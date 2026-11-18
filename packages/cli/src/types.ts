export interface SliceEntry {
  name: string;
  path: string; // e.g. "src/tenant-context.ts" or "src/team-rbac/"
  type: 'file' | 'directory';
  packageName: string; // e.g. "@kido/tenant-guard"
  packagePath: string; // e.g. "packages/tenant-guard"
  exports: string[];
  description?: string;
}

export interface PackageEntry {
  num: number;
  name: string; // e.g. "@kido/tenant-guard"
  shortName: string; // e.g. "tenant-guard"
  path: string; // e.g. "packages/tenant-guard"
  description: string;
  slices: SliceEntry[];
}

export interface Pillar {
  id: number;
  name: string;
  suitesCount: number;
  packages: PackageEntry[];
}

export interface Blueprint {
  id: string; // e.g. "01"
  slug: string; // e.g. "01-youtube-view-counter"
  name: string; // e.g. "YouTube-Scale Video View Counter"
  paradigm: string;
  composedSlices: string;
  benchmark: string;
}

export interface RegistryData {
  version: string;
  updatedAt: string;
  totalPackages: number;
  totalSlices: number;
  pillars: Pillar[];
  blueprints: Blueprint[];
}

export interface ListOptions {
  pillar?: number | string;
  blueprintsOnly?: boolean;
  slicesOnly?: boolean;
  search?: string;
  json?: boolean;
}

export interface AddOptions {
  outDir?: string;
  force?: boolean;
  dryRun?: boolean;
  rootPath?: string;
}

export interface AddResult {
  sliceName: string;
  sourcePath: string;
  targetPath: string;
  files: Array<{
    source: string;
    target: string;
    size: number;
  }>;
  externalDependencies: string[];
  peerSlices: string[];
  dryRun: boolean;
}
