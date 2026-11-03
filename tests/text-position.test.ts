import EpubCFI from 'epubjs/lib/epubcfi.js';
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { newId } from '../src/domain/model';
import {
  cursorAt,
  cursorForWord,
  wordAtCursor,
  validateDocumentTextIndex,
  type DocumentTextIndex,
} from '../src/domain/text-position';
import {
  buildDocumentTextIndex,
  createIndexScheduler,
  indexTextSection,
} from '../src/infrastructure/epub/text-index';
import { PositionResolver } from '../src/infrastructure/epub/PositionResolver';
import { PositionPersistenceService } from '../src/services/position-persistence';
import { ReadingProgressService } from '../src/services/reading-progress';

const hash = 'a'.repeat(64);
const xml = (body: string) =>
  new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Служебное</title></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  );
async function index(
  doc: Document,
  segmentation: DocumentTextIndex['segmentation'] = 'intl',
) {
  const section = await indexTextSection(
    doc,
    { path: 'EPUB/part.xhtml', spineIndex: 0, cfiBase: '/6/2[part]', start: 0 },
    createIndexScheduler(new AbortController().signal, () => Promise.resolve()),
    segmentation,
  );
  const result: DocumentTextIndex = {
    id: newId(),
    bookFileId: newId(),
    createdAt: 1,
    updatedAt: 1,
    algorithmVersion: 1,
    sha256: hash,
    segmentation,
    sections: [section],
    totalCharacters: section.text.length,
  };
  validateDocumentTextIndex(result);
  return result;
}
describe('DocumentTextIndex и PositionResolver', () => {
  it('семантические блоки не склеивают слова без явного whitespace', async () => {
    const data = await index(
      xml(
        '<dl><dt>Вопрос</dt><dd>Ответ</dd></dl><aside>Примечание</aside><table><tr><th>Колонка</th><td>Значение</td></tr></table>',
      ),
    );
    expect(data.sections[0]?.text).toBe(
      'Вопрос Ответ Примечание Колонка Значение',
    );
  });
  it('CDATA и соседние текстовые узлы канонизируются без потери текста и CFI', async () => {
    const doc = xml('<p>До. <![CDATA[Слово <не тег> & текст]]> После.</p>');
    const data = await index(doc);
    const resolver = new PositionResolver(data);
    expect(data.sections[0]?.text).toBe('До. Слово <не тег> & текст После.');
    const cursor = cursorForWord(data, 0, 1);
    expect(resolver.fromCfi(resolver.toCfi(cursor, doc), doc, 'word')).toEqual(
      cursor,
    );
  });
  it('нормализует русский текст, NFC, переносы и мягкий дефис; исключает служебное', async () => {
    const doc = xml(
      '<nav>Меню</nav><p>Е\u0308лка — <em>по\u00adрусски</em>,\n  да!</p><p hidden="">Скрыто</p><p aria-hidden="true">Скрыто</p><div style="display:none">Скрыто</div><script>скрипт</script><p>Конец.</p>',
    );
    const data = await index(doc);
    expect(data.sections[0]?.text).toBe('Ёлка — порусски, да! Конец.');
    const resolver = new PositionResolver(data);
    for (let word = 0; word < 4; word++) {
      const cursor = cursorForWord(data, 0, word);
      expect(
        resolver.fromCfi(resolver.toCfi(cursor, doc), doc, 'word'),
      ).toEqual(cursor);
    }
  });
  it('сохраняет связь через inline-границы и комбинируемые символы', async () => {
    const doc = xml('<p>сло<em>во</em> е<span>\u0308</span>ж.</p>');
    const data = await index(doc);
    const resolver = new PositionResolver(data);
    expect(data.sections[0]?.text).toBe('слово ёж.');
    const cursor = cursorForWord(data, 0, 1);
    const cfi = resolver.toCfi(cursor, doc);
    const reformatted = xml('<p>сло<em>во</em> е<span>\u0308</span>ж.</p>');
    reformatted
      .querySelector('head')
      ?.append(reformatted.createElement('style'));
    reformatted
      .querySelector('body')
      ?.setAttribute('style', 'font-size:32px;line-height:2');
    expect(resolver.fromCfi(cfi, reformatted, 'word')).toEqual(cursor);
    expect(wordAtCursor(data, cursorAt(data, 0, 5))).toEqual(cursor);
  });
  it.each(['intl', 'fallback'] as const)(
    'NFC после удаления soft hyphen и длинное слово: %s',
    async (segmentation) => {
      const doc = xml(
        `<p>Е\u00ad\u0308лка \u1100\u1161 \u0344 ${'я'.repeat(13000)}</p>`,
      );
      const data = await index(doc, segmentation);
      const section = data.sections[0];
      if (!section) throw new Error('Missing section');
      expect(section.text).toBe(section.text.normalize('NFC'));
      expect(section.text.startsWith('Ёлка 가')).toBe(true);
      expect(
        section.tokens.filter((token) => token.kind === 'word').at(-1),
      ).toMatchObject({ end: section.text.length });
      expect(
        section.tokens.filter(
          (token) => token.kind === 'word' && token.end - token.start > 10000,
        ),
      ).toHaveLength(1);
      const resolver = new PositionResolver(data);
      const cursor = cursorForWord(data, 0, 0);
      expect(
        resolver.fromCfi(resolver.toCfi(cursor, doc), doc, 'word'),
      ).toEqual(cursor);
    },
  );
  it('сохраняет spine, пустые разделы и отдаёт управление между порциями; отмена не возвращает индекс', async () => {
    let yields = 0;
    const abort = new AbortController();
    const data = await buildDocumentTextIndex(
      { id: newId(), sha256: hash },
      [
        {
          spineIndex: 0,
          path: 'z.xhtml',
          cfiBase: '/6/2[z]',
          load: () => Promise.resolve(xml('<p>Первая.</p>')),
        },
        {
          spineIndex: 2,
          path: 'empty.xhtml',
          cfiBase: '/6/6[e]',
          load: () => Promise.resolve(xml('<nav>Меню</nav>')),
        },
        {
          spineIndex: 3,
          path: 'a.xhtml',
          cfiBase: '/6/8[a]',
          load: () =>
            Promise.resolve(xml(`<p>${'Я читаю. '.repeat(1100)}</p>`)),
        },
      ],
      abort.signal,
      () => {
        yields++;
        return Promise.resolve();
      },
    );
    expect(data.sections.map((section) => section.spineIndex)).toEqual([
      0, 2, 3,
    ]);
    expect(yields).toBeGreaterThan(5);
    const progress = new ReadingProgressService(data);
    expect(progress.relative(cursorAt(data, 3, 0))).toBeGreaterThan(0);
    expect(
      progress.relative(cursorAt(data, 3, data.sections[2]?.text.length ?? 0)),
    ).toBe(1);
    await expect(
      buildDocumentTextIndex(
        { id: newId(), sha256: hash },
        [
          {
            spineIndex: 0,
            path: 'z',
            cfiBase: '/6/2[z]',
            load: () => Promise.resolve(xml('<p>Текст</p>')),
          },
        ],
        abort.signal,
        () => {
          abort.abort();
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow();
  });
  it('отвергает другое издание, неверные смещения и повреждённый индекс; поддерживает прежний CFI', async () => {
    const doc = xml('<p>Книга.</p>');
    const data = await index(doc);
    const resolver = new PositionResolver(data);
    const cursor = cursorAt(data, 0, 0);
    const cfi = resolver.toCfi(cursor, doc);
    expect(() =>
      resolver.toRange({ ...cursor, sha256: 'b'.repeat(64) }, doc),
    ).toThrow();
    expect(() => resolver.toRange({ ...cursor, offset: 999 }, doc)).toThrow();
    expect(() => {
      validateDocumentTextIndex({ ...data, totalCharacters: 0 });
    }).toThrow();
    expect(PositionPersistenceService.restore(data, { cfi })).toEqual({ cfi });
    expect(PositionPersistenceService.restore(data, { cfi, cursor })).toEqual({
      cfi,
      cursor,
    });
    expect(
      PositionPersistenceService.restore(data, {
        cfi,
        cursor: { ...cursor, algorithmVersion: 0 },
      }),
    ).toEqual({ cfi });
    expect(() =>
      PositionPersistenceService.restore(data, {
        cfi,
        cursor: { ...cursor, sha256: 'b'.repeat(64) },
      }),
    ).toThrow();
  });
});

/** Seeded property generators: reproducible failures include seed/case, no extra dependency. */
describe.each(['intl', 'fallback'] as const)(
  'property-based: %s',
  (segmentation) => {
    it('слово ↔ DOM ↔ CFI, покрытие токенов и монотонный текстовый прогресс', async () => {
      let seed = 0x5eed123;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const words = [
        'ёлка',
        'Е\u0308лка',
        'чтение',
        'дом',
        'пример',
        'сло\u00adво',
        'abc',
        '42',
        'кошка',
        'Е\u00ad\u0308лка',
        '\u1100\u1161',
        '\u0344',
        '👩‍💻',
      ];
      const separators = [' ', '\n', ' — ', ', ', '! ', '\u00a0', '\n\t'];
      for (let trial = 0; trial < 80; trial++) {
        const doc = xml('');
        const root = doc.querySelector('body');
        if (!root) throw new Error('Missing body');
        const count = 2 + Math.floor(random() * 12);
        for (let n = 0; n < count; n++) {
          const element = doc.createElementNS(
            'http://www.w3.org/1999/xhtml',
            n % 3 === 0 ? 'em' : 'span',
          );
          element.textContent =
            (words[Math.floor(random() * words.length)] ?? '') +
            (separators[Math.floor(random() * separators.length)] ?? ' ');
          root.append(element);
        }
        const data = await index(doc, segmentation);
        const section = data.sections[0];
        if (!section) throw new Error('Missing section');
        const resolver = new PositionResolver(data);
        const progress = new ReadingProgressService(data);
        expect(section.text).toBe(section.text.normalize('NFC'));
        expect(
          section.tokens
            .map((token) => section.text.slice(token.start, token.end))
            .join(''),
          `seed=${String(seed)}, case=${String(trial)}`,
        ).toBe(section.text);
        const tokens = section.tokens.filter((token) => token.kind === 'word');
        for (let n = 0; n < tokens.length; n++) {
          const cursor = cursorForWord(data, 0, n);
          expect(
            resolver.fromCfi(resolver.toCfi(cursor, doc), doc, 'word'),
            `seed=${String(seed)}, case=${String(trial)}, word=${String(n)}`,
          ).toEqual(cursor);
        }
        let previous = 0;
        for (let offset = 0; offset <= section.text.length; offset++) {
          const value = progress.relative(cursorAt(data, 0, offset));
          expect(value).toBeGreaterThanOrEqual(previous);
          expect(value).toBeLessThanOrEqual(1);
          previous = value;
        }
        expect(
          progress.interval(
            cursorAt(data, 0, 0),
            cursorAt(data, 0, section.text.length),
          ).end,
        ).toBe(section.text.length);
      }
    });
  },
);

it('диапазоны цитат проходят CFI ↔ DOM ↔ offsets через inline и нормализацию', async () => {
  const doc = xml('<p>До <em>Ёлка — русский</em> текст. После.</p>');
  const data = await index(doc);
  const resolver = new PositionResolver(data);
  for (let start = 0; start < 12; start++) {
    for (let end = start + 1; end <= 22; end++) {
      const a = cursorAt(data, 0, start, 'word');
      const b = cursorAt(data, 0, end, 'word');
      const cfi = resolver.rangeCfi(a, b, doc);
      const range = new EpubCFI(cfi).toRange(doc);
      expect(resolver.fromRange(0, range)).toEqual(a);
      const finish = range.cloneRange();
      finish.collapse(false);
      expect(resolver.fromRange(0, finish)).toEqual(b);
      expect(range.toString()).toBe(data.sections[0]?.text.slice(start, end));
    }
  }
  expect(() => resolver.fromCfi('invalid', doc)).toThrow();
});
