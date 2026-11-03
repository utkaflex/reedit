import type { Id, RecordBase } from './model';

export const TEXT_INDEX_VERSION = 1;
export interface DomPoint {
  path: number[];
  offset: number;
}
export interface TextMapping {
  start: number;
  end: number;
  from: DomPoint;
  to: DomPoint;
  linear: boolean;
}
export interface TextToken {
  start: number;
  end: number;
  kind: 'word' | 'space' | 'punctuation';
}
export interface DocumentTextSection {
  spineIndex: number;
  path: string;
  cfiBase: string;
  text: string;
  start: number;
  mappings: TextMapping[];
  tokens: TextToken[];
}
export interface DocumentTextIndex extends RecordBase {
  bookFileId: Id;
  sha256: string;
  algorithmVersion: number;
  segmentation: 'intl' | 'fallback';
  sections: DocumentTextSection[];
  totalCharacters: number;
}
export interface ReadingCursor {
  sha256: string;
  algorithmVersion: number;
  spineIndex: number;
  offset: number;
  anchor: 'word' | 'visible-fragment';
}
export function textMappingAt(
  section: DocumentTextSection,
  offset: number,
): TextMapping | undefined {
  let low = 0;
  let high = section.mappings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((section.mappings[middle]?.end ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return section.mappings[low];
}
export function cursorSection(
  index: DocumentTextIndex,
  cursor: ReadingCursor,
): DocumentTextSection {
  const section = index.sections.find(
    (entry) => entry.spineIndex === cursor.spineIndex,
  );
  if (
    cursor.sha256 !== index.sha256 ||
    cursor.algorithmVersion !== index.algorithmVersion ||
    !section ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    cursor.offset > section.text.length ||
    !['word', 'visible-fragment'].includes(cursor.anchor)
  )
    throw new Error('Текстовая позиция несовместима с индексом этого EPUB.');
  const mapping = textMappingAt(section, cursor.offset);
  if (mapping && !mapping.linear && cursor.offset > mapping.start)
    throw new Error('Позиция разделяет неделимый нормализованный символ.');
  return section;
}
export function cursorAt(
  index: DocumentTextIndex,
  spineIndex: number,
  offset = 0,
  anchor: ReadingCursor['anchor'] = 'visible-fragment',
): ReadingCursor {
  if (!Number.isSafeInteger(offset))
    throw new Error('Некорректное текстовое смещение.');
  const section = index.sections.find(
    (entry) => entry.spineIndex === spineIndex,
  );
  const mapping = section ? textMappingAt(section, offset) : undefined;
  const result = {
    sha256: index.sha256,
    algorithmVersion: index.algorithmVersion,
    spineIndex,
    offset:
      mapping && !mapping.linear && offset > mapping.start
        ? mapping.start
        : offset,
    anchor,
  };
  cursorSection(index, result);
  return result;
}
export function cursorForWord(
  index: DocumentTextIndex,
  spineIndex: number,
  wordNumber: number,
): ReadingCursor {
  const section = index.sections.find(
    (entry) => entry.spineIndex === spineIndex,
  );
  const word = section?.tokens.filter((token) => token.kind === 'word')[
    wordNumber
  ];
  if (!Number.isSafeInteger(wordNumber) || !word)
    throw new Error('Слово отсутствует в индексе.');
  return cursorAt(index, spineIndex, word.start, 'word');
}
/** Deterministic handoff: containing word, otherwise the first word following the anchor. */
export function wordAtCursor(
  index: DocumentTextIndex,
  cursor: ReadingCursor,
): ReadingCursor | null {
  cursorSection(index, cursor);
  for (const section of index.sections) {
    if (section.spineIndex < cursor.spineIndex) continue;
    const word = section.tokens.find(
      (token) =>
        token.kind === 'word' &&
        (section.spineIndex > cursor.spineIndex || token.end > cursor.offset),
    );
    if (word) return cursorAt(index, section.spineIndex, word.start, 'word');
  }
  return null;
}
export function validateDocumentTextIndex(index: DocumentTextIndex): void {
  if (
    index.algorithmVersion !== TEXT_INDEX_VERSION ||
    !/^[a-f0-9]{64}$/.test(index.sha256) ||
    !['intl', 'fallback'].includes(index.segmentation) ||
    !index.sections.length
  )
    throw new Error('Некорректный текстовый индекс.');
  let total = 0;
  let previous = -1;
  for (const section of index.sections) {
    if (
      !Number.isSafeInteger(section.spineIndex) ||
      section.spineIndex <= previous ||
      section.start !== total ||
      !section.path ||
      !section.cfiBase
    )
      throw new Error('Нарушен порядок текстового spine.');
    previous = section.spineIndex;
    for (const parts of [section.tokens, section.mappings]) {
      let end = 0;
      for (const part of parts) {
        if (
          !Number.isSafeInteger(part.start) ||
          !Number.isSafeInteger(part.end) ||
          part.start !== end ||
          part.end <= part.start ||
          part.end > section.text.length
        )
          throw new Error('Пропуск в текстовом индексе.');
        end = part.end;
      }
      if (end !== section.text.length)
        throw new Error('Неполный текстовый индекс.');
    }
    if (
      section.tokens.some(
        (token) => !['word', 'space', 'punctuation'].includes(token.kind),
      )
    )
      throw new Error('Неизвестный вид текстового токена.');
    for (const map of section.mappings) {
      for (const point of [map.from, map.to])
        if (
          !Number.isSafeInteger(point.offset) ||
          point.offset < 0 ||
          point.path.some((part) => !Number.isSafeInteger(part) || part < 0)
        )
          throw new Error('Некорректная связь текста и DOM.');
      if (
        map.linear &&
        (map.from.path.join('/') !== map.to.path.join('/') ||
          map.to.offset - map.from.offset !== map.end - map.start)
      )
        throw new Error('Некорректное линейное смещение DOM.');
    }
    total += section.text.length;
  }
  if (total !== index.totalCharacters)
    throw new Error('Неверный объём читаемого текста.');
}
