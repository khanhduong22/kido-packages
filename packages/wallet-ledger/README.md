# @kido/wallet-ledger

> **Dual-Wallet (Use / Earn) Accounting Engine & Immutable Financial Audit Ledger**  
> FinTech-grade double-entry ledger architecture isolating internal credit spending (Use Account) from withdrawable affiliate revenue (Earn Account), integrated with a formal Withdrawal State Machine, Held/Release balance locking, Idempotency protection, FX Floor margin defense, Stateless Crypto micro-decimal reconciliation, and anti-fraud referral clawback.

---

## 🏛️ 3-Tier Progressive Scale Architecture (`Naive Baseline` → `Tier-0 SME Zero-Infra` → `Tier-1 Growth` → `Tier-2 Big-Tech`)

### Architecture Comparison Table

| Tier | Architecture & Mechanism | Cost & Ops | Performance / SLA | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| **Naive Baseline** | **Direct Mutable Column**: `UPDATE users SET balance = balance + 100 WHERE id = $1`. Single mutable integer, no journal entries, no separation of withdrawable vs non-withdrawable funds, manual Excel reconciliations. | $0 extra | ~50 ops/s<br>(Deadlock prone) | 🛑 **Anti-pattern**: Immediate audit failure, lost updates during concurrent writes, negative balance race conditions, no transaction history. |
| **Tier-0 SME Zero-Infra** | **Embedded Dual-Wallet & In-Memory Idempotency**: `WalletLedger` with separate `USE` and `EARN` accounts, state-machine withdrawal hold locking, and mathematical Genesis balance verification (`auditLedgerIntegrity`). | **$5/mo** (Single VPS / SQLite / single PostgreSQL) | **> 1,500 tx/s**<br>Latency < 2ms | ✅ **Default for SMEs & Startups**: $0 Redis/Kafka cost, complete FinTech double-entry accounting and audit trail on a single node. |
| **Tier-1 Growth** | **PostgreSQL Row-Locking & Append-Only Journal**: Transactional `SELECT ... FOR UPDATE`, tenant-partitioned ledger tables, automated referral fraud detection (`ReferralFraudGuard`), and 4-tier micro-decimal deposit reconciliation (`MicroDecimalAmountGenerator`). | **$30 - $60/mo** (Managed DB / Replica) | **8,000 tx/s**<br>p99 < 15ms | ⭐ **Growing FinTech & E-Commerce**: 100k+ active wallets, affiliate referral networks, automated crypto USDT deposit matching. |
| **Tier-2 Big-Tech** | **Distributed Event-Sourced Ledger & CQRS**: Sharded ledger streams (Kafka / TigerBeetle / ScyllaDB), portfolio NAV valuation (`executeWacbTransaction`, `calculatePortfolioRiskMetrics`), and real-time anti-fraud subnet scoring. | **$250 - $800/mo** (Distributed Cluster) | **100,000+ tx/s**<br>Sub-millisecond | 🚀 **Big-Tech Enterprise**: Multi-region crypto exchanges, neo-banks, high-frequency settlement, multi-portfolio asset management. |

---

### Evolutionary Architecture Diagram

```mermaid
flowchart TD
    subgraph S0["Naive Baseline (Anti-Pattern)"]
        N_Req["Concurrent Deposit & Debit"] -->|Unsafe Mutation| N_DB[("Mutable Database\nUPDATE balance = balance + X")]
        N_DB -->|Race Condition & Lost Updates| N_Fail["Balance Mismatch & Double Spend"]
    end

    subgraph S1["Tier-0 SME Zero-Infra ($5/mo Single VPS)"]
        T0_Req["API Deposit / Payout"] --> T0_Ledger["WalletLedger Engine\n(USE vs EARN Separation)"]
        T0_Ledger --> T0_SM["WithdrawalStateMachine\n(AVAILABLE -> HELD -> DEBITED)"]
        T0_SM --> T0_Audit["auditLedgerIntegrity()\n(Deterministic Genesis Balance Proof)"]
        T0_Audit --> T0_DB[("Single SQLite / PostgreSQL\n(1 Node, $0 Infra Cost)")]
    end

    subgraph S2["Tier-1 Growth (Scale & Compliance)"]
        T1_Req["Affiliate & Deposit Influx"] --> T1_Guard["ReferralFraudGuard\n(Subnet / Disposable / Velocity)"]
        T1_Guard --> T1_Reconcile["Crypto Micro-Decimal Engine\n(4-Tier Unique Offset Matching)"]
        T1_Reconcile --> T1_PG[("PostgreSQL Master\n(SELECT FOR UPDATE + Partitioned Ledger)")]
    end

    subgraph S3["Tier-2 Big-Tech (100k+ tx/s)"]
        T2_Req["Global High-Frequency Trading"] --> T2_Kafka["Distributed Event Stream\n(Kafka / Pulsar Partitioned by WalletId)"]
        T2_Kafka --> T2_Beetle["TigerBeetle / Sharded Ledger Engine\n(Sub-millisecond Double-Entry)"]
        T2_Beetle --> T2_NAV["Portfolio NAV & Risk Engine\n(WACB, Sharpe, Max Drawdown)"]
        T2_NAV --> T2_Store[("Distributed Sharded Storage\nMulti-Region Active-Active")]
    end
```

