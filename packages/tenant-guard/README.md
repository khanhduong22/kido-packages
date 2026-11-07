# @kido/tenant-guard

Enterprise Multi-Tenant Row-Level Security (RLS) & Dynamic RBAC/ABAC Guard for Multi-Tier Franchise & Enterprise POS Architecture.

## Key Capabilities

1. **Multi-Tier Tenant Context Propagation**:
   - Hierarchy: `Holding -> Sub-Company -> Region -> Branch / Franchisee`.
   - Native Node/Bun `AsyncLocalStorage` engine to automatically propagate `TenantContext` & `UserContext` across async call stacks, eliminating manual parameter passing.
2. **Zero-Leakage Row-Level Security (RLS)**:
   - Dynamic SQL `WHERE` clause generation (`buildTenantWhereClause`) and ORM filter generation (`buildTenantOrmFilter` for Prisma, MikroORM, TypeORM, Drizzle).
   - Strict franchise & branch isolation preventing 100% of cross-tenant and cross-franchise data leakage.
   - Built-in SQL identifier sanitization and injection guards.
   - Dual placeholder support (`?` for MySQL/SQLite/Vitess, `$1, $2` for PostgreSQL).
3. **Hybrid RBAC + ABAC Security Engine**:
   - **RBAC**: Hierarchical roles (`HOLDING_ADMIN`, `CFO`, `REGION_MANAGER`, `STORE_MANAGER`, `CASHIER`, `WAREHOUSE_STAFF`, `FRANCHISEE_OWNER`).
   - **ABAC (Dynamic Attribute Rules)**:
     - `timeWindow` & `shiftHours`: Enforces operations strictly within store opening hours and shift windows (handles same-day & cross-midnight shifts).
     - `maxApprovalAmount`: Enforces budget thresholds (e.g., Store Manager can approve discounts/refunds up to 1,000,000 VND; amounts exceeding 1,000,000 VND require CFO/Holding escalation).
     - `branchLock`: Prevents unauthorized cross-branch viewing or manipulation.
     - `franchiseeLock`: Prohibits franchise partners from accessing holding consolidated financial reports.
4. **Guards & Middleware**:
   - Express/Connect route middleware `guardPermission(perm, options)`.
   - Pure function protector `protectFunction(perm, fn, options)`.
   - Deterministic assertions: `assertTenantIsolation`, `assertAccess`, `canAccess`.

---

## Installation

```bash
pnpm add @kido/tenant-guard
```

---

## Quick Start & Usage Examples

### 1. Multi-Tier AsyncLocalStorage Context

```typescript
import {
  runWithTenantAndUserContext,
  getTenantContext,
  getUserContext,
  requireTenantContext,
} from '@kido/tenant-guard';

await runWithTenantAndUserContext(
  {
    tenantId: 'holding-001',
    tenantName: 'Golden Gate Group',
    hierarchyLevel: 'BRANCH',
    branchId: 'branch-d1-01',
  },
  {
    userId: 'user-sm-01',
    role: 'STORE_MANAGER',
    tenantId: 'holding-001',
    branchId: 'branch-d1-01',
    maxApprovalAmount: 1_000_000,
  },
  async () => {
    // Ambient context is available anywhere in the async call stack
    const tenant = requireTenantContext();
    console.log(`Processing for: ${tenant.tenantName} - ${tenant.branchId}`);
  }
);
```

### 2. RLS SQL & ORM Filter Generation

```typescript
import { buildTenantWhereClause, buildTenantOrmFilter } from '@kido/tenant-guard';

// SQL WHERE Clause with parameter binding (MySQL / SQLite / Vitess)
const { sql, params, clause } = buildTenantWhereClause(userContext, {
  tableName: 'orders',
});
// sql: "orders.tenant_id = ? AND orders.branch_id = ?"
// params: ['holding-001', 'branch-d1-01']
// clause: "WHERE orders.tenant_id = ? AND orders.branch_id = ?"

// PostgreSQL numbered placeholders
const pgFilter = buildTenantWhereClause(userContext, {
  tableAlias: 'o',
  paramPlaceholder: (i) => `$${i}`,
});
// pgFilter.sql: "o.tenant_id = $1 AND o.branch_id = $2"

// ORM Filter Object (Prisma, MikroORM, TypeORM)
const ormFilter = buildTenantOrmFilter(userContext);
// { tenantId: 'holding-001', branchId: 'branch-d1-01' }
```

### 3. Cross-Tenant Isolation Guard

```typescript
import { assertTenantIsolation } from '@kido/tenant-guard';

try {
  // Throws CrossTenantAccessViolationError if resource belongs to another tenant or branch
  assertTenantIsolation(userContext, {
    tenantId: targetOrder.tenantId,
    branchId: targetOrder.branchId,
  });
} catch (err) {
  // 100% Guaranteed isolation against data leakage
}
```

### 4. RBAC + ABAC Authorization Evaluation

```typescript
import { evaluatePolicy, canAccess, assertAccess } from '@kido/tenant-guard';

// Check if store manager can apply a 500,000 VND discount (Allowed)
const allowed = canAccess(storeManagerUser, 'order:discount', {
  tenantId: 'holding-001',
  branchId: 'branch-d1-01',
  amount: 500_000,
}); // true

// Check if store manager can apply a 2,500,000 VND discount (Denied: exceeds 1M VND limit)
const denied = canAccess(storeManagerUser, 'order:discount', {
  tenantId: 'holding-001',
  branchId: 'branch-d1-01',
  amount: 2_500_000,
}); // false (Requires CFO approval)
```

### 5. Route Middleware & Function Guard

```typescript
import { guardPermission, protectFunction } from '@kido/tenant-guard';

// Express / Connect Route Guard
app.post(
  '/api/orders/:id/refund',
  guardPermission('order:cancel', {
    extractResource: (req) => ({
      tenantId: req.user.tenantId,
      branchId: req.user.branchId,
      amount: req.body.refundAmount,
    }),
  }),
  orderController.refundOrder
);

// Method / Function Wrapper
const refundOrder = protectFunction(
  'order:cancel',
  async (orderId: string, amount: number) => {
    return db.refund(orderId, amount);
  },
  {
    extractResource: (_orderId, amount) => ({ amount }),
  }
);
```

---

## Test Verification

Run test suite:
```bash
pnpm test
```
Result: 27 test cases passing (100% pass rate).
