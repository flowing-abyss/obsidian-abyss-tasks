import type {
  ApiResultV1,
  ReadTaskTreeV1,
  TaskActivityV1,
  TaskTrackedActivityV1,
  TaskTreePageV1,
  TaskTreeV1,
} from '../../api';
import {
  addEntryToTotal,
  entryDurationMs,
  subtreeTotal,
  taskNodeSourceLine,
  taskTreeNodes,
  type TaskNodeSnapshot,
  type TaskReadNode,
  type TaskSnapshot,
  type TimeEntrySnapshot,
} from '../tasks';
import type { TaskApiContext } from './TaskApiProvider';
import { readError, readFailure } from './taskApiReads';
import { toTaskDto } from './taskDto';
import { freezeValue } from './values';

export function contentFailure(code = 'STALE_PLAN'): ApiResultV1<never> {
  return readError('conflict', code, 'The content basis is no longer available.');
}
export function readNodeFor(context: TaskApiContext, value: TaskNodeSnapshot): TaskReadNode {
  const line = taskNodeSourceLine(value.target),
    planning = value.node.planning;
  const { time, duration, ...dates } = planning;
  const address = {
    filePath: value.root.ref.filePath,
    rootRevision: value.root.ref.revision,
    rootLine: value.root.ref.line,
    nodeOffset: line - value.root.ref.line,
  };
  const parent =
    value.target.type === 'subtask'
      ? {
          ...address,
          nodeOffset: taskNodeSourceLine(value.target.ref.parent) - value.root.ref.line,
        }
      : undefined;
  const catalog = context.reads.statuses();
  const status =
    catalog.type === 'ok'
      ? catalog.value.find((r) => r.symbol === value.node.statusSymbol)?.status
      : undefined;
  return {
    value,
    address,
    line,
    dates,
    status: status ?? value.node.status,
    ...(parent === undefined ? {} : { parent }),
    ...(time === undefined ? {} : { time }),
    ...(duration === undefined ? {} : { durationMinutes: duration }),
  };
}
function tracked(entries: readonly TimeEntrySnapshot[], now: number): TaskTrackedActivityV1 {
  const total = { closedMs: 0, openStartsMs: [] as number[] };
  let brokenEntryCount = 0,
    last: number | undefined;
  for (const entry of entries) {
    addEntryToTotal(total, entry);
    if (entry.state === 'broken') {
      brokenEntryCount++;
      continue;
    }
    if (entry.startMs === undefined || entry.startMs > now) continue;
    const end = entry.state === 'running' ? now : entry.endMs;
    if (end !== undefined) last = Math.max(last ?? -Infinity, Math.min(now, end));
  }
  return {
    closedMs: total.closedMs,
    runningCount: total.openStartsMs.length,
    runningMsAtObservation: entries
      .filter((e) => e.state === 'running')
      .reduce((sum, e) => sum + entryDurationMs(e, now), 0),
    brokenEntryCount,
    ...(last === undefined ? {} : { lastRecordedWorkAtMs: last }),
  };
}
function activity(node: TaskNodeSnapshot['node'], now: number): TaskActivityV1 {
  const entries: TimeEntrySnapshot[] = [];
  const visit = (n: TaskNodeSnapshot['node']): void => {
    entries.push(...n.timeEntries);
    n.subtasks.forEach(visit);
  };
  visit(node);
  const subtree = tracked(entries, now);
  return {
    observedAtMs: now,
    own: tracked(node.timeEntries, now),
    subtree: { ...subtree, closedMs: subtreeTotal(node).closedMs },
  };
}
export interface TreeProjection {
  task(
    value: TaskNodeSnapshot,
  ): ApiResultV1<{ target: string; revision: string; parentTarget?: string }>;
  entry(kind: 'comment' | 'time-entry', parent: string, ref: object): string;
  readonly draft: boolean;
}
interface TreeWindow {
  readonly now: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly shallow?: boolean;
}
type TreeLists = Pick<TaskTreeV1, 'children' | 'comments' | 'timeEntries' | 'entries'>;
function orderedEntries(
  node: TaskNodeSnapshot['node'],
): Array<
  | { kind: 'child'; line: number; child: TaskNodeSnapshot['node']['subtasks'][number] }
  | { kind: 'comment'; line: number; comment: TaskNodeSnapshot['node']['comments'][number] }
  | { kind: 'time-entry'; line: number; entry: TimeEntrySnapshot }
