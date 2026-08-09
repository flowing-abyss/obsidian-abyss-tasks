import { TFile, type App } from 'obsidian';
import { parseLinks } from '../../../parser/links';
import type {
  RecurrenceCompletionRequest,
  TaskDraft,
  TaskEditCommand,
  TaskRepository,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import type {
  MoveRecovery,
  PlanningTarget,
  TaskOccurrenceResult,
  TaskResolutionCandidate,
} from '../../domain/commands';
import { nextOccurrencePlanning, type RecurrenceIssueCode } from '../../domain/recurrence';
import { prepareRecurrenceIteration } from '../../domain/recurrenceIteration';
import type {
  CommentRef,
  LocalDate,
  SubtaskRef,
  SubtaskSnapshot,
  TaskDestination,
  TaskMutationTarget,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from '../../domain/types';
import { sameTaskNodeRef } from '../../domain/types';
import { localDate } from '../../domain/validation';
import { applyTaskCommand } from '../markdown/applyTaskCommand';
import { createTaskBlock } from '../markdown/createTaskBlock';
import type { TaskBlockEdit, TaskRootBlock } from '../markdown/TaskBlockEditor';
import { TaskBlockEditor } from '../markdown/TaskBlockEditor';
import { TaskLocator } from '../markdown/TaskLocator';
import { TaskMarkdownCodec } from '../markdown/TaskMarkdownCodec';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
  type RootRevisionOverride,
  type TaskRefStageResult,
  type TaskSnapshotState,
} from '../TaskRefAuthority';

interface RepositoryOptions {
  readonly codec: TaskMarkdownCodec;
  readonly editor: TaskBlockEditor;
  readonly locator: TaskLocator;
  readonly snapshotsFromContent: (filePath: string, content: string) => readonly TaskSnapshot[];
  readonly refAuthority?: TaskRefAuthority;
  readonly snapshotState?: TaskSnapshotState;
}

type StructuralTaskEditCommand = Extract<
  TaskEditCommand,
  {
    readonly type:
      | 'set-description'
      | 'add-subtask'
      | 'delete-subtask'
      | 'reorder-subtask'
      | 'add-comment'
      | 'update-comment'
      | 'delete-comment';
  }
>;

function rootRefOf(target: PlanningTarget): TaskRef {
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') node = node.ref.parent;
  return node.ref;
}

function nodeTargetOf(command: TaskEditCommand): PlanningTarget | undefined {
  if (
    command.type === 'patch' ||
    command.type === 'set-status' ||
    command.type === 'append-title'
  ) {
    return command.target;
  }
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target.ref.parent : command.target.target;
  }
  if (command.type === 'set-description') return command.target;
  if (command.type === 'add-subtask') return command.parent;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return command.subtask.parent;
  }
  if (command.type === 'add-comment') return command.parent;
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return command.comment.parent;
  }
  return undefined;
}

function rootRefForCommand(command: TaskEditCommand): TaskRef {
  const target = nodeTargetOf(command);
  if (target) return rootRefOf(target);
  if ('ref' in command) return command.ref;
  throw new Error('Task edit command has no root reference');
}

function childChain(target: PlanningTarget): readonly SubtaskRef[] {
  const chain: SubtaskRef[] = [];
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') {
    chain.unshift(node.ref);
    node = node.ref.parent;
  }
  return chain;
}

function legacyLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function confirmedTargetRelativeLine(
  target: PlanningTarget,
  rootBlock: TaskRootBlock,
): number | undefined {
  if (target.type === 'task') return 0;
  const rootLines = rootBlock.source.split(/\r?\n/u);
  let line = 0;
  for (const child of childChain(target)) {
    line += child.relativeLine;
    const expected = child.originalBlock.split(/\r?\n/u).map(legacyLine);
    const current = rootLines.slice(line, line + expected.length);
    if (
      current.length !== expected.length ||
      current.some((value, index) => value !== expected[index])
    ) {
      return undefined;
    }
  }
  return line;
}

function rebaseNode(node: TaskNodeRef, root: TaskRef): TaskNodeRef {
  if (node.type === 'task') return { type: 'task', ref: root };
  return {
    type: 'subtask',
    ref: { ...node.ref, parent: rebaseNode(node.ref.parent, root) },
  };
}

function rebaseSubtaskWithParent(
  task: SubtaskSnapshot,
  parent: TaskNodeRef,
  root: TaskRef,
): SubtaskSnapshot {
  const node: TaskNodeRef = { type: 'subtask', ref: { ...task.ref, parent } };
  return {
    ...task,
    ref: node.ref,
    planning: { ...task.planning },
    tags: [...task.tags],
    subtasks: task.subtasks.map((child) => rebaseSubtaskWithParent(child, node, root)),
    comments: task.comments.map((comment) => ({
      ...comment,
      ref: { ...comment.ref, parent: node },
    })),
  };
}

function rebaseSnapshot(task: TaskSnapshot, root: TaskRef): TaskSnapshot {
  const node: TaskNodeRef = { type: 'task', ref: root };
  return {
    ...task,
    ref: root,
    planning: { ...task.planning },
    tags: [...task.tags],
    subtasks: task.subtasks.map((child) => rebaseSubtaskWithParent(child, node, root)),
    comments: task.comments.map((comment) => ({
      ...comment,
      ref: { ...comment.ref, parent: node },
    })),
    source: { ...task.source, filePath: root.filePath, line: root.line },
    presentation: { ...task.presentation },
  };
}

function mutationTarget(command: TaskEditCommand): TaskMutationTarget {
  if (
    command.type === 'patch' ||
    command.type === 'set-status' ||
    command.type === 'append-title'
  ) {
    return command.target;
  }
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target : command.target.target;
  }
  if (command.type === 'set-description') return command.target;
  if (command.type === 'add-subtask') return command.parent;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return { type: 'subtask', ref: command.subtask };
  }
  if (command.type === 'add-comment') return command.parent;
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return { type: 'comment', ref: command.comment };
  }
  return { type: 'task', ref: command.ref };
}

