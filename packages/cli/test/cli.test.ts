import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli';

describe('@kido/cli: CLI Entrypoint (runCli)', () => {
  it('displays help text when invoked with --help', async () => {
    let output = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await runCli(['--help']);
      assert.ok(output.includes('kido-bag'));
      assert.ok(output.includes('USAGE:'));
      assert.ok(output.includes('COMMANDS:'));
      assert.ok(output.includes('list'));
      assert.ok(output.includes('add'));
      assert.ok(output.includes('info'));
    } finally {
      console.log = originalLog;
    }
  });

  it('displays version when invoked with --version', async () => {
    let output = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await runCli(['--version']);
      assert.ok(output.includes('kido-bag v1.0.0'));
    } finally {
      console.log = originalLog;
    }
  });

  it('outputs valid JSON when running list --json', async () => {
    let output = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += msg;
    };

    try {
      await runCli(['list', '--json']);
      const parsed = JSON.parse(output);
      assert.ok(Array.isArray(parsed.pillars));
      assert.ok(Array.isArray(parsed.blueprints));
      assert.strictEqual(parsed.pillars.length, 6);
      assert.strictEqual(parsed.blueprints.length, 12);
    } finally {
      console.log = originalLog;
    }
  });

  it('executes info command for a slice', async () => {
    let output = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await runCli(['info', 'slotted-counter']);
      const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
      assert.ok(plain.includes('ISOLATED SLICE: slotted-counter'));
      assert.ok(plain.includes('@kido/hot-counter'));
      assert.ok(plain.includes('SlottedCounter'));
    } finally {
      console.log = originalLog;
    }
  });

  it('executes add command in dry-run mode', async () => {
    let output = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await runCli(['add', 'slotted-counter', '--dry-run']);
      const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
      assert.ok(plain.includes('[DRY RUN] Would install: slotted-counter'));
      assert.ok(plain.includes('slotted-counter.ts'));
    } finally {
      console.log = originalLog;
    }
  });
});
