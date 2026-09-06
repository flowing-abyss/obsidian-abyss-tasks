import type { SubtaskSnapshot, TaskSnapshot } from './types';

type Node = TaskSnapshot | SubtaskSnapshot;

function taskLine(node: Node): string {
  const source = 'source' in node ? node.source.originalMarkdown : node.ref.originalBlock;
  return (source.split('\n', 1)[0] ?? '').replace(/\r$/u, '');
}

function changedRemovalParent(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
  remove: number | undefined,
): boolean {
  return path?.length === 0 && remove !== undefined && taskLine(before) !== taskLine(after);
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
  },
): boolean {
  const children = comparisonChildren(before, path, change.remove);
  if (children.length + addedChildCount(path, change.append) !== after.subtasks.length)
    return false;
  if (changedRemovalParent(before, after, path, change.remove)) return false;
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
