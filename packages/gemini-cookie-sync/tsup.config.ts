import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/server.ts', 'src/constants.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  onSuccess: async () => {
    const srcExt = path.resolve(__dirname, 'src/extension');
    const distExt = path.resolve(__dirname, 'dist/extension');
    if (fs.existsSync(srcExt)) {
      fs.cpSync(srcExt, distExt, { recursive: true });
    }
  },
});
