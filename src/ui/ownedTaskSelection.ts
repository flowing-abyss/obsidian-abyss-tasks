import {
  sameTaskNodeRef,
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

function childPath(root: TaskSnapshot, target: TaskNodeRef): number[] | undefined {
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
    if (child === undefined || !uniqueSource(current, child)) return undefined;
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

function follow(root: TaskSnapshot, indices: readonly number[]): TaskSelectionNode[] | undefined {
  const stack: TaskSelectionNode[] = [root];
  let parent: TaskSelectionNode = root;
  for (const index of indices) {
    const child: SubtaskSnapshot | undefined = parent.subtasks[index];
    if (child === undefined || !uniqueSource(parent, child)) return undefined;
    stack.push(child);
    parent = child;
  }
  return stack;
}

function comparable(value: unknown, omitted: ReadonlySet<string>, path = ''): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => comparable(item, omitted, path));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, child]) => {
        const next = path === '' ? key : `${path}.${key}`;
        return key === 'ref' || omitted.has(next) ? [] : [[key, comparable(child, omitted, next)]];
      }),
  );
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
  command: ContentCommand,
): Set<string> | undefined {
  if (command.type === 'patch') return patchFields(after, command.patch);
  if (command.type === 'set-description') {
    return after.description === (command.text ?? undefined) ? new Set(['description']) : undefined;
  }
  if (before.recurrence !== undefined || before.onCompletion === 'delete') return undefined;
  const matches =
    command.type === 'set-status'
      ? after.statusSymbol === command.symbol
      : before.statusSymbol !== after.statusSymbol;
  return matches
    ? new Set(['status', 'statusSymbol', 'planning.completion', 'planning.cancelled'])
    : undefined;
}

function sameTree(
  before: TaskSelectionNode,
  after: TaskSelectionNode,
  path: readonly number[] | undefined,
  fields: ReadonlySet<string>,
): boolean {
  if (before.subtasks.length !== after.subtasks.length) return false;
  if (
    path === undefined &&
    !('source' in before) &&
    !('source' in after) &&
    before.ref.originalBlock !== after.ref.originalBlock
  )
    return false;
  const omitted = new Set([
    'subtasks',
    'source',
    'presentation',
    ...(path?.length === 0 ? fields : []),
  ]);
  if (JSON.stringify(comparable(before, omitted)) !== JSON.stringify(comparable(after, omitted)))
    return false;
  return before.subtasks.every((child, index) => {
    const next = after.subtasks[index];
    return (
      next !== undefined &&
      sameTree(child, next, path?.[0] === index ? path.slice(1) : undefined, fields)
    );
  });
}

function selectionPaths(
  current: TaskSnapshot,
  selection: readonly TaskSelectionNode[],
  target: TaskNodeRef,
): { before: TaskSnapshot; selectedPath: number[]; editedPath: number[] } | undefined {
  const before = selection[0];
  const selected = selection[selection.length - 1];
  if (before === undefined || selected === undefined || !('source' in before)) return undefined;
  if (before.ref.filePath !== current.ref.filePath || before.ref.line !== current.ref.line)
    return undefined;
  const selectedPath = childPath(before, taskNodeRef(selected));
  const editedPath = childPath(before, target);
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
  if (!['patch', 'set-description', 'set-status', 'toggle-completion'].includes(command.type))
    return undefined;
  const edit = command as ContentCommand;
  const paths = selectionPaths(current, selection, edit.target);
  if (paths === undefined) return undefined;
  const { before, selectedPath, editedPath } = paths;
  const beforeEdit = follow(before, editedPath)?.[editedPath.length];
  const afterEdit = follow(current, editedPath)?.[editedPath.length];
  if (beforeEdit === undefined || afterEdit === undefined) return undefined;
  const fields = editedFields(beforeEdit, afterEdit, edit);
  if (fields === undefined || !sameTree(before, current, editedPath, fields)) return undefined;
  return follow(current, selectedPath);
}
