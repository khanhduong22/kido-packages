import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithTenantContext,
  getTenantContext,
  requireTenantContext,
  runWithUserContext,
  getUserContext,
  requireUserContext,
  runWithTenantAndUserContext,
  buildTenantWhereClause,
  buildTenantOrmFilter,
  assertTenantIsolation,
  evaluatePolicy,
  canAccess,
  assertAccess,
  guardPermission,
  protectFunction,
  TenantContextMissingError,
  CrossTenantAccessViolationError,
  PermissionDeniedError,
  SecurityViolationError,
  TenantContext,
  UserContext,
  injectPrismaTenantArgs,
  createPrismaTenantExtensionConfig,
  prefixTenantCacheKey,
  buildTenantCachePattern,
} from './index';

describe('@kido/tenant-guard Test Suite', () => {
  // Mock Tenant Contexts
  const HOLDING_TENANT: TenantContext = {
    tenantId: 'holding-corp-001',
    tenantName: 'Golden Gate Holding Corp',
    hierarchyLevel: 'HOLDING',
    plan: 'ENTERPRISE',
    isFranchise: false,
  };

  const REGION_TENANT: TenantContext = {
    tenantId: 'holding-corp-001',
    tenantName: 'South Region Operations',
    hierarchyLevel: 'REGION',
    regionId: 'region-south',
    accessibleBranchIds: ['branch-hcm-01', 'branch-hcm-02', 'branch-hcm-03'],
    plan: 'ENTERPRISE',
    isFranchise: false,
  };

  const BRANCH_TENANT: TenantContext = {
    tenantId: 'holding-corp-001',
    tenantName: 'District 1 Flagship Store',
    hierarchyLevel: 'BRANCH',
    regionId: 'region-south',
    branchId: 'branch-hcm-01',
    plan: 'ENTERPRISE',
    isFranchise: false,
  };

  const FRANCHISE_TENANT_A: TenantContext = {
    tenantId: 'holding-corp-001',
    tenantName: 'Franchise Partner An Phu',
    hierarchyLevel: 'FRANCHISEE',
    franchiseeId: 'franchise-an-phu',
    branchId: 'branch-fc-anphu',
    plan: 'PROFESSIONAL',
    isFranchise: true,
  };

  const OTHER_TENANT: TenantContext = {
    tenantId: 'rival-enterprise-999',
    tenantName: 'Rival FastFood Group',
    hierarchyLevel: 'HOLDING',
    plan: 'ENTERPRISE',
    isFranchise: false,
  };

  // Mock User Contexts
  const HOLDING_ADMIN_USER: UserContext = {
    userId: 'user-holding-admin',
    role: 'HOLDING_ADMIN',
    tenantId: 'holding-corp-001',
    email: 'admin@goldengate.vn',
    isFranchise: false,
  };

  const CFO_USER: UserContext = {
    userId: 'user-cfo-01',
    role: 'CFO',
    tenantId: 'holding-corp-001',
    email: 'cfo@goldengate.vn',
    maxApprovalAmount: 500_000_000, // 500M VND
    isFranchise: false,
  };

  const REGION_MANAGER_USER: UserContext = {
    userId: 'user-rm-south',
    role: 'REGION_MANAGER',
    tenantId: 'holding-corp-001',
    regionId: 'region-south',
    accessibleBranchIds: ['branch-hcm-01', 'branch-hcm-02', 'branch-hcm-03'],
    isFranchise: false,
  };

  const STORE_MANAGER_USER: UserContext = {
    userId: 'user-sm-d1',
    role: 'STORE_MANAGER',
    tenantId: 'holding-corp-001',
    branchId: 'branch-hcm-01',
    maxApprovalAmount: 1_000_000, // 1M VND
    shiftHours: { start: '07:30', end: '22:30' },
    isFranchise: false,
  };

  const CASHIER_USER: UserContext = {
    userId: 'user-cashier-01',
    role: 'CASHIER',
    tenantId: 'holding-corp-001',
    branchId: 'branch-hcm-01',
    shiftHours: { start: '08:00', end: '16:00' },
    isFranchise: false,
  };

  const WAREHOUSE_USER: UserContext = {
    userId: 'user-wh-01',
    role: 'WAREHOUSE_STAFF',
    tenantId: 'holding-corp-001',
    branchId: 'branch-hcm-01',
    isFranchise: false,
  };

  const FRANCHISE_OWNER_USER: UserContext = {
    userId: 'user-fc-owner',
    role: 'FRANCHISEE_OWNER',
    tenantId: 'holding-corp-001',
    franchiseeId: 'franchise-an-phu',
    branchId: 'branch-fc-anphu',
    isFranchise: true,
  };

  // ==========================================================================
  // 1. AsyncLocalStorage Tenant Context Propagation
  // ==========================================================================
  describe('AsyncLocalStorage Tenant & User Context', () => {
    it('should propagate TenantContext automatically across async call stack', async () => {
      assert.strictEqual(getTenantContext(), undefined);

      await runWithTenantContext(BRANCH_TENANT, async () => {
        assert.deepStrictEqual(getTenantContext(), BRANCH_TENANT);
        assert.strictEqual(requireTenantContext().branchId, 'branch-hcm-01');

        // Nested async promise
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(getTenantContext()?.tenantId, 'holding-corp-001');

        // Deep nested function call
        const fetchBranchInfo = async () => {
          const ctx = requireTenantContext();
          return `${ctx.tenantName} - ${ctx.branchId}`;
        };
        const result = await fetchBranchInfo();
        assert.strictEqual(result, 'District 1 Flagship Store - branch-hcm-01');
      });

      // Context must be restored after execution
      assert.strictEqual(getTenantContext(), undefined);
    });

    it('should throw TenantContextMissingError when context is required but absent', () => {
      assert.throws(
        () => requireTenantContext(),
        (err: Error) => {
          assert.ok(err instanceof TenantContextMissingError);
          assert.strictEqual(err.code, 'TENANT_CONTEXT_MISSING');
          return true;
        }
      );
    });

    it('should propagate both TenantContext and UserContext seamlessly', async () => {
      await runWithTenantAndUserContext(HOLDING_TENANT, CFO_USER, async () => {
        const tenant = requireTenantContext();
        const user = requireUserContext();

        assert.strictEqual(tenant.tenantId, 'holding-corp-001');
        assert.strictEqual(tenant.hierarchyLevel, 'HOLDING');
        assert.strictEqual(user.role, 'CFO');
        assert.strictEqual(user.email, 'cfo@goldengate.vn');
      });

      assert.strictEqual(getTenantContext(), undefined);
      assert.strictEqual(getUserContext(), undefined);
    });
  });

  // ==========================================================================
  // 2. RLS SQL Where Clause Generation
  // ==========================================================================
  describe('RLS SQL Query Filter Generation', () => {
    it('should generate holding-wide query filter for Holding Admin', () => {
      const result = buildTenantWhereClause(HOLDING_TENANT);
      assert.strictEqual(result.sql, 'tenant_id = ?');
      assert.deepStrictEqual(result.params, ['holding-corp-001']);
      assert.strictEqual(result.clause, 'WHERE tenant_id = ?');
    });

    it('should generate branch IN (?, ?) filter for Region Manager', () => {
      const result = buildTenantWhereClause(REGION_TENANT, { tableAlias: 'orders' });
      assert.strictEqual(
        result.sql,
        'orders.tenant_id = ? AND orders.branch_id IN (?, ?, ?)'
      );
      assert.deepStrictEqual(result.params, [
        'holding-corp-001',
        'branch-hcm-01',
        'branch-hcm-02',
        'branch-hcm-03',
      ]);
    });

    it('should generate branch_id = ? filter for Store Manager or Cashier', () => {
      const result = buildTenantWhereClause(BRANCH_TENANT, {
        tableName: 'pos_orders',
      });
      assert.strictEqual(
        result.sql,
        'pos_orders.tenant_id = ? AND pos_orders.branch_id = ?'
      );
      assert.deepStrictEqual(result.params, [
        'holding-corp-001',
        'branch-hcm-01',
      ]);
    });

    it('should generate strict franchisee_id and branch filter for Franchisee', () => {
      const result = buildTenantWhereClause(FRANCHISE_TENANT_A);
      assert.strictEqual(
        result.sql,
        'tenant_id = ? AND franchisee_id = ? AND branch_id = ?'
      );
      assert.deepStrictEqual(result.params, [
        'holding-corp-001',
        'franchise-an-phu',
        'branch-fc-anphu',
      ]);
    });

    it('should support PostgreSQL numbered placeholders ($1, $2, ...)', () => {
      const result = buildTenantWhereClause(FRANCHISE_TENANT_A, {
        tableAlias: 'inv',
        paramPlaceholder: (idx) => `$${idx}`,
      });
      assert.strictEqual(
        result.sql,
        'inv.tenant_id = $1 AND inv.franchisee_id = $2 AND inv.branch_id = $3'
      );
      assert.deepStrictEqual(result.params, [
        'holding-corp-001',
        'franchise-an-phu',
        'branch-fc-anphu',
      ]);
    });

    it('should prevent SQL injection on table and column identifiers', () => {
      assert.throws(
        () =>
          buildTenantWhereClause(BRANCH_TENANT, {
            tableName: 'orders; DROP TABLE users;--',
          }),
        (err: Error) => {
          assert.ok(err instanceof SecurityViolationError);
          assert.strictEqual(err.code, 'SECURITY_VIOLATION');
          return true;
        }
      );

      assert.throws(
        () =>
          buildTenantWhereClause(BRANCH_TENANT, {
            tenantColumn: 'tenant_id OR 1=1',
          }),
        (err: Error) => {
          assert.ok(err instanceof SecurityViolationError);
          return true;
        }
      );
    });

    it('should generate ORM compatible filter objects', () => {
      const ormFilterHolding = buildTenantOrmFilter(HOLDING_TENANT);
      assert.deepStrictEqual(ormFilterHolding, {
        tenantId: 'holding-corp-001',
      });

      const ormFilterRegion = buildTenantOrmFilter(REGION_TENANT);
      assert.deepStrictEqual(ormFilterRegion, {
        tenantId: 'holding-corp-001',
        branchId: {
          in: ['branch-hcm-01', 'branch-hcm-02', 'branch-hcm-03'],
        },
      });

      const ormFilterFranchise = buildTenantOrmFilter(FRANCHISE_TENANT_A);
      assert.deepStrictEqual(ormFilterFranchise, {
        tenantId: 'holding-corp-001',
        franchiseeId: 'franchise-an-phu',
        branchId: 'branch-fc-anphu',
      });
    });
  });

  // ==========================================================================
  // 3. Cross-Tenant and Cross-Franchise Isolation Guard
  // ==========================================================================
  describe('Cross-Tenant Data Leakage Prevention', () => {
    it('should throw CrossTenantAccessViolationError when accessing another tenant resource', () => {
      assert.throws(
        () =>
          assertTenantIsolation(BRANCH_TENANT, {
            tenantId: OTHER_TENANT.tenantId,
            branchId: 'branch-other',
          }),
        (err: Error) => {
          assert.ok(err instanceof CrossTenantAccessViolationError);
          assert.strictEqual(err.code, 'CROSS_TENANT_ACCESS_VIOLATION');
          assert.strictEqual(
            (err as CrossTenantAccessViolationError).currentTenantId,
            'holding-corp-001'
          );
          assert.strictEqual(
            (err as CrossTenantAccessViolationError).targetTenantId,
            'rival-enterprise-999'
          );
          return true;
        }
      );
    });

    it('should throw CrossTenantAccessViolationError when accessing another branch outside caller scope', () => {
      assert.throws(
        () =>
          assertTenantIsolation(STORE_MANAGER_USER, {
            tenantId: 'holding-corp-001',
            branchId: 'branch-hcm-02', // Store manager of branch-hcm-01 accessing branch-hcm-02
          }),
        (err: Error) => {
          assert.ok(err instanceof CrossTenantAccessViolationError);
          return true;
        }
      );
    });

    it('should throw CrossTenantAccessViolationError when franchisee accesses another franchisee', () => {
      assert.throws(
        () =>
          assertTenantIsolation(FRANCHISE_OWNER_USER, {
            tenantId: 'holding-corp-001',
            franchiseeId: 'franchise-other-partner',
            branchId: 'branch-fc-other',
          }),
        (err: Error) => {
          assert.ok(err instanceof CrossTenantAccessViolationError);
          return true;
        }
      );
    });

    it('should permit Holding Admin to access any branch within same tenant', () => {
      assert.doesNotThrow(() => {
        assertTenantIsolation(HOLDING_ADMIN_USER, {
          tenantId: 'holding-corp-001',
          branchId: 'branch-hcm-02',
        });
      });
    });
  });

  // ==========================================================================
  // 4. RBAC Role Hierarchy & Permissions
  // ==========================================================================
  describe('RBAC Role Hierarchy Verification', () => {
    it('HOLDING_ADMIN should have wildcard access to all operations', () => {
      assert.strictEqual(canAccess(HOLDING_ADMIN_USER, 'tenant:admin'), true);
      assert.strictEqual(canAccess(HOLDING_ADMIN_USER, 'financial:approve'), true);
      assert.strictEqual(canAccess(HOLDING_ADMIN_USER, 'inventory:adjust'), true);
    });

    it('CFO should have financial and reporting permissions, but not tenant admin', () => {
      assert.strictEqual(canAccess(CFO_USER, 'financial:approve'), true);
      assert.strictEqual(canAccess(CFO_USER, 'financial:export'), true);
      assert.strictEqual(canAccess(CFO_USER, 'report:holding'), true);
      assert.strictEqual(canAccess(CFO_USER, 'tenant:write'), false);
    });

    it('STORE_MANAGER should have store and order operations, but cannot export holding reports', () => {
      assert.strictEqual(canAccess(STORE_MANAGER_USER, 'order:create'), true);
      assert.strictEqual(canAccess(STORE_MANAGER_USER, 'order:discount'), true);
      assert.strictEqual(canAccess(STORE_MANAGER_USER, 'inventory:adjust'), true);
      assert.strictEqual(canAccess(STORE_MANAGER_USER, 'report:holding'), false);
      assert.strictEqual(canAccess(STORE_MANAGER_USER, 'financial:approve'), false);
    });

    it('CASHIER should have POS order read/create, but cannot discount or adjust inventory', () => {
      assert.strictEqual(canAccess(CASHIER_USER, 'order:create'), true);
      assert.strictEqual(canAccess(CASHIER_USER, 'order:read'), true);
      assert.strictEqual(canAccess(CASHIER_USER, 'order:discount'), false);
      assert.strictEqual(canAccess(CASHIER_USER, 'inventory:adjust'), false);
    });

    it('WAREHOUSE_STAFF should have inventory permissions only', () => {
      assert.strictEqual(canAccess(WAREHOUSE_USER, 'inventory:adjust'), true);
      assert.strictEqual(canAccess(WAREHOUSE_USER, 'inventory:transfer'), true);
      assert.strictEqual(canAccess(WAREHOUSE_USER, 'order:create'), false);
    });
  });

  // ==========================================================================
  // 5. ABAC Dynamic Context Constraints
  // ==========================================================================
  describe('ABAC Dynamic Context Constraints', () => {
    it('ABAC Budget Constraint: Store Manager can approve <= 1M VND, denied for > 1M VND', () => {
      // 500k VND discount -> Allowed for Store Manager
      const allowResult = evaluatePolicy(STORE_MANAGER_USER, 'order:discount', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-hcm-01',
        amount: 500_000,
      });
      assert.strictEqual(allowResult.allowed, true);

      // 1.5M VND discount -> Denied for Store Manager (threshold is 1M VND)
      const denyResult = evaluatePolicy(STORE_MANAGER_USER, 'order:discount', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-hcm-01',
        amount: 1_500_000,
      });
      assert.strictEqual(denyResult.allowed, false);
      assert.ok(
        denyResult.violations.some((v) => v.includes('Approval limit exceeded'))
      );

      // 1.5M VND discount -> Allowed for CFO (threshold is 500M VND)
      const cfoResult = evaluatePolicy(CFO_USER, 'order:discount', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-hcm-01',
        amount: 1_500_000,
      });
      assert.strictEqual(cfoResult.allowed, true);
    });

    it('ABAC Time Window Constraint: Cashier denied outside shift hours, allowed within shift', () => {
      // Cashier shift: 08:00 - 16:00
      // 10:30 AM -> Allowed
      const allowedResult = evaluatePolicy(CASHIER_USER, 'order:create', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-hcm-01',
        timestamp: '10:30',
      });
      assert.strictEqual(allowedResult.allowed, true);

      // 21:00 (outside shift) -> Denied
      const deniedResult = evaluatePolicy(CASHIER_USER, 'order:create', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-hcm-01',
        timestamp: '21:00',
      });
      assert.strictEqual(denyResultAllowed(deniedResult), false);
      assert.ok(
        deniedResult.violations.some((v) => v.includes('Time window violation'))
      );
    });

    function denyResultAllowed(res: any) {
      return res.allowed;
    }

    it('ABAC Branch Lock Constraint: User cannot access resource belonging to another branch', () => {
      const result = evaluatePolicy(STORE_MANAGER_USER, 'order:read', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-hcm-02', // Different store
      });
      assert.strictEqual(result.allowed, false);
      assert.ok(
        result.violations.some((v) => v.includes('Branch lock violation'))
      );
    });

    it('ABAC Franchisee Confidentiality: Franchisee cannot access holding consolidated reports', () => {
      const result = evaluatePolicy(FRANCHISE_OWNER_USER, 'order:read', {
        tenantId: 'holding-corp-001',
        branchId: 'branch-fc-anphu',
        franchiseeId: 'franchise-an-phu',
        resourceType: 'HOLDING_CONFIDENTIAL',
      });
      assert.strictEqual(result.allowed, false);
      assert.ok(
        result.violations.some((v) =>
          v.includes('Franchisee prohibited from accessing holding confidential')
        )
      );
    });
  });

  // ==========================================================================
  // 6. Permission Guard Middleware and Function Wrapper
  // ==========================================================================
  describe('Permission Guard Middleware & Protect Wrapper', () => {
    it('assertAccess should throw PermissionDeniedError on unauthorized actions', () => {
      assert.throws(
        () => assertAccess(CASHIER_USER, 'financial:approve'),
        (err: Error) => {
          assert.ok(err instanceof PermissionDeniedError);
          assert.strictEqual(err.code, 'PERMISSION_DENIED');
          assert.strictEqual(
            (err as PermissionDeniedError).permission,
            'financial:approve'
          );
          return true;
        }
      );
    });

    it('guardPermission middleware should invoke next(err) or return 403 on denial', (t, done) => {
      const middleware = guardPermission('financial:approve', {
        getUser: () => STORE_MANAGER_USER,
      });

      const mockReq = {};
      const mockRes = {
        status(code: number) {
          assert.strictEqual(code, 403);
          return {
            json(data: any) {
              assert.strictEqual(data.error, 'Forbidden');
              done();
            },
          };
        },
      };

      middleware(mockReq, mockRes, () => {
        assert.fail('Should not call next() for forbidden action');
      });
    });

    it('guardPermission middleware should invoke next() when authorized', (t, done) => {
      const middleware = guardPermission('order:create', {
        getUser: () => CASHIER_USER,
        extractResource: () => ({
          tenantId: 'holding-corp-001',
          branchId: 'branch-hcm-01',
          timestamp: '10:00',
        }),
      });

      const mockReq = {};
      const mockRes = {};

      middleware(mockReq, mockRes, (err?: any) => {
        assert.strictEqual(err, undefined);
        done();
      });
    });

    it('protectFunction wrapper should execute wrapped function when authorized', async () => {
      const refundOrder = protectFunction(
        'order:cancel',
        async (orderId: string, amount: number) => {
          return { refunded: true, orderId, amount };
        },
        {
          getUser: () => STORE_MANAGER_USER,
          extractResource: (_orderId, amount) => ({
            tenantId: 'holding-corp-001',
            branchId: 'branch-hcm-01',
            amount,
          }),
        }
      );

      // Budget <= 1M VND -> Success
      const success = await refundOrder('ORD-123', 500_000);
      assert.strictEqual(success.refunded, true);
      assert.strictEqual(success.amount, 500_000);

      // Budget > 1M VND -> Throws PermissionDeniedError
      await assert.rejects(
        async () => {
          await refundOrder('ORD-456', 2_000_000);
        },
        (err: Error) => {
          assert.ok(err instanceof PermissionDeniedError);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 7. Prisma ORM Query Interceptor & Valkey/Redis Cache Key Isolation
  // ==========================================================================
  describe('Prisma ORM Query Interceptor & Cache Key Isolation', () => {
    it('should preserve args reference on default tenant when enforceIsolation is false', () => {
      const originalArgs = { where: { isActive: true } };
      const out = injectPrismaTenantArgs('User', 'findMany', originalArgs, {
        tenantId: 'acme-retail',
        defaultTenantId: 'acme-retail',
        enforceIsolation: false,
      });
      assert.strictEqual(out, originalArgs);
      assert.deepStrictEqual(out, { where: { isActive: true } });
    });

    it('should inject where.tenantId on read/update/delete operations for non-default tenant or when enforceIsolation is true', () => {
      const findArgs = injectPrismaTenantArgs(
        'WorkShift',
        'findMany',
        { where: { status: 'OPEN' } },
        { tenantId: 'demo-coffee', defaultTenantId: 'acme-retail' }
      );
      assert.deepStrictEqual(findArgs, {
        where: { status: 'OPEN', tenantId: 'demo-coffee' },
      });

      const forcedDefaultArgs = injectPrismaTenantArgs(
        'WorkShift',
        'deleteMany',
        { where: { status: 'CANCELLED' } },
        { tenantId: 'acme-retail', defaultTenantId: 'acme-retail', enforceIsolation: true }
      );
      assert.deepStrictEqual(forcedDefaultArgs, {
        where: { status: 'CANCELLED', tenantId: 'acme-retail' },
      });
    });

    it('should inject data.tenantId for create and createMany operations', () => {
      const createArgs = injectPrismaTenantArgs(
        'User',
        'create',
        { data: { name: 'Alice' } },
        { tenantId: 'store-b', defaultTenantId: 'acme-retail' }
      );
      assert.deepStrictEqual(createArgs, {
        data: { name: 'Alice', tenantId: 'store-b' },
      });

      const createManyArgs = injectPrismaTenantArgs(
        'User',
        'createMany',
        {
          data: [
            { name: 'Alice' },
            { name: 'Bob', tenantId: 'custom-override' },
          ],
        },
        { tenantId: 'store-b', defaultTenantId: 'acme-retail' }
      );
      assert.deepStrictEqual(createManyArgs, {
        data: [
          { name: 'Alice', tenantId: 'store-b' },
          { name: 'Bob', tenantId: 'custom-override' },
        ],
      });
    });

    it('should respect scopedModels whitelist and ignore unscoped models', () => {
      const scopedModels = new Set(['User', 'WorkShift']);
      const unscopedArgs = { where: { key: 'theme' } };
      const resUnscoped = injectPrismaTenantArgs(
        'SystemSetting',
        'findFirst',
        unscopedArgs,
        {
          tenantId: 'store-b',
          defaultTenantId: 'acme-retail',
          scopedModels,
        }
      );
      assert.strictEqual(resUnscoped, unscopedArgs);

      const resScoped = injectPrismaTenantArgs(
        'User',
        'count',
        {},
        {
          tenantId: 'store-b',
          defaultTenantId: 'acme-retail',
          scopedModels,
        }
      );
      assert.deepStrictEqual(resScoped, {
        where: { tenantId: 'store-b' },
      });
    });

    it('createPrismaTenantExtensionConfig should intercept $allOperations and pass scoped args to query()', async () => {
      const ext = createPrismaTenantExtensionConfig({
        defaultTenantId: 'acme-retail',
        scopedModels: ['User'],
      });

      await runWithTenantContext(BRANCH_TENANT, async () => {
        let capturedArgs: any = null;
        const result = await ext.query.$allModels.$allOperations({
          model: 'User',
          operation: 'findMany',
          args: { where: { role: 'CASHIER' } },
          query: async (nextArgs) => {
            capturedArgs = nextArgs;
            return [{ id: 'u1' }];
          },
        });

        assert.deepStrictEqual(result, [{ id: 'u1' }]);
        assert.deepStrictEqual(capturedArgs, {
          where: { role: 'CASHIER', tenantId: 'holding-corp-001' },
        });
      });
    });

    it('prefixTenantCacheKey and buildTenantCachePattern should namespace non-default tenants and avoid double-prefixing', () => {
      // Default tenant -> unprefixed
      assert.strictEqual(
        prefixTenantCacheKey('shifts:2026-10', {
          tenantId: 'acme-retail',
          defaultTenantId: 'acme-retail',
        }),
        'shifts:2026-10'
      );

      // Non-default tenant -> prefixed
      const prefixed = prefixTenantCacheKey('shifts:2026-10', {
        tenantId: 'demo-coffee',
        defaultTenantId: 'acme-retail',
      });
      assert.strictEqual(prefixed, 'tenant:demo-coffee:shifts:2026-10');

      // Already prefixed -> no double prefix
      assert.strictEqual(
        prefixTenantCacheKey(prefixed, {
          tenantId: 'demo-coffee',
          defaultTenantId: 'acme-retail',
        }),
        'tenant:demo-coffee:shifts:2026-10'
      );

      // Pattern builder
      assert.strictEqual(
        buildTenantCachePattern('payroll:*', {
          tenantId: 'demo-coffee',
          defaultTenantId: 'acme-retail',
        }),
        'tenant:demo-coffee:payroll:*'
      );
      assert.strictEqual(
        buildTenantCachePattern('', {
          tenantId: 'demo-coffee',
          defaultTenantId: 'acme-retail',
        }),
        'tenant:demo-coffee:*'
      );
    });
  });
});
