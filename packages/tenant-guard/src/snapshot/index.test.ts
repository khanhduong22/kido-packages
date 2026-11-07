import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSnapshotChecksum,
  verifySnapshotIntegrity,
  SurgicalSnapshotEngine,
  InMemorySnapshotAdapter,
  PrismaSnapshotAdapter,
  SnapshotTamperError,
  CrossTenantImportForbiddenError,
  InvalidSnapshotPayloadError,
} from '../index';

describe('@kido/tenant-snapshot Test Suite', () => {
  function createSeededAdapter(): InMemorySnapshotAdapter {
    return new InMemorySnapshotAdapter({
      tenants: {
        'acme-retail': {
          id: 'acme-retail',
          slug: 'acme-retail',
          name: 'AcmeRetail Flagship Store',
          isActive: true,
        },
        rival: {
          id: 'rival',
          slug: 'rival',
          name: 'Rival Store',
          isActive: true,
        },
      },
      collections: {
        users: [
          { id: 'u1', name: 'Alice', role: 'MANAGER', tenantId: 'acme-retail' },
          { id: 'u2', name: 'Bob', role: 'STAFF', tenantId: 'acme-retail' },
          { id: 'u99', name: 'Mallory', role: 'MANAGER', tenantId: 'rival' },
        ],
        workShifts: [
          { id: 101, name: 'Morning Shift', tenantId: 'acme-retail' },
          { id: 102, name: 'Evening Shift', tenantId: 'acme-retail' },
          { id: 999, name: 'Rival Shift', tenantId: 'rival' },
        ],
        shiftDuties: [
          { id: 'sd1', shiftId: 101, title: 'Open Register', tenantId: 'acme-retail' },
          { id: 'sd2', shiftId: 102, title: 'Lock Doors', tenantId: 'acme-retail' },
        ],
        documents: [
          { id: 'doc1', title: 'SOP Handbook', tenantId: 'acme-retail' },
        ],
        announcements: [
          { id: 'ann1', title: 'Holiday Notice', tenantId: 'acme-retail' },
        ],
        taskDefinitions: [
          { id: 'td1', name: 'Daily Cleaning', tenantId: 'acme-retail' },
        ],
        taskItems: [
          { id: 'ti1', taskDefinitionId: 'td1', label: 'Sweep floor', tenantId: 'acme-retail' },
        ],
        holidays: [
          { id: 'hol1', name: 'Tet Holiday', date: '2026-02-17', tenantId: 'acme-retail' },
        ],
        allowedIps: [
          { id: 1, ip: '203.0.113.10', label: 'Store WiFi', tenantId: 'acme-retail' },
        ],
      },
    });
  }

  // ==========================================================================
  // 1. Canonical SHA-256 Checksum & Tamper Seal
  // ==========================================================================
  describe('Canonical SHA-256 Checksum & Integrity Verification', () => {
    it('should produce identical SHA-256 checksums regardless of object key insertion order', () => {
      const objA = {
        tenant: { id: 'acme-retail', name: 'AcmeRetail', isActive: true },
        users: [{ id: 'u1', name: 'Alice', tenantId: 'acme-retail' }],
      };
      const objB = {
        users: [{ tenantId: 'acme-retail', name: 'Alice', id: 'u1' }],
        tenant: { isActive: true, name: 'AcmeRetail', id: 'acme-retail' },
      };

      const hashA = computeSnapshotChecksum(objA);
      const hashB = computeSnapshotChecksum(objB);
      assert.strictEqual(hashA, hashB);
      assert.strictEqual(hashA.length, 64);
    });

    it('should detect payload tampering when a single field in data is altered', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);

      const snapshot = await engine.exportTenantSnapshot('acme-retail', 'all');
      const validCheck = verifySnapshotIntegrity(snapshot);
      assert.strictEqual(validCheck.valid, true);
      assert.strictEqual(validCheck.expected, snapshot.checksum);

      // Tamper with exported data
      const tampered = structuredClone(snapshot);
      tampered.data.users[0].role = 'SUPER_HACKER';

      const invalidCheck = verifySnapshotIntegrity(tampered);
      assert.strictEqual(invalidCheck.valid, false);
      assert.notStrictEqual(invalidCheck.expected, invalidCheck.actual);

      await assert.rejects(
        async () => {
          await engine.importTenantSnapshot('acme-retail', tampered);
        },
        (err: Error) => {
          assert.ok(err instanceof SnapshotTamperError);
          assert.strictEqual((err as SnapshotTamperError).code, 'SNAPSHOT_CHECKSUM_MISMATCH');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 2. Scoped Export & Multi-Tenant Isolation
  // ==========================================================================
  describe('Surgical Scoped Snapshot Export', () => {
    it('should export only target tenant records and exclude other tenants', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);

      const snapshot = await engine.exportTenantSnapshot('acme-retail', 'all');
      assert.strictEqual(snapshot.version, '1.0');
      assert.strictEqual(snapshot.tenantId, 'acme-retail');
      assert.strictEqual(snapshot.scope, 'all');
      assert.strictEqual(snapshot.counts.users, 2);
      assert.strictEqual(snapshot.counts.workShifts, 2);
      assert.strictEqual(snapshot.counts.shiftDuties, 2);
      assert.strictEqual(snapshot.counts.documents, 1);
      assert.strictEqual(snapshot.counts.taskDefinitions, 1);
      assert.strictEqual(snapshot.counts.taskItems, 1);

      // Ensure rival tenant records are never exported
      assert.ok(
        snapshot.data.users.every((u: any) => u.tenantId === 'acme-retail')
      );
      assert.ok(
        snapshot.data.workShifts.every((s: any) => s.tenantId === 'acme-retail')
      );
    });

    it('should export only schedule collections when scope is "schedule"', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);

      const scheduleSnapshot = await engine.exportTenantSnapshot(
        'acme-retail',
        'schedule'
      );
      assert.strictEqual(scheduleSnapshot.scope, 'schedule');
      assert.strictEqual(scheduleSnapshot.counts.users, 2);
      assert.strictEqual(scheduleSnapshot.counts.workShifts, 2);
      assert.strictEqual(scheduleSnapshot.counts.shiftDuties, 2);
      assert.strictEqual(scheduleSnapshot.data.documents, undefined);
      assert.strictEqual(scheduleSnapshot.data.taskDefinitions, undefined);
    });
  });

  // ==========================================================================
  // 3. Reverse-FK Dependency Order & Scoped Surgical Restore
  // ==========================================================================
  describe('Reverse-FK Dependency Order & Scoped Restore', () => {
    it('should delete child tables before parent tables (Reverse-FK order) and insert parents before children', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);

      const snapshot = await engine.exportTenantSnapshot('acme-retail', 'all');
      adapter.clearOperationLog();

      const result = await engine.importTenantSnapshot('acme-retail', snapshot);
      assert.strictEqual(result.restoredTenantId, 'acme-retail');
      assert.strictEqual(result.dryRun, false);

      // Verify Reverse-FK deletion order: shiftDuties (45) before workShifts (40); taskItems (35) before taskDefinitions (30)
      const shiftDutiesDeleteIdx = result.deletionOrder.indexOf('shiftDuties');
      const workShiftsDeleteIdx = result.deletionOrder.indexOf('workShifts');
      assert.ok(
        shiftDutiesDeleteIdx < workShiftsDeleteIdx,
        'shiftDuties must be deleted before workShifts'
      );

      const taskItemsDeleteIdx = result.deletionOrder.indexOf('taskItems');
      const taskDefsDeleteIdx = result.deletionOrder.indexOf('taskDefinitions');
      assert.ok(
        taskItemsDeleteIdx < taskDefsDeleteIdx,
        'taskItems must be deleted before taskDefinitions'
      );

      // Verify Forward-FK insertion order: workShifts (40) before shiftDuties (45); taskDefinitions (30) before taskItems (35)
      const workShiftsInsertIdx = result.insertionOrder.indexOf('workShifts');
      const shiftDutiesInsertIdx = result.insertionOrder.indexOf('shiftDuties');
      assert.ok(
        workShiftsInsertIdx < shiftDutiesInsertIdx,
        'workShifts must be inserted before shiftDuties'
      );

      // Verify Rival tenant records in the same database were completely untouched
      const rivalShifts = await adapter.findCollectionRecords('workShifts', 'rival');
      assert.strictEqual(rivalShifts.length, 1);
      assert.strictEqual(rivalShifts[0].name, 'Rival Shift');
    });

    it('should restore only scoped tables during a surgical "schedule" restore without wiping documents or tasks', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);

      const scheduleSnap = await engine.exportTenantSnapshot('acme-retail', 'schedule');

      // Mutate live schedule and documents
      await adapter.deleteCollectionRecords('workShifts', 'acme-retail');
      await adapter.insertCollectionRecords('documents', 'acme-retail', [
        { id: 'doc2', title: 'New Live Document', tenantId: 'acme-retail' },
      ]);

      // Restore only schedule scope
      const restoreRes = await engine.importTenantSnapshot('acme-retail', scheduleSnap);
      assert.strictEqual(restoreRes.restoredCounts.workShifts, 2);
      assert.strictEqual(restoreRes.restoredCounts.shiftDuties, 2);
      assert.strictEqual(restoreRes.restoredCounts.documents, undefined);

      // Live documents must remain intact (2 documents total)
      const docsAfter = await adapter.findCollectionRecords('documents', 'acme-retail');
      assert.strictEqual(docsAfter.length, 2);
    });
  });

  // ==========================================================================
  // 4. Cross-Tenant Clone Guard & Sandbox Cloning
  // ==========================================================================
  describe('Cross-Tenant Sandbox Clone & Guardrails', () => {
    it('should block cross-tenant import when allowCrossTenantImport is not enabled', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);
      const snapshot = await engine.exportTenantSnapshot('acme-retail', 'all');

      await assert.rejects(
        async () => {
          await engine.importTenantSnapshot('demo-sandbox', snapshot);
        },
        (err: Error) => {
          assert.ok(err instanceof CrossTenantImportForbiddenError);
          assert.strictEqual(
            (err as CrossTenantImportForbiddenError).code,
            'CROSS_TENANT_IMPORT_FORBIDDEN'
          );
          return true;
        }
      );
    });

    it('should clone snapshot into target tenant with rewritten tenantId and prefixed string IDs when allowCrossTenantImport is true', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);
      const snapshot = await engine.exportTenantSnapshot('acme-retail', 'all');

      let invalidatedPattern: string | null = null;
      const cloneResult = await engine.importTenantSnapshot(
        'demo-coffee',
        snapshot,
        {
          allowCrossTenantImport: true,
          invalidateCache: async (pattern) => {
            invalidatedPattern = pattern;
          },
        }
      );

      assert.strictEqual(cloneResult.restoredTenantId, 'demo-coffee');
      assert.strictEqual(cloneResult.sourceTenantId, 'acme-retail');
      assert.strictEqual(cloneResult.restoredCounts.users, 2);
      assert.strictEqual(cloneResult.restoredCounts.workShifts, 2);
      assert.strictEqual(invalidatedPattern, 'tenant:demo-coffee:*');

      const clonedUsers = await adapter.findCollectionRecords('users', 'demo-coffee');
      assert.strictEqual(clonedUsers.length, 2);
      assert.ok(clonedUsers.every((u) => u.tenantId === 'demo-coffee'));
      assert.ok(clonedUsers.every((u) => u.id.startsWith('demo-coffee_')));

      // Source tenant must remain untouched
      const sourceUsers = await adapter.findCollectionRecords('users', 'acme-retail');
      assert.strictEqual(sourceUsers.length, 2);
    });

    it('should support dryRun mode without modifying storage or firing cache invalidation', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);
      const snapshot = await engine.exportTenantSnapshot('acme-retail', 'schedule');

      let cacheCalled = false;
      const dryRunRes = await engine.importTenantSnapshot(
        'demo-sandbox',
        snapshot,
        {
          dryRun: true,
          allowCrossTenantImport: true,
          invalidateCache: () => {
            cacheCalled = true;
          },
        }
      );

      assert.strictEqual(dryRunRes.dryRun, true);
      assert.strictEqual(dryRunRes.restoredCounts.workShifts, 2);
      assert.strictEqual(cacheCalled, false);

      const sandboxShifts = await adapter.findCollectionRecords(
        'workShifts',
        'demo-sandbox'
      );
      assert.strictEqual(sandboxShifts.length, 0);
    });

    it('should reject invalid payload structures with InvalidSnapshotPayloadError', async () => {
      const adapter = createSeededAdapter();
      const engine = new SurgicalSnapshotEngine(adapter);

      await assert.rejects(
        async () => {
          await engine.importTenantSnapshot('acme-retail', { version: '0.9' } as any);
        },
        (err: Error) => {
          assert.ok(err instanceof InvalidSnapshotPayloadError);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 5. PrismaSnapshotAdapter Integration
  // ==========================================================================
  describe('PrismaSnapshotAdapter Integration', () => {
    it('should execute export and transactional import via Prisma client delegates', async () => {
      const callOrder: string[] = [];
      const store: Record<string, any[]> = {
        user: [{ id: 'u1', name: 'Alice', tenantId: 'acme-retail' }],
        workShift: [{ id: 10, name: 'Shift A', tenantId: 'acme-retail' }],
        shiftDuty: [{ id: 'd1', shiftId: 10, tenantId: 'acme-retail' }],
      };

      const makeModel = (key: string) => ({
        findMany: async ({ where }: any = {}) => {
          const rows = store[key] ?? [];
          return where?.tenantId
            ? rows.filter((r) => r.tenantId === where.tenantId)
            : rows;
        },
        deleteMany: async ({ where }: any = {}) => {
          callOrder.push(`delete:${key}`);
          const before = (store[key] ?? []).length;
          store[key] = (store[key] ?? []).filter(
            (r) => r.tenantId !== where?.tenantId
          );
          return { count: before - store[key].length };
        },
        createMany: async ({ data }: any) => {
          callOrder.push(`insert:${key}`);
          store[key] = [...(store[key] ?? []), ...data];
          return { count: data.length };
        },
      });

      const mockPrisma: Record<string, any> = {
        tenant: {
          findUnique: async ({ where }: any) => ({
            id: where.id,
            slug: where.id,
            name: 'AcmeRetail',
            isActive: true,
          }),
          upsert: async () => {
            callOrder.push('upsert:tenant');
            return {};
          },
        },
        user: makeModel('user'),
        workShift: makeModel('workShift'),
        shiftDuty: makeModel('shiftDuty'),
        $transaction: async (fn: any) => {
          callOrder.push('tx:begin');
          const res = await fn(mockPrisma);
          callOrder.push('tx:commit');
          return res;
        },
      };

      const prismaAdapter = new PrismaSnapshotAdapter(mockPrisma);
      const engine = new SurgicalSnapshotEngine(prismaAdapter);

      const snap = await engine.exportTenantSnapshot('acme-retail', 'schedule');
      assert.strictEqual(snap.counts.users, 1);
      assert.strictEqual(snap.counts.workShifts, 1);
      assert.strictEqual(snap.counts.shiftDuties, 1);

      const importRes = await engine.importTenantSnapshot('demo', snap, {
        allowCrossTenantImport: true,
        scopes: ['schedule'],
      });

      assert.strictEqual(importRes.restoredCounts.workShifts, 1);
      assert.strictEqual(importRes.restoredCounts.shiftDuties, 1);
      assert.deepStrictEqual(callOrder, [
        'tx:begin',
        'delete:shiftDuty',
        'delete:workShift',
        'upsert:tenant',
        'insert:workShift',
        'insert:shiftDuty',
        'tx:commit',
      ]);
    });
  });
});
