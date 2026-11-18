import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'rpm-rate-guard': 'src/rpm-rate-guard/index.ts',
    'rag-security-guard': 'src/rag-security-guard/index.ts',
    'provider-fallback': 'src/provider-fallback/index.ts',
    'rag-pipeline': 'src/rag-pipeline/index.ts',
    'quota-manager': 'src/quota-manager/index.ts',
    'semantic-cache': 'src/semantic-cache/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
