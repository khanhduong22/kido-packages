import { z } from 'zod';

/**
 * Standard 5-Tier Workforce Categories for Payroll and Shift Management
 */
export const WorkforceCategorySchema = z.enum([
  'ADMIN',       // Leadership / Managers / Board
  'PARTNER',     // Shareholders / External Partners / Affiliates
  'FULL_TIME',   // Permanent full-time staff
  'PART_TIME',   // Hourly / Part-time / Freelance crew
  'RESIGNED',    // Former staff / Inactive / Suspended
]);
export type WorkforceCategoryType = z.infer<typeof WorkforceCategorySchema>;

export interface WorkforceCategoryConfig {
  id: WorkforceCategoryType;
  label: string;
  labelVi: string;
  isCollapsible: boolean;
  defaultExpanded: boolean;
  headerBg: string;
  badgeColor: string;
}

export const WORKFORCE_CATEGORIES: Record<WorkforceCategoryType, WorkforceCategoryConfig> = {
  ADMIN: {
    id: 'ADMIN',
    label: 'Management & Administration',
    labelVi: 'Ban Giám đốc & Quản lý',
    isCollapsible: false,
    defaultExpanded: true,
    headerBg: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    badgeColor: 'amber',
  },
  PARTNER: {
    id: 'PARTNER',
    label: 'Partners & Shareholders',
    labelVi: 'Cổ đông & Đối tác',
    isCollapsible: true,
    defaultExpanded: true,
    headerBg: 'bg-purple-500/10 border-purple-500/20 text-purple-400',
    badgeColor: 'purple',
  },
  FULL_TIME: {
    id: 'FULL_TIME',
    label: 'Full-time Staff',
    labelVi: 'Nhân viên Chính thức',
    isCollapsible: false,
    defaultExpanded: true,
    headerBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    badgeColor: 'emerald',
  },
  PART_TIME: {
    id: 'PART_TIME',
    label: 'Part-time & Freelance Crew',
    labelVi: 'Nhân viên Part-time & Thời vụ',
    isCollapsible: false,
    defaultExpanded: true,
    headerBg: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    badgeColor: 'blue',
  },
  RESIGNED: {
    id: 'RESIGNED',
    label: 'Resigned / Inactive',
    labelVi: 'Nhân viên Đã nghỉ việc / Tạm ngưng',
    isCollapsible: true,
    defaultExpanded: false,
    headerBg: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
    badgeColor: 'slate',
  },
};

