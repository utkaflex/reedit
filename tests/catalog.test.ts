import Dexie from 'dexie';
import { schemaV6 } from '../src/infrastructure/database';
import { initialReading } from '../src/services/library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogMatches,
  validateCatalogQuery,
  type CatalogBook,
  type CatalogEdition,
  type CatalogQuery,
} from '../src/domain/catalog';
import {
  GoogleBooksProvider,
  OpenLibraryProvider,
  googleBook,
} from '../src/infrastructure/catalog/providers';
import {
  HttpCatalogTransport,
  type CatalogTransport,
} from '../src/infrastructure/catalog/transport';
import { createLocalStore } from '../src/infrastructure/local-store';
import { ReeditDatabase } from '../src/infrastructure/database';
import { newId } from '../src/domain/model';
import { makeBook, editReading } from '../src/services/library';
import { saveCatalogSelection } from '../src/services/catalog';
import {
  catalogEdition,
  catalogOtherEdition,
  catalogWork,
  googleVolume,
} from './fixtures/catalog';

const query: CatalogQuery = {
  text: 'Преступление и наказание',
  field: 'title',
  language: 'ru',
  page: 0,
};
const signal = () => new AbortController().signal;
function transport(values: Record<string, unknown>): CatalogTransport {
  return {
    json: (path, inputSignal) => {
      inputSignal.throwIfAborted();
      const value = values[path.split('?')[0] ?? ''];
      return Promise.resolve({ value, cached: false, expiresAt: 0 });
    },
  };
}
async function editionFixture(): Promise<{
  book: CatalogBook;
  edition: CatalogEdition;
}> {
  const provider = new OpenLibraryProvider(
    transport({
      'open/search': { docs: [catalogWork], numFound: 1 },
      'open/work': { description: { value: 'Синтетическое описание.' } },
      'open/editions': {
        entries: [catalogEdition, catalogOtherEdition],
        size: 2,
      },
      'open/edition': catalogEdition,
    }),
  );
  const book = (await provider.search(query, signal())).items[0];
  if (!book) throw new Error('Missing fixture');
  const edition = (await provider.editions(book, 0, signal())).items[0];
  if (!edition) throw new Error('Missing fixture');
  return { book, edition: await provider.edition(book, edition, signal()) };
}
describe('CatalogProvider', () => {
  it('Open Library разделяет work и конкретное издание, не подменяет ISBN/год/издателя work-данными', async () => {
    const { book, edition } = await editionFixture();
    expect(book).toMatchObject({
      id: 'OL100W',
      kind: 'work',
      year: '1866',
      isbn: [],
    });
    expect(edition).toMatchObject({
      id: 'OL101M',
      kind: 'edition',
      workId: 'OL100W',
      publisher: 'Тестовое издательство',
      year: '2020',
      language: 'rus',
      description: 'Синтетическое описание.',
      isbn: ['9781234567897'],
    });
    expect(edition.covers).toHaveLength(2);
  });
  it('Google сохраняет порядок, очищает HTML, даёт volume как издание и не использует ссылки текстов', async () => {
    const provider = new GoogleBooksProvider(
      transport({
        'google/search': {
          totalItems: 2,
          items: [googleVolume, { ...googleVolume, id: 'second' }],
        },
        'google/volume': googleVolume,
      }),
    );
    const result = await provider.search(
      { ...query, text: 'Crime and Punishment', language: 'en' },
      signal(),
    );
    expect(result.items.map((item) => item.id)).toEqual([
      'synthetic-volume',
      'second',
    ]);
    expect(result.items[0]).toMatchObject({
      kind: 'edition',
      description: 'Example  description .',
      publisher: 'Synthetic Publisher',
    });
    expect(JSON.stringify(result)).not.toContain('unsafe');
    expect(JSON.stringify(result)).not.toContain('downloadLink');
    const first = result.items[0];
    if (!first) throw new Error('Missing fixture');
    expect((await provider.editions(first, 0, signal())).items).toHaveLength(1);
  });
  it('проверяет ISBN и отклоняет испорченные ответы вместо ложного пустого результата', async () => {
    expect(
      validateCatalogQuery({
        ...query,
        field: 'isbn',
        text: '978-1-234-56789-7',
      }).text,
    ).toBe('9781234567897');
    expect(() =>
      validateCatalogQuery({ ...query, field: 'isbn', text: '9781234567890' }),
    ).toThrow();
    await expect(
      new OpenLibraryProvider(transport({ 'open/search': {} })).search(
        query,
        signal(),
      ),
    ).rejects.toThrow('Некорректный');
    await expect(
      new GoogleBooksProvider(transport({ 'google/search': {} })).search(
        query,
        signal(),
      ),
    ).rejects.toThrow('Некорректный');
  });
});
describe('кэш, отмена и rate limits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('повторный ответ берётся из ограниченного TTL-кэша, после истечения идёт новый запрос', async () => {
    let now = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json(
            { docs: [] },
            { headers: { 'Cache-Control': 'private, max-age=2' } },
          ),
        ),
      );
    const client = new HttpCatalogTransport(fetcher, () => now);
    await client.json('open/search?text=test', signal());
    expect((await client.json('open/search?text=test', signal())).cached).toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 2001;
    await client.json('open/search?text=test', signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('отмена не кеширует устаревший ответ; 429 останавливает повторные запросы до Retry-After', async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
      );
    let now = 0;
    const client = new HttpCatalogTransport(fetcher, () => now);
    await expect(client.json('open/search', abort.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.json('open/search', signal())).rejects.toMatchObject({
      code: 'rate-limit',
      retryAt: 2000,
    });
    await expect(client.json('open/work', signal())).rejects.toMatchObject({
      code: 'rate-limit',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 2001;
    await expect(client.json('open/search', signal())).rejects.toMatchObject({
      code: 'rate-limit',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
const databases: ReeditDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
function storeFixture() {
  const db = new ReeditDatabase(`catalog-${newId()}`);
  databases.push(db);
  return { db, store: createLocalStore(db) };
}
it('создаёт отдельные локальные метаданные/источник/издание; редактирование не меняет каталог, повтор не создаёт дубль', async () => {
  const { db, store } = storeFixture();
  const { book: record, edition } = await editionFixture();
  const draft = {
    title: 'Моё название',
    authors: edition.authors.join('; '),
    description: 'Мой текст',
    genres: '',
    isbn: edition.isbn.join(';'),
    cover: null,
    publisher: edition.publisher,
    publishedDate: edition.year,
  };
  const input = {
    record,
    edition,
    draft,
    target: null,
    replaceMetadata: false,
    allowDuplicate: false,
    selectedCover: null,
  };
  const book = await saveCatalogSelection(store, input);
  expect(book.catalogIds).toEqual([
    { source: 'open-library', value: 'OL101M' },
  ]);
  const stored = (await store.repositories.catalogSelections.list())[0];
  expect(stored).toMatchObject({
    bookId: book.id,
    record: { id: 'OL100W' },
    edition: { id: 'OL101M' },
    snapshot: { edition: { title: edition.title } },
  });
  await expect(saveCatalogSelection(store, input)).rejects.toThrow(
    'Похожая книга',
  );
  const edited = makeBook(
    { ...draft, title: 'Исправлено вручную', description: 'Отредактировано' },
    book,
  );
  await store.saveLibraryBook(edited, {
    expectedUpdatedAt: book.updatedAt,
    allowDuplicate: true,
  });
  db.close();
  await db.open();
  expect((await store.repositories.books.get(book.id))?.description).toBe(
    'Отредактировано',
  );
  expect(
    (await store.repositories.catalogSelections.list())[0]?.snapshot?.edition
      .title,
  ).toBe(edition.title);
  expect((await store.readLibrary()).books).toHaveLength(1);
});
it('сопоставление сохраняет UUID, отзывы, прочтения и позиции, не объединяет одноимённые книги', async () => {
  const { store } = storeFixture();
  const { book: record, edition } = await editionFixture();
  const draft = {
    title: edition.title,
    authors: 'Другой автор',
    description: 'Пользовательское',
    genres: '',
    isbn: '',
    cover: null,
  };
  const original = makeBook(draft);
  await store.repositories.books.save(original);
  const reading = await store.addReading(original.id);
  await store.repositories.readings.save(
    editReading(reading, {
      status: 'planned',
      startedAt: '',
      finishedAt: '',
      rating: '4.5',
      review: 'Личный отзыв',
    }),
  );
  const position = {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    readingId: reading.id,
    bookFileId: null,
    cfi: 'epubcfi(/6/2)',
    progression: 0.5,
  };
  await store.repositories.positions.save(position);
  expect(catalogMatches(original, edition)).toBe(false);
  const saved = await saveCatalogSelection(store, {
    record,
    edition,
    draft: { ...draft, title: 'Каталожное изменение' },
    target: original,
    replaceMetadata: false,
    allowDuplicate: false,
    selectedCover: null,
  });
  expect(saved.id).toBe(original.id);
  expect(saved.title).toBe(original.title);
  expect(saved.description).toBe('Пользовательское');
  expect((await store.repositories.readings.get(reading.id))?.review).toBe(
    'Личный отзыв',
  );
  expect(await store.repositories.positions.get(position.id)).toEqual(position);
  expect((await store.readLibrary()).readings).toHaveLength(1);
  await expect(
    saveCatalogSelection(store, {
      record,
      edition,
      draft,
      target: original,
      replaceMetadata: true,
      allowDuplicate: false,
      selectedCover: null,
    }),
  ).rejects.toThrow('изменена');
  await store.removeBook(original.id, { confirmed: true });
  expect(await store.repositories.catalogSelections.list()).toEqual([]);
});
it('Google сохраняет только ссылку/идентификатор и пользовательские поля, не постоянную копию ответа API', async () => {
  const { store } = storeFixture();
  const edition = googleBook(googleVolume);
  if (!edition) throw new Error('Missing fixture');
  const book = await saveCatalogSelection(store, {
    record: edition,
    edition,
    draft: {
      title: edition.title,
      authors: 'Автор',
      description: 'Написано пользователем',
      genres: '',
      isbn: '',
      cover: null,
    },
    target: null,
    replaceMetadata: false,
    allowDuplicate: false,
    selectedCover: null,
  });
  expect((await store.repositories.catalogSelections.list())[0]).toMatchObject({
    snapshot: null,
    editionId: edition.id,
    bookId: book.id,
  });
  expect(book.description).toBe('Написано пользователем');
});

it('v6 → v7 добавляет только provenance без потери старых BookFile/Reading/позиции', async () => {
  const { db, store } = storeFixture();
  const legacy = new Dexie(db.name);
  legacy.version(6).stores(schemaV6);
  const book = makeBook({
    title: 'Старая книга',
    authors: 'Автор',
    description: 'Личное описание',
    genres: '',
    isbn: '',
    cover: null,
  });
  const reading = {
    ...initialReading(book),
    review: 'Старый отзыв',
    rating: 4.5,
  };
  const file = {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    bookId: book.id,
    name: 'old.epub',
    mediaType: 'application/epub+zip',
    data: new Blob(['original EPUB bytes']),
    sha256: null,
  };
  const position = {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    readingId: reading.id,
    bookFileId: file.id,
    cfi: 'epubcfi(/6/2)',
    progression: 0.4,
  };
  await legacy.table('books').put(book);
  await legacy.table('readings').put(reading);
  await legacy.table('bookFiles').put(file);
  await legacy.table('positions').put(position);
  legacy.close();
  expect(await store.repositories.books.get(book.id)).toEqual(book);
  expect(await store.repositories.readings.get(reading.id)).toEqual(reading);
  expect(await store.repositories.positions.get(position.id)).toEqual(position);
  expect(
    await (await store.repositories.bookFiles.get(file.id))?.data.text(),
  ).toBe('original EPUB bytes');
  expect(await store.repositories.catalogSelections.list()).toEqual([]);
});
it('ошибка записи источника откатывает создание книги и прочтения целиком', async () => {
  const { db, store } = storeFixture();
  const { book: record, edition } = await editionFixture();
  vi.spyOn(db.records('catalogSelections'), 'put').mockImplementationOnce(() =>
    Dexie.Promise.reject(new DOMException('quota', 'QuotaExceededError')),
  );
  await expect(
    saveCatalogSelection(store, {
      record,
      edition,
      draft: {
        title: edition.title,
        authors: 'Автор',
        description: '',
        genres: '',
        isbn: '',
        cover: null,
      },
      target: null,
      replaceMetadata: false,
      allowDuplicate: false,
      selectedCover: null,
    }),
  ).rejects.toMatchObject({ code: 'quota' });
  expect((await store.readLibrary()).books).toEqual([]);
  expect((await store.readLibrary()).readings).toEqual([]);
  expect(await store.repositories.catalogSelections.list()).toEqual([]);
});
