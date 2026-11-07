import { createHash } from 'node:crypto';
import { AuditEntry, MerkleProof, MerkleProofStep, ShiftSnapshot } from './types';
import { GENESIS_HASH } from './hash-chain';

/**
 * Hash two child nodes to compute the parent node in the Merkle Tree
 */
export function hashPair(left: string, right: string): string {
  return createHash('sha256').update(left + right).digest('hex');
}

/**
 * Cryptographic Merkle Tree for shift transaction aggregation and financial anchoring
 */
export class MerkleTree {
  private readonly leaves: string[];
  private readonly levels: string[][];

  constructor(inputs: string[] | AuditEntry[]) {
    if (inputs.length === 0) {
      this.leaves = [createHash('sha256').update('').digest('hex')];
    } else if (typeof inputs[0] === 'string') {
      this.leaves = [...(inputs as string[])];
    } else {
      this.leaves = (inputs as AuditEntry[]).map((entry) => entry.currentHash);
    }

    this.levels = this.buildTree(this.leaves);
  }

  /**
   * Internal recursive builder for Merkle Tree levels
   */
  private buildTree(leaves: string[]): string[][] {
    const levels: string[][] = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        nextLevel.push(hashPair(left, right));
      }

      levels.push(nextLevel);
      currentLevel = nextLevel;
    }

    return levels;
  }

  /**
   * Returns the root hash of the Merkle Tree
   */
  public getRoot(): string {
    const topLevel = this.levels[this.levels.length - 1];
    return topLevel && topLevel.length > 0 ? topLevel[0] : '';
  }

  /**
   * Returns all leaf hashes
   */
  public getLeaves(): string[] {
    return [...this.leaves];
  }

  /**
   * Generate an audit inclusion proof for a leaf at the given index
   */
  public generateProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of bounds (0-${this.leaves.length - 1})`);
    }

    const leafHash = this.leaves[leafIndex];
    const proof: MerkleProofStep[] = [];
    let currentIndex = leafIndex;

    for (let levelIdx = 0; levelIdx < this.levels.length - 1; levelIdx++) {
      const level = this.levels[levelIdx];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      let siblingHash: string;
      if (siblingIndex < level.length) {
        siblingHash = level[siblingIndex];
      } else {
        // Paired with itself if odd
        siblingHash = level[currentIndex];
      }

      proof.push({
        position: isRightNode ? 'left' : 'right',
        hash: siblingHash,
      });

      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      leafIndex,
      leafHash,
      proof,
      root: this.getRoot(),
    };
  }

  /**
   * Verify whether a leaf and its cryptographic proof match the expected root hash
   */
  public static verifyProof(leaf: string, proof: MerkleProofStep[], root: string): boolean {
    let current = leaf;

    for (const step of proof) {
      if (step.position === 'left') {
        current = hashPair(step.hash, current);
      } else {
        current = hashPair(current, step.hash);
      }
    }

    return current === root;
  }

  /**
   * Anchor a shift of transactions into an immutable financial snapshot
   */
  public static anchorShift(
    shiftId: string,
    entries: AuditEntry[],
    options?: {
      branchId?: string;
      timestamp?: number;
      metadata?: Record<string, unknown>;
    }
  ): ShiftSnapshot {
    const tree = new MerkleTree(entries);
    const firstHash = entries.length > 0 ? entries[0].currentHash : GENESIS_HASH;
    const lastHash = entries.length > 0 ? entries[entries.length - 1].currentHash : GENESIS_HASH;

    return {
      shiftId,
      branchId: options?.branchId ?? entries[0]?.actor?.branchId ?? 'MAIN_BRANCH',
      timestamp: options?.timestamp ?? Date.now(),
      merkleRoot: tree.getRoot(),
      totalTransactions: entries.length,
      firstHash,
      lastHash,
      metadata: options?.metadata,
    };
  }
}
