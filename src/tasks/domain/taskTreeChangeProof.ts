import { matchesSubmittedChild, type TaskCreationProofPolicy } from './dependencySubtaskProof';
import type { SubtaskSnapshot, TaskSnapshot } from './types';

type Node = TaskSnapshot | SubtaskSnapshot;

function sourceBlock(node: Node): string {
  return 'source' in node ? node.source.originalBlock : node.ref.originalBlock;
}

function removalSourceMatches(before: Node, after: Node, index: number): boolean {
  const child = before.subtasks[index];
  if (child === undefined) return false;
  const source = sourceBlock(before);
  const contracted = sourceBlock(after);
  const childSource = child.ref.originalBlock;
  const prefix = `${source.split('\n', child.ref.relativeLine).join('\n')}\n`;
  if (!source.startsWith(childSource, prefix.length)) return false;
  const suffix = source.slice(prefix.length + childSource.length);
  if (suffix.length > 0) return prefix + suffix.replace(/^\r?\n/u, '') === contracted;
  return source.startsWith(contracted) && /^(?:\r?\n)+$/u.test(prefix.slice(contracted.length));
}

function changedRemovalParent(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
  remove: number | undefined,
): boolean {
  return path?.length === 0 && remove !== undefined && !removalSourceMatches(before, after, remove);
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

/** Only the specified node fields and one explicitly identified child may differ. */
export function sameTaskTreeWithOwnedChanges(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
  change: {
    readonly fields: ReadonlySet<string>;
    readonly append?: boolean;
    readonly remove?: number;
    readonly insertion?: {
      readonly type: 'add-subtask' | 'add-comment';
      readonly text: string;
      readonly policy?: TaskCreationProofPolicy;
    };
  },
): boolean {
  if (!validInsertion(before, after, path, change.insertion)) return false;
  const children = comparisonChildren(before, path, change.remove);
  if (children.length + addedChildCount(path, change.append) !== after.subtasks.length)
    return false;
  if (changedRemovalParent(before, after, path, change.remove)) return false;
  if (changedUneditedSource(before, after, path)) return false;
  const omitted = new Set([
    'subtasks',
    'source',
    'presentation',
    ...(path?.length === 0 ? change.fields : []),
  ]);
  if (JSON.stringify(comparable(before, omitted)) !== JSON.stringify(comparable(after, omitted)))
    return false;
  return children.every((child, index) => {
    const next = after.subtasks[index];
    return (
      next !== undefined &&
      sameTaskTreeWithOwnedChanges(
        child,
        next,
        path?.[0] === index ? path.slice(1) : undefined,
        change,
      )
    );
  });
}

function changedUneditedSource(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
): boolean {
  return (
    path === undefined &&
    !('source' in before) &&
    !('source' in after) &&
    before.ref.originalBlock !== after.ref.originalBlock
  );
}

function comparisonChildren(
  node: Node,
  path: readonly number[] | undefined,
  remove: number | undefined,
): readonly SubtaskSnapshot[] {
  return path?.length === 0 && remove !== undefined
    ? node.subtasks.filter((_, index) => index !== remove)
    : node.subtasks;
}

function addedChildCount(path: readonly number[] | undefined, append: boolean | undefined): number {
  return append === true && path?.length === 0 ? 1 : 0;
}

type Insertion = NonNullable<Parameters<typeof sameTaskTreeWithOwnedChanges>[3]['insertion']>;

function validInsertion(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
  insertion: Insertion | undefined,
): boolean {
  return (
    path === undefined ||
    insertion === undefined ||
    insertionSourceMatches(before, after, path, insertion)
  );
}

/** A single new line at the exact edited parent; every pre-existing source byte stays put. */
function insertionSourceMatches(
  before: Node,
  after: Node,
  path: readonly number[],
  insertion: NonNullable<Parameters<typeof sameTaskTreeWithOwnedChanges>[3]['insertion']>,
): boolean {
  let previous = before;
  let current = after;
  let offset = 0;
  for (const index of path) {
    const oldChild: SubtaskSnapshot | undefined = previous.subtasks[index];
    const newChild: SubtaskSnapshot | undefined = current.subtasks[index];
    if (oldChild === undefined || newChild === undefined) return false;
    offset += newChild.ref.relativeLine;
    previous = oldChild;
    current = newChild;
  }
  const inserted = insertedLine(previous, current, insertion);
  if (inserted === undefined) return false;
  const { source } = inserted;
  const line = offset + inserted.line;
  const lines = sourceBlock(after).split('\n');
  if (lines[line]?.replace(/\r$/u, '') !== source.replace(/\r$/u, '') || source.includes('\n'))
    return false;
  const last = line === lines.length - 1;
  lines.splice(line, 1);
  const retained = lines.join('\n');
  return retained === sourceBlock(before) || (last && retained === `${sourceBlock(before)}\r`);
}

function insertedLine(
  before: Node,
  after: Node,
  insertion: Insertion,
): { line: number; source: string } | undefined {
  if (insertion.type === 'add-subtask') {
    const child = after.subtasks[before.subtasks.length];
    if (
      after.subtasks.length !== before.subtasks.length + 1 ||
      child === undefined ||
      !plainSubmittedChild(child, insertion)
    )
      return undefined;
    return { line: child.ref.relativeLine, source: child.ref.originalBlock };
  }
  const comment = after.comments[before.comments.length];
  if (after.comments.length !== before.comments.length + 1 || comment?.text !== insertion.text)
    return undefined;
  return { line: comment.ref.relativeLine, source: comment.ref.originalMarkdown };
}

function plainSubmittedChild(child: SubtaskSnapshot, insertion: Insertion): boolean {
  return (
    child.subtasks.length === 0 &&
    child.comments.length === 0 &&
    child.description === undefined &&
    matchesSubmittedChild(child, insertion.text, insertion.policy)
  );
}
