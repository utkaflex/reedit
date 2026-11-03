import { EpubImportError, normalizeEpubText } from '../../domain/epub';
import { hasControlCharacters } from './characters';

export function parseXml(
  bytes: Uint8Array,
  path: string,
  maxBytes = 4 * 1024 * 1024,
): XMLDocument {
  if (bytes.length > maxBytes)
    throw new EpubImportError(
      'limit',
      `XML/XHTML ${path} превышает лимит ${String(maxBytes / (1024 * 1024))} МБ.`,
    );
  let text: string;
  try {
    const utf16 =
      bytes[0] === 255 && bytes[1] === 254
        ? 'utf-16le'
        : bytes[0] === 254 && bytes[1] === 255
          ? 'utf-16be'
          : 'utf-8';
    text = new TextDecoder(utf16, { fatal: true }).decode(bytes);
  } catch {
    throw new EpubImportError(
      'structure',
      `Невозможно прочитать кодировку XML: ${path}. Поддерживаются UTF-8 и UTF-16 с BOM.`,
    );
  }
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text))
    throw new EpubImportError(
      'unsafe',
      `Объявления XML-сущностей запрещены: ${path}.`,
    );
  const encoding = /^\s*<\?xml[^>]*encoding\s*=\s*['"]([^'"]+)/i
    .exec(text)?.[1]
    ?.toLowerCase();
  if (
    encoding &&
    !['utf-8', 'utf8', 'utf-16', 'utf-16le', 'utf-16be'].includes(encoding)
  )
    throw new EpubImportError(
      'structure',
      `Неподдерживаемая кодировка ${encoding}: ${path}.`,
    );
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (
    doc.createTreeWalker(doc, NodeFilter.SHOW_PROCESSING_INSTRUCTION).nextNode()
  )
    throw new EpubImportError(
      'unsafe',
      `Инструкции обработки XML не поддерживаются: ${path}.`,
    );
  if (
    doc.getElementsByTagName('parsererror').length ||
    doc.documentElement.localName === 'parsererror'
  )
    throw new EpubImportError('structure', `Некорректный XML/XHTML: ${path}.`);
  const stack: { node: Element; depth: number }[] = [
    { node: doc.documentElement, depth: 0 },
  ];
  let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++count > 100000 || item.depth > 64)
      throw new EpubImportError(
        'limit',
        `Слишком сложная структура XML: ${path}.`,
      );
    for (const child of item.node.children)
      stack.push({ node: child, depth: item.depth + 1 });
  }
  return doc;
}
export const elements = (node: Document | Element, name: string): Element[] =>
  Array.from(node.getElementsByTagNameNS('*', name));
