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
