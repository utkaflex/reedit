// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { File } from 'node:buffer';
import { newId, type ReadingSession } from '../src/domain/model';
import { createArchive } from '../src/infrastructure/backup/archive';
import { backupTables, type BackupManifest } from '../src/domain/backup';
import { ReeditDatabase } from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import { DocumentAdapter } from '../src/infrastructure/DocumentAdapter';
import { makeEpubFixture } from './fixtures/epub';
import { makeFb2Fixture } from './fixtures/fb2';
import { saveEpub } from '../src/services/epub-import';
import { exportLibrary, inspectBackup } from '../src/services/backup';
import { buildDocumentTextIndex } from '../src/infrastructure/epub/text-index';
import { parseXml } from '../src/infrastructure/epub/xml';
import { cursorAt } from '../src/domain/text-position';
import { PositionResolver } from '../src/infrastructure/epub/PositionResolver';
import { ReadingProgressService } from '../src/services/reading-progress';
import { contentIdentity } from '../src/domain/annotations';
import { ReadingActivityService } from '../src/services/reading-activity';
import { sha256 } from '../src/infrastructure/fb2/Fb2Adapter';
import { storageCapacity, requestPersistence } from '../src/services/pwa';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
});
const databases: ReeditDatabase[] = [];
const controller = () => new AbortController();
const adapter = new DocumentAdapter();
const progress = () => undefined;
const portableSession = (session: ReadingSession) => {
  const result = { ...session };
  delete result.ownerId;
  delete result.leaseKey;
  delete result.leaseUntil;
  return result;
};
function database() {
  const db = new ReeditDatabase(`backup-${newId()}`);
  databases.push(db);
  return { db, store: createLocalStore(db) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function fixture() {
  const { db, store } = database(),
    test = await makeEpubFixture({
      cover: true,
      chapters: [
        { name: 'a.xhtml', text: 'Первое второе третье.' },
        { name: 'b.xhtml', text: 'Четвёртое пятое.' },
      ],
      toc: [0],
    });
  const analysis = await adapter.analyze(
    new File([test.bytes], 'original.epub'),
    controller().signal,
    progress,
  );
  const saved = await saveEpub(
    store,
    analysis,
    {
      name: 'original.epub',
      title: 'Тестовая книга копии',
      targetBookId: null,
      allowDuplicateBook: false,
    },
    controller().signal,
  );
  const reading = (await store.repositories.readings.list())[0];
  if (!reading) throw new Error('No Reading');
  await store.repositories.readings.save({
    ...reading,
    rating: 4.5,
    review: 'Сохранённый отзыв',
    updatedAt: reading.updatedAt + 1,
  });
  const zip = await JSZip.loadAsync(test.bytes);
  const index = await buildDocumentTextIndex(
    { id: saved.fileId, sha256: analysis.sha256 },
    analysis.spine.map((entry, spineIndex) => ({
      spineIndex,
      path: entry.path,
      cfiBase: `/6/${String((spineIndex + 1) * 2)}[part${String(spineIndex)}]`,
      load: async () => {
        const source = await zip.file(entry.path)?.async('string');
        if (!source) throw new Error('Missing XHTML');
        return parseXml(new TextEncoder().encode(source), entry.path);
      },
    })),
    controller().signal,
  );
  await store.cacheDocumentTextIndex(index);
  const start = cursorAt(index, 0, 0, 'word'),
    end = cursorAt(index, 0, 6, 'word');
  const first = zip.file(analysis.spine[0]?.path ?? '');
  if (!first) throw new Error('Missing XHTML');
  const doc = parseXml(await first.async('uint8array'), 'a.xhtml');
  const resolver = new PositionResolver(index);
  await store.saveReaderPosition({
    readingId: reading.id,
    bookFileId: saved.fileId,
    cfi: resolver.toCfi(start, doc),
    progression: new ReadingProgressService(index).relative(start),
    cursor: start,
  });
  const now = Date.now(),
    base = { id: newId(), createdAt: now, updatedAt: now };
  const file = await store.repositories.bookFiles.get(saved.fileId);
  if (!file) throw new Error('Missing file');
  await store.saveAnnotation({
    ...base,
    bookId: saved.bookId,
    readingId: reading.id,
    bookFileId: saved.fileId,
    quote: 'Первое',
    note: 'Комментарий',
    color: 'yellow',
    cfi: resolver.toCfi(start, doc),
    anchor: {
      contentId: contentIdentity(file) ?? '',
      start,
      end,
      before: '',
      after: index.sections[0]?.text.slice(6, 54) ?? '',
    },
  });
  await store.repositories.journal.save({
    ...base,
    id: newId(),
    bookId: saved.bookId,
    readingId: reading.id,
    day: '2026-11-03',
    body: 'Впечатление',
  });
  await store.repositories.collections.save({
    ...base,
    id: newId(),
    name: 'Избранное',
    bookIds: [saved.bookId],
  });
  await store.repositories.settings.save({
    ...base,
    id: newId(),
    key: 'local',
    locale: 'ru',
    theme: 'dark',
    readingGoals: { '2026': 12 },
  });
  let utc = Date.now();
  const activity = new ReadingActivityService(
    store,
    reading.id,
    saved.fileId,
    progress,
    { utc: () => utc, monotonic: () => utc },
  );
  await activity.pulse('rsvp');
  utc += 1000;
  await activity.record('rsvp', { start: 0, end: 1 });
  await activity.pause();
  return { db, store, saved, reading, bytes: test.bytes };
}
async function archiveTables(blob: Blob) {
  return JSZip.loadAsync(await blob.arrayBuffer());
}
async function mutate(
  blob: Blob,
  change: (zip: JSZip) => Promise<void> | void,
): Promise<Blob> {
  const zip = await archiveTables(blob);
  await change(zip);
  return new Blob([
    new Uint8Array(
      await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    ),
  ]);
}
async function replaceJson(zip: JSZip, path: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  zip.file(path, bytes, { createFolders: false });
  const entry = zip.file('manifest.json');
  if (!entry) throw new Error('manifest');
  const manifest = JSON.parse(await entry.async('string')) as BackupManifest;
  const record = manifest.entries.find((e) => e.path === path);
  if (!record) throw new Error('entry');
  record.size = bytes.length;
  record.sha256 = await sha256(bytes.buffer);
  zip.file('manifest.json', JSON.stringify(manifest));
}
describe('резервные копии', () => {
  it('полная копия FB2 сохраняет оригинал и отдельное EPUB-представление', async () => {
    const { store } = database(),
      fixture = makeFb2Fixture();
    const analysis = await adapter.analyze(
      new File([fixture.bytes], 'original.fb2'),
      controller().signal,
      progress,
    );
    await saveEpub(
      store,
      analysis,
      {
        name: 'original.fb2',
        title: 'FB2 в копии',
        targetBookId: null,
        allowDuplicateBook: false,
      },
      controller().signal,
    );
    const before = await store.readBackup();
    const prepared = await inspectBackup(
      await exportLibrary(store, true, controller().signal, progress),
      adapter,
      controller().signal,
      progress,
    );
    await store.restoreBackup(
      prepared,
      before.revision,
      { confirmed: true },
      controller().signal,
    );
    const file = (await store.readBackup()).tables.bookFiles[0];
    expect(file?.mediaType).toBe('application/x-fictionbook+xml');
    expect(await file?.data.arrayBuffer()).toEqual(fixture.bytes.buffer);
    expect(await file?.representation?.data.arrayBuffer()).toEqual(
      await before.tables.bookFiles[0]?.representation?.data.arrayBuffer(),
    );
  });
  it('активный HTML в книге отклоняется даже в ZIP с верными контрольными суммами', async () => {
    const f = await fixture(),
      source = await makeEpubFixture({
        unsafeMarkup: '<script>globalThis.unsafeBackup = true</script>',
      });
    const { tables } = await f.store.readBackup();
    const file = tables.bookFiles[0];
    if (!file) throw new Error('file');
    file.data = new Blob([new Uint8Array(source.bytes)], {
      type: 'application/epub+zip',
    });
    file.sha256 = null;
    tables.epubIndexes = [];
    tables.documentTextIndexes = [];
    tables.positions = [];
    tables.annotations = [];
    tables.bookmarks = [];
    tables.sessions = [];
    tables.activities = [];
    const archive = await createArchive(
      tables,
      true,
      controller().signal,
      progress,
    );
    await expect(
      inspectBackup(archive, adapter, controller().signal, progress),
    ).rejects.toThrow();
    expect(Object.hasOwn(globalThis, 'unsafeBackup')).toBe(false);
  });
  it('экспорт → очистка только тестовой базы → импорт сохраняет книги, отзывы, цитаты, позиции, файлы и статистику', async () => {
    const f = await fixture(),
      before = await f.store.readBackup();
    const blob = await exportLibrary(
      f.store,
      true,
      controller().signal,
      progress,
    );
    const prepared = await inspectBackup(
      blob,
      adapter,
      controller().signal,
      progress,
    );
    await f.db.transaction('rw', f.db.tables, async () => {
      for (const name of backupTables) await f.db.records(name).clear();
    });
    await f.store.restoreBackup(
      prepared,
      (await f.store.readBackup()).revision,
      { confirmed: true },
      controller().signal,
    );
    const restored = await f.store.readBackup();
    for (const name of backupTables) {
      if (name === 'sessions')
        expect(restored.tables.sessions.map(portableSession)).toEqual(
          before.tables.sessions.map(portableSession),
        );
      else expect(restored.tables[name]).toEqual(before.tables[name]);
    }
    expect(await restored.tables.bookFiles[0]?.data.arrayBuffer()).toEqual(
      f.bytes.buffer,
    );
    expect(restored.tables.readings[0]?.review).toBe('Сохранённый отзыв');
    f.store.close();
    const reopened = createLocalStore(new ReeditDatabase(f.db.name));
    try {
      expect((await reopened.readBackup()).revision).toBe(restored.revision);
    } finally {
      reopened.close();
    }
  });
  it('копия без файлов сохраняет обложки, цитаты, комментарии, якоря и историю без фиктивных вложений', async () => {
    const f = await fixture(),
      blob = await exportLibrary(f.store, false, controller().signal, progress),
      prepared = await inspectBackup(
        blob,
        adapter,
        controller().signal,
        progress,
      );
    expect(prepared.tables.bookFiles).toEqual([]);
    expect(prepared.tables.epubIndexes).toEqual([]);
    expect(prepared.tables.documentTextIndexes).toEqual([]);
    expect(prepared.tables.books[0]?.cover).toBeInstanceOf(Blob);
    expect(prepared.tables.annotations[0]).toMatchObject({
      bookFileId: null,
      quote: 'Первое',
      note: 'Комментарий',
    });
    expect(prepared.tables.positions[0]?.cursor).toBeDefined();
    expect(prepared.tables.activities).toHaveLength(1);
    await f.store.restoreBackup(
      prepared,
      (await f.store.readBackup()).revision,
      { confirmed: true },
      controller().signal,
    );
    expect((await f.store.readStatistics()).journal[0]?.body).toBe(
      'Впечатление',
    );
  });
  it('сбой записи после clear откатывает всю библиотеку и Blob', async () => {
    const f = await fixture(),
      before = await f.store.readBackup();
    const prepared = await inspectBackup(
      await exportLibrary(f.store, true, controller().signal, progress),
      adapter,
      controller().signal,
      progress,
    );
    const hook = () => {
      throw new DOMException('Disk full', 'QuotaExceededError');
    };
    f.db.records('readings').hook('creating', hook);
    await expect(
      f.store.restoreBackup(
        prepared,
        before.revision,
        { confirmed: true },
        controller().signal,
      ),
    ).rejects.toThrow('места');
    f.db.records('readings').hook('creating').unsubscribe(hook);
    expect((await f.store.readBackup()).revision).toBe(before.revision);
  });
  it('отмена во время транзакции откатывает удаления и новые записи', async () => {
    const f = await fixture(),
      before = await f.store.readBackup(),
      stop = controller();
    const prepared = await inspectBackup(
      await exportLibrary(f.store, false, controller().signal, progress),
      adapter,
      controller().signal,
      progress,
    );
    const hook = () => {
      stop.abort();
    };
    f.db.records('books').hook('creating', hook);
    await expect(
      f.store.restoreBackup(
        prepared,
        before.revision,
        { confirmed: true },
        stop.signal,
      ),
    ).rejects.toThrow();
    f.db.records('books').hook('creating').unsubscribe(hook);
    expect((await f.store.readBackup()).revision).toBe(before.revision);
  });
  it('требует подтверждения и отклоняет библиотеку, изменившуюся после preview', async () => {
    const f = await fixture(),
      before = await f.store.readBackup(),
      prepared = await inspectBackup(
        await exportLibrary(f.store, false, controller().signal, progress),
        adapter,
        controller().signal,
        progress,
      );
    await expect(
      f.store.restoreBackup(
        prepared,
        before.revision,
        { confirmed: false },
        controller().signal,
      ),
    ).rejects.toThrow('подтверждение');
    await f.store.addReading(f.saved.bookId);
    const changed = await f.store.readBackup();
    await expect(
      f.store.restoreBackup(
        prepared,
        before.revision,
        { confirmed: true },
        controller().signal,
      ),
    ).rejects.toThrow('изменилась');
    expect((await f.store.readBackup()).revision).toBe(changed.revision);
  });
  it('старые вкладки не могут писать поверх восстановленных данных', async () => {
    const f = await fixture(),
      other = createLocalStore(new ReeditDatabase(f.db.name));
    await other.repositories.books.list();
    const before = await f.store.readBackup(),
      prepared = await inspectBackup(
        await exportLibrary(f.store, false, controller().signal, progress),
        adapter,
        controller().signal,
        progress,
      );
    await f.store.restoreBackup(
      prepared,
      before.revision,
      { confirmed: true },
      controller().signal,
    );
    try {
      await expect(other.addReading(f.saved.bookId)).rejects.toThrow(
        'Перезагрузите',
      );
      await expect(
        other.removeBook(f.saved.bookId, { confirmed: true }),
      ).rejects.toThrow('Перезагрузите');
    } finally {
      other.close();
    }
  });
  it('не восстанавливает поверх активной книги в другом окне', async () => {
    const f = await fixture(),
      prepared = await inspectBackup(
        await exportLibrary(f.store, false, controller().signal, progress),
        adapter,
        controller().signal,
        progress,
      );
    await f.store.claimActivity({
      ownerId: newId(),
      readingId: f.reading.id,
      fileId: f.saved.fileId,
      mode: 'ordinary',
      now: Date.now(),
    });
    await expect(
      f.store.restoreBackup(
        prepared,
        (await f.store.readBackup()).revision,
        { confirmed: true },
        controller().signal,
      ),
    ).rejects.toThrow('закройте книги');
  });
  it('отвергает повреждение CRC/контрольной суммы и неизвестные версии без изменения БД', async () => {
    const f = await fixture(),
      before = await f.store.readBackup(),
      blob = await exportLibrary(f.store, true, controller().signal, progress);
    const corrupt = await mutate(blob, (zip) => {
      zip.file('tables/books.json', '[]');
    });
    await expect(
      inspectBackup(corrupt, adapter, controller().signal, progress),
    ).rejects.toThrow();
    const future = await mutate(blob, async (zip) => {
      const file = zip.file('manifest.json');
      if (!file) throw new Error();
      const value: unknown = JSON.parse(await file.async('string'));
      if (value && typeof value === 'object')
        zip.file('manifest.json', JSON.stringify({ ...value, version: 99 }));
    });
    await expect(
      inspectBackup(future, adapter, controller().signal, progress),
    ).rejects.toThrow('Версия');
    expect((await f.store.readBackup()).revision).toBe(before.revision);
  });
  it('даже с корректными SHA отклоняет неправильные поля, ссылки и prototype pollution', async () => {
    const f = await fixture(),
      blob = await exportLibrary(f.store, false, controller().signal, progress);
    for (const value of [
      [{ ...f.reading, id: newId(), bookId: newId() }],
      [{ ...f.reading, review: 9 }],
      JSON.parse('[{"__proto__":{"polluted":true}}]') as unknown,
    ]) {
      const unsafe = await mutate(blob, (zip) =>
        replaceJson(zip, 'tables/readings.json', value),
      );
      await expect(
        inspectBackup(unsafe, adapter, controller().signal, progress),
      ).rejects.toThrow();
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('path traversal, лишние файлы и превышение размера отклоняются до восстановления', async () => {
    const f = await fixture(),
      blob = await exportLibrary(f.store, false, controller().signal, progress);
    for (const name of [
      '../escape.txt',
      '/absolute.txt',
      'C:/outside.txt',
      'unlisted.txt',
    ]) {
      await expect(
        inspectBackup(
          await mutate(blob, (zip) => {
            zip.file(name, 'unsafe', { createFolders: false });
          }),
          adapter,
          controller().signal,
          progress,
        ),
      ).rejects.toThrow();
    }
    const bomb = await mutate(blob, (zip) => {
      zip.file('bomb.bin', new Uint8Array(1));
    });
    const bytes = new Uint8Array(await bomb.arrayBuffer()),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 256 * 1024 * 1024, true);
        break;
      }
    await expect(
      inspectBackup(new Blob([bytes]), adapter, controller().signal, progress),
    ).rejects.toThrow();
  });
  it('проверка отменяется до любых изменений и дата копии требует явного подтверждения сохранения', async () => {
    const f = await fixture(),
      blob = await exportLibrary(f.store, false, controller().signal, progress),
      stop = controller();
    stop.abort();
    await expect(
      inspectBackup(blob, adapter, stop.signal, progress),
    ).rejects.toThrow('отменена');
    expect((await f.store.backupStatus()).lastBackupAt).toBeNull();
    const at = Date.now();
    await f.store.confirmBackup(at, false);
    expect(await f.store.backupStatus()).toMatchObject({
      lastBackupAt: at,
      includedFiles: false,
    });
  });
});
describe('Storage API', () => {
  it('оценка и persist необязательны; отказ не мешает локальной работе', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    });
    expect(await storageCapacity()).toEqual({
      usage: null,
      quota: null,
      persistent: null,
    });
    expect(await requestPersistence()).toBeNull();
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ usage: 10, quota: 100 }),
        persisted: () => Promise.resolve(false),
        persist: () => Promise.resolve(false),
      },
    });
    expect(await storageCapacity()).toEqual({
      usage: 10,
      quota: 100,
      persistent: false,
    });
    expect(await requestPersistence()).toBe(false);
  });
});
