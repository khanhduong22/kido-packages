import { WalletLedger } from './ledger';
import {
  BalanceSnapshot,
  PayoutDestination,
  PayoutMethod,
  WithdrawalRequest,
  WithdrawalStatus,
} from './types';

export interface RequestWithdrawalParams {
  withdrawalId?: string;
  walletId: string;
  userId: string;
  amount: number; // Gross amount requested
  fee?: number; // Fee deducted from gross amount
  currency?: string;
  payoutMethod: PayoutMethod;
  destination: PayoutDestination;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export class WithdrawalStateMachine {
  private requests: Map<string, WithdrawalRequest> = new Map();
  private idempotencyMap: Map<string, WithdrawalRequest> = new Map();

  constructor(private ledger: WalletLedger) {}

  /**
   * Request a new withdrawal from the EARN account.
   * Immediately moves funds from available to held via WITHDRAWAL_HOLD ledger entry.
   */
  public requestWithdrawal(params: RequestWithdrawalParams): WithdrawalRequest {
    if (this.idempotencyMap.has(params.idempotencyKey)) {
      return this.idempotencyMap.get(params.idempotencyKey)!;
    }

    if (params.amount <= 0) {
      throw new Error(`Withdrawal amount must be strictly positive: ${params.amount}`);
    }

    const fee = params.fee && params.fee >= 0 ? params.fee : 0;
    if (fee >= params.amount) {
      throw new Error(`Withdrawal fee (${fee}) cannot be greater than or equal to amount (${params.amount})`);
    }

    const netAmount = params.amount - fee;
    const wallet = this.ledger.getWallet(params.walletId);
    if (!wallet) {
      throw new Error(`Wallet "${params.walletId}" does not exist.`);
    }

    if (wallet.earnAccount.available < params.amount) {
      throw new Error(
        `Insufficient available balance in EARN account: required ${params.amount}, available: ${wallet.earnAccount.available}`
      );
    }

    const withdrawalId =
      params.withdrawalId || `wd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // 1. Move available -> held in EARN account
    const before: BalanceSnapshot = { ...wallet.earnAccount };
    wallet.earnAccount.available -= params.amount;
    wallet.earnAccount.held += params.amount;
    wallet.earnAccount.total = wallet.earnAccount.available + wallet.earnAccount.held;
    wallet.updatedAt = Date.now();
    const after: BalanceSnapshot = { ...wallet.earnAccount };

    // 2. Record immutable WITHDRAWAL_HOLD entry
    const holdEntry = this.ledger.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'EARN',
      entryType: 'WITHDRAWAL_HOLD',
      direction: 'DEBIT', // debit available, credit held
      amount: params.amount,
      fee,
      balanceBefore: before,
      balanceAfter: after,
      currency: wallet.currency,
      referenceType: 'WITHDRAWAL_REQUEST',
      referenceId: withdrawalId,
      idempotencyKey: `${params.idempotencyKey}:hold`,
      metadata: {
        netAmount,
        payoutMethod: params.payoutMethod,
        destination: params.destination,
        ...params.metadata,
      },
    });

    const request: WithdrawalRequest = {
      withdrawalId,
      walletId: wallet.walletId,
      userId: wallet.userId,
      amount: params.amount,
      fee,
      netAmount,
      currency: wallet.currency,
      payoutMethod: params.payoutMethod,
      destination: params.destination,
      status: 'PENDING',
      idempotencyKey: params.idempotencyKey,
      holdLedgerEntryId: holdEntry.id,
      requestedAt: Date.now(),
      metadata: params.metadata,
    };

    this.requests.set(withdrawalId, request);
    this.idempotencyMap.set(params.idempotencyKey, request);
    return request;
  }

  /**
   * Approve a pending withdrawal request
   */
  public approveWithdrawal(withdrawalId: string, reviewedBy?: string): WithdrawalRequest {
    const request = this.getRequestOrThrow(withdrawalId);

    if (request.status !== 'PENDING' && request.status !== 'REQUESTED') {
      throw new Error(
        `Cannot approve withdrawal ${withdrawalId} in status "${request.status}". Only PENDING withdrawals can be approved.`
      );
    }

    request.status = 'APPROVED';
    request.reviewedAt = Date.now();
    if (reviewedBy && request.metadata) {
      request.metadata.reviewedBy = reviewedBy;
    }
    return request;
  }

  /**
   * Complete a withdrawal after successful on-chain or banking transfer.
   * Debits held balance via WITHDRAWAL_DEBIT ledger entry.
   */
  public completeWithdrawal(withdrawalId: string, txHashOrRef?: string): WithdrawalRequest {
    const request = this.getRequestOrThrow(withdrawalId);

    if (request.status === 'COMPLETED') {
      return request;
    }

    if (request.status !== 'APPROVED' && request.status !== 'PENDING') {
      throw new Error(
        `Cannot complete withdrawal ${withdrawalId} in status "${request.status}". Must be APPROVED or PENDING.`
      );
    }

    const wallet = this.ledger.getWallet(request.walletId);
    if (!wallet) {
      throw new Error(`Wallet "${request.walletId}" not found for withdrawal ${withdrawalId}`);
    }

    // Debit held balance
    const before: BalanceSnapshot = { ...wallet.earnAccount };
    wallet.earnAccount.held -= request.amount;
    wallet.earnAccount.total = wallet.earnAccount.available + wallet.earnAccount.held;
    wallet.updatedAt = Date.now();
    const after: BalanceSnapshot = { ...wallet.earnAccount };

    const debitEntry = this.ledger.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'EARN',
      entryType: 'WITHDRAWAL_DEBIT',
      direction: 'DEBIT',
      amount: request.amount,
      fee: request.fee,
      balanceBefore: before,
      balanceAfter: after,
      currency: wallet.currency,
      referenceType: 'WITHDRAWAL_COMPLETE',
      referenceId: withdrawalId,
      idempotencyKey: `${request.idempotencyKey}:complete`,
      metadata: { txHashOrRef, netAmount: request.netAmount },
    });

    request.status = 'COMPLETED';
    request.completedAt = Date.now();
    request.txHashOrRef = txHashOrRef;
    request.debitLedgerEntryId = debitEntry.id;

    return request;
  }

  /**
   * Reject a withdrawal request and release held funds back to available balance.
   */
  public rejectWithdrawal(withdrawalId: string, reason: string): WithdrawalRequest {
    const request = this.getRequestOrThrow(withdrawalId);

    if (request.status === 'COMPLETED') {
      throw new Error(`Cannot reject already COMPLETED withdrawal ${withdrawalId}`);
    }

    if (request.status === 'REJECTED' || request.status === 'CANCELLED') {
      return request;
    }

    const wallet = this.ledger.getWallet(request.walletId);
    if (!wallet) {
      throw new Error(`Wallet "${request.walletId}" not found`);
    }

    // Release held funds back to available
    const before: BalanceSnapshot = { ...wallet.earnAccount };
    wallet.earnAccount.held -= request.amount;
    wallet.earnAccount.available += request.amount;
    wallet.earnAccount.total = wallet.earnAccount.available + wallet.earnAccount.held;
    wallet.updatedAt = Date.now();
    const after: BalanceSnapshot = { ...wallet.earnAccount };

    const releaseEntry = this.ledger.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'EARN',
      entryType: 'WITHDRAWAL_RELEASE',
      direction: 'CREDIT',
      amount: request.amount,
      fee: 0,
      balanceBefore: before,
      balanceAfter: after,
      currency: wallet.currency,
      referenceType: 'WITHDRAWAL_REJECT',
      referenceId: withdrawalId,
      idempotencyKey: `${request.idempotencyKey}:release`,
      metadata: { reason },
    });

    request.status = 'REJECTED';
    request.rejectedAt = Date.now();
    request.rejectionReason = reason;
    request.releaseLedgerEntryId = releaseEntry.id;

    return request;
  }

  /**
   * Cancel a withdrawal request (by user) before it is processed.
   */
  public cancelWithdrawal(withdrawalId: string, reason: string = 'User cancelled'): WithdrawalRequest {
    const request = this.getRequestOrThrow(withdrawalId);

    if (request.status !== 'PENDING' && request.status !== 'REQUESTED') {
      throw new Error(`Cannot cancel withdrawal in "${request.status}" state.`);
    }

    const res = this.rejectWithdrawal(withdrawalId, reason);
    res.status = 'CANCELLED';
    return res;
  }

  /**
   * Get withdrawal request by ID
   */
  public getWithdrawal(withdrawalId: string): WithdrawalRequest | undefined {
    return this.requests.get(withdrawalId);
  }

  /**
   * Get withdrawal request by idempotency key
   */
  public getWithdrawalByIdempotency(key: string): WithdrawalRequest | undefined {
    return this.idempotencyMap.get(key);
  }

  /**
   * Helper to fetch or throw
   */
  private getRequestOrThrow(withdrawalId: string): WithdrawalRequest {
    const request = this.requests.get(withdrawalId);
    if (!request) {
      throw new Error(`Withdrawal request "${withdrawalId}" does not exist.`);
    }
    return request;
  }
}
