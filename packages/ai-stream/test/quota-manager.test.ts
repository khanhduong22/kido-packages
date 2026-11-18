/**
 * @kido/ai-stream - Level 13 Per-User Token Quota & 3-Layer EDoS Shield Test Suite
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PerUserTokenQuotaManager,
  InMemoryQuotaStore,
  DEFAULT_PER_USER_QUOTA_POLICY,
  VALKEY_PER_USER_QUOTA_LUA,
  clampChatPrompt,
  EdosChatbotShield,
  simulateLevel13BudgetBurningChatbot,
} from '../src/quota-manager/index.js';
import {
  DualRpmTpmTokenBucket,
  MultiProviderQuotaPoolRouter,
} from '../src/rpm-rate-guard/index.js';

const BASE_TIME = 1_700_000_000_000;

describe('Level 13 Per-User Token Quota & 3-Layer EDoS Shield', () => {
  describe('1. InMemoryQuotaStore & VALKEY_PER_USER_QUOTA_LUA', () => {
    it('evicts least-recently-used entries at maxEntries capacity', () => {
      const store = new InMemoryQuotaStore({ maxEntries: 3 });
      const mk = (v: number) => ({
        minuteBucket: 1, dayBucket: 1, requestsMinute: v, requestsDay: v,
        tokensMinute: v * 10, tokensDay: v * 10, violations: 0, lastAccessMs: BASE_TIME,
      });

      store.set('u1', mk(1));
      store.set('u2', mk(2));
      store.set('u3', mk(3));
      assert.equal(store.size(), 3);

      // Refresh u1 recency via get(), so u2 becomes the LRU entry
      assert.equal(store.get('u1')?.requestsMinute, 1);
      store.set('u4', mk(4));

      assert.equal(store.size(), 3);
      assert.equal(store.has('u1'), true);
      assert.equal(store.has('u2'), false);
      assert.equal(store.has('u3'), true);
      assert.equal(store.has('u4'), true);
    });

    it('exports atomic Redis/Valkey Lua script covering 413 and minute/day windows', () => {
      for (const token of [
        'SINGLE_PROMPT_TOO_LARGE',
        'MINUTE_RPM_EXCEEDED',
        'DAY_RPD_EXCEEDED',
        'MINUTE_TPM_EXCEEDED',
        'DAY_TPD_EXCEEDED',
        'PEXPIRE',
      ]) {
        assert.ok(VALKEY_PER_USER_QUOTA_LUA.includes(token), `Lua missing ${token}`);
      }
    });
  });

  describe('2. PerUserTokenQuotaManager', () => {
    it('pre-flight rejects 50,000-token paste with 413 and 0 LLM tokens deducted', () => {
      let now = BASE_TIME;
      const mgr = new PerUserTokenQuotaManager({ now: () => now });

      const first = mgr.checkAndConsume({ subjectId: 'user-paste', estimatedInputTokens: 120 });
      assert.equal(first.allowed, true);
      assert.equal(first.httpStatus, 200);

      const abuse = mgr.checkAndConsume({ subjectId: 'user-paste', estimatedInputTokens: 50_000 });
      assert.equal(abuse.allowed, false);
      assert.equal(abuse.httpStatus, 413);
      assert.equal(abuse.reason, 'SINGLE_PROMPT_TOO_LARGE');
      assert.equal(abuse.headers['X-Quota-Blocked'], '1');
      assert.equal(abuse.retryAfterSeconds, 0);

      // Verify 0 tokens were added for the rejected 50,000-token prompt
      const snap = mgr.getSnapshot('user-paste');
      assert.equal(snap.requestsMinute, 1);
      assert.equal(snap.tokensMinute, 120);
      assert.equal(snap.tokensDay, 120);
      assert.equal(snap.violations, 1);
    });

    it('enforces minute RPM and resets cleanly on next minute window', () => {
      let now = BASE_TIME;
      const mgr = new PerUserTokenQuotaManager({
        policy: { maxRequestsPerMinute: 3, maxRequestsPerDay: 20 },
        now: () => now,
      });

      for (let i = 0; i < 3; i++) {
        const res = mgr.checkAndConsume({ subjectId: 'rpm-user', estimatedInputTokens: 50 });
        assert.equal(res.allowed, true);
        assert.equal(res.remainingRequestsMinute, 2 - i);
      }

      const blocked = mgr.checkAndConsume({ subjectId: 'rpm-user', estimatedInputTokens: 50 });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.httpStatus, 429);
      assert.equal(blocked.reason, 'MINUTE_RPM_EXCEEDED');
      assert.equal(blocked.headers['X-Quota-Blocked'], '1');
      assert.ok(blocked.retryAfterSeconds >= 1);

      now += 61_000;
      const recovered = mgr.checkAndConsume({ subjectId: 'rpm-user', estimatedInputTokens: 50 });
      assert.equal(recovered.allowed, true);
      assert.equal(recovered.remainingRequestsMinute, 2);
      assert.equal(recovered.remainingRequestsDay, 16);
    });

    it('enforces day RPD limit across minute boundaries until day rollover', () => {
      let now = BASE_TIME;
      const mgr = new PerUserTokenQuotaManager({
        policy: { maxRequestsPerMinute: 10, maxRequestsPerDay: 4 },
        now: () => now,
      });

      for (let i = 0; i < 4; i++) {
        now += 65_000;
        assert.equal(mgr.checkAndConsume({ subjectId: 'rpd-user', estimatedInputTokens: 20 }).allowed, true);
      }

      const blocked = mgr.checkAndConsume({ subjectId: 'rpd-user', estimatedInputTokens: 20 });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.httpStatus, 429);
      assert.equal(blocked.reason, 'DAY_RPD_EXCEEDED');
      assert.ok(blocked.retryAfterSeconds > 60);

      now += 86_400_000;
      assert.equal(mgr.checkAndConsume({ subjectId: 'rpd-user', estimatedInputTokens: 20 }).allowed, true);
    });

    it('enforces minute TPM and day TPD limits independently', () => {
      let now = BASE_TIME;
      const mgr = new PerUserTokenQuotaManager({
        policy: {
          maxRequestsPerMinute: 100,
          maxRequestsPerDay: 500,
          maxTokensPerMinute: 500,
          maxTokensPerDay: 900,
          maxSinglePromptTokens: 400,
        },
        now: () => now,
      });

      assert.equal(mgr.checkAndConsume({ subjectId: 'tpm-user', estimatedInputTokens: 300 }).allowed, true);
      const minBlocked = mgr.checkAndConsume({ subjectId: 'tpm-user', estimatedInputTokens: 250 });
      assert.equal(minBlocked.allowed, false);
      assert.equal(minBlocked.httpStatus, 429);
      assert.equal(minBlocked.reason, 'MINUTE_TPM_EXCEEDED');

      // Advance 2 minutes: minute TPM resets, but day TPD (300/900 used) remains
      now += 120_000;
      assert.equal(mgr.checkAndConsume({ subjectId: 'tpm-user', estimatedInputTokens: 350 }).allowed, true);
      now += 120_000;
      const dayBlocked = mgr.checkAndConsume({ subjectId: 'tpm-user', estimatedInputTokens: 300 });
      assert.equal(dayBlocked.allowed, false);
      assert.equal(dayBlocked.httpStatus, 429);
      assert.equal(dayBlocked.reason, 'DAY_TPD_EXCEEDED');
    });

    it('reconciles completionTokens and input delta via recordCompletionTokens', () => {
      const mgr = new PerUserTokenQuotaManager({ now: () => BASE_TIME });
      mgr.checkAndConsume({ subjectId: 'rec-user', estimatedInputTokens: 600 });

      const snap = mgr.recordCompletionTokens({
        subjectId: 'rec-user',
        estimatedInputTokens: 600,
        actualInputTokens: 150,
        completionTokens: 80,
      });
      // 600 + 80 + (150 - 600) = 230 tokens
      assert.equal(snap.tokensMinute, 230);
      assert.equal(snap.tokensDay, 230);
      assert.equal(snap.remainingTokensMinute, DEFAULT_PER_USER_QUOTA_POLICY.maxTokensPerMinute - 230);
    });

    it('supports anonymous/authenticated/vip tiers with custom overrides and challenge threshold', () => {
      const mgr = new PerUserTokenQuotaManager({
        tierOverrides: {
          vip: { maxRequestsPerMinute: 50 },
        },
        now: () => BASE_TIME,
      });

      assert.equal(mgr.resolvePolicy('anonymous').maxRequestsPerMinute, 6);
      assert.equal(mgr.resolvePolicy('authenticated').maxRequestsPerMinute, 12);
      assert.equal(mgr.resolvePolicy('vip').maxRequestsPerMinute, 50);

      // 3 violations on anonymous user triggers requiresChallenge
      for (let i = 1; i <= 3; i++) {
        const res = mgr.checkAndConsume({ subjectId: 'anon-1', tier: 'anonymous', estimatedInputTokens: 9999 });
        assert.equal(res.allowed, false);
        assert.equal(res.requiresChallenge, i >= 3);
        if (i >= 3) assert.equal(res.headers['X-Quota-Challenge-Required'], '1');
      }
      mgr.reset('anon-1');
      assert.equal(mgr.getSnapshot('anon-1', { tier: 'anonymous' }).violations, 0);
    });
  });

  describe('3. clampChatPrompt & EdosChatbotShield', () => {
    it('strips email chains/signatures, collapses spam floods, and clamps query & history', () => {
      const bloatedQuery =
        'Cho mình hỏi giấy màu nước 300gsm loại nào tốt ạ? ' +
        'a'.repeat(50) +
        '\nDuplicate line check\nDuplicate line check\n' +
        '\nOn Mon, Nov 17, 2026 at 09:00 AM Support <help@example.com> wrote:\n' +
        '> Old quoted message\n'.repeat(80) +
        '\n--\nSent from my iPhone\nThis email and any attachments are confidential.';

      const res = clampChatPrompt(
        {
          query: bloatedQuery,
          history: Array.from({ length: 8 }, (_, idx) => ({
            role: idx % 2 === 0 ? 'user' : 'assistant',
            content: `Turn ${idx}: ${'b'.repeat(700)}`,
          })),
        },
        { maxQueryChars: 300, maxPromptTokens: 120, maxHistoryTurns: 4, maxHistoryTurnChars: 150 }
      );

      assert.equal(res.wasClamped, true);
      assert.ok(res.tokensSaved > 50);
      assert.ok(res.cleanQuery.includes('giấy màu nước 300gsm'));
      assert.ok(!res.cleanQuery.includes('Old quoted message'));
      assert.ok(!res.cleanQuery.includes('aaaaaaaaaa'));
      assert.ok(res.cleanQuery.length <= 300);
      assert.equal(res.cleanHistory.length, 4);
      assert.ok(res.cleanHistory.every((t) => t.content.length <= 150));
    });

    it('orchestrates 3-layer shield: 413 block on botnet & 50/50 split + token refund on email paste', async () => {
      const quotaManager = new PerUserTokenQuotaManager({ now: () => BASE_TIME });
      const router = new MultiProviderQuotaPoolRouter([
        { id: 'openai_small', bucket: new DualRpmTpmTokenBucket({ maxRpm: 100, maxTpm: 100_000 }) },
        { id: 'anthropic_small', bucket: new DualRpmTpmTokenBucket({ maxRpm: 100, maxTpm: 100_000 }) },
      ]);
      const shield = new EdosChatbotShield({
        quotaManager,
        router,
        clampOptions: { maxQueryChars: 400, maxPromptTokens: 120 },
      });

      let invoked = 0;
      const botPaste = 'book '.repeat(45_000);
      const blocked = await shield.execute(
        { subjectId: 'bot-1', tier: 'anonymous', query: botPaste, nowMs: BASE_TIME },
        async () => {
          invoked++;
          return 'should not run';
        }
      );
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.httpStatus, 413);
      assert.equal(blocked.attempts, 0);
      assert.equal(invoked, 0);
      assert.equal(quotaManager.getSnapshot('bot-1').tokensMinute, 0);

      const emailThread =
        'Tư vấn cọ tỉa nét mảnh ạ.\nOn Tue, Nov 18, 2026 at 10:00 AM User wrote:\n' +
        '> old quoted reply line with extra noise '.repeat(40);
      const seenPools: string[] = [];

      for (let i = 0; i < 4; i++) {
        const ok = await shield.execute(
          { subjectId: `legit-${i}`, query: emailThread, nowMs: BASE_TIME },
          async (ctx) => {
            seenPools.push(ctx.providerId);
            assert.ok(!ctx.cleanQuery.includes('old quoted reply'));
            return { result: 'Khạp khạp! Chọn cọ tỉa số 00 nha.', completionTokens: 20 };
          }
        );
        assert.equal(ok.allowed, true);
        assert.equal(ok.httpStatus, 200);
        assert.ok(ok.tokensSaved > 0);
        assert.ok(ok.snapshot.tokensMinute < ok.clamped!.rawTokens);
        assert.ok(ok.headers['X-Quota-Remaining-Requests']);
        assert.ok(ok.headers['X-Quota-Remaining-Tokens']);
      }

      assert.equal(seenPools.filter((p) => p === 'openai_small').length, 2);
      assert.equal(seenPools.filter((p) => p === 'anthropic_small').length, 2);
    });
  });

  describe('4. simulateLevel13BudgetBurningChatbot', () => {
    it('proves SLA failures without QuotaManager, ContextBuilder, or 2nd Small pool', () => {
      const noQuota = simulateLevel13BudgetBurningChatbot({ hasQuotaManager: false });
      assert.equal(noQuota.passedSla, false);
      assert.equal(noQuota.edosAttacksBlocked, 0);
      assert.ok(noQuota.edosTokensBurned > 0);
      assert.ok(noQuota.costPerTaskUc > noQuota.budgetUc);

      const noContext = simulateLevel13BudgetBurningChatbot({ hasContextBuilder: false });
      assert.equal(noContext.passedSla, false);
      assert.equal(noContext.passedAccuracySla, false);
      assert.ok(noContext.accuracyPct < 85);

      const onePool = simulateLevel13BudgetBurningChatbot({ activeSmallPools: 1 });
      assert.equal(onePool.passedSla, false);
      assert.equal(onePool.passedAnsweredSla, false);
      assert.ok(onePool.answeredPct < 99);

      const noStream = simulateLevel13BudgetBurningChatbot({ stream: false });
      assert.equal(noStream.passedSla, false);
      assert.equal(noStream.passedTtftSla, false);

      const noRetry = simulateLevel13BudgetBurningChatbot({ retryMode: 'none' });
      assert.equal(noRetry.passedSla, false);
    });

    it('achieves 100% 3-Star SLA with 3-Layer EDoS Shield at 27,266 UC/task', () => {
      const optimal = simulateLevel13BudgetBurningChatbot({
        hasQuotaManager: true,
        hasContextBuilder: true,
        activeSmallPools: 2,
        retryMode: 'backoff',
        stream: true,
      });

      assert.equal(optimal.totalTicks, 420);
      assert.equal(optimal.legitimateTasks, 2760);
      assert.equal(optimal.edosAttacksBlocked, optimal.edosAttacksAttempted);
      assert.equal(optimal.edosTokensBurned, 0);
      assert.ok(optimal.answeredPct >= 99);
      assert.ok(optimal.ttftMs <= 2000);
      assert.ok(optimal.accuracyPct >= 85);
      assert.equal(optimal.costPerTaskUc, 27_266);
      assert.equal(optimal.passedSla, true);
      assert.equal(optimal.isThreeStarRecord, true);
    });
  });
});
