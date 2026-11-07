import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WalletLedger,
  WithdrawalStateMachine,
  calculateFxFloor,
  executeWacbTransaction,
  calculatePortfolioValuation,
  calculatePortfolioRiskMetrics,
  downsampleChartLabels,
  L1QuoteSnapshotCache,
} from './index';

describe('@kido/wallet-ledger Test Suite', () => {
  let ledger: WalletLedger;
  let sm: WithdrawalStateMachine;

  beforeEach(() => {
    ledger = new WalletLedger();
    sm = new WithdrawalStateMachine(ledger);
  });

  // -------------------------------------------------------------
  // Group 1: Dual-Wallet & Double-Entry Accounting
  // -------------------------------------------------------------
  describe('1. Dual-Wallet & Double-Entry Accounting', () => {
    it('1.1 should initialize dual-wallet with USE (non-withdrawable) and EARN (withdrawable)', () => {
      const wallet = ledger.createWallet('wal_01', 'usr_01', 'VND');

      assert.strictEqual(wallet.walletId, 'wal_01');
      assert.strictEqual(wallet.userId, 'usr_01');
      assert.strictEqual(wallet.currency, 'VND');

      // Use account assertions
      assert.strictEqual(wallet.useAccount.available, 0);
      assert.strictEqual(wallet.useAccount.held, 0);
      assert.strictEqual(wallet.useAccount.total, 0);
      assert.strictEqual(wallet.useAccount.isWithdrawable, false);

      // Earn account assertions
      assert.strictEqual(wallet.earnAccount.available, 0);
      assert.strictEqual(wallet.earnAccount.held, 0);
      assert.strictEqual(wallet.earnAccount.total, 0);
      assert.strictEqual(wallet.earnAccount.isWithdrawable, true);
    });

    it('1.2 should credit and debit USE account with exact balance tracking', () => {
      ledger.createWallet('wal_02', 'usr_02', 'VND');

      // Credit 500,000 VND
      const { entry: creditEntry, wallet: w1 } = ledger.creditUseAccount({
        walletId: 'wal_02',
        amount: 500_000,
        referenceType: 'CRYPTO_DEPOSIT',
        referenceId: 'DEP_001',
        idempotencyKey: 'idem_credit_1',
      });

      assert.strictEqual(creditEntry.direction, 'CREDIT');
      assert.strictEqual(creditEntry.amount, 500_000);
      assert.strictEqual(w1.useAccount.available, 500_000);
      assert.strictEqual(w1.useAccount.total, 500_000);

      // Debit 120,000 VND
      const { entry: debitEntry, wallet: w2 } = ledger.debitUseAccount({
        walletId: 'wal_02',
        amount: 120_000,
        referenceType: 'SUBSCRIPTION_PURCHASE',
        referenceId: 'SUB_001',
        idempotencyKey: 'idem_debit_1',
      });

      assert.strictEqual(debitEntry.direction, 'DEBIT');
      assert.strictEqual(debitEntry.amount, 120_000);
      assert.strictEqual(w2.useAccount.available, 380_000);
      assert.strictEqual(w2.useAccount.total, 380_000);
    });

    it('1.3 should prevent double charging via idempotency key', () => {
      ledger.createWallet('wal_03', 'usr_03', 'VND');

      // First credit
      ledger.creditUseAccount({
        walletId: 'wal_03',
        amount: 100_000,
        referenceType: 'TOPUP',
        referenceId: 'TOPUP_1',
        idempotencyKey: 'idem_unique_key',
      });

      // Second credit with identical idempotency key
      const repeat = ledger.creditUseAccount({
        walletId: 'wal_03',
        amount: 100_000,
        referenceType: 'TOPUP',
        referenceId: 'TOPUP_1',
        idempotencyKey: 'idem_unique_key',
      });

      // Balance must NOT double to 200,000; it must stay 100,000
      assert.strictEqual(repeat.wallet.useAccount.available, 100_000);

      const entries = ledger.getLedgerEntries('wal_03');
      assert.strictEqual(entries.length, 1);
    });

    it('1.4 should reject debit when available balance is insufficient', () => {
      ledger.createWallet('wal_04', 'usr_04', 'VND');

      assert.throws(
        () => {
          ledger.debitUseAccount({
            walletId: 'wal_04',
            amount: 50_000,
            referenceType: 'PURCHASE',
            referenceId: 'P1',
            idempotencyKey: 'idem_fail_1',
          });
        },
        /Insufficient available balance/
      );
    });

    it('1.5 should transfer funds from EARN to USE with bonus incentive', () => {
      ledger.createWallet('wal_05', 'usr_05', 'VND');

      // Credit Earn account 200,000 VND
      ledger.creditEarnAccount({
        walletId: 'wal_05',
        amount: 200_000,
        referenceType: 'AFFILIATE_COMMISSION',
        referenceId: 'COMM_01',
        idempotencyKey: 'idem_comm_1',
      });

      // Transfer 100,000 VND from Earn -> Use with 10% bonus
      const result = ledger.transferEarnToUse({
        walletId: 'wal_05',
        amount: 100_000,
        bonusPercent: 10, // 10k bonus
        idempotencyKey: 'idem_transfer_01',
      });

      // Earn account available reduced by 100,000
      assert.strictEqual(result.wallet.earnAccount.available, 100_000);
      assert.strictEqual(result.earnEntry.amount, 100_000);

      // Use account received 100,000 + 10,000 bonus = 110,000
      assert.strictEqual(result.wallet.useAccount.available, 110_000);
      assert.strictEqual(result.useEntry.amount, 110_000);
    });
  });

  // -------------------------------------------------------------
  // Group 2: Withdrawal State Machine
  // -------------------------------------------------------------
  describe('2. Withdrawal State Machine', () => {
    beforeEach(() => {
      ledger.createWallet('wal_wd_01', 'usr_wd_01', 'VND');
      ledger.creditEarnAccount({
        walletId: 'wal_wd_01',
        amount: 1_000_000,
        referenceType: 'AFFILIATE_COMMISSION',
        referenceId: 'COMM_WD_01',
        idempotencyKey: 'idem_init_earn',
      });
    });

    it('2.1 should lock funds into held balance upon withdrawal request', () => {
      const request = sm.requestWithdrawal({
        walletId: 'wal_wd_01',
        userId: 'usr_wd_01',
        amount: 300_000,
        fee: 10_000,
        payoutMethod: 'BANK_TRANSFER_VN',
        destination: {
          bankCode: '970422',
          accountNumber: '123456789',
          accountName: 'TEST USER',
        },
        idempotencyKey: 'idem_wd_1',
      });

      assert.strictEqual(request.status, 'PENDING');
      assert.strictEqual(request.amount, 300_000);
      assert.strictEqual(request.netAmount, 290_000);

      const wallet = ledger.getWallet('wal_wd_01')!;
      // Available must be 700,000
      assert.strictEqual(wallet.earnAccount.available, 700_000);
      // Held must be 300,000
      assert.strictEqual(wallet.earnAccount.held, 300_000);
      // Total must still be 1,000,000
      assert.strictEqual(wallet.earnAccount.total, 1_000_000);
    });

    it('2.2 should execute complete withdrawal lifecycle: REQUEST -> APPROVE -> COMPLETE', () => {
      const request = sm.requestWithdrawal({
        walletId: 'wal_wd_01',
        userId: 'usr_wd_01',
        amount: 400_000,
        fee: 10_000,
        payoutMethod: 'BANK_TRANSFER_VN',
        destination: { accountNumber: '999999' },
        idempotencyKey: 'idem_wd_lifecycle',
      });

      // Approve
      const approved = sm.approveWithdrawal(request.withdrawalId, 'admin_kido');
      assert.strictEqual(approved.status, 'APPROVED');

      // Complete
      const completed = sm.completeWithdrawal(request.withdrawalId, 'TX_BANK_REF_9988');
      assert.strictEqual(completed.status, 'COMPLETED');
      assert.strictEqual(completed.txHashOrRef, 'TX_BANK_REF_9988');

      const wallet = ledger.getWallet('wal_wd_01')!;
      // Available: 600,000
      assert.strictEqual(wallet.earnAccount.available, 600_000);
      // Held: 0
      assert.strictEqual(wallet.earnAccount.held, 0);
      // Total: 600,000 (400,000 completely debited)
      assert.strictEqual(wallet.earnAccount.total, 600_000);
    });

    it('2.3 should release held funds back to available balance upon REJECT or CANCEL', () => {
      const request = sm.requestWithdrawal({
        walletId: 'wal_wd_01',
        userId: 'usr_wd_01',
        amount: 250_000,
        payoutMethod: 'USDT_TRC20',
        destination: { cryptoAddress: 'TYASw5k19fr6TsZfG83uE8F2P3' },
        idempotencyKey: 'idem_wd_reject',
      });

      const walletBefore = ledger.getWallet('wal_wd_01')!;
      assert.strictEqual(walletBefore.earnAccount.available, 750_000);
      assert.strictEqual(walletBefore.earnAccount.held, 250_000);

      // Admin rejects
      const rejected = sm.rejectWithdrawal(request.withdrawalId, 'Invalid crypto wallet address format');
      assert.strictEqual(rejected.status, 'REJECTED');

      const walletAfter = ledger.getWallet('wal_wd_01')!;
      // Held balance refunded to available
      assert.strictEqual(walletAfter.earnAccount.available, 1_000_000);
      assert.strictEqual(walletAfter.earnAccount.held, 0);
      assert.strictEqual(walletAfter.earnAccount.total, 1_000_000);
    });

    it('2.4 should prevent illegal state transitions (e.g. rejecting completed withdrawal)', () => {
      const request = sm.requestWithdrawal({
        walletId: 'wal_wd_01',
        userId: 'usr_wd_01',
        amount: 100_000,
        payoutMethod: 'BANK_TRANSFER_VN',
        destination: { accountNumber: '111' },
        idempotencyKey: 'idem_wd_illegal',
      });

      sm.completeWithdrawal(request.withdrawalId, 'TX_DONE');

      assert.throws(
        () => {
          sm.rejectWithdrawal(request.withdrawalId, 'Trying to reject after completed');
        },
        /Cannot reject already COMPLETED/
      );
    });
  });

  // -------------------------------------------------------------
  // Group 3: calculateFxFloor & Currency Margin Protection
  // -------------------------------------------------------------
  describe('3. calculateFxFloor & Margin Protection', () => {
    it('3.1 should calculate deposit rate with spread and safety buffer', () => {
      // Market rate: 25,400 VND / USDT
      // Spread: 1.5%, Safety buffer: 0.5% => Total 2.0%
      // Rate = 25,400 * (1 - 0.02) = 24,892
      const fx = calculateFxFloor({
        marketRate: 25_400,
        direction: 'DEPOSIT',
        spreadPercent: 1.5,
        safetyBufferPercent: 0.5,
      });

      assert.strictEqual(fx.effectiveRate, 24_892);
      assert.strictEqual(fx.appliedSpreadPercent, 2.0);
      assert.strictEqual(fx.isFloorTriggered, false);

      const conv = fx.convert(100); // 100 USDT
      assert.strictEqual(conv.convertedAmount, 2_489_200);
      assert.strictEqual(conv.spreadFeeAmount, 50_800); // Profit retained
    });

    it('3.2 should enforce minFloorRate when calculated rate drops too low', () => {
      const fx = calculateFxFloor({
        marketRate: 20_000,
        direction: 'DEPOSIT',
        spreadPercent: 5.0,
        minFloorRate: 19_500, // Hard floor
      });

      // Raw = 20,000 * 0.945 = 18,900 < 19,500
      assert.strictEqual(fx.effectiveRate, 19_500);
      assert.strictEqual(fx.isFloorTriggered, true);
    });

    it('3.3 should reject negative amounts in conversion', () => {
      const fx = calculateFxFloor({
        marketRate: 25_000,
        direction: 'DEPOSIT',
      });

      assert.throws(() => {
        fx.convert(-50);
      }, /Cannot convert negative amount/);
    });
  });

  // -------------------------------------------------------------
  // Group 4: Ledger Audit & Integrity Verification
  // -------------------------------------------------------------
  describe('4. Ledger Audit & Integrity Verification', () => {
    it('4.1 should successfully verify audit trail across multi-step transactions', () => {
      ledger.createWallet('wal_audit_1', 'usr_audit_1', 'VND');

      // Step 1: Deposit USE
      ledger.creditUseAccount({
        walletId: 'wal_audit_1',
        amount: 1_000_000,
        referenceType: 'TOPUP',
        referenceId: 'T1',
        idempotencyKey: 'idem_a1',
      });

      // Step 2: Buy service from USE
      ledger.debitUseAccount({
        walletId: 'wal_audit_1',
        amount: 250_000,
        referenceType: 'PURCHASE',
        referenceId: 'P1',
        idempotencyKey: 'idem_a2',
      });

      // Step 3: Earn affiliate in EARN
      ledger.creditEarnAccount({
        walletId: 'wal_audit_1',
        amount: 500_000,
        referenceType: 'COMMISSION',
        referenceId: 'C1',
        idempotencyKey: 'idem_a3',
      });

      // Step 4: Transfer some EARN to USE
      ledger.transferEarnToUse({
        walletId: 'wal_audit_1',
        amount: 100_000,
        bonusPercent: 5,
        idempotencyKey: 'idem_a4',
      });

      // Step 5: Withdraw remaining EARN
      sm.requestWithdrawal({
        walletId: 'wal_audit_1',
        userId: 'usr_audit_1',
        amount: 200_000,
        fee: 5_000,
        payoutMethod: 'BANK_TRANSFER_VN',
        destination: { accountNumber: '888' },
        idempotencyKey: 'idem_a5',
      });

      const audit = ledger.auditLedgerIntegrity('wal_audit_1');
      assert.strictEqual(audit.isValid, true);
      assert.strictEqual(audit.discrepancies.length, 0);
      assert.strictEqual(audit.totalEntries > 0, true);
    });

    it('4.2 should detect tampering when wallet live balance is illegally modified', () => {
      ledger.createWallet('wal_tamper_1', 'usr_tamper_1', 'VND');

      ledger.creditUseAccount({
        walletId: 'wal_tamper_1',
        amount: 100_000,
        referenceType: 'TOPUP',
        referenceId: 'T1',
        idempotencyKey: 'idem_t1',
      });

      // Hacker alters balance directly on object
      const wallet = ledger.getWallet('wal_tamper_1')!;
      wallet.useAccount.available = 999_999; // Forged

      const audit = ledger.auditLedgerIntegrity('wal_tamper_1');
      assert.strictEqual(audit.isValid, false);
      assert.ok(audit.discrepancies.some((d) => d.includes('Final USE available mismatch')));
    });
  });

  // -------------------------------------------------------------
  // Group 5: Portfolio NAV Valuation, WACB Ledger & Risk Metrics
  // -------------------------------------------------------------
  describe('5. Portfolio NAV Valuation, WACB Ledger & Risk Metrics', () => {
    it('5.1 should compute Weighted Average Cost Basis (WACB) across BUY and SELL transactions', () => {
      let state = {
        cashBalance: 100_000_000,
        holdings: [],
      };

      // Buy 1,000 HPG at 50,000 + 50,000 fee -> avgCost = 50,050
      state = executeWacbTransaction(state, {
        symbol: 'hpg',
        side: 'BUY',
        quantity: 1000,
        price: 50_000,
        fee: 50_000,
      });

      assert.strictEqual(state.holdings.length, 1);
      assert.strictEqual(state.holdings[0]?.symbol, 'HPG');
      assert.strictEqual(state.holdings[0]?.quantity, 1000);
      assert.strictEqual(state.holdings[0]?.avgCostPrice, 50_050);
      assert.strictEqual(state.cashBalance, 49_950_000);

      // Buy another 1,000 HPG at 60,000 + 50,000 fee -> total cost = 110,100,000 / 2000 = 55,050
      state = executeWacbTransaction(state, {
        symbol: 'HPG',
        side: 'BUY',
        quantity: 1000,
        price: 60_000,
        fee: 50_000,
      });

      assert.strictEqual(state.holdings[0]?.quantity, 2000);
      assert.strictEqual(state.holdings[0]?.avgCostPrice, 55_050);

      // Sell 500 HPG at 65,000 -> avgCostPrice remains 55,050, quantity becomes 1500
      state = executeWacbTransaction(state, {
        symbol: 'HPG',
        side: 'SELL',
        quantity: 500,
        price: 65_000,
        fee: 25_000,
      });

      assert.strictEqual(state.holdings[0]?.quantity, 1500);
      assert.strictEqual(state.holdings[0]?.avgCostPrice, 55_050);
    });

    it('5.2 should valuate portfolio holdings and filter asset classes cleanly', () => {
      const cache = new L1QuoteSnapshotCache({ ttlMs: 60_000 });
      cache.setQuote('VNM', 62_000, 2.5, 1_000);
      cache.setQuote('HPG', 28_000, -1.2, 1_000);

      const summary = calculatePortfolioValuation(
        {
          cashBalance: 10_000_000,
          holdings: [
            { symbol: 'VNM', assetType: 'STOCK', quantity: 1000, avgCostPrice: 50_000 },
            { symbol: 'HPG', assetType: 'STOCK', quantity: 2000, avgCostPrice: 25_000 },
            { symbol: 'BTC', assetType: 'CRYPTO', quantity: 1, avgCostPrice: 90_000 },
          ],
        },
        cache.hydratePricesMap(1_500),
        { filterAssetType: 'STOCK' },
      );

      assert.strictEqual(summary.holdings.length, 2);
      assert.strictEqual(summary.marketValue, 118_000_000); // 62M + 56M
      assert.strictEqual(summary.totalCost, 100_000_000); // 50M + 50M
      assert.strictEqual(summary.totalValue, 128_000_000); // 118M + 10M cash
      assert.strictEqual(summary.totalPnL, 18_000_000);
      assert.strictEqual(summary.totalPnLPct, 18);
    });

    it('5.3 should compute Sharpe Ratio, Beta, Max Drawdown, Alpha, and downsample chart labels', () => {
      const points = [
        { date: '2026-10-01', navValue: 100_000_000, portfolioReturnPct: 0, benchmarkReturnPct: 0 },
        { date: '2026-10-02', navValue: 103_000_000, portfolioReturnPct: 3.0, benchmarkReturnPct: 1.5 },
        { date: '2026-10-03', navValue: 99_910_000, portfolioReturnPct: -0.09, benchmarkReturnPct: -0.5 },
        { date: '2026-10-04', navValue: 105_000_000, portfolioReturnPct: 5.0, benchmarkReturnPct: 2.0 },
        { date: '2026-10-05', navValue: 108_000_000, portfolioReturnPct: 8.0, benchmarkReturnPct: 3.5 },
      ];

      const metrics = calculatePortfolioRiskMetrics(points);
      assert.strictEqual(metrics.totalReturnPct, 8);
      assert.strictEqual(metrics.benchmarkReturnPct, 3.5);
      assert.strictEqual(metrics.alphaPct, 4.5);
      assert.strictEqual(metrics.maxDrawdownPct, 3); // 103M -> 99.91M is 3% drawdown
      assert.ok(metrics.sharpeRatio > 0);
      assert.ok(metrics.beta > 0);

      const rawLabels = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'];
      const ticks = downsampleChartLabels(rawLabels, 4);
      assert.strictEqual(ticks.length, 4);
      assert.strictEqual(ticks[0], 'D1');
      assert.strictEqual(ticks[3], 'D10');
    });
  });
});
