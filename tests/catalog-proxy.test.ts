import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCatalogProxy, upstreamUrl } from '../server/catalog-proxy';

let server: Server;
let base = '';
const fetcher = vi.fn<typeof fetch>();
beforeEach(async () => {
  fetcher.mockReset();
  fetcher.mockImplementation(() =>
    Promise.resolve(
      Response.json(
        { docs: [], numFound: 0 },
        { headers: { 'Cache-Control': 'public, max-age=60' } },
      ),
    ),
  );
  const proxy = createCatalogProxy({
    googleKey: 'synthetic-server-key',
    contact: 'maintainer@example.test',
    fetcher,
    intervalMs: 0,
  });
  server = createServer((req, res) => {
    void proxy(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  base = `http://127.0.0.1:${String(address.port)}/api/catalog/`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});
const search = 'open/search?text=Тест&field=title&language=ru&page=0';
describe('ограниченный каталог proxy', () => {
  it('разрешает только метаданные/обложки, не SSRF, полный текст или загрузку файлов', async () => {
    for (const path of [
      'google/download?id=x',
      'open/read?id=OL100W',
      'open/edition?id=../../private',
      'cover?url=http://127.0.0.1/secret',
      'cover?url=https://evil.test/image.png',
    ]) {
      expect((await fetch(base + path)).status).toBe(400);
    }
    expect(
      (await fetch(base + search, { method: 'POST', body: 'EPUB' })).status,
    ).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('ключ и идентификация добавляются только сервером, а ответ и кэш не раскрывают ключ', async () => {
    fetcher.mockResolvedValueOnce(
      Response.json(
        { totalItems: 0 },
        { headers: { 'Cache-Control': 'public, max-age=60', Age: '55' } },
      ),
    );
    const path = 'google/search?text=Crime&field=title&language=en&page=0';
    const response = await fetch(base + path);
    expect(await response.text()).not.toContain('synthetic-server-key');
    const call = fetcher.mock.calls[0];
    const requested = call?.[0];
    if (!(requested instanceof URL)) throw new Error('Expected URL');
    expect(requested.searchParams.get('key')).toBe('synthetic-server-key');
    expect(new Headers(call?.[1]?.headers).get('User-Agent')).toBe(
      'Reedit/0.1 (maintainer@example.test)',
    );
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=5');
    const cached = await fetch(base + path);
    expect(cached.headers.get('X-Catalog-Cache')).toBe('hit');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('no-store не кэшируется; отсутствие ключа возвращает 503 без запроса Google', async () => {
    fetcher.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { totalItems: 0 },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
      ),
    );
    const path = 'google/volume?id=volume';
    await fetch(base + path);
    await fetch(base + path);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const proxy = createCatalogProxy({
      googleKey: '',
      contact: '',
      fetcher,
      intervalMs: 0,
    });
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      void proxy(req, res);
    });
    expect((await fetch(base + path)).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('Retry-After соблюдается без повторного запроса; небезопасные redirect и не-изображения отклоняются', async () => {
    fetcher.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
    );
    const response = await fetch(base + search);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect((await fetch(base + 'open/work?id=OL100W')).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(
      new Response('', {
        status: 302,
        headers: { Location: 'http://localhost/private' },
      }),
    );
    expect(
      (
        await fetch(
          base +
            `cover?url=${encodeURIComponent('https://books.google.com/books/content?id=volume')}`,
        )
      ).status,
    ).toBe(502);
  });
  it('кодирует русский поиск и фиксирует лимиты/offset без произвольного upstream URL', () => {
    const url = upstreamUrl(
      'open/search',
      new URLSearchParams({
        text: 'Преступление и наказание',
        field: 'title',
        language: 'ru',
        page: '2',
      }),
    );
    expect(url.hostname).toBe('openlibrary.org');
    expect(url.searchParams.get('title')).toBe('Преступление и наказание');
    expect(url.searchParams.get('offset')).toBe('20');
    expect(url.searchParams.get('fields')).not.toContain('availability');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});
