import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { transformWithEsbuild, type Plugin } from 'vite';
export function pwaPlugin(build: string): Plugin {
  return {
    name: 'reedit-offline-shell',
    apply: 'build',
    enforce: 'post',
    async writeBundle(options, bundle) {
      const output = resolve(options.dir ?? 'dist');
      const entries: { url: string; sha256: string }[] = [];
      const digest = (data: string | Uint8Array) =>
        createHash('sha256').update(data).digest('hex');
      for (const name of Object.keys(bundle))
        if (/\.(?:html|js|css)$/.test(name))
          entries.push({
            url: `/${name}`,
            sha256: digest(await readFile(resolve(output, name))),
          });
      for (const name of [
        'manifest.webmanifest',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/apple-touch-icon.png',
        'icons/maskable-512.png',
        'icons/icon.svg',
      ])
        entries.push({
          url: `/${name}`,
          sha256: digest(await readFile(resolve(output, name))),
        });
      if (!entries.some((entry) => entry.url === '/index.html'))
        throw new Error('index.html missing from offline shell');
      const source = await readFile(resolve('src/pwa/worker.ts'), 'utf8');
      const compiled = await transformWithEsbuild(source, 'worker.ts', {
        loader: 'ts',
        target: 'es2022',
        format: 'iife',
        minify: true,
      });
      await writeFile(
        resolve(output, 'sw.js'),
        `const BUILD=${JSON.stringify(build)};const PRECACHE=${JSON.stringify(entries)};\n${compiled.code}`,
      );
    },
  };
}
