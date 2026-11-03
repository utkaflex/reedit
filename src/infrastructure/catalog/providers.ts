import { normalizeIsbn, validIsbn } from '../../domain/library';
import {
  validateCatalogQuery,
  type CatalogBook,
  type CatalogEdition,
  type CatalogPage,
  type CatalogProvider,
  type CatalogQuery,
} from '../../domain/catalog';
import type { CatalogTransport } from './transport';

export const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const string = (value: unknown): string =>
  typeof value === 'string'
    ? value.slice(0, 20000)
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : '';
export const strings = (value: unknown): string[] =>
  array(value).map(string).filter(Boolean).slice(0, 100);
export function plain(value: unknown): string {
  const text = string(
    typeof value === 'object' && value !== null ? object(value).value : value,
  );
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, key: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[
          key
        ] ?? '',
    )
    .trim();
}
const isbns = (value: unknown) => [
  ...new Set(strings(value).map(normalizeIsbn).filter(validIsbn)),
];
const key = (value: unknown, kind: 'W' | 'M') => {
  const match = new RegExp(`(?:^|/)(OL\\d+${kind})$`).exec(string(value));
  return match?.[1] ?? '';
};
export const coverUrl = (url: string): string =>
  `/api/catalog/cover?url=${encodeURIComponent(url)}`;
