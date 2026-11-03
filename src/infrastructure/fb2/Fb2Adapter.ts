import JSZip from 'jszip';
import {
  checkImportCancelled,
  EpubImportError,
  normalizeEpubText,
  type EpubAnalysis,
  type EpubSource,
} from '../../domain/epub';
import { EpubJsAdapter } from '../epub/EpubJsAdapter';
import { parseXml } from '../epub/xml';
import { rasterCover } from '../epub/raster-cover';
import { createIndexScheduler } from '../epub/text-index';

const NS = 'http://www.gribuser.ru/xml/fictionbook/2.0';
const XHTML = 'http://www.w3.org/1999/xhtml';
const XLINK = 'http://www.w3.org/1999/xlink';
export const FB2_LIMIT = 16 * 1024 * 1024;
function fail(
  message: string,
  code: 'structure' | 'unsafe' | 'limit' | 'resource' = 'structure',
): never {
  throw new EpubImportError(code, `FB2: ${message}`);
}
export async function sha256(data: ArrayBuffer): Promise<string> {
  const available = (value: unknown) => value !== undefined && value !== null;
  if (!available(crypto.subtle))
    throw new EpubImportError(
      'read',
      'Для проверки SHA-256 нужен HTTPS или localhost.',
    );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const children = (element: Element, name: string) =>
  Array.from(element.children).filter(
    (child) => child.localName === name && child.namespaceURI === NS,
  );
const child = (element: Element, name: string) => children(element, name)[0];
const text = (element: Element | undefined) =>
  normalizeEpubText(element?.textContent ?? '');
const href = (element: Element) =>
  (
    element.getAttributeNS(XLINK, 'href') ??
    element.getAttribute('href') ??
    ''
  ).trim();
function fragmentId(reference: string): string {
  if (!reference.startsWith('#') || reference.length < 2)
    fail('Ожидается внутренняя ссылка на id.', 'resource');
  try {
    return decodeURIComponent(reference.slice(1));
  } catch {
    return fail('Некорректный кодированный id в ссылке.', 'resource');
  }
}
const mapped = new Map<string, string>([
  ['section', 'section'],
  ['title', 'header'],
  ['p', 'p'],
  ['subtitle', 'h3'],
  ['epigraph', 'blockquote'],
  ['cite', 'blockquote'],
  ['poem', 'div'],
  ['stanza', 'div'],
  ['v', 'p'],
  ['text-author', 'p'],
  ['date', 'p'],
  ['annotation', 'div'],
  ['empty-line', 'div'],
  ['strong', 'strong'],
  ['emphasis', 'em'],
  ['strikethrough', 's'],
  ['sub', 'sub'],
  ['sup', 'sup'],
  ['code', 'code'],
  ['style', 'span'],
  ['a', 'a'],
  ['table', 'table'],
  ['tr', 'tr'],
  ['td', 'td'],
  ['th', 'th'],
  ['image', 'img'],
]);

function decode(bytes: Uint8Array): string {
  const sniff = new TextDecoder('ascii').decode(bytes.subarray(0, 256));
  const declared = /^\s*<\?xml\s[^>]*encoding\s*=\s*['"]([^'"]+)/i
    .exec(sniff)?.[1]
    ?.toLowerCase();
  const unicode =
    (bytes[0] === 255 && bytes[1] === 254) ||
    (bytes[0] === 60 && bytes[1] === 0)
      ? 'utf-16le'
      : (bytes[0] === 254 && bytes[1] === 255) ||
          (bytes[0] === 0 && bytes[1] === 60)
        ? 'utf-16be'
        : null;
  const encoding = unicode ?? declared ?? 'utf-8';
  if (
    ![
      'utf-8',
      'utf8',
      'utf-16',
      'utf-16le',
      'utf-16be',
      'windows-1251',
      'cp1251',
      'koi8-r',
    ].includes(encoding)
  )
    fail(
      'Неподдерживаемая кодировка XML. Используйте UTF-8, UTF-16, Windows-1251 или KOI8-R.',
    );
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return fail('Не удалось прочитать кодировку XML.');
  }
  const actualDeclaration = /^\s*<\?xml\s[^>]*encoding\s*=\s*['"]([^'"]+)/i
    .exec(decoded)?.[1]
    ?.toLowerCase();
  if (
    bytes[0] === 239 &&
    bytes[1] === 187 &&
    bytes[2] === 191 &&
    actualDeclaration &&
    !['utf-8', 'utf8'].includes(actualDeclaration)
  )
    fail('BOM UTF-8 и объявленная кодировка XML не согласованы.');
  if (
    unicode &&
    actualDeclaration &&
    actualDeclaration !== 'utf-16' &&
    actualDeclaration !== unicode
  )
    fail('BOM и объявленная кодировка XML не согласованы.');
  if (/<!DOCTYPE|<!ENTITY/i.test(decoded))
    fail(
      'DTD и объявления внешних или внутренних сущностей запрещены.',
      'unsafe',
    );
  return decoded.replace(
    /^(\s*<\?xml[^>]*encoding\s*=\s*['"])[^'"]+(['"])/i,
    '$1UTF-8$2',
  );
}

export class Fb2Adapter {
  constructor(private epub = new EpubJsAdapter()) {}
  async analyze(
    file: EpubSource,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<EpubAnalysis> {
    try {
      return await this.analyzeLocal(file, signal, progress);
    } catch (cause) {
      if (signal.aborted) checkImportCancelled(signal);
      if (cause instanceof EpubImportError) throw cause;
      throw new EpubImportError(
        'corrupt',
        'Не удалось разобрать FB2. Файл повреждён или содержит неподдерживаемую структуру.',
        { cause },
      );
    }
  }
  private async analyzeLocal(
    file: EpubSource,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<EpubAnalysis> {
    checkImportCancelled(signal);
    if (!/\.fb2$/i.test(file.name))
      fail('Выберите файл .fb2; архивы FB2.ZIP пока не поддерживаются.');
    if (!file.size || file.size > FB2_LIMIT)
      fail('Размер файла должен быть от 1 байта до 16 МБ.', 'limit');
    progress('Читаем и проверяем XML FB2…');
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (cause) {
      throw new EpubImportError('read', 'Не удалось прочитать файл FB2.', {
        cause,
      });
    }
    if (buffer.byteLength !== file.size || buffer.byteLength > FB2_LIMIT)
      fail('Размер прочитанных данных не совпадает с файлом.', 'limit');
    const original = new Blob([buffer], {
      type: 'application/x-fictionbook+xml',
    });
    const sourceHash = await sha256(buffer);
    checkImportCancelled(signal);
    const decoded = decode(new Uint8Array(buffer));
    let doc: Document;
    try {
      doc = parseXml(
        new TextEncoder().encode(decoded),
        file.name,
        32 * 1024 * 1024,
      );
    } catch (cause) {
      throw new EpubImportError(
        'structure',
        `Некорректная разметка FB2: ${cause instanceof Error ? cause.message : 'XML повреждён.'}`,
        { cause },
      );
    }
    const root = doc.documentElement;
    if (root.localName !== 'FictionBook' || root.namespaceURI !== NS)
      fail('Ожидается FictionBook в пространстве имён FictionBook 2.0.');
    const schedule = createIndexScheduler(signal);
    const ids = new Map<string, string>();
    let serial = 0;
    for (const element of Array.from(doc.getElementsByTagName('*'))) {
      if (element.namespaceURI !== NS)
        fail(
          `Посторонняя XML-разметка ${element.localName} не поддерживается.`,
          'unsafe',
        );
      if (
        Array.from(element.attributes).some((attribute) =>
          /^on/i.test(attribute.localName),
        )
      )
        fail('Активные обработчики событий запрещены.', 'unsafe');
      const id = element.getAttribute('id');
      if (id) {
        if (ids.has(id)) fail(`Повторяющийся XML id: ${id}`);
        ids.set(id, `fb2-${String(++serial)}`);
      }
      await schedule();
    }
    const description = child(root, 'description');
    const titleInfo = description && child(description, 'title-info');
    if (!description || !titleInfo) fail('Отсутствует description/title-info.');
    const title = text(child(titleInfo, 'book-title'));
    if (!title) fail('Не указано название книги.');
    const authors = children(titleInfo, 'author')
      .map(
        (author) =>
          ['first-name', 'middle-name', 'last-name']
            .map((name) => text(child(author, name)))
            .filter(Boolean)
            .join(' ') || text(child(author, 'nickname')),
      )
      .filter(Boolean);
    const annotation = child(titleInfo, 'annotation');
    const annotationText = annotation
      ? Array.from(annotation.children, (element) => text(element)).join(
          '\n\n',
        ) || text(annotation)
      : '';
    const language = text(child(titleInfo, 'lang')) || 'und';
    const warnings: string[] = [];
    if (children(root, 'stylesheet').length)
      warnings.push(
        'Стили из FB2 не исполняются; используется оформление Reedit.',
      );
    const binaries = children(root, 'binary');
    if (binaries.length > 512)
      fail('Слишком много встроенных изображений (максимум 512).', 'limit');
    const images = new Map<
      string,
      { path: string; media: string; data: Blob }
    >();
    let binaryTotal = 0;
    for (const [number, binary] of binaries.entries()) {
      const id = binary.getAttribute('id');
      const media = binary.getAttribute('content-type')?.toLowerCase() ?? '';
      if (!id) fail('У binary отсутствует id.');
      const encoded = binary.textContent.replace(/[\t\n\r ]/g, '');
      if (!encoded || encoded.length > 12 * 1024 * 1024)
        fail('Встроенное изображение пустое или превышает 8 МБ.', 'limit');
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        fail('Некорректный Base64 в binary.');
      let raw: string;
      try {
        raw = atob(encoded);
      } catch {
        return fail('Некорректный Base64 в binary.');
      }
      const bytes = new Uint8Array(raw.length);
      for (let base = 0; base < raw.length; base += 65536) {
        for (let i = base; i < Math.min(base + 65536, raw.length); i++)
          bytes[i] = raw.charCodeAt(i);
        await schedule();
      }
      binaryTotal += bytes.length;
      if (bytes.length > 8 * 1024 * 1024 || binaryTotal > FB2_LIMIT)
        fail('Превышен лимит встроенных изображений.', 'limit');
      const valid =
        media === 'image/png'
          ? [137, 80, 78, 71, 13, 10, 26, 10].every(
              (value, i) => bytes[i] === value,
            )
          : media === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : media === 'image/webp' &&
              new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
              new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
      if (!valid)
        fail(
          'Встроенные изображения должны быть корректными PNG, JPEG или WebP; SVG и другие типы не поддерживаются.',
          'resource',
        );
      images.set(id, {
        path: `image-${String(number)}.${media === 'image/png' ? 'png' : media === 'image/jpeg' ? 'jpg' : 'webp'}`,
        media,
        data: rasterCover(bytes, media),
      });
      await schedule(true);
    }
    const imageFor = (element: Element) => {
      const reference = href(element);
      if (!reference.startsWith('#') || reference.length < 2)
        return fail(
          'Изображение должно ссылаться на встроенный binary.',
          'unsafe',
        );
      const image = images.get(fragmentId(reference));
      if (!image)
        return fail(
          `Не найдено встроенное изображение ${reference}.`,
          'resource',
        );
      return image;
    };
    const coverElement = child(titleInfo, 'coverpage');
    const coverImage = coverElement && child(coverElement, 'image');
    const cover = coverImage ? imageFor(coverImage) : null;
    const bodies = children(root, 'body');
    if (!bodies.length) fail('Отсутствует body с текстом книги.');
    const checkStructuralText = (element: Element) => {
      if (
        Array.from(element.childNodes).some(
          (node) =>
            (node.nodeType === 3 || node.nodeType === 4) &&
            (node.textContent ?? '').trim(),
        )
      )
        fail(`Текст вне допустимого абзаца в ${element.localName}.`);
    };
    checkStructuralText(root);
    if (
      Array.from(root.children).some(
        (element) =>
          !['stylesheet', 'description', 'body', 'binary'].includes(
            element.localName,
          ),
      )
    )
      fail('Неподдерживаемый элемент верхнего уровня FictionBook.');
    const units: {
      body: Element;
      nodes: Element[];
      path: string;
      label: string;
    }[] = [];
    for (const [bodyNumber, body] of bodies.entries()) {
      checkStructuralText(body);
      const sections = children(body, 'section');
      if (!sections.length) fail('Каждый body должен содержать section.');
      const prefix: Element[] = [];
      let foundSection = false;
      for (const element of Array.from(body.children)) {
        if (element.localName === 'section') {
          foundSection = true;
          units.push({
            body,
            nodes: [element],
            path: `part-${String(units.length)}.xhtml`,
            label:
              text(child(element, 'title')) ||
              `Раздел ${String(units.length + 1)}`,
          });
        } else {
          if (
            foundSection ||
            !['image', 'title', 'epigraph'].includes(element.localName)
          )
            fail(`Некорректный элемент ${element.localName} в body.`);
          prefix.push(element);
        }
      }
      if (prefix.length) {
        const insertAt = units.length - sections.length;
        units.splice(insertAt, 0, {
          body,
          nodes: prefix,
          path: `prefix-${String(bodyNumber)}.xhtml`,
          label:
            text(child(body, 'title')) || `Часть ${String(bodyNumber + 1)}`,
        });
      }
    }
    if (units.length > 1024)
      fail('Слишком много частей FB2 (максимум 1024).', 'limit');
    const locations = new Map<string, string>();
    const sectionIds = new WeakMap<Element, string>();
    const sectionLocations = new WeakMap<Element, string>();
    const bodyFirst = new Map<Element, string>();
    for (const unit of units) {
      bodyFirst.set(unit.body, bodyFirst.get(unit.body) ?? unit.path);
      for (const node of unit.nodes)
        for (const element of [
          node,
          ...Array.from(node.getElementsByTagName('*')),
        ]) {
          const id = element.getAttribute('id');
          if (id) locations.set(id, `${unit.path}#${ids.get(id) ?? ''}`);
          if (element.localName === 'section') {
            const generated = id
              ? (ids.get(id) ?? '')
              : `fb2-section-${String(++serial)}`;
            sectionIds.set(element, generated);
            sectionLocations.set(element, `${unit.path}#${generated}`);
          }
        }
    }
    for (const [body, first] of bodyFirst) {
      const id = body.getAttribute('id');
      if (id) locations.set(id, `${first}#${ids.get(id) ?? ''}`);
    }
    const convert = async (
      source: Node,
      target: Node,
      output: Document,
      heading = false,
    ): Promise<void> => {
      if (source.nodeType === 3 || source.nodeType === 4) {
        target.appendChild(output.createTextNode(source.textContent ?? ''));
        return;
      }
      if (source.nodeType !== 1) return;
      const element = source as Element;
      const name = mapped.get(element.localName);
      if (!name)
        fail(
          `Неподдерживаемый элемент содержимого ${element.localName}; текст не будет пропущен.`,
        );
      if (
        [
          'section',
          'title',
          'poem',
          'stanza',
          'epigraph',
          'cite',
          'annotation',
          'table',
          'tr',
        ].includes(element.localName)
      )
        checkStructuralText(element);
      if (
        ['image', 'empty-line'].includes(element.localName) &&
        (element.children.length || element.textContent.trim())
      )
        fail(`Элемент ${element.localName} должен быть пустым.`);
      let tag = heading && element.localName === 'p' ? 'h2' : name;
      let link = '';
      if (element.localName === 'a') {
        const reference = href(element);
        if (reference.startsWith('#')) {
          link = locations.get(fragmentId(reference)) ?? '';
          if (!link)
            fail(`Не найдена внутренняя ссылка ${reference}.`, 'resource');
        } else if (/^(https?:|mailto:)/i.test(reference)) {
          tag = 'span';
          if (
            !warnings.includes(
              'Внешние ссылки оставлены как текст и не открываются.',
            )
          )
            warnings.push(
              'Внешние ссылки оставлены как текст и не открываются.',
            );
        } else if (reference) fail('Небезопасная ссылка в FB2.', 'unsafe');
        else tag = 'span';
      }
      const result = output.createElementNS(XHTML, tag);
      result.setAttribute('class', `fb2-${element.localName}`);
      const id = element.getAttribute('id');
      if (id) result.setAttribute('id', ids.get(id) ?? '');
      else {
        const generated = sectionIds.get(element);
        if (generated) result.setAttribute('id', generated);
      }
      const lang = element.getAttributeNS(
        'http://www.w3.org/XML/1998/namespace',
        'lang',
      );
      if (lang) result.setAttribute('lang', lang);
      if (link) result.setAttribute('href', link);
      if (element.localName === 'image') {
        result.setAttribute('src', imageFor(element).path);
        result.setAttribute(
          'alt',
          element.getAttribute('alt') ?? 'Иллюстрация книги',
        );
      } else {
        for (const attribute of ['colspan', 'rowspan']) {
          const value = element.getAttribute(attribute);
          if (value) {
            if (!/^\d{1,2}$/.test(value) || Number(value) < 1)
              fail('Некорректный размер ячейки таблицы.');
            result.setAttribute(attribute, value);
          }
        }
        for (const node of Array.from(source.childNodes))
          await convert(node, result, output, element.localName === 'title');
      }
      target.appendChild(result);
      await schedule();
    };
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file(
      'META-INF/container.xml',
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    zip.file(
      'EPUB/book.css',
      'p{margin:0 0 .8em}.fb2-stanza{margin-block:1em}.fb2-stanza p{margin:0}.fb2-empty-line{min-height:1em}.fb2-subtitle,.fb2-title{font-weight:bold}img{max-width:100%;height:auto}',
    );
    for (const unit of units) {
      progress(
        `Готовим часть ${String(units.indexOf(unit) + 1)} из ${String(units.length)}…`,
      );
      const output = new DOMParser().parseFromString(
        `<html xmlns="${XHTML}"><head><title>${escapeXml(unit.label)}</title><link rel="stylesheet" href="book.css"/></head><body/></html>`,
        'application/xhtml+xml',
      );
      const body = output.getElementsByTagNameNS(XHTML, 'body')[0];
      if (!body) fail('Не удалось подготовить документ.');
      output.documentElement.setAttribute('lang', language);
      const bodyLanguage = unit.body.getAttributeNS(
        'http://www.w3.org/XML/1998/namespace',
        'lang',
      );
      if (bodyLanguage) body.setAttribute('lang', bodyLanguage);
      const bodyId = unit.body.getAttribute('id');
      if (bodyId && bodyFirst.get(unit.body) === unit.path)
        body.setAttribute('id', ids.get(bodyId) ?? '');
      for (const node of unit.nodes) await convert(node, body, output);
      const content = new XMLSerializer().serializeToString(output);
      if (new TextEncoder().encode(content).length > 4 * 1024 * 1024)
        fail('Одна часть FB2 превышает лимит XHTML 4 МБ.', 'limit');
      zip.file(`EPUB/${unit.path}`, content);
      await schedule(true);
    }
    const navigation = (element: Element): string => {
      const destination = sectionLocations.get(element);
      const title = text(child(element, 'title'));
      return destination && title
        ? `<li><a href="${escapeXml(destination)}">${escapeXml(title)}</a>${children(element, 'section').length ? `<ol>${children(element, 'section').map(navigation).join('')}</ol>` : ''}</li>`
        : children(element, 'section').map(navigation).join('');
    };
    zip.file(
      'EPUB/nav.xhtml',
      `<html xmlns="${XHTML}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Оглавление</title></head><body><nav epub:type="toc"><ol>${units
        .map(
          (unit) =>
            `<li><a href="${unit.path}">${escapeXml(unit.label)}</a>${
              unit.nodes.flatMap((element) => children(element, 'section'))
                .length
                ? `<ol>${unit.nodes
                    .flatMap((element) => children(element, 'section'))
                    .map(navigation)
                    .join('')}</ol>`
                : ''
            }</li>`,
        )
        .join('')}</ol></nav></body></html>`,
    );
    for (const image of images.values())
      zip.file(`EPUB/${image.path}`, await image.data.arrayBuffer());
    zip.file(
      'EPUB/package.opf',
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:sha256:${sourceHash}</dc:identifier><dc:title>${escapeXml(title)}</dc:title>${authors.map((author) => `<dc:creator>${escapeXml(author)}</dc:creator>`).join('')}<dc:language>${escapeXml(language)}</dc:language><dc:description>${escapeXml(annotationText)}</dc:description><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata><manifest>${units.map((unit, i) => `<item id="part${String(i)}" href="${unit.path}" media-type="application/xhtml+xml"/>`).join('')}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="book.css" media-type="text/css"/>${Array.from(images.values(), (image, i) => `<item id="image${String(i)}" href="${image.path}" media-type="${image.media}"${image === cover ? ' properties="cover-image"' : ''}/>`).join('')}</manifest><spine>${units.map((_, i) => `<itemref idref="part${String(i)}"/>`).join('')}</spine></package>`,
    );
    // Fixed timestamps make this version's derived representation reproducible.
    zip.forEach((_, entry) => {
      entry.date = new Date('2020-01-01T00:00:00.000Z');
    });
    checkImportCancelled(signal);
    const bytes = await zip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    checkImportCancelled(signal);
    progress('Проверяем производный EPUB существующим адаптером…');
    const checked = await this.epub.analyze(
      {
        name: 'converted.epub',
        size: bytes.byteLength,
        type: 'application/epub+zip',
        arrayBuffer: () => Promise.resolve(bytes),
      },
      signal,
      progress,
    );
    return {
      ...checked,
      sha256: sourceHash,
      original,
      sourceFormat: 'fb2',
      representation: {
        format: 'epub',
        converterVersion: 1,
        sourceSha256: sourceHash,
        sha256: checked.sha256,
        data: checked.original,
      },
      warnings: [...warnings, ...checked.warnings],
    };
  }
}
