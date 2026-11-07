import { AsyncLocalStorage } from 'node:async_hooks';
import {
  TenantContext,
  TenantContextInput,
  TenantContextSchema,
  UserContext,
  UserContextInput,
  UserContextSchema,
  TenantContextMissingError,
  HierarchyLevel,
} from './types';

// ============================================================================
// AsyncLocalStorage instances for Thread-safe Context Propagation
// ============================================================================

const tenantStorage = new AsyncLocalStorage<TenantContext>();
const userStorage = new AsyncLocalStorage<UserContext>();

/**
 * Runs a function within the scope of a given TenantContext.
 * Automatically propagates through async calls, promises, and timers.
 */
export function runWithTenantContext<T>(
  ctx: TenantContextInput,
  fn: () => T
): T {
  const validated = TenantContextSchema.parse(ctx);
  return tenantStorage.run(Object.freeze({ ...validated }), fn);
}

/**
 * Retrieves the currently active TenantContext from AsyncLocalStorage.
 * Returns undefined if no context is active.
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

/**
 * Retrieves the active TenantContext or throws TenantContextMissingError.
 */
export function requireTenantContext(): TenantContext {
  const ctx = getTenantContext();
  if (!ctx) {
    throw new TenantContextMissingError(
      'Operation rejected: active TenantContext is required but not found in execution scope'
    );
  }
  return ctx;
}

/**
 * Runs a function within the scope of a given UserContext.
 */
export function runWithUserContext<T>(
  ctx: UserContextInput,
  fn: () => T
): T {
  const validated = UserContextSchema.parse(ctx);
  return userStorage.run(Object.freeze({ ...validated }), fn);
}

/**
 * Retrieves the currently active UserContext.
 */
export function getUserContext(): UserContext | undefined {
  return userStorage.getStore();
}

/**
 * Retrieves the active UserContext or throws TenantContextMissingError.
 */
export function requireUserContext(): UserContext {
  const ctx = getUserContext();
  if (!ctx) {
    throw new TenantContextMissingError(
      'Operation rejected: active UserContext is required but not found in execution scope'
    );
  }
  return ctx;
}

/**
 * Runs a function within both TenantContext and UserContext.
 */
export function runWithTenantAndUserContext<T>(
  tenantCtx: TenantContextInput,
  userCtx: UserContextInput,
  fn: () => T
): T {
  const validatedTenant = TenantContextSchema.parse(tenantCtx);
  const validatedUser = UserContextSchema.parse(userCtx);

  return tenantStorage.run(Object.freeze({ ...validatedTenant }), () => {
    return userStorage.run(Object.freeze({ ...validatedUser }), fn);
  });
}

// ============================================================================
// Multi-Tier Hierarchy Inspection Helpers
// ============================================================================

/**
 * Checks if the context corresponds to the top-level Holding corporation.
 */
export function isHoldingLevel(ctx: TenantContext | UserContext): boolean {
  if ('hierarchyLevel' in ctx && ctx.hierarchyLevel === 'HOLDING') {
    return true;
  }
  if ('role' in ctx && (ctx.role === 'HOLDING_ADMIN' || ctx.role === 'CFO')) {
    return true;
  }
  return false;
}

/**
 * Checks if the context belongs to a franchise entity.
 */
export function isFranchiseTenant(ctx: TenantContext | UserContext): boolean {
  if (ctx.isFranchise) {
    return true;
  }
  if ('hierarchyLevel' in ctx && ctx.hierarchyLevel === 'FRANCHISEE') {
    return true;
  }
  if ('role' in ctx && ctx.role === 'FRANCHISEE_OWNER') {
    return true;
  }
  return false;
}

/**
 * Validates if the given context has permission to access a specific target branch.
 */
export function canAccessBranch(
  ctx: TenantContext | UserContext,
  targetBranchId: string
): boolean {
  if (!targetBranchId) return false;

  // Holding Level and CFO have global access to all branches
  if (isHoldingLevel(ctx)) {
    return true;
  }

  // Check explicit accessible branches list
  if (ctx.accessibleBranchIds && ctx.accessibleBranchIds.length > 0) {
    return ctx.accessibleBranchIds.includes(targetBranchId);
  }

  // Branch level direct match
  if (ctx.branchId) {
    return ctx.branchId === targetBranchId;
  }

  return false;
}

/**
 * Returns the effective hierarchy level for context analysis.
 */
export function getHierarchyLevel(ctx: TenantContext | UserContext): HierarchyLevel {
  if ('hierarchyLevel' in ctx && ctx.hierarchyLevel) {
    return ctx.hierarchyLevel;
  }
  if ('role' in ctx) {
    switch (ctx.role) {
      case 'HOLDING_ADMIN':
      case 'CFO':
        return 'HOLDING';
      case 'REGION_MANAGER':
        return 'REGION';
      case 'FRANCHISEE_OWNER':
        return 'FRANCHISEE';
      default:
        return 'BRANCH';
    }
  }
  return 'BRANCH';
}
