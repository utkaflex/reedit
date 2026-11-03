import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createWebHandler } from '../server/web';

let root: string, base: string, server: Server;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reedit-web-'));
  await mkdir(join(root, 'assets'));
  for (const [name, text] of Object.entries({
    'index.html': '<h1>Книги</h1>',
    'sw.js': '// worker',
    'manifest.webmanifest': '{}',
    'assets/app-12345678.js': 'export const title="Чтение";',
    'private.epub': 'never public',
  }))
    await writeFile(join(root, name), text);
  await writeFile(join(root, 'index.html.gz'), gzipSync('<h1>Книги</h1>'));
  server = createServer(
    createWebHandler({ root, publicOrigin: 'https://reedit.example' }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  base = `http://127.0.0.1:${String(address.port)}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await rm(root, { recursive: true, force: true });
});
it('serves Russian SPA, health, MIME, immutable assets and revalidated worker', async () => {
  expect((await fetch(base + '/healthz')).status).toBe(200);
  const page = await fetch(base + '/library', {
    headers: { Accept: 'text/html' },
  });
  expect(await page.text()).toBe('<h1>Книги</h1>');
  expect(page.headers.get('content-type')).toContain('charset=utf-8');
  expect(page.headers.get('content-security-policy')).toContain(
    "object-src 'none'",
  );
  expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  const worker = await fetch(base + '/sw.js');
  expect(worker.headers.get('cache-control')).toBe('no-cache');
  expect(worker.headers.get('service-worker-allowed')).toBe('/');
  const asset = await fetch(base + '/assets/app-12345678.js', {
    method: 'HEAD',
  });
  expect(asset.headers.get('cache-control')).toContain('immutable');
  expect(await asset.text()).toBe('');
  expect(
    (await fetch(base + '/manifest.webmanifest')).headers.get('content-type'),
  ).toContain('application/manifest+json');
});
it('rejects private files, traversal, missing assets, invalid URLs and mutations', async () => {
  for (const path of ['/private.epub', '/api/missing', '/missing.js'])
    expect((await fetch(base + path)).status).toBe(404);
  expect((await fetch(base + '/.env')).status).toBe(403);
  expect((await fetch(base + '/%2e%2e%2fsecret')).status).toBe(403);
  expect((await fetch(base + '/%00')).status).toBe(400);
  expect((await fetch(base + '/%zz')).status).toBe(400);
  expect((await fetch(base, { method: 'POST' })).status).toBe(405);
  await rm(join(root, 'sw.js'));
  expect((await fetch(base + '/healthz')).status).toBe(503);
});
it('negotiates compression, honors q=0 and redirects only to configured HTTPS origin', async () => {
  const compressed = await fetch(base, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  expect(compressed.headers.get('content-encoding')).toBe('gzip');
  expect(await compressed.text()).toBe('<h1>Книги</h1>');
  const identity = await fetch(base, {
    headers: { 'Accept-Encoding': 'gzip;q=0, br;q=0' },
  });
  expect(identity.headers.get('content-encoding')).toBeNull();
  const redirect = await fetch(base + '/library?q=1', {
    redirect: 'manual',
    headers: { 'X-Forwarded-Proto': 'http', Host: 'evil.example' },
  });
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get('location')).toBe(
    'https://reedit.example/library?q=1',
  );
});
