import type { ReadTaskTreeV1, TaskTreePageV1 } from '../../api';
import { commandMessage } from './commandMessages';
import { hasUnresolvedCommandWrites, type HistoricalCommandSession } from './commandRecovery';
import type { CommandSession } from './CommandSession';
import type { CommandPersistenceFailure, CommandSessionStore } from './CommandSessionStore';
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
interface SubmissionSurface {
  readonly noteReview: symbol | undefined;
  readonly visibility: symbol | undefined;
}
interface CaptureClaim {
  readonly visibility: symbol;
  stop(): void;
  workChanged(): void;
  awaitingTranscript(): boolean;
  continuous(): boolean;
}
interface QueuedVoice {
  readonly text: string;
  readonly basis: CommandSubmissionBasis;
  readonly surface: symbol | undefined;
  readonly visibility: symbol | undefined;
  readonly admission: () => boolean;
  readonly sessionId: string;
  resolve(accepted: boolean): void;
}
/** One runtime/client across surfaces. Inactive sessions remain detached store records. */
export class CommandSessionOwner {
  private readonly session: CommandSession;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(state: CommandSessionSnapshot) => void>();
  private cancelScheduled: (() => void) | undefined;
  private disposed = false;
  private retirement: Promise<void> | undefined;
  private visible = false;
  private readonly surfaces = new Map<symbol, object>();
  private changing: Promise<void> | undefined;
  private pendingWork = 0;
  private acceptance = 0;
  private interaction = 0;
  private readonly voiceQueue: QueuedVoice[] = [];
  private drainingVoice = false;
  private submitted = 0;
  private failureCode: string | undefined;
  private readonly ownedSessions = new Set<string>();
  private readonly noteReviews = new Map<symbol, CommandNoteReview>();
  private captureClaim: CaptureClaim | undefined;
  private preferenceOrigin: symbol | undefined;
  private voiceTurn: { readonly visibility: symbol | undefined } | undefined;
  claimCapture(claim: CaptureClaim): () => void {
    this.stopCapture();
    this.captureClaim = claim;
    return () => {
      if (this.captureClaim === claim) this.captureClaim = undefined;
    };
  }
  private stopCapture(visibility?: symbol): void {
    const claim = this.captureClaim;
    if (claim !== undefined && (visibility === undefined || claim.visibility === visibility))
      claim.stop();
  }
  canStartManual(visibility: symbol): boolean {
    const claim = this.captureClaim;
    return claim === undefined || claim.visibility === visibility || !claim.continuous();
  }
  canStartContinuous(visibility: symbol, replace: boolean): boolean {
    const claim = this.captureClaim;
    return (
      claim === undefined ||
      claim.visibility === visibility ||
      (replace && !this.commandPending() && !claim.awaitingTranscript())
    );
  }
  followsVoicePreference(visibility: symbol): boolean {
    if (!this.surfaces.has(visibility)) return false;
    return this.captureClaim === undefined
      ? (this.preferenceOrigin ?? this.voiceTurn?.visibility) === visibility
      : this.captureClaim.visibility === visibility;
  }
  captureSubmission(visibility?: symbol): ReturnType<CommandSession['captureSubmission']> & {
    continuationCurrent(): boolean;
  } {
    const captured = this.session.captureSubmission(),
      generation = this.acceptance,
      interaction = this.interaction,
      visible = this.captureVisibility(visibility);
    return {
      continuationCurrent: () =>
        !this.disposed &&
        visible() &&
        generation === this.acceptance &&
        interaction === this.interaction &&
        captured.basis.sessionId === this.session.snapshot().id,
      basis: captured.basis,
      current: () =>
        !this.disposed && visible() && generation === this.acceptance && captured.current(),
    };
  }
  private captureVisibility(visibility?: symbol): () => boolean {
    const scope = visibility === undefined ? undefined : this.surfaces.get(visibility);
    return () =>
      visibility === undefined || (scope !== undefined && this.surfaces.get(visibility) === scope);
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
          await options.store.create(next, () => !this.disposed && current());
          this.assertLive();
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
    let transition = JSON.stringify(this.session.snapshot().pendingTransition);
    this.unsubscribe = this.session.subscribe((state) => {
      const next = JSON.stringify(state.pendingTransition);
      if (transition !== next) {
        this.interaction++;
        transition = next;
      }
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
    else if (!this.surfaces.has(surface)) this.surfaces.set(surface, {});
    this.emit();
    return this.snapshot();
  }
  commandPending(): boolean {
    return this.pendingWork > 0;
  }
  /** Cover admission, queued work, intermediate published results, and durable readback. */
  private async duringCommand<T>(work: () => Promise<T>): Promise<T> {
    if (++this.pendingWork === 1) this.captureClaim?.workChanged();
    try {
      return await work();
    } finally {
      if (--this.pendingWork === 0) this.captureClaim?.workChanged();
    }
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
    return this.duringCommand(() => pending);
  }
  async hide(surface?: symbol): Promise<void> {
    if (this.disposed) return;
    if (surface === undefined) this.visible = false;
    else this.surfaces.delete(surface);
    this.retireVoice(surface);
    this.stopCapture(surface);
    if (surface === undefined) this.acceptance++;
    await this.flush();
  }
  async stop(): Promise<void> {
    if (this.disposed) return;
    this.stopCapture();
    this.retireVoice();
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
      this.assertLive();
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
    this.interaction++;
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
  submit(
    text: string,
    basis?: CommandSubmissionBasis,
    surface?: SubmissionSurface,
    admission?: () => boolean,
  ): Promise<void> {
    return this.duringCommand(() => this.submitText(text, basis, surface, admission));
  }
  private async submitText(
    text: string,
    basis?: CommandSubmissionBasis,
    surface?: SubmissionSurface,
    admission?: () => boolean,
  ): Promise<void> {
    this.interaction++;
    const generation = this.acceptance,
      submitted = ++this.submitted,
      input = this.session.captureInput(),
      visible = this.captureVisibility(surface?.visibility);
    if (this.changing !== undefined) await this.changing;
    if (this.isDisposed() || !visible() || admission?.() === false) return;
    if (generation !== this.acceptance) {
      this.retainUnadmitted(text, input, admission);
      await this.flush();
      return;
    }
    const acceptance = { retired: false };
    await this.submitTurn(text, basis, surface, () => {
      const current = generation === this.acceptance && visible();
      acceptance.retired ||= !current;
      return current && admission?.() !== false;
    });
    if (acceptance.retired) this.retainUnadmitted(text, input, admission);
    await this.flush();
    this.notifyCompletion(submitted);
  }
  private async submitTurn(
    text: string,
    basis: CommandSubmissionBasis | undefined,
    surface: SubmissionSurface | undefined,
    admission: () => boolean,
  ): Promise<void> {
    const turn = { visibility: surface?.visibility };
    try {
      await this.session.submit(text, basis, this.noteReview(surface?.noteReview), () => {
        if (!admission()) return false;
        this.voiceTurn = turn;
        return true;
      });
    } finally {
      if (this.voiceTurn === turn) this.voiceTurn = undefined;
    }
  }
  setVoiceMode(mode: 'manual' | 'continuous', visibility?: symbol): void {
    if (this.disposed) return;
    this.preferenceOrigin = visibility;
    try {
      this.session.setVoiceMode(mode);
    } finally {
      this.preferenceOrigin = undefined;
    }
  }
  queuedVoice(): number {
    return this.voiceQueue.length;
  }
  enqueueVoice(
    text: string,
    basis: CommandSubmissionBasis,
    surface: SubmissionSurface | undefined,
    admission: () => boolean,
  ): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (
      this.voiceQueue.length >= 8 ||
      this.voiceQueue.reduce((size, item) => size + item.text.length, text.length) > 64000 ||
      text.length > 16000
    ) {
      this.retireVoice();
      this.retainVoiceText(text, basis.sessionId);
      return Promise.resolve(false);
    }
    const visible = this.captureVisibility(surface?.visibility);
    const result = new Promise<boolean>((resolve) => {
      this.voiceQueue.push({
        text,
        basis,
        surface: surface?.noteReview,
        visibility: surface?.visibility,
        admission: () => visible() && admission(),
        sessionId: basis.sessionId,
        resolve,
      });
    });
    this.emit();
    if (!this.drainingVoice)
      void this.duringCommand(() => this.drainVoice()).catch(() => {
        this.retireVoice();
        this.session.status('error', commandMessage('Voice kept as text. Review before sending.'));
        console.error('[abyss-tasks] Voice queue failed', { code: 'VOICE_QUEUE' });
      });
    return result;
  }
  private async drainVoice(): Promise<void> {
    this.drainingVoice = true;
    try {
      while (this.voiceQueue.length > 0 && !this.disposed) {
        await this.session.whenIdle();
        if (this.changing !== undefined) await this.changing;
        const item = this.voiceQueue.shift();
        if (item === undefined) break;
        this.emit();
        await this.runVoice(item);
      }
    } finally {
      this.drainingVoice = false;
    }
  }
  private async runVoice(item: QueuedVoice): Promise<void> {
    try {
      if (!item.admission()) {
        this.retainVoiceText(item.text, item.sessionId);
        return;
      }
      const submitted = ++this.submitted;
      const acceptance = { retired: false };
      await this.submitTurn(
        item.text,
        item.basis,
        { noteReview: item.surface, visibility: item.visibility },
        () => {
          const current = item.admission();
          acceptance.retired ||= !current;
          return current;
        },
      );
      if (acceptance.retired) this.retainVoiceText(item.text, item.sessionId);
      await this.flush();
      this.notifyCompletion(submitted);
    } catch (cause) {
      this.retainVoiceText(item.text, item.sessionId);
      throw cause;
    } finally {
      item.resolve(true);
    }
  }
  private retainVoiceText(text: string, sessionId: string): void {
    const state = this.session.snapshot();
    if (state.id === sessionId)
      this.session.setInput(state.input === '' ? text : `${state.input}\n\n${text}`);
  }
  retireVoice(visibility?: symbol): void {
    const retired = this.voiceQueue.filter(
      (item) => visibility === undefined || item.visibility === visibility,
    );
    for (const item of retired) {
      this.voiceQueue.splice(this.voiceQueue.indexOf(item), 1);
      this.retainVoiceText(item.text, item.sessionId);
      item.resolve(true);
    }
  }
  private retainUnadmitted(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    admission: (() => boolean) | undefined,
  ): void {
    if (admission?.() !== false && input.current()) this.setInput(text);
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
  confirmAndStart(revision?: number, surface?: symbol, visibility?: symbol): Promise<boolean> {
    this.interaction++;
    const basis = this.session.snapshot(),
      input = this.session.captureInput(),
      generation = this.acceptance,
      expectedRevision = revision ?? basis.proposal.revision,
      visible = this.captureVisibility(visibility);
    const current = (): boolean =>
      !this.disposed &&
      visible() &&
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
      if (state.proposal.changes.length > 0) {
        if (!(await this.saveToFinish(expectedRevision, surface))) return false;
      } else await this.flush();
      const next = this.session.snapshot();
      if (!current() || next.proposal.changes.length !== 0 || !this.canFinishSession(next))
        return false;
      this.retireVoice();
      this.stopCapture();
      return this.startSession();
    });
  }
  private async saveToFinish(revision: number, surface?: symbol): Promise<boolean> {
    const submitted = ++this.submitted;
    const result = await this.session.confirm(revision, this.noteReview(surface));
    await this.flush();
    this.notifyCompletion(submitted);
    return result;
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
  confirm(revision?: number, surface?: symbol): Promise<boolean> {
    return this.duringCommand(() => this.confirmCurrent(revision, surface));
  }
  private async confirmCurrent(revision?: number, surface?: symbol): Promise<boolean> {
    this.interaction++;
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
    this.interaction++;
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
    this.interaction++;
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
    this.interaction++;
    this.retireVoice();
    this.stopCapture();
    return this.transition(() => this.startSession(disposition));
  }
  private async startSession(disposition?: 'keep' | 'discard'): Promise<boolean> {
    if (this.disposed) return false;
    const result = await this.session.newSession(disposition);
    this.emit();
    return result;
  }
  select(id: string): Promise<boolean> {
    this.interaction++;
    if (id !== this.session.snapshot().id) {
      this.retireVoice();
      this.stopCapture();
    }
    const generation = this.acceptance;
    return this.transition(() => this.selectSession(id, generation));
  }
  private async selectSession(id: string, generation: number): Promise<boolean> {
    if (this.disposed) return false;
    await this.session.settle();
    if (id !== this.session.snapshot().id && !this.session.canLeaveUncertainty()) return false;
    if (!(await this.flush()) || this.isDisposed() || generation !== this.acceptance) return false;
    try {
      await this.options.store.select(id, () => !this.disposed && generation === this.acceptance);
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
    this.interaction++;
    return this.transition(() => this.reviewSession());
  }
  private async reviewSession(): Promise<boolean> {
    await this.session.settle();
    if (this.disposed || !(await this.flush())) return false;
    return this.session.beginReview();
  }
  acknowledgeUncertainty(): Promise<boolean> {
    this.interaction++;
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
    this.interaction++;
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
  deletionReason(id: string): string | null {
    const record = this.recent().find((entry) => entry.snapshot.id === id);
    return record !== undefined && hasUnresolvedCommandWrites(record.snapshot)
      ? 'This session contains an unresolved write. Review it before deleting history.'
      : null;
  }
  delete(id: string): Promise<boolean> {
    return this.deleteHistory(id);
  }
  clearHistory(): Promise<boolean> {
    return this.deleteHistory();
  }
  private removeHistoryRecords(id?: string): Promise<void> {
    return id === undefined ? this.options.store.clearHistory() : this.options.store.remove(id);
  }
  private deleteHistory(id?: string): Promise<boolean> {
    this.retireVoice();
    this.stopCapture();
    this.acceptance++;
    this.submitted++;
    this.session.cancelTurn();
    return this.transition(async () => {
      await this.session.settle();
      if (this.disposed || !(await this.flush())) return false;
      const ids = id === undefined ? this.recent().map((entry) => entry.snapshot.id) : [id];
      try {
        // Store checks the whole batch before changing a single row or its selection.
        if (ids.some((entry) => this.deletionReason(entry) !== null)) {
          await this.removeHistoryRecords(id);
          return false;
        }
        if (ids.includes(this.session.snapshot().id) && !(await this.startSession('keep')))
          return false;
        this.assertLive();
        await this.removeHistoryRecords(id);
        this.emit();
        return true;
      } catch {
        this.emit();
        return false;
      }
    });
  }
  /** Retirement revokes callbacks synchronously; callers replacing this owner await its drain. */
  drained(): Promise<void> {
    return this.retirement ?? this.options.store.drained();
  }
  dispose(): void {
    if (this.disposed) return;
    this.retireVoice();
    this.stopCapture();
    this.session.cancelTurn();
    const final = this.session.snapshot();
    const save =
      this.options.store.activeId() === null
        ? this.options.store.create(final)
        : this.options.store.save(final);
    this.disposed = true;
    this.acceptance++;
    this.submitted++;
    this.noteReviews.clear();
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    this.unsubscribe();
    this.listeners.clear();
    this.session.dispose();
    this.retirement = Promise.allSettled([save, this.changing, this.session.settle()]).then(
      async () => {
        await this.options.store.drained();
      },
    );
  }
}