---

### Concrete Code Examples: Tier-0 SME vs Tier-2 Big-Tech

#### 1. Tier-0 SME Zero-Infra Mode
Perfect for early-stage platforms on a single $5/month VPS. Uses the embedded double-entry engine, dual-wallet isolation, withdrawal state machine, and in-memory idempotency without needing Redis or external queues:

```typescript
import { WalletLedger, WithdrawalStateMachine, calculateFxFloor } from '@kido/wallet-ledger';

// 1. Initialize embedded ledger (Zero external infra required)
const ledger = new WalletLedger();
const stateMachine = new WithdrawalStateMachine(ledger);

// 2. Create customer wallet with separated USE (credits) and EARN (payouts) accounts
const wallet = ledger.createWallet('wal_sme_001', 'usr_sme_101', 'VND');

// 3. Customer deposits 500,000 VND (Credited to non-withdrawable USE account)
ledger.creditUseAccount({
  walletId: wallet.walletId,
  amount: 500_000,
  referenceType: 'DIRECT_DEPOSIT',
  referenceId: 'DEP_ORD_2001',
  idempotencyKey: 'idem_dep_sme_2001',
});

// 4. Partner receives 150,000 VND affiliate commission (Credited to withdrawable EARN account)
ledger.creditEarnAccount({
  walletId: wallet.walletId,
  amount: 150_000,
  referenceType: 'AFFILIATE_COMMISSION',
  referenceId: 'REF_TX_4001',
  idempotencyKey: 'idem_ref_sme_4001',
});

// 5. Withdrawal request: Locks funds from 'available' to 'held' instantly
const withdrawal = stateMachine.requestWithdrawal({
  walletId: wallet.walletId,
  userId: 'usr_sme_101',
  amount: 100_000,
  fee: 5_000,
  payoutMethod: 'BANK_TRANSFER_VN',
  destination: { bankCode: '970422', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' },
  idempotencyKey: 'idem_wd_sme_3001',
});

// 6. Complete withdrawal upon bank payout confirmation
stateMachine.approveWithdrawal(withdrawal.withdrawalId, 'admin_sme');
stateMachine.completeWithdrawal(withdrawal.withdrawalId, 'BANK_REF_998877');

// 7. Verify mathematical balance integrity from genesis
const audit = ledger.auditLedgerIntegrity(wallet.walletId);
console.log('Ledger audit passed:', audit.isValid); // true
```

#### 2. Tier-2 Big-Tech Mode
Designed for high-throughput enterprise platforms, automated stateless crypto micro-decimal reconciliations, fraud scoring, and portfolio risk management:

