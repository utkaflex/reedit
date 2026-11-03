import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWebHandler, securityHeaders } from '../../server/web.ts';
const root = resolve('dist');
let edition = 0;
const production = createWebHandler({ root });
createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'POST' && path.startsWith('/__test/')) {
    edition = Number(path.split('/').at(-1));
    response.end('ok');
    return;
  }
  if (path !== '/sw.js' || !edition) {
    production(request, response);
    return;
  }
  void (async () => {
    let bytes = await readFile(resolve(root, 'sw.js'));

    if (edition) {
      let source = bytes
        .toString()
        .replace(
          /const BUILD="([^"]+)"/,
          `const BUILD="$1-test-${String(edition)}"`,
        );
      if (edition === 2)
        source = source.replace(
          /"sha256":"[a-f0-9]{64}"/,
          `"sha256":"${'0'.repeat(64)}"`,
        );
      if (edition === 3)
        source = source.replace(
          /\b([\w$]+)\.skipWaiting\(\)/g,
          'new Promise(resolve=>setTimeout(resolve,1000)).then(()=>$1.skipWaiting())',
        );
      bytes = Buffer.from(source);
    }
    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    });
    response.end(bytes);
  })().catch(() => {
    response.writeHead(404);
    response.end();
  });
}).listen(4185, '127.0.0.1');
