import {
  TenantContext,
  UserContext,
  RlsFilterOptions,
  OrmFilterOptions,
  SqlWhereClauseResult,
  CrossTenantAccessViolationError,
  SecurityViolationError,
} from './types';
import { isHoldingLevel, isFranchiseTenant, canAccessBranch, getHierarchyLevel } from './tenant-context';

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates that an SQL identifier (table, alias, column) is safe against SQL injection.
 */
function sanitizeIdentifier(name: string, type: string): string {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new SecurityViolationError(
      `Invalid SQL ${type} identifier: '${name}'. Must be alphanumeric and start with letter or underscore.`
    );
  }
  return name;
}

/**
 * Builds a Row-Level Security (RLS) SQL WHERE clause based on the tenant/user context.
 * Guarantees zero cross-tenant and cross-franchise data leakage.
 */
export function buildTenantWhereClause(
  context: TenantContext | UserContext,
  options: RlsFilterOptions = {}
): SqlWhereClauseResult {
  if (!context || !context.tenantId) {
    throw new SecurityViolationError(
      'Tenant context with valid tenantId is strictly required to build RLS filter'
    );
  }

  const tenantCol = sanitizeIdentifier(options.tenantColumn || 'tenant_id', 'column');
  const branchCol = sanitizeIdentifier(options.branchColumn || 'branch_id', 'column');
  const regionCol = sanitizeIdentifier(options.regionColumn || 'region_id', 'column');
  const franchiseeCol = sanitizeIdentifier(options.franchiseeColumn || 'franchisee_id', 'column');

  let prefix = '';
  if (options.tableAlias) {
    prefix = `${sanitizeIdentifier(options.tableAlias, 'table alias')}.`;
  } else if (options.tableName) {
    prefix = `${sanitizeIdentifier(options.tableName, 'table name')}.`;
  }

  const placeholderFn = options.paramPlaceholder || (() => '?');
  const sqlParts: string[] = [];
  const params: (string | number | boolean)[] = [];

  const addCondition = (column: string, operator: '=' | 'IN', value: string | string[]) => {
    if (operator === '=') {
      const ph = placeholderFn(params.length + 1);
      sqlParts.push(`${prefix}${column} = ${ph}`);
      params.push(value as string);
    } else if (operator === 'IN') {
      const arr = Array.isArray(value) ? value : [value];
      if (arr.length === 0) {
        sqlParts.push('1 = 0');
      } else if (arr.length === 1) {
        const ph = placeholderFn(params.length + 1);
        sqlParts.push(`${prefix}${column} = ${ph}`);
        params.push(arr[0]);
      } else {
        const placeholders = arr.map((_, i) => placeholderFn(params.length + 1 + i)).join(', ');
        sqlParts.push(`${prefix}${column} IN (${placeholders})`);
        params.push(...arr);
      }
    }
  };

  // 1. Mandatory Root Isolation: tenant_id = ?
  addCondition(tenantCol, '=', context.tenantId);

  const level = getHierarchyLevel(context);
  const isFranchise = isFranchiseTenant(context);

  // 2. Franchisee Isolation Gate
  if (isFranchise) {
    if (context.franchiseeId) {
      addCondition(franchiseeCol, '=', context.franchiseeId);
    }

    if (context.branchId) {
      addCondition(branchCol, '=', context.branchId);
    } else if (context.accessibleBranchIds && context.accessibleBranchIds.length > 0) {
      addCondition(branchCol, 'IN', context.accessibleBranchIds);
    } else {
      // Franchisee without designated branch must not see everything
      sqlParts.push('1 = 0');
    }
  } else if (isHoldingLevel(context)) {
    // Holding Admin / CFO: Scope is entire tenant across all branches
    // If an explicit branch filter was requested in accessibleBranchIds with single item:
    if (context.branchId) {
      addCondition(branchCol, '=', context.branchId);
    }
  } else if (level === 'REGION') {
    // Region level manager
    if (context.accessibleBranchIds && context.accessibleBranchIds.length > 0) {
      addCondition(branchCol, 'IN', context.accessibleBranchIds);
    } else if (context.regionId) {
      addCondition(regionCol, '=', context.regionId);
    } else if (context.branchId) {
      addCondition(branchCol, '=', context.branchId);
    } else {
      sqlParts.push('1 = 0');
    }
  } else {
    // Branch Level (Store Manager, Cashier, Warehouse Staff)
    if (context.branchId) {
      addCondition(branchCol, '=', context.branchId);
    } else if (context.accessibleBranchIds && context.accessibleBranchIds.length > 0) {
      addCondition(branchCol, 'IN', context.accessibleBranchIds);
    } else {
      // Fail-safe protection: Reject unassigned branch accounts
      sqlParts.push('1 = 0');
    }
  }

  const sql = sqlParts.join(' AND ');
  const clause = `WHERE ${sql}`;

  return { sql, params, clause };
}

