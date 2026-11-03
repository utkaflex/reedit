import type { ReaderLocation, ReaderSession } from '../domain/reader';
import type { LocalStore } from '../domain/repositories';
import { newId } from '../domain/model';
import { cursorAt, type ReadingCursor } from '../domain/text-position';
import {
  defaultSpeedPreferences,
  validSpeedPreferences,
  speedWords,
  speedWordAt,
  frameEnd,
  previousSentence,
  wordDuration,
  type SpeedPreferences,
  type SpeedDocument,
  type SpeedWord,
} from '../domain/speed-reading';
import { PlaybackScheduler } from './playback-scheduler';
import { loadAppearance } from './appearance';

export type SpeedMode = 'rsvp' | 'guided';
export interface SpeedSnapshot {
  active: boolean;
  mode: SpeedMode;
  preparing: boolean;
  busy: boolean;
  playing: boolean;
  ended: boolean;
  word: string;
  ordinal: number;
  total: number;
  preferences: SpeedPreferences;
  error: string;
}
export const initialSpeedSnapshot = (): SpeedSnapshot => ({
  active: false,
  mode: 'rsvp',
  preparing: false,
  busy: false,
  playing: false,
  ended: false,
  word: '',
  ordinal: 0,
  total: 0,
  preferences: structuredClone(defaultSpeedPreferences),
  error: '',
});
export async function saveSpeedPreferences(
  store: LocalStore,
  speed: SpeedPreferences,
): Promise<void> {
  if (!validSpeedPreferences(speed))
    throw new Error('Некорректные настройки скорочтения.');
  const current = await loadAppearance(store.repositories.settings);
  const now = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);
  await store.repositories.settings.save(
    current
      ? { ...current, speed, updatedAt: now }
      : {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          key: 'local',
          locale: 'ru',
          theme: 'system',
          speed,
        },
    { expectedUpdatedAt: current?.updatedAt ?? null },
  );
}
/** Owns mode handoff and processed positions; neither React nor the timer interprets EPUB CFI. */
export class SpeedReadingService {
  private snapshot = initialSpeedSnapshot();
  private document: SpeedDocument | null = null;
  private words: SpeedWord[] = [];
  private scheduler: PlaybackScheduler | null = null;
  private cursor: ReadingCursor | null = null;
  private disposed = false;
  private generation = 0;
  private changing = false;
  private isCancelled(generation = this.generation): boolean {
    return this.disposed || generation !== this.generation;
  }
  private isHidden(): boolean {
    return document.visibilityState === 'hidden';
  }
  private isActive(): boolean {
    return this.snapshot.active;
  }
  constructor(
    private reader: ReaderSession,
    private store: LocalStore,
    private onPosition: (location: ReaderLocation) => Promise<void>,
    private changed: (snapshot: SpeedSnapshot) => void,
    private completed?: (
      mode: SpeedMode,
      start: ReadingCursor,
      end: ReadingCursor,
    ) => void,
  ) {}
  private async change(action: () => Promise<void>): Promise<void> {
    if (this.changing || this.disposed) return;
    this.changing = true;
    try {
      await action();
    } finally {
      this.changing = false;
    }
  }
  private emit(): void {
    if (!this.disposed)
      this.changed({
        ...this.snapshot,
        playing: this.scheduler?.playing ?? false,
        ended: this.scheduler?.ended ?? false,
      });
  }
  private count(): number {
    return this.snapshot.mode === 'guided'
      ? this.snapshot.preferences.guidedWords
      : 1;
  }
  private end(index: number): number {
    return frameEnd(this.words, index, this.count());
  }
  private wordCursor(index: number, end = false): ReadingCursor {
    const word = this.words[index];
    if (!word || !this.document)
      throw new Error('Слово отсутствует в индексе.');
    return cursorAt(
      this.document.index,
      word.spineIndex,
      end ? word.end : word.start,
      'word',
    );
  }
  private async persist(): Promise<void> {
    if (this.cursor && !this.disposed) {
      const location = await this.reader.resolveLocation(this.cursor);
      if (!this.isCancelled()) await this.onPosition(location);
    }
  }
  private async present(index: number): Promise<void> {
    if (!this.snapshot.active || this.disposed) return;
    if (this.isHidden())
      throw new Error(
        'Приложение скрыто. Продолжите чтение после возвращения.',
      );
    const end = this.end(index);
    this.snapshot.busy = true;
    this.emit();
    try {
      if (this.snapshot.mode === 'guided')
        await this.reader.showSpeedRange(
          this.wordCursor(index),
          this.wordCursor(end, true),
        );
      if (this.isCancelled() || !this.isActive()) return;
      if (this.isHidden())
        throw new Error(
          'Приложение скрыто. Продолжите чтение после возвращения.',
        );
      this.cursor = this.wordCursor(index);
      this.snapshot.word = this.words
        .slice(index, end + 1)
        .map((word) => word.display)
        .join(' ');
      this.snapshot.ordinal = index + 1;
      this.emit();
      await this.persist();
    } finally {
      this.snapshot.busy = false;
      this.emit();
    }
  }
  async open(mode: SpeedMode): Promise<void> {
    if (this.snapshot.active || this.disposed) return;
    const cursor = this.reader.getSelectionCursor() ?? this.reader.getCursor();
    if (!cursor) throw new Error('Дождитесь загрузки позиции.');
    this.cursor = null;
    this.reader.clearSpeedRange();
    this.reader.setSpeedInteraction(() => {
      this.pause();
    });
    const generation = ++this.generation;
    this.snapshot = {
      ...this.snapshot,
      active: true,
      mode,
      preparing: true,
      error: '',
      word: '',
      ordinal: 0,
    };
    this.emit();
    try {
      const settings = await loadAppearance(this.store.repositories.settings);
      if (this.isCancelled(generation)) return;
      if (settings?.speed && validSpeedPreferences(settings.speed))
        this.snapshot.preferences = structuredClone(settings.speed);
      if (!this.document) {
        const source = await this.reader.getSpeedDocument();
        const words: SpeedWord[] = [];
        for (const word of speedWords(source)) {
          words.push(word);
          if (words.length % 1000 === 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (this.isCancelled(generation)) return;
          }
        }
        this.document = source;
        this.words = words;
      }
      if (this.isCancelled(generation)) return;
      if (!this.words.length) throw new Error('В книге нет читаемых слов.');
      this.snapshot.total = this.words.length;
      this.reader.setSpeedInteraction(() => {
        this.pause();
      });
      this.scheduler = new PlaybackScheduler({
        completed: (ordinal) => {
          const word = this.words[ordinal];
          const index = this.document?.index;
          if (word && index && !this.isHidden())
            this.completed?.(
              this.snapshot.mode,
              cursorAt(index, word.spineIndex, word.start, 'word'),
              cursorAt(index, word.spineIndex, word.end, 'word'),
            );
        },
        next: (index) => (index + 1 < this.words.length ? index + 1 : null),
        duration: (index) => {
          const word = this.words[index];
          return word ? wordDuration(word, this.snapshot.preferences) : 0;
        },
        present: (index) => this.present(index),
        changed: () => {
          this.emit();
        },
        error: (reason) => {
          this.snapshot.error =
            reason instanceof Error
              ? reason.message
              : 'Не удалось продолжить чтение.';
          this.emit();
        },
      });
      await this.scheduler.seek(speedWordAt(this.document, this.words, cursor));
    } catch (reason) {
      this.snapshot.error =
        reason instanceof Error
          ? reason.message
          : 'Не удалось подготовить скорочтение.';
    } finally {
      if (generation === this.generation) {
        this.snapshot.preparing = false;
        this.emit();
      }
    }
  }
  pause(): void {
    this.scheduler?.pause();
  }
  async play(): Promise<void> {
    return this.change(async () => {
      if (
        !this.scheduler ||
        this.snapshot.busy ||
        this.snapshot.preparing ||
        this.disposed ||
        this.isHidden()
      )
        return;
      if (this.snapshot.error) {
        this.snapshot.error = '';
        await this.scheduler.seek(this.scheduler.index);
      }
      this.scheduler.play();
    });
  }
  async seek(direction: 'back' | 'forward' | 'sentence'): Promise<void> {
    return this.change(async () => {
      if (!this.scheduler || this.snapshot.busy || this.snapshot.preparing)
        return;
      this.pause();
      this.snapshot.error = '';
      const current = this.scheduler.index;
      const next =
        direction === 'sentence'
          ? previousSentence(this.words, current)
          : direction === 'forward'
            ? current + 1
            : current - 1;
      await this.scheduler.seek(
        Math.max(0, Math.min(this.words.length - 1, next)),
      );
    });
  }
  async configure(preferences: SpeedPreferences): Promise<void> {
    return this.change(async () => {
      if (
        !validSpeedPreferences(preferences) ||
        this.snapshot.preparing ||
        this.snapshot.busy
      )
        return;
      this.pause();
      await saveSpeedPreferences(this.store, preferences);
      this.snapshot.preferences = structuredClone(preferences);
      if (this.scheduler) await this.scheduler.seek(this.scheduler.index);
      this.emit();
    });
  }
  async stop(): Promise<void> {
    return this.change(async () => {
      this.pause();
      if (this.snapshot.preparing) {
        this.generation++;
        this.snapshot.preparing = false;
      }
      await this.scheduler?.drain();
      await this.persist();
      if (this.cursor) {
        await this.reader.showSpeedRange(
          this.cursor,
          this.wordCursor(Math.max(0, this.snapshot.ordinal - 1), true),
        );
        if (!(await this.reader.goToCursor(this.cursor)))
          throw new Error('Дождитесь завершения перехода и повторите возврат.');
        await this.reader.flashCursor(this.cursor);
      }
      this.scheduler?.destroy();
      this.scheduler = null;
      this.reader.setSpeedInteraction(null);
      this.snapshot.active = false;
      this.snapshot.error = '';
      this.emit();
    });
  }
  reportError(reason: unknown): void {
    this.pause();
    this.snapshot.error =
      reason instanceof Error
        ? reason.message
        : 'Не удалось выполнить действие.';
    this.emit();
  }
  destroy(): void {
    this.disposed = true;
    this.generation++;
    this.scheduler?.destroy();
    this.reader.setSpeedInteraction(null);
    this.reader.clearSpeedRange();
  }
}
