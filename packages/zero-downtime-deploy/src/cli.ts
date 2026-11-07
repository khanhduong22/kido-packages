#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  generateDeployWorkflow,
  generateAtomicSwapBeScript,
  generateAtomicSwapFeScript,
  performHealthCheck,
} from './index';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
@kido/zero-downtime-deploy CLI
Universal Zero-Downtime Deployment Toolkit

Usage:
  zero-downtime-deploy init <app-slug> <health-url>
    Scaffolds .github/workflows/deploy.yml and deployment scripts.

  zero-downtime-deploy workflow <app-slug> <health-url>
    Prints generated GitHub Actions workflow YAML to stdout.

  zero-downtime-deploy check <health-url> [timeout-seconds]
    Runs a health check against a target endpoint.

Examples:
  npx @kido/zero-downtime-deploy init order-api https://app.example.com/health
  npx @kido/zero-downtime-deploy check https://app.example.com/health 30
`);
    return;
  }

  if (command === 'init') {
    const appSlug = args[1] || 'sme-app';
    const healthUrl = args[2] || `https://${appSlug}.example.com/health`;

    console.log(`🚀 Initializing Zero-Downtime Deployment setup for '${appSlug}'...`);

    // 1. Generate GitHub Actions workflow
    const workflowDir = path.resolve(process.cwd(), '.github', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    const workflowPath = path.join(workflowDir, 'deploy.yml');
    const workflowContent = generateDeployWorkflow({ appSlug, healthUrl });
    fs.writeFileSync(workflowPath, workflowContent, 'utf-8');
    console.log(`✅ Created ${path.relative(process.cwd(), workflowPath)}`);

    // 2. Scaffold local scripts directory
    const scriptsDir = path.resolve(process.cwd(), 'scripts', 'deploy');
    fs.mkdirSync(scriptsDir, { recursive: true });

    const beScript = generateAtomicSwapBeScript({
      activeContainer: `${appSlug}-api`,
      healthUrl,
    });
    fs.writeFileSync(path.join(scriptsDir, 'atomic-swap-be.sh'), beScript, {
      encoding: 'utf-8',
      mode: 0o755,
    });

    const feScript = generateAtomicSwapFeScript({
      targetDir: `/opt/kido-infra/docker/portfolio/html/apps/${appSlug}`,
    });
    fs.writeFileSync(path.join(scriptsDir, 'atomic-swap-fe.sh'), feScript, {
      encoding: 'utf-8',
      mode: 0o755,
    });

    console.log(`✅ Scaffolding complete! Zero-Downtime Blue-Green deployment ready.`);
    return;
  }

  if (command === 'workflow') {
    const appSlug = args[1] || 'app';
    const healthUrl = args[2] || 'http://127.0.0.1:3000/health';
    console.log(generateDeployWorkflow({ appSlug, healthUrl }));
    return;
  }

  if (command === 'check') {
    const url = args[1];
    if (!url) {
      console.error('❌ Error: URL is required for health check.');
      process.exit(1);
    }
    const timeout = parseInt(args[2] || '45', 10);
    console.log(`🔍 Checking health of ${url} (timeout: ${timeout}s)...`);
    const res = await performHealthCheck(url, { timeoutMs: timeout * 1000 });
    if (res.healthy) {
      console.log(`✅ Health check PASSED (HTTP ${res.status} in ${res.durationMs}ms)`);
    } else {
      console.error(`❌ Health check FAILED: ${res.error}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}. Run with --help for instructions.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
