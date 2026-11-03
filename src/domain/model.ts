declare const uuidBrand: unique symbol;
import type {
  EpubMetadata,
  EpubManifestItem,
  EpubSpineItem,
  EpubNavItem,
  EpubTextResource,
} from './epub';
import type { ReaderPreferences } from './reader';
import type { SpeedPreferences } from './speed-reading';
import type { CatalogSelection } from './catalog';
import type { DocumentTextIndex, ReadingCursor } from './text-position';
import type { JournalEntry, ReadingActivity, ReadingMode } from './statistics';
export type Id = string & { readonly [uuidBrand]: true };
export function id(value: string): Id {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error('Некорректный UUID');
  return value as Id;
}
export const newId = (): Id => id(crypto.randomUUID());
export interface RecordBase {
  id: Id;
  createdAt: number;
  updatedAt: number;
}
export interface Book extends RecordBase {
  title: string;
  authors: string[];
  isbn: string[];
  catalogIds: { source: 'google-books' | 'open-library'; value: string }[];
  description: string;
  genres: string[];
  cover: Blob | null;
  language: string | null;
  publisher?: string;
  publishedDate?: string;
}
export interface BookFile extends RecordBase {
  bookId: Id;
  name: string;
  mediaType: 'application/epub+zip' | 'application/x-fictionbook+xml';
  data: Blob;
  sha256: string | null;
  representation?: EpubRepresentation;
}
export interface EpubRepresentation {
  format: 'epub';
  converterVersion: 1;
  sourceSha256: string;
  sha256: string;
  data: Blob;
}
/** UI attachment metadata; original bytes are fetched only for the selected reader/export. */
export type BookFileSummary = Omit<BookFile, 'data' | 'representation'> & {
  size: number;
  representation?: Omit<EpubRepresentation, 'data'>;
};
export interface EpubIndex extends RecordBase {
  bookFileId: Id;
  sha256: string;
  indexVersion: 1;
  safetyPolicyVersion: 1;
  metadata: EpubMetadata;
  packagePath: string;
  epubVersion: string;
  manifest: EpubManifestItem[];
  spine: EpubSpineItem[];
  navigation: EpubNavItem[];
  sections: EpubTextResource[];
  totalWords: number;
  totalCharacters: number;
}
export interface Reading extends RecordBase {
  bookId: Id;
  status: 'planned' | 'active' | 'finished' | 'paused' | 'abandoned';
  startedAt: number | null;
  finishedAt: number | null;
  rating: number | null;
  review: string;
}
export interface ReadingPosition extends RecordBase {
  readingId: Id;
  bookFileId: Id | null;
  cfi: string;
  progression: number;
  cursor?: ReadingCursor;
}
export interface TextAnchor {
  contentId: string;
  start: ReadingCursor;
  end: ReadingCursor;
  before: string;
  after: string;
}
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'rose';
export interface Annotation extends RecordBase {
  /** Optional only for legacy records without a resolvable content identity. */
  bookId?: Id;
  anchor?: TextAnchor;
  color?: HighlightColor;
  readingId: Id;
  bookFileId: Id | null;
  cfi: string;
  quote: string;
  note: string;
}
export interface Bookmark extends RecordBase {
  bookId?: Id;
  anchor?: TextAnchor;
  readingId: Id;
  bookFileId: Id | null;
  cfi: string;
  label: string;
}
export interface ReadingSession extends RecordBase {
  readingId: Id;
  startedAt: number;
  endedAt: number;
  activeSeconds: number;
  mode?: ReadingMode;
  ownerId?: Id;
  leaseKey?: 'active';
  leaseUntil?: number;
  contentId?: string;
  textVersion?: number;
  wordCount?: number;
  state?: 'active' | 'paused' | 'closed';
}
export interface Collection extends RecordBase {
  name: string;
  bookIds: Id[];
}
export interface Settings extends RecordBase {
  key: 'local';
  theme: 'system' | 'light' | 'dark';
  locale: 'ru';
  reader?: ReaderPreferences;
  speed?: SpeedPreferences;
  readingGoals?: Record<string, number>;
}
export interface Entities {
  activities: ReadingActivity;
  journal: JournalEntry;
  catalogSelections: CatalogSelection;
  books: Book;
  bookFiles: BookFile;
  readings: Reading;
  positions: ReadingPosition;
  annotations: Annotation;
  bookmarks: Bookmark;
  sessions: ReadingSession;
  collections: Collection;
  settings: Settings;
  epubIndexes: EpubIndex;
  documentTextIndexes: DocumentTextIndex;
}
export type EntityName = keyof Entities;
