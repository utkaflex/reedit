import type {
  Book,
  Id,
  Reading,
  ReadingPosition,
  ReadingSession,
  RecordBase,
  Settings,
} from './model';
import type { DocumentTextIndex, ReadingCursor } from './text-position';
import { cursorSection } from './text-position';

export type ReadingMode = 'ordinary' | 'rsvp' | 'guided';
export function activityMode(input: {
  visible: boolean;
  modal: boolean;
  speedActive: boolean;
  playing: boolean;
  mode: ReadingMode;
  now: number;
  lastInteraction: number;
}): ReadingMode | null {
  if (!input.visible || input.modal) return null;
  if (input.speedActive) return input.playing ? input.mode : null;
  const idle = input.now - input.lastInteraction;
  return idle >= 0 && idle <= 90000 ? 'ordinary' : null;
}
/** Half-open ordinal word intervals, scoped to an exact content identity and index version. */
export interface WordInterval {
  start: number;
  end: number;
}
export interface ReadingActivity extends RecordBase {
  readingId: Id;
  sessionId: Id;
  contentId: string;
  textVersion: number;
  mode: ReadingMode;
  from: number;
  to: number;
  milliseconds: number;
  intervals: WordInterval[];
}
export interface JournalEntry extends RecordBase {
  bookId: Id;
  readingId: Id;
  day: string;
  body: string;
}
export interface StatisticsSnapshot {
  books: Book[];
  readings: Reading[];
  positions: ReadingPosition[];
  sessions: ReadingSession[];
  activities: ReadingActivity[];
  journal: JournalEntry[];
  settings: Settings[];
}
export function mergeIntervals(
  values: readonly WordInterval[],
): WordInterval[] {
  const result: WordInterval[] = [];
  for (const interval of [...values].sort((a, b) => a.start - b.start)) {
    if (
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 0 ||
      interval.end <= interval.start
    )
      throw new Error('Некорректный интервал слов.');
    const last = result.at(-1);
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}
export const intervalWords = (values: readonly WordInterval[]): number =>
  mergeIntervals(values).reduce(
    (sum, value) => sum + value.end - value.start,
    0,
  );

/** Build cooperatively; positions are never inferred from page numbers or TOC. */
export class WordLocator {
  private constructor(
    private index: DocumentTextIndex,
    private words: { start: number; end: number }[],
  ) {}
  static async create(index: DocumentTextIndex): Promise<WordLocator> {
    const words: { start: number; end: number }[] = [];
    let visited = 0;
    for (const section of index.sections)
      for (const token of section.tokens) {
        if (token.kind === 'word')
          words.push({
            start: section.start + token.start,
            end: section.start + token.end,
          });
        if (++visited % 2000 === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    return new WordLocator(index, words);
  }
  get count(): number {
    return this.words.length;
  }
  interval(start: ReadingCursor, end: ReadingCursor): WordInterval | null {
    const a = cursorSection(this.index, start).start + start.offset;
    const b = cursorSection(this.index, end).start + end.offset;
    const lower = (offset: number, edge: 'start' | 'end') => {
      let low = 0,
        high = this.words.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const word = this.words[mid];
        if (
          word &&
          (edge === 'start' ? word.start < offset : word.end <= offset)
        )
          low = mid + 1;
        else high = mid;
      }
      return low;
    };
    const first = lower(a, 'start'),
      last = lower(b, 'end');
    return last > first ? { start: first, end: last } : null;
  }
}
export function localDay(utc: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(utc);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function yearDays(year: number): string[] {
  const days: string[] = [];
  for (
    let day = Date.UTC(year, 0, 1);
    new Date(day).getUTCFullYear() === year;
    day += 86400000
  )
    days.push(new Date(day).toISOString().slice(0, 10));
  return days;
}
/** UTC intervals are split at UTC minutes, then grouped in the user's current timezone, including DST. */
export function activityDays(
  activities: readonly ReadingActivity[],
  timeZone: string,
): Map<string, number> {
  const days = new Map<string, number>();
  for (const event of activities) {
    if (event.to <= event.from || event.milliseconds <= 0) continue;
    for (let from = event.from; from < event.to;) {
      const to = Math.min(event.to, (Math.floor(from / 60000) + 1) * 60000);
      const day = localDay(from, timeZone);
      days.set(
        day,
        (days.get(day) ?? 0) +
          (event.milliseconds * (to - from)) / (event.to - event.from),
      );
      from = to;
    }
  }
  return days;
}
export function statistics(
  data: StatisticsSnapshot,
  year: number,
  now: number,
  timeZone: string,
) {
  const today = localDay(now, timeZone);
  // Reading dates are user-entered civil dates encoded at UTC midnight (legacy contract).
  const finished = data.readings.filter(
    (r) => r.status === 'finished' && r.finishedAt !== null,
  );
  const date = (r: Reading) =>
    new Date(r.finishedAt ?? 0).toISOString().slice(0, 10);
  const yearly = finished.filter((r) => date(r).startsWith(`${String(year)}-`));
  const distinct = (readings: Reading[]) =>
    new Set(readings.map((r) => r.bookId)).size;
  const rated = yearly.filter((r) => r.rating !== null);
  const days = activityDays(data.activities, timeZone);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = new Date(Date.parse(`${today}T00:00:00Z`) - weekday * 86400000)
    .toISOString()
    .slice(0, 10);
  const sumDays = (predicate: (day: string) => boolean) =>
    [...days].reduce((sum, [day, ms]) => sum + (predicate(day) ? ms : 0), 0);
  const modes = (['ordinary', 'rsvp', 'guided'] as const).map((mode) => {
    const all = data.activities.filter((e) => e.mode === mode);
    const events = all.filter((e) =>
      localDay(e.to, timeZone).startsWith(`${String(year)}-`),
    );
    const milliseconds = [...activityDays(all, timeZone)].reduce(
      (sum, [day, ms]) => sum + (day.startsWith(`${String(year)}-`) ? ms : 0),
      0,
    );
    const words = events.reduce(
      (sum, e) => sum + e.intervals.reduce((n, i) => n + i.end - i.start, 0),
      0,
    );
    return {
      mode,
      milliseconds,
      words,
      wpm:
        milliseconds > 0 && words > 0 ? (words * 60000) / milliseconds : null,
    };
  });
  const groups = new Map<string, WordInterval[]>();
  const parents = new Map(data.readings.map((r) => [r.id, r.bookId]));
  for (const event of data.activities) {
    const key = `${String(parents.get(event.readingId))}:${event.contentId}:${String(event.textVersion)}`;
    const intervals = groups.get(key) ?? [];
    intervals.push(...event.intervals);
    groups.set(key, intervals);
  }
  const completedBooks = data.books.filter((b) =>
    yearly.some((r) => r.bookId === b.id),
  );
  const activeMilliseconds = modes.reduce(
    (sum, mode) => sum + mode.milliseconds,
    0,
  );
  const processedWords = modes.reduce((sum, mode) => sum + mode.words, 0);
  const distribution = (field: 'authors' | 'genres') => {
    const counts = new Map<string, number>();
    for (const book of completedBooks)
      for (const value of new Set(book[field]))
        counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'),
    );
  };
  return {
    averageWpm:
      activeMilliseconds > 0 && processedWords > 0
        ? (processedWords * 60000) / activeMilliseconds
        : null,
    finished,
    yearly,
    booksYear: distinct(yearly),
    booksMonth: distinct(
      finished.filter((r) => date(r).startsWith(today.slice(0, 7))),
    ),
    booksAll: distinct(finished),
    averageRating: rated.length
      ? rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length
      : null,
    days,
    modes,
    uniqueWords: [...groups.values()].reduce(
      (sum, intervals) => sum + intervalWords(intervals),
      0,
    ),
    dayTime: days.get(today) ?? 0,
    weekTime: sumDays((d) => d >= monday && d <= today),
    monthTime: sumDays((d) => d.startsWith(today.slice(0, 7))),
    yearTime: sumDays((d) => d.startsWith(`${String(year)}-`)),
    authors: distribution('authors'),
    genres: distribution('genres'),
    legacySeconds: data.sessions
      .filter((s) => !s.mode)
      .reduce((sum, s) => sum + s.activeSeconds, 0),
  };
}
