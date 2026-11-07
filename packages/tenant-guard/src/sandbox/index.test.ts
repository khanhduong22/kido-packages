import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_VIETNAMESE_NAMES,
  PART_TIME_RATES,
  FULL_TIME_SALARIES,
  buildCorporateAvatarSvg,
  sanitizeStaffProfile,
  recomputePayslipJson,
  sanitizePayslipRecord,
  sanitizeIpAddress,
  sanitizeEvidenceLinks,
  replaceBrandTerms,
  sanitizeText,
  ModuleStudioManager,
  MODULE_PRESETS,
  resolveDemoPersona,
  isBlockedInDemoSandbox,
  evaluateDemoEndpointGuard,
  ZeroLoginPersonaGuard,
  assertSafeDemoDatabaseUrl,
} from '../index';

describe('@kido/demo-sandbox — Deep PII & Financial JSONB Sanitizer', () => {
  it('sanitizes staff profiles with realistic Vietnamese names, safe emails, SVG avatars, and demo salary bands', () => {
    const nameMap = new Map<string, string>();
    const rawUser = {
      id: 'usr-prod-99',
      name: 'Phúc Khánh',
      email: 'phuckhanh.real@gmail.com',
      image: 'https://lh3.googleusercontent.com/a/real-google-avatar',
      role: 'USER',
      employmentType: 'PART_TIME' as const,
      hourlyRate: 47500, // Real private rate
      monthlySalary: 0,
    };

    const sanitized = sanitizeStaffProfile(rawUser, 0, { nameMap });

    assert.equal(sanitized.name, DEMO_VIETNAMESE_NAMES[0]);
    assert.notEqual(sanitized.name, 'Phúc Khánh');
    assert.equal(sanitized.email, 'staff01@demomart.vn');
    assert.ok(sanitized.image.startsWith('data:image/svg+xml;utf8,'));
    assert.ok(PART_TIME_RATES.includes(sanitized.hourlyRate));
    assert.notEqual(sanitized.hourlyRate, 47500);
    assert.equal(nameMap.get('Phúc Khánh'), DEMO_VIETNAMESE_NAMES[0]);
  });

  it('recomputes historical JSONB payslip blobs so zero real salary or real PII remains', () => {
    const rawPayslipJson = {
      userId: 'real-user-01',
      staffName: 'Mai Thị Na',
      name: 'Mai Thị Na',
      userName: 'Mai Thị Na',
      email: 'maithina4040@gmail.com',
      userEmail: 'maithina4040@gmail.com',
      employmentType: 'PART_TIME',
      hourlyRate: 62500, // Real confidential hourly rate
      monthlySalary: 0,
      baseSalary: 625000,
      totalSalary: 775000,
      totalPay: 775000,
      netSalary: 775000,
      finalNet: 775000,
      lateCount: 1,
      latePenaltyHours: 0.5,
      bonusPercent: 10,
      dailyDetails: [
        {
          date: '2026-10-01',
          checkIn: '08:00',
          checkOut: '12:00',
          hours: 4,
          salary: 250000, // 4 * 62500
          multiplier: 1,
          shift: 'Ca Sáng AcmeCorp — Mai Thị Na',
          isSenior: false,
        },
        {
          date: '2026-10-02',
          checkIn: '13:00',
          checkOut: '19:00',
          hours: 6,
          salary: 375000, // 6 * 62500
          multiplier: 1,
          shift: 'Ca Chiều Acme Corp',
          isSenior: true,
        },
      ],
      adjustments: [
        {
          id: 'adj-real-1',
          userId: 'real-user-01',
          amount: 185000, // Real custom bonus
          reason: 'Thưởng riêng cho Mai Thị Na tại AcmeCorp',
        },
      ],
    };

    const recomputed = recomputePayslipJson(rawPayslipJson, 25000, 0, {
      userId: 'demo-staff-01',
      staffName: 'Lê Hoàng Nam',
      email: 'staff01@demomart.vn',
      employmentType: 'PART_TIME',
    });

    const serialized = JSON.stringify(recomputed);

    // Verify ZERO real PII or real salary figures survive anywhere in the JSONB payload
    assert.ok(!serialized.includes('Mai Thị Na'));
    assert.ok(!serialized.includes('maithina4040'));
    assert.ok(!serialized.includes('AcmeCorp'));
    assert.ok(!serialized.includes('Acme Corp'));
    assert.ok(!serialized.includes('62500'));
    assert.ok(!serialized.includes('250000'));
    assert.ok(!serialized.includes('375000'));
    assert.ok(!serialized.includes('185000'));

    // Verify mathematical recomputation accuracy:
    // Day 1: 4h * 25,000 = 100,000
    // Day 2: 6h * 25,000 + (6 * 2,000 senior bonus) = 162,000
    // Base salary = 262,000
    assert.equal(recomputed.hourlyRate, 25000);
    assert.equal(recomputed.dailyDetails[0].salary, 100000);
    assert.equal(recomputed.dailyDetails[1].salary, 162000);
    assert.equal(recomputed.baseSalary, 262000);
    assert.equal(recomputed.staffName, 'Lê Hoàng Nam');
    assert.equal(recomputed.email, 'staff01@demomart.vn');
    assert.equal(recomputed.totalPay, recomputed.netSalary);
    assert.equal(recomputed.finalNet, recomputed.netSalary);
    assert.ok(recomputed.dailyDetails[0].shift?.includes('DemoMart'));
    assert.ok(recomputed.dailyDetails[0].shift?.includes('Lê Hoàng Nam'));
  });

  it('recomputes FULL_TIME payslip JSONB records accurately via sanitizePayslipRecord', () => {
    const rawRecord = {
      userId: 'u-ft-1',
      month: 10,
      year: 2026,
      netSalary: 22500000,
      content: JSON.stringify({
        staffName: 'Nguyễn Văn Thật',
        email: 'that.nguyen@company.vn',
        employmentType: 'FULL_TIME',
        monthlySalary: 22500000,
        standardDays: 26,
        leaveCount: 2,
      }),
    };

    const result = sanitizePayslipRecord(rawRecord, {
      id: 'demo-ft-01',
      name: 'Phạm Thảo Vy',
      email: 'staff02@demomart.vn',
      employmentType: 'FULL_TIME',
      hourlyRate: 0,
      monthlySalary: FULL_TIME_SALARIES[2], // 8,000,000
    });

    assert.equal(result.content.monthlySalary, 8000000);
    assert.equal(result.content.staffName, 'Phạm Thảo Vy');
    assert.equal(result.netSalary, result.content.netSalary);
    assert.ok(!JSON.stringify(result).includes('22500000'));
    assert.ok(!JSON.stringify(result).includes('Nguyễn Văn Thật'));
  });

  it('masks real office/home IPs, internal evidence links, and brand names', () => {
    const maskedIp1 = sanitizeIpAddress('118.69.72.14', 0);
    const maskedIp2 = sanitizeIpAddress('14.161.22.105');

    assert.equal(maskedIp1, '103.199.42.10');
    assert.match(maskedIp2, /^103\.199\.42\.\d+$/);
    assert.equal(sanitizeIpAddress('0.0.0.0/0'), '0.0.0.0/0');

    const rawEvidence =
      'Ảnh chụp đơn hàng tại https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing và https://s3.ap-southeast-1.amazonaws.com/acme-private/proof.png';
    const cleanEvidence = sanitizeEvidenceLinks(rawEvidence, 'https://demo.demomart.vn/proof.jpg');
    assert.ok(!cleanEvidence.includes('drive.google.com'));
    assert.ok(!cleanEvidence.includes('amazonaws.com'));
    assert.ok(cleanEvidence.includes('https://demo.demomart.vn/proof.jpg'));

    const brandText = replaceBrandTerms('Kho vận AcmeCorp & Cửa hàng Acme Corp Quận 1');
    assert.equal(brandText, 'Kho vận DemoMart & Cửa hàng DemoMart Quận 1');

    const nameMap = new Map([['Trần Văn An', 'Đặng Quốc Bảo']]);
    const freeText = sanitizeText(
      'Nhân viên Trần Văn An (0987654321, an.tran@acme.vn) check-in tại AcmeCorp IP 192.168.1.50 kèm ảnh https://drive.google.com/abc',
      nameMap
    );
    assert.ok(!freeText.includes('Trần Văn An'));
    assert.ok(!freeText.includes('0987654321'));
    assert.ok(!freeText.includes('an.tran@acme.vn'));
    assert.ok(!freeText.includes('192.168.1.50'));
    assert.ok(!freeText.includes('drive.google.com'));
    assert.ok(freeText.includes('Đặng Quốc Bảo'));
    assert.ok(freeText.includes('DemoMart'));
  });
});

