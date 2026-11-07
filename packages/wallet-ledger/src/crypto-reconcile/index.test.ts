import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MicroDecimalAmountGenerator,
  CryptoTransactionMatcher,
  TIER_CONFIG,
  DepositOrder,
  OnChainTransaction,
} from './index';

describe('@kido/crypto-reconcile Test Suite', () => {
  let generator: MicroDecimalAmountGenerator;
  let matcher: CryptoTransactionMatcher;

  beforeEach(() => {
    generator = new MicroDecimalAmountGenerator();
    matcher = new CryptoTransactionMatcher();
  });

  // -------------------------------------------------------------
  // Group 1: MicroDecimalAmountGenerator & Collision Avoidance
  // -------------------------------------------------------------
  describe('1. MicroDecimalAmountGenerator', () => {
    it('1.1 should allocate distinct micro-decimal slots for same base amount without collision', () => {
      const slots = [];
      const count = 50;

      for (let i = 0; i < count; i++) {
        const slot = generator.allocate({
          orderId: `ORD_${i}`,
          baseAmount: 100,
          currency: 'USDT',
          network: 'TRON_TRC20',
          decimals: 4,
        });
        slots.push(slot);
      }

      assert.strictEqual(slots.length, count);

      // Verify all totalExpectedAmounts are unique
      const uniqueAmounts = new Set(slots.map((s) => s.totalExpectedAmount));
      assert.strictEqual(uniqueAmounts.size, count);

      // Verify format
      for (const slot of slots) {
        assert.ok(slot.totalExpectedAmount.startsWith('100.'));
        assert.strictEqual(slot.baseAmount, '100');
        assert.strictEqual(slot.status, 'ACTIVE');
        assert.strictEqual(slot.decimals, 4);
      }
    });

    it('1.2 should scale to massive concurrent allocations (5,000 slots) with zero collisions', () => {
      const totalAllocations = 5000;
      const allocatedSet = new Set<string>();

      for (let i = 0; i < totalAllocations; i++) {
        const slot = generator.allocate({
          orderId: `SCALE_ORD_${i}`,
          baseAmount: 50,
          currency: 'USDT',
          network: 'EVM_BEP20',
          priorityTier: 'TIER_4_5_DECIMALS', // 5 decimals (99,999 capacity)
        });

        assert.strictEqual(
          allocatedSet.has(slot.totalExpectedAmount),
          false,
          `Collision detected on ${slot.totalExpectedAmount} at iteration ${i}`
        );
        allocatedSet.add(slot.totalExpectedAmount);
      }

      assert.strictEqual(allocatedSet.size, totalAllocations);
      assert.strictEqual(generator.getActiveCount(), totalAllocations);
    });

    it('1.3 should auto-escalate to higher tier when lower tier is saturated', () => {
      // TIER_1_2_DECIMALS has max 99 slots
      const maxSlotsTier1 = TIER_CONFIG.TIER_1_2_DECIMALS.maxSlots;

      // Allocate all 99 slots in Tier 1
      for (let i = 1; i <= maxSlotsTier1; i++) {
        const slot = generator.allocate({
          orderId: `T1_ORD_${i}`,
          baseAmount: 20,
          currency: 'USDC',
          network: 'TRON_TRC20',
          priorityTier: 'TIER_1_2_DECIMALS',
        });
        assert.strictEqual(slot.decimals, 2);
      }

      // The 100th allocation must auto-escalate to Tier 2 (3 decimals)
      const escalatedSlot = generator.allocate({
        orderId: 'T1_ORD_OVERFLOW',
        baseAmount: 20,
        currency: 'USDC',
        network: 'TRON_TRC20',
        priorityTier: 'TIER_1_2_DECIMALS',
      });

      assert.strictEqual(escalatedSlot.decimals, 3);
      assert.ok(escalatedSlot.totalExpectedAmount.startsWith('20.'));
      assert.strictEqual(escalatedSlot.totalExpectedAmount.split('.')[1].length, 3);
    });

    it('1.4 should properly release slot and allow it to be re-allocated', () => {
      const slot1 = generator.allocate({
        orderId: 'ORDER_RELEASE_1',
        baseAmount: 100,
        currency: 'USDT',
        network: 'TRON_TRC20',
        decimals: 2,
      });

      assert.strictEqual(generator.getActiveCount(), 1);

      // Release slot
      const released = generator.release('ORDER_RELEASE_1');
      assert.strictEqual(released, true);
      assert.strictEqual(generator.getActiveCount(), 0);

      // Allocate another order - it can successfully occupy released pool
      const slot2 = generator.allocate({
        orderId: 'ORDER_RELEASE_2',
        baseAmount: 100,
        currency: 'USDT',
        network: 'TRON_TRC20',
        decimals: 2,
      });

      assert.strictEqual(generator.getActiveCount(), 1);
      assert.strictEqual(slot2.orderId, 'ORDER_RELEASE_2');
    });

    it('1.5 should mark matched slot and recycle slot from active pool', () => {
      generator.allocate({
        orderId: 'ORDER_MATCH_1',
        baseAmount: 100,
        currency: 'USDT',
        network: 'TRON_TRC20',
        decimals: 3,
      });

      assert.strictEqual(generator.getActiveCount(), 1);
      const matched = generator.markMatched('ORDER_MATCH_1');
      assert.strictEqual(matched, true);
      assert.strictEqual(generator.getActiveCount(), 0);
    });

    it('1.6 should recycle expired slots during cleanup', () => {
      const now = Date.now();
      generator.allocate({
        orderId: 'EXPIRED_ORD_1',
        baseAmount: 100,
        currency: 'USDT',
        network: 'TRON_TRC20',
        ttlSeconds: 60, // 1 minute
      });

      assert.strictEqual(generator.getActiveCount(), 1);

      // Run cleanup with future timestamp (after 2 minutes)
      const cleaned = generator.cleanupExpired(now + 120_000);
      assert.strictEqual(cleaned, 1);
      assert.strictEqual(generator.getActiveCount(), 0);
    });

    it('1.7 should report accurate capacity info', () => {
      generator.allocate({
        orderId: 'CAP_ORD_1',
        baseAmount: 500,
        currency: 'USDT',
        network: 'EVM_ERC20',
        priorityTier: 'TIER_1_2_DECIMALS',
      });

      const info = generator.getCapacityInfo(
        'EVM_ERC20',
        'USDT',
        500,
        'TIER_1_2_DECIMALS'
      );

      assert.strictEqual(info.totalSlots, 99);
      assert.strictEqual(info.activeSlots, 1);
      assert.strictEqual(info.availableSlots, 98);
      assert.strictEqual(info.decimals, 2);
    });
  });

  // -------------------------------------------------------------
  // Group 2: CryptoTransactionMatcher & On-Chain Reconciliation
  // -------------------------------------------------------------
  describe('2. CryptoTransactionMatcher', () => {
    const masterTronWallet = 'TYASw5k19fr6TsZfG83uE8F2P3MASTER';
    const usdtTrc20Contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    const sampleOrder: DepositOrder = {
      orderId: 'ORD_TRON_001',
      userId: 'usr_buyer_99',
      baseAmount: '100',
      expectedAmount: '100.0142',
      decimalSuffix: '0.0142',
      currency: 'USDT',
      network: 'TRON_TRC20',
      receivingAddress: masterTronWallet,
      tokenContractAddress: usdtTrc20Contract,
      createdAt: 1700000000000,
      expiresAt: 1700000900000, // 15 mins later
      status: 'PENDING',
    };

    it('2.1 should successfully reconcile exact on-chain match', () => {
      matcher.registerOrder(sampleOrder);

      const tx: OnChainTransaction = {
        txHash: '0x3a1f94b8e2194bc028198fbc183921820491294812',
        network: 'TRON_TRC20',
        fromAddress: 'TKdCustomerWallet123',
        toAddress: masterTronWallet,
        tokenContractAddress: usdtTrc20Contract,
        amount: '100.0142',
        blockNumber: 58000100,
        blockTimestamp: 1700000300000, // 5 mins after order created
      };

      const result = matcher.matchTransaction(tx);

      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.mismatchType, 'EXACT_MATCH');
      assert.strictEqual(result.order?.orderId, 'ORD_TRON_001');
      assert.strictEqual(result.order?.status, 'MATCHED');
      assert.strictEqual(result.order?.matchedTxHash, tx.txHash);
    });

    it('2.2 should reject duplicate transaction (replay attack defense)', () => {
      matcher.registerOrder(sampleOrder);

      const tx: OnChainTransaction = {
        txHash: '0xREPLAY_ATTACK_TX_HASH_001',
        network: 'TRON_TRC20',
        fromAddress: 'TKdCustomerWallet123',
        toAddress: masterTronWallet,
        tokenContractAddress: usdtTrc20Contract,
        amount: '100.0142',
        blockNumber: 58000100,
        blockTimestamp: 1700000300000,
      };

      // First match passes
      const first = matcher.matchTransaction(tx);
      assert.strictEqual(first.matched, true);

      // Replay of same txHash fails immediately
      const replay = matcher.matchTransaction(tx);
      assert.strictEqual(replay.matched, false);
      assert.strictEqual(replay.mismatchType, 'DUPLICATE_TX');
      assert.ok(replay.reason.includes('replay'));
    });

    it('2.3 should perform case-insensitive EVM address matching', () => {
      const evmMaster = '0x1234567890abcdef1234567890abcdef12345678';
      const evmOrder: DepositOrder = {
        orderId: 'ORD_EVM_001',
        userId: 'usr_evm_1',
        baseAmount: '250',
        expectedAmount: '250.0088',
        decimalSuffix: '0.0088',
        currency: 'USDT',
        network: 'EVM_BEP20',
        receivingAddress: evmMaster.toUpperCase(), // Uppercase in order
        createdAt: 1700000000000,
        expiresAt: 1700000900000,
        status: 'PENDING',
      };

      matcher.registerOrder(evmOrder);

      const tx: OnChainTransaction = {
        txHash: '0xevm_tx_998811',
        network: 'EVM_BEP20',
        fromAddress: '0xSenderAddress',
        toAddress: evmMaster.toLowerCase(), // Lowercase in tx
        amount: '250.0088',
        blockNumber: 1200000,
        blockTimestamp: 1700000200000,
      };

      const res = matcher.matchTransaction(tx);
      assert.strictEqual(res.matched, true);
      assert.strictEqual(res.order?.orderId, 'ORD_EVM_001');
    });

    it('2.4 should flag UNDERPAID when customer sends incorrect decimal suffix', () => {
      matcher.registerOrder(sampleOrder);

      const txUnderpaid: OnChainTransaction = {
        txHash: '0xunderpaid_tx_1',
        network: 'TRON_TRC20',
        fromAddress: 'TKdCustomerWallet123',
        toAddress: masterTronWallet,
        tokenContractAddress: usdtTrc20Contract,
        amount: '100.0100', // Expected 100.0142
        blockNumber: 58000100,
        blockTimestamp: 1700000300000,
      };

      const result = matcher.matchTransaction(txUnderpaid);
      assert.strictEqual(result.matched, false);
      assert.strictEqual(result.mismatchType, 'UNDERPAID');
      assert.strictEqual(result.order?.orderId, 'ORD_TRON_001');
      assert.ok(result.reason.includes('UNDERPAID'));
    });

    it('2.5 should reject transaction arriving after order expiration window', () => {
      matcher.registerOrder(sampleOrder);

      const txLate: OnChainTransaction = {
        txHash: '0xlate_tx_1',
        network: 'TRON_TRC20',
        fromAddress: 'TKdCustomerWallet123',
        toAddress: masterTronWallet,
        tokenContractAddress: usdtTrc20Contract,
        amount: '100.0142',
        blockNumber: 58000100,
        blockTimestamp: sampleOrder.expiresAt + 600_000, // 10 minutes past expiration (exceeding 5 min grace)
      };

      const result = matcher.matchTransaction(txLate);
      assert.strictEqual(result.matched, false);
      assert.strictEqual(result.mismatchType, 'EXPIRED');
      assert.ok(result.reason.includes('outside the valid time window'));
    });

    it('2.6 should reject transaction sent to wrong recipient address', () => {
      matcher.registerOrder(sampleOrder);

      const txWrongTo: OnChainTransaction = {
        txHash: '0xwrong_to_tx_1',
        network: 'TRON_TRC20',
        fromAddress: 'TKdCustomerWallet123',
        toAddress: 'TWrongMasterAddress99999999999999',
        tokenContractAddress: usdtTrc20Contract,
        amount: '100.0142',
        blockNumber: 58000100,
        blockTimestamp: 1700000300000,
      };

      const result = matcher.matchTransaction(txWrongTo);
      assert.strictEqual(result.matched, false);
      assert.strictEqual(result.mismatchType, 'NO_MATCHING_ORDER');
    });

    it('2.7 should support batch matching multiple transactions', () => {
      const orderA: DepositOrder = {
        orderId: 'ORD_A',
        userId: 'usr_A',
        baseAmount: '100',
        expectedAmount: '100.0001',
        decimalSuffix: '0.0001',
        currency: 'USDT',
        network: 'TRON_TRC20',
        receivingAddress: masterTronWallet,
        createdAt: 1700000000000,
        expiresAt: 1700000900000,
        status: 'PENDING',
      };

      const orderB: DepositOrder = {
        orderId: 'ORD_B',
        userId: 'usr_B',
        baseAmount: '100',
        expectedAmount: '100.0002',
        decimalSuffix: '0.0002',
        currency: 'USDT',
        network: 'TRON_TRC20',
        receivingAddress: masterTronWallet,
        createdAt: 1700000000000,
        expiresAt: 1700000900000,
        status: 'PENDING',
      };

      matcher.registerOrder(orderA);
      matcher.registerOrder(orderB);

      const results = matcher.batchMatch([
        {
          txHash: '0xBATCH_1',
          network: 'TRON_TRC20',
          fromAddress: 'addr1',
          toAddress: masterTronWallet,
          amount: '100.0001',
          blockNumber: 1,
          blockTimestamp: 1700000100000,
        },
        {
          txHash: '0xBATCH_2',
          network: 'TRON_TRC20',
          fromAddress: 'addr2',
          toAddress: masterTronWallet,
          amount: '100.0002',
          blockNumber: 2,
          blockTimestamp: 1700000100000,
        },
      ]);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].matched, true);
      assert.strictEqual(results[0].order?.orderId, 'ORD_A');
      assert.strictEqual(results[1].matched, true);
      assert.strictEqual(results[1].order?.orderId, 'ORD_B');
    });
  });
});
