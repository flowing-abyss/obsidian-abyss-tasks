import { parseLinks } from '../../src/markdown/links';
import {
  dependencyMetadataIssues,
  subtaskRestorationGapIsCurrent,
  subtaskRestorationIssues,
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
} from '../../src/tasks/application/TaskRepository';
import type {
  PlanningTarget,
  TaskOccurrenceResult,
  TaskResolutionCandidate,
} from '../../src/tasks/domain/commands';
import {
  nextOccurrencePlanning,
  parseRecurrenceRule,
  type RecurrenceIssueCode,
} from '../../src/tasks/domain/recurrence';
import {
  prepareRecurrenceIteration,
  recurrenceMarkerCountInOwnedSubtree,
} from '../../src/tasks/domain/recurrenceIteration';
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
} from '../../src/tasks/domain/types';
import { sameTaskNodeRef } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { applyTaskCommand } from '../../src/tasks/infrastructure/markdown/applyTaskCommand';
import { createTaskBlock } from '../../src/tasks/infrastructure/markdown/createTaskBlock';
import { recoverSubtaskRemoval } from '../../src/tasks/infrastructure/markdown/subtaskRemovalRecovery';
import {
  TaskBlockEditor,
  type TaskBlockEdit,
} from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { type TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import {
  prepareTaskEditBatch,
  stageTaskEditBatch,
  taskEditBatchIssues,
} from '../../src/tasks/infrastructure/TaskEditBatch';
import {
  taskRefContentFingerprint,
  type RootRevisionOverride,
  type TaskRefAuthority,
  type TaskSnapshotState,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { expectDefined } from './../helpers';

type LocateResult = ReturnType<TaskLocator['locate']>;

function preparedRevisionResult(
  ...[prepared, located, authorityCurrent, locateAuthorityCurrent, snapshot]: readonly [
    prepared: RevisionPrecondition | undefined,
    located: LocateResult,
    authorityCurrent: TaskRef | undefined,
    locateAuthorityCurrent: (ref: TaskRef) => LocateResult,
    snapshot: (line: number) => TaskSnapshot | undefined,
  ]
): TaskRepositoryResult | undefined {
  if (prepared == null) return undefined;
  if (located.type === 'conflict') {
    if (authorityCurrent != null && authorityCurrent.revision !== prepared.baseRoot.ref.revision) {
      const authoritative = locateAuthorityCurrent(authorityCurrent);
      if (authoritative.type === 'exact') {
        const current = snapshot(authoritative.block.line);
        if (current != null) {
          return {
            type: 'rebased',
            previous: prepared.baseRoot,
            current,
            evidence: 'authority-transition',
          };
        }
      }
    }
    return { type: 'uncertain', target: prepared.baseTarget };
  }
  if (located.type !== 'exact' || located.block.line === prepared.baseRoot.ref.line)
    return undefined;
  const current = snapshot(located.block.line);
  return current != null
    ? {
        type: 'rebased',
        previous: prepared.baseRoot,
        current,
        evidence: 'byte-identical-relocation',
      }
    : { type: 'not-found', target: prepared.baseTarget };
}

interface Options {
  readonly files: Record<string, string>;
  readonly codec: TaskMarkdownCodec;
  readonly snapshotsFromContent: (path: string, content: string) => readonly TaskSnapshot[];
  readonly editor?: TaskBlockEditor;
  readonly locator?: TaskLocator;
  readonly refAuthority?: TaskRefAuthority;
  readonly snapshotState?: TaskSnapshotState;
}

function rootRef(target: PlanningTarget): TaskRef {
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') node = node.ref.parent;
  return node.ref;
}

function directNodeTarget(command: TaskEditCommand): PlanningTarget | undefined {
  if (
    command.type === 'patch' ||
    command.type === 'set-status' ||
    command.type === 'append-title' ||
    command.type === 'set-dependency-id' ||
    command.type === 'set-depends-on'
  ) {
    return command.target;
  }
  return undefined;
}

function childNodeTarget(command: TaskEditCommand): PlanningTarget | undefined {
  if (command.type === 'add-subtask' || command.type === 'restore-subtask') return command.parent;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return command.subtask.parent;
  }
  return undefined;
}

function commentNodeTarget(command: TaskEditCommand): PlanningTarget | undefined {
  if (command.type === 'add-comment') return command.parent;
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return command.comment.parent;
  }
  return undefined;
}

function nodeTarget(command: TaskEditCommand): PlanningTarget | undefined {
  const direct = directNodeTarget(command);
  if (direct !== undefined) return direct;
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target.ref.parent : command.target.target;
  }
  if (command.type === 'set-description') return command.target;
  return childNodeTarget(command) ?? commentNodeTarget(command);
}

