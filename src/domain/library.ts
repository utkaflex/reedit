import type { Book, Reading, Id } from './model';
import { IntegrityError } from './rules';

export const statusLabels: Record<Reading['status'], string> = {
  planned: 'Хочу прочитать',
  active: 'Читаю',
  finished: 'Прочитано',
  paused: 'Отложено',
  abandoned: 'Брошено',
};
export const normalizeText = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export const normalizeIsbn = (value: string): string =>
  value.replace(/[\s-]/g, '').toUpperCase();
export function validIsbn(value: string): boolean {
  const code = normalizeIsbn(value);
  if (/^\d{9}[\dX]$/.test(code))
    return (
      Array.from({ length: code.length }, (_, index) =>
        code.charAt(index),
      ).reduce(
        (sum, digit, index) =>
          sum + (digit === 'X' ? 10 : Number(digit)) * (10 - index),
        0,
      ) %
        11 ===
      0
    );
  if (/^97[89]\d{10}$/.test(code))
    return (
      Array.from({ length: code.length }, (_, index) =>
        code.charAt(index),
      ).reduce(
        (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3),
        0,
      ) %
        10 ===
      0
    );
  return false;
}
export function duplicateBooks(candidate: Book, books: Book[]): Book[] {
  const canonicalIsbn = (value: string) => {
    const code = normalizeIsbn(value);
    if (code.length !== 10 || !validIsbn(code)) return code;
    const stem = `978${code.slice(0, 9)}`;
    const sum = Array.from(
      { length: 12 },
      (_, index) => Number(stem.charAt(index)) * (index % 2 === 0 ? 1 : 3),
    ).reduce((a, b) => a + b, 0);
    return `${stem}${String((10 - (sum % 10)) % 10)}`;
  };
  const authors = (book: Book) =>
    book.authors.map(normalizeText).sort().join('|');
  return books.filter(
    (book) =>
      book.id !== candidate.id &&
      (book.isbn.some((value) =>
        candidate.isbn.map(canonicalIsbn).includes(canonicalIsbn(value)),
      ) ||
        (normalizeText(book.title) === normalizeText(candidate.title) &&
          authors(book) === authors(candidate))),
  );
}
export class DuplicateBookError extends IntegrityError {
  constructor(public readonly bookIds: Id[]) {
    super('Похожая книга уже есть в библиотеке.');
  }
}
export function latestReading(
  readings: Reading[],
  bookId: Id,
): Reading | undefined {
  return readings
    .filter((reading) => reading.bookId === bookId)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
}
export function parseDate(value: string): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new IntegrityError('Некорректная дата');
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  )
    throw new IntegrityError('Некорректная дата');
  return timestamp;
}
export const dateInput = (value: number | null): string =>
  value === null ? '' : new Date(value).toISOString().slice(0, 10);
export function today(): string {
  const date = new Date();
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export type LibrarySort = 'newest' | 'title' | 'author' | 'rating';
export function selectBooks(
  books: Book[],
  readings: Reading[],
  options: {
    query: string;
    status: string;
    collectionBookIds: Id[] | null;
    sort: LibrarySort;
  },
): Book[] {
  const query = normalizeText(options.query);
  const isbnQuery = normalizeIsbn(options.query);
  const statusFor = (book: Book) =>
    latestReading(readings, book.id)?.status ?? 'planned';
  const rating = (book: Book) => latestReading(readings, book.id)?.rating ?? -1;
  return books
    .filter(
      (book) =>
        (!query ||
          normalizeText(
            [
              book.title,
              ...book.authors,
              book.description,
              ...book.genres,
              ...book.isbn,
            ].join(' '),
          ).includes(query) ||
          (isbnQuery.length > 0 &&
            book.isbn.some((value) =>
              normalizeIsbn(value).includes(isbnQuery),
            ))) &&
        (options.status === 'all' || statusFor(book) === options.status) &&
        (options.collectionBookIds === null ||
          options.collectionBookIds.includes(book.id)),
    )
    .sort((a, b) => {
      const comparison =
        options.sort === 'title'
          ? a.title.localeCompare(b.title, 'ru')
          : options.sort === 'author'
            ? a.authors.join(', ').localeCompare(b.authors.join(', '), 'ru')
            : options.sort === 'rating'
              ? rating(b) - rating(a)
              : b.createdAt - a.createdAt;
      return (
        comparison ||
        a.title.localeCompare(b.title, 'ru') ||
        a.id.localeCompare(b.id)
      );
    });
}
