import { contentIdentity, anchorText } from '../src/domain/annotations';
import { saveSelection, exportAnnotations } from '../src/services/annotations';
import { cursorAt } from '../src/domain/text-position';
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import Dexie from 'dexie';
import { EpubJsAdapter } from '../src/infrastructure/epub/EpubJsAdapter';
import {
  ReeditDatabase,
  schemaV1,
  schemaV2,
} from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import { newId } from '../src/domain/model';
import { makeBook, initialReading, editReading } from '../src/services/library';
import { prepareEpub, saveEpub } from '../src/services/epub-import';
import { makeEpubFixture } from './fixtures/epub';
import JSZip from 'jszip';
import { buildDocumentTextIndex } from '../src/infrastructure/epub/text-index';
import { parseXml } from '../src/infrastructure/epub/xml';
import { cursorForWord } from '../src/domain/text-position';
import { PositionResolver } from '../src/infrastructure/epub/PositionResolver';
import { ReadingProgressService } from '../src/services/reading-progress';
import { PositionPersistenceService } from '../src/services/position-persistence';
import { loadReader } from '../src/services/reader';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
  Object.defineProperty(globalThis, 'Blob', {
    configurable: true,
    value: NodeBlob,
  });
});
let db: ReeditDatabase;
let store: ReturnType<typeof createLocalStore>;
beforeEach(() => {
  db = new ReeditDatabase(`import-${newId()}`);
  store = createLocalStore(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await db.delete();
});
async function prepared() {
  const fixture = await makeEpubFixture({
    cover: true,
    chapters: [
      { name: 'z.xhtml', text: 'Начало.' },
      { name: 'a.xhtml', text: 'Продолжение. Вторая часть одной главы.' },
    ],
    toc: [0],
  });
  const file = new NodeFile([fixture.bytes], 'book.epub', {
    type: 'application/epub+zip',
  });
  const controller = new AbortController();
  const value = await prepareEpub(
    new EpubJsAdapter(),
    store,
    file,
    controller.signal,
    () => undefined,
  );
  return { ...value, fixture, controller };
}
const options = {
  name: 'book.epub',
  targetBookId: null,
  allowDuplicateBook: false,
  title: 'Импортированная книга',
};
async function positioned() {
  const { analysis, fixture, controller } = await prepared();
  const saved = await saveEpub(store, analysis, options, controller.signal);
  const zip = await JSZip.loadAsync(fixture.bytes);
  const index = await buildDocumentTextIndex(
    { id: saved.fileId, sha256: analysis.sha256 },
    analysis.spine.flatMap((entry, spineIndex) =>
      entry.linear
        ? [
            {
              spineIndex,
              path: entry.path,
              cfiBase: `/6/${String((spineIndex + 1) * 2)}[part${String(spineIndex)}]`,
              load: async () => {
                const bytes = await zip.file(entry.path)?.async('uint8array');
                if (!bytes) throw new Error('Missing resource');
                return parseXml(bytes, entry.path);
              },
            },
          ]
        : [],
    ),
    controller.signal,
  );
  const readings = await store.repositories.readings.list();
  const reading = readings[0];
  if (!reading) throw new Error('Missing Reading');
  const cursor = cursorForWord(index, 1, 1);
  const bytes = await zip.file('EPUB/a.xhtml')?.async('uint8array');
  if (!bytes) throw new Error('Missing XHTML');
  const cfi = new PositionResolver(index).toCfi(
    cursor,
    parseXml(bytes, 'EPUB/a.xhtml'),
  );
  return { saved, index, cursor, cfi, reading };
}
it('кеширует полный индекс атомарно; курсор и отдельные прочтения переживают повторное открытие', async () => {
  const { saved, index, cursor, cfi, reading } = await positioned();
  const results = await Promise.all([
    store.cacheDocumentTextIndex(index),
    store.cacheDocumentTextIndex({ ...index, id: newId() }),
  ]);
  expect(results[0].id).toBe(results[1].id);
  const input = {
    readingId: reading.id,
    bookFileId: saved.fileId,
    cursor,
    cfi,
    progression: new ReadingProgressService(index).relative(cursor),
  };
  await store.saveReaderPosition(input);
  const previous = (await store.repositories.positions.list())[0];
  const another = await store.addReading(saved.bookId);
  await store.saveReaderPosition({ ...input, readingId: another.id });
  store.close();
  db = new ReeditDatabase(db.name);
  store = createLocalStore(db);
  expect(await store.getDocumentTextIndex(saved.fileId, index.sha256)).toEqual(
    index,
  );
  expect(
    await store.repositories.positions.get(previous?.id ?? newId()),
  ).toMatchObject({ cursor, cfi });
  expect(await store.repositories.positions.list()).toHaveLength(2);
  expect(PositionPersistenceService.restore(index, previous).cursor).toEqual(
    cursor,
  );
  await expect(
    store.saveReaderPosition({
      ...input,
      cursor: { ...cursor, sha256: 'f'.repeat(64) },
    }),
  ).rejects.toThrow();
  await expect(
    store.saveReaderPosition({ ...input, progression: 0.999 }),
  ).rejects.toThrow();
  await store.removeBookFile(saved.fileId);
  expect(await store.repositories.documentTextIndexes.list()).toEqual([]);
  expect(
    await store.repositories.positions.get(previous?.id ?? newId()),
  ).toMatchObject({ bookFileId: null, cursor, cfi });
});
it('ошибка записи индекса не создаёт частичный индекс и не меняет исходный EPUB', async () => {
  const { index, saved } = await positioned();
  const table = db.records('documentTextIndexes');
  const fail = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  table.hook('creating', fail);
  try {
    await expect(store.cacheDocumentTextIndex(index)).rejects.toMatchObject({
      code: 'quota',
    });
  } finally {
    table.hook('creating').unsubscribe(fail);
  }
  expect(await store.repositories.documentTextIndexes.list()).toEqual([]);
  expect(
    (await store.repositories.bookFiles.get(saved.fileId))?.data.size,
  ).toBeGreaterThan(0);
  expect(await store.repositories.positions.list()).toEqual([]);
  await store.cacheDocumentTextIndex(index);
  await store.removeBook(saved.bookId, { confirmed: true });
  expect(await store.repositories.documentTextIndexes.list()).toEqual([]);
});
it('вся книга и оригинал проходят через IndexedDB без потери текста или байтов', async () => {
  const { analysis, fixture, controller } = await prepared();
  expect((await store.readLibrary()).books).toEqual([]);
  await saveEpub(store, analysis, options, controller.signal);
  store.close();
  db = new ReeditDatabase(db.name);
  store = createLocalStore(db);
  const data = await store.readLibrary();
  const indexes = await store.repositories.epubIndexes.list();
  expect(data.books).toHaveLength(1);
  expect(data.files).toHaveLength(1);
  expect(data.readings).toHaveLength(1);
  expect(data.books[0]?.language).toBe('ru');
  expect(data.books[0]?.cover?.size).toBeGreaterThan(0);
  expect(indexes[0]?.sections.map((section) => section.text)).toEqual(
    fixture.expected,
  );
  expect(indexes[0]?.sections.map((section) => section.path)).toEqual(
    fixture.linearPaths,
  );
  const savedFile = data.files[0];
  if (!savedFile) throw new Error('Missing imported file');
  const original = await store.repositories.bookFiles.get(savedFile.id);
  if (!original) throw new Error('Missing original file');
  expect('data' in savedFile).toBe(false);
  expect(new Uint8Array(await original.data.arrayBuffer())).toEqual(
    fixture.bytes,
  );
  expect(data.files[0]?.sha256).toBe(analysis.sha256);
  expect(await store.listBookFiles()).toEqual(data.files);
  expect(await store.findEpubByHash(analysis.sha256)).toEqual(savedFile);
  const reading = data.readings[0];
  if (!reading) throw new Error('Missing reading');
  const allIndexes = vi.spyOn(store.repositories.epubIndexes, 'list');
  const allPositions = vi.spyOn(store.repositories.positions, 'list');
  const loaded = await loadReader(store, {
    bookId: savedFile.bookId,
    fileId: savedFile.id,
    readingId: reading.id,
  });
  expect(loaded.index.sections.map((section) => section.text)).toEqual(
    fixture.expected,
  );
  expect(allIndexes).not.toHaveBeenCalled();
  expect(allPositions).not.toHaveBeenCalled();
});
it('прикрепление не заменяет метаданные, отзывы и существующие прочтения', async () => {
  const book = makeBook({
    title: 'Мои метаданные',
    authors: 'Мой автор',
    description: 'Не менять',
    genres: 'Личное',
    isbn: '',
    cover: null,
  });
  const reading = editReading(initialReading(book), {
    status: 'finished',
    startedAt: '2026-01-01',
    finishedAt: '2026-01-02',
    rating: '4.5',
    review: 'Мой отзыв',
  });
  await store.saveLibraryBook(book, {
    expectedUpdatedAt: null,
    allowDuplicate: false,
    initialReading: reading,
  });
  const { analysis, controller } = await prepared();
  await saveEpub(
    store,
    analysis,
    { ...options, targetBookId: book.id },
    controller.signal,
  );
  expect(await store.repositories.books.get(book.id)).toEqual(book);
  expect(await store.repositories.readings.list()).toEqual([reading]);
  expect((await store.readLibrary()).files[0]?.bookId).toBe(book.id);
});
it('повторный и конкурентный импорт идентичного файла не создаёт записи и не уничтожает существующие', async () => {
  const { analysis, controller } = await prepared();
  const results = await Promise.all([
    saveEpub(store, analysis, options, controller.signal),
    saveEpub(store, analysis, options, controller.signal),
  ]);
  expect(results.filter((result) => result.duplicate)).toHaveLength(1);
  expect(results[0].fileId).toBe(results[1].fileId);
  expect((await store.readLibrary()).books).toHaveLength(1);
  expect(await store.repositories.epubIndexes.list()).toHaveLength(1);
  const existing = await store.findEpubByHash(analysis.sha256);
  expect(existing).toBeDefined();
});
it('ошибка квоты при записи индекса откатывает книгу, файл и прочтение целиком', async () => {
  const { analysis, controller } = await prepared();
  vi.spyOn(db.records('epubIndexes'), 'put').mockRejectedValueOnce(
    new DOMException('full', 'QuotaExceededError'),
  );
  await expect(
    saveEpub(store, analysis, options, controller.signal),
  ).rejects.toMatchObject({ code: 'quota' });
  const data = await store.readLibrary();
  expect(data.books).toEqual([]);
  expect(data.files).toEqual([]);
  expect(data.readings).toEqual([]);
  expect(await store.repositories.epubIndexes.list()).toEqual([]);
});
it('отмена до подтверждения не оставляет частичных записей', async () => {
  const { analysis, controller } = await prepared();
  controller.abort();
  await expect(
    saveEpub(store, analysis, options, controller.signal),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect((await store.readLibrary()).books).toEqual([]);
});
it('отмена во время транзакции откатывает уже записанные книгу и файл', async () => {
  const { analysis, controller } = await prepared();
  vi.spyOn(db.records('epubIndexes'), 'put').mockImplementationOnce(() => {
    controller.abort();
    return Dexie.Promise.reject(new DOMException('cancelled', 'AbortError'));
  });
  await expect(
    saveEpub(store, analysis, options, controller.signal),
  ).rejects.toMatchObject({ code: 'cancelled' });
  const data = await store.readLibrary();
  expect(data.books).toEqual([]);
  expect(data.files).toEqual([]);
  expect(data.readings).toEqual([]);
});
it('удаление файла убирает только его индекс, повторное прикрепление сохраняет историю', async () => {
  const { analysis, controller } = await prepared();
  const saved = await saveEpub(store, analysis, options, controller.signal);
  const history = await store.repositories.readings.list();
  await store.removeBookFile(saved.fileId);
  expect(await store.repositories.epubIndexes.list()).toEqual([]);
  expect(await store.repositories.readings.list()).toEqual(history);
  await saveEpub(
    store,
    analysis,
    { ...options, targetBookId: saved.bookId },
    controller.signal,
  );
  expect(await store.repositories.readings.list()).toEqual(history);
  await store.removeBook(saved.bookId, { confirmed: true });
  expect(await store.repositories.epubIndexes.list()).toEqual([]);
});
it('миграция v2 → v3 не читает/не меняет старый EPUB, отзыв, обложку и коллекции', async () => {
  const legacy = new Dexie(db.name);
  legacy.version(1).stores(schemaV1);
  legacy.version(2).stores(schemaV2);
  const book = makeBook({
    title: 'Старая книга',
    authors: '',
    description: 'Описание',
    genres: '',
    isbn: '',
    cover: new Blob(['cover'], { type: 'image/png' }),
  });
  const file = {
    id: newId(),
    bookId: book.id,
    createdAt: 1,
    updatedAt: 1,
    data: new Blob(['old epub']),
    name: 'old.epub',
    mediaType: 'application/epub+zip',
  };
  const reading = {
    ...initialReading(book),
    review: 'Старый отзыв',
    rating: 4.5,
  };
  await legacy.table('books').add(book);
  await legacy.table('bookFiles').add(file);
  await legacy.table('readings').add(reading);
  legacy.close();
  const data = await store.readLibrary();
  expect(data.books[0]).toEqual(book);
  expect(data.readings[0]).toEqual(reading);
  expect(data.files[0]?.sha256).toBeNull();
  const legacyFile = data.files[0];
  if (!legacyFile) throw new Error('Missing legacy file');
  expect(
    await (await store.repositories.bookFiles.get(legacyFile.id))?.data.text(),
  ).toBe('old epub');
  expect(await store.repositories.epubIndexes.list()).toEqual([]);
});

it('цитаты: точные offsets, идемпотентность, обновление, удаление EPUB и привязка только идентичного импорта', async () => {
  const { saved, index, reading } = await positioned();
  await store.cacheDocumentTextIndex(index);
  const file = await store.repositories.bookFiles.get(saved.fileId);
  if (!file) throw new Error('Missing file');
  const section = index.sections[1];
  if (!section) throw new Error('Missing section');
  const anchor = {
    contentId: contentIdentity(file) ?? '',
    start: cursorAt(index, 1, 0),
    end: cursorAt(index, 1, 12),
    before: '',
    after: section.text.slice(12, 60),
  };
  const selection = {
    anchor,
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:12)',
    quote: section.text.slice(0, 12),
  };
  const address = {
    bookId: saved.bookId,
    fileId: saved.fileId,
    readingId: reading.id,
  };
  const [one, repeated] = await Promise.all([
    saveSelection(store, address, selection, 'blue', 'Личный комментарий'),
    saveSelection(store, address, selection, 'blue', 'Личный комментарий'),
  ]);
  expect(one.id).toBe(repeated.id);
  expect(await store.repositories.annotations.list()).toHaveLength(1);
  await expect(
    saveSelection(store, address, { ...selection, quote: ' ' }, 'yellow', ''),
  ).rejects.toThrow();
  await expect(
    saveSelection(store, address, selection, 'green', 'Другой комментарий'),
  ).rejects.toThrow('уже сохранён');
  await expect(
    store.repositories.annotations.save({ ...one, quote: 'Неверная цитата' }),
  ).rejects.toThrow();
  const edited = {
    ...one,
    note: 'Новая мысль',
    color: 'rose' as const,
    updatedAt: one.updatedAt + 1,
  };
  await store.repositories.annotations.save(edited, {
    expectedUpdatedAt: one.updatedAt,
  });
  await expect(
    store.repositories.annotations.save(
      { ...edited, note: 'Устаревшее' },
      { expectedUpdatedAt: one.updatedAt },
    ),
  ).rejects.toThrow();
  const bookmark = {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    bookId: saved.bookId,
    readingId: reading.id,
    bookFileId: saved.fileId,
    cfi: selection.cfi,
    anchor: { ...anchor, end: anchor.start, after: section.text.slice(0, 48) },
    label: 'Вернуться сюда',
  };
  await store.repositories.bookmarks.save(bookmark);
  const unanchored = { ...edited };
  delete unanchored.anchor;
  await expect(store.repositories.annotations.save(unanchored)).rejects.toThrow(
    'неизменяема',
  );
  await store.removeBookFile(saved.fileId);
  store.close();
  db = new ReeditDatabase(db.name);
  store = createLocalStore(db);
  const detached = await store.repositories.annotations.get(one.id);
  expect(detached).toMatchObject({
    quote: one.quote,
    note: 'Новая мысль',
    color: 'rose',
    bookFileId: null,
    anchor,
  });
  expect(await store.repositories.bookmarks.get(bookmark.id)).toMatchObject({
    label: bookmark.label,
    bookFileId: null,
  });
  expect(
    exportAnnotations(
      detached ? [detached] : [],
      await store.repositories.books.list(),
      'text',
    ),
  ).toContain('Новая мысль');
  const otherFixture = await makeEpubFixture({
    title: 'Другое издание',
    chapters: [{ name: 'new.xhtml', text: 'Другой текст' }],
  });
  const other = await prepareEpub(
    new EpubJsAdapter(),
    store,
    new NodeFile([otherFixture.bytes], 'new.epub'),
    new AbortController().signal,
    () => undefined,
  );
  await saveEpub(
    store,
    other.analysis,
    { ...options, targetBookId: saved.bookId },
    new AbortController().signal,
  );
  expect(
    (await store.repositories.annotations.get(one.id))?.bookFileId,
  ).toBeNull();
  // Reuse the exact original bytes; filename does not determine identity.
  const same = await prepareEpub(
    new EpubJsAdapter(),
    store,
    new NodeFile(
      [new Uint8Array(await file.data.arrayBuffer())],
      'renamed.epub',
    ),
    new AbortController().signal,
    () => undefined,
  );
  const imported = await saveEpub(
    store,
    same.analysis,
    { ...options, targetBookId: saved.bookId },
    new AbortController().signal,
  );
  expect((await store.repositories.annotations.get(one.id))?.bookFileId).toBe(
    imported.fileId,
  );
  expect(
    (await store.repositories.bookmarks.get(bookmark.id))?.bookFileId,
  ).toBe(imported.fileId);
  const attached = await store.repositories.annotations.get(one.id);
  if (!attached) throw new Error('Missing annotation');
  expect(
    await store.getDocumentTextIndex(imported.fileId, index.sha256),
  ).toBeUndefined();
  await store.repositories.annotations.save(
    {
      ...attached,
      note: 'После повторного импорта',
      updatedAt: attached.updatedAt + 1,
    },
    { expectedUpdatedAt: attached.updatedAt },
  );
  expect(anchorText(index, anchor)).toBe(one.quote);
  expect(() =>
    anchorText(index, { ...anchor, before: 'несовпадение' }),
  ).toThrow();
  expect(() =>
    anchorText(index, {
      ...anchor,
      start: { ...anchor.start, sha256: 'f'.repeat(64) },
    }),
  ).toThrow();
  await store.removeSaved(
    'annotations',
    one.id,
    (await store.repositories.annotations.get(one.id))?.updatedAt ?? 0,
  );
  expect(await store.repositories.annotations.get(one.id)).toBeUndefined();
});

it('ошибка квоты при сохранении аннотации не оставляет частичную запись', async () => {
  const { saved, index, reading } = await positioned();
  await store.cacheDocumentTextIndex(index);
  const section = index.sections[0];
  if (!section) throw new Error('Missing section');
  const file = await store.repositories.bookFiles.get(saved.fileId);
  if (!file) throw new Error('Missing file');
  const selection = {
    quote: section.text,
    cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:7)',
    anchor: {
      contentId: contentIdentity(file) ?? '',
      start: cursorAt(index, 0, 0),
      end: cursorAt(index, 0, section.text.length),
      before: '',
      after: '',
    },
  };
  vi.spyOn(db.records('annotations'), 'put').mockImplementationOnce(() =>
    Dexie.Promise.reject(new DOMException('full', 'QuotaExceededError')),
  );
  const address = {
    bookId: saved.bookId,
    fileId: saved.fileId,
    readingId: reading.id,
  };
  await expect(
    saveSelection(store, address, selection, 'yellow', 'Мысль'),
  ).rejects.toMatchObject({ code: 'quota' });
  expect(await store.repositories.annotations.list()).toEqual([]);
  expect(await store.repositories.books.get(saved.bookId)).toBeDefined();
  const savedNote = await saveSelection(
    store,
    address,
    selection,
    'yellow',
    'Мысль',
  );
  expect(
    exportAnnotations(
      [savedNote],
      (await store.repositories.books.list()).map((book) => ({
        ...book,
        title: '[Ссылка](https://example.com)',
      })),
      'markdown',
    ),
  ).toContain('\\[Ссылка\\]\\(https://example\\.com\\)');
});
