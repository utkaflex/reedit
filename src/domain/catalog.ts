import type { Book, Id, RecordBase } from './model';
import { normalizeIsbn, validIsbn } from './library';

export type CatalogSource = 'google-books' | 'open-library';
export interface CatalogQuery {
  text: string;
  field: 'title' | 'author' | 'isbn';
  language: 'ru' | 'en';
  page: number;
}
export interface CatalogReference {
  source: CatalogSource;
  id: string;
  kind: 'work' | 'edition';
  url: string;
}
export interface CatalogBook extends CatalogReference {
  title: string;
  authors: string[];
  year: string;
  publisher: string;
  description: string;
  isbn: string[];
  language: string | null;
  covers: string[];
}
export interface CatalogEdition extends CatalogBook {
  kind: 'edition';
  workId: string | null;
  descriptionSource?: 'work' | 'edition' | 'none';
}
export interface CatalogPage<T> {
  items: T[];
  more: boolean;
  cached: boolean;
  record?: CatalogBook;
}
export interface CatalogProvider {
  readonly source: CatalogSource;
  search(
    query: CatalogQuery,
    signal: AbortSignal,
  ): Promise<CatalogPage<CatalogBook>>;
  editions(
    book: CatalogBook,
    page: number,
    signal: AbortSignal,
  ): Promise<CatalogPage<CatalogEdition>>;
  edition(
    book: CatalogBook,
    edition: CatalogEdition,
    signal: AbortSignal,
  ): Promise<CatalogEdition>;
}
/** References survive cache expiration; user-owned metadata lives in Book, never in this snapshot. */
export interface CatalogSelection extends RecordBase {
  bookId: Id;
  source: CatalogSource;
  editionId: string;
  record: CatalogReference;
  edition: CatalogReference & { kind: 'edition'; workId: string | null };
  selectedCover: string | null;
  snapshot: {
    record: CatalogBook;
    edition: CatalogEdition;
    expiresAt: number;
  } | null;
}
export class CatalogError extends Error {
  constructor(
    public readonly code:
      'offline' | 'rate-limit' | 'unavailable' | 'invalid' | 'network',
    message: string,
    public readonly retryAt = 0,
  ) {
    super(message);
  }
}
export function validateCatalogQuery(query: CatalogQuery): CatalogQuery {
  const text =
    query.field === 'isbn'
      ? normalizeIsbn(query.text)
      : query.text.normalize('NFC').trim();
  if (
    text.length < 2 ||
    text.length > 200 ||
    !Number.isSafeInteger(query.page) ||
    query.page < 0 ||
    query.page > 100 ||
    !['title', 'author', 'isbn'].includes(query.field) ||
    !['ru', 'en'].includes(query.language) ||
    (query.field === 'isbn' && !validIsbn(text))
  )
    throw new CatalogError(
      'invalid',
      query.field === 'isbn'
        ? 'Введите корректный ISBN-10 или ISBN-13.'
        : 'Введите от 2 до 200 символов.',
    );
  return { ...query, text };
}
export function catalogMatches(book: Book, edition: CatalogEdition): boolean {
  if (
    book.catalogIds.some(
      (ref) => ref.source === edition.source && ref.value === edition.id,
    )
  )
    return true;
  const canonical = (isbn: string) => {
    const code = normalizeIsbn(isbn);
    if (code.length !== 10) return code;
    const stem = `978${code.slice(0, 9)}`;
    const sum = Array.from(stem).reduce(
      (total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1),
      0,
    );
    return `${stem}${String((10 - (sum % 10)) % 10)}`;
  };
  return edition.isbn.some(
    (isbn) =>
      validIsbn(isbn) &&
      book.isbn.some(
        (local) => validIsbn(local) && canonical(local) === canonical(isbn),
      ),
  );
}
export function catalogReference(book: CatalogBook): CatalogReference {
  return { source: book.source, id: book.id, kind: book.kind, url: book.url };
}
