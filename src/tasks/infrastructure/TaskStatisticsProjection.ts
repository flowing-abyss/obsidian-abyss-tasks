import type {
  TaskStatisticsDateIssue,
  TaskStatisticsFile,
  TaskStatisticsSnapshot,
  TaskStatisticsSourceIssue,
} from '../application/TaskStatisticsSource';
import type { StatusCatalog } from '../domain/StatusCatalog';
import type { TimeEntrySnapshot } from '../domain/timeTracking';
import type {
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskSnapshot,
  TaskStatus,
} from '../domain/types';
import { localDate } from '../domain/validation';
import { TaskMarkdownCodec, type ParsedTaskLine } from './markdown/TaskMarkdownCodec';

export interface StatisticsProjectionInput {
  readonly path: string;
  readonly key: string;
  readonly generationKey: string;
  readonly kind: TaskStatisticsFile['kind'];
  readonly content: string | undefined;
  readonly roots:
    | ((current: () => boolean) => readonly TaskSnapshot[] | Promise<readonly TaskSnapshot[]>)
    | undefined;
  readonly sourceIssue: TaskStatisticsSourceIssue['reason'] | undefined;
  readonly statusCatalog: StatusCatalog;
}

interface ProjectionOwner {
  paths(): Iterable<string>;
  source(path: string): StatisticsProjectionInput | undefined;
  ready(): boolean;
  current(input: StatisticsProjectionInput): boolean;
}

const DATE_FIELDS: ReadonlyArray<TaskStatisticsDateIssue['field']> = [
  'created',
  'completion',
  'cancelled',
  'due',
  'scheduled',
  'start',
];

function dateIssue(
  parsed: ParsedTaskLine,
  field: TaskStatisticsDateIssue['field'],
): TaskStatisticsDateIssue['reason'] | undefined {
  const occurrences = parsed.occurrences.get(field)?.length ?? 0;
  const malformed = parsed.spans.filter(
    (span) => span.kind === 'malformed-known' && span.malformedKind === field,
  ).length;
  if (occurrences + malformed > 1) return 'ambiguous-date';
  if (malformed > 0) return 'invalid-date';
  if (occurrences === 0) return undefined;
  const value = parsed.planning[field];
  if (value === undefined) return 'invalid-date';
  try {
    localDate(value);
    return undefined;
  } catch {
    return 'invalid-date';
  }
}

