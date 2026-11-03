import type {
  RequestListener,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const securityHeaders = {
  // WebKit inherits this policy into blob XHTML: 'none' blocks our own reader iframe.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://books.google.com https://covers.openlibrary.org; font-src 'self' blob: data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
};
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const encodedTypes = new Set(['.html', '.js', '.css', '.svg', '.webmanifest']);
function encodings(request: IncomingMessage): ('br' | 'gzip')[] {
  const weights = new Map(
    (request.headers['accept-encoding'] ?? '').split(',').map((part) => {
      const [name = '', ...parameters] = part.trim().split(';');
      const q = parameters.find((parameter) =>
        parameter.trim().startsWith('q='),
      );
      return [name.trim(), q ? Number(q.trim().slice(2)) : 1] as const;
    }),
  );
  return (['br', 'gzip'] as const)
    .filter((name) => (weights.get(name) ?? 0) > 0)
    .sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0));
}
export function createWebHandler(options: {
  root: string;
  proxy?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>;
  publicOrigin?: string;
}): RequestListener {
  const root = resolve(options.root);
  const origin = options.publicOrigin ? new URL(options.publicOrigin) : null;
  if (
    origin &&
    (origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash)
  )
    throw new Error('APP_ORIGIN must be an HTTPS origin without a path.');
  return (request, response) => {
    for (const [key, value] of Object.entries(securityHeaders))
      response.setHeader(key, value);
    const fail = (code: number, message = '') => {
      response.writeHead(code, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    void (async () => {
      const raw = request.url ?? '/';
      let path: string;
      try {
        path = decodeURIComponent(raw.split('?')[0] ?? '/');
      } catch {
        fail(400);
        return;
      }
      if (
        raw.length > 4096 ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        path.includes('\\') ||
        path.includes(':') ||
        Array.from(path).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
      ) {
        fail(400);
        return;
      }
      if (path.split('/').some((segment) => segment.startsWith('.'))) {
        fail(403);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.setHeader('Allow', 'GET, HEAD');
        fail(405);
        return;
      }
      if (origin && request.headers['x-forwarded-proto'] === 'http') {
        response.writeHead(308, {
          Location: origin.origin + raw,
          'Cache-Control': 'no-store',
        });
        response.end();
        return;
      }
      if (path === '/healthz') {
        try {
          for (const name of ['index.html', 'sw.js', 'manifest.webmanifest'])
            if (!(await stat(resolve(root, name))).isFile())
              throw new Error('Missing build');
        } catch {
          fail(503, 'Build unavailable');
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
        return;
      }
      if (path.startsWith('/api/')) {
        if (path.startsWith('/api/catalog/') && options.proxy) {
          await options.proxy(request, response);
          return;
        }
        fail(404);
        return;
      }
      let file = resolve(root, `.${path}`);
      if (!file.startsWith(root + sep) && file !== root) {
        fail(403);
        return;
      }
      const extension = extname(path);
      if (extension && !Object.hasOwn(types, extension)) {
        fail(404);
        return;
      }
      try {
        if (!(await stat(file)).isFile()) throw new Error('Not a file');
      } catch {
        if (
          extension ||
          (path !== '/' && !request.headers.accept?.includes('text/html'))
        ) {
          fail(404);
          return;
        }
        file = resolve(root, 'index.html');
      }
      const realRoot = await realpath(root),
        actual = await realpath(file);
      if (!actual.startsWith(realRoot + sep)) {
        fail(403);
        return;
      }
      const mime = types[extname(file)];
      if (!mime) {
        fail(404);
        return;
      }
      let served = file,
        encoding: string | undefined;
      if (encodedTypes.has(extname(file)))
        for (const candidate of encodings(request)) {
          const compressed = file + (candidate === 'br' ? '.br' : '.gz');
          try {
            if (
              !(await realpath(compressed)).startsWith(realRoot + sep) ||
              !(await stat(compressed)).isFile()
            )
              continue;
            served = compressed;
            encoding = candidate;
            break;
          } catch {
            /* Identity remains available for clients/builds without this encoding. */
          }
        }
      const info = await stat(served);
      const immutable =
        file.startsWith(resolve(root, 'assets') + sep) &&
        /-[\w-]{8,}\.(?:js|css|woff2)$/.test(file);
      response.setHeader('Content-Type', mime);
      response.setHeader(
        'Cache-Control',
        immutable
          ? 'public, max-age=31536000, immutable'
          : ['.html', '.webmanifest'].includes(extname(file)) ||
              file === resolve(root, 'sw.js')
            ? 'no-cache'
            : 'public, max-age=3600',
      );
      response.setHeader('Content-Length', info.size);
      response.setHeader('Vary', 'Accept-Encoding');
      if (encoding) response.setHeader('Content-Encoding', encoding);
      if (file === resolve(root, 'sw.js'))
        response.setHeader('Service-Worker-Allowed', '/');
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      await pipeline(createReadStream(served), response);
    })().catch(() => {
      if (!response.headersSent) fail(503, 'Service temporarily unavailable');
      else response.destroy();
    });
  };
}
