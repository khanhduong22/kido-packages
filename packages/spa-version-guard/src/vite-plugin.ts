import type { ViteVersionPluginOptions, VersionFileInfo } from './types';

/**
 * Attempts to retrieve the current git commit hash safely
 */
function resolveGitCommit(gitCommitOption?: string | boolean): string | undefined {
  if (typeof gitCommitOption === 'string') {
    return gitCommitOption;
  }
  if (gitCommitOption === false) {
    return undefined;
  }

  // Check common CI environment variables
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 7);
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA.slice(0, 7);
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);

  try {
    // Dynamic require to prevent bundler issues in non-node runtimes
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Generates default build ID from date and git commit
 */
function generateDefaultBuildId(version: string, commit?: string): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const suffix = commit || Date.now().toString(36);
  return `${today}.${version}.${suffix}`;
}

export interface SpaVersionPluginOutput {
  name: string;
  config: (userConfig: Record<string, unknown>) => Record<string, unknown>;
  configureServer: (server: {
    middlewares: {
      use: (
        path: string,
        handler: (
          req: unknown,
          res: {
            setHeader: (k: string, v: string) => void;
            end: (data: string) => void;
          }
        ) => void
      ) => void;
    };
  }) => void;
  generateBundle: (this: {
    emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void;
  }) => void;
  getVersionData: () => VersionFileInfo;
}

/**
 * Vite Plugin that:
 * 1. Defines `__APP_BUILD_ID__` and `__APP_VERSION__` for client code.
 * 2. Emits `version.json` into the build output directory (`dist/`).
 * 3. Serves `/version.json` during development via Vite dev server middleware.
 */
export function viteVersionPlugin(
  options: ViteVersionPluginOptions = {}
): SpaVersionPluginOutput {
  const fileName = options.fileName || 'version.json';
  const version = options.version || process.env.npm_package_version || '1.0.0';
  const gitCommit = resolveGitCommit(options.gitCommit);
  const buildId = options.buildId || generateDefaultBuildId(version, gitCommit);
  const includeTimestamp = options.includeTimestamp !== false;
  const defineConstant = options.defineConstant || '__APP_BUILD_ID__';

  const versionData: VersionFileInfo = {
    version,
    buildId,
    ...(includeTimestamp ? { buildTime: new Date().toISOString() } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    ...(options.release ? { release: options.release } : {}),
    ...(options.customData ? { metadata: options.customData } : {}),
  };

  const jsonSource = JSON.stringify(versionData, null, 2);

  return {
    name: 'vite-plugin-spa-version-guard',

    config() {
      return {
        define: {
          [defineConstant]: JSON.stringify(buildId),
          __APP_VERSION__: JSON.stringify(version),
        },
      };
    },

    configureServer(server) {
      const route = fileName.startsWith('/') ? fileName : `/${fileName}`;
      server.middlewares.use(route, (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.end(jsonSource);
      });
    },

    generateBundle() {
      if (typeof this.emitFile === 'function') {
        this.emitFile({
          type: 'asset',
          fileName,
          source: jsonSource,
        });
      }
    },

    getVersionData() {
      return versionData;
    },
  };
}

export default viteVersionPlugin;
