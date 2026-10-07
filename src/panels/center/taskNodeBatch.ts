import { sameTaskNodeRef, type TaskNodeSnapshot, type TaskOccurrenceCompletion } from '../../tasks';

export type TaskNodeBatchKind = 'patch' | 'status' | 'subtree';
export interface TaskSelectedNode {
  readonly task: TaskNodeSnapshot;
  readonly completion: TaskOccurrenceCompletion;
}

export function taskNodeContains(ancestor: TaskNodeSnapshot, child: TaskNodeSnapshot): boolean {
  let target = child.target;
  while (target.type === 'subtask') {
    target = target.ref.parent;
    if (sameTaskNodeRef(ancestor.target, target)) return true;
  }
  return false;
}

export function planTaskNodeBatch(
  nodes: readonly TaskNodeSnapshot[],
  kind: TaskNodeBatchKind,
): readonly TaskNodeSnapshot[] {
  const unique: TaskNodeSnapshot[] = [];
  for (const node of nodes) {
    if (!unique.some((other) => sameTaskNodeRef(other.target, node.target))) unique.push(node);
  }
  if (kind === 'subtree')
    return unique.filter((node) => !unique.some((parent) => taskNodeContains(parent, node)));
  if (kind === 'status') return unique.sort((a, b) => b.path.length - a.path.length);
  return unique;
}
