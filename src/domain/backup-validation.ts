import {
  BackupError,
  backupTables,
  backupLabels,
  type BackupTables,
} from './backup';
import { id, type Entities, type EntityName } from './model';
import { validate } from './rules';
import { cursorSection } from './text-position';
import { anchorText, contentIdentity } from './annotations';

type Check = (value: unknown) => boolean;
const text: Check = (v) =>
  typeof v === 'string' && v.length <= 16 * 1024 * 1024;
const number: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const integer: Check = (v) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const time: Check = (v) =>
  integer(v) && typeof v === 'number' && v <= 8640000000000000;
const bool: Check = (v) => typeof v === 'boolean';
const uuid: Check = (v) => {
  try {
    return typeof v === 'string' && Boolean(id(v));
  } catch {
    return false;
  }
};
const one =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const array =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) &&
    v.length <= 1000000 &&
    v.every((item: unknown) => check(item));
export const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Blob);
const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    object(v) &&
    Object.keys(v).every((key) => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, check]) => check(v[key]));
const dictionary =
  (check: Check): Check =>
  (v) =>
    object(v) && Object.values(v).every(check);
const blob: Check = (v) => v instanceof Blob;
const hash: Check = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const mode = one('ordinary', 'rsvp', 'guided');
const base = { id: uuid, createdAt: time, updatedAt: time };
const point = shape({ path: array(integer), offset: integer });
const cursor = shape({
  sha256: hash,
  algorithmVersion: one(1),
  spineIndex: integer,
  offset: integer,
  anchor: one('word', 'visible-fragment'),
});
const anchor = shape({
  contentId: text,
  start: cursor,
  end: cursor,
  before: text,
  after: text,
});
const source = one('google-books', 'open-library');
const url: Check = (v) =>
  typeof v === 'string' &&
  /^https:\/\/(?:openlibrary\.org|covers\.openlibrary\.org|books\.google\.com|books\.googleapis\.com)\//.test(
    v,
  );
const reference = { source, id: text, kind: one('edition', 'work'), url };
const catalog = {
  ...reference,
  title: text,
  authors: array(text),
  year: text,
  publisher: text,
  description: text,
  isbn: array(text),
  language: nullable(text),
  covers: array(url),
};
const metadata = shape({
  title: text,
  authors: array(text),
  language: text,
  description: text,
  identifier: text,
});
const navigation: Check = (v) =>
  shape({
    label: text,
    path: text,
    fragment: text,
    children: array(navigation),
  })(v);
