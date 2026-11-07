import {
  DemoPersona,
  EmploymentType,
  PayslipAdjustment,
  PayslipDailyDetail,
  PayslipJsonPayload,
  RecomputePayslipOptions,
  SanitizedStaffProfile,
  SanitizeStaffOptions,
  StaffProfileInput,
} from './types';

export const DEMO_VIETNAMESE_NAMES: readonly string[] = [
  'Lê Hoàng Nam',
  'Phạm Thảo Vy',
  'Đặng Quốc Bảo',
  'Vũ Minh Châu',
  'Hoàng Gia Huy',
  'Ngô Khánh Linh',
  'Bùi Tuấn Kiệt',
  'Đỗ Ngọc Ánh',
  'Lý Gia Hân',
  'Trương Đức Anh',
  'Phan Thanh Trúc',
  'Đinh Quang Minh',
  'Hồ Phương Thảo',
  'Dương Tuấn Anh',
  'Mai Khánh Ngân',
  'Lương Hải Đăng',
  'Tạ Ngọc Diệp',
  'Chu Minh Quân',
  'Võ Thanh Hà',
  'Nguyễn Bảo Trâm',
] as const;

/** Alias for backward compatibility with existing callers */
export const DEMO_STAFF_NAMES = DEMO_VIETNAMESE_NAMES;

export const PART_TIME_RATES: readonly number[] = [
  23000, 24000, 25000, 26000, 28000, 30000, 32000, 35000,
] as const;

export const FULL_TIME_SALARIES: readonly number[] = [
  7000000, 7500000, 8000000, 8500000, 9000000, 9500000, 10500000,
] as const;

export const DEMO_ADJUSTMENT_AMOUNTS: readonly number[] = [
  100000, 150000, 200000, 300000,
] as const;

export const DEMO_ADJUSTMENT_REASONS: readonly string[] = [
  'Thưởng vượt KPI đóng gói',
  'Thưởng chuyên cần',
  'Thưởng hỗ trợ kiểm kho ca tối',
  'Thưởng doanh số bán hàng xuất sắc',
] as const;

export const DEFAULT_BRAND_MAP: Readonly<Record<string, string>> = {
  'Acme Corp': 'DemoMart',
  AcmeCorp: 'DemoMart',
  acmecorp: 'DemoMart',
};

export const DEFAULT_SAFE_EVIDENCE_URL = 'https://demo.demomart.vn/evidence/sample-proof.jpg';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickFromPool<T>(
  pool: readonly T[],
  index: number,
  deterministic = true,
  avoidValue?: T
): T {
  if (pool.length === 0) {
    throw new Error('Cannot pick from an empty pool');
  }
  const safeIndex = Math.abs(Math.trunc(index) || 0);
  let chosenIdx = deterministic
    ? safeIndex % pool.length
    : Math.floor(Math.random() * pool.length);

  if (avoidValue !== undefined && pool.length > 1 && pool[chosenIdx] === avoidValue) {
    chosenIdx = (chosenIdx + 1) % pool.length;
  }
  return pool[chosenIdx];
}

/**
 * Generates a clean, self-contained SVG corporate avatar data URI from a Vietnamese name and role.
 */
