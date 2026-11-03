import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export interface ProxyConfig {
  googleKey: string;
  contact: string;
  fetcher?: typeof fetch;
  intervalMs?: number;
}
type Reply = { data: Uint8Array; type: string; expires: number };
export function upstreamUrl(path: string, params: URLSearchParams): URL {
  const page = Number(params.get('page') ?? '0');
  if (!Number.isSafeInteger(page) || page < 0 || page > 100)
    throw new Error('Invalid page');
  const id = params.get('id') ?? '';
  if (path === 'cover') {
    const url = new URL(params.get('url') ?? '');
    if (url.protocol !== 'https:' || url.port || url.username || url.password)
      throw new Error('Invalid cover');
    if (
      url.hostname === 'covers.openlibrary.org' &&
      /^\/b\/id\/[1-9]\d{0,9}-[ML]\.jpg$/.test(url.pathname)
    )
      return new URL(`${url.origin}${url.pathname}?default=false`);
    if (
      url.hostname === 'books.google.com' &&
      url.pathname === '/books/content' &&
      /^[\w-]{1,100}$/.test(url.searchParams.get('id') ?? '')
    )
      return new URL(
        `https://books.google.com/books/content?${new URLSearchParams({ id: url.searchParams.get('id') ?? '', printsec: 'frontcover', img: '1', zoom: '1', source: 'gbs_api' })}`,
      );
    throw new Error('Invalid cover');
  }
  if (path === 'google/volume' && /^[\w-]{1,100}$/.test(id))
    return new URL(`https://www.googleapis.com/books/v1/volumes/${id}`);
  const work = /^OL\d{1,12}W$/.test(id);
  const edition = /^OL\d{1,12}M$/.test(id);
  if (path === 'open/work' && work)
    return new URL(`https://openlibrary.org/works/${id}.json`);
  if (path === 'open/edition' && edition)
    return new URL(`https://openlibrary.org/books/${id}.json`);
  if (path === 'open/editions' && work)
    return new URL(
      `https://openlibrary.org/works/${id}/editions.json?limit=20&offset=${String(page * 20)}`,
    );
  if (!['open/search', 'google/search'].includes(path))
    throw new Error('Invalid endpoint');
  const field = params.get('field') ?? '';
  const language = params.get('language') ?? '';
  let text = (params.get('text') ?? '').normalize('NFC').trim();
  if (
    !['title', 'author', 'isbn'].includes(field) ||
    !['ru', 'en'].includes(language) ||
    text.length < 2 ||
    text.length > 200 ||
    Array.from(text).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('Invalid query');
  if (field === 'isbn') {
    text = text.replace(/[\s-]/g, '').toUpperCase();
    if (!/^(?:\d{9}[\dX]|97[89]\d{10})$/.test(text))
      throw new Error('Invalid ISBN');
  }
  if (path === 'open/search') {
    const url = new URL('https://openlibrary.org/search.json');
    url.search = new URLSearchParams({
      [field]: text,
      lang: language,
      fields: 'key,title,author_name,first_publish_year,cover_i',
      limit: '10',
      offset: String(page * 10),
    }).toString();
    return url;
  }
  const prefix =
    field === 'title' ? 'intitle' : field === 'author' ? 'inauthor' : 'isbn';
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.search = new URLSearchParams({
    q: `${prefix}:"${text.replace(/["\\:]/g, ' ')}"`,
    langRestrict: language,
    printType: 'books',
    maxResults: '10',
    startIndex: String(page * 10),
    fields:
      'totalItems,items(id,volumeInfo(title,authors,publisher,publishedDate,description,language,industryIdentifiers,imageLinks))',
    source: 'reedit',
  }).toString();
  return url;
}
async function bounded(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get('Content-Length')) > max)
    throw new Error('Too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > max) throw new Error('Too large');
      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function createCatalogProxy(config: ProxyConfig) {
  const fetcher = config.fetcher ?? fetch;
  const cleanContact = config.contact.trim();
  const contact = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
    cleanContact,
  )
    ? cleanContact
    : '';
  const cache = new Map<string, Reply>();
  const clients = new Map<string, { start: number; count: number }>();
  const gates = new Map<
    string,
    { tail: Promise<void>; next: number; queued: number; blocked: number }
  >();
  const send = (
    res: ServerResponse,
    status: number,
    message: string,
    retry = 0,
  ) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(retry ? { 'Retry-After': String(retry) } : {}),
    });
    res.end(JSON.stringify({ message }));
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/catalog\//, '');
    if (req.method !== 'GET') {
      send(res, 405, 'Only metadata GET requests are supported.');
      return;
    }
    if (
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    ) {
      send(res, 403, 'Cross-origin requests are not allowed.');
      return;
    }
    const clientId = req.socket.remoteAddress ?? 'local';
    const now = Date.now();
    const client = clients.get(clientId) ?? { start: now, count: 0 };
    if (now - client.start > 60000) {
      client.start = now;
      client.count = 0;
    }
    client.count++;
    clients.set(clientId, client);
    if (clients.size > 1000) {
      const oldest = clients.keys().next().value;
      if (oldest) clients.delete(oldest);
    }
    if (client.count > 90) {
      send(res, 429, 'Too many requests.', 60);
      return;
    }
    let target: URL;
    try {
      target = upstreamUrl(path, url.searchParams);
    } catch {
      send(res, 400, 'Invalid catalog request.');
      return;
    }
    const google =
      path.startsWith('google/') || target.hostname === 'books.google.com';
    if (google && !config.googleKey) {
      send(res, 503, 'Google Books requires a server API key.');
      return;
    }
    const cacheKey = target.href;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > now) {
      res.writeHead(200, {
        'Content-Type': cached.type,
        'Cache-Control': `private, max-age=${String(Math.floor((cached.expires - now) / 1000))}`,
        'X-Catalog-Cache': 'hit',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(cached.data);
      return;
    }
    const gateKey = google ? 'google' : 'open';
    const gate = gates.get(gateKey) ?? {
      tail: Promise.resolve(),
      next: 0,
      queued: 0,
      blocked: 0,
    };
    gates.set(gateKey, gate);
    if (gate.blocked > now) {
      send(
        res,
        429,
        'Upstream rate limit.',
        Math.ceil((gate.blocked - now) / 1000),
      );
      return;
    }
    if (gate.queued >= 12) {
      send(res, 429, 'Catalog queue is full.', 10);
      return;
    }
    gate.queued++;
    const abort = new AbortController();
    res.on('close', () => {
      abort.abort();
    });
    let release = () => {};
    const previous = gate.tail;
    gate.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      abort.signal.throwIfAborted();
      if (gate.blocked > Date.now()) {
        send(
          res,
          429,
          'Upstream rate limit.',
          Math.ceil((gate.blocked - Date.now()) / 1000),
        );
        return;
      }
      await delay(Math.max(0, gate.next - Date.now()), undefined, {
        signal: abort.signal,
      });
      gate.next =
        Date.now() +
        (config.intervalMs ?? (google ? 1000 : contact ? 400 : 1100));
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(12000),
      ]);
      const headers: Record<string, string> = {
        Accept:
          path === 'cover'
            ? 'image/jpeg,image/png,image/webp'
            : 'application/json',
        'User-Agent': `Reedit/0.1${contact ? ` (${contact})` : ''}`,
      };
      if (contact) headers.From = contact;
      if (path.startsWith('google/')) {
        target.searchParams.set('key', config.googleKey);
        target.searchParams.set(
          'fields',
          path.endsWith('volume')
            ? 'id,volumeInfo(title,authors,publisher,publishedDate,description,language,industryIdentifiers,imageLinks)'
            : (target.searchParams.get('fields') ?? ''),
        );
      }
      let upstream = await fetcher(target, {
        headers,
        signal,
        redirect: 'manual',
      });
      if (path === 'cover')
        for (
          let i = 0;
          i < 3 && [301, 302, 303, 307, 308].includes(upstream.status);
          i++
        ) {
          const next = new URL(upstream.headers.get('Location') ?? '', target);
          if (
            next.protocol !== 'https:' ||
            next.username ||
            next.password ||
            next.port ||
            !(google
              ? ['books.google.com', 'books.googleusercontent.com'].includes(
                  next.hostname,
                ) || next.hostname.endsWith('.googleusercontent.com')
              : next.hostname === 'covers.openlibrary.org' ||
                next.hostname === 'archive.org' ||
                next.hostname.endsWith('.archive.org'))
          )
            throw new Error('Unsafe cover redirect');
          await upstream.body?.cancel();
          target = next;
          upstream = await fetcher(target, {
            headers,
            signal,
            redirect: 'manual',
          });
        }
      if (upstream.status === 429 || (upstream.status === 403 && google)) {
        const retryHeader = upstream.headers.get('Retry-After');
        const seconds = Number(retryHeader);
        const retry =
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, 3600)
            : retryHeader && Number.isFinite(Date.parse(retryHeader))
              ? Math.max(
                  1,
                  Math.min(
                    3600,
                    Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000),
                  ),
                )
              : 60;
        gate.blocked = Date.now() + retry * 1000;
        await upstream.body?.cancel();
        send(res, 429, 'Upstream rate limit or key restriction.', retry);
        return;
      }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        send(res, upstream.status === 404 ? 404 : 502, 'Catalog unavailable.');
        return;
      }
      const type =
        (upstream.headers.get('Content-Type') ?? '').split(';')[0] ?? '';
      if (
        path === 'cover'
          ? !['image/jpeg', 'image/png', 'image/webp'].includes(type)
          : type !== 'application/json'
      )
        throw new Error('Unexpected content');
      const data = await bounded(upstream, 2 * 1024 * 1024);
      if (path === 'cover') {
        const raster =
          type === 'image/jpeg'
            ? data[0] === 255 && data[1] === 216
            : type === 'image/png'
              ? data[0] === 137 && data[1] === 80
              : new TextDecoder().decode(data.slice(0, 4)) === 'RIFF' &&
                new TextDecoder().decode(data.slice(8, 12)) === 'WEBP';
        if (!raster) throw new Error('Invalid image');
      }
      const cc = upstream.headers.get('Cache-Control') ?? '';
      const ttlMatch = /max-age=(\d+)/i.exec(cc);
      const ttl = google
        ? /no-store|no-cache|private/i.test(cc)
          ? 0
          : Math.min(
              600,
              Math.max(
                0,
                Number(ttlMatch?.[1] ?? 0) -
                  Math.max(0, Number(upstream.headers.get('Age') ?? 0)),
              ),
            )
        : 600;
      if (ttl > 0) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { data, type, expires: Date.now() + ttl * 1000 });
        while (cache.size > 80) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
          else break;
        }
      }
      if (!res.destroyed) {
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': ttl ? `private, max-age=${String(ttl)}` : 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(data);
      }
    } catch {
      if (!res.destroyed)
        send(res, 502, 'Catalog request failed or timed out.');
    } finally {
      gate.queued--;
      release();
    }
  };
}