> {
  return [
    ...node.subtasks.map((child) => ({
      kind: 'child' as const,
      line: child.ref.relativeLine,
      child,
    })),
    ...node.comments.map((comment) => ({
      kind: 'comment' as const,
      line: comment.ref.relativeLine,
      comment,
    })),
    ...node.timeEntries.map((entry) => ({
      kind: 'time-entry' as const,
      line: entry.relativeLine,
      entry,
    })),
  ].sort((a, b) => a.line - b.line);
}
function commentDto(
  item: TaskNodeSnapshot['node']['comments'][number],
  target: string,
  parentTarget: string,
): TaskTreeV1['comments'][number] {
  const timestamp = item.timestamp;
  if (timestamp === undefined) return { target, parentTarget, text: item.text };
  const stamp =
    timestamp.precision === 'day'
      ? { precision: 'day' as const, value: timestamp.value }
      : { precision: 'instant' as const, atom: timestamp.atom, epochMs: timestamp.epochMs };
  return { target, parentTarget, text: item.text, timestamp: stamp };
}
function timeDto(
  e: TimeEntrySnapshot,
  target: string,
  parentTarget: string,
): TaskTreeV1['timeEntries'][number] {
  return {
    target,
    parentTarget,
    state: e.state,
    ...(e.startMs === undefined ? {} : { startMs: e.startMs }),
    ...(e.endMs === undefined ? {} : { endMs: e.endMs }),
    ...(e.tail === undefined ? {} : { note: e.tail }),
    ...(e.issue === undefined ? {} : { issue: e.issue }),
  };
}
function entryWindow(
  node: TaskNodeSnapshot['node'],
  window: TreeWindow,
): ReturnType<typeof orderedEntries> {
  if (window.shallow === true) return [];
  const offset = window.offset ?? 0;
  return orderedEntries(node).slice(offset, offset + (window.limit ?? 100));
}
function projectEntries(
  context: TaskApiContext,
  value: TaskNodeSnapshot,
  projection: TreeProjection,
  window: TreeWindow,
): ApiResultV1<TreeLists> {
  const lists: {
    children: TaskTreeV1[];
    comments: Array<TaskTreeV1['comments'][number]>;
    timeEntries: Array<TaskTreeV1['timeEntries'][number]>;
    entries: Array<TaskTreeV1['entries'][number]>;
  } = { children: [], comments: [], timeEntries: [], entries: [] };
  const parent = projection.task(value);
  if (!parent.ok) return parent;
  const selected = entryWindow(value.node, window);
  for (const item of selected) {
    if (item.kind === 'child') {
      const child = {
        root: value.root,
        node: item.child,
        target: { type: 'subtask' as const, ref: item.child.ref },
        path: [...value.path, item.child],
      };
      const result = projectTree(context, child, projection, { now: window.now, shallow: true });
      if (!result.ok) return result;
      lists.children.push(result.value);
      lists.entries.push({ kind: 'child', target: result.value.target });
      continue;
    }
    projectTextEntry(item, projection, parent.value.target, lists);
  }
  return { ok: true, value: lists };
}
function projectTextEntry(
  item: Exclude<ReturnType<typeof orderedEntries>[number], { kind: 'child' }>,
  projection: TreeProjection,
  parent: string,
  lists: {
    comments: Array<TaskTreeV1['comments'][number]>;
    timeEntries: Array<TaskTreeV1['timeEntries'][number]>;
    entries: Array<TaskTreeV1['entries'][number]>;
  },
): void {
  const ref = item.kind === 'comment' ? item.comment.ref : item.entry;
  const target = projection.entry(item.kind, parent, ref);
  lists.entries.push({ kind: item.kind, target });
  if (item.kind === 'comment') lists.comments.push(commentDto(item.comment, target, parent));
  else lists.timeEntries.push(timeDto(item.entry, target, parent));
}
export function projectTree(
  context: TaskApiContext,
  value: TaskNodeSnapshot,
  projection: TreeProjection,
  window: TreeWindow,
): ApiResultV1<TaskTreeV1> {
  const native = readNodeFor(context, value),
    identity = projection.task(value);
  if (!identity.ok) return identity;
  const { source, ...rest } = toTaskDto(native, identity.value),
    node = value.node;
  const lists = projectEntries(context, value, projection, window);
  if (!lists.ok) return lists;
  const count = node.subtasks.length + node.comments.length + node.timeEntries.length;
  const complete =
    (window.offset ?? 0) === 0 &&
    lists.value.entries.length === count &&
    lists.value.children.every((c) => c.complete);
  return freezeValue({
    ok: true,
    value: {
      ...rest,
      ...(projection.draft ? {} : { source }),
      ...(node.description === undefined ? {} : { description: node.description }),
      ...lists.value,
      activity: activity(node, window.now),
      childCount: node.subtasks.length,
      commentCount: node.comments.length,
      timeEntryCount: node.timeEntries.length,
      complete,
      truncated: !complete,
    },
  });
}
interface TreeCursor {
  binding: string;
  offset: number;
  now: number;
  expires: number;
}
/** Client-owned cursors and revision-scoped comment/time handles, never accepted task identities. */
export class TaskTreeReader {
  private sequence_abyssPrivate = 0;
  private readonly cursors_abyssPrivate = new Map<string, TreeCursor>();
  private readonly entries_abyssPrivate = new Map<
    string,
    { target: string; ref: object; expires: number }
  >();
  constructor(
    private readonly context_abyssPrivate: TaskApiContext,
    private readonly now_abyssPrivate: () => number,
    private readonly epoch_abyssPrivate: string,
  ) {}
  entry(kind: 'comment' | 'time-entry', parent: string, ref: object): string {
    this.clean();
    const key = JSON.stringify([kind, parent, ref]);
    const old = this.entries_abyssPrivate.get(key);
    if (old !== undefined) return old.target;
    if (this.entries_abyssPrivate.size >= 50000)
      throw new Error('Content entry capacity exhausted');
    const target = `${this.epoch_abyssPrivate}:e:${++this.sequence_abyssPrivate}`;
    this.entries_abyssPrivate.set(key, { target, ref, expires: this.now_abyssPrivate() + 60000 });
    return target;
  }
  comment(target: string): object | undefined {
    this.clean();
    for (const [key, value] of this.entries_abyssPrivate)
      if (value.target === target && key.startsWith('["comment"')) return value.ref;
    return undefined;
  }
  clean(): void {
    const now = this.now_abyssPrivate();
    for (const [key, v] of this.cursors_abyssPrivate)
      if (v.expires <= now) this.cursors_abyssPrivate.delete(key);
    for (const [key, v] of this.entries_abyssPrivate)
      if (v.expires <= now) this.entries_abyssPrivate.delete(key);
  }
  dispose(): void {
    this.cursors_abyssPrivate.clear();
    this.entries_abyssPrivate.clear();
  }
  read(
    query: ReadTaskTreeV1,
    value: TaskNodeSnapshot,
    projection: TreeProjection,
    observedAtMs?: number,
  ): ApiResultV1<TaskTreePageV1> {
    this.clean();
    const context = this.context_abyssPrivate,
      state = context.reads.capture();
    const binding = JSON.stringify({
      ...query,
      cursor: undefined,
      expectedRevision: query.expectedRevision ?? value.root.ref.revision,
      generation: state.generation,
    });
    const cursor =
      query.cursor === undefined ? undefined : this.cursors_abyssPrivate.get(query.cursor);
    if (query.cursor !== undefined && cursor?.binding !== binding)
      return contentFailure('STALE_CURSOR');
    const { now, offset, limit } = this.window_abyssPrivate(cursor, query, observedAtMs);
    const tree = projectTree(context, value, projection, { now, offset, limit });
    if (!tree.ok) return tree;
    return this.finish_abyssPrivate({ tree: tree.value, binding, offset, limit, now }, state);
  }
  private window_abyssPrivate(
    cursor: TreeCursor | undefined,
    query: ReadTaskTreeV1,
    observedAtMs?: number,
  ): { now: number; offset: number; limit: number } {
    return {
      now: cursor?.now ?? observedAtMs ?? this.now_abyssPrivate(),
      offset: cursor?.offset ?? 0,
      limit: query.limit ?? 100,
    };
  }
  private finish_abyssPrivate(
    page: { tree: TaskTreeV1; binding: string; offset: number; limit: number; now: number },
    state: ReturnType<TaskApiContext['reads']['capture']>,
  ): ApiResultV1<TaskTreePageV1> {
    const { tree, binding, offset, limit, now } = page,
      context = this.context_abyssPrivate;
    const count = tree.childCount + tree.commentCount + tree.timeEntryCount;
    let nextCursor: string | undefined;
    if (offset + limit < count) {
      if (this.cursors_abyssPrivate.size >= 1024)
        return readError('resource', 'RESOURCE_LIMIT', 'Tree cursor capacity exhausted.');
      nextCursor = `${this.epoch_abyssPrivate}:tree:${++this.sequence_abyssPrivate}`;
      this.cursors_abyssPrivate.set(nextCursor, {
        binding,
        offset: offset + limit,
        now,
        expires: this.now_abyssPrivate() + 60000,
      });
    }
    return freezeValue({
      ok: true,
      value: {
        ...context.observation(state),
        tree,
        complete: tree.complete,
        truncated: tree.truncated,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    });
  }
  accepted(query: ReadTaskTreeV1): ApiResultV1<TaskTreePageV1> {
    const context = this.context_abyssPrivate,
      found = context.identities.lookup(query.target);
    if (!found.ok) return found;
    if (found.value.state !== 'retained')
      return readFailure(found.value.state === 'removed' ? 'missing' : 'stale');
    const result = context.reads.node(found.value.address);
    if (result.type === 'error') return readFailure(result.reason);
    const identity = context.identities.project(result.value, result.observation.semanticsRevision);
    if (!identity.ok) return identity;
    if (query.expectedRevision !== undefined && query.expectedRevision !== identity.value.revision)
      return contentFailure('REVISION_CONFLICT');
    return this.read(query, result.value.value, {
      draft: false,
      task: (v) =>
        context.identities.project(readNodeFor(context, v), result.observation.semanticsRevision),
      entry: (kind, parent, ref) =>
        this.entry(kind, `${result.value.value.root.ref.revision}:${parent}`, ref),
    });
  }
}
export function findTreeNode(
  root: TaskSnapshot,
  target: TaskNodeSnapshot['target'],
): TaskNodeSnapshot | undefined {
  const key = JSON.stringify(target);
  for (const node of taskTreeNodes(root)) if (JSON.stringify(node.target) === key) return node;
  return undefined;
}
