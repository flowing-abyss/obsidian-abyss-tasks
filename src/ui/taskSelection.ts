import type {
  SubtaskRef,
  SubtaskSnapshot,
  TaskIndexEvent,
  TaskNodeRef,
  TaskQueryApi,
  TaskRef,
  TaskSnapshot,
} from '../tasks';

export type TaskSelectionNode = TaskSnapshot | SubtaskSnapshot;

export function taskNodeRef(node: TaskSelectionNode): TaskNodeRef {
  return 'parent' in node.ref
    ? { type: 'subtask', ref: node.ref }
    : { type: 'task', ref: node.ref };
}

export function rootTaskRef(node: TaskSelectionNode): TaskRef {
  let ref = taskNodeRef(node);
  while (ref.type === 'subtask') ref = ref.ref.parent;
  return ref.ref;
}

export function taskNodeLine(root: TaskSnapshot, node: TaskSelectionNode): number {
  if (!('parent' in node.ref)) return (node as TaskSnapshot).source.line;
  let line = root.source.line;
  let ref: SubtaskRef | undefined = node.ref;
  const offsets: number[] = [];
  while (ref) {
    offsets.push(ref.relativeLine);
    ref = ref.parent.type === 'subtask' ? ref.parent.ref : undefined;
  }
  return offsets.reduce((sum, offset) => sum + offset, line);
}

export function rebuildTaskSelection(
  root: TaskSnapshot,
  staleStack: readonly TaskSelectionNode[],
): TaskSelectionNode[] {
  const stack: TaskSelectionNode[] = [root];
  for (let index = 1; index < staleStack.length; index++) {
    const parent = stack[index - 1];
    const stale = staleStack[index];
    if (!parent || !stale || 'source' in stale) break;
    const candidates = parent.subtasks;
    const matches = candidates.filter(
      (candidate) => candidate.ref.originalBlock === stale.ref.originalBlock,
    );
    const child = matches.length === 1 ? matches[0] : undefined;
    if (!child) break;
    stack.push(child);
  }
  return stack;
}

export function renamedRootSelection(
  event: TaskIndexEvent,
  staleRoot: TaskSnapshot,
  queries: TaskQueryApi,
): TaskSnapshot | undefined {
  if (event.type !== 'renamed' || staleRoot.ref.filePath !== event.oldPath) return undefined;
  const matches = queries
    .list({ filePath: event.newPath })
    .filter(
      (candidate) =>
        candidate.source.line === staleRoot.source.line &&
        candidate.source.originalBlock === staleRoot.source.originalBlock,
    );
  return matches.length === 1 ? matches[0] : undefined;
}
