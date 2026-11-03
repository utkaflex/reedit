// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { newId, type Book, type Reading } from '../src/domain/model';
import {
  activityDays,
  activityMode,
  intervalWords,
  localDay,
  mergeIntervals,
  statistics,
  WordLocator,
  yearDays,
  type ReadingActivity,
  type StatisticsSnapshot,
} from '../src/domain/statistics';
import { ReeditDatabase, schemaV7 } from '../src/infrastructure/database';
import { createLocalStore } from '../src/infrastructure/local-store';
import { buildDocumentTextIndex } from '../src/infrastructure/epub/text-index';
import { ReadingActivityService } from '../src/services/reading-activity';
import { cursorAt } from '../src/domain/text-position';
import { validate } from '../src/domain/rules';
import { PlaybackScheduler } from '../src/services/playback-scheduler';

const hash = 'a'.repeat(64),
  identity = `${hash}:${hash}`;
const base = () => ({ id: newId(), createdAt: 1000, updatedAt: 1000 });
const book = (): Book => ({
  ...base(),
  title: 'Синтетическая книга',
  authors: ['Автор'],
  genres: ['Роман', 'Проза'],
  isbn: [],
  catalogIds: [],
  description: '',
  cover: null,
  language: 'ru',
});
const reading = (b: Book): Reading => ({
  ...base(),
  bookId: b.id,
  status: 'active',
  startedAt: 1000,
  finishedAt: null,
  rating: null,
  review: '',
});
const empty = (): StatisticsSnapshot => ({
  books: [],
  readings: [],
  positions: [],
  sessions: [],
  activities: [],
  journal: [],
  settings: [],
});
const event = (overrides: Partial<ReadingActivity> = {}): ReadingActivity => ({
  ...base(),
  readingId: newId(),
  sessionId: newId(),
  contentId: identity,
  textVersion: 1,
  mode: 'ordinary',
  from: 1000,
  to: 2000,
  milliseconds: 1000,
  intervals: [],
  ...overrides,
});
const databases: ReeditDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function fixture() {
  const db = new ReeditDatabase(`statistics-${newId()}`);
  databases.push(db);
  const store = createLocalStore(db),
    b = book(),
    r = reading(b);
  await store.repositories.books.save(b);
  await store.repositories.readings.save(r);
  const f = {
    ...base(),
    bookId: b.id,
    name: 'synthetic.epub',
    mediaType: 'application/epub+zip' as const,
    sha256: hash,
    data: new Blob(['synthetic']),
  };
  await store.repositories.bookFiles.save(f);
  const index = await buildDocumentTextIndex(
    f,
    [
      {
        spineIndex: 0,
        path: 'a.xhtml',
        cfiBase: '/6/2[a]',
        load: () =>
          Promise.resolve(
            new DOMParser().parseFromString(
              '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Первое второе, третье — четвёртое.</p></body></html>',
              'application/xhtml+xml',
            ),
          ),
      },
    ],
    new AbortController().signal,
  );
  // Isolate activity persistence from the separately tested EPUB importer.
  await db.records('documentTextIndexes').add(index);
  let utc = 10000,
    mono = 0;
  const advance = (ms: number) => {
    utc += ms;
    mono += ms;
  };
  const errors: (string | null)[] = [];
  const tracker = new ReadingActivityService(
    store,
    r.id,
    f.id,
    (message) => errors.push(message),
    { utc: () => utc, monotonic: () => mono },
  );
  return {
    db,
    store,
    b,
    r,
    f,
    index,
    tracker,
    advance,
    errors,
    clock: { utc: () => utc, monotonic: () => mono },
    setUtc: (value: number) => {
      utc = value;
    },
  };
}

