import { TFile, type App } from 'obsidian';
import { parseLinks } from '../../../parser/links';
import type {
  TaskDraft,
  TaskEditCommand,
  TaskRepository,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import type { MoveRecovery, PlanningTarget, TaskResolutionCandidate } from '../../domain/commands';
import type {
  CommentRef,
  SubtaskRef,
  SubtaskSnapshot,
  TaskDestination,
  TaskMutationTarget,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from '../../domain/types';
import { sameTaskNodeRef } from '../../domain/types';
import { applyTaskCommand } from '../markdown/applyTaskCommand';
import { createTaskLine } from '../markdown/createTaskLine';
import type { TaskBlockEdit, TaskRootBlock } from '../markdown/TaskBlockEditor';
import { TaskBlockEditor } from '../markdown/TaskBlockEditor';
import { TaskLocator } from '../markdown/TaskLocator';
import { TaskMarkdownCodec } from '../markdown/TaskMarkdownCodec';

interface RepositoryOptions {
  readonly codec: TaskMarkdownCodec;
  readonly editor: TaskBlockEditor;
  readonly locator: TaskLocator;
  readonly snapshotsFromContent: (filePath: string, content: string) => readonly TaskSnapshot[];
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
    const line = createTaskLine(this.options.codec, draft);
    if (line.type === 'invalid') return line;
    let result: TaskRepositoryResult | undefined;
    try {
      await this.processFile(file, (content) => {
        const inserted = this.options.editor.insertRoot(
          content,
          line.content,
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
        return inserted.content;
      });
    } catch {
      return {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      };
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
    const sourceLocated = this.options.locator.locate(
      this.options.editor.rootBlocks(sourceContent),
      ref,
    );
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

    let targetResult: TaskRepositoryResult | undefined;
    try {
      await this.processFile(targetFile, (content) => {
        const inserted = this.options.editor.insertRootBlock(
          content,
          sourceLocated.block.source,
          destination.insertion,
        );
        if (!inserted) {
          targetResult = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        const copiedTask = this.snapshotFor(destination.filePath, inserted.content, inserted.block);
        if (!copiedTask) {
          targetResult = { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
          return content;
        }
        targetResult = {
          type: 'committed',
          outcome: { type: 'task', task: copiedTask },
          changed: true,
        };
        return inserted.content;
      });
    } catch {
      return {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      };
    }
    if (!targetResult) {
      return {
        type: 'io-error',
        cause: 'process-error',
        path: destination.filePath,
        contentState: 'unknown',
      };
    }
    if (targetResult.type !== 'committed' || targetResult.outcome.type !== 'task') {
      return targetResult;
    }

    const copiedTask = targetResult.outcome.task;
    const removalFile = this.app.vault.getAbstractFileByPath(sourceTask.ref.filePath);
    if (!(removalFile instanceof TFile)) {
      return this.partialMove(sourceTask.ref, destination.filePath, copiedTask, 'not-found');
    }
    let removalPrepared = false;
    let removalCommitted = false;
    let sourceFailure: MoveRecovery['cause'] | undefined;
    try {
      await this.processFile(removalFile, (content) => {
        const located = this.options.locator.locate(
          this.options.editor.rootBlocks(content),
          sourceTask.ref,
        );
        if (located.type !== 'exact') {
          sourceFailure = located.type;
          return content;
        }
        const current = this.snapshotFor(sourceTask.ref.filePath, content, located.block);
        if (!current) {
          sourceFailure = 'not-found';
          return content;
        }
        const next = this.options.editor.deleteRoot(content, located.block);
        if (next === undefined) {
          sourceFailure = 'not-found';
          return content;
        }
        removalPrepared = true;
        return next;
      });
      removalCommitted = removalPrepared && sourceFailure === undefined;
    } catch {
      sourceFailure = 'io-error';
    }
    if (!removalCommitted) {
      return this.partialMove(
        sourceTask.ref,
        destination.filePath,
        copiedTask,
        sourceFailure ?? 'io-error',
      );
    }
    return targetResult;
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
    try {
      await this.processFile(file, (content) => {
        const blocks = this.options.editor.rootBlocks(content);
        const located = this.options.locator.locate(blocks, rootRef);
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
      });
    } catch {
      return {
        type: 'io-error',
        cause: 'process-error',
        path: rootRef.filePath,
        contentState: 'unknown',
      };
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
    const edited = this.options.editor.edit(
      content,
      block,
      blockTarget(node, block, relativeLine),
      structuralEdit(command),
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
    const snapshot = this.options
      .snapshotsFromContent(path, content)
      .find((candidate) => candidate.source.line === block.line);
    if (!snapshot) return undefined;
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
}
