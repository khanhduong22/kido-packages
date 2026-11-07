import assert from 'node:assert';
import test from 'node:test';
import {
  cleanPhoneNumber,
  createGoogleSheetsWebhookRequest,
  DEFAULT_SHEET_HEADERS,
  distributeRoundRobin,
  formatGoogleSheetBatchPayload,
  formatGoogleSheetPayload,
  formatPhoneDisplay,
  formatPhoneE164,
  formatPhoneForGoogleSheets,
  formatVietnamDateTime,
  getVietnameseCarrier,
  GoogleSheetPayloadSchema,
  ingestLead,
  isValidVietnamesePhone,
  LeadInputSchema,
  LeadRecordSchema,
  normalizeUtm,
  RoundRobinDistributor,
  SalesAgent,
  SalesAgentSchema,
} from './index';

test('1. Vietnam Phone Cleaning, Validation, Carrier Detection & Formatting', () => {
  // Various input formats
  assert.strictEqual(cleanPhoneNumber('0987654321'), '0987654321');
  assert.strictEqual(cleanPhoneNumber('+84 987 654 321'), '0987654321');
  assert.strictEqual(cleanPhoneNumber('84987654321'), '0987654321');
  assert.strictEqual(cleanPhoneNumber('+84987654321'), '0987654321');
  assert.strictEqual(cleanPhoneNumber('098.765.4321'), '0987654321');
  assert.strictEqual(cleanPhoneNumber('(098) 765-4321'), '0987654321');
  assert.strictEqual(cleanPhoneNumber('0084987654321'), '0987654321');

  // Valid prefixes (03, 05, 07, 08, 09)
  assert.strictEqual(isValidVietnamesePhone('0987654321'), true); // 098 Viettel
  assert.strictEqual(isValidVietnamesePhone('0901234567'), true); // 090 Mobifone
  assert.strictEqual(isValidVietnamesePhone('0912345678'), true); // 091 Vinaphone
  assert.strictEqual(isValidVietnamesePhone('0356789123'), true); // 035 Viettel
  assert.strictEqual(isValidVietnamesePhone('0771234567'), true); // 077 Mobifone
  assert.strictEqual(isValidVietnamesePhone('0831234567'), true); // 083 Vinaphone
  assert.strictEqual(isValidVietnamesePhone('0561234567'), true); // 056 Vietnamobile
  assert.strictEqual(isValidVietnamesePhone('0871234567'), true); // 087 Wintel

  // Invalid phone numbers
  assert.strictEqual(isValidVietnamesePhone('0243825000'), false); // Hanoi landline (024)
  assert.strictEqual(isValidVietnamesePhone('0123456789'), false); // Invalid prefix 01
  assert.strictEqual(isValidVietnamesePhone('098765432'), false); // 9 digits (too short)
  assert.strictEqual(isValidVietnamesePhone('09876543210'), false); // 11 digits (too long)
  assert.strictEqual(isValidVietnamesePhone('abc0987654'), false);

  // Carrier identification
  assert.strictEqual(getVietnameseCarrier('0987654321'), 'Viettel');
  assert.strictEqual(getVietnameseCarrier('0908123456'), 'Mobifone');
  assert.strictEqual(getVietnameseCarrier('0918123456'), 'Vinaphone');
  assert.strictEqual(getVietnameseCarrier('0568123456'), 'Vietnamobile');
  assert.strictEqual(getVietnameseCarrier('0878123456'), 'Wintel/Itelecom');

  // Phone formatting
  assert.strictEqual(formatPhoneE164('0987654321'), '+84987654321');
  assert.strictEqual(formatPhoneDisplay('0987654321'), '0987 654 321');
  assert.strictEqual(formatPhoneForGoogleSheets('0987654321'), "'0987654321");
});

