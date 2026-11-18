import { filterRegistry, loadRegistry } from '../registry';
import { ListOptions } from '../types';
import { colors } from '../utils/colors';

export async function executeListCommand(options: ListOptions = {}): Promise<void> {
  const registry = await loadRegistry();
  const { pillars, blueprints } = filterRegistry(registry, options);

  if (options.json) {
    console.log(JSON.stringify({ pillars, blueprints }, null, 2));
    return;
  }

  console.log(`\n${colors.bold(colors.cyan('👜 KIDO BAG ARCHITECTURE REGISTRY'))} ${colors.dim(`(v${registry.version})`)}`);
  console.log(colors.dim('The Shadcn for Distributed Systems & High-Concurrency Primitives\n'));

  // 1. Blueprints Section
  if (blueprints.length > 0 && !options.slicesOnly) {
    console.log(colors.bold(colors.yellow(`🏛️ MASTER ARCHITECTURE BLUEPRINTS (${blueprints.length})`)));
    console.log(colors.dim('Plug-and-play composite recipes composed from isolated domain slices:\n'));

    for (const bp of blueprints) {
      console.log(`  ${colors.bold(colors.cyan(`[${bp.id}]`))} ${colors.bold(bp.name)}`);
      console.log(`      ${colors.dim('Paradigm:')} ${bp.paradigm}`);
      console.log(`      ${colors.dim('Slices:')}   ${colors.green(bp.composedSlices)}`);
      if (bp.benchmark) {
        console.log(`      ${colors.dim('Proof:')}    ${colors.magenta(bp.benchmark)}`);
      }
      console.log(`      ${colors.dim('Command:')}  ${colors.bold(`npx kido-bag add ${bp.id}`)}\n`);
    }
  }

  // 2. Pillars & Slices Section
  if (pillars.length > 0 && !options.blueprintsOnly) {
    console.log(colors.bold(colors.yellow(`📦 DOMAIN COMBO SUITES & ISOLATED SLICES (${pillars.length} Pillars)`)));
    console.log(colors.dim('Every slice is 100% self-contained with zero cross-slice coupling:\n'));

    for (const pillar of pillars) {
      console.log(`${colors.bold(colors.magenta(`Pillar ${pillar.id}: ${pillar.name}`))} ${colors.dim(`(${pillar.packages.length} combo suites)`)}`);

      for (const pkg of pillar.packages) {
        console.log(`  ${colors.bold(colors.cyan(pkg.name))} ${colors.dim(`(${pkg.path})`)}`);
        console.log(`    ${colors.dim(pkg.description)}`);

        if (pkg.slices.length > 0) {
          console.log(`    ${colors.dim('Slices:')}`);
          for (const slice of pkg.slices) {
            const typeBadge = slice.type === 'directory' ? colors.blue('[dir]') : colors.dim('[file]');
            const exportList = slice.exports.length > 0 ? ` → ${colors.dim(slice.exports.slice(0, 3).join(', '))}${slice.exports.length > 3 ? colors.dim(` (+${slice.exports.length - 3})`) : ''}` : '';
            console.log(`      • ${colors.green(slice.name)} ${typeBadge}${exportList}`);
          }
        }
        console.log();
      }
    }
  }

  // Footer instructions
  console.log(colors.dim('─'.repeat(70)));
  console.log(`${colors.bold('Quick Start:')}`);
  console.log(`  ${colors.green('npx kido-bag add <slice>')}        ${colors.dim('Extract single slice to src/lib/kido')}`);
  console.log(`  ${colors.green('npx kido-bag add <blueprint>')}    ${colors.dim('Extract entire composite recipe (e.g. 01)')}`);
  console.log(`  ${colors.green('npx kido-bag list --pillar 2')}    ${colors.dim('Filter slices by pillar')}`);
  console.log(`  ${colors.green('npx kido-bag list --search hot')}   ${colors.dim('Search slices & blueprints by term')}\n`);
}
