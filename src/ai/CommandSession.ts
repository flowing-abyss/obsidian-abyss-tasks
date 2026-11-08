import type {
  ApiResultV1,
  ContentPlanV1,
  NoteReadPageV1,
  ProjectDtoV1,
  ReadTaskTreeV1,
  TaskTreePageV1,
  TaskTreeV1,
} from '../../api';
import { canonicalCommandPlan, commandRead } from './commandReads';
import { hasUnresolvedCommandWrites } from './commandRecovery';
import { reconcileCommandLink, sameReviewedContent, validatePlanOutput } from './commandSchemas';
import {
  CommandFailure,
  required,
  type CommandChange,
  type CommandFocus,
  type CommandFocusContinuations,
  type CommandJournalEntry,
  type CommandNoteRead,
  type CommandPendingTransition,
  type CommandPreparation,
  type CommandRevealRequest,
  type CommandSessionOptions,
  type CommandSessionSnapshot,
  type CommandStatusInput,
  type CommandStatusKind,
  type CommandSubmissionBasis,
  type CommandTransitionDisposition,
} from './commandTypes';
import { executeCommandWrites } from './commandWrites';
import { providerFailure } from './providers/providerFailure';

function statusNodes(tree: TaskTreeV1 | null): TaskTreeV1[] {
  return tree === null ? [] : [tree, ...tree.children.flatMap(statusNodes)];
}
function detached<T>(value: T): T {
  return structuredClone(value);
}
function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function nodeValues(
  tree: TaskTreeV1 | null,
  result = new Map<string, string>(),
): Map<string, string> {
  if (tree === null) return result;
  result.set(
    tree.target,
    JSON.stringify(tree, (key, value: unknown) =>
      ['children', 'source', 'target', 'revision', 'parentTarget', 'activity'].includes(key)
        ? undefined
        : value,
    ),
  );
  for (const child of tree.children) nodeValues(child, result);
  return result;
}
function affectedNodes(changes: readonly CommandChange[]): number {
  const keys = new Set<string>(),
    plans = new Map<string, Extract<CommandChange, { kind: 'task' }>['plan']>();
  for (const change of changes) {
    if (change.kind === 'task' || change.kind === 'cleanup')
      plans.set(change.plan.target, change.plan);
    else if (change.kind === 'status') keys.add(`task:${change.target}`);
    else if (change.kind === 'project') keys.add(`project:${change.before.target}`);
  }
  for (const change of changes)
    if (change.kind === 'link' && !plans.has(change.plan.target))
      plans.set(change.plan.target, change.plan);
  for (const plan of plans.values()) collectChangedNodes(plan, keys);
  return keys.size;
}
function collectChangedNodes(
  plan: Extract<CommandChange, { kind: 'task' }>['plan'],
  keys: Set<string>,
): void {
  const before = nodeValues(plan.before),
    after = nodeValues(plan.after);
  for (const target of new Set([...before.keys(), ...after.keys()]))
    if (before.get(target) !== after.get(target)) keys.add(`task:${target}`);
}
function validateChange(change: CommandChange): void {
  if (change.kind === 'task' || change.kind === 'cleanup' || change.kind === 'link') {
    validatePlanOutput(change.plan);
    if (change.plan.before?.complete === false || change.plan.after?.complete === false)
      throw new CommandFailure('INCOMPLETE_PLAN', 'Read the complete task plan before staging it.');
  }
}
function validOperationBudget(total: number, increment: number): boolean {
  return (
    Number.isInteger(increment) && increment >= 1 && increment <= 20 && total + increment <= 100
  );
}
function changeKey(c: CommandChange): string {
  if (c.kind === 'project') return `project:${c.before.target}`;
  if (c.kind === 'note' && c.plan.note !== undefined) return `note:${c.plan.note.target}`;
  if (c.kind === 'status') return `status:${c.target}`;
  if (c.kind === 'task' && c.plan.before !== null) return `task:${c.plan.before.target}`;
  return `${c.kind}:${c.plan.target}`;
}
function composeChange(previous: CommandChange, next: CommandChange): CommandChange {
  if (previous.kind === 'note' && next.kind === 'note' && previous.plan.target !== next.plan.target)
    throw new CommandFailure(
      'NOTE_REFINEMENT',
      'Refine the current note proposal to retain its pending sections.',
    );
  return composeProjectChange(previous, next);
}
function composeProjectChange(previous: CommandChange, next: CommandChange): CommandChange {
  if (previous.kind !== 'project' || next.kind !== 'project') return next;
  if (
    previous.before.revision !== next.before.revision ||
    previous.before.target !== next.before.target
  )
    throw new CommandFailure(
      'REVISION_CONFLICT',
      'The project changed while its earlier edits were pending. Review them before continuing.',
    );
  const fields = new Map((previous.fields ?? []).map((field) => [field.fieldId, field]));
  for (const field of next.fields ?? []) fields.set(field.fieldId, field);
  return {
    ...previous,
    ...next,
    before: previous.before,
    ...(previous.fields === undefined && next.fields === undefined
      ? {}
      : { fields: [...fields.values()] }),
  };
}
function focusNode(tree: TaskTreeV1 | null, target: string): TaskTreeV1 | undefined {
  if (tree === null) return undefined;
  if (tree.target === target) return tree;
  for (const child of tree.children) {
    const found = focusNode(child, target);
    if (found !== undefined) return found;
  }
  return undefined;
}
function matchesFocusRevision(
  target: Extract<CommandFocus, { kind: 'task' }>,
  node: TaskTreeV1,
  planRevision: string,
): boolean {
  return (
    (target.expectedPlanRevision === undefined || target.expectedPlanRevision === planRevision) &&
    (target.revision === undefined ||
      target.revision === node.revision ||
      target.revision === planRevision)
  );
}
function focusError(cause: unknown): string {
  return cause instanceof CommandFailure
    ? cause.message
    : 'Could not verify the requested selection.';
}
type VerifiedFocus =
  | { kind: 'task'; focus: CommandFocus; tree: TaskTreePageV1 }
  | { kind: 'project'; focus: CommandFocus; project: ProjectDtoV1 }
  | { kind: 'note'; focus: CommandFocus; note: NoteReadPageV1 };
