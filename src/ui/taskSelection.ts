import {
  sameTaskNodeRef,
  sameTaskTreeExceptDependencies,
  sameTaskTreeExceptTimeEntries,
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

/** The root task a node reference hangs off, which is the only part of it that names a file. */
export function rootTaskNodeRef(ref: TaskNodeRef): TaskRef {
  let current = ref;
  while (current.type === 'subtask') current = current.ref.parent;
  return current.ref;
}

export function rootTaskRef(node: TaskSelectionNode): TaskRef {
  return rootTaskNodeRef(taskNodeRef(node));
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
  const proofs = selectionProofs(root, staleStack[0], options.preserveDependencyChanges === true);
  for (let index = 1; index < staleStack.length; index++) {
    const parent = stack[index - 1];
    const stale = staleStack[index];
    if (parent == null || stale == null || 'source' in stale) break;
    const child = selectionChild(parent.subtasks, stale, staleStack[index - 1], proofs);
    if (child == null) break;
    stack.push(child);
  }
  return stack;
}

interface SelectionProofs {
  readonly preserveDependencies: boolean;
  readonly timeEntriesOnly: () => boolean;
}

/** The whole-tree proofs a positional match needs, each read at most once per rebuild. */
function selectionProofs(
  root: TaskSnapshot,
  previousRoot: TaskSelectionNode | undefined,
  preserveDependencyChanges: boolean,
): SelectionProofs {
  const staleRoot =
    previousRoot !== undefined && 'source' in previousRoot ? previousRoot : undefined;
  let trackedOnly: boolean | undefined;
  return {
    preserveDependencies:
      preserveDependencyChanges &&
      staleRoot !== undefined &&
      sameTaskTreeExceptDependencies(staleRoot, root),
    // Read only after a match on the node's own text has already failed.
    timeEntriesOnly: () =>
      (trackedOnly ??= staleRoot !== undefined && sameTaskTreeExceptTimeEntries(staleRoot, root)),
  };
}

function selectionChild(
  candidates: readonly SubtaskSnapshot[],
  stale: SubtaskSnapshot,
  previousParent: TaskSelectionNode | undefined,
  proofs: SelectionProofs,
): SubtaskSnapshot | undefined {
  const exact = candidates.filter((candidate) =>
    sameTaskNodeRef(taskNodeRef(candidate), taskNodeRef(stale)),
  );
  if (exact.length === 1) return exact[0];
  const positioned = proofs.preserveDependencies
    ? dependencyChangedChild(candidates, stale)
    : undefined;
  if (positioned !== undefined) return positioned;
  const tracked = trackedChild(candidates, previousParent, stale, proofs.timeEntriesOnly);
  if (tracked !== undefined) return tracked;
  const matches = candidates.filter(
    (candidate) => candidate.ref.originalBlock === stale.ref.originalBlock,
  );
  const previousMatches = previousParent?.subtasks.filter(
    (candidate) => candidate.ref.originalBlock === stale.ref.originalBlock,
  );
  return previousMatches?.length === 1 && matches.length === 1 ? matches[0] : undefined;
}

/**
 * An entry written under the selected node rewrites that node's own source block, so no text
 * match can find its successor. Inside a tree the domain proves unchanged apart from tracked
 * entries the child order is identical, which makes the stale child's position its identity.
 */
function trackedChild(
  candidates: readonly SubtaskSnapshot[],
  previousParent: TaskSelectionNode | undefined,
  stale: SubtaskSnapshot,
  timeEntriesOnly: () => boolean,
): SubtaskSnapshot | undefined {
  if (previousParent === undefined) return undefined;
  const staleRef = taskNodeRef(stale);
  const places = previousParent.subtasks.flatMap((candidate, at) =>
    sameTaskNodeRef(taskNodeRef(candidate), staleRef) ? [at] : [],
  );
  const at = places.length === 1 ? places[0] : undefined;
  return at !== undefined && timeEntriesOnly() ? candidates[at] : undefined;
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
