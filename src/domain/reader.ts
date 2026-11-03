import type { EpubNavItem } from './epub';
import type { Annotation, TextAnchor, BookFile, EpubIndex } from './model';
import type { DocumentTextIndex, ReadingCursor } from './text-position';
import type { SpeedDocument } from './speed-reading';

export interface ReaderPreferences {
  mode: 'paginated' | 'scroll';
  font: 'serif' | 'sans';
  fontSize: number;
  lineHeight: number;
  margin: number;
  alignment: 'left' | 'justify';
  theme: 'light' | 'dark' | 'sepia';
  animations: boolean;
}
export const defaultReaderPreferences: ReaderPreferences = {
  mode: 'paginated',
  font: 'serif',
  fontSize: 20,
  lineHeight: 1.6,
  margin: 24,
  alignment: 'left',
  theme: 'light',
  animations: true,
};
export function validReaderPreferences(value: ReaderPreferences): boolean {
  return (
    ['paginated', 'scroll'].includes(value.mode) &&
    ['serif', 'sans'].includes(value.font) &&
    Number.isInteger(value.fontSize) &&
    value.fontSize >= 16 &&
    value.fontSize <= 32 &&
    Number.isFinite(value.lineHeight) &&
    value.lineHeight >= 1.2 &&
    value.lineHeight <= 2.2 &&
    Number.isInteger(value.margin) &&
    value.margin >= 12 &&
    value.margin <= 48 &&
    ['left', 'justify'].includes(value.alignment) &&
    ['light', 'dark', 'sepia'].includes(value.theme) &&
    typeof value.animations === 'boolean'
  );
}
export interface ReaderLocation {
  visible?: { start: ReadingCursor; end: ReadingCursor };
  cursor?: ReadingCursor;
  cfi: string;
  path: string;
  spineIndex: number;
  chapter: string;
  progression: number;
  atStart: boolean;
  atEnd: boolean;
}
export interface ReaderTarget {
  path: string;
  fragment?: string;
}
export interface ReaderSelection {
  anchor: TextAnchor;
  cfi: string;
  quote: string;
}
export interface ReaderSession {
  getTextIndex?(): DocumentTextIndex | null;
  getSpeedDocument(): Promise<SpeedDocument>;
  resolveLocation(cursor: ReadingCursor): Promise<ReaderLocation>;
  showSpeedRange(start: ReadingCursor, end: ReadingCursor): Promise<void>;
  clearSpeedRange(): void;
  flashCursor(cursor: ReadingCursor): Promise<void>;
  setSpeedInteraction(onStop: (() => void) | null): void;
  getSelection(): ReaderSelection | null;
  getBookmark(): ReaderSelection | null;
  setHighlights(annotations: Annotation[]): void;
  goToSaved(anchor: TextAnchor, quote?: string): Promise<boolean>;
  getCursor(): ReadingCursor | null;
  getSelectionCursor(): ReadingCursor | null;
  goToCursor(cursor: ReadingCursor): Promise<boolean>;
  next(): Promise<boolean>;
  previous(): Promise<boolean>;
  goTo(target: ReaderTarget): Promise<boolean>;
  setPreferences(preferences: ReaderPreferences): Promise<boolean>;
  destroy(): void;
}
export interface ReaderOpenOptions {
  onInteraction?: () => void;
  host: HTMLElement;
  file: BookFile;
  index: EpubIndex;
  preferences: ReaderPreferences;
  cfi: string | null;
  cursor?: ReadingCursor;
  documentIndex?: DocumentTextIndex;
  onDocumentIndex?: (index: DocumentTextIndex) => Promise<DocumentTextIndex>;
  signal: AbortSignal;
  onSelection?: (selection: ReaderSelection | null) => void;
  onLocation: (location: ReaderLocation) => void;
  onToggleControls: () => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}
export function flattenNavigation(items: EpubNavItem[]): EpubNavItem[] {
  return items.flatMap((item) => [item, ...flattenNavigation(item.children)]);
}
export type ReaderGesture = 'next' | 'previous' | 'toggle' | 'none';
export function readerGesture(input: {
  x: number;
  y: number;
  endX: number;
  endY: number;
  width: number;
  duration: number;
  selected: boolean;
  interactive: boolean;
  mode: ReaderPreferences['mode'];
  rtl: boolean;
}): ReaderGesture {
  if (
    input.selected ||
    input.interactive ||
    input.duration > 350 ||
    input.x < 20 ||
    input.x > input.width - 20
  )
    return 'none';
  const dx = input.endX - input.x;
  const dy = input.endY - input.y;
  if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5)
    return dx < 0 !== input.rtl ? 'next' : 'previous';
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return 'none';
  if (input.mode === 'paginated' && input.x < input.width * 0.22)
    return input.rtl ? 'next' : 'previous';
  if (input.mode === 'paginated' && input.x > input.width * 0.78)
    return input.rtl ? 'previous' : 'next';
  return 'toggle';
}
