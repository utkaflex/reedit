import type { EpubAdapter, EpubAnalysis, EpubSource } from '../domain/epub';
import { checkImportCancelled } from '../domain/epub';
import { newId, type Book, type EpubIndex, type Id } from '../domain/model';
import type { LocalStore } from '../domain/repositories';
import { initialReading } from './library';
import { validIsbn, normalizeIsbn } from '../domain/library';

export async function prepareEpub(
  adapter: EpubAdapter,
  store: LocalStore,
  file: EpubSource,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const analysis = await adapter.analyze(file, signal, progress);
  const existing = await store.findEpubByHash(analysis.sha256);
  checkImportCancelled(signal);
  return { analysis, existing };
}
export async function saveEpub(
  store: LocalStore,
  analysis: EpubAnalysis,
  options: {
    name: string;
    targetBookId: Id | null;
    allowDuplicateBook: boolean;
    title: string;
    useEmbeddedCover?: boolean;
  },
  signal: AbortSignal,
) {
  checkImportCancelled(signal);
  const now = Date.now();
  const fileId = newId();
  const bookId = options.targetBookId ?? newId();
  const isbn = normalizeIsbn(
    analysis.metadata.identifier.replace(/^urn:isbn:/i, ''),
  );
  const newBook: Book = {
    id: bookId,
    createdAt: now,
    updatedAt: now,
    title: options.title.trim() || analysis.metadata.title,
    authors: analysis.metadata.authors,
    description: analysis.metadata.description,
    language: analysis.metadata.language || null,
    cover: analysis.cover,
    genres: [],
    catalogIds: [],
    isbn: validIsbn(isbn) ? [isbn] : [],
  };
  const index: EpubIndex = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    bookFileId: fileId,
    sha256: analysis.sha256,
    indexVersion: 1,
    safetyPolicyVersion: 1,
    metadata: analysis.metadata,
    packagePath: analysis.packagePath,
    epubVersion: analysis.version,
    manifest: analysis.manifest,
    spine: analysis.spine,
    navigation: analysis.navigation,
    sections: analysis.sections,
    totalWords: analysis.sections.reduce(
      (sum, section) => sum + section.wordCount,
      0,
    ),
    totalCharacters: analysis.sections.reduce(
      (sum, section) => sum + section.text.length,
      0,
    ),
  };
  return store.commitEpubImport(
    {
      file: {
        id: fileId,
        bookId,
        createdAt: now,
        updatedAt: now,
        name: options.name,
        mediaType:
          analysis.sourceFormat === 'fb2'
            ? 'application/x-fictionbook+xml'
            : 'application/epub+zip',
        data: analysis.original,
        sha256: analysis.sha256,
        ...(analysis.representation
          ? { representation: analysis.representation }
          : {}),
      },
      index,
      allowDuplicateBook: options.allowDuplicateBook,
      ...(options.targetBookId !== null &&
      options.useEmbeddedCover &&
      analysis.cover
        ? { coverIfMissing: analysis.cover }
        : {}),
      ...(options.targetBookId === null
        ? { newBook, initialReading: initialReading(newBook) }
        : {}),
    },
    signal,
  );
}
