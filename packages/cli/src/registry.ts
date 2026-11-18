import * as fs from 'node:fs';
import * as path from 'node:path';
import { Blueprint, PackageEntry, Pillar, RegistryData, SliceEntry, ListOptions } from './types';
import { findMonorepoRoot } from './utils/fs';
import embeddedRegistry from './data/registry.json';

/**
 * Parses PACKAGES_REGISTRY.md and optional ARCHITECTURE_BLUEPRINTS.md into RegistryData
 */
export function parseRegistryMarkdown(
  registryMd: string,
  blueprintsMd?: string
): RegistryData {
  const pillars: Pillar[] = [];
  let currentPillar: Pillar | null = null;

  const lines = registryMd.split('\n');
  for (const line of lines) {
    const pillarMatch = line.match(/^##\s+(\d+)\.\s+(.*?)\s+\(`(\d+)\s+Combo Suites`\)/);
    if (pillarMatch) {
      currentPillar = {
        id: parseInt(pillarMatch[1], 10),
        name: pillarMatch[2].trim(),
        suitesCount: parseInt(pillarMatch[3], 10),
        packages: [],
      };
      pillars.push(currentPillar);
      continue;
    }

    if (
      currentPillar &&
      line.startsWith('|') &&
      !line.includes('Combo Package') &&
      !line.includes('---|')
    ) {
      const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 4) {
        const num = parseInt(parts[0], 10);
        const rawPkgName = parts[1].replace(/[`]/g, '');
        const pkgPath = parts[2].replace(/[`]/g, '');
        const details = parts[3];
        const shortName = rawPkgName.replace('@kido/', '');

        const slices: SliceEntry[] = [];
        const bulletParts = details
          .split('<br>• ')
          .map((b) => b.replace(/^•\s+/, '').trim());

        for (const bullet of bulletParts) {
          const boldMatch = bullet.match(/\*\*([^*]+)\*\*/);
          if (!boldMatch) continue;

          const pathSegment = boldMatch[1];
          const colonIdx = bullet.indexOf(':');
          const exportsPart = colonIdx !== -1 ? bullet.substring(colonIdx + 1).trim() : '';
          const exportSymbols = (exportsPart.match(/`([^`]+)`/g) || []).map((s) =>
            s.replace(/`/g, '')
          );

          const rawPaths = pathSegment.split(/&amp;|&/).map((p) => p.trim().replace(/`/g, ''));
          for (const rp of rawPaths) {
            if (!rp.startsWith('src/')) continue;
            const isDir = rp.endsWith('/');
            const sliceName = isDir
              ? rp.replace('src/', '').replace('/', '')
              : rp.replace('src/', '').replace(/\.(ts|tsx|js|mjs)$/, '');

            slices.push({
              name: sliceName,
              path: rp,
              type: isDir ? 'directory' : 'file',
              packageName: rawPkgName,
              packagePath: pkgPath,
              exports: exportSymbols,
              description: bullet.split(':')[0].replace(/\*\*/g, '').replace(/`/g, '').trim(),
            });
          }
        }

        currentPillar.packages.push({
          num,
          name: rawPkgName,
          shortName,
          path: pkgPath,
          description: details.split('<br>')[0].replace(/\*\*/g, '').replace(/`/g, '').trim(),
          slices,
        });
      }
    }
  }

  const blueprints: Blueprint[] = [];
  if (blueprintsMd) {
    const bpLines = blueprintsMd.split('\n');
    let inTable = false;
    for (const line of bpLines) {
      if (line.includes('Master Blueprint Index')) {
        inTable = true;
        continue;
      }
      if (inTable && line.startsWith('| **')) {
        const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 4) {
          const id = parts[0].replace(/\*\*/g, '').trim();
          const name = parts[1].replace(/\*\*/g, '').trim();
          const paradigm = parts[2].trim();
          const composedSlices = parts[3].trim();
          const benchmark = parts[4] ? parts[4].trim() : '';
          const slug = `${id}-${name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')}`;

          blueprints.push({
            id,
            slug,
            name,
            paradigm,
            composedSlices,
            benchmark,
          });
        }
      } else if (inTable && line.startsWith('---') && blueprints.length > 0) {
        inTable = false;
      }
    }
  }

  const totalSlices = pillars.reduce(
    (sum, p) => sum + p.packages.reduce((s, pkg) => s + pkg.slices.length, 0),
    0
  );
  const totalPackages = pillars.reduce((sum, p) => sum + p.packages.length, 0);

  return {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    totalPackages,
    totalSlices,
    pillars,
    blueprints: blueprints.length > 0 ? blueprints : (embeddedRegistry.blueprints as Blueprint[]),
  };
}

/**
 * Loads registry metadata from PACKAGES_REGISTRY.md if available, or falls back to bundled JSON
 */
export async function loadRegistry(options: {
  registryPath?: string;
  blueprintsPath?: string;
  cwd?: string;
} = {}): Promise<RegistryData> {
  const root = findMonorepoRoot(options.cwd || process.cwd());

  let regMdPath = options.registryPath;
  if (!regMdPath && root) {
    const candidate = path.join(root, 'packages', 'PACKAGES_REGISTRY.md');
    if (fs.existsSync(candidate)) {
      regMdPath = candidate;
    }
  }

  let bpMdPath = options.blueprintsPath;
  if (!bpMdPath && root) {
    const candidate = path.join(root, 'ARCHITECTURE_BLUEPRINTS.md');
    if (fs.existsSync(candidate)) {
      bpMdPath = candidate;
    }
  }

  if (regMdPath && fs.existsSync(regMdPath)) {
    try {
      const regContent = fs.readFileSync(regMdPath, 'utf-8');
      const bpContent = bpMdPath && fs.existsSync(bpMdPath) ? fs.readFileSync(bpMdPath, 'utf-8') : undefined;
      return parseRegistryMarkdown(regContent, bpContent);
    } catch {
      // Fallback to embedded registry
    }
  }

  return embeddedRegistry as RegistryData;
}