/**
 * Builds an ORM-compatible filter object (Prisma, MikroORM, TypeORM, Drizzle).
 */
export function buildTenantOrmFilter(
  context: TenantContext | UserContext,
  options: OrmFilterOptions = {}
): Record<string, unknown> {
  if (!context || !context.tenantId) {
    throw new SecurityViolationError(
      'Tenant context with valid tenantId is strictly required to build ORM filter'
    );
  }

  const tenantField = options.tenantField || 'tenantId';
  const branchField = options.branchField || 'branchId';
  const regionField = options.regionField || 'regionId';
  const franchiseeField = options.franchiseeField || 'franchiseeId';

  const filter: Record<string, unknown> = {
    [tenantField]: context.tenantId,
  };

  const level = getHierarchyLevel(context);
  const isFranchise = isFranchiseTenant(context);

  if (isFranchise) {
    if (context.franchiseeId) {
      filter[franchiseeField] = context.franchiseeId;
    }
    if (context.branchId) {
      filter[branchField] = context.branchId;
    } else if (context.accessibleBranchIds && context.accessibleBranchIds.length > 0) {
      filter[branchField] =
        context.accessibleBranchIds.length === 1
          ? context.accessibleBranchIds[0]
          : { in: context.accessibleBranchIds };
    } else {
      filter[branchField] = '__NO_BRANCH_ACCESS__';
    }
  } else if (isHoldingLevel(context)) {
    if (context.branchId) {
      filter[branchField] = context.branchId;
    }
  } else if (level === 'REGION') {
    if (context.accessibleBranchIds && context.accessibleBranchIds.length > 0) {
      filter[branchField] =
        context.accessibleBranchIds.length === 1
          ? context.accessibleBranchIds[0]
          : { in: context.accessibleBranchIds };
    } else if (context.regionId) {
      filter[regionField] = context.regionId;
    } else if (context.branchId) {
      filter[branchField] = context.branchId;
    } else {
      filter[branchField] = '__NO_REGION_ACCESS__';
    }
  } else {
    // Branch level
    if (context.branchId) {
      filter[branchField] = context.branchId;
    } else if (context.accessibleBranchIds && context.accessibleBranchIds.length > 0) {
      filter[branchField] =
        context.accessibleBranchIds.length === 1
          ? context.accessibleBranchIds[0]
          : { in: context.accessibleBranchIds };
    } else {
      filter[branchField] = '__NO_BRANCH_ACCESS__';
    }
  }

  return filter;
}

/**
 * Asserts that the caller context can access a specific target entity.
 * Throws CrossTenantAccessViolationError if any boundary is breached.
 */
export function assertTenantIsolation(
  currentCtx: TenantContext | UserContext,
  targetEntity: {
    tenantId?: string;
    branchId?: string;
    franchiseeId?: string;
  }
): void {
  if (!currentCtx || !currentCtx.tenantId) {
    throw new SecurityViolationError('Current context must contain a valid tenantId');
  }

  // 1. Cross-Tenant Boundary
  if (targetEntity.tenantId && targetEntity.tenantId !== currentCtx.tenantId) {
    throw new CrossTenantAccessViolationError(
      `Cross-tenant access forbidden: current tenant '${currentCtx.tenantId}' cannot access resource belonging to tenant '${targetEntity.tenantId}'`,
      currentCtx.tenantId,
      targetEntity.tenantId
    );
  }

  // 2. Cross-Franchisee Boundary
  if (isFranchiseTenant(currentCtx)) {
    if (
      currentCtx.franchiseeId &&
      targetEntity.franchiseeId &&
      currentCtx.franchiseeId !== targetEntity.franchiseeId
    ) {
      throw new CrossTenantAccessViolationError(
        `Cross-franchisee access violation: franchisee '${currentCtx.franchiseeId}' cannot access data of franchisee '${targetEntity.franchiseeId}'`,
        currentCtx.tenantId,
        targetEntity.tenantId
      );
    }
  }

  // 3. Cross-Branch Boundary
  if (targetEntity.branchId) {
    if (!canAccessBranch(currentCtx, targetEntity.branchId)) {
      throw new CrossTenantAccessViolationError(
        `Cross-branch access violation: branch '${targetEntity.branchId}' is outside caller scope`,
        currentCtx.tenantId,
        targetEntity.tenantId
      );
    }
  }
}
