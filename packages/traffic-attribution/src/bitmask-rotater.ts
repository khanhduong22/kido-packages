import type {
  BitmaskRotationOptions,
  BitmaskRotationResult,
} from './types';

/**
 * Parses an integer bitmask from cookie string, number, or unknown value.
 * Safely defaults to 0 if invalid or negative.
 */
export function parseBitmask(val: unknown): number {
  if (typeof val === 'number') {
    if (Number.isNaN(val) || !Number.isFinite(val) || val < 0) return 0;
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const parsed = Number.parseInt(val.trim(), 10);
    return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
  }
  return 0;
}

/**
 * Serializes a bitmask number into a clean string representation for cookie storage.
 */
export function serializeBitmask(mask: number): string {
  return String(Math.max(0, Math.floor(mask)));
}

/**
 * Checks if the specific item index has already been visited in the given bitmask.
 */
export function isBitVisited(mask: number, index: number): boolean {
  if (index < 0 || index >= 30) return false;
  return (mask & (1 << index)) !== 0;
}

/**
 * Returns a new bitmask with the given index marked as visited.
 */
export function markBitVisited(mask: number, index: number): number {
  if (index < 0 || index >= 30) return mask;
  return mask | (1 << index);
}

/**
 * Returns an array of indices that have been visited.
 */
export function getVisitedIndices(mask: number, totalCount: number): number[] {
  const count = Math.min(totalCount, 30);
  const visited: number[] = [];
  for (let i = 0; i < count; i++) {
    if ((mask & (1 << i)) !== 0) {
      visited.push(i);
    }
  }
  return visited;
}

/**
 * Returns an array of indices that have NOT been visited yet.
 */
export function getUnvisitedIndices(mask: number, totalCount: number): number[] {
  const count = Math.min(totalCount, 30);
  const unvisited: number[] = [];
  for (let i = 0; i < count; i++) {
    if ((mask & (1 << i)) === 0) {
      unvisited.push(i);
    }
  }
  return unvisited;
}

/**
 * Checks if all items up to totalCount have been visited.
 */
export function isAllVisited(mask: number, totalCount: number): boolean {
  if (totalCount <= 0) return true;
  const count = Math.min(totalCount, 30);
  const fullMask = (1 << count) - 1;
  return (mask & fullMask) === fullMask;
}

/**
 * Zero-state link rotation algorithm based on Cookie Integer Bitmask (`bit_array & (1 << index)`).
 *
 * How it works:
 * 1. Checks which indices are unvisited in the current bitmask.
 * 2. If all links in the pool have been visited (or bitmask is exhausted), it automatically resets to 0.
 * 3. Selects the next unvisited link (either sequential or random).
 * 4. Updates the bitmask by setting the chosen bit (`mask | (1 << index)`).
 * 5. Requires ZERO external database or Redis session storage — purely client cookie driven!
 */
export function selectUnvisitedLinkBitmask<T>(
  items: readonly T[],
  currentBitmaskInput?: number | string | null,
  options: BitmaskRotationOptions = {}
): BitmaskRotationResult<T> {
  if (!items || items.length === 0) {
    throw new Error('Items array must not be empty');
  }

  const totalCount = items.length;
  if (totalCount > 30) {
    throw new Error('Bitmask rotator supports up to 30 items per pool to prevent 32-bit overflow');
  }

  const fullMask = (1 << totalCount) - 1;
  let activeMask = parseBitmask(currentBitmaskInput) & fullMask;

  let unvisited = getUnvisitedIndices(activeMask, totalCount);

  // If all items have already been visited in previous requests, reset cycle
  let cycleResetHappened = false;
  if (unvisited.length === 0) {
    activeMask = 0;
    unvisited = getUnvisitedIndices(0, totalCount);
    cycleResetHappened = true;
  }

  // Pick index
  let chosenIndex: number;
  if (options.mode === 'random') {
    const randomIndex = Math.floor(Math.random() * unvisited.length);
    chosenIndex = unvisited[randomIndex];
  } else {
    // Default: sequential round-robin
    chosenIndex = unvisited[0];
  }

  const nextMask = activeMask | (1 << chosenIndex);
  const isCycleCompleted = (nextMask & fullMask) === fullMask;
  const remainingUnvisited = unvisited.filter((idx) => idx !== chosenIndex);
  const visitedCount = getVisitedIndices(nextMask, totalCount).length;

  return {
    selectedItem: items[chosenIndex],
    selectedIndex: chosenIndex,
    currentBitmask: cycleResetHappened ? 0 : activeMask,
    nextBitmask: nextMask,
    isCycleCompleted,
    visitedCount,
    totalCount,
    unvisitedIndices: remainingUnvisited,
  };
}

/**
 * Helper to construct a standard Set-Cookie header string for the bitmask.
 */
export function createBitmaskCookieString(
  cookieName: string,
  bitmask: number,
  options: {
    maxAgeSeconds?: number;
    path?: string;
    domain?: string;
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
  } = {}
): string {
  const maxAge = options.maxAgeSeconds ?? 86400 * 30; // 30 days default
  const path = options.path ?? '/';
  const sameSite = options.sameSite ?? 'lax';
  const secure = options.secure ? '; Secure' : '';
  const domain = options.domain ? `; Domain=${options.domain}` : '';

  return `${cookieName}=${serializeBitmask(bitmask)}; Path=${path}; Max-Age=${maxAge}; SameSite=${sameSite}${secure}${domain}`;
}