function olCovers(value: unknown): string[] {
  return array(value)
    .filter(
      (id): id is number =>
        typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
    )
    .slice(0, 6)
    .map(
      (id) =>
        `https://covers.openlibrary.org/b/id/${String(id)}-L.jpg?default=false`,
    );
}
export function googleBook(value: unknown): CatalogEdition | null {
  const raw = object(value);
  const info = object(raw.volumeInfo);
  const id = string(raw.id);
  if (!/^[\w-]{1,100}$/.test(id) || !plain(info.title)) return null;
  return {
    source: 'google-books',
    id,
    kind: 'edition',
    workId: null,
    url: `https://books.google.com/books?id=${encodeURIComponent(id)}`,
    title: plain(info.title),
    authors: strings(info.authors).map(plain),
    year: string(info.publishedDate),
    publisher: plain(info.publisher),
    description: plain(info.description),
    descriptionSource: plain(info.description) ? 'edition' : 'none',
    language: string(info.language) || null,
    isbn: isbns(
      array(info.industryIdentifiers).map((item) => object(item).identifier),
    ),
    covers: Object.keys(object(info.imageLinks)).length
      ? [
          `https://books.google.com/books/content?id=${encodeURIComponent(id)}&printsec=frontcover&img=1&zoom=1&source=gbs_api`,
        ]
      : [],
  };
}
function olEdition(value: unknown, book: CatalogBook): CatalogEdition | null {
  const raw = object(value);
  const id = key(raw.key, 'M');
  if (!id || !plain(raw.title)) return null;
  return {
    source: 'open-library',
    id,
    kind: 'edition',
    workId: book.kind === 'work' ? book.id : null,
    url: `https://openlibrary.org/books/${id}`,
    title: plain(raw.title),
    authors: strings(raw.author_name).length
      ? strings(raw.author_name).map(plain)
      : book.authors,
    year: string(raw.publish_date),
    publisher: strings(raw.publishers).join('; '),
    description: plain(raw.description) || book.description,
    descriptionSource: plain(raw.description)
      ? 'edition'
      : book.description
        ? 'work'
        : 'none',
    language:
      string(object(array(raw.languages)[0]).key)
        .split('/')
        .at(-1) || null,
    isbn: isbns([...array(raw.isbn_10), ...array(raw.isbn_13)]),
    covers: olCovers(raw.covers),
  };
}
export class GoogleBooksProvider implements CatalogProvider {
  readonly source = 'google-books';
  constructor(private transport: CatalogTransport) {}
  async search(
    input: CatalogQuery,
    signal: AbortSignal,
  ): Promise<CatalogPage<CatalogBook>> {
    const query = validateCatalogQuery(input);
    const params = new URLSearchParams({
      text: query.text,
      field: query.field,
      language: query.language,
      page: String(query.page),
    });
    const response = await this.transport.json(
      `google/search?${params}`,
      signal,
    );
    const raw = object(response.value);
    if (
      typeof raw.totalItems !== 'number' ||
      (raw.items !== undefined && !Array.isArray(raw.items))
    )
      throw new Error('Некорректный ответ Google Books.');
    const items = array(raw.items).flatMap((item) => {
      const book = googleBook(item);
      return book ? [book] : [];
    });
    return {
      items,
      more: items.length === 10 && (query.page + 1) * 10 < raw.totalItems,
      cached: response.cached,
    };
  }
  editions(
    book: CatalogBook,
    page: number,
    signal: AbortSignal,
  ): Promise<CatalogPage<CatalogEdition>> {
    signal.throwIfAborted();
    return Promise.resolve({
      items: page === 0 ? [{ ...book, kind: 'edition', workId: null }] : [],
      more: false,
      cached: true,
    });
  }
  async edition(
    _book: CatalogBook,
    edition: CatalogEdition,
    signal: AbortSignal,
  ): Promise<CatalogEdition> {
    const response = await this.transport.json(
      `google/volume?id=${encodeURIComponent(edition.id)}`,
      signal,
    );
    const full = googleBook(response.value);
    if (!full || full.id !== edition.id)
      throw new Error('Издание Google Books недоступно.');
    return full;
  }
}
export class OpenLibraryProvider implements CatalogProvider {
  readonly source = 'open-library';
  constructor(private transport: CatalogTransport) {}
  async search(
    input: CatalogQuery,
    signal: AbortSignal,
  ): Promise<CatalogPage<CatalogBook>> {
    const query = validateCatalogQuery(input);
    const response = await this.transport.json(
      `open/search?${new URLSearchParams({ ...query, page: String(query.page) })}`,
      signal,
    );
    const raw = object(response.value);
    if (!Array.isArray(raw.docs))
      throw new Error('Некорректный ответ Open Library.');
    const items: CatalogBook[] = array(raw.docs).flatMap((value) => {
      const doc = object(value);
      const id = key(doc.key, 'W');
      if (!id || !plain(doc.title)) return [];
      return [
        {
          source: 'open-library',
          id,
          kind: 'work',
          title: plain(doc.title),
          authors: strings(doc.author_name).map(plain),
          year: string(doc.first_publish_year),
          publisher: '',
          description: '',
          isbn: [],
          language: null,
          covers: olCovers([doc.cover_i]),
          url: `https://openlibrary.org/works/${id}`,
        },
      ];
    });
    return {
      items,
      cached: response.cached,
      more: (query.page + 1) * 10 < Number(raw.numFound ?? raw.num_found ?? 0),
    };
  }
  async editions(
    book: CatalogBook,
    page: number,
    signal: AbortSignal,
  ): Promise<CatalogPage<CatalogEdition>> {
    const [details, response] = await Promise.all([
      this.transport.json(
        `open/work?id=${encodeURIComponent(book.id)}`,
        signal,
      ),
      this.transport.json(
        `open/editions?id=${encodeURIComponent(book.id)}&page=${String(page)}`,
        signal,
      ),
    ]);
    const work = {
      ...book,
      description: plain(object(details.value).description),
    };
    const raw = object(response.value);
    return {
      items: array(raw.entries).flatMap((value) => {
        const edition = olEdition(value, work);
        return edition ? [edition] : [];
      }),
      record: work,
      more: (page + 1) * 20 < Number(raw.size ?? 0),
      cached: response.cached,
    };
  }
  async edition(
    book: CatalogBook,
    edition: CatalogEdition,
    signal: AbortSignal,
  ): Promise<CatalogEdition> {
    const response = await this.transport.json(
      `open/edition?id=${encodeURIComponent(edition.id)}`,
      signal,
    );
    const result = olEdition(response.value, {
      ...book,
      description: edition.description,
    });
    if (!result || result.id !== edition.id)
      throw new Error('Издание Open Library недоступно.');
    return result;
  }
}
