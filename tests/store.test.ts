import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, id, type Book, type Reading } from '../src/domain/model';
import { validate, IntegrityError } from '../src/domain/rules';
import { ReeditDatabase } from '../src/infrastructure/database';
import {
  createLocalStore,
  StorageError,
} from '../src/infrastructure/local-store';
import { checkStorage } from '../src/services/storage-status';
import Dexie from 'dexie';
import {
  schemaV1,
  schemaV2,
  schemaV3,
  schemaV4,
  schemaV5,
  schemaV6,
  schemaV7,
  schemaV8,
  schemaV9,
} from '../src/infrastructure/database';

const base = () => ({ id: newId(), createdAt: 1000, updatedAt: 1000 });
const book = (): Book => ({
  ...base(),
  title: 'Книга',
  authors: [],
  isbn: [],
  catalogIds: [],
  description: '',
  genres: [],
  cover: null,
  language: null,
});
let db: ReeditDatabase;
let store: ReturnType<typeof createLocalStore>;
beforeEach(() => {
  db = new ReeditDatabase(`test-${newId()}`);
  store = createLocalStore(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await db.delete();
});
async function fixture() {
  const b = book();
  await store.repositories.books.save(b);
  const r: Reading = {
    ...base(),
    bookId: b.id,
    status: 'active',
    startedAt: 1000,
    finishedAt: null,
    rating: null,
    review: '',
  };
  await store.repositories.readings.save(r);
  const f = {
    ...base(),
    bookId: b.id,
    name: 'book.epub',
    mediaType: 'application/epub+zip' as const,
    data: new Blob(['epub']),
    sha256: null,
  };
  await store.repositories.bookFiles.save(f);
  const location = {
    ...base(),
    readingId: r.id,
    bookFileId: f.id,
    cfi: 'epubcfi(/6/2)',
  };
  await store.repositories.positions.save({ ...location, progression: 0.2 });
  await store.repositories.annotations.save({
    ...location,
    id: newId(),
    quote: 'Текст',
    note: 'Заметка',
  });
  await store.repositories.bookmarks.save({
    ...location,
    id: newId(),
    label: 'Место',
  });
  await store.repositories.sessions.save({
    ...base(),
    readingId: r.id,
    startedAt: 1000,
    endedAt: 2000,
    activeSeconds: 1,
  });
  return { b, r, f };
}
describe('доменные правила', () => {
  it('принимает только UUID, независимо от ISBN', () => {
    expect(() => id('9781234567890')).toThrow();
    expect(id(newId())).toBeTruthy();
  });
  it('проверяет название, даты и прогресс', () => {
    expect(() => {
      validate('books', { ...book(), title: ' ' });
    }).toThrow(IntegrityError);
    expect(() => {
      validate('books', { ...book(), updatedAt: 0 });
    }).toThrow(IntegrityError);
    expect(() => {
      validate('positions', {
        ...base(),
        readingId: newId(),
        bookFileId: null,
        cfi: 'cfi',
        progression: NaN,
      });
    }).toThrow(IntegrityError);
    expect(() => {
      validate('readings', {
        ...base(),
        bookId: newId(),
        status: 'finished',
        startedAt: 10,
        finishedAt: 9,
        rating: null,
        review: '',
      });
    }).toThrow(IntegrityError);
  });
});
describe('локальное хранилище', () => {
  it('v8 → v9 сохраняет книгу, обложку, отзыв, цитату, позицию и исходный файл', async () => {
    const legacy = new Dexie(db.name);
    legacy.version(8).stores(schemaV8);
    const b = { ...book(), cover: new Blob(['cover']) };
    const r: Reading = {
      ...base(),
      bookId: b.id,
      status: 'active',
      startedAt: 1000,
      finishedAt: null,
      rating: 4.5,
      review: 'Личный отзыв',
    };
    const f = {
      ...base(),
      bookId: b.id,
      name: 'original.epub',
      mediaType: 'application/epub+zip',
      data: new Blob(['original']),
      sha256: null,
    };
    const a = {
      ...base(),
      bookId: b.id,
      readingId: r.id,
      bookFileId: f.id,
      quote: 'Цитата',
      note: 'Комментарий',
      cfi: 'legacy-cfi',
      color: 'yellow',
    };
    const p = {
      ...base(),
      readingId: r.id,
      bookFileId: f.id,
      cfi: 'legacy-cfi',
      progression: 0.4,
    };
    try {
      await legacy.table('books').put(b);
      await legacy.table('readings').put(r);
      await legacy.table('bookFiles').put(f);
      await legacy.table('annotations').put(a);
      await legacy.table('positions').put(p);
    } finally {
      legacy.close();
    }
    expect(await store.repositories.readings.get(r.id)).toEqual(r);
    expect(await store.repositories.annotations.get(a.id)).toEqual(a);
    expect(await store.getReadingPosition(r.id, f.id)).toEqual(p);
    expect(
      await (await store.repositories.books.get(b.id))?.cover?.text(),
    ).toBe('cover');
    expect(
      await (await store.repositories.bookFiles.get(f.id))?.data.text(),
    ).toBe('original');
    expect(db.verno).toBe(9);
  });
  it('позволяет аддитивную миграцию без потери записей и Blob', async () => {
    const { b, f } = await fixture();
    store.close();
    const next = new Dexie(db.name);
    next.version(1).stores(schemaV1);
    next.version(2).stores(schemaV2);
    next.version(3).stores(schemaV3);
    next.version(4).stores(schemaV4);
    next.version(5).stores(schemaV5);
    next.version(6).stores(schemaV6);
    next.version(7).stores(schemaV7);
    next.version(8).stores(schemaV8);
    next.version(9).stores(schemaV9);
    next.version(10).stores({ books: 'id, title, updatedAt' });
    try {
      await next.open();
      expect(await next.table<Book>('books').get(b.id)).toEqual(b);
      const saved = await next.table<{ data: Blob }>('bookFiles').get(f.id);
      expect(await saved?.data.text()).toBe('epub');
    } finally {
      next.close();
    }
  });
  it('при конкурирующих удалении и записи не оставляет висячую связь', async () => {
    const { b, r } = await fixture();
    await Promise.allSettled([
      store.removeBook(b.id, { confirmed: true }),
      store.repositories.bookmarks.save({
        ...base(),
        readingId: r.id,
        bookFileId: null,
        cfi: 'cfi',
        label: '',
      }),
    ]);
    expect(await store.repositories.books.get(b.id)).toBeUndefined();
    expect(await store.repositories.bookmarks.list()).toEqual([]);
  });
  it('проверяет запись без создания пользовательских настроек; работает с существующими', async () => {
    await store.checkAvailability();
    expect(await store.repositories.settings.list()).toEqual([]);
    const settings = {
      ...base(),
      key: 'local' as const,
      theme: 'dark' as const,
      locale: 'ru' as const,
    };
    await store.repositories.settings.save(settings);
    await store.checkAvailability();
    expect(await store.repositories.settings.list()).toEqual([settings]);
  });
  it('сохраняет данные и Blob после повторного открытия базы', async () => {
    const { b, f } = await fixture();
    const name = db.name;
    store.close();
    db = new ReeditDatabase(name);
    store = createLocalStore(db);
    expect(await store.repositories.books.get(b.id)).toEqual(b);
    expect(
      await (await store.repositories.bookFiles.get(f.id))?.data.text(),
    ).toBe('epub');
  });
  it('удаляет только файл, сохраняет историю и допускает новый EPUB и прочтение', async () => {
    const { b, r, f } = await fixture();
    await store.removeBookFile(f.id);
    expect(await store.repositories.books.get(b.id)).toBeDefined();
    expect(await store.repositories.readings.get(r.id)).toBeDefined();
    for (const name of ['annotations', 'bookmarks', 'positions'] as const)
      expect((await store.repositories[name].list())[0]?.bookFileId).toBeNull();
    await store.repositories.bookFiles.save({ ...f, id: newId() });
    await store.repositories.readings.save({ ...r, id: newId() });
    expect(await store.repositories.readings.list()).toHaveLength(2);
    expect(
      (await store.repositories.positions.list())[0]?.bookFileId,
    ).toBeNull();
  });
  it('запрещает висячие и перекрёстные связи и перенос родителей', async () => {
    const { r, f } = await fixture();
    await expect(
      store.repositories.readings.save({ ...r, id: newId(), bookId: newId() }),
    ).rejects.toThrow(IntegrityError);
    const other = book();
    await store.repositories.books.save(other);
    await expect(
      store.repositories.bookFiles.save({ ...f, bookId: other.id }),
    ).rejects.toThrow(IntegrityError);
    const otherReading = { ...r, id: newId(), bookId: other.id };
    await store.repositories.readings.save(otherReading);
    await expect(
      store.repositories.bookmarks.save({
        ...base(),
        readingId: otherReading.id,
        bookFileId: f.id,
        cfi: 'cfi',
        label: '',
      }),
    ).rejects.toThrow(IntegrityError);
  });
  it('обеспечивает одну позицию на пару прочтение–файл, сохраняет прежнюю при ошибке', async () => {
    const { r, f } = await fixture();
    await expect(
      store.repositories.positions.save({
        ...base(),
        readingId: r.id,
        bookFileId: f.id,
        cfi: 'new',
        progression: 0,
      }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(await store.repositories.positions.list()).toHaveLength(1);
  });
  it('требует подтверждение удаления книги, атомарно чистит связи и коллекции', async () => {
    const { b } = await fixture();
    const other = book();
    await store.repositories.books.save(other);
    const c = { ...base(), name: 'Полка', bookIds: [b.id, other.id] };
    await store.repositories.collections.save(c);
    await expect(store.removeBook(b.id, { confirmed: false })).rejects.toThrow(
      IntegrityError,
    );
    expect(await store.repositories.books.get(b.id)).toBeDefined();
    await store.removeBook(b.id, { confirmed: true });
    for (const name of [
      'bookFiles',
      'readings',
      'positions',
      'annotations',
      'bookmarks',
      'sessions',
    ] as const)
      expect(await store.repositories[name].list()).toEqual([]);
    expect((await store.repositories.collections.get(c.id))?.bookIds).toEqual([
      other.id,
    ]);
  });
  it('откатывает удаление файла при ошибке в транзакции', async () => {
    const { f } = await fixture();
    vi.spyOn(db.records('bookFiles'), 'delete').mockRejectedValueOnce(
      new DOMException('full', 'QuotaExceededError'),
    );
    await expect(store.removeBookFile(f.id)).rejects.toMatchObject({
      code: 'quota',
    });
    expect(await store.repositories.bookFiles.get(f.id)).toBeDefined();
    expect((await store.repositories.annotations.list())[0]?.bookFileId).toBe(
      f.id,
    );
  });
  it('сообщает об отказе открытия хранилища', async () => {
    vi.spyOn(db, 'open').mockRejectedValueOnce(new Error('unavailable'));
    expect(await checkStorage(store)).toMatchObject({ state: 'error' });
  });
});

it('v5 → v6 сохраняет старые цитаты, комментарии, CFI и Blob, добавляет связь с книгой без догадок о содержимом', async () => {
  const legacy = new Dexie(db.name);
  legacy.version(5).stores(schemaV5);
  const b = book();
  const readingId = newId();
  const fileId = newId();
  const annotationId = newId();
  await legacy.table('books').put(b);
  await legacy
    .table('readings')
    .put({ ...base(), id: readingId, bookId: b.id });
  await legacy.table('bookFiles').put({
    ...base(),
    id: fileId,
    bookId: b.id,
    data: new Blob(['original']),
    sha256: null,
  });
  const annotation = {
    ...base(),
    id: annotationId,
    readingId,
    bookFileId: fileId,
    cfi: 'old-cfi',
    quote: 'Старая цитата',
    note: 'Мой комментарий',
  };
  await legacy.table('annotations').put(annotation);
  legacy.close();
  const migrated = await store.repositories.annotations.get(annotationId);
  expect(migrated).toEqual({ ...annotation, bookId: b.id, color: 'yellow' });
  expect(migrated?.anchor).toBeUndefined();
  expect(
    await (await store.repositories.bookFiles.get(fileId))?.data.text(),
  ).toBe('original');
});
