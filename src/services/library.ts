import type { Book, Reading } from '../domain/model';
import { newId } from '../domain/model';
import { normalizeIsbn, validIsbn, parseDate } from '../domain/library';
import { IntegrityError } from '../domain/rules';

export interface BookDraft {
  title: string;
  authors: string;
  description: string;
  genres: string;
  isbn: string;
  cover: Blob | null;
  publisher?: string;
  publishedDate?: string;
}
export function makeBook(draft: BookDraft, existing?: Book): Book {
  const isbn = [
    ...new Set(
      draft.isbn
        .split(/[,;\n]/)
        .map(normalizeIsbn)
        .filter(Boolean),
    ),
  ];
  if (isbn.some((value) => !validIsbn(value)))
    throw new IntegrityError(
      'Проверьте ISBN: нужен корректный ISBN-10 или ISBN-13.',
    );
  if (!draft.title.trim()) throw new IntegrityError('Введите название книги.');
  const now = existing
    ? Math.max(Date.now(), existing.updatedAt + 1)
    : Date.now();
  return {
    ...(existing ?? {}),
    id: existing?.id ?? newId(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    catalogIds: existing?.catalogIds ?? [],
    title: draft.title.trim(),
    authors: [
      ...new Set(
        draft.authors
          .split(/[;\n]/)
          .map((author) => author.trim())
          .filter(Boolean),
      ),
    ],
    description: draft.description.trim(),
    genres: [
      ...new Set(
        draft.genres
          .split(/[,;\n]/)
          .map((genre) => genre.trim())
          .filter(Boolean),
      ),
    ],
    isbn,
    ...(draft.publisher !== undefined
      ? { publisher: draft.publisher.trim() }
      : {}),
    ...(draft.publishedDate !== undefined
      ? { publishedDate: draft.publishedDate.trim() }
      : {}),
    cover: draft.cover,
    language: existing?.language ?? null,
  };
}
export function initialReading(book: Book): Reading {
  return {
    id: newId(),
    bookId: book.id,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    status: 'planned',
    startedAt: null,
    finishedAt: null,
    rating: null,
    review: '',
  };
}
export function editReading(
  existing: Reading,
  draft: {
    status: Reading['status'];
    startedAt: string;
    finishedAt: string;
    rating: string;
    review: string;
  },
): Reading {
  return {
    ...existing,
    updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
    status: draft.status,
    startedAt: parseDate(draft.startedAt),
    finishedAt: parseDate(draft.finishedAt),
    rating: draft.rating === '' ? null : Number(draft.rating),
    review: draft.review.trim(),
  };
}
