import { describe, expect, it } from "bun:test";
import {
  cosineSimilarity,
  cosineDistance,
  euclideanDistance,
  normalizeVector,
} from "./vector-math";
import {
  computeRrfScore,
  fuseRrfRankings,
  buildPostgresRrfCteSql,
} from "./hybrid-rrf";
import {
  normalizeSearchQuery,
  removeDiacritics,
  buildExactQueryHash,
} from "./text-normalizer";
import { SemanticVectorCache } from "./semantic-vector-cache";

describe("Semantic Cache Suite", () => {
  describe("1. Vector Math", () => {
    it("computes cosine similarity accurately", () => {
      // Parallel vectors: sim = 1
      expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1.0, 5);
      // Orthogonal vectors: sim = 0
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
      // Opposite vectors: sim = -1
      expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1.0, 5);
      // Arbitrary angle
      expect(cosineSimilarity([1, 1], [0, 1])).toBeCloseTo(Math.SQRT1_2, 5);
    });

    it("handles zero vectors and dimension mismatches safely", () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineDistance([], [])).toBe(1);
    });

    it("computes cosine distance clamped >= 0", () => {
      expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0.0, 5);
      expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1.0, 5);
      expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2.0, 5);
    });

    it("computes Euclidean distance and normalizes vectors", () => {
      expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5.0, 5);
      const normalized = normalizeVector([3, 4]);
      expect(normalized[0]).toBeCloseTo(0.6, 5);
      expect(normalized[1]).toBeCloseTo(0.8, 5);
      expect(euclideanDistance([0, 0], normalized)).toBeCloseTo(1.0, 5);
    });
  });

  describe("2. Reciprocal Rank Fusion (RRF)", () => {
    it("calculates standard RRF scores with k=60", () => {
      // rank 1 in both: 1/(60+1) + 1/(60+1) = 2/61 ≈ 0.032787
      const topScore = computeRrfScore(1, 1, 60);
      expect(topScore).toBeCloseTo(0.032787, 5);

      // rank 1 in vector only: 1/61 ≈ 0.016393
      const vectorOnly = computeRrfScore(1, null, 60);
      expect(vectorOnly).toBeCloseTo(0.016393, 5);

      // rank 1 in keyword only
      const keywordOnly = computeRrfScore(null, 1, 60);
      expect(keywordOnly).toBeCloseTo(0.016393, 5);

      // Combined rank beats single-source rank
      expect(topScore).toBeGreaterThan(vectorOnly);
      expect(topScore).toBeGreaterThan(keywordOnly);
    });

    it("fuses two independent ranking lists properly", () => {
      const vectorHits = [
        { id: "doc_a", item: { title: "Doc A" }, distance: 0.05 },
        { id: "doc_b", item: { title: "Doc B" }, distance: 0.08 },
        { id: "doc_c", item: { title: "Doc C" }, distance: 0.15 },
      ];

      const keywordHits = [
        { id: "doc_c", item: { title: "Doc C" } }, // Keyword top hit
        { id: "doc_a", item: { title: "Doc A" } }, // Keyword second hit
        { id: "doc_d", item: { title: "Doc D" } }, // Keyword third hit
      ];

      const fused = fuseRrfRankings(vectorHits, keywordHits, { k: 60, limit: 4 });

      // Doc A has rank 1 in vector + rank 2 in keyword -> score: 1/61 + 1/62 ≈ 0.03252
      // Doc C has rank 3 in vector + rank 1 in keyword -> score: 1/63 + 1/61 ≈ 0.03227
      // Doc A should be rank 1 overall
      expect(fused.length).toBe(4);
      expect(fused[0].id).toBe("doc_a");
      expect(fused[0].rankVector).toBe(1);
      expect(fused[0].rankKeyword).toBe(2);

      expect(fused[1].id).toBe("doc_c");
      expect(fused[1].rankVector).toBe(3);
      expect(fused[1].rankKeyword).toBe(1);

      expect(fused.some((f) => f.id === "doc_d")).toBe(true);
    });

    it("generates valid PostgreSQL 18/19 CTE SQL query", () => {
      const sql = buildPostgresRrfCteSql({
        table: "DocumentChunk",
        vectorLiteral: "[0.1, 0.2, 0.3]",
        queryText: "thuong 200k",
        filterSql: `"tenantId" = 'tenant-demo'`,
        limit: 5,
        k: 60,
      });

      expect(sql).toContain("WITH vector_matches AS");
      expect(sql).toContain("keyword_matches AS");
      expect(sql).toContain("::halfvec <=>");
      expect(sql).toContain("to_tsvector('simple'");
      expect(sql).toContain("plainto_tsquery('simple', 'thuong 200k')");
      expect(sql).toContain("COALESCE(1.0 / (60 + v.rank_vector), 0.0)");
    });
  });

  describe("3. Text Normalizer", () => {
    it("normalizes queries and strips punctuation", () => {
      const input = "  Điều kiện nhận thưởng 200k??? (Đúng không!)  ";
      const norm = normalizeSearchQuery(input);
      expect(norm).toBe("điều kiện nhận thưởng 200k đúng không");
    });

    it("strips Vietnamese diacritics and replaces đ/Đ", () => {
      const input = "Đi trễ phạt bao nhiêu, Đơn vị?";
      const unaccented = removeDiacritics(input);
      expect(unaccented).toBe("Di tre phat bao nhieu, Don vi?");
    });

    it("computes consistent exact query hash", () => {
      const h1 = buildExactQueryHash("thuong 200k");
      const h2 = buildExactQueryHash("thuong 200k");
      const h3 = buildExactQueryHash("thuong 500k");
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1.length).toBe(32);
    });
  });

  describe("4. SemanticVectorCache", () => {
    it("hits exact cache first with 0 distance", () => {
      const cache = new SemanticVectorCache<string>({ defaultDistanceThreshold: 0.15 });

      cache.set("Làm sao xin nghỉ phép?", [1, 0, 0], "Gửi đơn qua tab Requests.");

      const exactHit = cache.get("  Làm sao xin nghỉ phép?  ", [0, 1, 0]);
      expect(exactHit).not.toBeNull();
      expect(exactHit?.matchType).toBe("EXACT");
      expect(exactHit?.distance).toBe(0.0);
      expect(exactHit?.payload).toBe("Gửi đơn qua tab Requests.");
    });

    it("hits semantic cache when vector is close (cosine distance <= threshold)", () => {
      const cache = new SemanticVectorCache<string>({ defaultDistanceThreshold: 0.15 });

      cache.set("quy tac phat di tre", [1, 0.05, 0], "Trừ 50k vào chuyên cần.");

      // Different question text, but very close semantic vector (dist < 0.15)
      const semanticHit = cache.get("di muon xu ly sao", [0.99, 0.06, 0]);
      expect(semanticHit).not.toBeNull();
      expect(semanticHit?.matchType).toBe("SEMANTIC");
      expect(semanticHit?.distance).toBeLessThanOrEqual(0.15);
      expect(semanticHit?.payload).toBe("Trừ 50k vào chuyên cần.");
    });

    it("rejects lookup when vector distance exceeds threshold", () => {
      const cache = new SemanticVectorCache<string>({ defaultDistanceThreshold: 0.1 });

      cache.set("huong dan su dung", [1, 0, 0], "Doc tai lie u.");

      // Orthogonal vector (distance = 1.0 > 0.1)
      const miss = cache.get("khong lien quan", [0, 1, 0]);
      expect(miss).toBeNull();
    });

    it("supports multi-tenant namespaces", () => {
      const cache = new SemanticVectorCache<string>();

      cache.set("chinh sach", [1, 0], "Chính sách của Tenant A", { namespace: "tenant_a" });
      cache.set("chinh sach", [1, 0], "Chính sách của Tenant B", { namespace: "tenant_b" });

      const hitA = cache.get("chinh sach", null, { namespace: "tenant_a" });
      const hitB = cache.get("chinh sach", null, { namespace: "tenant_b" });

      expect(hitA?.payload).toBe("Chính sách của Tenant A");
      expect(hitB?.payload).toBe("Chính sách của Tenant B");
    });

    it("evicts oldest entry on reaching capacity", () => {
      const cache = new SemanticVectorCache<number>({ maxEntriesPerNamespace: 3 });

      cache.set("q1", [1, 0], 1);
      cache.set("q2", [0, 1], 2);
      cache.set("q3", [1, 1], 3);

      expect(cache.size()).toBe(3);

      // Access q1 to make it recently accessed
      cache.get("q1");

      // Add 4th entry -> q2 should be evicted (oldest lastAccessed)
      cache.set("q4", [0.5, 0.5], 4);
      expect(cache.size()).toBe(3);
      expect(cache.get("q1")).not.toBeNull();
      expect(cache.get("q2")).toBeNull();
      expect(cache.get("q4")).not.toBeNull();
    });
  });
});
