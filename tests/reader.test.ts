import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import {
  defaultReaderPreferences,
  readerGesture,
  validReaderPreferences,
  type ReaderLocation,
} from '../src/domain/reader';
import {
  newId,
  type Book,
  type BookFile,
  type Reading,
} from '../src/domain/model';
import {
  ReeditDatabase,
  schemaV3,
  schemaV4,
} from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import {
  createPositionWriter,
  saveReaderPreferences,
} from '../src/services/reader';
import { ReaderNavigationGate } from '../src/services/reader-navigation';
import {
  parseReaderAddress,
  readerUrl,
} from '../src/features/shell/navigation';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const base = () => ({ id: newId(), createdAt: 1000, updatedAt: 1000 });
const location = (cfi: string): ReaderLocation => ({
  cfi,
  path: 'chapter.xhtml',
  spineIndex: 0,
  chapter: 'Начало',
  progression: 0.2,
  atStart: false,
  atEnd: false,
});
const gesture = {
  x: 200,
  y: 200,
  endX: 200,
  endY: 200,
  width: 390,
  duration: 100,
  selected: false,
  interactive: false,
  mode: 'paginated' as const,
  rtl: false,
};

describe('навигация чтения', () => {
  it('различает жест, касание, выделение и системный край Safari', () => {
    expect(readerGesture(gesture)).toBe('toggle');
    expect(readerGesture({ ...gesture, x: 330, endX: 330 })).toBe('next');
    expect(readerGesture({ ...gesture, x: 40, endX: 40 })).toBe('previous');
    expect(readerGesture({ ...gesture, endX: 120 })).toBe('next');
    expect(readerGesture({ ...gesture, endX: 120, rtl: true })).toBe(
      'previous',
    );
    expect(readerGesture({ ...gesture, endY: 100 })).toBe('none');
    expect(readerGesture({ ...gesture, selected: true, endX: 120 })).toBe(
      'none',
    );
    expect(readerGesture({ ...gesture, interactive: true })).toBe('none');
    expect(readerGesture({ ...gesture, duration: 600 })).toBe('none');
    expect(readerGesture({ ...gesture, x: 5, endX: 200 })).toBe('none');
    expect(
      readerGesture({ ...gesture, mode: 'scroll', x: 330, endX: 330 }),
    ).toBe('toggle');
  });
  it('не ставит повторные перелистывания в очередь', async () => {
    vi.useFakeTimers();
    const gate = new ReaderNavigationGate();
    let finish: () => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = gate.run(action, true);
    expect(await gate.run(action, true)).toBe(false);
    finish();
    await vi.runAllTimersAsync();
    expect(await first).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    gate.destroy();
    expect(await gate.run(action)).toBe(false);
  });
  it('проверяет настройки и адреса с локальными UUID', () => {
    expect(validReaderPreferences(defaultReaderPreferences)).toBe(true);
    expect(
      validReaderPreferences({ ...defaultReaderPreferences, fontSize: 100 }),
    ).toBe(false);
    expect(
      validReaderPreferences({ ...defaultReaderPreferences, lineHeight: NaN }),
    ).toBe(false);
    const address = { bookId: newId(), fileId: newId(), readingId: newId() };
    expect(parseReaderAddress(readerUrl(address))).toEqual(address);
    expect(parseReaderAddress('#/reading/isbn/file/reading')).toBeNull();
  });
});

