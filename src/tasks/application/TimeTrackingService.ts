import type { ClockReading } from '../domain/clock';
import type { TaskCommandResult } from '../domain/commands';
import { taskNodeChain, taskNodeRootRef } from '../domain/taskCommandTargets';
import { timeEntryRef, type TimeEntrySnapshot, type TrackedEntry } from '../domain/timeTracking';
import {
  sameTaskNodeRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
  type TaskStatus,
} from '../domain/types';
import { invalidTaskTarget } from '../domain/validation';
import type {
  TaskDependencyQueryApi,
  TaskQueryApi,
  TimeTrackingQueryApi,
} from './TaskApplicationApi';
import type { TaskDiagnosticSink } from './TaskDependencyService';
import type { TaskEditCommand } from './TaskRepository';

/** A session shorter than this leaves no trace, so a mistaken start costs the note nothing. */
export const MINIMUM_TRACKED_MS = 60_000;

export interface TimeTrackingDependencies {
  readonly queries: TaskQueryApi & TaskDependencyQueryApi & TimeTrackingQueryApi;
  /** Resolves, validates and writes one internal edit through the normal existing-command path. */
  readonly edit: (command: TaskEditCommand) => Promise<TaskCommandResult>;
  readonly statusOf: (symbol: string) => TaskStatus;
  /** The mutation queue every multi-step task operation shares. */
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly diagnostics: TaskDiagnosticSink;
}

type NodePath = readonly number[];

/** One running entry with the child indices that lead from its root down to its node. */
interface RunningEntry {
  readonly path: NodePath;
  readonly target: TaskNodeRef;
  readonly entry: TimeEntrySnapshot;
}

interface LocatedNode {
  readonly node: TaskSnapshot | SubtaskSnapshot;
  readonly target: TaskNodeRef;
}

type RootClose =
  | {
      readonly type: 'closed';
      readonly root: TaskSnapshot;
      readonly closed: number;
      readonly discarded: boolean;
    }
  | { readonly type: 'failed'; readonly result: TaskCommandResult };

interface ClosePass {
  readonly roots: ReadonlyMap<string, TaskSnapshot>;
  readonly closed: number;
  readonly discarded: boolean;
  readonly failure?: TaskCommandResult;
}

function rootKey(ref: TaskRef): string {
  return `${ref.filePath}\0${ref.line}`;
}

function samePath(left: NodePath, right: NodePath): boolean {
  return left.length === right.length && left.every((index, at) => index === right[at]);
}

function withinSubtree(candidate: NodePath, ancestor: NodePath): boolean {
  return (
    candidate.length >= ancestor.length && ancestor.every((index, at) => candidate[at] === index)
  );
}

/**
 * Child indices from a root down to a node. Entry lines and status stamps rewrite text without
 * reordering children, so this address survives every write one tracking operation makes, while a
 * relative line moves as soon as a discarded entry disappears above it.
 */
function childIndexPath(root: TaskSnapshot, target: TaskNodeRef): NodePath | undefined {
  const path: number[] = [];
  let parent: TaskSnapshot | SubtaskSnapshot = root;
  for (const ref of taskNodeChain(target)) {
    const index: number = parent.subtasks.findIndex(
      (candidate) => candidate.ref.relativeLine === ref.relativeLine,
    );
    const child: SubtaskSnapshot | undefined = parent.subtasks[index];
    if (child === undefined) return undefined;
    path.push(index);
    parent = child;
  }
  return path;
}

function nodeAtIndexPath(root: TaskSnapshot, path: NodePath): LocatedNode | undefined {
  let node: TaskSnapshot | SubtaskSnapshot = root;
  let target: TaskNodeRef = { type: 'task', ref: root.ref };
  for (const index of path) {
    const child: SubtaskSnapshot | undefined = node.subtasks[index];
    if (child === undefined) return undefined;
    node = child;
    target = { type: 'subtask', ref: child.ref };
  }
  return { node, target };
}

/** Reports a session the previous close discarded, so presentation can explain the missing line. */
function withDiscardedShortEntry(result: TaskCommandResult): TaskCommandResult {
  if (result.type !== 'ok' || result.outcome.type !== 'task') return result;
  return { ...result, outcome: { ...result.outcome, discardedShortEntry: true } };
}

