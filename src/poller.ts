// Fixed-interval polling loop with no overlapping ticks. Polling is the reliable baseline;
// a filesystem watcher could later call `trigger()` to refresh sooner.

export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private stopped = true;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly intervalMs: () => number,
    private readonly onError: (e: unknown) => void = () => {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Runs a tick now (or right after the current one finishes). */
  trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    void this.run();
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.tick();
      } while (this.rerun && !this.stopped);
    } catch (e) {
      this.onError(e);
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.run(), Math.max(250, this.intervalMs()));
    }
  }
}