function commandRootRef(command: TaskEditCommand): TaskRef {
  const target = nodeTarget(command);
  if (target != null) return rootRef(target);
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

function confirmedLine(target: PlanningTarget, block: string): number | undefined {
  if (target.type === 'task') return 0;
  const rootLines = block.split(/\r?\n/u);
  let line = 0;
  for (const child of childChain(target)) {
    line += child.relativeLine;
    const expected = child.originalBlock.split(/\r?\n/u).map(legacyLine);
    if (rootLines.slice(line, line + expected.length).join('\n') !== expected.join('\n')) {
      return undefined;
    }
  }
  return line;
}

function directMutationTarget(command: TaskEditCommand): TaskMutationTarget | undefined {
  const direct = directNodeTarget(command);
  return direct;
}

function childMutationTarget(command: TaskEditCommand): TaskMutationTarget | undefined {
  if (command.type === 'add-subtask' || command.type === 'restore-subtask') return command.parent;
  if (command.type === 'delete-subtask' || command.type === 'reorder-subtask') {
    return { type: 'subtask', ref: command.subtask };
  }
  return undefined;
}

function commentMutationTarget(command: TaskEditCommand): TaskMutationTarget | undefined {
  if (command.type === 'add-comment') return command.parent;
  if (command.type === 'update-comment' || command.type === 'delete-comment') {
    return { type: 'comment', ref: command.comment };
  }
  return undefined;
}

function targetOf(command: TaskEditCommand): TaskMutationTarget {
  const direct = directMutationTarget(command);
  if (direct !== undefined) return direct;
  if (command.type === 'edit-link') {
    return command.target.type === 'comment' ? command.target : command.target.target;
  }
  if (command.type === 'set-description') return command.target;
  const child = childMutationTarget(command);
  if (child !== undefined) return child;
  const comment = commentMutationTarget(command);
  if (comment !== undefined) return comment;
  return { type: 'task', ref: commandRootRef(command) };
}

function snapshotNode(
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

function blockTarget(
  node: TaskSnapshot | SubtaskSnapshot,
  rootBlockLength: number,
  relativeLine: number,
) {
  const lineCount =
    'source' in node ? rootBlockLength : node.ref.originalBlock.split(/\r?\n/u).length;
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

function isStructuralCommand(command: TaskEditCommand): command is Extract<
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
> {
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

function structuralEdit(
  command: Extract<
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
  >,
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

function commentLine(
  parentLine: number,
  comment: CommentRef,
  lines: readonly string[],
): number | undefined {
  const line = parentLine + comment.relativeLine;
  return lines[line] === legacyLine(comment.originalMarkdown) ? line : undefined;
}

function rebaseNode(node: TaskNodeRef, root: TaskRef): TaskNodeRef {
  if (node.type === 'task') return { type: 'task', ref: root };
  return {
    type: 'subtask',
    ref: { ...node.ref, parent: rebaseNode(node.ref.parent, root) },
  };
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
  const root = expectDefined(roots[0]);
  if (targetRelativeLine === 0) {
    return { root, target: { type: 'task', ref: root.ref } };
  }
  const target = accumulatedSubtaskAt(root, targetRelativeLine);
  return target != null ? { root, target } : undefined;
}

function lineCount(source: string): number {
  return source.split(/\r?\n/u).length;
}

function invalidRecurrence(
  code: RecurrenceIssueCode | 'invalid-task-syntax',
): TaskRepositoryResult {
  return { type: 'invalid', issues: [{ code, field: 'recurrence' }] };
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

type TaskRootBlock = ReturnType<TaskBlockEditor['rootBlocks']>[number];

interface MoveInput {
  readonly prepared: TaskMoveRequest | undefined;
  readonly ref: TaskRef;
  readonly destination: TaskDestination;
}

type MoveSourceResolution =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly content: string;
      readonly block: TaskRootBlock;
      readonly current: TaskSnapshot;
      readonly indexedRevision: string;
    };

type MoveTransition =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | { readonly type: 'ready'; readonly token: object | undefined };

interface InsertedMove {
  readonly content: string;
  readonly block: TaskRootBlock;
}

interface MoveCommitInput {
  readonly input: MoveInput;
  readonly inserted: InsertedMove;
  readonly copiedTask: TaskSnapshot;
  readonly sourceWithoutTask: string;
  readonly transitionToken: object | undefined;
}

function normalizeMoveInput(
  request: TaskMoveRequest | TaskRef,
  legacyDestination: TaskDestination | undefined,
): MoveInput | undefined {
  if ('baseRoot' in request) {
    return { prepared: request, ref: request.baseRoot.ref, destination: request.destination };
  }
  return legacyDestination === undefined
    ? undefined
    : { prepared: undefined, ref: request, destination: legacyDestination };
}

function authorityRevisionChanged(
  authority: TaskRefAuthority | undefined,
  snapshotState: TaskSnapshotState | undefined,
  indexedRevision: string | undefined,
  expectedRevision: string,
): boolean {
  return authority != null && snapshotState != null && indexedRevision !== expectedRevision;
}

interface RecurrenceInput {
  readonly revisionRequest: RecurrenceCompletionRevisionRequest | undefined;
  readonly request: RecurrenceCompletionRequest;
  readonly ref: TaskRef;
}

type RecurrenceLocation =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly content: string;
      readonly block: TaskRootBlock;
      readonly current: TaskSnapshot;
      readonly owner: TaskSnapshot | SubtaskSnapshot;
      readonly relativeLine: number;
      readonly indexedRevision: string;
    };

interface RecurrenceCandidate {
  readonly candidate: string;
  readonly deletesCompleted: boolean;
  readonly cleanFirst: boolean;
  readonly cleanOffset: number;
  readonly completedOffset: number;
  readonly nestedOwner: boolean;
  readonly activeRootLine: number;
  readonly completedRootLine: number;
}

type PreparedRecurrence =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | { readonly type: 'ready'; readonly candidate: RecurrenceCandidate };

type RecurrenceTransition =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | { readonly type: 'ready'; readonly token: object | undefined };

interface RecurrenceOccurrences {
  readonly active: TaskOccurrenceResult;
  readonly completed: TaskOccurrenceResult | undefined;
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

interface EditInput {
  readonly prepared: TaskEditRequest | undefined;
  readonly command: TaskEditCommand;
  readonly ref: TaskRef;
}

type EditLocation =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | {
      readonly type: 'ready';
      readonly content: string;
      readonly block: TaskRootBlock;
    };

type TextEditLocation =
  | { readonly type: 'conflict' }
  | { readonly type: 'invalid' }
  | { readonly type: 'ready'; readonly line: number; readonly occurrence: number };

type SurvivingRootTransition =
  | { readonly type: 'result'; readonly result: TaskRepositoryResult }
  | { readonly type: 'ready'; readonly token: object | undefined };

interface LocatedEditInput {
  readonly process: EditInput;
  readonly content: string;
  readonly block: TaskRootBlock;
  readonly relativeLine: number;
  readonly target: PlanningTarget | undefined;
}

function recurrenceRequestInput(
  requestOrCommand: RecurrenceCompletionRevisionRequest | RecurrenceCompletionRequest,
): RecurrenceInput {
  const revisionRequest = 'command' in requestOrCommand ? requestOrCommand : undefined;
  const request = 'command' in requestOrCommand ? requestOrCommand.command : requestOrCommand;
  return { revisionRequest, request, ref: rootRef(request.target) };
}

function recurrenceReplacementOrder(
  cleanSubtree: string,
  completedSubtree: string,
  deletesCompleted: boolean,
  cleanFirst: boolean,
): readonly string[] {
  if (deletesCompleted) return [cleanSubtree];
  return cleanFirst ? [cleanSubtree, completedSubtree] : [completedSubtree, cleanSubtree];
}

function editRequestInput(request: TaskEditRequest | TaskEditCommand): EditInput {
  const prepared = 'command' in request ? request : undefined;
  const command = 'command' in request ? request.command : request;
  return { prepared, command, ref: commandRootRef(command) };
}

export class InMemoryTaskRepository implements TaskRepository {
  readonly supportsRevisionPreconditions = true as const;

  private readonly files: Map<string, string>;
  private readonly editor: TaskBlockEditor;
  private readonly locator: TaskLocator;

  constructor(private readonly options: Options) {
    this.files = new Map(Object.entries(options.files));
    this.editor = options.editor ?? new TaskBlockEditor();
    this.locator = options.locator ?? new TaskLocator();
  }

  content(path: string): string | undefined {
    return this.files.get(path);
  }

  async create(destination: TaskDestination, draft: TaskDraft): Promise<TaskRepositoryResult> {
    const content = this.files.get(destination.filePath);
    if (content === undefined) {
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
    const inserted = this.editor.insertRootBlock(content, block.content, destination.insertion);
    if (inserted == null) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    const task = this.snapshot(destination.filePath, inserted.content, inserted.block.line);
    if (task == null) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    this.files.set(destination.filePath, inserted.content);
    const installed = this.options.snapshotState?.installCommittedContent(
      destination.filePath,
      inserted.content,
    );
    return {
      type: 'committed',
      outcome: {
        type: 'task',
        task: installed?.find((candidate) => candidate.source.line === inserted.block.line) ?? task,
      },
      changed: true,
    };
  }

  async move(
    request: TaskMoveRequest | TaskRef,
    legacyDestination?: TaskDestination,
  ): Promise<TaskRepositoryResult> {
    const input = normalizeMoveInput(request, legacyDestination);
    if (input === undefined) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'destination' }] };
    }
    const source = this.resolveMoveSource(input);
    if (source.type === 'result') return source.result;
    if (input.ref.filePath === input.destination.filePath) {
      return { type: 'committed', outcome: { type: 'task', task: source.current }, changed: false };
    }
    return this.commitMove(input, source);
  }

  private resolveMoveSource(input: MoveInput): MoveSourceResolution {
    const { ref, prepared } = input;
    const sourceContent = this.files.get(ref.filePath);
    if (sourceContent === undefined) {
      return { type: 'result', result: { type: 'not-found', target: { type: 'task', ref } } };
    }
    const evidence = this.options.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.options.snapshotState?.currentRoot(ref.filePath, ref.line, evidence.source);
    const blocks = this.editor.rootBlocks(sourceContent);
    const located = this.locator.locate(blocks, ref);
    const preparedResult = preparedRevisionResult(
      prepared,
      located,
      this.options.snapshotState?.authoritySuccessor?.(ref),
      (currentRef) => this.locator.locate(blocks, currentRef),
      (line) => this.snapshot(ref.filePath, sourceContent, line),
    );
    if (preparedResult != null) return { type: 'result', result: preparedResult };
    return this.resolveLocatedMove(ref, sourceContent, located, indexedRef?.revision);
  }

  private resolveLocatedMove(
    ref: TaskRef,
    sourceContent: string,
    located: LocateResult,
    indexedRevision: string | undefined,
  ): MoveSourceResolution {
    const stale = authorityRevisionChanged(
      this.options.refAuthority,
      this.options.snapshotState,
      indexedRevision,
      ref.revision,
    );
    if (stale && located.type === 'exact') {
      return { type: 'result', result: this.moveConflict(ref, sourceContent, located.block) };
    }
    if (located.type === 'not-found') {
      return { type: 'result', result: { type: 'not-found', target: { type: 'task', ref } } };
    }
    if (located.type === 'conflict') {
      return { type: 'result', result: this.moveConflict(ref, sourceContent, located.block) };
    }
    if (located.type === 'ambiguous') {
      return {
        type: 'result',
        result: {
          type: 'ambiguous',
          candidates: located.blocks.flatMap((block) => {
            const root = this.snapshot(ref.filePath, sourceContent, block.line);
            return root != null ? [{ root, target: { type: 'task' as const, ref: root.ref } }] : [];
          }),
        },
      };
    }
    const current = this.snapshot(ref.filePath, sourceContent, located.block.line);
    return current == null
      ? { type: 'result', result: { type: 'not-found', target: { type: 'task', ref } } }
      : {
          type: 'ready',
          content: sourceContent,
          block: located.block,
          current,
          indexedRevision: indexedRevision ?? '',
        };
  }

  private moveConflict(ref: TaskRef, content: string, block: TaskRootBlock): TaskRepositoryResult {
    const current = this.snapshot(ref.filePath, content, block.line);
    return current != null
      ? { type: 'conflict', current }
      : { type: 'not-found', target: { type: 'task', ref } };
  }

  private commitMove(
    input: MoveInput,
    source: Extract<MoveSourceResolution, { type: 'ready' }>,
  ): TaskRepositoryResult {
    const targetContent = this.files.get(input.destination.filePath);
    if (targetContent === undefined) {
      return {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      };
    }
    const inserted = this.editor.insertRootBlock(
      targetContent,
      source.block.source,
      input.destination.insertion,
    );
    if (inserted == null) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    const transition = this.stageMoveTransition(input, source, inserted);
    if (transition.type === 'result') return transition.result;
    const copiedTask = (
      this.options.snapshotState?.previewContent(input.destination.filePath, inserted.content) ??
      this.options.snapshotsFromContent(input.destination.filePath, inserted.content)
    ).find((task) => task.source.line === inserted.block.line);
    if (copiedTask == null) {
      this.abortTransition(transition.token);
      return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    }
    const sourceWithoutTask = this.editor.deleteRoot(source.content, source.block);
    if (sourceWithoutTask === undefined) {
      this.abortTransition(transition.token);
      return { type: 'not-found', target: { type: 'task', ref: source.current.ref } };
    }
    return this.installMove({
      input,
      inserted,
      copiedTask,
      sourceWithoutTask,
      transitionToken: transition.token,
    });
  }

  private stageMoveTransition(
    input: MoveInput,
    source: Extract<MoveSourceResolution, { type: 'ready' }>,
    inserted: InsertedMove,
  ): MoveTransition {
    const authority = this.options.refAuthority;
    if (authority == null || this.options.snapshotState == null) {
      return { type: 'ready', token: undefined };
    }
    const revision = authority.successor(input.ref.revision, inserted.block.source);
    if (revision === undefined)
      return { type: 'result', result: { type: 'conflict', current: source.current } };
    const staged = authority.stage(
      {
        filePath: input.destination.filePath,
        candidateFingerprint: taskRefContentFingerprint(inserted.content),
        candidateLength: inserted.content.length,
        expectedRevision: input.ref.revision,
        roots: [{ line: inserted.block.line, source: inserted.block.source, revision }],
      },
      source.indexedRevision,
    );
    return staged.type === 'conflict'
      ? { type: 'result', result: { type: 'conflict', current: source.current } }
      : { type: 'ready', token: staged.token };
  }

  private abortTransition(token: object | undefined): void {
    if (token != null) this.options.refAuthority?.abort(token);
  }

  private installMove(commit: MoveCommitInput): TaskRepositoryResult {
    const { input, inserted, copiedTask, sourceWithoutTask, transitionToken } = commit;
    this.files.set(input.destination.filePath, inserted.content);
    this.files.set(input.ref.filePath, sourceWithoutTask);
    if (transitionToken != null) this.options.refAuthority?.commit(transitionToken);
    const installed = this.options.snapshotState?.installCommittedContent(
      input.destination.filePath,
      inserted.content,
    );
    if (transitionToken != null) {
      this.options.refAuthority?.acknowledge(input.destination.filePath, inserted.content);
    }
    this.options.snapshotState?.installCommittedContent(input.ref.filePath, sourceWithoutTask);
    return {
      type: 'committed',
      outcome: {
        type: 'task',
        task: installed?.find((task) => task.source.line === inserted.block.line) ?? copiedTask,
      },
      changed: true,
    };
  }

  async completeRecurrence(
    requestOrCommand: RecurrenceCompletionRevisionRequest | RecurrenceCompletionRequest,
  ): Promise<TaskRepositoryResult> {
    const input = recurrenceRequestInput(requestOrCommand);
    const location = this.resolveRecurrenceLocation(input);
    if (location.type === 'result') return location.result;
    if (this.options.codec.statusForSymbol(location.owner.statusSymbol) === 'done') {
      return {
        type: 'committed',
        outcome: { type: 'task', task: location.current },
        changed: false,
      };
    }
    const prepared = this.prepareRecurrence(input, location);
    if (prepared.type === 'result') return prepared.result;
    return this.commitRecurrence(input, location, prepared.candidate);
  }

  private resolveRecurrenceLocation(input: RecurrenceInput): RecurrenceLocation {
    const { ref, request, revisionRequest } = input;
    const content = this.files.get(ref.filePath);
    if (content === undefined) {
      return { type: 'result', result: { type: 'not-found', target: request.target } };
    }
    const evidence = this.options.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.options.snapshotState?.currentRoot(ref.filePath, ref.line, evidence.source);
    const blocks = this.editor.rootBlocks(content);
    const located = this.locator.locate(blocks, ref);
    const revisionResult = preparedRevisionResult(
      revisionRequest,
      located,
      this.options.snapshotState?.authoritySuccessor?.(ref),
      (currentRef) => this.locator.locate(blocks, currentRef),
      (line) => this.snapshot(ref.filePath, content, line),
    );
    if (revisionResult != null) return { type: 'result', result: revisionResult };
    return this.resolveLocatedRecurrence(input, content, located, indexedRef?.revision);
  }

  private resolveLocatedRecurrence(
    input: RecurrenceInput,
    content: string,
    located: LocateResult,
    indexedRevision: string | undefined,
  ): RecurrenceLocation {
    const { ref, request } = input;
    const stale = authorityRevisionChanged(
      this.options.refAuthority,
      this.options.snapshotState,
      indexedRevision,
      ref.revision,
    );
    if (stale) {
      if (located.type !== 'exact') {
        return {
          type: 'result',
          result: this.resolutionResultForTarget(located, request.target, ref.filePath, content),
        };
      }
      const current = this.snapshot(ref.filePath, content, located.block.line);
      return {
        type: 'result',
        result:
          current != null
            ? { type: 'conflict', current }
            : { type: 'not-found', target: request.target },
      };
    }
    if (located.type !== 'exact') {
      return {
        type: 'result',
        result: this.resolutionResultForTarget(located, request.target, ref.filePath, content),
      };
    }
    const relativeLine = confirmedLine(request.target, located.block.source);
    const current = this.snapshot(ref.filePath, content, located.block.line);
    if (relativeLine === undefined) return this.unresolvedRecurrence(current, request.target);
    if (current == null) return this.unresolvedRecurrence(current, request.target);
    const owner = snapshotNode(current, request.target);
    if (owner == null) return this.unresolvedRecurrence(current, request.target);
    return {
      type: 'ready',
      content,
      block: located.block,
      current,
      owner,
      relativeLine,
      indexedRevision: indexedRevision ?? '',
    };
  }

  private unresolvedRecurrence(
    current: TaskSnapshot | undefined,
    target: TaskNodeRef,
  ): RecurrenceLocation {
    return {
      type: 'result',
      result: current != null ? { type: 'conflict', current } : { type: 'not-found', target },
    };
  }

  private prepareRecurrence(
    input: RecurrenceInput,
    location: Extract<RecurrenceLocation, { type: 'ready' }>,
  ): PreparedRecurrence {
    const { owner, block, relativeLine, content } = location;
    const { request } = input;
    if (owner.recurrence === undefined) {
      return { type: 'result', result: invalidRecurrence('unparseable-rule') };
    }
    const next = nextOccurrencePlanning({
      rule: owner.recurrence,
      planning: owner.planning,
      completedOn: request.today,
      policy: request.policy,
    });
    if (next.type === 'invalid') {
      return { type: 'result', result: invalidRecurrence(next.code) };
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
      return { type: 'result', result: invalidRecurrence(prepared.code) };
    }
    const deletesCompleted = owner.onCompletion === 'delete';
    const cleanFirst = deletesCompleted || request.placement === 'before';
    const replacements = recurrenceReplacementOrder(
      prepared.cleanSubtree,
      prepared.completedSubtree,
      deletesCompleted,
      cleanFirst,
    );
    const candidate = this.editor.replaceOwnedTaskSubtree(
      content,
      block,
      relativeLine,
      replacements,
    );
    if (candidate === undefined) {
      return { type: 'result', result: invalidRecurrence('invalid-task-syntax') };
    }
    const cleanOffset = cleanFirst ? 0 : lineCount(prepared.completedSubtree);
    const completedOffset = cleanFirst ? lineCount(prepared.cleanSubtree) : 0;
    const nestedOwner = request.target.type === 'subtask';
    let activeRootLine = block.line;
    let completedRootLine = block.line;
    if (!nestedOwner) {
      activeRootLine += cleanOffset;
      completedRootLine += completedOffset;
    }
    return {
      type: 'ready',
      candidate: {
        candidate,
        deletesCompleted,
        cleanFirst,
        cleanOffset,
        completedOffset,
        nestedOwner,
        activeRootLine,
        completedRootLine,
      },
    };
  }

  private commitRecurrence(
    input: RecurrenceInput,
    location: Extract<RecurrenceLocation, { type: 'ready' }>,
    candidate: RecurrenceCandidate,
  ): TaskRepositoryResult {
    let transitionToken: object | undefined;
    try {
      const transition = this.stageRecurrenceTransition(input, location, candidate);
      if (transition.type === 'result') return transition.result;
      transitionToken = transition.token;
      const occurrences = this.recurrenceOccurrences(input, location, candidate);
      if (occurrences === undefined) {
        this.abortTransition(transitionToken);
        return invalidRecurrence('invalid-task-syntax');
      }
      return this.installRecurrence(
        input.ref.filePath,
        candidate.candidate,
        occurrences,
        transitionToken,
      );
    } catch {
      this.abortTransition(transitionToken);
      return {
        type: 'io-error',
        cause: 'process-error',
        path: input.ref.filePath,
        contentState: 'unknown',
      };
    }
  }

  private stageRecurrenceTransition(
    input: RecurrenceInput,
    location: Extract<RecurrenceLocation, { type: 'ready' }>,
    candidate: RecurrenceCandidate,
  ): RecurrenceTransition {
    const authority = this.options.refAuthority;
    if (authority == null || this.options.snapshotState == null) {
      return { type: 'ready', token: undefined };
    }
    const rootLines = new Set([
      candidate.activeRootLine,
      ...(!candidate.deletesCompleted ? [candidate.completedRootLine] : []),
    ]);
    const finalBlocks = new Map(
      this.editor.rootBlocks(candidate.candidate).map((block) => [block.line, block] as const),
    );
    const roots = this.recurrenceRevisionRoots(input.ref, rootLines, finalBlocks);
    if (roots === undefined) {
      return { type: 'result', result: invalidRecurrence('invalid-task-syntax') };
    }
    const staged = authority.stage(
      {
        filePath: input.ref.filePath,
        candidateFingerprint: taskRefContentFingerprint(candidate.candidate),
        candidateLength: candidate.candidate.length,
        expectedRevision: input.ref.revision,
        roots,
      },
      location.indexedRevision,
    );
    return staged.type === 'conflict'
      ? { type: 'result', result: { type: 'conflict', current: location.current } }
      : { type: 'ready', token: staged.token };
  }

  private recurrenceRevisionRoots(
    ref: TaskRef,
    rootLines: ReadonlySet<number>,
    finalBlocks: ReadonlyMap<number, TaskRootBlock>,
  ): readonly RootRevisionOverride[] | undefined {
    const authority = this.options.refAuthority;
    if (authority == null) return undefined;
    const roots: RootRevisionOverride[] = [];
    for (const line of rootLines) {
      const block = finalBlocks.get(line);
      if (block == null) return undefined;
      const revision = authority.successor(ref.revision, block.source);
      if (revision === undefined) return undefined;
      roots.push({ line, source: block.source, revision });
    }
    return roots;
  }

  private recurrenceOccurrences(
    input: RecurrenceInput,
    location: Extract<RecurrenceLocation, { type: 'ready' }>,
    candidate: RecurrenceCandidate,
  ): RecurrenceOccurrences | undefined {
    const snapshots =
      this.options.snapshotState?.previewContent(input.ref.filePath, candidate.candidate) ??
      this.options.snapshotsFromContent(input.ref.filePath, candidate.candidate);
    const activeRelativeLine = candidate.nestedOwner
      ? location.relativeLine + candidate.cleanOffset
      : 0;
    const active = occurrenceAt(snapshots, candidate.activeRootLine, activeRelativeLine);
    if (active == null) return undefined;
    if (candidate.deletesCompleted) return { active, completed: undefined };
    const completedRelativeLine = candidate.nestedOwner
      ? location.relativeLine + candidate.completedOffset
      : 0;
    const completed = occurrenceAt(snapshots, candidate.completedRootLine, completedRelativeLine);
    return completed == null ? undefined : { active, completed };
  }

  private installRecurrence(
    path: string,
    candidate: string,
    occurrences: RecurrenceOccurrences,
    transitionToken: object | undefined,
  ): TaskRepositoryResult {
    this.files.set(path, candidate);
    if (transitionToken != null) {
      this.options.refAuthority?.commit(transitionToken);
      this.options.snapshotState?.installCommittedContent(path, candidate);
      this.options.refAuthority?.acknowledge(path, candidate);
    }
    return {
      type: 'committed',
      outcome: {
        type: 'recurrence',
        active: occurrences.active,
        ...(occurrences.completed !== undefined && { completed: occurrences.completed }),
      },
      changed: true,
    };
  }

  async edit(request: TaskEditRequest | TaskEditCommand): Promise<TaskRepositoryResult> {
    const input = editRequestInput(request);
    const metadataIssues = [
      ...dependencyMetadataIssues(input.command),
      ...subtaskRestorationIssues(input.command),
    ];
    if (metadataIssues.length > 0) return { type: 'invalid', issues: metadataIssues };
    const parentIssue = this.reorderParentIssue(input.command);
    if (parentIssue !== undefined) return parentIssue;
    const location = this.resolveEditLocation(input);
    if (location.type === 'result') return location.result;
    return this.applyLocatedEdit(input, location);
  }

  async editBatch(request: TaskEditBatchRequest): Promise<TaskRepositoryResult> {
    const issues = taskEditBatchIssues(request);
    if (issues.length > 0) return { type: 'invalid', issues };
    const content = this.files.get(request.filePath);
    if (content === undefined) return { type: 'not-found', target: request.outcomeTarget };
    let token: object | undefined;
    try {
      const prepared = prepareTaskEditBatch(request, content, {
        ...this.options,
        editor: this.editor,
        resolve: (edit) => this.resolveEditLocation(editRequestInput(edit)),
      });
      if (prepared.type !== 'prepared') return prepared;
      if (prepared.content === content)
        return {
          type: 'committed',
          outcome: { type: 'task', task: prepared.outcomeRoot },
          changed: false,
        };
      const staged = stageTaskEditBatch(
        request.filePath,
        prepared,
        this.options.refAuthority,
        this.options.snapshotState,
      );
      if (staged.type !== 'staged') return staged;
      token = staged.token;
      return this.installSurvivingRoot(
        request.filePath,
        prepared.content,
        prepared.outcomeRoot,
        token,
      );
    } catch {
      this.abortTransition(token);
      return {
        type: 'io-error',
        cause: 'process-error',
        path: request.filePath,
        contentState: 'unknown',
      };
    }
  }

  private reorderParentIssue(command: TaskEditCommand): TaskRepositoryResult | undefined {
    if (command.type !== 'reorder-subtask') return undefined;
    if (sameTaskNodeRef(command.subtask.parent, command.target.parent)) return undefined;
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask-parent' }] };
  }

  private resolveEditLocation(input: EditInput): EditLocation {
    const content = this.files.get(input.ref.filePath);
    if (content === undefined) {
      return { type: 'result', result: { type: 'not-found', target: targetOf(input.command) } };
    }
    const evidence = this.options.refAuthority?.evidence(input.ref.revision);
    const indexedRef =
      evidence === undefined
        ? undefined
        : this.options.snapshotState?.currentRoot(
            input.ref.filePath,
            input.ref.line,
            evidence.source,
          );
    const blocks = this.editor.rootBlocks(content);
    const located = this.locator.locate(blocks, input.ref);
    const revision = preparedRevisionResult(
      input.prepared,
      located,
      this.options.snapshotState?.authoritySuccessor?.(input.ref),
      (currentRef) => this.locator.locate(blocks, currentRef),
      (line) => this.snapshot(input.ref.filePath, content, line),
    );
    if (revision !== undefined) return { type: 'result', result: revision };
    return this.resolveLocatedEdit(input, content, located, indexedRef?.revision);
  }

  private resolveLocatedEdit(
    input: EditInput,
    content: string,
    located: LocateResult,
    indexedRevision: string | undefined,
  ): EditLocation {
    const stale = authorityRevisionChanged(
      this.options.refAuthority,
      this.options.snapshotState,
      indexedRevision,
      input.ref.revision,
    );
    if (stale || located.type !== 'exact') {
      return { type: 'result', result: this.editResolution(input, content, located) };
    }
    return { type: 'ready', content, block: located.block };
  }

  private editResolution(
    input: EditInput,
    content: string,
    located: LocateResult,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') return { type: 'not-found', target: targetOf(input.command) };
    if (located.type === 'conflict' || located.type === 'exact') {
      const current = this.snapshot(input.ref.filePath, content, located.block.line);
      return current !== undefined
        ? { type: 'conflict', current }
        : { type: 'not-found', target: targetOf(input.command) };
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateForCommand(block, input.command, input.ref.filePath, content);
      return candidate === undefined ? [] : [candidate];
    });
    return { type: 'ambiguous', candidates };
  }

  private candidateForCommand(
    block: TaskRootBlock,
    command: TaskEditCommand,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshot(path, content, block.line);
    if (root === undefined) return undefined;
    const original = targetOf(command);
    const target =
      original.type === 'comment'
        ? {
            type: 'comment' as const,
            ref: { ...original.ref, parent: rebaseNode(original.ref.parent, root.ref) },
          }
        : rebaseNode(original, root.ref);
    return { root, target };
  }

  private applyLocatedEdit(
    input: EditInput,
    location: Extract<EditLocation, { readonly type: 'ready' }>,
  ): TaskRepositoryResult {
    if (input.command.type === 'delete') return this.deleteRootEdit(input, location);
    const target = nodeTarget(input.command);
    const relativeLine = target !== undefined ? confirmedLine(target, location.block.source) : 0;
    if (relativeLine === undefined) return this.relativeLineConflict(input, location);
    const located: LocatedEditInput = {
      process: input,
      content: location.content,
      block: location.block,
      relativeLine,
      target,
    };
    const completionDelete = this.deleteOnCompletion(located);
    if (completionDelete !== undefined) return completionDelete;
    if (isStructuralCommand(input.command)) return this.editStructural(located, input.command);
    if (input.command.type === 'edit-link' && input.command.target.type !== 'title') {
      return this.editTextTarget(located, input.command);
    }
    return this.editOrdinaryLine(located);
  }

  private deleteRootEdit(
    input: EditInput,
    location: Extract<EditLocation, { readonly type: 'ready' }>,
  ): TaskRepositoryResult {
    const current = this.snapshot(input.ref.filePath, location.content, location.block.line);
    const next = this.editor.deleteRoot(location.content, location.block);
    if (current === undefined || next === undefined) {
      return { type: 'not-found', target: targetOf(input.command) };
    }
    this.files.set(input.ref.filePath, next);
    this.options.snapshotState?.installCommittedContent(input.ref.filePath, next);
    return { type: 'committed', outcome: { type: 'deleted', ref: current.ref }, changed: true };
  }

  private relativeLineConflict(
    input: EditInput,
    location: Extract<EditLocation, { readonly type: 'ready' }>,
  ): TaskRepositoryResult {
    const current = this.snapshot(input.ref.filePath, location.content, location.block.line);
    return current !== undefined
      ? { type: 'conflict', current }
      : { type: 'not-found', target: targetOf(input.command) };
  }

  private editStructural(
    input: LocatedEditInput,
    command: StructuralTaskEditCommand,
  ): TaskRepositoryResult {
    const current = this.snapshot(input.process.ref.filePath, input.content, input.block.line);
    const targetSnapshot =
      current !== undefined && input.target !== undefined
        ? snapshotNode(current, input.target)
        : undefined;
    if (current === undefined || targetSnapshot === undefined) {
      return current !== undefined
        ? { type: 'conflict', current }
        : { type: 'not-found', target: targetOf(command) };
    }
    if (this.structuralOwnershipConflict(command, targetSnapshot)) {
      return { type: 'conflict', current };
    }
    const prepared = this.prepareStructuralCommand(command);
    if ('type' in prepared && prepared.type === 'invalid') return prepared;
    const blockLength = input.block.toLine - input.block.line + 1;
    const edited = this.editor.edit(
      input.content,
      input.block,
      blockTarget(targetSnapshot, blockLength, input.relativeLine),
      structuralEdit(prepared),
    );
    const result = this.structuralEditOutcome(input, current, edited);
    return recoverSubtaskRemoval(command, edited, result);
  }

  private structuralOwnershipConflict(
    command: StructuralTaskEditCommand,
    target: TaskSnapshot | SubtaskSnapshot,
  ): boolean {
    if (command.type === 'restore-subtask') return !subtaskRestorationGapIsCurrent(command, target);
    if (command.type === 'update-comment' || command.type === 'delete-comment') {
      return !ownsComment(target, command.comment);
    }
    if (command.type === 'delete-subtask') return !ownsSubtask(target, command.subtask);
    if (command.type === 'reorder-subtask') {
      return !ownsSubtask(target, command.subtask) || !ownsSubtask(target, command.target);
    }
    return false;
  }

  private prepareStructuralCommand(
    command: StructuralTaskEditCommand,
  ): StructuralTaskEditCommand | Extract<TaskRepositoryResult, { readonly type: 'invalid' }> {
    if (command.type !== 'add-subtask') return command;
    if (command.text.trim().length === 0 || /[\r\n]/u.test(command.text)) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] };
    }
    const today = (command as unknown as { readonly today?: LocalDate }).today;
    if (today === undefined) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'subtask' }] };
    }
    const created = createTaskBlock(this.options.codec, {
      markdownBody: command.text,
      today,
      addCreatedDate: command.addCreatedDate,
    });
    return created.type === 'invalid'
      ? created
      : { ...command, text: created.content.slice('- [ ] '.length) };
  }

  private structuralEditOutcome(
    input: LocatedEditInput,
    current: TaskSnapshot,
    edited: ReturnType<TaskBlockEditor['edit']>,
  ): TaskRepositoryResult {
    if (edited.type === 'conflict') return { type: 'conflict', current };
    if (edited.type === 'invalid') {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: edited.field }] };
    }
    if (edited.type === 'unchanged') {
      return { type: 'committed', outcome: { type: 'task', task: current }, changed: false };
    }
    return this.commitSurvivingRoot(input.process.ref, edited.content, input.block.line);
  }

  private editTextTarget(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
  ): TaskRepositoryResult {
    const current = this.snapshot(input.process.ref.filePath, input.content, input.block.line);
    const targetSnapshot =
      current !== undefined && input.target !== undefined
        ? snapshotNode(current, input.target)
        : undefined;
    if (current === undefined || targetSnapshot === undefined) {
      return current !== undefined
        ? { type: 'conflict', current }
        : { type: 'not-found', target: targetOf(command) };
    }
    const lines = input.content.split(/\r?\n/u);
    const target = this.resolveTextEditTarget(input, command, targetSnapshot, lines);
    if (target.type === 'conflict') return { type: 'conflict', current };
    if (target.type === 'invalid') {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] };
    }
    return this.applyTextEdit(input, command, current, target);
  }

  private resolveTextEditTarget(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
    target: TaskSnapshot | SubtaskSnapshot,
    lines: readonly string[],
  ): TextEditLocation {
    if (command.target.type === 'comment') {
      const line = commentLine(input.block.line + input.relativeLine, command.target.ref, lines);
      return line === undefined
        ? { type: 'conflict' }
        : { type: 'ready', line, occurrence: command.occurrence };
    }
    let occurrence = command.occurrence;
    const candidates = this.editor.descriptionLines(
      input.content,
      input.block,
      blockTarget(target, input.block.toLine - input.block.line + 1, input.relativeLine),
    );
    for (const relativeLine of candidates) {
      const line = input.block.line + relativeLine;
      const count = parseLinks(lines[line] ?? '').length;
      if (occurrence < count) return { type: 'ready', line, occurrence };
      occurrence -= count;
    }
    return { type: 'invalid' };
  }

  private applyTextEdit(
    input: LocatedEditInput,
    command: Extract<TaskEditCommand, { readonly type: 'edit-link' }>,
    current: TaskSnapshot,
    target: Extract<TextEditLocation, { readonly type: 'ready' }>,
  ): TaskRepositoryResult {
    const sourceLine = input.content.split(/\r?\n/u)[target.line] ?? '';
    const edited = this.options.codec.editTextLink(
      sourceLine,
      target.occurrence,
      command.replacement,
    );
    if (edited.type === 'invalid') return edited;
    if (edited.type === 'unchanged') {
      return { type: 'committed', outcome: { type: 'task', task: current }, changed: false };
    }
    const next = this.editor.replaceLine(
      input.content,
      input.block,
      target.line - input.block.line,
      edited.content,
    ).content;
    return this.commitSurvivingRoot(input.process.ref, next, input.block.line);
  }

  private editOrdinaryLine(input: LocatedEditInput): TaskRepositoryResult {
    const { process, content, block, relativeLine } = input;
    const sourceLine = content.split(/\r?\n/u)[block.line + relativeLine];
    if (sourceLine === undefined) return { type: 'not-found', target: targetOf(process.command) };
    const result = applyTaskCommand(this.options.codec, sourceLine, process.command);
    if (result.type === 'invalid') return result;
    if (result.type === 'changed') {
      const next = this.editor.replaceLine(content, block, relativeLine, result.content).content;
      return this.commitSurvivingRoot(process.ref, next, block.line);
    }
    const root = this.snapshot(process.ref.filePath, content, block.line);
    return root !== undefined
      ? { type: 'committed', outcome: { type: 'task', task: root }, changed: false }
      : { type: 'not-found', target: targetOf(process.command) };
  }

  private commitSurvivingRoot(
    consumed: TaskRef,
    candidate: string,
    line: number,
  ): TaskRepositoryResult {
    const block = this.editor.rootBlocks(candidate).find((root) => root.line === line);
    if (block == null) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    const transition = this.stageSurvivingRoot(consumed, candidate, block);
    if (transition.type === 'result') return transition.result;
    const root = (
      this.options.snapshotState?.previewContent(consumed.filePath, candidate) ??
      this.options.snapshotsFromContent(consumed.filePath, candidate)
    ).find((task) => task.source.line === line);
    if (root == null) {
      this.abortTransition(transition.token);
      return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    }
    return this.installSurvivingRoot(consumed.filePath, candidate, root, transition.token);
  }

  private stageSurvivingRoot(
    consumed: TaskRef,
    candidate: string,
    block: TaskRootBlock,
  ): SurvivingRootTransition {
    const authority = this.options.refAuthority;
    const snapshotState = this.options.snapshotState;
    if (authority == null || snapshotState == null) {
      return { type: 'ready', token: undefined };
    }
    const evidence = authority.evidence(consumed.revision);
    const current =
      evidence === undefined
        ? undefined
        : snapshotState.currentRoot(consumed.filePath, consumed.line, evidence.source);
    const revision = authority.successor(consumed.revision, block.source);
    if (current == null || revision === undefined) {
      return {
        type: 'result',
        result: { type: 'not-found', target: { type: 'task', ref: consumed } },
      };
    }
    const staged = authority.stage(
      {
        filePath: consumed.filePath,
        candidateFingerprint: taskRefContentFingerprint(candidate),
        candidateLength: candidate.length,
        expectedRevision: consumed.revision,
        roots: [{ line: block.line, source: block.source, revision }],
      },
      current.revision,
    );
    if (staged.type !== 'conflict') return { type: 'ready', token: staged.token };
    return { type: 'result', result: this.survivingRootConflict(consumed, block.line) };
  }

  private survivingRootConflict(consumed: TaskRef, line: number): TaskRepositoryResult {
    const current = this.snapshot(consumed.filePath, this.files.get(consumed.filePath) ?? '', line);
    return current !== undefined
      ? { type: 'conflict', current }
      : { type: 'not-found', target: { type: 'task', ref: consumed } };
  }

  private installSurvivingRoot(
    path: string,
    candidate: string,
    root: TaskSnapshot,
    token: object | undefined,
  ): TaskRepositoryResult {
    this.files.set(path, candidate);
    if (token !== undefined) this.options.refAuthority?.commit(token);
    const installed = this.options.snapshotState?.installCommittedContent(path, candidate);
    if (token !== undefined) this.options.refAuthority?.acknowledge(path, candidate);
    const committed = installed?.find((task) => task.source.line === root.source.line) ?? root;
    return { type: 'committed', outcome: { type: 'task', task: committed }, changed: true };
  }

  private snapshot(path: string, content: string, line: number): TaskSnapshot | undefined {
    return this.options
      .snapshotsFromContent(path, content)
      .find((candidate) => candidate.source.line === line);
  }

  private deleteOnCompletion(input: LocatedEditInput): TaskRepositoryResult | undefined {
    const { command } = input.process;
    if (command.type !== 'set-status' || input.target === undefined) return undefined;
    if (!this.isDeleteCompletionStatus(command)) return undefined;
    return this.deleteOnCompletionForTarget(input, input.target);
  }

  private isDeleteCompletionStatus(
    command: Extract<TaskEditCommand, { readonly type: 'set-status' }>,
  ): boolean {
    return (
      command.stamp !== undefined && this.options.codec.statusForSymbol(command.symbol) === 'done'
    );
  }

  private deleteOnCompletionForTarget(
    input: LocatedEditInput,
    target: PlanningTarget,
  ): TaskRepositoryResult | undefined {
    const { content, block, relativeLine } = input;
    const path = input.process.ref.filePath;
    const current = this.snapshot(path, content, block.line);
    const owner = current === undefined ? undefined : snapshotNode(current, target);
    const parsed = this.parseCompletionLine(input);
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
      return invalidRecurrence('nested-recurrence-conflict');
    }
    return target.type === 'task'
      ? this.deleteCompletedRoot(path, content, block, current)
      : this.deleteCompletedSubtask(input, current.ref);
  }

  private parseCompletionLine(input: LocatedEditInput): ReturnType<TaskMarkdownCodec['parseLine']> {
    const line = input.block.line + input.relativeLine;
    const source = input.content.split(/\r?\n/u)[line];
    return source === undefined
      ? null
      : this.options.codec.parseLine(source, { filePath: input.process.ref.filePath, line });
  }

  private deleteCompletedRoot(
    path: string,
    content: string,
    block: TaskRootBlock,
    current: TaskSnapshot,
  ): TaskRepositoryResult {
    const next = this.editor.deleteRoot(content, block);
    if (next === undefined) return invalidRecurrence('invalid-task-syntax');
    this.files.set(path, next);
    this.options.snapshotState?.installCommittedContent(path, next);
    return {
      type: 'committed',
      outcome: { type: 'deleted', ref: current.ref },
      changed: true,
    };
  }

  private deleteCompletedSubtask(input: LocatedEditInput, consumed: TaskRef): TaskRepositoryResult {
    const { content, block, relativeLine } = input;
    const path = input.process.ref.filePath;
    const next = this.editor.replaceOwnedTaskSubtree(content, block, relativeLine, []);
    if (next === undefined) return invalidRecurrence('invalid-task-syntax');
    const updatedBlock = this.editor
      .rootBlocks(next)
      .find((candidate) => candidate.line === block.line);
    if (updatedBlock === undefined) return invalidRecurrence('invalid-task-syntax');
    const root = this.snapshot(path, next, updatedBlock.line);
    if (root == null) return invalidRecurrence('invalid-task-syntax');
    if (this.options.snapshotState != null)
      return this.commitSurvivingRoot(consumed, next, block.line);
    this.files.set(path, next);
    return { type: 'committed', outcome: { type: 'task', task: root }, changed: true };
  }

  private candidateForTarget(
    block: ReturnType<TaskBlockEditor['rootBlocks']>[number],
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskResolutionCandidate | undefined {
    const root = this.snapshot(path, content, block.line);
    return root != null ? { root, target: rebaseNode(target, root.ref) } : undefined;
  }

  private resolutionResultForTarget(
    located: Exclude<ReturnType<TaskLocator['locate']>, { readonly type: 'exact' }>,
    target: TaskNodeRef,
    path: string,
    content: string,
  ): TaskRepositoryResult {
    if (located.type === 'not-found') return { type: 'not-found', target };
    if (located.type === 'conflict') {
      const current = this.snapshot(path, content, located.block.line);
      return current != null ? { type: 'conflict', current } : { type: 'not-found', target };
    }
    const candidates = located.blocks.flatMap((block) => {
      const candidate = this.candidateForTarget(block, target, path, content);
      return candidate != null ? [candidate] : [];
    });
    return candidates.length > 0
      ? { type: 'ambiguous', candidates }
      : { type: 'not-found', target };
  }
}
