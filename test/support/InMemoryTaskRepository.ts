import { parseLinks } from '../../src/parser/links';
import type {
  RecurrenceCompletionRequest,
  TaskDraft,
  TaskEditCommand,
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import type {
  PlanningTarget,
  TaskOccurrenceResult,
  TaskResolutionCandidate,
} from '../../src/tasks/domain/commands';
import {
  nextOccurrencePlanning,
  type RecurrenceIssueCode,
} from '../../src/tasks/domain/recurrence';
import { prepareRecurrenceIteration } from '../../src/tasks/domain/recurrenceIteration';
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
import {
  TaskBlockEditor,
  type TaskBlockEdit,
} from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
  type RootRevisionOverride,
  type TaskSnapshotState,
} from '../../src/tasks/infrastructure/TaskRefAuthority';

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

function nodeTarget(command: TaskEditCommand): PlanningTarget | undefined {
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

function commandRootRef(command: TaskEditCommand): TaskRef {
  const target = nodeTarget(command);
  if (target) return rootRef(target);
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

function targetOf(command: TaskEditCommand): TaskMutationTarget {
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
    if (!next) return undefined;
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

function invalidRecurrence(
  code: RecurrenceIssueCode | 'invalid-task-syntax',
): TaskRepositoryResult {
  return { type: 'invalid', issues: [{ code, field: 'recurrence' }] };
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

export class InMemoryTaskRepository implements TaskRepository {
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
    if (!inserted) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    const task = this.snapshot(destination.filePath, inserted.content, inserted.block.line);
    if (!task) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
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

  async move(ref: TaskRef, destination: TaskDestination): Promise<TaskRepositoryResult> {
    const sourceContent = this.files.get(ref.filePath);
    if (sourceContent === undefined) {
      return { type: 'not-found', target: { type: 'task', ref } };
    }
    const evidence = this.options.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence && this.options.snapshotState?.currentRoot(ref.filePath, ref.line, evidence.source);
    const located = this.locator.locate(this.editor.rootBlocks(sourceContent), ref);
    if (
      this.options.refAuthority &&
      this.options.snapshotState &&
      (!indexedRef || indexedRef.revision !== ref.revision) &&
      located.type === 'exact'
    ) {
      const current = this.snapshot(ref.filePath, sourceContent, located.block.line);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: { type: 'task', ref } };
    }
    if (located.type === 'not-found') {
      return { type: 'not-found', target: { type: 'task', ref } };
    }
    if (located.type === 'conflict') {
      const current = this.snapshot(ref.filePath, sourceContent, located.block.line);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: { type: 'task', ref } };
    }
    if (located.type === 'ambiguous') {
      return {
        type: 'ambiguous',
        candidates: located.blocks.flatMap((block) => {
          const root = this.snapshot(ref.filePath, sourceContent, block.line);
          return root ? [{ root, target: { type: 'task' as const, ref: root.ref } }] : [];
        }),
      };
    }
    const current = this.snapshot(ref.filePath, sourceContent, located.block.line);
    if (!current) return { type: 'not-found', target: { type: 'task', ref } };
    if (ref.filePath === destination.filePath) {
      return { type: 'committed', outcome: { type: 'task', task: current }, changed: false };
    }
    const targetContent = this.files.get(destination.filePath);
    if (targetContent === undefined) {
      return {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      };
    }
    const inserted = this.editor.insertRootBlock(
      targetContent,
      located.block.source,
      destination.insertion,
    );
    if (!inserted) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    let transitionToken: object | undefined;
    if (this.options.refAuthority && this.options.snapshotState) {
      const revision = this.options.refAuthority.successor(ref.revision, inserted.block.source);
      if (!revision) return { type: 'conflict', current };
      const staged = this.options.refAuthority.stage(
        {
          filePath: destination.filePath,
          candidateFingerprint: taskRefContentFingerprint(inserted.content),
          candidateLength: inserted.content.length,
          expectedRevision: ref.revision,
          roots: [
            {
              line: inserted.block.line,
              source: inserted.block.source,
              revision,
            },
          ],
        },
        indexedRef?.revision ?? '',
      );
      if (staged.type === 'conflict') return { type: 'conflict', current };
      transitionToken = staged.token;
    }
    const copiedTask = (
      this.options.snapshotState?.previewContent(destination.filePath, inserted.content) ??
      this.options.snapshotsFromContent(destination.filePath, inserted.content)
    ).find((task) => task.source.line === inserted.block.line);
    if (!copiedTask) {
      if (transitionToken) this.options.refAuthority?.abort(transitionToken);
      return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    }
    const sourceWithoutTask = this.editor.deleteRoot(sourceContent, located.block);
    if (sourceWithoutTask === undefined) {
      if (transitionToken) this.options.refAuthority?.abort(transitionToken);
      return { type: 'not-found', target: { type: 'task', ref: current.ref } };
    }
    this.files.set(destination.filePath, inserted.content);
    this.files.set(ref.filePath, sourceWithoutTask);
    if (transitionToken) this.options.refAuthority?.commit(transitionToken);
    const installed = this.options.snapshotState?.installCommittedContent(
      destination.filePath,
      inserted.content,
    );
    if (transitionToken) {
      this.options.refAuthority?.acknowledge(destination.filePath, inserted.content);
    }
    this.options.snapshotState?.installCommittedContent(ref.filePath, sourceWithoutTask);
    return {
      type: 'committed',
      outcome: {
        type: 'task',
        task: installed?.find((task) => task.source.line === inserted.block.line) ?? copiedTask,
      },
      changed: true,
    };
  }

  async completeRecurrence(request: RecurrenceCompletionRequest): Promise<TaskRepositoryResult> {
    const ref = rootRef(request.target);
    const content = this.files.get(ref.filePath);
    if (content === undefined) return { type: 'not-found', target: request.target };
    const evidence = this.options.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence && this.options.snapshotState?.currentRoot(ref.filePath, ref.line, evidence.source);
    const located = this.locator.locate(this.editor.rootBlocks(content), ref);
    if (
      this.options.refAuthority &&
      this.options.snapshotState &&
      (!indexedRef || indexedRef.revision !== ref.revision)
    ) {
      if (located.type !== 'exact') {
        return this.resolutionResultForTarget(located, request.target, ref.filePath, content);
      }
      const current = this.snapshot(ref.filePath, content, located.block.line);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: request.target };
    }
    if (located.type !== 'exact') {
      return this.resolutionResultForTarget(located, request.target, ref.filePath, content);
    }
    const relativeLine = confirmedLine(request.target, located.block.source);
    const current = this.snapshot(ref.filePath, content, located.block.line);
    const owner =
      relativeLine === undefined || !current ? undefined : snapshotNode(current, request.target);
    if (relativeLine === undefined || !current || !owner) {
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: request.target };
    }
    if (this.options.codec.statusForSymbol(owner.statusSymbol) === 'done') {
      return {
        type: 'committed',
        outcome: { type: 'task', task: current },
        changed: false,
      };
    }
    if (owner.recurrence === undefined) return invalidRecurrence('unparseable-rule');

    const next = nextOccurrencePlanning({
      rule: owner.recurrence,
      planning: owner.planning,
      completedOn: request.today,
      policy: request.policy,
    });
    if (next.type === 'invalid') return invalidRecurrence(next.code);
    const prepared = prepareRecurrenceIteration({
      rootBlock: located.block.source,
      ownerRelativeLine: relativeLine,
      nextPlanning: next.planning,
      dayDelta: next.dayDelta,
      doneSymbol: request.doneSymbol,
      todoSymbol: request.todoSymbol,
      today: request.today,
      addCreatedDate: request.addCreatedDate,
      addCompletionDate: request.addCompletionDate,
    });
    if (prepared.type === 'invalid') return invalidRecurrence(prepared.code);

    const deletesCompleted = owner.onCompletion === 'delete';
    const cleanFirst = deletesCompleted || request.placement === 'before';
    const replacements = deletesCompleted
      ? [prepared.cleanSubtree]
      : cleanFirst
        ? [prepared.cleanSubtree, prepared.completedSubtree]
        : [prepared.completedSubtree, prepared.cleanSubtree];
    const candidate = this.editor.replaceOwnedTaskSubtree(
      content,
      located.block,
      relativeLine,
      replacements,
    );
    if (candidate === undefined) return invalidRecurrence('invalid-task-syntax');

    let transitionToken: object | undefined;
    try {
      const cleanOffset = cleanFirst ? 0 : lineCount(prepared.completedSubtree);
      const completedOffset = cleanFirst ? lineCount(prepared.cleanSubtree) : 0;
      const nestedOwner = request.target.type === 'subtask';
      const activeRootLine = nestedOwner ? located.block.line : located.block.line + cleanOffset;
      const completedRootLine = nestedOwner
        ? located.block.line
        : located.block.line + completedOffset;
      if (this.options.refAuthority && this.options.snapshotState) {
        const rootLines = new Set([
          activeRootLine,
          ...(!deletesCompleted ? [completedRootLine] : []),
        ]);
        const finalBlocks = new Map(
          this.editor.rootBlocks(candidate).map((block) => [block.line, block] as const),
        );
        const roots: RootRevisionOverride[] = [];
        for (const line of rootLines) {
          const block = finalBlocks.get(line);
          const revision = block && this.options.refAuthority.successor(ref.revision, block.source);
          if (!block || !revision) return invalidRecurrence('invalid-task-syntax');
          roots.push({ line, source: block.source, revision });
        }
        const staged = this.options.refAuthority.stage(
          {
            filePath: ref.filePath,
            candidateFingerprint: taskRefContentFingerprint(candidate),
            candidateLength: candidate.length,
            expectedRevision: ref.revision,
            roots,
          },
          indexedRef?.revision ?? '',
        );
        if (staged.type === 'conflict') return { type: 'conflict', current };
        transitionToken = staged.token;
      }
      const finalSnapshots =
        this.options.snapshotState?.previewContent(ref.filePath, candidate) ??
        this.options.snapshotsFromContent(ref.filePath, candidate);
      const active = occurrenceAt(
        finalSnapshots,
        activeRootLine,
        nestedOwner ? relativeLine + cleanOffset : 0,
      );
      const completed = deletesCompleted
        ? undefined
        : occurrenceAt(
            finalSnapshots,
            completedRootLine,
            nestedOwner ? relativeLine + completedOffset : 0,
          );
      if (!active || (!deletesCompleted && !completed)) {
        if (transitionToken) this.options.refAuthority?.abort(transitionToken);
        return invalidRecurrence('invalid-task-syntax');
      }
      this.files.set(ref.filePath, candidate);
      if (transitionToken) {
        this.options.refAuthority?.commit(transitionToken);
        this.options.snapshotState?.installCommittedContent(ref.filePath, candidate);
        this.options.refAuthority?.acknowledge(ref.filePath, candidate);
      }
      return {
        type: 'committed',
        outcome: {
          type: 'recurrence',
          active,
          ...(completed !== undefined && { completed }),
        },
        changed: true,
      };
    } catch {
      if (transitionToken) this.options.refAuthority?.abort(transitionToken);
      return {
        type: 'io-error',
        cause: 'process-error',
        path: ref.filePath,
        contentState: 'unknown',
      };
    }
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
    const target = nodeTarget(command);
    const ref = commandRootRef(command);
    const content = this.files.get(ref.filePath);
    if (content === undefined) return { type: 'not-found', target: targetOf(command) };
    const evidence = this.options.refAuthority?.evidence(ref.revision);
    const indexedRef =
      evidence && this.options.snapshotState?.currentRoot(ref.filePath, ref.line, evidence.source);
    const located = this.locator.locate(this.editor.rootBlocks(content), ref);
    if (
      this.options.refAuthority &&
      this.options.snapshotState &&
      (!indexedRef || indexedRef.revision !== ref.revision)
    ) {
      if (located.type === 'exact') {
        const current = this.snapshot(ref.filePath, content, located.block.line);
        return current
          ? { type: 'conflict', current }
          : { type: 'not-found', target: targetOf(command) };
      }
    }
    if (located.type === 'not-found') return { type: 'not-found', target: targetOf(command) };
    if (located.type === 'conflict') {
      const current = this.snapshot(ref.filePath, content, located.block.line);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: targetOf(command) };
    }
    if (located.type === 'ambiguous') {
      const original = targetOf(command);
      return {
        type: 'ambiguous',
        candidates: located.blocks.flatMap((block) => {
          const root = this.snapshot(ref.filePath, content, block.line);
          if (!root) return [];
          const target =
            original.type === 'comment'
              ? {
                  type: 'comment' as const,
                  ref: { ...original.ref, parent: rebaseNode(original.ref.parent, root.ref) },
                }
              : rebaseNode(original, root.ref);
          return [{ root, target }];
        }),
      };
    }

    if (command.type === 'delete') {
      const current = this.snapshot(ref.filePath, content, located.block.line);
      const next = this.editor.deleteRoot(content, located.block);
      if (!current || next === undefined) return { type: 'not-found', target: targetOf(command) };
      this.files.set(ref.filePath, next);
      this.options.snapshotState?.installCommittedContent(ref.filePath, next);
      return {
        type: 'committed',
        outcome: { type: 'deleted', ref: current.ref },
        changed: true,
      };
    }

    const relativeLine = target ? confirmedLine(target, located.block.source) : 0;
    if (relativeLine === undefined) {
      const current = this.snapshot(ref.filePath, content, located.block.line);
      return current
        ? { type: 'conflict', current }
        : { type: 'not-found', target: targetOf(command) };
    }
    const completionDelete = this.deleteOnCompletion(
      command,
      ref.filePath,
      content,
      located.block,
      relativeLine,
      target,
    );
    if (completionDelete !== undefined) return completionDelete;
    if (isStructuralCommand(command)) {
      const current = this.snapshot(ref.filePath, content, located.block.line);
      const targetSnapshot = target ? current && snapshotNode(current, target) : undefined;
      if (!current || !targetSnapshot) {
        return current
          ? { type: 'conflict', current }
          : { type: 'not-found', target: targetOf(command) };
      }
      if (
        (command.type === 'update-comment' || command.type === 'delete-comment') &&
        !ownsComment(targetSnapshot, command.comment)
      ) {
        return { type: 'conflict', current };
      }
      if (command.type === 'delete-subtask' && !ownsSubtask(targetSnapshot, command.subtask)) {
        return { type: 'conflict', current };
      }
      if (
        command.type === 'reorder-subtask' &&
        (!ownsSubtask(targetSnapshot, command.subtask) ||
          !ownsSubtask(targetSnapshot, command.target))
      ) {
        return { type: 'conflict', current };
      }
      const blockLength = located.block.toLine - located.block.line + 1;
      let editorCommand = command;
      if (command.type === 'add-subtask') {
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
        if (created.type === 'invalid') return created;
        editorCommand = { ...command, text: created.content.slice('- [ ] '.length) };
      }
      const edited = this.editor.edit(
        content,
        located.block,
        blockTarget(targetSnapshot, blockLength, relativeLine),
        structuralEdit(editorCommand),
      );
      if (edited.type === 'conflict') return { type: 'conflict', current };
      if (edited.type === 'invalid') {
        return { type: 'invalid', issues: [{ code: 'invalid-target', field: edited.field }] };
      }
      if (edited.type === 'unchanged') {
        return { type: 'committed', outcome: { type: 'task', task: current }, changed: false };
      }
      return this.commitSurvivingRoot(ref, edited.content, located.block.line);
    }
    if (command.type === 'edit-link' && command.target.type !== 'title') {
      const current = this.snapshot(ref.filePath, content, located.block.line);
      const targetSnapshot = target ? current && snapshotNode(current, target) : undefined;
      if (!current || !targetSnapshot) {
        return current
          ? { type: 'conflict', current }
          : { type: 'not-found', target: targetOf(command) };
      }
      const lines = content.split(/\r?\n/u);
      let targetLine: number | undefined;
      let occurrence = command.occurrence;
      if (command.target.type === 'comment') {
        targetLine = commentLine(located.block.line + relativeLine, command.target.ref, lines);
      } else {
        for (const candidate of this.editor.descriptionLines(
          content,
          located.block,
          blockTarget(targetSnapshot, located.block.toLine - located.block.line + 1, relativeLine),
        )) {
          const count = parseLinks(lines[located.block.line + candidate] ?? '').length;
          if (occurrence < count) {
            targetLine = located.block.line + candidate;
            break;
          }
          occurrence -= count;
        }
      }
      if (targetLine === undefined) {
        if (command.target.type === 'comment') return { type: 'conflict', current };
        return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] };
      }
      const sourceLine = lines[targetLine] ?? '';
      const editResult = this.options.codec.editTextLink(
        sourceLine,
        occurrence,
        command.replacement,
      );
      if (editResult.type === 'invalid') return editResult;
      if (editResult.type === 'unchanged') {
        return { type: 'committed', outcome: { type: 'task', task: current }, changed: false };
      }
      const rootRelative = targetLine - located.block.line;
      const next = this.editor.replaceLine(
        content,
        located.block,
        rootRelative,
        editResult.content,
      ).content;
      return this.commitSurvivingRoot(ref, next, located.block.line);
    }
    const lines = content.split(/\r?\n/u);
    const sourceLine = lines[located.block.line + relativeLine];
    if (sourceLine === undefined) return { type: 'not-found', target: targetOf(command) };
    const result = applyTaskCommand(this.options.codec, sourceLine, command);
    if (result.type === 'invalid') return result;
    const nextLine = result.content;
    const changed = result.type === 'changed';
    const nextContent = changed
      ? this.editor.replaceLine(content, located.block, relativeLine, nextLine).content
      : content;
    if (changed) return this.commitSurvivingRoot(ref, nextContent, located.block.line);
    const root = this.snapshot(ref.filePath, nextContent, located.block.line);
    return root
      ? { type: 'committed', outcome: { type: 'task', task: root }, changed }
      : { type: 'not-found', target: targetOf(command) };
  }

  private commitSurvivingRoot(
    consumed: TaskRef,
    candidate: string,
    line: number,
  ): TaskRepositoryResult {
    const block = this.editor.rootBlocks(candidate).find((root) => root.line === line);
    if (!block) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    let token: object | undefined;
    if (this.options.refAuthority && this.options.snapshotState) {
      const evidence = this.options.refAuthority.evidence(consumed.revision);
      const current =
        evidence &&
        this.options.snapshotState.currentRoot(consumed.filePath, consumed.line, evidence.source);
      const revision = this.options.refAuthority.successor(consumed.revision, block.source);
      if (!current || !revision) {
        return { type: 'not-found', target: { type: 'task', ref: consumed } };
      }
      const staged = this.options.refAuthority.stage(
        {
          filePath: consumed.filePath,
          candidateFingerprint: taskRefContentFingerprint(candidate),
          candidateLength: candidate.length,
          expectedRevision: consumed.revision,
          roots: [{ line, source: block.source, revision }],
        },
        current.revision,
      );
      if (staged.type === 'conflict') {
        const currentTask = this.snapshot(
          consumed.filePath,
          this.files.get(consumed.filePath) ?? '',
          line,
        );
        return currentTask
          ? { type: 'conflict', current: currentTask }
          : { type: 'not-found', target: { type: 'task', ref: consumed } };
      }
      token = staged.token;
    }
    const root = (
      this.options.snapshotState?.previewContent(consumed.filePath, candidate) ??
      this.options.snapshotsFromContent(consumed.filePath, candidate)
    ).find((task) => task.source.line === line);
    if (!root) {
      if (token) this.options.refAuthority?.abort(token);
      return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    }
    this.files.set(consumed.filePath, candidate);
    if (token) this.options.refAuthority?.commit(token);
    const installed = this.options.snapshotState?.installCommittedContent(
      consumed.filePath,
      candidate,
    );
    if (token) this.options.refAuthority?.acknowledge(consumed.filePath, candidate);
    const committed = installed?.find((task) => task.source.line === line) ?? root;
    return { type: 'committed', outcome: { type: 'task', task: committed }, changed: true };
  }

  private snapshot(path: string, content: string, line: number): TaskSnapshot | undefined {
    return this.options
      .snapshotsFromContent(path, content)
      .find((candidate) => candidate.source.line === line);
  }

  private deleteOnCompletion(
    command: TaskEditCommand,
    path: string,
    content: string,
    block: ReturnType<TaskBlockEditor['rootBlocks']>[number],
    relativeLine: number,
    target: PlanningTarget | undefined,
  ): TaskRepositoryResult | undefined {
    if (
      command.type !== 'set-status' ||
      command.stamp === undefined ||
      this.options.codec.statusForSymbol(command.symbol) !== 'done' ||
      target === undefined
    ) {
      return undefined;
    }
    const current = this.snapshot(path, content, block.line);
    const owner = current && snapshotNode(current, target);
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
    const next = this.editor.replaceOwnedTaskSubtree(content, block, relativeLine, []);
    if (next === undefined) return invalidRecurrence('invalid-task-syntax');
    const updatedBlock = this.editor
      .rootBlocks(next)
      .find((candidate) => candidate.line === block.line);
    const root = updatedBlock && this.snapshot(path, next, updatedBlock.line);
    if (!root) return invalidRecurrence('invalid-task-syntax');
    if (this.options.snapshotState) {
      return this.commitSurvivingRoot(current.ref, next, updatedBlock.line);
    }
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
      const current = this.snapshot(path, content, located.block.line);
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
}
