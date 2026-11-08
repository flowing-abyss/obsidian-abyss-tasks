import type {
  ApiResultV1,
  ContentPlanV1,
  MutationReceiptV1,
  MutationResultV1,
  NoteMutationResultV1,
  NoteReadPageV1,
  ProjectDtoV1,
  ProjectMutationResultV1,
  TaskContentMutationResultV1,
  TaskContentReceiptV1,
  TaskTreeV1,
  TasksApiV1,
} from '../../api';
import { canonicalCommandPlan, commandRead } from './commandReads';
import { checkedWriteResult, sameReviewedContent } from './commandSchemas';
import {
  CommandFailure,
  required,
  type CommandChange,
  type CommandFocus,
  type CommandFocusContinuations,
  type CommandJournalEntry,
  type CommandProposal,
} from './commandTypes';
type WriteResult =
  MutationResultV1 | NoteMutationResultV1 | ProjectMutationResultV1 | TaskContentMutationResultV1;
interface WriteContext {
  readonly api: TasksApiV1;
  readonly proposal: CommandProposal;
  readonly now: () => number;
  readonly id: () => string;
  readonly cancelled: () => boolean;
  readonly signal: AbortSignal;
  readonly record: (entry: CommandJournalEntry) => Promise<void>;
  readonly actual: (trees: readonly TaskTreeV1[]) => void;
  readonly projects: readonly ProjectDtoV1[];
  readonly focus: () => readonly CommandFocus[];
  readonly focusChanges: (changes: CommandFocusContinuations) => void;
  readonly observeProject: (project: ProjectDtoV1) => void;
  readonly observeNote: (note: NoteReadPageV1) => void;
}
function treeTargets(tree: TaskTreeV1 | null, targets = new Set<string>()): Set<string> {
  if (tree !== null) {
    targets.add(tree.target);
    for (const child of tree.children) treeTargets(child, targets);
  }
  return targets;
}
function planPath(plan: ContentPlanV1): string | undefined {
  return plan.destination?.path ?? plan.before?.source?.path;
}
function receiptMatches(
  entry: CommandJournalEntry,
  receipt: NonNullable<WriteResult['receipt']>,
): boolean {
  if (receipt.requestId !== entry.request.requestId) return false;
  const change = entry.change;
  if (change.kind === 'task' || change.kind === 'cleanup' || change.kind === 'note')
    return (
      'plan' in receipt &&
      receipt.plan === change.plan.target &&
      receipt.planRevision === change.plan.revision &&
      receipt.providerEpoch === change.plan.providerEpoch
    );
  return true;
}
function writeSucceeded(result: WriteResult): boolean {
  return result.ok && result.receipt.effects !== 'partial' && result.receipt.effects !== 'unknown';
}
const order = (change: CommandChange): number =>
  ({ project: 0, note: 1, link: 2, task: 3, status: 4, cleanup: 5 })[change.kind];
