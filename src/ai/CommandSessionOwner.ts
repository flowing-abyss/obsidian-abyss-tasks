import type { ReadTaskTreeV1, TaskTreePageV1 } from '../../api';
import type { CommandSession } from './CommandSession';
import type { CommandPersistenceFailure, CommandSessionStore } from './CommandSessionStore';
import type { HistoricalCommandSession } from './commandRecovery';
import {
  CommandFailure,
  type CommandFocus,
  type CommandJournalPort,
  type CommandSessionSnapshot,
  type CommandSessionTransitions,
  type CommandSubmissionBasis,
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
}
/** One runtime/client across surfaces. Inactive sessions remain detached store records. */
export class CommandSessionOwner {
  private readonly session: CommandSession;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(state: CommandSessionSnapshot) => void>();
  private cancelScheduled: (() => void) | undefined;
  private disposed = false;
  private visible = false;
  private changing: Promise<void> | undefined;
  private acceptance = 0;
  private failureCode: string | undefined;
  private readonly ownedSessions = new Set<string>();
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
    if (failure !== null && this.visible && failure.code !== this.failureCode) {
      this.failureCode = failure.code;
      this.options.diagnose?.(failure.code);
    } else if (failure === null) this.failureCode = undefined;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  open(): CommandSessionSnapshot {
    this.visible = true;
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
  async hide(): Promise<void> {
    if (this.disposed) return;
    this.visible = false;
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
  setInput(text: string): void {
    if (!this.disposed) this.session.setInput(text);
  }
  async submit(text: string, basis?: CommandSubmissionBasis): Promise<void> {
    const generation = this.acceptance;
    if (this.changing !== undefined) await this.changing;
    if (this.isDisposed()) return;
    if (generation !== this.acceptance) {
      this.session.setInput(text);
      await this.flush();
      return;
    }
    await this.session.submit(text, basis);
    await this.flush();
  }
  async confirm(revision?: number): Promise<boolean> {
    const basis = this.session.snapshot();
    if (this.changing !== undefined) await this.changing;
    if (this.isDisposed() || this.session.snapshot().id !== basis.id) return false;
    const result = await this.session.confirm(revision ?? basis.proposal.revision);
    await this.flush();
    return result;
  }
  focus(target: CommandFocus | readonly CommandFocus[]): Promise<boolean> {
    return this.transition(async () => {
      await this.session.settle();
      return this.session.focus(target);
    });
  }
  readTreePage(query: ReadTaskTreeV1): Promise<TaskTreePageV1> {
    return this.session.readTreePage(query);
  }
  applyStatus(input: { target: string; revision: string; symbol: string }): Promise<boolean> {
    return this.session.applyStatus(input);
  }
  recent(): readonly HistoricalCommandSession[] {
    return this.options.store.records();
  }
  newSession(disposition?: 'keep' | 'discard'): Promise<boolean> {
    return this.transition(() => this.startSession(disposition));
  }
  private async startSession(disposition?: 'keep' | 'discard'): Promise<boolean> {
    if (this.disposed) return false;
    const result = await this.session.newSession(disposition);
    this.emit();
    return result;
  }
  select(id: string): Promise<boolean> {
    return this.transition(() => this.selectSession(id));
  }
  private async selectSession(id: string): Promise<boolean> {
    if (this.disposed) return false;
    await this.session.settle();
    if (!(await this.flush()) || this.isDisposed()) return false;
    try {
      await this.options.store.select(id);
      if (this.isDisposed()) return false;
      const record = this.recent().find((entry) => entry.snapshot.id === id);
      if (record === undefined) return false;
      this.session.restore(record.snapshot);
      if (this.ownedSessions.has(id)) await this.session.resumeOwned();
      return true;
    } catch {
      this.emit();
      return false;
    }
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
  resolveTransition(disposition: CommandTransitionDisposition): Promise<boolean> {
    return this.transition(() => this.session.resolveTransition(disposition));
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
    this.session.cancelTurn();
    // Host storage is synchronous: this flush crosses its boundary before revocation.
    void this.flush().catch(() => {
      this.emit();
    });
    this.disposed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    this.unsubscribe();
    this.listeners.clear();
    this.session.dispose();
  }
}
