import {
  dependencySubtaskChild,
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

function uniqueSource(parent: TaskSelectionNode, child: TaskSelectionNode): boolean {
  return (
    parent.subtasks.filter(
      (candidate) =>
        candidate.ref.originalBlock ===
        ('source' in child ? child.source.originalBlock : child.ref.originalBlock),
    ).length === 1
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

function matchesPatch(node: TaskSelectionNode, key: string, update: unknown): boolean {
  const record = (PLANNING_FIELDS.has(key) ? node.planning : node) as unknown as Record<
    string,
    unknown
  >;
  const value = update as { type: 'set'; value: unknown } | { type: 'clear' };
  return record[key] === (value.type === 'set' ? value.value : clearedField(key));
}

function patchFields(node: TaskSelectionNode, patch: TaskPatch): Set<string> | undefined {
  const fields = new Set<string>();
  for (const [key, update] of Object.entries(patch)) {
    if (key === 'tags' || !matchesPatch(node, key, update)) return undefined;
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
): Set<string> | undefined {
  if (command.type === 'create-dependency-subtask')
    return dependencySubtaskChild(before, after, command) === undefined
      ? undefined
      : new Set(['dependencyId', 'dependsOn']);
  if (command.type === 'patch') return patchFields(after, command.patch);
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

/** Called only for a pending inspector command's exact authority transition. */
export function rebuildOwnedTaskSelection(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  command: TaskCommand,
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
  const fields = editedFields(beforeEdit, afterEdit, edit);
  if (
    fields === undefined ||
    !sameTaskTreeWithOwnedChanges(before, current, editedPath, { fields, append })
  )
    return undefined;
  return follow(current, selectedPath, !append);
}
