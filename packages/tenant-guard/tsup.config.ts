import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'team-rbac': 'src/team-rbac/index.ts',
    snapshot: 'src/snapshot/index.ts',
    sandbox: 'src/sandbox/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