export function resolveReference(
  base: string,
  reference: string,
): { path: string; fragment: string } {
  const value = reference.trim();
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    hasControlCharacters(value)
  )
    throw new EpubImportError(
      'unsafe',
      `Внешний или небезопасный ресурс: ${reference}.`,
    );
  const hash = value.indexOf('#');
  const rawPath = hash < 0 ? value : value.slice(0, hash);
  if (rawPath.includes('?'))
    throw new EpubImportError(
      'resource',
      `Параметры в путях ресурсов пока не поддерживаются: ${reference}.`,
    );
  let decoded: string;
  let fragment: string;
  try {
    decoded = decodeURIComponent(rawPath);
    fragment = hash < 0 ? '' : decodeURIComponent(value.slice(hash + 1));
  } catch {
    throw new EpubImportError('resource', `Некорректная ссылка: ${reference}.`);
  }
  if (
    decoded.includes('\\') ||
    decoded.includes(':') ||
    hasControlCharacters(decoded) ||
    decoded.startsWith('/')
  )
    throw new EpubImportError('unsafe', 'Небезопасный путь в EPUB.');
  const parts = rawPath ? base.split('/').slice(0, -1) : [];
  if (!rawPath) return { path: base, fragment };
  for (const part of decoded.normalize('NFC').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length)
        throw new EpubImportError('unsafe', 'Ссылка выходит за границы EPUB.');
      parts.pop();
    } else parts.push(part);
  }
  return { path: parts.join('/'), fragment };
}
export interface ResourceLink {
  from: string;
  path: string;
  fragment: string;
}
export function checkDocument(
  doc: XMLDocument,
  path: string,
  links: ResourceLink[],
): void {
  const ids = new Set<string>();
  const forbidden = new Set([
    'script',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'applet',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'base',
    'foreignobject',
    'animate',
    'animatemotion',
    'animatetransform',
    'set',
    'discard',
  ]);
  for (const element of [
    doc.documentElement,
    ...Array.from(doc.documentElement.getElementsByTagName('*')),
  ]) {
    const tag = element.localName.toLowerCase();
    if (forbidden.has(tag))
      throw new EpubImportError(
        'unsafe',
        `Активное содержимое <${tag}> запрещено: ${path}.`,
      );
    const id = element.getAttribute('id');
    if (id) {
      if (ids.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id))
        throw new EpubImportError(
          'structure',
          `Неоднозначный или небезопасный id в ${path}.`,
        );
      ids.add(id);
    }
    // Calibre and many EPUB 2 publishers include a passive encoding declaration.
    // This must not be confused with refresh/CSP/cookie directives.
    if (
      tag === 'meta' &&
      element.hasAttribute('http-equiv') &&
      !(
        element.getAttribute('http-equiv')?.trim().toLowerCase() ===
          'content-type' &&
        /^(?:text\/html|application\/xhtml\+xml)\s*;\s*charset\s*=\s*["']?utf-(?:8|16(?:le|be)?)["']?\s*$/i.test(
          element.getAttribute('content') ?? '',
        )
      )
    )
      throw new EpubImportError(
        'unsafe',
        `В файле «${path}» обнаружена команда браузеру, которую читалка не поддерживает. Выберите другое издание EPUB.`,
      );
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value;
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        (name === 'base' &&
          attribute.namespaceURI === 'http://www.w3.org/XML/1998/namespace')
      )
        throw new EpubImportError(
          'unsafe',
          `Обработчики событий и изменение базы URL запрещены: ${path}.`,
        );
      if (/^(?:javascript|vbscript):/i.test(value.replace(/\s/g, '')))
        throw new EpubImportError(
          'unsafe',
          `Активная ссылка запрещена: ${path}.`,
        );
      if (name === 'style') checkCss(value, path, links);
      if (['src', 'href', 'poster', 'data'].includes(name)) {
        if (
          (tag === 'a' || tag === 'area') &&
          name === 'href' &&
          /^(?:https?:|mailto:|tel:)/i.test(value.trim())
        )
          continue;
        if (!value.trim()) continue;
        const target = resolveReference(path, value);
        links.push({ from: path, ...target });
      }
      if (name === 'srcset')
        for (const candidate of value.split(',')) {
          const href = candidate.trim().split(/\s+/)[0];
          if (href) links.push({ from: path, ...resolveReference(path, href) });
        }
    }
    if (tag === 'style') checkCss(element.textContent, path, links);
  }
}
export function checkCss(
  text: string,
  path: string,
  links: ResourceLink[],
): void {
  const decoded = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(
      /\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
      (_, hex: unknown, character: unknown) =>
        typeof hex === 'string'
          ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff))
          : typeof character === 'string'
            ? character
            : '',
    );
  if (/@import|expression\s*\(|behavior\s*:|-moz-binding/i.test(decoded))
    throw new EpubImportError(
      'unsafe',
      `Активный CSS или @import не поддерживается: ${path}.`,
    );
  for (const match of decoded.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const href = match[2]?.trim();
    if (href) links.push({ from: path, ...resolveReference(path, href) });
  }
}
const blocks = new Set([
  'p',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'li',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'text',
]);
export function extractText(doc: XMLDocument): string {
  const root = elements(doc, 'body')[0] ?? doc.documentElement;
  const output: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      output.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (['style', 'head', 'script'].includes(tag)) return;
    if (blocks.has(tag)) output.push(' ');
    for (const child of element.childNodes) visit(child);
    if (blocks.has(tag)) output.push(' ');
  };
  visit(root);
  return normalizeEpubText(output.join(''));
}