describe('сохранение чтения', () => {
  async function fixture() {
    const db = new ReeditDatabase(`reader-${newId()}`);
    const store = createLocalStore(db);
    const book: Book = {
      ...base(),
      title: 'Книга',
      authors: [],
      isbn: [],
      catalogIds: [],
      description: '',
      genres: [],
      cover: null,
      language: null,
    };
    const reading: Reading = {
      ...base(),
      bookId: book.id,
      status: 'active',
      startedAt: 1000,
      finishedAt: null,
      rating: null,
      review: '',
    };
    const file: BookFile = {
      ...base(),
      bookId: book.id,
      name: 'test.epub',
      mediaType: 'application/epub+zip',
      data: new Blob(['epub']),
      sha256: null,
    };
    await store.repositories.books.save(book);
    await store.repositories.readings.save(reading);
    await store.repositories.bookFiles.save(file);
    return {
      db,
      store,
      book,
      reading,
      file,
      address: { bookId: book.id, fileId: file.id, readingId: reading.id },
    };
  }
  it('обновляет ту же запись, разделяет файлы и сохраняет настройки приложения', async () => {
    const { db, store, file, reading } = await fixture();
    try {
      const input = {
        readingId: reading.id,
        bookFileId: file.id,
        cfi: 'epubcfi(/6/2)',
        progression: 0.2,
      };
      await store.saveReaderPosition(input);
      const initial = (await store.repositories.positions.list())[0];
      await store.saveReaderPosition({ ...input, cfi: 'epubcfi(/6/4)' });
      expect((await store.repositories.positions.list())[0]?.id).toBe(
        initial?.id,
      );
      const other = { ...file, id: newId() };
      await store.repositories.bookFiles.save(other);
      await store.saveReaderPosition({ ...input, bookFileId: other.id });
      expect(await store.repositories.positions.list()).toHaveLength(2);
      const settings = {
        ...base(),
        key: 'local' as const,
        locale: 'ru' as const,
        theme: 'dark' as const,
      };
      await store.repositories.settings.save(settings);
      await saveReaderPreferences(store, {
        ...defaultReaderPreferences,
        theme: 'sepia',
      });
      expect(await store.repositories.settings.get(settings.id)).toMatchObject({
        theme: 'dark',
        reader: { theme: 'sepia' },
      });
      store.close();
      await db.open();
      expect(await store.repositories.positions.list()).toHaveLength(2);
      await store.removeBookFile(file.id);
      expect(await store.repositories.positions.list()).toHaveLength(2);
      expect(
        await store.repositories.positions.get(initial?.id ?? newId()),
      ).toMatchObject({ bookFileId: null, cfi: 'epubcfi(/6/4)' });
    } finally {
      store.close();
      await db.delete();
    }
  });
  it('пишет только подтверждённые позиции, объединяет очередь и повторяет неудачную запись', async () => {
    const { db, store, address } = await fixture();
    try {
      const states: string[] = [];
      const writer = createPositionWriter(store, address, (state) =>
        states.push(state),
      );
      expect(await store.repositories.positions.list()).toHaveLength(0);
      const original = store.saveReaderPosition.bind(store);
      let finish: () => void = () => undefined;
      const delay = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const save = vi
        .spyOn(store, 'saveReaderPosition')
        .mockImplementationOnce(async (input) => {
          await delay;
          await original(input);
        });
      writer.push(location('epubcfi(/6/2)'));
      writer.push(location('epubcfi(/6/4)'));
      writer.push(location('epubcfi(/6/6)'));
      finish();
      await writer.flush();
      expect(save).toHaveBeenCalledTimes(2);
      expect((await store.repositories.positions.list())[0]?.cfi).toBe(
        'epubcfi(/6/6)',
      );
      save.mockRejectedValueOnce(
        new DOMException('Место закончилось', 'QuotaExceededError'),
      );
      writer.push(location('epubcfi(/6/8)'));
      await expect(writer.flush()).rejects.toThrow('Место закончилось');
      expect((await store.repositories.positions.list())[0]?.cfi).toBe(
        'epubcfi(/6/6)',
      );
      await writer.flush();
      expect((await store.repositories.positions.list())[0]?.cfi).toBe(
        'epubcfi(/6/8)',
      );
      expect(states).toContain('error');
      expect(states.at(-1)).toBe('saved');
    } finally {
      store.close();
      await db.delete();
    }
  });
  it.each([
    { version: 3, schema: schemaV3 },
    { version: 4, schema: schemaV4 },
  ])(
    'мигрирует v$version без потери UUID, CFI и оригинального Blob',
    async ({ version, schema }) => {
      const name = `migration-reader-${newId()}`;
      const old = new Dexie(name);
      old.version(version).stores(schema);
      const book: Book = {
        ...base(),
        title: 'До обновления',
        authors: [],
        isbn: [],
        catalogIds: [],
        description: '',
        genres: [],
        cover: null,
        language: null,
      };
      const reading: Reading = {
        ...base(),
        bookId: book.id,
        status: 'active',
        startedAt: null,
        finishedAt: null,
        rating: null,
        review: '',
      };
      const file: BookFile = {
        ...base(),
        bookId: book.id,
        name: 'old.epub',
        mediaType: 'application/epub+zip',
        data: new Blob(['original']),
        sha256: null,
      };
      const position = {
        ...base(),
        readingId: reading.id,
        bookFileId: file.id,
        cfi: 'epubcfi(/6/2)',
        progression: 0.3,
      };
      await old.table('books').add(book);
      await old.table('readings').add(reading);
      await old.table('bookFiles').add(file);
      await old.table('positions').add(position);
      old.close();
      const db = new ReeditDatabase(name);
      const store = createLocalStore(db);
      try {
        expect(await store.repositories.positions.get(position.id)).toEqual(
          position,
        );
        expect(
          await (await store.repositories.bookFiles.get(file.id))?.data.text(),
        ).toBe('original');
        const other = { ...file, id: newId() };
        await store.repositories.bookFiles.save(other);
        await store.saveReaderPosition({ ...position, bookFileId: other.id });
        expect(await store.repositories.positions.list()).toHaveLength(2);
      } finally {
        store.close();
        await db.delete();
      }
    },
  );
});