const location = {
  ...base,
  readingId: uuid,
  bookFileId: nullable(uuid),
  cfi: text,
};
const checks: Record<EntityName, Check> = {
  books: shape({
    ...base,
    title: text,
    authors: array(text),
    isbn: array(text),
    catalogIds: array(shape({ source, value: text })),
    description: text,
    genres: array(text),
    cover: nullable(blob),
    language: nullable(text),
    publisher: optional(text),
    publishedDate: optional(text),
  }),
  bookFiles: shape({
    ...base,
    bookId: uuid,
    name: text,
    mediaType: one('application/epub+zip', 'application/x-fictionbook+xml'),
    data: blob,
    sha256: nullable(hash),
    representation: optional(
      shape({
        format: one('epub'),
        converterVersion: one(1),
        sourceSha256: hash,
        sha256: hash,
        data: blob,
      }),
    ),
  }),
  readings: shape({
    ...base,
    bookId: uuid,
    status: one('planned', 'active', 'finished', 'paused', 'abandoned'),
    startedAt: nullable(time),
    finishedAt: nullable(time),
    rating: nullable(number),
    review: text,
  }),
  positions: shape({
    ...location,
    progression: number,
    cursor: optional(cursor),
  }),
  annotations: shape({
    ...location,
    bookId: optional(uuid),
    anchor: optional(anchor),
    color: optional(one('yellow', 'green', 'blue', 'rose')),
    quote: text,
    note: text,
  }),
  bookmarks: shape({
    ...location,
    bookId: optional(uuid),
    anchor: optional(anchor),
    label: text,
  }),
  sessions: shape({
    ...base,
    readingId: uuid,
    startedAt: time,
    endedAt: time,
    activeSeconds: number,
    mode: optional(mode),
    ownerId: optional(uuid),
    state: optional(one('active', 'paused', 'closed')),
    leaseKey: optional(one('active')),
    leaseUntil: optional(integer),
    contentId: optional(text),
    textVersion: optional(one(1)),
    wordCount: optional(integer),
  }),
  activities: shape({
    ...base,
    readingId: uuid,
    sessionId: uuid,
    contentId: text,
    textVersion: one(1),
    mode,
    from: time,
    to: time,
    milliseconds: number,
    intervals: array(shape({ start: integer, end: integer })),
  }),
  journal: shape({
    ...base,
    bookId: uuid,
    readingId: uuid,
    day: text,
    body: text,
  }),
  collections: shape({ ...base, name: text, bookIds: array(uuid) }),
  settings: shape({
    ...base,
    key: one('local'),
    theme: one('system', 'light', 'dark'),
    locale: one('ru'),
    readingGoals: optional(dictionary(integer)),
    reader: optional(
      shape({
        mode: one('paginated', 'scroll'),
        font: one('serif', 'sans'),
        fontSize: number,
        lineHeight: number,
        margin: number,
        alignment: one('left', 'justify'),
        theme: one('light', 'dark', 'sepia'),
        animations: bool,
      }),
    ),
    speed: optional(
      shape({
        wpm: integer,
        focusLetter: bool,
        guidedWords: integer,
        longWordLength: integer,
        pauses: shape({
          ordinary: number,
          long: number,
          comma: number,
          sentence: number,
          paragraph: number,
        }),
      }),
    ),
  }),
  epubIndexes: shape({
    ...base,
    bookFileId: uuid,
    sha256: hash,
    indexVersion: one(1),
    safetyPolicyVersion: one(1),
    metadata,
    packagePath: text,
    epubVersion: text,
    manifest: array(
      shape({ id: text, path: text, mediaType: text, properties: array(text) }),
    ),
    spine: array(shape({ idref: text, path: text, linear: bool })),
    navigation: array(navigation),
    sections: array(
      shape({ path: text, spineIndex: integer, text, wordCount: integer }),
    ),
    totalWords: integer,
    totalCharacters: integer,
  }),
  documentTextIndexes: shape({
    ...base,
    bookFileId: uuid,
    sha256: hash,
    algorithmVersion: one(1),
    segmentation: one('intl', 'fallback'),
    totalCharacters: integer,
    sections: array(
      shape({
        spineIndex: integer,
        path: text,
        cfiBase: text,
        start: integer,
        text,
        tokens: array(
          shape({
            start: integer,
            end: integer,
            kind: one('word', 'space', 'punctuation'),
          }),
        ),
        mappings: array(
          shape({
            start: integer,
            end: integer,
            from: point,
            to: point,
            linear: bool,
          }),
        ),
      }),
    ),
  }),
  catalogSelections: shape({
    ...base,
    bookId: uuid,
    source,
    editionId: text,
    record: shape(reference),
    edition: shape({
      ...reference,
      kind: one('edition'),
      workId: nullable(text),
    }),
    selectedCover: nullable(url),
    snapshot: nullable(
      shape({
        record: shape(catalog),
        edition: shape({
          ...catalog,
          kind: one('edition'),
          workId: nullable(text),
          descriptionSource: optional(one('work', 'edition', 'none')),
        }),
        expiresAt: integer,
      }),
    ),
  }),
};
export function decodeBackupRecord<K extends EntityName>(
  name: K,
  value: unknown,
): Entities[K] {
  if (!checks[name](value))
    throw new BackupError(
      `Повреждены или не поддерживаются данные: ${backupLabels[name]}.`,
    );
  const record = value as Entities[K]; // Full runtime shape checked above, then domain constraints below.
  validate(name, record);
  return record;
}
export function validateBackupGraph(tables: BackupTables): void {
  const fail = () => {
    throw new BackupError(
      'Нарушены связи или целостность записей резервной копии.',
    );
  };
  for (const name of backupTables) {
    const ids = new Set<string>();
    for (const record of tables[name]) {
      decodeBackupRecord(name, record);
      if (ids.has(record.id)) fail();
      ids.add(record.id);
    }
  }
  const books = new Map(tables.books.map((b) => [b.id, b])),
    readings = new Map(tables.readings.map((r) => [r.id, r])),
    files = new Map(tables.bookFiles.map((f) => [f.id, f]));
  for (const name of backupTables)
    for (const record of tables[name]) {
      if ('bookId' in record && !books.has(record.bookId)) fail();
      if ('readingId' in record) {
        const reading = readings.get(record.readingId);
        if (
          !reading ||
          ('bookId' in record && record.bookId !== reading.bookId)
        )
          fail();
        if (
          'bookFileId' in record &&
          record.bookFileId !== null &&
          files.get(record.bookFileId)?.bookId !== reading?.bookId
        )
          fail();
      }
      if (
        'bookFileId' in record &&
        record.bookFileId !== null &&
        !files.has(record.bookFileId)
      )
        fail();
    }
  const unique = (values: string[]) => {
    if (new Set(values).size !== values.length) fail();
  };
  unique(tables.bookFiles.flatMap((f) => (f.sha256 ? [f.sha256] : [])));
  unique(tables.epubIndexes.map((i) => i.bookFileId));
  unique(
    tables.documentTextIndexes.map(
      (i) => `${i.bookFileId}:${i.sha256}:${String(i.algorithmVersion)}`,
    ),
  );
  unique(
    tables.positions.flatMap((p) =>
      p.bookFileId ? [`${p.readingId}:${p.bookFileId}`] : [],
    ),
  );
  unique(
    tables.catalogSelections.map(
      (r) => `${r.bookId}:${r.source}:${r.editionId}`,
    ),
  );
  if (tables.settings.length > 1) fail();
  for (const collection of tables.collections)
    if (collection.bookIds.some((bookId) => !books.has(bookId))) fail();
  for (const index of [...tables.epubIndexes, ...tables.documentTextIndexes])
    if (index.sha256 !== files.get(index.bookFileId)?.sha256) fail();
  for (const index of tables.documentTextIndexes) {
    const spine = tables.epubIndexes
      .find((i) => i.bookFileId === index.bookFileId)
      ?.spine.map((s, spineIndex) => ({ ...s, spineIndex }))
      .filter((s) => s.linear);
    if (
      !spine ||
      spine.length !== index.sections.length ||
      index.sections.some(
        (s, n) =>
          s.spineIndex !== spine[n]?.spineIndex || s.path !== spine[n].path,
      )
    )
      fail();
  }
  for (const record of [
    ...tables.positions,
    ...tables.annotations,
    ...tables.bookmarks,
  ]) {
    const index = tables.documentTextIndexes.find(
      (i) => i.bookFileId === record.bookFileId,
    );
    if ('cursor' in record && record.bookFileId) {
      if (!index) {
        fail();
        continue;
      }
      const section = cursorSection(index, record.cursor);
      if (
        Math.abs(
          record.progression -
            (index.totalCharacters
              ? (section.start + record.cursor.offset) / index.totalCharacters
              : 0),
        ) > 1e-9
      )
        fail();
    }
    if ('anchor' in record && record.bookFileId) {
      const file = files.get(record.bookFileId);
      if (!file || contentIdentity(file) !== record.anchor.contentId) fail();
      if (index) {
        cursorSection(index, record.anchor.start);
        cursorSection(index, record.anchor.end);
        if (
          'quote' in record &&
          anchorText(index, record.anchor) !== record.quote
        )
          fail();
      }
    }
  }
  const sessions = new Map(tables.sessions.map((s) => [s.id, s]));
  const durations = new Map<string, number>(),
    last = new Map<string, number>();
  for (const event of [...tables.activities].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  )) {
    const s = sessions.get(event.sessionId);
    if (
      !s ||
      s.readingId !== event.readingId ||
      s.contentId !== event.contentId ||
      s.mode !== event.mode ||
      s.textVersion !== event.textVersion ||
      event.from < s.startedAt ||
      event.to > s.endedAt ||
      event.intervals.some((i) => i.end > (s.wordCount ?? 0)) ||
      event.from < (last.get(event.sessionId) ?? 0)
    )
      fail();
    last.set(event.sessionId, event.to);
    durations.set(
      event.sessionId,
      (durations.get(event.sessionId) ?? 0) + event.milliseconds,
    );
  }
  for (const s of tables.sessions)
    if (
      s.mode &&
      Math.abs(s.activeSeconds * 1000 - (durations.get(s.id) ?? 0)) > 0.01
    )
      fail();
}
