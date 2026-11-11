export interface CommandElapsedMemory {
  progress?: { readonly key: string; readonly startedAt: number };
}

/** View-local ticker; the start survives hiding Q while its owner keeps working. */
export class CommandElapsedTime {
  private timer: number | undefined;
  constructor(
    private readonly element: HTMLElement,
    private readonly memory: CommandElapsedMemory,
  ) {
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
  }
  update(key: string, busy: boolean): void {
    if (!busy) {
      this.dispose();
      delete this.memory.progress;
      this.element.hidden = true;
      this.element.textContent = '';
      return;
    }
    if (this.memory.progress?.key !== key) this.memory.progress = { key, startedAt: Date.now() };
    this.element.hidden = false;
    this.paint();
    this.timer ??= this.element.win.setInterval(() => {
      this.paint();
    }, 1000);
  }
  private paint(): void {
    const start = this.memory.progress?.startedAt;
    if (start === undefined) return;
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    this.element.textContent =
      seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  dispose(): void {
    this.element.win.clearInterval(this.timer);
    this.timer = undefined;
  }
}