/**
 * Flattens all slices across all packages
 */
export function getAllSlices(registry: RegistryData): SliceEntry[] {
  const slices: SliceEntry[] = [];
  for (const pillar of registry.pillars) {
    for (const pkg of pillar.packages) {
      for (const slice of pkg.slices) {
        slices.push(slice);
      }
    }
  }
  return slices;
}

/**
 * Resolves a slice query (e.g. "slotted-counter", "@kido/hot-counter/slotted-counter", "hot-counter/slotted-counter")
 */
export function findSlice(
  query: string,
  registry: RegistryData
): { slice?: SliceEntry; matches: SliceEntry[] } {
  const cleanQuery = query.trim().toLowerCase().replace(/\.(ts|tsx|js|mjs)$/, '');
  const allSlices = getAllSlices(registry);

  // 1. Exact match on slice name
  const exact = allSlices.find((s) => s.name.toLowerCase() === cleanQuery);
  if (exact) return { slice: exact, matches: [exact] };

  // 2. Package-qualified match: e.g. "@kido/hot-counter/slotted-counter" or "hot-counter/slotted-counter"
  if (cleanQuery.includes('/')) {
    const parts = cleanQuery.split('/');
    const targetSlice = parts[parts.length - 1];
    const targetPkg = parts.slice(0, parts.length - 1).join('/').replace('@kido/', '');

    const qualified = allSlices.find((s) => {
      const pkgShort = s.packageName.replace('@kido/', '').toLowerCase();
      return pkgShort === targetPkg && s.name.toLowerCase() === targetSlice;
    });
    if (qualified) return { slice: qualified, matches: [qualified] };
  }

  // 3. Substring / partial match
  const matches = allSlices.filter(
    (s) =>
      s.name.toLowerCase().includes(cleanQuery) ||
      s.packageName.toLowerCase().includes(cleanQuery) ||
      s.exports.some((exp) => exp.toLowerCase().includes(cleanQuery))
  );

  return {
    slice: matches.length === 1 ? matches[0] : undefined,
    matches,
  };
}

/**
 * Resolves a blueprint query (e.g. "01", "youtube-view-counter", "01-youtube-view-counter")
 */
export function findBlueprint(
  query: string,
  registry: RegistryData,
  exactOnly: boolean = false
): { blueprint?: Blueprint; matches: Blueprint[] } {
  const clean = query.trim().toLowerCase().replace(/^blueprint\//, '');

  // 1. Exact match by ID (e.g. "01" or "1")
  const idMatch = registry.blueprints.find(
    (b) => b.id.toLowerCase() === clean || parseInt(b.id, 10).toString() === clean
  );
  if (idMatch) return { blueprint: idMatch, matches: [idMatch] };

  // 2. Exact match by slug or name
  const exact = registry.blueprints.find(
    (b) => b.slug.toLowerCase() === clean || b.name.toLowerCase() === clean
  );
  if (exact) return { blueprint: exact, matches: [exact] };

  if (exactOnly) {
    return { blueprint: undefined, matches: [] };
  }

  // 3. Substring match on slug or name
  const matches = registry.blueprints.filter(
    (b) =>
      b.slug.toLowerCase().includes(clean) ||
      b.name.toLowerCase().includes(clean)
  );

  return {
    blueprint: matches.length === 1 ? matches[0] : undefined,
    matches,
  };
}

/**
 * Filters the registry according to list options
 */
export function filterRegistry(
  registry: RegistryData,
  options: ListOptions
): { pillars: Pillar[]; blueprints: Blueprint[] } {
  let filteredPillars = registry.pillars;
  let filteredBlueprints = registry.blueprints;

  // Filter by pillar
  if (options.pillar !== undefined) {
    const pStr = String(options.pillar).toLowerCase();
    const pNum = parseInt(pStr, 10);
    filteredPillars = filteredPillars.filter(
      (p) => (!isNaN(pNum) && p.id === pNum) || p.name.toLowerCase().includes(pStr)
    );
  }

  // Filter by search keyword
  if (options.search) {
    const q = options.search.toLowerCase();
    filteredPillars = filteredPillars
      .map((pillar) => {
        const matchingPkgs = pillar.packages
          .map((pkg) => {
            const pkgMatches =
              pkg.name.toLowerCase().includes(q) ||
              pkg.description.toLowerCase().includes(q);
            const matchingSlices = pkg.slices.filter(
              (s) =>
                s.name.toLowerCase().includes(q) ||
                s.exports.some((e) => e.toLowerCase().includes(q))
            );
            if (pkgMatches || matchingSlices.length > 0) {
              return {
                ...pkg,
                slices: matchingSlices.length > 0 ? matchingSlices : pkg.slices,
              };
            }
            return null;
          })
          .filter((pkg): pkg is PackageEntry => pkg !== null);

        return {
          ...pillar,
          packages: matchingPkgs,
        };
      })
      .filter((pillar) => pillar.packages.length > 0);

    filteredBlueprints = filteredBlueprints.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.slug.toLowerCase().includes(q) ||
        b.paradigm.toLowerCase().includes(q) ||
        b.composedSlices.toLowerCase().includes(q)
    );
  }

  if (options.blueprintsOnly) {
    filteredPillars = [];
  } else if (options.slicesOnly) {
    filteredBlueprints = [];
  }

  return {
    pillars: filteredPillars,
    blueprints: filteredBlueprints,
  };
}