test('2. UTM Normalization & FB/TikTok Ad Detection', () => {
  // Query string normalization
  const utm1 = normalizeUtm(
    '?utm_source=Facebook&utm_medium=PAID_SOCIAL&utm_campaign=TET_SALE_2026'
  );
  assert.strictEqual(utm1.utm_source, 'facebook');
  assert.strictEqual(utm1.utm_medium, 'paid_social');
  assert.strictEqual(utm1.utm_campaign, 'TET_SALE_2026');

  // Full URL with FBCLID
  const utmFb = normalizeUtm(
    'https://shopkt.vn/landing-combo?fbclid=IwAR2V8bXy_123456&utm_campaign=flash_deal'
  );
  assert.strictEqual(utmFb.utm_source, 'facebook');
  assert.strictEqual(utmFb.utm_medium, 'cpc');
  assert.strictEqual(utmFb.utm_campaign, 'flash_deal');
  assert.strictEqual(utmFb.fbclid, 'IwAR2V8bXy_123456');

  // TikTok Ad with TTCLID
  const utmTt = normalizeUtm({
    ttclid: 'tt_click_id_999888',
    utm_campaign: 'tiktok_live_stream',
  });
  assert.strictEqual(utmTt.utm_source, 'tiktok');
  assert.strictEqual(utmTt.utm_medium, 'cpc');
  assert.strictEqual(utmTt.utm_campaign, 'tiktok_live_stream');
  assert.strictEqual(utmTt.ttclid, 'tt_click_id_999888');

  // Object with camelCase properties
  const utmCamel = normalizeUtm({
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'brand_search',
  });
  assert.strictEqual(utmCamel.utm_source, 'google');
  assert.strictEqual(utmCamel.utm_medium, 'cpc');
  assert.strictEqual(utmCamel.utm_campaign, 'brand_search');
});

test('3. Lead Ingestion & Zod Schemas Validation', () => {
  // Valid lead ingestion
  const validResult = ingestLead({
    fullName: 'Nguyễn Văn An',
    phone: '+84 987 654 321',
    email: 'vanan@gmail.com',
    productInterest: 'Bộ dưỡng da phục hồi',
    note: 'Tư vấn ngoài giờ hành chính',
    utm: {
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'retargeting_v2',
      fbclid: 'fb_clk_123',
    },
  });

  assert.strictEqual(validResult.success, true);
  if (validResult.success) {
    const lead = validResult.data;
    assert.strictEqual(lead.fullName, 'Nguyễn Văn An');
    assert.strictEqual(lead.phone, '0987654321');
    assert.strictEqual(lead.phoneE164, '+84987654321');
    assert.strictEqual(lead.carrier, 'Viettel');
    assert.strictEqual(lead.status, 'NEW');
    assert.strictEqual(lead.source, 'facebook');
    assert.strictEqual(lead.utm.utm_campaign, 'retargeting_v2');

    // Validate against LeadRecordSchema
    const parseRecord = LeadRecordSchema.safeParse(lead);
    assert.strictEqual(parseRecord.success, true);
  }

  // Invalid lead (missing phone and invalid name)
  const invalidResult = ingestLead({
    fullName: '',
    phone: '0123456789', // Invalid VN mobile prefix
  });
  assert.strictEqual(invalidResult.success, false);
  if (!invalidResult.success) {
    assert.ok(invalidResult.errors.length >= 2);
  }

  // Validate LeadInputSchema
  const validParsedInput = LeadInputSchema.safeParse({
    fullName: 'Trần Thị Bích',
    phone: '0912345678',
    email: 'bich@example.com',
  });
  assert.strictEqual(validParsedInput.success, true);

  // Validate SalesAgentSchema
  const validAgent = SalesAgentSchema.safeParse({
    id: 'agent-01',
    name: 'Phạm Thị Thảo (Telesale)',
    email: 'thao.pt@company.vn',
    isActive: true,
    weight: 2,
  });
  assert.strictEqual(validAgent.success, true);
});

test('4. Round-Robin Lead Distribution Algorithm', () => {
  const agents: SalesAgent[] = [
    { id: 'agent-1', name: 'Sale 1', isActive: true, weight: 1 },
    { id: 'agent-2', name: 'Sale 2', isActive: true, weight: 1 },
    { id: 'agent-3', name: 'Sale 3 (Nghỉ phép)', isActive: false, weight: 1 },
  ];

  const distributor = new RoundRobinDistributor(agents);

  // Active agents should only be agent-1 and agent-2
  const active = distributor.getActiveAgents();
  assert.strictEqual(active.length, 2);
  assert.strictEqual(active.map((a) => a.id).includes('agent-3'), false);

  // Test sequential allocation (agent-1 -> agent-2 -> agent-1 -> agent-2)
  const a1 = distributor.nextAgent();
  const a2 = distributor.nextAgent();
  const a3 = distributor.nextAgent();
  const a4 = distributor.nextAgent();

  assert.strictEqual(a1?.id, 'agent-1');
  assert.strictEqual(a2?.id, 'agent-2');
  assert.strictEqual(a3?.id, 'agent-1');
  assert.strictEqual(a4?.id, 'agent-2');

  const stats = distributor.getStats();
  assert.strictEqual(stats['agent-1'], 2);
  assert.strictEqual(stats['agent-2'], 2);

  // State persistence (export & load)
  const savedState = distributor.exportState();
  const newDistributor = new RoundRobinDistributor(agents);
  newDistributor.loadState(savedState);

  const nextAfterRestore = newDistributor.nextAgent();
  assert.strictEqual(nextAfterRestore?.id, 'agent-1');

  // Weighted Round Robin
  const weightedAgents: SalesAgent[] = [
    { id: 'senior-1', name: 'Senior Sale', isActive: true, weight: 2 },
    { id: 'junior-1', name: 'Junior Sale', isActive: true, weight: 1 },
  ];
  const weightedDistributor = new RoundRobinDistributor(weightedAgents);
  const w1 = weightedDistributor.nextAgent();
  const w2 = weightedDistributor.nextAgent();
  const w3 = weightedDistributor.nextAgent();

  // Out of 3 picks, senior gets 2, junior gets 1
  assert.strictEqual(w1?.id, 'senior-1');
  assert.strictEqual(w2?.id, 'senior-1');
  assert.strictEqual(w3?.id, 'junior-1');

  // Functional helper distributeRoundRobin
  const leadSample = ingestLead({
    fullName: 'Lê Hoàng',
    phone: '0933111222',
  });
  assert.strictEqual(leadSample.success, true);
  if (leadSample.success) {
    const distributed = distributeRoundRobin([leadSample.data], agents);
    assert.strictEqual(distributed[0].status, 'ASSIGNED');
    assert.strictEqual(distributed[0].assignedTo, 'agent-1');
    assert.strictEqual(distributed[0].assignedAgentName, 'Sale 1');
  }
});

