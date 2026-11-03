// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlaybackScheduler,
  type PlaybackClock,
} from '../src/services/playback-scheduler';
import { buildDocumentTextIndex } from '../src/infrastructure/epub/text-index';
import { cursorAt, cursorForWord } from '../src/domain/text-position';
import {
  defaultSpeedPreferences,
  focusParts,
  frameEnd,
  previousSentence,
  speedWordAt,
  speedWords,
  validSpeedPreferences,
  wordDuration,
  type SpeedDocument,
} from '../src/domain/speed-reading';
import { PositionResolver } from '../src/infrastructure/epub/PositionResolver';
import { createLocalStore } from '../src/infrastructure/local-store';
import { ReeditDatabase } from '../src/infrastructure/database';
import { newId } from '../src/domain/model';
import { saveSpeedPreferences } from '../src/services/speed-reading';
import {
  SpeedReadingService,
  initialSpeedSnapshot,
} from '../src/services/speed-reading';
import {
  defaultReaderPreferences,
  type ReaderSession,
} from '../src/domain/reader';

class Clock implements PlaybackClock {
  time = 0;
  private serial = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule(callback: () => void, delay: number) {
    const id = this.serial++;
    this.tasks.set(id, { callback, at: this.time + delay });
    return () => {
      this.tasks.delete(id);
    };
  }
  async next(jitter = 0) {
    const first = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
    if (!first) throw new Error('No timer');
    this.time = first[1].at + jitter;
    this.tasks.delete(first[0]);
    first[1].callback();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
}
function playback(
  clock: Clock,
  duration = 100,
  present?: (index: number) => Promise<void>,
) {
  const shown: number[] = [];
  const errors: unknown[] = [];
  const scheduler = new PlaybackScheduler(
    {
      duration: () => duration,
      next: (index) => (index < 1000 ? index + 1 : null),
      present: async (index) => {
        shown.push(index);
        await present?.(index);
      },
      changed: () => {},
      error: (error) => {
        errors.push(error);
      },
    },
    clock,
  );
  return { scheduler, shown, errors };
}
describe('монотонный планировщик', () => {
  it('не накапливает drift за 1000 слов и не создаёт параллельные таймеры', async () => {
    const clock = new Clock();
    const { scheduler, shown } = playback(clock, 100, () => {
      clock.time += 7;
      return Promise.resolve();
    });
    await scheduler.seek(0);
    scheduler.play();
    scheduler.play();
    for (let i = 1; i <= 1000; i++) {
      expect(clock.tasks.size).toBe(1);
      expect([...clock.tasks.values()][0]?.at).toBe(7 + i * 100);
      await clock.next(3);
    }
    expect(shown).toEqual(Array.from({ length: 1001 }, (_, i) => i));
    await clock.next();
    expect(scheduler.ended).toBe(true);
    expect(clock.tasks.size).toBe(0);
  });
  it('пауза сохраняет остаток интервала и текущее слово', async () => {
    const clock = new Clock();
    const { scheduler, shown } = playback(clock);
    await scheduler.seek(0);
    scheduler.play();
    clock.time = 40;
    scheduler.pause();
    expect(clock.tasks.size).toBe(0);
    clock.time = 5000;
    scheduler.play();
    expect([...clock.tasks.values()][0]?.at).toBe(5060);
    expect(shown).toEqual([0]);
    await clock.next();
    expect(shown).toEqual([0, 1]);
    scheduler.destroy();
    expect(clock.tasks.size).toBe(0);
  });
  it('долгая блокировка останавливает воспроизведение вместо скрытого catch-up', async () => {
    const clock = new Clock();
    const { scheduler, shown } = playback(clock);
    await scheduler.seek(0);
    scheduler.play();
    await clock.next(10000);
    expect(shown).toEqual([0]);
    expect(scheduler.playing).toBe(false);
    expect(clock.tasks.size).toBe(0);
    scheduler.play();
    await clock.next();
    expect(shown).toEqual([0, 1]);
  });
  it('медленный вывод, пауза в полёте и destroy не запускают второй поток', async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = new Clock();
    const { scheduler, shown } = playback(clock, 100, (index) =>
      index === 1 ? pending : Promise.resolve(),
    );
    await scheduler.seek(0);
    scheduler.play();
    await clock.next();
    scheduler.pause();
    scheduler.play();
    expect(clock.tasks.size).toBe(0);
    release();
    await scheduler.drain();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(shown).toEqual([0, 1]);
    scheduler.play();
    expect(clock.tasks.size).toBe(1);
    scheduler.destroy();
    expect(clock.tasks.size).toBe(0);
  });
  it('перемещение не проигрывает пропущенные слова и сбрасывает ended', async () => {
    const clock = new Clock();
    const { scheduler, shown } = playback(clock);
    await scheduler.seek(1000);
    scheduler.play();
    await clock.next();
    expect(scheduler.ended).toBe(true);
    await scheduler.seek(12);
    expect(scheduler.ended).toBe(false);
    scheduler.play();
    await clock.next();
    expect(shown).toEqual([1000, 12, 13]);
  });
});
async function documentFor(
  parts: string[],
): Promise<{ document: SpeedDocument; docs: Document[] }> {
  const docs = parts.map((text) =>
    new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Тест</title></head><body><p>${text}</p></body></html>`,
      'application/xhtml+xml',
    ),
  );
  const index = await buildDocumentTextIndex(
    { id: newId(), sha256: 'a'.repeat(64) },
    docs.map((doc, i) => ({
      spineIndex: i,
      path: `${String(i)}.xhtml`,
      cfiBase: `/6/${String(i * 2 + 2)}`,
      load: () => Promise.resolve(doc),
    })),
    new AbortController().signal,
  );
  return { document: { index, paragraphEnds: {} }, docs };
}
describe('слова, пунктуация и единая позиция', () => {
  it('использует максимальный множитель и не умножает кластеры знаков', async () => {
    const { document } = await documentFor([
      'Слово, длинноеслово?!.. «Хорошо!» Далее — конец.',
    ]);
    const words = Array.from(speedWords(document));
    expect(words.map((word) => word.word)).toEqual([
      'Слово',
      'длинноеслово',
      'Хорошо',
      'Далее',
      'конец',
    ]);
    const p = { ...defaultSpeedPreferences, wpm: 600 };
    expect(words.map((word) => Math.round(wordDuration(word, p)))).toEqual([
      150, 220, 220, 100, 280,
    ]);
    expect(
      wordDuration(
        words.find((word) => word.word === 'длинноеслово') ?? {
          spineIndex: 0,
          start: 0,
          end: 1,
          word: 'ошибка',
          display: 'ошибка',
          sentenceEnd: false,
          paragraphEnd: false,
          comma: false,
        },
        {
          ...p,
          pauses: { ...p.pauses, sentence: 3 },
        },
      ),
    ).toBe(300);
    expect(validSpeedPreferences({ ...p, wpm: 901 })).toBe(false);
    expect(
      validSpeedPreferences({ ...p, pauses: { ...p.pauses, paragraph: NaN } }),
    ).toBe(false);
  });
  it('сокращения, инициалы, кавычки, прямая речь и многоточие не создают лишних предложений', async () => {
    const { document } = await documentFor([
      'В г. Москве жил А. С. Пушкин. — Да… «Верно?!» Он читал т. д. книги.',
    ]);
    const words = Array.from(speedWords(document));
    const ends = words
      .filter((word) => word.sentenceEnd)
      .map((word) => word.word);
    expect(ends).toEqual(['Пушкин', 'Да', 'Верно', 'книги']);
    expect(
      previousSentence(
        words,
        words.findIndex((word) => word.word === 'Он'),
      ),
    ).toBe(words.findIndex((word) => word.word === 'Верно'));
    expect(focusParts('«Ёлка!»').join('')).toBe('«Ёлка!»');
  });
  it('абзацы и spine ограничивают подсветку; пустые разделы не теряют следующие слова', async () => {
    const { document } = await documentFor([
      'Один два три четыре',
      '',
      'Пять шесть',
    ]);
    document.paragraphEnds[0] = [9];
    const words = Array.from(speedWords(document));
    expect(words.map((word) => word.word)).toEqual([
      'Один',
      'два',
      'три',
      'четыре',
      'Пять',
      'шесть',
    ]);
    expect(words[1]?.paragraphEnd).toBe(true);
    expect(frameEnd(words, 0, 12)).toBe(1);
    expect(frameEnd(words, 2, 12)).toBe(3);
    expect(words[4]?.spineIndex).toBe(2);
    expect(speedWordAt(document, words, cursorAt(document.index, 1, 0))).toBe(
      4,
    );
  });
  it('каждое слово в обоих режимах сохраняет точный CFI ↔ cursor, независимо от границ глав', async () => {
    const { document, docs } = await documentFor([
      'Раз <em>два</em> три.',
      'Четыре пять!',
    ]);
    const resolver = new PositionResolver(document.index);
    const words = Array.from(speedWords(document));
    for (const [i, word] of words.entries()) {
      const cursor = cursorAt(
        document.index,
        word.spineIndex,
        word.start,
        'word',
      );
      const doc = docs[word.spineIndex];
      if (!doc) throw new Error('Missing doc');
      expect(speedWordAt(document, words, cursor)).toBe(i);
      expect(
        resolver.fromCfi(resolver.toCfi(cursor, doc), doc, 'word'),
      ).toEqual(cursor);
    }
    expect(
      speedWordAt(document, words, cursorForWord(document.index, 1, 1)),
    ).toBe(4);
  });
});
const databases: ReeditDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
it('настройки скорости сохраняют тему/обычное чтение и переживают reopen без миграции пользовательских данных', async () => {
  const db = new ReeditDatabase(`speed-${newId()}`);
  databases.push(db);
  const store = createLocalStore(db);
  const settings = {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    key: 'local' as const,
    locale: 'ru' as const,
    theme: 'dark' as const,
    reader: { ...defaultReaderPreferences, fontSize: 24 },
  };
  await store.repositories.settings.save(settings);
  await saveSpeedPreferences(store, { ...defaultSpeedPreferences, wpm: 900 });
  db.close();
  await db.open();
  const saved = await store.repositories.settings.get(settings.id);
  expect(saved).toMatchObject({
    theme: 'dark',
    createdAt: 1,
    speed: { wpm: 900 },
    reader: { fontSize: 24 },
  });
  await expect(
    saveSpeedPreferences(store, { ...defaultSpeedPreferences, wpm: 0 }),
  ).rejects.toThrow();
  expect((await store.repositories.settings.get(settings.id))?.speed?.wpm).toBe(
    900,
  );
});

it.each(['rsvp', 'guided'] as const)(
  '%s: вход из общей позиции, один шаг и возврат к последнему слову без переноса на конец окна',
  async (mode) => {
    const { document, docs } = await documentFor([
      'Раз два три четыре.',
      'Пять шесть.',
    ]);
    const db = new ReeditDatabase(`handoff-${newId()}`);
    databases.push(db);
    const store = createLocalStore(db);
    const resolver = new PositionResolver(document.index);
    const initial = cursorForWord(document.index, 0, 1);
    const persisted: number[] = [];
    const returned: number[] = [];
    const flashes: number[] = [];
    const reader: ReaderSession = {
      getSpeedDocument: () => Promise.resolve(document),
      getCursor: () => initial,
      getSelectionCursor: () => null,
      getSelection: () => null,
      getBookmark: () => null,
      setHighlights: () => {},
      setSpeedInteraction: () => {},
      goToSaved: () => Promise.resolve(true),
      next: () => Promise.resolve(true),
      previous: () => Promise.resolve(true),
      goTo: () => Promise.resolve(true),
      setPreferences: () => Promise.resolve(true),
      destroy: () => {},
      clearSpeedRange: () => {},
      showSpeedRange: () => Promise.resolve(),
      flashCursor: (cursor) => {
        flashes.push(cursor.offset);
        return Promise.resolve();
      },
      goToCursor: (cursor) => {
        returned.push(cursor.offset);
        return Promise.resolve(true);
      },
      resolveLocation: (cursor) => {
        const doc = docs[cursor.spineIndex];
        if (!doc) return Promise.reject(new Error('Missing doc'));
        return Promise.resolve({
          cursor,
          cfi: resolver.toCfi(cursor, doc),
          path: `${String(cursor.spineIndex)}.xhtml`,
          spineIndex: cursor.spineIndex,
          chapter: 'Раздел',
          progression: cursor.offset / document.index.totalCharacters,
          atStart: false,
          atEnd: false,
        });
      },
    };
    let snapshot = initialSpeedSnapshot();
    const service = new SpeedReadingService(
      reader,
      store,
      (location) => {
        persisted.push(location.cursor?.offset ?? -1);
        return Promise.resolve();
      },
      (next) => {
        snapshot = next;
      },
    );
    await service.open(mode);
    expect(persisted).toEqual([initial.offset]);
    expect(snapshot.ordinal).toBe(2);
    expect(snapshot.playing).toBe(false);
    await service.seek('forward');
    const last = cursorForWord(document.index, 0, 2);
    expect(snapshot.ordinal).toBe(3);
    await service.stop();
    expect(returned).toEqual([last.offset]);
    expect(flashes).toEqual([last.offset]);
    expect(snapshot.active).toBe(false);
    expect(persisted.at(-1)).toBe(last.offset);
    service.destroy();
  },
);

it('длинное слово без пунктуации получает ровно 1.3, а не паузу предложения', async () => {
  const { document } = await documentFor(['Сверхдлинноеслово затем']);
  const word = Array.from(speedWords(document))[0];
  if (!word) throw new Error('Missing word');
  expect(
    wordDuration(word, { ...defaultSpeedPreferences, wpm: 600 }),
  ).toBeCloseTo(130);
});
