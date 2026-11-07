import { AhoCorasickAutomaton, maskMatchedText } from './aho-corasick';
import { hashContent, scanHeuristics } from './heuristics';
import { TextNormalizer } from './normalizer';
import {
  AntiSpamEngineOptions,
  BlacklistAction,
  BlacklistRule,
  IGeminiSpamAnalyzer,
  ISpamVelocityGuard,
  MaskOptions,
  TrieMatchResult,
  ValidateOptions,
  ValidationOutcome,
  VelocityCheckResult,
} from './types';

export class AntiSpamError extends Error {
  public readonly statusCode: number = 400;
  public readonly blockedWords: string[];
  public readonly fieldName: string;

  constructor(
    message: string,
    blockedWords: string[] = [],
    fieldName = 'Nội dung',
  ) {
    super(message);
    this.name = 'AntiSpamError';
    this.blockedWords = blockedWords;
    this.fieldName = fieldName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AntiSpamEngine {
  private readonly rulesMap = new Map<string | number, BlacklistRule>();
  private readonly automaton = new AhoCorasickAutomaton();
  private readonly normalizer = new TextNormalizer();
  private readonly defaultMaskOptions: MaskOptions;
  private readonly checkHeuristicsByDefault: boolean;
  private velocityGuard?: ISpamVelocityGuard;
  private geminiAnalyzer?: IGeminiSpamAnalyzer;

  constructor(options?: AntiSpamEngineOptions) {
    this.defaultMaskOptions = options?.defaultMaskOptions ?? {
      maskChar: '*',
      mode: 'repeat',
    };
    this.checkHeuristicsByDefault = options?.checkHeuristicsByDefault ?? true;
    this.velocityGuard = options?.velocityGuard;
    this.geminiAnalyzer = options?.geminiAnalyzer;

    if (options?.defaultRules && options.defaultRules.length > 0) {
      this.addRules(options.defaultRules);
    }
  }

  /**
   * Add a single blacklist rule and update automaton.
   */
  addRule(rule: BlacklistRule): void {
    this.rulesMap.set(rule.id, { ...rule });
    this.rebuild();
  }

  /**
   * Add multiple blacklist rules and rebuild automaton in one pass.
   */
  addRules(rules: BlacklistRule[]): void {
    for (const rule of rules) {
      this.rulesMap.set(rule.id, { ...rule });
    }
    this.rebuild();
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(ruleId: string | number): boolean {
    const deleted = this.rulesMap.delete(ruleId);
    if (deleted) {
      this.rebuild();
    }
    return deleted;
  }

  /**
   * Clear all active rules.
   */
  clearRules(): void {
    this.rulesMap.clear();
    this.rebuild();
  }

  /**
   * Rebuild the internal Aho-Corasick Trie automaton.
   */
  rebuild(): void {
    this.automaton.build(Array.from(this.rulesMap.values()));
  }

  /**
   * Get all currently active rules.
   */
  getRules(): BlacklistRule[] {
    return Array.from(this.rulesMap.values());
  }

  /**
   * Get the number of active rules.
   */
  getRuleCount(): number {
    return this.rulesMap.size;
  }

  /**
   * Get the underlying normalizer instance.
   */
  getNormalizer(): TextNormalizer {
    return this.normalizer;
  }

  /**
   * Get the underlying automaton instance.
   */
  getAutomaton(): AhoCorasickAutomaton {
    return this.automaton;
  }

  /**
   * Get the configured velocity guard.
   */
  getVelocityGuard(): ISpamVelocityGuard | undefined {
    return this.velocityGuard;
  }

  /**
   * Set or update velocity guard.
   */
  setVelocityGuard(guard: ISpamVelocityGuard): void {
    this.velocityGuard = guard;
  }

  /**
   * Get the configured Gemini spam analyzer.
   */
  getGeminiAnalyzer(): IGeminiSpamAnalyzer | undefined {
    return this.geminiAnalyzer;
  }

  /**
   * Set or update Gemini spam analyzer.
   */
  setGeminiAnalyzer(analyzer: IGeminiSpamAnalyzer): void {
    this.geminiAnalyzer = analyzer;
  }

  /**
   * Fast synchronous Layer 1 validation: Normalizer + Aho-Corasick Trie + Heuristics.
   */
  validateSync(content: string, options?: ValidateOptions): ValidationOutcome {
    const canonical = this.normalizer.canonicalize(content);

    if (!content || content.trim() === '') {
      return {
        isAllowed: true,
        action: 'ALLOW',
        shouldBlock: false,
        shouldHide: false,
        shouldFlag: false,
        shouldMask: false,
        matchedWords: [],
        categories: [],
        canonical,
        contentHash: hashContent(''),
      };
    }

    // 1. Scan original text and normalized text with Trie
    const directScan = this.automaton.search(content);
    const normScan = this.automaton.search(canonical.normalized);

    const mergedMatches: TrieMatchResult[] = [
      ...directScan.matchedRules,
      ...normScan.matchedRules,
    ];

    // 2. If no block found yet and leetNormalized is different, scan leetNormalized text
    if (!normScan.hasBlock && canonical.leetNormalized !== canonical.normalized) {
      const leetScan = this.automaton.search(canonical.leetNormalized);
      if (leetScan.matchedRules.length > 0) {
        mergedMatches.push(...leetScan.matchedRules);
      }
    }

    // Deduplicate matches
    const seenMatches = new Set<string>();
    const uniqueMatches: TrieMatchResult[] = [];
    for (const m of mergedMatches) {
      const key = `${m.ruleId}-${m.startIndex}-${m.endIndex}-${m.word}`;
      if (!seenMatches.has(key)) {
        seenMatches.add(key);
        uniqueMatches.push(m);
      }
    }

    // Summarize trie matches
    let hasBlock = false;
    let hasHide = false;
    let hasFlag = false;
    let hasMask = false;
    const blockedWordsSet = new Set<string>();
    const allMatchedWordsSet = new Set<string>();
    const categoriesSet = new Set<string>();

    for (const match of uniqueMatches) {
      allMatchedWordsSet.add(match.word);
      if (match.category) {
        categoriesSet.add(match.category);
      }

      switch (match.action) {
        case 'BLOCK':
          hasBlock = true;
          blockedWordsSet.add(match.word);
          break;
        case 'HIDE':
          hasHide = true;
          break;
        case 'FLAG':
          hasFlag = true;
          break;
        case 'MASK':
          hasMask = true;
          break;
        case 'ALLOW':
          break;
      }
    }

    // 3. Scan heuristics (Zalo/Telegram/Shorteners/Phone spam)
    const shouldCheckHeuristics =
      options?.checkHeuristics !== undefined
        ? options.checkHeuristics
        : this.checkHeuristicsByDefault;

    let heuristicFlags = undefined;
    if (shouldCheckHeuristics) {
      heuristicFlags = scanHeuristics(content, canonical.compact);
    }

    const hasSuspiciousLink = heuristicFlags?.hasSuspiciousLink ?? false;
    const hasPhoneSpam = heuristicFlags?.hasPhoneSpam ?? false;

    // Decision hierarchy: BLOCK > HIDE > FLAG > MASK > ALLOW
    const shouldBlock = hasBlock;
    const shouldHide = hasHide || hasSuspiciousLink || hasPhoneSpam;
    const shouldFlag = hasFlag;
    const shouldMask = hasMask;

    let action: BlacklistAction = 'ALLOW';
    let reason: string | undefined;

    if (shouldBlock) {
      action = 'BLOCK';
      reason = 'Nội dung chứa từ ngữ vi phạm tiêu chuẩn cộng đồng';
    } else if (shouldHide) {
      action = 'HIDE';
      if (hasSuspiciousLink) {
        reason = 'Nội dung chứa liên kết nhóm hoặc dịch vụ ngoài cần kiểm duyệt';
      } else if (hasPhoneSpam) {
        reason = 'Nội dung chứa nhiều số điện thoại liên hệ spam';
      } else {
        reason = 'Nội dung cần kiểm duyệt trước khi hiển thị';
      }
    } else if (shouldFlag) {
      action = 'FLAG';
      reason = 'Nội dung được đánh dấu cần rà soát';
    } else if (shouldMask) {
      action = 'MASK';
      reason = 'Nội dung chứa từ ngữ cần che giấu';
    }

    // 4. Generate censored text if needed (either action is MASK or autoCensor is requested)
    let censoredText: string | undefined;
    if (shouldMask || options?.autoCensor) {
      censoredText = this.censor(
        content,
        options?.maskOptions?.maskChar,
        options?.maskOptions,
      );
    }

    // Content fingerprint for duplicate spam flood detection
    const contentHash = hashContent(canonical.compact || canonical.normalized);

    return {
      isAllowed: !shouldBlock,
      action,
      shouldBlock,
      shouldHide,
      shouldFlag,
      shouldMask,
      matchedWords: Array.from(allMatchedWordsSet),
      censoredText,
      reason,
      contentHash,
      categories: Array.from(categoriesSet),
      canonical,
      heuristicFlags,
    };
  }

  /**
   * Multi-tiered validation pipeline:
   * Layer 1: Normalizer + In-memory Aho-Corasick Trie + Regex Heuristics
   * Layer 2: Velocity Guard (userId limits) + Duplicate Target Flood Guard (targetId)
   * Layer 3: Gemini Flash-Lite AI Semantic Analyzer for Grey-Zone Content
   */
  async validate(
    content: string,
    options?: ValidateOptions,
  ): Promise<ValidationOutcome> {
    const canonical = this.normalizer.canonicalize(content);

    if (!content || content.trim() === '') {
      return {
        isAllowed: true,
        action: 'ALLOW',
        shouldBlock: false,
        shouldHide: false,
        shouldFlag: false,
        shouldMask: false,
        matchedWords: [],
        categories: [],
        canonical,
        contentHash: hashContent(''),
      };
    }

    let velocityResult: VelocityCheckResult | undefined;

    // --- Layer 2: Velocity Rate Limiter ---
    if (options?.userId && this.velocityGuard) {
      velocityResult = await this.velocityGuard.checkVelocity(
        options.userId,
        options.actionType || 'comment',
      );

      if (!velocityResult.isAllowed) {
        return {
          isAllowed: false,
          action: 'BLOCK',
          shouldBlock: true,
          shouldHide: false,
          shouldFlag: false,
          shouldMask: false,
          matchedWords: [],
          reason: 'Bạn đang thao tác quá nhanh, vui lòng thử lại sau giây lát',
          contentHash: hashContent(canonical.compact || canonical.normalized),
          categories: ['VELOCITY_LIMIT'],
          canonical,
          velocityResult,
        };
      }
    }

    // --- Layer 1: Fast In-Memory Trie & Regex Scanners ---
    const outcome = this.validateSync(content, options);
    if (velocityResult) {
      outcome.velocityResult = velocityResult;
    }

    // If already blocked by Layer 1 keywords, reject immediately without AI call
    if (outcome.shouldBlock) {
      return outcome;
    }

    // --- Layer 2: Duplicate Content Flood Across Distinct Targets ---
    if (options?.userId && options?.targetId && this.velocityGuard) {
      const duplicateResult = await this.velocityGuard.checkDuplicateContent(
        options.userId,
        canonical.normalized,
        options.targetId,
        options.duplicateWindowMs,
      );

      outcome.duplicateResult = duplicateResult;

      if (duplicateResult.isDuplicateSpam) {
        outcome.shouldHide = true;
        if (
          outcome.action === 'ALLOW' ||
          outcome.action === 'FLAG' ||
          outcome.action === 'MASK'
        ) {
          outcome.action = 'HIDE';
        }
        outcome.reason =
          outcome.reason ||
          'Nội dung trùng lặp liên tục trên nhiều bài viết/bình luận';
        outcome.categories = Array.from(
          new Set([...outcome.categories, 'DUPLICATE_FLOOD']),
        );
      }
    }

    // --- Layer 3: Gemini Flash-Lite AI Semantic Analyzer (Grey-Zone Funnel) ---
    if (
      !outcome.shouldHide &&
      this.geminiAnalyzer &&
      options?.enableAi !== false &&
      this.geminiAnalyzer.shouldTriggerAiAnalysis(content)
    ) {
      const aiResult = await this.geminiAnalyzer.analyzeContent(
        content,
        options?.title,
      );
      outcome.aiAnalysis = aiResult;

      const threshold = this.geminiAnalyzer.thresholdScore ?? 0.8;
      if (aiResult.isSpam && aiResult.score >= threshold) {
        outcome.shouldHide = true;
        if (
          outcome.action === 'ALLOW' ||
          outcome.action === 'FLAG' ||
          outcome.action === 'MASK'
        ) {
          outcome.action = 'HIDE';
        }
        outcome.reason =
          aiResult.reason ||
          'AI phát hiện nội dung có dấu hiệu lừa đảo hoặc vi phạm tiêu chuẩn cộng đồng';

        if (aiResult.categories && aiResult.categories.length > 0) {
          outcome.categories = Array.from(
            new Set([...outcome.categories, ...aiResult.categories]),
          );
        }
      }
    }

    return outcome;
  }

  /**
   * Assert content does not contain any blocked keywords or trigger rate limit blocks.
   * Throws AntiSpamError immediately if content is blocked.
   */
  async assertNotBlocked(
    content: string,
    fieldName = 'Nội dung',
    options?: ValidateOptions,
  ): Promise<ValidationOutcome> {
    const outcome = await this.validate(content, options);
    if (outcome.shouldBlock) {
      throw new AntiSpamError(
        outcome.reason || `${fieldName} chứa từ ngữ vi phạm tiêu chuẩn cộng đồng`,
        outcome.matchedWords,
        fieldName,
      );
    }
    return outcome;
  }

  /**
   * Fast synchronous assert using Layer 1 only.
   */
  assertNotBlockedSync(
    content: string,
    fieldName = 'Nội dung',
    options?: ValidateOptions,
  ): ValidationOutcome {
    const outcome = this.validateSync(content, options);
    if (outcome.shouldBlock) {
      throw new AntiSpamError(
        outcome.reason || `${fieldName} chứa từ ngữ vi phạm tiêu chuẩn cộng đồng`,
        outcome.matchedWords,
        fieldName,
      );
    }
    return outcome;
  }

  /**
   * Censor matched forbidden words in the text, replacing them with mask characters (e.g. '***').
   */
  censor(
    content: string,
    maskChar?: string,
    options?: MaskOptions,
  ): string {
    if (!content) return '';

    const maskOpts: MaskOptions = {
      ...this.defaultMaskOptions,
      ...options,
      maskChar: maskChar ?? options?.maskChar ?? this.defaultMaskOptions.maskChar,
    };

    // 1. Direct scan matches on original text
    const directScan = this.automaton.search(content);
    let censored = maskMatchedText(content, directScan.matchedRules, maskOpts);

    // 2. Also check for words matched in normalized/leetspeak text
    const canonical = this.normalizer.canonicalize(content);
    const normScan = this.automaton.search(canonical.normalized);
    const leetScan = this.automaton.search(canonical.leetNormalized);

    const wordsToMask = new Set<string>();
    for (const r of [...normScan.matchedRules, ...leetScan.matchedRules]) {
      wordsToMask.add(r.word);
    }

    for (const word of wordsToMask) {
      if (!word) continue;
      // Escape for regex
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Create flexible regex matching potential zero-width or punctuation between characters
      const flexiblePattern = escaped
        .split('')
        .join('[\\s.\\-_*~\\u200B-\\u200D\\uFEFF]*');

      const regex = new RegExp(flexiblePattern, 'gi');
      censored = censored.replace(regex, (match) => {
        return maskOpts.mode === 'fixed'
          ? (maskOpts.maskChar ?? '*').repeat(maskOpts.fixedLength ?? 3)
          : (maskOpts.maskChar ?? '*').repeat(match.length);
      });
    }

    return censored;
  }
}
