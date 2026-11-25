/** A single damped motion that keeps its velocity when the next line arrives. */
export class GuidedScroll {
  private state: {
    container: HTMLElement;
    target: number;
    position: number;
    velocity: number;
    frequency: number;
    travelDuration: number;
    applied: number;
    time: number;
  } | null = null;
  private frame = 0;

  constructor(private onScroll: () => void) {}

  get moving(): boolean {
    return this.frame !== 0;
  }

  moveTo(
    container: HTMLElement,
    target: number,
    wpm: number,
    instant: boolean,
  ): void {
    if (instant) {
      this.stop();
      if (Math.abs(container.scrollTop - target) > 3) {
        container.scrollTop = target;
        this.onScroll();
      }
      return;
    }
    if (this.state?.container !== container) this.stop();
    const scroll = container.scrollTop;
    const state = this.state ?? {
      container,
      target: scroll,
      position: scroll,
      velocity: 0,
      frequency: 0,
      travelDuration: 0,
      applied: scroll,
      time: performance.now(),
    };
    this.rebase(state);
    const duration = Math.max(85, Math.min(295, 52_000 / wpm));
    if (Math.abs(state.target - target) > 3) {
      state.target = target;
      // Give chapter headings and blank lines more time without changing velocity.
      state.travelDuration = Math.min(
        430,
        Math.abs(target - state.position) * 3.2,
      );
    }
    state.frequency = 6 / Math.max(duration, state.travelDuration);
    this.state = state;
    if (!this.frame && Math.abs(state.target - state.position) > 1) {
      state.time = performance.now();
      this.frame = requestAnimationFrame(this.advance);
    }
  }

  private rebase(state: NonNullable<GuidedScroll['state']>): void {
    // The continuous EPUB manager compensates when adding/removing views above us.
    const nativeOffset = state.container.scrollTop - state.applied;
    state.position += nativeOffset;
    state.target += nativeOffset;
    state.applied = state.container.scrollTop;
  }

  private advance = (now: number) => {
    const state = this.state;
    if (!state) return;
    this.frame = 0;
    if (!state.container.isConnected) {
      this.stop();
      return;
    }
    this.rebase(state);
    const { container, target, frequency } = state;
    const elapsed = Math.max(0, Math.min(32, now - state.time));
    const distance = state.position - target;
    const rate = state.velocity + frequency * distance;
    const decay = Math.exp(-frequency * elapsed);
    state.position = target + (distance + rate * elapsed) * decay;
    state.velocity = (state.velocity - frequency * rate * elapsed) * decay;
    state.time = now;
    const settled =
      Math.abs(state.position - target) <= 1 &&
      Math.abs(state.velocity) < 0.025;
    if (settled) {
      state.position = target;
      state.velocity = 0;
    }
    container.scrollTop = state.position;
    state.applied = container.scrollTop;
    this.onScroll();
    if (!settled) this.frame = requestAnimationFrame(this.advance);
  };

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.state = null;
  }
}
