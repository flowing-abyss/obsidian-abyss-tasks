import type {
  ApiResultV1,
  ContentPlanV1,
  NoteReadPageV1,
  ProjectDtoV1,
  ReadTaskTreeV1,
  TaskTreePageV1,
  TaskTreeV1,
} from '../../api';
import {
  commandDiagnostic,
  commandMessage,
  draftDispositionMessage,
  noteMoveConflictMessage,
  pendingProjectConflictMessage,
  projectMoveFocusMessage,
  savedContentStatusMessage,
  writeJournalFailureMessage,
} from './commandMessages';
import { projectMoveWithDescendantFocus } from './commandProjects';
import { canonicalCommandPlan, commandRead } from './commandReads';
import {
  discardedCommandEvidence,
  hasUnresolvedCommandWrites,
  recoverDiscardedSnapshot,
} from './commandRecovery';
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
  type CommandTurnOutcome,
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
    throw new CommandFailure('STRUCTURAL_CONFLICT', commandMessage(noteMoveConflictMessage));
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
    throw new CommandFailure('REVISION_CONFLICT', commandMessage(pendingProjectConflictMessage));
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
type TaskFocusBasisMatch = {
  plan: ContentPlanV1;
  node: TaskTreeV1;
  side: 'before' | 'after';
};
function exactAfterFocusOwner(
  matches: readonly TaskFocusBasisMatch[],
  revision: string,
): TaskFocusBasisMatch | undefined {
  const match = matches[matches.length - 1];
  return matches.every((entry) => entry.plan.target === match?.plan.target) &&
    match?.side === 'after' &&
    match.node.revision === revision
    ? match
    : undefined;
}
function selectedTaskFocusMatch(
  target: Extract<CommandFocus, { kind: 'task' }>,
  matches: TaskFocusBasisMatch[],
): TaskFocusBasisMatch | undefined {
  const match =
    target.plan === undefined
      ? matches[0]
      : matches.find((entry) => entry.plan.target === target.plan);
  if (
    target.plan === undefined &&
    matches.length === 0 &&
    target.expectedPlanRevision === undefined
  )
    return undefined;
  if (
    match === undefined ||
    (target.plan === undefined && matches.length !== 1) ||
    !matchesFocusRevision(target, match.node, match.plan.revision)
  )
    throw new CommandFailure(
      'STALE_FOCUS',
      commandMessage('Use the exact current proposal and node for draft selection.'),
    );
  return match;
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
// Public operations and detached snapshots are the boundary; live session state is not reflected or serialized.
export class CommandSession {
  private state_abyssPrivate: CommandSessionSnapshot;
  private published_abyssPrivate: CommandSessionSnapshot | undefined;
  private readonly listeners_abyssPrivate = new Set<(state: CommandSessionSnapshot) => void>();
  private turn_abyssPrivate: AbortController | undefined;
  private running_abyssPrivate: Promise<CommandTurnOutcome> | undefined;
  private pendingWrite_abyssPrivate: Promise<boolean> | undefined;
  private writing_abyssPrivate = false;
  private writeAdmission_abyssPrivate: AbortController | undefined;
  private disposed_abyssPrivate = false;
  private focusRun_abyssPrivate = 0;
  private pendingReveal_abyssPrivate: PendingReveal | undefined;
  private acceptance_abyssPrivate = 0;
  private queuedInput_abyssPrivate: { text: string; current(): boolean } | undefined;
  private inputRevision_abyssPrivate = 0;
  private editRevision_abyssPrivate = 0;
  private inputDraft_abyssPrivate = false;
  private noteReviewRequired_abyssPrivate = false;
  private turnReview_abyssPrivate: CommandNoteReview | undefined;
  requireNoteReview(): void {
    this.noteReviewRequired_abyssPrivate = true;
  }
  constructor(private readonly options_abyssPrivate: CommandSessionOptions) {
    this.state_abyssPrivate = this.empty_abyssPrivate();
  }
  private empty_abyssPrivate(
    voiceMode = this.options_abyssPrivate.defaultVoiceMode?.() ?? 'manual',
  ): CommandSessionSnapshot {
    return {
      id: this.options_abyssPrivate.id(),
      voiceMode,
      input: '',
      focus: [],
      context: this.options_abyssPrivate.context ?? '',
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
  private presentation_abyssPrivate: CommandSessionSnapshot['presentation'];
  private conversationRevision_abyssPrivate = 0;
  captureInput(): { dirty: boolean; current(): boolean } {
    const revision = this.editRevision_abyssPrivate;
    return {
      dirty: this.inputDraft_abyssPrivate,
      current: () => !this.disposed_abyssPrivate && this.editRevision_abyssPrivate === revision,
    };
  }
  captureSubmission(): { basis: CommandSubmissionBasis; current(): boolean } {
    const id = this.state_abyssPrivate.id,
      revision = this.conversationRevision_abyssPrivate;
    return {
      basis: { sessionId: id, proposalRevision: this.state_abyssPrivate.proposal.revision },
      current: () =>
        !this.disposed_abyssPrivate &&
        this.state_abyssPrivate.id === id &&
        this.conversationRevision_abyssPrivate === revision,
    };
  }
  setVoiceMode(mode: 'manual' | 'continuous'): void {
    if (!this.disposed_abyssPrivate) this.publish_abyssPrivate({ voiceMode: mode });
  }
  private presentationSession_abyssPrivate = '';
  showChanges(signal: AbortSignal): void {
    if (this.turn_abyssPrivate?.signal !== signal || signal.aborted) return;
    this.presentationSession_abyssPrivate = this.state_abyssPrivate.id;
    this.presentation_abyssPrivate = {
      proposalRevision: this.state_abyssPrivate.proposal.revision,
      changes: 'cumulative',
    };
    this.publish_abyssPrivate({});
  }
  snapshot(): CommandSessionSnapshot {
    if (this.published_abyssPrivate !== undefined) return this.published_abyssPrivate;
    // State ingress detaches each patch. Frozen siblings can be shared by later publications.
    const copy = {
      ...this.state_abyssPrivate,
      ...(this.presentationSession_abyssPrivate === this.state_abyssPrivate.id &&
      this.presentation_abyssPrivate?.proposalRevision ===
        this.state_abyssPrivate.proposal.revision &&
      this.state_abyssPrivate.proposal.changes.length > 0
        ? { presentation: this.presentation_abyssPrivate }
        : {}),
      ...(this.pendingReveal_abyssPrivate === undefined
        ? {}
        : { reveal: this.pendingReveal_abyssPrivate.request }),
    };
    freeze(copy);
    this.published_abyssPrivate = copy;
    return copy;
  }
  /** The owner calls this only after settling work and persisting selection. */
  restore(snapshot: CommandSessionSnapshot, historical = true): boolean {
    if (this.disposed_abyssPrivate || this.writing_abyssPrivate) return false;
    this.focusRun_abyssPrivate++;
    this.conversationRevision_abyssPrivate++;
    this.state_abyssPrivate = recoverDiscardedSnapshot(detached(snapshot));
    this.editRevision_abyssPrivate++;
    this.inputDraft_abyssPrivate = this.state_abyssPrivate.input !== '';
    Reflect.deleteProperty(this.state_abyssPrivate, 'reveal');
    Reflect.deleteProperty(this.state_abyssPrivate, 'presentation');
    this.presentation_abyssPrivate = undefined;
    if (historical || this.state_abyssPrivate.recoveryEvidence?.discarded === true) {
      const blocked = hasUnresolvedCommandWrites(snapshot);
      this.state_abyssPrivate = {
        ...this.state_abyssPrivate,
        blocked,
        recovery: blocked ? 'uncertain' : 'historical',
      };
      if (['thinking', 'searching', 'writing'].includes(this.state_abyssPrivate.status.kind))
        this.state_abyssPrivate = {
          ...this.state_abyssPrivate,
          status: blocked
            ? {
                kind: 'error',
                message: commandMessage(writeJournalFailureMessage),
              }
            : { kind: 'ready', message: commandMessage('Stopped. Your draft is retained.') },
        };
    }
    this.publish_abyssPrivate({});
    return true;
  }
  readOnly(): boolean {
    return (
      this.state_abyssPrivate.blocked ||
      this.state_abyssPrivate.recovery === 'historical' ||
      this.state_abyssPrivate.recovery === 'uncertain'
    );
  }
  beginReview(): boolean {
    if (
      this.disposed_abyssPrivate ||
      this.writing_abyssPrivate ||
      this.state_abyssPrivate.blocked ||
      this.state_abyssPrivate.recovery === 'uncertain'
    )
      return false;
    if (this.state_abyssPrivate.recovery === 'reviewing') return true;
    const previous = this.state_abyssPrivate;
    this.publish_abyssPrivate({
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
      this.state_abyssPrivate.recovery === 'reviewing' &&
      this.state_abyssPrivate.proposal.changes.length > 0 &&
      this.state_abyssPrivate.activeQuestion === null
    )
      this.publish_abyssPrivate({ recovery: 'live' });
  }
  prepared(value: CommandPreparation): void {
    if (this.disposed_abyssPrivate || this.readOnly()) return;
    this.publish_abyssPrivate({
      preparations: [...(this.state_abyssPrivate.preparations ?? []), value],
    });
  }
  private current_abyssPrivate(id: string): boolean {
    return !this.disposed_abyssPrivate && this.state_abyssPrivate.id === id;
  }
  private async refreshOwnedChanges_abyssPrivate(): Promise<
    Array<Extract<CommandChange, { kind: 'task' }>>
  > {
    const signal = new AbortController().signal;
    const timing = {
      now: this.options_abyssPrivate.now,
      deadline: this.options_abyssPrivate.now() + 5000,
    };
    const changes: Array<Extract<CommandChange, { kind: 'task' }>> = [];
    for (const change of this.state_abyssPrivate.proposal.changes) {
      if (change.kind !== 'task')
        throw new CommandFailure('REVIEW', commandMessage('Review this preview again.'));
      const page = await commandRead(
        this.options_abyssPrivate.api,
        () =>
          required(this.options_abyssPrivate.api.tasks.prepare)({
            kind: 'refresh',
            plan: change.plan.target,
            expectedPlanRevision: change.plan.revision,
          }),
        signal,
        timing,
      );
      const plan = await canonicalCommandPlan(this.options_abyssPrivate.api, page, signal, timing);
      if (!sameReviewedContent(change.plan, plan))
        throw new CommandFailure(
          'REVIEW',
          commandMessage('The source changed. Review a fresh preview.'),
        );
      changes.push({ kind: 'task', plan });
    }
    return changes;
  }
  private refreshedFocus_abyssPrivate(
    changes: ReadonlyArray<Extract<CommandChange, { kind: 'task' }>>,
  ): readonly CommandFocus[] {
    return this.state_abyssPrivate.focus.map((focus) => {
      if (focus.kind !== 'task') return focus;
      const change = changes.find((entry) => entry.plan.target === focus.plan);
      return change === undefined
        ? focus
        : { ...focus, expectedPlanRevision: change.plan.revision };
    });
  }
  /** Only the still-owning client may attempt this proof. Failure leaves historical evidence. */
  async resumeOwned(): Promise<void> {
    if (
      this.disposed_abyssPrivate ||
      this.state_abyssPrivate.blocked ||
      this.state_abyssPrivate.recoveryEvidence !== undefined
    )
      return;
    const id = this.state_abyssPrivate.id;
    try {
      const changes = await this.refreshOwnedChanges_abyssPrivate();
      if (!this.current_abyssPrivate(id)) return;
      this.publish_abyssPrivate({
        recovery: 'live',
        proposal: {
          ...this.state_abyssPrivate.proposal,
          revision: this.state_abyssPrivate.proposal.revision + 1,
          changes,
        },
        trees: changes.flatMap((change) => commandPlanViews(change.plan)),
        focus: this.refreshedFocus_abyssPrivate(changes),
      });
    } catch {
      if (this.current_abyssPrivate(id)) this.publish_abyssPrivate({ recovery: 'historical' });
    }
  }
  subscribe(listener: (state: CommandSessionSnapshot) => void): () => void {
    this.listeners_abyssPrivate.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners_abyssPrivate.delete(listener);
    };
  }
  private publish_abyssPrivate(
    patch: Partial<CommandSessionSnapshot>,
    verifiedFocusContinuation = false,
  ): void {
    const identity = (focus: readonly CommandFocus[]): string =>
      JSON.stringify(focus.map(({ kind, target }) => ({ kind, target })));
    if (
      (!verifiedFocusContinuation &&
        patch.focus !== undefined &&
        identity(patch.focus) !== identity(this.state_abyssPrivate.focus)) ||
      ('pendingTransition' in patch &&
        JSON.stringify(patch.pendingTransition ?? null) !==
          JSON.stringify(this.state_abyssPrivate.pendingTransition ?? null))
    )
      this.conversationRevision_abyssPrivate++;
    this.state_abyssPrivate = this.patchedState_abyssPrivate(patch);
    this.published_abyssPrivate = undefined;
    for (const listener of this.listeners_abyssPrivate) listener(this.snapshot());
  }
  private patchedState_abyssPrivate(
    patch: Partial<CommandSessionSnapshot>,
  ): CommandSessionSnapshot {
    const next = { ...this.state_abyssPrivate, ...detached(patch) };
    // A later focus or edit is now the last result. A live cancellation is visible only in history.
    if (
      this.state_abyssPrivate.recoveryEvidence?.discarded === true &&
      !this.readOnly() &&
      patch.recoveryEvidence === undefined &&
      ('focus' in patch || 'proposal' in patch || 'entities' in patch || 'actual' in patch)
    ) {
      Reflect.deleteProperty(next, 'recoveryEvidence');
    }
    return next;
  }
  status(kind: CommandStatusKind, message: string): void {
    this.publish_abyssPrivate({ status: { kind, message: message.slice(0, 500) } });
  }
  question(text: string): void {
    this.publish_abyssPrivate({
      activeQuestion: text.slice(0, 500),
      status: { kind: 'question', message: text.slice(0, 500) },
    });
  }
  answer(): void {
    this.publish_abyssPrivate({ activeQuestion: null });
  }
  async requestReveal(
    input: { target: string; revision: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    const turn = this.turn_abyssPrivate,
      id = this.state_abyssPrivate.id;
    if (turn === undefined || signal.aborted || this.writing_abyssPrivate || this.readOnly())
      return false;
    const task = await commandRead(
      this.options_abyssPrivate.api,
      () => this.options_abyssPrivate.api.tasks.get(input.target),
      signal,
      { now: this.options_abyssPrivate.now, deadline: this.options_abyssPrivate.now() + 5000 },
    );
    if (task.target !== input.target || task.revision !== input.revision)
      throw new CommandFailure(
        'REVEAL_STALE',
        commandMessage('That task changed. Read it again before opening it.'),
      );
    if (!this.currentRevealTurn_abyssPrivate(turn, id, signal)) return false;
    return this.waitForReveal_abyssPrivate(
      { id: this.options_abyssPrivate.id(), sessionId: id, ...input },
      turn,
      signal,
    );
  }
  private waitForReveal_abyssPrivate(
    request: CommandRevealRequest,
    turn: AbortController,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.pendingReveal_abyssPrivate?.settle(false);
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
          if (this.pendingReveal_abyssPrivate !== pending) return;
          this.pendingReveal_abyssPrivate = undefined;
          signal.removeEventListener('abort', abort);
          resolve(accepted);
          this.publish_abyssPrivate({});
        },
      };
      this.pendingReveal_abyssPrivate = pending;
      signal.addEventListener('abort', abort, { once: true });
      this.status('thinking', commandMessage('Opening task…'));
    });
  }
  claimReveal(request: CommandRevealRequest): boolean {
    const pending = this.matchingReveal_abyssPrivate(request);
    if (pending === undefined || pending.claimed) return false;
    pending.claimed = true;
    return true;
  }
  private currentRevealTurn_abyssPrivate(
    turn: AbortController,
    id: string,
    signal: AbortSignal,
  ): boolean {
    return this.current_abyssPrivate(id) && this.turn_abyssPrivate === turn && !signal.aborted;
  }
  private matchingReveal_abyssPrivate(request: CommandRevealRequest): PendingReveal | undefined {
    const pending = this.pendingReveal_abyssPrivate;
    if (
      pending === undefined ||
      !this.currentRevealTurn_abyssPrivate(pending.turn, request.sessionId, pending.signal)
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
    const pending = this.matchingReveal_abyssPrivate(request);
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
    const id = this.state_abyssPrivate.id,
      run = ++this.focusRun_abyssPrivate,
      deadline = this.options_abyssPrivate.now() + 5000;
    const current = (): boolean =>
      !this.disposed_abyssPrivate &&
      !signal.aborted &&
      this.state_abyssPrivate.id === id &&
      this.focusRun_abyssPrivate === run;
    const read = <T>(work: () => Promise<ApiResultV1<T>>): Promise<T> =>
      commandRead(this.options_abyssPrivate.api, work, signal, {
        deadline,
        now: this.options_abyssPrivate.now,
      });
    try {
      if (requested.length > 5)
        throw new CommandFailure(
          'FOCUS_LIMIT',
          commandMessage('Choose at most five working entities.'),
        );
      const verified: VerifiedFocus[] = [];
      for (const entry of requested)
        verified.push(await this.verifyFocus_abyssPrivate(entry, read));
      if (!current()) return false;
      if (this.retainFocusTransition_abyssPrivate(requested, verified)) return false;
      for (const entry of verified) this.observeFocus_abyssPrivate(entry);
      this.publish_abyssPrivate({ focus: verified.map((entry) => entry.focus) });
      return true;
    } catch (cause) {
      if (current()) this.status('error', focusError(cause));
      return false;
    }
  }
  private retainFocusTransition_abyssPrivate(
    requested: readonly CommandFocus[],
    verified: readonly VerifiedFocus[],
  ): boolean {
    if (this.readOnly()) return false;
    if (this.retainProjectMoveFocus_abyssPrivate(requested)) return true;
    this.restoreProjectMoveRoot_abyssPrivate(requested);
    if (this.hasProjectTaskContext_abyssPrivate(verified)) return false;
    if (!this.needsFocusDisposition_abyssPrivate(requested)) return false;
    this.requestTransition_abyssPrivate(
      { kind: 'focus', target: requested },
      commandMessage(draftDispositionMessage),
    );
    return true;
  }
  private hasProjectTaskContext_abyssPrivate(verified: readonly VerifiedFocus[]): boolean {
    return this.state_abyssPrivate.proposal.changes.some(
      (change) =>
        change.kind === 'project' &&
        verified.some(
          (entry) => entry.kind === 'task' && entry.tree.tree.source?.path === change.before.path,
        ),
    );
  }
  private requestTransition_abyssPrivate(
    pending: CommandPendingTransition,
    question: string,
  ): void {
    const requested = { ...pending, previousQuestion: this.previousQuestion_abyssPrivate() };
    if (JSON.stringify(requested) === JSON.stringify(this.state_abyssPrivate.pendingTransition))
      return;
    this.publish_abyssPrivate({
      pendingTransition: requested,
      proposal: {
        ...this.state_abyssPrivate.proposal,
        revision: this.state_abyssPrivate.proposal.revision + 1,
      },
    });
    this.question(question);
  }
  private previousQuestion_abyssPrivate(): string | null {
    return this.state_abyssPrivate.pendingTransition == null
      ? this.state_abyssPrivate.activeQuestion
      : (this.state_abyssPrivate.pendingTransition.previousQuestion ?? null);
  }
  private retainProjectMoveFocus_abyssPrivate(requested: readonly CommandFocus[]): boolean {
    if (
      projectMoveWithDescendantFocus(this.state_abyssPrivate.proposal.changes, requested) ===
      undefined
    )
      return false;
    this.requestTransition_abyssPrivate(
      { kind: 'focus', target: requested },
      commandDiagnostic(projectMoveFocusMessage),
    );
    return true;
  }
  private pendingProjectMoveFocus_abyssPrivate():
    Extract<CommandChange, { kind: 'project-move' }> | undefined {
    const pending = this.state_abyssPrivate.pendingTransition;
    return pending?.kind === 'focus'
      ? projectMoveWithDescendantFocus(this.state_abyssPrivate.proposal.changes, pending.target)
      : undefined;
  }
  private restoreProjectMoveRoot_abyssPrivate(requested: readonly CommandFocus[]): void {
    const pending = this.pendingProjectMoveFocus_abyssPrivate();
    if (
      pending === undefined ||
      !requested.some((entry) => entry.kind === 'task' && entry.target === pending.before.target)
    )
      return;
    const question = this.previousQuestion_abyssPrivate();
    this.publish_abyssPrivate({
      pendingTransition: null,
      activeQuestion: question,
      status: {
        kind: question === null ? 'ready' : 'question',
        message: question ?? commandMessage('Ready for review.'),
      },
    });
  }
  private needsFocusDisposition_abyssPrivate(requested: readonly CommandFocus[]): boolean {
    if (this.readOnly() || this.state_abyssPrivate.proposal.changes.length === 0) return false;
    if (requested.length === 0 && this.state_abyssPrivate.focus.length === 0) return false;
    if (
      requested.some((entry) =>
        this.state_abyssPrivate.focus.some((current) => current.target === entry.target),
      )
    )
      return false;
    return !requested.some((entry) =>
      this.state_abyssPrivate.proposal.changes.some((change) => {
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
    if (!(await this.transitionAllowed_abyssPrivate(signal, basis))) return false;
    const pending = this.state_abyssPrivate.pendingTransition;
    if (pending == null) return false;
    if (disposition === 'cancel') {
      const question = this.previousQuestion_abyssPrivate();
      this.publish_abyssPrivate({
        pendingTransition: null,
        activeQuestion: question,
        status:
          question === null
            ? { kind: 'ready', message: commandMessage('Current work retained.') }
            : { kind: 'question', message: question },
      });
      return true;
    }
    if (disposition === 'save') return this.saveTransition_abyssPrivate(pending, signal, review);
    if (pending.kind === 'new-session') return this.newSession(disposition, signal);
    if (!(await this.newSession(disposition, signal))) return false;
    return this.focus(pending.target, signal);
  }
  private saveTransition_abyssPrivate(
    pending: CommandPendingTransition,
    signal: AbortSignal | undefined,
    review: CommandNoteReview | undefined,
  ): Promise<boolean> {
    if (this.pendingProjectMoveFocus_abyssPrivate() !== undefined) {
      this.question(commandDiagnostic(projectMoveFocusMessage));
      return Promise.resolve(false);
    }
    return this.saveAndFocus_abyssPrivate(
      pending.kind === 'focus' ? pending.target : undefined,
      signal,
      review,
    );
  }
  private currentTransition_abyssPrivate(basis?: CommandTransitionBasis): boolean {
    return (
      basis === undefined ||
      (basis.sessionId === this.state_abyssPrivate.id &&
        basis.proposalRevision === this.state_abyssPrivate.proposal.revision &&
        JSON.stringify(basis.pendingTransition) ===
          JSON.stringify(this.state_abyssPrivate.pendingTransition))
    );
  }
  private async saveAndFocus_abyssPrivate(
    target: readonly CommandFocus[] | undefined,
    signal?: AbortSignal,
    review?: CommandNoteReview,
  ): Promise<boolean> {
    const question = this.previousQuestion_abyssPrivate();
    if (question !== null) {
      this.question(question);
      return false;
    }
    this.publish_abyssPrivate({ activeQuestion: null, status: { kind: 'ready', message: '' } });
    const saved =
      signal === undefined
        ? await this.confirm(this.state_abyssPrivate.proposal.revision, review)
        : await this.confirmFromTurn(this.state_abyssPrivate.proposal.revision, signal);
    if (!saved) return false;
    this.publish_abyssPrivate({ pendingTransition: null });
    if (target === undefined) return this.newSession('keep', signal);
    return this.focus(
      target.map((entry) => ({ kind: entry.kind, target: entry.target })),
      signal,
    );
  }
  private async transitionAllowed_abyssPrivate(
    signal?: AbortSignal,
    basis?: CommandTransitionBasis,
  ): Promise<boolean> {
    if (signal === undefined) await this.settle();
    else if (this.turn_abyssPrivate?.signal !== signal || signal.aborted) return false;
    return (
      !this.disposed_abyssPrivate &&
      !this.writing_abyssPrivate &&
      this.currentTransition_abyssPrivate(basis)
    );
  }
  private async verifyFocus_abyssPrivate(
    target: CommandFocus,
    read: <T>(work: () => Promise<ApiResultV1<T>>) => Promise<T>,
  ): Promise<VerifiedFocus> {
    if (target.kind === 'task') return this.verifyTaskFocus_abyssPrivate(target, read);
    if (target.kind === 'project') {
      const project = await read(() =>
        required(this.options_abyssPrivate.api.projects).get(target.target),
      );
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
      required(this.options_abyssPrivate.api.notes).read({
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
        this.state_abyssPrivate.entities.notes.find(
          (page) =>
            page.note.target === note.note.target && page.note.revision === note.note.revision,
        ) ?? note,
      focus: { kind: 'note', target: note.note.target, revision: note.note.revision },
    };
  }
  private taskFocusBasis_abyssPrivate(
    target: Extract<CommandFocus, { kind: 'task' }>,
    exactAfterRevision?: string,
  ): {
    focus: Extract<CommandFocus, { kind: 'task' }>;
    side: 'before' | 'after';
  } {
    const matches = this.state_abyssPrivate.proposal.changes.flatMap((change) => {
      if (change.kind !== 'task' && change.kind !== 'cleanup') return [];
      const views = commandPlanViews(change.plan);
      const after = views
        .map((view) => focusNode(view.after, target.target))
        .find((node) => node !== undefined);
      const node =
        after ??
        views
          .map((view) => focusNode(view.before, target.target))
          .find((value) => value !== undefined);
      const side = after === undefined ? ('before' as const) : ('after' as const);
      return node === undefined ? [] : [{ plan: change.plan, node, side }];
    });
    const match =
      exactAfterRevision === undefined
        ? selectedTaskFocusMatch(target, matches)
        : exactAfterFocusOwner(matches, exactAfterRevision);
    if (match === undefined) return { focus: target, side: 'after' };
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
      [query.plan, query.expectedPlanRevision, query.side, query.cursor].some(
        (value) => value !== undefined,
      )
    )
      return query;
    const target = { kind: 'task' as const, target: query.target };
    const { focus, side } = this.taskFocusBasis_abyssPrivate(target, query.expectedRevision);
    return focus.plan === undefined
      ? query
      : {
          ...query,
          plan: focus.plan,
          expectedPlanRevision: required(focus.expectedPlanRevision),
          side,
        };
  }
  private async verifyTaskFocus_abyssPrivate(
    requested: Extract<CommandFocus, { kind: 'task' }>,
    read: <T>(work: () => Promise<ApiResultV1<T>>) => Promise<T>,
  ): Promise<VerifiedFocus> {
    const { focus: target, side } = this.taskFocusBasis_abyssPrivate(requested);
    const acceptedBasis =
      target.revision === undefined ? {} : { expectedRevision: target.revision };
    const tree = await read(() =>
      required(this.options_abyssPrivate.api.tasks.tree)({
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
  private observeFocus_abyssPrivate(entry: VerifiedFocus): void {
    if (entry.kind === 'task') this.observeTree(entry.tree);
    else if (entry.kind === 'project') this.observeProject(entry.project);
    else this.observeNote(entry.note);
  }
  remapFocus(changes: CommandFocusContinuations): void {
    const removed = this.state_abyssPrivate.focus.some(
      (entry) => entry.kind === 'task' && changes.get(entry.target) === null,
    );
    this.publish_abyssPrivate(
      {
        focus: this.state_abyssPrivate.focus.flatMap((entry): CommandFocus[] => {
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
    const id = this.state_abyssPrivate.id,
      revision = this.conversationRevision_abyssPrivate,
      signal = new AbortController().signal;
    const page = await commandRead(
      this.options_abyssPrivate.api,
      () => required(this.options_abyssPrivate.api.tasks.tree)(query),
      signal,
      { deadline: this.options_abyssPrivate.now() + 5000, now: this.options_abyssPrivate.now },
    );
    if (
      !this.disposed_abyssPrivate &&
      this.state_abyssPrivate.id === id &&
      this.conversationRevision_abyssPrivate === revision &&
      !this.readOnly()
    )
      this.observeTree(page);
    return page;
  }
  observeTree(page: TaskTreePageV1): void {
    this.publish_abyssPrivate({
      entities: {
        ...this.state_abyssPrivate.entities,
        tasks: [...this.state_abyssPrivate.entities.tasks, page].slice(-32),
      },
    });
  }
  observeProject(project: ProjectDtoV1): void {
    this.publish_abyssPrivate({
      focus: this.state_abyssPrivate.focus.map((entry) =>
        entry.kind === 'project' && entry.target === project.target
          ? { ...entry, revision: project.revision }
          : entry,
      ),
      entities: {
        ...this.state_abyssPrivate.entities,
        projects: [
          ...this.state_abyssPrivate.entities.projects.filter((p) => p.target !== project.target),
          project,
        ].slice(-20),
      },
    });
  }
  observeNote(note: CommandNoteRead): void {
    this.publish_abyssPrivate({
      focus: this.state_abyssPrivate.focus.map((entry) =>
        entry.kind === 'note' && entry.target === note.note.target
          ? { ...entry, revision: note.note.revision }
          : entry,
      ),
      entities: {
        ...this.state_abyssPrivate.entities,
        notes: [
          ...this.state_abyssPrivate.entities.notes.filter(
            (n) => n.note.target !== note.note.target,
          ),
          note,
        ].slice(-10),
      },
    });
  }
  discardDraft(plan: string, revision: string): number {
    const draft = this.state_abyssPrivate.proposal.changes.find(
      (c) => c.kind === 'task' && c.plan.target === plan,
    );
    if (draft?.kind !== 'task' || draft.plan.before !== null || draft.plan.revision !== revision)
      throw new CommandFailure(
        'DRAFT',
        commandMessage('Only the current unsaved root can be discarded.'),
      );
    const changes = this.state_abyssPrivate.proposal.changes.filter((c) =>
      c.kind === 'status'
        ? c.plan !== plan
        : c.kind === 'project' ||
          c.kind === 'project-create' ||
          c.kind === 'project-move' ||
          c.plan.target !== plan,
    );
    const proposalRevision = this.state_abyssPrivate.proposal.revision + 1;
    this.publish_abyssPrivate({
      ...(changes.length === 0
        ? { recoveryEvidence: discardedCommandEvidence(this.state_abyssPrivate), preparations: [] }
        : {}),
      proposal: {
        revision: proposalRevision,
        operations: this.state_abyssPrivate.proposal.operations + 1,
        changes,
      },
      focus: this.state_abyssPrivate.focus.filter(
        (entry) => entry.kind !== 'task' || !nodeValues(draft.plan.after).has(entry.target),
      ),
      trees: changes.flatMap(changeViews),
    });
    return proposalRevision;
  }
  updateContext(context: string): void {
    if (!this.disposed_abyssPrivate) this.publish_abyssPrivate({ context: context.slice(0, 8000) });
  }
  async stageStatus(input: CommandStatusInput): Promise<boolean> {
    const basis = this.state_abyssPrivate;
    if (!this.canStageStatus_abyssPrivate(basis)) return false;
    const change = basis.proposal.changes.find(
      (entry) => entry.kind === 'task' && entry.plan.target === input.plan,
    );
    if (change?.kind !== 'task' || change.plan.revision !== input.expectedPlanRevision)
      return false;
    if (!this.draftStatusMatches_abyssPrivate(change.plan, input)) return false;
    try {
      return await this.applyDraftStatus_abyssPrivate(change.plan, input, basis);
    } catch (error) {
      if (this.current_abyssPrivate(basis.id))
        this.status(
          'error',
          error instanceof CommandFailure
            ? error.message
            : commandMessage('Could not change the draft status.'),
        );
      return false;
    }
  }
  private canStageStatus_abyssPrivate(basis: CommandSessionSnapshot): boolean {
    return (
      this.canApplyStatus_abyssPrivate(basis) &&
      this.turn_abyssPrivate === undefined &&
      this.state_abyssPrivate.pendingTransition == null
    );
  }
  private draftStatusMatches_abyssPrivate(plan: ContentPlanV1, input: CommandStatusInput): boolean {
    return (
      statusNodes(plan.after).find((node) => node.target === input.target)?.revision ===
      input.revision
    );
  }
  private async applyDraftStatus_abyssPrivate(
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
      const result = await required(this.options_abyssPrivate.api.tasks.prepare)(request);
      if (!result.ok) throw new CommandFailure(result.error.code, result.error.message);
      const plan = await canonicalCommandPlan(
        this.options_abyssPrivate.api,
        result.value,
        new AbortController().signal,
        { now: this.options_abyssPrivate.now, deadline: this.options_abyssPrivate.now() + 5000 },
      );
      if (!this.canApplyStatus_abyssPrivate(basis)) return false;
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
      nuance: commandMessage(savedContentStatusMessage),
    });
  }
  setInput(text: string, draft = true): void {
    this.inputRevision_abyssPrivate++;
    if (draft) this.editRevision_abyssPrivate++;
    this.inputDraft_abyssPrivate = draft && text !== '';
    this.publish_abyssPrivate({ input: text });
  }
  exchange(role: 'user' | 'agent', text: string): void {
    this.publish_abyssPrivate({
      exchanges: [...this.state_abyssPrivate.exchanges, { role, text }],
    });
  }
  stage(
    change: CommandChange,
    operations = 1,
    preparations: ReadonlyArray<Extract<CommandPreparation, { kind: 'task' }>> = [],
  ): void {
    this.requireStageable_abyssPrivate();
    validateChange(change);
    const changes = [...this.state_abyssPrivate.proposal.changes];
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
    if (
      count > 50 ||
      !validOperationBudget(this.state_abyssPrivate.proposal.operations, operations)
    )
      throw new CommandFailure(
        'BUDGET',
        commandMessage('This proposal is too large. Save or split it first.'),
      );
    this.publish_abyssPrivate({
      preparations: [...(this.state_abyssPrivate.preparations ?? []), ...preparations],
      focus: planFocus(this.state_abyssPrivate.focus, change),
      proposal: {
        revision: this.state_abyssPrivate.proposal.revision + 1,
        operations: this.state_abyssPrivate.proposal.operations + operations,
        changes: retained,
      },
      trees: retained.flatMap(changeViews),
      activeQuestion: null,
      status: { kind: 'ready', message: commandMessage('Ready for review.') },
    });
  }
  private requireStageable_abyssPrivate(): void {
    if (
      this.disposed_abyssPrivate ||
      this.writing_abyssPrivate ||
      this.readOnly() ||
      this.state_abyssPrivate.pendingTransition != null
    )
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
  ): Promise<CommandTurnOutcome> {
    if (!this.admitSubmission_abyssPrivate(admission)) return;
    const input = this.captureInput();
    if (text.length <= 16000 && text.trim() === '') {
      await this.confirmSubmission_abyssPrivate(submittedAgainst, review);
      return;
    }
    if (this.running_abyssPrivate !== undefined || this.pendingWrite_abyssPrivate !== undefined) {
      return this.submitAfterDrain_abyssPrivate(text, input, admission, () =>
        this.startSubmission_abyssPrivate(text, input, submittedAgainst, review),
      );
    }
    return this.startSubmission_abyssPrivate(text, input, submittedAgainst, review);
  }
  private async startSubmission_abyssPrivate(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    submittedAgainst?: CommandSubmissionBasis,
    review?: CommandNoteReview,
  ): Promise<CommandTurnOutcome> {
    if (this.rejectOversizedInput_abyssPrivate(text, input)) return;
    const running = this.runTurn_abyssPrivate(text, input, submittedAgainst, review);
    this.running_abyssPrivate = running;
    try {
      return await running;
    } finally {
      if (this.running_abyssPrivate === running) this.running_abyssPrivate = undefined;
    }
  }
  private async submitAfterDrain_abyssPrivate(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    admission: (() => boolean) | undefined,
    start: () => Promise<CommandTurnOutcome>,
  ): Promise<CommandTurnOutcome> {
    const previous = this.running_abyssPrivate ?? this.pendingWrite_abyssPrivate;
    this.cancelTurn(false);
    const generation = this.acceptance_abyssPrivate;
    this.queuedInput_abyssPrivate = { text, current: () => input.current() };
    await previous;
    if (generation !== this.acceptance_abyssPrivate) return;
    this.queuedInput_abyssPrivate = undefined;
    if (this.admitSubmission_abyssPrivate(admission)) return start();
  }
  private clearAcceptedInput_abyssPrivate(input: { current(): boolean }): void {
    if (input.current()) this.setInput('', false);
  }
  private retainInput_abyssPrivate(text: string, input: { current(): boolean }): void {
    if (input.current()) this.setInput(text);
  }
  private rejectOversizedInput_abyssPrivate(text: string, input: { current(): boolean }): boolean {
    if (text.length <= 16000) return false;
    this.retainInput_abyssPrivate(text, input);
    this.status(
      'error',
      commandMessage(
        'This command is too long. Shorten it before sending; your full input is retained.',
      ),
    );
    return true;
  }
  private restoreFailedInput_abyssPrivate(
    text: string,
    input: { current(): boolean },
    signal: AbortSignal,
    sessionId: string,
  ): void {
    if (
      this.acceptsTurn_abyssPrivate(signal, sessionId) &&
      this.state_abyssPrivate.status.kind === 'error'
    )
      this.retainInput_abyssPrivate(text, input);
  }
  private admitSubmission_abyssPrivate(admission: (() => boolean) | undefined): boolean {
    return !this.disposed_abyssPrivate && admission?.() !== false;
  }
  private unavailable_abyssPrivate(): boolean {
    return (
      this.disposed_abyssPrivate ||
      this.writing_abyssPrivate ||
      this.turn_abyssPrivate !== undefined
    );
  }
  private async confirmSubmission_abyssPrivate(
    basis?: CommandSubmissionBasis,
    review?: CommandNoteReview,
  ): Promise<void> {
    if (basis !== undefined && basis.sessionId !== this.state_abyssPrivate.id) return;
    await this.confirm(basis?.proposalRevision, review);
  }
  private acceptsTurn_abyssPrivate(signal: AbortSignal, id: string): boolean {
    return !signal.aborted && this.current_abyssPrivate(id);
  }
  private restoreQuestionStatus_abyssPrivate(): void {
    const question = this.state_abyssPrivate.activeQuestion;
    this.status(question === null ? 'ready' : 'question', question ?? commandMessage('Ready.'));
  }
  private async runTurn_abyssPrivate(
    text: string,
    input: ReturnType<CommandSession['captureInput']>,
    submittedAgainst?: CommandSubmissionBasis,
    review?: CommandNoteReview,
  ): Promise<CommandTurnOutcome> {
    if (this.unavailable_abyssPrivate()) {
      this.status('error', commandMessage('Finish or reconcile the previous operation first.'));
      return;
    }
    this.presentation_abyssPrivate = undefined;
    this.clearAcceptedInput_abyssPrivate(input);
    this.exchange('user', text);
    const controller = new AbortController();
    this.turn_abyssPrivate = controller;
    this.turnReview_abyssPrivate = review;
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
      const outcome = await this.options_abyssPrivate.agent.run({
        text,
        signal: controller.signal,
        session: basis,
      });
      if (!this.acceptsTurn_abyssPrivate(controller.signal, snapshot.id)) return;
      if (this.state_abyssPrivate.status.kind === 'thinking')
        this.restoreQuestionStatus_abyssPrivate();
      return outcome;
    } catch (cause) {
      if (this.acceptsTurn_abyssPrivate(controller.signal, snapshot.id))
        this.status(
          'error',
          cause instanceof CommandFailure ? cause.message : providerFailure(cause).message,
        );
    } finally {
      this.restoreFailedInput_abyssPrivate(text, input, controller.signal, snapshot.id);
      if (this.turn_abyssPrivate === controller) {
        this.turn_abyssPrivate = undefined;
        this.turnReview_abyssPrivate = undefined;
      }
    }
  }
  cancelTurn(retainQueued = true): void {
    this.acceptance_abyssPrivate++;
    if (retainQueued && this.queuedInput_abyssPrivate !== undefined) {
      this.retainInput_abyssPrivate(
        this.queuedInput_abyssPrivate.text,
        this.queuedInput_abyssPrivate,
      );
      this.queuedInput_abyssPrivate = undefined;
    }
    const active = this.turn_abyssPrivate !== undefined;
    this.turn_abyssPrivate?.abort();
    this.pendingReveal_abyssPrivate?.settle(false);
    this.writeAdmission_abyssPrivate?.abort();
    if (active && !this.writing_abyssPrivate && this.state_abyssPrivate.activeQuestion === null)
      this.status('ready', commandMessage('Stopped. Your draft is retained.'));
  }
  async whenIdle(): Promise<void> {
    while (
      this.running_abyssPrivate !== undefined ||
      this.pendingWrite_abyssPrivate !== undefined
    ) {
      await this.running_abyssPrivate;
      await this.pendingWrite_abyssPrivate;
    }
  }
  async settle(): Promise<void> {
    this.cancelTurn();
    await this.running_abyssPrivate;
    await this.pendingWrite_abyssPrivate;
  }
  async confirm(
    revision = this.state_abyssPrivate.proposal.revision,
    review?: CommandNoteReview,
  ): Promise<boolean> {
    if (this.turn_abyssPrivate !== undefined) return false;
    return this.commit_abyssPrivate(revision, review);
  }
  async confirmFromTurn(
    revision: number,
    signal: AbortSignal,
    immediate = false,
    scope?: CommandSaveScope,
  ): Promise<boolean> {
    if (this.turn_abyssPrivate?.signal !== signal || signal.aborted) return false;
    return this.commit_abyssPrivate(revision, this.turnReview_abyssPrivate, immediate, scope);
  }
  private canCommit_abyssPrivate(revision: number): boolean {
    return (
      !this.disposed_abyssPrivate &&
      !this.writing_abyssPrivate &&
      !this.state_abyssPrivate.blocked &&
      (this.state_abyssPrivate.recovery === undefined ||
        this.state_abyssPrivate.recovery === 'live') &&
      this.state_abyssPrivate.activeQuestion === null &&
      this.state_abyssPrivate.status.kind !== 'error' &&
      revision === this.state_abyssPrivate.proposal.revision &&
      this.state_abyssPrivate.proposal.changes.length > 0
    );
  }
  private async commit_abyssPrivate(
    revision: number,
    review?: CommandNoteReview,
    immediate = false,
    scope?: CommandSaveScope,
  ): Promise<boolean> {
    if (this.pendingProjectMoveFocus_abyssPrivate() !== undefined) {
      this.question(commandDiagnostic(projectMoveFocusMessage));
      return false;
    }
    if (
      !this.canCommit_abyssPrivate(revision) ||
      !this.reviewedSelection_abyssPrivate({ revision, immediate, scope }, review)
    )
      return false;
    if (scope === undefined)
      return this.writeProposal_abyssPrivate(detached(this.state_abyssPrivate.proposal), true);
    return this.commitSelection_abyssPrivate(revision, scope);
  }
  private reviewedSelection_abyssPrivate(
    basis: { revision: number; immediate: boolean; scope: CommandSaveScope | undefined },
    review?: CommandNoteReview,
  ): boolean {
    const changes =
      basis.scope === undefined
        ? this.state_abyssPrivate.proposal.changes
        : basis.scope.changes.flatMap((selection) => {
            const change = this.state_abyssPrivate.proposal.changes[selection.index];
            return change === undefined ? [] : [change];
          });
    if (projectMoveWithDescendantFocus(changes, this.state_abyssPrivate.focus) !== undefined) {
      this.retainProjectMoveFocus_abyssPrivate(this.state_abyssPrivate.focus);
      return false;
    }
    if (
      !basis.immediate &&
      this.noteReviewRequired_abyssPrivate &&
      changes.some((change) => change.kind === 'note') &&
      review?.({ sessionId: this.state_abyssPrivate.id, proposalRevision: basis.revision }) !== true
    ) {
      this.status('ready', commandMessage('The note preview is not ready to save.'));
      return false;
    }
    return true;
  }
  private async commitSelection_abyssPrivate(
    revision: number,
    scope: CommandSaveScope,
  ): Promise<boolean> {
    const signal = required(this.turn_abyssPrivate).signal;
    try {
      const selection = await selectCommandWrite(
        this.options_abyssPrivate.api,
        detached(this.state_abyssPrivate.proposal),
        scope,
        { signal, now: this.options_abyssPrivate.now },
      );
      if (signal.aborted || !this.canCommit_abyssPrivate(revision)) return false;
      return this.writeProposal_abyssPrivate(selection.proposal, true, selection);
    } catch (cause) {
      if (signal.aborted || this.turn_abyssPrivate?.signal !== signal) return false;
      this.selectionFailed_abyssPrivate(cause);
      return false;
    }
  }
  private selectionFailed_abyssPrivate(cause: unknown): void {
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
    const basis = this.state_abyssPrivate;
    if (!this.canApplyStatus_abyssPrivate(basis)) return false;
    this.cancelTurn();
    if (this.running_abyssPrivate !== undefined) await this.running_abyssPrivate;
    if (!this.canApplyStatus_abyssPrivate(basis)) return false;
    return this.writeProposal_abyssPrivate(
      {
        revision: this.state_abyssPrivate.proposal.revision,
        operations: 1,
        changes: [{ kind: 'status', ...input, nuance: 'Ordinary status lifecycle.' }],
      },
      false,
    );
  }
  private canApplyStatus_abyssPrivate(basis: CommandSessionSnapshot): boolean {
    return (
      this.current_abyssPrivate(basis.id) &&
      this.state_abyssPrivate.proposal.revision === basis.proposal.revision &&
      !this.writing_abyssPrivate &&
      !this.readOnly() &&
      this.state_abyssPrivate.recovery !== 'reviewing'
    );
  }
  private invalidateTaskReads_abyssPrivate(path: string): void {
    const draftTargets = new Set<string>();
    for (const change of this.state_abyssPrivate.proposal.changes) {
      if (change.kind !== 'task') continue;
      if ((change.plan.destination?.path ?? change.plan.before?.source?.path) !== path) continue;
      for (const target of nodeValues(change.plan.after).keys()) draftTargets.add(target);
      for (const target of nodeValues(change.plan.before).keys()) draftTargets.add(target);
    }
    this.publish_abyssPrivate({
      entities: {
        ...this.state_abyssPrivate.entities,
        tasks: this.state_abyssPrivate.entities.tasks.filter(
          (page) => page.tree.source?.path !== path && !draftTargets.has(page.tree.target),
        ),
      },
    });
  }
  private async recordWrite_abyssPrivate(entry: CommandJournalEntry): Promise<void> {
    const journal = [...this.state_abyssPrivate.journal];
    const index = journal.findIndex((j) => j.id === entry.id);
    if (index < 0) journal.push(entry);
    else journal[index] = entry;
    this.publish_abyssPrivate({ journal });
    try {
      await this.options_abyssPrivate.journal.save(this.snapshot());
    } catch (cause) {
      if (entry.state === 'admitted')
        this.publish_abyssPrivate({
          journal: this.state_abyssPrivate.journal.map((record) =>
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
  private async completeWrite_abyssPrivate(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
    inputRevision: number,
    remainder?: readonly CommandChange[],
  ): Promise<void> {
    const completed: CommandSessionSnapshot = {
      ...this.snapshot(),
      ...(clear
        ? this.completedProposal_abyssPrivate(proposal, inputRevision, remainder ?? [])
        : {}),
      status: this.completedStatus_abyssPrivate(clear, remainder ?? []),
    };
    await this.options_abyssPrivate.journal.save(completed);
    if (clear && inputRevision === this.inputRevision_abyssPrivate)
      this.inputDraft_abyssPrivate = false;
    this.publish_abyssPrivate({
      ...completed,
      input:
        inputRevision === this.inputRevision_abyssPrivate
          ? completed.input
          : this.state_abyssPrivate.input,
    });
  }
  private completedStatus_abyssPrivate(
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
  private completedProposal_abyssPrivate(
    proposal: CommandSessionSnapshot['proposal'],
    inputRevision: number,
    changes: readonly CommandChange[],
  ): Partial<CommandSessionSnapshot> {
    return {
      proposal: { revision: proposal.revision + 1, operations: changes.length, changes },
      trees: changes.flatMap((change) =>
        change.kind === 'task' ? commandPlanViews(change.plan) : [],
      ),
      focus: this.refreshedFocus_abyssPrivate(changes.filter((change) => change.kind === 'task')),
      input: inputRevision === this.inputRevision_abyssPrivate ? '' : this.state_abyssPrivate.input,
    };
  }
  private async writeProposal_abyssPrivate(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
    selection?: CommandSelectedWrite,
  ): Promise<boolean> {
    const pending = this.performWrite_abyssPrivate(proposal, clear, selection);
    this.pendingWrite_abyssPrivate = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingWrite_abyssPrivate === pending) this.pendingWrite_abyssPrivate = undefined;
    }
  }
  private async performWrite_abyssPrivate(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
    selection?: CommandSelectedWrite,
  ): Promise<boolean> {
    const inputRevision = this.inputRevision_abyssPrivate;
    const journalStart = this.state_abyssPrivate.journal.length;
    const admission = new AbortController();
    this.writeAdmission_abyssPrivate = admission;
    this.writing_abyssPrivate = true;
    this.status('writing', commandMessage('Saving…'));
    try {
      await executeCommandWrites({
        api: this.options_abyssPrivate.api,
        proposal,
        now: this.options_abyssPrivate.now,
        id: this.options_abyssPrivate.id,
        cancelled: () => admission.signal.aborted,
        record: (entry) =>
          this.recordWrite_abyssPrivate({ ...entry, origin: clear ? 'proposal' : 'direct' }),
        actual: (trees) => {
          this.publish_abyssPrivate({ actual: trees });
        },
        projects: this.state_abyssPrivate.entities.projects,
        invalidateTaskReads: (path) => {
          this.invalidateTaskReads_abyssPrivate(path);
        },
        observeTree: (page) => {
          this.observeTree(page);
        },
        focus: () => this.state_abyssPrivate.focus,
        focusChanges: (changes) => {
          this.remapFocus(changes);
        },
        createdProject: (project) => {
          this.publish_abyssPrivate({
            focus: [
              ...this.state_abyssPrivate.focus.filter((f) => f.target !== project.target),
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
              this.options_abyssPrivate.api,
              selection,
              this.state_abyssPrivate.journal.slice(journalStart),
              this.options_abyssPrivate.now,
            );
      await this.completeWrite_abyssPrivate(proposal, clear, inputRevision, remainder);
      return true;
    } catch (cause) {
      this.failedWrite_abyssPrivate(cause, journalStart);
      return false;
    } finally {
      this.writing_abyssPrivate = false;
      this.writeAdmission_abyssPrivate = undefined;
      this.releaseDisposed_abyssPrivate();
    }
  }
  private failedWrite_abyssPrivate(cause: unknown, journalStart: number): void {
    const unsettled = this.state_abyssPrivate.journal
      .slice(journalStart)
      .some(
        (j) =>
          j.state === 'admitted' ||
          j.effects === 'unknown' ||
          j.effects === 'partial' ||
          j.effects === 'committed',
      );
    this.publish_abyssPrivate({
      blocked: unsettled,
      ...this.writeRecovery_abyssPrivate(unsettled, cause),
      status: {
        kind: 'error',
        message:
          cause instanceof CommandFailure
            ? cause.message
            : commandMessage(writeJournalFailureMessage),
      },
    });
    if (!unsettled && cause instanceof CommandFailure && cause.code === 'PROJECT_MOVE_FOCUS')
      this.retainProjectMoveFocus_abyssPrivate(this.state_abyssPrivate.focus);
  }
  private writeRecovery_abyssPrivate(
    unsettled: boolean,
    cause: unknown,
  ): Partial<CommandSessionSnapshot> {
    if (unsettled) return { recovery: 'uncertain' };
    return cause instanceof CommandFailure && cause.code === 'EXPIRED'
      ? { recovery: 'historical' }
      : {};
  }
  canLeaveUncertainty(): boolean {
    if (
      !this.state_abyssPrivate.blocked ||
      this.state_abyssPrivate.uncertaintyAcknowledged === true
    )
      return true;
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
    options: {
      acknowledgeUncertainty?: boolean;
      current?: () => boolean;
      voiceMode?: 'continuous';
    } = {},
  ): Promise<boolean> {
    if (!(await this.transitionAllowed_abyssPrivate(signal))) return false;
    if (options.acknowledgeUncertainty !== true && !this.canLeaveUncertainty()) return false;
    if (this.state_abyssPrivate.proposal.changes.length > 0 && disposition === undefined) {
      this.requestTransition_abyssPrivate(
        { kind: 'new-session' },
        commandMessage('Keep this draft in history or discard it before starting a new session?'),
      );
      return false;
    }
    const archived = this.archivedSnapshot_abyssPrivate(
      disposition,
      options.acknowledgeUncertainty,
    );
    const next = this.empty_abyssPrivate(options.voiceMode);
    return this.startSession_abyssPrivate(
      archived,
      disposition === 'discard' && !this.state_abyssPrivate.blocked
        ? {
            ...next,
            status: {
              kind: 'ready',
              message: commandMessage('Draft discarded. Ready to continue.'),
            },
          }
        : next,
      () =>
        this.current_abyssPrivate(archived.id) &&
        signal?.aborted !== true &&
        options.current?.() !== false,
    );
  }
  private async startSession_abyssPrivate(
    archived: CommandSessionSnapshot,
    next: CommandSessionSnapshot,
    current: () => boolean,
  ): Promise<boolean> {
    if (!current()) return false;
    try {
      if (this.options_abyssPrivate.transitions !== undefined)
        await this.options_abyssPrivate.transitions.start(archived, next, current);
      else await this.options_abyssPrivate.journal.save(archived);
      return current() && this.restore(next, false);
    } catch {
      if (current())
        this.status(
          'error',
          commandMessage('Could not retain this session. Keep it open and try again.'),
        );
      return false;
    }
  }
  private archivedStatus_abyssPrivate(): CommandSessionSnapshot['status'] {
    const question = this.previousQuestion_abyssPrivate();
    if (question !== null) return { kind: 'question', message: question };
    if (
      this.state_abyssPrivate.pendingTransition != null ||
      ['thinking', 'searching'].includes(this.state_abyssPrivate.status.kind)
    )
      return { kind: 'ready', message: commandMessage('Ready for review.') };
    return this.state_abyssPrivate.status;
  }
  private archivedSnapshot_abyssPrivate(
    disposition?: 'keep' | 'discard',
    acknowledgeUncertainty = false,
  ): CommandSessionSnapshot {
    const previous = {
      ...this.snapshot(),
      pendingTransition: null,
      activeQuestion: this.previousQuestion_abyssPrivate(),
      input: this.inputDraft_abyssPrivate ? this.state_abyssPrivate.input : '',
      status: this.archivedStatus_abyssPrivate(),
      ...(acknowledgeUncertainty && this.state_abyssPrivate.blocked
        ? { uncertaintyAcknowledged: true }
        : {}),
    };
    return disposition === 'discard' && !previous.blocked
      ? {
          ...previous,
          input: '',
          recovery: 'historical',
          recoveryEvidence:
            previous.recoveryEvidence?.discarded === true
              ? previous.recoveryEvidence
              : discardedCommandEvidence(previous),
          preparations: [],
          proposal: { revision: previous.proposal.revision + 1, operations: 0, changes: [] },
          trees: [],
          activeQuestion: null,
          status: { kind: 'ready', message: commandMessage('Draft discarded.') },
        }
      : previous;
  }
  private releaseDisposed_abyssPrivate(): void {
    if (this.disposed_abyssPrivate) this.options_abyssPrivate.api.dispose();
  }
  dispose(): void {
    if (this.disposed_abyssPrivate) return;
    this.disposed_abyssPrivate = true;
    this.turn_abyssPrivate?.abort();
    this.pendingReveal_abyssPrivate?.settle(false);
    this.writeAdmission_abyssPrivate?.abort();
    this.listeners_abyssPrivate.clear();
    if (!this.writing_abyssPrivate) this.options_abyssPrivate.api.dispose();
    this.options_abyssPrivate.onDispose?.();
  }
}
