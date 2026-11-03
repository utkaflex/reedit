import Packaging from 'epubjs/lib/packaging.js';
import Navigation from 'epubjs/lib/navigation.js';
import type { NavItem } from 'epubjs/types/navigation';
import {
  checkImportCancelled,
  EpubImportError,
  epubWordCount,
  type EpubAdapter,
  type EpubAnalysis,
  type EpubNavItem,
  type EpubSource,
  type EpubTextResource,
} from '../../domain/epub';
import { EPUB_LIMITS, readZip } from './zip';
import {
  checkCss,
  checkDocument,
  elements,
  extractText,
  parseXml,
  resolveReference,
  type ResourceLink,
} from './xml';
import { rasterCover } from './raster-cover';

export class EpubJsAdapter implements EpubAdapter {
  async openReader(options: import('../../domain/reader').ReaderOpenOptions) {
    const { openEpubReader } = await import('./reader');
    return openEpubReader(options, this.analyze.bind(this));
  }
  async analyze(
    file: EpubSource,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<EpubAnalysis> {
    try {
      return await this.analyzeLocal(file, signal, progress);
    } catch (error) {
      if (error instanceof EpubImportError) throw error;
      if (signal.aborted) checkImportCancelled(signal);
      throw new EpubImportError(
        'corrupt',
        'Не удалось разобрать EPUB. Возможно, файл повреждён или использует неподдерживаемую структуру.',
        { cause: error },
      );
    }
  }
  private async analyzeLocal(
    file: EpubSource,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<EpubAnalysis> {
    checkImportCancelled(signal);
    // OS-provided File.type is advisory; the ZIP's exact mimetype is authoritative.
    if (!/\.epub$/i.test(file.name))
      throw new EpubImportError(
        'format',
        'Выберите файл с расширением .epub. PDF и другие форматы не поддерживаются.',
      );
    if (file.size === 0 || file.size > EPUB_LIMITS.compressed)
      throw new EpubImportError(
        'limit',
        'Размер EPUB должен быть от 1 байта до 32 МБ.',
      );
    progress('Читаем локальный файл…');
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (error) {
      throw new EpubImportError(
        'read',
        'Не удалось прочитать файл. Попробуйте выбрать его повторно.',
        { cause: error },
      );
    }
    if (
      buffer.byteLength !== file.size ||
      buffer.byteLength > EPUB_LIMITS.compressed
    )
      throw new EpubImportError(
        'read',
        'Размер прочитанных данных не совпадает с выбранным файлом. Выберите EPUB повторно.',
      );
    checkImportCancelled(signal);
    progress('Вычисляем SHA-256…');
    const available = (value: unknown) => value !== undefined && value !== null;
    if (!available(crypto.subtle))
      throw new EpubImportError(
        'read',
        'Для SHA-256 нужен защищённый контекст: HTTPS или localhost.',
      );
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    const sha256 = Array.from(hash, (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    const resources = await readZip(buffer, signal, progress);
    checkImportCancelled(signal);
    if (
      [
        'META-INF/encryption.xml',
        'META-INF/rights.xml',
        'META-INF/license.lcpl',
      ].some((path) => resources.has(path))
    )
      throw new EpubImportError(
        'drm',
        'DRM, шифрование ресурсов и обфускация шрифтов пока не поддерживаются. Нужен EPUB без защиты.',
      );
    const required = (path: string): Uint8Array<ArrayBuffer> => {
      const bytes = resources.get(path);
      if (!bytes)
        throw new EpubImportError(
          'resource',
          `В EPUB отсутствует обязательный ресурс: ${path}.`,
        );
      return bytes;
    };
    const container = parseXml(
      required('META-INF/container.xml'),
      'META-INF/container.xml',
    );
    const roots = elements(container, 'rootfile');
    if (
      roots.length !== 1 ||
      roots[0]?.getAttribute('media-type') !== 'application/oebps-package+xml'
    )
      throw new EpubImportError(
        'structure',
        'Нужен EPUB с одним корректным OPF rootfile. Несколько редакций в одном контейнере пока не поддерживаются.',
      );
    const packagePath = resolveReference(
      'container.xml',
      roots[0].getAttribute('full-path') ?? '',
    ).path;
    const opf = parseXml(required(packagePath), packagePath);
    if (
      opf.documentElement.localName !== 'package' ||
      opf.documentElement.namespaceURI !== 'http://www.idpf.org/2007/opf'
    )
      throw new EpubImportError('structure', 'Не найден корректный пакет OPF.');
    const version = opf.documentElement.getAttribute('version') ?? '';
    if (!/^[23](?:\.|$)/.test(version))
      throw new EpubImportError('format', 'Поддерживаются EPUB 2 и EPUB 3.');
    const manifestNodes = elements(opf, 'manifest');
    const spineNodes = elements(opf, 'spine');
    if (
      manifestNodes.length !== 1 ||
      spineNodes.length !== 1 ||
      elements(opf, 'metadata').length !== 1
    )
      throw new EpubImportError(
        'structure',
        'OPF должен содержать metadata, manifest и spine.',
      );
    const rawItems = Array.from(manifestNodes[0]?.children ?? []);
    const itemRefs = Array.from(spineNodes[0]?.children ?? []);
    const ids = new Set<string>();
    const paths = new Set<string>();
    const links: ResourceLink[] = [];
    checkDocument(opf, packagePath, []);
    for (const item of rawItems) {
      const id = item.getAttribute('id') ?? '';
      const href = item.getAttribute('href') ?? '';
      if (
        item.localName !== 'item' ||
        !id ||
        ids.has(id) ||
        ['__proto__', 'prototype', 'constructor'].includes(id) ||
        !href ||
        !item.getAttribute('media-type')
      )
        throw new EpubImportError(
          'structure',
          'Некорректный или повторяющийся элемент manifest.',
        );
      const target = resolveReference(packagePath, href);
      required(target.path);
      if (target.fragment || paths.has(target.path))
        throw new EpubImportError(
          'structure',
          'Manifest содержит повторяющийся путь или фрагмент вместо ресурса.',
        );
      ids.add(id);
      paths.add(target.path);
      if (
        (item.getAttribute('properties') ?? '')
          .split(/\s+/)
          .includes('scripted') ||
        /(?:javascript|ecmascript)/i.test(item.getAttribute('media-type') ?? '')
      )
        throw new EpubImportError(
          'unsafe',
          'EPUB с активными скриптами не импортируется.',
        );
    }
    for (const item of itemRefs)
      if (
        item.localName !== 'itemref' ||
        !ids.has(item.getAttribute('idref') ?? '') ||
        !['yes', 'no'].includes(item.getAttribute('linear') ?? 'yes')
      )
        throw new EpubImportError(
          'structure',
          'Spine ссылается на отсутствующий manifest id или содержит некорректный linear.',
        );
    // epub.js is the OPF and navigation parser; the checks above enforce import policy, not a second parser.
    const packaging = new Packaging(opf);
    try {
      const manifest = Object.entries(packaging.manifest).map(([id, item]) => ({
        id,
        path: resolveReference(packagePath, item.href).path,
        mediaType: item.type,
        properties: [...item.properties],
      }));
      const spine = packaging.spine.map((item, index) => {
        if (item.idref !== itemRefs[index]?.getAttribute('idref'))
          throw new EpubImportError(
            'structure',
            'Парсер изменил порядок ресурсов spine.',
          );
        const resource = manifest.find((entry) => entry.id === item.idref);
        if (!resource)
          throw new EpubImportError(
            'structure',
            'epub.js не смог сопоставить spine с manifest.',
          );
        return {
          idref: item.idref,
          path: resource.path,
          linear: itemRefs[index].getAttribute('linear') !== 'no',
        };
      });
      if (
        spine.length !== itemRefs.length ||
        !spine.some((item) => item.linear) ||
        manifest.length !== rawItems.length
      )
        throw new EpubImportError(
          'structure',
          'Парсер не сохранил полный manifest/spine или линейный spine пуст.',
        );
      const documents = new Map<string, XMLDocument>();
      progress('Проверяем XHTML, изображения и ссылки…');
      for (const [path, bytes] of resources) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        checkImportCancelled(signal);
        const media =
          manifest.find((item) => item.path === path)?.mediaType ?? '';
        if (/\.(?:js|mjs|cjs)$/i.test(path))
          throw new EpubImportError(
            'unsafe',
            `В EPUB найден файл скрипта: ${path}.`,
          );
        if (
          /\.(?:xhtml|html|htm|svg|xml|opf|ncx)$/i.test(path) ||
          /(?:xml|html|svg)/i.test(media)
        ) {
          const doc = parseXml(bytes, path);
          checkDocument(doc, path, links);
          documents.set(path, doc);
        } else if (/\.css$/i.test(path) || media === 'text/css')
          checkCss(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            path,
            links,
          );
      }
      // OPF/container URI attributes have their own bases and are already checked separately.
      const contentLinks = links.filter(
        (link) =>
          link.from !== packagePath && link.from !== 'META-INF/container.xml',
      );
      for (const link of contentLinks) {
        required(link.path);
        if (!paths.has(link.path))
          throw new EpubImportError(
            'resource',
            `Ресурс ${link.path} из ${link.from} не включён в manifest.`,
          );
        if (link.fragment) {
          const target = documents.get(link.path);
          if (
            target &&
            !Array.from(target.getElementsByTagName('*')).some(
              (node) =>
                node.getAttribute('id') === link.fragment ||
                node.getAttribute('name') === link.fragment,
            )
          )
            throw new EpubImportError(
              'resource',
              `Не найден фрагмент #${link.fragment} в ${link.path}.`,
            );
        }
      }
      const navPath = packaging.navPath || packaging.ncxPath;
      if (!navPath)
        throw new EpubImportError(
          'structure',
          'В EPUB отсутствует navigation (EPUB 3) или NCX (EPUB 2).',
        );
      const resolvedNav = resolveReference(packagePath, navPath).path;
      const navDocument = documents.get(resolvedNav);
      if (!navDocument)
        throw new EpubImportError(
          'resource',
          `Не удалось прочитать навигацию ${resolvedNav}.`,
        );
      const parsedNavigation = new Navigation(navDocument);
      const convertNav = (items: NavItem[]): EpubNavItem[] =>
        items.map((item) => ({
          label: item.label.trim(),
          ...resolveReference(resolvedNav, item.href),
          children: convertNav(item.subitems ?? []),
        }));
      const navigation = convertNav(parsedNavigation.toc);
      let characters = 0;
      const sections: EpubTextResource[] = [];
      for (const [index, item] of spine.entries()) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        checkImportCancelled(signal);
        if (!item.linear) continue;
        const media = manifest.find(
          (entry) => entry.id === item.idref,
        )?.mediaType;
        if (media !== 'application/xhtml+xml' && media !== 'image/svg+xml')
          throw new EpubImportError(
            'format',
            `Линейный ресурс ${item.path} имеет неподдерживаемый тип ${media ?? 'неизвестный'}. Он не будет молча пропущен.`,
          );
        const doc = documents.get(item.path);
        if (
          !doc ||
          (media === 'application/xhtml+xml' && !elements(doc, 'body').length)
        )
          throw new EpubImportError(
            'structure',
            `Не найден текстовый документ/body линейного ресурса ${item.path}.`,
          );
        const text = extractText(doc);
        characters += text.length;
        if (characters > EPUB_LIMITS.textCharacters)
          throw new EpubImportError(
            'limit',
            'Текстовый индекс превышает лимит 16 миллионов символов.',
          );
        sections.push({
          path: item.path,
          spineIndex: index,
          text,
          wordCount: epubWordCount(text),
        });
      }
      const metadata = {
        title: packaging.metadata.title.trim(),
        authors: elements(
          elements(opf, 'metadata')[0] ?? opf.documentElement,
          'creator',
        )
          .map((node) => node.textContent.trim())
          .filter(Boolean),
        language: packaging.metadata.language.trim(),
        description: packaging.metadata.description.trim(),
        identifier: packaging.metadata.identifier.trim(),
      };
      if (
        !metadata.title ||
        metadata.title.length > 500 ||
        metadata.authors.join('; ').length > 2000 ||
        metadata.description.length > 30000 ||
        metadata.language.length > 128
      )
        throw new EpubImportError(
          'structure',
          'Название отсутствует или метаданные EPUB слишком велики.',
        );
      const warnings: string[] = [];
      let cover: Blob | null = null;
      if (packaging.coverPath) {
        const path = resolveReference(packagePath, packaging.coverPath).path;
        const bytes = required(path);
        const media =
          manifest.find((item) => item.path === path)?.mediaType ?? '';
        if (['image/png', 'image/jpeg', 'image/webp'].includes(media)) {
          const valid =
            media === 'image/png'
              ? bytes[0] === 137 &&
                bytes[1] === 80 &&
                bytes[2] === 78 &&
                bytes[3] === 71
              : media === 'image/jpeg'
                ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                : new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
                  new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
          if (!valid)
            throw new EpubImportError(
              'resource',
              'Встроенная обложка повреждена или её тип не совпадает с данными.',
            );
          cover = rasterCover(bytes, media);
        } else
          warnings.push(
            'Встроенная обложка не является JPG/PNG/WebP. Она сохранится в оригинале, но не используется для превью.',
          );
      }
      checkImportCancelled(signal);
      progress('Книга проверена. Выберите, куда сохранить EPUB.');
      return {
        sha256,
        original: new Blob([buffer], { type: 'application/epub+zip' }),
        metadata,
        cover,
        packagePath,
        version,
        manifest,
        spine,
        navigation,
        sections,
        warnings,
      };
    } finally {
      packaging.destroy();
    }
  }
}
