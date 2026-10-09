export type TaskRenderOutcome =
  | { readonly type: 'ready' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'failed'; readonly error: unknown };
export interface TaskTextRender {
  readonly settled: Promise<TaskRenderOutcome>;
  cancel(): void;
}
/** One mount owns every asynchronous text receipt; sealing waits for actual render work. */
export class TaskRenderScope {
  readonly #renders: TaskTextRender[] = [];
  #sealed = false;
  #cancelled = false;
  #failure: Extract<TaskRenderOutcome, { type: 'failed' }> | null = null;
  readonly #signal: AbortSignal;
  readonly #onAbort = (): void => {
    this.cancel();
  };
  constructor(signal: AbortSignal) {
    this.#signal = signal;
    signal.addEventListener('abort', this.#onAbort, { once: true });
    if (signal.aborted) this.cancel();
  }
  track(render: TaskTextRender): void {
    if (this.#cancelled) {
      render.cancel();
      return;
    }
    if (this.#sealed) throw new Error('Task render scope is sealed');
    const safe: TaskTextRender = {
      settled: render.settled.catch((error: unknown) => ({ type: 'failed', error })),
      cancel: () => {
        render.cancel();
      },
    };
    this.#renders.push(safe);
    void safe.settled.then(
      (outcome) => {
        if (outcome.type === 'failed' && this.#failure === null) {
          this.#failure = outcome;
          this.cancel();
        }
      },
      (error: unknown) => {
        this.#failure = { type: 'failed', error };
        this.cancel();
      },
    );
  }
  async finish(): Promise<TaskRenderOutcome> {
    this.#sealed = true;
    const outcomes = await Promise.all(this.#renders.map((render) => render.settled));
    this.#signal.removeEventListener('abort', this.#onAbort);
    this.#renders.length = 0;
    if (this.#failure !== null) return this.#failure;
    if (this.#cancelled || outcomes.some((o) => o.type === 'cancelled'))
      return { type: 'cancelled' };
    return outcomes.find((o) => o.type === 'failed') ?? { type: 'ready' };
  }
  cancel(): void {
    this.#cancelled = true;
    this.#signal.removeEventListener('abort', this.#onAbort);
    for (const render of this.#renders) render.cancel();
  }
}
