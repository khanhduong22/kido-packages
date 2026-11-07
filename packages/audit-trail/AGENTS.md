# Cryptographic Chained Audit Logger Standards (@kido/audit-trail)

<!-- Inherits root project rules & system directives -->
@../../AGENTS.md

================================================================================
1. PACKAGE ROLE & SPECIFICATION
================================================================================
- **Package**: `@kido/audit-trail` (`packages/audit-trail`)
- **Engine Purpose**: Cryptographic audit logging, tamper detection, Merkle tree batch shift anchoring, and real-time fraud/anomaly detection for enterprise retail operations.
- **Runtime**: Node.js / Bun / TypeScript (Pure cryptographic and computational library with zero DB coupling).

================================================================================
2. CRYPTOGRAPHIC INTEGRITY & HASH-CHAINING INVARIANTS
================================================================================

### 2.1 SHA-256 Hash Chaining
- Each audit log entry is linked to its immediate predecessor, forming a tamper-evident blockchain-like chain.
- Hash Formula:
  ```text
  hash = SHA256(previousHash + timestamp + action + actorId + canonicalJson(payload))
  ```
- **Deterministic Serialization**: JSON payload attributes must be serialized deterministically using canonical JSON stringification (`canonicalJsonStringify`) regardless of object key insertion order.

### 2.2 Genesis Block Verification
- The genesis entry of the chain is anchored to a predefined constant:
  ```typescript
  export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
  ```
- Any chain missing a valid genesis hash or containing an altered historical record fails integrity checks (`verifyChainIntegrity`).

### 2.3 Tamper Detection & Merkle Shift Anchoring
- **Tamper Evidence**: Any modification, insertion, deletion, or reordering of records immediately breaks downstream hashes.
- **Merkle Tree Anchoring**:
  - End-of-shift batches and financial closures are aggregated into a cryptographic Merkle root.
  - Generates and verifies cryptographic inclusion proofs (`verifyMerkleProof`) for financial audit compliance.

### 2.4 Real-time Anomaly & Fraud Detection
- Rules engine monitors audit events for operational anomalies:
  - Unauthorized price overrides or abnormal cash register adjustments.
  - Large order cancellations or cancellations outside business hours (e.g. post 22:00).
  - Cash discrepancies exceeding defined thresholds.
  - Suspicious cash drawer openings (`NO_SALE`).

### 2.5 Declarative Range Partitioning & BRIN Indexing
- **Monthly Declarative Partitioning (`PgRangePartitionManager`)**:
  - Automatically plans and generates PostgreSQL 14-18 declarative monthly range partition DDL (`PARTITION BY RANGE ("timestamp")`).
  - Pre-creates hot partitions for current month + `premakeMonths` (default 2, `pg_partman` style) so inserts at midnight on the 1st never fail.
  - Generates local **BRIN (Block Range Index)** on `timestamp` with `pages_per_range = 32`, consuming 99% less RAM and disk compared to B-Tree on append-only sequential logs.
- **Partition Pruning Enforcer (`withPartitionPruningBounds`)**:
  - In PostgreSQL, Partition Pruning (`enable_partition_pruning = on`) only triggers when `WHERE` clauses contain explicit bounds on the partition key.
  - Injects default 30-day hot bounds (`{ gte, lte }`) into Prisma/SQL queries, enabling $O(1)$ partition pruning and eliminating full-table scans across legacy months.

### 2.6 Zero-Lock Cold Tier Archiving & Boundary Anchor
- **Zero-Lock Concurrent Detach (`ColdTierArchiver`)**:
  - Uses `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` (PostgreSQL 14-18) instead of destructive `DELETE FROM` locks.
  - Prevents WAL bloat, dead tuples, and table locking during retention cutoffs.
- **Solving the Partition Detach Paradox (`verifyChainWithColdManifest`)**:
  - Offloading detached partitions to S3/R2 creates a boundary discontinuity if the next partition still requires hash verification.
  - Generates immutable `ColdPartitionManifest` containing `firstHash`, `lastHash`, Merkle Root, and NDJSON SHA-256 payload checksum.
  - Verifies that hot partition record `[0].previousHash === coldManifest.lastHash`, mathematically proving zero deleted or tampered records across partition boundaries.


================================================================================
3. VERIFICATION COMMANDS
================================================================================
```bash
# Run cryptographic immutability and anomaly detection test suite
pnpm --filter @kido/audit-trail test

# Typecheck TypeScript definitions
pnpm --filter @kido/audit-trail typecheck

# Build bundle via tsup
pnpm --filter @kido/audit-trail build
```