export function buildCorporateAvatarSvg(name: string, role = 'USER'): string {
  const cleaned = String(name || '')
    .replace(/\([^)]*\)/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'D')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);
  let initials = 'DM';
  if (words.length >= 2) {
    const lastTwo = words.slice(-2);
    initials = `${lastTwo[0][0]}${lastTwo[1][0]}`.toUpperCase();
  } else if (words.length === 1) {
    initials = words[0].slice(0, 2).toUpperCase();
  }

  const normalizedRole = String(role || 'USER').toUpperCase();
  const [startColor, endColor] =
    normalizedRole === 'ADMIN'
      ? ['#4f46e5', '#1d4ed8']
      : normalizedRole === 'PARTNER'
        ? ['#0d9488', '#047857']
        : ['#334155', '#0f172a'];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="${initials}"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${startColor}"/><stop offset="100%" stop-color="${endColor}"/></linearGradient></defs><rect width="128" height="128" rx="64" fill="url(#g)"/><text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="#ffffff" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="48" font-weight="700" letter-spacing="1">${initials}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Masks real static office/home IPv4 or IPv6 addresses into safe demo CIDR block `103.199.42.x`.
 */
export function sanitizeIpAddress(ip: string | null | undefined, index?: number): string {
  const raw = String(ip || '').trim();
  if (!raw) {
    return '103.199.42.10';
  }
  if (raw === '0.0.0.0/0') {
    return '0.0.0.0/0';
  }

  const octet =
    typeof index === 'number' && Number.isFinite(index)
      ? ((Math.abs(Math.trunc(index)) % 240) + 10)
      : ((hashString(raw) % 240) + 10);

  return `103.199.42.${octet}`;
}

/**
 * Replaces internal Google Drive, S3, R2, or arbitrary external evidence URLs with a safe demo link.
 */
export function sanitizeEvidenceLinks(
  textOrUrl: string | null | undefined,
  safeUrl: string = DEFAULT_SAFE_EVIDENCE_URL
): string {
  if (!textOrUrl) return '';
  const raw = String(textOrUrl);
  return raw.replace(/https?:\/\/[^\s)"'<>]+/gi, safeUrl);
}

/**
 * Rewrites internal/client brand names into safe demo brand names ("DemoMart").
 */
export function replaceBrandTerms(
  text: string | null | undefined,
  brandMap: Record<string, string> = DEFAULT_BRAND_MAP
): string {
  if (!text) return '';
  let output = String(text);

  const entries = Object.entries(brandMap).sort((a, b) => b[0].length - a[0].length);
  for (const [sourceBrand, targetBrand] of entries) {
    if (!sourceBrand.trim()) continue;
    const pattern = new RegExp(escapeRegExp(sourceBrand.trim()), 'gi');
    output = output.replace(pattern, targetBrand);
  }

  return output;
}

/**
 * Sanitizes free-text strings by scrubbing URLs, emails, Vietnamese phone numbers,
 * IPv4 addresses, mapped real employee names, and brand names.
 */
export function sanitizeText(
  input: string | null | undefined,
  nameMap?: Map<string, string>,
  brandMap: Record<string, string> = DEFAULT_BRAND_MAP,
  safeUrl: string = DEFAULT_SAFE_EVIDENCE_URL
): string {
  if (!input) return '';

  let output = String(input);

  // 1. Replace URLs with placeholder first so brand replacement does not mutate the safe demo URL
  const URL_PLACEHOLDER = '__DEMO_SAFE_ASSET_URL__';
  output = output.replace(/https?:\/\/[^\s)"'<>]+/gi, URL_PLACEHOLDER);

  // 2. Replace any email addresses
  output = output.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    'contact@demomart.vn'
  );

  // 3. Replace Vietnamese phone numbers (0\d{8,10} or +84\d{8,10})
  output = output.replace(/(?:\+84|(?<!\d)0)\d{8,10}(?!\d)/g, '0901234567');

  // 4. Replace raw IPv4 addresses embedded in free text (except already-masked 103.199.42.x)
  output = output.replace(
    /\b(?!103\.199\.42\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    (matchedIp) => sanitizeIpAddress(matchedIp)
  );

  // 5. Replace real user names from nameMap (longest keys first)
  if (nameMap && nameMap.size > 0) {
    const entries = Array.from(nameMap.entries())
      .filter(([orig]) => orig && orig.trim().length >= 2)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [origName, demoName] of entries) {
      const pattern = new RegExp(`(?<!\\p{L})${escapeRegExp(origName.trim())}(?!\\p{L})`, 'giu');
      output = output.replace(pattern, demoName);
    }
  }

  // 6. Replace brand terms
  output = replaceBrandTerms(output, brandMap);

  // 7. Restore safe Demo URL
  output = output.replace(new RegExp(URL_PLACEHOLDER, 'g'), safeUrl);

  return output;
}

/**
 * Deterministically or randomly replaces real staff PII with realistic Vietnamese sample names,
 * safe demo emails (`staff01@demomart.vn`), SVG corporate avatars, and safe salary bands.
 */
export function sanitizeStaffProfile(
  user: StaffProfileInput,
  index = 0,
  options?: SanitizeStaffOptions
): SanitizedStaffProfile {
  const deterministic = options?.deterministic !== false;
  const domain = (options?.domain || 'demomart.vn').replace(/^@+/, '');
  const emailPrefix = options?.emailPrefix || 'staff';
  const namePool =
    options?.namePool && options.namePool.length > 0
      ? options.namePool
      : DEMO_VIETNAMESE_NAMES;
  const partTimeRates =
    options?.partTimeRates && options.partTimeRates.length > 0
      ? options.partTimeRates
      : PART_TIME_RATES;
  const fullTimeSalaries =
    options?.fullTimeSalaries && options.fullTimeSalaries.length > 0
      ? options.fullTimeSalaries
      : FULL_TIME_SALARIES;

  const safeIdx = Math.max(0, Math.trunc(index) || 0);
  const rawRole = String(user?.role || 'USER').toUpperCase();
  const normalizedRole: 'ADMIN' | 'PARTNER' | 'USER' =
    rawRole === 'ADMIN' ? 'ADMIN' : rawRole === 'PARTNER' ? 'PARTNER' : 'USER';
  const persona: DemoPersona = normalizedRole === 'ADMIN' ? 'ADMIN' : 'STAFF';

  const demoName = pickFromPool(
    namePool,
    safeIdx,
    deterministic,
    typeof user?.name === 'string' ? user.name : undefined
  );

  if (options?.nameMap && typeof user?.name === 'string' && user.name.trim().length >= 2) {
    options.nameMap.set(user.name.trim(), demoName);
  }

  // Generate 1-based padded number: index 0 -> "01", index 1 -> "02" (or if caller passed 1-based index, still "01", "02"...)
  const paddedNumber = String(safeIdx + 1).padStart(2, '0');
  const demoEmail = `${emailPrefix}${paddedNumber}@${domain}`.toLowerCase();

  const employmentType: EmploymentType =
    user?.employmentType === 'FULL_TIME' ||
    (Number(user?.monthlySalary) > 0 && !Number(user?.hourlyRate))
      ? 'FULL_TIME'
      : 'PART_TIME';

  const realHourly = Number(user?.hourlyRate) || 0;
  const realMonthly = Number(user?.monthlySalary) || 0;

  const mappedHourlyRate =
    employmentType === 'PART_TIME' || realHourly > 0
      ? pickFromPool(partTimeRates, safeIdx, deterministic, realHourly)
      : 0;

  const mappedMonthlySalary =
    employmentType === 'FULL_TIME' || realMonthly > 0
      ? pickFromPool(fullTimeSalaries, safeIdx, deterministic, realMonthly)
      : 0;

  const id =
    typeof user?.id === 'string' && user.id.trim()
      ? user.id.trim()
      : `demo-${emailPrefix}-${paddedNumber}`;

  return {
    id,
    name: demoName,
    email: demoEmail,
    image: buildCorporateAvatarSvg(demoName, normalizedRole),
    role: normalizedRole,
    persona,
    isActive: user?.isActive !== false,
    employmentType,
    hourlyRate: mappedHourlyRate,
    monthlySalary: mappedMonthlySalary,
    birthday: user?.birthday ? new Date(user.birthday) : new Date(Date.UTC(2000, safeIdx % 12, 15)),
    startDate: user?.startDate ? new Date(user.startDate) : new Date('2025-01-15T00:00:00.000Z'),
  };
}

/**
 * Deep-sanitizes historical JSON/JSONB payslip blobs so embedded `hourlyRate`, `baseSalary`,
 * `totalPay`, `netSalary`, `staffName`, and `email` inside JSONB are mathematically recomputed
 * to match the randomized demo salary — eliminating the "Hidden PII Leak in JSONB" vulnerability.
 */
export function recomputePayslipJson(
  payslipContent: Record<string, unknown> | string | null | undefined,
  newHourlyRate: number,
  newMonthlySalary: number,
  options?: RecomputePayslipOptions
): PayslipJsonPayload {
  let rawContent: Record<string, any> = {};
  if (typeof payslipContent === 'string') {
    try {
      const parsed = JSON.parse(payslipContent);
      if (parsed && typeof parsed === 'object') {
        rawContent = parsed;
      }
    } catch {
      rawContent = {};
    }
  } else if (payslipContent && typeof payslipContent === 'object') {
    rawContent = { ...payslipContent };
  }

  const nameMap = new Map<string, string>(options?.nameMap ? Array.from(options.nameMap.entries()) : []);
  const brandMap = options?.brandMap || DEFAULT_BRAND_MAP;

  const safeStaffName = options?.staffName || DEMO_VIETNAMESE_NAMES[0];
  const safeEmail = options?.email || 'staff01@demomart.vn';
  const safeUserId = options?.userId || 'demo-staff-01';

  // Record any embedded original names into nameMap so nested strings are also scrubbed
  for (const key of ['staffName', 'name', 'userName', 'employeeName', 'fullName']) {
    const val = rawContent[key];
    if (typeof val === 'string' && val.trim().length >= 2 && val !== safeStaffName) {
      nameMap.set(val.trim(), safeStaffName);
    }
  }

  const safeHourlyRate = Math.max(0, Math.round(Number(newHourlyRate) || 0));
  const safeMonthlySalary = Math.max(0, Math.round(Number(newMonthlySalary) || 0));

  const employmentType: EmploymentType =
    options?.employmentType ||
    (safeMonthlySalary > 0 && safeHourlyRate === 0
      ? 'FULL_TIME'
      : safeHourlyRate > 0 && safeMonthlySalary === 0
        ? 'PART_TIME'
        : rawContent.employmentType === 'FULL_TIME'
          ? 'FULL_TIME'
          : safeMonthlySalary > 0
            ? 'FULL_TIME'
            : 'PART_TIME');

  const isFullTime = employmentType === 'FULL_TIME' && safeMonthlySalary > 0;
  const standardDays = Math.max(1, Number(rawContent.standardDays) || 26);
  const leaveCount = Math.max(0, Math.min(3, Number(rawContent.leaveCount) || 0));
  const dailySalary =
    safeMonthlySalary > 0
      ? Math.round(safeMonthlySalary / standardDays)
      : Math.round((safeHourlyRate || 25000) * 8);

  const dynamicHourlyRate =
    safeMonthlySalary > 0 && safeHourlyRate === 0
      ? Math.round(dailySalary / 8)
      : safeHourlyRate || 25000;

  const effectiveHourlyRate = safeHourlyRate > 0 ? safeHourlyRate : dynamicHourlyRate;

  const rawDailyDetails = Array.isArray(rawContent.dailyDetails) ? rawContent.dailyDetails : [];
  let recomputedTotalHours = 0;
  let recomputedDaysWorked = 0;
  let recomputedDailySalarySum = 0;
  let recomputedSeniorBonus = 0;

  const sanitizedDailyDetails: PayslipDailyDetail[] = rawDailyDetails.map((d: any) => {
    const hours = Math.max(0, Number(d?.hours) || 0);
    const multiplier = Math.max(0.5, Number(d?.multiplier) || 1);
    const isSenior = Boolean(d?.isSenior);
    const seniorBonus = isSenior ? Math.round(hours * 2000) : 0;
    const daySalary = Math.round(hours * effectiveHourlyRate * multiplier) + seniorBonus;

    if (hours > 0) {
      recomputedTotalHours += hours;
      recomputedDaysWorked += 1;
    }
    recomputedDailySalarySum += daySalary;
    recomputedSeniorBonus += seniorBonus;

    return {
      date: typeof d?.date === 'string' ? d.date : '2026-10-01',
      checkIn: d?.checkIn ?? null,
      checkOut: d?.checkOut ?? null,
      hours: Math.round(hours * 100) / 100,
      salary: daySalary,
      isLate: Boolean(d?.isLate),
      multiplier,
      isValid: d?.isValid !== false,
      shift: sanitizeText(d?.shift || 'Ca tiêu chuẩn', nameMap, brandMap),
      isSenior,
      seniorBonus,
    };
  });

  const totalHours =
    recomputedTotalHours > 0
      ? Math.round(recomputedTotalHours * 100) / 100
      : Number(rawContent.totalHours) || (isFullTime ? 176 : 96);

  const daysWorked =
    recomputedDaysWorked > 0
      ? recomputedDaysWorked
      : Number(rawContent.daysWorked) || (isFullTime ? 24 : 16);

  const deduction = isFullTime ? Math.round(leaveCount * dailySalary) : 0;
  const baseSalary = isFullTime
    ? Math.max(0, Math.round(safeMonthlySalary - deduction))
    : recomputedDailySalarySum > 0
      ? recomputedDailySalarySum
      : Math.round(totalHours * effectiveHourlyRate);

  const rawAdjustments = Array.isArray(rawContent.adjustments) ? rawContent.adjustments : [];
  const sanitizedAdjustments: PayslipAdjustment[] = rawAdjustments.map((adj: any, idx: number) => {
    const isNegative = Number(adj?.amount) < 0;
    const amount = isNegative
      ? -50000
      : DEMO_ADJUSTMENT_AMOUNTS[idx % DEMO_ADJUSTMENT_AMOUNTS.length];
    return {
      id: typeof adj?.id === 'string' ? adj.id : `demo-adj-${idx + 1}`,
      userId: safeUserId,
      amount,
      reason: isNegative
        ? 'Phạt đi trễ ca sáng'
        : DEMO_ADJUSTMENT_REASONS[idx % DEMO_ADJUSTMENT_REASONS.length],
      date: typeof adj?.date === 'string' ? adj.date : '2026-10-01T00:00:00.000Z',
    };
  });

  const totalAdjustments = sanitizedAdjustments.reduce((sum, a) => sum + a.amount, 0);

  const lateCount = Math.max(0, Math.min(5, Number(rawContent.lateCount) || 0));
  const latePenaltyHours = Number(rawContent.latePenaltyHours) || lateCount * 0.5;
  const latePenaltyAmount = Math.round(latePenaltyHours * effectiveHourlyRate);
  const bonusPercent = Math.max(0, Math.min(100, Number(rawContent.bonusPercent) || 0));
  const bonusAmount = Math.round(baseSalary * (bonusPercent / 100));

  const totalSalary = Math.max(
    0,
    Math.round(baseSalary + totalAdjustments - latePenaltyAmount)
  );
  const finalNet = Math.max(0, Math.round(totalSalary + bonusAmount));

  return {
    userId: safeUserId,
    staffName: safeStaffName,
    name: safeStaffName,
    userName: safeStaffName,
    email: safeEmail,
    userEmail: safeEmail,
    employmentType,
    hourlyRate: safeHourlyRate,
    dynamicHourlyRate,
    monthlySalary: safeMonthlySalary,
    standardDays,
    dailySalary,
    leaveCount,
    deduction,
    totalHours,
    totalOvertimeHours: Math.max(0, Math.round((totalHours - 176) * 10) / 10),
    leaderboardOvertimeHours: Math.max(0, Math.round((totalHours - 176) * 10) / 10),
    daysWorked,
    checkinCount: daysWorked * 2,
    baseSalary,
    totalAdjustments,
    lateCount,
    latePenaltyHours,
    latePenaltyAmount,
    totalSeniorBonus: recomputedSeniorBonus,
    bonusPercent,
    bonusAmount,
    totalSalary,
    totalPay: finalNet,
    projectedSalary: finalNet,
    netSalary: finalNet,
    finalNet,
    isThuKpiSalary: false,
    adjustments: sanitizedAdjustments,
    dailyDetails: sanitizedDailyDetails,
  };
}

/**
 * Compatible wrapper matching payslip record sanitizer signature.
 */
export function sanitizePayslipRecord(
  rawPayslip: {
    userId: string;
    month: number;
    year: number;
    content: Record<string, unknown> | string | null | undefined;
    netSalary: number;
    status?: string;
  },
  demoUser: {
    id: string;
    name: string;
    email: string;
    role?: string;
    employmentType: EmploymentType;
    hourlyRate: number;
    monthlySalary: number;
  },
  nameMap?: Map<string, string>
): { content: PayslipJsonPayload; netSalary: number } {
  const content = recomputePayslipJson(
    rawPayslip.content,
    demoUser.hourlyRate,
    demoUser.monthlySalary,
    {
      userId: demoUser.id,
      staffName: demoUser.name,
      email: demoUser.email,
      employmentType: demoUser.employmentType,
      nameMap,
    }
  );
  return {
    content,
    netSalary: content.netSalary,
  };
}
