import {
  Role,
  Permission,
  UserContext,
  ResourceAttributes,
  PolicyRule,
  AccessEvaluationResult,
} from './types';
import { canAccessBranch, isFranchiseTenant } from './tenant-context';

// ============================================================================
// Default RBAC Permissions per Role
// ============================================================================

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, string[]> = {
  HOLDING_ADMIN: ['*'],
  CFO: [
    'tenant:read',
    'financial:read',
    'financial:export',
    'financial:approve',
    'order:read',
    'order:discount',
    'order:cancel',
    'order:refund',
    'report:holding',
    'report:region',
    'report:branch',
    'branch:read',
    'inventory:read',
  ],
  REGION_MANAGER: [
    'region:read',
    'region:write',
    'branch:read',
    'order:read',
    'order:create',
    'order:update',
    'order:discount',
    'order:cancel',
    'inventory:read',
    'inventory:adjust',
    'inventory:transfer',
    'report:region',
    'report:branch',
  ],
  STORE_MANAGER: [
    'branch:read',
    'order:read',
    'order:create',
    'order:update',
    'order:discount',
    'order:cancel',
    'order:refund',
    'inventory:read',
    'inventory:adjust',
    'inventory:transfer',
    'report:branch',
  ],
  CASHIER: [
    'order:read',
    'order:create',
    'order:update',
  ],
  WAREHOUSE_STAFF: [
    'inventory:read',
    'inventory:adjust',
    'inventory:transfer',
  ],
  FRANCHISEE_OWNER: [
    'branch:read',
    'order:read',
    'order:create',
    'order:update',
    'order:discount',
    'order:cancel',
    'inventory:read',
    'inventory:adjust',
    'report:branch',
  ],
};

// ============================================================================
// Default Approval Budget Thresholds (VND)
// ============================================================================

export const DEFAULT_MAX_APPROVAL_AMOUNTS: Record<Role, number> = {
  HOLDING_ADMIN: Number.POSITIVE_INFINITY,
  CFO: Number.POSITIVE_INFINITY,
  REGION_MANAGER: 5_000_000,
  STORE_MANAGER: 1_000_000,
  FRANCHISEE_OWNER: 2_000_000,
  CASHIER: 0,
  WAREHOUSE_STAFF: 0,
};

// Actions that mutate financials or alter revenue
const FINANCIAL_APPROVAL_ACTIONS = new Set([
  'order:discount',
  'order:cancel',
  'order:refund',
  'financial:approve',
]);

// ============================================================================
// Time Window Utilities
// ============================================================================

function toMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

export function extractTimeString(ts: Date | string | number): string {
  if (typeof ts === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(ts)) {
    return ts;
  }
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function isTimeWithinWindow(
  timeStr: string,
  window: { start: string; end: string }
): boolean {
  const target = toMinutes(timeStr);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);

  if (start <= end) {
    // Normal same-day window (e.g. 08:00 -> 22:00)
    return target >= start && target <= end;
  }
  // Cross-midnight window (e.g. 22:00 -> 06:00)
  return target >= start || target <= end;
}

// ============================================================================
// Permission Matcher (Exact & Wildcards)
// ============================================================================

export function matchPermission(assignedPerm: string, targetPerm: string): boolean {
  if (assignedPerm === '*' || assignedPerm === targetPerm) {
    return true;
  }
  if (assignedPerm.endsWith(':*')) {
    const prefix = assignedPerm.slice(0, -2);
    return targetPerm.startsWith(`${prefix}:`);
  }
  return false;
}

/**
 * Checks whether user's role and custom permissions satisfy the target permission.
 */
export function hasRbacPermission(user: UserContext, targetPermission: Permission): boolean {
  const rolePerms = DEFAULT_ROLE_PERMISSIONS[user.role] || [];
  const customPerms = user.customPermissions || [];
  const allPerms = [...rolePerms, ...customPerms];

  return allPerms.some((perm) => matchPermission(perm, targetPermission));
}

// ============================================================================
// Policy Evaluation Engine (RBAC + ABAC)
// ============================================================================

