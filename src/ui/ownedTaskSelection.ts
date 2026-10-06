import { parseLinks } from '../markdown/links';
import { sameTag } from '../markdown/tagSyntax';
import {
  dependencySubtaskChild,
  normalizeCommentText,
  sameTaskNodeRef,
  sameTaskTreeWithOwnedChanges,
  type SubtaskSnapshot,
  type TaskCommand,
  type TaskNodeRef,
  type TaskPatch,
  type TaskSnapshot,
} from '../tasks';
import { taskNodeRef, type TaskSelectionNode } from './taskSelection';

type ContentCommand = Extract<
  TaskCommand,
  { type: 'patch' | 'set-description' | 'set-status' | 'toggle-completion' }
>;

function childPath(root: TaskSnapshot, target: TaskNodeRef, unique: boolean): number[] | undefined {
  const refs: TaskNodeRef[] = [];
  let reference = target;
  while (reference.type === 'subtask') {
    refs.unshift(reference);
    reference = reference.ref.parent;
  }
  if (!sameTaskNodeRef(taskNodeRef(root), reference)) return undefined;
  const indices: number[] = [];
  let current: TaskSelectionNode = root;
  for (const ref of refs) {
    const index: number = current.subtasks.findIndex((child) =>
      sameTaskNodeRef(taskNodeRef(child), ref),
    );
    const child: SubtaskSnapshot | undefined = current.subtasks[index];
    if (child === undefined || (unique && !uniqueSource(current, child))) return undefined;
    indices.push(index);
    current = child;
  }
  return indices;
}

function uniqueSource(parent: TaskSelectionNode, child: SubtaskSnapshot): boolean {
  return (
    parent.subtasks.filter((candidate) => candidate.ref.originalBlock === child.ref.originalBlock)
      .length === 1
  );
}

function follow(
  root: TaskSnapshot,
  indices: readonly number[],
  unique: boolean,
): TaskSelectionNode[] | undefined {
  const stack: TaskSelectionNode[] = [root];
  let parent: TaskSelectionNode = root;
  for (const index of indices) {
    const child: SubtaskSnapshot | undefined = parent.subtasks[index];
    if (child === undefined || (unique && !uniqueSource(parent, child))) return undefined;
    stack.push(child);
    parent = child;
  }
  return stack;
}

const PLANNING_FIELDS = new Set(['due', 'scheduled', 'start', 'time', 'duration']);

function clearedField(key: string): unknown {
  if (key === 'priority') return 'D';
  if (key === 'onCompletion') return 'keep';
  return undefined;
}

function matchesPatch(
  before: TaskSelectionNode,
  node: TaskSelectionNode,
  key: string,
  update: unknown,
): boolean {
  if (key === 'tags') return matchesTagPatch(before, node, update as TaskPatch['tags']);
  const record = (PLANNING_FIELDS.has(key) ? node.planning : node) as unknown as Record<
    string,
    unknown
  >;
  const value = update as { type: 'set'; value: unknown } | { type: 'clear' };
  return record[key] === (value.type === 'set' ? value.value : clearedField(key));
}

function matchesTagPatch(
  before: TaskSelectionNode,
  after: TaskSelectionNode,
  tags: TaskPatch['tags'],
): boolean {
  const normalize = (tag: string): string => (tag.startsWith('#') ? tag : `#${tag}`);
  const remove = new Set((tags?.remove ?? []).map(normalize));
  const remaining = before.tags.filter(
    (tag) => ![...remove].some((candidate) => sameTag(candidate, tag)),
  );
  const add = (tags?.add ?? [])
    .map(normalize)
    .filter((tag, index, all) => all.findIndex((candidate) => sameTag(candidate, tag)) === index);
  const expected = [
    ...remaining,
    ...add.filter((tag) => !remaining.some((candidate) => sameTag(candidate, tag))),
  ];
  return (
    expected.length === after.tags.length &&
    expected.every((tag, index) => tag === after.tags[index])
  );
}

function patchFields(
  before: TaskSelectionNode,
  after: TaskSelectionNode,
  patch: TaskPatch,
): Set<string> | undefined {
  const fields = new Set<string>();
  for (const [key, update] of Object.entries(patch)) {
    if (!matchesPatch(before, after, key, update)) return undefined;
    fields.add(PLANNING_FIELDS.has(key) ? `planning.${key}` : key);
    if (key === 'markdownTitle') fields.add('title');
    if (key === 'onCompletion') fields.add('onCompletionExplicit');
  }
  return fields;
}