function nodeSnapshot(
  root: TaskSnapshot,
  target: PlanningTarget,
): TaskSnapshot | SubtaskSnapshot | undefined {
  if (target.type === 'task') return root;
  let current: TaskSnapshot | SubtaskSnapshot = root;
  for (const child of childChain(target)) {
    const next: SubtaskSnapshot | undefined = current.subtasks.find(
      (candidate) =>
        candidate.ref.relativeLine === child.relativeLine &&
        candidate.ref.originalBlock === child.originalBlock,
    );
    if (!next) return undefined;
    current = next;
  }
  return current;
}

function accumulatedSubtaskAt(
  root: TaskSnapshot,
  targetRelativeLine: number,
): TaskNodeRef | undefined {
  const matches: TaskNodeRef[] = [];
  const visit = (parent: TaskSnapshot | SubtaskSnapshot, parentRelativeLine: number): void => {
    for (const child of parent.subtasks) {
      const relativeLine = parentRelativeLine + child.ref.relativeLine;
      if (relativeLine === targetRelativeLine) {
        matches.push({ type: 'subtask', ref: child.ref });
      }
      visit(child, relativeLine);
    }
  };
  visit(root, 0);
  return matches.length === 1 ? matches[0] : undefined;
}

function occurrenceAt(
  snapshots: readonly TaskSnapshot[],
  rootLine: number,
  targetRelativeLine: number,
): TaskOccurrenceResult | undefined {
  const roots = snapshots.filter((candidate) => candidate.source.line === rootLine);
  if (roots.length !== 1) return undefined;
  const root = roots[0]!;
  if (targetRelativeLine === 0) {
    return { root, target: { type: 'task', ref: root.ref } };
  }
  const target = accumulatedSubtaskAt(root, targetRelativeLine);
  return target ? { root, target } : undefined;
}

function lineCount(source: string): number {
  return source.split(/\r?\n/u).length;
}

function stageRootTransition(
  authority: TaskRefAuthority,
  editor: TaskBlockEditor,
  filePath: string,
  candidate: string,
  expectedRevision: string,
  currentRevision: string,
  rootLines: readonly number[],
): TaskRefStageResult | { readonly type: 'invalid' } {
  const finalBlocks = new Map(
    editor.rootBlocks(candidate).map((block) => [block.line, block] as const),
  );
  const roots: RootRevisionOverride[] = [];
  for (const line of new Set(rootLines)) {
    const block = finalBlocks.get(line);
    const revision = block && authority.successor(expectedRevision, block.source);
    if (!block || !revision) return { type: 'invalid' };
    roots.push({ line, source: block.source, revision });
  }
  return authority.stage(
    {
      filePath,
      candidateFingerprint: taskRefContentFingerprint(candidate),
      candidateLength: candidate.length,
      expectedRevision,
      roots,
    },
    currentRevision,
  );
}

function occurrenceCoordinates(
  blockLine: number,
  ownerRelativeLine: number,
  offset: number,
  nestedOwner: boolean,
): { readonly rootLine: number; readonly targetRelativeLine: number } {
  return nestedOwner
    ? { rootLine: blockLine, targetRelativeLine: ownerRelativeLine + offset }
    : { rootLine: blockLine + offset, targetRelativeLine: 0 };
}

function invalidRecurrence(
  code: RecurrenceIssueCode | 'invalid-task-syntax',
): TaskRepositoryResult {
  return { type: 'invalid', issues: [{ code, field: 'recurrence' }] };
}

type PreparedRecurrenceCandidate =
  | { readonly type: 'invalid'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'prepared';
      readonly candidate: string;
      readonly deletesCompleted: boolean;
      readonly cleanOffset: number;
      readonly completedOffset: number;
    };

function prepareRecurrenceCandidate(
  editor: TaskBlockEditor,
  content: string,
  block: TaskRootBlock,
  owner: TaskSnapshot | SubtaskSnapshot,
  relativeLine: number,
  request: RecurrenceCompletionRequest,
): PreparedRecurrenceCandidate {
  if (owner.recurrence === undefined) {
    return { type: 'invalid', result: invalidRecurrence('unparseable-rule') };
  }
  const next = nextOccurrencePlanning({
    rule: owner.recurrence,
    planning: owner.planning,
    completedOn: request.today,
    policy: request.policy,
  });
  if (next.type === 'invalid') {
    return { type: 'invalid', result: invalidRecurrence(next.code) };
  }
  const prepared = prepareRecurrenceIteration({
    rootBlock: block.source,
    ownerRelativeLine: relativeLine,
    nextPlanning: next.planning,
    dayDelta: next.dayDelta,
    doneSymbol: request.doneSymbol,
    todoSymbol: request.todoSymbol,
    today: request.today,
    addCreatedDate: request.addCreatedDate,
    addCompletionDate: request.addCompletionDate,
  });
  if (prepared.type === 'invalid') {
    return { type: 'invalid', result: invalidRecurrence(prepared.code) };
  }
  const deletesCompleted = owner.onCompletion === 'delete';
  const cleanFirst = deletesCompleted || request.placement === 'before';
  let replacements: readonly string[];
  if (deletesCompleted) replacements = [prepared.cleanSubtree];
  else if (cleanFirst) replacements = [prepared.cleanSubtree, prepared.completedSubtree];
  else replacements = [prepared.completedSubtree, prepared.cleanSubtree];
  const candidate = editor.replaceOwnedTaskSubtree(content, block, relativeLine, replacements);
  if (candidate === undefined) {
    return { type: 'invalid', result: invalidRecurrence('invalid-task-syntax') };
  }
  return {
    type: 'prepared',
    candidate,
    deletesCompleted,
    cleanOffset: cleanFirst ? 0 : lineCount(prepared.completedSubtree),
    completedOffset: cleanFirst ? lineCount(prepared.cleanSubtree) : 0,
  };
}

function hasAuthoredRecurrence(
  parsed: NonNullable<ReturnType<TaskMarkdownCodec['parseLine']>>,
): boolean {
  return parsed.spans.some(
    (span) =>
      span.kind === 'recurrence' ||
      (span.kind === 'malformed-known' && span.malformedKind === 'recurrence'),
  );
}