export function evaluatePolicy(
  user: UserContext,
  permission: Permission,
  resource?: ResourceAttributes,
  customRules?: PolicyRule[]
): AccessEvaluationResult {
  const violations: string[] = [];

  // --------------------------------------------------------------------------
  // Step 1: RBAC Role & Permission Verification
  // --------------------------------------------------------------------------
  if (!hasRbacPermission(user, permission)) {
    return {
      allowed: false,
      reason: 'RBAC_PERMISSION_NOT_GRANTED',
      violations: [`Role '${user.role}' lacks assigned permission '${permission}'`],
    };
  }

  // --------------------------------------------------------------------------
  // Step 2: ABAC Dynamic Context Attributes Verification
  // --------------------------------------------------------------------------

  // A. Cross-Tenant Isolation
  if (resource?.tenantId && resource.tenantId !== user.tenantId) {
    violations.push(
      `Cross-tenant access forbidden: user tenant '${user.tenantId}' cannot access resource tenant '${resource.tenantId}'`
    );
  }

  // B. Branch Lock Guard
  if (resource?.branchId) {
    if (!canAccessBranch(user, resource.branchId)) {
      violations.push(
        `Branch lock violation: resource branch '${resource.branchId}' is outside user permitted branch scope`
      );
    }
  }

  // C. Franchisee Isolation & Confidentiality Guard
  if (isFranchiseTenant(user)) {
    if (resource?.franchiseeId && user.franchiseeId && resource.franchiseeId !== user.franchiseeId) {
      violations.push(
        `Cross-franchisee violation: cannot access data of another franchisee '${resource.franchiseeId}'`
      );
    }
    if (
      resource?.resourceType === 'HOLDING_CONFIDENTIAL' ||
      permission.startsWith('report:holding') ||
      permission.startsWith('financial:export')
    ) {
      violations.push(
        'Franchisee prohibited from accessing holding confidential resources or consolidated financial reports'
      );
    }
  }

  // D. Approval Budget & Financial Threshold Guard
  if (resource?.amount !== undefined && resource.amount !== null) {
    const isApprovalAction = FINANCIAL_APPROVAL_ACTIONS.has(permission);
    if (isApprovalAction) {
      const maxAllowed =
        user.maxApprovalAmount !== undefined
          ? user.maxApprovalAmount
          : (DEFAULT_MAX_APPROVAL_AMOUNTS[user.role] ?? 0);

      if (resource.amount > maxAllowed) {
        violations.push(
          `Approval limit exceeded: requested amount ${resource.amount.toLocaleString()} exceeds user approval threshold ${maxAllowed.toLocaleString()} (escalation required)`
        );
      }
    }
  }

  // E. Time Window / Operating Shift Guard (evaluated when execution timestamp is provided)
  if (resource?.timestamp !== undefined) {
    const targetTimeStr = extractTimeString(resource.timestamp);

    // 1. User shift hours constraint
    if (user.shiftHours && !isTimeWithinWindow(targetTimeStr, user.shiftHours)) {
      violations.push(
        `Time window violation: current time '${targetTimeStr}' is outside permitted shift hours [${user.shiftHours.start} - ${user.shiftHours.end}]`
      );
    }

    // 2. Branch opening hours constraint
    const branchWindow = resource.openingHours || resource.timeWindow;
    if (
      branchWindow &&
      !isTimeWithinWindow(targetTimeStr, {
        start: branchWindow.open,
        end: branchWindow.close,
      })
    ) {
      violations.push(
        `Time window violation: operation time '${targetTimeStr}' is outside store opening hours [${branchWindow.open} - ${branchWindow.close}]`
      );
    }
  }

  // F. Custom Dynamic Rules
  if (customRules && customRules.length > 0) {
    for (const rule of customRules) {
      const roleMatches = !rule.roles || rule.roles.includes(user.role);
      const permMatches =
        !rule.permissions ||
        rule.permissions.some((p) => matchPermission(p, permission));

      if (roleMatches && permMatches && rule.condition) {
        const conditionResult = rule.condition(user, resource);
        if (rule.effect === 'ALLOW' && !conditionResult) {
          violations.push(rule.description || `Rule condition failed for rule: ${rule.id}`);
        } else if (rule.effect === 'DENY' && conditionResult) {
          violations.push(rule.description || `Denied by policy rule: ${rule.id}`);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Step 3: Consolidated Result
  // --------------------------------------------------------------------------
  if (violations.length > 0) {
    return {
      allowed: false,
      reason: 'ABAC_CONSTRAINT_FAILED',
      violations,
    };
  }

  return {
    allowed: true,
    violations: [],
  };
}
