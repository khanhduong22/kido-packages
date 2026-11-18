import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImports } from '../src/utils/deps';

describe('@kido/cli: Dependency Analyzer', () => {
  it('correctly ignores Node.js stdlib and relative imports', () => {
    const code = `
      import * as fs from 'node:fs';
      import path from 'path';
      import { EventEmitter } from 'events';
      import { myHelper } from './helper';
      import { sibling } from '../sibling';
    `;

    const result = analyzeImports([code]);
    assert.strictEqual(result.externalDeps.length, 0, 'Should have 0 external deps');
    assert.ok(result.hasNodeDeps, 'Should detect Node.js stdlib imports');
    assert.strictEqual(result.installCommand.pnpm, '');
  });

  it('detects external npm packages and formats install command', () => {
    const code = `
      import { z } from 'zod';
      import Redis from 'ioredis';
      import type { Context } from 'hono';
      const pino = require('pino');
    `;

    const result = analyzeImports([code]);
    assert.deepStrictEqual(result.externalDeps, ['hono', 'ioredis', 'pino', 'zod']);
    assert.strictEqual(result.installCommand.pnpm, 'pnpm add hono ioredis pino zod');
    assert.strictEqual(result.installCommand.npm, 'npm install hono ioredis pino zod');
    assert.strictEqual(result.installCommand.bun, 'bun add hono ioredis pino zod');
  });

  it('detects scoped packages correctly', () => {
    const code = `
      import { useQuery } from '@tanstack/react-query';
      import { clsx } from 'clsx';
    `;

    const result = analyzeImports([code]);
    assert.deepStrictEqual(result.externalDeps, ['@tanstack/react-query', 'clsx']);
  });

  it('identifies peer Kido packages separately', () => {
    const code = `
      import { createCache } from '@kido/resilient-cache';
      import { SlottedCounter } from '@kido/hot-counter';
    `;

    const result = analyzeImports([code]);
    assert.strictEqual(result.externalDeps.length, 0);
    assert.deepStrictEqual(result.peerKidoDeps, ['@kido/hot-counter', '@kido/resilient-cache']);
  });
});