```typescript
import {
  WalletLedger,
  MicroDecimalAmountGenerator,
  CryptoTransactionMatcher,
  ReferralFraudGuard,
  ReferralClawbackManager,
  executeWacbTransaction,
  calculatePortfolioValuation,
  calculatePortfolioRiskMetrics,
} from '@kido/wallet-ledger';

// 1. Anti-Fraud Screening: Evaluate referral velocity, IP subnets, and disposable emails
const fraudGuard = new ReferralFraudGuard({
  maxRegistrationsPerHourPerIp: 10,
  prohibitDisposableEmails: true,
});

const fraudScore = fraudGuard.evaluateRegistration({
  referrerId: 'usr_affiliate_01',
  refereeEmail: 'user@example.com',
  refereeIp: '198.51.100.45',
  referrerRecentIps: ['198.51.100.12'], // Same /24 subnet check
  registeredAt: new Date(),
});

if (fraudScore.isSuspicious) {
  console.warn('Fraud alert flagged:', fraudScore.reasons);
}

// 2. High-Frequency Stateless Crypto Micro-Decimal Deposit Matching
// Generates unique micro-decimal amount (e.g., 50.0014 USDT) to match on-chain deposits without hot-wallet DB writes
const microGenerator = new MicroDecimalAmountGenerator();
const depositIntent = microGenerator.generateDepositAmount({
  baseAmount: 50.0,
  orderId: 'ORD_CRYPTO_9999',
  userId: 'usr_crypto_88',
});

console.log(`Instruct user to transfer exact amount: ${depositIntent.exactAmount} USDT`);

// Match incoming on-chain blockchain transaction
const matcher = new CryptoTransactionMatcher();
const matchResult = matcher.matchTransaction({
  txAmount: depositIntent.exactAmount,
  txHash: '0x3a1b...c89d',
  timestamp: Date.now(),
});

// 3. Multi-Asset Portfolio NAV & Weighted Average Cost Basis (WACB) Ledger
let portfolioState = {
  holdings: new Map(),
  cashBalance: 100_000, // $100,000 USD initial liquidity
  realizedPnl: 0,
};

// Execute purchase transaction with exact WACB math
portfolioState = executeWacbTransaction(portfolioState, {
  assetSymbol: 'BTC/USD',
  action: 'BUY',
  quantity: 1.5,
  executionPrice: 65_000,
  timestamp: Date.now(),
});

// Calculate real-time portfolio metrics
const valuation = calculatePortfolioValuation(portfolioState, {
  'BTC/USD': 68_000,
});
console.log('Unrealized Profit:', valuation.totalUnrealizedPnl);
```

---

## 🌟 Đặt Vấn Đề & Kiến Trúc Giải Pháp

Trong các hệ thống SaaS, E-Commerce và Affiliate Platform hiện đại:
1. **Phân Định Trách Nhiệm Dòng Tiền**:
   - Khách nạp tiền để mua dịch vụ (Ví dụ: nạp 1,000,000 VND mua credits AI hoặc gói hội viên) là khoản **Doanh thu hoãn lại (Deferred Revenue)**, không được phép rút tiền mặt ra ngoài (tránh biến nền tảng thành dịch vụ trung gian thanh toán trái phép hoặc rửa tiền). Đây là **`USE Account`** (`isWithdrawable: false`).
   - Đối tác, Affiliate, Nhà sáng tạo kiếm được tiền hoa hồng/doanh thu là khoản **Phải trả người bán (Accounts Payable)**. Khoản này ĐƯỢC PHÉP rút về tài khoản ngân hàng hoặc ví crypto, hoặc có thể chuyển sang `USE Account` để chi tiêu nội bộ. Đây là **`EARN Account`** (`isWithdrawable: true`).

2. **Kế Toán Kép & Sổ Cái Bất Biến (Double-Entry & Immutable Ledger)**:
   - Không bao giờ cập nhật số dư bằng câu lệnh SQL đơn thuần như `UPDATE wallet SET balance = balance + 100`.
   - Mọi biến động đều phát sinh bản ghi sổ cái `WalletLedgerEntry` ghi nhận chính xác: `balanceBefore`, `balanceAfter`, `direction`, `entryType`, `referenceId`, và `idempotencyKey`.
   - Có thể kiểm toán và khôi phục toàn vẹn số dư từ đầu kỳ (Genesis) thông qua `auditLedgerIntegrity`.

3. **Vòng Đời Rút Tiền Chuẩn SRE/FinTech (Withdrawal State Machine)**:
   - `REQUESTED` / `PENDING`: Khóa số dư tức thì sang `held` qua bút toán `WITHDRAWAL_HOLD`. Người dùng không thể rút kép hay chi tiêu số tiền đang chờ duyệt.
   - `APPROVED`: Quản trị viên hoặc bot risk engine phê duyệt. Tiền vẫn nằm trong `held`.
   - `COMPLETED`: Chuyển tiền thành công -> trừ số dư `held` qua bút toán `WITHDRAWAL_DEBIT`.
   - `REJECTED` / `CANCELLED`: Giao dịch bị hủy hoặc từ chối -> giải phóng số dư `held` trả lại `available` qua bút toán `WITHDRAWAL_RELEASE`.

