# @kido/wallet-ledger

> **Dual-Wallet (Use / Earn) Accounting Engine & Immutable Financial Audit Ledger**
> Kiến trúc sổ cái kế toán kép chuẩn FinTech, phân tách triệt để ví chi tiêu nội bộ (Use Account) và ví thu nhập hoa hồng (Earn Account), tích hợp máy trạng thái rút tiền (Withdrawal State Machine), khóa số dư Hold/Release, bảo vệ khóa Idempotency và tính tỷ giá sàn FX Floor bảo vệ biên lợi nhuận.

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
    accountNumber: '0987654321',
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