test('5. Google Sheets Realtime Sync Payload Formatter', () => {
  const leadResult = ingestLead({
    fullName: 'Võ Minh Trí',
    phone: '0978123456',
    email: 'tri.vo@gmail.com',
    productInterest: 'Serum Vitamin C',
    note: 'Giao hàng giờ hành chính',
    utm: {
      utm_source: 'tiktok',
      utm_medium: 'paid_social',
      utm_campaign: 'mega_sale_11',
    },
  });

  assert.strictEqual(leadResult.success, true);
  if (!leadResult.success) return;

  const lead = leadResult.data;
  lead.assignedTo = 'agent-02';
  lead.assignedAgentName = 'Phạm Minh Tuấn';
  lead.status = 'ASSIGNED';

  // Format single row payload
  const payload = formatGoogleSheetPayload(lead, {
    sheetName: 'Data Leads Tháng 10',
    preservePhoneLeadingZero: true,
  });

  // Verify against Zod Schema
  const parseResult = GoogleSheetPayloadSchema.safeParse(payload);
  assert.strictEqual(parseResult.success, true);

  assert.strictEqual(payload.action, 'APPEND_ROW');
  assert.strictEqual(payload.sheetName, 'Data Leads Tháng 10');
  assert.deepStrictEqual(payload.headers, DEFAULT_SHEET_HEADERS);

  // Verify row values
  const row = payload.row;
  assert.strictEqual(row[1], lead.id);
  assert.strictEqual(row[2], 'Võ Minh Trí');
  // CRUCIAL: Must preserve leading zero with single quote
  assert.strictEqual(row[3], "'0978123456");
  assert.strictEqual(row[4], 'Viettel');
  assert.strictEqual(row[5], 'tri.vo@gmail.com');
  assert.strictEqual(row[6], 'Serum Vitamin C');
  assert.strictEqual(row[7], 'tiktok');
  assert.strictEqual(row[10], 'Phạm Minh Tuấn');
  assert.strictEqual(row[11], 'ASSIGNED');

  // Verify Batch Payload
  const batchPayload = formatGoogleSheetBatchPayload([lead, lead], {
    sheetName: 'Leads Backup',
  });
  assert.strictEqual(batchPayload.action, 'APPEND_ROWS');
  assert.strictEqual(batchPayload.rows.length, 2);
  assert.strictEqual(batchPayload.count, 2);

  // Verify Webhook Request Builder
  const req = createGoogleSheetsWebhookRequest({
    webhookUrl: 'https://script.google.com/macros/s/AKfycbx.../exec',
    payload,
    secretToken: 'secret_app_key_123',
  });

  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.headers['Content-Type'], 'application/json');
  assert.ok(req.url.includes('token=secret_app_key_123'));
  assert.ok(req.body.includes("'0978123456"));
});

test('6. Vietnamese DateTime Formatter', () => {
  const iso = '2026-09-30T05:00:00.000Z'; // 12:00:00 VN time (UTC+7)
  const formatted = formatVietnamDateTime(iso);
  assert.ok(formatted.includes('30/09/2026') || formatted.includes('2026'));
  assert.ok(formatted.includes('12:00:00'));
});
