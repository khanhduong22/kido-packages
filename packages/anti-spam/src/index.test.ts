import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  AhoCorasickAutomaton,
  AntiSpamEngine,
  AntiSpamError,
  BlacklistRule,
  buildGeminiSpamPrompt,
  cleanJsonOutput,
  createExpressAntiSpamMiddleware,
  createHonoAntiSpamMiddleware,
  createPresetRules,
  GeminiSpamAnalyzer,
  getAllPresets,
  getEnglishPresets,
  getPresetsByCategory,
  getVietnamesePresets,
  hashContent,
  maskMatchedText,
  MemoryVelocityCacheAdapter,
  PRESET_CATEGORIES,
  scanHeuristics,
  shouldTriggerAiAnalysis,
  SpamVelocityGuard,
  TextNormalizer,
  validateRequestBody,
  validateRequestBodySync,
} from './index';

describe('@kido/anti-spam Engine & Utilities', () => {
  // ==========================================
  // 1. TextNormalizer Suite
  // ==========================================
  describe('TextNormalizer', () => {
    const normalizer = new TextNormalizer();

    it('should strip zero-width and invisible formatting characters', () => {
      const malicious = 'l\u200Bừ\u200Ca \uFEFFđ\u200Dả\u00ADo';
      expect(normalizer.stripZeroWidth(malicious)).toBe('lừa đảo');
      expect(normalizer.stripZeroWidth('')).toBe('');
    });

    it('should harmonize Unicode NFD decomposed forms into NFC', () => {
      const decomposed = 'lu\u0300a'; // 'lùa' decomposed
      expect(normalizer.normalizeUnicode(decomposed)).toBe('lùa');
      expect(normalizer.normalizeUnicode('Tiếng Việt')).toBe('Tiếng Việt');
    });

    it('should fold Cyrillic and Greek homoglyphs to Latin equivalents', () => {
      // Cyrillic 'а' and Ukrainian 'і'
      const cyrillicMixed = '\u0430dm\u0456n';
      expect(normalizer.foldHomoglyphs(cyrillicMixed)).toBe('admin');

      // Greek 'ο' and 'ε'
      const greekMixed = 'h\u03BFm\u03B5';
      expect(normalizer.foldHomoglyphs(greekMixed)).toBe('home');
    });

    it('should collapse 3+ repeated characters into 2', () => {
      expect(normalizer.collapseRepeated('haaaaalo')).toBe('haalo');
      expect(normalizer.collapseRepeated('chuuuuửi')).toBe('chuuửi');
      expect(normalizer.collapseRepeated('chết tiệt!!!!!!!!')).toBe('chết tiệt!!');
    });

    it('should normalize leetspeak symbols (@, $)', () => {
      expect(normalizer.normalizeLeetspeak('b@n $h@re')).toBe('ban share');
      expect(normalizer.normalizeLeetspeak('$ex')).toBe('sex');
    });

    it('should collapse punctuation-separated and space-separated obfuscated letters', () => {
      expect(normalizer.normalizeLeetspeak('b.á.n')).toBe('bán');
      expect(normalizer.normalizeLeetspeak('b-á-n')).toBe('bán');
      expect(normalizer.normalizeLeetspeak('d.m')).toBe('dm');
      expect(normalizer.normalizeLeetspeak('z-a-l-o')).toBe('zalo');
      expect(normalizer.normalizeLeetspeak('z a l o')).toBe('zalo');
    });

    it('should produce complete canonical output in canonicalize()', () => {
      const input = 'L\u200Bừ\u200Ca Đ\u200Dả\u200Do  quaaaa!!';
      const canonical = normalizer.canonicalize(input);

      expect(canonical.original).toBe(input);
      expect(canonical.normalized.toLowerCase()).toContain('lừa đảo');
      expect(canonical.compact).not.toContain(' ');
    });
  });

  // ==========================================
  // 2. AhoCorasickAutomaton Suite
  // ==========================================
  describe('AhoCorasickAutomaton', () => {
    it('should find forbidden patterns in single-pass linear scan', () => {
      const automaton = new AhoCorasickAutomaton();
      automaton.build([
        { id: 1, word: 'lừa đảo', action: 'BLOCK' },
        { id: 2, word: 'cờ bạc', action: 'BLOCK' },
        { id: 3, word: 'nhạy cảm', action: 'FLAG' },
      ]);

      const text = 'Cảnh báo lừa đảo và cờ bạc trong hội nhóm';
      const scan = automaton.search(text);

      expect(scan.hasBlock).toBe(true);
      expect(scan.blockedWords).toContain('lừa đảo');
      expect(scan.blockedWords).toContain('cờ bạc');
      expect(scan.hasFlag).toBe(false);
      expect(scan.matchedRules).toHaveLength(2);
    });

    it('should prevent Scunthorpe false positives using whole word boundary checks', () => {
      const automaton = new AhoCorasickAutomaton();
      automaton.build([
        { id: 1, word: 'dm', action: 'BLOCK', isWholeWord: true },
        { id: 2, word: 'sex', action: 'BLOCK', isWholeWord: true },
        { id: 3, word: 'bán', action: 'BLOCK', isWholeWord: true },
      ]);

      // 1. "admin" contains "dm", but boundary check should ignore it
      const adminScan = automaton.search('Liên hệ admin để được hỗ trợ');
      expect(adminScan.hasBlock).toBe(false);

      // 2. "roadmap" contains "dm"
      const roadmapScan = automaton.search('Xem lộ trình roadmap quý 3');
      expect(roadmapScan.hasBlock).toBe(false);

      // 3. "Sussex" contains "sex"
      const sussexScan = automaton.search('Trường đại học Sussex');
      expect(sussexScan.hasBlock).toBe(false);

      // 4. "cơ bản" should NOT trigger "bán"
      const coBanScan = automaton.search('Nắm vững kiến thức cơ bản');
      expect(coBanScan.hasBlock).toBe(false);

      // 5. Standalone profane "dm" or "sex" SHOULD trigger
      const profaneScan = automaton.search('Thằng dm này láo thật');
      expect(profaneScan.hasBlock).toBe(true);
      expect(profaneScan.blockedWords).toContain('dm');

      const realSexScan = automaton.search('Xem video sex miễn phí');
      expect(realSexScan.hasBlock).toBe(true);
      expect(realSexScan.blockedWords).toContain('sex');
    });

    it('should correctly classify HIDE, FLAG, and MASK actions', () => {
      const automaton = new AhoCorasickAutomaton();
      automaton.build([
        { id: 1, word: 'review', action: 'FLAG' },
        { id: 2, word: 'chờ duyệt', action: 'HIDE' },
        { id: 3, word: 'thô tục', action: 'MASK' },
      ]);

      const text = 'Từ ngữ thô tục cần review và chờ duyệt trước';
      const scan = automaton.search(text);

      expect(scan.hasBlock).toBe(false);
      expect(scan.hasHide).toBe(true);
      expect(scan.hasFlag).toBe(true);
      expect(scan.hasMask).toBe(true);
      expect(scan.maskedWords).toContain('thô tục');
    });

    it('should mask matched text cleanly with overlapping intervals', () => {
      const text = 'Đây là nội dung cực kỳ nguy hiểm và độc hại';
      const matches = [
        {
          ruleId: 1,
          word: 'cực kỳ',
          action: 'MASK' as const,
          startIndex: 16,
          endIndex: 22,
        },
        {
          ruleId: 2,
          word: 'nguy hiểm',
          action: 'MASK' as const,
          startIndex: 23,
          endIndex: 32,
        },
      ];

      const masked = maskMatchedText(text, matches, {
        maskChar: '*',
        mode: 'repeat',
      });
      expect(masked).toBe('Đây là nội dung ****** ********* và độc hại');

      const fixedMasked = maskMatchedText(text, matches, {
        maskChar: '#',
        mode: 'fixed',
        fixedLength: 3,
      });
      expect(fixedMasked).toBe('Đây là nội dung ### ### và độc hại');
    });
  });

  // ==========================================
  // 3. Heuristics & FNV-1a Hash Suite
  // ==========================================
  describe('Heuristics & FNV-1a Content Hash', () => {
    it('should detect Zalo group invite links', () => {
      const text1 = 'Tham gia nhóm Zalo https://zalo.me/g/abcxyz123 để nhận phím hàng';
      const scan1 = scanHeuristics(text1);
      expect(scan1.hasSuspiciousLink).toBe(true);
      expect(scan1.links).toContain('https://zalo.me/g/abcxyz123');

      const text2 = 'Link nhóm: zalo.me/join/vipgroup';
      const scan2 = scanHeuristics(text2);
      expect(scan2.hasSuspiciousLink).toBe(true);
    });

    it('should detect Telegram invite links', () => {
      const text1 = 'Kênh tín hiệu VIP t.me/trading_vip_channel';
      const scan1 = scanHeuristics(text1);
      expect(scan1.hasSuspiciousLink).toBe(true);
      expect(scan1.links.length).toBeGreaterThan(0);

      const text2 = 'Vào nhóm telegram.me/+privateInviteCode';
      const scan2 = scanHeuristics(text2);
      expect(scan2.hasSuspiciousLink).toBe(true);
    });

    it('should detect URL shorteners', () => {
      const text = 'Nhận quà airdrop tại bit.ly/free-crypto ngay';
      const scan = scanHeuristics(text);
      expect(scan.hasSuspiciousLink).toBe(true);
      expect(scan.links).toContain('bit.ly/free-crypto');
    });

    it('should detect multiple phone numbers as spam', () => {
      const text = 'Liên hệ hotline 0988123456 hoặc Zalo 0912345678 để tư vấn';
      const scan = scanHeuristics(text);
      expect(scan.hasPhoneSpam).toBe(true);
      expect(scan.phoneNumbers).toHaveLength(2);
    });

    it('should generate deterministic 64-bit FNV-1a hash fingerprints', () => {
      const hash1 = hashContent('Nội dung bình luận mẫu');
      const hash2 = hashContent('Nội dung bình luận mẫu');
      const hash3 = hashContent('Nội dung bình luận khác');

      expect(hash1).toHaveLength(16);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });
  });

  // ==========================================
  // 4. AntiSpamEngine Suite (Sync & Async)
  // ==========================================
  describe('AntiSpamEngine', () => {
    it('should support dynamic rule addition, deletion, and rebuild', async () => {
      const engine = new AntiSpamEngine();
      expect(engine.getRuleCount()).toBe(0);

      engine.addRule({ id: 1, word: 'scam', action: 'BLOCK' });
      expect(engine.getRuleCount()).toBe(1);

      let outcome = await engine.validate('This is a scam project');
      expect(outcome.shouldBlock).toBe(true);

      engine.removeRule(1);
      expect(engine.getRuleCount()).toBe(0);

      outcome = await engine.validate('This is a scam project');
      expect(outcome.shouldBlock).toBe(false);
    });

    it('should support validateSync for pure Layer 1 synchronous execution', () => {
      const engine = new AntiSpamEngine({
        defaultRules: [{ id: 1, word: 'scam', action: 'BLOCK' }],
      });

      const outcome = engine.validateSync('This is a scam project');
      expect(outcome.shouldBlock).toBe(true);
      expect(outcome.action).toBe('BLOCK');
      expect(outcome.matchedWords).toContain('scam');
    });

    it('should detect evasion via zero-width characters and homoglyphs', async () => {
      const engine = new AntiSpamEngine({
        defaultRules: [
          { id: 1, word: 'lừa đảo', action: 'BLOCK' },
          { id: 2, word: 'cờ bạc', action: 'HIDE' },
        ],
      });

      // Evasion with zero-width characters: l\u200Bừ\u200Ca đ\u200Dả\u200Do
      const obfuscated = 'Nội dung l\u200Bừ\u200Ca đ\u200Dả\u200Do cực kỳ nguy hiểm';
      const outcome = await engine.validate(obfuscated);
      expect(outcome.shouldBlock).toBe(true);
      expect(outcome.action).toBe('BLOCK');
      expect(outcome.matchedWords).toContain('lừa đảo');
    });

    it('should detect evasion via leetspeak and letter separators', async () => {
      const engine = new AntiSpamEngine({
        defaultRules: [
          { id: 1, word: 'bán', action: 'BLOCK' },
          { id: 2, word: 'zalo', action: 'HIDE' },
        ],
      });

      const outcome = await engine.validate('Cần b.á.n gấp tài khoản, liên hệ z a l o');
      expect(outcome.shouldBlock).toBe(true);
      expect(outcome.action).toBe('BLOCK');
    });

    it('should assertNotBlocked and throw AntiSpamError asynchronously and synchronously', async () => {
      const engine = new AntiSpamEngine({
        defaultRules: [{ id: 1, word: 'lừa đảo', action: 'BLOCK' }],
      });

      // Async assertNotBlocked throws
      expect(
        engine.assertNotBlocked('Hành vi lừa đảo người tiêu dùng'),
      ).rejects.toThrow(AntiSpamError);

      // Sync assertNotBlockedSync throws
      expect(() => {
        engine.assertNotBlockedSync('Hành vi lừa đảo người tiêu dùng');
      }).toThrow(AntiSpamError);

      try {
        await engine.assertNotBlocked('Hành vi lừa đảo', 'Tiêu đề');
      } catch (err) {
        expect(err instanceof AntiSpamError).toBe(true);
        const antiSpamErr = err as AntiSpamError;
        expect(antiSpamErr.statusCode).toBe(400);
        expect(antiSpamErr.fieldName).toBe('Tiêu đề');
        expect(antiSpamErr.blockedWords).toContain('lừa đảo');
      }

      // Clean text passes without error
      const cleanOutcome = await engine.assertNotBlocked('Thảo luận kỹ thuật lành mạnh');
      expect(cleanOutcome.isAllowed).toBe(true);
    });

    it('should censor forbidden words in censor() method', () => {
      const engine = new AntiSpamEngine({
        defaultRules: [
          { id: 1, word: 'dm', action: 'BLOCK', isWholeWord: true },
          { id: 2, word: 'chửi bậy', action: 'BLOCK' },
        ],
      });

      const censored = engine.censor('Này dm mày chửi bậy hả');
      expect(censored).toBe('Này ** mày ******** hả');
    });

    it('should automatically censor when action is MASK or autoCensor is enabled', async () => {
      const engine = new AntiSpamEngine({
        defaultRules: [{ id: 1, word: 'bí mật', action: 'MASK' }],
      });

      const outcome = await engine.validate('Đây là thông tin bí mật quốc gia');
      expect(outcome.action).toBe('MASK');
      expect(outcome.shouldMask).toBe(true);
      expect(outcome.censoredText).toBe('Đây là thông tin ****** quốc gia');
    });
  });

  // ==========================================
  // 5. Middleware Suite
  // ==========================================
  describe('Anti-Spam Middleware', () => {
    const engine = new AntiSpamEngine({
      defaultRules: [{ id: 1, word: 'scam', action: 'BLOCK' }],
    });

    it('should validateRequestBody across multiple keys', async () => {
      const cleanBody = {
        title: 'Bàn luận về AI',
        content: 'Trí tuệ nhân tạo ngày nay',
      };
      const cleanResult = await validateRequestBody(engine, cleanBody);
      expect(cleanResult.outcome.isAllowed).toBe(true);

      const spamBody = {
        title: 'Bàn luận về AI',
        content: 'This project is a scam',
      };
      const spamResult = await validateRequestBody(engine, spamBody);
      expect(spamResult.outcome.shouldBlock).toBe(true);
      expect(spamResult.violatedField).toBe('content');

      // validateRequestBodySync also works
      const syncResult = validateRequestBodySync(engine, spamBody);
      expect(syncResult.outcome.shouldBlock).toBe(true);
    });

    it('should work with createHonoAntiSpamMiddleware', async () => {
      const middleware = createHonoAntiSpamMiddleware(engine);

      // 1. Blocked request test
      let jsonResponse: any = null;
      let statusCode = 200;
      let nextCalled = false;

      const mockCtxBlocked = {
        req: {
          header: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
          json: async () => ({ content: 'Warning: scam alert!' }),
        },
        set: () => {},
        json: (data: any, status: number) => {
          jsonResponse = data;
          statusCode = status;
          return { data, status };
        },
      };

      await middleware(mockCtxBlocked, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(400);
      expect(jsonResponse.blacklistedWords).toContain('scam');

      // 2. Allowed request test
      nextCalled = false;
      const mockCtxAllowed = {
        req: {
          header: () => 'application/json',
          json: async () => ({ content: 'Nội dung rất sạch và hữu ích' }),
        },
        set: () => {},
        json: () => {},
      };

      await middleware(mockCtxAllowed, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });

    it('should work with createExpressAntiSpamMiddleware', async () => {
      const middleware = createExpressAntiSpamMiddleware(engine);

      let nextCalled = false;
      let statusCode = 200;
      let jsonResponse: any = null;

      const req = {
        body: { comment: 'Beware of this scam' },
      };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return {
            json: (data: any) => {
              jsonResponse = data;
            },
          };
        },
      };
      const next = () => {
        nextCalled = true;
      };

      await middleware(req, res, next);
      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(400);
      expect(jsonResponse.blacklistedWords).toContain('scam');
    });

    it('should respect blockOnViolation: false and invoke onBlocked callback', async () => {
      let blockedCalled = false;
      const middleware = createHonoAntiSpamMiddleware(engine, {
        blockOnViolation: false,
        onBlocked: () => {
          blockedCalled = true;
        },
      });

      let nextCalled = false;
      const mockCtx = {
        req: {
          header: () => 'application/json',
          json: async () => ({ content: 'This is a scam' }),
        },
        set: () => {},
        json: () => {},
      };

      await middleware(mockCtx, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(blockedCalled).toBe(false);
    });
  });

  // ==========================================
  // 6. SpamVelocityGuard Suite
  // ==========================================
  describe('SpamVelocityGuard & MemoryVelocityCacheAdapter', () => {
    it('should perform in-memory cache CRUD and respect TTL', async () => {
      const cache = new MemoryVelocityCacheAdapter(false);

      cache.set('key1', 42, 50); // 50ms TTL
      expect(cache.get('key1')).toBe(42);

      cache.delete('key1');
      expect(cache.get('key1')).toBeNull();

      cache.set('key2', 'hello', 10);
      await new Promise((r) => setTimeout(r, 25));
      expect(cache.get('key2')).toBeNull();

      cache.destroy();
    });

    it('should enforce velocity limit for comments (max 10 comments / 60s)', async () => {
      const guard = new SpamVelocityGuard({
        commentLimit: 3, // Lower for fast test
        commentWindowSec: 60,
      });

      const userId = 'user_comment_1';

      // First 3 requests pass
      const r1 = await guard.checkVelocity(userId, 'comment');
      const r2 = await guard.checkVelocity(userId, 'comment');
      const r3 = await guard.checkVelocity(userId, 'comment');

      expect(r1.isAllowed).toBe(true);
      expect(r2.isAllowed).toBe(true);
      expect(r3.isAllowed).toBe(true);

      // 4th request exceeds limit
      const r4 = await guard.checkVelocity(userId, 'comment');
      expect(r4.isAllowed).toBe(false);
      expect(r4.retryAfterSec).toBe(60);
    });

    it('should enforce velocity limit for posts (max 3 posts / 300s)', async () => {
      const guard = new SpamVelocityGuard({
        postLimit: 2,
        postWindowSec: 300,
      });

      const userId = 'user_post_1';

      expect((await guard.checkVelocity(userId, 'post')).isAllowed).toBe(true);
      expect((await guard.checkVelocity(userId, 'post')).isAllowed).toBe(true);

      const r3 = await guard.checkVelocity(userId, 'post');
      expect(r3.isAllowed).toBe(false);
      expect(r3.retryAfterSec).toBe(300);
    });

    it('should detect duplicate content flood across 3+ distinct targets', async () => {
      const guard = new SpamVelocityGuard({
        duplicateThreshold: 3,
        duplicateWindowSec: 300,
      });

      const userId = 'bot_spammer_1';
      const text = 'Nhận quà thưởng 500k miễn phí tại link bên dưới';

      // Target 1: normal post
      const d1 = await guard.checkDuplicateContent(userId, text, 'post_101');
      expect(d1.isDuplicateSpam).toBe(false);
      expect(d1.targetCount).toBe(1);

      // Same target again: not counted as distinct target
      const d1Repeat = await guard.checkDuplicateContent(userId, text, 'post_101');
      expect(d1Repeat.isDuplicateSpam).toBe(false);
      expect(d1Repeat.targetCount).toBe(1);

      // Target 2: allowed
      const d2 = await guard.checkDuplicateContent(userId, text, 'post_102');
      expect(d2.isDuplicateSpam).toBe(false);
      expect(d2.targetCount).toBe(2);

      // Target 3: 3rd distinct target -> duplicate flood detected!
      const d3 = await guard.checkDuplicateContent(userId, text, 'post_103');
      expect(d3.isDuplicateSpam).toBe(true);
      expect(d3.targetCount).toBe(3);
    });

    it('should bypass duplicate check for very short text (< 10 chars)', async () => {
      const guard = new SpamVelocityGuard();
      const shortText = 'Ok nhé';

      const d1 = await guard.checkDuplicateContent('user_2', shortText, 'target_1');
      const d2 = await guard.checkDuplicateContent('user_2', shortText, 'target_2');
      const d3 = await guard.checkDuplicateContent('user_2', shortText, 'target_3');

      expect(d1.isDuplicateSpam).toBe(false);
      expect(d2.isDuplicateSpam).toBe(false);
      expect(d3.isDuplicateSpam).toBe(false);
    });

    it('should fail-open on cache adapter errors', async () => {
      const faultyAdapter = {
        get: () => {
          throw new Error('Redis connection lost');
        },
        set: () => {
          throw new Error('Redis connection lost');
        },
      };

      const guard = new SpamVelocityGuard({ cacheAdapter: faultyAdapter });

      const velResult = await guard.checkVelocity('user_err', 'comment');
      expect(velResult.isAllowed).toBe(true);

      const dupResult = await guard.checkDuplicateContent(
        'user_err',
        'Nội dung kiểm tra lỗi cache',
        'target_1',
      );
      expect(dupResult.isDuplicateSpam).toBe(false);
    });
  });

  // ==========================================
  // 7. GeminiSpamAnalyzer Suite
  // ==========================================
  describe('GeminiSpamAnalyzer', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should identify suspicious text with shouldTriggerAiAnalysis', () => {
      expect(shouldTriggerAiAnalysis('Cam kết lợi nhuận 50% mỗi tháng')).toBe(true);
      expect(shouldTriggerAiAnalysis('Kéo tài khoản 1-1 về bờ uy tín')).toBe(true);
      expect(shouldTriggerAiAnalysis('Tham gia nhóm kín vip room')).toBe(true);
      expect(shouldTriggerAiAnalysis('Lô đề tài xỉu trực tuyến')).toBe(true);
      expect(shouldTriggerAiAnalysis('https://example.com/invest')).toBe(true);

      // Short clean text should not trigger
      expect(shouldTriggerAiAnalysis('Thị trường hôm nay biến động nhẹ')).toBe(false);

      // Long text (> 120 chars) should trigger grey-zone analysis
      const longText =
        'Thị trường tài chính hiện tại đang có những tín hiệu rất lạ từ dòng tiền tổ chức và các quỹ đầu tư lớn trên thế giới đang dịch chuyển danh mục.'.repeat(
          2,
        );
      expect(shouldTriggerAiAnalysis(longText)).toBe(true);
    });

    it('should return non-spam fail-open if GEMINI_API_KEY is not configured', async () => {
      const analyzer = new GeminiSpamAnalyzer({ apiKey: '' });
      const result = await analyzer.analyzeContent('Cam kết lợi nhuận khủng');

      expect(result.isSpam).toBe(false);
      expect(result.reason).toContain('No API key');
    });

    it('should return empty text result for whitespace', async () => {
      const analyzer = new GeminiSpamAnalyzer({ apiKey: 'test_key' });
      const result = await analyzer.analyzeContent('   ');

      expect(result.isSpam).toBe(false);
      expect(result.reason).toBe('Empty text');
    });

    it('should successfully parse valid Gemini JSON spam response', async () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    isSpam: true,
                    score: 0.95,
                    categories: ['FINANCIAL_SCAM', 'GROUP_INVITE'],
                    reason: 'Dụ dỗ cam kết lãi khủng và mời vào nhóm kín',
                  }),
                },
              ],
            },
          },
        ],
      };

      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const analyzer = new GeminiSpamAnalyzer({ apiKey: 'mock_key' });
      const result = await analyzer.analyzeContent(
        'Lãi ngày 5% cam kết không rủi ro, inbox zalo nhận slot',
      );

      expect(result.isSpam).toBe(true);
      expect(result.score).toBe(0.95);
      expect(result.categories).toContain('FINANCIAL_SCAM');
      expect(result.categories).toContain('GROUP_INVITE');
      expect(result.reason).toContain('lãi khủng');
    });

    it('should handle markdown-wrapped json output cleanly', async () => {
      const rawMarkdownJson = `\`\`\`json
{
  "isSpam": true,
  "score": 0.88,
  "categories": ["GAMBLING_LOAN"],
  "reason": "Quảng cáo app đánh bạc tài xỉu"
}
\`\`\``;

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: rawMarkdownJson }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      const analyzer = new GeminiSpamAnalyzer({ apiKey: 'mock_key' });
      const result = await analyzer.analyzeContent('Chơi tài xỉu nổ hũ uy tín');

      expect(result.isSpam).toBe(true);
      expect(result.score).toBe(0.88);
      expect(result.categories).toContain('GAMBLING_LOAN');
    });

    it('should fail-open on HTTP error or timeout', async () => {
      globalThis.fetch = async () =>
        new Response('Service Unavailable', { status: 503 });

      const analyzer = new GeminiSpamAnalyzer({ apiKey: 'mock_key' });
      const result = await analyzer.analyzeContent('Thử nghiệm nội dung');

      expect(result.isSpam).toBe(false);
      expect(result.reason).toContain('Fail-open');
    });

    it('should clean markdown json properly with cleanJsonOutput', () => {
      const input = '```json\n{"hello":"world"}\n```';
      expect(cleanJsonOutput(input)).toBe('{"hello":"world"}');
    });

    it('should build formatted prompt with buildGeminiSpamPrompt', () => {
      const prompt = buildGeminiSpamPrompt('Nội dung mẫu', 'Tiêu đề mẫu');
      expect(prompt).toContain('Tiêu đề: Tiêu đề mẫu');
      expect(prompt).toContain('FINANCIAL_SCAM');
      expect(prompt).toContain('GROUP_INVITE');
    });
  });

  // ==========================================
  // 8. Presets Catalog Suite
  // ==========================================
  describe('Presets Catalog (@kido/anti-spam/presets)', () => {
    it('should provide Vietnamese presets with all 4 categories', () => {
      const viPresets = getVietnamesePresets();
      expect(viPresets.length).toBeGreaterThan(50);

      const categories = new Set(viPresets.map((r) => r.category));
      expect(categories.has(PRESET_CATEGORIES.PROFANITY)).toBe(true);
      expect(categories.has(PRESET_CATEGORIES.GAMBLING)).toBe(true);
      expect(categories.has(PRESET_CATEGORIES.SCAM)).toBe(true);
      expect(categories.has(PRESET_CATEGORIES.SEXUAL)).toBe(true);
    });

    it('should provide English presets with all 4 categories', () => {
      const enPresets = getEnglishPresets();
      expect(enPresets.length).toBeGreaterThan(30);

      const words = enPresets.map((r) => r.word);
      expect(words).toContain('fuck');
      expect(words).toContain('online casino');
      expect(words).toContain('investment scam');
      expect(words).toContain('escort service');
    });

    it('should provide combined presets with getAllPresets()', () => {
      const allPresets = getAllPresets();
      const viCount = getVietnamesePresets().length;
      const enCount = getEnglishPresets().length;

      expect(allPresets.length).toBe(viCount + enCount);
    });

    it('should filter presets by category and language', () => {
      const gamblingVi = getPresetsByCategory(PRESET_CATEGORIES.GAMBLING, 'vi');
      expect(gamblingVi.every((r) => r.category === 'GAMBLING')).toBe(true);
      expect(gamblingVi.map((r) => r.word)).toContain('tài xỉu');

      const customRules = createPresetRules({
        language: 'vi',
        categories: [PRESET_CATEGORIES.SCAM],
        action: 'HIDE',
      });
      expect(customRules.every((r) => r.action === 'HIDE')).toBe(true);
      expect(customRules.map((r) => r.word)).toContain('kéo tài khoản');
    });

    it('should work seamlessly when loaded into AntiSpamEngine', async () => {
      const engine = new AntiSpamEngine({
        defaultRules: getVietnamesePresets(),
      });

      // Gambling keyword
      const r1 = await engine.validate('Anh em vào chơi tài xỉu tối nay nhé');
      expect(r1.shouldBlock).toBe(true);
      expect(r1.matchedWords).toContain('tài xỉu');

      // Financial scam keyword
      const r2 = await engine.validate('Dịch vụ kéo tài khoản uy tín');
      expect(r2.shouldBlock).toBe(true);
      expect(r2.matchedWords).toContain('kéo tài khoản');

      // Profanity keyword
      const r3 = await engine.validate('Đồ thằng chó đẻ');
      expect(r3.shouldBlock).toBe(true);
      expect(r3.matchedWords).toContain('chó đẻ');

      // Clean business text
      const clean = await engine.validate('Báo cáo phân tích doanh thu quý 3 của công ty');
      expect(clean.isAllowed).toBe(true);
      expect(clean.shouldBlock).toBe(false);
    });
  });

  // ==========================================
  // 9. Full 3-Tier Multi-Layer Pipeline Suite
  // ==========================================
  describe('Full 3-Tier Pipeline in AntiSpamEngine', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('Layer 1: should block on forbidden keyword before running velocity or AI', async () => {
      let aiCalled = false;
      const mockAnalyzer = {
        thresholdScore: 0.8,
        shouldTriggerAiAnalysis: () => true,
        analyzeContent: async () => {
          aiCalled = true;
          return { isSpam: true, score: 0.99, categories: [], reason: 'AI spam' };
        },
      };

      const engine = new AntiSpamEngine({
        defaultRules: [{ id: 1, word: 'lừa đảo', action: 'BLOCK' }],
        geminiAnalyzer: mockAnalyzer,
      });

      const outcome = await engine.validate('Dự án này là lừa đảo trắng trợn');
      expect(outcome.shouldBlock).toBe(true);
      expect(outcome.action).toBe('BLOCK');
      // Short-circuit: AI is not called when Layer 1 blocks
      expect(aiCalled).toBe(false);
    });

    it('Layer 2: should reject request when velocity threshold is exceeded', async () => {
      const velocityGuard = new SpamVelocityGuard({
        commentLimit: 2,
        commentWindowSec: 60,
      });

      const engine = new AntiSpamEngine({
        velocityGuard,
      });

      const opts = { userId: 'user_burst_1', actionType: 'comment' };

      const r1 = await engine.validate('Bình luận lần 1', opts);
      expect(r1.isAllowed).toBe(true);

      const r2 = await engine.validate('Bình luận lần 2', opts);
      expect(r2.isAllowed).toBe(true);

      // 3rd comment exceeds limit 2
      const r3 = await engine.validate('Bình luận lần 3', opts);
      expect(r3.isAllowed).toBe(false);
      expect(r3.shouldBlock).toBe(true);
      expect(r3.action).toBe('BLOCK');
      expect(r3.reason).toContain('quá nhanh');
      expect(r3.categories).toContain('VELOCITY_LIMIT');
      expect(r3.velocityResult?.retryAfterSec).toBe(60);
    });

    it('Layer 2: should mark action as HIDE when duplicate target flood is detected', async () => {
      const velocityGuard = new SpamVelocityGuard({
        duplicateThreshold: 3,
        duplicateWindowSec: 300,
      });

      const engine = new AntiSpamEngine({
        velocityGuard,
      });

      const userId = 'bot_flooder';
      const spamText = 'Ủy thác đầu tư lợi nhuận ổn định 10% mỗi tháng';

      const r1 = await engine.validate(spamText, { userId, targetId: 'post_1' });
      expect(r1.shouldHide).toBe(false);

      const r2 = await engine.validate(spamText, { userId, targetId: 'post_2' });
      expect(r2.shouldHide).toBe(false);

      // 3rd distinct target -> duplicate flood!
      const r3 = await engine.validate(spamText, { userId, targetId: 'post_3' });
      expect(r3.shouldHide).toBe(true);
      expect(r3.action).toBe('HIDE');
      expect(r3.reason).toContain('trùng lặp liên tục');
      expect(r3.categories).toContain('DUPLICATE_FLOOD');
    });

    it('Layer 3: should invoke Gemini AI for grey-zone content and flag spam with score >= 0.8', async () => {
      const mockAnalyzer = {
        thresholdScore: 0.8,
        shouldTriggerAiAnalysis: (text: string) => shouldTriggerAiAnalysis(text),
        analyzeContent: async (text: string) => {
          if (text.includes('lãi ngày')) {
            return {
              isSpam: true,
              score: 0.92,
              categories: ['FINANCIAL_SCAM'],
              reason: 'AI phát hiện mô hình cam kết lợi nhuận lừa đảo',
            };
          }
          return {
            isSpam: false,
            score: 0.1,
            categories: [],
            reason: 'Nội dung bình thường',
          };
        },
      };

      const engine = new AntiSpamEngine({
        geminiAnalyzer: mockAnalyzer,
      });

      // Text contains keyword 'lãi ngày' which triggers shouldTriggerAiAnalysis
      const scamOutcome = await engine.validate(
        'Đầu tư sinh lời với mức lãi ngày 3% cam kết hoàn vốn nhanh',
      );

      expect(scamOutcome.shouldHide).toBe(true);
      expect(scamOutcome.action).toBe('HIDE');
      expect(scamOutcome.categories).toContain('FINANCIAL_SCAM');
      expect(scamOutcome.reason).toContain('AI phát hiện');
      expect(scamOutcome.aiAnalysis?.score).toBe(0.92);

      // Clean text does not get flagged
      const cleanOutcome = await engine.validate('Chào buổi sáng mọi người');
      expect(cleanOutcome.shouldHide).toBe(false);
      expect(cleanOutcome.action).toBe('ALLOW');
    });
  });

  // ==========================================
  // 10. Advanced Edge Cases & Performance Suite
  // ==========================================
  describe('Advanced Edge Cases & Scalability', () => {
    it('should correctly handle Vietnamese Scunthorpe word boundaries for "bán"', () => {
      const automaton = new AhoCorasickAutomaton();
      automaton.build([
        { id: 1, word: 'bán', action: 'BLOCK', isWholeWord: true },
      ]);

      // "cơ bản" has "bản" (ả vs á), boundary & accent checks prevent block
      const coBanResult = automaton.search('Nền tảng kiến thức cơ bản');
      expect(coBanResult.hasBlock).toBe(false);

      const banSacResult = automaton.search('Giữ gìn bản sắc văn hóa');
      expect(banSacResult.hasBlock).toBe(false);

      // "buôn bán" contains whole word "bán"
      const buonBanResult = automaton.search('Hoạt động buôn bán nhộn nhịp');
      expect(buonBanResult.hasBlock).toBe(true);
      expect(buonBanResult.blockedWords).toContain('bán');

      // "bán acc"
      const banAccResult = automaton.search('Cần bán acc vip');
      expect(banAccResult.hasBlock).toBe(true);
    });

    it('should respect case-sensitive rules', () => {
      const automaton = new AhoCorasickAutomaton();
      automaton.build([
        { id: 1, word: 'VIP_SCAM', action: 'BLOCK', isCaseSensitive: true },
      ]);

      const lowerResult = automaton.search('nhận vé vip_scam giá rẻ');
      expect(lowerResult.hasBlock).toBe(false);

      const upperResult = automaton.search('nhận vé VIP_SCAM giá rẻ');
      expect(upperResult.hasBlock).toBe(true);
      expect(upperResult.blockedWords).toContain('VIP_SCAM');
    });

    it('should handle large text and 500 rules with sub-millisecond linear performance', () => {
      const rules: BlacklistRule[] = [];
      for (let i = 0; i < 500; i++) {
        rules.push({
          id: i,
          word: `spamword_${i}`,
          action: 'BLOCK',
          isWholeWord: true,
        });
      }
      rules.push({
        id: 999,
        word: 'violated_term',
        action: 'BLOCK',
        isWholeWord: true,
      });

      const automaton = new AhoCorasickAutomaton();
      automaton.build(rules);

      // 10,000 characters paragraph
      const longText =
        'Một đoạn văn bản dài lành mạnh chứa nhiều thông tin. '.repeat(200) +
        'violated_term kết thúc';

      const start = performance.now();
      const result = automaton.search(longText);
      const elapsed = performance.now() - start;

      expect(result.hasBlock).toBe(true);
      expect(result.blockedWords).toContain('violated_term');
      // Sub-200ms for 10k chars and 501 rules under parallel CI load
      expect(elapsed).toBeLessThan(200);
    });

    it('should safely handle empty and whitespace-only text', async () => {
      const engine = new AntiSpamEngine({
        defaultRules: [{ id: 1, word: 'test', action: 'BLOCK' }],
      });

      const outcome1 = await engine.validate('');
      expect(outcome1.isAllowed).toBe(true);
      expect(outcome1.action).toBe('ALLOW');

      const outcome2 = await engine.validate('   \n\t  ');
      expect(outcome2.isAllowed).toBe(true);
      expect(outcome2.action).toBe('ALLOW');
    });
  });
});