export const WorkforceMemberPayrollSchema = z.object({
  id: z.string().min(1, 'Member ID is required'),
  name: z.string().min(1, 'Member name is required'),
  email: z.string().email().optional(),
  role: z.string().optional(),
  employmentType: z.string().optional(),
  isActive: z.boolean().default(true),
  baseSalary: z.number().nonnegative().default(0),
  baseHours: z.number().nonnegative().default(0).optional(),
  overtimeHours: z.number().nonnegative().default(0).optional(),
  allowances: z.number().nonnegative().default(0).optional(),
  bonus: z.number().nonnegative().default(0).optional(),
  deductions: z.number().nonnegative().default(0).optional(),
  netPayout: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WorkforceMemberPayroll = z.infer<typeof WorkforceMemberPayrollSchema>;

export interface WorkforceCategoryTotals {
  headcount: number;
  totalBaseHours: number;
  totalOvertimeHours: number;
  totalBaseSalary: number;
  totalAllowances: number;
  totalBonus: number;
  totalDeductions: number;
  totalNetPayout: number;
}

export interface CategorizedWorkforceGroup {
  category: WorkforceCategoryType;
  config: WorkforceCategoryConfig;
  members: WorkforceMemberPayroll[];
  totals: WorkforceCategoryTotals;
}

export interface CategorizedWorkforcePayroll {
  groups: Record<WorkforceCategoryType, CategorizedWorkforceGroup>;
  orderedGroups: CategorizedWorkforceGroup[];
  grandTotals: WorkforceCategoryTotals;
  activeHeadcount: number;
}

export interface GroupWorkforceOptions {
  includeResignedInGrandTotals?: boolean;
  sortBy?: 'name' | 'netPayout' | 'baseSalary';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Resolves the 5-tier category for a workforce member based on employmentType, role, and active status.
 */
export function resolveWorkforceCategory(
  member: Pick<WorkforceMemberPayroll, 'isActive' | 'role' | 'employmentType'>
): WorkforceCategoryType {
  // If explicitly flagged inactive or employmentType indicates resigned, map to RESIGNED
  if (
    member.isActive === false ||
    member.employmentType?.toUpperCase() === 'RESIGNED' ||
    member.employmentType?.toUpperCase() === 'INACTIVE' ||
    member.employmentType?.toUpperCase() === 'LEFT'
  ) {
    return 'RESIGNED';
  }

  const role = (member.role || '').toUpperCase();
  const empType = (member.employmentType || '').toUpperCase();

  // Admin / Executive level
  if (
    role.includes('ADMIN') ||
    role.includes('DIRECTOR') ||
    role.includes('MANAGER') ||
    role.includes('QUAN_LY') ||
    empType === 'ADMIN' ||
    empType === 'MANAGEMENT'
  ) {
    return 'ADMIN';
  }

  // Partner / Shareholder level
  if (
    role.includes('PARTNER') ||
    role.includes('INVESTOR') ||
    role.includes('CO_DONG') ||
    empType === 'PARTNER' ||
    empType === 'SHAREHOLDER'
  ) {
    return 'PARTNER';
  }

  // Part-time / Freelance / Temporary
  if (
    role.includes('PART_TIME') ||
    role.includes('FREELANCE') ||
    role.includes('SEASONAL') ||
    role.includes('THOI_VU') ||
    empType === 'PART_TIME' ||
    empType === 'FREELANCE' ||
    empType === 'HOURLY'
  ) {
    return 'PART_TIME';
  }

  // Default to FULL_TIME for regular active staff
  return 'FULL_TIME';
}

/**
 * Aggregates payroll totals for a list of workforce members.
 */
export function calculateCategoryTotals(members: WorkforceMemberPayroll[]): WorkforceCategoryTotals {
  let totalBaseHours = 0;
  let totalOvertimeHours = 0;
  let totalBaseSalary = 0;
  let totalAllowances = 0;
  let totalBonus = 0;
  let totalDeductions = 0;
  let totalNetPayout = 0;

  for (const m of members) {
    totalBaseHours += m.baseHours ?? 0;
    totalOvertimeHours += m.overtimeHours ?? 0;
    totalBaseSalary += m.baseSalary ?? 0;
    totalAllowances += m.allowances ?? 0;
    totalBonus += m.bonus ?? 0;
    totalDeductions += m.deductions ?? 0;

    const net =
      typeof m.netPayout === 'number'
        ? m.netPayout
        : (m.baseSalary ?? 0) + (m.allowances ?? 0) + (m.bonus ?? 0) - (m.deductions ?? 0);

    totalNetPayout += net;
  }

  return {
    headcount: members.length,
    totalBaseHours: Number(totalBaseHours.toFixed(2)),
    totalOvertimeHours: Number(totalOvertimeHours.toFixed(2)),
    totalBaseSalary: Math.round(totalBaseSalary),
    totalAllowances: Math.round(totalAllowances),
    totalBonus: Math.round(totalBonus),
    totalDeductions: Math.round(totalDeductions),
    totalNetPayout: Math.round(totalNetPayout),
  };
}

/**
 * Groups an array of workforce members into the 5 standard categories with sub-totals,
 * grand totals, and sort orders.
 */
export function groupWorkforcePayroll(
  rawMembers: WorkforceMemberPayroll[],
  options?: GroupWorkforceOptions
): CategorizedWorkforcePayroll {
  const sortBy = options?.sortBy ?? 'name';
  const sortOrder = options?.sortOrder ?? 'asc';
  const includeResigned = options?.includeResignedInGrandTotals ?? false;

  const buckets: Record<WorkforceCategoryType, WorkforceMemberPayroll[]> = {
    ADMIN: [],
    PARTNER: [],
    FULL_TIME: [],
    PART_TIME: [],
    RESIGNED: [],
  };

  for (const raw of rawMembers) {
    const validated = WorkforceMemberPayrollSchema.parse(raw);
    const category = resolveWorkforceCategory(validated);

    // Compute netPayout if not explicitly provided
    const netPayout =
      typeof validated.netPayout === 'number'
        ? validated.netPayout
        : validated.baseSalary + (validated.allowances ?? 0) + (validated.bonus ?? 0) - (validated.deductions ?? 0);

    buckets[category].push({
      ...validated,
      netPayout,
    });
  }

  // Sort within each bucket
  const sortMultiplier = sortOrder === 'asc' ? 1 : -1;
  const categories: WorkforceCategoryType[] = ['ADMIN', 'PARTNER', 'FULL_TIME', 'PART_TIME', 'RESIGNED'];

  for (const cat of categories) {
    buckets[cat].sort((a, b) => {
      if (sortBy === 'netPayout') {
        return ((a.netPayout ?? 0) - (b.netPayout ?? 0)) * sortMultiplier;
      }
      if (sortBy === 'baseSalary') {
        return (a.baseSalary - b.baseSalary) * sortMultiplier;
      }
      return a.name.localeCompare(b.name, 'vi') * sortMultiplier;
    });
  }

  const groups = {} as Record<WorkforceCategoryType, CategorizedWorkforceGroup>;
  const orderedGroups: CategorizedWorkforceGroup[] = [];

  for (const cat of categories) {
    const list = buckets[cat];
    const totals = calculateCategoryTotals(list);
    const group: CategorizedWorkforceGroup = {
      category: cat,
      config: WORKFORCE_CATEGORIES[cat],
      members: list,
      totals,
    };
    groups[cat] = group;
    orderedGroups.push(group);
  }

  // Calculate Grand Totals
  const eligibleMembers = categories
    .filter((cat) => includeResigned || cat !== 'RESIGNED')
    .flatMap((cat) => buckets[cat]);

  const grandTotals = calculateCategoryTotals(eligibleMembers);
  const activeHeadcount = categories
    .filter((cat) => cat !== 'RESIGNED')
    .reduce((sum, cat) => sum + buckets[cat].length, 0);

  return {
    groups,
    orderedGroups,
    grandTotals,
    activeHeadcount,
  };
}