function yieldProjection(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function consumeSteps(steps: Iterable<void>, current: () => boolean): Promise<boolean> {
  let work = 0;
  const iterator = steps[Symbol.iterator]();
  while (iterator.next().done !== true) {
    if (!current()) return false;
    work += 1;
    if (work >= 1000) {
      await yieldProjection();
      work = 0;
    }
  }
  return current();
}

interface NodeEvidence {
  readonly input: StatisticsProjectionInput;
  readonly issues: TaskStatisticsDateIssue[];
  readonly codec: TaskMarkdownCodec;
}

function projectNodeEvidence(
  node: TaskSnapshot | SubtaskSnapshot,
  line: number,
  markdown: string,
  context: NodeEvidence,
): TaskStatus {
  const parsed = context.codec.parseLine(markdown, { filePath: context.input.path, line });
  const cancelled = parsed?.planning.cancelled;
  const status =
    cancelled !== undefined && cancelled.length > 0
      ? 'cancelled'
      : context.input.statusCatalog.statusForSymbol(node.statusSymbol);
  if (parsed !== null) {
    for (const field of DATE_FIELDS) {
      const reason = dateIssue(parsed, field);
      if (reason !== undefined) context.issues.push(Object.freeze({ line, field, reason }));
    }
  }
  return status;
}

interface DetachedNodeFields {
  readonly status: TaskStatus;
  readonly subtasks: readonly SubtaskSnapshot[];
  readonly comments: readonly TaskCommentSnapshot[];
  readonly timeEntries: readonly TimeEntrySnapshot[];
}

/** Each scheduling unit is one physical node, comment or entry, independent of scalar fields. */
function* detachedNodeFields(
  node: TaskSnapshot | SubtaskSnapshot,
  source: { readonly line: number; readonly markdown: string },
  parent: TaskNodeRef,
  context: NodeEvidence,
): Generator<void, DetachedNodeFields> {
  const status = projectNodeEvidence(node, source.line, source.markdown, context);
  yield;
  const timeEntries: TimeEntrySnapshot[] = [];
  for (const entry of node.timeEntries) {
    timeEntries.push(Object.freeze({ ...entry }));
    yield;
  }
  const comments: TaskCommentSnapshot[] = [];
  for (const comment of node.comments) {
    comments.push(
      Object.freeze({
        ...comment,
        ref: Object.freeze({ ...comment.ref, parent }),
        ...(comment.timestamp === undefined
          ? {}
          : { timestamp: Object.freeze({ ...comment.timestamp }) }),
      }),
    );
    yield;
  }
  const subtasks: SubtaskSnapshot[] = [];
  for (const child of node.subtasks) {
    const ref = Object.freeze({ ...child.ref, parent });
    const target: TaskNodeRef = Object.freeze({ type: 'subtask', ref });
    const firstNewline = child.ref.originalBlock.indexOf('\n');
    const originalMarkdown =
      firstNewline < 0 ? child.ref.originalBlock : child.ref.originalBlock.slice(0, firstNewline);
    const fields = yield* detachedNodeFields(
      child,
      { line: source.line + child.ref.relativeLine, markdown: originalMarkdown },
      target,
      context,
    );
    subtasks.push(
      Object.freeze({
        ...child,
        ...fields,
        ref,
        planning: Object.freeze({ ...child.planning }),
        tags: Object.freeze([...child.tags]),
        dependsOn: Object.freeze([...child.dependsOn]),
      }),
    );
  }
  return {
    status,
    subtasks: Object.freeze(subtasks),
    comments: Object.freeze(comments),
    timeEntries: Object.freeze(timeEntries),
  };
}

function* detachedRootSteps(
  roots: readonly TaskSnapshot[],
  copies: TaskSnapshot[],
  context: NodeEvidence,
): Generator<void> {
  for (const node of roots) {
    const ref = Object.freeze({ ...node.ref });
    const parent: TaskNodeRef = Object.freeze({ type: 'task', ref });
    const fields = yield* detachedNodeFields(
      node,
      { line: node.source.line, markdown: node.source.originalMarkdown },
      parent,
      context,
    );
    copies.push(
      Object.freeze({
        ...node,
        ...fields,
        ref,
        planning: Object.freeze({ ...node.planning }),
        tags: Object.freeze([...node.tags]),
        dependsOn: Object.freeze([...node.dependsOn]),
        source: Object.freeze({ ...node.source }),
        presentation: Object.freeze({ ...node.presentation }),
      }),
    );
  }
}

async function projectFile(
  input: StatisticsProjectionInput,
  revision: number,
  current: () => boolean,
): Promise<TaskStatisticsFile | undefined> {
  const roots = (await input.roots?.(current)) ?? [];
  if (!current()) return undefined;
  const copies: TaskSnapshot[] = [];
  const issues: TaskStatisticsDateIssue[] = [];
  const context: NodeEvidence = {
    input,
    issues,
    codec: new TaskMarkdownCodec(input.statusCatalog),
  };
  if (!(await consumeSteps(detachedRootSteps(roots, copies, context), current))) return undefined;
  return Object.freeze({
    path: input.path,
    revision,
    kind: input.kind,
    roots: Object.freeze(copies),
    dateIssues: Object.freeze(issues),
  });
}

/** Owns only the extra evidence projection and its active leases, never task or write authority. */
export class TaskStatisticsProjection {
  private readonly listeners = new Set<() => void>();
  private readonly files = new Map<string, TaskStatisticsFile>();
  private readonly keys = new Map<string, string>();
  private readonly issues = new Map<string, TaskStatisticsSourceIssue>();
  private readonly pending = new Set<string>();
  private generation = 0;
  private fileRevision = 0;
  private holds = 0;
  private readonly settlementWaiters = new Set<() => void>();
  private running: Promise<void> | undefined;
  private snapshot: TaskStatisticsSnapshot = Object.freeze({
    revision: 0,
    ready: false,
    files: Object.freeze([]),
    issues: Object.freeze([]),
  });

  constructor(private readonly owner: ProjectionOwner) {}

  get active(): boolean {
    return this.listeners.size > 0;
  }
  read(): TaskStatisticsSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    // Each subscription is its own lease, even for the same callback.
    const lease = (): void => {
      listener();
    };
    this.listeners.add(lease);
    if (this.listeners.size === 1) this.invalidateAll();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(lease);
      if (!this.active) this.dispose();
    };
  }

  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      if (this.running === undefined && this.pending.size === 0) this.publish();
      this.releaseSettled();
    };
  }

  update(path: string): void {
    if (!this.active) return;
    this.pending.add(path);
    this.schedule();
  }

  remove(path: string, immediate = false): void {
    this.pending.delete(path);
    this.files.delete(path);
    this.keys.delete(path);
    this.issues.delete(path);
    if (immediate) this.publish();
    else if (this.active) this.schedule();
  }

  invalidateAll(): void {
    if (!this.active) return;
    this.prune();
    for (const path of this.owner.paths()) this.pending.add(path);
    this.schedule();
  }

  /** Policy tightening is effective before awaited source reads can fail or return stale bytes. */
  prune(): void {
    for (const path of new Set([...this.files.keys(), ...this.issues.keys()])) {
      if (this.owner.source(path) === undefined) this.remove(path, true);
    }
  }

  async settled(): Promise<void> {
    while (this.active && this.running !== undefined) await this.running;
  }

  isCurrent(snapshot: TaskStatisticsSnapshot): boolean {
    return (
      snapshot === this.snapshot &&
      this.running === undefined &&
      this.pending.size === 0 &&
      this.holds === 0
    );
  }

  whenSettled(): Promise<void> {
    if (!this.active || this.isCurrent(this.snapshot)) return Promise.resolve();
    return new Promise((resolve) => this.settlementWaiters.add(resolve));
  }

  private releaseSettled(): void {
    if (this.active && !this.isCurrent(this.snapshot)) return;
    for (const resolve of this.settlementWaiters) resolve();
    this.settlementWaiters.clear();
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
    this.pending.clear();
    this.releaseSettled();
    this.files.clear();
    this.keys.clear();
    this.issues.clear();
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      ready: false,
      files: Object.freeze([]),
      issues: Object.freeze([]),
    });
  }

  private schedule(): void {
    if (this.running !== undefined) return;
    const generation = this.generation;
    this.running = Promise.resolve()
      .then(async () => {
        let work = 0;
        while (this.active && this.generation === generation && this.pending.size > 0) {
          const path = this.pending.values().next().value;
          if (path === undefined) break;
          this.pending.delete(path);
          await this.replace(path, generation);
          work += 1;
          if (work >= 50) {
            await yieldProjection();
            work = 0;
          }
        }
        if (this.generation === generation) this.publish();
      })
      .catch((error: unknown) => {
        console.error('[abyss-tasks] statistics publication failed', { error });
      })
      .finally(() => {
        this.running = undefined;
        if (this.active && this.pending.size > 0) this.schedule();
        this.releaseSettled();
      });
  }

  private needsProjection(source: StatisticsProjectionInput): boolean {
    return source.roots !== undefined && this.keys.get(source.path) !== source.key;
  }

  private async replace(path: string, generation: number): Promise<void> {
    const source = this.owner.source(path);
    if (source === undefined) {
      this.remove(path);
      return;
    }
    if (source.sourceIssue !== undefined)
      this.issues.set(path, Object.freeze({ path, reason: source.sourceIssue }));
    else if (this.keys.get(path) === source.key) this.issues.delete(path);
    if (!this.needsProjection(source)) return;
    const current = (): boolean =>
      this.active && this.generation === generation && this.owner.current(source);
    try {
      const file = await projectFile(source, ++this.fileRevision, current);
      if (file === undefined || !current()) return;
      this.files.set(path, file);
      this.keys.set(path, source.key);
      if (source.sourceIssue === undefined) this.issues.delete(path);
    } catch (error) {
      if (!current()) return;
      this.issues.set(path, Object.freeze({ path, reason: 'projection-failed' }));
      console.error('[abyss-tasks] statistics projection failed', { path, error });
    }
  }

  private publish(): void {
    if (!this.active || this.holds > 0) return;
    const order = (left: { path: string }, right: { path: string }): number =>
      left.path.localeCompare(right.path);
    const files = [...this.files.values()].sort(order);
    const issues = [...this.issues.values()].sort(order);
    const ready = this.owner.ready();
    if (
      ready === this.snapshot.ready &&
      files.length === this.snapshot.files.length &&
      files.every((file, index) => file === this.snapshot.files[index]) &&
      JSON.stringify(issues) === JSON.stringify(this.snapshot.issues)
    )
      return;
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      ready,
      files: Object.freeze(files),
      issues: Object.freeze(issues),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[abyss-tasks] statistics listener failed', { error });
      }
    }
  }
}
