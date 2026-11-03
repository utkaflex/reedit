import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { newId, type Collection } from '../src/domain/model';
import { ReeditDatabase, schemaV1 } from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import { makeBook, initialReading, editReading } from '../src/services/library';
import {
  DuplicateBookError,
  latestReading,
  parseDate,
  selectBooks,
  validIsbn,
} from '../src/domain/library';
import { validate } from '../src/domain/rules';

let db: ReeditDatabase;
let store: ReturnType<typeof createLocalStore>;
beforeEach(() => {
  db = new ReeditDatabase(`library-${newId()}`);
  store = createLocalStore(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await db.delete();
});
const draft = () => ({
  title: 'Моя книга',
  authors: 'Первый автор; Второй автор',
  description: 'Описание',
  genres: 'Роман, Проза',
  isbn: '9780140328721',
  cover: new Blob(['cover'], { type: 'image/png' }),
});
async function create() {
  const book = makeBook(draft());
  const reading = initialReading(book);
  await store.saveLibraryBook(book, {
    expectedUpdatedAt: null,
    allowDuplicate: false,
    initialReading: reading,
  });
  return { book, reading };
}

it('создаёт книгу без EPUB, редактирует метаданные и локальную обложку, сохраняет после перезапуска', async () => {
  const { book } = await create();
  const changed = makeBook(
    { ...draft(), title: 'Новое название', cover: null },
    book,
  );
  await store.saveLibraryBook(changed, {
    expectedUpdatedAt: book.updatedAt,
    allowDuplicate: false,
  });
  store.close();
  db = new ReeditDatabase(db.name);
  store = createLocalStore(db);
  const data = await store.readLibrary();
  expect(data.books).toEqual([changed]);
  expect(data.files).toEqual([]);
  expect(data.readings).toHaveLength(1);
});
it('откатывает создание книги, если начальное прочтение не прошло валидацию', async () => {
  const book = makeBook(draft());
  const reading = { ...initialReading(book), rating: 6 };
  await expect(
    store.saveLibraryBook(book, {
      expectedUpdatedAt: null,
      allowDuplicate: false,
      initialReading: reading,
    }),
  ).rejects.toThrow();
  expect((await store.readLibrary()).books).toEqual([]);
});
it('не перезаписывает историю при повторном чтении и сохраняет оценку и отзыв конкретного Reading', async () => {
  const { book, reading } = await create();
  const finished = editReading(reading, {
    status: 'finished',
    startedAt: '2026-01-01',
    finishedAt: '2026-01-08',
    rating: '4.5',
    review: 'Личный отзыв',
  });
  await store.repositories.readings.save(finished, {
    expectedUpdatedAt: reading.updatedAt,
  });
  const next = await store.addReading(book.id);
  const data = await store.readLibrary();
  expect(latestReading(data.readings, book.id)?.id).toBe(next.id);
  expect(next).toMatchObject({
    status: 'planned',
    rating: null,
    review: '',
    startedAt: null,
    finishedAt: null,
  });
  expect(await store.repositories.readings.get(reading.id)).toEqual(finished);
});
it('проверяет границы и шаг рейтинга, календарные даты и все статусы', () => {
  const book = makeBook(draft());
  const reading = initialReading(book);
  for (const rating of [0.5, 1, 4.5, 5, null])
    expect(() => {
      validate('readings', { ...reading, rating });
    }).not.toThrow();
  for (const rating of [0, 0.25, 5.5, NaN])
    expect(() => {
      validate('readings', { ...reading, rating });
    }).toThrow();
  for (const value of ['2026-02-30', '2026-13-01', 'invalid'])
    expect(() => parseDate(value)).toThrow();
  expect(parseDate('2024-02-29')).not.toBeNull();
  for (const status of ['paused', 'abandoned'] as const)
    expect(() => {
      validate('readings', { ...reading, status });
    }).not.toThrow();
  expect(() => {
    validate('readings', { ...reading, status: 'active' });
  }).toThrow();
});
it('дубли требуют явного подтверждения; конкурентное добавление не обходит проверку', async () => {
  const a = makeBook(draft());
  const b = makeBook({ ...draft(), title: 'Другое название с тем же ISBN' });
  const result = await Promise.allSettled(
    [a, b].map((book) =>
      store.saveLibraryBook(book, {
        expectedUpdatedAt: null,
        allowDuplicate: false,
        initialReading: initialReading(book),
      }),
    ),
  );
  expect(result.filter((value) => value.status === 'fulfilled')).toHaveLength(
    1,
  );
  expect((await store.readLibrary()).books).toHaveLength(1);
  const duplicate = makeBook(draft());
  await expect(
    store.saveLibraryBook(duplicate, {
      expectedUpdatedAt: null,
      allowDuplicate: false,
    }),
  ).rejects.toBeInstanceOf(DuplicateBookError);
  await store.saveLibraryBook(duplicate, {
    expectedUpdatedAt: null,
    allowDuplicate: true,
  });
  expect((await store.readLibrary()).books).toHaveLength(2);
});
it('проверяет ISBN и находит совпадение нормализованного названия и автора без ISBN', async () => {
  expect(validIsbn('0-14-032872-6')).toBe(true);
  expect(validIsbn('9780140328721')).toBe(true);
  expect(validIsbn('9780140328722')).toBe(false);
  const a = makeBook({ ...draft(), isbn: '', title: 'Ёлка: История' });
  await store.saveLibraryBook(a, {
    expectedUpdatedAt: null,
    allowDuplicate: false,
  });
  const b = makeBook({ ...draft(), isbn: '', title: 'елка история' });
  await expect(
    store.saveLibraryBook(b, {
      expectedUpdatedAt: null,
      allowDuplicate: false,
    }),
  ).rejects.toBeInstanceOf(DuplicateBookError);
});
it('коллекции хранят ссылки, редактируются, удаляются без удаления книг', async () => {
  const { book } = await create();
  const now = Date.now();
  const collection: Collection = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    name: 'Мои любимые',
    bookIds: [book.id],
  };
  await store.repositories.collections.save(collection, {
    expectedUpdatedAt: null,
  });
  await expect(
    store.repositories.collections.save({
      ...collection,
      bookIds: [book.id, book.id],
    }),
  ).rejects.toThrow();
  await expect(
    store.removeCollection(collection.id, { confirmed: false }),
  ).rejects.toThrow();
  await store.repositories.collections.save(
    { ...collection, name: 'Любимые', bookIds: [], updatedAt: now + 1 },
    { expectedUpdatedAt: now },
  );
  await store.removeCollection(collection.id, { confirmed: true });
  expect((await store.readLibrary()).books).toHaveLength(1);
  expect((await store.readLibrary()).collections).toEqual([]);
});
it('отвергает устаревшее редактирование, в том числе после удаления книги', async () => {
  const { book } = await create();
  const newer = makeBook({ ...draft(), title: 'Новая версия' }, book);
  await store.saveLibraryBook(newer, {
    expectedUpdatedAt: book.updatedAt,
    allowDuplicate: false,
  });
  await expect(
    store.saveLibraryBook(book, {
      expectedUpdatedAt: book.updatedAt,
      allowDuplicate: false,
    }),
  ).rejects.toThrow('другой вкладке');
  await store.removeBook(book.id, { confirmed: true });
  await expect(
    store.saveLibraryBook(newer, {
      expectedUpdatedAt: newer.updatedAt,
      allowDuplicate: false,
    }),
  ).rejects.toThrow('другой вкладке');
  expect((await store.readLibrary()).books).toEqual([]);
});
it('поиск, статус, коллекция и сортировка работают по реальным данным', async () => {
  const { book, reading } = await create();
  const other = makeBook({
    ...draft(),
    title: 'Альфа',
    isbn: '',
    authors: 'Другой',
  });
  const options = {
    query: 'ПРОЗА',
    status: 'planned',
    collectionBookIds: [book.id],
    sort: 'title' as const,
  };
  expect(selectBooks([other, book], [reading], options)).toEqual([book]);
  expect(
    selectBooks([other, book], [reading], {
      ...options,
      query: '978-0140328721',
    }),
  ).toEqual([book]);
  expect(
    selectBooks([book, other], [], {
      ...options,
      query: '',
      collectionBookIds: null,
    }).map((value) => value.title),
  ).toEqual(['Альфа', 'Моя книга']);
});
it('мигрирует реальную v1 в v2 без потери UUID, истории, Blob и пользовательских записей', async () => {
  const legacy = new Dexie(db.name);
  legacy.version(1).stores(schemaV1);
  const bookId = newId();
  const readingId = newId();
  const now = 1000;
  const oldBook = {
    id: bookId,
    createdAt: now,
    updatedAt: now,
    title: 'Книга v1',
    authors: ['Автор'],
    isbn: [],
    catalogIds: [],
  };
  const oldReading = {
    id: readingId,
    bookId,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    startedAt: now,
    finishedAt: null,
  };
  const file = {
    id: newId(),
    bookId,
    createdAt: now,
    updatedAt: now,
    name: 'old.epub',
    mediaType: 'application/epub+zip',
    data: new Blob(['original epub']),
  };
  await legacy.table('books').add(oldBook);
  await legacy.table('readings').add(oldReading);
  await legacy.table('bookFiles').add(file);
  const bookmark = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    readingId,
    bookFileId: file.id,
    cfi: 'epubcfi(/6/2)',
    label: 'Место',
  };
  await legacy.table('bookmarks').add(bookmark);
  legacy.close();
  const data = await store.readLibrary();
  expect(data.books[0]).toEqual({
    ...oldBook,
    description: '',
    genres: [],
    cover: null,
    language: null,
  });
  expect(data.readings[0]).toEqual({ ...oldReading, rating: null, review: '' });
  expect(
    await (await store.repositories.bookFiles.get(file.id))?.data.text(),
  ).toBe('original epub');
  expect(await store.repositories.bookmarks.get(bookmark.id)).toEqual({
    ...bookmark,
    bookId: oldBook.id,
  });
  expect(data.books).toHaveLength(1);
  expect(data.readings).toHaveLength(1);
});

it('сбой миграции откатывает изменения и допускает безопасную повторную попытку', async () => {
  const legacy = new Dexie(db.name);
  legacy.version(1).stores(schemaV1);
  const oldBook = {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    title: 'Сохранить при сбое',
    authors: [],
    isbn: [],
    catalogIds: [],
  };
  await legacy.table('books').add(oldBook);
  legacy.close();
  const failure = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
  await expect(db.open().then(() => undefined)).rejects.toThrow();
  failure.mockRestore();
  db.close();
  const verify = new Dexie(db.name);
  verify.version(1).stores(schemaV1);
  expect(await verify.table('books').get(oldBook.id)).toEqual(oldBook);
  verify.close();
  db = new ReeditDatabase(db.name);
  store = createLocalStore(db);
  expect((await store.readLibrary()).books[0]).toMatchObject({
    ...oldBook,
    description: '',
    genres: [],
    cover: null,
    language: null,
  });
});
