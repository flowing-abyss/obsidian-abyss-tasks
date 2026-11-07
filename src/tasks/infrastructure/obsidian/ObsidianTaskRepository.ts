import { TFile, type App } from 'obsidian';
import { sameNoteFileStamp } from '../../../markdown/noteFileStamp';
import { compileNotePathPattern } from '../../../markdown/notePathPattern';
import type { TaskQueryApi } from '../../application/TaskApplicationApi';
import type { TaskDiagnosticSink } from '../../application/TaskDependencyService';
import type {
  ProjectSourceReadApi,
  TaskIntegrationReadStateApi,
  TaskReadObservation,
} from '../../application/TaskIntegrationReadApi';
import {
  projectTaskFailure,
  type ProjectTaskDestination,
  type ProjectTaskGuard,
  type ProjectTaskResult,
  type ProjectTaskSource,
} from '../../application/TaskProjectCommands';
import type {
  PreparedTaskCreateGuard,
  TaskHierarchyRequest,
  TaskPreparedCreateRoot,
  TaskPreparedRootEdit,
} from '../../application/TaskRepository';
import {
  dependencyMetadataIssues,
  taskEditMutationTarget as mutationTarget,
  taskEditRootRef as rootRefForCommand,
  subtaskRestorationGapIsCurrent,
  subtaskRestorationIssues,
  type CreateDependencySubtaskRequest,
  type RecurrenceCompletionRequest,
  type RecurrenceCompletionRevisionRequest,
  type ReverseDependencyRequest,
  type RevisionPrecondition,
  type TaskDraft,
  type TaskEditBatchRequest,
  type TaskEditCommand,
  type TaskEditRequest,
  type TaskMoveRequest,
  type TaskRepository,
  type TaskRepositoryResult,
} from '../../application/TaskRepository';
import type { TaskStrictWriteContext } from '../../application/TaskStatusMutationApi';
import type {
  ArchiveRecovery,
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
import {
  taskNodeChain as childChain,
  taskNodeAtSourcePath as nodeSnapshot,
  rebaseTaskNode as rebaseNode,
  taskNodeRootRef as rootRefOf,
  taskMutationNodeRef,
} from '../../domain/taskCommandTargets';
import type { TaskOccurrenceAddress, TaskOccurrenceWitness } from '../../domain/taskOccurrence';
import type { CompletionTrackingWitness } from '../../domain/taskReconciliation';
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
  TimeEntryRef,
} from '../../domain/types';
import { sameTaskNodeRef } from '../../domain/types';
import {
  invalidTaskResult,
  invalidTaskSyntax,
  invalidTaskTarget,
  localDate,
} from '../../domain/validation';
import {
  dependencySubtaskResolutionRequest,
  finishDependencySubtask,
  prepareDependencySubtask,
  type PreparedDependencySubtask,
} from '../createDependencySubtask';
import { applyTaskCommand } from '../markdown/applyTaskCommand';
import { createTaskBlock } from '../markdown/createTaskBlock';
import {
  MarkdownTaskEditPreparation,
  unchangedPreparedContinuations,
} from '../markdown/MarkdownTaskEditPreparation';
import {
  recoverSubtaskRemoval,
  withSubtaskRemovalRecovery,
} from '../markdown/subtaskRemovalRecovery';
import type {
  DescriptionLinkTarget,
  TaskBlockEdit,
  TaskBlockTarget,
  TaskNodeLineMapping,
  TaskRootBlock,
} from '../markdown/TaskBlockEditor';
import { type TaskBlockEditor } from '../markdown/TaskBlockEditor';
import { parseMarkdownFrontmatter } from '../markdown/taskBlockSyntax';
import { type TaskLocator } from '../markdown/TaskLocator';
import { type TaskMarkdownCodec } from '../markdown/TaskMarkdownCodec';
import {
  recoverTimeEntryRemoval,
  withTimeEntryRemovalRecovery,
} from '../markdown/timeEntryRemovalRecovery';
import {
  preparedRevisionResult,
  strictStatusEffects,
  strictStatusPrecondition,
} from '../preparedRevisionResult';
import {
  prepareTaskEditBatch,
  stageTaskEditBatch,
  taskEditBatchIssues,
  type PreparedTaskEditBatch,
} from '../TaskEditBatch';
import {
  editedOccurrenceWitnesses,
  recurrenceOccurrenceWitnesses,
  removedSubtreeNodeMap,
} from '../taskOccurrenceEdits';
import {
  hasUnconfirmedCurrentRoot,
  taskRefContentFingerprint,
  type RootRevisionOverride,
  type TaskRefAuthority,
  type TaskRefStageResult,
  type TaskSnapshotState,
} from '../TaskRefAuthority';
import { ProjectRootPhase, type ProjectRootEdit } from './projectRootPhase';
import { reverseDependency } from './reverseDependency';
import { runTaskFileMutation } from './taskFileMutationQueue';
import { taskHierarchyTransaction } from './taskHierarchyTransaction';

type LocateResult = ReturnType<TaskLocator['locate']>;

function notFound(
  target: TaskMutationTarget,
): Extract<TaskRepositoryResult, { readonly type: 'not-found' }> {
  return { type: 'not-found', target };
}

function conflict(
  current: TaskSnapshot,
): Extract<TaskRepositoryResult, { readonly type: 'conflict' }> {
  return { type: 'conflict', current };
}

function committedTask(
  task: TaskSnapshot,
  changed: boolean,
): Extract<TaskRepositoryResult, { readonly type: 'committed' }> {
  return { type: 'committed', outcome: { type: 'task', task }, changed };
}

function archiveReceiptKey(ref: TaskRef): string {
  return `${ref.filePath}\0${ref.line}\0${ref.revision}`;
}

function authorityRevisionChanged(
  hasAuthority: boolean,
  hasSnapshotState: boolean,
  indexedRef: TaskRef | undefined,
  revision: string,
): boolean {
  return hasAuthority && hasSnapshotState && indexedRef?.revision !== revision;
}

type PreparedRootPorts = ConstructorParameters<typeof MarkdownTaskEditPreparation>[0];
type PreparedRootRefresh = Awaited<ReturnType<NonNullable<PreparedRootPorts['refresh']>>>;
type PreparedRootCandidate = Parameters<NonNullable<PreparedRootPorts['refresh']>>[1];
interface PreparedCreateContext {
  readonly destination: TaskDestination;
  readonly basis: PreparedCreateBasis;
  readonly family: { attempted: boolean };
  readonly phase: boolean | 'refreshed';
}

interface PreparedRootBasis {
  readonly root: TaskSnapshot;
  readonly content: string;
  readonly file: TFile;
  readonly observation: TaskReadObservation;
  readonly source: NonNullable<
    Extract<ReturnType<ProjectSourceReadApi['get']>, { type: 'ok' }>['value']
  >;
}

interface RepositoryOptions {
  readonly preparedRootQueries?: Pick<TaskQueryApi, 'resolve'>;
  readonly preparedRootSources?: ProjectSourceReadApi;
  readonly preparedRootReads?: TaskIntegrationReadStateApi;
  readonly codec: TaskMarkdownCodec;
  readonly editor: TaskBlockEditor;
  readonly locator: TaskLocator;
  readonly snapshotsFromContent: (filePath: string, content: string) => readonly TaskSnapshot[];
  readonly refAuthority?: TaskRefAuthority;
  readonly snapshotState?: TaskSnapshotState;
  readonly configuredTaskNotePath?: () => string;
  readonly diagnostics?: TaskDiagnosticSink;
}

function emptyTaskNote(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  const frontmatter = parseMarkdownFrontmatter(lines);
  return (
    frontmatter.type !== 'invalid' && lines.slice(frontmatter.contentStart).join('\n').trim() === ''
  );
}

function configuredTaskNote(policy: string | undefined, path: string): boolean {
  if (policy === undefined || policy === '') return false;
  try {
    return compileNotePathPattern(policy).matches(path);
  } catch {
    // Invalid settings preserve the note; task deletion remains authorized.
    return false;
  }
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
      | 'delete-comment'
      | 'add-time-entry'
      | 'close-time-entry'
      | 'delete-time-entry'
      | 'restore-time-entry';
  }
>;

type TimeEntryTaskEditCommand = Extract<
  StructuralTaskEditCommand,
  {
    readonly type:
      'add-time-entry' | 'close-time-entry' | 'delete-time-entry' | 'restore-time-entry';
  }
>;

/** Exhaustive by construction, so a new entry command cannot miss the entry block edits. */
const TIME_ENTRY_COMMAND_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    'add-time-entry': true,
    'close-time-entry': true,
    'delete-time-entry': true,
    'restore-time-entry': true,
  } satisfies Readonly<Record<TimeEntryTaskEditCommand['type'], true>>),
);

/** Exhaustive by construction, so a new structural command cannot miss the block-edit dispatch. */
const STRUCTURAL_COMMAND_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    'set-description': true,
    'add-subtask': true,
    'restore-subtask': true,
    'delete-subtask': true,
    'reorder-subtask': true,
    'add-comment': true,
    'update-comment': true,
    'delete-comment': true,
    'add-time-entry': true,
    'close-time-entry': true,
    'delete-time-entry': true,
    'restore-time-entry': true,
  } satisfies Readonly<Record<StructuralTaskEditCommand['type'], true>>),
);

