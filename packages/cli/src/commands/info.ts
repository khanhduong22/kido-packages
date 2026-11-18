import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBlueprint, findSlice, loadRegistry } from '../registry';
import { colors } from '../utils/colors';
import { analyzeImports } from '../utils/deps';
import { findMonorepoRoot } from '../utils/fs';

export async function executeInfoCommand(target: string): Promise<void> {
  if (!target) {
    throw new Error('Please specify a slice or blueprint name: e.g. npx kido-bag info slotted-counter');
  }

  const registry = await loadRegistry();

  // 1. Check exact Blueprint ID or slug first (e.g. "01", "01-youtube-view-counter", "blueprint/01")
  const { blueprint: exactBp } = findBlueprint(target, registry, true);
  if (exactBp) {
    printBlueprintInfo(exactBp);
    return;
  }

  // 2. Check Slice match
  const { slice, matches } = findSlice(target, registry);
  if (!slice && matches.length > 1) {
    console.log(colors.yellow(`\nMultiple slices matched "${target}":`));
    for (const m of matches) {
      console.log(`  • ${colors.bold(m.packageName)}/${colors.green(m.name)}`);
    }
    console.log();
    return;
  }

  if (slice) {
    printSliceInfo(slice);
    return;
  }

  // 3. Fallback to fuzzy blueprint match
  const { blueprint: fuzzyBp } = findBlueprint(target, registry, false);
  if (fuzzyBp) {
    printBlueprintInfo(fuzzyBp);
    return;
  }

  throw new Error(`Slice or blueprint "${target}" not found.`);
}

function printBlueprintInfo(bp: any): void {
  console.log(`\n${colors.bold(colors.yellow(`🏛️ ARCHITECTURE BLUEPRINT [${bp.id}]:`))} ${colors.bold(bp.name)}`);
  console.log(`${colors.dim('Slug:')}           ${bp.slug}`);
  console.log(`${colors.dim('Paradigm:')}       ${bp.paradigm}`);
  console.log(`${colors.dim('Composed Slices:')} ${colors.green(bp.composedSlices)}`);
  if (bp.benchmark) {
    console.log(`${colors.dim('Proof/k6:')}       ${colors.magenta(bp.benchmark)}`);
  }
  console.log(`\n${colors.bold('To install this entire blueprint:')}`);
  console.log(`  ${colors.green(`npx kido-bag add ${bp.id}`)}\n`);
}

function printSliceInfo(slice: any): void {
  console.log(`\n${colors.bold(colors.cyan('⚡ ISOLATED SLICE:'))} ${colors.bold(colors.green(slice.name))}`);
  console.log(`${colors.dim('Package:')}      ${colors.bold(slice.packageName)}`);
  console.log(`${colors.dim('Type:')}         ${slice.type === 'directory' ? 'Directory Module' : 'Single File'}`);
  console.log(`${colors.dim('Source Path:')}  ${slice.packagePath}/${slice.path}`);
  if (slice.description) {
    console.log(`${colors.dim('Description:')}  ${slice.description}`);
  }

  if (slice.exports.length > 0) {
    console.log(`${colors.dim('Exports:')}`);
    for (const exp of slice.exports) {
      console.log(`  • ${colors.bold(exp)}`);
    }
  }

  // If inside repo, analyze dependencies directly
  const root = findMonorepoRoot();
  if (root) {
    const fullSource = path.join(root, slice.packagePath, slice.path);
    if (fs.existsSync(fullSource)) {
      let contents: string[] = [];
      if (fs.statSync(fullSource).isDirectory()) {
        const files = fs.readdirSync(fullSource).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
        contents = files.map((f) => fs.readFileSync(path.join(fullSource, f), 'utf-8'));
      } else {
        contents = [fs.readFileSync(fullSource, 'utf-8')];
      }
      const analysis = analyzeImports(contents);
      console.log(`${colors.dim('External Deps:')} ${analysis.externalDeps.length > 0 ? colors.yellow(analysis.externalDeps.join(', ')) : colors.green('None (Zero External Dependencies)')}`);
    }
  }

  console.log(`\n${colors.bold('To cherry-pick this slice into your project:')}`);
  console.log(`  ${colors.green(`npx kido-bag add ${slice.name}`)}\n`);
}
