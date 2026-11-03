import EpubCFI from 'epubjs/lib/epubcfi.js';
import { prepareTextDocument } from './text-dom';
import {
  cursorAt,
  cursorSection,
  type DocumentTextIndex,
  type DomPoint,
  type ReadingCursor,
} from '../../domain/text-position';

function nodeAt(doc: Document, point: DomPoint): Node {
  let node: Node | undefined = doc.getElementsByTagNameNS('*', 'body')[0];
  for (const step of point.path) node = node?.childNodes[step];
  if (
    !node ||
    point.offset >
      (node.nodeType === 3 || node.nodeType === 4
        ? (node.textContent?.length ?? 0)
        : node.childNodes.length)
  )
    throw new Error('DOM раздела не соответствует текстовому индексу.');
  return node;
}
function pointRange(doc: Document, point: DomPoint): Range {
  const range = doc.createRange();
  range.setStart(nodeAt(doc, point), point.offset);
  range.collapse(true);
  return range;
}
/** Offsets refer to the original body DOM, unaffected by reader CSS/head injections. */
export class PositionResolver {
  constructor(private index: DocumentTextIndex) {}
  toRange(cursor: ReadingCursor, doc: Document): Range {
    prepareTextDocument(doc);
    const section = cursorSection(this.index, cursor);
    let low = 0;
    let high = section.mappings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((section.mappings[middle]?.end ?? 0) <= cursor.offset)
        low = middle + 1;
      else high = middle;
    }
    const map = section.mappings[low];
    if (!map)
      return pointRange(
        doc,
        section.mappings.at(-1)?.to ?? { path: [], offset: 0 },
      );
    const point = map.linear
      ? {
          path: map.from.path,
          offset: map.from.offset + cursor.offset - map.start,
        }
      : map.from;
    return pointRange(doc, point);
  }
  fromRange(
    spineIndex: number,
    range: Range,
    anchor: ReadingCursor['anchor'] = 'word',
  ): ReadingCursor {
    const section = this.index.sections.find(
      (entry) => entry.spineIndex === spineIndex,
    );
    if (!section) throw new Error('Раздел отсутствует в читаемом spine.');
    const doc = range.startContainer.ownerDocument;
    if (!doc) throw new Error('Диапазон не принадлежит документу EPUB.');
    const start = range.cloneRange();
    start.collapse(true);
    const root = doc.getElementsByTagNameNS('*', 'body')[0];
    if (!root?.contains(start.startContainer) && root !== start.startContainer)
      throw new Error('Позиция находится вне текста EPUB.');
    let low = 0;
    let high = section.mappings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const map = section.mappings[middle];
      if (map && pointRange(doc, map.to).compareBoundaryPoints(0, start) <= 0)
        low = middle + 1;
      else high = middle;
    }
    const map = section.mappings[low];
    let offset = map?.start ?? section.text.length;
    if (map?.linear && nodeAt(doc, map.from) === start.startContainer)
      offset = Math.max(
        map.start,
        Math.min(map.end, map.start + start.startOffset - map.from.offset),
      );
    return cursorAt(this.index, spineIndex, offset, anchor);
  }
  rangeBetween(start: ReadingCursor, end: ReadingCursor, doc: Document): Range {
    if (start.spineIndex !== end.spineIndex || end.offset < start.offset)
      throw new Error('Некорректный диапазон раздела.');
    const range = this.toRange(start, doc);
    const finish = this.toRange(end, doc);
    range.setEnd(finish.startContainer, finish.startOffset);
    return range;
  }
  rangeCfi(start: ReadingCursor, end: ReadingCursor, doc: Document): string {
    return new EpubCFI(
      this.rangeBetween(start, end, doc),
      cursorSection(this.index, start).cfiBase,
    ).toString();
  }
  toCfi(cursor: ReadingCursor, doc: Document): string {
    const section = cursorSection(this.index, cursor);
    return new EpubCFI(this.toRange(cursor, doc), section.cfiBase).toString();
  }
  fromCfi(
    cfi: string,
    doc: Document,
    anchor: ReadingCursor['anchor'] = 'visible-fragment',
  ): ReadingCursor {
    try {
      prepareTextDocument(doc);
      const parsed = new EpubCFI(cfi);
      if (!parsed.isCfiString(cfi)) throw new Error('Некорректный EPUB CFI.');
      return this.fromRange(parsed.spinePos, parsed.toRange(doc), anchor);
    } catch (error) {
      throw new Error(
        'Не удалось сопоставить EPUB CFI с читаемым текстом. Сохранённая позиция не изменена.',
        { cause: error },
      );
    }
  }
}
