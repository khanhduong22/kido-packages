import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 1. Setup lightweight mock for DOMPurify to allow Mermaid parsing in Node.js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
try {
  const mermaidPath = require.resolve('mermaid');
  let cur = path.dirname(mermaidPath);
  let dpPath = null;
  while (cur !== path.dirname(cur)) {
    const candidate = path.join(cur, 'node_modules/dompurify/dist/purify.es.mjs');
    if (fs.existsSync(candidate)) {
      dpPath = candidate;
      break;
    }
    cur = path.dirname(cur);
  }
  if (dpPath) {
    const dpModule = await import('file://' + dpPath);
    const dompurify = dpModule.default || dpModule;
    if (dompurify) {
      dompurify.sanitize = (txt) => txt;
      dompurify.addHook = () => {};
    }
  }
} catch (e) {
  console.warn('Warning: Could not patch DOMPurify directly:', e.message);
}

// 2. Initialize Mermaid
const mermaidModule = await import('mermaid');
const mermaid = mermaidModule.default || mermaidModule;
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docsRoot = path.resolve(__dirname, '../content/docs');

function findMdxFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMdxFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function extractMermaidBlocks(content) {
  // Matches ```mermaid ... ```
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0];
    const code = match[1].trim();
    // Calculate 1-based line number
    const line = content.slice(0, match.index).split('\n').length;
    blocks.push({ code, line });
  }
  return blocks;
}

async function audit() {
  console.log(`\n🔍 Scanning MDX files in ${docsRoot}...\n`);
  const files = findMdxFiles(docsRoot);
  let totalDiagrams = 0;
  let passCount = 0;
  let failCount = 0;
  const failures = [];

  for (const file of files) {
    const relPath = path.relative(docsRoot, file);
    const content = fs.readFileSync(file, 'utf-8');
    const blocks = extractMermaidBlocks(content);

    if (blocks.length === 0) {
      continue;
    }

    for (let i = 0; i < blocks.length; i++) {
      totalDiagrams++;
      const { code, line } = blocks[i];
      try {
        await mermaid.parse(code);
        passCount++;
        console.log(`  ✓ PASS: ${relPath}:${line} (Diagram #${i + 1})`);
      } catch (err) {
        failCount++;
        const errMsg = err?.message || String(err);
        console.error(`  ✗ FAIL: ${relPath}:${line} (Diagram #${i + 1})\n    Error: ${errMsg.split('\n')[0]}`);
        failures.push({
          file: relPath,
          line,
          index: i + 1,
          code,
          error: errMsg,
        });
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Mermaid Audit Results:`);
  console.log(`  Total Diagrams Scanned: ${totalDiagrams}`);
  console.log(`  Passed:                 ${passCount}`);
  console.log(`  Failed:                 ${failCount}`);
  console.log('='.repeat(60) + '\n');

  if (failures.length > 0) {
    console.log('Detailed Failures:\n');
    for (const f of failures) {
      console.log(`--- [FAIL] ${f.file}:${f.line} ---`);
      console.log(f.error);
      console.log('\nDiagram snippet:');
      console.log(f.code.split('\n').slice(0, 10).join('\n'));
      console.log('...\n');
    }
    process.exit(1);
  } else {
    console.log('🎉 All Mermaid diagrams parsed successfully with 0 errors!\n');
    process.exit(0);
  }
}

audit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