describe('интервалы и календарь', () => {
  it('отдельно считает сегодняшний день, неделю с понедельника, месяц и год', () => {
    const activities = [
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ].map((day) => {
      const from = Date.parse(`${day}T12:00:00Z`);
      return event({ from, to: from + 1000 });
    });
    const result = statistics(
      { ...empty(), activities },
      2026,
      Date.parse('2026-11-03T15:00Z'),
      'UTC',
    );
    expect([
      result.dayTime,
      result.weekTime,
      result.monthTime,
      result.yearTime,
    ]).toEqual([1000, 2000, 3000, 4000]);
  });
  it('бездействие, фон, диалоги и пауза скорочтения не дают активного времени; действие возобновляет учёт', () => {
    const state = {
      visible: true,
      modal: false,
      speedActive: false,
      playing: false,
      mode: 'ordinary' as const,
      now: 91000,
      lastInteraction: 0,
    };
    expect(activityMode(state)).toBeNull();
    expect(activityMode({ ...state, lastInteraction: 91000 })).toBe('ordinary');
    expect(
      activityMode({ ...state, lastInteraction: 91000, visible: false }),
    ).toBeNull();
    expect(
      activityMode({ ...state, lastInteraction: 91000, modal: true }),
    ).toBeNull();
    expect(
      activityMode({
        ...state,
        speedActive: true,
        playing: true,
        mode: 'guided',
      }),
    ).toBe('guided');
    expect(
      activityMode({
        ...state,
        speedActive: true,
        playing: false,
        mode: 'rsvp',
      }),
    ).toBeNull();
  });
  it('годовые режимы делят время на границе локального года', () => {
    const from = Date.parse('2026-12-31T18:59:59Z');
    const data = {
      ...empty(),
      activities: [event({ from, to: from + 2000, milliseconds: 2000 })],
    };
    expect(
      statistics(data, 2026, from, 'Asia/Yekaterinburg').modes[0]?.milliseconds,
    ).toBe(1000);
    expect(
      statistics(data, 2027, from, 'Asia/Yekaterinburg').modes[0]?.milliseconds,
    ).toBe(1000);
  });
  it('объединяет повторные проходы, касания и вложенные интервалы', () => {
    expect(
      mergeIntervals([
        { start: 3, end: 8 },
        { start: 0, end: 4 },
        { start: 2, end: 3 },
        { start: 8, end: 10 },
      ]),
    ).toEqual([{ start: 0, end: 10 }]);
    expect(() => mergeIntervals([{ start: 5, end: 4 }])).toThrow();
  });
  it('property: объединение идемпотентно и совпадает с множеством прочитанных слов', () => {
    let seed = 12345;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed;
    };
    for (let run = 0; run < 200; run++) {
      const values = Array.from({ length: 30 }, () => {
        const start = random() % 70;
        return { start, end: start + 1 + (random() % 20) };
      });
      const set = new Set(
        values.flatMap((v) =>
          Array.from({ length: v.end - v.start }, (_, i) => i + v.start),
        ),
      );
      expect(intervalWords(values)).toBe(set.size);
      expect(mergeIntervals([...values].reverse())).toEqual(
        mergeIntervals(values),
      );
      expect(mergeIntervals(mergeIntervals(values))).toEqual(
        mergeIntervals(values),
      );
    }
  });
  it('считает високосные годы и дни в локальной зоне, не UTC', () => {
    expect(yearDays(2024)).toHaveLength(366);
    expect(yearDays(2026)).toHaveLength(365);
    expect(localDay(Date.parse('2026-01-01T00:30Z'), 'America/New_York')).toBe(
      '2025-12-31',
    );
    const from = Date.parse('2026-01-01T18:59:58Z');
    const days = activityDays(
      [event({ from, to: from + 4000, milliseconds: 4000 })],
      'Asia/Yekaterinburg',
    );
    expect(days.get('2026-01-01')).toBe(2000);
    expect(days.get('2026-01-02')).toBe(2000);
  });
  it('смена DST не удваивает активное время', () => {
    const first = Date.parse('2026-11-01T05:59:58Z'),
      second = Date.parse('2026-11-01T06:00:00Z');
    expect(
      activityDays(
        [
          event({ from: first, to: first + 2000, milliseconds: 2000 }),
          event({ from: second, to: second + 2000, milliseconds: 2000 }),
        ],
        'America/New_York',
      ).get('2026-11-01'),
    ).toBe(4000);
  });
  it('считает книги отдельно от перечитываний и сохраняет ручные даты', () => {
    const b = book(),
      r = {
        ...reading(b),
        status: 'finished' as const,
        finishedAt: Date.UTC(2026, 0, 1),
        rating: 4,
      };
    const data = {
      ...empty(),
      books: [b],
      readings: [r, { ...r, id: newId(), rating: 5 }],
    };
    const result = statistics(
      data,
      2026,
      Date.UTC(2026, 0, 10),
      'America/New_York',
    );
    expect(result.booksYear).toBe(1);
    expect(result.booksAll).toBe(1);
    expect(result.yearly).toHaveLength(2);
    expect(result.averageRating).toBe(4.5);
    expect(result.authors).toEqual([['Автор', 1]]);
    expect(result.genres).toHaveLength(2);
    expect(result.yearTime).toBe(0);
  });
  it('разделяет время, обработанные слова, уникальность, режимы и разные издания', () => {
    const b = book(),
      r = reading(b),
      rerun = reading(b),
      from = Date.UTC(2026, 0, 1);
    const data = {
      ...empty(),
      books: [b],
      readings: [r, rerun],
      activities: [
        event({
          readingId: r.id,
          from,
          to: from + 1000,
          intervals: [{ start: 0, end: 4 }],
        }),
        event({
          readingId: rerun.id,
          mode: 'rsvp' as const,
          from: from + 1000,
          to: from + 2000,
          intervals: [{ start: 0, end: 4 }],
        }),
        event({
          readingId: r.id,
          mode: 'guided' as const,
          contentId: `${hash}:${'b'.repeat(64)}`,
          from: from + 2000,
          to: from + 3000,
          intervals: [{ start: 0, end: 2 }],
        }),
      ],
    };
    const result = statistics(data, 2026, from, 'UTC');
    expect(result.uniqueWords).toBe(6);
    expect(result.averageWpm).toBe(200);
    expect(result.dayTime).toBe(3000);
    expect(result.modes.map((m) => m.wpm)).toEqual([240, 240, 120]);
    expect(statistics(empty(), 2026, from, 'UTC').modes[0]?.wpm).toBeNull();
  });
});
describe('сохранность статистики', () => {
  it('неудачная запись не оставляет частичного времени; повтор сохраняет исходное событие', async () => {
    const f = await fixture();
    await f.tracker.pulse('ordinary');
    vi.spyOn(f.store, 'commitActivity').mockRejectedValueOnce(
      new DOMException('Quota', 'QuotaExceededError'),
    );
    f.advance(1000);
    await f.tracker.record('ordinary', { start: 0, end: 1 });
    await expect(f.tracker.pause()).rejects.toThrow();
    expect((await f.store.readStatistics()).activities).toEqual([]);
    expect((await f.store.readStatistics()).sessions[0]?.activeSeconds).toBe(0);
    await f.tracker.flush();
    expect((await f.store.readStatistics()).activities).toHaveLength(1);
    expect((await f.store.readStatistics()).sessions[0]?.activeSeconds).toBe(1);
  });
  it('сопоставляет только полные слова видимого диапазона; отвергает другое издание', async () => {
    const { index } = await fixture(),
      locator = await WordLocator.create(index);
    expect(locator.count).toBe(4);
    expect(
      locator.interval(
        cursorAt(index, 0, 1),
        cursorAt(index, 0, index.totalCharacters),
      ),
    ).toEqual({ start: 1, end: 4 });
    expect(() =>
      locator.interval(
        { ...cursorAt(index, 0), sha256: 'b'.repeat(64) },
        cursorAt(index, 0, 10),
      ),
    ).toThrow();
  });
  it('учитывает активное время без автоматических слов; пропущенные часы не начисляются', async () => {
    const { store, tracker, advance } = await fixture();
    await tracker.pulse('ordinary');
    advance(1000);
    await tracker.pulse('ordinary');
    advance(3600000);
    await tracker.pulse('ordinary');
    advance(1000);
    await tracker.pause();
    const data = await store.readStatistics();
    expect(data.activities.reduce((n, e) => n + e.milliseconds, 0)).toBe(2000);
    expect(data.activities.flatMap((e) => e.intervals)).toHaveLength(0);
  });
  it('pause/resume и перезапуск сохраняют интервалы и режимы без удвоения', async () => {
    const f = await fixture();
    await f.tracker.pulse('ordinary');
    f.advance(1000);
    await f.tracker.record('ordinary', { start: 0, end: 2 });
    await f.tracker.pause();
    const restarted = new ReadingActivityService(
      f.store,
      f.r.id,
      f.f.id,
      () => undefined,
      f.clock,
    );
    f.advance(100000);
    await restarted.pulse('rsvp');
    f.advance(1000);
    await restarted.record('rsvp', { start: 1, end: 3 });
    await restarted.pause();
    const before = await f.store.readStatistics();
    f.store.close();
    const reopened = createLocalStore(new ReeditDatabase(f.db.name));
    try {
      expect(await reopened.readStatistics()).toEqual(before);
      expect(intervalWords(before.activities.flatMap((e) => e.intervals))).toBe(
        3,
      );
      expect(before.activities.reduce((n, e) => n + e.milliseconds, 0)).toBe(
        2000,
      );
      expect(new Set(before.activities.map((e) => e.mode))).toEqual(
        new Set(['ordinary', 'rsvp']),
      );
    } finally {
      reopened.close();
    }
  });
  it('не начисляет отрицательную длительность при переводе часов', async () => {
    const f = await fixture();
    await f.tracker.pulse('ordinary');
    f.advance(1000);
    f.setUtc(5000);
    await f.tracker.pulse('ordinary');
    f.advance(1000);
    await f.tracker.pause();
    expect(
      (await f.store.readStatistics()).activities.reduce(
        (n, e) => n + e.milliseconds,
        0,
      ),
    ).toBe(1000);
  });
  it('атомарно дедуплицирует повтор после неопределённого результата записи', async () => {
    const f = await fixture();
    await f.tracker.pulse('guided');
    const commit = f.store.commitActivity.bind(f.store);
    vi.spyOn(f.store, 'commitActivity').mockImplementationOnce(
      async (value, owner) => {
        await commit(value, owner);
        throw new Error('Потерян ответ');
      },
    );
    f.advance(1000);
    await f.tracker.record('guided', { start: 0, end: 1 });
    await expect(f.tracker.pause()).rejects.toThrow();
    await f.tracker.flush();
    const data = await f.store.readStatistics();
    expect(data.activities).toHaveLength(1);
    expect(data.sessions[0]?.activeSeconds).toBe(1);
    expect(data.activities[0]?.intervals).toEqual([{ start: 0, end: 1 }]);
    expect(f.errors.some(Boolean)).toBe(true);
  });
  it('эксклюзивная аренда исключает параллельный учёт двух вкладок', async () => {
    const f = await fixture(),
      other = new ReadingActivityService(
        f.store,
        f.r.id,
        f.f.id,
        () => undefined,
        f.clock,
      );
    await Promise.all([f.tracker.pulse('ordinary'), other.pulse('ordinary')]);
    f.advance(1000);
    await Promise.all([f.tracker.pause(), other.pause()]);
    expect(
      (await f.store.readStatistics()).activities.reduce(
        (n, e) => n + e.milliseconds,
        0,
      ),
    ).toBe(1000);
  });
  it('отвергает выход за текст, неверный UUID события и отрицательную длительность', async () => {
    const f = await fixture(),
      ownerId = newId();
    const session = await f.store.claimActivity({
      readingId: f.r.id,
      fileId: f.f.id,
      ownerId,
      mode: 'ordinary',
      now: 10000,
    });
    if (!session) throw new Error('No session');
    const value = event({
      readingId: f.r.id,
      sessionId: session.id,
      from: 10000,
      to: 11000,
      intervals: [{ start: 0, end: 5 }],
    });
    await expect(f.store.commitActivity(value, ownerId)).rejects.toThrow();
    expect(() => {
      validate('activities', { ...value, milliseconds: -1 });
    }).toThrow();
    const valid = { ...value, intervals: [{ start: 0, end: 1 }] };
    await f.store.commitActivity(valid, ownerId);
    await f.store.commitActivity(valid, ownerId);
    await expect(
      f.store.commitActivity({ ...valid, milliseconds: 500 }, ownerId),
    ).rejects.toThrow();
    expect((await f.store.readStatistics()).activities).toHaveLength(1);
  });
  it('удаление EPUB сохраняет время, интервалы и дневник; удаление книги требует подтверждения', async () => {
    const f = await fixture();
    await f.tracker.pulse('ordinary');
    f.advance(1000);
    await f.tracker.record('ordinary', { start: 0, end: 2 });
    await f.tracker.pause();
    const entry = {
      ...base(),
      bookId: f.b.id,
      readingId: f.r.id,
      day: '2026-11-03',
      body: 'Впечатление',
    };
    await f.store.repositories.journal.save(entry, { expectedUpdatedAt: null });
    await f.store.removeBookFile(f.f.id);
    expect((await f.store.readStatistics()).activities).toHaveLength(1);
    expect((await f.store.readStatistics()).journal).toEqual([entry]);
    await expect(
      f.store.removeBook(f.b.id, { confirmed: false }),
    ).rejects.toThrow();
    await f.store.removeBook(f.b.id, { confirmed: true });
    expect((await f.store.readStatistics()).activities).toEqual([]);
    expect((await f.store.readStatistics()).journal).toEqual([]);
  });
  it('дневник проверяет связи, даты и конфликты; цель сохраняется отдельно', async () => {
    const f = await fixture(),
      entry = {
        ...base(),
        bookId: f.b.id,
        readingId: f.r.id,
        day: '2026-11-03',
        body: 'Мысль',
      };
    await expect(
      f.store.repositories.journal.save({ ...entry, day: '2026-02-30' }),
    ).rejects.toThrow();
    await expect(
      f.store.repositories.journal.save({ ...entry, body: ' ' }),
    ).rejects.toThrow();
    await f.store.repositories.journal.save(entry, { expectedUpdatedAt: null });
    await f.store.repositories.journal.save(
      { ...entry, updatedAt: 1001, body: 'Исправлено' },
      { expectedUpdatedAt: 1000 },
    );
    await expect(f.store.removeJournal(entry.id, 1000)).rejects.toThrow();
    await f.store.removeJournal(entry.id, 1001);
    expect((await f.store.readStatistics()).journal).toEqual([]);
    const settings = {
      ...base(),
      key: 'local' as const,
      locale: 'ru' as const,
      theme: 'dark' as const,
      readingGoals: { '2026': 20 },
    };
    await f.store.repositories.settings.save(settings);
    expect(() => {
      validate('settings', { ...settings, readingGoals: { '2026': -1 } });
    }).toThrow();
  });
  it('v7 → v8 сохраняет старые сессии и Blob, не придумывает режим и события', async () => {
    const name = `migration-${newId()}`,
      old = new Dexie(name);
    old.version(7).stores(schemaV7);
    const b = book(),
      r = reading(b),
      session = {
        ...base(),
        readingId: r.id,
        startedAt: 1000,
        endedAt: 2000,
        activeSeconds: 1,
      };
    await old.table('books').put(b);
    await old.table('readings').put(r);
    await old.table('sessions').put(session);
    await old
      .table('bookFiles')
      .put({ ...base(), bookId: b.id, data: new Blob(['original']) });
    old.close();
    const db = new ReeditDatabase(name);
    databases.push(db);
    const store = createLocalStore(db);
    expect((await store.readStatistics()).sessions).toEqual([session]);
    expect((await store.readStatistics()).activities).toEqual([]);
    expect(
      await (await store.repositories.bookFiles.list())[0]?.data.text(),
    ).toBe('original');
  });
  it('завершение показа слова происходит один раз; seek не засчитывает пропуск', async () => {
    let now = 0;
    const callbacks: (() => void)[] = [];
    const completed: number[] = [];
    const scheduler = new PlaybackScheduler(
      {
        duration: () => 100,
        next: () => null,
        present: () => Promise.resolve(),
        completed: (index) => completed.push(index),
        changed: () => undefined,
        error: () => undefined,
      },
      {
        now: () => now,
        schedule: (fn) => {
          callbacks.push(fn);
          return () => {
            callbacks.splice(callbacks.indexOf(fn), 1);
          };
        },
      },
    );
    await scheduler.seek(2);
    expect(completed).toEqual([]);
    scheduler.play();
    now = 50;
    scheduler.pause();
    scheduler.play();
    now = 100;
    callbacks.at(-1)?.();
    await scheduler.drain();
    expect(completed).toEqual([2]);
    scheduler.play();
    expect(completed).toEqual([2]);
    scheduler.destroy();
  });
});
