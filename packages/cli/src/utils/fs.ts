import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Searches upwards from startDir to locate the kido-packages monorepo root
 */
export function findMonorepoRoot(startDir: string = process.cwd()): string | null {
  // Check environment override first
  if (process.env.KIDO_PACKAGES_ROOT && fs.existsSync(process.env.KIDO_PACKAGES_ROOT)) {
    return path.resolve(process.env.KIDO_PACKAGES_ROOT);
  }

  // Check known standard paths on this machine
  const knownLocations = [
    '/root/projects/core/kido-packages',
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
  ];
  for (const loc of knownLocations) {
    if (fs.existsSync(path.join(loc, 'packages', 'PACKAGES_REGISTRY.md'))) {
      return path.resolve(loc);
    }
  }

  // Ascend directory tree
  let current = path.resolve(startDir);
  while (true) {
    const candidateRegistry = path.join(current, 'packages', 'PACKAGES_REGISTRY.md');
    if (fs.existsSync(candidateRegistry)) {
      return current;
    }
    const candidateWorkspace = path.join(current, 'pnpm-workspace.yaml');
    if (
      fs.existsSync(candidateWorkspace) &&
      fs.existsSync(path.join(current, 'packages'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export interface CopiedFileInfo {
  source: string;
  target: string;
  size: number;
}

/**
 * Recursively copies a directory
 */
export function copyDirectoryRecursive(
  srcDir: string,
  destDir: string,
  dryRun: boolean = false
): CopiedFileInfo[] {
  const copiedFiles: CopiedFileInfo[] = [];

  if (!fs.existsSync(srcDir)) {
    throw new Error(`Source directory does not exist: ${srcDir}`);
  }

  if (!dryRun) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    // Skip node_modules, dist, .turbo, tests
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.turbo' ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.spec.ts')
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      const subCopies = copyDirectoryRecursive(srcPath, destPath, dryRun);
      copiedFiles.push(...subCopies);
    } else if (entry.isFile()) {
      const stat = fs.statSync(srcPath);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
      copiedFiles.push({
        source: srcPath,
        target: destPath,
        size: stat.size,
      });
    }
  }

  return copiedFiles;
}

/**
 * Copies a single slice file, plus any companion files it imports (e.g. ./types.ts, ./schemas.ts)
 */
export function copySingleFileSlice(
  srcFile: string,
  destFile: string,
  dryRun: boolean = false
): CopiedFileInfo[] {
  if (!fs.existsSync(srcFile)) {
    throw new Error(`Source file does not exist: ${srcFile}`);
  }

  const copiedFiles: CopiedFileInfo[] = [];
  const stat = fs.statSync(srcFile);
  const destDir = path.dirname(destFile);

  if (!dryRun) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcFile, destFile);
  }

  copiedFiles.push({
    source: srcFile,
    target: destFile,
    size: stat.size,
  });

  // Check for local relative imports like './types', './constants', './schemas'
  const content = fs.readFileSync(srcFile, 'utf-8');
  const localImportRegex = /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"]\.\/([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  const srcDir = path.dirname(srcFile);
  const companionsChecked = new Set<string>();

  while ((match = localImportRegex.exec(content)) !== null) {
    const relativeName = match[1];
    if (companionsChecked.has(relativeName)) continue;
    companionsChecked.add(relativeName);

    // Possible extensions
    const candidates = [
      `${relativeName}.ts`,
      `${relativeName}.tsx`,
      `${relativeName}.js`,
      `${relativeName}/index.ts`,
    ];

    for (const cand of candidates) {
      const candSrc = path.join(srcDir, cand);
      if (fs.existsSync(candSrc)) {
        const candDest = path.join(destDir, cand);
        if (!dryRun) {
          fs.mkdirSync(path.dirname(candDest), { recursive: true });
          fs.copyFileSync(candSrc, candDest);
        }
        const candStat = fs.statSync(candSrc);
        copiedFiles.push({
          source: candSrc,
          target: candDest,
          size: candStat.size,
        });
        break;
      }
    }
  }

  return copiedFiles;
}
