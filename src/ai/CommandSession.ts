import type {
  ApiResultV1,
  ContentPlanV1,
  NoteReadPageV1,
  ProjectDtoV1,
  ReadTaskTreeV1,
  TaskTreePageV1,
  TaskTreeV1,
} from '../../api';
import { commandDiagnostic, commandMessage } from './commandMessages';
import { projectMoveFocusMessage, projectMoveWithDescendantFocus } from './commandProjects';
import { canonicalCommandPlan, commandRead } from './commandReads';
import { hasUnresolvedCommandWrites } from './commandRecovery';
import {
  commandPlanViews,
  reconcileCommandLink,
  sameReviewedContent,
  validatePlanOutput,
} from './commandSchemas';
import {
  rebaseCommandRemainder,
  selectCommandWrite,
  type CommandSelectedWrite,
} from './commandSelection';
import type { CommandSaveScope } from './commandTypes';
import {
  CommandFailure,
  required,
  type CommandChange,
  type CommandFocus,
  type CommandFocusContinuations,
  type CommandJournalEntry,
  type CommandNoteRead,
  type CommandNoteReview,
  type CommandPendingTransition,
  type CommandPreparation,
  type CommandRevealRequest,
  type CommandSessionOptions,
  type CommandSessionSnapshot,
  type CommandStatusInput,
  type CommandStatusKind,
  type CommandSubmissionBasis,
  type CommandTransitionBasis,
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
    else collectSimpleChanges(change, keys);
  }
  for (const change of changes)
    if (change.kind === 'link' && !plans.has(change.plan.target))
      plans.set(change.plan.target, change.plan);
  for (const plan of plans.values()) collectChangedNodes(plan, keys);
  return keys.size;
}
function collectSimpleChanges(change: CommandChange, keys: Set<string>): void {
  if (change.kind === 'status') keys.add(`task:${change.target}`);
  if (change.kind === 'project') keys.add(`project:${change.before.target}`);
  if (change.kind === 'project-create') keys.add(`project:${change.id}`);
  if (change.kind === 'project-move')
    for (const target of nodeValues(change.before).keys()) keys.add(`task:${target}`);
}
function changeViews(change: CommandChange): CommandSessionSnapshot['trees'] {
  if (change.kind === 'task') return commandPlanViews(change.plan);
  if (change.kind === 'project-move') return [{ before: change.before, after: change.before }];
  return [];
}
function changePaths(change: CommandChange): ReadonlyArray<string | undefined> {
  if ('plan' in change && change.kind !== 'status') {
    if (change.kind === 'note') return [change.plan.path];
    return [
      change.plan.destination?.path,
      ...commandPlanViews(change.plan).flatMap((v) => [
        v.before?.source?.path,
        v.after?.source?.path,
      ]),
    ];
  }
  if (change.kind === 'project-move') return [change.before.source?.path, change.destination.path];
  if (change.kind === 'project') return [change.before.path];
  return [];
}
function structuralConflict(structural: CommandChange, other: CommandChange): boolean {
  if (
    structural.kind !== 'project-move' &&
    !(structural.kind === 'task' && structural.plan.kind === 'hierarchy')
  )
    return false;
  const paths = new Set(changePaths(structural));
  if (changePaths(other).some((path) => path !== undefined && paths.has(path))) return true;
  return (
    other.kind === 'status' &&
    changeViews(structural).some(
      (view) =>
        nodeValues(view.before).has(other.target) || nodeValues(view.after).has(other.target),
    )
  );
}
function requireComposable(change: CommandChange, changes: readonly CommandChange[]): void {
  if (
    changes.some(
      (pending) => structuralConflict(change, pending) || structuralConflict(pending, change),
    )
  )
    throw new CommandFailure(
      'STRUCTURAL_CONFLICT',
      commandMessage(
        'Save or discard the pending changes to these notes before moving tasks. All current work is retained.',
      ),
    );
}
function planFocus(focus: readonly CommandFocus[], change: CommandChange): readonly CommandFocus[] {
  if (change.kind !== 'task') return focus;
  const before = new Set(changeViews(change).flatMap((v) => [...nodeValues(v.before).keys()]));
  const after = new Set(changeViews(change).flatMap((v) => [...nodeValues(v.after).keys()]));
  return focus.flatMap((entry): CommandFocus[] => {
    if (entry.kind !== 'task') return [entry];
    if (after.has(entry.target))
      return [
        {
          kind: 'task',
          target: entry.target,
          plan: change.plan.target,
          expectedPlanRevision: change.plan.revision,
        },
      ];
    if (entry.plan !== change.plan.target) return [entry];
    return before.has(entry.target) ? [{ kind: 'task', target: entry.target }] : [];
  });
}
function collectChangedNodes(
  plan: Extract<CommandChange, { kind: 'task' }>['plan'],
  keys: Set<string>,
): void {
  const before = new Map<string, string>(),
    after = new Map<string, string>();
  for (const view of commandPlanViews(plan)) {
    nodeValues(view.before, before);
    nodeValues(view.after, after);
  }
  if (plan.kind === 'hierarchy' && plan.after !== null) keys.add(`task:${plan.after.target}`);
  for (const target of new Set([...before.keys(), ...after.keys()]))
    if (before.get(target) !== after.get(target)) keys.add(`task:${target}`);
}
function validateChange(change: CommandChange): void {
  if (change.kind === 'task' || change.kind === 'cleanup' || change.kind === 'link') {
    validatePlanOutput(change.plan);
    if (
      commandPlanViews(change.plan).some(
        (view) => view.before?.complete === false || view.after?.complete === false,
      )
    )
      throw new CommandFailure(
        'INCOMPLETE_PLAN',
        commandMessage('Read the complete task plan before staging it.'),
      );
  }
}
function validOperationBudget(total: number, increment: number): boolean {
  return (
    Number.isInteger(increment) && increment >= 1 && increment <= 20 && total + increment <= 100
  );
}
function changeKey(c: CommandChange): string {
  switch (c.kind) {
    case 'project-create':
      return c.id;
    case 'project-move':
      return `move:${c.before.target}`;
    case 'project':
      return `project:${c.before.target}`;
    case 'status':
      return `status:${c.target}`;
    case 'note':
      return noteChangeKey(c.plan);
    case 'task':
      return taskChangeKey(c.plan);
    case 'link':
    case 'cleanup':
      return `${c.kind}:${c.plan.target}`;
  }
}
function noteChangeKey(plan: Extract<CommandChange, { kind: 'note' }>['plan']): string {
  return `note:${plan.note?.target ?? plan.target}`;
}
function taskChangeKey(plan: Extract<CommandChange, { kind: 'task' }>['plan']): string {
  return plan.kind === 'hierarchy'
    ? `hierarchy:${plan.target}`
    : `task:${plan.before?.target ?? plan.target}`;
}
function composeChange(previous: CommandChange, next: CommandChange): CommandChange {
  if (previous.kind === 'note' && next.kind === 'note' && previous.plan.target !== next.plan.target)
    throw new CommandFailure(
      'NOTE_REFINEMENT',
      commandMessage('Refine the current note proposal to retain its pending sections.'),
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
      commandMessage(
        'The project changed while its earlier edits were pending. Review them before continuing.',
      ),
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
    : commandMessage('Could not verify the requested selection.');
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
  private queuedInput: { text: string; current(): boolean } | undefined;
  private inputRevision = 0;
  private editRevision = 0;
  private inputDraft = false;
  private noteReviewRequired = false;
  private turnReview: CommandNoteReview | undefined;
  requireNoteReview(): void {
    this.noteReviewRequired = true;
  }
  constructor(private readonly options: CommandSessionOptions) {
    this.state = this.empty();
  }
  private empty(): CommandSessionSnapshot {
    return {
      id: this.options.id(),
      voiceMode: this.options.defaultVoiceMode?.() ?? 'manual',
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
  private conversationRevision = 0;
  captureInput(): { dirty: boolean; current(): boolean } {
    const revision = this.editRevision;
    return {
      dirty: this.inputDraft,
      current: () => !this.disposed && this.editRevision === revision,
    };
  }
  captureSubmission(): { basis: CommandSubmissionBasis; current(): boolean } {
    const id = this.state.id,
      revision = this.conversationRevision;
    return {
      basis: { sessionId: id, proposalRevision: this.state.proposal.revision },
      current: () =>
        !this.disposed && this.state.id === id && this.conversationRevision === revision,
    };
  }
  setVoiceMode(mode: 'manual' | 'continuous'): void {
    if (!this.disposed) this.publish({ voiceMode: mode });
  }
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
    this.conversationRevision++;
    this.state = detached(snapshot);
    this.editRevision++;
    this.inputDraft = this.state.input !== '';
    Reflect.deleteProperty(this.state, 'reveal');
    Reflect.deleteProperty(this.state, 'presentation');
    this.presentation = undefined;
    if (historical) {
      const blocked = hasUnresolvedCommandWrites(snapshot);
      this.state = { ...this.state, blocked, recovery: blocked ? 'uncertain' : 'historical' };
      if (['thinking', 'searching', 'writing'].includes(this.state.status.kind))
        this.state = {
          ...this.state,
          status: blocked
            ? {
                kind: 'error',
                message: commandMessage(
                  'Could not save or record the result. Review the retained write journal before continuing.',
                ),
              }
            : { kind: 'ready', message: commandMessage('Stopped. Your draft is retained.') },
        };
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
      status: {
        kind: 'ready',
        message: commandMessage('Prepare a fresh preview from the current source.'),
      },
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
      if (change.kind !== 'task')
        throw new CommandFailure('REVIEW', commandMessage('Review this preview again.'));
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
        throw new CommandFailure(
          'REVIEW',
          commandMessage('The source changed. Review a fresh preview.'),
        );
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
        trees: changes.flatMap((change) => commandPlanViews(change.plan)),
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
  private publish(patch: Partial<CommandSessionSnapshot>, verifiedFocusContinuation = false): void {
    const identity = (focus: readonly CommandFocus[]): string =>
      JSON.stringify(focus.map(({ kind, target }) => ({ kind, target })));
    if (
      (!verifiedFocusContinuation &&
        patch.focus !== undefined &&
        identity(patch.focus) !== identity(this.state.focus)) ||
      ('pendingTransition' in patch &&
        JSON.stringify(patch.pendingTransition ?? null) !==
          JSON.stringify(this.state.pendingTransition ?? null))
    )
      this.conversationRevision++;
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
        commandMessage('That task changed. Read it again before opening it.'),
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
      this.status('thinking', commandMessage('Opening task…'));
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
        throw new CommandFailure(
          'FOCUS_LIMIT',
          commandMessage('Choose at most five working entities.'),
        );
      const verified: VerifiedFocus[] = [];
      for (const entry of requested) verified.push(await this.verifyFocus(entry, read));
      if (!current()) return false;
      if (this.retainFocusTransition(requested, verified)) return false;
      for (const entry of verified) this.observeFocus(entry);
      this.publish({ focus: verified.map((entry) => entry.focus) });
      return true;
    } catch (cause) {
      if (current()) this.status('error', focusError(cause));
      return false;
    }
  }
  private retainFocusTransition(
    requested: readonly CommandFocus[],
    verified: readonly VerifiedFocus[],
  ): boolean {
    if (this.readOnly()) return false;
    if (this.retainProjectMoveFocus(requested)) return true;
    this.restoreProjectMoveRoot(requested);
    if (this.hasProjectTaskContext(verified)) return false;
    if (!this.needsFocusDisposition(requested)) return false;
    this.requestTransition(
      { kind: 'focus', target: requested },
      commandMessage('Save these changes, keep them for later, discard them, or stay here?'),
    );
    return true;
  }
  private hasProjectTaskContext(verified: readonly VerifiedFocus[]): boolean {
    return this.state.proposal.changes.some(
      (change) =>
        change.kind === 'project' &&
        verified.some(
          (entry) => entry.kind === 'task' && entry.tree.tree.source?.path === change.before.path,
        ),
    );
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
  private retainProjectMoveFocus(requested: readonly CommandFocus[]): boolean {
    if (projectMoveWithDescendantFocus(this.state.proposal.changes, requested) === undefined)
      return false;
    this.requestTransition(
      { kind: 'focus', target: requested },
      commandDiagnostic(projectMoveFocusMessage),
    );
    return true;
  }
  private pendingProjectMoveFocus(): Extract<CommandChange, { kind: 'project-move' }> | undefined {
    const pending = this.state.pendingTransition;
    return pending?.kind === 'focus'
      ? projectMoveWithDescendantFocus(this.state.proposal.changes, pending.target)
      : undefined;
  }
  private restoreProjectMoveRoot(requested: readonly CommandFocus[]): void {
    const pending = this.pendingProjectMoveFocus();
    if (
      pending === undefined ||
      !requested.some((entry) => entry.kind === 'task' && entry.target === pending.before.target)
    )
      return;
    const question = this.previousQuestion();
    this.publish({
      pendingTransition: null,
      activeQuestion: question,
      status: {
        kind: question === null ? 'ready' : 'question',
        message: question ?? commandMessage('Ready for review.'),
      },
    });
  }
  private needsFocusDisposition(requested: readonly CommandFocus[]): boolean {
    if (this.readOnly() || this.state.proposal.changes.length === 0) return false;
    if (requested.length === 0 && this.state.focus.length === 0) return false;
    if (
      requested.some((entry) => this.state.focus.some((current) => current.target === entry.target))
    )
      return false;
    return !requested.some((entry) =>
      this.state.proposal.changes.some((change) => {
        if (change.kind === 'project') return entry.target === change.before.target;
        if (change.kind === 'project-create') return false;
        if (change.kind === 'project-move')
          return (
            entry.target === change.destination.target || entry.target === change.before.target
          );
        if (change.kind === 'note') return entry.target === change.plan.note?.target;
        if (change.kind === 'status') return entry.target === change.target;
        return commandPlanViews(change.plan).some(
          (view) =>
            focusNode(view.after, entry.target) !== undefined ||
            focusNode(view.before, entry.target) !== undefined,
        );
      }),
    );
  }
  async resolveTransition(
    disposition: CommandTransitionDisposition,
    signal?: AbortSignal,
    basis?: CommandTransitionBasis,
    review?: CommandNoteReview,
  ): Promise<boolean> {
    if (!(await this.transitionAllowed(signal, basis))) return false;
    const pending = this.state.pendingTransition;
    if (pending == null) return false;
    if (disposition === 'cancel') {
      const question = this.previousQuestion();
      this.publish({
        pendingTransition: null,
        activeQuestion: question,
        status:
          question === null
            ? { kind: 'ready', message: commandMessage('Current work retained.') }
            : { kind: 'question', message: question },
      });
      return true;
    }
    if (disposition === 'save') return this.saveTransition(pending, signal, review);
    if (pending.kind === 'new-session') return this.newSession(disposition, signal);
    if (!(await this.newSession(disposition, signal))) return false;
    return this.focus(pending.target, signal);
  }
  private saveTransition(
    pending: CommandPendingTransition,
    signal: AbortSignal | undefined,
    review: CommandNoteReview | undefined,
  ): Promise<boolean> {
    if (this.pendingProjectMoveFocus() !== undefined) {
      this.question(commandDiagnostic(projectMoveFocusMessage));
      return Promise.resolve(false);
    }
    return this.saveAndFocus(pending.kind === 'focus' ? pending.target : undefined, signal, review);
  }
  private currentTransition(basis?: CommandTransitionBasis): boolean {
    return (
      basis === undefined ||
      (basis.sessionId === this.state.id &&
        basis.proposalRevision === this.state.proposal.revision &&
        JSON.stringify(basis.pendingTransition) === JSON.stringify(this.state.pendingTransition))
    );
  }
  private async saveAndFocus(
    target: readonly CommandFocus[] | undefined,
    signal?: AbortSignal,
    review?: CommandNoteReview,
  ): Promise<boolean> {
    const question = this.previousQuestion();
    if (question !== null) {
      this.question(question);
      return false;
    }
    this.publish({ activeQuestion: null, status: { kind: 'ready', message: '' } });
    const saved =
      signal === undefined
        ? await this.confirm(this.state.proposal.revision, review)
        : await this.confirmFromTurn(this.state.proposal.revision, signal);
    if (!saved) return false;
    this.publish({ pendingTransition: null });
    if (target === undefined) return this.newSession('keep', signal);
    return this.focus(
      target.map((entry) => ({ kind: entry.kind, target: entry.target })),
      signal,
    );
  }
  private async transitionAllowed(
    signal?: AbortSignal,
    basis?: CommandTransitionBasis,
  ): Promise<boolean> {
    if (signal === undefined) await this.settle();
    else if (this.turn?.signal !== signal || signal.aborted) return false;
    return !this.disposed && !this.writing && this.currentTransition(basis);
  }
  private async verifyFocus(
    target: CommandFocus,
    read: <T>(work: () => Promise<ApiResultV1<T>>) => Promise<T>,
  ): Promise<VerifiedFocus> {
    if (target.kind === 'task') return this.verifyTaskFocus(target, read);
    if (target.kind === 'project') {
      const project = await read(() => required(this.options.api.projects).get(target.target));
      if (target.revision !== undefined && project.revision !== target.revision)
        throw new CommandFailure(
          'STALE_FOCUS',
          commandMessage('The project changed before it could be selected.'),
        );
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
      const views = commandPlanViews(change.plan);
      const after = views
        .map((view) => focusNode(view.after, target.target))
        .find((node) => node !== undefined);
      const node =
        after ??
        views
          .map((view) => focusNode(view.before, target.target))
          .find((node) => node !== undefined);
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
        commandMessage('Use the exact current proposal and node for draft selection.'),
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
  resolveTreeRead(query: ReadTaskTreeV1): ReadTaskTreeV1 {
    if (
      this.readOnly() ||
      [
        query.plan,
        query.expectedPlanRevision,
        query.expectedRevision,
        query.side,
        query.cursor,
      ].some((value) => value !== undefined)
    )
      return query;
    const { focus, side } = this.taskFocusBasis({ kind: 'task', target: query.target });
    return focus.plan === undefined
      ? query
      : {
          ...query,
          plan: focus.plan,
          expectedPlanRevision: required(focus.expectedPlanRevision),
          side,
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
    const removed = this.state.focus.some(
      (entry) => entry.kind === 'task' && changes.get(entry.target) === null,
    );
    this.publish(
      {
        focus: this.state.focus.flatMap((entry): CommandFocus[] => {
          if (entry.kind !== 'task' || !changes.has(entry.target)) return [entry];
          const next = changes.get(entry.target);
          return next == null
            ? []
            : [{ kind: 'task', target: next.target, revision: next.revision }];
        }),
      },
      !removed,
    );
  }
  async readTreePage(query: ReadTaskTreeV1): Promise<TaskTreePageV1> {
    const id = this.state.id,
      revision = this.conversationRevision,
      signal = new AbortController().signal;
    const page = await commandRead(
      this.options.api,
      () => required(this.options.api.tasks.tree)(query),
      signal,
      { deadline: this.options.now() + 5000, now: this.options.now },
    );
    if (
      !this.disposed &&
      this.state.id === id &&
      this.conversationRevision === revision &&
      !this.readOnly()
    )
      this.observeTree(page);
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
  discardDraft(plan: string, revision: string): number {
    const draft = this.state.proposal.changes.find(
      (c) => c.kind === 'task' && c.plan.target === plan,
    );
    if (draft?.kind !== 'task' || draft.plan.before !== null || draft.plan.revision !== revision)
      throw new CommandFailure(
        'DRAFT',
        commandMessage('Only the current unsaved root can be discarded.'),
      );
    const changes = this.state.proposal.changes.filter((c) =>
      c.kind === 'status'
        ? c.plan !== plan
        : c.kind === 'project' ||
          c.kind === 'project-create' ||
          c.kind === 'project-move' ||
          c.plan.target !== plan,
    );
    const proposalRevision = this.state.proposal.revision + 1;
    this.publish({
      proposal: {
        revision: proposalRevision,
        operations: this.state.proposal.operations + 1,
        changes,
      },
      focus: this.state.focus.filter(
        (entry) => entry.kind !== 'task' || !nodeValues(draft.plan.after).has(entry.target),
      ),
      trees: changes.flatMap(changeViews),
    });
    return proposalRevision;
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
          error instanceof CommandFailure
            ? error.message
            : commandMessage('Could not change the draft status.'),
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
      nuance: commandMessage(
        'Status uses ordinary completion, recurrence, deletion, timer and blocker rules after the content is saved.',
      ),
    });
  }
  setInput(text: string, draft = true): void {
    this.inputRevision++;
    if (draft) this.editRevision++;
    this.inputDraft = draft && text !== '';
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
    requireComposable(change, changes);
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
      throw new CommandFailure(
        'BUDGET',
        commandMessage('This proposal is too large. Save or split it first.'),
      );
    this.publish({
      preparations: [...(this.state.preparations ?? []), ...preparations],
      focus: planFocus(this.state.focus, change),
      proposal: {
        revision: this.state.proposal.revision + 1,
        operations: this.state.proposal.operations + operations,
        changes: retained,
      },
      trees: retained.flatMap(changeViews),
      activeQuestion: null,
      status: { kind: 'ready', message: commandMessage('Ready for review.') },
    });
  }
  private requireStageable(): void {
    if (this.disposed || this.writing || this.readOnly() || this.state.pendingTransition != null)
      throw new CommandFailure(
        'BUSY',
        commandMessage('Resolve the previous write before changing this proposal.'),
      );
  }
  async submit(
    text: string,
    submittedAgainst?: CommandSubmissionBasis,
    review?: CommandNoteReview,
    admission?: () => boolean,
  ): Promise<void> {
    if (!this.admitSubmission(admission)) return;
    const input = this.captureInput();
    if (text.length <= 16000 && text.trim() === '') {
      await this.confirmSubmission(submittedAgainst, review);
      return;
    }
    if (this.running !== undefined || this.pendingWrite !== undefined) {
      await this.submitAfterDrain(text, input, admission, () =>
        this.startSubmission(text, input, submittedAgainst, review),
      );
      return;
    }
    await this.startSubmission(text, input, submittedAgainst, review);
  }
  private async startSubmission(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    submittedAgainst?: CommandSubmissionBasis,
    review?: CommandNoteReview,
  ): Promise<void> {
    if (this.rejectOversizedInput(text, input)) return;
    const running = this.runTurn(text, input, submittedAgainst, review);
    this.running = running;
    try {
      await running;
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }
  private async submitAfterDrain(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    admission: (() => boolean) | undefined,
    start: () => Promise<void>,
  ): Promise<void> {
    const previous = this.running ?? this.pendingWrite;
    this.cancelTurn(false);
    const generation = this.acceptance;
    this.queuedInput = { text, current: () => input.current() };
    await previous;
    if (generation !== this.acceptance) return;
    this.queuedInput = undefined;
    if (this.admitSubmission(admission)) await start();
  }
  private clearAcceptedInput(input: { current(): boolean }): void {
    if (input.current()) this.setInput('', false);
  }
  private retainInput(text: string, input: { current(): boolean }): void {
    if (input.current()) this.setInput(text);
  }
  private rejectOversizedInput(text: string, input: { current(): boolean }): boolean {
    if (text.length <= 16000) return false;
    this.retainInput(text, input);
    this.status(
      'error',
      commandMessage(
        'This command is too long. Shorten it before sending; your full input is retained.',
      ),
    );
    return true;
  }
  private restoreFailedInput(
    text: string,
    input: { current(): boolean },
    signal: AbortSignal,
    sessionId: string,
  ): void {
    if (this.acceptsTurn(signal, sessionId) && this.state.status.kind === 'error')
      this.retainInput(text, input);
  }
  private admitSubmission(admission: (() => boolean) | undefined): boolean {
    return !this.disposed && admission?.() !== false;
  }
  private unavailable(): boolean {
    return this.disposed || this.writing || this.turn !== undefined;
  }
  private async confirmSubmission(
    basis?: CommandSubmissionBasis,
    review?: CommandNoteReview,
  ): Promise<void> {
    if (basis !== undefined && basis.sessionId !== this.state.id) return;
    await this.confirm(basis?.proposalRevision, review);
  }
  private acceptsTurn(signal: AbortSignal, id: string): boolean {
    return !signal.aborted && this.current(id);
  }
  private restoreQuestionStatus(): void {
    const question = this.state.activeQuestion;
    this.status(question === null ? 'ready' : 'question', question ?? commandMessage('Ready.'));
  }
  private async runTurn(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    submittedAgainst?: CommandSubmissionBasis,
    review?: CommandNoteReview,
  ): Promise<void> {
    if (this.unavailable()) {
      this.status('error', commandMessage('Finish or reconcile the previous operation first.'));
      return;
    }
    this.presentation = undefined;
    this.clearAcceptedInput(input);
    this.exchange('user', text);
    const controller = new AbortController();
    this.turn = controller;
    this.turnReview = review;
    const snapshot = this.snapshot();
    const basis = {
      ...snapshot,
      submissionBasis: submittedAgainst ?? {
        sessionId: snapshot.id,
        proposalRevision: snapshot.proposal.revision,
      },
    };
    this.status('thinking', commandMessage('Working…'));
    try {
      await this.options.agent.run({ text, signal: controller.signal, session: basis });
      if (
        !controller.signal.aborted &&
        this.state.id === snapshot.id &&
        this.state.status.kind === 'thinking'
      )
        this.restoreQuestionStatus();
    } catch (cause) {
      if (this.acceptsTurn(controller.signal, snapshot.id))
        this.status(
          'error',
          cause instanceof CommandFailure ? cause.message : providerFailure(cause).message,
        );
    } finally {
      this.restoreFailedInput(text, input, controller.signal, snapshot.id);
      if (this.turn === controller) {
        this.turn = undefined;
        this.turnReview = undefined;
      }
    }
  }
  cancelTurn(retainQueued = true): void {
    this.acceptance++;
    if (retainQueued && this.queuedInput !== undefined) {
      this.retainInput(this.queuedInput.text, this.queuedInput);
      this.queuedInput = undefined;
    }
    const active = this.turn !== undefined;
    this.turn?.abort();
    this.pendingReveal?.settle(false);
    this.writeAdmission?.abort();
    if (active && !this.writing && this.state.activeQuestion === null)
      this.status('ready', commandMessage('Stopped. Your draft is retained.'));
  }
  async whenIdle(): Promise<void> {
    while (this.running !== undefined || this.pendingWrite !== undefined) {
      await this.running;
      await this.pendingWrite;
    }
  }
  async settle(): Promise<void> {
    this.cancelTurn();
    await this.running;
    await this.pendingWrite;
  }
  async confirm(
    revision = this.state.proposal.revision,
    review?: CommandNoteReview,
  ): Promise<boolean> {
    if (this.turn !== undefined) return false;
    return this.commit(revision, review);
  }
  async confirmFromTurn(
    revision: number,
    signal: AbortSignal,
    immediate = false,
    scope?: CommandSaveScope,
  ): Promise<boolean> {
    if (this.turn?.signal !== signal || signal.aborted) return false;
    return this.commit(revision, this.turnReview, immediate, scope);
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
  private async commit(
    revision: number,
    review?: CommandNoteReview,
    immediate = false,
    scope?: CommandSaveScope,
  ): Promise<boolean> {
    if (this.pendingProjectMoveFocus() !== undefined) {
      this.question(commandDiagnostic(projectMoveFocusMessage));
      return false;
    }
    if (
      !this.canCommit(revision) ||
      !this.reviewedSelection({ revision, immediate, scope }, review)
    )
      return false;
    if (scope === undefined) return this.writeProposal(detached(this.state.proposal), true);
    return this.commitSelection(revision, scope);
  }
  private reviewedSelection(
    basis: { revision: number; immediate: boolean; scope: CommandSaveScope | undefined },
    review?: CommandNoteReview,
  ): boolean {
    const changes =
      basis.scope === undefined
        ? this.state.proposal.changes
        : basis.scope.changes.flatMap((selection) => {
            const change = this.state.proposal.changes[selection.index];
            return change === undefined ? [] : [change];
          });
    if (projectMoveWithDescendantFocus(changes, this.state.focus) !== undefined) {
      this.retainProjectMoveFocus(this.state.focus);
      return false;
    }
    if (
      !basis.immediate &&
      this.noteReviewRequired &&
      changes.some((change) => change.kind === 'note') &&
      review?.({ sessionId: this.state.id, proposalRevision: basis.revision }) !== true
    ) {
      this.status('ready', commandMessage('The note preview is not ready to save.'));
      return false;
    }
    return true;
  }
  private async commitSelection(revision: number, scope: CommandSaveScope): Promise<boolean> {
    const signal = required(this.turn).signal;
    try {
      const selection = await selectCommandWrite(
        this.options.api,
        detached(this.state.proposal),
        scope,
        { signal, now: this.options.now },
      );
      if (signal.aborted || !this.canCommit(revision)) return false;
      return this.writeProposal(selection.proposal, true, selection);
    } catch (cause) {
      if (signal.aborted || this.turn?.signal !== signal) return false;
      this.selectionFailed(cause);
      return false;
    }
  }
  private selectionFailed(cause: unknown): void {
    if (cause instanceof CommandFailure && cause.code === 'SELECTION_DEPENDENCY')
      this.question(cause.message);
    else
      this.status(
        'error',
        cause instanceof CommandFailure
          ? cause.message
          : commandMessage('Could not prepare the selected changes. Your proposal is retained.'),
      );
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
    remainder?: readonly CommandChange[],
  ): Promise<void> {
    const completed: CommandSessionSnapshot = {
      ...this.snapshot(),
      ...(clear ? this.completedProposal(proposal, inputRevision, remainder ?? []) : {}),
      status: this.completedStatus(clear, remainder ?? []),
    };
    await this.options.journal.save(completed);
    if (clear && inputRevision === this.inputRevision) this.inputDraft = false;
    this.publish({
      ...completed,
      input: inputRevision === this.inputRevision ? completed.input : this.state.input,
    });
  }
  private completedStatus(
    clear: boolean,
    remainder: readonly CommandChange[],
  ): CommandSessionSnapshot['status'] {
    if (remainder.length > 0)
      return {
        kind: 'ready',
        message: commandMessage('Selected changes saved. The rest is pending.'),
      };
    return clear
      ? { kind: 'saved', message: commandMessage('Saved.') }
      : {
          kind: 'ready',
          message: commandMessage('Status saved. Pending content is retained for review.'),
        };
  }
  private completedProposal(
    proposal: CommandSessionSnapshot['proposal'],
    inputRevision: number,
    changes: readonly CommandChange[],
  ): Partial<CommandSessionSnapshot> {
    return {
      proposal: { revision: proposal.revision + 1, operations: changes.length, changes },
      trees: changes.flatMap((change) =>
        change.kind === 'task' ? commandPlanViews(change.plan) : [],
      ),
      focus: this.refreshedFocus(changes.filter((change) => change.kind === 'task')),
      input: inputRevision === this.inputRevision ? '' : this.state.input,
    };
  }
  private async writeProposal(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
    selection?: CommandSelectedWrite,
  ): Promise<boolean> {
    const pending = this.performWrite(proposal, clear, selection);
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
    selection?: CommandSelectedWrite,
  ): Promise<boolean> {
    const inputRevision = this.inputRevision;
    const journalStart = this.state.journal.length;
    const admission = new AbortController();
    this.writeAdmission = admission;
    this.writing = true;
    this.status('writing', commandMessage('Saving…'));
    try {
      await executeCommandWrites({
        api: this.options.api,
        proposal,
        now: this.options.now,
        id: this.options.id,
        cancelled: () => admission.signal.aborted,
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
        createdProject: (project) => {
          this.publish({
            focus: [
              ...this.state.focus.filter((f) => f.target !== project.target),
              { kind: 'project' as const, target: project.target, revision: project.revision },
            ].slice(-5),
          });
        },
        observeProject: (project) => {
          this.observeProject(project);
        },
        observeNote: (note) => {
          this.observeNote(note);
        },
      });
      const remainder =
        selection === undefined
          ? undefined
          : await rebaseCommandRemainder(
              this.options.api,
              selection,
              this.state.journal.slice(journalStart),
              this.options.now,
            );
      await this.completeWrite(proposal, clear, inputRevision, remainder);
      return true;
    } catch (cause) {
      this.failedWrite(cause, journalStart);
      return false;
    } finally {
      this.writing = false;
      this.writeAdmission = undefined;
      this.releaseDisposed();
    }
  }
  private failedWrite(cause: unknown, journalStart: number): void {
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
            : commandMessage(
                'Could not save or record the result. Review the retained write journal before continuing.',
              ),
      },
    });
    if (!unsettled && cause instanceof CommandFailure && cause.code === 'PROJECT_MOVE_FOCUS')
      this.retainProjectMoveFocus(this.state.focus);
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
      commandMessage(
        'The earlier result is unresolved. Acknowledge it before starting independent work.',
      ),
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
        commandMessage('Keep this draft in history or discard it before starting a new session?'),
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
        this.status(
          'error',
          commandMessage('Could not retain this session. Keep it open and try again.'),
        );
      return false;
    }
  }
  private archivedStatus(): CommandSessionSnapshot['status'] {
    const question = this.previousQuestion();
    if (question !== null) return { kind: 'question', message: question };
    if (
      this.state.pendingTransition != null ||
      ['thinking', 'searching'].includes(this.state.status.kind)
    )
      return { kind: 'ready', message: commandMessage('Ready for review.') };
    return this.state.status;
  }
  private archivedSnapshot(
    disposition?: 'keep' | 'discard',
    acknowledgeUncertainty = false,
  ): CommandSessionSnapshot {
    const previous = {
      ...this.snapshot(),
      pendingTransition: null,
      activeQuestion: this.previousQuestion(),
      input: this.inputDraft ? this.state.input : '',
      status: this.archivedStatus(),
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
          status: { kind: 'ready', message: commandMessage('Draft discarded.') },
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
