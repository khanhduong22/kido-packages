import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBlueprint, findSlice, getAllSlices, loadRegistry } from '../registry';
import { AddOptions, AddResult, Blueprint, SliceEntry } from '../types';
import { colors } from '../utils/colors';
import { analyzeImports } from '../utils/deps';
import {
  copyDirectoryRecursive,
  copySingleFileSlice,
  findMonorepoRoot,
} from '../utils/fs';

/**
 * Parses composedSlices string from a blueprint, e.g.:
 * "@kido/hot-counter (youtube-view-engine, valkey-write-behind, slotted-counter) + @kido/traffic-attribution (hll-analytics)"
 */
export function parseBlueprintComposedSlices(
  composed: string,
  allSlices: SliceEntry[]
): SliceEntry[] {
  const result: SliceEntry[] = [];
  const cleanComposed = composed.replace(/`/g, '');
  const parts = cleanComposed.split('+').map((p) => p.trim());

  for (const part of parts) {
    // Matches: @kido/<package> (slice1, slice2, ...)
    const pkgMatch = part.match(/(@kido\/[\w-]+)\s*(?:\(([^)]+)\))?/);
    if (!pkgMatch) continue;

    const pkgName = pkgMatch[1];
    const sliceNamesPart = pkgMatch[2];

    if (sliceNamesPart) {
      const sliceNames = sliceNamesPart.split(',').map((s) => s.trim().toLowerCase());
      for (const sName of sliceNames) {
        const matched = allSlices.find(
          (s) =>
            s.packageName === pkgName &&
            (s.name.toLowerCase() === sName || s.name.toLowerCase().includes(sName))
        );
        if (matched && !result.includes(matched)) {
          result.push(matched);
        }
      }
    } else {
      // Entire package slices
      const pkgSlices = allSlices.filter((s) => s.packageName === pkgName);
      for (const s of pkgSlices) {
        if (!result.includes(s)) result.push(s);
      }
    }
  }

  return result;
}

/**
 * Adds an isolated slice to the target project
 */
export async function addSlice(
  slice: SliceEntry,
  monorepoRoot: string,
  options: AddOptions = {}
): Promise<AddResult> {
  const outDir = options.outDir || 'src/lib/kido';
  const dryRun = Boolean(options.dryRun);
  const targetDir = path.resolve(process.cwd(), outDir);

  // Resolve source path on disk
  let sourceCandidate = path.join(monorepoRoot, slice.packagePath, slice.path);
  if (!fs.existsSync(sourceCandidate)) {
    if (fs.existsSync(`${sourceCandidate}.ts`)) {
      sourceCandidate = `${sourceCandidate}.ts`;
    } else if (sourceCandidate.endsWith('/') && fs.existsSync(sourceCandidate.slice(0, -1))) {
      sourceCandidate = sourceCandidate.slice(0, -1);
    } else {
      throw new Error(`Slice source file/dir not found: ${sourceCandidate}`);
    }
  }

  const isDirectory = fs.statSync(sourceCandidate).isDirectory();
  const destPath = isDirectory
    ? path.join(targetDir, slice.name)
    : path.join(targetDir, path.basename(sourceCandidate));

  // Check overwrite protection
  if (fs.existsSync(destPath) && !options.force && !dryRun) {
    if (!isDirectory && fs.existsSync(destPath)) {
      const srcBuf = fs.readFileSync(sourceCandidate);
      const destBuf = fs.readFileSync(destPath);
      if (!srcBuf.equals(destBuf)) {
        throw new Error(
          `Destination already exists: ${destPath}\nUse --force to overwrite existing files.`
        );
      }
    } else {
      throw new Error(
        `Destination already exists: ${destPath}\nUse --force to overwrite existing files.`
      );
    }
  }

  let copiedFiles;
  if (isDirectory) {
    copiedFiles = copyDirectoryRecursive(sourceCandidate, destPath, dryRun);
  } else {
    copiedFiles = copySingleFileSlice(sourceCandidate, destPath, dryRun);
  }

  // Read file contents to analyze dependencies
  const fileContents = copiedFiles.map((f) =>
    fs.existsSync(f.source) ? fs.readFileSync(f.source, 'utf-8') : ''
  );
  const analysis = analyzeImports(fileContents);

  return {
    sliceName: slice.name,
    sourcePath: sourceCandidate,
    targetPath: destPath,
    files: copiedFiles,
    externalDependencies: analysis.externalDeps,
    peerSlices: analysis.peerKidoDeps,
    dryRun,
  };
}

/**
 * Executes the `add` CLI command
 */
export async function executeAddCommand(
  target: string,
  options: AddOptions = {}
): Promise<AddResult[]> {
  if (!target) {
    throw new Error('Please specify a slice or blueprint to add (e.g. npx kido-bag add slotted-counter)');
  }

  const registry = await loadRegistry();
  const root = findMonorepoRoot(options.rootPath || process.cwd());

  if (!root) {
    throw new Error(
      'Kido Packages source repository not found.\n' +
      'Please ensure you are inside kido-packages or set KIDO_PACKAGES_ROOT to the repository path.'
    );
  }

  const outDir = options.outDir || 'src/lib/kido';
  const dryRun = Boolean(options.dryRun);

  // 1. Check if target matches an exact Blueprint ID or slug
  const { blueprint: exactBp } = findBlueprint(target, registry, true);
  if (exactBp) {
    return handleBlueprintAdd(exactBp, registry, root, outDir, dryRun, options);
  }

  // 2. Check if target matches an individual Slice
  const { slice: matchedSlice, matches } = findSlice(target, registry);

  if (!matchedSlice && matches.length > 1) {
    console.log(colors.yellow(`\nMultiple slices matched "${target}":`));
    for (const m of matches) {
      console.log(`  • ${colors.bold(m.packageName)}/${colors.green(m.name)} ${colors.dim(`(${m.path})`)}`);
    }
    console.log(colors.dim('\nPlease specify the qualified name: e.g. npx kido-bag add <package>/<slice>\n'));
    return [];
  }

  if (matchedSlice) {
    console.log(`\n${colors.bold(colors.cyan('⚡ Cherry-Picking Isolated Slice:'))} ${colors.bold(colors.green(matchedSlice.name))}`);
    console.log(`${colors.dim('From Package:')} ${matchedSlice.packageName}`);
    console.log(`${colors.dim('Relative Path:')} ${matchedSlice.path}`);
    if (matchedSlice.exports.length > 0) {
      console.log(`${colors.dim('Exports:')} ${colors.dim(matchedSlice.exports.join(', '))}`);
    }
    console.log();

    const result = await addSlice(matchedSlice, root, options);
    printSingleSliceSummary(result, dryRun);
    return [result];
  }

  // 3. Fallback to fuzzy blueprint matching
  const { blueprint: fuzzyBp } = findBlueprint(target, registry, false);
  if (fuzzyBp) {
    return handleBlueprintAdd(fuzzyBp, registry, root, outDir, dryRun, options);
  }

  throw new Error(
    `Slice or blueprint "${target}" not found in Kido Packages Registry.\nRun "npx kido-bag list" to see all available slices.`
  );
}

async function handleBlueprintAdd(
  matchedBp: Blueprint,
  registry: any,
  root: string,
  outDir: string,
  dryRun: boolean,
  options: AddOptions
): Promise<AddResult[]> {
  console.log(`\n${colors.bold(colors.cyan('🏛️ Extracting Master Blueprint:'))} ${colors.bold(matchedBp.name)}`);
  console.log(`${colors.dim('Paradigm:')} ${matchedBp.paradigm}`);
  if (matchedBp.benchmark) {
    console.log(`${colors.dim('Benchmark Proof:')} ${colors.magenta(matchedBp.benchmark)}`);
  }
  console.log();

  const allSlices = getAllSlices(registry);
  const composed = parseBlueprintComposedSlices(matchedBp.composedSlices, allSlices);

  if (composed.length === 0) {
    throw new Error(`Could not resolve composed slices for blueprint ${matchedBp.name}`);
  }

  const results: AddResult[] = [];
  const allExternalDeps = new Set<string>();
  const allPeerDeps = new Set<string>();

  for (const slice of composed) {
    // Blueprint slices are placed in a subfolder named after the blueprint slug
    const bpOutDir = path.join(outDir, matchedBp.slug);
    const res = await addSlice(slice, root, {
      ...options,
      force: options.force ?? true,
      outDir: bpOutDir,
    });
    results.push(res);
    res.externalDependencies.forEach((d) => allExternalDeps.add(d));
    res.peerSlices.forEach((p) => allPeerDeps.add(p));
  }

  printBlueprintSummary(matchedBp, results, Array.from(allExternalDeps), dryRun);
  return results;
}

function printSingleSliceSummary(result: AddResult, dryRun: boolean): void {
  const prefix = dryRun ? colors.yellow('[DRY RUN] Would install:') : colors.green('✔ Successfully installed:');
  console.log(`${prefix} ${colors.bold(result.sliceName)}`);
  console.log(`${colors.dim('Destination:')} ${colors.cyan(result.targetPath)}`);
  console.log(`${colors.dim('Files:')}`);

  for (const f of result.files) {
    const relTarget = path.relative(process.cwd(), f.target);
    console.log(`  • ${colors.bold(relTarget)} ${colors.dim(`(${f.size} bytes)`)}`);
  }
  console.log();

  // External dependency resolution notes
  if (result.externalDependencies.length > 0) {
    const depsStr = result.externalDependencies.join(' ');
    console.log(colors.bold(colors.yellow('📦 External Dependencies Required:')));
    console.log(`  Run one of the following commands in your project:`);
    console.log(`  ${colors.green(`pnpm add ${depsStr}`)}`);
    console.log(`  ${colors.dim(`npm install ${depsStr} | bun add ${depsStr}`)}\n`);
  } else {
    console.log(`${colors.green('✨ Zero external dependencies!')} ${colors.dim('Pure TypeScript & Node.js stdlib.')}\n`);
  }

  if (result.peerSlices.length > 0) {
    console.log(colors.dim(`ℹ️ Note: Uses Kido peer concepts: ${result.peerSlices.join(', ')}`));
  }
}

function printBlueprintSummary(
  bp: Blueprint,
  results: AddResult[],
  externalDeps: string[],
  dryRun: boolean
): void {
  const prefix = dryRun ? colors.yellow('[DRY RUN] Would install blueprint:') : colors.green('✔ Successfully installed blueprint:');
  console.log(`${prefix} ${colors.bold(bp.name)}`);
  console.log(`${colors.dim('Extracted')} ${results.length} ${colors.dim('isolated slices:')}`);

  for (const res of results) {
    console.log(`  ${colors.green('✔')} ${colors.bold(res.sliceName)} ${colors.dim(`(${res.files.length} files)`)}`);
  }
  console.log();

  if (externalDeps.length > 0) {
    const depsStr = externalDeps.sort().join(' ');
    console.log(colors.bold(colors.yellow('📦 External Dependencies Required for this Blueprint:')));
    console.log(`  Run one of the following commands in your project:`);
    console.log(`  ${colors.green(`pnpm add ${depsStr}`)}`);
    console.log(`  ${colors.dim(`npm install ${depsStr} | bun add ${depsStr}`)}\n`);
  } else {
    console.log(`${colors.green('✨ Zero external dependencies!')} ${colors.dim('Pure TypeScript & Node.js stdlib.')}\n`);
  }
}