function nodeTargetOf(command: TaskEditCommand): PlanningTarget | undefined {
  if ('ref' in command) return undefined;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask')
    return command.subtask.parent;
  return taskMutationNodeRef(mutationTarget(command));
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
  readonly beforeStage?: (roots: readonly RootRevisionOverride[]) => void;
  readonly operation?: object;
  readonly occurrences?: (
    roots: readonly RootRevisionOverride[],
  ) => readonly TaskOccurrenceWitness[];
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
  input.beforeStage?.(roots);
  return authority.stage(
    {
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      filePath,
      candidateFingerprint: taskRefContentFingerprint(candidate),
      candidateLength: candidate.length,
      expectedRevision,
      roots,
      ...(input.occurrences === undefined ? {} : { occurrences: input.occurrences(roots) }),
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
    semanticTransition: request.semanticTransition === true,
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
  return STRUCTURAL_COMMAND_TYPES.has(command.type);
}

function ownsComment(node: TaskSnapshot | SubtaskSnapshot, comment: CommentRef): boolean {
  return node.comments.some(
    (candidate) =>
      candidate.ref.relativeLine === comment.relativeLine &&
      legacyLine(candidate.ref.originalMarkdown) === legacyLine(comment.originalMarkdown),
  );
}

function ownsTimeEntry(node: TaskSnapshot | SubtaskSnapshot, entry: TimeEntryRef): boolean {
  return node.timeEntries.some(
    (candidate) =>
      candidate.relativeLine === entry.relativeLine &&
      legacyLine(candidate.originalMarkdown) === legacyLine(entry.originalMarkdown),
  );
}

function ownsSubtask(node: TaskSnapshot | SubtaskSnapshot, subtask: SubtaskRef): boolean {
  return node.subtasks.some(
    (candidate) =>
      candidate.ref.relativeLine === subtask.relativeLine &&
      candidate.ref.originalBlock === subtask.originalBlock,
  );
}

function isTimeEntryCommand(
  command: StructuralTaskEditCommand,
): command is TimeEntryTaskEditCommand {
  return TIME_ENTRY_COMMAND_TYPES.has(command.type);
}

function structuralEdit(command: StructuralTaskEditCommand): TaskBlockEdit {
  return isTimeEntryCommand(command) ? timeEntryEdit(command) : taskContentEdit(command);
}

function timeEntryEdit(command: TimeEntryTaskEditCommand): TaskBlockEdit {
  switch (command.type) {
    case 'add-time-entry':
      return { type: command.type, stamp: command.stamp };
    case 'close-time-entry':
      return {
        type: command.type,
        relativeLine: command.entry.relativeLine,
        originalMarkdown: command.entry.originalMarkdown,
        stamp: command.stamp,
        endMs: command.endMs,
        minimumMs: command.minimumMs,
      };
    case 'delete-time-entry':
      return {
        type: command.type,
        relativeLine: command.entry.relativeLine,
        originalMarkdown: command.entry.originalMarkdown,
      };
    case 'restore-time-entry':
      return {
        type: command.type,
        markdown: command.markdown,
        relativeLine: command.relativeLine,
      };
  }
}

function taskContentEdit(
  command: Exclude<StructuralTaskEditCommand, TimeEntryTaskEditCommand>,
): TaskBlockEdit {
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

interface MoveTargetInput {
  readonly sourceTask: TaskSnapshot;
  readonly sourceBlock: TaskRootBlock;
  readonly destination: TaskDestination;
  readonly targetFile: TFile;
  readonly indexedRevision: string;
  readonly archive: boolean;
  readonly archiveSource?: TaskRef;
  readonly project?: ProjectMove | undefined;
}

interface ProjectPhaseInput {
  readonly file: TFile;
  readonly phase: ProjectRootPhase;
  readonly check: ProjectTaskGuard;
  readonly peer?: { readonly file: TFile; readonly content: string };
}
interface ProjectMove {
  readonly source: ProjectTaskSource;
  readonly destination: ProjectTaskDestination;
  readonly copy: ProjectRootPhase;
  readonly removal: ProjectRootPhase;
  sourceFile?: TFile;
  sourceContent?: string;
  remaining?: string;
}

interface MoveTargetTransaction {
  result: TaskRepositoryResult | undefined;
  transition: object | undefined;
  committedContent: string | undefined;
  insertedBlock?: TaskRootBlock;
  originalContent?: string;
}

interface ArchiveReceipt {
  readonly source: TaskRef;
  readonly sourceBlock: string;
  readonly targetPath: string;
  readonly targetBlock: TaskRootBlock;
  readonly targetContentBefore: string;
  readonly targetContentAfter: string;
}

type ArchiveReceiptLookup =
  | { readonly type: 'found'; readonly receipt: ArchiveReceipt }
  | { readonly type: 'absent' | 'ambiguous' };

type MoveSourceResolution =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly task: TaskSnapshot;
      readonly block: TaskRootBlock;
      readonly indexedRevision: string;
    };

interface SourceRemovalFailure {
  readonly cause: MoveRecovery['cause'];
  readonly contentState: 'remains' | 'unknown';
}

interface SourceRemovalTransaction {
  committedContent?: string;
  failure?: MoveRecovery['cause'];
}

type ArchiveStart =
  | {
      readonly type: 'ready';
      readonly source: Extract<MoveSourceResolution, { type: 'ready' }>;
      readonly targetFile: TFile;
    }
  | { readonly type: 'result'; readonly result: TaskRepositoryResult };

type ArchiveTargetProof =
  | { readonly type: 'proven' }
  | { readonly type: 'absent' }
  | { readonly type: 'result'; readonly result: TaskRepositoryResult };

function moveRequestParts(
  request: TaskMoveRequest | TaskRef,
  legacyDestination: TaskDestination | undefined,
): {
  readonly prepared: RevisionPrecondition | undefined;
  readonly ref: TaskRef;
  readonly receiptRef: TaskRef;
  readonly destination: TaskDestination | undefined;
} {
  if ('baseRoot' in request) {
    return {
      prepared: request,
      ref: request.baseRoot.ref,
      receiptRef: rootRefOf(request.baseTarget),
      destination: request.destination,
    };
  }
  return { prepared: undefined, ref: request, receiptRef: request, destination: legacyDestination };
}

interface RecurrenceProcessInput {
  readonly fileIdentity?: object | undefined;
  readonly revisionRequest: RecurrenceCompletionRevisionRequest | undefined;
  readonly request: RecurrenceCompletionRequest;
  readonly rootRef: TaskRef;
}

interface RecurrenceTransaction {
  result: TaskRepositoryResult | undefined;
  transitionToken: object | undefined;
  committedContent: string | undefined;
  rollbackBasis?: RollbackBasis | undefined;
  confirmStrict?: (() => void) | undefined;
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
  readonly originalContent: string;
  readonly process: RecurrenceProcessInput;
  readonly location: ReadyRecurrenceLocation;
  readonly prepared: PreparedRecurrence;
  readonly coordinates: RecurrenceCoordinates;
}

interface EditProcessInput {
  /** Private creation preview context: author status without completion-time side effects. */
  readonly initialStatus?: true;
  readonly collectNodes?: boolean;
  readonly fileIdentity?: object | undefined;
  readonly prepared: TaskEditRequest | undefined;
  readonly command: TaskEditCommand;
  readonly rootRef: TaskRef;
}

interface EditTransaction {
  result: TaskRepositoryResult | undefined;
  transitionToken: object | undefined;
  committedContent: string | undefined;
  rollbackBasis?: RollbackBasis | undefined;
  confirmStrict?: (() => void) | undefined;
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
  readonly nodeMap?: readonly TaskNodeLineMapping[];
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

function completionTrackingWitness(
  input: SurvivingEditStageInput,
  revision: string,
): CompletionTrackingWitness | undefined {
  const { process, edit, surviving } = input;
  const command = process.command;
  return command.type === 'close-time-entry' &&
    command.completionFollowUp === true &&
    edit.result.type === 'committed' &&
    edit.result.outcome.type === 'task'
    ? {
        before: { ...process.rootRef },
        after: { filePath: process.rootRef.filePath, line: surviving.line, revision },
        entry: structuredClone(command.entry),
        stamp: command.stamp,
        endMs: command.endMs,
        minimumMs: command.minimumMs,
        disposition:
          edit.result.outcome.discardedShortEntry === true
            ? ('discarded' as const)
            : ('closed' as const),
      }
    : undefined;
}

interface RejectedRollbackContext {
  readonly authority: TaskRefAuthority;
  readonly snapshotState: TaskSnapshotState;
  readonly block: TaskRootBlock;
  readonly expectedRevision: string;
}

type TextEditTarget = DescriptionLinkTarget;

interface PreparedCreateBasis {
  readonly sources: ProjectSourceReadApi;
  readonly reads: TaskIntegrationReadStateApi;
  readonly observation: TaskReadObservation;
  readonly accepted: Extract<ReturnType<ProjectSourceReadApi['get']>, { type: 'ok' }>['value'];
  readonly file: TFile | null;
}

export class ObsidianTaskRepository implements TaskRepository {
  readonly supportsRevisionPreconditions = true as const;
  readonly supportsStrictStatusPreconditions = true as const;

  private readonly authority_abyssPrivate: TaskRefAuthority | undefined;
  private readonly state_abyssPrivate: TaskSnapshotState | undefined;
  private readonly codec_abyssPrivate: TaskMarkdownCodec;
  private readonly editor_abyssPrivate: TaskBlockEditor;
  private readonly locator_abyssPrivate: TaskLocator;
  private readonly parse_abyssPrivate: RepositoryOptions['snapshotsFromContent'];
  private readonly archiveReceipts_abyssPrivate = new Map<string, ArchiveReceipt>();
  private preparedSequence_abyssPrivate = 0;
  private archiveQueue_abyssPrivate: Promise<void> = Promise.resolve();

  constructor(
    private readonly app_abyssPrivate: App,
    private readonly options_abyssPrivate: RepositoryOptions,
  ) {
    this.authority_abyssPrivate = options_abyssPrivate.refAuthority;
    this.state_abyssPrivate = options_abyssPrivate.snapshotState;
    this.codec_abyssPrivate = options_abyssPrivate.codec;
    this.editor_abyssPrivate = options_abyssPrivate.editor;
    this.locator_abyssPrivate = options_abyssPrivate.locator;
    this.parse_abyssPrivate = options_abyssPrivate.snapshotsFromContent;
  }

  async create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult> {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (!(file instanceof TFile)) return this.destinationUnavailable_abyssPrivate();
    const block = this.draftBlock_abyssPrivate(draft);
    if (block.type === 'invalid') return block;
    return this.createInFile_abyssPrivate(file, destination, block.content);
  }

  async prepareCreateRoot(
    destination: TaskDestination,
    draft: TaskDraft,
  ): Promise<TaskPreparedCreateRoot> {
    const basis = this.capturePreparedCreateBasis_abyssPrivate(destination);
    if (basis === undefined)
      return { type: 'invalid', result: this.destinationUnavailable_abyssPrivate() };
    const block = this.draftBlock_abyssPrivate(draft);
    if (block.type === 'invalid') return { type: 'invalid', result: block };
    const rootBlock = this.editor_abyssPrivate.rootBlocks(block.content)[0];
    const root =
      rootBlock === undefined
        ? undefined
        : this.snapshotFor_abyssPrivate(destination.filePath, block.content, rootBlock);
    if (root === undefined) return { type: 'invalid', result: invalidTaskSyntax() };
    const candidate = this.prepareDraftCandidate_abyssPrivate(root, block.content);
    return (await this.validatePreparedCreateBasis_abyssPrivate(basis, destination))
      ? this.wrapPreparedCreate_abyssPrivate(candidate, {
          destination,
          basis,
          family: { attempted: false },
          phase: true,
        })
      : { type: 'invalid', result: this.destinationUnavailable_abyssPrivate() };
  }

  private wrapPreparedCreate_abyssPrivate(
    prepared: TaskPreparedRootEdit,
    context: PreparedCreateContext,
  ): TaskPreparedCreateRoot {
    if (prepared.type === 'invalid') return prepared;
    const after = prepared.after;
    if (after === null) return { type: 'invalid', result: invalidTaskTarget('target') };
    const { destination, basis, family, phase: initial } = context;
    const { sources, accepted, file } = basis;
    let attempt: Promise<TaskRepositoryResult> | undefined;
    return {
      type: 'ready',
      get after() {
        return structuredClone(after);
      },
      get continuations() {
        if (initial === 'refreshed') return unchangedPreparedContinuations(after);
        return initial ? [] : prepared.continuations;
      },
      validateBeforeProvision: async (check, plannedContent) => {
        if (!(await this.validatePreparedCreateBasis_abyssPrivate(basis, destination)))
          return false;
        const live = accepted?.content ?? plannedContent ?? '';
        const inserted = this.editor_abyssPrivate.insertRootBlock(
          live,
          after.source.originalBlock,
          destination.insertion,
        );
        return (
          inserted !== undefined &&
          sources.prospective(destination.filePath, inserted.content).type === 'ok' &&
          (file === null || check === undefined || check(file, live, inserted.content))
        );
      },
      append: (command) =>
        command.type === 'delete'
          ? { type: 'invalid', result: invalidTaskTarget('target') }
          : this.wrapPreparedCreate_abyssPrivate(prepared.append(command), {
              ...context,
              phase: false,
            }),
      refresh: (options) => this.refreshPreparedCreate_abyssPrivate(prepared, context, options),
      commit: async (guard) => {
        family.attempted = true;
        attempt ??= Promise.resolve().then(async () => {
          const native = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
          if (!(native instanceof TFile)) return this.destinationUnavailable_abyssPrivate();
          return this.createInFile_abyssPrivate(native, destination, after.source.originalBlock, {
            validateBeforeProvision: () => guard.validateBeforeProvision(),
            check: (identity, live, content) =>
              this.preparedCreateCurrent_abyssPrivate(basis) &&
              guard.check(identity, live, content) &&
              (accepted === undefined
                ? sources.prospective(destination.filePath, content).type === 'ok'
                : identity instanceof TFile &&
                  identity === file &&
                  sources.matchesFile(accepted, identity) &&
                  live === accepted.content &&
                  sources.candidate(accepted, live, content).type === 'ok'),
          });
        });
        return structuredClone(await attempt);
      },
    };
  }

  private async refreshPreparedCreate_abyssPrivate(
    prepared: Extract<TaskPreparedRootEdit, { type: 'ready' }>,
    context: PreparedCreateContext,
    options?: { readonly createdDestinationAnchor?: TaskSnapshot },
  ): Promise<TaskPreparedCreateRoot> {
    const { destination, basis, family } = context;
    const allowed = (): boolean =>
      !family.attempted && this.preparedCreateCurrent_abyssPrivate(basis);
    const fresh = this.capturePreparedCreateBasis_abyssPrivate(destination);
    if (
      !allowed() ||
      fresh === undefined ||
      !this.preparedCreateIdentity_abyssPrivate(context, fresh, options?.createdDestinationAnchor)
    )
      return { type: 'invalid', result: this.destinationUnavailable_abyssPrivate() };
    if (!(await this.validatePreparedCreateBasis_abyssPrivate(fresh, destination)) || !allowed())
      return { type: 'invalid', result: this.destinationUnavailable_abyssPrivate() };
    return this.wrapPreparedCreate_abyssPrivate(prepared, {
      ...context,
      basis: fresh,
      phase: 'refreshed',
    });
  }

  private preparedCreateIdentity_abyssPrivate(
    context: PreparedCreateContext,
    fresh: PreparedCreateBasis,
    anchor: TaskSnapshot | undefined,
  ): boolean {
    if (context.basis.file !== null) return fresh.file === context.basis.file;
    if (fresh.file === null) return true;
    const root = anchor === undefined ? undefined : this.capturePreparedRoot_abyssPrivate(anchor);
    return root?.file === fresh.file && root.root.ref.filePath === context.destination.filePath;
  }

  private prepareDraftCandidate_abyssPrivate(
    root: TaskSnapshot,
    content: string,
  ): TaskPreparedRootEdit {
    return new MarkdownTaskEditPreparation({
      apply: (content, previous, command) =>
        this.previewRootEdit_abyssPrivate(content, previous, command, true),
      commit: async () => invalidTaskTarget('destination'),
    }).prepare(
      this.versionPreparedSnapshot_abyssPrivate(root),
      content,
      (this.editor_abyssPrivate.ownedTaskSubtree(content, 0)?.taskLines ?? []).map((offset) => ({
        beforeOffset: offset,
        afterOffset: offset,
      })),
    );
  }

  private preparedCreateCurrent_abyssPrivate(basis: PreparedCreateBasis): boolean {
    const now = basis.reads.capture();
    return (
      now.lifecycle === 'ready' &&
      now.scopeRevision === basis.observation.scopeRevision &&
      now.semanticsRevision === basis.observation.semanticsRevision
    );
  }

  private async validatePreparedCreateBasis_abyssPrivate(
    basis: PreparedCreateBasis,
    destination: TaskDestination,
  ): Promise<boolean> {
    if (!this.preparedCreateCurrent_abyssPrivate(basis)) return false;
    const native = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (basis.file === null) return native === null;
    return (
      native === basis.file &&
      basis.accepted !== undefined &&
      basis.sources.matchesFile(basis.accepted, basis.file) &&
      (await this.app_abyssPrivate.vault.read(basis.file)) === basis.accepted.content
    );
  }

  private capturePreparedCreateBasis_abyssPrivate(
    destination: TaskDestination,
  ): PreparedCreateBasis | undefined {
    const sources = this.options_abyssPrivate.preparedRootSources;
    const reads = this.options_abyssPrivate.preparedRootReads;
    if (sources === undefined || reads === undefined) return undefined;
    const observation = reads.capture();
    const source = sources.get(destination.filePath);
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (source.type !== 'ok' || (file !== null && !(file instanceof TFile))) return undefined;
    if (file !== null && source.value === undefined) return undefined;
    return { sources, reads, observation, accepted: source.value, file };
  }

  private draftBlock_abyssPrivate(draft: TaskDraft): ReturnType<typeof createTaskBlock> {
    return createTaskBlock(this.codec_abyssPrivate, {
      ...draft,
      today: draft.today ?? localDate('1970-01-01'),
      addCreatedDate: draft.addCreatedDate ?? false,
    });
  }

  async createProjectRoot(
    destination: ProjectTaskDestination,
    draft: TaskDraft,
  ): Promise<ProjectTaskResult> {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (!(file instanceof TFile)) return projectTaskFailure('unavailable');
    const block = this.draftBlock_abyssPrivate(draft);
    if (block.type === 'invalid') return projectTaskFailure('invalid');
    const phase = new ProjectRootPhase(destination.filePath, {});
    await this.insertProjectRoot_abyssPrivate(
      { file, phase, check: destination.check },
      destination,
      block.content,
    );
    return this.projectResult_abyssPrivate(destination, phase);
  }

  private async projectResult_abyssPrivate(
    destination: ProjectTaskDestination,
    copy: ProjectRootPhase,
    removal?: ProjectRootPhase,
  ): Promise<ProjectTaskResult> {
    const last = copy.effect === 'committed' ? (removal ?? copy) : copy;
    const changed = last.effect === 'committed';
    const ref = await this.currentProjectCopy_abyssPrivate(destination, copy);
    return {
      outcome: changed ? 'changed' : 'failed',
      destinationCopy: copy.effect,
      sourceRemoval: removal?.effect ?? 'unchanged',
      ...(!changed && { reason: last.reason }),
      ...(ref !== undefined && {
        task: {
          filePath: ref.filePath,
          rootLine: ref.line,
          rootRevision: ref.revision,
          nodeOffset: 0,
        },
      }),
    };
  }

  private async currentProjectCopy_abyssPrivate(
    destination: ProjectTaskDestination,
    copy: ProjectRootPhase,
  ): Promise<TaskRef | undefined> {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(copy.path);
    if (!(file instanceof TFile) || copy.task === undefined) return;
    const stamp = { ...file.stat };
    try {
      const live = await this.app_abyssPrivate.vault.read(file);
      if (
        live === copy.content &&
        sameNoteFileStamp(stamp, file.stat) &&
        this.projectCopyCurrent_abyssPrivate(destination, copy, file)
      )
        return copy.task.ref;
    } catch {
      // Storage effects survive an unavailable read at delivery.
    }
    return undefined;
  }

  private projectCopyCurrent_abyssPrivate(
    destination: ProjectTaskDestination,
    copy: ProjectRootPhase,
    file: TFile,
  ): boolean {
    const { task, content } = copy;
    return (
      content !== undefined &&
      task !== undefined &&
      this.isCurrentFile_abyssPrivate(file, copy.path) &&
      destination.checkCopy(file, content) &&
      this.state_abyssPrivate?.currentRoot(copy.path, task.ref.line, task.source.originalBlock)
        ?.revision === task.ref.revision
    );
  }

  private async insertProjectRoot_abyssPrivate(
    input: ProjectPhaseInput,
    destination: TaskDestination,
    block: string,
  ): Promise<void> {
    await this.writeProjectPhase_abyssPrivate(input, (live) => {
      const inserted = this.editor_abyssPrivate.insertRootBlock(live, block, destination.insertion);
      if (inserted?.block.source !== block) return;
      return { kind: 'insert', line: inserted.block.line, content: inserted.content };
    });
  }

  private async writeProjectPhase_abyssPrivate(
    { file, phase, check, peer }: ProjectPhaseInput,
    edit: (live: string) => ProjectRootEdit | undefined,
  ): Promise<void> {
    const current = (): boolean => this.isCurrentFile_abyssPrivate(file, phase.path);
    // Native changes may update a file's stat before its metadata acquisition reaches TaskIndex.
    const stat = peer === undefined ? undefined : { ...peer.file.stat };
    const peerCurrent = (): boolean => sameNoteFileStamp(stat, peer?.file.stat);
    try {
      await this.processFile_abyssPrivate(
        file,
        (live) => {
          if (!current() || !peerCurrent()) return live;
          const candidate = edit(live);
          if (candidate === undefined) return live;
          const failed = check(file, live, candidate.content);
          if (failed !== undefined) {
            phase.reason = failed;
            return live;
          }
          return phase.forward(live, candidate, this.options_abyssPrivate);
        },
        async () => {
          if (phase.content === undefined) return;
          phase.effect = 'committed';
          const state = this.state_abyssPrivate;
          await state?.reconcileCommittedSource?.(phase.path, file, phase.content, () => {
            phase.install(state);
          });
        },
        peer === undefined
          ? undefined
          : async () => {
              if ((await this.app_abyssPrivate.vault.read(peer.file)) !== peer.content)
                throw new Error('Move peer changed');
            },
      );
    } catch {
      phase.reason = 'io';
    } finally {
      phase.release();
    }
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
    guard?: PreparedTaskCreateGuard,
  ): Promise<TaskRepositoryResult> {
    let result: TaskRepositoryResult | undefined;
    let createdContent: string | undefined;
    const original = guard === undefined ? undefined : await this.app_abyssPrivate.vault.read(file);
    try {
      await this.processFile_abyssPrivate(
        file,
        (content) => {
          const inserted = this.editor_abyssPrivate.insertRootBlock(
            content,
            blockContent,
            destination.insertion,
          );
          if (inserted == null) {
            result = invalidTaskSyntax();
            return content;
          }
          if (
            guard !== undefined &&
            (!this.isCurrentFile_abyssPrivate(file, destination.filePath) ||
              !guard.check(file, content, inserted.content))
          ) {
            result = invalidTaskTarget('destination');
            return content;
          }
          const task = this.snapshotFor_abyssPrivate(
            destination.filePath,
            inserted.content,
            inserted.block,
          );
          if (task == null) {
            result = invalidTaskSyntax();
            return content;
          }
          result = committedTask(task, true);
          createdContent = inserted.content;
          return inserted.content;
        },
        async () => {
          result = this.finalizeCreatedResult_abyssPrivate(
            destination.filePath,
            createdContent,
            result,
          );
        },
      );
    } catch {
      await this.reconcileCreateFailure_abyssPrivate(file, destination.filePath, createdContent);
      return this.guardedCreateFailure_abyssPrivate(file, destination.filePath, original);
    }
    return result ?? this.processError_abyssPrivate(destination.filePath);
  }

  private async guardedCreateFailure_abyssPrivate(
    file: TFile,
    path: string,
    original: string | undefined,
  ): Promise<TaskRepositoryResult> {
    if (original !== undefined) {
      try {
        if (
          this.isCurrentFile_abyssPrivate(file, path) &&
          (await this.app_abyssPrivate.vault.read(file)) === original
        )
          return { type: 'io-error', cause: 'process-error', path, contentState: 'unchanged' };
      } catch {
        // The receipt below records the unavailable readback; it never authorizes replay.
      }
    }
    return this.processError_abyssPrivate(path);
  }

  private async reconcileCreateFailure_abyssPrivate(
    file: TFile,
    path: string,
    createdContent: string | undefined,
  ): Promise<void> {
    if (createdContent === undefined || this.state_abyssPrivate == null) return;
    try {
      const authoritative = await this.app_abyssPrivate.vault.read(file);
      this.state_abyssPrivate.installCommittedContent(path, authoritative);
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
    const installed = this.state_abyssPrivate?.installCommittedContent(path, content);
    return this.rebaseEditResult_abyssPrivate(result, installed);
  }

  private processError_abyssPrivate(path: string): TaskRepositoryResult {
    return { type: 'io-error', cause: 'process-error', path, contentState: 'unknown' };
  }

  async move(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult> {
    if ('baseRoot' in request && request.strictStatus !== undefined)
      return { type: 'strict-rejected', reason: 'unsupported-precondition' };
    return await this.withStatisticsHold_abyssPrivate(() =>
      this.moveOnce_abyssPrivate(request, legacyDestination),
    );
  }

  async moveProjectRoot(
    destination: ProjectTaskDestination,
    source: ProjectTaskSource,
  ): Promise<ProjectTaskResult> {
    const operation = {};
    const project: ProjectMove = {
      source,
      destination,
      copy: new ProjectRootPhase(destination.filePath, operation),
      removal: new ProjectRootPhase(source.root.ref.filePath, operation),
    };
    try {
      const result = await this.withStatisticsHold_abyssPrivate(() =>
        this.moveOnce_abyssPrivate(source.root.ref, destination, project),
      );
      if (result.type === 'committed' && !result.changed)
        return this.projectNoop_abyssPrivate(project);
      if (result.type === 'io-error' && project.copy.effect === 'unchanged')
        project.copy.reason = 'io';
    } catch {
      (project.copy.effect === 'committed' ? project.removal : project.copy).reason = 'io';
    }
    return this.projectResult_abyssPrivate(destination, project.copy, project.removal);
  }

  private projectNoop_abyssPrivate(project: ProjectMove): ProjectTaskResult {
    const { sourceFile, sourceContent, destination } = project;
    if (sourceFile === undefined || sourceContent === undefined) return projectTaskFailure('stale');
    const failure =
      this.projectMoveSourceGuard_abyssPrivate(project, sourceFile, sourceContent, sourceContent) ??
      destination.check(sourceFile, sourceContent, sourceContent);
    if (failure !== undefined) return projectTaskFailure(failure);
    const ref = project.source.root.ref;
    return {
      outcome: 'noop',
      destinationCopy: 'unchanged',
      sourceRemoval: 'unchanged',
      task: {
        filePath: ref.filePath,
        rootLine: ref.line,
        rootRevision: ref.revision,
        nodeOffset: 0,
      },
    };
  }

  private async withStatisticsHold_abyssPrivate<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.state_abyssPrivate?.holdStatisticsPublication?.();
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async moveOnce_abyssPrivate(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
    project?: ProjectMove,
  ): Promise<TaskRepositoryResult> {
    const { prepared, ref, destination } = moveRequestParts(request, legacyDestination);
    if (destination == null) {
      return invalidTaskTarget('destination');
    }
    const sourceFile = this.app_abyssPrivate.vault.getAbstractFileByPath(ref.filePath);
    if (!(sourceFile instanceof TFile)) {
      return notFound({ type: 'task', ref });
    }
    const sourceContent = await this.readMoveSource_abyssPrivate(
      sourceFile,
      ref.filePath,
      project !== undefined,
    );
    if (typeof sourceContent !== 'string') return sourceContent;
    const source = this.resolveMoveSource_abyssPrivate(
      ref,
      prepared,
      sourceContent,
      project?.source.root,
    );
    if (source.type === 'result') return source.result;
    if (!this.prepareProjectMove_abyssPrivate(project, sourceFile, sourceContent, source.block))
      return conflict(source.task);
    if (ref.filePath === destination.filePath) return this.unchangedMove_abyssPrivate(source.task);
    const targetFile = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    if (!(targetFile instanceof TFile)) return this.destinationUnavailable_abyssPrivate();
    const targetResult = await this.copyMoveTarget_abyssPrivate({
      sourceTask: source.task,
      sourceBlock: source.block,
      destination,
      targetFile,
      indexedRevision: source.indexedRevision,
      archive: false,
      project,
    });
    return await this.finishMoveSource_abyssPrivate(
      source.task,
      destination.filePath,
      targetResult,
      project,
    );
  }

  private prepareProjectMove_abyssPrivate(
    project: ProjectMove | undefined,
    file: TFile,
    content: string,
    block: TaskRootBlock,
  ): boolean {
    if (project === undefined) return true;
    project.sourceFile = file;
    project.sourceContent = content;
    const same = project.source.root.ref.filePath === project.destination.filePath;
    const remaining = same ? content : this.editor_abyssPrivate.deleteRoot(content, block);
    if (remaining === undefined) return false;
    project.remaining = remaining;
    const failure =
      this.projectMoveSourceGuard_abyssPrivate(project, file, content, remaining) ??
      (same ? project.destination.check(file, content, content) : undefined);
    if (failure === undefined) return true;
    project.copy.reason = failure;
    return false;
  }

  async archive(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult> {
    if ('baseRoot' in request && request.strictStatus !== undefined)
      return { type: 'strict-rejected', reason: 'unsupported-precondition' };
    const operation = this.archiveQueue_abyssPrivate.then(() =>
      this.withStatisticsHold_abyssPrivate(() =>
        this.archiveOnce_abyssPrivate(request, legacyDestination),
      ),
    );
    this.archiveQueue_abyssPrivate = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async archiveOnce_abyssPrivate(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult> {
    const { prepared, ref, receiptRef, destination } = moveRequestParts(request, legacyDestination);
    if (destination == null || ref.filePath.toLowerCase() === destination.filePath.toLowerCase()) {
      return invalidTaskTarget('destination');
    }
    const previous = await this.retainedArchiveResult_abyssPrivate(
      receiptRef,
      ref,
      destination,
      prepared?.baseRoot.source.originalBlock,
    );
    if (previous !== undefined) return previous;
    const start = await this.beginArchive_abyssPrivate(ref, prepared, destination);
    if (start.type === 'result') return start.result;
    const source = start.source;
    const targetResult = await this.copyMoveTarget_abyssPrivate({
      sourceTask: source.task,
      sourceBlock: source.block,
      destination,
      targetFile: start.targetFile,
      indexedRevision: source.indexedRevision,
      archive: true,
      archiveSource: receiptRef,
    });
    if (targetResult.type !== 'committed' || targetResult.outcome.type !== 'task')
      return targetResult;
    const receipt = this.archiveReceipts_abyssPrivate.get(archiveReceiptKey(receiptRef));
    if (receipt === undefined) return this.processError_abyssPrivate(destination.filePath);
    return await this.finishArchiveSource_abyssPrivate(source.task, receipt);
  }

  private async retainedArchiveResult_abyssPrivate(
    receiptRef: TaskRef,
    currentRef: TaskRef,
    destination: TaskDestination,
    sourceBlock: string | undefined,
  ): Promise<TaskRepositoryResult | undefined> {
    const lookup = this.archiveReceiptLookup_abyssPrivate(receiptRef, sourceBlock);
    if (lookup.type === 'found') {
      return await this.resumeArchive_abyssPrivate(currentRef, destination, lookup.receipt);
    }
    if (lookup.type === 'ambiguous') {
      return {
        type: 'io-error',
        cause: 'archive-recovery-ambiguous',
        path: destination.filePath,
        contentState: 'unchanged',
      };
    }
    if (this.archiveReceipts_abyssPrivate.size < 64) return undefined;
    return {
      type: 'io-error',
      cause: 'archive-recovery-capacity',
      path: destination.filePath,
      contentState: 'unchanged',
    };
  }

  private archiveReceiptLookup_abyssPrivate(
    ref: TaskRef,
    sourceBlock: string | undefined,
  ): ArchiveReceiptLookup {
    const exact = this.archiveReceipts_abyssPrivate.get(archiveReceiptKey(ref));
    if (exact !== undefined) return { type: 'found', receipt: exact };
    if (sourceBlock === undefined) return { type: 'absent' };
    const sameSource = [...this.archiveReceipts_abyssPrivate.values()].filter(
      (receipt) => receipt.source.filePath === ref.filePath && receipt.sourceBlock === sourceBlock,
    );
    const sameRevision = sameSource.filter((receipt) => receipt.source.revision === ref.revision);
    if (sameRevision.length === 1) {
      return { type: 'found', receipt: sameRevision[0] as ArchiveReceipt };
    }
    return { type: sameSource.length === 0 ? 'absent' : 'ambiguous' };
  }

  private async beginArchive_abyssPrivate(
    ref: TaskRef,
    prepared: RevisionPrecondition | undefined,
    destination: TaskDestination,
  ): Promise<ArchiveStart> {
    const sourceFile = this.app_abyssPrivate.vault.getAbstractFileByPath(ref.filePath);
    if (!(sourceFile instanceof TFile)) {
      return { type: 'result', result: notFound({ type: 'task', ref }) };
    }
    const sourceContent = await this.readMoveSource_abyssPrivate(sourceFile, ref.filePath);
    if (typeof sourceContent !== 'string') return { type: 'result', result: sourceContent };
    const source = this.resolveMoveSource_abyssPrivate(ref, prepared, sourceContent);
    if (source.type === 'result') return source;
    const target = this.app_abyssPrivate.vault.getAbstractFileByPath(destination.filePath);
    return target instanceof TFile
      ? { type: 'ready', source, targetFile: target }
      : { type: 'result', result: this.destinationUnavailable_abyssPrivate() };
  }

  private retainArchiveReceipt_abyssPrivate(receipt: ArchiveReceipt): void {
    const key = archiveReceiptKey(receipt.source);
    this.archiveReceipts_abyssPrivate.delete(key);
    this.archiveReceipts_abyssPrivate.set(key, receipt);
  }

  private async resumeArchive_abyssPrivate(
    ref: TaskRef,
    destination: TaskDestination,
    receipt: ArchiveReceipt,
  ): Promise<TaskRepositoryResult> {
    if (receipt.targetPath.toLowerCase() !== destination.filePath.toLowerCase()) {
      return invalidTaskTarget('destination');
    }
    const targetProof = await this.proveArchiveTarget_abyssPrivate(receipt);
    if (targetProof.type === 'result') return targetProof.result;
    if (targetProof.type === 'absent') {
      this.archiveReceipts_abyssPrivate.delete(archiveReceiptKey(receipt.source));
      return await this.archiveOnce_abyssPrivate(ref, destination);
    }
    return await this.resumeArchiveSource_abyssPrivate(ref, receipt);
  }

  private async proveArchiveTarget_abyssPrivate(
    receipt: ArchiveReceipt,
  ): Promise<ArchiveTargetProof> {
    const target = this.app_abyssPrivate.vault.getAbstractFileByPath(receipt.targetPath);
    if (!(target instanceof TFile)) {
      return { type: 'result', result: this.partialArchive_abyssPrivate(receipt, 'not-found') };
    }
    let content: string;
    try {
      content = await this.app_abyssPrivate.vault.read(target);
    } catch {
      return { type: 'result', result: this.partialArchive_abyssPrivate(receipt, 'io-error') };
    }
    if (content === receipt.targetContentBefore) return { type: 'absent' };
    const occurrence = this.editor_abyssPrivate
      .rootBlocks(content)
      .some(
        (block) =>
          block.line === receipt.targetBlock.line && block.source === receipt.targetBlock.source,
      );
    return content === receipt.targetContentAfter && occurrence
      ? { type: 'proven' }
      : { type: 'result', result: this.partialArchive_abyssPrivate(receipt, 'conflict') };
  }

  private async resumeArchiveSource_abyssPrivate(
    ref: TaskRef,
    receipt: ArchiveReceipt,
  ): Promise<TaskRepositoryResult> {
    const source = this.app_abyssPrivate.vault.getAbstractFileByPath(ref.filePath);
    if (!(source instanceof TFile)) {
      this.archiveReceipts_abyssPrivate.delete(archiveReceiptKey(receipt.source));
      return this.committedArchive_abyssPrivate(ref, receipt.targetPath);
    }
    const sourceContent = await this.readMoveSource_abyssPrivate(source, ref.filePath);
    if (typeof sourceContent !== 'string') return sourceContent;
    const located = this.locator_abyssPrivate.locate(
      this.editor_abyssPrivate.rootBlocks(sourceContent),
      ref,
    );
    if (located.type !== 'exact') {
      return this.partialArchive_abyssPrivate(receipt, located.type);
    }
    if (located.block.source !== receipt.sourceBlock) {
      return this.partialArchive_abyssPrivate(receipt, 'conflict');
    }
    const current = this.snapshotFor_abyssPrivate(ref.filePath, sourceContent, located.block);
    if (current === undefined) return this.partialArchive_abyssPrivate(receipt, 'not-found');
    return await this.finishArchiveSource_abyssPrivate(current, receipt);
  }

  private async finishArchiveSource_abyssPrivate(
    source: TaskSnapshot,
    receipt: ArchiveReceipt,
  ): Promise<TaskRepositoryResult> {
    const sourceFailure = await this.removeMoveSource_abyssPrivate(source);
    if (sourceFailure !== undefined) {
      return this.partialArchive_abyssPrivate(
        receipt,
        sourceFailure.cause,
        sourceFailure.contentState === 'unknown' ? 'source-removal-unknown' : undefined,
      );
    }
    this.archiveReceipts_abyssPrivate.delete(archiveReceiptKey(receipt.source));
    return this.committedArchive_abyssPrivate(receipt.source, receipt.targetPath);
  }

  private committedArchive_abyssPrivate(ref: TaskRef, filePath: string): TaskRepositoryResult {
    return { type: 'committed', changed: true, outcome: { type: 'archived', ref, filePath } };
  }

  private partialArchive_abyssPrivate(
    receipt: ArchiveReceipt,
    cause: ArchiveRecovery['cause'],
    state: ArchiveRecovery['state'] = 'target-copied-source-remains',
  ): TaskRepositoryResult {
    return {
      type: 'partial',
      operation: 'archive',
      recovery: {
        source: receipt.source,
        targetPath: receipt.targetPath,
        state,
        cause,
      },
    };
  }

  private async readMoveSource_abyssPrivate(
    file: TFile,
    path: string,
    strict = false,
  ): Promise<string | TaskRepositoryResult> {
    try {
      const stamp = strict ? { ...file.stat } : undefined;
      const content = await this.app_abyssPrivate.vault.read(file);
      return stamp !== undefined && !sameNoteFileStamp(stamp, file.stat)
        ? { type: 'strict-rejected', reason: 'revision-changed' }
        : content;
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
    strictRoot?: TaskSnapshot,
  ): MoveSourceResolution {
    const evidence = this.authority_abyssPrivate?.evidence(ref.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.state_abyssPrivate?.currentRoot(ref.filePath, ref.line, evidence.source);
    const sourceBlocks = this.editor_abyssPrivate.rootBlocks(sourceContent);
    const confirmed =
      strictRoot !== undefined &&
      this.sourceRevisionIsCurrent_abyssPrivate(strictRoot, sourceBlocks)
        ? indexedRef
        : undefined;
    const sourceLocated = this.locator_abyssPrivate.locate(sourceBlocks, ref, confirmed);
    const preparedResult = preparedRevisionResult({
      prepared,
      located: sourceLocated,
      authorityCurrent: this.state_abyssPrivate?.authoritySuccessor?.(ref),
      locateAuthorityCurrent: (currentRef) =>
        this.locator_abyssPrivate.locate(sourceBlocks, currentRef),
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
      this.authority_abyssPrivate !== undefined,
      this.state_abyssPrivate !== undefined,
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
        result: notFound({ type: 'task', ref }),
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
    return current != null ? conflict(current) : notFound({ type: 'task', ref });
  }

  private unchangedMove_abyssPrivate(task: TaskSnapshot): TaskRepositoryResult {
    return committedTask(task, false);
  }

  private async finishMoveSource_abyssPrivate(
    sourceTask: TaskSnapshot,
    targetPath: string,
    targetResult: TaskRepositoryResult,
    project?: ProjectMove,
  ): Promise<TaskRepositoryResult> {
    if (targetResult.type !== 'committed' || targetResult.outcome.type !== 'task') {
      return targetResult;
    }
    const copiedTask = targetResult.outcome.task;
    const sourceFailure = await this.removeMoveSource_abyssPrivate(sourceTask, project);
    if (sourceFailure !== undefined) {
      return this.partialMove_abyssPrivate(
        sourceTask.ref,
        targetPath,
        copiedTask,
        sourceFailure.cause,
      );
    }
    return targetResult;
  }

  private async copyMoveTarget_abyssPrivate(input: MoveTargetInput): Promise<TaskRepositoryResult> {
    const project = input.project;
    if (project !== undefined) {
      const { sourceContent, remaining, sourceFile } = project;
      if (sourceContent === undefined || remaining === undefined || sourceFile === undefined)
        return conflict(input.sourceTask);
      await this.insertProjectRoot_abyssPrivate(
        {
          file: input.targetFile,
          phase: project.copy,
          peer: { file: sourceFile, content: sourceContent },
          check: (file, live, candidate) =>
            this.projectMoveSourceGuard_abyssPrivate(
              project,
              sourceFile,
              sourceContent,
              remaining,
            ) ?? project.destination.check(file, live, candidate),
        },
        input.destination,
        input.sourceBlock.source,
      );
      return project.copy.task !== undefined
        ? committedTask(project.copy.task, true)
        : conflict(input.sourceTask);
    }
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
      return this.rejectedMoveTargetResult_abyssPrivate(input, transaction);
    }
    const result = this.commitMoveTarget_abyssPrivate(input, transaction);
    this.retainCommittedArchiveTarget_abyssPrivate(input, transaction, result);
    return result;
  }

  private rejectedMoveTargetResult_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
  ): TaskRepositoryResult {
    if (!input.archive || transaction.insertedBlock === undefined) {
      return this.processError_abyssPrivate(input.destination.filePath);
    }
    const receipt = this.archiveReceiptForTransaction_abyssPrivate(input, transaction);
    if (receipt === undefined) return this.processError_abyssPrivate(input.destination.filePath);
    this.retainArchiveReceipt_abyssPrivate(receipt);
    return this.partialArchive_abyssPrivate(receipt, 'io-error');
  }

  private retainCommittedArchiveTarget_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
    result: TaskRepositoryResult,
  ): void {
    if (!input.archive || result.type !== 'committed' || result.outcome.type !== 'task') return;
    const receipt = this.archiveReceiptForTransaction_abyssPrivate(input, transaction);
    if (receipt !== undefined) this.retainArchiveReceipt_abyssPrivate(receipt);
  }

  private archiveReceiptForTransaction_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
  ): ArchiveReceipt | undefined {
    const targetBlock = transaction.insertedBlock;
    const targetContentBefore = transaction.originalContent;
    const targetContentAfter = transaction.committedContent;
    if (
      targetBlock === undefined ||
      targetContentBefore === undefined ||
      targetContentAfter === undefined
    )
      return undefined;
    return {
      source: input.archiveSource ?? input.sourceTask.ref,
      sourceBlock: input.sourceBlock.source,
      targetPath: input.destination.filePath,
      targetBlock,
      targetContentBefore,
      targetContentAfter,
    };
  }

  private copyMoveContent_abyssPrivate(
    input: MoveTargetInput,
    transaction: MoveTargetTransaction,
    content: string,
  ): string {
    transaction.originalContent = content;
    const inserted = this.editor_abyssPrivate.insertRootBlock(
      content,
      input.sourceBlock.source,
      input.destination.insertion,
    );
    if (inserted == null) {
      transaction.result = invalidTaskSyntax();
      return content;
    }
    transaction.insertedBlock = inserted.block;
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
      transaction.result = invalidTaskSyntax();
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
    const authority = this.authority_abyssPrivate;
    if (authority == null || this.state_abyssPrivate == null) return true;
    const revision = authority.successor(input.sourceTask.ref.revision, block.source);
    if (revision === undefined || revision.length === 0) {
      transaction.result = conflict(input.sourceTask);
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
      transaction.result = conflict(input.sourceTask);
      return false;
    }
    transaction.transition = staged.token;
    return true;
  }

  private abortMoveTransition_abyssPrivate(transaction: MoveTargetTransaction): void {
    if (transaction.transition != null) this.authority_abyssPrivate?.abort(transaction.transition);
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
    const installed = this.installTransition_abyssPrivate(
      input.destination.filePath,
      content,
      token,
    );
    return transaction.result?.type === 'committed'
      ? this.rebaseEditResult_abyssPrivate(transaction.result, installed)
      : (transaction.result ?? this.processError_abyssPrivate(input.destination.filePath));
  }

  private async removeMoveSource_abyssPrivate(
    sourceTask: TaskSnapshot,
    project?: ProjectMove,
  ): Promise<SourceRemovalFailure | undefined> {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(sourceTask.ref.filePath);
    if (!(file instanceof TFile)) return { cause: 'not-found', contentState: 'remains' };
    if (project !== undefined) return await this.removeProjectSource_abyssPrivate(project, file);
    const transaction: SourceRemovalTransaction = {};
    try {
      await this.processFile_abyssPrivate(file, (content) =>
        this.removeMoveSourceContent_abyssPrivate(sourceTask, transaction, content),
      );
    } catch {
      return await this.rejectedSourceRemoval_abyssPrivate(file, sourceTask, transaction);
    }
    if (transaction.committedContent === undefined || transaction.failure !== undefined) {
      return { cause: transaction.failure ?? 'io-error', contentState: 'remains' };
    }
    this.state_abyssPrivate?.installCommittedContent(
      sourceTask.ref.filePath,
      transaction.committedContent,
    );
    return undefined;
  }

  private projectMoveSourceGuard_abyssPrivate(
    project: ProjectMove,
    file: TFile,
    live: string,
    candidate: string,
  ): ReturnType<ProjectTaskGuard> {
    const { root } = project.source;
    if (
      this.state_abyssPrivate === undefined ||
      this.authority_abyssPrivate === undefined ||
      project.sourceFile !== file ||
      !this.isCurrentFile_abyssPrivate(file, root.ref.filePath) ||
      !this.sourceRevisionIsCurrent_abyssPrivate(root, this.editor_abyssPrivate.rootBlocks(live))
    )
      return 'stale';
    return project.source.check(file, live, candidate);
  }

  private async removeProjectSource_abyssPrivate(
    project: ProjectMove,
    file: TFile,
  ): Promise<SourceRemovalFailure | undefined> {
    const { copy, source, destination, removal } = project;
    const target = this.app_abyssPrivate.vault.getAbstractFileByPath(copy.path);
    const content = copy.content;
    if (!(target instanceof TFile) || content === undefined || copy.task === undefined)
      return { cause: 'conflict', contentState: 'remains' };
    await this.writeProjectPhase_abyssPrivate(
      {
        file,
        phase: removal,
        peer: { file: target, content },
        check: (actual, live, next) =>
          actual === file && this.projectCopyCurrent_abyssPrivate(destination, copy, target)
            ? this.projectMoveSourceGuard_abyssPrivate(project, file, live, next)
            : 'stale',
      },
      (live) => {
        const transaction: SourceRemovalTransaction = {};
        this.removeMoveSourceContent_abyssPrivate(source.root, transaction, live, true);
        if (transaction.committedContent === undefined) return;
        return {
          kind: 'remove',
          content: transaction.committedContent,
          line: source.root.ref.line,
        };
      },
    );
    return removal.effect === 'committed'
      ? undefined
      : { cause: 'conflict', contentState: removal.effect === 'unknown' ? 'unknown' : 'remains' };
  }

  private removeMoveSourceContent_abyssPrivate(
    sourceTask: TaskSnapshot,
    transaction: SourceRemovalTransaction,
    content: string,
    strict = false,
  ): string {
    const blocks = this.editor_abyssPrivate.rootBlocks(content);
    if (!this.sourceRevisionIsCurrent_abyssPrivate(sourceTask, blocks)) {
      transaction.failure = 'conflict';
      return content;
    }
    const located = this.locator_abyssPrivate.locate(
      blocks,
      sourceTask.ref,
      strict ? sourceTask.ref : undefined,
    );
    if (located.type !== 'exact') {
      transaction.failure = located.type;
      return content;
    }
    const current = this.snapshotFor_abyssPrivate(sourceTask.ref.filePath, content, located.block);
    const next =
      current === undefined
        ? undefined
        : this.editor_abyssPrivate.deleteRoot(content, located.block);
    if (next === undefined) {
      transaction.failure = 'not-found';
      return content;
    }
    transaction.committedContent = next;
    return next;
  }

  private sourceRevisionIsCurrent_abyssPrivate(
    sourceTask: TaskSnapshot,
    blocks: readonly TaskRootBlock[],
  ): boolean {
    if (this.authority_abyssPrivate === undefined || this.state_abyssPrivate === undefined) {
      return true;
    }
    const population = blocks
      .filter((block) => block.source === sourceTask.source.originalBlock)
      .map((block) => block.line);
    const current = this.state_abyssPrivate.currentRoot(
      sourceTask.ref.filePath,
      sourceTask.ref.line,
      sourceTask.source.originalBlock,
      population,
    );
    return current?.revision === sourceTask.ref.revision;
  }

  private async rejectedSourceRemoval_abyssPrivate(
    file: TFile,
    sourceTask: TaskSnapshot,
    transaction: SourceRemovalTransaction,
  ): Promise<SourceRemovalFailure | undefined> {
    if (transaction.committedContent === undefined) {
      return { cause: 'io-error', contentState: 'remains' };
    }
    await this.reconcileRejectedDeletion_abyssPrivate(
      file,
      sourceTask.ref.filePath,
      sourceTask.ref,
    );
    try {
      const authoritative = await this.app_abyssPrivate.vault.read(file);
      const located = this.locator_abyssPrivate.locate(
        this.editor_abyssPrivate.rootBlocks(authoritative),
        sourceTask.ref,
      );
      return located.type === 'not-found'
        ? undefined
        : { cause: 'io-error', contentState: 'remains' };
    } catch {
      return { cause: 'io-error', contentState: 'unknown' };
    }
  }

  async completeRecurrence(
    requestOrCommand: RecurrenceCompletionRevisionRequest | RecurrenceCompletionRequest,
  ): Promise<TaskRepositoryResult> {
    const revisionRequest = 'command' in requestOrCommand ? requestOrCommand : undefined;
    const request = 'command' in requestOrCommand ? requestOrCommand.command : requestOrCommand;
    const rootRef = rootRefOf(request.target);
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(rootRef.filePath);
    if (!(file instanceof TFile)) return notFound(request.target);
    const input: RecurrenceProcessInput = { revisionRequest, request, rootRef, fileIdentity: file };
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
    try {
      this.commitRecurrence_abyssPrivate(input, transaction);
    } finally {
      this.confirmStrictTransaction_abyssPrivate(transaction);
    }
    return transaction.result ?? this.processError_abyssPrivate(rootRef.filePath);
  }

  private completeRecurrenceContent_abyssPrivate(
    input: RecurrenceProcessInput,
    transaction: RecurrenceTransaction,
    content: string,
  ): string {
    const strict = this.checkStrictStatus_abyssPrivate(
      input.revisionRequest,
      input.fileIdentity,
      content,
      input.request.target,
    );
    if (strict !== undefined) {
      transaction.result = strict;
      return content;
    }
    const location = this.resolveRecurrenceLocation_abyssPrivate(input, content);
    if (location.type === 'result') {
      transaction.result = location.result;
      return content;
    }
    transaction.rollbackBasis = this.captureRollbackBasis_abyssPrivate(
      input.rootRef.filePath,
      content,
    );
    if (
      input.request.semanticTransition !== true &&
      this.codec_abyssPrivate.statusForSymbol(location.owner.statusSymbol) === 'done'
    ) {
      transaction.result = this.unchangedMove_abyssPrivate(location.current);
      return content;
    }
    const prepared = prepareRecurrenceCandidate({
      editor: this.editor_abyssPrivate,
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
    const evidence = this.authority_abyssPrivate?.evidence(rootRef.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.state_abyssPrivate?.currentRoot(rootRef.filePath, rootRef.line, evidence.source);
    const blocks = this.editor_abyssPrivate.rootBlocks(content);
    const located = this.locator_abyssPrivate.locate(blocks, rootRef);
    const revision = preparedRevisionResult({
      prepared: input.revisionRequest,
      located,
      authorityCurrent: this.state_abyssPrivate?.authoritySuccessor?.(rootRef),
      locateAuthorityCurrent: (currentRef) => this.locator_abyssPrivate.locate(blocks, currentRef),
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
      this.authority_abyssPrivate !== undefined,
      this.state_abyssPrivate !== undefined,
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
    return current != null ? conflict(current) : notFound(target);
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
      const result = current != null ? conflict(current) : notFound(input.request.target);
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
      !this.stageRecurrence_abyssPrivate(
        { process, location, prepared, coordinates, originalContent: unchangedContent },
        transaction,
      )
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
    const authority = this.authority_abyssPrivate;
    if (authority == null || this.state_abyssPrivate == null) return true;
    const staged = stageRootTransition({
      authority,
      editor: this.editor_abyssPrivate,
      filePath: process.rootRef.filePath,
      candidate: prepared.candidate,
      expectedRevision: process.rootRef.revision,
      currentRevision: location.indexedRevision,
      ...(authority.collectsOccurrences()
        ? {
            occurrences: (roots: readonly RootRevisionOverride[]) =>
              recurrenceOccurrenceWitnesses({
                before: location.current.ref,
                source: location.block.source,
                selectedOffset: location.relativeLine,
                roots,
                active: coordinates.active,
                completed: coordinates.completed,
                deletesCompleted: prepared.deletesCompleted,
              }),
          }
        : {}),
      ...(process.revisionRequest?.strictStatus === undefined
        ? {}
        : {
            operation: process.revisionRequest.strictStatus.operation,
            beforeStage: (roots: readonly RootRevisionOverride[]) => {
              transaction.confirmStrict = this.expectStrictRecurrence_abyssPrivate(input, roots);
            },
          }),
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
        : conflict(location.current);
    return false;
  }

  private expectStrictRecurrence_abyssPrivate(
    input: RecurrenceStageInput,
    roots: readonly RootRevisionOverride[],
  ): (() => void) | undefined {
    const { process, location, prepared, coordinates } = input;
    const request = process.revisionRequest;
    if (request?.strictStatus === undefined) return;
    const current = this.strictContext_abyssPrivate(request, input.originalContent);
    if (current === undefined) throw new Error('Missing strict source');
    const address = (coordinates: RecurrenceCoordinates['active']): TaskOccurrenceAddress => {
      const root = roots.find((root) => root.line === coordinates.rootLine);
      if (root === undefined) throw new Error('Missing strict occurrence');
      return {
        filePath: process.rootRef.filePath,
        rootRevision: root.revision,
        rootLine: root.line,
        nodeOffset: coordinates.targetRelativeLine,
      };
    };
    return request.strictStatus.expectCommit(current, prepared.candidate, {
      original: {
        before: {
          filePath: process.rootRef.filePath,
          rootRevision: process.rootRef.revision,
          rootLine: process.rootRef.line,
          nodeOffset: location.relativeLine,
        },
        ...(!prepared.deletesCompleted ? { after: address(coordinates.completed) } : {}),
      },
      next: address(coordinates.active),
    });
  }

  private recurrenceOutcome_abyssPrivate(
    path: string,
    prepared: PreparedRecurrence,
    coordinates: RecurrenceCoordinates,
  ): TaskRepositoryResult | undefined {
    const snapshots =
      this.state_abyssPrivate?.previewContent(path, prepared.candidate) ??
      this.parse_abyssPrivate(path, prepared.candidate);
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
      this.authority_abyssPrivate?.abort(transaction.transitionToken);
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
    this.installTransition_abyssPrivate(input.rootRef.filePath, content, token);
  }

  prepareRootEdit(root: TaskSnapshot): TaskPreparedRootEdit {
    const basis = this.capturePreparedRoot_abyssPrivate(root);
    if (basis === undefined) return { type: 'invalid', result: invalidTaskTarget('target') };
    return new MarkdownTaskEditPreparation(this.preparedRootPorts_abyssPrivate(basis)).prepare(
      basis.root,
      basis.content,
      (
        this.editor_abyssPrivate.ownedTaskSubtree(basis.root.source.originalBlock, 0)?.taskLines ??
        []
      ).map((offset) => ({ beforeOffset: offset, afterOffset: offset })),
    );
  }

  private preparedRootPorts_abyssPrivate(basis: PreparedRootBasis): PreparedRootPorts {
    return {
      apply: (content, current, command) =>
        this.previewRootEdit_abyssPrivate(content, current, command),
      commit: (content, after, nodeMap) =>
        this.commitPreparedRoot_abyssPrivate(basis, { content, after, nodeMap }),
      refresh: async (current, candidate) => {
        const fresh = await this.refreshPreparedRootBasis_abyssPrivate(basis, current);
        return fresh === undefined
          ? undefined
          : this.transplantPreparedRoot_abyssPrivate(fresh, candidate);
      },
    };
  }

  private async refreshPreparedRootBasis_abyssPrivate(
    basis: PreparedRootBasis,
    current: TaskSnapshot,
  ): Promise<PreparedRootBasis | undefined> {
    const proven = this.provenPreparedRoot_abyssPrivate(basis.root.ref);
    if (
      proven === undefined ||
      !sameTaskNodeRef({ type: 'task', ref: proven.ref }, { type: 'task', ref: current.ref })
    )
      return undefined;
    const fresh = this.capturePreparedRoot_abyssPrivate(current);
    if (fresh === undefined || !this.samePreparedRootBasis_abyssPrivate(basis, fresh))
      return undefined;
    return (await this.app_abyssPrivate.vault.read(fresh.file)) === fresh.content
      ? fresh
      : undefined;
  }

  private provenPreparedRoot_abyssPrivate(ref: TaskRef): TaskSnapshot | undefined {
    const resolution = this.options_abyssPrivate.preparedRootQueries?.resolve(ref);
    if (resolution?.type === 'exact') return resolution.task;
    if (resolution?.type === 'rebased' && resolution.basis.authorityTransition !== undefined)
      return resolution.current;
    return undefined;
  }

  private samePreparedRootBasis_abyssPrivate(
    basis: PreparedRootBasis,
    fresh: PreparedRootBasis,
  ): boolean {
    return (
      fresh.file === basis.file &&
      fresh.root.source.originalBlock === basis.root.source.originalBlock &&
      fresh.observation.scopeRevision === basis.observation.scopeRevision &&
      fresh.observation.semanticsRevision === basis.observation.semanticsRevision
    );
  }

  private transplantPreparedRoot_abyssPrivate(
    fresh: PreparedRootBasis,
    candidate: PreparedRootCandidate,
  ): PreparedRootRefresh {
    const block = this.editor_abyssPrivate
      .rootBlocks(fresh.content)
      .find((item) => item.line === fresh.root.ref.line);
    if (block === undefined) return undefined;
    const content =
      candidate.after === null
        ? this.editor_abyssPrivate.deleteRoot(fresh.content, block)
        : this.editor_abyssPrivate.replaceRootBlock(
            fresh.content,
            block,
            candidate.after.source.originalBlock,
          );
    if (
      content === undefined ||
      this.options_abyssPrivate.preparedRootSources?.candidate(fresh.source, fresh.content, content)
        .type !== 'ok'
    )
      return undefined;
    let after: TaskSnapshot | null = null;
    if (candidate.after !== null) {
      const nextBlock = this.editor_abyssPrivate
        .rootBlocks(content)
        .find((item) => item.line === fresh.root.ref.line);
      if (nextBlock === undefined) return undefined;
      const projected = this.snapshotFor_abyssPrivate(fresh.root.ref.filePath, content, nextBlock);
      if (projected === undefined) return undefined;
      after = this.versionPreparedSnapshot_abyssPrivate(projected);
    }
    return { ports: this.preparedRootPorts_abyssPrivate(fresh), content, after };
  }

  private capturePreparedRoot_abyssPrivate(root: TaskSnapshot): PreparedRootBasis | undefined {
    const sources = this.options_abyssPrivate.preparedRootSources;
    const reads = this.options_abyssPrivate.preparedRootReads;
    if (sources === undefined || reads === undefined) return undefined;
    const observation = reads.capture();
    const source = sources.get(root.ref.filePath);
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(root.ref.filePath);
    if (source.type !== 'ok' || source.value === undefined || !(file instanceof TFile))
      return undefined;
    const accepted = source.value.roots.find(
      (candidate) =>
        candidate.ref.line === root.ref.line &&
        candidate.ref.revision === root.ref.revision &&
        candidate.source.originalBlock === root.source.originalBlock,
    );
    if (accepted === undefined) return undefined;
    const basis: PreparedRootBasis = {
      root: structuredClone(accepted),
      content: source.value.content,
      source: source.value,
      file,
      observation,
    };
    return this.preparedRootCurrent_abyssPrivate(basis, basis.content) ? basis : undefined;
  }

  private previewRootEdit_abyssPrivate(
    content: string,
    root: TaskSnapshot,
    command: TaskEditCommand,
    initialStatus?: true,
  ): EditOutcome {
    const block = this.editor_abyssPrivate
      .rootBlocks(content)
      .find(
        (candidate) =>
          candidate.line === root.ref.line && candidate.source === root.source.originalBlock,
      );
    if (block === undefined) return { content, result: invalidTaskTarget('target') };
    const edit = this.applyLocatedEdit_abyssPrivate(
      {
        command,
        rootRef: root.ref,
        prepared: undefined,
        collectNodes: true,
        ...(initialStatus === undefined ? {} : { initialStatus }),
      },
      content,
      block,
    );
    if (edit.result.type !== 'committed' || edit.result.outcome.type !== 'task') return edit;
    return {
      ...edit,
      result: {
        ...edit.result,
        outcome: {
          type: 'task',
          task: edit.result.changed
            ? this.versionPreparedSnapshot_abyssPrivate(edit.result.outcome.task)
            : structuredClone(root),
        },
      },
    };
  }

  private versionPreparedSnapshot_abyssPrivate(root: TaskSnapshot): TaskSnapshot {
    const revision = `prepared:${++this.preparedSequence_abyssPrivate}:${root.ref.revision}`;
    return rebaseSnapshot(root, { ...root.ref, revision });
  }

  private preparedRootCurrent_abyssPrivate(basis: PreparedRootBasis, content: string): boolean {
    const current = this.options_abyssPrivate.preparedRootReads?.capture();
    return (
      current?.lifecycle === 'ready' &&
      current.scopeRevision === basis.observation.scopeRevision &&
      current.semanticsRevision === basis.observation.semanticsRevision &&
      content === basis.content &&
      this.isCurrentFile_abyssPrivate(basis.file, basis.root.ref.filePath) &&
      this.options_abyssPrivate.preparedRootSources?.matchesFile(basis.source, basis.file) ===
        true &&
      this.exactStrictRoot_abyssPrivate(basis.root, content)
    );
  }

  private preparedRootContent_abyssPrivate(
    prepared: {
      readonly basis: PreparedRootBasis;
      readonly candidate: string;
      readonly after: TaskSnapshot | null;
      readonly nodeMap: readonly TaskNodeLineMapping[] | undefined;
    },
    transaction: EditTransaction,
    content: string,
  ): string {
    const { basis, candidate, after } = prepared;
    if (
      !this.preparedRootCurrent_abyssPrivate(basis, content) ||
      this.options_abyssPrivate.preparedRootSources?.candidate(basis.source, content, candidate)
        .type !== 'ok'
    ) {
      transaction.result = invalidTaskTarget('target');
      return content;
    }
    const block = this.editor_abyssPrivate
      .rootBlocks(content)
      .find((item) => item.line === basis.root.ref.line);
    if (block === undefined) {
      transaction.result = invalidTaskTarget('target');
      return content;
    }
    const command: TaskEditCommand =
      after === null
        ? { type: 'delete', ref: basis.root.ref }
        : { type: 'patch', target: { type: 'task', ref: basis.root.ref }, patch: {} };
    const process: EditProcessInput = {
      command,
      rootRef: basis.root.ref,
      prepared: undefined,
      fileIdentity: basis.file,
    };
    const result: TaskRepositoryResult = {
      type: 'committed',
      changed: candidate !== content,
      outcome:
        after === null
          ? { type: 'deleted', ref: basis.root.ref }
          : { type: 'task', task: candidate === content ? basis.root : after },
    };
    transaction.result = result;
    if (!result.changed) return content;
    transaction.rollbackBasis = this.captureRollbackBasis_abyssPrivate(
      basis.root.ref.filePath,
      content,
    );
    transaction.committedContent = candidate;
    return this.stageEditTransition_abyssPrivate(
      {
        process,
        originalContent: content,
        location: { type: 'ready', block, indexedRevision: basis.root.ref.revision },
        edit: {
          content: candidate,
          result,
          ...(prepared.nodeMap === undefined ? {} : { nodeMap: prepared.nodeMap }),
        },
      },
      transaction,
    );
  }

  private async commitPreparedRoot_abyssPrivate(
    basis: PreparedRootBasis,
    candidate: {
      readonly content: string;
      readonly after: TaskSnapshot | null;
      readonly nodeMap: readonly TaskNodeLineMapping[] | undefined;
    },
  ): Promise<TaskRepositoryResult> {
    const { content, after, nodeMap } = candidate;
    const path = basis.root.ref.filePath;
    const transaction: EditTransaction = {
      result: undefined,
      transitionToken: undefined,
      committedContent: undefined,
    };
    const cleanupPolicy =
      after === null ? this.options_abyssPrivate.configuredTaskNotePath?.() : undefined;
    try {
      await this.processFile_abyssPrivate(
        basis.file,
        (live) =>
          this.preparedRootContent_abyssPrivate(
            { basis, candidate: content, after, nodeMap },
            transaction,
            live,
          ),
        async () => {
          this.commitEdit_abyssPrivate(path, transaction);
          await this.cleanupEmptyTaskNote_abyssPrivate(
            basis.file,
            path,
            cleanupPolicy,
            transaction,
          );
        },
      );
      return transaction.result ?? this.processError_abyssPrivate(path);
    } catch {
      await this.rejectMutation_abyssPrivate(basis.file, basis.root.ref, transaction);
      this.options_abyssPrivate.diagnostics?.({
        operation: after === null ? 'delete' : 'patch',
        phase: 'unexpected',
        cause: 'prepared-root-write',
      });
      let unchanged = false;
      try {
        unchanged =
          this.isCurrentFile_abyssPrivate(basis.file, path) &&
          (await this.app_abyssPrivate.vault.read(basis.file)) === basis.content;
      } catch {
        /* No readback proof means the write effect remains unknown. */
      }
      return {
        type: 'io-error',
        cause: 'process-failed',
        path,
        contentState: unchanged ? 'unchanged' : 'unknown',
      };
    }
  }

  async edit(request: TaskEditRequest | TaskEditCommand): Promise<TaskRepositoryResult> {
    if (
      'command' in request &&
      request.strictStatus !== undefined &&
      request.command.type !== 'set-status' &&
      request.command.type !== 'close-time-entry'
    )
      return { type: 'strict-rejected', reason: 'unsupported-precondition' };
    const prepared = 'command' in request ? request : undefined;
    const command: TaskEditCommand = 'command' in request ? request.command : request;
    const metadataIssues = [
      ...dependencyMetadataIssues(command),
      ...subtaskRestorationIssues(command),
    ];
    if (metadataIssues.length > 0) return invalidTaskResult(metadataIssues);
    const reorderIssue = this.reorderParentIssue_abyssPrivate(command);
    if (reorderIssue !== undefined) return reorderIssue;
    const rootRef = rootRefForCommand(command);
    const input: EditProcessInput = {
      prepared,
      command,
      rootRef,
      fileIdentity:
        this.app_abyssPrivate.vault.getAbstractFileByPath(rootRef.filePath) ?? undefined,
    };
    return this.processEdit_abyssPrivate(input, (transaction, content) =>
      this.editContent_abyssPrivate(input, transaction, content),
    );
  }

  private processEdit_abyssPrivate(
    input: EditProcessInput,
    transform: (transaction: EditTransaction, content: string) => string,
  ): Promise<TaskRepositoryResult> {
    return this.processEditTarget_abyssPrivate(
      mutationTarget(input.command),
      transform,
      (file, transaction) => this.rejectMutation_abyssPrivate(file, input.rootRef, transaction),
      input.command.type === 'delete'
        ? this.options_abyssPrivate.configuredTaskNotePath?.()
        : undefined,
    );
  }

  private async processEditTarget_abyssPrivate(
    target: TaskMutationTarget,
    transform: (transaction: EditTransaction, content: string) => string,
    reject: (file: TFile, transaction: EditTransaction) => Promise<void>,
    cleanupPolicy?: string,
  ): Promise<TaskRepositoryResult> {
    const path = rootRefOf(target).filePath;
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return notFound(target);
    const transaction: EditTransaction = {
      result: undefined,
      transitionToken: undefined,
      committedContent: undefined,
    };
    try {
      await this.processFile_abyssPrivate(
        file,
        (content) => transform(transaction, content),
        async () => {
          try {
            this.commitEdit_abyssPrivate(path, transaction);
            await this.cleanupEmptyTaskNote_abyssPrivate(file, path, cleanupPolicy, transaction);
          } finally {
            this.confirmStrictTransaction_abyssPrivate(transaction);
          }
        },
      );
    } catch {
      await reject(file, transaction);
      return this.processError_abyssPrivate(path);
    }
    return transaction.result ?? this.processError_abyssPrivate(path);
  }

  async editBatch(request: TaskEditBatchRequest): Promise<TaskRepositoryResult> {
    if (request.edits.some((edit) => edit.strictStatus !== undefined))
      return { type: 'strict-rejected', reason: 'unsupported-precondition' };
    const issues = taskEditBatchIssues(request);
    if (issues.length > 0) return invalidTaskResult(issues);
    return this.processEditTarget_abyssPrivate(
      request.outcomeTarget,
      (transaction, content) => this.editBatchContent_abyssPrivate(request, transaction, content),
      (file, transaction) => this.rejectBatch_abyssPrivate(file, request, transaction),
    );
  }

  hierarchy(request: TaskHierarchyRequest): Promise<TaskRepositoryResult> {
    if (request.source.strictStatus !== undefined || request.parent?.strictStatus !== undefined)
      return Promise.resolve({ type: 'strict-rejected', reason: 'unsupported-precondition' });
    return taskHierarchyTransaction(this.app_abyssPrivate, request, {
      authority: this.authority_abyssPrivate,
      state: this.state_abyssPrivate,
      editor: this.editor_abyssPrivate,
      parse: this.parse_abyssPrivate,
      processFile: (file, transform) => this.processFile_abyssPrivate(file, transform),
    });
  }

  reverseDependency(request: ReverseDependencyRequest): Promise<TaskRepositoryResult> {
    if (
      request.batches.some((batch) => batch.edits.some((edit) => edit.strictStatus !== undefined))
    )
      return Promise.resolve({ type: 'strict-rejected', reason: 'unsupported-precondition' });
    return reverseDependency(this.app_abyssPrivate, request, {
      authority: this.authority_abyssPrivate,
      state: this.state_abyssPrivate,
      parse: this.parse_abyssPrivate,
      processFile: (file, transform) => this.processFile_abyssPrivate(file, transform),
      capture: (path, content) => this.captureRollbackBasis_abyssPrivate(path, content),
      prepare: (batch, content) => this.prepareBatch_abyssPrivate(batch, content),
    });
  }

  async createDependencySubtask(
    request: CreateDependencySubtaskRequest,
  ): Promise<TaskRepositoryResult> {
    if (request.strictStatus !== undefined)
      return { type: 'strict-rejected', reason: 'unsupported-precondition' };
    const resolution = dependencySubtaskResolutionRequest(request);
    if (resolution === undefined) return invalidTaskTarget('subtask');
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
      this.state_abyssPrivate === undefined ? this.parse_abyssPrivate : undefined,
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
      this.authority_abyssPrivate,
      this.state_abyssPrivate,
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
    const prepared = this.prepareBatch_abyssPrivate(request, content);
    if (prepared.type !== 'prepared') {
      transaction.result = prepared;
      return content;
    }
    return this.stagePreparedRoots_abyssPrivate(request.filePath, prepared, transaction, content);
  }

  private prepareBatch_abyssPrivate(
    request: TaskEditBatchRequest,
    content: string,
  ): PreparedTaskEditBatch | TaskRepositoryResult {
    return prepareTaskEditBatch(request, content, {
      ...this.options_abyssPrivate,
      resolve: (edit) =>
        this.resolveEditLocation_abyssPrivate(
          { prepared: edit, command: edit.command, rootRef: edit.baseRoot.ref },
          content,
        ),
    });
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
      this.authority_abyssPrivate?.abort(transaction.transitionToken);
      for (const { baseRoot } of request.edits)
        this.state_abyssPrivate?.discardAuthoritySuccessor?.(baseRoot.ref);
    }
  }

  private reorderParentIssue_abyssPrivate(
    command: TaskEditCommand,
  ): TaskRepositoryResult | undefined {
    if (command.type !== 'reorder-subtask') return undefined;
    if (sameTaskNodeRef(command.subtask.parent, command.target.parent)) return undefined;
    return invalidTaskTarget('subtask-parent');
  }

  private editContent_abyssPrivate(
    input: EditProcessInput,
    transaction: EditTransaction,
    content: string,
  ): string {
    const strict = this.checkStrictStatus_abyssPrivate(
      input.prepared,
      input.fileIdentity,
      content,
      nodeTargetOf(input.command),
    );
    if (strict !== undefined) {
      transaction.result = strict;
      return content;
    }
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

  private strictContext_abyssPrivate(
    prepared: RevisionPrecondition,
    content: string,
  ): TaskStrictWriteContext | undefined {
    const target = prepared.baseTarget;
    if (target.type !== 'task' && target.type !== 'subtask') return undefined;
    const filePath = prepared.baseRoot.ref.filePath;
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return undefined;
    return { fileIdentity: file, filePath, content, root: prepared.baseRoot, target };
  }

  private checkStrictStatus_abyssPrivate(
    prepared: RevisionPrecondition | undefined,
    fileIdentity: object | undefined,
    content: string,
    target: TaskNodeRef | undefined,
  ): TaskRepositoryResult | undefined {
    if (prepared?.strictStatus === undefined) return undefined;
    if (this.authority_abyssPrivate === undefined || this.state_abyssPrivate === undefined)
      return { type: 'strict-rejected', reason: 'unsupported-precondition' };
    this.authority_abyssPrivate.activateOccurrences();
    const basis = this.strictContext_abyssPrivate(prepared, content);
    const current = basis === undefined || target === undefined ? undefined : { ...basis, target };
    if (current === undefined) return { type: 'strict-rejected', reason: 'source-unavailable' };
    return strictStatusPrecondition(
      prepared,
      current,
      fileIdentity === current.fileIdentity &&
        this.exactStrictRoot_abyssPrivate(prepared.baseRoot, content),
    );
  }

  private exactStrictRoot_abyssPrivate(root: TaskSnapshot, content: string): boolean {
    const blocks = this.editor_abyssPrivate.rootBlocks(content);
    const indexed = this.state_abyssPrivate?.currentRoot(
      root.ref.filePath,
      root.ref.line,
      root.source.originalBlock,
    );
    const located = this.locator_abyssPrivate.locate(blocks, root.ref, indexed);
    return (
      indexed?.revision === root.ref.revision &&
      located.type === 'exact' &&
      located.block.line === root.ref.line &&
      located.block.source === root.source.originalBlock
    );
  }

  private resolveEditLocation_abyssPrivate(input: EditProcessInput, content: string): EditLocation {
    const { rootRef } = input;
    const blocks = this.editor_abyssPrivate.rootBlocks(content);
    const evidence = this.authority_abyssPrivate?.evidence(rootRef.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.state_abyssPrivate?.currentRoot(
            rootRef.filePath,
            rootRef.line,
            evidence.source,
            blocks.filter((block) => block.source === evidence.source).map((block) => block.line),
          );
    const located = this.locator_abyssPrivate.locate(blocks, rootRef, indexedRef);
    if (hasUnconfirmedCurrentRoot(this.state_abyssPrivate, rootRef, evidence, indexedRef))
      return { type: 'result', result: this.editResolution_abyssPrivate(input, located, content) };
    const revision = preparedRevisionResult({
      prepared: input.prepared,
      located,
      authorityCurrent: this.state_abyssPrivate?.authoritySuccessor?.(rootRef),
      locateAuthorityCurrent: (currentRef) => this.locator_abyssPrivate.locate(blocks, currentRef),
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
      this.authority_abyssPrivate !== undefined,
      this.state_abyssPrivate !== undefined,
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
    return current != null ? conflict(current) : notFound(mutationTarget(input.command));
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
    const next = this.editor_abyssPrivate.deleteRoot(content, block);
    if (current == null || next === undefined) {
      return { result: notFound(mutationTarget(input.command)), content };
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
    const result = current != null ? conflict(current) : notFound(mutationTarget(input.command));
    return { result, content };
  }

  private editOrdinaryLine_abyssPrivate(input: LocatedEditInput): EditOutcome {
    const { process, content, block, relativeLine } = input;
    const sourceLine = content.split(/\r?\n/u)[block.line + relativeLine];
    if (
      sourceLine === undefined ||
      this.codec_abyssPrivate.parseLine(sourceLine, { filePath: '', line: 0 }) == null
    ) {
      return { result: notFound(mutationTarget(process.command)), content };
    }
    const edit = applyTaskCommand(this.codec_abyssPrivate, sourceLine, process.command);
    if (edit.type === 'invalid') return { result: edit, content };
    if (edit.type === 'unchanged') return this.unchangedLineEdit_abyssPrivate(input);
    const replaced = this.editor_abyssPrivate.replaceLine(
      content,
      block,
      relativeLine,
      edit.content,
      process.collectNodes ?? this.authority_abyssPrivate?.collectsOccurrences(),
    );
    const task = this.snapshotFor_abyssPrivate(
      process.rootRef.filePath,
      replaced.content,
      replaced.block,
    );
    return task == null
      ? { result: invalidTaskSyntax(), content }
      : {
          result: committedTask(task, true),
          content: replaced.content,
          ...(replaced.nodeMap === undefined ? {} : { nodeMap: replaced.nodeMap }),
        };
  }

  private unchangedLineEdit_abyssPrivate(input: LocatedEditInput): EditOutcome {
    const task = this.snapshotFor_abyssPrivate(
      input.process.rootRef.filePath,
      input.content,
      input.block,
    );
    const result =
      task != null ? committedTask(task, false) : notFound(mutationTarget(input.process.command));
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
    const authority = this.authority_abyssPrivate;
    const snapshotState = this.state_abyssPrivate;
    if (authority == null || snapshotState == null) return edit.content;
    const taskLine = edit.result.outcome.task.source.line;
    const surviving = this.editor_abyssPrivate
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
    transaction.result = invalidTaskSyntax();
    transaction.committedContent = undefined;
  }

  private expectStrictEdit_abyssPrivate(
    process: EditProcessInput,
    originalContent: string,
    candidate: string,
    witnesses: readonly TaskOccurrenceWitness[],
  ): (() => void) | undefined {
    const guard = process.prepared?.strictStatus;
    if (guard === undefined || process.prepared === undefined) return;
    const current = this.strictContext_abyssPrivate(process.prepared, originalContent);
    if (current === undefined) throw new Error('Missing strict source');
    return guard.expectCommit(
      current,
      candidate,
      process.command.type === 'set-status' ? strictStatusEffects(current, witnesses) : undefined,
    );
  }

  /** The canonical edit owns one root; its byte-identical prefix/suffix retain physical siblings. */
  private retainedEditSiblings_abyssPrivate(
    process: EditProcessInput,
    before: string,
    after: string,
  ): {
    readonly roots: readonly RootRevisionOverride[];
    readonly occurrences: readonly TaskOccurrenceWitness[];
  } {
    const none = { roots: [], occurrences: [] };
    const prior = this.state_abyssPrivate?.currentRoots?.(process.rootRef.filePath);
    const retained = this.editor_abyssPrivate.retainedRootLines(
      before,
      after,
      process.rootRef.line,
    );
    if (prior === undefined || retained === undefined) return none;
    const roots: RootRevisionOverride[] = [];
    const occurrences: TaskOccurrenceWitness[] = [];
    for (const pair of retained) {
      const old = prior.find(
        (root) => root.line === pair.before.line && root.source === pair.before.source,
      );
      if (old === undefined) return none;
      roots.push({ ...old, line: pair.after.line });
      occurrences.push(
        ...this.retainedRootWitnesses_abyssPrivate(old, pair.after.line, process.rootRef.filePath),
      );
    }
    return { roots, occurrences };
  }

  private retainedRootWitnesses_abyssPrivate(
    old: RootRevisionOverride,
    line: number,
    filePath: string,
  ): readonly TaskOccurrenceWitness[] {
    if (this.authority_abyssPrivate?.collectsOccurrences() !== true) return [];
    return editedOccurrenceWitnesses(
      { filePath, line: old.line, revision: old.revision },
      { filePath, line, revision: old.revision },
      (this.editor_abyssPrivate.ownedTaskSubtree(old.source, 0)?.taskLines ?? []).map((offset) => ({
        beforeOffset: offset,
        afterOffset: offset,
      })),
    );
  }

  private stageSurvivingEdit_abyssPrivate(
    input: SurvivingEditStageInput,
    transaction: EditTransaction,
  ): string {
    const { process, indexedRevision, edit, originalContent, surviving } = input;
    const authority = this.authority_abyssPrivate;
    if (authority == null) return edit.content;
    const revision = authority.successor(process.rootRef.revision, surviving.source);
    if (revision === undefined || revision.length === 0) {
      this.invalidateStagedEdit_abyssPrivate(transaction);
      return originalContent;
    }
    const completionTracking = completionTrackingWitness(input, revision);
    const witnesses = editedOccurrenceWitnesses(
      process.rootRef,
      { filePath: process.rootRef.filePath, line: surviving.line, revision },
      edit.nodeMap ?? [],
    );
    transaction.confirmStrict = this.expectStrictEdit_abyssPrivate(
      process,
      originalContent,
      edit.content,
      witnesses,
    );

    const retained = this.retainedEditSiblings_abyssPrivate(process, originalContent, edit.content);
    const staged = authority.stage(
      {
        retainedRoots: retained.roots,
        filePath: process.rootRef.filePath,
        candidateFingerprint: taskRefContentFingerprint(edit.content),
        candidateLength: edit.content.length,
        ...(process.prepared?.strictStatus === undefined
          ? {}
          : { operation: process.prepared.strictStatus.operation }),
        occurrences: [
          ...retained.occurrences,
          ...(edit.nodeMap === undefined
            ? []
            : editedOccurrenceWitnesses(
                process.rootRef,
                { filePath: process.rootRef.filePath, line: surviving.line, revision },
                edit.nodeMap,
              )),
        ],
        expectedRevision: process.rootRef.revision,
        roots: [
          {
            line: surviving.line,
            source: surviving.source,
            revision,
            ...(completionTracking === undefined ? {} : { completionTracking }),
          },
        ],
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
    const authority = this.authority_abyssPrivate;
    if (authority === undefined || this.state_abyssPrivate === undefined) return input.edit.content;
    transaction.confirmStrict = this.expectStrictEdit_abyssPrivate(
      input.process,
      input.originalContent,
      input.edit.content,
      editedOccurrenceWitnesses(
        input.process.rootRef,
        input.process.rootRef,
        removedSubtreeNodeMap(input.location.block.source, 0),
      ),
    );
    const retained = this.retainedEditSiblings_abyssPrivate(
      input.process,
      input.originalContent,
      input.edit.content,
    );
    const staged = authority.stage(
      {
        retainedRoots: retained.roots,
        ...(input.process.prepared?.strictStatus === undefined
          ? {}
          : { operation: input.process.prepared.strictStatus.operation }),
        filePath: input.process.rootRef.filePath,
        candidateFingerprint: taskRefContentFingerprint(input.edit.content),
        candidateLength: input.edit.content.length,
        ...(authority.collectsOccurrences()
          ? {
              occurrences: [
                ...retained.occurrences,
                ...editedOccurrenceWitnesses(
                  input.process.rootRef,
                  input.process.rootRef,
                  removedSubtreeNodeMap(input.location.block.source, 0),
                ),
              ],
            }
          : {}),
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
    const current = this.state_abyssPrivate
      ?.previewContent(input.rootRef.filePath, content)
      .find((task) => task.ref.revision === input.rootRef.revision);
    return current != null ? conflict(current) : notFound(mutationTarget(input.command));
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

  private confirmStrictTransaction_abyssPrivate(transaction: EditTransaction): void {
    const confirm = transaction.confirmStrict;
    transaction.confirmStrict = undefined;
    if (
      transaction.result?.type === 'committed' &&
      transaction.result.changed &&
      transaction.committedContent !== undefined
    )
      confirm?.();
  }

  private commitEdit_abyssPrivate(path: string, transaction: EditTransaction): void {
    const result = transaction.result;
    const content = transaction.committedContent;
    if (result?.type !== 'committed' || !result.changed || content === undefined) return;
    const installed = this.installTransition_abyssPrivate(
      path,
      content,
      transaction.transitionToken,
    );
    transaction.result = this.rebaseEditResult_abyssPrivate(result, installed);
  }

  private installTransition_abyssPrivate(
    path: string,
    content: string,
    token: object | undefined,
  ): readonly TaskSnapshot[] | undefined {
    if (token !== undefined) this.authority_abyssPrivate?.commit(token);
    const installed = this.state_abyssPrivate?.installCommittedContent(path, content);
    if (token !== undefined) this.authority_abyssPrivate?.acknowledge(path, content);
    return installed;
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
          ? withTimeEntryRemovalRecovery(rebased, result.outcome)
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
        result: current != null ? conflict(current) : notFound(mutationTarget(command)),
        content,
      };
    }
    if (this.structuralOwnershipConflict_abyssPrivate(command, node)) {
      return { result: conflict(current), content };
    }
    const prepared = this.prepareStructuralCommand_abyssPrivate(command, content);
    if ('result' in prepared) return prepared;
    const edited = this.editor_abyssPrivate.edit(
      content,
      block,
      blockTarget(node, block, relativeLine),
      structuralEdit(prepared),
      input.process.collectNodes ?? this.authority_abyssPrivate?.collectsOccurrences(),
    );
    const outcome = this.structuralEditOutcome_abyssPrivate(
      input.process.rootRef.filePath,
      content,
      current,
      edited,
    );
    return {
      ...outcome,
      result: recoverTimeEntryRemoval(
        command,
        edited,
        recoverSubtaskRemoval(command, edited, outcome.result),
      ),
    };
  }

  private structuralOwnershipConflict_abyssPrivate(
    command: StructuralTaskEditCommand,
    node: TaskSnapshot | SubtaskSnapshot,
  ): boolean {
    if (command.type === 'restore-subtask') return !subtaskRestorationGapIsCurrent(command, node);
    if (command.type === 'update-comment' || command.type === 'delete-comment') {
      return !ownsComment(node, command.comment);
    }
    if (command.type === 'close-time-entry' || command.type === 'delete-time-entry') {
      return !ownsTimeEntry(node, command.entry);
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
    const created = createTaskBlock(this.codec_abyssPrivate, {
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
      result: invalidTaskTarget('subtask'),
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
      return { result: conflict(current), content };
    }
    if (edited.type === 'invalid') {
      return {
        result: invalidTaskTarget(edited.field),
        content,
      };
    }
    if (edited.type === 'unchanged') {
      return {
        result: committedTask(current, false),
        content,
      };
    }
    const task = this.snapshotFor_abyssPrivate(path, edited.content, edited.block);
    return task != null
      ? {
          result: committedTask(task, true),
          content: edited.content,
          ...(edited.nodeMap === undefined ? {} : { nodeMap: edited.nodeMap }),
        }
      : {
          result: invalidTaskSyntax(),
          content,
        };
  }

  private deleteOnCompletion_abyssPrivate(input: LocatedEditInput): EditOutcome | undefined {
    const { command } = input.process;
    if (command.type !== 'set-status' || input.process.initialStatus === true) return undefined;
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
      this.codec_abyssPrivate.statusForSymbol(command.symbol) === 'done'
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
      : this.codec_abyssPrivate.parseLine(source, { filePath: path, line });
  }

  private deleteCompletedRoot_abyssPrivate(
    content: string,
    block: TaskRootBlock,
    current: TaskSnapshot,
  ): EditOutcome {
    const next = this.editor_abyssPrivate.deleteRoot(content, block);
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
    const next = this.editor_abyssPrivate.replaceOwnedTaskSubtree(content, block, relativeLine, []);
    if (next === undefined) {
      return { result: invalidRecurrence('invalid-task-syntax'), content };
    }
    const updatedBlock = this.editor_abyssPrivate
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
      result: committedTask(root, true),
      content: next,
      ...(this.authority_abyssPrivate?.collectsOccurrences() === true
        ? { nodeMap: removedSubtreeNodeMap(block.source, relativeLine) }
        : {}),
    };
  }

  private async processFile_abyssPrivate(
    file: TFile,
    transform: (content: string) => string,
    afterProcess?: () => Promise<void>,
    beforeProcess?: () => Promise<void>,
  ): Promise<void> {
    const path = file.path;
    const work = async (): Promise<void> => {
      if (beforeProcess !== undefined) await beforeProcess();
      if (!this.isCurrentFile_abyssPrivate(file, path))
        throw new Error('Task file identity changed');
      await this.app_abyssPrivate.vault.process(file, transform);
      await afterProcess?.();
    };
    await runTaskFileMutation(this.app_abyssPrivate, path, work);
  }

  private isCurrentFile_abyssPrivate(file: TFile, path: string): boolean {
    return file.path === path && this.app_abyssPrivate.vault.getAbstractFileByPath(path) === file;
  }

  private async cleanupEmptyTaskNote_abyssPrivate(
    file: TFile,
    path: string,
    policy: string | undefined,
    transaction: EditTransaction,
  ): Promise<void> {
    const candidate = this.emptyNoteCandidate_abyssPrivate(transaction);
    if (
      candidate === undefined ||
      !configuredTaskNote(policy, path) ||
      !this.cleanupIdentityIsCurrent_abyssPrivate(file, path, policy)
    )
      return;
    let cause: 'read-failed' | 'removal-unconfirmed' = 'read-failed';
    try {
      const fresh = await this.app_abyssPrivate.vault.read(file);
      if (fresh !== candidate || !this.cleanupIdentityIsCurrent_abyssPrivate(file, path, policy))
        return;
      cause = 'removal-unconfirmed';
      await this.app_abyssPrivate.fileManager.trashFile(file);
      if (this.app_abyssPrivate.vault.getAbstractFileByPath(path) !== file) return;
    } catch {
      if (cause === 'read-failed' && !this.isCurrentFile_abyssPrivate(file, path)) return;
      // Task deletion is committed; only cleanup failed. Never retry the task command.
    }
    this.recordCleanupWarning_abyssPrivate(transaction, path, cause);
  }

  private emptyNoteCandidate_abyssPrivate(transaction: EditTransaction): string | undefined {
    const result = transaction.result;
    const candidate = transaction.committedContent;
    return result?.type === 'committed' &&
      result.changed &&
      result.outcome.type === 'deleted' &&
      candidate !== undefined &&
      emptyTaskNote(candidate)
      ? candidate
      : undefined;
  }

  private cleanupIdentityIsCurrent_abyssPrivate(
    file: TFile,
    path: string,
    policy: string | undefined,
  ): boolean {
    return (
      this.isCurrentFile_abyssPrivate(file, path) &&
      this.options_abyssPrivate.configuredTaskNotePath?.() === policy
    );
  }

  private recordCleanupWarning_abyssPrivate(
    transaction: EditTransaction,
    path: string,
    cause: 'read-failed' | 'removal-unconfirmed',
  ): void {
    const result = transaction.result;
    if (result?.type !== 'committed' || result.outcome.type !== 'deleted') return;
    transaction.result = {
      ...result,
      outcome: { ...result.outcome, noteCleanupWarning: { cause, path } },
    };
    try {
      this.options_abyssPrivate.diagnostics?.({
        operation: 'delete',
        phase: 'empty-note-cleanup',
        path,
        cause,
      });
    } catch {
      console.error('[abyss-tasks] Cleanup diagnostic failed', {
        phase: 'empty-note-cleanup',
        path,
        cause,
      });
    }
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
        result: current != null ? conflict(current) : notFound(mutationTarget(command)),
        content,
      };
    }
    const target = this.resolveTextEditTarget_abyssPrivate(input, command, targetNode);
    if (target.type === 'conflict') return { result: conflict(current), content };
    if (target.type === 'invalid') {
      return {
        result: invalidTaskTarget('link'),
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
    const editResult = this.codec_abyssPrivate.editTextLinkAt(source, target, command.replacement);
    if (editResult.type === 'conflict') return { result: conflict(current), content };
    if (editResult.type === 'invalid') return { result: editResult, content };
    if (editResult.type === 'unchanged') {
      return {
        result: committedTask(current, false),
        content,
      };
    }
    const replaced = this.editor_abyssPrivate.replaceLine(
      content,
      block,
      target.relativeLine,
      editResult.content,
      this.authority_abyssPrivate?.collectsOccurrences(),
    );
    const task = this.snapshotFor_abyssPrivate(
      input.process.rootRef.filePath,
      replaced.content,
      replaced.block,
    );
    return task != null
      ? {
          result: committedTask(task, true),
          content: replaced.content,
          ...(replaced.nodeMap === undefined ? {} : { nodeMap: replaced.nodeMap }),
        }
      : {
          result: invalidTaskSyntax(),
          content,
        };
  }

  private resolveTextEditTarget_abyssPrivate(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
    node: TaskSnapshot | SubtaskSnapshot,
  ): TextEditTarget {
    if (command.target.type === 'comment') {
      return this.editor_abyssPrivate.commentLink(
        input.content,
        input.block,
        blockTarget(node, input.block, input.relativeLine),
        command.target.ref,
        command.occurrence,
      );
    }
    if (command.target.type !== 'description') return { type: 'invalid' };
    return this.editor_abyssPrivate.descriptionLink(
      input.content,
      input.block,
      blockTarget(node, input.block, input.relativeLine),
      command.occurrence,
    );
  }

  private snapshotFor_abyssPrivate(
    path: string,
    content: string,
    block: TaskRootBlock,
  ): TaskSnapshot | undefined {
    const snapshot = (
      this.state_abyssPrivate?.previewContent(path, content) ??
      this.parse_abyssPrivate(path, content)
    ).find((candidate) => candidate.source.line === block.line);
    if (snapshot == null) return undefined;
    if (this.state_abyssPrivate != null) return snapshot;
    const ref: TaskRef = {
      filePath: path,
      line: block.line,
      revision: this.locator_abyssPrivate.revision(block.source),
    };
    return rebaseSnapshot(snapshot, ref);
  }

  private candidateForTarget_abyssPrivate(
    block: TaskRootBlock,
    target: TaskMutationTarget,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshotFor_abyssPrivate(path, content, block);
    return root != null ? { root, target: rebaseNode(target, root.ref) } : undefined;
  }

  private resolutionResultForTarget_abyssPrivate(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    target: TaskMutationTarget,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') return notFound(target);
    if (located.type === 'conflict') {
      const current = this.snapshotFor_abyssPrivate(path, content, located.block);
      return current != null ? conflict(current) : notFound(target);
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateForTarget_abyssPrivate(block, target, path, content);
      return candidate != null ? [candidate] : [];
    });
    return candidates.length > 0 ? { type: 'ambiguous', candidates } : notFound(target);
  }

  private resolutionResult_abyssPrivate(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    command: TaskEditCommand,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    return this.resolutionResultForTarget_abyssPrivate(
      located,
      mutationTarget(command),
      path,
      content,
    );
  }

  private resolutionResultForRef_abyssPrivate(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    ref: TaskRef,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') {
      return notFound({ type: 'task', ref });
    }
    if (located.type === 'conflict') {
      const current = this.snapshotFor_abyssPrivate(ref.filePath, content, located.block);
      return current != null ? conflict(current) : notFound({ type: 'task', ref });
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
    if (this.state_abyssPrivate == null) return;
    try {
      const authoritative = await this.app_abyssPrivate.vault.read(file);
      this.state_abyssPrivate.installCommittedContent(path, authoritative);
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
    const authority = this.authority_abyssPrivate;
    if (authority == null || this.state_abyssPrivate == null) {
      authority?.abort(token);
      await this.reconcileAfterRejection_abyssPrivate(file, path);
      return;
    }

    const invalidate = authority.hasRetainedRoots(token)
      ? this.state_abyssPrivate.captureRejectedSourceInvalidation?.(path, file)
      : undefined;
    let authoritative: string;
    try {
      authoritative = await this.app_abyssPrivate.vault.read(file);
    } catch {
      authority.abort(token);
      this.state_abyssPrivate.discardAuthoritySuccessor?.(consumed);
      invalidate?.();
      return;
    }
    try {
      this.restoreOwnedTransition_abyssPrivate(path, authoritative, token);
    } finally {
      authority.abort(token);
      this.state_abyssPrivate.discardAuthoritySuccessor?.(consumed);
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
    const authority = this.authority_abyssPrivate;
    const snapshotState = this.state_abyssPrivate;
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
    const authority = this.authority_abyssPrivate;
    const snapshotState = this.state_abyssPrivate;
    if (authority == null || snapshotState == null) return undefined;
    const evidence = authority.evidence(consumed.revision);
    if (evidence === undefined) return undefined;
    const current = snapshotState.currentRoot(path, consumed.line, evidence.source);
    if (current?.revision === consumed.revision) return undefined;
    const located = this.locator_abyssPrivate.locate(
      this.editor_abyssPrivate.rootBlocks(authoritative),
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
    const authority = this.authority_abyssPrivate;
    const state = this.state_abyssPrivate;
    if (authority === undefined || state === undefined) return undefined;
    const blocks = this.editor_abyssPrivate.rootBlocks(content);
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
      this.authority_abyssPrivate?.retainPredecessors(
        transitionToken,
        rollbackBasis.content,
        rollbackBasis.roots,
      );
  }

  private restoreOwnedTransition_abyssPrivate(path: string, content: string, token: object): void {
    const authority = this.authority_abyssPrivate;
    const state = this.state_abyssPrivate;
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
