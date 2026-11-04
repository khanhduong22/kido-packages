/**
 * Pure TypeScript Vector Mathematics for In-Memory Vector Operations
 * Zero-dependency, optimized for fast Cosine Similarity & Distance.
 */

/**
 * Computes Cosine Similarity between two dense numeric vectors.
 * Returns a value in [-1.0, 1.0], where 1.0 means identical direction.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Computes Cosine Distance (1 - Cosine Similarity) clamped to [0.0, 2.0].
 * Distance 0.0 means identical vectors; lower distance indicates higher semantic relevance.
 */
export function cosineDistance(vecA: number[], vecB: number[]): number {
  const sim = cosineSimilarity(vecA, vecB);
  return Math.max(0, 1 - sim);
}

/**
 * Computes Euclidean (L2) distance between two vectors.
 */
export function euclideanDistance(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
    return Infinity;
  }

  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    const diff = vecA[i] - vecB[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Normalizes a vector to unit length (L2 norm = 1.0).
 */
export function normalizeVector(vec: number[]): number[] {
  if (!vec || vec.length === 0) return [];
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  if (norm === 0) return [...vec];
  const scale = 1 / Math.sqrt(norm);
  return vec.map((v) => v * scale);
}
