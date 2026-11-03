/** Drop re-entrant commands, never queue multiple page turns from one gesture/click. */
export class ReaderNavigationGate {
  private active = false;
  private destroyed = false;
  async run(action: () => Promise<void>, pageTurn = false): Promise<boolean> {
    if (this.active || this.destroyed) return false;
    this.active = true;
    const started = performance.now();
    try {
      await action();
      return !this.destroyed;
    } finally {
      if (pageTurn) {
        const remaining = 160 - (performance.now() - started);
        if (remaining > 0)
          await new Promise<void>((resolve) => {
            setTimeout(resolve, remaining);
          });
      }
      this.active = false;
    }
  }
  destroy() {
    this.destroyed = true;
  }
  get busy(): boolean {
    return this.active;
  }
}