function editedFields(
  before: TaskSelectionNode,
  after: TaskSelectionNode,
  command: ContentCommand | Extract<TaskCommand, { type: 'create-dependency-subtask' }>,
  policy?: Parameters<typeof dependencySubtaskChild>[3],
): Set<string> | undefined {
  if (command.type === 'create-dependency-subtask')
    return dependencySubtaskChild(before, after, command, policy) === undefined
      ? undefined
      : new Set(['dependencyId', 'dependsOn']);
  if (command.type === 'patch') return patchFields(before, after, command.patch);
  if (command.type === 'set-description') {
    return after.description === (command.text ?? undefined) ? new Set(['description']) : undefined;
  }
  return statusFields(before, after, command);
}

function statusFields(
  before: TaskSelectionNode,
  after: TaskSelectionNode,
  command: Extract<ContentCommand, { type: 'set-status' | 'toggle-completion' }>,
): Set<string> | undefined {
  if (before.recurrence !== undefined || before.onCompletion === 'delete') return undefined;
  const matches =
    command.type === 'set-status'
      ? after.statusSymbol === command.symbol
      : before.statusSymbol !== after.statusSymbol;
  return matches
    ? new Set(['status', 'statusSymbol', 'planning.completion', 'planning.cancelled'])
    : undefined;
}

function selectionPaths(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  target: TaskNodeRef,
  unique: boolean,
): { before: TaskSnapshot; selectedPath: number[]; editedPath: number[] } | undefined {
  const before = selection[0];
  const selected = selection[selection.length - 1];
  if (before === undefined || selected === undefined || !('source' in before)) return undefined;
  if (before.ref.filePath !== current.ref.filePath || before.ref.line !== current.ref.line)
    return undefined;
  const selectedPath = childPath(before, taskNodeRef(selected), unique);
  const editedPath = childPath(before, target, unique);
  if (
    selectedPath === undefined ||
    editedPath === undefined ||
    selectedPath.length + 1 !== selection.length
  )
    return undefined;
  return { before, selectedPath, editedPath };
}

export interface OwnedTaskSelectionProof {
  readonly selection: TaskSelectionNode[];
  readonly successor: (previous: TaskSelectionNode) => TaskSelectionNode | undefined;
}

/** Prove once, then index the exact surviving occurrences for mounted action owners. */
export function proveOwnedTaskSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: TaskCommand,
  policy?: Parameters<typeof dependencySubtaskChild>[3],
): OwnedTaskSelectionProof | undefined {
  const rebuilt = rebuildSelection(current, selection, command, policy);
  const before = selection[0];
  if (rebuilt === undefined || before === undefined) return undefined;
  const successors = new Map<string, TaskSelectionNode>();
  const splice = command.type === 'delete-subtask' || command.type === 'restore-subtask';
  const restore = command.type === 'restore-subtask';
  let parent: TaskNodeRef | undefined;
  if (command.type === 'restore-subtask') parent = command.parent;
  if (command.type === 'delete-subtask') parent = command.subtask.parent;
  const visit = (previous: TaskSelectionNode, next: TaskSelectionNode): void => {
    successors.set(JSON.stringify(taskNodeRef(previous)), next);
    const edited = parent !== undefined && sameTaskNodeRef(taskNodeRef(previous), parent);
    const expanded = restore ? next : previous;
    const index = edited && splice ? removalIndex(expanded, command) : -1;
    previous.subtasks.forEach((child, position) => {
      if (edited && !restore && position === index) return;
      const shift = restore ? 1 : -1;
      const shifted = edited && position >= index ? position + shift : position;
      const successor = next.subtasks[shifted];
      if (successor !== undefined) visit(child, successor);
    });
  };
  visit(before, current);
  return {
    selection: rebuilt,
    successor: (previous) => successors.get(JSON.stringify(taskNodeRef(previous))),
  };
}

export function rebuildOwnedTaskSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: TaskCommand,
  policy?: Parameters<typeof dependencySubtaskChild>[3],
): TaskSelectionNode[] | undefined {
  return proveOwnedTaskSelection(current, selection, command, policy)?.selection;
}

