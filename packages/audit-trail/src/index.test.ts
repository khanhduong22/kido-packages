import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GENESIS_HASH,
  canonicalJsonStringify,
  computeEntryHash,
  createAuditEntry,
  verifyChainIntegrity,
  MerkleTree,
  hashPair,
  AnomalyDetector,
  DEFAULT_ANOMALY_CONFIG,
  AuditLogger,
  MemoryStorageAdapter,
  FileStreamingStorageAdapter,
  AuditEntry,
  ActorContext,
} from './index';

describe('@kido/audit-trail Test Suite', () => {
  const dummyActor: ActorContext = {
    userId: 'usr_cashier_01',
    role: 'CASHIER',
    ipAddress: '192.168.1.100',
    userAgent: 'Sunmi-T2-POS',
    branchId: 'BRANCH_D1_HCMC',
  };

  const managerActor: ActorContext = {
    userId: 'usr_mgr_01',
    role: 'BRANCH_MANAGER',
    ipAddress: '192.168.1.10',
    userAgent: 'Admin-Dashboard-Web',
    branchId: 'BRANCH_D1_HCMC',
  };

  // -------------------------------------------------------------
  // Group 1: Cryptographic Hash-Chain & Tamper Detection
  // -------------------------------------------------------------
  describe('1. Cryptographic Hash-Chain & Tamper Detection', () => {
    it('1.1 should serialize JSON deterministically regardless of key insertion order', () => {
      const objA = { amount: 150000, note: 'Khách thanh toán VietQR', orderId: 'ORD_001' };
      const objB = { orderId: 'ORD_001', note: 'Khách thanh toán VietQR', amount: 150000 };

      const strA = canonicalJsonStringify(objA);
      const strB = canonicalJsonStringify(objB);

      assert.strictEqual(strA, strB);
      assert.strictEqual(
        strA,
        '{"amount":150000,"note":"Khách thanh toán VietQR","orderId":"ORD_001"}'
      );
    });

    it('1.2 should compute deterministic SHA-256 hash for audit entries', () => {
      const hash1 = computeEntryHash({
        previousHash: GENESIS_HASH,
        timestamp: 1700000000000,
        userId: 'usr_cashier_01',
        action: 'ORDER_CREATE',
        payload: { orderId: 'ORD_100', total: 250000 },
        nonce: 0,
      });

      const hash2 = computeEntryHash({
        previousHash: GENESIS_HASH,
        timestamp: 1700000000000,
        userId: 'usr_cashier_01',
        action: 'ORDER_CREATE',
        payload: { total: 250000, orderId: 'ORD_100' }, // swapped keys
        nonce: 0,
      });

      assert.strictEqual(hash1.length, 64);
      assert.strictEqual(hash1, hash2);
    });

    it('1.3 should build a sequential hash chain linking records properly', () => {
      const entry1 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CREATE',
          entityId: 'ORD_001',
          payload: { total: 100000 },
          timestamp: 1000,
        },
        GENESIS_HASH
      );

      const entry2 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CREATE',
          entityId: 'ORD_002',
          payload: { total: 200000 },
          timestamp: 2000,
        },
        entry1.currentHash
      );

      const entry3 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CREATE',
          entityId: 'ORD_003',
          payload: { total: 300000 },
          timestamp: 3000,
        },
        entry2.currentHash
      );

      assert.strictEqual(entry1.previousHash, GENESIS_HASH);
      assert.strictEqual(entry2.previousHash, entry1.currentHash);
      assert.strictEqual(entry3.previousHash, entry2.currentHash);

      const chain = [entry1, entry2, entry3];
      const result = verifyChainIntegrity(chain);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.totalRecords, 3);
      assert.strictEqual(result.tamperedIndex, null);
    });

    it('1.4 should instantly detect data tampering inside a record payload', () => {
      const entry1 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CREATE',
          entityId: 'ORD_001',
          payload: { total: 100000 },
        },
        GENESIS_HASH
      );

      const entry2 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CREATE',
          entityId: 'ORD_002',
          payload: { total: 200000 },
        },
        entry1.currentHash
      );

      // Fraudulent attempt: Hacker modifies total in record 2 without re-signing
      const tamperedRecord: AuditEntry = {
        ...entry2,
        payload: { total: 50000 }, // illegally reduced price
      };

      const chain = [entry1, tamperedRecord];
      const verification = verifyChainIntegrity(chain);

      assert.strictEqual(verification.isValid, false);
      assert.strictEqual(verification.tamperedIndex, 1);
      assert.strictEqual(verification.tamperedRecordId, entry2.id);
      assert.ok(verification.reason?.includes('Data tampering detected'));
    });

    it('1.5 should detect broken link if a record is deleted or replaced', () => {
      const entry1 = createAuditEntry(
        { actor: dummyActor, action: 'ORDER_CREATE', entityId: 'ORD_001', payload: { a: 1 } },
        GENESIS_HASH
      );
      const entry2 = createAuditEntry(
        { actor: dummyActor, action: 'ORDER_CREATE', entityId: 'ORD_002', payload: { a: 2 } },
        entry1.currentHash
      );
      const entry3 = createAuditEntry(
        { actor: dummyActor, action: 'ORDER_CREATE', entityId: 'ORD_003', payload: { a: 3 } },
        entry2.currentHash
      );

      // Delete entry2 from the middle
      const tamperedChain = [entry1, entry3];
      const verification = verifyChainIntegrity(tamperedChain);

      assert.strictEqual(verification.isValid, false);
      assert.strictEqual(verification.tamperedIndex, 1);
      assert.strictEqual(verification.tamperedRecordId, entry3.id);
      assert.ok(verification.reason?.includes('Broken chain link detected'));
    });

    it('1.6 should reject invalid genesis hash at the start of the chain', () => {
      const forgedGenesis = 'f'.repeat(64);
      const entry1 = createAuditEntry(
        { actor: dummyActor, action: 'ORDER_CREATE', entityId: 'ORD_001', payload: { a: 1 } },
        forgedGenesis
      );

      const verification = verifyChainIntegrity([entry1], GENESIS_HASH);
      assert.strictEqual(verification.isValid, false);
      assert.strictEqual(verification.tamperedIndex, 0);
      assert.ok(verification.reason?.includes('Genesis previousHash mismatch'));
    });
  });

  // -------------------------------------------------------------
  // Group 2: Merkle Tree & Financial Shift Anchoring
  // -------------------------------------------------------------
  describe('2. Merkle Tree & Financial Shift Anchoring', () => {
    it('2.1 should compute correct Merkle root for even number of transactions (4 leaves)', () => {
      const leaves = [
        '1111111111111111111111111111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222222222222222222222222222',
        '3333333333333333333333333333333333333333333333333333333333333333',
        '4444444444444444444444444444444444444444444444444444444444444444',
      ];

      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      const expectedH12 = hashPair(leaves[0], leaves[1]);
      const expectedH34 = hashPair(leaves[2], leaves[3]);
      const expectedRoot = hashPair(expectedH12, expectedH34);

      assert.strictEqual(root, expectedRoot);
      assert.strictEqual(root.length, 64);
    });

    it('2.2 should handle odd number of transactions by duplicating last node', () => {
      const leaves = [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ];

      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      const hAB = hashPair(leaves[0], leaves[1]);
      const hCC = hashPair(leaves[2], leaves[2]); // duplicated
      const expectedRoot = hashPair(hAB, hCC);

      assert.strictEqual(root, expectedRoot);
    });

    it('2.3 should generate and verify valid cryptographic Merkle inclusion proofs', () => {
      const leaves = [
        'leaf_0_00000000000000000000000000000000000000000000000000000000000000',
        'leaf_1_00000000000000000000000000000000000000000000000000000000000000',
        'leaf_2_00000000000000000000000000000000000000000000000000000000000000',
        'leaf_3_00000000000000000000000000000000000000000000000000000000000000',
        'leaf_4_00000000000000000000000000000000000000000000000000000000000000',
      ];

      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      // Verify proof for each leaf
      for (let i = 0; i < leaves.length; i++) {
        const proofObj = tree.generateProof(i);
        assert.strictEqual(proofObj.leafHash, leaves[i]);
        assert.strictEqual(proofObj.root, root);

        const isValid = MerkleTree.verifyProof(proofObj.leafHash, proofObj.proof, root);
        assert.strictEqual(isValid, true, `Proof verification failed for leaf index ${i}`);
      }
    });

    it('2.4 should fail verification if leaf hash is altered or fake', () => {
      const leaves = ['hash1', 'hash2', 'hash3', 'hash4'];
      const tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      const proofObj = tree.generateProof(1);
      const fakeLeaf = 'forged_tampered_leaf_hash';

      const isValid = MerkleTree.verifyProof(fakeLeaf, proofObj.proof, root);
      assert.strictEqual(isValid, false);
    });

    it('2.5 should anchor an end-of-shift batch of entries into a ShiftSnapshot', () => {
      const e1 = createAuditEntry(
        { actor: dummyActor, action: 'ORDER_CREATE', entityId: 'ORD_1', payload: { val: 100 } },
        GENESIS_HASH
      );
      const e2 = createAuditEntry(
        { actor: dummyActor, action: 'ORDER_CREATE', entityId: 'ORD_2', payload: { val: 200 } },
        e1.currentHash
      );

      const snapshot = MerkleTree.anchorShift('SHIFT_20260930_CA1', [e1, e2], {
        branchId: 'BRANCH_D1_HCMC',
        metadata: { cashierName: 'Nguyen Van A', drawerCashExpected: 5000000 },
      });

      assert.strictEqual(snapshot.shiftId, 'SHIFT_20260930_CA1');
      assert.strictEqual(snapshot.branchId, 'BRANCH_D1_HCMC');
      assert.strictEqual(snapshot.totalTransactions, 2);
      assert.strictEqual(snapshot.firstHash, e1.currentHash);
      assert.strictEqual(snapshot.lastHash, e2.currentHash);
      assert.strictEqual(snapshot.merkleRoot.length, 64);
    });
  });

  // -------------------------------------------------------------
  // Group 3: Real-Time Anomaly & Fraud Detection Engine
  // -------------------------------------------------------------
  describe('3. Real-Time Anomaly & Fraud Detection Engine', () => {
    let detector: AnomalyDetector;

    beforeEach(() => {
      detector = new AnomalyDetector();
    });

    it('3.1 should trigger WARNING when ORDER_CANCEL exceeds 500k VND', () => {
      const entry = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CANCEL',
          entityId: 'ORD_991',
          payload: { amount: 650000, reason: 'Khách đổi ý' },
          timestamp: new Date(2026, 8, 30, 14, 0).getTime(), // 14:00 daytime
        },
        GENESIS_HASH
      );

      const anomalies = detector.detect(entry);
      assert.strictEqual(anomalies.length, 1);
      assert.strictEqual(anomalies[0].ruleId, 'ORDER_CANCEL_OVER_LIMIT');
      assert.strictEqual(anomalies[0].severity, 'WARNING');
      assert.ok(anomalies[0].message.includes('650.000'));
    });

    it('3.2 should trigger CRITICAL when ORDER_CANCEL exceeds 5M VND', () => {
      const entry = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CANCEL',
          entityId: 'ORD_992',
          payload: { totalAmount: 7500000 },
          timestamp: new Date(2026, 8, 30, 15, 0).getTime(),
        },
        GENESIS_HASH
      );

      const anomalies = detector.detect(entry);
      assert.strictEqual(anomalies.length, 1);
      assert.strictEqual(anomalies[0].ruleId, 'ORDER_CANCEL_CRITICAL_AMOUNT');
      assert.strictEqual(anomalies[0].severity, 'CRITICAL');
    });

    it('3.3 should trigger CRITICAL when ORDER_CANCEL happens after 22h night', () => {
      const entry = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CANCEL',
          entityId: 'ORD_993',
          payload: { amount: 100000 }, // small amount under 500k
          timestamp: new Date(2026, 8, 30, 23, 15).getTime(), // 23:15 night
        },
        GENESIS_HASH
      );

      const anomalies = detector.detect(entry);
      const nightAnomaly = anomalies.find((a) => a.ruleId === 'ORDER_CANCEL_NIGHT_TIME');
      assert.ok(nightAnomaly, 'Night cancellation anomaly must be flagged');
      assert.strictEqual(nightAnomaly?.severity, 'CRITICAL');
      assert.ok(nightAnomaly?.message.includes('sau 22h đêm'));
    });

    it('3.4 should trigger WARNING when PRICE_OVERRIDE discount > 10% and CRITICAL for Cashier', () => {
      // Case A: Cashier giving 15% discount (> 10%)
      const entryCashier = createAuditEntry(
        {
          actor: dummyActor, // role: CASHIER
          action: 'PRICE_OVERRIDE',
          entityId: 'ITEM_881',
          payload: { originalPrice: 100000, overridePrice: 85000 }, // 15% discount
        },
        GENESIS_HASH
      );

      const anomaliesA = detector.detect(entryCashier);
      assert.strictEqual(anomaliesA.length, 1);
      assert.strictEqual(anomaliesA[0].ruleId, 'PRICE_OVERRIDE_UNAUTHORIZED');
      assert.strictEqual(anomaliesA[0].severity, 'CRITICAL'); // Escalate to CRITICAL for cashier

      // Case B: Manager giving 15% discount
      const entryManager = createAuditEntry(
        {
          actor: managerActor, // role: BRANCH_MANAGER
          action: 'PRICE_OVERRIDE',
          entityId: 'ITEM_882',
          payload: { discountPercent: 15 },
        },
        GENESIS_HASH
      );

      const anomaliesB = detector.detect(entryManager);
      assert.strictEqual(anomaliesB.length, 1);
      assert.strictEqual(anomaliesB[0].severity, 'WARNING');

      // Case C: Critical discount > 30%
      const entryExtreme = createAuditEntry(
        {
          actor: managerActor,
          action: 'PRICE_OVERRIDE',
          entityId: 'ITEM_883',
          payload: { discountPercent: 40 },
        },
        GENESIS_HASH
      );

      const anomaliesC = detector.detect(entryExtreme);
      assert.strictEqual(anomaliesC.length, 1);
      assert.strictEqual(anomaliesC[0].ruleId, 'PRICE_OVERRIDE_CRITICAL_DISCOUNT');
      assert.strictEqual(anomaliesC[0].severity, 'CRITICAL');
    });

    it('3.5 should flag CASH_DISCREPANCY > 200k VND on cash drawer audit', () => {
      // Discrepancy 350,000 VND (> 200k, < 1m) -> WARNING
      const entryWarning = createAuditEntry(
        {
          actor: dummyActor,
          action: 'CASH_DRAWER_OPEN',
          entityId: 'DRAWER_D1_01',
          payload: { expectedCash: 5000000, actualCash: 4650000 }, // diff = 350,000
        },
        GENESIS_HASH
      );

      const anomalies1 = detector.detect(entryWarning);
      const warningFlag = anomalies1.find((a) => a.ruleId === 'CASH_DISCREPANCY_WARNING');
      assert.ok(warningFlag);
      assert.strictEqual(warningFlag.severity, 'WARNING');

      // Discrepancy 1,500,000 VND (> 1m) -> CRITICAL
      const entryCritical = createAuditEntry(
        {
          actor: dummyActor,
          action: 'CASH_DRAWER_OPEN',
          entityId: 'DRAWER_D1_01',
          payload: { discrepancy: 1500000 },
        },
        GENESIS_HASH
      );

      const anomalies2 = detector.detect(entryCritical);
      const criticalFlag = anomalies2.find((a) => a.ruleId === 'CASH_DISCREPANCY_CRITICAL');
      assert.ok(criticalFlag);
      assert.strictEqual(criticalFlag.severity, 'CRITICAL');
    });

    it('3.6 should alert on suspicious NO_SALE cash drawer open without transaction', () => {
      const entry = createAuditEntry(
        {
          actor: dummyActor,
          action: 'CASH_DRAWER_OPEN',
          entityId: 'DRAWER_D1_01',
          payload: { reason: 'NO_SALE', note: 'Mở đổi tiền lẻ cho khách' },
        },
        GENESIS_HASH
      );

      const anomalies = detector.detect(entry);
      const noSaleFlag = anomalies.find((a) => a.ruleId === 'CASH_DRAWER_NO_SALE_OPEN');
      assert.ok(noSaleFlag);
      assert.strictEqual(noSaleFlag.severity, 'WARNING');
    });

    it('3.7 should alert on unauthorized DEBT_WRITEOFF attempts', () => {
      const entryCashier = createAuditEntry(
        {
          actor: dummyActor, // role: CASHIER
          action: 'DEBT_WRITEOFF',
          entityId: 'DEBT_CUST_100',
          payload: { amount: 500000, reason: 'Khách khó đòi' },
        },
        GENESIS_HASH
      );

      const anomalies = detector.detect(entryCashier);
      assert.strictEqual(anomalies.length, 1);
      assert.strictEqual(anomalies[0].ruleId, 'DEBT_WRITEOFF_UNAUTHORIZED');
      assert.strictEqual(anomalies[0].severity, 'CRITICAL');
    });

    it('3.8 should support registering custom anomaly rules', () => {
      // Custom rule: Flag any action with IP outside trusted intranet
      detector.registerRule((entry) => {
        if (!entry.actor.ipAddress?.startsWith('192.168.')) {
          return {
            ruleId: 'SUSPICIOUS_REMOTE_IP',
            severity: 'CRITICAL',
            message: `Truy cập từ địa chỉ IP bên ngoài không an toàn: ${entry.actor.ipAddress}`,
            detectedAt: Date.now(),
          };
        }
        return null;
      });

      const entryExternal = createAuditEntry(
        {
          actor: { ...dummyActor, ipAddress: '103.21.244.2' },
          action: 'ORDER_CREATE',
          entityId: 'ORD_999',
          payload: { total: 50000 },
        },
        GENESIS_HASH
      );

      const anomalies = detector.detect(entryExternal);
      const customFlag = anomalies.find((a) => a.ruleId === 'SUSPICIOUS_REMOTE_IP');
      assert.ok(customFlag);
      assert.strictEqual(customFlag.severity, 'CRITICAL');
    });
  });

  // -------------------------------------------------------------
  // Group 4: AuditLogger & Storage Persistence
  // -------------------------------------------------------------
  describe('4. AuditLogger & Storage Persistence', () => {
    let tempDir: string;
    let tempLogFile: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-audit-test-'));
      tempLogFile = path.join(tempDir, 'audit-chain.jsonl');
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('4.1 should automatically trigger onAnomalyDetected callback upon logging an anomaly', async () => {
      let callbackInvoked = false;
      let capturedAnomaliesCount = 0;

      const memoryStorage = new MemoryStorageAdapter();
      const logger = new AuditLogger({
        storage: memoryStorage,
        onAnomalyDetected: async (_entry, anomalies) => {
          callbackInvoked = true;
          capturedAnomaliesCount = anomalies.length;
        },
      });

      await logger.initialize();

      // Log normal order (no anomaly)
      const res1 = await logger.log({
        actor: dummyActor,
        action: 'ORDER_CREATE',
        entityId: 'ORD_001',
        payload: { total: 100000 },
      });
      assert.strictEqual(res1.anomalies.length, 0);
      assert.strictEqual(callbackInvoked, false);

      // Log suspicious order cancel > 500k
      const res2 = await logger.log({
        actor: dummyActor,
        action: 'ORDER_CANCEL',
        entityId: 'ORD_002',
        payload: { amount: 800000 },
        timestamp: new Date(2026, 8, 30, 10, 0).getTime(),
      });
      assert.strictEqual(res2.anomalies.length, 1);
      assert.strictEqual(callbackInvoked, true);
      assert.strictEqual(capturedAnomaliesCount, 1);

      // Verify chain integrity in memory
      const integrity = await logger.verifyIntegrity();
      assert.strictEqual(integrity.isValid, true);
      assert.strictEqual(integrity.totalRecords, 2);
    });

    it('4.2 should detect tampering when memory storage records are manipulated', async () => {
      const memoryStorage = new MemoryStorageAdapter();
      const logger = new AuditLogger({ storage: memoryStorage });
      await logger.initialize();

      await logger.log({
        actor: dummyActor,
        action: 'ORDER_CREATE',
        entityId: 'ORD_001',
        payload: { amount: 500000 },
      });

      await logger.log({
        actor: dummyActor,
        action: 'ORDER_CREATE',
        entityId: 'ORD_002',
        payload: { amount: 750000 },
      });

      // Verification before tamper
      const before = await logger.verifyIntegrity();
      assert.strictEqual(before.isValid, true);

      // Malicious modification of record 1 amount
      memoryStorage._tamperRecordForTesting(1, {
        payload: { amount: 100000 }, // forged
      });

      // Verification after tamper
      const after = await logger.verifyIntegrity();
      assert.strictEqual(after.isValid, false);
      assert.strictEqual(after.tamperedIndex, 1);
    });

    it('4.3 should persist audit logs via FileStreamingStorageAdapter and recover chain state', async () => {
      const fileAdapter = new FileStreamingStorageAdapter(tempLogFile);
      const logger = new AuditLogger({ storage: fileAdapter });
      await logger.initialize();

      await logger.log({
        actor: dummyActor,
        action: 'ORDER_CREATE',
        entityId: 'ORD_F01',
        payload: { total: 120000 },
      });

      await logger.log({
        actor: dummyActor,
        action: 'ORDER_CREATE',
        entityId: 'ORD_F02',
        payload: { total: 340000 },
      });

      // Verify physical file on disk
      assert.ok(fs.existsSync(tempLogFile));
      const content = fs.readFileSync(tempLogFile, 'utf-8');
      const lines = content.trim().split('\n');
      assert.strictEqual(lines.length, 2);

      // Re-instantiate logger with same file (simulating server reboot)
      const newFileAdapter = new FileStreamingStorageAdapter(tempLogFile);
      const newLogger = new AuditLogger({ storage: newFileAdapter });
      await newLogger.initialize();

      // The new logger should resume the hash chain from the last record
      const previousLastHash = logger.getLastHash();
      assert.strictEqual(newLogger.getLastHash(), previousLastHash);

      // Append 3rd record
      await newLogger.log({
        actor: dummyActor,
        action: 'ORDER_CREATE',
        entityId: 'ORD_F03',
        payload: { total: 560000 },
      });

      // Verify complete chain of 3 records
      const integrity = await newLogger.verifyIntegrity();
      assert.strictEqual(integrity.isValid, true);
      assert.strictEqual(integrity.totalRecords, 3);
    });
  });
});
