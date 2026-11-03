// @vitest-environment jsdom
import { expect, it, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import { EpubJsAdapter } from '../src/infrastructure/epub/EpubJsAdapter';
import { makeEpubFixture, type FixtureOptions } from './fixtures/epub';
import { normalizeEpubText, EpubImportError } from '../src/domain/epub';
import JSZip from 'jszip';

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
async function analyze(options: FixtureOptions = {}) {
  const fixture = await makeEpubFixture(options);
  const file = new NodeFile([fixture.bytes], 'synthetic.epub', {
    type: 'application/epub+zip',
  });
  const result = await new EpubJsAdapter().analyze(
    file,
    new AbortController().signal,
    () => undefined,
  );
  return { fixture, result };
}
it.each(['2', '3'] as const)(
  'EPUB %s: одна глава, метаданные и исходные байты без изменений',
  async (version) => {
    const { fixture, result } = await analyze({ version });
    expect(result.sections.map((section) => section.text)).toEqual(
      fixture.expected,
    );
    expect(result.sections.map((section) => section.path)).toEqual(
      fixture.linearPaths,
    );
    expect(result.metadata.authors).toEqual([
      'Автор тестовой фикстуры',
      'Второй автор',
    ]);
    expect(result.metadata.language).toBe('ru');
    expect(new Uint8Array(await result.original.arrayBuffer())).toEqual(
      fixture.bytes,
    );
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  },
);
it('глава из нескольких XHTML: неполное оглавление и ZIP не меняют полный spine', async () => {
  const { fixture, result } = await analyze({
    chapters: [
      { name: 'z.xhtml', text: 'Первая часть главы.' },
      { name: 'a.xhtml', text: 'Продолжение главы.' },
      { name: 'm.xhtml', text: 'Конец главы.' },
    ],
    toc: [0],
  });
  expect(result.navigation).toHaveLength(1);
  expect(result.sections).toHaveLength(3);
  expect(result.sections.map((section) => section.path)).toEqual(
    fixture.linearPaths,
  );
  expect(
    normalizeEpubText(result.sections.map((section) => section.text).join(' ')),
  ).toBe(fixture.expected.join(' '));
});
it('части с обратным оглавлением и явно нелинейным ресурсом', async () => {
  const { fixture, result } = await analyze({
    chapters: [
      { name: 'one.xhtml', text: 'Один' },
      { name: 'note.xhtml', text: 'Примечания', linear: false },
      { name: 'two.xhtml', text: 'Два' },
      { name: 'three.xhtml', text: 'Три' },
    ],
    toc: [3, 0],
  });
  expect(result.spine).toHaveLength(4);
  expect(result.sections).toHaveLength(3);
  expect(result.sections.map((section) => section.text)).toEqual(
    fixture.expected,
  );
  expect(result.sections.map((section) => section.spineIndex)).toEqual([
    0, 2, 3,
  ]);
});
it('длинный русский текст и inline-разметка не теряют и не разрывают слова', async () => {
  const sentence =
    'Слово и мир. Длинный русский текст: ёж, тире — и «кавычки». ';
  const text = sentence.repeat(4000).trim();
  const { fixture, result } = await analyze({
    chapters: [
      {
        name: 'long.xhtml',
        text,
        markup: `<p>Сло<em>во</em> и мир. Длинный русский текст: ёж, тире — и «кавычки». ${text.slice(sentence.length)}</p>`,
      },
    ],
  });
  expect(result.sections[0]?.text).toBe(fixture.expected[0]);
});
it('иллюстрация и встроенная обложка остаются в оригинале', async () => {
  const { fixture, result } = await analyze({ cover: true });
  expect(result.cover?.type).toBe('image/png');
  expect(result.cover?.size).toBeGreaterThan(0);
  expect(result.sections.map((section) => section.text)).toEqual(
    fixture.expected,
  );
  expect(result.manifest.some((item) => item.path === 'EPUB/cover.png')).toBe(
    true,
  );
});
it.each([
  { missingChapter: 0 },
  { brokenLink: true },
  { drm: true },
  { unsafeMarkup: '<script>globalThis.pwned=true</script>' },
  { unsafeMarkup: '<img src="cover.png" onerror="alert(1)"/>' },
  { unsafeMarkup: '<a href="java&#x73;cript:alert(1)">ссылка</a>' },
  { unsafeMarkup: '<iframe src="https://example.com"/>' },
  {
    extraFiles: {
      'EPUB/unused.xhtml':
        '<html><body><script>alert(1)</script></body></html>',
    },
  },
])('отклоняет повреждённые/небезопасные EPUB: %j', async (options) => {
  await expect(analyze(options)).rejects.toBeInstanceOf(EpubImportError);
});
it('неверный CRC и обрезанный ZIP дают явную ошибку', async () => {
  const fixture = await makeEpubFixture();
  for (const bytes of [
    fixture.bytes.slice(0, -20),
    (() => {
      const value = fixture.bytes.slice();
      const view = new DataView(value.buffer);
      for (let offset = 0; offset < value.length - 46; offset++) {
        if (view.getUint32(offset, true) === 0x02014b50) {
          const length = view.getUint16(offset + 28, true);
          if (
            new TextDecoder().decode(
              value.subarray(offset + 46, offset + 46 + length),
            ) === 'EPUB/part.xhtml'
          ) {
            const local = view.getUint32(offset + 42, true);
            const crc = view.getUint32(offset + 16, true) ^ 1;
            view.setUint32(offset + 16, crc, true);
            view.setUint32(local + 14, crc, true);
            break;
          }
        }
      }
      return value;
    })(),
  ])
    await expect(
      new EpubJsAdapter().analyze(
        new NodeFile([bytes], 'broken.epub'),
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(EpubImportError);
});
it('не загружает внешние ресурсы, блокирует CSS/SMIL и XML-сущности', async () => {
  for (const markup of [
    '<img src="https://example.com/tracker.png"/>',
    '<p style="background:url(https://example.com/a)">Текст</p>',
    '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onload" to="alert(1)"/></svg>',
  ])
    await expect(analyze({ unsafeMarkup: markup })).rejects.toMatchObject({
      code: 'unsafe',
    });
  await expect(
    analyze({
      extraFiles: {
        'EPUB/entities.xml':
          '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>',
      },
    }),
  ).rejects.toMatchObject({ code: 'unsafe' });
});
it('отсутствующий фрагмент и выход пути за пределы контейнера не игнорируются', async () => {
  await expect(
    analyze({ unsafeMarkup: '<a href="part.xhtml#missing">Ссылка</a>' }),
  ).rejects.toMatchObject({ code: 'resource' });
  await expect(
    analyze({ unsafeMarkup: '<img src="../../outside.png"/>' }),
  ).rejects.toMatchObject({ code: 'unsafe' });
});
it('проверяет размер до чтения и не теряет неподдерживаемый линейный ресурс молча', async () => {
  const source = {
    name: 'large.epub',
    type: '',
    size: 33 * 1024 * 1024,
    arrayBuffer: () => {
      throw new Error('Must not read');
    },
  };
  await expect(
    new EpubJsAdapter().analyze(
      source,
      new AbortController().signal,
      () => undefined,
    ),
  ).rejects.toMatchObject({ code: 'limit' });
  const fixture = await makeEpubFixture();
  const zip = await JSZip.loadAsync(fixture.bytes);
  const opf = await zip.file('EPUB/package.opf')?.async('string');
  if (!opf) throw new Error('Missing OPF');
  zip.file(
    'EPUB/package.opf',
    opf.replace(
      'media-type="application/xhtml+xml"',
      'media-type="application/pdf"',
    ),
  );
  await expect(
    new EpubJsAdapter().analyze(
      new NodeFile(
        [await zip.generateAsync({ type: 'uint8array' })],
        'unsupported.epub',
      ),
      new AbortController().signal,
      () => undefined,
    ),
  ).rejects.toMatchObject({ code: 'format' });
});
it('дубликат manifest id отклоняется явно', async () => {
  const fixture = await makeEpubFixture();
  const zip = await JSZip.loadAsync(fixture.bytes);
  const opf = await zip.file('EPUB/package.opf')?.async('string');
  if (!opf) throw new Error('Missing OPF');
  zip.file(
    'EPUB/package.opf',
    opf.replace(
      '</manifest>',
      '<item id="part0" href="part.xhtml" media-type="application/xhtml+xml"/></manifest>',
    ),
  );
  await expect(
    new EpubJsAdapter().analyze(
      new NodeFile(
        [await zip.generateAsync({ type: 'uint8array' })],
        'bad.epub',
      ),
      new AbortController().signal,
      () => undefined,
    ),
  ).rejects.toBeInstanceOf(EpubImportError);
});
it('поддерживает отмену во время распаковки без частичного индекса', async () => {
  const fixture = await makeEpubFixture();
  const controller = new AbortController();
  await expect(
    new EpubJsAdapter().analyze(
      new NodeFile([fixture.bytes], 'cancel.epub'),
      controller.signal,
      (message) => {
        if (message.startsWith('Проверяем ресурсы')) controller.abort();
      },
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
});