4. **Tính Tỷ Giá Sàn FX Floor (`calculateFxFloor`)**:
   - Khi quy đổi giữa Crypto (USDT) và Fiat (VND), biến động tỷ giá và spread ngân hàng có thể làm xói mòn lợi nhuận.
   - `calculateFxFloor` áp dụng spread hệ thống + biên an toàn (safety buffer) và sàn tối thiểu/trần tối đa, đảm bảo hệ thống không bao giờ bị âm biên lợi nhuận khi thanh toán.

---

## 🚀 Cài Đặt & Sử Dụng

```bash
pnpm add @kido/wallet-ledger
# hoặc bun add @kido/wallet-ledger
```

### 1. Khởi Tạo Ví & Bút Toán Kế Toán Kép

```typescript
import { WalletLedger } from '@kido/wallet-ledger';

const ledger = new WalletLedger();

// Tạo ví cho người dùng
const wallet = ledger.createWallet('wal_usr_01', 'usr_01', 'VND');

// 1. Nạp tiền vào USE Account (mua gói dịch vụ)
ledger.creditUseAccount({
  walletId: 'wal_usr_01',
  amount: 500_000,
  referenceType: 'CRYPTO_DEPOSIT',
  referenceId: 'DEP_ORD_100',
  idempotencyKey: 'idem_dep_100',
});

// 2. Tiêu tiền từ USE Account
ledger.debitUseAccount({
  walletId: 'wal_usr_01',
  amount: 150_000,
  referenceType: 'SUBSCRIPTION_PURCHASE',
  referenceId: 'SUB_PRO_1M',
  idempotencyKey: 'idem_sub_01',
});

// 3. Nhận hoa hồng affiliate vào EARN Account
ledger.creditEarnAccount({
  walletId: 'wal_usr_01',
  amount: 200_000,
  referenceType: 'AFFILIATE_COMMISSION',
  referenceId: 'REF_REW_88',
  idempotencyKey: 'idem_ref_88',
});

// 4. Chuyển tiền từ EARN sang USE (kèm thưởng 5% khuyến mại)
ledger.transferEarnToUse({
  walletId: 'wal_usr_01',
  amount: 50_000,
  bonusPercent: 5, // Nhận thêm 2,500 VND vào USE account
  idempotencyKey: 'idem_transfer_01',
});

// Kiểm toán tính toàn vẹn sổ cái từ Genesis
const audit = ledger.auditLedgerIntegrity('wal_usr_01');
console.log(audit.isValid); // true
```

### 2. Vòng Đời Rút Tiền (`WithdrawalStateMachine`)

```typescript
import { WalletLedger, WithdrawalStateMachine } from '@kido/wallet-ledger';

const ledger = new WalletLedger();
const sm = new WithdrawalStateMachine(ledger);

// Khách yêu cầu rút 100,000 VND từ ví Earn
const request = sm.requestWithdrawal({
  walletId: 'wal_usr_01',
  userId: 'usr_01',
  amount: 100_000,
  fee: 5_000, // Phí rút tiền 5k
  payoutMethod: 'BANK_TRANSFER_VN',
  destination: {
    bankCode: '970422', // MB Bank
    accountNumber: '0123456789',
    accountName: 'NGUYEN VAN A',
  },
  idempotencyKey: 'idem_wd_req_01',
});

// Admin duyệt
sm.approveWithdrawal(request.withdrawalId, 'admin_super');

// Sau khi chuyển khoản thành công:
sm.completeWithdrawal(request.withdrawalId, 'FT2610051239812');
```

### 3. Tỷ Giá Sàn FX Floor (`calculateFxFloor`)

```typescript
import { calculateFxFloor } from '@kido/wallet-ledger';

// Tỷ giá thị trường: 25,450 VND / USDT
// Tính tỷ giá quy đổi nạp tiền bảo vệ spread 1.5% + 0.5% buffer
const fx = calculateFxFloor({
  marketRate: 25_450,
  direction: 'DEPOSIT',
  spreadPercent: 1.5,
  safetyBufferPercent: 0.5,
  roundDecimals: 0,
});

console.log(fx.effectiveRate); // 24,941 VND / USDT
const conversion = fx.convert(100); // 100 USDT
console.log(conversion.convertedAmount); // 2,494,100 VND
console.log(conversion.spreadFeeAmount); // 50,900 VND (Biên lợi nhuận giữ lại)
```

---

## 🧪 Chạy Test

```bash
bun test
# hoặc pnpm test
```
