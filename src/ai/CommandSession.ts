import type {
  ApiResultV1,
  NoteReadPageV1,
  ProjectDtoV1,
  ReadTaskTreeV1,
  TaskTreePageV1,
  TaskTreeV1,
} from '../../api';
import { commandRead } from './commandReads';
import { reconcileCommandLink, validatePlanOutput } from './commandSchemas';
import {
  CommandFailure,
  required,
  type CommandChange,
  type CommandFocus,
  type CommandFocusContinuations,
  type CommandJournalEntry,
  type CommandSessionOptions,
  type CommandSessionSnapshot,
  type CommandStatusKind,
  type CommandSubmissionBasis,
} from './commandTypes';
import { executeCommandWrites } from './commandWrites';
import { providerFailure } from './providers/providerFailure';

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
  if (c.kind === 'status') return `status:${c.target}`;
  if (c.kind === 'task' && c.plan.before !== null) return `task:${c.plan.before.target}`;
  return `${c.kind}:${c.plan.target}`;
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
export class CommandSession {
  private state: CommandSessionSnapshot;
  private readonly listeners = new Set<(state: CommandSessionSnapshot) => void>();
  private turn: AbortController | undefined;
  private running: Promise<void> | undefined;
  private writing = false;
  private writeAdmission: AbortController | undefined;
  private disposed = false;
  private focusRun = 0;
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
  snapshot(): CommandSessionSnapshot {
    const copy = detached(this.state);
    freeze(copy);
    return copy;
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
      for (const entry of verified) this.observeFocus(entry);
      this.publish({ focus: verified.map((entry) => entry.focus) });
      return true;
    } catch (cause) {
      if (current()) this.status('error', focusError(cause));
      return false;
    }
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
      note,
      focus: { kind: 'note', target: note.note.target, revision: note.note.revision },
    };
  }
  private taskFocusBasis(
    target: Extract<CommandFocus, { kind: 'task' }>,
  ): Extract<CommandFocus, { kind: 'task' }> {
    const matches = this.state.proposal.changes.flatMap((change) => {
      if (change.kind !== 'task') return [];
      const node = focusNode(change.plan.after, target.target);
      return node === undefined ? [] : [{ plan: change.plan, node }];
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
      return target;
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
      kind: 'task',
      target: target.target,
      plan: match.plan.target,
      expectedPlanRevision: match.plan.revision,
    };
  }
  private async verifyTaskFocus(
    requested: Extract<CommandFocus, { kind: 'task' }>,
    read: <T>(work: () => Promise<ApiResultV1<T>>) => Promise<T>,
  ): Promise<VerifiedFocus> {
    const target = this.taskFocusBasis(requested);
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
              side: 'after' as const,
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
  observeNote(note: NoteReadPageV1): void {
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
  setInput(text: string): void {
    this.publish({ input: text });
  }
  exchange(role: 'user' | 'agent', text: string): void {
    this.publish({
      exchanges: [...this.state.exchanges, { role, text }],
    });
  }
  stage(change: CommandChange, operations = 1): void {
    if (this.disposed || this.writing || this.state.blocked)
      throw new CommandFailure('BUSY', 'Resolve the previous write before changing this proposal.');
    validateChange(change);
    const changes = [...this.state.proposal.changes];
    const index = changes.findIndex((c) => changeKey(c) === changeKey(change));
    if (index < 0) changes.push(change);
    else changes[index] = composeProjectChange(required(changes[index]), change);
    const retained = changes
      .filter((c) => !(c.kind === 'task' && c.plan.before === null && c.plan.after === null))
      .map((entry) =>
        entry.kind === 'link' && change.kind === 'task' && entry.plan.target === change.plan.target
          ? reconcileCommandLink(entry, change.plan)
          : entry,
      );
    const count = affectedNodes(retained);
    if (count > 50 || !validOperationBudget(this.state.proposal.operations, operations))
      throw new CommandFailure('BUDGET', 'This proposal is too large. Save or split it first.');
    this.publish({
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
  async submit(text: string, submittedAgainst?: CommandSubmissionBasis): Promise<void> {
    if (this.disposed) return;
    if (text.length <= 16000 && text.trim() === '') {
      await this.confirm();
      return;
    }
    if (this.running !== undefined) {
      this.cancelTurn();
      await this.running;
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
    return this.disposed || this.writing || this.turn !== undefined || this.state.blocked;
  }
  private async runTurn(text: string, submittedAgainst?: CommandSubmissionBasis): Promise<void> {
    if (this.unavailable()) {
      this.status('error', 'Finish or reconcile the previous operation first.');
      return;
    }
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
      if (!controller.signal.aborted && this.state.status.kind === 'thinking')
        this.status('ready', 'Ready.');
    } catch (cause) {
      if (!controller.signal.aborted)
        this.status(
          'error',
          cause instanceof CommandFailure ? cause.message : providerFailure(cause).message,
        );
    } finally {
      if (this.turn === controller) this.turn = undefined;
    }
  }
  cancelTurn(): void {
    this.turn?.abort();
    this.writeAdmission?.abort();
    if (!this.writing) this.status('ready', 'Stopped. Your draft is retained.');
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
    if (this.writing || this.state.blocked || this.disposed) return false;
    this.cancelTurn();
    if (this.running !== undefined) await this.running;
    return this.writeProposal(
      {
        revision: this.state.proposal.revision,
        operations: 1,
        changes: [{ kind: 'status', ...input, nuance: 'Ordinary status lifecycle.' }],
      },
      false,
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
    await this.options.journal.save(this.snapshot());
  }
  private async completeWrite(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
  ): Promise<void> {
    const completed: CommandSessionSnapshot = {
      ...this.snapshot(),
      ...(clear
        ? {
            proposal: { revision: proposal.revision + 1, operations: 0, changes: [] },
            trees: [],
            input: '',
          }
        : {}),
      status: {
        kind: clear ? 'saved' : 'ready',
        message: clear ? 'Saved.' : 'Status saved. Pending content is retained for review.',
      },
    };
    await this.options.journal.save(completed);
    this.publish(completed);
  }
  private async writeProposal(
    proposal: CommandSessionSnapshot['proposal'],
    clear: boolean,
  ): Promise<boolean> {
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
        record: (entry) => this.recordWrite(entry),
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
      await this.completeWrite(proposal, clear);
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
  async newSession(disposition?: 'keep' | 'discard'): Promise<boolean> {
    if (this.disposed || this.writing || this.state.blocked) {
      this.question('Finish the current operation before starting another session.');
      return false;
    }
    if (this.state.proposal.changes.length > 0 && disposition === undefined) {
      this.question('Keep this draft in history or discard it before starting a new session?');
      return false;
    }
    this.cancelTurn();
    if (disposition !== 'discard') await this.options.journal.save(this.snapshot());
    this.publish(this.empty());
    return true;
  }
  private releaseDisposed(): void {
    if (this.disposed) this.options.api.dispose();
  }
  dispose(): void {
    this.disposed = true;
    this.turn?.abort();
    this.writeAdmission?.abort();
    this.listeners.clear();
    if (!this.writing) this.options.api.dispose();
  }
}
