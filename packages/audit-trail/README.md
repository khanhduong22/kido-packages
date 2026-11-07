# @kido/audit-trail

> **Cryptographic Audit Trail Engine**: Internal SHA-256 Hash Chaining, Real-Time Tamper Detection, Merkle Tree End-of-Shift Financial Anchoring, and Real-Time POS/ERP Fraud Anomaly Detection.

---

## 📌 Architecture Overview

```mermaid
flowchart TD
    A[POS / ERP Transaction] --> B[ActorContext + Payload]
    B --> C[AuditLogger.log]
    C --> D[Cryptographic Hash Chain Engine]
    D -->|SHA-256 Chaining| E[Immutable Append-Only Storage\nMemory / File JSONL]
    C --> F[Real-Time Anomaly Detector]
    F -->|Fraud Thresholds & Hour Rules| G{Anomaly Detected?}
    G -- Yes --> H[Trigger onAnomalyDetected Alert\nWARNING / CRITICAL]
    G -- No --> I[Log Success]
    
    E --> J[verifyChainIntegrity\nTamper Detection]
    E --> K[End-of-Shift Transactions]
    K --> L[Merkle Tree Engine]
    L --> M[Merkle Root Financial Anchor\nChốt két ca làm việc]
    L --> N[Merkle Inclusion Proof & Verify]
```

---

## 🚀 Key Features

1. **Cryptographic Hash-Chaining (Internal Blockchain Log)**:
   - Every record links to its predecessor via `previousHash`.
   - `currentHash = SHA256(previousHash + timestamp + actor.userId + action + canonicalJsonStringify(payload) + nonce)`.
   - Deterministic key sorting (`canonicalJsonStringify`) guarantees consistent hashes regardless of JavaScript object key order.
   - `verifyChainIntegrity(records)`: pinpoint immediately any inserted, altered, or deleted record.

2. **Merkle Tree Shift Anchoring**:
   - Compresses $N$ shift transactions into a single 32-byte cryptographic root (`merkleRoot`).
   - Anchors daily cash drawer closing and financial audit reports for company executives.
   - Generates lightweight inclusion proofs (`generateProof`) and verifies proofs without reading the entire dataset (`verifyProof`).

3. **Real-Time Anomaly & Fraud Detection**:
   - `ORDER_CANCEL`:
     - Cancellation $> 500.000$ VND: `WARNING`
     - Cancellation $> 5.000.000$ VND: `CRITICAL`
     - Cancellation during night hours (22:00 - 06:00): `CRITICAL`
   - `PRICE_OVERRIDE`:
     - Discount $> 10\%$: `WARNING` (or `CRITICAL` if triggered by a `CASHIER`)
     - Discount $> 30\%$: `CRITICAL`
   - `CASH_DRAWER_OPEN`:
     - Discrepancy $> 200.000$ VND: `WARNING`
     - Discrepancy $> 1.000.000$ VND: `CRITICAL`
     - Manual drawer opening with `NO_SALE`: `WARNING`
   - `DEBT_WRITEOFF`:
     - Debt write-off $> 1.000.000$ VND without `ADMIN` role: `CRITICAL`
   - Custom extensible rule engine.

4. **Production-Grade Append-Only Logger**:
   - In-memory adapter with `Object.freeze` immutability.
   - File streaming adapter appending JSON lines (`.jsonl`) with crash recovery and chain resumption.
   - Real-time `onAnomalyDetected` webhook callback.

5. **Declarative Monthly Range Partitioning & BRIN Indexing (`PgRangePartitionManager`)**:
   - `pg_partman`-style monthly partition pre-creation (`current month + 2 ahead`) to prevent midnight insert failures.
   - Generates local PostgreSQL BRIN indexes on `timestamp` with `pages_per_range = 32`, saving 99% RAM and disk.
   - `withPartitionPruningBounds`: Injects bounded `{ gte, lte }` filters into Prisma/SQL queries so PostgreSQL prunes 100% of inactive monthly partitions in $O(1)$ time.

6. **Uber/Stripe Zero-Lock Cold Tier Archiver & Boundary Anchor (`ColdTierArchiver`)**:
   - Replaces destructive `DELETE FROM` locks with `ALTER TABLE DETACH PARTITION CONCURRENTLY`.
   - Seals detached partitions into deterministic NDJSON format and produces an immutable `ColdPartitionManifest`.
   - Solves the **Partition Detach Paradox**: `verifyChainWithColdManifest` asserts that `hotRecords[0].previousHash === coldManifest.lastHash` and verifies subsequent hot records seamlessly.

---

## 📦 Installation

```bash
pnpm add @kido/audit-trail
```

---

## 💡 Usage Examples

### 1. Initialize Logger & Log Transactions

```typescript
import { AuditLogger, FileStreamingStorageAdapter } from '@kido/audit-trail';

const logger = new AuditLogger({
  storage: new FileStreamingStorageAdapter('./storage/audit.jsonl'),
  onAnomalyDetected: async (entry, anomalies) => {
    console.warn(`[FRAUD ALERT] Action ${entry.action} triggered:`, anomalies);
    // Send Slack / Zalo / Telegram notification to store owner
  },
});

await logger.initialize();

// Log order creation
const { entry, anomalies } = await logger.log({
  actor: {
    userId: 'usr_cashier_01',
    role: 'CASHIER',
    ipAddress: '192.168.1.100',
    userAgent: 'Sunmi-POS-T2',
    branchId: 'BRANCH_D1_HCMC',
  },
  action: 'ORDER_CREATE',
  entityId: 'ORD_20260930_001',
  payload: { total: 450000, paymentMethod: 'VIETQR' },
});
```

### 2. Instant Tamper Detection (Chain Integrity)

```typescript
const result = await logger.verifyIntegrity();

if (!result.isValid) {
  console.error(`🚨 DATA TAMPERED at index ${result.tamperedIndex}!`);
  console.error(`Record ID: ${result.tamperedRecordId}`);
  console.error(`Reason: ${result.reason}`);
} else {
  console.log(`✅ Audit chain 100% verified (${result.totalRecords} records).`);
}
```

### 3. Merkle Tree End-of-Shift Financial Anchoring

```typescript
import { MerkleTree } from '@kido/audit-trail';

// Anchor shift transactions
const snapshot = await logger.createShiftSnapshot('SHIFT_20260930_CA1', {
  branchId: 'BRANCH_D1_HCMC',
  metadata: {
    cashier: 'Nguyen Van A',
    expectedCash: 12500000,
    actualCash: 12500000,
  },
});

console.log('Shift Merkle Root:', snapshot.merkleRoot);
// Securely store snapshot.merkleRoot into Master Ledger / Daily Close Report
```

### 4. Merkle Inclusion Proof & Verification

```typescript
const entries = await logger.getEntries();
const tree = new MerkleTree(entries);

// Generate proof for transaction index 3
const proof = tree.generateProof(3);

// Verify leaf inclusion against root
const isValid = MerkleTree.verifyProof(proof.leafHash, proof.proof, tree.getRoot());
console.log('Transaction verified in shift:', isValid); // true
```

---

## 🧪 Testing

```bash
pnpm run test
pnpm run typecheck
pnpm run build
```
