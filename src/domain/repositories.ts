import type {
  Entities,
  EntityName,
  Id,
  Book,
  Reading,
  BookFile,
  BookFileSummary,
  Collection,
  EpubIndex,
  ReadingPosition,
} from './model';
import type { DocumentTextIndex } from './text-position';
import type { BackupSnapshot, BackupStatus, PreparedBackup } from './backup';
import type {
  ReadingActivity,
  ReadingMode,
  StatisticsSnapshot,
} from './statistics';
export interface LibrarySnapshot {
  books: Book[];
  readings: Reading[];
  files: BookFileSummary[];
  collections: Collection[];
}
export interface Repository<K extends EntityName> {
  get(id: Id): Promise<Entities[K] | undefined>;
  list(): Promise<Entities[K][]>;
  save(
    entity: Entities[K],
    options?: { expectedUpdatedAt: number | null },
  ): Promise<void>;
}
export type Repositories = { [K in EntityName]: Repository<K> };
export interface LocalStore {
  listBookFiles(): Promise<BookFileSummary[]>;
  getEpubIndex(fileId: Id): Promise<EpubIndex | undefined>;
  getReadingPosition(
    readingId: Id,
    fileId: Id,
  ): Promise<ReadingPosition | undefined>;
  readBackup(): Promise<BackupSnapshot>;
  backupStatus(): Promise<BackupStatus>;
  confirmBackup(at: number, includedFiles: boolean): Promise<void>;
  restoreBackup(
    backup: PreparedBackup,
    expectedRevision: string,
    confirmation: { confirmed: boolean },
    signal: AbortSignal,
  ): Promise<void>;
  readStatistics(): Promise<StatisticsSnapshot>;
  claimActivity(input: {
    readingId: Id;
    fileId: Id;
    ownerId: Id;
    mode: ReadingMode;
    now: number;
  }): Promise<Entities['sessions'] | null>;
  commitActivity(event: ReadingActivity, ownerId: Id): Promise<void>;
  releaseActivity(sessionId: Id, ownerId: Id): Promise<void>;
  removeJournal(id: Id, expectedUpdatedAt: number): Promise<void>;
  saveCatalogBook(input: {
    book: Book;
    selection: Entities['catalogSelections'];
    expectedUpdatedAt: number | null;
    initialReading?: Reading;
    allowDuplicate: boolean;
  }): Promise<void>;
  repositories: Repositories;
  saveAnnotation(
    annotation: Entities['annotations'],
  ): Promise<Entities['annotations']>;
  removeSaved(
    kind: 'annotations' | 'bookmarks',
    id: Id,
    expectedUpdatedAt: number,
  ): Promise<void>;
  getDocumentTextIndex(
    fileId: Id,
    sha256: string,
  ): Promise<DocumentTextIndex | undefined>;
  cacheDocumentTextIndex(index: DocumentTextIndex): Promise<DocumentTextIndex>;
  saveReaderPosition(
    input: Pick<
      ReadingPosition,
      'readingId' | 'bookFileId' | 'cfi' | 'progression' | 'cursor'
    >,
  ): Promise<void>;
  findEpubByHash(hash: string): Promise<BookFileSummary | undefined>;
  commitEpubImport(
    input: {
      file: BookFile;
      index: EpubIndex;
      newBook?: Book;
      initialReading?: Reading;
      allowDuplicateBook: boolean;
      coverIfMissing?: Blob;
    },
    signal: AbortSignal,
  ): Promise<{ bookId: Id; fileId: Id; duplicate: boolean }>;
  readLibrary(): Promise<LibrarySnapshot>;
  saveLibraryBook(
    book: Book,
    options: {
      expectedUpdatedAt: number | null;
      allowDuplicate: boolean;
      initialReading?: Reading;
    },
  ): Promise<void>;
  addReading(bookId: Id): Promise<Reading>;
  removeCollection(id: Id, confirmation: { confirmed: boolean }): Promise<void>;
  checkAvailability(): Promise<void>;
  removeBookFile(id: Id): Promise<void>;
  removeBook(id: Id, confirmation: { confirmed: boolean }): Promise<void>;
  close(): void;
}
