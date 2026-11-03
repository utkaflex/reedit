import { newId, type Id, type ReadingSession } from '../domain/model';
import type { LocalStore } from '../domain/repositories';
import type {
  ReadingActivity,
  ReadingMode,
  WordInterval,
} from '../domain/statistics';

export interface ActivityClock {
  utc(): number;
  monotonic(): number;
}
const clock: ActivityClock = {
  utc: () => Date.now(),
  monotonic: () => performance.now(),
};
/** Serial writer, immutable event UUIDs on retries and exclusive cross-tab lease. */
export class ReadingActivityService {
  private ownerId = newId();
  private session: ReadingSession | null = null;
  private tail: Promise<void> = Promise.resolve();
  private previous: {
    utc: number;
    mono: number;
    mode: ReadingMode | null;
  } | null = null;
  private pending: ReadingActivity | null = null;
  private failure = false;
  private blocked = false;
  private buffer: {
    from: number;
    to: number;
    milliseconds: number;
    intervals: WordInterval[];
  } | null = null;
  constructor(
    private store: LocalStore,
    private readingId: Id,
    private fileId: Id,
    private report: (message: string | null) => void,
    private time: ActivityClock = clock,
  ) {}
  private enqueue(action: () => Promise<void>): Promise<void> {
    const job = this.tail.then(async () => {
      if (this.pending) {
        await this.store.commitActivity(this.pending, this.ownerId);
        this.session = this.session
          ? {
              ...this.session,
              endedAt: this.pending.to,
              leaseUntil: this.pending.to + 15000,
            }
          : null;
        this.pending = null;
      }
      await action();
      if (this.failure) {
        this.failure = false;
        this.report(null);
      }
    });
    this.tail = job.catch((error: unknown) => {
      this.previous = null;
      this.failure = true;
      this.report(
        `Статистика не сохранена: ${error instanceof Error ? error.message : 'ошибка записи'}. Повторите сохранение или откройте книгу снова.`,
      );
    });
    return job;
  }
  private async write(
    from: number,
    to: number,
    milliseconds: number,
    intervals: WordInterval[],
  ): Promise<void> {
    const session = this.session;
    if (!session?.mode || !session.contentId || !session.textVersion) return;
    const now = Math.max(to, session.updatedAt);
    this.pending = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      readingId: this.readingId,
      sessionId: session.id,
      contentId: session.contentId,
      textVersion: session.textVersion,
      mode: session.mode,
      from,
      to,
      milliseconds,
      intervals,
    };
    await this.store.commitActivity(this.pending, this.ownerId);
    this.pending = null;
    this.session = { ...session, endedAt: to, leaseUntil: to + 15000 };
  }
  private async sample(
    mode: ReadingMode | null,
    utc: number,
    mono: number,
  ): Promise<void> {
    const previous = this.previous;
    this.previous = { utc, mono, mode };
    if (this.session && previous && previous.mode === this.session.mode) {
      const elapsed = mono - previous.mono;
      const wall = utc - previous.utc;
      // Never infer time across throttling, clock changes or an unobserved suspension.
      if (
        elapsed > 0 &&
        elapsed <= 2500 &&
        wall > 0 &&
        Math.abs(wall - elapsed) < 250
      ) {
        const from = Math.max(
          previous.utc,
          this.session.endedAt,
          this.buffer?.to ?? 0,
        );
        if (utc > from) {
          this.buffer ??= { from, to: from, milliseconds: 0, intervals: [] };
          this.buffer.to = utc;
          this.buffer.milliseconds += Math.min(elapsed, utc - from);
        }
      } else if (elapsed > 2500 || wall < 0 || Math.abs(wall - elapsed) >= 250)
        await this.flushBuffer();
    }
    if (
      this.buffer &&
      (this.buffer.to - this.buffer.from >= 5000 ||
        this.buffer.intervals.length >= 100)
    )
      await this.flushBuffer();
    if (
      this.session &&
      (mode !== this.session.mode ||
        utc > (this.session.leaseUntil ?? 0) ||
        utc < this.session.endedAt)
    ) {
      await this.flushBuffer();
      await this.store.releaseActivity(this.session.id, this.ownerId);
      this.session = null;
    }
    if (mode && !this.session) {
      this.session = await this.store.claimActivity({
        readingId: this.readingId,
        fileId: this.fileId,
        ownerId: this.ownerId,
        mode,
        now: utc,
      });
      if (!this.session && !this.blocked) {
        this.blocked = true;
        this.report(
          'Учёт чтения активен в другой вкладке. Здесь он возобновится после её паузы.',
        );
      } else if (this.session && this.blocked) {
        this.blocked = false;
        this.report(null);
      }
    }
  }
  pulse(mode: ReadingMode | null): Promise<void> {
    const utc = this.time.utc(),
      mono = this.time.monotonic();
    return this.enqueue(() => this.sample(mode, utc, mono));
  }
  record(mode: ReadingMode, interval: WordInterval): Promise<void> {
    const utc = this.time.utc(),
      mono = this.time.monotonic();
    return this.enqueue(async () => {
      await this.sample(mode, utc, mono);
      if (this.session?.mode === mode) {
        this.buffer ??= { from: utc, to: utc, milliseconds: 0, intervals: [] };
        this.buffer.intervals.push(interval);
      }
    });
  }
  async pause(): Promise<void> {
    await this.pulse(null);
  }
  private async flushBuffer(): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) return;
    this.buffer = null;
    await this.write(
      buffer.from,
      buffer.to,
      buffer.milliseconds,
      buffer.intervals,
    );
  }
  async flush(): Promise<void> {
    await this.enqueue(() => this.flushBuffer());
  }
}
