import { parseLinks } from '../../src/parser/links';
import type {
  TaskDraft,
  TaskEditCommand,
  TaskRepository,
  TaskRepositoryResult,
} from '../../src/tasks/application/TaskRepository';
import type { PlanningTarget } from '../../src/tasks/domain/commands';
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
  type TaskBlockEdit,
  TaskBlockEditor,
} from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';

interface Options {
  readonly files: Record<string, string>;
  readonly codec: TaskMarkdownCodec;
  readonly snapshotsFromContent: (path: string, content: string) => readonly TaskSnapshot[];
  readonly editor?: TaskBlockEditor;
  readonly locator?: TaskLocator;
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
    return { type: 'committed', outcome: { type: 'task', task }, changed: true };
  }

  async move(ref: TaskRef, destination: TaskDestination): Promise<TaskRepositoryResult> {
    const sourceContent = this.files.get(ref.filePath);
    if (sourceContent === undefined) {
      return { type: 'not-found', target: { type: 'task', ref } };
    }
    const located = this.locator.locate(this.editor.rootBlocks(sourceContent), ref);
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
    const copiedTask = this.snapshot(destination.filePath, inserted.content, inserted.block.line);
    if (!copiedTask) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
    const sourceWithoutTask = this.editor.deleteRoot(sourceContent, located.block);
    if (sourceWithoutTask === undefined) {
      return { type: 'not-found', target: { type: 'task', ref: current.ref } };
    }
    this.files.set(destination.filePath, inserted.content);
    this.files.set(ref.filePath, sourceWithoutTask);
    return {
      type: 'committed',
      outcome: { type: 'task', task: copiedTask },
      changed: true,
    };
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
    const located = this.locator.locate(this.editor.rootBlocks(content), ref);
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
      const root = this.snapshot(ref.filePath, edited.content, located.block.line);
      if (!root) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
      this.files.set(ref.filePath, edited.content);
      return { type: 'committed', outcome: { type: 'task', task: root }, changed: true };
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
      this.files.set(ref.filePath, next);
      const root = this.snapshot(ref.filePath, next, located.block.line);
      return root
        ? { type: 'committed', outcome: { type: 'task', task: root }, changed: true }
        : { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
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
    if (changed) this.files.set(ref.filePath, nextContent);
    const root = this.snapshot(ref.filePath, nextContent, located.block.line);
    return root
      ? { type: 'committed', outcome: { type: 'task', task: root }, changed }
      : { type: 'not-found', target: targetOf(command) };
  }

  private snapshot(path: string, content: string, line: number): TaskSnapshot | undefined {
    return this.options
      .snapshotsFromContent(path, content)
      .find((candidate) => candidate.source.line === line);
  }
}
