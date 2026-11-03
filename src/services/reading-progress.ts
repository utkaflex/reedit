import {
  cursorSection,
  type DocumentTextIndex,
  type ReadingCursor,
} from '../domain/text-position';

export interface TextInterval {
  sha256: string;
  algorithmVersion: number;
  start: number;
  end: number;
}
export class ReadingProgressService {
  constructor(private index: DocumentTextIndex) {}
  absolute(cursor: ReadingCursor): number {
    return cursorSection(this.index, cursor).start + cursor.offset;
  }
  relative(cursor: ReadingCursor): number {
    return this.index.totalCharacters
      ? this.absolute(cursor) / this.index.totalCharacters
      : 0;
  }
  /** Only call for a truly traversed interval; navigation jumps do not imply reading. */
  interval(from: ReadingCursor, to: ReadingCursor): TextInterval {
    const start = this.absolute(from);
    const end = this.absolute(to);
    if (end < start) throw new Error('Текстовый интервал направлен назад.');
    return {
      sha256: this.index.sha256,
      algorithmVersion: this.index.algorithmVersion,
      start,
      end,
    };
  }
}
