import {
  sameTaskNodeRef,
  sameTaskTreeExceptDependencies,
  type SubtaskRef,
  type SubtaskSnapshot,
  type TaskIndexEvent,
  type TaskNodeRef,
  type TaskQueryApi,
  type TaskRef,
  type TaskSnapshot,
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
  const line = root.source.line;
  let ref: SubtaskRef | undefined = node.ref;
  const offsets: number[] = [];
  while (ref != null) {
    offsets.push(ref.relativeLine);
    ref = ref.parent.type === 'subtask' ? ref.parent.ref : undefined;
  }
  return offsets.reduce((sum, offset) => sum + offset, line);
}

export function rebuildTaskSelection(
  root: TaskSnapshot,
  staleStack: readonly TaskSelectionNode[],
  options: { readonly preserveDependencyChanges?: boolean } = {},
): TaskSelectionNode[] {
  const stack: TaskSelectionNode[] = [root];
  const previousRoot = staleStack[0];
  const preserveDependencies =
    options.preserveDependencyChanges === true &&
    previousRoot !== undefined &&
    'source' in previousRoot &&
    sameTaskTreeExceptDependencies(previousRoot, root);
  for (let index = 1; index < staleStack.length; index++) {
    const parent = stack[index - 1];
    const stale = staleStack[index];
    if (parent == null || stale == null || 'source' in stale) break;
    const child = selectionChild(
      parent.subtasks,
      stale,
      staleStack[index - 1],
      preserveDependencies,
    );
    if (child == null) break;
    stack.push(child);
  }
  return stack;
}

function selectionChild(
  candidates: readonly SubtaskSnapshot[],
  stale: SubtaskSnapshot,
  previousParent: TaskSelectionNode | undefined,
  preserveDependencies: boolean,
): SubtaskSnapshot | undefined {
  const exact = candidates.filter((candidate) =>
    sameTaskNodeRef(taskNodeRef(candidate), taskNodeRef(stale)),
  );
  if (exact.length === 1) return exact[0];
  const positioned = preserveDependencies ? dependencyChangedChild(candidates, stale) : undefined;
  if (positioned !== undefined) return positioned;
  const matches = candidates.filter(
    (candidate) => candidate.ref.originalBlock === stale.ref.originalBlock,
  );
  const previousMatches = previousParent?.subtasks.filter(
    (candidate) => candidate.ref.originalBlock === stale.ref.originalBlock,
  );
  return previousMatches?.length === 1 && matches.length === 1 ? matches[0] : undefined;
}

function dependencyChangedChild(
  candidates: readonly SubtaskSnapshot[],
  stale: SubtaskSnapshot,
): SubtaskSnapshot | undefined {
  const positioned = candidates.filter(
    (candidate) => candidate.ref.relativeLine === stale.ref.relativeLine,
  );
  return positioned.length === 1 ? positioned[0] : undefined;
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
