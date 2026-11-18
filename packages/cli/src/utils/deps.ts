const NODE_STDLIB_MODULES = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'test',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

export interface DependencyAnalysis {
  externalDeps: string[];
  peerKidoDeps: string[];
  hasNodeDeps: boolean;
  installCommand: {
    pnpm: string;
    npm: string;
    bun: string;
  };
}

/**
 * Parses raw code text and extracts all imports / requires
 */
export function analyzeImports(fileContents: string[]): DependencyAnalysis {
  const externalDepsSet = new Set<string>();
  const peerKidoDepsSet = new Set<string>();
  let hasNodeDeps = false;

  // Regex patterns for ES import/export and CommonJS require
  const importRegex = /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImportRegex = /(?:import|require)\(['"]([^'"]+)['"]\)/g;

  for (const content of fileContents) {
    let match: RegExpExecArray | null;

    // Static imports/exports
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1].trim();
      classifySpecifier(specifier);
    }

    // Dynamic imports / require()
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      const specifier = match[1].trim();
      classifySpecifier(specifier);
    }
  }

  function classifySpecifier(specifier: string) {
    if (!specifier) return;

    // Relative imports
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      return;
    }

    // Node built-in with node: scheme
    if (specifier.startsWith('node:')) {
      hasNodeDeps = true;
      return;
    }

    // Bare node standard library
    if (NODE_STDLIB_MODULES.has(specifier)) {
      hasNodeDeps = true;
      return;
    }

    // Kido peer package
    if (specifier.startsWith('@kido/')) {
      peerKidoDepsSet.add(specifier);
      return;
    }

    // Extract root npm package name (handles scoped packages like @tanstack/react-query)
    const parts = specifier.split('/');
    let pkgName = parts[0];
    if (specifier.startsWith('@') && parts.length >= 2) {
      pkgName = `${parts[0]}/${parts[1]}`;
    }

    externalDepsSet.add(pkgName);
  }

  const externalDeps = Array.from(externalDepsSet).sort();
  const peerKidoDeps = Array.from(peerKidoDepsSet).sort();
  const depsString = externalDeps.join(' ');

  return {
    externalDeps,
    peerKidoDeps,
    hasNodeDeps,
    installCommand: {
      pnpm: depsString ? `pnpm add ${depsString}` : '',
      npm: depsString ? `npm install ${depsString}` : '',
      bun: depsString ? `bun add ${depsString}` : '',
    },
  };
}
