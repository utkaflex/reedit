import { newId } from '../../domain/model';
import {
  TEXT_INDEX_VERSION,
  validateDocumentTextIndex,
  type DocumentTextIndex,
  type DocumentTextSection,
  type DomPoint,
  type TextMapping,
  type TextToken,
} from '../../domain/text-position';
import type { Id } from '../../domain/model';
import { prepareTextDocument } from './text-dom';

type RawRun = {
  start: number;
  end: number;
  from: DomPoint;
  to: DomPoint;
  linear: boolean;
};
const omitted = new Set([
  'script',
  'style',
  'head',
  'nav',
  'noscript',
  'template',
  'rt',
  'rp',
]);
const blocks = new Set([
  'p',
  'div',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'tr',
  'td',
  'br',
  'hr',
  'figure',
  'figcaption',
  'pre',
  'address',
  'aside',
  'main',
  'header',
  'footer',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'th',
  'caption',
  'details',
  'summary',
]);
export function createIndexScheduler(
  signal: AbortSignal,
  yieldTask: () => Promise<void> = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    }),
) {
  let deadline = performance.now() + 8;
  return (force = false) => {
    signal.throwIfAborted();
    if (force || performance.now() >= deadline) {
      return yieldTask().then(() => {
        signal.throwIfAborted();
        deadline = performance.now() + 8;
      });
    }
    return undefined;
  };
}
export type IndexScheduler = ReturnType<typeof createIndexScheduler>;
const samePath = (a: number[], b: number[]) =>
  a.length === b.length && a.every((part, i) => part === b[i]);
const excluded = (element: Element) =>
  omitted.has(element.localName.toLowerCase()) ||
  element.hasAttribute('hidden') ||
  element.getAttribute('aria-hidden') === 'true' ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
    element.getAttribute('style') ?? '',
  ) ||
  /(?:^|\s)(?:navigation|doc-toc|doc-pagebreak)(?:\s|$)/.test(
    element.getAttribute('role') ?? '',
  ) ||
  /(?:^|\s)(?:toc|landmarks|page-list|pagebreak)(?:\s|$)/.test(
    element.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '',
  );