/** Application sequencing of guarded public commands. No native writer, rollback, or blind replay. */
export async function executeCommandWrites(ctx: WriteContext): Promise<void> {
  await new CommandWriteRun(ctx).run();
}
class CommandWriteRun {
  private readonly accepted = new Map<string, Map<string, { target: string; revision: string }>>();
  private readonly verified = new Set<string>();
  private readonly notes = new Map<string, { target: string; revision: string }>();
  private readonly materialized = new Map<string, ContentPlanV1>();
  private readonly actual: TaskTreeV1[] = [];
  private readonly changedPaths = new Set<string>();
  private readonly projects = new Map<string, ProjectDtoV1>();
  private readonly signal = new AbortController().signal;
  constructor(private readonly ctx: WriteContext) {
    for (const project of ctx.projects) this.projects.set(project.target, project);
  }
  private read<T>(work: () => Promise<ApiResultV1<T>>): Promise<T> {
    return commandRead(this.ctx.api, work, this.signal, {
      deadline: this.ctx.now() + 5000,
      now: this.ctx.now,
    });
  }
  async run(): Promise<void> {
    for (const change of [...this.ctx.proposal.changes].sort((a, b) => order(a) - order(b))) {
      if (this.ctx.cancelled())
        throw new CommandFailure(
          'CANCELLED',
          'Stopped after the last admitted write. Review the result before continuing.',
        );
      await this.processChange(change);
    }
    await this.refreshSelectedTasks();
    for (const project of this.projects.values()) {
      if (!this.changedPaths.has(project.path)) continue;
      const current = await this.read(() => required(this.ctx.api.projects).get(project.target));
      this.ctx.observeProject(current);
    }
  }
  private async refreshSelectedTasks(): Promise<void> {
    for (const selection of this.ctx.focus()) {
      if (selection.kind !== 'task' || selection.plan !== undefined) continue;
      try {
        const current = await this.read(() => this.ctx.api.tasks.get(selection.target));
        this.ctx.focusChanges(
          new Map([[selection.target, { target: current.target, revision: current.revision }]]),
        );
      } catch {
        // Historical entity evidence remains; an unverified continuation is not current focus.
        this.ctx.focusChanges(new Map([[selection.target, null]]));
      }
    }
  }
  private async processChange(change: CommandChange): Promise<void> {
    if (change.kind === 'link') await this.materializeLink(change);
    else {
      const prepared = await this.refreshAfterKnownWrite(change);
      await this.write(prepared);
      if (prepared.kind === 'project') this.changedPaths.add(prepared.before.path);
      if (prepared.kind === 'task') {
        const path = planPath(prepared.plan);
        if (path !== undefined) this.changedPaths.add(path);
      }
    }
  }
  private async refreshAfterKnownWrite(
    change: Exclude<CommandChange, { kind: 'link' }>,
  ): Promise<Exclude<CommandChange, { kind: 'link' }>> {
    if (change.kind !== 'task' && change.kind !== 'cleanup') return change;
    const plan = this.materialized.get(change.plan.target) ?? change.plan;
    const path = planPath(plan);
    if (path === undefined || !this.changedPaths.has(path)) return { ...change, plan };
    const refreshedPage = await this.read(() =>
      required(this.ctx.api.tasks.prepare)({
        kind: 'refresh',
        plan: plan.target,
        expectedPlanRevision: plan.revision,
      }),
    );
    const refreshed = await canonicalCommandPlan(this.ctx.api, refreshedPage, this.signal, {
      now: this.ctx.now,
      deadline: this.ctx.now() + 5000,
    });
    if (!sameReviewedContent(plan, refreshed))
      throw new CommandFailure(
        'REVIEW_REQUIRED',
        'Related content changed after the earlier write. Review the remaining proposal before saving.',
      );
    if (
      change.kind === 'task' &&
      this.ctx.proposal.changes.some(
        (c) => c.kind === 'cleanup' && c.destinationPlan === plan.target,
      )
    )
      throw new CommandFailure(
        'PRESERVATION_EXPIRED',
        'The earlier write invalidated the merge assessment. The source is retained for a fresh review.',
      );
    return { ...change, plan: refreshed };
  }
  private async materializeLink(change: Extract<CommandChange, { kind: 'link' }>): Promise<void> {
    const note = this.notes.get(change.notePlan);
    const task = this.ctx.proposal.changes.find(
      (c) => c.kind === 'task' && c.plan.target === change.plan.target,
    );
    if (note === undefined || task?.kind !== 'task' || task.plan.revision !== change.plan.revision)
      throw new CommandFailure(
        'LINK_DEPENDENCY',
        'The note was saved, but the reviewed task link no longer matches.',
      );
    const page = await this.read(() =>
      required(this.ctx.api.notes).read({
        selector: { target: note.target, expectedRevision: note.revision },
        linkFor: { fromPath: change.sourcePath, alias: change.alias },
      }),
    );
    if (page.markdownLink === undefined)
      throw new CommandFailure(
        'LINK_READBACK',
        'The note was saved, but its link could not be verified.',
      );
    const text = change.template.replace('{{link}}', page.markdownLink);
    const plan = await this.read(() =>
      required(this.ctx.api.tasks.prepare)({
        kind: 'append',
        plan: change.plan.target,
        expectedPlanRevision: change.plan.revision,
        operation:
          change.field === 'description'
            ? { type: 'description', target: change.target, text }
            : {
                type: 'patch',
                target: change.target,
                patch: { markdownTitle: { type: 'set', value: text } },
              },
      }),
    );
    const canonical = await canonicalCommandPlan(this.ctx.api, plan, this.signal, {
      now: this.ctx.now,
      deadline: this.ctx.now() + 5000,
    });
    this.materialized.set(plan.target, canonical);
  }
  private checkCleanup(change: Extract<CommandChange, { kind: 'cleanup' }>): void {
    if (
      !this.verified.has(change.destinationPlan) ||
      this.ctx.proposal.changes.some(
        (c) => c.kind === 'status' && c.plan === change.destinationPlan,
      )
    )
      throw new CommandFailure(
        'CLEANUP_HELD',
        'The copied content needs review before removing its source.',
      );
    const destination = this.ctx.proposal.changes.find(
      (c) => c.kind === 'task' && c.plan.target === change.destinationPlan,
    );
    if (destination?.kind !== 'task')
      throw new CommandFailure('CLEANUP_HELD', 'The reviewed destination is unavailable.');
    this.checkAssessment(destination.plan, change);
  }
  private checkAssessment(
    destination: ContentPlanV1,
    change: Extract<CommandChange, { kind: 'cleanup' }>,
  ): void {
    const assessment = destination.mergePreservation,
      source = change.plan.before;
    if (
      destination.revision !== change.destinationRevision ||
      assessment?.state !== 'covered' ||
      assessment.planRevision !== change.destinationRevision ||
      assessment.sourceRoot.target !== source?.target ||
      assessment.sourceRoot.revision !== source.revision
    )
      throw new CommandFailure(
        'CLEANUP_HELD',
        'The source preservation check no longer matches this proposal.',
      );
  }
  private async write(change: Exclude<CommandChange, { kind: 'link' }>): Promise<void> {
    if (change.kind === 'cleanup') this.checkCleanup(change);
    const entry: CommandJournalEntry = {
      id: this.ctx.id(),
      proposalRevision: this.ctx.proposal.revision,
      change,
      request: { requestId: this.ctx.id(), expiresAt: this.ctx.now() + 60000 },
      state: 'admitted',
    };
    const execute = this.operation(change, entry.request);
    await this.ctx.record(entry);
    if (this.ctx.cancelled()) {
      await this.ctx.record({
        ...entry,
        state: 'settled',
        effects: 'unchanged',
        error: 'CANCELLED_BEFORE_ADMISSION',
      });
      throw new CommandFailure(
        'CANCELLED',
        'Stopped before the write was admitted. Your draft is retained.',
      );
    }
    let result: WriteResult;
    try {
      result = checkedWriteResult(await execute());
    } catch {
      this.clearAffectedFocus(entry.change);
      await this.ctx.record({
        ...entry,
        state: 'settled',
        effects: 'unknown',
        error: 'WRITE_RESULT_UNAVAILABLE',
      });
      throw new CommandFailure(
        'UNKNOWN_WRITE',
        'The write result is unknown. Check the actual note before retrying.',
      );
    }
    await this.settle(entry, result);
  }
  private async settle(entry: CommandJournalEntry, result: WriteResult): Promise<void> {
    const receipt = result.receipt,
      effects = result.ok ? result.receipt.effects : result.effects;
    if (receipt !== undefined && !receiptMatches(entry, receipt)) {
      this.clearAffectedFocus(entry.change);
      await this.ctx.record({
        ...entry,
        state: 'settled',
        effects: 'unknown',
        error: 'INVALID_RECEIPT',
      });
      throw new CommandFailure(
        'INVALID_RECEIPT',
        'The write receipt could not be verified. Do not repeat the write.',
      );
    }
    await this.ctx.record({
      ...entry,
      state: 'settled',
      effects,
      ...(receipt === undefined ? {} : { receipt }),
      ...(!result.ok ? { error: result.error.code } : {}),
    });
    try {
      await this.readResult(entry, result);
    } catch (cause) {
      this.clearAffectedFocus(entry.change);
      throw cause;
    }
    if (!writeSucceeded(result))
      throw new CommandFailure(
        'WRITE_STOPPED',
        'The request may be partly saved. Review the actual result before continuing.',
      );
  }
  private async readResult(entry: CommandJournalEntry, result: WriteResult): Promise<void> {
    const receipt = result.receipt,
      effects = result.ok ? result.receipt.effects : result.effects;
    if (receipt === undefined && effects !== 'unchanged') {
      this.clearAffectedFocus(entry.change);
      await this.observeUncertain(entry.change);
    }
    if (receipt !== undefined && (result.ok || effects !== 'unchanged'))
      await this.readback(receipt, entry.change);
  }
  private async observeUncertain(change: CommandChange): Promise<void> {
    if (change.kind !== 'task' && change.kind !== 'cleanup') return;
    const path = planPath(change.plan);
    if (path === undefined) return;
    try {
      const page = await this.read(() => this.ctx.api.tasks.list({ path, limit: 50 }));
      for (const node of page.items.filter((t) => t.parentTarget === undefined).slice(0, 5))
        await this.readTree(node.target, node.revision);
    } catch {
      // The durable unknown receipt remains authoritative; read failure never permits replay.
      this.ctx.actual(this.actual);
    }
  }
  private async readback(
    receipt: NonNullable<WriteResult['receipt']>,
    change: CommandChange,
  ): Promise<void> {
    if ('contentContinuity' in receipt) {
      await this.readContent(receipt, change);
      return;
    }
    if ('original' in receipt) {
      await this.readStatus(receipt);
      return;
    }
    if ('noteEffects' in receipt) {
      const note = receipt.note;
      if (note === undefined)
        throw new CommandFailure('READBACK', 'The note write finished without a verified result.');
      this.notes.set(receipt.plan, note);
      const current = await this.read(() =>
        required(this.ctx.api.notes).read({
          selector: { target: note.target, expectedRevision: note.revision },
        }),
      );
      this.ctx.observeNote(current);
      return;
    }
    const project = receipt.project;
    if (project === undefined)
      throw new CommandFailure('READBACK', 'The project write finished without a verified result.');
    const current = await this.read(() => required(this.ctx.api.projects).get(project.target));
    if (current.revision !== project.revision)
      throw new CommandFailure(
        'READBACK',
        'The project changed again before it could be verified.',
      );
    this.projects.set(current.target, current);
    this.ctx.observeProject(current);
  }
  private async readContent(receipt: TaskContentReceiptV1, change: CommandChange): Promise<void> {
    const correspondence = receipt.contentContinuity.correspondence;
    if (correspondence.state !== 'complete')
      throw new CommandFailure(
        'READBACK',
        'The write finished, but its resulting tasks could not be identified. Review the note.',
      );
    this.accepted.set(
      receipt.plan,
      new Map(
        correspondence.tasks.map((t) => [
          t.preparedTarget,
          { target: t.committedTarget, revision: t.committedRevision },
        ]),
      ),
    );
    const root = correspondence.root;
    if (root !== null) await this.readTree(root.target, root.revision);
    else this.ctx.actual(this.actual);
    const affected = this.affectedFocus(change);
    const continuations = new Map<string, { target: string; revision: string } | null>();
    for (const selected of affected) {
      const next = this.accepted.get(receipt.plan)?.get(selected.target);
      if (next === undefined) continuations.set(selected.target, null);
      else {
        const current = await this.read(() => this.ctx.api.tasks.get(next.target));
        if (current.revision !== next.revision)
          throw new CommandFailure(
            'READBACK',
            'The selected task changed before it could be verified.',
          );
        continuations.set(selected.target, next);
      }
    }
    this.ctx.focusChanges(continuations);
    this.verified.add(receipt.plan);
  }
  private affectedFocus(change: CommandChange): readonly CommandFocus[] {
    const targets = new Set(change.kind === 'status' ? [change.target] : []);
    if (change.kind === 'task' || change.kind === 'cleanup') {
      treeTargets(change.plan.before, targets);
      treeTargets(change.plan.after, targets);
    }
    return this.ctx
      .focus()
      .filter(
        (entry) =>
          entry.kind === 'task' &&
          (targets.has(entry.target) ||
            ((change.kind === 'task' || change.kind === 'cleanup') &&
              entry.plan === change.plan.target)),
      );
  }
  private clearAffectedFocus(change: CommandChange): void {
    this.ctx.focusChanges(new Map(this.affectedFocus(change).map((entry) => [entry.target, null])));
  }
  private async readStatus(receipt: MutationReceiptV1): Promise<void> {
    if (receipt.original.state === 'unproven')
      throw new CommandFailure(
        'READBACK',
        'The task changed, but its final state could not be verified.',
      );
    if (receipt.original.state === 'retained') {
      await this.readTree(receipt.original.target);
      const current = await this.read(() => this.ctx.api.tasks.get(receipt.original.target));
      this.ctx.focusChanges(
        new Map([
          [receipt.original.target, { target: current.target, revision: current.revision }],
        ]),
      );
    } else this.ctx.focusChanges(new Map([[receipt.original.target, null]]));
    if (receipt.next !== undefined) await this.readTree(receipt.next.target);
    this.ctx.actual(this.actual);
  }
  private async readTree(target: string, expectedRevision?: string): Promise<void> {
    const page = await this.read(() =>
      required(this.ctx.api.tasks.tree)({
        target,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        limit: 500,
      }),
    );
    if (page.tree.source !== undefined) this.changedPaths.add(page.tree.source.path);
    this.actual.push(page.tree);
    this.ctx.actual(this.actual);
  }
  private operation(
    change: Exclude<CommandChange, { kind: 'link' }>,
    request: { requestId: string; expiresAt: number },
  ): () => Promise<WriteResult> {
    if (change.kind === 'task' || change.kind === 'cleanup' || change.kind === 'note')
      return this.contentOperation(change, request);
    if (change.kind === 'project')
      return () =>
        required(this.ctx.api.projects).update(
          {
            target: change.before.target,
            expectedRevision: change.before.revision,
            ...(change.fields === undefined ? {} : { fields: change.fields }),
            ...(change.statusId === undefined ? {} : { statusId: change.statusId }),
            ...request,
          },
          { signal: this.ctx.signal },
        );
    const target =
      change.plan === undefined
        ? { target: change.target, revision: change.revision }
        : this.accepted.get(change.plan)?.get(change.target);
    if (target === undefined)
      throw new CommandFailure(
        'CORRESPONDENCE',
        'The saved task has no exact correspondence. Review its status separately.',
      );
    return () =>
      this.ctx.api.tasks.setStatus(
        {
          target: target.target,
          expectedRevision: target.revision,
          symbol: change.symbol,
          ...request,
        },
        { signal: this.ctx.signal },
      );
  }
  private contentOperation(
    change: Extract<CommandChange, { kind: 'task' | 'cleanup' | 'note' }>,
    request: { requestId: string; expiresAt: number },
  ): () => Promise<WriteResult> {
    const plan = change.plan;
    if (plan.expiresAt <= this.ctx.now())
      throw new CommandFailure(
        'EXPIRED',
        'This preview expired. Review a refreshed proposal before saving.',
      );
    const input = { plan: plan.target, expectedPlanRevision: plan.revision, ...request };
    if (change.kind === 'note')
      return () =>
        required(this.ctx.api.notes)[plan.kind === 'create' ? 'create' : 'apply'](input, {
          signal: this.ctx.signal,
        });
    return () =>
      required(plan.kind === 'create' ? this.ctx.api.tasks.create : this.ctx.api.tasks.apply)(
        input,
        { signal: this.ctx.signal },
      );
  }
}
