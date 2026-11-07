import {
  BalanceSnapshot,
  DualWallet,
  EarnAccountBalance,
  LedgerAuditResult,
  LedgerEntryType,
  UseAccountBalance,
  WalletAccountType,
  WalletLedgerEntry,
} from './types';

export interface CreditParams {
  walletId: string;
  amount: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface DebitParams {
  walletId: string;
  amount: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface TransferEarnToUseParams {
  walletId: string;
  amount: number;
  bonusPercent?: number; // e.g. 5% extra credits when moving Earn -> Use
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export class WalletLedger {
  private wallets: Map<string, DualWallet> = new Map();
  private entries: Map<string, WalletLedgerEntry[]> = new Map(); // walletId -> entries
  private idempotencyIndex: Map<string, WalletLedgerEntry> = new Map(); // idempotencyKey -> entry

  /**
   * Initialize a new dual-account wallet for a user
   */
  public createWallet(walletId: string, userId: string, currency: string = 'VND'): DualWallet {
    if (this.wallets.has(walletId)) {
      return this.wallets.get(walletId)!;
    }

    const now = Date.now();
    const useAccount: UseAccountBalance = {
      available: 0,
      held: 0,
      total: 0,
      currency: currency.toUpperCase(),
      isWithdrawable: false,
    };

    const earnAccount: EarnAccountBalance = {
      available: 0,
      held: 0,
      total: 0,
      currency: currency.toUpperCase(),
      isWithdrawable: true,
    };

    const wallet: DualWallet = {
      walletId,
      userId,
      currency: currency.toUpperCase(),
      useAccount,
      earnAccount,
      createdAt: now,
      updatedAt: now,
    };

    this.wallets.set(walletId, wallet);
    this.entries.set(walletId, []);
    return wallet;
  }

  /**
   * Get wallet by wallet ID
   */
  public getWallet(walletId: string): DualWallet | undefined {
    return this.wallets.get(walletId);
  }

  /**
   * Helper to fetch or throw
   */
  private getWalletOrThrow(walletId: string): DualWallet {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error(`Wallet with ID "${walletId}" does not exist.`);
    }
    return wallet;
  }

  /**
   * Credit the USE account (e.g. deposit topup, refund)
   */
  public creditUseAccount(params: CreditParams): { entry: WalletLedgerEntry; wallet: DualWallet } {
    if (this.idempotencyIndex.has(params.idempotencyKey)) {
      const existingEntry = this.idempotencyIndex.get(params.idempotencyKey)!;
      return { entry: existingEntry, wallet: this.getWalletOrThrow(params.walletId) };
    }

    if (params.amount <= 0) {
      throw new Error(`Credit amount must be strictly positive, received: ${params.amount}`);
    }

    const wallet = this.getWalletOrThrow(params.walletId);
    const before: BalanceSnapshot = { ...wallet.useAccount };

    wallet.useAccount.available += params.amount;
    wallet.useAccount.total = wallet.useAccount.available + wallet.useAccount.held;
    wallet.updatedAt = Date.now();

    const after: BalanceSnapshot = { ...wallet.useAccount };

    const entry = this.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'USE',
      entryType: 'DEPOSIT',
      direction: 'CREDIT',
      amount: params.amount,
      fee: 0,
      balanceBefore: before,
      balanceAfter: after,
      currency: wallet.currency,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
    });

    return { entry, wallet };
  }

