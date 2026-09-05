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
  for (let index = 1; index < staleStack.length; index++) {
    const parent = stack[index - 1];
    const stale = staleStack[index];
    if (parent == null || stale == null || 'source' in stale) break;
    const child = selectionChild(
      parent.subtasks,
      stale,
      staleStack[index - 1],
      options.preserveDependencyChanges === true,
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

function selectionContent(node: SubtaskSnapshot): unknown {
  return {
    ...node,
    ref: { relativeLine: node.ref.relativeLine },
    dependencyId: undefined,
    dependsOn: undefined,
    subtasks: node.subtasks.map(selectionContent),
    comments: node.comments.map((comment) => ({
      ...comment,
      ref: {
        relativeLine: comment.ref.relativeLine,
        originalMarkdown: comment.ref.originalMarkdown,
      },
    })),
  };
}

function dependencyChangedChild(
  candidates: readonly SubtaskSnapshot[],
  stale: SubtaskSnapshot,
): SubtaskSnapshot | undefined {
  const positioned = candidates.filter(
    (candidate) => candidate.ref.relativeLine === stale.ref.relativeLine,
  );
  const child = positioned.length === 1 ? positioned[0] : undefined;
  return child !== undefined &&
    JSON.stringify(selectionContent(child)) === JSON.stringify(selectionContent(stale))
    ? child
    : undefined;
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
