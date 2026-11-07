import { getTenantContext } from './tenant-context';

// ============================================================================
// Prisma ORM Query Interceptor & Valkey/Redis Cache Namespace Isolation
// ============================================================================

export const DEFAULT_PRISMA_READ_FILTER_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

export interface PrismaTenantInterceptorOptions {
  /**
   * Explicit tenant ID override. If omitted, resolves from `resolveTenantId()` or active `getTenantContext()?.tenantId`.
   */
  tenantId?: string;
  /**
   * Default tenant ID that bypasses filter injection when `enforceIsolation` is false/omitted.
   * Defaults to `'default'`.
   */
  defaultTenantId?: string;
  /**
   * When true, forces `tenantId` injection even for the default tenant.
   */
  enforceIsolation?: boolean;
  /**
   * Set or array of Prisma model names that have a `tenantId` column.
   * If omitted, all provided model names are treated as tenant-scoped.
   */
  scopedModels?: ReadonlySet<string> | Set<string> | readonly string[];
  /**
   * Custom tenant column field name in Prisma models. Defaults to `'tenantId'`.
   */
  tenantField?: string;
  /**
   * Optional callback to dynamically resolve the current tenant ID (e.g., from a custom AsyncLocalStorage).
   */
  resolveTenantId?: () => string | undefined;
}

export interface PrismaOperationContext {
  model?: string;
  operation: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (args: Record<string, any>) => Promise<any>;
}

export interface TenantCacheKeyOptions {
  /**
   * Explicit tenant ID. If omitted, resolves from `resolveTenantId()` or active `getTenantContext()?.tenantId`.
   */
  tenantId?: string;
  /**
   * Default tenant ID that uses unprefixed legacy cache keys. Defaults to `'default'`.
   */
  defaultTenantId?: string;
  /**
   * Optional callback to resolve the active tenant ID.
   */
  resolveTenantId?: () => string | undefined;
}

function isModelInScope(
  model: string | undefined,
  scopedModels?: ReadonlySet<string> | Set<string> | readonly string[]
): boolean {
  if (!model) {
    return false;
  }
  if (!scopedModels) {
    return true;
  }
  if (scopedModels instanceof Set) {
    return scopedModels.has(model);
  }
  if (Array.isArray(scopedModels)) {
    return scopedModels.includes(model);
  }
  return (scopedModels as ReadonlySet<string>).has(model);
}

function resolveEffectiveTenantId(options?: {
  tenantId?: string;
  defaultTenantId?: string;
  resolveTenantId?: () => string | undefined;
}): { tenantId: string; defaultTenantId: string } {
  const defaultTenantId = options?.defaultTenantId ?? 'default';
  const rawTenantId =
    options?.tenantId ??
    options?.resolveTenantId?.() ??
    getTenantContext()?.tenantId ??
    defaultTenantId;
  const normalized = rawTenantId.trim();
  return {
    tenantId: normalized.length > 0 ? normalized : defaultTenantId,
    defaultTenantId,
  };
}

/**
 * Pure helper that automatically injects `where.tenantId` for read/update/delete operations
 * (`findMany`, `findFirst`, `count`, `aggregate`, `groupBy`, `updateMany`, `deleteMany`)
 * and `data.tenantId` for `create` / `createMany`.
 *
 * Preserves reference equality on `args` for the default tenant when `enforceIsolation` is false
 * so existing unit test spies do not break.
 */
export function injectPrismaTenantArgs(
  model: string | undefined,
  operation: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any> = {},
  options?: PrismaTenantInterceptorOptions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!isModelInScope(model, options?.scopedModels)) {
    return args;
  }

  const { tenantId, defaultTenantId } = resolveEffectiveTenantId(options);
  const shouldInject =
    options?.enforceIsolation === true || tenantId !== defaultTenantId;

  if (!shouldInject) {
    return args;
  }

  const tenantField = options?.tenantField ?? 'tenantId';

  if (DEFAULT_PRISMA_READ_FILTER_OPERATIONS.has(operation)) {
    const existingWhere =
      args.where && typeof args.where === 'object' ? args.where : {};
    return {
      ...args,
      where: {
        ...existingWhere,
        [tenantField]: existingWhere[tenantField] ?? tenantId,
      },
    };
  }

  if (operation === 'create') {
    const existingData =
      args.data && typeof args.data === 'object' ? args.data : {};
    return {
      ...args,
      data: {
        ...existingData,
        [tenantField]: existingData[tenantField] ?? tenantId,
      },
    };
  }

  if (operation === 'createMany') {
    if (Array.isArray(args.data)) {
      return {
        ...args,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: args.data.map((item: Record<string, any>) => ({
          ...item,
          [tenantField]: item[tenantField] ?? tenantId,
        })),
      };
    }
    if (args.data && typeof args.data === 'object') {
      return {
        ...args,
        data: {
          ...args.data,
          [tenantField]: args.data[tenantField] ?? tenantId,
        },
      };
    }
  }

  return args;
}

/**
 * Returns a ready-to-use configuration object for `prisma.$extends(...)`
 * that intercepts `$allModels.$allOperations` and injects tenant filters automatically.
 */
export function createPrismaTenantExtensionConfig(
  options?: PrismaTenantInterceptorOptions
) {
  return {
    name: 'kt-tenant-guard-prisma-extension',
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: PrismaOperationContext) {
          const scopedArgs = injectPrismaTenantArgs(
            model,
            operation,
            args ?? {},
            options
          );
          return query(scopedArgs);
        },
      },
    },
  };
}

/**
 * Automatically prefixes Valkey/Redis cache keys with `tenant:{tenantId}:{key}`
 * for non-default tenants while avoiding double-prefixing if already prefixed.
 */
export function prefixTenantCacheKey(
  key: string,
  options?: TenantCacheKeyOptions
): string {
  if (!key || key.startsWith('tenant:')) {
    return key;
  }
  const { tenantId, defaultTenantId } = resolveEffectiveTenantId(options);
  if (!tenantId || tenantId === defaultTenantId) {
    return key;
  }
  return `tenant:${tenantId}:${key}`;
}

/**
 * Builds a tenant-scoped Valkey/Redis SCAN/KEYS pattern (e.g. `tenant:demo:shifts:*`).
 */
export function buildTenantCachePattern(
  pattern: string,
  options?: TenantCacheKeyOptions
): string {
  const normalizedPattern = pattern && pattern.trim().length > 0 ? pattern : '*';
  return prefixTenantCacheKey(normalizedPattern, options);
}