interface PendingReveal {
  readonly request: CommandRevealRequest;
  claimed: boolean;
  readonly turn: AbortController;
  readonly signal: AbortSignal;
  settle(accepted: boolean): void;
}
export class CommandSession {
  private state: CommandSessionSnapshot;
  private readonly listeners = new Set<(state: CommandSessionSnapshot) => void>();
  private turn: AbortController | undefined;
  private running: Promise<void> | undefined;
  private pendingWrite: Promise<boolean> | undefined;
  private writing = false;
  private writeAdmission: AbortController | undefined;
  private disposed = false;
  private focusRun = 0;
  private pendingReveal: PendingReveal | undefined;
  private acceptance = 0;
  private queuedInput: string | undefined;
  private inputRevision = 0;
  constructor(private readonly options: CommandSessionOptions) {
    this.state = this.empty();
  }
  private empty(): CommandSessionSnapshot {
    return {
      id: this.options.id(),
      input: '',
      focus: [],
      context: this.options.context ?? '',
      trees: [],
      entities: { tasks: [], projects: [], notes: [] },
      exchanges: [],
      activeQuestion: null,
      status: { kind: 'ready', message: '' },
      proposal: { revision: 0, operations: 0, changes: [] },
      journal: [],
      actual: [],
      blocked: false,
    };
  }
  private presentation: CommandSessionSnapshot['presentation'];
  private presentationSession = '';
  showChanges(signal: AbortSignal): void {
    if (this.turn?.signal !== signal || signal.aborted) return;
    this.presentationSession = this.state.id;
    this.presentation = { proposalRevision: this.state.proposal.revision, changes: 'cumulative' };
    this.publish({});
  }
  snapshot(): CommandSessionSnapshot {
    const copy = detached({
      ...this.state,
      ...(this.presentationSession === this.state.id &&
      this.presentation?.proposalRevision === this.state.proposal.revision &&
      this.state.proposal.changes.length > 0
        ? { presentation: this.presentation }
        : {}),
      ...(this.pendingReveal === undefined ? {} : { reveal: this.pendingReveal.request }),
    });
    freeze(copy);
    return copy;
  }
  /** The owner calls this only after settling work and persisting selection. */
  restore(snapshot: CommandSessionSnapshot, historical = true): boolean {
    if (this.disposed || this.writing) return false;
    this.focusRun++;
    this.state = detached(snapshot);
    Reflect.deleteProperty(this.state, 'reveal');
    Reflect.deleteProperty(this.state, 'presentation');
    this.presentation = undefined;
    if (historical) {
      const blocked = hasUnresolvedCommandWrites(snapshot);
      this.state = { ...this.state, blocked, recovery: blocked ? 'uncertain' : 'historical' };
    }
    this.publish({});
    return true;
  }
  readOnly(): boolean {
    return (
      this.state.blocked ||
      this.state.recovery === 'historical' ||
      this.state.recovery === 'uncertain'
    );
  }
  beginReview(): boolean {
    if (this.disposed || this.writing || this.state.blocked || this.state.recovery === 'uncertain')
      return false;
    if (this.state.recovery === 'reviewing') return true;
    const previous = this.state;
    this.publish({
      recovery: 'reviewing',
      recoveryEvidence: {
        proposal: previous.proposal,
        focus: previous.focus,
        preparations: previous.preparations ?? [],
      },
      preparations: [],
      proposal: { revision: previous.proposal.revision + 1, operations: 0, changes: [] },
      trees: [],
      focus: [],
      entities: { tasks: [], notes: [], projects: [] },
      actual: [],
      activeQuestion: null,
      pendingTransition: null,
      status: { kind: 'ready', message: 'Prepare a fresh preview from the current source.' },
    });
    return true;
  }
  finishReview(): void {
    if (
      this.state.recovery === 'reviewing' &&
      this.state.proposal.changes.length > 0 &&
      this.state.activeQuestion === null
    )
      this.publish({ recovery: 'live' });
  }
  prepared(value: CommandPreparation): void {
    if (this.disposed || this.readOnly()) return;
    this.publish({ preparations: [...(this.state.preparations ?? []), value] });
  }
  private current(id: string): boolean {
    return !this.disposed && this.state.id === id;
  }
  private async refreshOwnedChanges(): Promise<Array<Extract<CommandChange, { kind: 'task' }>>> {
    const signal = new AbortController().signal;
    const timing = { now: this.options.now, deadline: this.options.now() + 5000 };
    const changes: Array<Extract<CommandChange, { kind: 'task' }>> = [];
    for (const change of this.state.proposal.changes) {
      if (change.kind !== 'task') throw new CommandFailure('REVIEW', 'Review this preview again.');
      const page = await commandRead(
        this.options.api,
        () =>
          required(this.options.api.tasks.prepare)({
            kind: 'refresh',
            plan: change.plan.target,
            expectedPlanRevision: change.plan.revision,
          }),
        signal,
        timing,
      );
      const plan = await canonicalCommandPlan(this.options.api, page, signal, timing);
      if (!sameReviewedContent(change.plan, plan))
        throw new CommandFailure('REVIEW', 'The source changed. Review a fresh preview.');
      changes.push({ kind: 'task', plan });
    }
    return changes;
  }
  private refreshedFocus(
    changes: ReadonlyArray<Extract<CommandChange, { kind: 'task' }>>,
  ): readonly CommandFocus[] {
    return this.state.focus.map((focus) => {
      if (focus.kind !== 'task') return focus;
      const change = changes.find((entry) => entry.plan.target === focus.plan);
      return change === undefined
        ? focus
        : { ...focus, expectedPlanRevision: change.plan.revision };
    });
  }
  /** Only the still-owning client may attempt this proof. Failure leaves historical evidence. */
  async resumeOwned(): Promise<void> {
    if (this.disposed || this.state.blocked || this.state.recoveryEvidence !== undefined) return;
    const id = this.state.id;
    try {
      const changes = await this.refreshOwnedChanges();
      if (!this.current(id)) return;
      this.publish({
        recovery: 'live',
        proposal: { ...this.state.proposal, revision: this.state.proposal.revision + 1, changes },
        trees: changes.map((change) => ({ before: change.plan.before, after: change.plan.after })),
        focus: this.refreshedFocus(changes),
      });
    } catch {
      if (this.current(id)) this.publish({ recovery: 'historical' });
    }
  }
  subscribe(listener: (state: CommandSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<CommandSessionSnapshot>): void {
    this.state = { ...this.state, ...detached(patch) };
    for (const listener of this.listeners) listener(this.snapshot());
  }
  status(kind: CommandStatusKind, message: string): void {
    this.publish({ status: { kind, message: message.slice(0, 500) } });
  }
  question(text: string): void {
    this.publish({
      activeQuestion: text.slice(0, 500),
      status: { kind: 'question', message: text.slice(0, 500) },
    });
  }
  answer(): void {
    this.publish({ activeQuestion: null });
  }
  async requestReveal(
    input: { target: string; revision: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    const turn = this.turn,
      id = this.state.id;
    if (turn === undefined || signal.aborted || this.writing || this.readOnly()) return false;
    const task = await commandRead(
      this.options.api,
      () => this.options.api.tasks.get(input.target),
      signal,
      { now: this.options.now, deadline: this.options.now() + 5000 },
    );
    if (task.target !== input.target || task.revision !== input.revision)
      throw new CommandFailure(
        'REVEAL_STALE',
        'That task changed. Read it again before opening it.',
      );
    if (!this.currentRevealTurn(turn, id, signal)) return false;
    return this.waitForReveal({ id: this.options.id(), sessionId: id, ...input }, turn, signal);
  }
  private waitForReveal(
    request: CommandRevealRequest,
    turn: AbortController,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.pendingReveal?.settle(false);
    return new Promise((resolve) => {
      const abort = (): void => {
        pending.settle(false);
      };
      const pending: PendingReveal = {
        request,
        turn,
        signal,
        claimed: false,
        settle: (accepted) => {
          if (this.pendingReveal !== pending) return;
          this.pendingReveal = undefined;
          signal.removeEventListener('abort', abort);
          resolve(accepted);
          this.publish({});
        },
      };
      this.pendingReveal = pending;
      signal.addEventListener('abort', abort, { once: true });
      this.status('thinking', 'Opening task…');
    });
  }
  claimReveal(request: CommandRevealRequest): boolean {
    const pending = this.matchingReveal(request);
    if (pending === undefined || pending.claimed) return false;
    pending.claimed = true;
    return true;
  }
  private currentRevealTurn(turn: AbortController, id: string, signal: AbortSignal): boolean {
    return this.current(id) && this.turn === turn && !signal.aborted;
  }
  private matchingReveal(request: CommandRevealRequest): PendingReveal | undefined {
    const pending = this.pendingReveal;
    if (
      pending === undefined ||
      !this.currentRevealTurn(pending.turn, request.sessionId, pending.signal)
    )
      return undefined;
    const expected = pending.request;
    return expected.id === request.id &&
      expected.target === request.target &&
      expected.revision === request.revision
      ? pending
      : undefined;
  }
  acknowledgeReveal(request: CommandRevealRequest, accepted: boolean): boolean {
    const pending = this.matchingReveal(request);
    if (pending?.claimed !== true) return false;
    pending.settle(accepted);
    return true;
  }
  async focus(
    target: CommandFocus | readonly CommandFocus[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    const requested: readonly CommandFocus[] = Array.isArray(target)
      ? target
      : [target as CommandFocus];
    const id = this.state.id,
      run = ++this.focusRun,
      deadline = this.options.now() + 5000;
    const current = (): boolean =>
      !this.disposed && !signal.aborted && this.state.id === id && this.focusRun === run;
    const read = <T>(work: () => Promise<ApiResultV1<T>>): Promise<T> =>
      commandRead(this.options.api, work, signal, { deadline, now: this.options.now });
    try {
      if (requested.length > 5)
        throw new CommandFailure('FOCUS_LIMIT', 'Choose at most five working entities.');
      const verified: VerifiedFocus[] = [];
      for (const entry of requested) verified.push(await this.verifyFocus(entry, read));
      if (!current()) return false;
      if (this.needsFocusDisposition(requested)) {
        this.requestTransition(
          { kind: 'focus', target: requested },
          'Save these changes, keep them for later, discard them, or stay here?',
        );
        return false;
      }
      for (const entry of verified) this.observeFocus(entry);
      this.publish({ focus: verified.map((entry) => entry.focus) });
      return true;
    } catch (cause) {
      if (current()) this.status('error', focusError(cause));
      return false;
    }
  }
  private requestTransition(pending: CommandPendingTransition, question: string): void {
    const requested = { ...pending, previousQuestion: this.previousQuestion() };
    if (JSON.stringify(requested) === JSON.stringify(this.state.pendingTransition)) return;
    this.publish({
      pendingTransition: requested,
      proposal: { ...this.state.proposal, revision: this.state.proposal.revision + 1 },
    });
    this.question(question);
  }
  private previousQuestion(): string | null {
    return this.state.pendingTransition == null
      ? this.state.activeQuestion
      : (this.state.pendingTransition.previousQuestion ?? null);
  }
  private needsFocusDisposition(requested: readonly CommandFocus[]): boolean {
    if (this.readOnly() || this.state.proposal.changes.length === 0) return false;
    if (
      requested.some((entry) => this.state.focus.some((current) => current.target === entry.target))
    )
      return false;
    return !requested.some((entry) =>
      this.state.proposal.changes.some((change) => {
        if (change.kind === 'project') return entry.target === change.before.target;
        if (change.kind === 'note') return entry.target === change.plan.target;
        if (change.kind === 'status') return entry.target === change.target;
        return (
          focusNode(change.plan.after, entry.target) !== undefined ||
          focusNode(change.plan.before, entry.target) !== undefined
        );
      }),
    );
  }
  async resolveTransition(
    disposition: CommandTransitionDisposition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.transitionAllowed(signal))) return false;
    const pending = this.state.pendingTransition;
    if (pending == null) return false;
    if (disposition === 'cancel') {
      const question = this.previousQuestion();
      this.publish({
        pendingTransition: null,
        activeQuestion: question,
        status:
          question === null
            ? { kind: 'ready', message: 'Current work retained.' }
            : { kind: 'question', message: question },
      });
      return true;
    }
    if (pending.kind === 'new-session')
      return disposition === 'save' ? false : this.newSession(disposition, signal);
    if (disposition === 'save') return this.saveAndFocus(pending.target, signal);
    if (!(await this.newSession(disposition, signal))) return false;
    return this.focus(pending.target, signal);
  }
  private async saveAndFocus(
    target: readonly CommandFocus[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const question = this.previousQuestion();
    if (question !== null) {
      this.question(question);
      return false;
    }
    this.publish({ activeQuestion: null, status: { kind: 'ready', message: '' } });
    const saved =
      signal === undefined
        ? await this.confirm()
        : await this.confirmFromTurn(this.state.proposal.revision, signal);
    if (!saved) return false;
    this.publish({ pendingTransition: null });
    return this.focus(
      target.map((entry) => ({ kind: entry.kind, target: entry.target })),
      signal,
    );
  }
  private async transitionAllowed(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) await this.settle();
    else if (this.turn?.signal !== signal || signal.aborted) return false;
    return !this.disposed && !this.writing;
  }
  private async verifyFocus(
    target: CommandFocus,
    read: <T>(work: () => Promise<ApiResultV1<T>>) => Promise<T>,
  ): Promise<VerifiedFocus> {
    if (target.kind === 'task') return this.verifyTaskFocus(target, read);
    if (target.kind === 'project') {
      const project = await read(() => required(this.options.api.projects).get(target.target));
      if (target.revision !== undefined && project.revision !== target.revision)
        throw new CommandFailure('STALE_FOCUS', 'The project changed before it could be selected.');
      return {
        kind: 'project',
        project,
        focus: { kind: 'project', target: project.target, revision: project.revision },
      };
    }
    const note = await read(() =>
      required(this.options.api.notes).read({
        selector: {
          target: target.target,
          ...(target.revision === undefined ? {} : { expectedRevision: target.revision }),
        },
        limitCharacters: 12000,
      }),
    );
    return {
      kind: 'note',
      note:
        this.state.entities.notes.find(
          (page) =>
            page.note.target === note.note.target && page.note.revision === note.note.revision,
        ) ?? note,
      focus: { kind: 'note', target: note.note.target, revision: note.note.revision },
    };
  }
  private taskFocusBasis(target: Extract<CommandFocus, { kind: 'task' }>): {
    focus: Extract<CommandFocus, { kind: 'task' }>;
    side: 'before' | 'after';
  } {
    const matches = this.state.proposal.changes.flatMap((change) => {
      if (change.kind !== 'task' && change.kind !== 'cleanup') return [];
      const after = focusNode(change.plan.after, target.target);
      const node = after ?? focusNode(change.plan.before, target.target);
      const side = after === undefined ? ('before' as const) : ('after' as const);
      return node === undefined ? [] : [{ plan: change.plan, node, side }];
    });
    const match =
      target.plan === undefined
        ? matches[0]
        : matches.find((entry) => entry.plan.target === target.plan);
    if (
      target.plan === undefined &&
      matches.length === 0 &&
      target.expectedPlanRevision === undefined
    )
      return { focus: target, side: 'after' };
    if (
      match === undefined ||
      (target.plan === undefined && matches.length !== 1) ||
      !matchesFocusRevision(target, match.node, match.plan.revision)
    )
      throw new CommandFailure(
        'STALE_FOCUS',
        'Use the exact current proposal and node for draft selection.',
      );
    return {
      focus: {
        kind: 'task',
        target: target.target,
        plan: match.plan.target,
        expectedPlanRevision: match.plan.revision,
      },
      side: match.side,
    };
  }
  private async verifyTaskFocus(
    requested: Extract<CommandFocus, { kind: 'task' }>,
    read: <T>(work: () => Promise<ApiResultV1<T>>) => Promise<T>,
  ): Promise<VerifiedFocus> {
    const { focus: target, side } = this.taskFocusBasis(requested);
    const acceptedBasis =
      target.revision === undefined ? {} : { expectedRevision: target.revision };
    const tree = await read(() =>
      required(this.options.api.tasks.tree)({
        target: target.target,
        ...(target.plan === undefined
          ? acceptedBasis
          : {
              plan: target.plan,
              expectedPlanRevision: required(target.expectedPlanRevision),
              side,
            }),
        limit: 50,
      }),
    );
    return {
      kind: 'task',
      tree,
      focus:
        target.plan === undefined
          ? { kind: 'task', target: tree.tree.target, revision: tree.tree.revision }
          : {
              kind: 'task',
              target: tree.tree.target,
              plan: target.plan,
              expectedPlanRevision: required(target.expectedPlanRevision),
            },
    };
  }
  private observeFocus(entry: VerifiedFocus): void {
    if (entry.kind === 'task') this.observeTree(entry.tree);
    else if (entry.kind === 'project') this.observeProject(entry.project);
    else this.observeNote(entry.note);
  }
  remapFocus(changes: CommandFocusContinuations): void {
    this.publish({
      focus: this.state.focus.flatMap((entry): CommandFocus[] => {
        if (entry.kind !== 'task' || !changes.has(entry.target)) return [entry];
        const next = changes.get(entry.target);
        return next == null ? [] : [{ kind: 'task', target: next.target, revision: next.revision }];
      }),
    });
  }
  async readTreePage(query: ReadTaskTreeV1): Promise<TaskTreePageV1> {
    const id = this.state.id,
      signal = new AbortController().signal;
    const page = await commandRead(
      this.options.api,
      () => required(this.options.api.tasks.tree)(query),
      signal,
      { deadline: this.options.now() + 5000, now: this.options.now },
    );
    if (!this.disposed && this.state.id === id) this.observeTree(page);
    return page;
  }
  observeTree(page: TaskTreePageV1): void {
    this.publish({
      entities: { ...this.state.entities, tasks: [...this.state.entities.tasks, page].slice(-32) },
    });
  }
  observeProject(project: ProjectDtoV1): void {
    this.publish({
      focus: this.state.focus.map((entry) =>
        entry.kind === 'project' && entry.target === project.target
          ? { ...entry, revision: project.revision }
          : entry,
      ),
      entities: {
        ...this.state.entities,
        projects: [
          ...this.state.entities.projects.filter((p) => p.target !== project.target),
          project,
        ].slice(-20),
      },
    });
  }
  observeNote(note: CommandNoteRead): void {
    this.publish({
      focus: this.state.focus.map((entry) =>
        entry.kind === 'note' && entry.target === note.note.target
          ? { ...entry, revision: note.note.revision }
          : entry,
      ),
      entities: {
        ...this.state.entities,
        notes: [
          ...this.state.entities.notes.filter((n) => n.note.target !== note.note.target),
          note,
        ].slice(-10),
      },
    });
  }
  discardDraft(plan: string, revision: string): void {
    const draft = this.state.proposal.changes.find(
      (c) => c.kind === 'task' && c.plan.target === plan,
    );
    if (draft?.kind !== 'task' || draft.plan.before !== null || draft.plan.revision !== revision)
      throw new CommandFailure('DRAFT', 'Only the current unsaved root can be discarded.');
    const changes = this.state.proposal.changes.filter((c) =>
      c.kind === 'status' ? c.plan !== plan : c.kind === 'project' || c.plan.target !== plan,
    );
    this.publish({
      proposal: {
        revision: this.state.proposal.revision + 1,
        operations: this.state.proposal.operations + 1,
        changes,
      },
      focus: this.state.focus.filter(
        (entry) => entry.kind !== 'task' || !nodeValues(draft.plan.after).has(entry.target),
      ),
      trees: changes.flatMap((c) =>
        c.kind === 'task' ? [{ before: c.plan.before, after: c.plan.after }] : [],
      ),
    });
  }
  updateContext(context: string): void {
    if (!this.disposed) this.publish({ context: context.slice(0, 8000) });
  }
  async stageStatus(input: CommandStatusInput): Promise<boolean> {
    const basis = this.state;
    if (!this.canStageStatus(basis)) return false;
    const change = basis.proposal.changes.find(
      (entry) => entry.kind === 'task' && entry.plan.target === input.plan,
    );
    if (change?.kind !== 'task' || change.plan.revision !== input.expectedPlanRevision)
      return false;
    if (!this.draftStatusMatches(change.plan, input)) return false;
    try {
      return await this.applyDraftStatus(change.plan, input, basis);
    } catch (error) {
      if (this.current(basis.id))
        this.status(
          'error',
          error instanceof CommandFailure ? error.message : 'Could not change the draft status.',
        );
      return false;
    }
  }
  private canStageStatus(basis: CommandSessionSnapshot): boolean {
    return (
      this.canApplyStatus(basis) && this.turn === undefined && this.state.pendingTransition == null
    );
  }
  private draftStatusMatches(plan: ContentPlanV1, input: CommandStatusInput): boolean {
    return (
      statusNodes(plan.after).find((node) => node.target === input.target)?.revision ===
      input.revision
    );
  }
  private async applyDraftStatus(
    current: ContentPlanV1,
    input: CommandStatusInput,
    basis: CommandSessionSnapshot,
  ): Promise<boolean> {
    const existing =
      statusNodes(current.before).some((entry) => entry.target === input.target) ||
      current.copies?.some((copy) =>
        copy.tasks.some((task) => task.destinationTarget === input.target),
      ) === true;
    if (existing) this.stageLifecycleStatus(input);
    else {
      const request = {
        kind: 'append' as const,
        plan: input.plan,
        expectedPlanRevision: input.expectedPlanRevision,
        operation: {
          type: 'set-initial-status' as const,
          target: input.target,
          symbol: input.symbol,
        },
      };
      const result = await required(this.options.api.tasks.prepare)(request);
      if (!result.ok) throw new CommandFailure(result.error.code, result.error.message);
      const plan = await canonicalCommandPlan(
        this.options.api,
        result.value,
        new AbortController().signal,
        { now: this.options.now, deadline: this.options.now() + 5000 },
      );
      if (!this.canApplyStatus(basis)) return false;
      this.stage({ kind: 'task', plan }, 1, [{ kind: 'task', input: request }]);
    }
    return true;
  }
  stageLifecycleStatus(input: {
    target: string;
    revision: string;
    symbol: string;
    plan?: string | undefined;
  }): void {
    this.stage({
      kind: 'status',
      target: input.target,
      revision: input.revision,
      symbol: input.symbol,
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      nuance:
        'Status uses ordinary completion, recurrence, deletion, timer and blocker rules after the content is saved.',
    });
  }
  setInput(text: string): void {
    this.inputRevision++;
    this.publish({ input: text });
  }
  exchange(role: 'user' | 'agent', text: string): void {
    this.publish({
      exchanges: [...this.state.exchanges, { role, text }],
    });
  }
  stage(
    change: CommandChange,
    operations = 1,
    preparations: ReadonlyArray<Extract<CommandPreparation, { kind: 'task' }>> = [],
  ): void {
    this.requireStageable();
    validateChange(change);
    const changes = [...this.state.proposal.changes];
    const index = changes.findIndex((c) => changeKey(c) === changeKey(change));
    if (index < 0) changes.push(change);
    else changes[index] = composeChange(required(changes[index]), change);
    const retained = changes
      .filter((c) => !(c.kind === 'task' && c.plan.before === null && c.plan.after === null))
      .map((entry) =>
        entry.kind === 'link' && change.kind === 'task' && entry.plan.target === change.plan.target
          ? reconcileCommandLink(entry, change.plan, preparations)
          : entry,
      );
    const count = affectedNodes(retained);
    if (count > 50 || !validOperationBudget(this.state.proposal.operations, operations))
      throw new CommandFailure('BUDGET', 'This proposal is too large. Save or split it first.');
    this.publish({
      preparations: [...(this.state.preparations ?? []), ...preparations],
      focus:
        change.kind === 'task'
          ? this.state.focus.flatMap((entry): CommandFocus[] => {
              if (entry.kind !== 'task') return [entry];
              if (nodeValues(change.plan.after).has(entry.target))
                return [
                  {
                    kind: 'task',
                    target: entry.target,
                    plan: change.plan.target,
                    expectedPlanRevision: change.plan.revision,
                  },
                ];
              if (entry.plan !== change.plan.target) return [entry];
              return nodeValues(change.plan.before).has(entry.target)
                ? [{ kind: 'task', target: entry.target }]
                : [];
            })
          : this.state.focus,
      proposal: {
        revision: this.state.proposal.revision + 1,
        operations: this.state.proposal.operations + operations,
        changes: retained,
      },
      trees: retained.flatMap((c) =>
        c.kind === 'task' ? [{ before: c.plan.before, after: c.plan.after }] : [],
      ),
      activeQuestion: null,
      status: { kind: 'ready', message: 'Ready for review.' },
    });
  }
  private requireStageable(): void {
    if (this.disposed || this.writing || this.readOnly() || this.state.pendingTransition != null)
      throw new CommandFailure('BUSY', 'Resolve the previous write before changing this proposal.');
  }
  async submit(text: string, submittedAgainst?: CommandSubmissionBasis): Promise<void> {
    if (this.disposed) return;
    if (text.length <= 16000 && text.trim() === '') {
      await this.confirm();
      return;
    }
    if (this.running !== undefined || this.pendingWrite !== undefined) {
      const previous = this.running ?? this.pendingWrite;
      this.cancelTurn(false);
      const generation = this.acceptance;
      this.queuedInput = text;
      await previous;
      if (generation !== this.acceptance) return;
      this.queuedInput = undefined;
      return this.submit(text, submittedAgainst);
    }
    if (text.length > 16000) {
      this.setInput(text);
      this.status(
        'error',
        'This command is too long. Shorten it before sending; your full input is retained.',
      );
      return;
    }
    const running = this.runTurn(text, submittedAgainst);
    this.running = running;
    try {
      await running;
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }
  private unavailable(): boolean {
    return this.disposed || this.writing || this.turn !== undefined;
  }
  private acceptsTurn(signal: AbortSignal, id: string): boolean {
    return !signal.aborted && this.current(id);
  }
  private async runTurn(text: string, submittedAgainst?: CommandSubmissionBasis): Promise<void> {
    if (this.unavailable()) {
      this.status('error', 'Finish or reconcile the previous operation first.');
      return;
    }
    this.presentation = undefined;
    this.setInput(text);
    this.exchange('user', text);
    const controller = new AbortController();
    this.turn = controller;
    const snapshot = this.snapshot();
    const basis = {
      ...snapshot,
      submissionBasis: submittedAgainst ?? {
        sessionId: snapshot.id,
        proposalRevision: snapshot.proposal.revision,
      },
    };
    this.status('thinking', 'Working…');
    try {
      await this.options.agent.run({ text, signal: controller.signal, session: basis });
      if (
        !controller.signal.aborted &&
        this.state.id === snapshot.id &&
        this.state.status.kind === 'thinking'
      )
        this.status('ready', 'Ready.');
    } catch (cause) {
      if (this.acceptsTurn(controller.signal, snapshot.id))
        this.status(
          'error',
          cause instanceof CommandFailure ? cause.message : providerFailure(cause).message,
        );
    } finally {
      if (this.turn === controller) this.turn = undefined;
    }
  }
  cancelTurn(retainQueued = true): void {
    this.acceptance++;
    if (retainQueued && this.queuedInput !== undefined) {
      this.setInput(this.queuedInput);
      this.queuedInput = undefined;
    }
    const active = this.turn !== undefined;
    this.turn?.abort();
    this.pendingReveal?.settle(false);
    this.writeAdmission?.abort();
    if (active && !this.writing && this.state.activeQuestion === null)
      this.status('ready', 'Stopped. Your draft is retained.');
  }
  async settle(): Promise<void> {
    this.cancelTurn();
    await this.running;
    await this.pendingWrite;
  }
  async confirm(revision = this.state.proposal.revision): Promise<boolean> {
    if (this.turn !== undefined) return false;
    return this.commit(revision);
  }
  async confirmFromTurn(revision: number, signal: AbortSignal): Promise<boolean> {
    if (this.turn?.signal !== signal || signal.aborted) return false;
    return this.commit(revision);
  }
  private canCommit(revision: number): boolean {
    return (
      !this.disposed &&
      !this.writing &&
      !this.state.blocked &&
      (this.state.recovery === undefined || this.state.recovery === 'live') &&
      this.state.activeQuestion === null &&
      this.state.status.kind !== 'error' &&
      revision === this.state.proposal.revision &&
      this.state.proposal.changes.length > 0
    );
  }
  private async commit(revision: number): Promise<boolean> {
    if (!this.canCommit(revision)) return false;
    return this.writeProposal(detached(this.state.proposal), true);
  }
  async applyStatus(input: { target: string; revision: string; symbol: string }): Promise<boolean> {
    const basis = this.state;
    if (!this.canApplyStatus(basis)) return false;
    this.cancelTurn();
    if (this.running !== undefined) await this.running;
    if (!this.canApplyStatus(basis)) return false;
    return this.writeProposal(
      {
        revision: this.state.proposal.revision,
        operations: 1,
        changes: [{ kind: 'status', ...input, nuance: 'Ordinary status lifecycle.' }],
      },
      false,
    );
  }
  private canApplyStatus(basis: CommandSessionSnapshot): boolean {
    return (
      this.current(basis.id) &&
      this.state.proposal.revision === basis.proposal.revision &&
      !this.writing &&
      !this.readOnly() &&
      this.state.recovery !== 'reviewing'
    );
  }
  private invalidateTaskReads(path: string): void {
    const draftTargets = new Set<string>();
    for (const change of this.state.proposal.changes) {
      if (change.kind !== 'task') continue;
      if ((change.plan.destination?.path ?? change.plan.before?.source?.path) !== path) continue;
      for (const target of nodeValues(change.plan.after).keys()) draftTargets.add(target);
      for (const target of nodeValues(change.plan.before).keys()) draftTargets.add(target);
    }
    this.publish({
      entities: {
        ...this.state.entities,
        tasks: this.state.entities.tasks.filter(
          (page) => page.tree.source?.path !== path && !draftTargets.has(page.tree.target),
        ),
      },
    });
  }
  private async recordWrite(entry: CommandJournalEntry): Promise<void> {
    const journal = [...this.state.journal];
    const index = journal.findIndex((j) => j.id === entry.id);
    if (index < 0) journal.push(entry);
    else journal[index] = entry;
    this.publish({ journal });
    try {
      await this.options.journal.save(this.snapshot());
    } catch (cause) {
      if (entry.state === 'admitted')
        this.publish({
          journal: this.state.journal.map((record) =>
            record.id === entry.id
              ? {
                  ...record,
                  state: 'settled',
                  effects: 'unchanged',
                  error: 'STORAGE_BEFORE_ADMISSION',
                }
              : record,
          ),
        });
      throw cause;
    }
  }
  private async completeWrite(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
    inputRevision: number,
  ): Promise<void> {
    const completed: CommandSessionSnapshot = {
      ...this.snapshot(),
      ...(clear
        ? {
            proposal: { revision: proposal.revision + 1, operations: 0, changes: [] },
            trees: [],
            input: inputRevision === this.inputRevision ? '' : this.state.input,
          }
        : {}),
      status: {
        kind: clear ? 'saved' : 'ready',
        message: clear ? 'Saved.' : 'Status saved. Pending content is retained for review.',
      },
    };
    await this.options.journal.save(completed);
    this.publish({
      ...completed,
      input: inputRevision === this.inputRevision ? completed.input : this.state.input,
    });
  }
  private async writeProposal(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
  ): Promise<boolean> {
    const pending = this.performWrite(proposal, clear);
    this.pendingWrite = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingWrite === pending) this.pendingWrite = undefined;
    }
  }
  private async performWrite(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
  ): Promise<boolean> {
    const inputRevision = this.inputRevision;
    const journalStart = this.state.journal.length;
    const admission = new AbortController();
    this.writeAdmission = admission;
    this.writing = true;
    this.status('writing', 'Saving…');
    try {
      await executeCommandWrites({
        api: this.options.api,
        proposal,
        now: this.options.now,
        id: this.options.id,
        cancelled: () => admission.signal.aborted,
        signal: admission.signal,
        record: (entry) => this.recordWrite({ ...entry, origin: clear ? 'proposal' : 'direct' }),
        actual: (trees) => {
          this.publish({ actual: trees });
        },
        projects: this.state.entities.projects,
        invalidateTaskReads: (path) => {
          this.invalidateTaskReads(path);
        },
        observeTree: (page) => {
          this.observeTree(page);
        },
        focus: () => this.state.focus,
        focusChanges: (changes) => {
          this.remapFocus(changes);
        },
        observeProject: (project) => {
          this.observeProject(project);
        },
        observeNote: (note) => {
          this.observeNote(note);
        },
      });
      await this.completeWrite(proposal, clear, inputRevision);
      return true;
    } catch (cause) {
      const unsettled = this.state.journal
        .slice(journalStart)
        .some(
          (j) =>
            j.state === 'admitted' ||
            j.effects === 'unknown' ||
            j.effects === 'partial' ||
            j.effects === 'committed',
        );
      this.publish({
        blocked: unsettled,
        ...this.writeRecovery(unsettled, cause),
        status: {
          kind: 'error',
          message:
            cause instanceof CommandFailure
              ? cause.message
              : 'Could not save or record the result. Review the retained write journal before continuing.',
        },
      });
      return false;
    } finally {
      this.writing = false;
      this.writeAdmission = undefined;
      this.releaseDisposed();
    }
  }
  private writeRecovery(unsettled: boolean, cause: unknown): Partial<CommandSessionSnapshot> {
    if (unsettled) return { recovery: 'uncertain' };
    return cause instanceof CommandFailure && cause.code === 'EXPIRED'
      ? { recovery: 'historical' }
      : {};
  }
  canLeaveUncertainty(): boolean {
    if (!this.state.blocked || this.state.uncertaintyAcknowledged === true) return true;
    this.question(
      'The earlier result is unresolved. Acknowledge it before starting independent work.',
    );
    return false;
  }
  async newSession(
    disposition?: 'keep' | 'discard',
    signal?: AbortSignal,
    acknowledgeUncertainty = false,
  ): Promise<boolean> {
    if (!(await this.transitionAllowed(signal))) return false;
    if (!acknowledgeUncertainty && !this.canLeaveUncertainty()) return false;
    if (this.state.proposal.changes.length > 0 && disposition === undefined) {
      this.requestTransition(
        { kind: 'new-session' },
        'Keep this draft in history or discard it before starting a new session?',
      );
      return false;
    }
    return this.startSession(
      this.archivedSnapshot(disposition, acknowledgeUncertainty),
      this.empty(),
      signal,
    );
  }
  private async startSession(
    archived: CommandSessionSnapshot,
    next: CommandSessionSnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      if (this.options.transitions !== undefined)
        await this.options.transitions.start(
          archived,
          next,
          () => this.current(archived.id) && signal?.aborted !== true,
        );
      else {
        await this.options.journal.save(archived);
        if (signal?.aborted === true) return false;
      }
      if (!this.current(archived.id)) return false;
      return this.restore(next, false);
    } catch {
      if (signal?.aborted !== true)
        this.status('error', 'Could not retain this session. Keep it open and try again.');
      return false;
    }
  }
  private archivedSnapshot(
    disposition?: 'keep' | 'discard',
    acknowledgeUncertainty = false,
  ): CommandSessionSnapshot {
    const previous = {
      ...this.snapshot(),
      pendingTransition: null,
      activeQuestion: this.previousQuestion(),
      ...(acknowledgeUncertainty && this.state.blocked ? { uncertaintyAcknowledged: true } : {}),
    };
    return disposition === 'discard' && !previous.blocked
      ? {
          ...previous,
          input: '',
          recovery: 'live',
          proposal: { revision: previous.proposal.revision + 1, operations: 0, changes: [] },
          trees: [],
          activeQuestion: null,
          status: { kind: 'ready', message: 'Draft discarded.' },
        }
      : previous;
  }
  private releaseDisposed(): void {
    if (this.disposed) this.options.api.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.turn?.abort();
    this.pendingReveal?.settle(false);
    this.writeAdmission?.abort();
    this.listeners.clear();
    if (!this.writing) this.options.api.dispose();
    this.options.onDispose?.();
  }
}
