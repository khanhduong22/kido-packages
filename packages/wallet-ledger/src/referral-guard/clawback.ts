import {
  ClawbackResult,
  CommissionRewardRecord,
  RewardStatus,
} from './types';

export const DEFAULT_HOLD_DAYS = 14;

export interface CreateRewardParams {
  rewardId?: string;
  orderId: string;
  referrerId: string;
  amount: number;
  currency?: string;
  holdDays?: number;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ClawbackProcessParams {
  orderId: string;
  reason: string;
  now?: number;
  earnWalletDebitor?: (
    referrerId: string,
    amount: number,
    rewardId: string
  ) => Promise<boolean> | boolean;
}

export class ReferralClawbackManager {
  private rewards: Map<string, CommissionRewardRecord> = new Map();
  private orderToRewardIds: Map<string, Set<string>> = new Map();
  private referrerToRewardIds: Map<string, Set<string>> = new Map();

  /**
   * Create a new commission reward placed in the protective Hold Window
   */
  public createPendingReward(params: CreateRewardParams): CommissionRewardRecord {
    if (params.amount <= 0) {
      throw new Error(`Reward amount must be strictly positive: ${params.amount}`);
    }

    const rewardId =
      params.rewardId || `rew_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const createdAt = params.createdAt || Date.now();
    const holdDays = params.holdDays ?? DEFAULT_HOLD_DAYS;
    const holdUntil = createdAt + holdDays * 24 * 60 * 60 * 1000;

    const record: CommissionRewardRecord = {
      rewardId,
      orderId: params.orderId,
      referrerId: params.referrerId,
      amount: params.amount,
      currency: (params.currency || 'VND').toUpperCase(),
      status: 'PENDING_HOLD',
      holdDays,
      createdAt,
      holdUntil,
      metadata: params.metadata,
    };

    this.rewards.set(rewardId, record);

    // Index by orderId
    let orderSet = this.orderToRewardIds.get(params.orderId);
    if (!orderSet) {
      orderSet = new Set();
      this.orderToRewardIds.set(params.orderId, orderSet);
    }
    orderSet.add(rewardId);

    // Index by referrerId
    let refSet = this.referrerToRewardIds.get(params.referrerId);
    if (!refSet) {
      refSet = new Set();
      this.referrerToRewardIds.set(params.referrerId, refSet);
    }
    refSet.add(rewardId);

    return record;
  }

  /**
   * Retrieve reward by ID
   */
  public getReward(rewardId: string): CommissionRewardRecord | undefined {
    return this.rewards.get(rewardId);
  }

  /**
   * Retrieve all rewards associated with an order ID
   */
  public getRewardsByOrderId(orderId: string): CommissionRewardRecord[] {
    const ids = this.orderToRewardIds.get(orderId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.rewards.get(id)!)
      .filter(Boolean);
  }

  /**
   * Retrieve all rewards for a referrer
   */
  public getRewardsByReferrer(referrerId: string): CommissionRewardRecord[] {
    const ids = this.referrerToRewardIds.get(referrerId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.rewards.get(id)!)
      .filter(Boolean);
  }

  /**
   * Query all rewards whose hold period has elapsed and are ready to be cleared into Earn wallet
   */
  public getClearableRewards(now: number = Date.now()): CommissionRewardRecord[] {
    const clearable: CommissionRewardRecord[] = [];
    for (const reward of this.rewards.values()) {
      if (reward.status === 'PENDING_HOLD' && now >= reward.holdUntil) {
        clearable.push(reward);
      }
    }
    return clearable;
  }

  /**
   * Transition reward status from PENDING_HOLD to CLEARED
   */
  public clearReward(rewardId: string, now: number = Date.now()): CommissionRewardRecord {
    const reward = this.rewards.get(rewardId);
    if (!reward) {
      throw new Error(`Reward "${rewardId}" not found.`);
    }

    if (reward.status !== 'PENDING_HOLD') {
      throw new Error(`Cannot clear reward ${rewardId} in status "${reward.status}".`);
    }

    reward.status = 'CLEARED';
    reward.clearedAt = now;
    return reward;
  }

  /**
   * Process refund or chargeback clawback:
   * - If reward is PENDING_HOLD: cancels the reward before clearance.
   * - If reward is CLEARED: triggers debit on referrer Earn wallet.
   */
  public async processClawback(params: ClawbackProcessParams): Promise<ClawbackResult[]> {
    const now = params.now || Date.now();
    const rewards = this.getRewardsByOrderId(params.orderId);

    if (rewards.length === 0) {
      return [
        {
          success: false,
          rewardId: '',
          orderId: params.orderId,
          action: 'NOT_ELIGIBLE',
          amount: 0,
          notes: `No commission rewards found for order ${params.orderId}`,
        },
      ];
    }

    const results: ClawbackResult[] = [];

    for (const reward of rewards) {
      if (reward.status === 'CANCELLED_CLAWBACK' || reward.status === 'RECOVERED_CLAWBACK') {
        results.push({
          success: true,
          rewardId: reward.rewardId,
          orderId: params.orderId,
          action: 'NOT_ELIGIBLE',
          amount: reward.amount,
          notes: `Reward ${reward.rewardId} was already clawed back previously.`,
        });
        continue;
      }

      if (reward.status === 'PENDING_HOLD') {
        // Case A: Pending hold -> Instant cancellation
        reward.status = 'CANCELLED_CLAWBACK';
        reward.clawedBackAt = now;
        reward.clawbackReason = params.reason;

        results.push({
          success: true,
          rewardId: reward.rewardId,
          orderId: params.orderId,
          action: 'CANCELLED_PENDING',
          amount: reward.amount,
          notes: `Pending commission cancelled in hold window due to: ${params.reason}`,
        });
      } else if (reward.status === 'CLEARED') {
        // Case B: Cleared -> Debit from Earn wallet
        reward.status = 'RECOVERED_CLAWBACK';
        reward.clawedBackAt = now;
        reward.clawbackReason = params.reason;

        let debitedSuccessfully = true;
        if (params.earnWalletDebitor) {
          debitedSuccessfully = await params.earnWalletDebitor(
            reward.referrerId,
            reward.amount,
            reward.rewardId
          );
        }

        results.push({
          success: debitedSuccessfully,
          rewardId: reward.rewardId,
          orderId: params.orderId,
          action: 'DEBITED_EARN_WALLET',
          amount: reward.amount,
          notes: debitedSuccessfully
            ? `Clawed back cleared commission of ${reward.amount} ${reward.currency} from referrer ${reward.referrerId}`
            : `Failed to debit Earn wallet for referrer ${reward.referrerId}`,
        });
      }
    }

    return results;
  }

  /**
   * Clear all internal state (for tests)
   */
  public clear(): void {
    this.rewards.clear();
    this.orderToRewardIds.clear();
    this.referrerToRewardIds.clear();
  }
}
