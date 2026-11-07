import {
  CryptoNetwork,
  DepositOrder,
  MatchResult,
  OnChainTransaction,
} from './types';

export interface MatcherConfig {
  /**
   * Allowed clock drift before order creation in milliseconds (default: 120,000ms = 2 mins)
   */
  gracePeriodBeforeMs?: number;
  /**
   * Allowed confirmation lag after order expiration in milliseconds (default: 300,000ms = 5 mins)
   */
  gracePeriodAfterMs?: number;
  /**
   * Strict token contract matching (default: true)
   */
  enforceTokenContractMatch?: boolean;
}

export class CryptoTransactionMatcher {
  private orders: Map<string, DepositOrder> = new Map();
  private processedTxHashes: Set<string> = new Set();
  private config: Required<MatcherConfig>;

  constructor(config?: MatcherConfig) {
    this.config = {
      gracePeriodBeforeMs: config?.gracePeriodBeforeMs ?? 120_000,
      gracePeriodAfterMs: config?.gracePeriodAfterMs ?? 300_000,
      enforceTokenContractMatch: config?.enforceTokenContractMatch ?? true,
    };
  }

  /**
   * Normalize crypto address for safe cross-network comparison
   */
  public normalizeAddress(address: string, network: CryptoNetwork): string {
    const trimmed = address.trim();
    if (network.startsWith('EVM_')) {
      return trimmed.toLowerCase();
    }
    // Tron / Solana addresses are case-sensitive Base58
    return trimmed;
  }

  /**
   * Standardize amount string with exact decimal representation
   */
  public normalizeAmountString(amount: string): string {
    const trimmed = amount.trim();
    if (!trimmed.includes('.')) {
      return trimmed;
    }
    // Remove trailing zeros after decimal point unless it's just '0'
    const [intPart, decPart] = trimmed.split('.');
    const cleanDec = decPart.replace(/0+$/, '');
    return cleanDec.length > 0 ? `${intPart}.${cleanDec}` : intPart;
  }

  /**
   * Register a new pending deposit order to be monitored
   */
  public registerOrder(order: DepositOrder): void {
    if (this.orders.has(order.orderId)) {
      throw new Error(`Order with ID "${order.orderId}" is already registered in matcher.`);
    }
    this.orders.set(order.orderId, { ...order });
  }

  /**
   * Get registered order by order ID
   */
  public getOrder(orderId: string): DepositOrder | undefined {
    return this.orders.get(orderId);
  }

  /**
   * Cancel an existing pending deposit order
   */
  public cancelOrder(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;
    if (order.status !== 'PENDING') return false;

    order.status = 'CANCELLED';
    return true;
  }

  /**
   * Check if transaction hash was already matched or processed
   */
  public hasProcessedTx(txHash: string): boolean {
    return this.processedTxHashes.has(txHash.toLowerCase());
  }

