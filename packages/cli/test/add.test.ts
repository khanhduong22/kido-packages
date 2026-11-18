import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeAddCommand, addSlice } from '../src/commands/add';
import { loadRegistry, findSlice } from '../src/registry';
import { findMonorepoRoot } from '../src/utils/fs';

describe('@kido/cli: Surgical Slice & Blueprint Extraction (add)', () => {
  let tempDir: string;
  let root: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kido-bag-test-'));
    const detectedRoot = findMonorepoRoot();
    assert.ok(detectedRoot, 'Monorepo root should be found');
    root = detectedRoot;
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('performs dry-run extraction without writing files', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('slotted-counter', registry);
    assert.ok(slice);

    const outDir = path.join(tempDir, 'dry-run-test');
    const result = await addSlice(slice, root, {
      outDir,
      dryRun: true,
    });

    assert.strictEqual(result.dryRun, true);
    assert.ok(result.files.length > 0);
    assert.strictEqual(fs.existsSync(outDir), false, 'Dry-run must not create destination directory');
  });

  it('surgically copies single-file slice and companion types', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('tenant-context', registry);
    assert.ok(slice);

    const outDir = path.join(tempDir, 'slices/tenant');
    const result = await addSlice(slice, root, {
      outDir,
      dryRun: false,
    });

    assert.ok(fs.existsSync(result.targetPath), 'Target file must exist');
    const content = fs.readFileSync(result.targetPath, 'utf-8');
    assert.ok(content.includes('runWithTenantContext'), 'Content should contain runWithTenantContext');

    // Check if companion types.ts was copied because tenant-context.ts imports ./types
    const companionPath = path.join(outDir, 'types.ts');
    assert.ok(fs.existsSync(companionPath), 'Companion types.ts should be automatically copied');
  });

  it('surgically copies directory slice recursively', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('rpm-rate-guard', registry);
    assert.ok(slice);
    assert.strictEqual(slice.type, 'directory');

    const outDir = path.join(tempDir, 'slices/rpm');
    const result = await addSlice(slice, root, {
      outDir,
      dryRun: false,
    });

    assert.ok(fs.existsSync(result.targetPath), 'Target directory must exist');
    assert.ok(fs.statSync(result.targetPath).isDirectory(), 'Must be a directory');
    const files = fs.readdirSync(result.targetPath);
    assert.ok(files.length > 0, 'Directory should contain files');
    assert.ok(files.some((f) => f.endsWith('.ts')), 'Should contain .ts files');
  });

  it('enforces overwrite protection unless --force is specified', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('slotted-counter', registry);
    assert.ok(slice);

    const outDir = path.join(tempDir, 'overwrite-test');
    // First copy
    await addSlice(slice, root, { outDir, dryRun: false });

    // Modify existing file to simulate user edits
    const destFile = path.join(outDir, 'slotted-counter.ts');
    fs.writeFileSync(destFile, '// user customized code', 'utf-8');

    // Second copy without force -> should throw because file was modified
    await assert.rejects(
      async () => {
        await addSlice(slice, root, { outDir, force: false, dryRun: false });
      },
      /already exists/
    );

    // Third copy with force -> should succeed and overwrite
    const res = await addSlice(slice, root, { outDir, force: true, dryRun: false });
    assert.ok(res.files.length > 0);
    assert.notStrictEqual(fs.readFileSync(destFile, 'utf-8'), '// user customized code');
  });

  it('extracts Master Architecture Blueprint 01 with composed slices', async () => {
    const outDir = path.join(tempDir, 'blueprints');
    const results = await executeAddCommand('01', {
      outDir,
      dryRun: false,
      rootPath: root,
    });

    assert.strictEqual(results.length, 4, 'Blueprint 01 should compose exactly 4 slices');
    const bpDir = path.join(outDir, '01-youtube-scale-video-view-counter');
    assert.ok(fs.existsSync(bpDir), 'Blueprint subfolder should be created');

    const sliceNames = results.map((r) => r.sliceName);
    assert.ok(sliceNames.includes('youtube-view-engine'));
    assert.ok(sliceNames.includes('valkey-write-behind'));
    assert.ok(sliceNames.includes('slotted-counter'));
    assert.ok(sliceNames.includes('hll-analytics'));
  });
});