describe('@kido/demo-sandbox — Super App Module Studio Manager', () => {
  it('manages module toggles, presets, and core module enforcement with Redis + memory fallback', async () => {
    const backingMap = new Map<string, string>();
    let shouldFailRedis = false;

    const mockRedisAdapter = {
      async get(key: string) {
        if (shouldFailRedis) throw new Error('Redis connection lost');
        return backingMap.get(key) ?? null;
      },
      async set(key: string, value: string) {
        if (shouldFailRedis) throw new Error('Redis write timeout');
        backingMap.set(key, value);
      },
      async del(key: string) {
        backingMap.delete(key);
      },
    };

    const studio = new ModuleStudioManager({
      store: mockRedisAdapter,
      enforceCoreModules: true,
    });

    assert.equal(studio.getCatalog().length, 6);

    // Initial config has all modules enabled
    const initial = await studio.getConfig();
    assert.equal(initial.attendance, true);
    assert.equal(initial.gamification, true);

    // Apply RETAIL_CORE preset
    const retail = await studio.applyPreset('RETAIL_CORE');
    assert.deepEqual(retail, MODULE_PRESETS.RETAIL_CORE);
    assert.equal(await studio.isModuleEnabled('gamification'), false);
    assert.equal(await studio.isModuleEnabled('payroll'), true);

    // Core module 'attendance' cannot be disabled when enforceCoreModules is true
    const afterAttemptDisableCore = await studio.updateConfig({ attendance: false });
    assert.equal(afterAttemptDisableCore.attendance, true);

    // Toggle 'gamification' back on
    const toggled = await studio.toggleModule('gamification');
    assert.equal(toggled.gamification, true);

    // Simulate Redis outage and verify resilient in-memory fallback
    shouldFailRedis = true;
    const fallbackUpdate = await studio.updateConfig({ piecework: false });
    assert.equal(fallbackUpdate.piecework, false);
    const fallbackRead = await studio.getConfig();
    assert.equal(fallbackRead.piecework, false);

    // Recover Redis and reset
    shouldFailRedis = false;
    const resetState = await studio.reset();
    assert.deepEqual(resetState, MODULE_PRESETS.FULL_SUITE);
  });
});