export async function indexTextSection(
  doc: Document,
  identity: Pick<
    DocumentTextSection,
    'path' | 'spineIndex' | 'cfiBase' | 'start'
  >,
  schedule: IndexScheduler,
  segmentation: DocumentTextIndex['segmentation'],
): Promise<DocumentTextSection> {
  prepareTextDocument(doc);
  const root = doc.getElementsByTagNameNS('*', 'body')[0];
  if (!root) throw new Error(`В разделе ${identity.path} отсутствует body.`);
  const raw: string[] = [];
  const runs: RawRun[] = [];
  let length = 0;
  const append = (
    text: string,
    from: DomPoint,
    to: DomPoint,
    linear: boolean,
  ) => {
    if (!text) return;
    raw.push(text);
    runs.push({ start: length, end: length + text.length, from, to, linear });
    length += text.length;
  };
  const stack: { node: Node; path: number[]; exit: boolean }[] = [
    { node: root, path: [], exit: false },
  ];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    const { node, path, exit } = entry;
    if (node.nodeType === 3 || node.nodeType === 4) {
      const text = node.textContent ?? '';
      // Remove invisible separators before NFC, retaining original DOM offsets.
      for (const part of text.matchAll(/[^\u00ad\u200b\ufeff]+/gu)) {
        append(
          part[0],
          { path, offset: part.index },
          { path, offset: part.index + part[0].length },
          true,
        );
      }
    } else if (node.nodeType === 1) {
      const element = node as Element;
      if (excluded(element)) continue;
      const boundary = blocks.has(element.localName.toLowerCase());
      if (boundary)
        append(
          ' ',
          { path, offset: exit ? node.childNodes.length : 0 },
          { path, offset: exit ? node.childNodes.length : 0 },
          false,
        );
      if (!exit) {
        if (boundary) stack.push({ node, path, exit: true });
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          const child = node.childNodes[i];
          if (child)
            stack.push({ node: child, path: [...path, i], exit: false });
        }
      }
    }
    const pause = schedule();
    if (pause) await pause;
  }
  const source = raw.join('');
  let runIndex = 0;
  const pointAt = (offset: number, end: boolean): DomPoint => {
    while (
      runIndex < runs.length - 1 &&
      (runs[runIndex]?.end ?? 0) < offset + (end ? 0 : 1)
    )
      runIndex++;
    const run = runs[runIndex];
    if (!run) return { path: [], offset: 0 };
    return run.linear
      ? {
          path: run.from.path,
          offset:
            Math.max(0, Math.min(run.end - run.start, offset - run.start)) +
            run.from.offset,
        }
      : end
        ? run.to
        : run.from;
  };
  const mappings: TextMapping[] = [];
  const chunks: string[] = [];
  let outputBuffer = '';
  let size = 0;
  const emit = (
    value: string,
    from: DomPoint,
    to: DomPoint,
    linear: boolean,
  ) => {
    const previous = mappings.at(-1);
    outputBuffer += value;
    if (outputBuffer.length >= 4096) {
      chunks.push(outputBuffer);
      outputBuffer = '';
    }
    if (
      linear &&
      previous?.linear &&
      samePath(previous.to.path, from.path) &&
      previous.to.offset === from.offset
    ) {
      previous.end += value.length;
      previous.to = to;
    } else
      mappings.push({
        start: size,
        end: size + value.length,
        from,
        to,
        linear,
      });
    size += value.length;
  };
  let whitespace: { from: DomPoint; to: DomPoint } | null = null;
  const graphemes =
    segmentation === 'intl'
      ? new Intl.Segmenter('ru', { granularity: 'grapheme' })
      : null;
  for (let base = 0; base < source.length;) {
    let limit = Math.min(base + 4096, source.length);
    while (
      limit < source.length &&
      /(?:\p{M}|[\u1100-\u11ff]|\u200d|[\uDC00-\uDFFF])/u.test(
        source.charAt(limit),
      )
    ) {
      limit++;
      if (limit - base > 8192)
        throw new Error(
          'Слишком длинная неделимая последовательность символов в EPUB. Оригинал сохранён.',
        );
    }
    const chunk = source.slice(base, limit);
    const pieces = graphemes
      ? Array.from(graphemes.segment(chunk), (entry) => ({
          value: entry.segment,
          offset: entry.index,
        }))
      : Array.from(
          chunk.matchAll(
            /(?:[\u1100-\u1112][\u1161-\u1175][\u11a8-\u11c2]?|[\uac00-\ud7a3][\u11a8-\u11c2]?|\P{M})\p{M}*|\p{M}+/gu,
          ),
          (entry) => ({
            value: entry[0],
            offset: entry.index,
          }),
        );
    for (const piece of pieces) {
      const value = piece.value
        .replace(/[\u00ad\u200b\ufeff]/gu, '')
        .normalize('NFC');
      const from = pointAt(base + piece.offset, false);
      const to = pointAt(base + piece.offset + piece.value.length, true);
      if (/^\s+$/u.test(value)) {
        whitespace ??= { from, to };
        whitespace.to = to;
      } else if (value) {
        if (whitespace && size > 0)
          emit(
            ' ',
            whitespace.from,
            whitespace.to,
            samePath(whitespace.from.path, whitespace.to.path) &&
              whitespace.to.offset - whitespace.from.offset === 1,
          );
        whitespace = null;
        emit(
          value,
          from,
          to,
          samePath(from.path, to.path) &&
            to.offset - from.offset === value.length &&
            value === piece.value,
        );
      }
      const pause = schedule();
      if (pause) await pause;
    }
    base = limit;
    await schedule(true);
  }
  chunks.push(outputBuffer);
  const text = chunks.join('');
  const tokens: TextToken[] = [];
  const words =
    segmentation === 'intl'
      ? new Intl.Segmenter('ru', { granularity: 'word' })
      : null;
  for (let base = 0; base < text.length;) {
    let end = Math.min(base + 4096, text.length);
    if (end < text.length && /[\uDC00-\uDFFF]/u.test(text.charAt(end))) end++;
    const chunk = text.slice(base, end);
    const pieces = words
      ? Array.from(words.segment(chunk), (entry) => ({
          value: entry.segment,
          offset: entry.index,
          word: entry.isWordLike === true,
        }))
      : Array.from(
          chunk.matchAll(/[\p{L}\p{M}\p{N}]+|\s+|[^\s\p{L}\p{M}\p{N}]+/gu),
          (entry) => ({
            value: entry[0],
            offset: entry.index,
            word: /^[\p{L}\p{M}\p{N}]/u.test(entry[0]),
          }),
        );
    for (const piece of pieces) {
      const previous = tokens.at(-1);
      if (
        piece.offset === 0 &&
        base > 0 &&
        previous?.kind === 'word' &&
        piece.word &&
        /[\p{L}\p{M}\p{N}]/u.test(text.charAt(base - 1)) &&
        /[\p{L}\p{M}\p{N}]/u.test(piece.value.charAt(0))
      ) {
        previous.end = base + piece.value.length;
        const pause = schedule();
        if (pause) await pause;
        continue;
      }
      tokens.push({
        start: base + piece.offset,
        end: base + piece.offset + piece.value.length,
        kind: piece.word
          ? 'word'
          : /^\s+$/u.test(piece.value)
            ? 'space'
            : 'punctuation',
      });
      const pause = schedule();
      if (pause) await pause;
    }
    base = end;
    await schedule(true);
  }
  return { ...identity, text, mappings, tokens };
}

export async function buildDocumentTextIndex(
  file: { id: Id; sha256: string },
  sections: {
    spineIndex: number;
    path: string;
    cfiBase: string;
    load: () => Promise<Document>;
  }[],
  signal: AbortSignal,
  yieldTask?: () => Promise<void>,
  onSection?: (completed: number, total: number) => void,
): Promise<DocumentTextIndex> {
  const schedule = createIndexScheduler(signal, yieldTask);
  const segmentation =
    typeof Intl.Segmenter === 'function' ? 'intl' : 'fallback';
  const result: DocumentTextSection[] = [];
  let total = 0;
  for (const section of sections) {
    onSection?.(result.length, sections.length);
    await schedule(true);
    const indexed = await indexTextSection(
      await section.load(),
      {
        spineIndex: section.spineIndex,
        path: section.path,
        cfiBase: section.cfiBase,
        start: total,
      },
      schedule,
      segmentation,
    );
    result.push(indexed);
    total += indexed.text.length;
  }
  signal.throwIfAborted();
  const now = Date.now();
  const index: DocumentTextIndex = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    bookFileId: file.id,
    sha256: file.sha256,
    algorithmVersion: TEXT_INDEX_VERSION,
    segmentation,
    sections: result,
    totalCharacters: total,
  };
  validateDocumentTextIndex(index);
  return index;
}
