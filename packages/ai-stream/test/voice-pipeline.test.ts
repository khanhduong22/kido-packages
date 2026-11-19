/**
 * @kido/ai-stream - Level 25 Full-Duplex Voice Pipeline Test Suite
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VoiceSentenceChunker,
  createVoiceSentenceChunker,
  sanitizeForSpeech,
  VoiceTurnController,
  createVoiceTurnController,
  VoiceLatencyBudgetTracker,
  createVoiceLatencyBudgetTracker,
  isVoiceBargeInError,
  runVoiceStreamPipeline,
  simulateLevel25VoiceAssistantLatency,
  LEVEL25_COST_COMPONENTS_UC,
  LEVEL25_SLA_TARGETS,
  type SttTranscriptEvent,
  type VoicePipelineEvent,
  type VoiceSentenceChunk,
} from '../src/voice-pipeline/index.js';
import * as rootPackage from '../src/index.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Level 25 Full-Duplex Voice Pipeline (`voice-pipeline`)', () => {
  describe('1. Bilingual VI/EN VoiceSentenceChunker & sanitizeForSpeech', () => {
    it('prevents false splits on abbreviations, decimals, VND currency, URLs & numbered lists', () => {
      const chunker = createVoiceSentenceChunker({ minChunkChars: 12, firstClauseCommaFlush: false });
      const tokens = [
        'Dr. Nguyen và Mr. Smith ở TP. Hồ Chí Minh ',
        'đặt gói trị giá 150.000đ với độ trễ 1.',
        '2s (v.v. và e.g. hỗ trợ 1,200 ms). ',
        'Xem https://docs.example.com/v1.2/voice để cấu hình. ',
        '1. Bật streaming STT và LLM. ',
        '2. Bật streaming TTS ngay lập tức!',
      ];

      const emitted = tokens.flatMap((t) => chunker.push(t)).concat(chunker.flush());
      assert.equal(emitted.length, 4);
      assert.ok(emitted[0]!.text.includes('Dr. Nguyen') && emitted[0]!.text.includes('Mr. Smith'));
      assert.ok(emitted[0]!.text.includes('TP. Hồ Chí Minh') && emitted[0]!.text.includes('150.000đ'));
      assert.ok(emitted[0]!.text.includes('1.2s') && emitted[0]!.text.includes('v.v.') && emitted[0]!.text.includes('e.g.'));
      assert.equal(emitted[0]!.isFirstClause, true);
      assert.ok(emitted[1]!.text.includes('https://docs.example.com/v1.2/voice'));
      assert.equal(emitted[1]!.speakableText, 'Xem để cấu hình.');
      assert.equal(emitted[2]!.text, '1. Bật streaming STT và LLM.');
      assert.equal(emitted[3]!.text, '2. Bật streaming TTS ngay lập tức!');
      assert.equal(emitted[3]!.isFinal, true);
    });

    it('flushes only the first clause early on comma/em-dash and respects maxBufferChars', () => {
      const chunker = new VoiceSentenceChunker({
        minChunkChars: 16,
        firstClauseCommaFlush: true,
        firstClauseMinChars: 16,
        maxBufferChars: 65,
      });

      const c1 = chunker.push('Xin chào quý khách hàng, chúng tôi đang kiểm tra, và sẽ báo ngay. ');
      assert.equal(c1.length, 2);
      assert.equal(c1[0]!.reason, 'first_clause_comma');
      assert.equal(c1[0]!.text, 'Xin chào quý khách hàng,');
      assert.equal(c1[0]!.isFirstClause, true);
      assert.equal(c1[1]!.reason, 'sentence_boundary');
      assert.equal(c1[1]!.text, 'chúng tôi đang kiểm tra, và sẽ báo ngay.');
      assert.equal(c1[1]!.isFirstClause, false);

      chunker.reset();
      const dash = chunker.push('Hệ thống CommerceVoiceBot đã sẵn sàng — vui lòng nói câu hỏi.');
      assert.equal(dash.length, 1);
      assert.equal(dash[0]!.reason, 'first_clause_comma');
      assert.equal(dash[0]!.text, 'Hệ thống CommerceVoiceBot đã sẵn sàng —');

      chunker.reset();
      const runOn = chunker.push(
        'đây là một câu rất dài không hề có dấu chấm hay dấu phẩy nào để kiểm tra bộ đệm tối đa của bộ cắt câu'
      );
      assert.ok(runOn.length >= 1);
      assert.equal(runOn[0]!.reason, 'max_buffer');
      assert.ok(runOn[0]!.text.length <= 65);
    });

    it('sanitizes markdown syntax for natural TTS speech while keeping snake_case & Vietnamese', () => {
      const md = [
        '### **BankingVoiceAssistant** Thông Báo',
        '- Gói `openai_small` giá **150.000đ** (_tiết kiệm 95%_)',
        '- Xem [bảng giá](https://example.com/pricing) hoặc https://example.com/raw.',
        '```ts\nconst secret = { stream: true };\n```',
      ].join('\n');

      const spoken = sanitizeForSpeech(md);
      assert.ok(!spoken.includes('###') && !spoken.includes('**') && !spoken.includes('```') && !spoken.includes('https://'));
      assert.ok(spoken.includes('BankingVoiceAssistant Thông Báo'));
      assert.ok(spoken.includes('openai_small') && spoken.includes('150.000đ'));
      assert.ok(spoken.includes('(tiết kiệm 95%)') && spoken.includes('Xem bảng giá hoặc.'));
    });
  });

  describe('2. VoiceTurnController & VoiceLatencyBudgetTracker', () => {
    it('runs full-duplex STT endpointing, state transitions, and AbortController barge-in', () => {
      let clockMs = 1_000;
      const transitions: string[] = [];
      let bargeInEvents = 0;

      const controller = createVoiceTurnController({
        now: () => clockMs,
        endpointSilenceMs: 350,
        onStateChange: (e) => transitions.push(`${e.from}->${e.to}`),
        onBargeIn: () => {
          bargeInEvents += 1;
        },
      });

      assert.equal(controller.getState(), 'idle');
      controller.startListening();
      assert.equal(controller.ingestSttEvent({ text: 'Kiểm tra', isFinal: false, timestampMs: 1_050 }).committed, false);
      assert.equal(
        controller.ingestSttEvent({ text: 'Kiểm tra đơn hàng', isFinal: true, speechFinal: false, timestampMs: 1_120 }).committed,
        false
      );

      const committed = controller.ingestSttEvent({
        text: 'mã 8842',
        isFinal: true,
        speechFinal: true,
        timestampMs: 1_220,
      });
      assert.equal(committed.committed, true);
      assert.equal(committed.transcript, 'Kiểm tra đơn hàng mã 8842');
      assert.equal(committed.turnId, 1);
      assert.ok(committed.signal && !committed.signal.aborted);
      assert.equal(controller.beginSpeaking(), true);
      assert.equal(controller.getState(), 'speaking');

      const interrupt = controller.ingestSttEvent({
        text: 'Khoan đã, đổi địa chỉ',
        isFinal: false,
        vadSpeechDetected: true,
        timestampMs: 1_600,
      });
      assert.equal(interrupt.bargedIn, true);
      assert.equal(committed.signal.aborted, true);
      assert.equal(isVoiceBargeInError(committed.signal.reason), true);
      assert.equal(bargeInEvents, 1);
      assert.equal(controller.getState(), 'listening');

      clockMs = 1_960;
      const endpointed = controller.checkEndpointing();
      assert.equal(endpointed.committed, true);
      assert.equal(endpointed.turnId, 2);
      assert.equal(endpointed.transcript, 'Khoan đã, đổi địa chỉ');

      controller.completeTurn();
      assert.equal(controller.getState(), 'idle');
      assert.equal(controller.getSnapshot().completedTurns, 1);
      assert.equal(controller.getSnapshot().bargeInCount, 1);
      assert.ok(transitions.includes('speaking->interrupted'));
    });

    it('tracks per-stage latency budget, bottleneck attribution, and Level 25 reason codes', () => {
      let t = 10_000;
      const tracker = createVoiceLatencyBudgetTracker({ budgetMs: 1_200, now: () => t });
      tracker.markSpeechEnd();
      t += 220;
      tracker.markSttFinal();
      t += 240;
      tracker.markLlmFirstToken();
      t += 100;
      tracker.markFirstClauseReady();
      t += 190;
      tracker.markTtsFirstAudio();

      const fast = tracker.getReport();
      assert.deepEqual(
        [fast.sttFinalMs, fast.llmTtftMs, fast.firstClauseMs, fast.ttsFirstAudioMs, fast.e2eFirstAudioMs],
        [220, 240, 100, 190, 750]
      );
      assert.equal(fast.withinBudget, true);
      assert.equal(fast.headroomMs, 450);
      assert.equal(fast.bottleneckStage, 'llm');
      assert.deepEqual(fast.reasonCodes, []);

      const batch = VoiceLatencyBudgetTracker.fromDurations({
        sttFinalMs: 1_000,
        llmTtftMs: 2_000,
        firstClauseMs: 0,
        ttsFirstAudioMs: 1_400,
      });
      assert.equal(batch.e2eFirstAudioMs, 4_400);
      assert.equal(batch.withinBudget, false);
      assert.ok(batch.reasonCodes.includes('unstreamed_speech'));
      assert.ok(batch.reasonCodes.includes('no_streaming_ttft'));
      assert.ok(batch.reasonCodes.includes('latency_budget_exceeded'));
    });
  });

  describe('3. runVoiceStreamPipeline (Concurrent FIFO TTS + Streaming + Barge-In)', () => {
    it('runs STT -> LLM -> Chunker -> concurrent TTS while enforcing strict FIFO audio order', async () => {
      async function* mockStt(): AsyncIterable<SttTranscriptEvent> {
        yield { text: 'Đơn hàng của tôi', isFinal: false };
        yield { text: 'Đơn hàng của tôi khi nào giao?', isFinal: true, speechFinal: true };
      }

      async function* mockLlm(): AsyncIterable<string> {
        for (const token of [
          'Chào bạn tại TP. Hồ Chí Minh, ',
          'đơn hàng trị giá 150.000đ đang được đóng gói. ',
          'Dự kiến giao vào ngày mai!',
        ]) {
          await delay(8);
          yield token;
        }
      }

      const ttsFinishes: number[] = [];
      const ttsDelays = [45, 8, 5]; // Clause 0 is deliberately slower than 1 and 2
      const events: VoicePipelineEvent[] = [];

      const gen = runVoiceStreamPipeline({
        sttStream: mockStt(),
        llmStream: () => mockLlm(),
        chunkerOptions: { minChunkChars: 14, firstClauseMinChars: 14, firstClauseCommaFlush: true },
        maxConcurrentTts: 3,
        ttsSynthesize: async (clause: VoiceSentenceChunk) => {
          await delay(ttsDelays[clause.index] ?? 5);
          ttsFinishes.push(clause.index);
          return { bytes: new TextEncoder().encode(`audio:${clause.index}`), mimeType: 'audio/pcm', durationMs: 300 };
        },
      });

      while (true) {
        const step = await gen.next();
        if (step.done) {
          assert.equal(step.value.interrupted, false);
          assert.equal(step.value.clausesEmitted, 3);
          assert.equal(step.value.audioFramesEmitted, 3);
          assert.equal(step.value.transcript, 'Đơn hàng của tôi khi nào giao?');
          break;
        }
        events.push(step.value);
      }

      assert.ok(ttsFinishes.indexOf(1) < ttsFinishes.indexOf(0));
      const audioEvents = events.filter((e) => e.type === 'tts_audio');
      assert.deepEqual(audioEvents.map((e) => e.clauseIndex), [0, 1, 2]);
      assert.equal(audioEvents[0]!.isFirstAudio, true);
      assert.equal(audioEvents[1]!.isFirstAudio, false);
      assert.ok(events.some((e) => e.type === 'stt_interim') && events.some((e) => e.type === 'stt_final'));
    });

    it('supports streaming AsyncIterable TTS chunks and aborts immediately on barge-in', async () => {
      const controller = new VoiceTurnController();
      let observedSignalAborted = false;

      async function* mockLlm(_q: string, signal: AbortSignal): AsyncIterable<string> {
        for (const p of [
          'Đây là câu đầu tiên rất mượt mà, ',
          'đây là câu thứ hai không được phát sau barge-in. ',
          'Và đây là câu thứ ba bị hủy hoàn toàn.',
        ]) {
          if (signal.aborted) break;
          yield p;
          await delay(25);
        }
      }

      const audioClausesEmitted: number[] = [];
      let sawInterruptedEvent = false;

      const gen = runVoiceStreamPipeline({
        transcript: 'Giải thích quy trình đổi trả',
        turnController: controller,
        llmStream: (q, sig) => mockLlm(q, sig),
        chunkerOptions: { minChunkChars: 12, firstClauseMinChars: 12 },
        ttsSynthesize: async function* (clause, signal) {
          signal.addEventListener('abort', () => {
            observedSignalAborted = true;
          });
          yield new TextEncoder().encode(`chunk-a:${clause.index}`);
          await delay(15);
          if (signal.aborted) return;
          yield new TextEncoder().encode(`chunk-b:${clause.index}`);
        },
      });

      while (true) {
        const step = await gen.next();
        if (step.done) {
          assert.equal(step.value.interrupted, true);
          assert.equal(step.value.interruptionReason, 'caller_cut_in');
          break;
        }
        if (step.value.type === 'tts_audio') {
          audioClausesEmitted.push(step.value.clauseIndex);
          if (step.value.isFirstAudio) controller.triggerBargeIn('caller_cut_in');
        } else if (step.value.type === 'interrupted') {
          sawInterruptedEvent = true;
        }
      }

      assert.equal(sawInterruptedEvent, true);
      assert.equal(observedSignalAborted, true);
      assert.deepEqual(audioClausesEmitted, [0]);
      assert.equal(controller.getState(), 'interrupted');
    });
  });

  describe('4. GonnaCrash Level 25 Simulator & Root Export Parity', () => {
    it('proves serial batch, partial streaming & openai_mid fail while openai_small hits 663,289 UC', () => {
      const sim = simulateLevel25VoiceAssistantLatency();
      assert.equal(sim.levelKey, LEVEL25_SLA_TARGETS.levelKey);
      assert.equal(sim.concept, LEVEL25_SLA_TARGETS.concept);

      // (a) Serial batch: 4,400ms > 1,200ms -> FAIL
      const serial = sim.comparisons.serial_batch;
      assert.equal(serial.firstAudioMs, 4_400);
      assert.equal(serial.passedFirstAudioSla, false);
      assert.equal(serial.passedSla, false);
      assert.ok(serial.reasonCodes.includes('unstreamed_speech') && serial.reasonCodes.includes('no_streaming_ttft'));

      // (b) Partial streaming (LLM only; STT+TTS batch): 2,740ms > 1,200ms -> FAIL
      const partial = sim.comparisons.partial_streaming;
      assert.ok(partial.firstAudioMs > 1_200);
      assert.equal(partial.passedFirstAudioSla, false);
      assert.equal(partial.passedSla, false);
      assert.ok(partial.reasonCodes.includes('unstreamed_speech'));

      // (c) Full-duplex streaming with openai_mid: 910,289 UC > 770,000 UC -> BUDGET FAIL
      const mid = sim.comparisons.streaming_mid_model;
      assert.equal(mid.llmModel, 'openai_mid');
      assert.equal(mid.firstAudioMs, 1_160);
      assert.equal(mid.passedFirstAudioSla, true);
      assert.equal(mid.passedAccuracySla, true);
      assert.equal(mid.costPerTaskUc, 910_289);
      assert.equal(mid.passedCostSla, false);
      assert.equal(mid.passedSla, false);
      assert.ok(mid.reasonCodes.includes('budget_exceeded'));

      // (d) Full-duplex streaming with openai_small: exact 663,289 UC 3-Star Record PASS!
      assert.equal(sim.strategy, 'full_duplex_three_star');
      assert.equal(sim.llmModel, 'openai_small');
      assert.ok(sim.firstAudioMs >= 700 && sim.firstAudioMs <= 850);
      assert.equal(sim.passedAnsweredSla && sim.passedFirstAudioSla && sim.passedAccuracySla && sim.passedCostSla, true);
      assert.equal(sim.passedSla, true);
      assert.equal(sim.isThreeStarRecord, true);
      assert.equal(sim.costPerTaskUc, LEVEL25_SLA_TARGETS.threeStarBestCostUc);
      assert.equal(
        sim.costBreakdownUc.appServerUc + sim.costBreakdownUc.sttUc + sim.costBreakdownUc.ttsUc + sim.costBreakdownUc.llmUc,
        663_289
      );
      assert.equal(
        LEVEL25_COST_COMPONENTS_UC.appServerSmallUc +
          LEVEL25_COST_COMPONENTS_UC.sttPerTurnUc +
          LEVEL25_COST_COMPONENTS_UC.ttsPerTurnUc +
          LEVEL25_COST_COMPONENTS_UC.openaiSmallUc,
        663_289
      );

      assert.equal(sim.probes.firstClauseFlushedEarly, true);
      assert.equal(sim.probes.protectedEntitiesIntact, true);
      assert.equal(sim.probes.markdownStrippedForSpeech, true);
      assert.equal(sim.probes.bargeInAbortedSignal, true);

      // Root @kido/ai-stream re-export parity (zero collision check)
      assert.equal(rootPackage.VoiceSentenceChunker, VoiceSentenceChunker);
      assert.equal(rootPackage.VoiceTurnController, VoiceTurnController);
      assert.equal(rootPackage.VoiceLatencyBudgetTracker, VoiceLatencyBudgetTracker);
      assert.equal(rootPackage.runVoiceStreamPipeline, runVoiceStreamPipeline);
      assert.equal(rootPackage.simulateLevel25VoiceAssistantLatency, simulateLevel25VoiceAssistantLatency);
    });
  });
});
