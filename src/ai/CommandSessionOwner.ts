import type { ReadTaskTreeV1, TaskTreePageV1 } from '../../api';
import type { CommandSession } from './CommandSession';
import type { CommandPersistenceFailure, CommandSessionStore } from './CommandSessionStore';
import type { HistoricalCommandSession } from './commandRecovery';
import type { CommandStatusInput } from './commandTypes';
import {
  CommandFailure,
  type CommandFocus,
  type CommandJournalPort,
  type CommandNoteReview,
  type CommandRevealRequest,
  type CommandSessionSnapshot,
  type CommandSessionTransitions,
  type CommandSubmissionBasis,
  type CommandTransitionBasis,
  type CommandTransitionDisposition,
} from './commandTypes';

export interface CommandSessionOwnerOptions {
  readonly store: CommandSessionStore;
  readonly createSession: (
    journal: CommandJournalPort,
    transitions: CommandSessionTransitions,
  ) => CommandSession;
  readonly schedule: (callback: () => void) => () => void;
  readonly diagnose?: (code: string) => void;
  readonly notify?: (state: CommandSessionSnapshot) => void;
}
/** One runtime/client across surfaces. Inactive sessions remain detached store records. */
export class CommandSessionOwner {
  private readonly session: CommandSession;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(state: CommandSessionSnapshot) => void>();
  private cancelScheduled: (() => void) | undefined;
  private disposed = false;
  private visible = false;
  private readonly surfaces = new Set<symbol>();
  private changing: Promise<void> | undefined;
  private acceptance = 0;
  private submitted = 0;
  private failureCode: string | undefined;
  private readonly ownedSessions = new Set<string>();
  private readonly noteReviews = new Map<symbol, CommandNoteReview>();
  private stopCapture: (() => void) | undefined;
  claimCapture(stop: () => void): () => void {
    this.stopCapture?.();
    this.stopCapture = stop;
    return () => {
      if (this.stopCapture === stop) this.stopCapture = undefined;
    };
  }
  captureSubmission(): ReturnType<CommandSession['captureSubmission']> {
    const captured = this.session.captureSubmission(),
      generation = this.acceptance;
    return {
      basis: captured.basis,
      current: () => !this.disposed && generation === this.acceptance && captured.current(),
    };
  }
  constructor(private readonly options: CommandSessionOwnerOptions) {
    this.session = options.createSession(
      { save: (state) => this.save(state) },
      {
        start: async (previous, next, current) => {
          this.assertLive();
          await this.save(previous);
          this.assertLive();
          if (!current())
            throw new CommandFailure('CANCELLED', 'Session change stopped. Your work is retained.');
          await options.store.create(next);
          this.ownedSessions.add(next.id);
        },
      },
    );
    this.ownedSessions.add(this.session.snapshot().id);
    this.session.requireNoteReview();
    const active = options.store
      .records()
      .find((record) => record.snapshot.id === options.store.activeId());
    if (active !== undefined) this.session.restore(active.snapshot);
    let initial = true;
    this.unsubscribe = this.session.subscribe(() => {
      if (!initial) this.schedule();
      this.emit();
    });
    initial = false;
  }
  private assertLive(): void {
    if (this.disposed) throw new CommandFailure('CLOSED', 'This session owner has closed.');
  }
  isDisposed(): boolean {
    return this.disposed;
  }
  snapshot(): CommandSessionSnapshot {
    const state = this.session.snapshot(),
      failure = this.persistenceFailure();
    return failure === null
      ? state
      : Object.freeze({
          ...state,
          status: Object.freeze({ kind: 'error' as const, message: failure.message }),
        });
  }
  persistenceFailure(): CommandPersistenceFailure | null {
    return this.options.store.failure();
  }
  subscribe(listener: (state: CommandSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    if (this.disposed) return;
    const failure = this.persistenceFailure();
    if (failure !== null && this.isVisible() && failure.code !== this.failureCode) {
      this.failureCode = failure.code;
      this.options.diagnose?.(failure.code);
    } else if (failure === null) this.failureCode = undefined;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  private isVisible(): boolean {
    return this.visible || this.surfaces.size > 0;
  }
  open(surface?: symbol): CommandSessionSnapshot {
    if (surface === undefined) this.visible = true;
    else this.surfaces.add(surface);
    this.emit();
    return this.snapshot();
  }
  private transition(work: () => Promise<boolean>): Promise<boolean> {
    const pending = (this.changing ?? Promise.resolve()).then(work);
    const settled = pending.then(
      () => {},
      () => {},
    );
    this.changing = settled;
    void settled
      .then(() => {
        if (this.changing === settled) this.changing = undefined;
      })
      .catch(() => {
        this.emit();
      });
    return pending;
  }
  async hide(surface?: symbol): Promise<void> {
    if (this.disposed) return;
    if (surface === undefined) this.visible = false;
    else this.surfaces.delete(surface);
    this.stopCapture?.();
    this.acceptance++;
    await this.flush();
  }
  async stop(): Promise<void> {
    if (this.disposed) return;
    this.submitted++;
    this.acceptance++;
    this.session.cancelTurn();
    await this.flush();
  }
  private schedule(): void {
    if (this.disposed || this.cancelScheduled !== undefined) return;
    this.cancelScheduled = this.options.schedule(() => {
      this.cancelScheduled = undefined;
      void this.flush().catch(() => {
        this.emit();
      });
    });
  }
  private async save(state: CommandSessionSnapshot): Promise<void> {
    this.assertLive();
    try {
      if (this.options.store.activeId() === null) await this.options.store.create(state);
      else await this.options.store.save(state);
    } finally {
      this.emit();
    }
  }
  async flush(): Promise<boolean> {
    if (this.disposed) return false;
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    try {
      await this.save(this.session.snapshot());
      return true;
    } catch {
      this.emit();
      return false;
    }
  }
  updateContext(context: string): void {
    if (!this.disposed) this.session.updateContext(context);
  }
  stageStatus(input: CommandStatusInput): Promise<boolean> {
    const basis = this.session.snapshot(),
      generation = this.acceptance;
    return this.transition(async () => {
      await this.session.settle();
      const current = this.session.snapshot();
      if (
        this.disposed ||
        generation !== this.acceptance ||
        current.id !== basis.id ||
        current.proposal.revision !== basis.proposal.revision
      )
        return false;
      const result = await this.session.stageStatus(input);
      await this.flush();
      return result;
    });
  }
  setInput(text: string): void {
    if (!this.disposed) this.session.setInput(text);
  }
  captureInput(): ReturnType<CommandSession['captureInput']> {
    return this.session.captureInput();
  }
  clearInput(): void {
    if (!this.disposed) this.session.setInput('', false);
  }
  registerNoteReview(review: CommandNoteReview): { token: symbol; dispose(): void } {
    this.assertLive();
    const token = Symbol();
    this.noteReviews.set(token, review);
    return {
      token,
      dispose: () => {
        this.noteReviews.delete(token);
      },
    };
  }
  private noteReview(token?: symbol): CommandNoteReview {
    return (basis) =>
      !this.disposed && token !== undefined && this.noteReviews.get(token)?.(basis) === true;
  }
  async submit(
    text: string,
    basis?: CommandSubmissionBasis,
    surface?: symbol,
    admission?: () => boolean,
  ): Promise<void> {
    const generation = this.acceptance,
      submitted = ++this.submitted;
    if (this.changing !== undefined) await this.changing;
    if (this.isDisposed() || admission?.() === false) return;
    if (generation !== this.acceptance) {
      this.setInput(text);
      await this.flush();
      return;
    }
    await this.session.submit(text, basis, this.noteReview(surface), admission);
    await this.flush();
    this.notifyCompletion(submitted);
  }
  private notifyCompletion(submitted: number): void {
    if (
      !this.disposed &&
      !this.isVisible() &&
      submitted === this.submitted &&
      !['thinking', 'searching', 'writing'].includes(this.snapshot().status.kind)
    )
      this.options.notify?.(this.snapshot());
  }
  confirmAndStart(revision?: number, surface?: symbol): Promise<boolean> {
    const basis = this.session.snapshot(),
      input = this.session.captureInput(),
      generation = this.acceptance,
      expectedRevision = revision ?? basis.proposal.revision;
    const current = (): boolean =>
      !this.disposed &&
      generation === this.acceptance &&
      input.current() &&
      this.session.snapshot().id === basis.id &&
      this.session.snapshot().input.trim() === '';
    return this.transition(async () => {
      const state = this.session.snapshot();
      if (
        !current() ||
        state.proposal.revision !== expectedRevision ||
        !this.canFinishSession(state)
      )
        return false;
      if (
        state.proposal.changes.length > 0 &&
        !(await this.session.confirm(expectedRevision, this.noteReview(surface)))
      ) {
        await this.flush();
        return false;
      }
      await this.flush();
      const next = this.session.snapshot();
      if (!current() || next.proposal.changes.length !== 0 || !this.canFinishSession(next))
        return false;
      this.stopCapture?.();
      return this.startSession();
    });
  }
  private canFinishSession(state: CommandSessionSnapshot): boolean {
    return (
      !state.blocked &&
      state.activeQuestion === null &&
      state.pendingTransition == null &&
      (state.recovery ?? 'live') === 'live' &&
      ['ready', 'saved'].includes(state.status.kind)
    );
  }
  async confirm(revision?: number, surface?: symbol): Promise<boolean> {
    const basis = this.session.snapshot();
    if (this.changing !== undefined) await this.changing;
    if (this.isDisposed() || this.session.snapshot().id !== basis.id) return false;
    const result = await this.session.confirm(
      revision ?? basis.proposal.revision,
      this.noteReview(surface),
    );
    await this.flush();
    return result;
  }
  focus(target: CommandFocus | readonly CommandFocus[]): Promise<boolean> {
    return this.transition(async () => {
      await this.session.settle();
      return this.session.focus(target);
    });
  }
  claimReveal(request: CommandRevealRequest): boolean {
    return !this.disposed && this.session.claimReveal(request);
  }
  acknowledgeReveal(request: CommandRevealRequest, accepted: boolean): boolean {
    return !this.disposed && this.session.acknowledgeReveal(request, accepted);
  }
  readTreePage(query: ReadTaskTreeV1): Promise<TaskTreePageV1> {
    return this.session.readTreePage(query);
  }
  applyStatus(input: { target: string; revision: string; symbol: string }): Promise<boolean> {
    const basis = this.session.snapshot(),
      generation = this.acceptance;
    return this.transition(async () => {
      await this.session.settle();
      const current = this.session.snapshot();
      if (
        this.disposed ||
        generation !== this.acceptance ||
        current.id !== basis.id ||
        current.proposal.revision !== basis.proposal.revision
      )
        return false;
      const result = await this.session.applyStatus(input);
      await this.flush();
      return result;
    });
  }
  recent(): readonly HistoricalCommandSession[] {
    return this.options.store.records();
  }
  newSession(disposition?: 'keep' | 'discard'): Promise<boolean> {
    this.stopCapture?.();
    return this.transition(() => this.startSession(disposition));
  }
  private async startSession(disposition?: 'keep' | 'discard'): Promise<boolean> {
    if (this.disposed) return false;
    const result = await this.session.newSession(disposition);
    this.emit();
    return result;
  }
  select(id: string): Promise<boolean> {
    if (id !== this.session.snapshot().id) this.stopCapture?.();
    const generation = this.acceptance;
    return this.transition(() => this.selectSession(id, generation));
  }
  private async selectSession(id: string, generation: number): Promise<boolean> {
    if (this.disposed) return false;
    await this.session.settle();
    if (id !== this.session.snapshot().id && !this.session.canLeaveUncertainty()) return false;
    if (!(await this.flush()) || this.isDisposed() || generation !== this.acceptance) return false;
    try {
      await this.options.store.select(id);
      return await this.restoreSelection(id);
    } catch {
      this.emit();
      return false;
    }
  }
  private async restoreSelection(id: string): Promise<boolean> {
    if (this.disposed) return false;
    const record = this.recent().find((entry) => entry.snapshot.id === id);
    if (record === undefined) return false;
    if (!this.session.restore(record.snapshot)) {
      await this.options.store.create(this.session.snapshot());
      return false;
    }
    if (this.ownedSessions.has(id)) await this.session.resumeOwned();
    return this.session.snapshot().id === id && this.options.store.activeId() === id;
  }
  review(): Promise<boolean> {
    return this.transition(() => this.reviewSession());
  }
  private async reviewSession(): Promise<boolean> {
    await this.session.settle();
    if (this.disposed || !(await this.flush())) return false;
    return this.session.beginReview();
  }
  acknowledgeUncertainty(): Promise<boolean> {
    return this.transition(async () => {
      if (this.disposed || !this.snapshot().blocked) return false;
      return this.session.newSession('keep', undefined, true);
    });
  }
  resolveTransition(
    disposition: CommandTransitionDisposition,
    basis?: CommandTransitionBasis,
    surface?: symbol,
  ): Promise<boolean> {
    const expected = basis ?? this.transitionBasis();
    if (expected === undefined) return Promise.resolve(false);
    return this.transition(() =>
      this.session.resolveTransition(disposition, undefined, expected, this.noteReview(surface)),
    );
  }
  private transitionBasis(): CommandTransitionBasis | undefined {
    const state = this.session.snapshot();
    if (state.pendingTransition == null) return undefined;
    return {
      sessionId: state.id,
      proposalRevision: state.proposal.revision,
      pendingTransition: state.pendingTransition,
    };
  }
  async clearCompleted(): Promise<boolean> {
    if (!(await this.flush())) return false;
    try {
      await this.options.store.clearCompleted();
      this.emit();
      return true;
    } catch {
      this.emit();
      return false;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.stopCapture?.();
    this.session.cancelTurn();
    // Host storage is synchronous: this flush crosses its boundary before revocation.
    void this.flush().catch(() => {
      this.emit();
    });
    this.disposed = true;
    this.noteReviews.clear();
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    this.unsubscribe();
    this.listeners.clear();
    this.session.dispose();
  }
}
