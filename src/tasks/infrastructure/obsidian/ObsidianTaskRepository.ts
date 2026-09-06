import { TFile, type App } from 'obsidian';
import { parseLinks } from '../../../markdown/links';
import {
  dependencyMetadataIssues,
  subtaskRestorationGapIsCurrent,
  subtaskRestorationIssues,
  type CreateDependencySubtaskRequest,
  type RecurrenceCompletionRequest,
  type RecurrenceCompletionRevisionRequest,
  type RevisionPrecondition,
  type TaskDraft,
  type TaskEditBatchRequest,
  type TaskEditCommand,
  type TaskEditRequest,
  type TaskMoveRequest,
  type TaskRepository,
  type TaskRepositoryResult,
} from '../../application/TaskRepository';
import type {
  MoveRecovery,
  PlanningTarget,
  TaskOccurrenceResult,
  TaskResolutionCandidate,
} from '../../domain/commands';
import {
  nextOccurrencePlanning,
  parseRecurrenceRule,
  type RecurrenceIssueCode,
} from '../../domain/recurrence';
import {
  prepareRecurrenceIteration,
  recurrenceMarkerCountInOwnedSubtree,
} from '../../domain/recurrenceIteration';
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
import {
  dependencySubtaskResolutionRequest,
  finishDependencySubtask,
  prepareDependencySubtask,
  type PreparedDependencySubtask,
} from '../createDependencySubtask';
import { applyTaskCommand } from '../markdown/applyTaskCommand';
import { createTaskBlock } from '../markdown/createTaskBlock';
import {
  recoverSubtaskRemoval,
  withSubtaskRemovalRecovery,
} from '../markdown/subtaskRemovalRecovery';
import type { TaskBlockEdit, TaskBlockTarget, TaskRootBlock } from '../markdown/TaskBlockEditor';
import { type TaskBlockEditor } from '../markdown/TaskBlockEditor';
import { type TaskLocator } from '../markdown/TaskLocator';
import { type TaskMarkdownCodec } from '../markdown/TaskMarkdownCodec';
import { preparedRevisionResult } from '../preparedRevisionResult';
import {
  prepareTaskEditBatch,
  stageTaskEditBatch,
  taskEditBatchIssues,
  type PreparedTaskEditBatch,
} from '../TaskEditBatch';
import {
  hasUnconfirmedCurrentRoot,
  taskRefContentFingerprint,
  type RootRevisionOverride,
  type TaskRefAuthority,
  type TaskRefStageResult,
  type TaskSnapshotState,
} from '../TaskRefAuthority';

type LocateResult = ReturnType<TaskLocator['locate']>;

function authorityRevisionChanged(
  hasAuthority: boolean,
  hasSnapshotState: boolean,
  indexedRef: TaskRef | undefined,
  revision: string,
): boolean {
  return hasAuthority && hasSnapshotState && indexedRef?.revision !== revision;
}

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
      | 'restore-subtask'
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

function directNodeTargetOf(command: TaskEditCommand): PlanningTarget | undefined {
  if (command.type === 'patch') return command.target;
  if (command.type === 'set-status') return command.target;
  if (command.type === 'append-title') return command.target;
  if (command.type === 'set-description') return command.target;
  if (command.type === 'set-dependency-id' || command.type === 'set-depends-on') {
    return command.target;
  }
  return undefined;
}

function relatedNodeTargetOf(command: TaskEditCommand): PlanningTarget | undefined {
  if (
    command.type === 'add-subtask' ||
    command.type === 'restore-subtask' ||
    command.type === 'add-comment'
  )
    return command.parent;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return command.subtask.parent;
  }
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return command.comment.parent;
  }
  return undefined;
}

function nodeTargetOf(command: TaskEditCommand): PlanningTarget | undefined {
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target.ref.parent : command.target.target;
  }
  return directNodeTargetOf(command) ?? relatedNodeTargetOf(command);
}

function rootRefForCommand(command: TaskEditCommand): TaskRef {
  const target = nodeTargetOf(command);
  if (target != null) return rootRefOf(target);
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

function structuralMutationTarget(command: TaskEditCommand): TaskMutationTarget | undefined {
  if (
    command.type === 'add-subtask' ||
    command.type === 'restore-subtask' ||
    command.type === 'add-comment'
  )
    return command.parent;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return { type: 'subtask', ref: command.subtask };
  }
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return { type: 'comment', ref: command.comment };
  }
  return undefined;
}

function mutationTarget(command: TaskEditCommand): TaskMutationTarget {
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target : command.target.target;
  }
  const node = directNodeTargetOf(command);
  if (node !== undefined) return node;
  const structural = structuralMutationTarget(command);
  return structural ?? { type: 'task', ref: rootRefForCommand(command) };
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
    if (next == null) return undefined;
    current = next;
  }
  return current;
}

function optionalNodeSnapshot(
  root: TaskSnapshot | undefined,
  target: PlanningTarget | undefined,
): TaskSnapshot | SubtaskSnapshot | undefined {
  if (root === undefined || target === undefined) return undefined;
  return nodeSnapshot(root, target);
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
  const root = roots[0];
  if (root === undefined) return undefined;
  if (targetRelativeLine === 0) {
    return { root, target: { type: 'task', ref: root.ref } };
  }
  const target = accumulatedSubtaskAt(root, targetRelativeLine);
  return target != null ? { root, target } : undefined;
}

function lineCount(source: string): number {
  return source.split(/\r?\n/u).length;
}

interface RootTransitionInput {
  readonly authority: TaskRefAuthority;
  readonly editor: TaskBlockEditor;
  readonly filePath: string;
  readonly candidate: string;
  readonly expectedRevision: string;
  readonly currentRevision: string;
  readonly rootLines: readonly number[];
}

