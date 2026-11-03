import JSZip from 'jszip';
/** Synthetic original text/ZIP fixtures, CC0-1.0. Never user library data. */
export interface FixtureChapter {
  name: string;
  text: string;
  markup?: string;
  linear?: boolean;
}
export interface FixtureOptions {
  version?: '2' | '3';
  chapters?: FixtureChapter[];
  toc?: number[];
  cover?: boolean;
  missingChapter?: number;
  brokenLink?: boolean;
  unsafeMarkup?: string;
  drm?: boolean;
  extraFiles?: Record<string, string>;
  title?: string;
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export async function makeEpubFixture(options: FixtureOptions = {}) {
  const version = options.version ?? '3';
  const chapters = options.chapters ?? [
    {
      name: 'part.xhtml',
      text: 'Это синтетическая тестовая книга. Весь её текст должен сохраниться.',
    },
  ];
  const toc = options.toc ?? chapters.map((_, index) => index);
  const title = options.title ?? 'Синтетическая книга EPUB';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const nav = version === '3' ? 'nav.xhtml' : 'toc.ncx';
  zip.file(
    'EPUB/package.opf',
    `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:synthetic-cc0</dc:identifier><dc:title>${xml(title)}</dc:title><dc:creator>Автор тестовой фикстуры</dc:creator><dc:creator>Второй автор</dc:creator><dc:language>ru</dc:language><dc:description>Синтетический текст CC0</dc:description>${version === '2' && options.cover ? '<meta name="cover" content="cover"/>' : ''}</metadata><manifest>${chapters.map((chapter, index) => `<item id="part${String(index)}" href="${xml(chapter.name)}" media-type="application/xhtml+xml"/>`).join('')}<item id="navigation" href="${nav}" media-type="${version === '3' ? 'application/xhtml+xml' : 'application/x-dtbncx+xml'}" ${version === '3' ? 'properties="nav"' : ''}/>${options.cover ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>' : ''}</manifest><spine ${version === '2' ? 'toc="navigation"' : ''}>${chapters.map((chapter, index) => `<itemref idref="part${String(index)}"${chapter.linear === false ? ' linear="no"' : ''}/>`).join('')}</spine></package>`,
  );
  for (const [index, chapter] of [...chapters.entries()].reverse())
    if (options.missingChapter !== index)
      zip.file(
        `EPUB/${chapter.name}`,
        `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ресурс ${String(index)}</title></head><body>${chapter.markup ?? `<p>${xml(chapter.text)}</p>`}${index === 0 && options.cover ? '<img src="cover.png" alt="Иллюстрация"/>' : ''}${index === 0 && options.brokenLink ? '<a href="missing.xhtml">Потерянная ссылка</a>' : ''}${index === 0 ? (options.unsafeMarkup ?? '') : ''}</body></html>`,
      );
  if (version === '3')
    zip.file(
      `EPUB/${nav}`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Оглавление</title></head><body><nav epub:type="toc"><ol>${toc.map((index) => `<li><a href="${xml(chapters[index]?.name ?? 'missing.xhtml')}">Раздел ${String(index + 1)}</a></li>`).join('')}</ol></nav></body></html>`,
    );
  else
    zip.file(
      `EPUB/${nav}`,
      `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>${xml(title)}</text></docTitle><navMap>${toc.map((index) => `<navPoint id="n${String(index)}" playOrder="${String(index + 1)}"><navLabel><text>Раздел ${String(index + 1)}</text></navLabel><content src="${xml(chapters[index]?.name ?? 'missing.xhtml')}"/></navPoint>`).join('')}</navMap></ncx>`,
    );
  if (options.cover)
    zip.file(
      'EPUB/cover.png',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
      { base64: true },
    );
  if (options.drm)
    zip.file(
      'META-INF/encryption.xml',
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"/></encryption>',
    );
  for (const [path, value] of Object.entries(options.extraFiles ?? {}))
    zip.file(path, value);
  zip.forEach((_path, entry) => {
    entry.date = new Date('2020-01-01T00:00:00.000Z');
  });
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return {
    bytes,
    expected: chapters
      .filter((chapter) => chapter.linear !== false)
      .map((chapter) =>
        chapter.text.normalize('NFC').replace(/\s+/gu, ' ').trim(),
      ),
    linearPaths: chapters
      .filter((chapter) => chapter.linear !== false)
      .map((chapter) => `EPUB/${chapter.name}`),
  };
}
