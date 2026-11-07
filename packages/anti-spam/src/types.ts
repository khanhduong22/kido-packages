/**
 * @kido/anti-spam - Type Definitions
 * High-performance zero-dependency anti-spam engine
 */

export type BlacklistAction = 'BLOCK' | 'HIDE' | 'FLAG' | 'MASK' | 'ALLOW';

export interface BlacklistRule {
  id: number | string;
  word: string;
  action: BlacklistAction;
  isCaseSensitive?: boolean;
  isWholeWord?: boolean;
  category?: string;
}

export interface TrieMatchResult {
  ruleId: number | string;
  word: string;
  action: BlacklistAction;
  startIndex: number;
  endIndex: number;
  category?: string;
}

export interface ScanResult {
  matchedRules: TrieMatchResult[];
  hasBlock: boolean;
  hasHide: boolean;
  hasFlag: boolean;
  hasMask: boolean;
  blockedWords: string[];
  maskedWords: string[];
  categories: string[];
}

export interface TextCanonicalization {
  original: string;
  normalized: string;
  leetNormalized: string;
  compact: string;
}

export interface HeuristicScanResult {
  hasSuspiciousLink: boolean;
  hasPhoneSpam: boolean;
  links: string[];
  phoneNumbers: string[];
  reasons: string[];
}

export interface GeminiSpamAnalysisResult {
  isSpam: boolean;
  score: number;
  categories: string[];
  reason: string;
}

export interface VelocityCheckResult {
  isAllowed: boolean;
  retryAfterSec?: number;
  currentCount?: number;
}

export interface DuplicateCheckResult {
  isDuplicateSpam: boolean;
  targetCount?: number;
}

export interface ValidationOutcome {
  isAllowed: boolean;
  action: BlacklistAction;
  shouldBlock: boolean;
  shouldHide: boolean;
  shouldFlag: boolean;
  shouldMask: boolean;
  matchedWords: string[];
  censoredText?: string;
  reason?: string;
  contentHash?: string;
  categories: string[];
  canonical: TextCanonicalization;
  heuristicFlags?: HeuristicScanResult;
  aiAnalysis?: GeminiSpamAnalysisResult;
  velocityResult?: VelocityCheckResult;
  duplicateResult?: DuplicateCheckResult;
}

export interface MaskOptions {
  maskChar?: string;
  mode?: 'repeat' | 'fixed';
  fixedLength?: number;
}

export interface ValidateOptions {
  checkHeuristics?: boolean;
  autoCensor?: boolean;
  maskOptions?: MaskOptions;
  customCategories?: string[];

  // Layer 2: Velocity & Duplicate check options
  userId?: string | number;
  targetId?: string | number;
  actionType?: 'post' | 'comment' | string;
  duplicateWindowMs?: number;

  // Layer 3: Gemini AI semantic check options
  title?: string;
  enableAi?: boolean;
}

export interface IVelocityCacheAdapter {
  get<T>(key: string): Promise<T | null | undefined> | T | null | undefined;
  set<T>(key: string, value: T, ttlMs: number): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export interface VelocityLimitConfig {
  maxCount: number;
  windowSec: number;
}

export interface SpamVelocityGuardOptions {
  cacheAdapter?: IVelocityCacheAdapter;
  commentLimit?: number;
  commentWindowSec?: number;
  postLimit?: number;
  postWindowSec?: number;
  duplicateWindowSec?: number;
  duplicateThreshold?: number;
}

export interface GeminiSpamAnalyzerOptions {
  apiKey?: string;
  modelName?: string;
  timeoutMs?: number;
  thresholdScore?: number;
  customPrompt?: (content: string, title?: string) => string;
}

// Forward reference interfaces for engine options
export interface ISpamVelocityGuard {
  checkVelocity(
    userId: string | number,
    actionType?: 'post' | 'comment' | string,
    limits?: Partial<VelocityLimitConfig>,
  ): Promise<VelocityCheckResult>;
  checkDuplicateContent(
    userId: string | number,
    normalizedText: string,
    targetId: string | number,
    windowMs?: number,
  ): Promise<DuplicateCheckResult>;
}

export interface IGeminiSpamAnalyzer {
  thresholdScore?: number;
  shouldTriggerAiAnalysis(text: string): boolean;
  analyzeContent(
    text: string,
    title?: string,
  ): Promise<GeminiSpamAnalysisResult>;
}

export interface AntiSpamEngineOptions {
  defaultRules?: BlacklistRule[];
  defaultMaskOptions?: MaskOptions;
  checkHeuristicsByDefault?: boolean;
  velocityGuard?: ISpamVelocityGuard;
  geminiAnalyzer?: IGeminiSpamAnalyzer;
}