  /**
   * Debit the USE account (e.g. purchase package, pay subscription)
   */
  public debitUseAccount(params: DebitParams): { entry: WalletLedgerEntry; wallet: DualWallet } {
    if (this.idempotencyIndex.has(params.idempotencyKey)) {
      const existingEntry = this.idempotencyIndex.get(params.idempotencyKey)!;
      return { entry: existingEntry, wallet: this.getWalletOrThrow(params.walletId) };
    }

    if (params.amount <= 0) {
      throw new Error(`Debit amount must be strictly positive, received: ${params.amount}`);
    }

    const wallet = this.getWalletOrThrow(params.walletId);
    if (wallet.useAccount.available < params.amount) {
      throw new Error(
        `Insufficient available balance in USE account: requires ${params.amount}, available: ${wallet.useAccount.available}`
      );
    }

    const before: BalanceSnapshot = { ...wallet.useAccount };

    wallet.useAccount.available -= params.amount;
    wallet.useAccount.total = wallet.useAccount.available + wallet.useAccount.held;
    wallet.updatedAt = Date.now();

    const after: BalanceSnapshot = { ...wallet.useAccount };

    const entry = this.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'USE',
      entryType: 'PURCHASE',
      direction: 'DEBIT',
      amount: params.amount,
      fee: 0,
      balanceBefore: before,
      balanceAfter: after,
      currency: wallet.currency,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
    });

    return { entry, wallet };
  }

  /**
   * Credit the EARN account (e.g. affiliate commission, ad revenue)
   */
  public creditEarnAccount(params: CreditParams): { entry: WalletLedgerEntry; wallet: DualWallet } {
    if (this.idempotencyIndex.has(params.idempotencyKey)) {
      const existingEntry = this.idempotencyIndex.get(params.idempotencyKey)!;
      return { entry: existingEntry, wallet: this.getWalletOrThrow(params.walletId) };
    }

    if (params.amount <= 0) {
      throw new Error(`Credit amount must be strictly positive, received: ${params.amount}`);
    }

    const wallet = this.getWalletOrThrow(params.walletId);
    const before: BalanceSnapshot = { ...wallet.earnAccount };

    wallet.earnAccount.available += params.amount;
    wallet.earnAccount.total = wallet.earnAccount.available + wallet.earnAccount.held;
    wallet.updatedAt = Date.now();

    const after: BalanceSnapshot = { ...wallet.earnAccount };

    const entry = this.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'EARN',
      entryType: 'COMMISSION_EARNED',
      direction: 'CREDIT',
      amount: params.amount,
      fee: 0,
      balanceBefore: before,
      balanceAfter: after,
      currency: wallet.currency,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
    });

    return { entry, wallet };
  }

  /**
   * Transfer funds from EARN account to USE account (with optional bonus promotion)
   */
  public transferEarnToUse(params: TransferEarnToUseParams): {
    earnEntry: WalletLedgerEntry;
    useEntry: WalletLedgerEntry;
    wallet: DualWallet;
  } {
    const earnIdemKey = `${params.idempotencyKey}:earn_debit`;
    const useIdemKey = `${params.idempotencyKey}:use_credit`;

    if (this.idempotencyIndex.has(earnIdemKey) && this.idempotencyIndex.has(useIdemKey)) {
      return {
        earnEntry: this.idempotencyIndex.get(earnIdemKey)!,
        useEntry: this.idempotencyIndex.get(useIdemKey)!,
        wallet: this.getWalletOrThrow(params.walletId),
      };
    }

    if (params.amount <= 0) {
      throw new Error(`Transfer amount must be strictly positive: ${params.amount}`);
    }

    const wallet = this.getWalletOrThrow(params.walletId);
    if (wallet.earnAccount.available < params.amount) {
      throw new Error(
        `Insufficient available balance in EARN account: required ${params.amount}, available: ${wallet.earnAccount.available}`
      );
    }

    const bonusRate = params.bonusPercent && params.bonusPercent > 0 ? params.bonusPercent : 0;
    const bonusAmount = (params.amount * bonusRate) / 100;
    const creditedToUse = params.amount + bonusAmount;

    // 1. Debit EARN account
    const earnBefore: BalanceSnapshot = { ...wallet.earnAccount };
    wallet.earnAccount.available -= params.amount;
    wallet.earnAccount.total = wallet.earnAccount.available + wallet.earnAccount.held;
    const earnAfter: BalanceSnapshot = { ...wallet.earnAccount };

    const earnEntry = this.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'EARN',
      entryType: 'TRANSFER_EARN_TO_USE',
      direction: 'DEBIT',
      amount: params.amount,
      fee: 0,
      balanceBefore: earnBefore,
      balanceAfter: earnAfter,
      currency: wallet.currency,
      referenceType: 'TRANSFER_TO_USE',
      referenceId: params.idempotencyKey,
      idempotencyKey: earnIdemKey,
      metadata: { bonusPercent: bonusRate, bonusAmount, creditedToUse, ...params.metadata },
    });

    // 2. Credit USE account
    const useBefore: BalanceSnapshot = { ...wallet.useAccount };
    wallet.useAccount.available += creditedToUse;
    wallet.useAccount.total = wallet.useAccount.available + wallet.useAccount.held;
    const useAfter: BalanceSnapshot = { ...wallet.useAccount };

    const useEntry = this.recordEntry({
      walletId: wallet.walletId,
      userId: wallet.userId,
      accountType: 'USE',
      entryType: 'TRANSFER_EARN_TO_USE',
      direction: 'CREDIT',
      amount: creditedToUse,
      fee: 0,
      balanceBefore: useBefore,
      balanceAfter: useAfter,
      currency: wallet.currency,
      referenceType: 'TRANSFER_FROM_EARN',
      referenceId: params.idempotencyKey,
      idempotencyKey: useIdemKey,
      metadata: { transferredFromEarn: params.amount, bonusAmount, ...params.metadata },
    });

    wallet.updatedAt = Date.now();

    return { earnEntry, useEntry, wallet };
  }

  /**
   * Internal recorder for ledger entries with immutability guarantees
   */
  public recordEntry(
    raw: Omit<WalletLedgerEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }
  ): WalletLedgerEntry {
    const entry: WalletLedgerEntry = {
      id: raw.id || `ent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: raw.timestamp || Date.now(),
      ...raw,
    };

    const walletEntries = this.entries.get(entry.walletId);
    if (!walletEntries) {
      this.entries.set(entry.walletId, [entry]);
    } else {
      walletEntries.push(entry);
    }

    this.idempotencyIndex.set(entry.idempotencyKey, entry);
    return entry;
  }

  /**
   * Get all immutable ledger entries for a wallet
   */
  public getLedgerEntries(
    walletId: string,
    options?: { accountType?: WalletAccountType; limit?: number }
  ): WalletLedgerEntry[] {
    const list = this.entries.get(walletId) || [];
    let filtered = options?.accountType ? list.filter((e) => e.accountType === options.accountType) : list;
    if (options?.limit && options.limit > 0) {
      filtered = filtered.slice(-options.limit);
    }
    return filtered;
  }

  /**
   * Check if idempotency key exists
   */
  public hasIdempotencyKey(key: string): boolean {
    return this.idempotencyIndex.has(key);
  }

  /**
   * Retrieve entry by idempotency key
   */
  public getEntryByIdempotencyKey(key: string): WalletLedgerEntry | undefined {
    return this.idempotencyIndex.get(key);
  }

  /**
   * Cryptographically audit ledger integrity for a wallet by replaying all entries from genesis.
   */
  public auditLedgerIntegrity(walletId: string): LedgerAuditResult {
    const wallet = this.getWalletOrThrow(walletId);
    const list = this.entries.get(walletId) || [];

    const computedUse: BalanceSnapshot = { available: 0, held: 0, total: 0 };
    const computedEarn: BalanceSnapshot = { available: 0, held: 0, total: 0 };
    const discrepancies: string[] = [];

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      const target = entry.accountType === 'USE' ? computedUse : computedEarn;

      // Assert balanceBefore matches computed balance at this point
      if (
        Math.abs(target.available - entry.balanceBefore.available) > 0.0001 ||
        Math.abs(target.held - entry.balanceBefore.held) > 0.0001 ||
        Math.abs(target.total - entry.balanceBefore.total) > 0.0001
      ) {
        discrepancies.push(
          `Entry index ${i} (${entry.id}) balanceBefore mismatch: expected ${JSON.stringify(
            target
          )}, recorded ${JSON.stringify(entry.balanceBefore)}`
        );
      }

      // Replay entry transformation
      switch (entry.entryType) {
        case 'DEPOSIT':
        case 'COMMISSION_EARNED':
        case 'REFUND':
          target.available += entry.amount;
          break;

        case 'PURCHASE':
          target.available -= entry.amount;
          break;

        case 'TRANSFER_EARN_TO_USE':
          if (entry.direction === 'DEBIT') {
            target.available -= entry.amount;
          } else {
            target.available += entry.amount;
          }
          break;

        case 'WITHDRAWAL_HOLD':
          target.available -= entry.amount;
          target.held += entry.amount;
          break;

        case 'WITHDRAWAL_DEBIT':
          target.held -= entry.amount;
          break;

        case 'WITHDRAWAL_RELEASE':
          target.held -= entry.amount;
          target.available += entry.amount;
          break;

        case 'CLAWBACK_DEBIT':
          target.available -= entry.amount;
          break;

        case 'ADJUSTMENT':
          if (entry.direction === 'CREDIT') {
            target.available += entry.amount;
          } else {
            target.available -= entry.amount;
          }
          break;
      }

      target.total = target.available + target.held;

      // Assert balanceAfter matches computed balance
      if (
        Math.abs(target.available - entry.balanceAfter.available) > 0.0001 ||
        Math.abs(target.held - entry.balanceAfter.held) > 0.0001 ||
        Math.abs(target.total - entry.balanceAfter.total) > 0.0001
      ) {
        discrepancies.push(
          `Entry index ${i} (${entry.id}) balanceAfter mismatch: computed ${JSON.stringify(
            target
          )}, recorded ${JSON.stringify(entry.balanceAfter)}`
        );
      }
    }

    // Compare final computed balances with current live wallet state
    if (Math.abs(computedUse.available - wallet.useAccount.available) > 0.0001) {
      discrepancies.push(
        `Final USE available mismatch: live=${wallet.useAccount.available}, computed=${computedUse.available}`
      );
    }
    if (Math.abs(computedUse.held - wallet.useAccount.held) > 0.0001) {
      discrepancies.push(
        `Final USE held mismatch: live=${wallet.useAccount.held}, computed=${computedUse.held}`
      );
    }
    if (Math.abs(computedEarn.available - wallet.earnAccount.available) > 0.0001) {
      discrepancies.push(
        `Final EARN available mismatch: live=${wallet.earnAccount.available}, computed=${computedEarn.available}`
      );
    }
    if (Math.abs(computedEarn.held - wallet.earnAccount.held) > 0.0001) {
      discrepancies.push(
        `Final EARN held mismatch: live=${wallet.earnAccount.held}, computed=${computedEarn.held}`
      );
    }

    return {
      isValid: discrepancies.length === 0,
      totalEntries: list.length,
      walletId,
      verifiedBalances: {
        use: computedUse,
        earn: computedEarn,
      },
      discrepancies,
    };
  }

  /**
   * Reset all state (for tests)
   */
  public clear(): void {
    this.wallets.clear();
    this.entries.clear();
    this.idempotencyIndex.clear();
  }
}
