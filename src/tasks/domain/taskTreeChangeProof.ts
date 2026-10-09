import {
  readCommentBlock,
  replacementCommentSourceLines,
  type CommentSource,
} from './commentSource';
import { matchesSubmittedChild, type TaskCreationProofPolicy } from './dependencySubtaskProof';
import type { CompletionTrackingWitness } from './taskReconciliation';
import { closeEntryLine, parseTimeEntryLine, type ParsedTimeEntry } from './timeEntry';
import { MINIMUM_TRACKED_MS, type TimeEntrySnapshot } from './timeTracking';
import { sameTaskNodeRef, type CommentRef, type SubtaskSnapshot, type TaskSnapshot } from './types';

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
        const isTimeEntryPosition = next === 'timeEntries.relativeLine';
        return key === 'ref' || omitted.has(next) || isTimeEntryPosition
          ? []
          : [[key, comparable(child, omitted, next)]];
      }),
  );
}

function sameSnapshotValues(
  before: unknown,
  after: unknown,
  omitted: ReadonlySet<string> = new Set(),
): boolean {
  return JSON.stringify(comparable(before, omitted)) === JSON.stringify(comparable(after, omitted));
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
    readonly tracking?: CompletionTrackingWitness;
    readonly comment?: { readonly ref: CommentRef; readonly text?: string };
    readonly insertion?: {
      readonly type: 'add-subtask' | 'add-comment';
      readonly text: string;
      readonly policy?: TaskCreationProofPolicy;
    };
  },
): boolean {
  if (!validOwnedSource(before, after, path, change)) return false;
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
  if (!sameSnapshotValues(before, after, omitted)) return false;
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

function validOwnedSource(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
  change: Parameters<typeof sameTaskTreeWithOwnedChanges>[3],
): boolean {
  return (
    validTracking(before, after, path, change.tracking) &&
    validInsertion(before, after, path, change.insertion) &&
    (path === undefined ||
      change.comment === undefined ||
      commentSourceMatches(before, after, path, change.comment))
  );
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

/** A single contiguous insertion at the exact edited parent; every pre-existing source byte stays put. */
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
  const insertedLines = source.split('\n');
  if (insertion.type === 'add-subtask' && insertedLines.length !== 1) return false;
  if (
    lines
      .slice(line, line + insertedLines.length)
      .join('\n')
      .replace(/\r$/u, '') !== source.replace(/\r$/u, '')
  )
    return false;
  const last = line + insertedLines.length === lines.length;
  lines.splice(line, insertedLines.length);
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

/** The captured full comment is the only replaced/deleted source range; ancestors and neighbors retain their bytes. */
function commentSourceMatches(
  before: Node,
  after: Node,
  path: readonly number[],
  edit: NonNullable<Parameters<typeof sameTaskTreeWithOwnedChanges>[3]['comment']>,
): boolean {
  const location = commentOwner(before, after, path);
  if (location === undefined) return false;
  const { owner, next, offset } = location;
  const parent =
    'source' in owner
      ? { type: 'task' as const, ref: owner.ref }
      : { type: 'subtask' as const, ref: owner.ref };
  if (!sameTaskNodeRef(parent, edit.ref.parent)) return false;
  const index = owner.comments.findIndex(
    (comment) =>
      comment.ref.relativeLine === edit.ref.relativeLine &&
      comment.ref.originalMarkdown === edit.ref.originalMarkdown,
  );
  const comment = owner.comments[index];
  if (comment === undefined) return false;
  const lines = sourceBlock(before).split('\n');
  const from = offset + edit.ref.relativeLine;
  const original = readCommentBlock(lines, from, offset + sourceBlock(owner).split('\n').length);
  if (original?.originalMarkdown !== edit.ref.originalMarkdown) return false;
  if (!commentSnapshotsMatch(owner, next, index, edit.text)) return false;
  const replacement = replacementCommentLines(lines, offset, original, edit.text);
  lines.splice(from, original.toExclusive - from, ...replacement);
  let expected = lines.join('\n');
  if (!sourceBlock(before).endsWith('\r')) expected = expected.replace(/\r$/u, '');
  return expected === sourceBlock(after);
}

function commentOwner(
  before: Node,
  after: Node,
  path: readonly number[],
): { owner: Node; next: Node; offset: number } | undefined {
  let owner = before;
  let next = after;
  let offset = 0;
  for (const index of path) {
    const child: SubtaskSnapshot | undefined = owner.subtasks[index];
    const successor: SubtaskSnapshot | undefined = next.subtasks[index];
    if (child === undefined || successor === undefined) return undefined;
    offset += child.ref.relativeLine;
    owner = child;
    next = successor;
  }
  return { owner, next, offset };
}

function commentSnapshotsMatch(
  owner: Node,
  next: Node,
  index: number,
  text: string | undefined,
): boolean {
  const expected = owner.comments.flatMap((entry, position) => {
    if (position !== index) return [entry];
    return text === undefined ? [] : [{ ...entry, text }];
  });
  return sameSnapshotValues(expected, next.comments);
}

function replacementCommentLines(
  lines: readonly string[],
  offset: number,
  original: CommentSource,
  text: string | undefined,
): string[] {
  if (text === undefined) return [];
  const ending = lines[offset]?.endsWith('\r') === true ? '\r' : '';
  return replacementCommentSourceLines(original, text).map((line, position) => {
    let suffix = ending;
    const at = original.from + position;
    if (at < original.toExclusive && at < lines.length - 1)
      suffix = lines[at]?.endsWith('\r') === true ? '\r' : '';
    return `${line}${suffix}`;
  });
}

function validTracking(
  before: Node,
  after: Node,
  path: readonly number[] | undefined,
  witness: CompletionTrackingWitness | undefined,
): boolean {
  if (path === undefined || witness === undefined) return true;
  const location = commentOwner(before, after, path);
  if (location === undefined) return false;
  const { owner, next, offset } = location;
  const tracked = confirmedTracking(owner, witness);
  if (tracked === undefined || !trackingSnapshotsMatch(owner, next, tracked, witness)) return false;
  return trackingSourceMatches(before, after, { offset, entry: tracked.entry, witness });
}

interface ConfirmedTracking {
  readonly index: number;
  readonly entry: TimeEntrySnapshot & { readonly startMs: number };
  readonly closed: string | undefined;
  readonly parsed: ParsedTimeEntry;
}
function confirmedTracking(
  owner: Node,
  witness: CompletionTrackingWitness,
): ConfirmedTracking | undefined {
  const index = owner.timeEntries.findIndex(
    (entry) =>
      entry.relativeLine === witness.entry.relativeLine &&
      entry.originalMarkdown === witness.entry.originalMarkdown,
  );
  const entry = owner.timeEntries[index];
  if (entry?.state !== 'running' || entry.startMs === undefined) return undefined;
  const closed = closeEntryLine(entry.originalMarkdown, witness.stamp);
  const parsed = closed === undefined ? undefined : parseTimeEntryLine(closed, () => 0);
  if (
    parsed?.state !== 'closed' ||
    parsed.startMs !== entry.startMs ||
    !validCompletionReading(parsed, witness)
  )
    return undefined;
  return { index, entry: { ...entry, startMs: entry.startMs }, closed, parsed };
}

function validCompletionReading(
  parsed: ParsedTimeEntry,
  witness: CompletionTrackingWitness,
): boolean {
  return (
    Number.isSafeInteger(witness.endMs) &&
    parsed.endMs === Math.floor(witness.endMs / 1000) * 1000 &&
    witness.minimumMs === MINIMUM_TRACKED_MS
  );
}

function trackingSnapshotsMatch(
  owner: Node,
  next: Node,
  tracked: ConfirmedTracking,
  witness: CompletionTrackingWitness,
): boolean {
  const { index, entry, closed, parsed } = tracked;
  const discard = witness.disposition === 'discarded';
  const shouldDiscard =
    witness.endMs - entry.startMs < witness.minimumMs && (entry.tail ?? '') === '';
  if (discard !== shouldDiscard) return false;
  const expected = owner.timeEntries.flatMap((old, position) => {
    if (position !== index) return [old];
    return discard ? [] : [{ ...old, ...parsed, originalMarkdown: closed }];
  });
  return sameSnapshotValues(expected, next.timeEntries);
}

function trackingSourceMatches(
  before: Node,
  after: Node,
  context: {
    readonly offset: number;
    readonly entry: ConfirmedTracking['entry'];
    readonly witness: CompletionTrackingWitness;
  },
): boolean {
  const { offset, entry, witness } = context;
  const discard = witness.disposition === 'discarded';
  const closed = closeEntryLine(entry.originalMarkdown, witness.stamp);
  if (!('source' in before)) return true;
  if (
    !('source' in after) ||
    !sameTaskNodeRef({ type: 'task', ref: before.ref }, { type: 'task', ref: witness.before }) ||
    !sameTaskNodeRef({ type: 'task', ref: after.ref }, { type: 'task', ref: witness.after })
  )
    return false;
  const lines = sourceBlock(before).split('\n');
  const at = offset + entry.relativeLine;
  if (lines[at] !== entry.originalMarkdown) return false;
  lines.splice(at, 1, ...(discard ? [] : [closed ?? '']));
  let source = lines.join('\n');
  if (!sourceBlock(before).endsWith('\r')) source = source.replace(/\r$/u, '');
  return source === sourceBlock(after);
}
