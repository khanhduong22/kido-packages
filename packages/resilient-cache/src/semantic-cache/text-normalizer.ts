import { createHash } from "crypto";

/**
 * Normalizes query string for exact caching:
 * Unicode NFC, lowercase, strips punctuation, collapses whitespace.
 */
export function normalizeSearchQuery(query: string): string {
  if (!query) return "";
  return query
    .normalize("NFC")
    .toLowerCase()
    .replace(/[?!.,;:"'()[\]{}`~@#$%^&*+=<>\\/|_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips Vietnamese and Latin diacritics / accents for typo-tolerant keyword matching.
 * e.g. "Quy chế khen thưởng 200k" -> "Quy che khen thuong 200k"
 */
export function removeDiacritics(str: string): string {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Computes a deterministic SHA-256 slice for exact cache key generation.
 */
export function buildExactQueryHash(normalizedQuery: string, length = 32): string {
  return createHash("sha256")
    .update(normalizedQuery)
    .digest("hex")
    .slice(0, length);
}