function stageRootTransition(
  input: RootTransitionInput,
): TaskRefStageResult | { readonly type: 'invalid' } {
  const { authority, editor, filePath, candidate, expectedRevision, currentRevision, rootLines } =
    input;
  const finalBlocks = new Map(
    editor.rootBlocks(candidate).map((block) => [block.line, block] as const),
  );
  const roots: RootRevisionOverride[] = [];
  for (const line of new Set(rootLines)) {
    const block = finalBlocks.get(line);
    if (block === undefined) return { type: 'invalid' };
    const revision = authority.successor(expectedRevision, block.source);
    if (revision === undefined || revision.length === 0) return { type: 'invalid' };
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

interface RecurrenceCandidateInput {
  readonly editor: TaskBlockEditor;
  readonly content: string;
  readonly block: TaskRootBlock;
  readonly owner: TaskSnapshot | SubtaskSnapshot;
  readonly relativeLine: number;
  readonly request: RecurrenceCompletionRequest;
}

function prepareRecurrenceCandidate(input: RecurrenceCandidateInput): PreparedRecurrenceCandidate {
  const { editor, content, block, owner, relativeLine, request } = input;
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

function ordinaryDeleteRecurrenceDisposition(
  parsed: NonNullable<ReturnType<TaskMarkdownCodec['parseLine']>>,
  rawRule: string | undefined,
  rootBlock: string,
  relativeLine: number,
): 'allow' | 'defer' | 'invalid' {
  const recurrenceSpans = parsed.spans.filter(
    (span) =>
      span.kind === 'recurrence' ||
      (span.kind === 'malformed-known' && span.malformedKind === 'recurrence'),
  );
  const ownedMarkerCount = recurrenceMarkerCountInOwnedSubtree(rootBlock, relativeLine);
  if (ownedMarkerCount === undefined) return 'invalid';
  if (recurrenceSpans.length === 0) return ownedMarkerCount === 0 ? 'allow' : 'invalid';
  if (recurrenceSpans.length !== 1 || rawRule === undefined || ownedMarkerCount !== 1) {
    return 'invalid';
  }
  return parseRecurrenceRule(rawRule).type === 'valid' ? 'defer' : 'allow';
}

function blockTarget(
  node: TaskSnapshot | SubtaskSnapshot,
  rootBlock: TaskRootBlock,
  relativeLine: number,
): TaskBlockTarget {
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
    command.type === 'restore-subtask' ||
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
    case 'restore-subtask':
      return { type: command.type, markdown: command.markdown, placement: command.placement };
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

interface MoveTargetInput {
  readonly sourceTask: TaskSnapshot;
  readonly sourceBlock: TaskRootBlock;
  readonly destination: TaskDestination;
  readonly targetFile: TFile;
  readonly indexedRevision: string;
}

interface MoveTargetTransaction {
  result: TaskRepositoryResult | undefined;
  transition: object | undefined;
  committedContent: string | undefined;
}

type MoveSourceResolution =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly task: TaskSnapshot;
      readonly block: TaskRootBlock;
      readonly indexedRevision: string;
    };

interface RecurrenceProcessInput {
  readonly revisionRequest: RecurrenceCompletionRevisionRequest | undefined;
  readonly request: RecurrenceCompletionRequest;
  readonly rootRef: TaskRef;
}

interface RecurrenceTransaction {
  result: TaskRepositoryResult | undefined;
  transitionToken: object | undefined;
  committedContent: string | undefined;
  rollbackBasis?: RollbackBasis | undefined;
}

type RecurrenceLocation =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly block: TaskRootBlock;
      readonly current: TaskSnapshot;
      readonly owner: TaskSnapshot | SubtaskSnapshot;
      readonly relativeLine: number;
      readonly indexedRevision: string;
    };

type ReadyRecurrenceLocation = Extract<RecurrenceLocation, { readonly type: 'ready' }>;
type PreparedRecurrence = Extract<PreparedRecurrenceCandidate, { readonly type: 'prepared' }>;

interface RecurrenceCoordinates {
  readonly active: ReturnType<typeof occurrenceCoordinates>;
  readonly completed: ReturnType<typeof occurrenceCoordinates>;
}

interface RecurrenceCandidateCommitInput {
  readonly process: RecurrenceProcessInput;
  readonly location: ReadyRecurrenceLocation;
  readonly prepared: PreparedRecurrence;
  readonly unchangedContent: string;
}

interface RecurrenceStageInput {
  readonly process: RecurrenceProcessInput;
  readonly location: ReadyRecurrenceLocation;
  readonly prepared: PreparedRecurrence;
  readonly coordinates: RecurrenceCoordinates;
}

interface EditProcessInput {
  readonly prepared: TaskEditRequest | undefined;
  readonly command: TaskEditCommand;
  readonly rootRef: TaskRef;
}

interface EditTransaction {
  result: TaskRepositoryResult | undefined;
  transitionToken: object | undefined;
  committedContent: string | undefined;
  rollbackBasis?: RollbackBasis | undefined;
}

interface RollbackBasis {
  readonly content: string;
  readonly roots: readonly RootRevisionOverride[];
}

type EditLocation =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly block: TaskRootBlock;
      readonly indexedRevision: string;
    };

interface LocatedEditInput {
  readonly process: EditProcessInput;
  readonly content: string;
  readonly block: TaskRootBlock;
  readonly relativeLine: number;
  readonly nodeTarget: PlanningTarget | undefined;
}

interface EditOutcome {
  readonly result: TaskRepositoryResult;
  readonly content: string;
}

interface EditStageInput {
  readonly process: EditProcessInput;
  readonly location: Extract<EditLocation, { readonly type: 'ready' }>;
  readonly edit: EditOutcome;
  readonly originalContent: string;
}

interface SurvivingEditStageInput {
  readonly process: EditProcessInput;
  readonly indexedRevision: string;
  readonly edit: EditOutcome;
  readonly originalContent: string;
  readonly surviving: TaskRootBlock;
}

interface RejectedRollbackContext {
  readonly authority: TaskRefAuthority;
  readonly snapshotState: TaskSnapshotState;
  readonly block: TaskRootBlock;
  readonly expectedRevision: string;
}

type TextEditTarget =
  | { readonly type: 'ready'; readonly relativeLine: number; readonly occurrence: number }
  | { readonly type: 'conflict' }
  | { readonly type: 'invalid' };

export class ObsidianTaskRepository implements TaskRepository {
  readonly supportsRevisionPreconditions = true as const;

  constructor(
    private readonly app_abyssPrivate: App,
    private readonly options_abyssPrivate: RepositoryOptions,
  ) {}

  async create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult> {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (!(file instanceof TFile)) return this.destinationUnavailable_abyssPrivate();
    const block = createTaskBlock(this.options_abyssPrivate.codec, {
      ...draft,
      today: draft.today ?? localDate('1970-01-01'),
      addCreatedDate: draft.addCreatedDate ?? false,
    });
    if (block.type === 'invalid') return block;
    return this.createInFile_abyssPrivate(file, destination, block.content);
  }

  private destinationUnavailable_abyssPrivate(): TaskRepositoryResult {
    return {
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    };
  }

  private async createInFile_abyssPrivate(
    file: TFile,
    destination: TaskDestination,
    blockContent: string,
  ): Promise<TaskRepositoryResult> {
    let result: TaskRepositoryResult | undefined;
    let createdContent: string | undefined;
    try {
      await this.processFile_abyssPrivate(file, (content) => {
        const inserted = this.options_abyssPrivate.editor.insertRootBlock(
          content,
          blockContent,
          destination.insertion,
        );
        if (inserted == null) {
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        const task = this.snapshotFor_abyssPrivate(
          destination.filePath,
          inserted.content,
          inserted.block,
        );
        if (task == null) {
          result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        result = { type: 'committed', outcome: { type: 'task', task }, changed: true };
        createdContent = inserted.content;
        return inserted.content;
      });
    } catch {
      await this.reconcileCreateFailure_abyssPrivate(file, destination.filePath, createdContent);
      return this.processError_abyssPrivate(destination.filePath);
    }
    return this.finalizeCreatedResult_abyssPrivate(destination.filePath, createdContent, result);
  }

  private async reconcileCreateFailure_abyssPrivate(
    file: TFile,
    path: string,
    createdContent: string | undefined,
  ): Promise<void> {
    if (createdContent === undefined || this.options_abyssPrivate.snapshotState == null) return;
    try {
      const authoritative = await this.app_abyssPrivate.vault.read(file);
      this.options_abyssPrivate.snapshotState.installCommittedContent(path, authoritative);
    } catch {
      // The I/O result records that final content state is unknown.
    }
  }

  private finalizeCreatedResult_abyssPrivate(
    path: string,
    content: string | undefined,
    result: TaskRepositoryResult | undefined,
  ): TaskRepositoryResult {
    if (
      content === undefined ||
      content.length === 0 ||
      result?.type !== 'committed' ||
      result.outcome.type !== 'task'
    ) {
      return result ?? this.processError_abyssPrivate(path);
    }
    const installed = this.options_abyssPrivate.snapshotState?.installCommittedContent(
      path,
      content,
    );
    const line = result.outcome.task.source.line;
    const rebased = installed?.find((candidate) => candidate.source.line === line);
    return rebased === undefined ? result : { ...result, outcome: { type: 'task', task: rebased } };
  }

  private processError_abyssPrivate(path: string): TaskRepositoryResult {
    return { type: 'io-error', cause: 'process-error', path, contentState: 'unknown' };
  }

  async move(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult> {
    const prepared = 'baseRoot' in request ? request : undefined;
    const ref = 'baseRoot' in request ? request.baseRoot.ref : request;
    const destination = 'destination' in request ? request.destination : legacyDestination;
    if (destination == null) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'destination' }] };
    }
    const sourceFile = this.app_abyssPrivate.vault.getAbstractFileByPath(ref.filePath);
    if (!(sourceFile instanceof TFile)) {
      return { type: 'not-found', target: { type: 'task', ref } };
    }
    const sourceContent = await this.readMoveSource_abyssPrivate(sourceFile, ref.filePath);
    if (typeof sourceContent !== 'string') return sourceContent;
    const source = this.resolveMoveSource_abyssPrivate(ref, prepared, sourceContent);
    if (source.type === 'result') return source.result;
    if (ref.filePath === destination.filePath) return this.unchangedMove_abyssPrivate(source.task);
    const targetFile = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (!(targetFile instanceof TFile)) return this.destinationUnavailable_abyssPrivate();
    const targetResult = await this.copyMoveTarget_abyssPrivate({
      sourceTask: source.task,
      sourceBlock: source.block,
      destination,
      targetFile,
      indexedRevision: source.indexedRevision,
    });
    return this.finishMoveSource_abyssPrivate(source.task, destination.filePath, targetResult);
  }

  private async readMoveSource_abyssPrivate(
    file: TFile,
    path: string,
  ): Promise<string | TaskRepositoryResult> {
    try {
      return await this.app_abyssPrivate.vault.read(file);
    } catch {
      return {
        type: 'io-error',
        cause: 'read-error',
        path,
        contentState: 'unchanged',
      };
    }
  }

  private resolveMoveSource_abyssPrivate(
    ref: TaskRef,
    prepared: RevisionPrecondition | undefined,
    sourceContent: string,
  ): MoveSourceResolution {
    const evidence = this.options_abyssPrivate.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.options_abyssPrivate.snapshotState?.currentRoot(
            ref.filePath,
            ref.line,
            evidence.source,
          );
    const sourceBlocks = this.options_abyssPrivate.editor.rootBlocks(sourceContent);
    const sourceLocated = this.options_abyssPrivate.locator.locate(sourceBlocks, ref);
    const preparedResult = preparedRevisionResult({
      prepared,
      located: sourceLocated,
      authorityCurrent: this.options_abyssPrivate.snapshotState?.authoritySuccessor?.(ref),
      locateAuthorityCurrent: (currentRef) =>
        this.options_abyssPrivate.locator.locate(sourceBlocks, currentRef),
      snapshot: (block) => this.snapshotFor_abyssPrivate(ref.filePath, sourceContent, block),
    });
    if (preparedResult != null) return { type: 'result', result: preparedResult };
    return this.resolveLocatedMove_abyssPrivate(ref, sourceContent, sourceLocated, indexedRef);
  }

  private resolveLocatedMove_abyssPrivate(
    ref: TaskRef,
    sourceContent: string,
    sourceLocated: LocateResult,
    indexedRef: TaskRef | undefined,
  ): MoveSourceResolution {
    const stale = authorityRevisionChanged(
      this.options_abyssPrivate.refAuthority !== undefined,
      this.options_abyssPrivate.snapshotState !== undefined,
      indexedRef,
      ref.revision,
    );
    if (stale && sourceLocated.type === 'exact') {
      return {
        type: 'result',
        result: this.moveConflict_abyssPrivate(ref, sourceContent, sourceLocated.block),
      };
    }
    if (sourceLocated.type !== 'exact') {
      return {
        type: 'result',
        result: this.resolutionResultForRef_abyssPrivate(sourceLocated, ref, sourceContent),
      };
    }
    const sourceTask = this.snapshotFor_abyssPrivate(
      ref.filePath,
      sourceContent,
      sourceLocated.block,
    );
    if (sourceTask == null) {
      return {
        type: 'result',
        result: { type: 'not-found', target: { type: 'task', ref } },
      };
    }
    return {
      type: 'ready',
      task: sourceTask,
      block: sourceLocated.block,
      indexedRevision: indexedRef?.revision ?? '',
    };
  }

  private moveConflict_abyssPrivate(
    ref: TaskRef,
    content: string,
    block: TaskRootBlock,
  ): TaskRepositoryResult {
    const current = this.snapshotFor_abyssPrivate(ref.filePath, content, block);
    return current != null
      ? { type: 'conflict', current }
      : { type: 'not-found', target: { type: 'task', ref } };
  }

  private unchangedMove_abyssPrivate(task: TaskSnapshot): TaskRepositoryResult {
    return { type: 'committed', outcome: { type: 'task', task }, changed: false };
  }

  private async finishMoveSource_abyssPrivate(
    sourceTask: TaskSnapshot,
    targetPath: string,
    targetResult: TaskRepositoryResult,
  ): Promise<TaskRepositoryResult> {
    if (targetResult.type !== 'committed' || targetResult.outcome.type !== 'task') {
      return targetResult;
    }
    const copiedTask = targetResult.outcome.task;
    const sourceFailure = await this.removeMoveSource_abyssPrivate(sourceTask);
    if (sourceFailure !== undefined && sourceFailure.length > 0) {
      return this.partialMove_abyssPrivate(sourceTask.ref, targetPath, copiedTask, sourceFailure);
    }
    return targetResult;
  }

  private async copyMoveTarget_abyssPrivate(input: MoveTargetInput): Promise<TaskRepositoryResult> {
    const transaction: MoveTargetTransaction = {
      result: undefined,
      transition: undefined,
      committedContent: undefined,
    };
    try {
      await this.processFile_abyssPrivate(input.targetFile, (content) =>
        this.copyMoveContent_abyssPrivate(input, transaction, content),
      );
    } catch {
      await this.rejectMoveTarget_abyssPrivate(input, transaction);
      return this.processError_abyssPrivate(input.destination.filePath);
    }
    return this.commitMoveTarget_abyssPrivate(input, transaction);
  }

  private copyMoveContent_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
    content: string,
  ): string {
    const inserted = this.options_abyssPrivate.editor.insertRootBlock(
      content,
      input.sourceBlock.source,
      input.destination.insertion,
    );
    if (inserted == null) {
      transaction.result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
      return content;
    }
    if (
      !this.stageMoveTransition_abyssPrivate(input, transaction, inserted.content, inserted.block)
    ) {
      return content;
    }
    const copied = this.snapshotFor_abyssPrivate(
      input.destination.filePath,
      inserted.content,
      inserted.block,
    );
    if (copied == null) {
      this.abortMoveTransition_abyssPrivate(transaction);
      transaction.result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
      return content;
    }
    transaction.result = {
      type: 'committed',
      outcome: { type: 'task', task: copied },
      changed: true,
    };
    transaction.committedContent = inserted.content;
    return inserted.content;
  }

  private stageMoveTransition_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
    candidate: string,
    block: TaskRootBlock,
  ): boolean {
    const authority = this.options_abyssPrivate.refAuthority;
    if (authority == null || this.options_abyssPrivate.snapshotState == null) return true;
    const revision = authority.successor(input.sourceTask.ref.revision, block.source);
    if (revision === undefined || revision.length === 0) {
      transaction.result = { type: 'conflict', current: input.sourceTask };
      return false;
    }
    const staged = authority.stage(
      {
        filePath: input.destination.filePath,
        candidateFingerprint: taskRefContentFingerprint(candidate),
        candidateLength: candidate.length,
        expectedRevision: input.sourceTask.ref.revision,
        roots: [{ line: block.line, source: block.source, revision }],
      },
      input.indexedRevision,
    );
    if (staged.type === 'conflict') {
      transaction.result = { type: 'conflict', current: input.sourceTask };
      return false;
    }
    transaction.transition = staged.token;
    return true;
  }

  private abortMoveTransition_abyssPrivate(transaction: MoveTargetTransaction): void {
    if (transaction.transition != null)
      this.options_abyssPrivate.refAuthority?.abort(transaction.transition);
    transaction.transition = undefined;
  }

  private async rejectMoveTarget_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
  ): Promise<void> {
    this.abortMoveTransition_abyssPrivate(transaction);
    if (transaction.committedContent !== undefined) {
      await this.reconcileAfterRejection_abyssPrivate(input.targetFile, input.destination.filePath);
    }
  }

  private commitMoveTarget_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
  ): TaskRepositoryResult {
    const content = transaction.committedContent;
    const token = transaction.transition;
    if (token == null || content === undefined) {
      return transaction.result ?? this.processError_abyssPrivate(input.destination.filePath);
    }
    this.options_abyssPrivate.refAuthority?.commit(token);
    const installed = this.options_abyssPrivate.snapshotState?.installCommittedContent(
      input.destination.filePath,
      content,
    );
    this.options_abyssPrivate.refAuthority?.acknowledge(input.destination.filePath, content);
    return this.rebaseMoveResult_abyssPrivate(
      transaction.result,
      installed,
      input.destination.filePath,
    );
  }

  private rebaseMoveResult_abyssPrivate(
    result: TaskRepositoryResult | undefined,
    installed: readonly TaskSnapshot[] | undefined,
    path: string,
  ): TaskRepositoryResult {
    if (result?.type !== 'committed' || result.outcome.type !== 'task' || installed === undefined) {
      return result ?? this.processError_abyssPrivate(path);
    }
    const line = result.outcome.task.source.line;
    const task = installed.find((candidate) => candidate.source.line === line);
    return task === undefined ? result : { ...result, outcome: { type: 'task', task } };
  }

  private async removeMoveSource_abyssPrivate(
    sourceTask: TaskSnapshot,
  ): Promise<MoveRecovery['cause'] | undefined> {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(sourceTask.ref.filePath);
    if (!(file instanceof TFile)) return 'not-found';
    let committedContent: string | undefined;
    let failure: MoveRecovery['cause'] | undefined;
    try {
      await this.processFile_abyssPrivate(file, (content) => {
        const located = this.options_abyssPrivate.locator.locate(
          this.options_abyssPrivate.editor.rootBlocks(content),
          sourceTask.ref,
        );
        if (located.type !== 'exact') {
          failure = located.type;
          return content;
        }
        const current = this.snapshotFor_abyssPrivate(
          sourceTask.ref.filePath,
          content,
          located.block,
        );
        const next =
          current === undefined
            ? undefined
            : this.options_abyssPrivate.editor.deleteRoot(content, located.block);
        if (current === undefined || next === undefined) {
          failure = 'not-found';
          return content;
        }
        committedContent = next;
        return next;
      });
    } catch {
      if (committedContent !== undefined) {
        await this.reconcileRejectedDeletion_abyssPrivate(
          file,
          sourceTask.ref.filePath,
          sourceTask.ref,
        );
      }
      return 'io-error';
    }
    if (committedContent === undefined || (failure !== undefined && failure.length > 0)) {
      return failure ?? 'io-error';
    }
    this.options_abyssPrivate.snapshotState?.installCommittedContent(
      sourceTask.ref.filePath,
      committedContent,
    );
    return undefined;
  }

  async completeRecurrence(
    requestOrCommand: RecurrenceCompletionRevisionRequest | RecurrenceCompletionRequest,
  ): Promise<TaskRepositoryResult> {
    const revisionRequest = 'command' in requestOrCommand ? requestOrCommand : undefined;
    const request = 'command' in requestOrCommand ? requestOrCommand.command : requestOrCommand;
    const rootRef = rootRefOf(request.target);
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(rootRef.filePath);
    if (!(file instanceof TFile)) return { type: 'not-found', target: request.target };
    const input: RecurrenceProcessInput = { revisionRequest, request, rootRef };
    const transaction: RecurrenceTransaction = {
      result: undefined,
      transitionToken: undefined,
      committedContent: undefined,
    };
    try {
      await this.processFile_abyssPrivate(file, (content) =>
        this.completeRecurrenceContent_abyssPrivate(input, transaction, content),
      );
    } catch {
      await this.rejectMutation_abyssPrivate(file, rootRef, transaction);
      return this.processError_abyssPrivate(rootRef.filePath);
    }
    this.commitRecurrence_abyssPrivate(input, transaction);
    return transaction.result ?? this.processError_abyssPrivate(rootRef.filePath);
  }

  private completeRecurrenceContent_abyssPrivate(
    input: RecurrenceProcessInput,
    transaction: RecurrenceTransaction,
    content: string,
  ): string {
    const location = this.resolveRecurrenceLocation_abyssPrivate(input, content);
    if (location.type === 'result') {
      transaction.result = location.result;
      return content;
    }
    transaction.rollbackBasis = this.captureRollbackBasis_abyssPrivate(
      input.rootRef.filePath,
      content,
    );
    if (this.options_abyssPrivate.codec.statusForSymbol(location.owner.statusSymbol) === 'done') {
      transaction.result = this.unchangedMove_abyssPrivate(location.current);
      return content;
    }
    const prepared = prepareRecurrenceCandidate({
      editor: this.options_abyssPrivate.editor,
      content,
      block: location.block,
      owner: location.owner,
      relativeLine: location.relativeLine,
      request: input.request,
    });
    if (prepared.type === 'invalid') {
      transaction.result = prepared.result;
      return content;
    }
    return this.commitRecurrenceCandidate_abyssPrivate(
      { process: input, location, prepared, unchangedContent: content },
      transaction,
    );
  }

  private resolveRecurrenceLocation_abyssPrivate(
    input: RecurrenceProcessInput,
    content: string,
  ): RecurrenceLocation {
    const { rootRef } = input;
    const evidence = this.options_abyssPrivate.refAuthority?.evidence(rootRef.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.options_abyssPrivate.snapshotState?.currentRoot(
            rootRef.filePath,
            rootRef.line,
            evidence.source,
          );
    const blocks = this.options_abyssPrivate.editor.rootBlocks(content);
    const located = this.options_abyssPrivate.locator.locate(blocks, rootRef);
    const revision = preparedRevisionResult({
      prepared: input.revisionRequest,
      located,
      authorityCurrent: this.options_abyssPrivate.snapshotState?.authoritySuccessor?.(rootRef),
      locateAuthorityCurrent: (currentRef) =>
        this.options_abyssPrivate.locator.locate(blocks, currentRef),
      snapshot: (block) => this.snapshotFor_abyssPrivate(rootRef.filePath, content, block),
    });
    if (revision != null) return { type: 'result', result: revision };
    return this.resolveLocatedRecurrence_abyssPrivate(input, content, located, indexedRef);
  }

  private resolveLocatedRecurrence_abyssPrivate(
    input: RecurrenceProcessInput,
    content: string,
    located: LocateResult,
    indexedRef: TaskRef | undefined,
  ): RecurrenceLocation {
    const { rootRef, request } = input;
    const stale = authorityRevisionChanged(
      this.options_abyssPrivate.refAuthority !== undefined,
      this.options_abyssPrivate.snapshotState !== undefined,
      indexedRef,
      rootRef.revision,
    );
    if (stale || located.type !== 'exact') {
      return {
        type: 'result',
        result: this.recurrenceResolution_abyssPrivate(
          located,
          request.target,
          rootRef.filePath,
          content,
        ),
      };
    }
    return this.resolveExactRecurrence_abyssPrivate(
      input,
      content,
      located.block,
      indexedRef?.revision ?? '',
    );
  }

  private recurrenceResolution_abyssPrivate(
    located: LocateResult,
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type !== 'exact') {
      return this.resolutionResultForTarget_abyssPrivate(located, target, path, content);
    }
    const current = this.snapshotFor_abyssPrivate(path, content, located.block);
    return current != null ? { type: 'conflict', current } : { type: 'not-found', target };
  }

  private resolveExactRecurrence_abyssPrivate(
    input: RecurrenceProcessInput,
    content: string,
    block: TaskRootBlock,
    indexedRevision: string,
  ): RecurrenceLocation {
    const relativeLine = confirmedTargetRelativeLine(input.request.target, block);
    const current = this.snapshotFor_abyssPrivate(input.rootRef.filePath, content, block);
    const owner =
      relativeLine === undefined || current == null
        ? undefined
        : nodeSnapshot(current, input.request.target);
    if (relativeLine === undefined || current == null || owner == null) {
      const result =
        current != null
          ? { type: 'conflict' as const, current }
          : { type: 'not-found' as const, target: input.request.target };
      return { type: 'result', result };
    }
    return { type: 'ready', block, current, owner, relativeLine, indexedRevision };
  }

  private commitRecurrenceCandidate_abyssPrivate(
    input: RecurrenceCandidateCommitInput,
    transaction: RecurrenceTransaction,
  ): string {
    const { process, location, prepared, unchangedContent } = input;
    const coordinates = this.recurrenceCoordinates_abyssPrivate(
      process.request,
      location,
      prepared,
    );
    if (
      !this.stageRecurrence_abyssPrivate({ process, location, prepared, coordinates }, transaction)
    ) {
      return input.unchangedContent;
    }
    const outcome = this.recurrenceOutcome_abyssPrivate(
      process.rootRef.filePath,
      prepared,
      coordinates,
    );
    if (outcome === undefined) {
      this.abortRecurrenceTransition_abyssPrivate(transaction);
      transaction.result = invalidRecurrence('invalid-task-syntax');
      return unchangedContent;
    }
    transaction.result = outcome;
    transaction.committedContent = prepared.candidate;
    return prepared.candidate;
  }

  private recurrenceCoordinates_abyssPrivate(
    request: RecurrenceCompletionRequest,
    location: ReadyRecurrenceLocation,
    prepared: PreparedRecurrence,
  ): RecurrenceCoordinates {
    const nested = request.target.type === 'subtask';
    return {
      active: occurrenceCoordinates(
        location.block.line,
        location.relativeLine,
        prepared.cleanOffset,
        nested,
      ),
      completed: occurrenceCoordinates(
        location.block.line,
        location.relativeLine,
        prepared.completedOffset,
        nested,
      ),
    };
  }

  private stageRecurrence_abyssPrivate(
    input: RecurrenceStageInput,
    transaction: RecurrenceTransaction,
  ): boolean {
    const { process, location, prepared, coordinates } = input;
    const authority = this.options_abyssPrivate.refAuthority;
    if (authority == null || this.options_abyssPrivate.snapshotState == null) return true;
    const staged = stageRootTransition({
      authority,
      editor: this.options_abyssPrivate.editor,
      filePath: process.rootRef.filePath,
      candidate: prepared.candidate,
      expectedRevision: process.rootRef.revision,
      currentRevision: location.indexedRevision,
      rootLines: [
        coordinates.active.rootLine,
        ...(!prepared.deletesCompleted ? [coordinates.completed.rootLine] : []),
      ],
    });
    if (staged.type === 'staged') {
      transaction.transitionToken = staged.token;
      this.retainRollbackBasis_abyssPrivate(transaction);
      return true;
    }
    transaction.result =
      staged.type === 'invalid'
        ? invalidRecurrence('invalid-task-syntax')
        : { type: 'conflict', current: location.current };
    return false;
  }

  private recurrenceOutcome_abyssPrivate(
    path: string,
    prepared: PreparedRecurrence,
    coordinates: RecurrenceCoordinates,
  ): TaskRepositoryResult | undefined {
    const snapshots =
      this.options_abyssPrivate.snapshotState?.previewContent(path, prepared.candidate) ??
      this.options_abyssPrivate.snapshotsFromContent(path, prepared.candidate);
    const active = occurrenceAt(
      snapshots,
      coordinates.active.rootLine,
      coordinates.active.targetRelativeLine,
    );
    const completed = prepared.deletesCompleted
      ? undefined
      : occurrenceAt(
          snapshots,
          coordinates.completed.rootLine,
          coordinates.completed.targetRelativeLine,
        );
    if (active == null || (!prepared.deletesCompleted && completed == null)) return undefined;
    return {
      type: 'committed',
      outcome: { type: 'recurrence', active, ...(completed !== undefined && { completed }) },
      changed: true,
    };
  }

  private abortRecurrenceTransition_abyssPrivate(transaction: RecurrenceTransaction): void {
    if (transaction.transitionToken != null) {
      this.options_abyssPrivate.refAuthority?.abort(transaction.transitionToken);
    }
    transaction.transitionToken = undefined;
  }

  private commitRecurrence_abyssPrivate(
    input: RecurrenceProcessInput,
    transaction: RecurrenceTransaction,
  ): void {
    const token = transaction.transitionToken;
    const content = transaction.committedContent;
    if (token === undefined || content === undefined || content.length === 0) return;
    this.options_abyssPrivate.refAuthority?.commit(token);
    this.options_abyssPrivate.snapshotState?.installCommittedContent(
      input.rootRef.filePath,
      content,
    );
    this.options_abyssPrivate.refAuthority?.acknowledge(input.rootRef.filePath, content);
  }

  async edit(request: TaskEditRequest | TaskEditCommand): Promise<TaskRepositoryResult> {
    const prepared = 'command' in request ? request : undefined;
    const command: TaskEditCommand = 'command' in request ? request.command : request;
    const metadataIssues = [
      ...dependencyMetadataIssues(command),
      ...subtaskRestorationIssues(command),
    ];
    if (metadataIssues.length > 0) return { type: 'invalid', issues: metadataIssues };
    const reorderIssue = this.reorderParentIssue_abyssPrivate(command);
    if (reorderIssue !== undefined) return reorderIssue;
    const rootRef = rootRefForCommand(command);
    const input: EditProcessInput = { prepared, command, rootRef };
    return this.processEdit_abyssPrivate(input, (transaction, content) =>
      this.editContent_abyssPrivate(input, transaction, content),
    );
  }

  private async processEdit_abyssPrivate(
    input: EditProcessInput,
    transform: (transaction: EditTransaction, content: string) => string,
  ): Promise<TaskRepositoryResult> {
    const { rootRef, command } = input;
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(rootRef.filePath);
    if (!(file instanceof TFile)) {
      return { type: 'not-found', target: mutationTarget(command) };
    }
    const transaction: EditTransaction = {
      result: undefined,
      transitionToken: undefined,
      committedContent: undefined,
    };
    try {
      await this.processFile_abyssPrivate(file, (content) => transform(transaction, content));
    } catch {
      await this.rejectMutation_abyssPrivate(file, rootRef, transaction);
      return this.processError_abyssPrivate(rootRef.filePath);
    }
    this.commitEdit_abyssPrivate(rootRef.filePath, transaction);
    return transaction.result ?? this.processError_abyssPrivate(rootRef.filePath);
  }

  async editBatch(request: TaskEditBatchRequest): Promise<TaskRepositoryResult> {
    const issues = taskEditBatchIssues(request);
    if (issues.length > 0) return { type: 'invalid', issues };
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(request.filePath);
    if (!(file instanceof TFile)) return { type: 'not-found', target: request.outcomeTarget };
    const transaction: EditTransaction = {
      result: undefined,
      transitionToken: undefined,
      committedContent: undefined,
    };
    try {
      await this.processFile_abyssPrivate(file, (content) =>
        this.editBatchContent_abyssPrivate(request, transaction, content),
      );
    } catch {
      await this.rejectBatch_abyssPrivate(file, request, transaction);
      return this.processError_abyssPrivate(request.filePath);
    }
    this.commitEdit_abyssPrivate(request.filePath, transaction);
    return transaction.result ?? this.processError_abyssPrivate(request.filePath);
  }

  async createDependencySubtask(
    request: CreateDependencySubtaskRequest,
  ): Promise<TaskRepositoryResult> {
    const resolution = dependencySubtaskResolutionRequest(request);
    if (resolution === undefined)
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] };
    const rootRef = request.baseRoot.ref;
    const input = { prepared: resolution, command: resolution.command, rootRef };
    let prepared: PreparedDependencySubtask | undefined;
    const result = await this.processEdit_abyssPrivate(input, (transaction, content) => {
      const location = this.resolveEditLocation_abyssPrivate(input, content);
      if (location.type === 'result') {
        transaction.result = location.result;
        return content;
      }
      const candidate = prepareDependencySubtask(
        request,
        content,
        location.block,
        this.options_abyssPrivate,
      );
      if (candidate.type !== 'prepared') {
        transaction.result = candidate;
        return content;
      }
      prepared = candidate;
      return this.stagePreparedRoots_abyssPrivate(
        rootRef.filePath,
        candidate,
        transaction,
        content,
      );
    });
    return finishDependencySubtask(
      request,
      prepared,
      result,
      this.options_abyssPrivate.snapshotState === undefined
        ? this.options_abyssPrivate.snapshotsFromContent
        : undefined,
    );
  }

  private stagePreparedRoots_abyssPrivate(
    path: string,
    prepared: PreparedTaskEditBatch,
    transaction: EditTransaction,
    content: string,
  ): string {
    transaction.result = {
      type: 'committed',
      outcome: { type: 'task', task: prepared.outcomeRoot },
      changed: prepared.content !== content,
    };
    if (prepared.content === content) return content;
    transaction.rollbackBasis = this.captureRollbackBasis_abyssPrivate(path, content);
    const staged = stageTaskEditBatch(
      path,
      prepared,
      this.options_abyssPrivate.refAuthority,
      this.options_abyssPrivate.snapshotState,
    );
    if (staged.type !== 'staged') {
      transaction.result = staged;
      return content;
    }
    transaction.transitionToken = staged.token;
    transaction.committedContent = prepared.content;
    this.retainRollbackBasis_abyssPrivate(transaction);
    return prepared.content;
  }

  private editBatchContent_abyssPrivate(
    request: TaskEditBatchRequest,
    transaction: EditTransaction,
    content: string,
  ): string {
    const prepared = prepareTaskEditBatch(request, content, {
      ...this.options_abyssPrivate,
      resolve: (edit) =>
        this.resolveEditLocation_abyssPrivate(
          { prepared: edit, command: edit.command, rootRef: edit.baseRoot.ref },
          content,
        ),
    });
    if (prepared.type !== 'prepared') {
      transaction.result = prepared;
      return content;
    }
    return this.stagePreparedRoots_abyssPrivate(request.filePath, prepared, transaction, content);
  }

  private async rejectBatch_abyssPrivate(
    file: TFile,
    request: TaskEditBatchRequest,
    transaction: EditTransaction,
  ): Promise<void> {
    if (transaction.transitionToken === undefined) return;
    try {
      const content = await this.app_abyssPrivate.vault.read(file);
      this.restoreOwnedTransition_abyssPrivate(
        request.filePath,
        content,
        transaction.transitionToken,
      );
    } catch {
      // The I/O result records that final content state is unknown.
    } finally {
      this.options_abyssPrivate.refAuthority?.abort(transaction.transitionToken);
      for (const { baseRoot } of request.edits)
        this.options_abyssPrivate.snapshotState?.discardAuthoritySuccessor?.(baseRoot.ref);
    }
  }

  private reorderParentIssue_abyssPrivate(
    command: TaskEditCommand,
  ): TaskRepositoryResult | undefined {
    if (command.type !== 'reorder-subtask') return undefined;
    if (sameTaskNodeRef(command.subtask.parent, command.target.parent)) return undefined;
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask-parent' }] };
  }

  private editContent_abyssPrivate(
    input: EditProcessInput,
    transaction: EditTransaction,
    content: string,
  ): string {
    const location = this.resolveEditLocation_abyssPrivate(input, content);
    if (location.type === 'result') {
      transaction.result = location.result;
      return content;
    }
    transaction.rollbackBasis = this.captureRollbackBasis_abyssPrivate(
      input.rootRef.filePath,
      content,
    );
    const edit = this.applyLocatedEdit_abyssPrivate(input, content, location.block);
    transaction.result = edit.result;
    if (edit.result.type !== 'committed' || !edit.result.changed) return edit.content;
    transaction.committedContent = edit.content;
    return this.stageEditTransition_abyssPrivate(
      { process: input, location, edit, originalContent: content },
      transaction,
    );
  }

  private resolveEditLocation_abyssPrivate(input: EditProcessInput, content: string): EditLocation {
    const { rootRef } = input;
    const blocks = this.options_abyssPrivate.editor.rootBlocks(content);
    const evidence = this.options_abyssPrivate.refAuthority?.evidence(rootRef.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.options_abyssPrivate.snapshotState?.currentRoot(
            rootRef.filePath,
            rootRef.line,
            evidence.source,
            blocks.filter((block) => block.source === evidence.source).map((block) => block.line),
          );
    const located = this.options_abyssPrivate.locator.locate(blocks, rootRef, indexedRef);
    if (
      hasUnconfirmedCurrentRoot(
        this.options_abyssPrivate.snapshotState,
        rootRef,
        evidence,
        indexedRef,
      )
    )
      return { type: 'result', result: this.editResolution_abyssPrivate(input, located, content) };
    const revision = preparedRevisionResult({
      prepared: input.prepared,
      located,
      authorityCurrent: this.options_abyssPrivate.snapshotState?.authoritySuccessor?.(rootRef),
      locateAuthorityCurrent: (currentRef) =>
        this.options_abyssPrivate.locator.locate(blocks, currentRef),
      snapshot: (block) => this.snapshotFor_abyssPrivate(rootRef.filePath, content, block),
    });
    if (revision != null) return { type: 'result', result: revision };
    return this.resolveLocatedEdit_abyssPrivate(input, content, located, indexedRef?.revision);
  }

  private resolveLocatedEdit_abyssPrivate(
    input: EditProcessInput,
    content: string,
    located: LocateResult,
    indexedRevision: string | undefined,
  ): EditLocation {
    const stale = authorityRevisionChanged(
      this.options_abyssPrivate.refAuthority !== undefined,
      this.options_abyssPrivate.snapshotState !== undefined,
      indexedRevision === undefined ? undefined : { ...input.rootRef, revision: indexedRevision },
      input.rootRef.revision,
    );
    if (stale || located.type !== 'exact') {
      return {
        type: 'result',
        result: this.editResolution_abyssPrivate(input, located, content),
      };
    }
    return { type: 'ready', block: located.block, indexedRevision: indexedRevision ?? '' };
  }

  private editResolution_abyssPrivate(
    input: EditProcessInput,
    located: LocateResult,
    content: string,
  ): TaskRepositoryResult {
    if (located.type !== 'exact') {
      return this.resolutionResult_abyssPrivate(
        located,
        input.command,
        input.rootRef.filePath,
        content,
      );
    }
    const current = this.snapshotFor_abyssPrivate(input.rootRef.filePath, content, located.block);
    return current != null
      ? { type: 'conflict', current }
      : { type: 'not-found', target: mutationTarget(input.command) };
  }

  private applyLocatedEdit_abyssPrivate(
    input: EditProcessInput,
    content: string,
    block: TaskRootBlock,
  ): EditOutcome {
    if (input.command.type === 'delete')
      return this.deleteRootEdit_abyssPrivate(input, content, block);
    const nodeTarget = nodeTargetOf(input.command);
    const relativeLine = nodeTarget != null ? confirmedTargetRelativeLine(nodeTarget, block) : 0;
    if (relativeLine === undefined)
      return this.relativeLineConflict_abyssPrivate(input, content, block);
    const located: LocatedEditInput = {
      process: input,
      content,
      block,
      relativeLine,
      nodeTarget,
    };
    const completionDelete = this.deleteOnCompletion_abyssPrivate(located);
    if (completionDelete !== undefined) return completionDelete;
    if (isStructuralCommand(input.command))
      return this.editStructural_abyssPrivate(located, input.command);
    if (input.command.type === 'edit-link' && input.command.target.type !== 'title') {
      return this.editTextTarget_abyssPrivate(located, input.command);
    }
    return this.editOrdinaryLine_abyssPrivate(located);
  }

  private deleteRootEdit_abyssPrivate(
    input: EditProcessInput,
    content: string,
    block: TaskRootBlock,
  ): EditOutcome {
    const current = this.snapshotFor_abyssPrivate(input.rootRef.filePath, content, block);
    const next = this.options_abyssPrivate.editor.deleteRoot(content, block);
    if (current == null || next === undefined) {
      return { result: { type: 'not-found', target: mutationTarget(input.command) }, content };
    }
    return {
      result: { type: 'committed', outcome: { type: 'deleted', ref: current.ref }, changed: true },
      content: next,
    };
  }

  private relativeLineConflict_abyssPrivate(
    input: EditProcessInput,
    content: string,
    block: TaskRootBlock,
  ): EditOutcome {
    const current = this.snapshotFor_abyssPrivate(input.rootRef.filePath, content, block);
    const result =
      current != null
        ? { type: 'conflict' as const, current }
        : { type: 'not-found' as const, target: mutationTarget(input.command) };
    return { result, content };
  }

  private editOrdinaryLine_abyssPrivate(input: LocatedEditInput): EditOutcome {
    const { process, content, block, relativeLine } = input;
    const sourceLine = content.split(/\r?\n/u)[block.line + relativeLine];
    if (
      sourceLine === undefined ||
      this.options_abyssPrivate.codec.parseLine(sourceLine, { filePath: '', line: 0 }) == null
    ) {
      return { result: { type: 'not-found', target: mutationTarget(process.command) }, content };
    }
    const edit = applyTaskCommand(this.options_abyssPrivate.codec, sourceLine, process.command);
    if (edit.type === 'invalid') return { result: edit, content };
    if (edit.type === 'unchanged') return this.unchangedLineEdit_abyssPrivate(input);
    const replaced = this.options_abyssPrivate.editor.replaceLine(
      content,
      block,
      relativeLine,
      edit.content,
    );
    const task = this.snapshotFor_abyssPrivate(
      process.rootRef.filePath,
      replaced.content,
      replaced.block,
    );
    return task == null
      ? { result: { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] }, content }
      : {
          result: { type: 'committed', outcome: { type: 'task', task }, changed: true },
          content: replaced.content,
        };
  }

  private unchangedLineEdit_abyssPrivate(input: LocatedEditInput): EditOutcome {
    const task = this.snapshotFor_abyssPrivate(
      input.process.rootRef.filePath,
      input.content,
      input.block,
    );
    const result =
      task != null
        ? { type: 'committed' as const, outcome: { type: 'task' as const, task }, changed: false }
        : { type: 'not-found' as const, target: mutationTarget(input.process.command) };
    return { result, content: input.content };
  }

  private stageEditTransition_abyssPrivate(
    input: EditStageInput,
    transaction: EditTransaction,
  ): string {
    const { process, location, edit, originalContent } = input;
    if (edit.result.type !== 'committed') return edit.content;
    if (edit.result.outcome.type === 'deleted')
      return this.stageDeletedEdit_abyssPrivate(input, transaction);
    if (edit.result.outcome.type !== 'task') return edit.content;
    const authority = this.options_abyssPrivate.refAuthority;
    const snapshotState = this.options_abyssPrivate.snapshotState;
    if (authority == null || snapshotState == null) return edit.content;
    const taskLine = edit.result.outcome.task.source.line;
    const surviving = this.options_abyssPrivate.editor
      .rootBlocks(edit.content)
      .find((root) => root.line === taskLine);
    if (surviving === undefined) {
      this.invalidateStagedEdit_abyssPrivate(transaction);
      return originalContent;
    }
    return this.stageSurvivingEdit_abyssPrivate(
      { process, indexedRevision: location.indexedRevision, edit, originalContent, surviving },
      transaction,
    );
  }

  private invalidateStagedEdit_abyssPrivate(transaction: EditTransaction): void {
    transaction.result = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    transaction.committedContent = undefined;
  }

  private stageSurvivingEdit_abyssPrivate(
    input: SurvivingEditStageInput,
    transaction: EditTransaction,
  ): string {
    const { process, indexedRevision, edit, originalContent, surviving } = input;
    const authority = this.options_abyssPrivate.refAuthority;
    if (authority == null) return edit.content;
    const revision = authority.successor(process.rootRef.revision, surviving.source);
    if (revision === undefined || revision.length === 0) {
      this.invalidateStagedEdit_abyssPrivate(transaction);
      return originalContent;
    }
    const staged = authority.stage(
      {
        filePath: process.rootRef.filePath,
        candidateFingerprint: taskRefContentFingerprint(edit.content),
        candidateLength: edit.content.length,
        expectedRevision: process.rootRef.revision,
        roots: [{ line: surviving.line, source: surviving.source, revision }],
      },
      indexedRevision,
    );
    if (staged.type === 'conflict') {
      transaction.result = this.stagedEditConflict_abyssPrivate(process, originalContent);
      transaction.committedContent = undefined;
      return originalContent;
    }
    transaction.transitionToken = staged.token;
    this.retainRollbackBasis_abyssPrivate(transaction);
    return edit.content;
  }

  private stageDeletedEdit_abyssPrivate(
    input: EditStageInput,
    transaction: EditTransaction,
  ): string {
    const authority = this.options_abyssPrivate.refAuthority;
    if (authority === undefined || this.options_abyssPrivate.snapshotState === undefined)
      return input.edit.content;
    const staged = authority.stage(
      {
        filePath: input.process.rootRef.filePath,
        candidateFingerprint: taskRefContentFingerprint(input.edit.content),
        candidateLength: input.edit.content.length,
        expectedRevision: input.process.rootRef.revision,
        roots: [],
      },
      input.location.indexedRevision,
    );
    if (staged.type !== 'staged') {
      transaction.result = this.stagedEditConflict_abyssPrivate(
        input.process,
        input.originalContent,
      );
      transaction.committedContent = undefined;
      return input.originalContent;
    }
    transaction.transitionToken = staged.token;
    this.retainRollbackBasis_abyssPrivate(transaction);
    return input.edit.content;
  }

  private stagedEditConflict_abyssPrivate(
    input: EditProcessInput,
    content: string,
  ): TaskRepositoryResult {
    const current = this.options_abyssPrivate.snapshotState
      ?.previewContent(input.rootRef.filePath, content)
      .find((task) => task.ref.revision === input.rootRef.revision);
    return current != null
      ? { type: 'conflict', current }
      : { type: 'not-found', target: mutationTarget(input.command) };
  }

  private async rejectMutation_abyssPrivate(
    file: TFile,
    rootRef: TaskRef,
    transaction: Pick<EditTransaction, 'transitionToken' | 'committedContent' | 'rollbackBasis'>,
  ): Promise<void> {
    if (transaction.transitionToken != null) {
      await this.abortAndReconcileTransition_abyssPrivate(
        file,
        rootRef.filePath,
        transaction.transitionToken,
        rootRef,
      );
    } else if (transaction.committedContent !== undefined) {
      await this.reconcileRejectedDeletion_abyssPrivate(file, rootRef.filePath, rootRef);
    }
  }

  private commitEdit_abyssPrivate(path: string, transaction: EditTransaction): void {
    const result = transaction.result;
    const content = transaction.committedContent;
    if (result?.type !== 'committed' || !result.changed || content === undefined) return;
    const token = transaction.transitionToken;
    if (token != null) this.options_abyssPrivate.refAuthority?.commit(token);
    const installed = this.options_abyssPrivate.snapshotState?.installCommittedContent(
      path,
      content,
    );
    if (token != null) this.options_abyssPrivate.refAuthority?.acknowledge(path, content);
    transaction.result = this.rebaseEditResult_abyssPrivate(result, installed);
  }

  private rebaseEditResult_abyssPrivate(
    result: Extract<TaskRepositoryResult, { readonly type: 'committed' }>,
    installed: readonly TaskSnapshot[] | undefined,
  ): TaskRepositoryResult {
    if (result.outcome.type !== 'task' || installed == null) return result;
    const line = result.outcome.task.source.line;
    const rebased = installed.find((candidate) => candidate.source.line === line);
    if (rebased == null) return result;
    const recovery = result.outcome.subtaskRemovalRecovery;
    return {
      ...result,
      outcome:
        recovery === undefined
          ? { type: 'task', task: rebased }
          : withSubtaskRemovalRecovery(rebased, recovery),
    };
  }

  private editStructural_abyssPrivate(
    input: LocatedEditInput,
    command: StructuralTaskEditCommand,
  ): EditOutcome {
    const { content, block, relativeLine, nodeTarget } = input;
    const current = this.snapshotFor_abyssPrivate(input.process.rootRef.filePath, content, block);
    const node =
      current != null && nodeTarget != null ? nodeSnapshot(current, nodeTarget) : undefined;
    if (current == null || node == null) {
      return {
        result:
          current != null
            ? { type: 'conflict', current }
            : { type: 'not-found', target: mutationTarget(command) },
        content,
      };
    }
    if (this.structuralOwnershipConflict_abyssPrivate(command, node)) {
      return { result: { type: 'conflict', current }, content };
    }
    const prepared = this.prepareStructuralCommand_abyssPrivate(command, content);
    if ('result' in prepared) return prepared;
    const edited = this.options_abyssPrivate.editor.edit(
      content,
      block,
      blockTarget(node, block, relativeLine),
      structuralEdit(prepared),
    );
    const outcome = this.structuralEditOutcome_abyssPrivate(
      input.process.rootRef.filePath,
      content,
      current,
      edited,
    );
    return { ...outcome, result: recoverSubtaskRemoval(command, edited, outcome.result) };
  }

  private structuralOwnershipConflict_abyssPrivate(
    command: StructuralTaskEditCommand,
    node: TaskSnapshot | SubtaskSnapshot,
  ): boolean {
    if (command.type === 'restore-subtask') return !subtaskRestorationGapIsCurrent(command, node);
    if (command.type === 'update-comment' || command.type === 'delete-comment') {
      return !ownsComment(node, command.comment);
    }
    if (command.type === 'delete-subtask') return !ownsSubtask(node, command.subtask);
    if (command.type === 'reorder-subtask') {
      return !ownsSubtask(node, command.subtask) || !ownsSubtask(node, command.target);
    }
    return false;
  }

  private prepareStructuralCommand_abyssPrivate(
    command: StructuralTaskEditCommand,
    content: string,
  ): StructuralTaskEditCommand | EditOutcome {
    if (command.type !== 'add-subtask') return command;
    if (command.text.trim().length === 0 || /[\r\n]/u.test(command.text)) {
      return this.invalidSubtask_abyssPrivate(content);
    }
    const today = (command as unknown as { readonly today?: LocalDate }).today;
    if (today === undefined) return this.invalidSubtask_abyssPrivate(content);
    const created = createTaskBlock(this.options_abyssPrivate.codec, {
      markdownBody: command.text,
      today,
      addCreatedDate: command.addCreatedDate,
    });
    return created.type === 'invalid'
      ? { result: created, content }
      : { ...command, text: created.content.slice('- [ ] '.length) };
  }

  private invalidSubtask_abyssPrivate(content: string): EditOutcome {
    return {
      result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] },
      content,
    };
  }

  private structuralEditOutcome_abyssPrivate(
    path: string,
    content: string,
    current: TaskSnapshot,
    edited: ReturnType<TaskBlockEditor['edit']>,
  ): EditOutcome {
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
    const task = this.snapshotFor_abyssPrivate(path, edited.content, edited.block);
    return task != null
      ? {
          result: { type: 'committed', outcome: { type: 'task', task }, changed: true },
          content: edited.content,
        }
      : {
          result: { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] },
          content,
        };
  }

  private deleteOnCompletion_abyssPrivate(input: LocatedEditInput): EditOutcome | undefined {
    const { command } = input.process;
    if (command.type !== 'set-status') return undefined;
    const target = input.nodeTarget;
    if (target === undefined || !this.isDeleteCompletionStatus_abyssPrivate(command))
      return undefined;
    return this.deleteOnCompletionForTarget_abyssPrivate(input, target);
  }

  private isDeleteCompletionStatus_abyssPrivate(
    command: Extract<TaskEditCommand, { readonly type: 'set-status' }>,
  ): boolean {
    return (
      command.stamp !== undefined &&
      this.options_abyssPrivate.codec.statusForSymbol(command.symbol) === 'done'
    );
  }

  private deleteOnCompletionForTarget_abyssPrivate(
    input: LocatedEditInput,
    target: PlanningTarget,
  ): EditOutcome | undefined {
    const { content, block, relativeLine } = input;
    const path = input.process.rootRef.filePath;
    const current = this.snapshotFor_abyssPrivate(path, content, block);
    const owner = current === undefined ? undefined : nodeSnapshot(current, target);
    const parsed = this.parseCompletionLine_abyssPrivate(input, path);
    if (current == null || owner == null || parsed == null || owner.onCompletion !== 'delete') {
      return undefined;
    }
    const recurrenceDisposition = ordinaryDeleteRecurrenceDisposition(
      parsed,
      owner.recurrence,
      block.source,
      relativeLine,
    );
    if (recurrenceDisposition === 'defer') return undefined;
    if (recurrenceDisposition === 'invalid') {
      return { result: invalidRecurrence('nested-recurrence-conflict'), content };
    }
    return target.type === 'task'
      ? this.deleteCompletedRoot_abyssPrivate(content, block, current)
      : this.deleteCompletedSubtask_abyssPrivate(path, content, block, relativeLine);
  }

  private parseCompletionLine_abyssPrivate(
    input: LocatedEditInput,
    path: string,
  ): ReturnType<TaskMarkdownCodec['parseLine']> {
    const line = input.block.line + input.relativeLine;
    const source = input.content.split(/\r?\n/u)[line];
    return source === undefined
      ? null
      : this.options_abyssPrivate.codec.parseLine(source, { filePath: path, line });
  }

  private deleteCompletedRoot_abyssPrivate(
    content: string,
    block: TaskRootBlock,
    current: TaskSnapshot,
  ): EditOutcome {
    const next = this.options_abyssPrivate.editor.deleteRoot(content, block);
    return next === undefined
      ? { result: invalidRecurrence('invalid-task-syntax'), content }
      : {
          result: {
            type: 'committed',
            outcome: { type: 'deleted', ref: current.ref },
            changed: true,
          },
          content: next,
        };
  }

  private deleteCompletedSubtask_abyssPrivate(
    path: string,
    content: string,
    block: TaskRootBlock,
    relativeLine: number,
  ): EditOutcome {
    const next = this.options_abyssPrivate.editor.replaceOwnedTaskSubtree(
      content,
      block,
      relativeLine,
      [],
    );
    if (next === undefined) {
      return { result: invalidRecurrence('invalid-task-syntax'), content };
    }
    const updatedBlock = this.options_abyssPrivate.editor
      .rootBlocks(next)
      .find((candidate) => candidate.line === block.line);
    const root =
      updatedBlock === undefined
        ? undefined
        : this.snapshotFor_abyssPrivate(path, next, updatedBlock);
    if (root === undefined) {
      return { result: invalidRecurrence('invalid-task-syntax'), content };
    }
    return {
      result: { type: 'committed', outcome: { type: 'task', task: root }, changed: true },
      content: next,
    };
  }

  private async processFile_abyssPrivate(
    file: TFile,
    transform: (content: string) => string,
  ): Promise<void> {
    await this.app_abyssPrivate.vault.process(file, transform);
  }

  private editTextTarget_abyssPrivate(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
  ): EditOutcome {
    const { content, block, nodeTarget } = input;
    const path = input.process.rootRef.filePath;
    const current = this.snapshotFor_abyssPrivate(path, content, block);
    const targetNode = optionalNodeSnapshot(current, nodeTarget);
    if (current == null || targetNode == null) {
      return {
        result:
          current != null
            ? { type: 'conflict', current }
            : { type: 'not-found', target: mutationTarget(command) },
        content,
      };
    }
    const lines = content.split(/\r?\n/u);
    const target = this.resolveTextEditTarget_abyssPrivate(input, command, targetNode, lines);
    if (target.type === 'conflict') return { result: { type: 'conflict', current }, content };
    if (target.type === 'invalid') {
      return {
        result: { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] },
        content,
      };
    }
    return this.applyTextEdit_abyssPrivate(input, command, current, target);
  }

  private applyTextEdit_abyssPrivate(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
    current: TaskSnapshot,
    target: Extract<TextEditTarget, { readonly type: 'ready' }>,
  ): EditOutcome {
    const { content, block } = input;
    const source = content.split(/\r?\n/u)[block.line + target.relativeLine] ?? '';
    const editResult = this.options_abyssPrivate.codec.editTextLink(
      source,
      target.occurrence,
      command.replacement,
    );
    if (editResult.type === 'invalid') return { result: editResult, content };
    if (editResult.type === 'unchanged') {
      return {
        result: { type: 'committed', outcome: { type: 'task', task: current }, changed: false },
        content,
      };
    }
    const replaced = this.options_abyssPrivate.editor.replaceLine(
      content,
      block,
      target.relativeLine,
      editResult.content,
    );
    const task = this.snapshotFor_abyssPrivate(
      input.process.rootRef.filePath,
      replaced.content,
      replaced.block,
    );
    return task != null
      ? {
          result: { type: 'committed', outcome: { type: 'task', task }, changed: true },
          content: replaced.content,
        }
      : {
          result: { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] },
          content,
        };
  }

  private resolveTextEditTarget_abyssPrivate(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
    node: TaskSnapshot | SubtaskSnapshot,
    lines: readonly string[],
  ): TextEditTarget {
    if (command.target.type === 'comment') {
      const relativeLine = commentRelativeLine(
        input.relativeLine,
        command.target.ref,
        lines,
        input.block.line,
      );
      return relativeLine === undefined
        ? { type: 'conflict' }
        : { type: 'ready', relativeLine, occurrence: command.occurrence };
    }
    if (command.target.type !== 'description') return { type: 'invalid' };
    return this.descriptionLinkTarget_abyssPrivate(input, command.occurrence, node, lines);
  }

  private descriptionLinkTarget_abyssPrivate(
    input: LocatedEditInput,
    initialOccurrence: number,
    node: TaskSnapshot | SubtaskSnapshot,
    lines: readonly string[],
  ): Extract<TextEditTarget, { readonly type: 'ready' | 'invalid' }> {
    let occurrence = initialOccurrence;
    const candidates = this.options_abyssPrivate.editor.descriptionLines(
      input.content,
      input.block,
      blockTarget(node, input.block, input.relativeLine),
    );
    for (const relativeLine of candidates) {
      const count = parseLinks(lines[input.block.line + relativeLine] ?? '').length;
      if (occurrence < count) return { type: 'ready', relativeLine, occurrence };
      occurrence -= count;
    }
    return { type: 'invalid' };
  }

  private snapshotFor_abyssPrivate(
    path: string,
    content: string,
    block: TaskRootBlock,
  ): TaskSnapshot | undefined {
    const snapshot = (
      this.options_abyssPrivate.snapshotState?.previewContent(path, content) ??
      this.options_abyssPrivate.snapshotsFromContent(path, content)
    ).find((candidate) => candidate.source.line === block.line);
    if (snapshot == null) return undefined;
    if (this.options_abyssPrivate.snapshotState != null) return snapshot;
    const ref: TaskRef = {
      filePath: path,
      line: block.line,
      revision: this.options_abyssPrivate.locator.revision(block.source),
    };
    return rebaseSnapshot(snapshot, ref);
  }

  private candidateFor_abyssPrivate(
    block: TaskRootBlock,
    command: TaskEditCommand,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshotFor_abyssPrivate(path, content, block);
    if (root == null) return undefined;
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

  private candidateForTarget_abyssPrivate(
    block: TaskRootBlock,
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshotFor_abyssPrivate(path, content, block);
    return root != null ? { root, target: rebaseNode(target, root.ref) } : undefined;
  }

  private resolutionResultForTarget_abyssPrivate(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') return { type: 'not-found', target };
    if (located.type === 'conflict') {
      const current = this.snapshotFor_abyssPrivate(path, content, located.block);
      return current != null ? { type: 'conflict', current } : { type: 'not-found', target };
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateForTarget_abyssPrivate(block, target, path, content);
      return candidate != null ? [candidate] : [];
    });
    return candidates.length > 0
      ? { type: 'ambiguous', candidates }
      : { type: 'not-found', target };
  }

  private resolutionResult_abyssPrivate(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    command: TaskEditCommand,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') {
      return { type: 'not-found', target: mutationTarget(command) };
    }
    if (located.type === 'conflict') {
      const current = this.snapshotFor_abyssPrivate(path, content, located.block);
      return current != null
        ? { type: 'conflict', current }
        : { type: 'not-found', target: mutationTarget(command) };
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateFor_abyssPrivate(block, command, path, content);
      return candidate != null ? [candidate] : [];
    });
    return candidates.length > 0
      ? { type: 'ambiguous', candidates }
      : { type: 'not-found', target: mutationTarget(command) };
  }

  private resolutionResultForRef_abyssPrivate(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    ref: TaskRef,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') {
      return { type: 'not-found', target: { type: 'task', ref } };
    }
    if (located.type === 'conflict') {
      const current = this.snapshotFor_abyssPrivate(ref.filePath, content, located.block);
      return current != null
        ? { type: 'conflict', current }
        : { type: 'not-found', target: { type: 'task', ref } };
    }
    return {
      type: 'ambiguous',
      candidates: located.blocks.flatMap((block) => {
        const root = this.snapshotFor_abyssPrivate(ref.filePath, content, block);
        return root != null ? [{ root, target: { type: 'task' as const, ref: root.ref } }] : [];
      }),
    };
  }

  private partialMove_abyssPrivate(
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

  private async reconcileAfterRejection_abyssPrivate(file: TFile, path: string): Promise<void> {
    if (this.options_abyssPrivate.snapshotState == null) return;
    try {
      const authoritative = await this.app_abyssPrivate.vault.read(file);
      this.options_abyssPrivate.snapshotState.installCommittedContent(path, authoritative);
    } catch {
      // The caller's failure result records that the authoritative content is unknown.
    }
  }

  private async abortAndReconcileTransition_abyssPrivate(
    file: TFile,
    path: string,
    token: object,
    consumed: TaskRef,
  ): Promise<void> {
    const authority = this.options_abyssPrivate.refAuthority;
    if (authority == null || this.options_abyssPrivate.snapshotState == null) {
      authority?.abort(token);
      await this.reconcileAfterRejection_abyssPrivate(file, path);
      return;
    }

    let authoritative: string;
    try {
      authoritative = await this.app_abyssPrivate.vault.read(file);
    } catch {
      authority.abort(token);
      this.options_abyssPrivate.snapshotState.discardAuthoritySuccessor?.(consumed);
      return;
    }
    try {
      this.restoreOwnedTransition_abyssPrivate(path, authoritative, token);
    } finally {
      authority.abort(token);
      this.options_abyssPrivate.snapshotState.discardAuthoritySuccessor?.(consumed);
    }
  }

  private async reconcileRejectedDeletion_abyssPrivate(
    file: TFile,
    path: string,
    consumed: TaskRef,
  ): Promise<void> {
    try {
      const authoritative = await this.app_abyssPrivate.vault.read(file);
      this.installRejectedContent_abyssPrivate(path, authoritative, consumed);
    } catch {
      // The caller's failure result records that the authoritative content is unknown.
    }
  }

  private installRejectedContent_abyssPrivate(
    path: string,
    authoritative: string,
    consumed: TaskRef,
  ): void {
    const authority = this.options_abyssPrivate.refAuthority;
    const snapshotState = this.options_abyssPrivate.snapshotState;
    if (authority == null || snapshotState == null) {
      snapshotState?.installCommittedContent(path, authoritative);
      return;
    }

    const rollbackContext = this.rejectedRollbackContext_abyssPrivate(
      path,
      authoritative,
      consumed,
    );
    if (rollbackContext === undefined) {
      this.installContentSafely_abyssPrivate(snapshotState, path, authoritative);
      return;
    }
    const rollback = rollbackContext.authority.stage(
      {
        filePath: path,
        candidateFingerprint: taskRefContentFingerprint(authoritative),
        candidateLength: authoritative.length,
        expectedRevision: rollbackContext.expectedRevision,
        roots: [
          {
            line: rollbackContext.block.line,
            source: rollbackContext.block.source,
            revision: consumed.revision,
          },
        ],
      },
      rollbackContext.expectedRevision,
    );
    if (rollback.type === 'conflict') return;
    try {
      this.installContentSafely_abyssPrivate(rollbackContext.snapshotState, path, authoritative);
    } finally {
      rollbackContext.authority.abort(rollback.token);
    }
  }

  private rejectedRollbackContext_abyssPrivate(
    path: string,
    authoritative: string,
    consumed: TaskRef,
  ): RejectedRollbackContext | undefined {
    const authority = this.options_abyssPrivate.refAuthority;
    const snapshotState = this.options_abyssPrivate.snapshotState;
    if (authority == null || snapshotState == null) return undefined;
    const evidence = authority.evidence(consumed.revision);
    if (evidence === undefined) return undefined;
    const current = snapshotState.currentRoot(path, consumed.line, evidence.source);
    if (current?.revision === consumed.revision) return undefined;
    const located = this.options_abyssPrivate.locator.locate(
      this.options_abyssPrivate.editor.rootBlocks(authoritative),
      consumed,
    );
    if (located.type !== 'exact') return undefined;
    return {
      authority,
      snapshotState,
      block: located.block,
      expectedRevision: current?.revision ?? consumed.revision,
    };
  }

  private captureRollbackBasis_abyssPrivate(
    path: string,
    content: string,
  ): RollbackBasis | undefined {
    const authority = this.options_abyssPrivate.refAuthority;
    const state = this.options_abyssPrivate.snapshotState;
    if (authority === undefined || state === undefined) return undefined;
    const blocks = this.options_abyssPrivate.editor.rootBlocks(content);
    const roots: RootRevisionOverride[] = [];
    for (const block of blocks) {
      const population = blocks
        .filter((candidate) => candidate.source === block.source)
        .map(({ line }) => line);
      const current = state.currentRoot(path, block.line, block.source, population);
      if (
        current?.line !== block.line ||
        authority.evidence(current.revision)?.source !== block.source
      )
        return undefined;
      roots.push({ line: block.line, source: block.source, revision: current.revision });
    }
    return { content, roots };
  }

  private retainRollbackBasis_abyssPrivate(
    transaction: Pick<EditTransaction, 'transitionToken' | 'rollbackBasis'>,
  ): void {
    const { transitionToken, rollbackBasis } = transaction;
    if (transitionToken !== undefined && rollbackBasis !== undefined)
      this.options_abyssPrivate.refAuthority?.retainPredecessors(
        transitionToken,
        rollbackBasis.content,
        rollbackBasis.roots,
      );
  }

  private restoreOwnedTransition_abyssPrivate(path: string, content: string, token: object): void {
    const authority = this.options_abyssPrivate.refAuthority;
    const state = this.options_abyssPrivate.snapshotState;
    if (authority === undefined || state === undefined) return;
    // A late processor rejection may have persisted the candidate. Never compensate bytes or
    // transfer predecessor identities into a changed population, even if old source is now unique.
    const restoration = authority.stageRestoration(token, content);
    try {
      this.installContentSafely_abyssPrivate(state, path, content);
    } finally {
      if (restoration.type === 'staged') authority.abort(restoration.token);
    }
  }

  private installContentSafely_abyssPrivate(
    snapshotState: TaskSnapshotState | undefined,
    path: string,
    content: string,
  ): void {
    try {
      snapshotState?.installCommittedContent(path, content);
    } catch {
      // The caller's failure result records that the authoritative content is unknown.
    }
  }
}
