// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import JSZip from 'jszip';
import { Fb2Adapter } from '../src/infrastructure/fb2/Fb2Adapter';
import { DocumentAdapter } from '../src/infrastructure/DocumentAdapter';
import { EpubJsAdapter } from '../src/infrastructure/epub/EpubJsAdapter';
import { makeFb2Fixture, expectedFb2Parts, fb2Namespace } from './fixtures/fb2';
import { makeEpubFixture } from './fixtures/epub';
import { ReeditDatabase } from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import { prepareEpub, saveEpub } from '../src/services/epub-import';
import { newId } from '../src/domain/model';
import { makeBook, initialReading, editReading } from '../src/services/library';

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
afterEach(() => {
  vi.restoreAllMocks();
});
const file = (source: string | Uint8Array<ArrayBuffer>) =>
  new NodeFile([source], 'book.fb2', {
    type: 'application/x-fictionbook+xml',
  });
const analyze = (source = makeFb2Fixture().source) =>
  new Fb2Adapter().analyze(
    file(source),
    new AbortController().signal,
    () => undefined,
  );
describe('FB2 → проверенный EPUB', () => {
  it('извлекает метаданные/обложку, весь текст, стихотворение, вложенные секции и примечания в порядке XML', async () => {
    const fixture = makeFb2Fixture();
    const result = await analyze(fixture.source);
    expect(result.sourceFormat).toBe('fb2');
    expect(result.metadata).toMatchObject({
      title: 'Синтетическая книга FB2',
      authors: ['Иван Иванович Авторов', 'Соавтор'],
      language: 'ru',
    });
    expect(result.metadata.description).toBe(
      'Первый абзац описания.\n\nВторой абзац описания.',
    );
    expect(result.cover?.type).toBe('image/png');
    expect(result.sections.map((section) => section.text)).toEqual(
      expectedFb2Parts,
    );
    expect(
      Array.from(new Uint8Array(await result.original.arrayBuffer())),
    ).toEqual(Array.from(fixture.bytes));
    expect(result.representation?.sourceSha256).toBe(result.sha256);
    expect(result.representation?.sha256).not.toBe(result.sha256);
    const representation = result.representation;
    if (!representation) throw new Error('Missing EPUB');
    const zip = await JSZip.loadAsync(await representation.data.arrayBuffer());
    const first = await zip.file('EPUB/part-0.xhtml')?.async('string');
    expect(first).toContain('<em');
    expect(first).toContain('fb2-stanza');
    expect(first).toMatch(/href="part-3.xhtml#fb2-\d+"/);
    const second = await new EpubJsAdapter().analyze(
      new NodeFile(
        [new Uint8Array(await representation.data.arrayBuffer())],
        'derived.epub',
      ),
      new AbortController().signal,
      () => undefined,
    );
    expect(second.sections.map((section) => section.text)).toEqual(
      expectedFb2Parts,
    );
  });
  it('одна книга в FB2 и независимо созданном EPUB имеет тот же полный порядок текста', async () => {
    const fb2 = await analyze();
    const fixture = await makeEpubFixture({
      chapters: expectedFb2Parts.map((text, i) => ({
        name: `section-${String(i)}.xhtml`,
        text,
      })),
      toc: [0, 1, 4],
    });
    const epub = await new EpubJsAdapter().analyze(
      new NodeFile([fixture.bytes], 'same.epub'),
      new AbortController().signal,
      () => undefined,
    );
    expect(fb2.sections.map((section) => section.text)).toEqual(
      epub.sections.map((section) => section.text),
    );
    expect(fb2.sections.map((section) => section.wordCount)).toEqual(
      epub.sections.map((section) => section.wordCount),
    );
  });
  it('поддерживает кодированные ссылки и вложенное оглавление без исходных id', async () => {
    const source = makeFb2Fixture()
      .source.replace('id="nested"', '')
      .replace('id="note1"', 'id="сноска"')
      .replace('#note1', '#%D1%81%D0%BD%D0%BE%D1%81%D0%BA%D0%B0')
      .replaceAll('#cover', '#%63over');
    const result = await analyze(source);
    expect(result.sections.map((section) => section.text)).toEqual(
      expectedFb2Parts,
    );
    expect(result.navigation[1]?.children[0]?.label).toBe('Подраздел');
    expect(result.navigation[1]?.children[0]?.fragment).toMatch(
      /^fb2-section-/,
    );
  });
  it('отмена во время конверсии возвращает штатную ошибку отмены', async () => {
    const abort = new AbortController();
    await expect(
      new Fb2Adapter().analyze(
        file(makeFb2Fixture({ long: true }).source),
        abort.signal,
        (message) => {
          if (message.startsWith('Готовим часть')) abort.abort();
        },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('конверсия воспроизводима, стили не исполняются, внешние ссылки сохраняют текст', async () => {
    const fixture = makeFb2Fixture();
    const one = await analyze(fixture.source);
    const two = await analyze(fixture.source);
    expect(one.representation?.sha256).toBe(two.representation?.sha256);
    const result = await analyze(
      fixture.source
        .replace(
          '<description>',
          '<stylesheet type="text/css">@import "https://example.org/evil.css";</stylesheet><description>',
        )
        .replace(
          'Первый абзац с',
          '<a l:href="https://example.org/book">Ссылка</a> Первый абзац с',
        ),
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.sections[1]?.text).toContain('Ссылка Первый');
  });
  it.each([
    ['повреждённый XML', '<FictionBook>'],
    [
      'внешняя сущность',
      `<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "https://example.org/secret">]>${makeFb2Fixture()
        .source.replace(/^<\?xml[^>]+>/, '')
        .replace('Первый абзац', '&x;')}`,
    ],
    [
      'внешний DTD',
      makeFb2Fixture().source.replace(
        '<FictionBook',
        '<!DOCTYPE FictionBook SYSTEM "https://example.org/fb2.dtd"><FictionBook',
      ),
    ],
    [
      'processing instruction',
      makeFb2Fixture().source.replace(
        '<description>',
        '<?xml-stylesheet href="https://example.org/evil"?><description>',
      ),
    ],
    [
      'неизвестный контент',
      makeFb2Fixture().source.replace(
        'Первый абзац с',
        '<unknown>Не терять текст</unknown> Первый абзац с',
      ),
    ],
    [
      'скрипт',
      makeFb2Fixture().source.replace(
        'Первый абзац с',
        '<script>alert(1)</script> Первый абзац с',
      ),
    ],
    [
      'неизвестный namespace',
      makeFb2Fixture().source.replace(
        'Первый абзац с',
        '<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script> Первый абзац с',
      ),
    ],
    [
      'обработчик',
      makeFb2Fixture().source.replace(
        '<p id="paragraph">',
        '<p id="paragraph" onclick="alert(1)">',
      ),
    ],
    [
      'потерянное изображение',
      makeFb2Fixture().source.replaceAll('#cover', '#missing'),
    ],
    [
      'удалённое изображение',
      makeFb2Fixture().source.replaceAll(
        '#cover',
        'https://example.org/cover.png',
      ),
    ],
    [
      'потерянное примечание',
      makeFb2Fixture().source.replace('#note1', '#missing'),
    ],
    [
      'повторный id',
      makeFb2Fixture().source.replace('id="nested"', 'id="start"'),
    ],
    [
      'неверный Base64',
      makeFb2Fixture().source.replace(
        /<binary([^>]+)>[^<]+/,
        '<binary$1>!invalid!',
      ),
    ],
    [
      'текст вне абзаца',
      makeFb2Fixture().source.replace(
        '<section id="start">',
        '<section id="start">Потерянный текст',
      ),
    ],
    ['неверный корень', `<book xmlns="${fb2Namespace}"/>`],
  ])('отклоняет %s без исполнения содержимого', async (_, source) => {
    await expect(analyze(source)).rejects.toThrow();
  });
  it('принимает UTF-16 и Windows-1251; отмена и размер проверяются до сохранения', async () => {
    const source = makeFb2Fixture().source.replace('UTF-8', 'UTF-16');
    const encoded = new Uint8Array(2 + source.length * 2);
    encoded[0] = 255;
    encoded[1] = 254;
    const view = new DataView(encoded.buffer);
    for (let i = 0; i < source.length; i++)
      view.setUint16(2 + i * 2, source.charCodeAt(i), true);
    const utf16 = await new Fb2Adapter().analyze(
      file(encoded),
      new AbortController().signal,
      () => undefined,
    );
    expect(utf16.sections.map((section) => section.text)).toEqual(
      expectedFb2Parts,
    );
    const short = `<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns="${fb2Namespace}"><description><title-info><book-title>Книга</book-title><lang>ru</lang></title-info></description><body><section><p>Текст.</p></section></body></FictionBook>`;
    const cp = Uint8Array.from(short, (character) => {
      const code = character.charCodeAt(0);
      return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
    });
    const decoded = await new Fb2Adapter().analyze(
      file(cp),
      new AbortController().signal,
      () => undefined,
    );
    expect(decoded.metadata.title).toBe('Книга');
    expect(decoded.sections[0]?.text).toBe('Текст.');
    const signal = new AbortController();
    signal.abort();
    await expect(
      new Fb2Adapter().analyze(file(source), signal.signal, () => undefined),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      new Fb2Adapter().analyze(
        {
          name: 'large.fb2',
          size: 17 * 1024 * 1024,
          type: '',
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'limit' });
  });
});

it('ошибка сохранения FB2 откатывает оба Blob, книгу, прочтение и индекс', async () => {
  const db = new ReeditDatabase(`fb2-quota-${newId()}`);
  const store = createLocalStore(db);
  const hook = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  try {
    const result = await analyze();
    db.records('epubIndexes').hook('creating', hook);
    await expect(
      saveEpub(
        store,
        result,
        {
          name: 'book.fb2',
          title: result.metadata.title,
          targetBookId: null,
          allowDuplicateBook: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'quota' });
    expect(await store.repositories.books.list()).toEqual([]);
    expect(await store.repositories.bookFiles.list()).toEqual([]);
    expect(await store.repositories.readings.list()).toEqual([]);
    expect(await store.repositories.epubIndexes.list()).toEqual([]);
  } finally {
    db.records('epubIndexes').hook('creating').unsubscribe(hook);
    store.close();
    await db.delete();
  }
});

it('прикрепление FB2 не меняет личный отзыв, оценку, метаданные или прочтения', async () => {
  const db = new ReeditDatabase(`fb2-attach-${newId()}`);
  const store = createLocalStore(db);
  try {
    const book = makeBook({
      title: 'Мои данные',
      authors: 'Мой автор',
      description: 'Личное описание',
      genres: '',
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
    const analysis = await analyze();
    await saveEpub(
      store,
      analysis,
      {
        name: 'attached.fb2',
        title: analysis.metadata.title,
        targetBookId: book.id,
        allowDuplicateBook: false,
      },
      new AbortController().signal,
    );
    expect(await store.repositories.books.get(book.id)).toEqual(book);
    expect(await store.repositories.readings.list()).toEqual([reading]);
    expect((await store.repositories.bookFiles.list())[0]?.mediaType).toBe(
      'application/x-fictionbook+xml',
    );
  } finally {
    store.close();
    await db.delete();
  }
});

it('оригинал FB2, EPUB-представление и индекс сохраняются атомарно и переживают reopen; дубли не меняют историю', async () => {
  const db = new ReeditDatabase(`fb2-${newId()}`);
  const store = createLocalStore(db);
  try {
    const prepared = await prepareEpub(
      new DocumentAdapter(),
      store,
      file(makeFb2Fixture().source),
      new AbortController().signal,
      () => undefined,
    );
    const options = {
      name: 'book.fb2',
      title: prepared.analysis.metadata.title,
      targetBookId: null,
      allowDuplicateBook: false,
    };
    const saved = await saveEpub(
      store,
      prepared.analysis,
      options,
      new AbortController().signal,
    );
    store.close();
    await db.open();
    const original = await store.repositories.bookFiles.get(saved.fileId);
    expect(original?.mediaType).toBe('application/x-fictionbook+xml');
    expect(await original?.data.text()).toBe(makeFb2Fixture().source);
    expect(original?.representation?.data.size).toBeGreaterThan(0);
    const duplicate = await saveEpub(
      store,
      prepared.analysis,
      options,
      new AbortController().signal,
    );
    expect(duplicate.duplicate).toBe(true);
    expect(await store.repositories.books.list()).toHaveLength(1);
    expect(await store.repositories.readings.list()).toHaveLength(1);
    await store.removeBookFile(saved.fileId);
    expect(await store.repositories.books.list()).toHaveLength(1);
    expect(await store.repositories.readings.list()).toHaveLength(1);
    expect(await store.repositories.epubIndexes.list()).toEqual([]);
  } finally {
    store.close();
    await db.delete();
  }
});