/** Called only for a pending inspector command's exact authority transition. */
function rebuildSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: TaskCommand,
  policy?: Parameters<typeof dependencySubtaskChild>[3],
): TaskSelectionNode[] | undefined {
  if (command.type === 'edit-link') return rebuildLinkSelection(current, selection, command);
  if (command.type === 'delete-subtask' || command.type === 'restore-subtask')
    return rebuildRemovalSelection(current, selection, command);
  if (command.type === 'add-subtask' || command.type === 'add-comment')
    return rebuildInsertionSelection(current, selection, command, policy);
  return rebuildContentSelection(current, selection, command, policy);
}

type LinkCommand = Extract<TaskCommand, { type: 'edit-link' }>;

function exactLinkSourceChange(
  before: string,
  after: string,
  raw: string,
  replacement: string,
): boolean {
  for (
    let index = before.indexOf(raw);
    index >= 0;
    index = before.indexOf(raw, index + raw.length)
  ) {
    if (before.slice(0, index) + replacement + before.slice(index + raw.length) === after)
      return true;
  }
  return false;
}

function linkText(node: TaskSelectionNode, command: LinkCommand): string | undefined {
  const target = command.target;
  if (target.type === 'title') return node.markdownTitle;
  if (target.type === 'description') return node.description;
  return node.comments.find((comment) => comment.ref.relativeLine === target.ref.relativeLine)
    ?.text;
}

function linkCommentsMatch(
  before: TaskSelectionNode,
  after: TaskSelectionNode,
  command: LinkCommand,
  change: { text: string; raw: string },
): boolean {
  const { text, raw } = change;
  const target = command.target;
  if (target.type !== 'comment' || before.comments.length !== after.comments.length) return false;
  return before.comments.every((comment, index) => {
    const next = after.comments[index];
    if (
      next?.ref.relativeLine !== comment.ref.relativeLine ||
      JSON.stringify(next.timestamp) !== JSON.stringify(comment.timestamp)
    )
      return false;
    const edited = comment.ref.relativeLine === target.ref.relativeLine;
    return edited
      ? comment.ref.originalMarkdown === target.ref.originalMarkdown &&
          next.text === text &&
          exactLinkSourceChange(
            comment.ref.originalMarkdown,
            next.ref.originalMarkdown,
            raw,
            command.replacement,
          )
      : comment.text === next.text && comment.ref.originalMarkdown === next.ref.originalMarkdown;
  });
}

function linkChange(
  previous: TaskSelectionNode,
  next: TaskSelectionNode,
  command: LinkCommand,
): { raw: string; fields: Set<string> } | undefined {
  const text = linkText(previous, command);
  if (text === undefined) return undefined;
  const token = parseLinks(text)[command.occurrence];
  if (token === undefined) return undefined;
  const expected =
    text.slice(0, token.index) + command.replacement + text.slice(token.index + token.raw.length);
  if (command.target.type === 'comment') {
    return linkCommentsMatch(previous, next, command, { text: expected, raw: token.raw })
      ? { raw: token.raw, fields: new Set(['comments']) }
      : undefined;
  }
  if (linkText(next, command) !== expected) return undefined;
  return {
    raw: token.raw,
    fields: new Set(command.target.type === 'title' ? ['title', 'markdownTitle'] : ['description']),
  };
}

function rebuildLinkSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: LinkCommand,
): TaskSelectionNode[] | undefined {
  const target =
    command.target.type === 'comment' ? command.target.ref.parent : command.target.target;
  const paths = selectionPaths(current, selection, target, true);
  if (paths === undefined) return undefined;
  const { before, selectedPath, editedPath } = paths;
  const previous = follow(before, editedPath, true)?.[editedPath.length];
  const next = follow(current, editedPath, true)?.[editedPath.length];
  if (previous === undefined || next === undefined) return undefined;
  const change = linkChange(previous, next, command);
  if (change === undefined) return undefined;
  if (
    !exactLinkSourceChange(
      before.source.originalBlock,
      current.source.originalBlock,
      change.raw,
      command.replacement,
    ) ||
    !sameTaskTreeWithOwnedChanges(before, current, editedPath, { fields: change.fields })
  )
    return undefined;
  return follow(current, selectedPath, true);
}

function rebuildContentSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: TaskCommand,
  policy?: Parameters<typeof dependencySubtaskChild>[3],
): TaskSelectionNode[] | undefined {
  if (
    ![
      'patch',
      'set-description',
      'set-status',
      'toggle-completion',
      'create-dependency-subtask',
    ].includes(command.type)
  )
    return undefined;
  const edit = command as
    ContentCommand | Extract<TaskCommand, { type: 'create-dependency-subtask' }>;
  const append = edit.type === 'create-dependency-subtask';
  const paths = selectionPaths(current, selection, append ? edit.current : edit.target, !append);
  if (paths === undefined) return undefined;
  const { before, selectedPath, editedPath } = paths;
  const beforeEdit = follow(before, editedPath, !append)?.[editedPath.length];
  const afterEdit = follow(current, editedPath, !append)?.[editedPath.length];
  if (beforeEdit === undefined || afterEdit === undefined) return undefined;
  const fields = editedFields(beforeEdit, afterEdit, edit, policy);
  if (
    fields === undefined ||
    !sameTaskTreeWithOwnedChanges(before, current, editedPath, { fields, append })
  )
    return undefined;
  return follow(current, selectedPath, !append);
}

function rebuildRemovalSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: Extract<TaskCommand, { type: 'delete-subtask' | 'restore-subtask' }>,
): TaskSelectionNode[] | undefined {
  const restore = command.type === 'restore-subtask';
  const parent = restore ? command.parent : command.subtask.parent;
  // Structural commands carry exact relative-line refs and are verified below by
  // a single-child splice proof. Requiring source uniqueness before that proof
  // would lose the selected occurrence after deleting its distinguishing child.
  const paths = selectionPaths(current, selection, parent, false);
  if (paths === undefined) return undefined;
  const { before, selectedPath, editedPath } = paths;
  const expanded = restore ? current : before;
  const parentNode = follow(expanded, editedPath, true)?.[editedPath.length];
  if (parentNode === undefined) return undefined;
  const index = removalIndex(parentNode, command);
  if (
    index < 0 ||
    !sameTaskTreeWithOwnedChanges(expanded, restore ? before : current, editedPath, {
      fields: new Set(),
      remove: index,
    })
  )
    return undefined;
  spliceSelectionPath(selectedPath, editedPath, index, restore);
  // The exact splice proof makes the positional path authoritative even when
  // removing the last child makes its parent byte-identical to a sibling.
  return follow(current, selectedPath, false);
}

function removalIndex(
  parent: TaskSelectionNode,
  command: Extract<TaskCommand, { type: 'delete-subtask' | 'restore-subtask' }>,
): number {
  return parent.subtasks.findIndex((child) =>
    command.type === 'restore-subtask'
      ? child.ref.relativeLine === command.placement.relativeLine &&
        child.ref.originalBlock === command.markdown.replace(/\n$/u, '')
      : sameTaskNodeRef(taskNodeRef(child), { type: 'subtask', ref: command.subtask }),
  );
}

function spliceSelectionPath(
  selectedPath: number[],
  editedPath: readonly number[],
  index: number,
  restore: boolean,
): void {
  // Paths below the edited parent move only by the proven single-child splice.
  const depth = editedPath.length;
  const selectedChild = selectedPath[depth];
  if (selectedChild !== undefined && editedPath.every((part, i) => selectedPath[i] === part)) {
    if (!restore && selectedChild === index) selectedPath.splice(depth);
    else if (selectedChild >= index) selectedPath[depth] = selectedChild + (restore ? 1 : -1);
  }
}

function rebuildInsertionSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: Extract<TaskCommand, { type: 'add-subtask' | 'add-comment' }>,
  policy?: Parameters<typeof dependencySubtaskChild>[3],
): TaskSelectionNode[] | undefined {
  const normalized =
    command.type === 'add-comment'
      ? normalizeCommentText(command.text)
      : { type: 'ready' as const, text: command.text };
  if (normalized.type !== 'ready') return undefined;
  const paths = selectionPaths(current, selection, command.parent, false);
  if (paths === undefined) return undefined;
  const { before, selectedPath, editedPath } = paths;
  if (
    !sameTaskTreeWithOwnedChanges(before, current, editedPath, {
      fields: new Set(command.type === 'add-comment' ? ['comments'] : []),
      append: command.type === 'add-subtask',
      insertion: {
        type: command.type,
        text: normalized.text,
        ...(policy === undefined ? {} : { policy }),
      },
    })
  )
    return undefined;
  return follow(current, selectedPath, false);
}