describe('@kido/demo-sandbox — Zero-Login Persona Guard & Destructive Route Blocker', () => {
  it('resolves zero-login demo personas from headers, query params, and cookies', () => {
    assert.equal(resolveDemoPersona({ 'x-demo-persona': 'staff' }), 'STAFF');
    assert.equal(resolveDemoPersona({ 'x-demo-role': 'PARTNER' }), 'ADMIN');
    assert.equal(resolveDemoPersona(null, '?persona=guest'), 'GUEST');
    assert.equal(resolveDemoPersona(null, null, 'theme=dark; demo_role=USER'), 'STAFF');
    assert.equal(resolveDemoPersona(null, null, null, 'ADMIN'), 'ADMIN');

    const guard = new ZeroLoginPersonaGuard({ defaultPersona: 'ADMIN' });
    const staffProfile = guard.resolvePersona({
      headers: { 'x-demo-persona': 'STAFF' },
    });
    assert.equal(staffProfile.persona, 'STAFF');
    assert.equal(staffProfile.email, 'staff01@demomart.vn');
    assert.ok(staffProfile.image.startsWith('data:image/svg+xml;utf8,'));
  });

  it('blocks destructive and sensitive endpoints in public demo mode while allowing interactive sandbox routes', () => {
    // Blocked destructive / sensitive endpoints
    assert.equal(isBlockedInDemoSandbox('POST', '/api/tenants/backup'), true);
    assert.equal(isBlockedInDemoSandbox('POST', '/api/system/wipe'), true);
    assert.equal(isBlockedInDemoSandbox('POST', '/api/auth/change-password'), true);
    assert.equal(isBlockedInDemoSandbox('DELETE', '/api/users/oauth-tokens'), true);
    assert.equal(isBlockedInDemoSandbox('DELETE', '/api/tenants/org-123'), true);

    const detail = evaluateDemoEndpointGuard('POST', '/api/tenants/backup');
    assert.equal(detail.blocked, true);
    assert.equal(detail.status, 403);
    assert.equal(detail.code, 'DEMO_SANDBOX_RESTRICTED');

    // Allowed interactive sandbox endpoints
    assert.equal(isBlockedInDemoSandbox('POST', '/api/demo/reset'), false);
    assert.equal(isBlockedInDemoSandbox('POST', '/api/demo/switch-role'), false);
    assert.equal(isBlockedInDemoSandbox('POST', '/api/demo/modules'), false);
    assert.equal(isBlockedInDemoSandbox('POST', '/api/checkins'), false);
    assert.equal(isBlockedInDemoSandbox('GET', '/api/payslips'), false);

    // Custom block rules
    const customRules = [
      {
        method: 'DELETE',
        pattern: '/api/payroll/periods',
        reason: 'Payroll period deletion is locked in demo.',
      },
    ];
    assert.equal(isBlockedInDemoSandbox('DELETE', '/api/payroll/periods/2026-10', customRules), true);
    assert.equal(isBlockedInDemoSandbox('GET', '/api/payroll/periods/2026-10', customRules), false);
  });

  it('enforces database safety lock to prevent running demo sanitizer against production DB', () => {
    assert.throws(
      () => assertSafeDemoDatabaseUrl('postgresql://prod_user:secret@aws-rds.prod.internal:5432/acme_prod', 'production'),
      /SAFETY LOCK/
    );

    assert.doesNotThrow(() =>
      assertSafeDemoDatabaseUrl('postgresql://postgres:postgres@localhost:5432/checkin_demo_db', 'production')
    );
  });
});
