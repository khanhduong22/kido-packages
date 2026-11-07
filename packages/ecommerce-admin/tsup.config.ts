import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    'react',
    'react-dom',
    'bun:sqlite',
    '@kido/admin-ui',
    '@kido/payment-vietqr',
    'lucide-react',
    'hono',
    '@hono/zod-validator',
    'zod',
  ],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.js',
    };
  },
});
