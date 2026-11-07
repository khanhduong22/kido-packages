export type CryptoNetwork =
  | 'TRON_TRC20'
  | 'EVM_ERC20'
  | 'EVM_BEP20'
  | 'EVM_POLYGON'
  | 'EVM_ARBITRUM'
  | 'SOLANA';

export type PriorityTier =
  | 'TIER_1_2_DECIMALS' // 2 decimals (0.01 - 0.99, 99 slots)
  | 'TIER_2_3_DECIMALS' // 3 decimals (0.001 - 0.999, 999 slots)
  | 'TIER_3_4_DECIMALS' // 4 decimals (0.0001 - 0.9999, 9,999 slots)
  | 'TIER_4_5_DECIMALS' // 5 decimals (0.00001 - 0.99999, 99,999 slots)
  | 'TIER_5_6_DECIMALS'; // 6 decimals (0.000001 - 0.999999, 999,999 slots)

export type SlotStatus = 'ACTIVE' | 'MATCHED' | 'EXPIRED' | 'RELEASED';

export interface SlotAllocationRequest {
  orderId: string;
  baseAmount: string | number;
  currency: string;
  network: CryptoNetwork;
  priorityTier?: PriorityTier;
  decimals?: number; // 2 to 6
  ttlSeconds?: number; // default 900 (15 minutes)
  metadata?: Record<string, unknown>;
}

export interface AllocatedSlot {
  slotKey: string;
  orderId: string;
  baseAmount: string;
  decimalSuffix: string; // e.g. "0.0142" or "0142"
  totalExpectedAmount: string; // e.g. "100.0142"
  currency: string;
  network: CryptoNetwork;
  decimals: number;
  allocatedAt: number;
  expiresAt: number;
  status: SlotStatus;
  metadata?: Record<string, unknown>;
}

export type DepositOrderStatus = 'PENDING' | 'MATCHED' | 'EXPIRED' | 'CANCELLED';

export interface DepositOrder {
  orderId: string;
  userId: string;
  baseAmount: string;
  expectedAmount: string;
  decimalSuffix: string;
  currency: string;
  network: CryptoNetwork;
  receivingAddress: string;
  tokenContractAddress?: string;
  createdAt: number;
  expiresAt: number;
  status: DepositOrderStatus;
  matchedTxHash?: string;
  matchedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface OnChainTransaction {
  txHash: string;
  network: CryptoNetwork;
  fromAddress: string;
  toAddress: string;
  tokenContractAddress?: string;
  amount: string; // human readable string e.g. "100.0142"
  rawAmount?: string; // atomic units (e.g. 100014200 Sun)
  blockNumber: number;
  blockTimestamp: number; // millisecond timestamp
  confirmations?: number;
}

export type MatchMismatchType =
  | 'EXACT_MATCH'
  | 'UNDERPAID'
  | 'OVERPAID'
  | 'EXPIRED'
  | 'WRONG_RECIPIENT'
  | 'DUPLICATE_TX'
  | 'NETWORK_MISMATCH'
  | 'TOKEN_MISMATCH'
  | 'NO_MATCHING_ORDER';

export interface MatchResult {
  matched: boolean;
  order?: DepositOrder;
  transaction: OnChainTransaction;
  reason: string;
  mismatchType?: MatchMismatchType;
  expectedAmount?: string;
  actualAmount?: string;
  difference?: string;
}

export interface CapacityInfo {
  network: CryptoNetwork;
  currency: string;
  baseAmount: string;
  tier: PriorityTier;
  decimals: number;
  totalSlots: number;
  activeSlots: number;
  availableSlots: number;
}