function blockTarget(
  node: TaskSnapshot | SubtaskSnapshot,
  rootBlock: TaskRootBlock,
  relativeLine: number,
) {
  const lineCount =
    'source' in node
      ? rootBlock.toLine - rootBlock.line + 1
      : node.ref.originalBlock.split(/\r?\n/u).length;
  return {
    relativeLine,
    lineCount,
    childRanges: node.subtasks.map((child) => ({
      from: child.ref.relativeLine,
      to: child.ref.relativeLine + child.ref.originalBlock.split(/\r?\n/u).length - 1,
    })),
    ...(node.description !== undefined && { description: node.description }),
  };
}

function isStructuralCommand(command: TaskEditCommand): command is StructuralTaskEditCommand {
  return (
    command.type === 'set-description' ||
    command.type === 'add-subtask' ||
    command.type === 'delete-subtask' ||
    command.type === 'reorder-subtask' ||
    command.type === 'add-comment' ||
    command.type === 'update-comment' ||
    command.type === 'delete-comment'
  );
}

function ownsComment(node: TaskSnapshot | SubtaskSnapshot, comment: CommentRef): boolean {
  return node.comments.some(
    (candidate) =>
      candidate.ref.relativeLine === comment.relativeLine &&
      legacyLine(candidate.ref.originalMarkdown) === legacyLine(comment.originalMarkdown),
  );
}

function ownsSubtask(node: TaskSnapshot | SubtaskSnapshot, subtask: SubtaskRef): boolean {
  return node.subtasks.some(
    (candidate) =>
      candidate.ref.relativeLine === subtask.relativeLine &&
      candidate.ref.originalBlock === subtask.originalBlock,
  );
}

function structuralEdit(command: StructuralTaskEditCommand): TaskBlockEdit {
  switch (command.type) {
    case 'set-description':
      return { type: command.type, text: command.text };
    case 'add-subtask':
      return { type: command.type, text: command.text };
    case 'delete-subtask':
      return {
        type: command.type,
        relativeLine: command.subtask.relativeLine,
        originalBlock: command.subtask.originalBlock,
      };
    case 'reorder-subtask':
      return {
        type: command.type,
        source: {
          relativeLine: command.subtask.relativeLine,
          originalBlock: command.subtask.originalBlock,
        },
        target: {
          relativeLine: command.target.relativeLine,
          originalBlock: command.target.originalBlock,
        },
        placement: command.placement,
      };
    case 'add-comment':
      return { type: command.type, text: command.text, stamp: command.stamp };
    case 'update-comment':
      return {
        type: command.type,
        relativeLine: command.comment.relativeLine,
        originalMarkdown: command.comment.originalMarkdown,
        text: command.text,
      };
    case 'delete-comment':
      return {
        type: command.type,
        relativeLine: command.comment.relativeLine,
        originalMarkdown: command.comment.originalMarkdown,
      };
  }
}

function commentRelativeLine(
  parentRelativeLine: number,
  comment: CommentRef,
  lines: readonly string[],
  rootLine: number,
): number | undefined {
  const relativeLine = parentRelativeLine + comment.relativeLine;
  return lines[rootLine + relativeLine] === legacyLine(comment.originalMarkdown)
    ? relativeLine
    : undefined;
}

export class ObsidianTaskRepository implements TaskRepository {
  constructor(
    private readonly app: App,
    private readonly options: RepositoryOptions,
  ) {}

