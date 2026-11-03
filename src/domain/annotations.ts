import type {
  Annotation,
  BookFile,
  EpubRepresentation,
  HighlightColor,
  TextAnchor,
} from './model';
import { cursorSection, type DocumentTextIndex } from './text-position';

export const highlightColors: Record<
  HighlightColor,
  { label: string; fill: string }
> = {
  yellow: { label: 'Песочный', fill: '#dfbd61' },
  green: { label: 'Шалфейный', fill: '#89b792' },
  blue: { label: 'Голубой', fill: '#86adce' },
  rose: { label: 'Розовый', fill: '#cc98aa' },
};
export function contentIdentity(
  file: Pick<BookFile, 'sha256'> & {
    representation?: Pick<EpubRepresentation, 'sha256'>;
  },
): string | null {
  return file.sha256
    ? `${file.sha256}:${file.representation?.sha256 ?? file.sha256}`
    : null;
}
/** Validate offsets and surrounding text before rendering or navigating, never guess another edition. */
export function anchorText(
  index: DocumentTextIndex,
  anchor: TextAnchor,
): string {
  const section = cursorSection(index, anchor.start);
  cursorSection(index, anchor.end);
  if (
    anchor.start.spineIndex !== anchor.end.spineIndex ||
    anchor.end.offset < anchor.start.offset
  )
    throw new Error('Диапазон заметки повреждён.');
  const { offset: start } = anchor.start;
  const { offset: end } = anchor.end;
  if (
    section.text.slice(Math.max(0, start - anchor.before.length), start) !==
      anchor.before ||
    section.text.slice(end, end + anchor.after.length) !== anchor.after
  )
    throw new Error('Контекст заметки не совпадает с текстом книги.');
  return section.text.slice(start, end);
}
export function annotationKey(
  value: Pick<Annotation, 'readingId' | 'anchor' | 'cfi'>,
): string {
  const a = value.anchor;
  return JSON.stringify([
    value.readingId,
    a?.contentId,
    a?.start.algorithmVersion,
    a?.start.spineIndex,
    a?.start.offset,
    a?.end.offset,
    a ? null : value.cfi,
  ]);
}
