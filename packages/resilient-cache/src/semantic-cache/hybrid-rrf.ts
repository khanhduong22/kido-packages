/**
 * Reciprocal Rank Fusion (RRF) Engine
 * Standard Big-Tech algorithm (Stripe, OpenAI, Anthropic) for merging
 * Dense Vector Semantic Search + Sparse BM25 / Keyword Search rankings.
 */

/**
 * Computes the individual Reciprocal Rank Fusion score for an item:
 * RRF(d) = 1/(k + rank_vector) + 1/(k + rank_keyword)
 *
 * @param rankVector 1-based rank from vector search, or null/undefined if not matched
 * @param rankKeyword 1-based rank from keyword search, or null/undefined if not matched
 * @param k Smoothing constant (default: 60, standard in TREC and Lucene benchmarks)
 */
export function computeRrfScore(
  rankVector?: number | null,
  rankKeyword?: number | null,
  k = 60
): number {
  const vScore = rankVector && rankVector > 0 ? 1 / (k + rankVector) : 0;
  const kScore = rankKeyword && rankKeyword > 0 ? 1 / (k + rankKeyword) : 0;
  return Number((vScore + kScore).toFixed(6));
}

export interface VectorHit<T = any> {
  id: string;
  item: T;
  distance?: number;
  similarity?: number;
}

export interface KeywordHit<T = any> {
  id: string;
  item: T;
  score?: number;
}

export interface RrfFusedResult<T = any> {
  id: string;
  item: T;
  rrfScore: number;
  rankVector?: number;
  rankKeyword?: number;
  vectorDistance?: number;
}

export interface FuseRrfOptions {
  k?: number;
  limit?: number;
}

/**
 * Fuses two independent ranked candidate lists (Vector vs Keyword) using RRF.
 * Produces an ordered list sorted by descending RRF score.
 */
export function fuseRrfRankings<T = any>(
  vectorHits: VectorHit<T>[],
  keywordHits: KeywordHit<T>[],
  options?: FuseRrfOptions
): RrfFusedResult<T>[] {
  const k = options?.k ?? 60;
  const limit = options?.limit ?? 10;

  const registry = new Map<
    string,
    {
      item: T;
      rankVector?: number;
      rankKeyword?: number;
      vectorDistance?: number;
    }
  >();

  // Process vector ranking (1-based)
  for (let i = 0; i < vectorHits.length; i++) {
    const hit = vectorHits[i];
    const rank = i + 1;
    registry.set(hit.id, {
      item: hit.item,
      rankVector: rank,
      vectorDistance: hit.distance,
    });
  }

  // Process keyword ranking (1-based)
  for (let j = 0; j < keywordHits.length; j++) {
    const hit = keywordHits[j];
    const rank = j + 1;
    const existing = registry.get(hit.id);
    if (existing) {
      existing.rankKeyword = rank;
    } else {
      registry.set(hit.id, {
        item: hit.item,
        rankKeyword: rank,
      });
    }
  }

  // Calculate fused RRF score
  const results: RrfFusedResult<T>[] = [];
  for (const [id, entry] of registry.entries()) {
    const score = computeRrfScore(entry.rankVector, entry.rankKeyword, k);
    results.push({
      id,
      item: entry.item,
      rrfScore: score,
      rankVector: entry.rankVector,
      rankKeyword: entry.rankKeyword,
      vectorDistance: entry.vectorDistance,
    });
  }

  // Sort descending by RRF score
  results.sort((a, b) => b.rrfScore - a.rrfScore);

  return results.slice(0, limit);
}

export interface PostgresRrfCteOptions {
  table: string;
  idCol?: string;
  vectorCol?: string;
  textCol?: string;
  vectorLiteral: string;
  queryText: string;
  filterSql?: string;
  candidateLimit?: number;
  finalLimit?: number;
  k?: number;
}

/**
 * Generates an optimized PostgreSQL 18/19 CTE SQL query for Pure-SQL Hybrid RRF.
 * Uses halfvec cosine distance (<=>) for vector branch and to_tsvector @@ plainto_tsquery for keyword branch.
 */
export function buildPostgresRrfCteSql(opts: PostgresRrfCteOptions): string {
  const idCol = opts.idCol || "id";
  const vectorCol = opts.vectorCol || "embedding";
  const textCol = opts.textCol || "content";
  const candidateLimit = opts.candidateLimit || 20;
  const finalLimit = opts.finalLimit || 8;
  const k = opts.k || 60;
  const filterClause = opts.filterSql ? `AND ${opts.filterSql}` : "";

  return `
WITH vector_matches AS (
  SELECT
    "${idCol}",
    ("${vectorCol}"::halfvec <=> '${opts.vectorLiteral}'::halfvec)::float8 AS distance,
    ROW_NUMBER() OVER (ORDER BY "${vectorCol}"::halfvec <=> '${opts.vectorLiteral}'::halfvec ASC) AS rank_vector
  FROM "${opts.table}"
  WHERE "${vectorCol}" IS NOT NULL ${filterClause}
  ORDER BY "${vectorCol}"::halfvec <=> '${opts.vectorLiteral}'::halfvec ASC
  LIMIT ${candidateLimit}
),
keyword_matches AS (
  SELECT
    "${idCol}",
    ROW_NUMBER() OVER (
      ORDER BY ts_rank(to_tsvector('simple', "${textCol}"), plainto_tsquery('simple', '${opts.queryText.replace(/'/g, "''")}')) DESC
    ) AS rank_keyword
  FROM "${opts.table}"
  WHERE to_tsvector('simple', "${textCol}") @@ plainto_tsquery('simple', '${opts.queryText.replace(/'/g, "''")}')
    ${filterClause}
  LIMIT ${candidateLimit}
)
SELECT
  t."${idCol}",
  t."${textCol}",
  COALESCE(v.distance, 1.0) AS distance,
  (
    COALESCE(1.0 / (${k} + v.rank_vector), 0.0) +
    COALESCE(1.0 / (${k} + k.rank_keyword), 0.0)
  ) AS rrf_score,
  v.rank_vector,
  k.rank_keyword
FROM "${opts.table}" t
LEFT JOIN vector_matches v ON t."${idCol}" = v."${idCol}"
LEFT JOIN keyword_matches k ON t."${idCol}" = k."${idCol}"
WHERE v."${idCol}" IS NOT NULL OR k."${idCol}" IS NOT NULL
ORDER BY rrf_score DESC
LIMIT ${finalLimit};
  `.trim();
}
