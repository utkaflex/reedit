export interface PlaybackClock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}
export const monotonicClock: PlaybackClock = {
  now: () => performance.now(),
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => {
      clearTimeout(timer);
    };
  },
};
/** One timer, one in-flight frame; deadlines advance from their previous deadline, not callback completion. */
export class PlaybackScheduler {
  index = 0;
  playing = false;
  ended = false;
  private disposed = false;
  private isPlaying(): boolean {
    return this.playing && !this.disposed;
  }
  private cancel: (() => void) | null = null;
  private pending: Promise<void> | null = null;
  private deadline = 0;
  private remaining = 0;
  constructor(
    private options: {
      duration(index: number): number;
      next(index: number): number | null;
      present(index: number): Promise<void>;
      completed?(index: number): void;
      changed(): void;
      error(error: unknown): void;
    },
    private clock: PlaybackClock = monotonicClock,
  ) {}
  async seek(index: number): Promise<void> {
    this.pause();
    await this.drain();
    if (this.disposed) return;
    this.index = index;
    this.ended = false;
    this.remaining = this.options.duration(index);
    this.pending = this.options.present(index);
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
    this.options.changed();
  }
  play(): void {
    if (this.disposed || this.playing || this.ended || this.pending) return;
    this.playing = true;
    this.deadline = this.clock.now() + this.remaining;
    this.options.changed();
    this.arm();
  }
  pause(): void {
    if (this.playing)
      this.remaining = Math.max(0, this.deadline - this.clock.now());
    this.playing = false;
    this.cancel?.();
    this.cancel = null;
    this.options.changed();
  }
  private arm(): void {
    if (!this.playing || this.disposed) return;
    this.cancel?.();
    this.cancel = this.clock.schedule(
      () => {
        this.cancel = null;
        void this.tick();
      },
      Math.max(0, this.deadline - this.clock.now()),
    );
  }
  private async tick(): Promise<void> {
    if (!this.playing || this.disposed) return;
    // A suspended/throttled tab must never catch up by racing through unseen words.
    if (this.clock.now() - this.deadline > 1000) {
      this.pause();
      this.remaining = this.options.duration(this.index);
      return;
    }
    this.options.completed?.(this.index);
    const next = this.options.next(this.index);
    if (next === null) {
      this.pause();
      this.ended = true;
      this.options.changed();
      return;
    }
    this.index = next;
    const duration = this.options.duration(next);
    this.deadline += duration;
    this.remaining = duration;
    this.pending = this.options.present(next);
    try {
      await this.pending;
      if (this.isPlaying() && this.clock.now() >= this.deadline)
        this.deadline = this.clock.now() + duration;
    } catch (error) {
      this.pause();
      this.options.error(error);
    } finally {
      this.pending = null;
    }
    this.arm();
  }
  async drain(): Promise<void> {
    await this.pending;
  }
  destroy(): void {
    this.disposed = true;
    this.pause();
  }
}
