import { z } from 'zod';

// ============================================================================
// 1. Enums and Literal Schemas
// ============================================================================

export const TenantPlanSchema = z.enum(['STARTER', 'PROFESSIONAL', 'ENTERPRISE']);
export type TenantPlan = z.infer<typeof TenantPlanSchema>;

export const HierarchyLevelSchema = z.enum([
  'HOLDING',
  'SUB_COMPANY',
  'REGION',
  'BRANCH',
  'FRANCHISEE',
]);
export type HierarchyLevel = z.infer<typeof HierarchyLevelSchema>;

export const RoleSchema = z.enum([
  'HOLDING_ADMIN',
  'CFO',
  'REGION_MANAGER',
  'STORE_MANAGER',
  'CASHIER',
  'WAREHOUSE_STAFF',
  'FRANCHISEE_OWNER',
]);
export type Role = z.infer<typeof RoleSchema>;

export const PermissionActionSchema = z.string().min(1);
export type Permission = string;

// ============================================================================
// 2. Context Schemas
// ============================================================================

export const TimeWindowSchema = z.object({
  open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time format (HH:MM)'),
  close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time format (HH:MM)'),
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const ShiftHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time format (HH:MM)'),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time format (HH:MM)'),
});
export type ShiftHours = z.infer<typeof ShiftHoursSchema>;

export const TenantContextSchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required'),
  tenantName: z.string().min(1, 'tenantName is required'),
  hierarchyLevel: HierarchyLevelSchema.optional().default('BRANCH'),
  subCompanyId: z.string().optional(),
  regionId: z.string().optional(),
  branchId: z.string().optional(),
  plan: TenantPlanSchema.optional().default('ENTERPRISE'),
  isFranchise: z.boolean().optional().default(false),
  franchiseeId: z.string().optional(),
  accessibleBranchIds: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type TenantContext = z.infer<typeof TenantContextSchema>;
export type TenantContextInput = z.input<typeof TenantContextSchema>;

export const BranchContextSchema = z.object({
  branchId: z.string().min(1, 'branchId is required'),
  branchName: z.string().min(1, 'branchName is required'),
  tenantId: z.string().min(1, 'tenantId is required'),
  subCompanyId: z.string().optional(),
  regionId: z.string().optional(),
  isFranchise: z.boolean().optional().default(false),
  franchiseeId: z.string().optional(),
  openingHours: TimeWindowSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type BranchContext = z.infer<typeof BranchContextSchema>;
export type BranchContextInput = z.input<typeof BranchContextSchema>;

export const UserContextSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  role: RoleSchema,
  tenantId: z.string().min(1, 'tenantId is required'),
  email: z.string().email().optional(),
  name: z.string().optional(),
  subCompanyId: z.string().optional(),
  regionId: z.string().optional(),
  branchId: z.string().optional(),
  accessibleBranchIds: z.array(z.string()).optional(),
  isFranchise: z.boolean().optional().default(false),
  franchiseeId: z.string().optional(),
  maxApprovalAmount: z.number().nonnegative().optional(),
  shiftHours: ShiftHoursSchema.optional(),
  customPermissions: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UserContext = z.infer<typeof UserContextSchema>;
export type UserContextInput = z.input<typeof UserContextSchema>;

// ============================================================================
// 3. Resource Attributes & Policy Rules
// ============================================================================

export const ResourceAttributesSchema = z.object({
  tenantId: z.string().optional(),
  branchId: z.string().optional(),
  subCompanyId: z.string().optional(),
  regionId: z.string().optional(),
  franchiseeId: z.string().optional(),
  amount: z.number().optional(),
  timestamp: z.union([z.date(), z.string(), z.number()]).optional(),
  timeWindow: TimeWindowSchema.optional(),
  openingHours: TimeWindowSchema.optional(),
  ownerId: z.string().optional(),
  resourceType: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ResourceAttributes = z.infer<typeof ResourceAttributesSchema>;

export interface PolicyRule {
  id: string;
  description?: string;
  effect: 'ALLOW' | 'DENY';
  roles?: Role[];
  permissions?: Permission[];
  condition?: (
    ctx: UserContext,
    resource?: ResourceAttributes
  ) => boolean | Promise<boolean>;
}

export interface AccessEvaluationResult {
  allowed: boolean;
  reason?: string;
  violations: string[];
}

// ============================================================================
// 4. RLS & SQL Options
// ============================================================================

export interface SqlWhereClauseResult {
  sql: string;
  params: (string | number | boolean)[];
  clause: string;
}

export interface RlsFilterOptions {
  tableName?: string;
  tableAlias?: string;
  tenantColumn?: string;
  branchColumn?: string;
  subCompanyColumn?: string;
  regionColumn?: string;
  franchiseeColumn?: string;
  paramPlaceholder?: (index: number) => string;
  strictFranchiseIsolation?: boolean;
}

export interface OrmFilterOptions {
  tenantField?: string;
  branchField?: string;
  subCompanyField?: string;
  regionField?: string;
  franchiseeField?: string;
  strictFranchiseIsolation?: boolean;
}

// ============================================================================
// 5. Custom Error Hierarchy
// ============================================================================

export class TenantGuardError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'TENANT_GUARD_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TenantContextMissingError extends TenantGuardError {
  constructor(
    message = 'Tenant context is required but was not provided or active in current execution context'
  ) {
    super(message, 'TENANT_CONTEXT_MISSING');
  }
}

export class CrossTenantAccessViolationError extends TenantGuardError {
  public readonly currentTenantId?: string;
  public readonly targetTenantId?: string;

  constructor(
    message: string,
    currentTenantId?: string,
    targetTenantId?: string
  ) {
    super(message, 'CROSS_TENANT_ACCESS_VIOLATION');
    this.currentTenantId = currentTenantId;
    this.targetTenantId = targetTenantId;
  }
}

export class PermissionDeniedError extends TenantGuardError {
  public readonly permission: string;
  public readonly role?: Role;
  public readonly violations: string[];

  constructor(
    permission: string,
    violations: string[] = [],
    role?: Role,
    message?: string
  ) {
    super(
      message ||
        `Access denied for permission '${permission}'. Violations: ${violations.join(', ') || 'Insufficient privileges'}`,
      'PERMISSION_DENIED'
    );
    this.permission = permission;
    this.role = role;
    this.violations = violations;
  }
}

export class SecurityViolationError extends TenantGuardError {
  constructor(message: string) {
    super(message, 'SECURITY_VIOLATION');
  }
}