  /**
   * Match an incoming on-chain transaction against registered pending orders
   */
  public matchTransaction(tx: OnChainTransaction): MatchResult {
    const normalizedTxHash = tx.txHash.toLowerCase();

    // 1. Replay attack prevention
    if (this.processedTxHashes.has(normalizedTxHash)) {
      return {
        matched: false,
        transaction: tx,
        reason: `Transaction hash ${tx.txHash} has already been processed (duplicate/replay).`,
        mismatchType: 'DUPLICATE_TX',
      };
    }

    const normalizedTxTo = this.normalizeAddress(tx.toAddress, tx.network);
    const normalizedTxAmount = this.normalizeAmountString(tx.amount);

    let matchingCandidate: DepositOrder | null = null;
    let expiredCandidate: DepositOrder | null = null;
    let partialCandidate: { order: DepositOrder; diff: number; type: 'UNDERPAID' | 'OVERPAID' } | null = null;

    for (const order of this.orders.values()) {
      // Must match network
      if (order.network !== tx.network) {
        continue;
      }

      // Must match currency
      if (order.currency.toUpperCase() !== (tx.tokenContractAddress ? order.currency.toUpperCase() : 'USDT')) {
        // Continue if currency doesn't align
      }

      // Must match receiving address
      const normalizedOrderTo = this.normalizeAddress(order.receivingAddress, order.network);
      if (normalizedOrderTo !== normalizedTxTo) {
        continue;
      }

      // Must match token contract address if required
      if (
        this.config.enforceTokenContractMatch &&
        order.tokenContractAddress &&
        tx.tokenContractAddress
      ) {
        const orderContract = this.normalizeAddress(order.tokenContractAddress, order.network);
        const txContract = this.normalizeAddress(tx.tokenContractAddress, tx.network);
        if (orderContract !== txContract) {
          continue;
        }
      }

      // Timestamp window validation
      const txTime = tx.blockTimestamp > 1e12 ? tx.blockTimestamp : tx.blockTimestamp * 1000;
      const minValidTime = order.createdAt - this.config.gracePeriodBeforeMs;
      const maxValidTime = order.expiresAt + this.config.gracePeriodAfterMs;

      const normalizedExpectedAmount = this.normalizeAmountString(order.expectedAmount);

      // Check exact amount match
      if (normalizedExpectedAmount === normalizedTxAmount) {
        if (txTime < minValidTime || txTime > maxValidTime) {
          expiredCandidate = order;
          continue;
        }

        if (order.status === 'PENDING') {
          matchingCandidate = order;
          break;
        }
      } else {
        // Check if same base amount but decimal discrepancy
        const [expInt] = normalizedExpectedAmount.split('.');
        const [actInt] = normalizedTxAmount.split('.');
        if (expInt === actInt && order.status === 'PENDING') {
          const diff = Number(normalizedTxAmount) - Number(normalizedExpectedAmount);
          partialCandidate = {
            order,
            diff,
            type: diff < 0 ? 'UNDERPAID' : 'OVERPAID',
          };
        }
      }
    }

    // Exact match found!
    if (matchingCandidate) {
      matchingCandidate.status = 'MATCHED';
      matchingCandidate.matchedTxHash = tx.txHash;
      matchingCandidate.matchedAt = Date.now();
      this.processedTxHashes.add(normalizedTxHash);

      return {
        matched: true,
        order: matchingCandidate,
        transaction: tx,
        reason: 'Successfully reconciled on-chain transaction with deposit order.',
        mismatchType: 'EXACT_MATCH',
        expectedAmount: matchingCandidate.expectedAmount,
        actualAmount: tx.amount,
      };
    }

    // Expired order candidate
    if (expiredCandidate) {
      return {
        matched: false,
        order: expiredCandidate,
        transaction: tx,
        reason: `Transaction arrived outside the valid time window for order ${expiredCandidate.orderId}.`,
        mismatchType: 'EXPIRED',
        expectedAmount: expiredCandidate.expectedAmount,
        actualAmount: tx.amount,
      };
    }

    // Amount discrepancy on same base
    if (partialCandidate) {
      return {
        matched: false,
        order: partialCandidate.order,
        transaction: tx,
        reason: `Amount mismatch for order ${partialCandidate.order.orderId}: expected ${partialCandidate.order.expectedAmount}, received ${tx.amount} (${partialCandidate.type}).`,
        mismatchType: partialCandidate.type,
        expectedAmount: partialCandidate.order.expectedAmount,
        actualAmount: tx.amount,
        difference: String(partialCandidate.diff),
      };
    }

    // No matching order
    return {
      matched: false,
      transaction: tx,
      reason: `No pending deposit order found matching recipient ${tx.toAddress} and amount ${tx.amount} on ${tx.network}.`,
      mismatchType: 'NO_MATCHING_ORDER',
      actualAmount: tx.amount,
    };
  }

  /**
   * Batch match an array of transactions
   */
  public batchMatch(txs: OnChainTransaction[]): MatchResult[] {
    return txs.map((tx) => this.matchTransaction(tx));
  }

  /**
   * Retrieve list of currently pending orders
   */
  public getPendingOrders(): DepositOrder[] {
    return Array.from(this.orders.values()).filter((o) => o.status === 'PENDING');
  }

  /**
   * Cleanup expired orders past their grace window
   */
  public cleanupExpiredOrders(now: number = Date.now()): number {
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.status === 'PENDING' && now > order.expiresAt + this.config.gracePeriodAfterMs) {
        order.status = 'EXPIRED';
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all matcher state (for tests)
   */
  public clear(): void {
    this.orders.clear();
    this.processedTxHashes.clear();
  }
}