/** Every still running entry of one root generation, in depth-first source order. */
function runningEntries(root: TaskSnapshot): readonly RunningEntry[] {
  const found: RunningEntry[] = [];
  const visit = (
    node: TaskSnapshot | SubtaskSnapshot,
    target: TaskNodeRef,
    path: NodePath,
  ): void => {
    for (const entry of node.timeEntries) {
      if (entry.state === 'running') found.push({ path, target, entry });
    }
    node.subtasks.forEach((child, index) => {
      visit(child, { type: 'subtask', ref: child.ref }, [...path, index]);
    });
  };
  visit(root, { type: 'task', ref: root.ref }, []);
  return found;
}

/**
 * Enforces one active timer by writing entry lines in a fixed order on the shared mutation queue.
 * Every step re-reads its node from the root the previous write returned, so the index never has to
 * catch up between two writes of the same operation.
 */
export class TimeTrackingService {
  private readonly queries_abyssPrivate: TimeTrackingDependencies['queries'];
  private readonly edit_abyssPrivate: TimeTrackingDependencies['edit'];
  private readonly statusOf_abyssPrivate: TimeTrackingDependencies['statusOf'];
  private readonly serialize_abyssPrivate: TimeTrackingDependencies['serialize'];
  private readonly diagnostics_abyssPrivate: TaskDiagnosticSink;

  constructor(dependencies: TimeTrackingDependencies) {
    this.queries_abyssPrivate = dependencies.queries;
    this.edit_abyssPrivate = dependencies.edit;
    this.statusOf_abyssPrivate = dependencies.statusOf;
    this.serialize_abyssPrivate = dependencies.serialize;
    this.diagnostics_abyssPrivate = dependencies.diagnostics;
  }

  start(parent: TaskNodeRef, reading: ClockReading): Promise<TaskCommandResult> {
    return this.serialize_abyssPrivate(
      async () => await this.startNow_abyssPrivate(parent, reading),
    );
  }

  stopAll(reading: ClockReading): Promise<TaskCommandResult> {
    return this.serialize_abyssPrivate(async () => await this.stopNow_abyssPrivate(reading));
  }

  /**
   * Called after a status command succeeded. Closes the subtree's running entries only while the
   * committed node really reads as done or cancelled, because a queued command may have resolved
   * the same target against a status the caller no longer sees. Never throws.
   */
  async closeAfterCompletion(
    root: TaskSnapshot,
    target: TaskNodeRef,
    reading: ClockReading,
  ): Promise<void> {
    try {
      const path = childIndexPath(root, target);
      if (path === undefined) return;
      const completed = nodeAtIndexPath(root, path);
      if (completed === undefined || !this.isCompleted_abyssPrivate(completed.node)) return;
      const closed = await this.closeInRoot_abyssPrivate(root, reading, (candidate) =>
        withinSubtree(candidate, path),
      );
      if (closed.type === 'failed') {
        this.diagnostics_abyssPrivate({
          operation: 'close-time-entry',
          phase: 'completion-follow-up',
          cause: closed.result.type,
        });
      }
    } catch (error) {
      this.diagnostics_abyssPrivate(
        {
          operation: 'close-time-entry',
          phase: 'completion-follow-up',
          cause: 'repository-error',
        },
        error,
      );
    }
  }

  private async startNow_abyssPrivate(
    parent: TaskNodeRef,
    reading: ClockReading,
  ): Promise<TaskCommandResult> {
    const rootRef = taskNodeRootRef(parent);
    const indexed = this.queries_abyssPrivate
      .listNodes({ filePath: rootRef.filePath })
      .find((candidate) => sameTaskNodeRef(candidate.target, parent));
    if (indexed === undefined) return { type: 'not-found', target: parent };
    if (this.isCompleted_abyssPrivate(indexed.node)) return invalidTaskTarget('time-entry');
    const targetPath = childIndexPath(indexed.root, parent);
    if (targetPath === undefined) return { type: 'conflict', current: indexed.root };

    const entries = this.queries_abyssPrivate.activeEntries();
    const running = entries.some((entry) => sameTaskNodeRef(entry.target, parent));
    const pass = await this.closeOthers_abyssPrivate(entries, reading, {
      root: rootKey(rootRef),
      path: targetPath,
    });
    if (pass.failure !== undefined) return pass.failure;

    const current = pass.roots.get(rootKey(rootRef)) ?? indexed.root;
    if (running) return { type: 'ok', changed: false, outcome: { type: 'task', task: current } };
    const located = nodeAtIndexPath(current, targetPath);
    if (located === undefined) return { type: 'conflict', current };
    const result = await this.edit_abyssPrivate({
      type: 'add-time-entry',
      parent: located.target,
      stamp: reading.atom,
    });
    return pass.discarded ? withDiscardedShortEntry(result) : result;
  }

