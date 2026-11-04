import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export class AtomicWriter {
  private outDir: string;
  private isGzipEnabled: boolean;
  private isDryRun: boolean;

  constructor(outDir: string, isGzipEnabled: boolean = true, isDryRun: boolean = false) {
    this.outDir = outDir;
    this.isGzipEnabled = isGzipEnabled;
    this.isDryRun = isDryRun;

    if (!this.isDryRun && !fs.existsSync(this.outDir)) {
      fs.mkdirSync(this.outDir, { recursive: true });
    }
  }

  write(filename: string, content: string): void {
    if (this.isDryRun) return;

    const targetPath = path.join(this.outDir, filename);
    const tmpPath = `${targetPath}.tmp`;

    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, targetPath);

    if (this.isGzipEnabled) {
      const gzTmp = `${targetPath}.gz.tmp`;
      const gzipped = zlib.gzipSync(Buffer.from(content, 'utf-8'), { level: 9 });
      fs.writeFileSync(gzTmp, gzipped);
      fs.renameSync(gzTmp, `${targetPath}.gz`);
    }
  }

  exists(filename: string): boolean {
    return fs.existsSync(path.join(this.outDir, filename));
  }

  read(filename: string): string | null {
    try {
      return fs.readFileSync(path.join(this.outDir, filename), 'utf-8');
    } catch {
      return null;
    }
  }
}
