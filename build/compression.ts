import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';
import type { Plugin } from 'vite';
const brotli = promisify(brotliCompress),
  compressGzip = promisify(gzip);
export function compressionPlugin(): Plugin {
  return {
    name: 'reedit-precompressed-assets',
    apply: 'build',
    enforce: 'post',
    async writeBundle(options, bundle) {
      const root = resolve(options.dir ?? 'dist');
      for (const name of Object.keys(bundle))
        if (/\.(?:js|css|html)$/.test(name)) {
          const source = await readFile(resolve(root, name));
          await Promise.all([
            writeFile(
              resolve(root, name + '.br'),
              await brotli(source, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
              }),
            ),
            writeFile(
              resolve(root, name + '.gz'),
              await compressGzip(source, { level: 9 }),
            ),
          ]);
        }
    },
  };
}
