/**
 * @kido/ai-stream - Level 09 Cross-Encoder Reranker & Two-Stage Retrieval Verification Suite
 *
 * Verifies:
 * 1. LocalCrossEncoderReranker: scoring, query term coverage, phrase proximity, and deterministic tie-breaking.
 * 2. RemoteRerankApi: mock fetch, payload formatting, error handling, retries, and automatic fallback to LocalCrossEncoder.
 * 3. TwoStageRetrievalPipeline: Stage 1 Broad Recall (top 20) -> Stage 2 Cross-Encoder Rerank -> Stage 3 Context Pruning (top 5 + threshold).
 * 4. simulateLevel09FindTheRightChunk: GonnaCrash World 3 Level 09 3-Star SLA validation:
 *    - Answered >= 99%
 *    - First word <= 3.0s
 *    - Correct >= 85% (accuracy jumps from ~72% to >= 87% / 91.67%)
 *    - Cost <= 1.20¢/task (1,200,000 UC), proving Best Cost 1.0414¢/task (1,041,357 UC).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalCrossEncoderReranker,
  RemoteRerankApi,
  createTwoStageRetrievalPipeline,
  simulateLevel09FindTheRightChunk,
  adaptDocumentChunkToCandidate,
  adaptCatalogProductToCandidate,
  type RerankCandidate,
  AsyncIngestionQueue,
  IngestionPacer,
  MicroBatchChunker,
  IngestionWorker,
  buildPgvectorBatchInsertSql,
  simulateLevel10FreshDocsHourly,
  computeIngestionDecorrelatedJitterMs,
  computeIngestionFullJitterMs,
  adaptKnowledgeDocumentToIngestionJob,
  createCommerceAsyncIngestionPipeline,
  type IngestionJob,
  type BatchUpsertItem,
  stripEmailReplyChain,
  stripLegalDisclaimers,
  stripSignatureBlocks,
  slidingWindowContext,
  ContextBuilder,
  sanitizeContext,
  simulateLevel12BloatedTickets,
  sanitizeSupportTicket,
  type ContextSanitizerOptions,
  type SanitizeResult,
  type GonnaCrashLevel12SimOptions,
  type Level12SimulationResult,
  type SupportTicketLike,
} from '../src/index.js';

describe('Level 09 Cross-Encoder Reranker & Two-Stage Retrieval Suite', () => {

  // ==========================================================================
  // 1. LocalCrossEncoderReranker Unit Tests
  // ==========================================================================
  describe('1. LocalCrossEncoderReranker', () => {
    it('accurately scores candidates based on exact match, proximity, and query coverage', async () => {
      const reranker = new LocalCrossEncoderReranker();
      const query = 'chính sách hoàn tiền khi hàng vỡ';

      const candidates: RerankCandidate[] = [
        {
          id: 'chunk_distractor',
          title: 'Quy định bảo mật thông tin',
          content: 'Bảo mật thông tin thanh toán tiền và tài khoản ngân hàng của khách.',
          initialRank: 1,
          initialScore: 0.85,
        },
        {
          id: 'chunk_exact',
          title: 'Chính sách hoàn tiền khi hàng vỡ',
          content: 'Khi hàng vỡ trong vận chuyển, khách hàng chụp ảnh gửi hỗ trợ để nhận hoàn tiền 100% trong 24 giờ.',
          initialRank: 2,
          initialScore: 0.72,
        },
        {
          id: 'chunk_partial',
          title: 'Quy trình đóng gói hàng dễ vỡ',
          content: 'Đóng gói hàng dễ vỡ với mút xốp chống sốc 3 lớp trước khi giao vận.',
          initialRank: 3,
          initialScore: 0.68,
        },
      ];

      const results = await reranker.rerank(query, candidates);

      assert.equal(results.length, 3);
      // Perfect match must be promoted to rank 1 despite starting at rank 2
      assert.equal(results[0].id, 'chunk_exact');
      assert.equal(results[0].rank, 1);
      assert.equal(results[0].initialRank, 2);
      assert(results[0].score > results[1].score);
      assert(results[0].score >= 0.70);
      assert(results[0].score <= 1.0);
    });

    it('performs deterministic tie-breaking preserving lower initialRank', async () => {
      const reranker = new LocalCrossEncoderReranker();
      const identicalCandidates: RerankCandidate[] = [
        { id: 'chunk_z', content: 'Identical documentation snippet for tie break testing.', initialRank: 5 },
        { id: 'chunk_a', content: 'Identical documentation snippet for tie break testing.', initialRank: 2 },
        { id: 'chunk_m', content: 'Identical documentation snippet for tie break testing.', initialRank: 4 },
      ];

      const results = await reranker.rerank('documentation snippet', identicalCandidates);

      assert.equal(results.length, 3);
      // All scores are identical, so tie-breaker must sort by initialRank ascending (2 -> 4 -> 5)
      assert.equal(results[0].id, 'chunk_a');
      assert.equal(results[0].initialRank, 2);
      assert.equal(results[1].id, 'chunk_m');
      assert.equal(results[1].initialRank, 4);
      assert.equal(results[2].id, 'chunk_z');
      assert.equal(results[2].initialRank, 5);
    });

    it('handles unaccented / diacritic-normalized Vietnamese search and minRelevanceScore', async () => {
      const reranker = new LocalCrossEncoderReranker();
      const unaccentedQuery = 'mau nuoc holbein nghe thuat';

      const candidates: RerankCandidate[] = [
        {
          id: 'holbein_art',
          title: 'Màu Nước Holbein Hạng Nghệ Thuật',
          content: 'Bộ màu nước Holbein Artists cao cấp cho họa sĩ chuyên nghiệp.',
        },
        {
          id: 'unrelated',
          title: 'Giấy phác thảo chì',
          content: 'Giấy vẽ ký họa than chì hạt vân thô 160gsm.',
        },
      ];

      const results = await reranker.rerank(unaccentedQuery, candidates, { minRelevanceScore: 0.25 });

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'holbein_art');
      assert(results[0].score >= 0.40);
    });
  });

  // ==========================================================================
  // 2. RemoteRerankApi Unit Tests
  // ==========================================================================
  describe('2. RemoteRerankApi', () => {
    it('formats request payload, parses remote scores, and respects topK', async () => {
      let passedPayload: any = null;
      let authHeader: string | null = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? null;
        passedPayload = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.982 },
              { index: 0, relevance_score: 0.315 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const remoteApi = new RemoteRerankApi({
        provider: 'cohere',
        apiKey: 'co-test-token-xyz',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const candidates: RerankCandidate[] = [
        { id: 'cand_a', content: 'First doc' },
        { id: 'cand_b', content: 'Second doc' },
      ];

      const results = await remoteApi.rerank('query string', candidates, { topK: 1 });

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'cand_b');
      assert.equal(results[0].score, 0.982);
      assert.equal(results[0].rank, 1);
      assert.equal(authHeader, 'Bearer co-test-token-xyz');
      assert.equal(passedPayload.query, 'query string');
      assert.equal(passedPayload.top_n, 1);
    });

    it('falls back automatically to LocalCrossEncoderReranker when remote API returns HTTP 500 or throws', async () => {
      let callCount = 0;
      const failingFetch = async (): Promise<Response> => {
        callCount++;
        return new Response('Remote Server Outage', { status: 500 });
      };

      const remoteApi = new RemoteRerankApi({
        provider: 'cohere',
        apiKey: 'fail-token',
        maxRetries: 1,
        fallbackToLocal: true,
        fetchFn: failingFetch as unknown as typeof fetch,
      });

      const candidates: RerankCandidate[] = [
        { id: 'noise', content: 'Random unhelpful text', title: 'Noise' },
        { id: 'target', content: 'Crucial steps to resolve network connection timeout issue', title: 'Network Troubleshoot' },
      ];

      const results = await remoteApi.rerank('resolve network connection timeout', candidates);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, 'target');
      assert.equal(results[0].provider, 'local');
      assert(results[0].explanation?.includes('Fallback from cohere'));
      assert(callCount >= 2); // 1 initial + 1 retry
    });
  });

  // ==========================================================================
  // 3. TwoStageRetrievalPipeline Unit Tests
  // ==========================================================================
  describe('3. TwoStageRetrievalPipeline', () => {
    it('executes Stage 1 Recall (top 20) -> Stage 2 Rerank -> Stage 3 Prune (top 5 distractors eliminated)', async () => {
      // Mock retriever returning 20 candidates (broad recall)
      const mockRetriever = async (_query: string, topK: number): Promise<RerankCandidate[]> => {
        const pool: RerankCandidate[] = [];
        for (let i = 1; i <= topK; i++) {
          if (i === 18) {
            // Ground truth buried deep at index 18
            pool.push({
              id: `chunk_${i}_golden`,
              title: 'Quy định hoàn tiền và bồi thường hàng vỡ',
              content: 'Khi hàng bị vỡ trong vận chuyển, nhân viên lập tức xử lý hoàn tiền cho khách trong 24 giờ.',
              initialRank: i,
              initialScore: 0.62,
            });
          } else {
            pool.push({
              id: `chunk_${i}_distractor`,
              title: `Tài liệu thông tin chung ${i}`,
              content: `Nội dung tổng quát về bảo hộ lao động và quy chế hành chính ${i}.`,
              initialRank: i,
              initialScore: 0.70 + (i * 0.005),
            });
          }
        }
        return pool;
      };

      const pipeline = createTwoStageRetrievalPipeline({
        stage1RecallTopK: 20,
        stage2FinalTopK: 5,
        minRelevanceScore: 0.0,
        reranker: new LocalCrossEncoderReranker(),
        retriever: mockRetriever,
      });

      const result = await pipeline.execute('khi hàng bị vỡ hoàn tiền cho khách');

      assert.equal(result.stage1Count, 20);
      assert.equal(result.stage2Count, 5);
      assert.equal(result.finalCount, 5);
      assert.equal(result.distractorsPruned, 15);
      // The buried chunk at position 18 must be promoted to rank 1
      assert.equal(result.finalCandidates[0].id, 'chunk_18_golden');
      assert.equal(result.finalCandidates[0].rank, 1);
      assert.equal(result.finalCandidates[0].initialRank, 18);
      assert(result.finalCandidates[0].score >= 0.50);
      assert(result.totalDurationMs >= 0);
      assert(result.stage1DurationMs >= 0);
      assert(result.stage2DurationMs >= 0);
    });

    it('enforces minRelevanceScore threshold filtering to eliminate unrelated noise', async () => {
      const mockRetriever = async (_query: string, topK: number): Promise<RerankCandidate[]> => {
        const pool: RerankCandidate[] = [];
        for (let i = 1; i <= topK; i++) {
          if (i === 1) {
            pool.push({
              id: 'golden_refund',
              title: 'Chính sách hoàn tiền khi hàng vỡ',
              content: 'Hoàn tiền 100% trong 24 giờ nếu hàng vỡ khi vận chuyển.',
              initialRank: 1,
            });
          } else {
            pool.push({
              id: `unrelated_${i}`,
              title: `Tài liệu kế toán ${i}`,
              content: `Báo cáo quyết toán thuế và chứng từ tài chính số ${i}.`,
              initialRank: i,
            });
          }
        }
        return pool;
      };

      const pipelineWithThreshold = createTwoStageRetrievalPipeline({
        stage1RecallTopK: 20,
        stage2FinalTopK: 5,
        minRelevanceScore: 0.35, // Strict threshold
        reranker: new LocalCrossEncoderReranker(),
        retriever: mockRetriever,
      });

      const result = await pipelineWithThreshold.execute('hoàn tiền khi hàng vỡ');
      // Only the 1 golden candidate scores >= 0.35, all 19 unrelated docs are pruned
      assert.equal(result.stage1Count, 20);
      assert.equal(result.finalCount, 1);
      assert.equal(result.finalCandidates[0].id, 'golden_refund');
      assert(result.finalCandidates[0].score >= 0.50);
    });
  });

  // ==========================================================================
  // 4. simulateLevel09FindTheRightChunk() 3-Star SLA Verification
  // ==========================================================================
  describe('4. GonnaCrash Level 09 3-Star SLA Simulation Verification', () => {
    it('fails 3-Star SLA when reranker is absent (accuracy ~72.5% < 85%)', () => {
      const naive = simulateLevel09FindTheRightChunk({ hasReranker: false, hasStreaming: true });
      assert.equal(naive.passedCorrectSla, false);
      assert(naive.correctPpm < 850_000);
      assert.equal(naive.isThreeStarRecord, false);
    });

    it('fails 3-Star SLA when streaming is absent (TTFT ~4.2s > 3.0s)', () => {
      const noStream = simulateLevel09FindTheRightChunk({ hasReranker: true, hasStreaming: false });
      assert.equal(noStream.passedTtftSla, false);
      assert(noStream.averageTtftMs > 3000);
      assert.equal(noStream.isThreeStarRecord, false);
    });

    it('satisfies 100% GonnaCrash Level 09 3-Star SLA with Two-Stage Reranker + Streaming', () => {
      const winning = simulateLevel09FindTheRightChunk({ hasReranker: true, hasStreaming: true });

      // 1. Answered >= 99%
      assert.equal(winning.passedAnsweredSla, true);
      assert(winning.answeredPpm >= 990_000);
      assert.equal(winning.answeredPpm, 1_000_000);

      // 2. First Word <= 3.0s
      assert.equal(winning.passedTtftSla, true);
      assert(winning.averageTtftMs <= 3000);
      assert.equal(winning.averageTtftMs, 880);

      // 3. Accuracy / Correct >= 85% (jumps from 72.5% to >= 87% / 91.67%)
      assert.equal(winning.passedCorrectSla, true);
      assert(winning.correctPpm >= 850_000);
      assert.equal(winning.correctPpm, 916667);
      assert(winning.accuracyImprovement >= 15);

      // 4. Cost <= 1.20¢/task (1,200,000 UC), Best Cost = 1.0414¢/task (1,041,357 UC)
      assert.equal(winning.passedCostSla, true);
      assert(winning.costPerTaskUc <= 1_200_000);
      assert.equal(winning.costPerTaskUc, 1041357);
      assert.equal(winning.costPerTaskCents, 1.0414);

      // 5. Overall 3-Star Record
      assert.equal(winning.isThreeStarRecord, true);
      assert(winning.verdict.includes('PASSED'));
    });
  });

  // ==========================================================================
  // 5. Commerce Catalog Domain Adapters
  // ==========================================================================
  describe('5. Commerce Catalog Domain Adapters', () => {
    it('seamlessly adapts StoreProduct and DocumentChunk to RerankCandidate', () => {
      const product = {
        id: 'cat_prod_001',
        name: 'Giấy Màu Nước Baohong 300gsm Vân Cold Press',
        brand: 'Baohong',
        category: 'Giấy Vẽ Mỹ Thuật',
        tags: ['cotton 100%', '300gsm', 'vân cold press'],
        description: 'Giấy vẽ màu nước 100% cotton cao cấp, thấm hút đều và không bị bở.',
        price: 135000,
        matchScore: 0.84,
      };

      const candidate = adaptCatalogProductToCandidate(product, 2);
      assert.equal(candidate.id, 'cat_prod_001');
      assert.equal(candidate.title, 'Giấy Màu Nước Baohong 300gsm Vân Cold Press');
      assert(candidate.content.includes('Baohong'));
      assert(candidate.content.includes('135.000đ'));
      assert.equal(candidate.initialScore, 0.84);
      assert.equal(candidate.initialRank, 2);

      const chunk = {
        id: 'chunk_leave_01',
        documentId: 'sop_leaves',
        chunkIndex: 0,
        title: 'Quy định nghỉ phép năm',
        content: 'Mỗi năm nhân viên chính thức có 12 ngày phép có hưởng lương.',
        similarity: 0.91,
      };

      const chunkCandidate = adaptDocumentChunkToCandidate(chunk, 1);
      assert.equal(chunkCandidate.id, 'chunk_leave_01');
      assert.equal(chunkCandidate.title, 'Quy định nghỉ phép năm');
      assert.equal(chunkCandidate.initialScore, 0.91);
      assert.equal(chunkCandidate.initialRank, 1);
      assert.equal(chunkCandidate.metadata?.documentId, 'sop_leaves');
    });
  });

  // ==========================================================================
  // Level 10 Asynchronous Ingestion Pacing & Rate Regulation Suite
  // ==========================================================================
  describe('Level 10 Asynchronous Ingestion Pacing & Rate Regulation Suite', () => {

    // ------------------------------------------------------------------------
    // 1. AsyncIngestionQueue Unit Tests
    // ------------------------------------------------------------------------
    describe('1. AsyncIngestionQueue', () => {
      it('enqueues jobs with priority ordering and FIFO resolution for equal priorities', () => {
        const queue = new AsyncIngestionQueue<string>({ maxCapacity: 100 });

        // Enqueue in mixed priority order
        const r1 = queue.enqueue({ documentId: 'doc_low', content: 'Low priority doc', priority: 'low' });
        const r2 = queue.enqueue({ documentId: 'doc_crit', content: 'Critical security doc', priority: 'critical' });
        const r3 = queue.enqueue({ documentId: 'doc_norm_1', content: 'Normal doc 1', priority: 'normal' });
        const r4 = queue.enqueue({ documentId: 'doc_high', content: 'High priority doc', priority: 'high' });
        const r5 = queue.enqueue({ documentId: 'doc_norm_2', content: 'Normal doc 2', priority: 'normal' });

        assert.equal(r1.accepted, true);
        assert.equal(r2.accepted, true);
        assert.equal(queue.size(), 5);

        // Dequeue should follow priority descending: critical (3) -> high (2) -> normal (1) [FIFO] -> low (0)
        const j1 = queue.dequeue();
        assert.equal(j1?.documentId, 'doc_crit');
        assert.equal(j1?.status, 'processing');
        assert(typeof j1?.startedAt === 'number');

        const j2 = queue.dequeue();
        assert.equal(j2?.documentId, 'doc_high');

        const j3 = queue.dequeue();
        assert.equal(j3?.documentId, 'doc_norm_1');

        const j4 = queue.dequeue();
        assert.equal(j4?.documentId, 'doc_norm_2');

        const j5 = queue.dequeue();
        assert.equal(j5?.documentId, 'doc_low');

        assert.equal(queue.dequeue(), null);
        assert.equal(queue.isEmpty(), true);
      });

      it('prevents duplicate pending or processing jobs when dedupKey matches', () => {
        const queue = new AsyncIngestionQueue();

        const first = queue.enqueue({ documentId: 'sop_wms_v1', content: 'Initial version' });
        assert.equal(first.accepted, true);
        assert.equal(first.isDuplicate, false);
        assert.equal(queue.size(), 1);

        // Duplicate enqueue with same documentId while first is still queued
        const duplicate = queue.enqueue({ documentId: 'sop_wms_v1', content: 'Updated content' });
        assert.equal(duplicate.accepted, true);
        assert.equal(duplicate.isDuplicate, true);
        assert.equal(duplicate.jobId, first.jobId);
        assert.equal(queue.size(), 1); // Size unchanged!

        // Dequeue first job into processing state
        const job = queue.dequeue();
        assert.equal(job?.status, 'processing');

        // Attempting duplicate while processing should also deduplicate
        const dupWhileProcessing = queue.enqueue({ documentId: 'sop_wms_v1', content: 'Third try' });
        assert.equal(dupWhileProcessing.isDuplicate, true);

        // Complete job, which frees up dedupKey
        queue.markCompleted(first.jobId);
        assert.equal(job?.status, 'completed');

        // Now a new job with the same key is accepted as net-new
        const fresh = queue.enqueue({ documentId: 'sop_wms_v1', content: 'Fresh version' });
        assert.equal(fresh.accepted, true);
        assert.equal(fresh.isDuplicate, false);
        assert.notEqual(fresh.jobId, first.jobId);
      });

      it('calculates oldestJobAgeMs and tracks metrics accurately', async () => {
        const queue = new AsyncIngestionQueue();
        assert.equal(queue.getOldestJobAgeMs(), 0);

        queue.enqueue({ documentId: 'doc_old', content: 'Old doc' });
        await new Promise((r) => setTimeout(r, 15));

        const ageMs = queue.getOldestJobAgeMs();
        assert(ageMs >= 10, `Expected oldestJobAgeMs >= 10ms, got ${ageMs}ms`);

        const stats = queue.getStats();
        assert.equal(stats.queueDepth, 1);
        assert.equal(stats.enqueued, 1);
        assert.equal(stats.processed, 0);
        assert.equal(stats.failed, 0);

        const job = queue.dequeue();
        if (job) {
          queue.markCompleted(job.id);
        }

        const afterStats = queue.getStats();
        assert.equal(afterStats.queueDepth, 0);
        assert.equal(afterStats.processed, 1);
        assert.equal(afterStats.oldestJobAgeMs, 0);
      });

      it('handles requeue with retry count and marks failed after maxRetries', () => {
        const queue = new AsyncIngestionQueue({ defaultMaxRetries: 2 });
        queue.enqueue({ documentId: 'doc_flaky', content: 'Flaky doc', maxRetries: 2 });

        const job = queue.dequeue()!;
        assert.equal(job.retries, 0);

        // Retry 1
        queue.requeue(job);
        assert.equal(job.retries, 1);
        assert.equal(job.status, 'retrying');
        assert.equal(queue.size(), 1);

        // Retry 2
        const jobTry2 = queue.dequeue()!;
        queue.requeue(jobTry2);
        assert.equal(jobTry2.retries, 2);
        assert.equal(queue.size(), 1);

        // Retry 3 (exceeds maxRetries = 2)
        const jobTry3 = queue.dequeue()!;
        queue.requeue(jobTry3);
        assert.equal(jobTry3.retries, 3);
        assert.equal(jobTry3.status, 'failed');
        assert.equal(queue.size(), 0); // Not re-inserted into queue

        const stats = queue.getStats();
        assert.equal(stats.failed, 1);
      });

      it('enforces backpressure when maxCapacity is reached', () => {
        const queue = new AsyncIngestionQueue({ maxCapacity: 2 });
        const r1 = queue.enqueue({ documentId: 'd1', content: '1' });
        const r2 = queue.enqueue({ documentId: 'd2', content: '2' });
        const r3 = queue.enqueue({ documentId: 'd3', content: '3' });

        assert.equal(r1.accepted, true);
        assert.equal(r2.accepted, true);
        assert.equal(r3.accepted, false);
        assert(r3.reason?.includes('capacity exceeded'));
      });

      it('fires onDrain listener when queue becomes empty and supports unregistering', () => {
        const queue = new AsyncIngestionQueue();
        let drainCount = 0;

        const unsubscribe = queue.onDrain(() => {
          drainCount++;
        });

        queue.enqueue({ documentId: 'd1', content: 'c1' });
        const job = queue.dequeue()!;
        queue.markCompleted(job.id);

        assert.equal(drainCount, 1);

        // Unsubscribe and verify no more events
        unsubscribe();
        queue.enqueue({ documentId: 'd2', content: 'c2' });
        const job2 = queue.dequeue()!;
        queue.markCompleted(job2.id);

        assert.equal(drainCount, 1);
      });
    });

    // ------------------------------------------------------------------------
    // 2. IngestionPacer Unit Tests
    // ------------------------------------------------------------------------
    describe('2. IngestionPacer', () => {
      it('enforces token bucket rate limiting and allows acquiring tokens', async () => {
        const pacer = new IngestionPacer({
          maxRequestsPerSecond: 20,
          maxConcurrentRequests: 2,
        });

        const initialStats = pacer.getStats();
        assert(initialStats.tokensAvailable <= 20);
        assert.equal(initialStats.activeConcurrent, 0);

        // Acquire slot 1
        await pacer.acquire();
        assert.equal(pacer.getStats().activeConcurrent, 1);

        // Acquire slot 2
        await pacer.acquire();
        assert.equal(pacer.getStats().activeConcurrent, 2);

        // Release slots
        pacer.release();
        assert.equal(pacer.getStats().activeConcurrent, 1);
        pacer.release();
        assert.equal(pacer.getStats().activeConcurrent, 0);
      });

      it('triggers adaptive backoff on HTTP 429 and resets state on success', () => {
        const pacer = new IngestionPacer({
          maxRequestsPerSecond: 50,
          backoffInitialMs: 100,
          backoffMaxMs: 2000,
        });

        assert.equal(pacer.getStats().isInBackoff, false);

        // Handle 429
        const backoffMs = pacer.handleRateLimit(429);
        assert(backoffMs >= 100);
        const statsAfter429 = pacer.getStats();
        assert.equal(statsAfter429.consecutive429s, 1);
        assert.equal(statsAfter429.totalBackoffs, 1);
        assert.equal(statsAfter429.isInBackoff, true);
        assert.equal(statsAfter429.tokensAvailable, 0); // Token bucket drained!

        // Second consecutive 429 increases backoff
        pacer.handleRateLimit(429);
        assert.equal(pacer.getStats().consecutive429s, 2);
        assert.equal(pacer.getStats().totalBackoffs, 2);

        // Successful request resets consecutive backoffs
        pacer.handleSuccess();
        assert.equal(pacer.getStats().consecutive429s, 0);
      });

      it('validates decorrelated jitter and full jitter mathematical bounds', () => {
        // Decorrelated jitter: sleep between initialDelay and min(maxDelay, prev * 3)
        const prev = 300;
        const init = 100;
        const max = 5000;

        for (let i = 0; i < 20; i++) {
          const sleep = computeIngestionDecorrelatedJitterMs(prev, init, max);
          assert(sleep >= init, `Sleep ${sleep} must be >= init ${init}`);
          assert(sleep <= max, `Sleep ${sleep} must be <= max ${max}`);
          assert(sleep <= prev * 3, `Sleep ${sleep} must be <= prev * 3 (${prev * 3})`);
        }

        // Full jitter: sleep between 0 and min(max, base * 2^attempt)
        for (let attempt = 0; attempt < 5; attempt++) {
          const sleep = computeIngestionFullJitterMs(attempt, 50, 1000);
          assert(sleep >= 0);
          assert(sleep <= Math.min(1000, 50 * Math.pow(2, attempt)));
        }
      });

      it('executes async operation with proactive pacing, auto-retrying on 429', async () => {
        const pacer = new IngestionPacer({
          maxRequestsPerSecond: 100,
          backoffInitialMs: 10,
          backoffMaxMs: 50,
        });

        let callCount = 0;
        const result = await pacer.executeWithPacing(async () => {
          callCount++;
          if (callCount === 1) {
            const err: any = new Error('Rate limit exceeded');
            err.status = 429;
            throw err;
          }
          return 'ok_embeddings';
        });

        assert.equal(result, 'ok_embeddings');
        assert.equal(callCount, 2);
        assert.equal(pacer.getStats().totalBackoffs, 1);
        assert.equal(pacer.getStats().consecutive429s, 0); // Reset on success
      });

      it('executeWithPacing throws when retries exceed maxRetries', async () => {
        const pacer = new IngestionPacer({
          maxRequestsPerSecond: 100,
          backoffInitialMs: 5,
          backoffMaxMs: 20,
        });

        let attempts = 0;
        await assert.rejects(
          async () => {
            await pacer.executeWithPacing(
              async () => {
                attempts++;
                const err: any = new Error('Permanent rate limit failure');
                err.status = 429;
                throw err;
              },
              0,
              2 // maxRetries = 2
            );
          },
          /Permanent rate limit failure/
        );

        assert(attempts >= 3); // initial try + 2 retries
      });
    });

    // ------------------------------------------------------------------------
    // 3. MicroBatchChunker Unit Tests
    // ------------------------------------------------------------------------
    describe('3. MicroBatchChunker', () => {
      it('bundles raw chunks into micro-batches respecting maxBatchSize', () => {
        const chunker = new MicroBatchChunker({ maxBatchSize: 4, maxBatchTokens: 10000 });
        const rawChunks = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];

        const batches = chunker.batchChunks(rawChunks);
        assert.equal(batches.length, 3);
        assert.deepEqual(batches[0], ['c1', 'c2', 'c3', 'c4']);
        assert.deepEqual(batches[1], ['c5', 'c6', 'c7', 'c8']);
        assert.deepEqual(batches[2], ['c9']);
      });

      it('splits micro-batches when estimated token boundary is exceeded', () => {
        const chunker = new MicroBatchChunker({ maxBatchSize: 10, maxBatchTokens: 500 });
        // estimateTokenCount is ~ chars / 3.5. A 1200-char string is ~343 tokens.
        const longChunk1 = 'A'.repeat(1200); // ~343 tokens
        const longChunk2 = 'B'.repeat(1200); // ~343 tokens
        const longChunk3 = 'C'.repeat(1200); // ~343 tokens

        const batches = chunker.batchChunks([longChunk1, longChunk2, longChunk3]);
        // Even though maxBatchSize is 10, combining any two chunks exceeds 500 tokens!
        assert.equal(batches.length, 3);
        assert.deepEqual(batches[0], [longChunk1]);
        assert.deepEqual(batches[1], [longChunk2]);
        assert.deepEqual(batches[2], [longChunk3]);
      });

      it('bundles DocumentChunk objects preserving chunk metadata and token counts', () => {
        const chunker = new MicroBatchChunker({ maxBatchSize: 2 });
        const docChunks = [
          { id: 'c1', documentId: 'doc_1', chunkIndex: 0, content: 'Para 1', tokenCount: 10 },
          { id: 'c2', documentId: 'doc_1', chunkIndex: 1, content: 'Para 2', tokenCount: 12 },
          { id: 'c3', documentId: 'doc_1', chunkIndex: 2, content: 'Para 3', tokenCount: 15 },
        ];

        const batches = chunker.batchDocumentChunks(docChunks);
        assert.equal(batches.length, 2);
        assert.equal(batches[0].length, 2);
        assert.equal(batches[1].length, 1);
        assert.equal(batches[0][0].id, 'c1');
        assert.equal(batches[1][0].id, 'c3');
      });

      it('handles empty chunks array gracefully', () => {
        const chunker = new MicroBatchChunker();
        assert.deepEqual(chunker.batchChunks([]), []);
        assert.deepEqual(chunker.batchDocumentChunks([]), []);
      });
    });

    // ------------------------------------------------------------------------
    // 4. BatchVectorUpserter (buildPgvectorBatchInsertSql)
    // ------------------------------------------------------------------------
    describe('4. BatchVectorUpserter (buildPgvectorBatchInsertSql)', () => {
      it('generates multi-row parameterized SQL with standard vector cast', () => {
        const items: BatchUpsertItem[] = [
          { id: 'chunk_1', documentId: 'doc_1', content: 'Text 1', embedding: [0.1, 0.2, 0.3] },
          { id: 'chunk_2', documentId: 'doc_1', content: 'Text 2', embedding: [0.4, 0.5, 0.6] },
        ];

        const { query, params } = buildPgvectorBatchInsertSql(items, { tableName: 'DocumentChunk' });

        assert(query.includes('INSERT INTO "DocumentChunk"'));
        assert(query.includes('($1, $2, $3, $4::vector, NOW())'));
        assert(query.includes('($5, $6, $7, $8::vector, NOW())'));
        assert(query.includes('ON CONFLICT ("id") DO UPDATE SET'));

        assert.equal(params.length, 8);
        assert.equal(params[0], 'chunk_1');
        assert.equal(params[1], 'doc_1');
        assert.equal(params[2], 'Text 1');
        assert.equal(params[3], '[0.1,0.2,0.3]');
        assert.equal(params[4], 'chunk_2');
      });

      it('supports halfvec cast and custom database schema', () => {
        const items: BatchUpsertItem[] = [
          { id: 'chunk_h1', documentId: 'doc_h', content: 'Halfvec text', embedding: [0.9, 0.8] },
        ];

        const { query } = buildPgvectorBatchInsertSql(items, {
          tableName: 'KnowledgeChunk',
          schema: 'acme',
          useHalfvec: true,
        });

        assert(query.includes('"acme"."KnowledgeChunk"'));
        assert(query.includes('$4::halfvec'));
      });

      it('returns empty query and empty params when input items is empty', () => {
        const result = buildPgvectorBatchInsertSql([]);
        assert.equal(result.query, '');
        assert.deepEqual(result.params, []);
      });
    });

    // ------------------------------------------------------------------------
    // 5. IngestionWorker Unit Tests
    // ------------------------------------------------------------------------
    describe('5. IngestionWorker', () => {
      it('processes queued jobs, micro-batches chunks, calls embed and upsert callbacks', async () => {
        const queue = new AsyncIngestionQueue<string>();
        const embeddedBatches: string[][] = [];
        const upsertedItems: BatchUpsertItem[] = [];

        const worker = new IngestionWorker({
          queue,
          concurrency: 1, // Single Tier-S Worker
          pollIntervalMs: 5,
          chunkingOptions: { maxTokens: 100, overlapTokens: 10 },
          embedBatch: async (chunks: string[]) => {
            embeddedBatches.push(chunks);
            return chunks.map(() => [0.123, 0.456, 0.789]);
          },
          upsertBatch: async (items: BatchUpsertItem[]) => {
            upsertedItems.push(...items);
          },
        });

        // Enqueue 2 documents
        queue.enqueue({
          documentId: 'doc_sop_hr',
          title: 'Quy trình nhân sự',
          content: 'Chính sách nghỉ lễ và công tác phí cho nhân viên chính thức.',
        });

        queue.enqueue({
          documentId: 'doc_sop_wms',
          title: 'Quy trình kho bãi',
          content: 'Kiểm kê định kỳ vào ngày 25 hàng tháng. Báo cáo hàng hỏng ngay trong ngày.',
        });

        // Start worker and drain
        worker.start();
        const drained = await worker.drain(2000);
        assert.equal(drained, true);
        await worker.stop();

        // Verify processing
        const stats = worker.getStats();
        assert.equal(stats.totalJobsProcessed, 2);
        assert.equal(stats.totalJobsFailed, 0);
        assert(stats.totalChunksEmbedded >= 2);
        assert.equal(stats.isDrained, true);

        assert(embeddedBatches.length >= 1);
        assert(upsertedItems.length >= 2);
        assert.equal(upsertedItems[0].documentId, 'doc_sop_hr');
        assert.deepEqual(upsertedItems[0].embedding, [0.123, 0.456, 0.789]);
      });

      it('requeues on transient error and marks failed after maxRetries', async () => {
        const queue = new AsyncIngestionQueue({ defaultMaxRetries: 1 });
        const pacer = new IngestionPacer({ backoffInitialMs: 10, backoffMaxMs: 25 });
        let embedAttempts = 0;
        let jobErrors = 0;

        const worker = new IngestionWorker({
          queue,
          pacer,
          concurrency: 1,
          pollIntervalMs: 5,
          embedBatch: async () => {
            embedAttempts++;
            throw new Error('Upstream embedding service 503 unavailable');
          },
          upsertBatch: async () => {},
          onJobError: () => {
            jobErrors++;
          },
        });

        queue.enqueue({
          documentId: 'doc_failing',
          content: 'Content doomed to fail',
          maxRetries: 1,
        });

        worker.start();
        await worker.drain(2000);
        await worker.stop();

        const stats = worker.getStats();
        assert.equal(stats.totalJobsProcessed, 0);
        assert.equal(stats.totalJobsFailed, 1);
        assert.equal(jobErrors, 1);
        assert(embedAttempts >= 2); // Initial attempt + 1 retry
      });
    });

    // ------------------------------------------------------------------------
    // 6. GonnaCrash Level 10 3-Star SLA Simulation Verification
    // ------------------------------------------------------------------------
    describe('6. GonnaCrash Level 10 3-Star SLA Simulation Verification', () => {
      it('fails 3-Star SLA when ingestion is synchronous in App Server (no queue)', () => {
        const naive = simulateLevel10FreshDocsHourly({ hasQueue: false });

        // 1. Ingestion collapse: >600 requests dropped with HTTP 429
        assert.equal(naive.passedFreshDocsSla, false);
        assert.equal(naive.http429DropCount, 600); // 10 req/s overflow * 60s
        assert.equal(naive.freshDocsAnsweredPpm, 833333); // Only 83.3% < 99.9%
        assert.equal(naive.passedJobsCompletedSla, false);

        // 2. Realtime Q&A starved due to thread pool exhaustion
        assert.equal(naive.passedQaAnsweredSla, false);
        assert.equal(naive.qaAnsweredPpm, 780000); // 78% < 99%
        assert.equal(naive.passedQaFirstWordSla, false);
        assert.equal(naive.qaFirstWordSec, 4.8);   // 4.8s > 3.0s SLA
        assert.equal(naive.passedQaCorrectSla, false);
        assert.equal(naive.qaCorrectPpm, 506667); // 50.67% < 72%

        // 3. Overall failure
        assert.equal(naive.isThreeStarRecord, false);
        assert(naive.verdict.includes('FAILED'));
      });

      it('fails 3-Star SLA when queue exists but pacer is disabled (burst 429 drops)', () => {
        const unpaced = simulateLevel10FreshDocsHourly({ hasQueue: true, hasPacer: false, hasMicroBatching: false });

        assert.equal(unpaced.passedFreshDocsSla, false);
        assert(unpaced.http429DropCount > 0);
        assert.equal(unpaced.isThreeStarRecord, false);
        assert(unpaced.verdict.includes('FAILED'));
      });

      it('satisfies 100% GonnaCrash Level 10 3-Star SLA with Asynchronous Paced Pipeline', () => {
        const winning = simulateLevel10FreshDocsHourly({
          hasQueue: true,
          hasPacer: true,
          hasMicroBatching: true,
          hasStreaming: true,
          workerCount: 1, // 1 Tier-S Worker
        });

        // 1. Ingestion SLA: fresh docs answered >= 99.9%, jobs completed >= 99.9%
        assert.equal(winning.passedFreshDocsSla, true);
        assert.equal(winning.freshDocsAnsweredPpm, 1_000_000); // 100% fresh docs answered
        assert.equal(winning.passedJobsCompletedSla, true);
        assert.equal(winning.jobsCompletedPpm, 1_000_000);    // 100% jobs completed
        assert.equal(winning.http429DropCount, 0);            // 0% rate limit drops!

        // 2. Oldest job waiting SLA: <= 600s (10 minutes)
        assert.equal(winning.passedOldestJobSla, true);
        assert(winning.oldestJobWaitingSec <= 600);
        assert.equal(winning.oldestJobWaitingSec, 490);       // ~490s well within 10 min window

        // 3. Realtime Q&A stream SLA: answered >= 99%, TTFT <= 3.0s, correct >= 72%
        assert.equal(winning.passedQaAnsweredSla, true);
        assert.equal(winning.qaAnsweredPpm, 1_000_000);       // 100% Q&A answered
        assert.equal(winning.passedQaFirstWordSla, true);
        assert.equal(winning.qaFirstWordSec, 0.88);           // 880ms TTFT <= 3.0s
        assert.equal(winning.passedQaCorrectSla, true);
        assert.equal(winning.qaCorrectPpm, 760000);           // 76% correct >= 72%

        // 4. Budget & Best Cost SLA: <= 1.10¢/task, proving 0.9514¢/task record
        assert.equal(winning.passedCostSla, true);
        assert(winning.costPerTaskUc <= 1_100_000);
        assert.equal(winning.costPerTaskUc, 951361);          // Exactly 951,361 UC
        assert.equal(winning.costPerTaskCents, 0.9514);       // 0.9514¢/task
        assert.equal(winning.isThreeStarRecord, true);
        assert(winning.verdict.includes('PASSED'));
      });

      it('detects cost regression if workerCount is scaled to 2, failing exact 3-Star Best Cost record', () => {
        const scaled = simulateLevel10FreshDocsHourly({
          hasQueue: true,
          hasPacer: true,
          hasMicroBatching: true,
          hasStreaming: true,
          workerCount: 2, // 2 Tier-S Workers incurs +193 UC
        });

        assert.equal(scaled.costPerTaskUc, 951554); // 951,361 + 193 = 951,554 UC
        assert.equal(scaled.isThreeStarRecord, false); // Fails the strict best-cost record
      });
    });

    // ------------------------------------------------------------------------
    // 7. Commerce Ingestion Pipeline Integration Adapters
    // ------------------------------------------------------------------------
    describe('7. Commerce Ingestion Pipeline Integration Adapters', () => {
      it('adapts KnowledgeDocumentLike into IngestionJob with priority and metadata', () => {
        const sampleDoc = {
          id: 'doc_art_guide',
          title: 'Hướng dẫn bảo quản cọ màu nước lông chồn',
          content: 'Rửa sạch cọ bằng nước ấm và xà phòng chuyên dụng sau mỗi lần vẽ.',
          path: '/sop/art/brushes.md',
          tenantId: 'acme_vn',
          metadata: { author: 'Kido', version: '2.0' },
        };

        const job = adaptKnowledgeDocumentToIngestionJob(sampleDoc, 'high');
        assert.equal(job.documentId, 'doc_art_guide');
        assert.equal(job.title, 'Hướng dẫn bảo quản cọ màu nước lông chồn');
        assert.equal(job.priority, 2); // high = 2
        assert.equal(job.status, 'queued');
        assert.equal(job.metadata?.tenantId, 'acme_vn');
        assert.equal(job.metadata?.author, 'Kido');
        assert.equal(job.dedupKey, 'doc_art_guide');
      });

      it('creates and runs an end-to-end commerce async ingestion pipeline with mock DB executeRaw', async () => {
        const executedQueries: Array<{ query: string; params: unknown[] }> = [];

        const pipeline = createCommerceAsyncIngestionPipeline({
          maxRps: 50,
          batchSize: 16,
          concurrency: 1,
          embedContentBatch: async (chunks: string[]) => {
            return chunks.map(() => [0.01, 0.02, 0.03]);
          },
          prismaExecuteRaw: async (query: string, ...params: unknown[]) => {
            executedQueries.push({ query, params });
          },
        });

        // 1. Enqueue document (HTTP 202 response simulation)
        const response = pipeline.enqueueDocument(
          {
            id: 'sop_cash_handling',
            title: 'Quy định bàn giao quỹ tiền mặt cuối ngày',
            content: 'Cuối ca, thu ngân đối chiếu tiền trong két với báo cáo ca trên POS và ký biên bản bàn giao.',
          },
          'critical'
        );

        assert.equal(response.accepted, true);
        assert.equal(response.status, 'queued');
        assert(response.estimatedWaitMs >= 0);

        // 2. Start worker and drain
        pipeline.start();
        const drained = await pipeline.drain(2000);
        assert.equal(drained, true);
        await pipeline.stop();

        // 3. Verify PostgreSQL batch query was executed
        assert(executedQueries.length >= 1);
        const { query, params } = executedQueries[0];
        assert(query.includes('INSERT INTO "DocumentChunk"'));
        assert(query.includes('$4::halfvec'));
        assert.equal(params[1], 'sop_cash_handling');

        const stats = pipeline.getStats();
        assert.equal(stats.totalJobsProcessed, 1);
        assert.equal(stats.isDrained, true);
      });
    });
  });

  // ==========================================================================
  // Level 12 Context Sanitizer & Email Chain Truncation Suite
  // ==========================================================================
  describe('Level 12 Context Sanitizer & Email Chain Truncation Suite', () => {

    // ------------------------------------------------------------------------
    // 1. stripEmailReplyChain Tests
    // ------------------------------------------------------------------------
    describe('1. stripEmailReplyChain', () => {
      it('strips single-level and nested quote blocks (>) from email bodies', () => {
        const input = [
          'Chào bạn, đơn hàng màu nước của tôi bị vỡ hũ màu trắng khi nhận hàng.',
          'Tôi cần đổi sản phẩm mới hoặc hoàn tiền.',
          '> On Jan 10, 2026, Support Team wrote:',
          '> Quý khách vui lòng cung cấp video khui hàng.',
          '>> On Jan 09, 2026, Customer wrote:',
          '>> Đơn hàng của tôi đã được giao chưa?',
        ].join('\n');

        const cleaned = stripEmailReplyChain(input);
        assert(!cleaned.includes('Quý khách vui lòng cung cấp video khui hàng.'));
        assert(!cleaned.includes('Đơn hàng của tôi đã được giao chưa?'));
        assert(cleaned.includes('Chào bạn, đơn hàng màu nước của tôi bị vỡ hũ màu trắng khi nhận hàng.'));
        assert(cleaned.includes('Tôi cần đổi sản phẩm mới hoặc hoàn tiền.'));
      });

      it('strips Gmail / Apple Mail reply headers (On ... wrote:)', () => {
        const input = [
          'Please cancel my subscription and issue a full refund immediately.',
          '',
          'On Mon, Jan 15, 2024 at 10:30 AM, Support Agent <support@example.com> wrote:',
          'Hello, thank you for contacting us. How can we help you today?',
        ].join('\n');

        const cleaned = stripEmailReplyChain(input);
        assert.equal(cleaned, 'Please cancel my subscription and issue a full refund immediately.');
        assert(!cleaned.includes('On Mon, Jan 15'));
        assert(!cleaned.includes('support@example.com'));
      });

      it('strips standard Outlook / Exchange dividers and multi-line headers', () => {
        const input = [
          'Hệ thống POS tại chi nhánh Quận 1 không đồng bộ được tồn kho.',
          '',
          '-----Original Message-----',
          'From: Store Manager <manager.q1@acme-store.example.com>',
          'Sent: Monday, November 17, 2025 8:30 AM',
          'To: Tech Support <it@acme-store.example.com>',
          'Subject: Báo cáo tồn kho cuối ngày',
          '',
          'Tồn kho cọ vẽ lông chồn hiện tại ghi nhận 0 trên kệ.',
        ].join('\n');

        const cleaned = stripEmailReplyChain(input);
        assert.equal(cleaned, 'Hệ thống POS tại chi nhánh Quận 1 không đồng bộ được tồn kho.');
        assert(!cleaned.includes('Original Message'));
        assert(!cleaned.includes('Store Manager'));
        assert(!cleaned.includes('Tồn kho cọ vẽ lông chồn'));
      });

      it('strips Exchange 10+ underscore horizontal rule dividers', () => {
        const input = [
          'Vui lòng cập nhật chiết khấu 15% cho khách VIP.',
          '________________________________',
          'From: accounting@acme-store.example.com',
          'Tất cả chiết khấu cần phê duyệt của Giám đốc.',
        ].join('\n');

        const cleaned = stripEmailReplyChain(input);
        assert.equal(cleaned, 'Vui lòng cập nhật chiết khấu 15% cho khách VIP.');
        assert(!cleaned.includes('accounting@acme-store.example.com'));
      });

      it('strips Vietnamese email reply threads (Vào lúc ..., ... đã viết: / Ngày ... / Thư gốc)', () => {
        const input = [
          'Tôi muốn thay đổi địa chỉ giao hàng sang 123 Nguyễn Huệ, Quận 1.',
          '',
          'Vào lúc 09:15 Th 4, 12 thg 11, 2025, Nguyen Van A <a@example.com> đã viết:',
          'Cảm ơn bạn đã đặt hàng giấy vẽ Arches 300gsm.',
          '',
          'Ngày 10/11/2025 14:00, CSKH Acme đã viết:',
          'Đơn hàng đang được chuẩn bị tại kho.',
        ].join('\n');

        const cleaned = stripEmailReplyChain(input);
        assert.equal(cleaned, 'Tôi muốn thay đổi địa chỉ giao hàng sang 123 Nguyễn Huệ, Quận 1.');
        assert(!cleaned.includes('Nguyen Van A'));
        assert(!cleaned.includes('CSKH Acme'));
        assert(!cleaned.includes('giấy vẽ Arches'));
      });

      it('strips multilingual headers (French, German, Spanish)', () => {
        const french = [
          'Pouvez-vous confirmer ma commande ?',
          'Le 10 nov. 2025 à 09:30, Jean-Luc Dupont a écrit :',
          'Merci pour votre commande.',
        ].join('\n');
        assert.equal(stripEmailReplyChain(french), 'Pouvez-vous confirmer ma commande ?');

        const german = [
          'Ich möchte meine Bestellung stornieren.',
          'Am 15.01.2025 schrieb Max Mustermann:',
          'Ihre Bestellung ist eingegangen.',
        ].join('\n');
        assert.equal(stripEmailReplyChain(german), 'Ich möchte meine Bestellung stornieren.');

        const spanish = [
          'Por favor cambien mi dirección de entrega.',
          'El 15 de enero de 2025, Carlos escribió:',
          'Su pedido ha sido enviado.',
        ].join('\n');
        assert.equal(stripEmailReplyChain(spanish), 'Por favor cambien mi dirección de entrega.');
      });

      it('strips forwarded message indicators (-----Forwarded message----- / Begin forwarded message:)', () => {
        const input = [
          'Chuyển tiếp báo cáo lỗi thanh toán qua cổng ZaloPay.',
          '',
          '---------- Forwarded message ---------',
          'From: khachhang@gmail.com',
          'Subject: Lỗi quét mã QR',
          'Không thể quét mã QR trên màn hình checkout.',
        ].join('\n');

        const cleaned = stripEmailReplyChain(input);
        assert.equal(cleaned, 'Chuyển tiếp báo cáo lỗi thanh toán qua cổng ZaloPay.');
        assert(!cleaned.includes('khachhang@gmail.com'));
      });

      it('does not trigger false positives on mid-sentence words', () => {
        const text = 'On Monday we will release version 2.0 with enhanced streaming capabilities.';
        assert.equal(stripEmailReplyChain(text), text);

        const vnText = 'Vào lúc này chúng tôi chưa có nhu cầu mua thêm tài khoản.';
        assert.equal(stripEmailReplyChain(vnText), vnText);
      });
    });

    // ------------------------------------------------------------------------
    // 2. stripLegalDisclaimers Tests
    // ------------------------------------------------------------------------
    describe('2. stripLegalDisclaimers', () => {
      it('strips standard English corporate confidentiality notices', () => {
        const input = [
          'The customer has requested an expedited replacement brush.',
          '',
          'This email and any attachments are confidential and intended solely for the use of the individual or entity to whom they are addressed. If you have received this message in error, please notify the sender immediately and delete it from your system.',
        ].join('\n');

        const cleaned = stripLegalDisclaimers(input);
        assert.equal(cleaned, 'The customer has requested an expedited replacement brush.');
        assert(!cleaned.includes('confidential and intended solely'));
      });

      it('strips Privileged/Confidential Information boilerplate and unintended recipient warnings', () => {
        const input = [
          'Please process refund for order #LIM-9921.',
          '',
          'Privileged/Confidential Information may be contained in this message. If you are not the intended recipient you must not use, disclose, copy or distribute this message or its attachments.',
        ].join('\n');

        const cleaned = stripLegalDisclaimers(input);
        assert.equal(cleaned, 'Please process refund for order #LIM-9921.');
        assert(!cleaned.includes('Privileged/Confidential Information'));
      });

      it('strips Vietnamese corporate confidentiality notices and statutory warnings', () => {
        const input = [
          'Biên bản đối soát ca làm việc ngày 17/11 đã được gửi.',
          '',
          'Email này và các tệp đính kèm là bảo mật và chỉ phục vụ cho người nhận được nêu tên. Nếu bạn không phải là người nhận được chỉ định, vui lòng xóa thư này và thông báo ngay cho người gửi.',
        ].join('\n');

        const cleaned = stripLegalDisclaimers(input);
        assert.equal(cleaned, 'Biên bản đối soát ca làm việc ngày 17/11 đã được gửi.');
        assert(!cleaned.includes('Email này và các tệp đính kèm là bảo mật'));
      });

      it('strips environmental printing reminders and anti-virus security scanner notices', () => {
        const input = [
          'Cần kiểm tra lại hạn mức tồn kho giấy màu nước Fabriano.',
          'Please consider the environment before printing this e-mail.',
          'This email has been scanned for viruses by Proofpoint Security Gateway.',
          'Scanned by ClamAV Antivirus Suite.',
        ].join('\n');

        const cleaned = stripLegalDisclaimers(input);
        assert.equal(cleaned, 'Cần kiểm tra lại hạn mức tồn kho giấy màu nước Fabriano.');
        assert(!cleaned.includes('environment before printing'));
        assert(!cleaned.includes('Proofpoint'));
        assert(!cleaned.includes('ClamAV'));
      });

      it('strips marketing unsubscribe links and mailing list footers', () => {
        const input = [
          'New seasonal promo guidelines are now active.',
          'If you no longer wish to receive these emails, click here to unsubscribe.',
          'Unsubscribe: https://newsletter.acme-store.example.com/opt-out?id=88312',
        ].join('\n');

        const cleaned = stripLegalDisclaimers(input, { stripUnsubscribe: true });
        assert.equal(cleaned, 'New seasonal promo guidelines are now active.');
        assert(!cleaned.includes('unsubscribe'));
        assert(!cleaned.includes('opt-out'));
      });

      it('preserves valid sentences containing the word confidential in business context', () => {
        const input = 'We must ensure that all customer payment data is treated as confidential in our SOC2 audit.';
        const cleaned = stripLegalDisclaimers(input);
        assert.equal(cleaned, input);
      });
    });

    // ------------------------------------------------------------------------
    // 3. stripSignatureBlocks Tests
    // ------------------------------------------------------------------------
    describe('3. stripSignatureBlocks', () => {
      it('strips RFC 3676 standard signature delimiters (-- \\n)', () => {
        const input = [
          'Khách báo lỗi cổng thanh toán thẻ quốc tế không nhận thẻ JCB.',
          '--',
          'Nguyễn Văn A',
          'Lead Support Specialist',
          'Acme Commerce Vietnam',
        ].join('\n');

        const cleaned = stripSignatureBlocks(input);
        assert.equal(cleaned, 'Khách báo lỗi cổng thanh toán thẻ quốc tế không nhận thẻ JCB.');
        assert(!cleaned.includes('Nguyễn Văn A'));
        assert(!cleaned.includes('Lead Support Specialist'));
      });

      it('strips mobile device tags (Sent from my iPhone / Android / Gửi từ iPhone)', () => {
        const input = [
          'Tôi đã nhận được hàng nhưng thiếu tuýp màu xanh cobalt.',
          'Sent from my iPhone',
        ].join('\n');

        assert.equal(stripSignatureBlocks(input), 'Tôi đã nhận được hàng nhưng thiếu tuýp màu xanh cobalt.');

        const vnInput = [
          'Tôi đang đợi phản hồi về đơn hàng #12345.',
          'Gửi từ iPhone của tôi',
        ].join('\n');

        assert.equal(stripSignatureBlocks(vnInput), 'Tôi đang đợi phản hồi về đơn hàng #12345.');

        const androidInput = [
          'Đã kiểm tra lại trên ứng dụng di động.',
          'Sent from my Galaxy device',
        ].join('\n');

        assert.equal(stripSignatureBlocks(androidInput), 'Đã kiểm tra lại trên ứng dụng di động.');
      });

      it('strips multi-line closing salutations (Best regards, Sincerely, Trân trọng)', () => {
        const inputEn = [
          'Please find attached the quarterly inventory valuation report.',
          '',
          'Best regards,',
          'John Doe',
          'Head of Operations',
          'Phone: +1 555-0199',
        ].join('\n');

        const cleanedEn = stripSignatureBlocks(inputEn);
        assert.equal(cleanedEn, 'Please find attached the quarterly inventory valuation report.');
        assert(!cleanedEn.includes('Best regards'));
        assert(!cleanedEn.includes('John Doe'));

        const inputVn = [
          'Hôm nay cửa hàng cần nhập thêm 50 tập giấy vẽ chì A4.',
          '',
          'Trân trọng,',
          'Trần Thị B',
          'Cửa hàng trưởng Acme HCM',
          'SĐT: 0909123456',
        ].join('\n');

        const cleanedVn = stripSignatureBlocks(inputVn);
        assert.equal(cleanedVn, 'Hôm nay cửa hàng cần nhập thêm 50 tập giấy vẽ chì A4.');
        assert(!cleanedVn.includes('Trân trọng'));
        assert(!cleanedVn.includes('Trần Thị B'));
      });

      it('strips trailing contact info blocks (Phone, Email, Hotline, Website)', () => {
        const input = [
          'Nhờ IT reset mật khẩu tài khoản thu ngân ca sáng.',
          'Phone: 0987654321',
          'Email: support@acme-store.example.com',
          'Website: https://acme-store.example.com',
        ].join('\n');

        const cleaned = stripSignatureBlocks(input);
        assert.equal(cleaned, 'Nhờ IT reset mật khẩu tài khoản thu ngân ca sáng.');
        assert(!cleaned.includes('0987654321'));
      });

      it('does not strip mid-sentence uses of closing salutations', () => {
        const text = 'Chúng tôi luôn trân trọng sự đồng hành của quý khách hàng trong suốt năm qua.';
        assert.equal(stripSignatureBlocks(text), text);
      });
    });

    // ------------------------------------------------------------------------
    // 4. slidingWindowContext Tests
    // ------------------------------------------------------------------------
    describe('4. slidingWindowContext', () => {
      it('returns original text when token count is within maxTokens budget', () => {
        const text = 'Một đoạn văn bản ngắn không vượt quá ngân sách token.';
        assert.equal(slidingWindowContext(text, 1000), text);
      });

      it('bounds text to tail window keeping recent context', () => {
        const paragraphs = [
          'Đoạn văn 1: Lịch sử trao đổi từ tuần trước về chính sách giá sỉ.',
          'Đoạn văn 2: Báo cáo kiểm kê kho từ tháng trước về màu nước.',
          'Đoạn văn 3: Yêu cầu mới nhất hôm nay: Khách hàng yêu cầu xuất hóa đơn VAT gấp cho đơn hàng #889.',
        ].join('\n\n');

        const bounded = slidingWindowContext(paragraphs, 30, { strategy: 'tail' });
        assert(bounded.includes('Yêu cầu mới nhất hôm nay'));
        assert(!bounded.includes('Lịch sử trao đổi từ tuần trước'));
      });

      it('bounds text to head window when requested', () => {
        const paragraphs = [
          'Đoạn văn 1: Quy định cốt lõi về chính sách bảo hành sản phẩm nghệ thuật.',
          'Đoạn văn 2: Chi tiết các điều khoản bổ sung năm 2024.',
          'Đoạn văn 3: Chi tiết các điều khoản bổ sung năm 2025.',
        ].join('\n\n');

        const bounded = slidingWindowContext(paragraphs, 25, { strategy: 'head' });
        assert(bounded.includes('Quy định cốt lõi'));
        assert(!bounded.includes('năm 2025'));
      });

      it('bounds text with head-tail strategy showing truncation note', () => {
        const paragraphs = [
          'Đầu: Tóm tắt yêu cầu chính của khách hàng.',
          'Giữa 1: Dữ liệu trao đổi trung gian dài dòng...',
          'Giữa 2: Thêm dữ liệu thảo luận kỹ thuật không liên quan...',
          'Cuối: Quyết định chốt đơn cuối cùng của quản lý.',
        ].join('\n\n');

        const bounded = slidingWindowContext(paragraphs, 25, { strategy: 'head-tail' });
        assert(bounded.includes('Đầu: Tóm tắt'));
        assert(bounded.includes('Cuối: Quyết định'));
        assert(bounded.includes('[... content truncated for context budget ...]'));
      });
    });

    // ------------------------------------------------------------------------
    // 5. ContextBuilder Pipeline & Token Reduction Tests
    // ------------------------------------------------------------------------
    describe('5. ContextBuilder & sanitizeContext Pipeline', () => {
      it('orchestrates end-to-end sanitization with high token reduction (>80% on 12k bloated ticket)', () => {
        // Construct a bloated support ticket simulating GonnaCrash Level 12 (12,000 tokens)
        const coreTicket = [
          'CẦN HỖ TRỢ GẤP: Khách hàng VIP phản ánh đơn hàng #LIM-7788 bị thiếu 3 tuýp màu nước Holbein Artists và 1 cọ tỉa bản số 0.',
          'Khách hàng cần giao bù trong chiều nay trước 17:00 tại cơ sở Thảo Điền, TP. Thủ Đức.',
        ].join('\n');

        // Multi-layered nested quotes and email reply history
        const quotedHistory = Array.from({ length: 40 }, (_, i) => [
          `> On Jan ${10 + (i % 20)}, 2026, Internal Sales wrote:`,
          `> Follow-up thread note #${i}: The customer previously inquired about bulk discount for Holbein watercolor sets.`,
          `> Checking warehouse availability across Hanoi and HCM distribution centers.`,
          `>> On Jan ${5 + (i % 15)}, 2026, Warehouse Operations wrote:`,
          `>> Stock level verified for item SKU-HB-${1000 + i}. Current count is 14 units.`,
          `>> Please confirm purchase order with supplier before dispatching.`,
        ].join('\n')).join('\n\n');

        // Corporate legal disclaimers
        const legalDisclaimer = [
          'This email and any attachments are confidential and intended solely for the use of the individual or entity to whom they are addressed.',
          'If you have received this message in error, please notify the sender immediately and delete it from your system.',
          'Privileged/Confidential Information may be contained in this message. Any unauthorized review, use, disclosure or distribution is strictly prohibited.',
          'Email này và các tệp đính kèm là bảo mật và chỉ dành cho người nhận được chỉ định.',
          'Please consider the environment before printing this e-mail.',
          'This email has been scanned for viruses by Proofpoint Security Gateway.',
          'If you no longer wish to receive these emails, click here to unsubscribe.',
          'Unsubscribe: https://mail.acme-store.example.com/opt-out',
        ].join('\n\n');

        // Multi-line signature
        const signature = [
          '--',
          'Trân trọng,',
          'Nguyễn Văn Trưởng Phòng',
          'Giám đốc Kinh doanh Vùng Nam Bộ | Acme Corporation',
          'Hotline: 1900 6868 | SĐT: 0909 888 999',
          'Email: truongphong.sales@acme-store.example.com | Website: https://acme-store.example.com',
          'Địa chỉ: 45 Lê Duẩn, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
          'Sent from my iPhone',
        ].join('\n');

        const bloatedTicket = [
          coreTicket,
          '',
          'On Mon, Nov 17, 2025 at 8:00 AM, Sales Staff wrote:',
          quotedHistory,
          '',
          legalDisclaimer,
          '',
          signature,
        ].join('\n');

        const result = sanitizeContext(bloatedTicket, {
          maxTokens: 1000,
        });

        assert(result.originalTokens > 1000, `Expected original tokens > 1000, got ${result.originalTokens}`);
        assert(result.sanitizedTokens < result.originalTokens);
        // Requirement: >80% token reduction
        assert(
          result.reductionRatio >= 0.80,
          `Expected reductionRatio >= 0.80, got ${result.reductionRatio} (${result.originalTokens} -> ${result.sanitizedTokens})`
        );

        // Core business message MUST be preserved
        assert(result.cleanText.includes('CẦN HỖ TRỢ GẤP'));
        assert(result.cleanText.includes('Khách hàng VIP phản ánh đơn hàng #LIM-7788'));
        assert(result.cleanText.includes('giao bù trong chiều nay trước 17:00'));

        // All junk MUST be stripped
        assert(!result.cleanText.includes('Proofpoint'));
        assert(!result.cleanText.includes('Sent from my iPhone'));
        assert(!result.cleanText.includes('Stock level verified'));
        assert(!result.cleanText.includes('truongphong.sales@acme-store.example.com'));

        // Verify summary segment flags
        assert.equal(result.segmentsSummary.quotedHistory, true);
        assert.equal(result.segmentsSummary.signature, true);
        assert.equal(result.segmentsSummary.legalDisclaimer, true);

        // Execution time should be fast (< 50ms)
        assert(result.durationMs >= 0);
        assert(result.durationMs < 50, `Expected durationMs < 50, got ${result.durationMs}`);
      });

      it('handles empty and whitespace-only inputs gracefully', () => {
        const emptyResult = sanitizeContext('');
        assert.equal(emptyResult.cleanText, '');
        assert.equal(emptyResult.originalTokens, 0);
        assert.equal(emptyResult.sanitizedTokens, 0);
        assert.equal(emptyResult.reductionRatio, 0);

        const wsResult = sanitizeContext('   \n\n\t  ');
        assert.equal(wsResult.cleanText, '');
      });

      it('leaves clean text without junk segments unchanged', () => {
        const cleanMessage = 'Xin chào, vui lòng cho hỏi cửa hàng có bán màu nước Daniel Smith dạng tuýp 15ml không?';
        const result = sanitizeContext(cleanMessage);
        assert.equal(result.cleanText, cleanMessage);
        assert.equal(result.reductionRatio, 0);
        assert.equal(result.segmentsSummary.quotedHistory, false);
        assert.equal(result.segmentsSummary.signature, false);
        assert.equal(result.segmentsSummary.legalDisclaimer, false);
      });
    });

    // ------------------------------------------------------------------------
    // 6. GonnaCrash Level 12 3-Star SLA Simulation Verification
    // ------------------------------------------------------------------------
    describe('6. GonnaCrash Level 12 3-Star SLA Simulation Verification', () => {
      it('fails 3-Star SLA when ContextBuilder is absent (Context Rot collapses accuracy and blows budget)', () => {
        const baseline = simulateLevel12BloatedTickets({
          hasContextBuilder: false,
          totalTicks: 240,
          arrivalRateRps: 3,
        });

        assert.equal(baseline.totalTickets, 720);
        assert.equal(baseline.bloatedTickets, 540); // 180s * 3 rps = 540 bloated tickets
        assert.equal(baseline.contextRotPrevented, false);

        // Accuracy collapses below 95% SLA target due to noise
        assert(
          baseline.accuracyRate < 0.95,
          `Expected accuracyRate < 0.95 without ContextBuilder, got ${baseline.accuracyRate}`
        );
        assert.equal(baseline.passedAccuracySla, false);

        // Fallback rate to expensive LLM surges
        assert(
          baseline.fallbackRate > 0.50,
          `Expected high fallback rate (>0.50), got ${baseline.fallbackRate}`
        );

        // Cost per task surges to >0.60¢, exceeding the 0.13¢ budget
        assert(
          baseline.costPerTaskUc > 130000,
          `Expected costPerTaskUc > 130000, got ${baseline.costPerTaskUc}`
        );
        assert.equal(baseline.passedCostSla, false);
        assert.equal(baseline.isThreeStarRecord, false);
        assert(baseline.verdict.includes('FAILED'));
      });

      it('satisfies 100% GonnaCrash Level 12 3-Star SLA with ContextBuilder', () => {
        const optimal = simulateLevel12BloatedTickets({
          hasContextBuilder: true,
          totalTicks: 240,
          arrivalRateRps: 3,
        });

        // 1. Total Tickets: 240s * 3 req/s = 720 tickets
        assert.equal(optimal.totalTickets, 720);
        assert.equal(optimal.bloatedTickets, 540);
        assert.equal(optimal.contextRotPrevented, true);

        // 2. Ticket Answered SLA: >= 99% (990,000 ppm)
        assert.equal(optimal.passedAnsweredSla, true);
        assert(optimal.answeredPpm >= 990000);

        // 3. Response Time SLA: <= 2.0s
        assert.equal(optimal.passedResponseTimeSla, true);
        assert(
          optimal.averageResponseTimeSec <= 2.0,
          `Expected averageResponseTimeSec <= 2.0s, got ${optimal.averageResponseTimeSec}s`
        );

        // 4. Classification Accuracy SLA: >= 95% (950,000 ppm)
        assert.equal(optimal.passedAccuracySla, true);
        assert(
          optimal.accuracyRate >= 0.95,
          `Expected accuracyRate >= 0.95, got ${optimal.accuracyRate}`
        );
        assert(optimal.accuracyPpm >= 950000);

        // 5. Cost SLA: <= 0.13¢ (130,000 UC)
        assert.equal(optimal.passedCostSla, true);
        assert(
          optimal.costPerTaskUc <= 130000,
          `Expected costPerTaskUc <= 130000, got ${optimal.costPerTaskUc}`
        );

        // 6. Proving exact Global 3-Star Best Cost Record: 0.1086¢ / 108,592 UC
        assert.equal(optimal.costPerTaskUc, 108592);
        assert.equal(optimal.costPerTaskCents, 0.1086);

        // 7. Token Reduction Ratio on bloated tickets: > 80% (12k -> 800 tokens = ~93.3%)
        assert(
          optimal.tokenReductionRatio >= 0.80,
          `Expected tokenReductionRatio >= 0.80, got ${optimal.tokenReductionRatio}`
        );

        // 8. 3-Star Record Flag & Verdict
        assert.equal(optimal.isThreeStarRecord, true);
        assert.equal(optimal.verdict, 'PASSED (★★★ 3-Star Record)');
      });
    });

    // ------------------------------------------------------------------------
    // 7. Support Ticket Domain Adapter Tests
    // ------------------------------------------------------------------------
    describe('7. Support Ticket Domain Adapter (sanitizeSupportTicket)', () => {
      it('adapts incoming customer ticket stripping email quotes and signatures', () => {
        const rawTicket: SupportTicketLike = {
          id: 'ticket_supp_4421',
          subject: 'Hỏi về đơn hàng giao chậm',
          customerEmail: 'khachhang.vip@gmail.com',
          metadata: { channel: 'email', priority: 'high', storeId: 'hcm_d1' },
          body: [
            'Cho mình hỏi đơn hàng số #88219 đặt từ hôm thứ Hai sao giờ chưa nhận được?',
            '',
            'Vào lúc 14:00 Th 2, 10 thg 11, 2025, CSKH Acme <cskh@acme-store.example.com> đã viết:',
            'Đơn hàng của quý khách đã được đóng gói và giao cho đơn vị vận chuyển.',
            '',
            'This email and any attachments are confidential.',
            '--',
            'Trân trọng,',
            'Nguyễn Văn C',
            'Sent from my iPhone',
          ].join('\n'),
        };

        const sanitized = sanitizeSupportTicket(rawTicket);

        assert.equal(sanitized.id, 'ticket_supp_4421');
        assert.equal(sanitized.subject, 'Hỏi về đơn hàng giao chậm');
        assert.equal(sanitized.customerEmail, 'khachhang.vip@gmail.com');
        assert.equal(sanitized.metadata?.storeId, 'hcm_d1');

        assert.equal(
          sanitized.cleanBody,
          'Cho mình hỏi đơn hàng số #88219 đặt từ hôm thứ Hai sao giờ chưa nhận được?'
        );
        assert(!sanitized.cleanBody.includes('CSKH Acme'));
        assert(!sanitized.cleanBody.includes('confidential'));
        assert(!sanitized.cleanBody.includes('Sent from my iPhone'));

        assert(sanitized.originalTokens > sanitized.sanitizedTokens);
        assert(sanitized.reductionRatio > 0.5);
        assert(sanitized.strippedSegments.includes('email_reply_chain'));
      });
    });
  });
});
