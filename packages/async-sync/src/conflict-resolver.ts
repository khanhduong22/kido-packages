import {
  ConflictResolution,
  ConflictStrategy,
  VersionedEntity,
} from './types';
import { uuidv7 } from './uuidv7';

export type VectorClockRelation =
  | 'LOCAL_DOMINATES'
  | 'REMOTE_DOMINATES'
  | 'EQUAL'
  | 'CONCURRENT';

export class ConflictResolver {
  /**
   * Evaluates the relationship between two vector clocks.
   */
  static compareVectorClocks(
    localClock: Record<string, number> = {},
    remoteClock: Record<string, number> = {}
  ): VectorClockRelation {
    const allKeys = new Set([...Object.keys(localClock), ...Object.keys(remoteClock)]);

    let localGreater = false;
    let remoteGreater = false;

    for (const key of allKeys) {
      const localVal = localClock[key] ?? 0;
      const remoteVal = remoteClock[key] ?? 0;

      if (localVal > remoteVal) localGreater = true;
      if (remoteVal > localVal) remoteGreater = true;
    }

    if (!localGreater && !remoteGreater) return 'EQUAL';
    if (localGreater && !remoteGreater) return 'LOCAL_DOMINATES';
    if (remoteGreater && !localGreater) return 'REMOTE_DOMINATES';
    return 'CONCURRENT';
  }

  /**
   * Merges two vector clocks by taking the pairwise maximum of each node.
   */
  static mergeVectorClocks(
    a: Record<string, number> = {},
    b: Record<string, number> = {}
  ): Record<string, number> {
    const merged: Record<string, number> = { ...a };
    for (const [key, val] of Object.entries(b)) {
      merged[key] = Math.max(merged[key] ?? 0, val);
    }
    return merged;
  }

  /**
   * Resolves conflict between local entity and remote entity.
   */
  static resolve<T extends Record<string, unknown>>(
    local: VersionedEntity<T>,
    remote: VersionedEntity<T>,
    strategy: ConflictStrategy = 'LAST_WRITE_WINS'
  ): ConflictResolution<T> {
    // Financial and invoice entities MUST strictly use APPEND-ONLY strategy
    if (local.isFinancial || remote.isFinancial || strategy === 'APPEND_ONLY') {
      return this.resolveAppendOnly(local, remote);
    }

    if (strategy === 'VECTOR_CLOCK' && local.vectorClock && remote.vectorClock) {
      const relation = this.compareVectorClocks(local.vectorClock, remote.vectorClock);
      if (relation === 'LOCAL_DOMINATES') {
        return {
          winner: 'local',
          entity: local,
          auditLog: `Local vector clock dominates remote: ${JSON.stringify(local.vectorClock)} > ${JSON.stringify(remote.vectorClock)}`,
        };
      }
      if (relation === 'REMOTE_DOMINATES') {
        return {
          winner: 'remote',
          entity: remote,
          auditLog: `Remote vector clock dominates local: ${JSON.stringify(remote.vectorClock)} > ${JSON.stringify(local.vectorClock)}`,
        };
      }
      if (relation === 'EQUAL') {
        return {
          winner: 'remote',
          entity: remote,
          auditLog: `Vector clocks are equal. Defaulting to remote version.`,
        };
      }
      // CONCURRENT: Fall through to Last-Write-Wins as tie-breaker
    }

    // Default: Last-Write-Wins (LWW) with version stamp inspection
    return this.resolveLastWriteWins(local, remote);
  }

  /**
   * Last-Write-Wins with version stamp check and timestamp comparison.
   */
  private static resolveLastWriteWins<T extends Record<string, unknown>>(
    local: VersionedEntity<T>,
    remote: VersionedEntity<T>
  ): ConflictResolution<T> {
    // 1. If remote version is strictly greater and remote updated later or equal
    if (remote.version > local.version && remote.updatedAt >= local.updatedAt) {
      return {
        winner: 'remote',
        entity: remote,
        auditLog: `Remote won via LWW (Remote v${remote.version} @ ${remote.updatedAt} > Local v${local.version} @ ${local.updatedAt})`,
      };
    }

    // 2. If local updated strictly after remote
    if (local.updatedAt > remote.updatedAt) {
      const nextVersion = Math.max(local.version, remote.version) + 1;
      const mergedClock = this.mergeVectorClocks(local.vectorClock, remote.vectorClock);
      return {
        winner: 'local',
        entity: {
          ...local,
          version: nextVersion,
          vectorClock: mergedClock,
        },
        auditLog: `Local won via LWW timestamp (Local @ ${local.updatedAt} > Remote @ ${remote.updatedAt})`,
      };
    }

    // 3. If remote updated strictly after local
    if (remote.updatedAt > local.updatedAt) {
      return {
        winner: 'remote',
        entity: remote,
        auditLog: `Remote won via LWW timestamp (Remote @ ${remote.updatedAt} > Local @ ${local.updatedAt})`,
      };
    }

    // 4. Equal timestamps: Tie-breaker using version stamp or remote preference
    if (local.version > remote.version) {
      return {
        winner: 'local',
        entity: local,
        auditLog: `Local won via tie-breaker version stamp (v${local.version} > v${remote.version})`,
      };
    }

    return {
      winner: 'remote',
      entity: remote,
      auditLog: `Remote won via tie-breaker default`,
    };
  }

  /**
   * Append-Only Strategy for Financial & Ledger Entries:
   * Never overwrites financial records. Preserves both transactions and creates an adjustment delta if amounts differ.
   */
  private static resolveAppendOnly<T extends Record<string, unknown>>(
    local: VersionedEntity<T>,
    remote: VersionedEntity<T>
  ): ConflictResolution<T> {
    const localAmount = Number(local.data['amount'] ?? local.data['totalAmount'] ?? 0);
    const remoteAmount = Number(remote.data['amount'] ?? remote.data['totalAmount'] ?? 0);
    const delta = localAmount - remoteAmount;

    const supplementary: VersionedEntity<T>[] = [];

    if (delta !== 0) {
      const adjustmentRecord: VersionedEntity<T> = {
        id: uuidv7(),
        version: Math.max(local.version, remote.version) + 1,
        updatedAt: Date.now(),
        isFinancial: true,
        data: {
          ...local.data,
          referenceId: local.id,
          adjustmentDelta: delta,
          type: 'FINANCIAL_ADJUSTMENT',
          note: `Auto-generated compensating adjustment for offline sync reconciliation. Local: ${localAmount}, Remote: ${remoteAmount}, Delta: ${delta}`,
        } as unknown as T,
      };
      supplementary.push(adjustmentRecord);
    }

    return {
      winner: 'merged',
      entity: {
        ...remote,
        version: Math.max(local.version, remote.version) + 1,
        updatedAt: Math.max(local.updatedAt, remote.updatedAt),
        isFinancial: true,
      },
      isAppendOnly: true,
      supplementaryRecords: supplementary,
      auditLog: `Append-only reconciliation preserved financial audit trail. Base: Remote v${remote.version}, Adjustments generated: ${supplementary.length}`,
    };
  }
}
