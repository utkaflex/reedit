import { createServer } from 'node:http';
import { createCatalogProxy } from './catalog-proxy.ts';
import { createWebHandler } from './web.ts';
const proxy = createCatalogProxy({
  googleKey: process.env.GOOGLE_BOOKS_API_KEY ?? '',
  contact: (process.env.CATALOG_CONTACT ?? '').replace(/[\r\n]/g, ''),
});
const publicOrigin =
  process.env.APP_ORIGIN ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : undefined);
const server = createServer(
  createWebHandler({
    root: 'dist',
    proxy,
    ...(publicOrigin ? { publicOrigin } : {}),
  }),
);
const port = Number(process.env.PORT ?? 4174);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid PORT');
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port, '0.0.0.0', () => {
  process.stdout.write('Reedit web/catalog server is ready.\n');
});
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    server.closeAllConnections();
  }, 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
