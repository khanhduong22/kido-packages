import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EventLifecycleDripEngine,
  DEFAULT_DRIP_RULES,
  calculateEventRoiTelemetry,
  calculateB2bRoiTelemetry,
  compareWithBenchmark,
  formatVndCurrency,
  evaluateCpiRating,
  renderMinimalistEmail,
  EmailTemplateBuilder,
  renderB2bRoiEmail,
  renderWeddingGalleryEmail,
  ZaloZnsAdapter,
  TelegramAdapter,
  TelegramWebhookDispatcher,
  MockEmailAdapter,
  ResendEmailAdapter,
  SendGridEmailAdapter,
  EventDetails,
  EventRoiInput,
} from './index';

describe('@kido/event-marketing Unit Tests', () => {
  // Mock base dates for deterministic testing
  const eventDate = new Date('2026-11-20T18:00:00.000Z');
  const quoteCreatedAt = new Date('2026-10-15T09:00:00.000Z');

  const sampleB2bEvent: EventDetails = {
    id: 'evt-vinfast-gala-2026',
    name: 'VinFast Global Partner Summit & Gala Dinner',
    category: 'B2B_CORPORATE',
    clientName: 'Trần Minh Quân',
    clientCompany: 'VinFast Auto',
    clientEmail: 'quan.tm@vinfast.vn',
    clientPhone: '0905123456',
    eventDate: eventDate,
    callTime: new Date('2026-11-20T16:00:00+07:00'),
    venue: {
      name: 'Vinpearl Luxury Landmark 81 - Grand Ballroom',
      address: '720A Điện Biên Phủ, Phường 22, Bình Thạnh, TP.HCM',
      mapUrl: 'https://maps.google.com/?q=Landmark81',
    },
    assignedCrew: [
      { name: 'Nguyễn Văn Hùng', role: 'Lead Host Photobooth', phone: '0912345678' },
      { name: 'Lê Hoàng Nam', role: 'Kỹ Thuật Viên Máy In & iPad', phone: '0934567890' },
    ],
  };

  const sampleWeddingEvent: EventDetails = {
    id: 'evt-wedding-nam-mai',
    name: 'Lễ Thành Hôn & Tiệc Cưới: Nam & Mai',
    category: 'B2C_WEDDING',
    clientName: 'Hoàng Nam & Tuyết Mai',
    clientEmail: 'nam.mai.wedding@gmail.com',
    clientPhone: '0987654321',
    eventDate: eventDate,
    venue: {
      name: 'InterContinental Danang Sun Peninsula Resort',
      address: 'Bãi Bắc, Bán đảo Sơn Trà, Đà Nẵng',
    },
    galleryDetails: {
      url: 'https://fotobooth.vn/gallery/nam-mai-2026',
      pinCode: '2026',
      photoCount: 450,
    },
  };

  const sampleAbandonedQuoteEvent: EventDetails = {
    id: 'evt-quote-sun-group',
    name: 'Tiệc Year End Party Sun World Bà Nà Hills',
    category: 'LEAD_ABANDONED',
    clientName: 'Phạm Thu Thảo',
    clientEmail: 'thao.pt@sungroup.com.vn',
    clientPhone: '0918889999',
    eventDate: new Date('2026-12-28T18:00:00.000Z'),
    quoteDetails: {
      id: 'quote-sun-yep-2026',
      createdAt: quoteCreatedAt,
      totalAmountVnd: 25000000,
      status: 'ABANDONED',
      quoteLink: 'https://fotobooth.vn/quotes/sun-yep-2026',
      btsVideoUrl: 'https://youtu.be/bts-sample',
    },
  };

  // ==========================================================================
  // 1. DRIP LIFECYCLE ENGINE TESTS
  // ==========================================================================
  describe('EventLifecycleDripEngine - Timing & Rules', () => {
    const engine = new EventLifecycleDripEngine();

    it('Test 1: should calculate exact T-24h trigger time (24h before event)', () => {
      const rule = DEFAULT_DRIP_RULES.find((r) => r.triggerType === 'T_MINUS_24H')!;
      const scheduled = engine.calculateScheduledTime(rule, sampleB2bEvent);

      const expected = new Date(eventDate.getTime() - 24 * 60 * 60 * 1000);
      assert.strictEqual(scheduled.toISOString(), expected.toISOString());
      assert.strictEqual(scheduled.toISOString(), '2026-11-19T18:00:00.000Z');
    });

    it('Test 2: should calculate exact T+24h trigger time (24h after event)', () => {
      const rule = DEFAULT_DRIP_RULES.find((r) => r.triggerType === 'T_PLUS_24H')!;
      const scheduled = engine.calculateScheduledTime(rule, sampleB2bEvent);

      const expected = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
      assert.strictEqual(scheduled.toISOString(), expected.toISOString());
      assert.strictEqual(scheduled.toISOString(), '2026-11-21T18:00:00.000Z');
    });

    it('Test 3: should calculate exact T+3d trigger time (72h after event)', () => {
      const rule = DEFAULT_DRIP_RULES.find((r) => r.triggerType === 'T_PLUS_3D')!;
      const scheduled = engine.calculateScheduledTime(rule, sampleWeddingEvent);

      const expected = new Date(eventDate.getTime() + 3 * 24 * 60 * 60 * 1000);
      assert.strictEqual(scheduled.toISOString(), expected.toISOString());
      assert.strictEqual(scheduled.toISOString(), '2026-11-23T18:00:00.000Z');
    });

    it('Test 4: should calculate exact T+365d anniversary trigger time (1 year later)', () => {
      const rule = DEFAULT_DRIP_RULES.find((r) => r.triggerType === 'T_PLUS_365D')!;
      const scheduled = engine.calculateScheduledTime(rule, sampleWeddingEvent);

      assert.strictEqual(scheduled.getUTCFullYear(), 2027);
      assert.strictEqual(scheduled.getUTCMonth(), 10); // November is month 10 (0-indexed)
      assert.strictEqual(scheduled.getUTCDate(), 20);
      assert.strictEqual(scheduled.getUTCHours(), 18);
    });

    it('Test 5: should calculate exact T+2h abandoned quote trigger time (2h after quote created)', () => {
      const rule = DEFAULT_DRIP_RULES.find((r) => r.triggerType === 'T_PLUS_2H')!;
      const scheduled = engine.calculateScheduledTime(rule, sampleAbandonedQuoteEvent);

      const expected = new Date(quoteCreatedAt.getTime() + 2 * 60 * 60 * 1000);
      assert.strictEqual(scheduled.toISOString(), expected.toISOString());
      assert.strictEqual(scheduled.toISOString(), '2026-10-15T11:00:00.000Z');
    });

    it('Test 6: should filter rules by category (B2B gets ROI report, Wedding gets anniversary)', () => {
      const b2bSchedule = engine.generateSchedule(sampleB2bEvent);
      const b2bRuleTypes = b2bSchedule.map((m) => m.triggerType);

      assert.ok(b2bRuleTypes.includes('T_MINUS_24H'), 'B2B has T-24h briefing');
      assert.ok(b2bRuleTypes.includes('T_PLUS_24H'), 'B2B has T+24h ROI report');
      assert.ok(!b2bRuleTypes.includes('T_PLUS_365D'), 'B2B should NOT get Wedding Anniversary');

      const weddingSchedule = engine.generateSchedule(sampleWeddingEvent);
      const weddingRuleTypes = weddingSchedule.map((m) => m.triggerType);

      assert.ok(weddingRuleTypes.includes('T_MINUS_24H'), 'Wedding has T-24h');
      assert.ok(weddingRuleTypes.includes('T_PLUS_3D'), 'Wedding has T+3d Gallery');
      assert.ok(weddingRuleTypes.includes('T_PLUS_365D'), 'Wedding has T+365d Anniversary');
      assert.ok(!weddingRuleTypes.includes('T_PLUS_24H'), 'Wedding should NOT get B2B ROI report');
    });

    it('Test 7: should evaluate status and filter due messages correctly', () => {
      const schedule = engine.generateSchedule(sampleB2bEvent);

      // Current time is 1 hour before event -> T-24h message should be due
      const beforeEvent = new Date(eventDate.getTime() - 1 * 60 * 60 * 1000);
      const dueMessages = engine.filterDueMessages(schedule, beforeEvent);

      assert.strictEqual(dueMessages.length, 1);
      assert.strictEqual(dueMessages[0].triggerType, 'T_MINUS_24H');

      // Dispatch T-24h message
      const dispatchedMsg = engine.markMessageDispatched(dueMessages[0], beforeEvent);
      assert.strictEqual(dispatchedMsg.status, 'DISPATCHED');
      assert.ok(dispatchedMsg.dispatchedAt);

      // Now evaluate after event + 25 hours
      const afterEvent = new Date(eventDate.getTime() + 25 * 60 * 60 * 1000);
      const statusCheck = engine.evaluateStatus(
        [dispatchedMsg, schedule.find((s) => s.triggerType === 'T_PLUS_24H')!],
        afterEvent
      );

      assert.strictEqual(statusCheck.dispatched.length, 1);
      assert.strictEqual(statusCheck.due.length, 1);
      assert.strictEqual(statusCheck.due[0].triggerType, 'T_PLUS_24H');
    });
  });

  // ==========================================================================
  // 2. ROI TELEMETRY & CALCULATOR TESTS
  // ==========================================================================
  describe('ROI Calculator - Telemetry & Performance Benchmarking', () => {
    const roiInput: EventRoiInput = {
      eventCost: 15000000, // 15,000,000 VND
      totalSessions: 450,
      totalPhotosPrinted: 900,
      qrScans: 600,
      leadsCaptured: 360,
      estimatedAttendance: 1000,
      avgSocialSharesPerGuest: 2.5,
      avgFollowersPerGuest: 350,
    };

    it('Test 8: should calculate accurate interaction, conversion and CPL metrics', () => {
      const telemetry = calculateEventRoiTelemetry(roiInput);

      // Total interactions = 450 + 900 + 600 = 1950
      assert.strictEqual(telemetry.totalInteractions, 1950);
      assert.strictEqual(telemetry.totalSessions, 450);
      assert.strictEqual(telemetry.totalPhotosPrinted, 900);
      assert.strictEqual(telemetry.qrScans, 600);
      assert.strictEqual(telemetry.leadsCaptured, 360);

      // Conversion rate = (360 / 600) * 100 = 60%
      assert.strictEqual(telemetry.conversionRatePercent, 60);

      // Interaction per guest = 1950 / 1000 = 1.95
      assert.strictEqual(telemetry.interactionPerGuestRatio, 1.95);

      // Cost Per Lead = 15,000,000 / 360 = 41,667 VND
      assert.strictEqual(telemetry.costPerLeadVnd, 41667);
    });

    it('Test 9: should calculate viral reach, CPI and CPI rating accurately', () => {
      const telemetry = calculateB2bRoiTelemetry(roiInput);

      // Estimated social reach = 600 * 2.5 * 350 = 525,000 views
      assert.strictEqual(telemetry.estimatedSocialReach, 525000);

      // CPI = 15,000,000 / 525,000 = 28.57 VND / impression
      assert.strictEqual(telemetry.costPerImpressionVnd, 28.57);

      // Rating: < 100 is EXCELLENT
      assert.strictEqual(telemetry.cpiRating, 'EXCELLENT');
      assert.strictEqual(evaluateCpiRating(28.57), 'EXCELLENT');
      assert.strictEqual(evaluateCpiRating(250), 'GOOD');
      assert.strictEqual(evaluateCpiRating(500), 'AVERAGE');
      assert.strictEqual(evaluateCpiRating(900), 'SUB_OPTIMAL');

      // Check summary text
      assert.ok(telemetry.summaryText.includes('1.950 điểm chạm'));
      assert.ok(telemetry.summaryText.includes('525.000 lượt hiển thị'));
      assert.ok(telemetry.summaryText.includes('EXCELLENT'));
    });

    it('Test 10: should compare efficiency against digital advertising benchmark', () => {
      const telemetry = calculateEventRoiTelemetry(roiInput);
      const comparison = compareWithBenchmark(telemetry, 350); // Benchmark: 350 VND/cpi

      assert.strictEqual(comparison.isMoreEfficient, true);
      // Savings = 525,000 * 350 - 525,000 * 28.57 = 183,750,000 - 15,000,000 = 168,750,000 VND
      assert.ok(comparison.savingsVndTotal > 168000000);
      // Savings percent = ((350 - 28.57) / 350) * 100 = ~92%
      assert.strictEqual(comparison.savingsPercent, 92);
    });

    it('Test 11: should reject invalid inputs with Zod validation', () => {
      assert.throws(() => {
        calculateEventRoiTelemetry({
          eventCost: -5000, // Invalid negative cost
          totalSessions: 10,
          totalPhotosPrinted: 10,
          qrScans: 10,
          leadsCaptured: 5,
        });
      });
    });
  });

  // ==========================================================================
  // 3. EMAIL BUILDER (CRAFT MINIMALISM) TESTS
  // ==========================================================================
  describe('Email Template Builder', () => {
    const telemetry = calculateEventRoiTelemetry({
      eventCost: 10000000,
      totalSessions: 300,
      totalPhotosPrinted: 600,
      qrScans: 400,
      leadsCaptured: 240,
    });

    it('Test 12: should render clean minimalist email HTML with responsive viewport and inline CSS', () => {
      const html = renderMinimalistEmail({
        title: 'Báo Cáo Sự Kiện',
        subtitle: 'T-RED Media Update',
        clientName: 'Anh Quân',
        eventName: 'VinFast Summit',
        bodyParagraphs: ['Đoạn văn 1', 'Đoạn văn 2'],
        brandInfo: {
          name: 'T-RED Media',
          website: 'https://tred.vn',
        },
      });

      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('<meta name="viewport"'));
      assert.ok(html.includes('max-width: 600px'));
      assert.ok(html.includes('Anh Quân'));
      assert.ok(html.includes('VinFast Summit'));
      assert.ok(html.includes('Đoạn văn 1'));
      assert.ok(html.includes('https://tred.vn'));
    });

    it('Test 13: should render ROI Telemetry grid and executive brief callout', () => {
      const html = renderB2bRoiEmail({
        clientName: 'Chị Mai',
        eventName: 'Gala Dinner 2026',
        roi: telemetry,
        ctaUrl: 'https://tred.vn/dashboard/gala-2026',
      });

      assert.ok(html.includes('Tổng Điểm Chạm'));
      assert.ok(html.includes('Data Lead Thu Thập'));
      assert.ok(html.includes('Ước Tính Lan Toả MXH'));
      assert.ok(html.includes('Chi Phí / Tiếp Cận (CPI)'));
      assert.ok(html.includes('https://tred.vn/dashboard/gala-2026'));
      assert.ok(html.includes('Xem Dashboard Báo Cáo Chi Tiết'));
    });

    it('Test 14: should render wedding gallery email with PIN code security box', () => {
      const html = renderWeddingGalleryEmail({
        clientName: 'Nam & Mai',
        eventName: 'Lễ Thành Hôn',
        galleryUrl: 'https://fotobooth.vn/gallery/nam-mai',
        pinCode: '9999',
        photoCount: 500,
      });

      assert.ok(html.includes('Nam & Mai'));
      assert.ok(html.includes('Mã PIN Bảo Mật Gallery Riêng Tư'));
      assert.ok(html.includes('9999'));
      assert.ok(html.includes('https://fotobooth.vn/gallery/nam-mai'));
      assert.ok(html.includes('Truy Cập Cloud Gallery & Tải Ảnh'));
    });
  });

  // ==========================================================================
  // 4. ADAPTER TESTS (ZALO ZNS, TELEGRAM, EMAIL)
  // ==========================================================================
  describe('Adapters - Zalo ZNS, Telegram & Email', () => {
    it('Test 15: ZaloZnsAdapter should normalize phone numbers across varied input formats', () => {
      assert.strictEqual(ZaloZnsAdapter.normalizePhoneNumber('0905123456'), '84905123456');
      assert.strictEqual(ZaloZnsAdapter.normalizePhoneNumber('+84905123456'), '84905123456');
      assert.strictEqual(ZaloZnsAdapter.normalizePhoneNumber('090-512-3456'), '84905123456');
      assert.strictEqual(ZaloZnsAdapter.normalizePhoneNumber('84905123456'), '84905123456');
    });

    it('Test 16: ZaloZnsAdapter should build valid anniversary and abandoned quote payloads and dispatch in dev mode', async () => {
      const zns = new ZaloZnsAdapter({ mode: 'development' });

      // Anniversary payload
      const anniPayload = zns.buildAnniversaryPayload({
        phone: '0905123456',
        clientName: 'Nam & Mai',
        weddingDate: '20-11-2025',
      });
      assert.strictEqual(anniPayload.phone, '84905123456');
      assert.strictEqual(anniPayload.template_id, 'TRED_ZNS_WEDDING_1YEAR');

      const resAnni = await zns.send(anniPayload);
      assert.strictEqual(resAnni.error, 0);

      // Abandoned quote payload
      const quotePayload = zns.buildAbandonedQuotePayload({
        phone: '0918889999',
        clientName: 'Phạm Thu Thảo',
        quoteAmountVnd: 25000000,
        btsVideoUrl: 'https://fotobooth.vn/bts',
      });
      assert.strictEqual(quotePayload.phone, '84918889999');
      assert.strictEqual(quotePayload.template_id, 'TRED_ZNS_QUOTE_NUDGE_BTS');

      const resQuote = await zns.send(quotePayload);
      assert.strictEqual(resQuote.error, 0);

      // Check stored mock records
      const sent = zns.getSentMessages();
      assert.strictEqual(sent.length, 2);
    });

    it('Test 17: TelegramAdapter should format Markdown for crew briefing, ROI report, and quote nudge alert', async () => {
      const telegram = new TelegramAdapter({ defaultChatId: '-100123456789' });

      // Crew briefing Markdown
      const crewMd = telegram.formatCrewBriefingMarkdown(sampleB2bEvent);
      assert.ok(crewMd.includes('[THÔNG BÁO T-24H] ĐIỀU PHỐI EKIP SỰ KIỆN'));
      assert.ok(crewMd.includes('Vinpearl Luxury Landmark 81'));
      assert.ok(crewMd.includes('Nguyễn Văn Hùng'));
      assert.ok(crewMd.includes('16:00'));

      // ROI report Markdown
      const telemetry = calculateEventRoiTelemetry({
        eventCost: 15000000,
        totalSessions: 400,
        totalPhotosPrinted: 800,
        qrScans: 500,
        leadsCaptured: 300,
      });
      const roiMd = telegram.formatRoiReportMarkdown(sampleB2bEvent, telemetry);
      assert.ok(roiMd.includes('[TELEMETRY T+24H] BÁO CÁO HIỆU QUẢ SỰ KIỆN'));
      assert.ok(roiMd.includes('VinFast Auto'));
      assert.ok(roiMd.includes('Cost-Per-Impression'));

      // Abandoned quote alert
      const quoteAlertMd = telegram.formatAbandonedQuoteAlertMarkdown(sampleAbandonedQuoteEvent);
      assert.ok(quoteAlertMd.includes('[T+2H BOT ALERT] NHẮC BÁO GIÁ CHƯA CỌC'));
      assert.ok(quoteAlertMd.includes('Phạm Thu Thảo'));

      // Send mock message
      const sendResult = await telegram.sendMessage(undefined, crewMd);
      assert.strictEqual(sendResult.ok, true);
      assert.strictEqual(telegram.getSentMessages().length, 1);

      // Aliased dispatcher
      const aliasDispatcher = new TelegramWebhookDispatcher({ defaultChatId: '123' });
      assert.ok(aliasDispatcher instanceof TelegramAdapter);
    });

    it('Test 18: Email Adapters should send and record messages across Mock, Resend and SendGrid', async () => {
      // Mock Adapter
      const mockEmail = new MockEmailAdapter();
      const sendRes = await mockEmail.send({
        to: 'cmo@vinfast.vn',
        from: 'T-RED Media <contact@tred.vn>',
        subject: 'Báo Cáo ROI T+24h',
        html: '<h1>Báo cáo sự kiện</h1>',
      });
      assert.strictEqual(sendRes.success, true);
      assert.strictEqual(sendRes.provider, 'MOCK');
      assert.strictEqual(mockEmail.getSentMessages().length, 1);

      // Resend Adapter (Simulated mode without API key)
      const resend = new ResendEmailAdapter();
      const resendRes = await resend.send({
        to: 'client@tred.vn',
        from: 'T-RED Media <contact@tred.vn>',
        subject: 'Thông báo',
        html: '<p>Test Resend</p>',
      });
      assert.strictEqual(resendRes.success, true);
      assert.strictEqual(resendRes.provider, 'RESEND');

      // SendGrid Adapter (Simulated mode without API key)
      const sendgrid = new SendGridEmailAdapter();
      const sgRes = await sendgrid.send({
        to: 'client@tred.vn',
        from: 'T-RED Media <contact@tred.vn>',
        subject: 'Thông báo',
        html: '<p>Test SendGrid</p>',
      });
      assert.strictEqual(sgRes.success, true);
      assert.strictEqual(sgRes.provider, 'SENDGRID');
    });
  });
});
