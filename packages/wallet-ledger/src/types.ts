export type WalletAccountType = 'USE' | 'EARN';

export type EntryDirection = 'CREDIT' | 'DEBIT';

export type LedgerEntryType =
  | 'DEPOSIT'
  | 'PURCHASE'
  | 'REFUND'
  | 'COMMISSION_EARNED'
  | 'TRANSFER_EARN_TO_USE'
  | 'WITHDRAWAL_HOLD'
  | 'WITHDRAWAL_DEBIT'
  | 'WITHDRAWAL_RELEASE'
  | 'CLAWBACK_DEBIT'
  | 'ADJUSTMENT';

export interface AccountBalance {
  available: number;
  held: number;
  total: number;
  currency: string;
}

export interface UseAccountBalance extends AccountBalance {
  readonly isWithdrawable: false;
}

export interface EarnAccountBalance extends AccountBalance {
  readonly isWithdrawable: true;
}

export interface DualWallet {
  walletId: string;
  userId: string;
  currency: string;
  useAccount: UseAccountBalance;
  earnAccount: EarnAccountBalance;
  createdAt: number;
  updatedAt: number;
}

export interface BalanceSnapshot {
  available: number;
  held: number;
  total: number;
}

export interface WalletLedgerEntry {
  id: string;
  walletId: string;
  userId: string;
  accountType: WalletAccountType;
  entryType: LedgerEntryType;
  direction: EntryDirection;
  amount: number;
  fee: number;
  balanceBefore: BalanceSnapshot;
  balanceAfter: BalanceSnapshot;
  currency: string;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export type WithdrawalStatus =
  | 'REQUESTED'
  | 'PENDING'
  | 'APPROVED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED';

export type PayoutMethod =
  | 'BANK_TRANSFER_VN'
  | 'USDT_TRC20'
  | 'USDT_BEP20'
  | 'USDT_ERC20'
  | 'PAYPAL';

export interface PayoutDestination {
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  cryptoAddress?: string;
  network?: string;
  email?: string;
}

export interface WithdrawalRequest {
  withdrawalId: string;
  walletId: string;
  userId: string;
  amount: number; // Gross amount requested
  fee: number; // Platform fee
  netAmount: number; // Amount recipient receives (amount - fee)
  currency: string;
  payoutMethod: PayoutMethod;
  destination: PayoutDestination;
  status: WithdrawalStatus;
  idempotencyKey: string;
  holdLedgerEntryId: string;
  debitLedgerEntryId?: string;
  releaseLedgerEntryId?: string;
  requestedAt: number;
  reviewedAt?: number;
  completedAt?: number;
  rejectedAt?: number;
  rejectionReason?: string;
  txHashOrRef?: string;
  metadata?: Record<string, unknown>;
}

export interface FxFloorParams {
  marketRate: number; // e.g. 25,450 VND / USD
  direction: 'DEPOSIT' | 'WITHDRAWAL';
  spreadPercent?: number; // e.g. 1.5%
  minFloorRate?: number; // Absolute safety floor
  maxCeilingRate?: number; // Absolute safety ceiling
  safetyBufferPercent?: number; // e.g. 0.5%
  roundDecimals?: number; // 0 for VND, 4 for Crypto
}

export interface FxFloorResult {
  effectiveRate: number;
  marketRate: number;
  direction: 'DEPOSIT' | 'WITHDRAWAL';
  appliedSpreadPercent: number;
  isFloorTriggered: boolean;
  isCeilingTriggered: boolean;
  convert: (amount: number) => {
    convertedAmount: number;
    spreadFeeAmount: number;
  };
}

export interface LedgerAuditResult {
  isValid: boolean;
  totalEntries: number;
  walletId: string;
  verifiedBalances: {
    use: BalanceSnapshot;
    earn: BalanceSnapshot;
  };
  discrepancies: string[];
}
