/** A real owner-window task yield; disposal releases canceled model waiters as well as ports. */
export class StatisticsWorkScheduler {
  private channel_abyssPrivate: MessageChannel | undefined;
  private readonly pending_abyssPrivate = new Set<() => void>();
  private timer_abyssPrivate: number | undefined;
  private disposed_abyssPrivate = false;
  constructor(private readonly owner_abyssPrivate: Window) {
    const Channel = Reflect.get(owner_abyssPrivate, 'MessageChannel') as
      typeof MessageChannel | undefined;
    if (Channel !== undefined) {
      this.channel_abyssPrivate = new Channel();
      this.channel_abyssPrivate.port1.onmessage = () => {
        this.flush_abyssPrivate();
      };
    }
  }
  readonly yieldControl = (): Promise<void> => {
    if (this.disposed_abyssPrivate) return Promise.resolve();
    return new Promise((resolve) => {
      this.pending_abyssPrivate.add(resolve);
      if (this.pending_abyssPrivate.size !== 1) return;
      if (this.channel_abyssPrivate !== undefined)
        this.channel_abyssPrivate.port2.postMessage(null);
      else
        this.timer_abyssPrivate = this.owner_abyssPrivate.setTimeout(() => {
          this.flush_abyssPrivate();
        }, 0);
    });
  };
  private flush_abyssPrivate(): void {
    this.timer_abyssPrivate = undefined;
    const pending = [...this.pending_abyssPrivate];
    this.pending_abyssPrivate.clear();
    for (const resolve of pending) resolve();
  }
  destroy(): void {
    this.disposed_abyssPrivate = true;
    if (this.timer_abyssPrivate !== undefined)
      this.owner_abyssPrivate.clearTimeout(this.timer_abyssPrivate);
    this.channel_abyssPrivate?.port1.close();
    this.channel_abyssPrivate?.port2.close();
    this.channel_abyssPrivate = undefined;
    this.flush_abyssPrivate();
  }
}