  async create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult> {
    const file = this.app.vault.getAbstractFileByPath(destination.filePath);
    if (!(file instanceof TFile)) {
      return {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      };
    }
    const block = createTaskBlock(this.options.codec, {
      ...draft,
      today: draft.today ?? localDate('1970-01-01'),
      addCreatedDate: draft.addCreatedDate ?? false,
    });
    if (block.type === 'invalid') return block;
    let result: TaskRepositoryResult | undefined;
    let createdContent: string | undefined;
    try {
      await this.processFile(file, (content) => {
        const inserted = this.options.editor.insertRootBlock(
          content,
          block.content,
          destination.insertion,
        );
        if (!inserted) {
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        const task = this.snapshotFor(destination.filePath, inserted.content, inserted.block);
        if (!task) {
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        result = { type: 'committed', outcome: { type: 'task', task }, changed: true };
        createdContent = inserted.content;
        return inserted.content;
      });
    } catch {
      if (createdContent !== undefined && this.options.snapshotState) {
        try {
          const authoritative = await this.app.vault.read(file);
          this.options.snapshotState.installCommittedContent(destination.filePath, authoritative);
        } catch {
          // The I/O result below already records that final content state is unknown.
        }
      }
      return {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      };
    }
    if (createdContent && result?.type === 'committed' && result.outcome.type === 'task') {
      const installed = this.options.snapshotState?.installCommittedContent(
        destination.filePath,
        createdContent,
      );
      const outcome = result.outcome;
      const rebased = installed?.find(
        (candidate) => candidate.source.line === outcome.task.source.line,
      );
      if (rebased) result = { ...result, outcome: { type: 'task', task: rebased } };
    }
    return (
      result ?? {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      }
    );
  }

  async move(ref: TaskRef, destination: TaskDestination): Promise<TaskRepositoryResult> {
    const sourceFile = this.app.vault.getAbstractFileByPath(ref.filePath);
    if (!(sourceFile instanceof TFile)) {
      return { type: 'not-found', target: { type: 'task', ref } };
    }

    let sourceContent: string;
    try {
      sourceContent = await this.app.vault.read(sourceFile);
    } catch {
      return {
        type: 'io-error',
        cause: 'read-error',
        path: ref.filePath,
        contentState: 'unchanged',
      };
    }
    const evidence = this.options.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence && this.options.snapshotState?.currentRoot(ref.filePath, ref.line, evidence.source);
    const sourceLocated = this.options.locator.locate(
      this.options.editor.rootBlocks(sourceContent),
      ref,
    );
    if (
      this.options.refAuthority &&
      this.options.snapshotState &&
      (!indexedRef || indexedRef.revision !== ref.revision) &&
      sourceLocated.type === 'exact'
    ) {
      const current = this.snapshotFor(ref.filePath, sourceContent, sourceLocated.block);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: { type: 'task', ref } };
    }
    if (sourceLocated.type !== 'exact') {
      return this.resolutionResultForRef(sourceLocated, ref, sourceContent);
    }
    const sourceTask = this.snapshotFor(ref.filePath, sourceContent, sourceLocated.block);
    if (!sourceTask) return { type: 'not-found', target: { type: 'task', ref } };
    if (ref.filePath === destination.filePath) {
      return {
        type: 'committed',
        outcome: { type: 'task', task: sourceTask },
        changed: false,
      };
    }

    const targetFile = this.app.vault.getAbstractFileByPath(destination.filePath);
    if (!(targetFile instanceof TFile)) {
      return {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      };
    }

    const targetResult = await this.copyMoveTarget(
      sourceTask,
      sourceLocated.block,
      destination,
      targetFile,
      indexedRef?.revision ?? '',
    );
    if (targetResult.type !== 'committed' || targetResult.outcome.type !== 'task') {
      return targetResult;
    }

    const copiedTask = targetResult.outcome.task;
    const sourceFailure = await this.removeMoveSource(sourceTask);
    if (sourceFailure) {
      return this.partialMove(
        sourceTask.ref,
        destination.filePath,
        copiedTask,
        sourceFailure ?? 'io-error',
      );
    }
    return targetResult;
  }

  private async copyMoveTarget(
    sourceTask: TaskSnapshot,
    sourceBlock: TaskRootBlock,
    destination: TaskDestination,
    targetFile: TFile,
    indexedRevision: string,
  ): Promise<TaskRepositoryResult> {
    let result: TaskRepositoryResult | undefined;
    let transition: object | undefined;
    let committedContent: string | undefined;
    try {
      await this.processFile(targetFile, (content) => {
        const inserted = this.options.editor.insertRootBlock(
          content,
          sourceBlock.source,
          destination.insertion,
        );
        if (!inserted) {
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        if (this.options.refAuthority && this.options.snapshotState) {
          const revision = this.options.refAuthority.successor(
            sourceTask.ref.revision,
            inserted.block.source,
          );
          if (!revision) {
            result = { type: 'conflict', current: sourceTask };
            return content;
          }
          const staged = this.options.refAuthority.stage(
            {
              filePath: destination.filePath,
              candidateFingerprint: taskRefContentFingerprint(inserted.content),
              candidateLength: inserted.content.length,
              expectedRevision: sourceTask.ref.revision,
              roots: [
                {
                  line: inserted.block.line,
                  source: inserted.block.source,
                  revision,
                },
              ],
            },
            indexedRevision,
          );
          if (staged.type === 'conflict') {
            result = { type: 'conflict', current: sourceTask };
            return content;
          }
          transition = staged.token;
        }
        const copiedTask = this.snapshotFor(destination.filePath, inserted.content, inserted.block);
        if (!copiedTask) {
          if (transition) this.options.refAuthority?.abort(transition);
          transition = undefined;
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        result = {
          type: 'committed',
          outcome: { type: 'task', task: copiedTask },
          changed: true,
        };
        committedContent = inserted.content;
        return inserted.content;
      });
    } catch {
      if (transition) this.options.refAuthority?.abort(transition);
      if (committedContent !== undefined) {
        await this.reconcileAfterRejection(targetFile, destination.filePath);
      }
      return {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      };
    }
    if (transition && committedContent !== undefined) {
      this.options.refAuthority?.commit(transition);
      const installed = this.options.snapshotState?.installCommittedContent(
        destination.filePath,
        committedContent,
      );
      this.options.refAuthority?.acknowledge(destination.filePath, committedContent);
      if (result?.type === 'committed' && result.outcome.type === 'task' && installed) {
        const line = result.outcome.task.source.line;
        const task = installed.find((candidate) => candidate.source.line === line);
        if (task) result = { ...result, outcome: { type: 'task', task } };
      }
    }
    return (
      result ?? {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      }
    );
  }

  private async removeMoveSource(
    sourceTask: TaskSnapshot,
  ): Promise<MoveRecovery['cause'] | undefined> {
    const file = this.app.vault.getAbstractFileByPath(sourceTask.ref.filePath);
    if (!(file instanceof TFile)) return 'not-found';
    let prepared = false;
    let committedContent: string | undefined;
    let failure: MoveRecovery['cause'] | undefined;
    try {
      await this.processFile(file, (content) => {
        const located = this.options.locator.locate(
          this.options.editor.rootBlocks(content),
          sourceTask.ref,
        );
        if (located.type !== 'exact') {
          failure = located.type;
          return content;
        }
        const current = this.snapshotFor(sourceTask.ref.filePath, content, located.block);
        const next = current && this.options.editor.deleteRoot(content, located.block);
        if (!current || next === undefined) {
          failure = 'not-found';
          return content;
        }
        prepared = true;
        committedContent = next;
        return next;
      });
    } catch {
      if (committedContent !== undefined) {
        await this.reconcileRejectedDeletion(file, sourceTask.ref.filePath, sourceTask.ref);
      }
      return 'io-error';
    }
    if (!prepared || failure) return failure ?? 'io-error';
    this.options.snapshotState?.installCommittedContent(
      sourceTask.ref.filePath,
      committedContent ?? '',
    );
    return undefined;
  }

  async completeRecurrence(request: RecurrenceCompletionRequest): Promise<TaskRepositoryResult> {
    const rootRef = rootRefOf(request.target);
    const file = this.app.vault.getAbstractFileByPath(rootRef.filePath);
    if (!(file instanceof TFile)) return { type: 'not-found', target: request.target };

    let result: TaskRepositoryResult | undefined;
    let transitionToken: object | undefined;
    let committedContent: string | undefined;
    try {
      await this.processFile(file, (content) => {
        const evidence = this.options.refAuthority?.evidence(rootRef.revision);
        const indexedRef =
          evidence &&
          this.options.snapshotState?.currentRoot(rootRef.filePath, rootRef.line, evidence.source);
        const located = this.options.locator.locate(
          this.options.editor.rootBlocks(content),
          rootRef,
        );
        if (
          this.options.refAuthority &&
          this.options.snapshotState &&
          (!indexedRef || indexedRef.revision !== rootRef.revision)
        ) {
          if (located.type !== 'exact') {
            result = this.resolutionResultForTarget(
              located,
              request.target,
              rootRef.filePath,
              content,
            );
          } else {
            const current = this.snapshotFor(rootRef.filePath, content, located.block);
            result = current
              ? { type: 'conflict', current }
              : { type: 'not-found', target: request.target };
          }
          return content;
        }
        if (located.type !== 'exact') {
          result = this.resolutionResultForTarget(
            located,
            request.target,
            rootRef.filePath,
            content,
          );
          return content;
        }

        const relativeLine = confirmedTargetRelativeLine(request.target, located.block);
        const current = this.snapshotFor(rootRef.filePath, content, located.block);
        const owner =
          relativeLine === undefined || !current
            ? undefined
            : nodeSnapshot(current, request.target);
        if (relativeLine === undefined || !current || !owner) {
          result = current
            ? { type: 'conflict', current }
            : { type: 'not-found', target: request.target };
          return content;
        }
        if (this.options.codec.statusForSymbol(owner.statusSymbol) === 'done') {
          result = {
            type: 'committed',
            outcome: { type: 'task', task: current },
            changed: false,
          };
          return content;
        }
        const prepared = prepareRecurrenceCandidate(
          this.options.editor,
          content,
          located.block,
          owner,
          relativeLine,
          request,
        );
        if (prepared.type === 'invalid') {
          result = prepared.result;
          return content;
        }
        const { candidate, deletesCompleted, cleanOffset, completedOffset } = prepared;
        const nestedOwner = request.target.type === 'subtask';
        const activeCoordinates = occurrenceCoordinates(
          located.block.line,
          relativeLine,
          cleanOffset,
          nestedOwner,
        );
        const completedCoordinates = occurrenceCoordinates(
          located.block.line,
          relativeLine,
          completedOffset,
          nestedOwner,
        );
        if (this.options.refAuthority && this.options.snapshotState) {
          const staged = stageRootTransition(
            this.options.refAuthority,
            this.options.editor,
            rootRef.filePath,
            candidate,
            rootRef.revision,
            indexedRef?.revision ?? '',
            [
              activeCoordinates.rootLine,
              ...(!deletesCompleted ? [completedCoordinates.rootLine] : []),
            ],
          );
          if (staged.type === 'invalid') {
            result = invalidRecurrence('invalid-task-syntax');
            return content;
          }
          if (staged.type === 'conflict') {
            result = { type: 'conflict', current };
            return content;
          }
          transitionToken = staged.token;
        }
        const finalSnapshots =
          this.options.snapshotState?.previewContent(rootRef.filePath, candidate) ??
          this.options.snapshotsFromContent(rootRef.filePath, candidate);
        const active = occurrenceAt(
          finalSnapshots,
          activeCoordinates.rootLine,
          activeCoordinates.targetRelativeLine,
        );
        const completed = deletesCompleted
          ? undefined
          : occurrenceAt(
              finalSnapshots,
              completedCoordinates.rootLine,
              completedCoordinates.targetRelativeLine,
            );
        if (!active || (!deletesCompleted && !completed)) {
          if (transitionToken) this.options.refAuthority?.abort(transitionToken);
          transitionToken = undefined;
          result = invalidRecurrence('invalid-task-syntax');
          return content;
        }
        result = {
          type: 'committed',
          outcome: {
            type: 'recurrence',
            active,
            ...(completed !== undefined && { completed }),
          },
          changed: true,
        };
        committedContent = candidate;
        return candidate;
      });
    } catch {
      if (transitionToken) {
        await this.abortAndReconcileTransition(file, rootRef.filePath, transitionToken, rootRef);
      } else if (committedContent !== undefined) {
        await this.reconcileRejectedDeletion(file, rootRef.filePath, rootRef);
      }
      return {
        type: 'io-error',
        cause: 'process-error',
        path: rootRef.filePath,
        contentState: 'unknown',
      };
    }
    if (transitionToken && committedContent) {
      this.options.refAuthority?.commit(transitionToken);
      this.options.snapshotState?.installCommittedContent(rootRef.filePath, committedContent);
      this.options.refAuthority?.acknowledge(rootRef.filePath, committedContent);
    }
    return (
      result ?? {
        type: 'io-error',
        cause: 'process-error',
        path: rootRef.filePath,
        contentState: 'unknown',
      }
    );
  }

  async edit(command: TaskEditCommand): Promise<TaskRepositoryResult> {
    if (
      command.type === 'reorder-subtask' &&
      !sameTaskNodeRef(command.subtask.parent, command.target.parent)
    ) {
      return {
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask-parent' }],
      };
    }
    const rootRef = rootRefForCommand(command);
    const file = this.app.vault.getAbstractFileByPath(rootRef.filePath);
    if (!(file instanceof TFile)) {
      return { type: 'not-found', target: mutationTarget(command) };
    }

    let result: TaskRepositoryResult | undefined;
    let transitionToken: object | undefined;
    let committedContent: string | undefined;
    try {
      await this.processFile(file, (content) => {
        const evidence = this.options.refAuthority?.evidence(rootRef.revision);
        const indexedRef =
          evidence &&
          this.options.snapshotState?.currentRoot(rootRef.filePath, rootRef.line, evidence.source);
        const candidate = (() => {
          const blocks = this.options.editor.rootBlocks(content);
          const located = this.options.locator.locate(blocks, rootRef);
          if (
            this.options.refAuthority &&
            this.options.snapshotState &&
            (!indexedRef || indexedRef.revision !== rootRef.revision)
          ) {
            if (located.type === 'exact') {
              const current = this.snapshotFor(rootRef.filePath, content, located.block);
              result = current
                ? { type: 'conflict', current }
                : { type: 'not-found', target: mutationTarget(command) };
            } else {
              result = this.resolutionResult(located, command, rootRef.filePath, content);
            }
            return content;
          }
          if (located.type !== 'exact') {
            result = this.resolutionResult(located, command, rootRef.filePath, content);
            return content;
          }

          if (command.type === 'delete') {
            const current = this.snapshotFor(rootRef.filePath, content, located.block);
            const next = this.options.editor.deleteRoot(content, located.block);
            if (!current || next === undefined) {
              result = { type: 'not-found', target: mutationTarget(command) };
              return content;
            }
            result = {
              type: 'committed',
              outcome: { type: 'deleted', ref: current.ref },
              changed: true,
            };
            return next;
          }

          const nodeTarget = nodeTargetOf(command);
          const relativeLine = nodeTarget
            ? confirmedTargetRelativeLine(nodeTarget, located.block)
            : 0;
          if (relativeLine === undefined) {
            const current = this.snapshotFor(rootRef.filePath, content, located.block);
            result = current
              ? { type: 'conflict', current }
              : { type: 'not-found', target: mutationTarget(command) };
            return content;
          }

          const completionDelete = this.deleteOnCompletion(
            command,
            rootRef.filePath,
            content,
            located.block,
            relativeLine,
            nodeTarget,
          );
          if (completionDelete !== undefined) {
            result = completionDelete.result;
            return completionDelete.content;
          }

          if (isStructuralCommand(command)) {
            const edit = this.editStructural(
              command,
              rootRef.filePath,
              content,
              located.block,
              relativeLine,
              nodeTarget,
            );
            result = edit.result;
            return edit.content;
          }

          if (command.type === 'edit-link' && command.target.type !== 'title') {
            const edit = this.editTextTarget(
              command,
              rootRef,
              content,
              located.block,
              relativeLine,
              nodeTarget,
            );
            result = edit.result;
            return edit.content;
          }
          const lines = content.split(/\r?\n/u);
          const sourceLine = lines[located.block.line + relativeLine];
          if (
            sourceLine === undefined ||
            !this.options.codec.parseLine(sourceLine, { filePath: '', line: 0 })
          ) {
            result = { type: 'not-found', target: mutationTarget(command) };
            return content;
          }

          const editResult = applyTaskCommand(this.options.codec, sourceLine, command);
          if (editResult.type === 'invalid') {
            result = editResult;
            return content;
          }
          if (editResult.type === 'unchanged') {
            const task = this.snapshotFor(rootRef.filePath, content, located.block);
            result = task
              ? { type: 'committed', outcome: { type: 'task', task }, changed: false }
              : { type: 'not-found', target: mutationTarget(command) };
            return content;
          }

          const replaced = this.options.editor.replaceLine(
            content,
            located.block,
            relativeLine,
            editResult.content,
          );
          const task = this.snapshotFor(rootRef.filePath, replaced.content, replaced.block);
          if (!task) {
            result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
            return content;
          }
          result = { type: 'committed', outcome: { type: 'task', task }, changed: true };
          return replaced.content;
        })();
        if (result?.type !== 'committed' || !result.changed) return candidate;
        committedContent = candidate;
        const outcome = result.outcome;
        if (outcome.type !== 'task' || !this.options.refAuthority || !this.options.snapshotState) {
          return candidate;
        }
        const surviving = this.options.editor
          .rootBlocks(candidate)
          .find((root) => root.line === outcome.task.source.line);
        const revision =
          surviving && this.options.refAuthority.successor(rootRef.revision, surviving.source);
        if (!surviving || !revision) {
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          committedContent = undefined;
          return content;
        }
        const staged = this.options.refAuthority.stage(
          {
            filePath: rootRef.filePath,
            candidateFingerprint: taskRefContentFingerprint(candidate),
            candidateLength: candidate.length,
            expectedRevision: rootRef.revision,
            roots: [{ line: surviving.line, source: surviving.source, revision }],
          },
          indexedRef?.revision ?? '',
        );
        if (staged.type === 'conflict') {
          const current = this.options.snapshotState
            .previewContent(rootRef.filePath, content)
            .find((task) => task.ref.revision === rootRef.revision);
          result = current
            ? { type: 'conflict', current }
            : { type: 'not-found', target: mutationTarget(command) };
          committedContent = undefined;
          return content;
        }
        transitionToken = staged.token;
        return candidate;
      });
    } catch {
      if (transitionToken) {
        await this.abortAndReconcileTransition(file, rootRef.filePath, transitionToken, rootRef);
      } else if (committedContent !== undefined) {
        await this.reconcileRejectedDeletion(file, rootRef.filePath, rootRef);
      }
      return {
        type: 'io-error',
        cause: 'process-error',
        path: rootRef.filePath,
        contentState: 'unknown',
      };
    }
    if (result?.type === 'committed' && result.changed && committedContent !== undefined) {
      if (transitionToken) this.options.refAuthority?.commit(transitionToken);
      const installed = this.options.snapshotState?.installCommittedContent(
        rootRef.filePath,
        committedContent,
      );
      if (transitionToken)
        this.options.refAuthority?.acknowledge(rootRef.filePath, committedContent);
      if (result.outcome.type === 'task' && installed) {
        const outcome = result.outcome;
        const rebased = installed.find(
          (candidate) => candidate.source.line === outcome.task.source.line,
        );
        if (rebased) result = { ...result, outcome: { type: 'task', task: rebased } };
      }
    }
    return (
      result ?? {
        type: 'io-error',
        cause: 'process-error',
        path: rootRef.filePath,
        contentState: 'unknown',
      }
    );
  }

  private editStructural(
    command: StructuralTaskEditCommand,
    path: string,
    content: string,
    block: TaskRootBlock,
    relativeLine: number,
    nodeTarget: PlanningTarget | undefined,
  ): { readonly result: TaskRepositoryResult; readonly content: string } {
    const current = this.snapshotFor(path, content, block);
    const node = current && nodeTarget ? nodeSnapshot(current, nodeTarget) : undefined;
    if (!current || !node) {
      return {
        result: current
          ? { type: 'conflict', current }
          : { type: 'not-found', target: mutationTarget(command) },
        content,
      };
    }
    if (
      (command.type === 'update-comment' || command.type === 'delete-comment') &&
      !ownsComment(node, command.comment)
    ) {
      return { result: { type: 'conflict', current }, content };
    }
    if (command.type === 'delete-subtask' && !ownsSubtask(node, command.subtask)) {
      return { result: { type: 'conflict', current }, content };
    }
    if (
      command.type === 'reorder-subtask' &&
      (!ownsSubtask(node, command.subtask) || !ownsSubtask(node, command.target))
    ) {
      return { result: { type: 'conflict', current }, content };
    }
    let editorCommand = command;
    if (command.type === 'add-subtask') {
      if (command.text.trim().length === 0 || /[\r\n]/u.test(command.text)) {
        return {
          result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] },
          content,
        };
      }
      const today = (command as unknown as { readonly today?: LocalDate }).today;
      if (today === undefined) {
        return {
          result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] },
          content,
        };
      }
      const created = createTaskBlock(this.options.codec, {
        markdownBody: command.text,
        today,
        addCreatedDate: command.addCreatedDate,
      });
      if (created.type === 'invalid') return { result: created, content };
      editorCommand = { ...command, text: created.content.slice('- [ ] '.length) };
    }
    const edited = this.options.editor.edit(
      content,
      block,
      blockTarget(node, block, relativeLine),
      structuralEdit(editorCommand),
    );
    if (edited.type === 'conflict') {
      return { result: { type: 'conflict', current }, content };
    }
    if (edited.type === 'invalid') {
      return {
        result: { type: 'invalid', issues: [{ code: 'invalid-target', field: edited.field }] },
        content,
      };
    }
    if (edited.type === 'unchanged') {
      return {
        result: { type: 'committed', outcome: { type: 'task', task: current }, changed: false },
        content,
      };
    }
    const task = this.snapshotFor(path, edited.content, edited.block);
    return task
      ? {
          result: { type: 'committed', outcome: { type: 'task', task }, changed: true },
          content: edited.content,
        }
      : {
          result: { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] },
          content,
        };
  }

  private deleteOnCompletion(
    command: TaskEditCommand,
    path: string,
    content: string,
    block: TaskRootBlock,
    relativeLine: number,
    target: PlanningTarget | undefined,
  ): { readonly result: TaskRepositoryResult; readonly content: string } | undefined {
    if (
      command.type !== 'set-status' ||
      command.stamp === undefined ||
      this.options.codec.statusForSymbol(command.symbol) !== 'done' ||
      target === undefined
    ) {
      return undefined;
    }
    const current = this.snapshotFor(path, content, block);
    const owner = current && nodeSnapshot(current, target);
    const sourceLine = content.split(/\r?\n/u)[block.line + relativeLine];
    const parsed =
      sourceLine === undefined
        ? null
        : this.options.codec.parseLine(sourceLine, {
            filePath: path,
            line: block.line + relativeLine,
          });
    if (
      !current ||
      !owner ||
      !parsed ||
      owner.onCompletion !== 'delete' ||
      hasAuthoredRecurrence(parsed)
    ) {
      return undefined;
    }
    if (target.type === 'task') {
      const next = this.options.editor.deleteRoot(content, block);
      return next === undefined
        ? {
            result: invalidRecurrence('invalid-task-syntax'),
            content,
          }
        : {
            result: {
              type: 'committed',
              outcome: { type: 'deleted', ref: current.ref },
              changed: true,
            },
            content: next,
          };
    }
    const next = this.options.editor.replaceOwnedTaskSubtree(content, block, relativeLine, []);
    if (next === undefined) {
      return { result: invalidRecurrence('invalid-task-syntax'), content };
    }
    const updatedBlock = this.options.editor
      .rootBlocks(next)
      .find((candidate) => candidate.line === block.line);
    const root = updatedBlock && this.snapshotFor(path, next, updatedBlock);
    return root
      ? {
          result: { type: 'committed', outcome: { type: 'task', task: root }, changed: true },
          content: next,
        }
      : { result: invalidRecurrence('invalid-task-syntax'), content };
  }

  private async processFile(file: TFile, transform: (content: string) => string): Promise<void> {
    await this.app.vault.process(file, transform);
  }

  private editTextTarget(
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
    rootRef: TaskRef,
    content: string,
    block: TaskRootBlock,
    relativeLine: number,
    nodeTarget: PlanningTarget | undefined,
  ): { readonly result: TaskRepositoryResult; readonly content: string } {
    const current = this.snapshotFor(rootRef.filePath, content, block);
    const targetNode = nodeTarget ? current && nodeSnapshot(current, nodeTarget) : undefined;
    if (!current || !targetNode) {
      return {
        result: current
          ? { type: 'conflict', current }
          : { type: 'not-found', target: mutationTarget(command) },
        content,
      };
    }
    const lines = content.split(/\r?\n/u);
    let targetRelativeLine: number | undefined;
    let occurrence = command.occurrence;
    if (command.target.type === 'comment') {
      targetRelativeLine = commentRelativeLine(relativeLine, command.target.ref, lines, block.line);
      if (targetRelativeLine === undefined) {
        return { result: { type: 'conflict', current }, content };
      }
    } else if (command.target.type === 'description') {
      for (const candidate of this.options.editor.descriptionLines(
        content,
        block,
        blockTarget(targetNode, block, relativeLine),
      )) {
        const linkCount = parseLinks(lines[block.line + candidate] ?? '').length;
        if (occurrence < linkCount) {
          targetRelativeLine = candidate;
          break;
        }
        occurrence -= linkCount;
      }
    }
    if (targetRelativeLine === undefined) {
      return {
        result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] },
        content,
      };
    }
    const source = lines[block.line + targetRelativeLine] ?? '';
    const editResult = this.options.codec.editTextLink(source, occurrence, command.replacement);
    if (editResult.type === 'invalid') return { result: editResult, content };
    if (editResult.type === 'unchanged') {
      return {
        result: { type: 'committed', outcome: { type: 'task', task: current }, changed: false },
        content,
      };
    }
    const replaced = this.options.editor.replaceLine(
      content,
      block,
      targetRelativeLine,
      editResult.content,
    );
    const task = this.snapshotFor(rootRef.filePath, replaced.content, replaced.block);
    return task
      ? {
          result: { type: 'committed', outcome: { type: 'task', task }, changed: true },
          content: replaced.content,
        }
      : {
          result: { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] },
          content,
        };
  }

  private snapshotFor(
    path: string,
    content: string,
    block: TaskRootBlock,
  ): TaskSnapshot | undefined {
    const snapshot = (
      this.options.snapshotState?.previewContent(path, content) ??
      this.options.snapshotsFromContent(path, content)
    ).find((candidate) => candidate.source.line === block.line);
    if (!snapshot) return undefined;
    if (this.options.snapshotState) return snapshot;
    const ref: TaskRef = {
      filePath: path,
      line: block.line,
      revision: this.options.locator.revision(block.source),
    };
    return rebaseSnapshot(snapshot, ref);
  }

  private candidateFor(
    block: TaskRootBlock,
    command: TaskEditCommand,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshotFor(path, content, block);
    if (!root) return undefined;
    const original = mutationTarget(command);
    const target =
      original.type === 'comment'
        ? {
            type: 'comment' as const,
            ref: { ...original.ref, parent: rebaseNode(original.ref.parent, root.ref) },
          }
        : rebaseNode(original, root.ref);
    return { root, target };
  }

  private candidateForTarget(
    block: TaskRootBlock,
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshotFor(path, content, block);
    return root ? { root, target: rebaseNode(target, root.ref) } : undefined;
  }

  private resolutionResultForTarget(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') return { type: 'not-found', target };
    if (located.type === 'conflict') {
      const current = this.snapshotFor(path, content, located.block);
      return current ? { type: 'conflict', current } : { type: 'not-found', target };
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateForTarget(block, target, path, content);
      return candidate ? [candidate] : [];
    });
    return candidates.length > 0
      ? { type: 'ambiguous', candidates }
      : { type: 'not-found', target };
  }

  private resolutionResult(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    command: TaskEditCommand,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') {
      return { type: 'not-found', target: mutationTarget(command) };
    }
    if (located.type === 'conflict') {
      const current = this.snapshotFor(path, content, located.block);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: mutationTarget(command) };
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateFor(block, command, path, content);
      return candidate ? [candidate] : [];
    });
    return candidates.length > 0
      ? { type: 'ambiguous', candidates }
      : { type: 'not-found', target: mutationTarget(command) };
  }

  private resolutionResultForRef(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    ref: TaskRef,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') {
      return { type: 'not-found', target: { type: 'task', ref } };
    }
    if (located.type === 'conflict') {
      const current = this.snapshotFor(ref.filePath, content, located.block);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: { type: 'task', ref } };
    }
    return {
      type: 'ambiguous',
      candidates: located.blocks.flatMap((block) => {
        const root = this.snapshotFor(ref.filePath, content, block);
        return root ? [{ root, target: { type: 'task' as const, ref: root.ref } }] : [];
      }),
    };
  }

  private partialMove(
    source: TaskRef,
    targetPath: string,
    copiedTask: TaskSnapshot,
    cause: MoveRecovery['cause'],
  ): TaskRepositoryResult {
    return {
      type: 'partial',
      operation: 'move',
      recovery: {
        source,
        targetPath,
        copiedTask,
        state: 'target-copied-source-remains',
        cause,
      },
    };
  }

  private async reconcileAfterRejection(file: TFile, path: string): Promise<void> {
    if (!this.options.snapshotState) return;
    try {
      const authoritative = await this.app.vault.read(file);
      this.options.snapshotState.installCommittedContent(path, authoritative);
    } catch {
      // The caller's failure result records that the authoritative content is unknown.
    }
  }

  private async abortAndReconcileTransition(
    file: TFile,
    path: string,
    token: object,
    consumed: TaskRef,
  ): Promise<void> {
    const authority = this.options.refAuthority;
    if (!authority || !this.options.snapshotState) {
      authority?.abort(token);
      await this.reconcileAfterRejection(file, path);
      return;
    }

    let authoritative: string;
    try {
      authoritative = await this.app.vault.read(file);
    } catch {
      authority.abort(token);
      return;
    }
    authority.abort(token);

    this.installRejectedContent(path, authoritative, consumed);
  }

  private async reconcileRejectedDeletion(
    file: TFile,
    path: string,
    consumed: TaskRef,
  ): Promise<void> {
    try {
      const authoritative = await this.app.vault.read(file);
      this.installRejectedContent(path, authoritative, consumed);
    } catch {
      // The caller's failure result records that the authoritative content is unknown.
    }
  }

  private installRejectedContent(path: string, authoritative: string, consumed: TaskRef): void {
    const authority = this.options.refAuthority;
    const snapshotState = this.options.snapshotState;
    if (!authority || !snapshotState) {
      snapshotState?.installCommittedContent(path, authoritative);
      return;
    }

    const evidence = authority.evidence(consumed.revision);
    const current = evidence && snapshotState.currentRoot(path, consumed.line, evidence.source);
    const located = this.options.locator.locate(
      this.options.editor.rootBlocks(authoritative),
      consumed,
    );
    if (!evidence || current?.revision === consumed.revision || located.type !== 'exact') {
      try {
        snapshotState.installCommittedContent(path, authoritative);
      } catch {
        // The caller's failure result records that the authoritative content is unknown.
      }
      return;
    }

    const expectedRevision = current?.revision ?? consumed.revision;

    const rollback = authority.stage(
      {
        filePath: path,
        candidateFingerprint: taskRefContentFingerprint(authoritative),
        candidateLength: authoritative.length,
        expectedRevision,
        roots: [
          {
            line: located.block.line,
            source: located.block.source,
            revision: consumed.revision,
          },
        ],
      },
      expectedRevision,
    );
    if (rollback.type === 'conflict') return;
    try {
      snapshotState.installCommittedContent(path, authoritative);
    } catch {
      // The caller's failure result records that the authoritative content is unknown.
    } finally {
      authority.abort(rollback.token);
    }
  }
}
