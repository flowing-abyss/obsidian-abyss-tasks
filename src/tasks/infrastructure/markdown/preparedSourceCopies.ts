import type { TaskSourceCopy, TaskSourceCopyEvidence } from '../../application/TaskSourceCopyApi';
import { taskNodeSourceLine, taskTreeNodes } from '../../domain/taskSearchProjection';
import {
  sameTaskNodeRef,
  type CommentRef,
  type TaskNodeRef,
  type TaskSnapshot,
} from '../../domain/types';
import type { TaskNodeLineMapping } from './TaskBlockEditor';

export interface CapturedSourceCopy {
  readonly selection: TaskSourceCopy;
  readonly sourceRoot: TaskSnapshot;
  readonly sourceFrom: number;
  readonly from: number;
  readonly count: number;
  readonly text: string;
  readonly retained: boolean;
  /** Scope/catalog disclosure only; source freshness is a separate cleanup condition. */
  readonly permitted: () => boolean;
}
function range(root: TaskSnapshot, from: number, count: number): string {
  return root.source.originalBlock
    .split('\n')
    .slice(from, from + count)
    .join('\n')
    .replace(/\r$/u, '');
}
export function advanceSourceCopies(
  copies: readonly CapturedSourceCopy[],
  after: TaskSnapshot | null,
  map: readonly TaskNodeLineMapping[] | undefined,
): readonly CapturedSourceCopy[] {
  const positions = new Map(map?.map((e) => [e.beforeOffset, e.afterOffset]));
  return copies.map((copy) => {
    if (!copy.retained || after === null) return { ...copy, retained: false };
    const from = positions.get(copy.from);
    const retained =
      from !== undefined &&
      Array.from({ length: copy.count }, (_, i) => i).every(
        (i) => positions.get(copy.from + i) === from + i,
      ) &&
      range(after, from, copy.count) === copy.text.replace(/\r$/u, '');
    return { ...copy, from: from ?? copy.from, retained };
  });
}
function subtreePairs(
  copy: CapturedSourceCopy,
  after: TaskSnapshot,
): Pick<TaskSourceCopyEvidence, 'tasks' | 'comments' | 'state'> {
  const tasks: Array<TaskSourceCopyEvidence['tasks'][number]> = [];
  const comments: Array<TaskSourceCopyEvidence['comments'][number]> = [];
  const destinations = new Map(
    [...taskTreeNodes(after)].map((node) => [
      taskNodeSourceLine(node.target) - after.ref.line,
      node,
    ]),
  );
  for (const source of taskTreeNodes(copy.sourceRoot)) {
    const at = taskNodeSourceLine(source.target) - copy.sourceRoot.ref.line;
    if (at < copy.sourceFrom || at >= copy.sourceFrom + copy.count) continue;
    const destination = destinations.get(copy.from + at - copy.sourceFrom);
    if (destination === undefined) return { state: 'unavailable', tasks: [], comments: [] };
    tasks.push({ source: source.target, destination: destination.target });
    for (const comment of source.node.comments) {
      const found = destination.node.comments.find(
        (c) => c.ref.relativeLine === comment.ref.relativeLine,
      );
      if (found === undefined) return { state: 'unavailable', tasks: [], comments: [] };
      comments.push({ source: comment.ref, destination: found.ref });
    }
  }
  return { state: 'retained', tasks, comments };
}
function commentPairs(
  copy: CapturedSourceCopy,
  after: TaskSnapshot,
): TaskSourceCopyEvidence['comments'] {
  if (copy.selection.type !== 'comment') return [];
  const source = copy.selection.source;
  return [...taskTreeNodes(after)].flatMap((owner) =>
    owner.node.comments.flatMap((comment) =>
      taskNodeSourceLine(owner.target) - after.ref.line + comment.ref.relativeLine === copy.from
        ? [{ source, destination: comment.ref }]
        : [],
    ),
  );
}
export function sourceCopyEvidence(
  copy: CapturedSourceCopy,
  after: TaskSnapshot | null,
): TaskSourceCopyEvidence {
  const base = {
    type: copy.selection.type,
    sourceRoot: copy.sourceRoot,
    source: copy.selection.source,
  };
  if (!copy.retained || after === null)
    return { ...base, state: 'unavailable', tasks: [], comments: [] };
  if (copy.selection.type === 'subtree') return { ...base, ...subtreePairs(copy, after) };
  const comments = commentPairs(copy, after);
  return {
    ...base,
    state: comments.length === 1 ? 'retained' : 'unavailable',
    tasks: [],
    comments,
  };
}
export function copyHasParent(
  copy: CapturedSourceCopy,
  after: TaskSnapshot,
  parent: TaskNodeRef | undefined,
): boolean {
  if (parent === undefined) return false;
  const evidence = sourceCopyEvidence(copy, after);
  if (evidence.state !== 'retained') return false;
  if (copy.selection.type === 'comment')
    return evidence.comments.every((pair) => sameTaskNodeRef(pair.destination.parent, parent));
  const inserted = evidence.tasks[0]?.destination;
  return inserted?.type === 'subtask' && sameTaskNodeRef(inserted.ref.parent, parent);
}

/** Exact original comment range survives through physical source-line witnesses, including duplicates. */
export function continuePreparedComment(
  roots: { before: TaskSnapshot; after: TaskSnapshot | null },
  map: readonly TaskNodeLineMapping[] | undefined,
  source: CommentRef,
): CommentRef | undefined {
  if (roots.after === null) return undefined;
  const originalOwner = [...taskTreeNodes(roots.before)].find((n) =>
    sameTaskNodeRef(n.target, source.parent),
  );
  if (
    originalOwner?.node.comments.some((c) => JSON.stringify(c.ref) === JSON.stringify(source)) !==
    true
  )
    return undefined;
  const offset = taskNodeSourceLine(source.parent) - roots.before.ref.line + source.relativeLine;
  const count = source.originalMarkdown.split('\n').length;
  const positions = new Map(map?.map((e) => [e.beforeOffset, e.afterOffset]));
  const from = positions.get(offset);
  if (
    from === undefined ||
    !Array.from({ length: count }, (_, i) => i).every((i) => positions.get(offset + i) === from + i)
  )
    return undefined;
  const after = roots.after;
  for (const owner of taskTreeNodes(after)) {
    const match = owner.node.comments.find(
      (c) =>
        taskNodeSourceLine(owner.target) - after.ref.line + c.ref.relativeLine === from &&
        c.ref.originalMarkdown.replace(/\r$/u, '') === source.originalMarkdown.replace(/\r$/u, ''),
    );
    if (match !== undefined) return match.ref;
  }
  return undefined;
}
