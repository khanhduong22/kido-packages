import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRegistry,
  findSlice,
  findBlueprint,
  filterRegistry,
  getAllSlices,
  parseRegistryMarkdown,
} from '../src/registry';

describe('@kido/cli: Registry Parser & Query Engine', () => {
  it('loads registry and verifies 6 pillars and 39 packages', async () => {
    const registry = await loadRegistry();
    assert.strictEqual(registry.pillars.length, 6, 'Should have exactly 6 pillars');
    assert.strictEqual(registry.totalPackages, 39, 'Should have exactly 39 packages');
    assert.ok(registry.totalSlices >= 100, 'Should have >= 100 isolated slices');
  });

  it('verifies all 12 Master Architecture Blueprints', async () => {
    const registry = await loadRegistry();
    assert.strictEqual(registry.blueprints.length, 12, 'Should have 12 blueprints');

    const bp01 = registry.blueprints.find((b) => b.id === '01');
    assert.ok(bp01, 'Blueprint 01 must exist');
    assert.ok(bp01.name.includes('YouTube-Scale Video View Counter'));
    assert.ok(bp01.paradigm.includes('Adaptive Slotted Write'));
  });

  it('finds slice by exact name', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('slotted-counter', registry);
    assert.ok(slice, 'Should find slotted-counter');
    assert.strictEqual(slice.name, 'slotted-counter');
    assert.strictEqual(slice.packageName, '@kido/hot-counter');
    assert.ok(slice.exports.includes('SlottedCounter'));
  });

  it('finds directory slice by name', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('rpm-rate-guard', registry);
    assert.ok(slice, 'Should find rpm-rate-guard');
    assert.strictEqual(slice.type, 'directory');
    assert.strictEqual(slice.packageName, '@kido/ai-stream');
  });

  it('finds slice by package-qualified path', async () => {
    const registry = await loadRegistry();
    const { slice } = findSlice('@kido/hot-counter/slotted-counter', registry);
    assert.ok(slice, 'Should find @kido/hot-counter/slotted-counter');
    assert.strictEqual(slice.name, 'slotted-counter');
  });

  it('finds blueprint by ID and slug', async () => {
    const registry = await loadRegistry();

    const byId = findBlueprint('01', registry);
    assert.ok(byId.blueprint, 'Should find blueprint 01');
    assert.strictEqual(byId.blueprint.id, '01');

    const byNumber = findBlueprint('1', registry);
    assert.ok(byNumber.blueprint, 'Should find blueprint 1');
    assert.strictEqual(byNumber.blueprint.id, '01');

    const bySlug = findBlueprint('01-youtube-scale-video-view-counter', registry);
    assert.ok(bySlug.blueprint, 'Should find blueprint by slug');
  });

  it('filters registry by pillar and search term', async () => {
    const registry = await loadRegistry();

    // Filter by Pillar 2 (High-Concurrency Infrastructure)
    const p2Result = filterRegistry(registry, { pillar: 2 });
    assert.strictEqual(p2Result.pillars.length, 1);
    assert.strictEqual(p2Result.pillars[0].id, 2);
    assert.strictEqual(p2Result.pillars[0].packages.length, 11);

    // Search keyword
    const searchResult = filterRegistry(registry, { search: 'counter' });
    assert.ok(searchResult.pillars.length > 0);
    assert.ok(searchResult.blueprints.length > 0);
  });

  it('parses raw PACKAGES_REGISTRY.md markdown string directly', () => {
    const sampleMd = `
## 1. Security & Anti-Abuse (\`1 Combo Suites\`)

| # | Combo Package (\`@kido/*\`) | Path | Isolated Slices (\`src/<slice>\`) & Core Exports |
|---|---|---|---|
| 1 | \`@kido/tenant-guard\` | \`packages/tenant-guard\` | **Multi-Tenant Combo**:<br>• **\`src/tenant-context.ts\`**: \`TenantContextStore\` |
`;
    const parsed = parseRegistryMarkdown(sampleMd);
    assert.strictEqual(parsed.pillars.length, 1);
    assert.strictEqual(parsed.pillars[0].packages.length, 1);
    assert.strictEqual(parsed.pillars[0].packages[0].name, '@kido/tenant-guard');
    assert.strictEqual(parsed.pillars[0].packages[0].slices.length, 1);
    assert.strictEqual(parsed.pillars[0].packages[0].slices[0].name, 'tenant-context');
  });
});
