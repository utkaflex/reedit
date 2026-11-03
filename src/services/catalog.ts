import {
  catalogReference,
  type CatalogBook,
  type CatalogEdition,
} from '../domain/catalog';
import type { Book } from '../domain/model';
import type { CatalogSelection } from '../domain/catalog';
import { newId } from '../domain/model';
import type { LocalStore } from '../domain/repositories';
import { initialReading, makeBook, type BookDraft } from './library';

export async function saveCatalogSelection(
  store: LocalStore,
  input: {
    record: CatalogBook;
    edition: CatalogEdition;
    draft: BookDraft;
    target: Book | null;
    replaceMetadata: boolean;
    allowDuplicate: boolean;
    selectedCover: string | null;
  },
): Promise<Book> {
  const now = Math.max(Date.now(), (input.target?.updatedAt ?? 0) + 1);
  const entity =
    input.target && !input.replaceMetadata
      ? { ...input.target, updatedAt: now }
      : makeBook(input.draft, input.target ?? undefined);
  const book: Book = {
    ...entity,
    language:
      input.target && !input.replaceMetadata
        ? input.target.language
        : input.edition.language,
    catalogIds: [
      ...entity.catalogIds.filter(
        (ref) =>
          ref.source !== input.edition.source || ref.value !== input.edition.id,
      ),
      { source: input.edition.source, value: input.edition.id },
    ],
  };
  const selection: CatalogSelection = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    bookId: book.id,
    source: input.edition.source,
    editionId: input.edition.id,
    record: catalogReference(input.record),
    edition: {
      ...catalogReference(input.edition),
      kind: 'edition',
      workId: input.edition.workId,
    },
    selectedCover:
      input.edition.source === 'google-books' ||
      (input.target && !input.replaceMetadata)
        ? null
        : input.selectedCover,
    snapshot:
      input.edition.source === 'open-library'
        ? {
            record: input.record,
            edition: input.edition,
            expiresAt: Number.MAX_SAFE_INTEGER,
          }
        : null,
  };
  await store.saveCatalogBook({
    book,
    selection,
    expectedUpdatedAt: input.target?.updatedAt ?? null,
    ...(!input.target ? { initialReading: initialReading(book) } : {}),
    allowDuplicate: input.allowDuplicate,
  });
  return book;
}