  private async stopNow_abyssPrivate(reading: ClockReading): Promise<TaskCommandResult> {
    const pass = await this.closeOthers_abyssPrivate(
      this.queries_abyssPrivate.activeEntries(),
      reading,
    );
    if (pass.failure !== undefined) return pass.failure;
    return {
      type: 'ok',
      changed: pass.closed > 0,
      outcome: { type: 'stopped', ...(pass.discarded ? { discardedShortEntry: true } : {}) },
    };
  }

  /** Closes every listed entry root by root, keeping only the node the caller exempts. */
  private async closeOthers_abyssPrivate(
    entries: readonly TrackedEntry[],
    reading: ClockReading,
    exempt?: { readonly root: string; readonly path: NodePath },
  ): Promise<ClosePass> {
    const observed = new Map<string, TrackedEntry>();
    for (const entry of entries) {
      const key = rootKey(entry.root);
      if (!observed.has(key)) observed.set(key, entry);
    }
    const roots = new Map<string, TaskSnapshot>();
    let closed = 0;
    let discarded = false;
    for (const [key, first] of observed) {
      const root = this.rootSnapshot_abyssPrivate(first.root);
      if (root === undefined) {
        return { roots, closed, discarded, failure: { type: 'not-found', target: first.target } };
      }
      const pass = await this.closeInRoot_abyssPrivate(
        root,
        reading,
        (path) => exempt?.root !== key || !samePath(path, exempt.path),
      );
      if (pass.type === 'failed') return { roots, closed, discarded, failure: pass.result };
      roots.set(key, pass.root);
      closed += pass.closed;
      discarded = discarded || pass.discarded;
    }
    return { roots, closed, discarded };
  }

  /**
   * Closes accepted entries of one root in source order, re-reading the next entry from the root
   * the previous write returned. Each write closes or discards one running line, so this ends.
   */
  private async closeInRoot_abyssPrivate(
    root: TaskSnapshot,
    reading: ClockReading,
    accepts: (path: NodePath) => boolean,
  ): Promise<RootClose> {
    let current = root;
    let closed = 0;
    let discarded = false;
    for (;;) {
      const next = runningEntries(current).find((candidate) => accepts(candidate.path));
      if (next === undefined) return { type: 'closed', root: current, closed, discarded };
      const result = await this.edit_abyssPrivate({
        type: 'close-time-entry',
        entry: timeEntryRef(next.target, next.entry),
        stamp: reading.atom,
        endMs: reading.epochMs,
        minimumMs: MINIMUM_TRACKED_MS,
      });
      if (result.type !== 'ok') return { type: 'failed', result };
      closed += 1;
      if (result.outcome.type !== 'task') {
        return { type: 'closed', root: current, closed, discarded };
      }
      if (result.outcome.discardedShortEntry === true) discarded = true;
      current = result.outcome.task;
    }
  }

  private rootSnapshot_abyssPrivate(ref: TaskRef): TaskSnapshot | undefined {
    const resolution = this.queries_abyssPrivate.resolve(ref);
    if (resolution.type === 'exact') return resolution.task;
    return resolution.type === 'rebased' ? resolution.current : undefined;
  }

  private isCompleted_abyssPrivate(node: TaskSnapshot | SubtaskSnapshot): boolean {
    const status = this.statusOf_abyssPrivate(node.statusSymbol);
    return status === 'done' || status === 'cancelled';
  }
}
