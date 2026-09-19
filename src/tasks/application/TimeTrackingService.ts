import type { ClockReading } from '../domain/clock';
import type { TaskCommandResult } from '../domain/commands';
import { rebaseTaskNode, taskNodeChain, taskNodeRootRef } from '../domain/taskCommandTargets';
import type { TaskResolution } from '../domain/taskReconciliation';
import { timeEntryRef, type TimeEntrySnapshot, type TrackedEntry } from '../domain/timeTracking';
import type {
  SubtaskSnapshot,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
  TaskStatus,
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

const NOTHING_DISCARDED = { discardedShortEntry: false } as const;

export interface TimeTrackingDependencies {
  readonly queries: TaskQueryApi & TaskDependencyQueryApi & TimeTrackingQueryApi;
  /** Resolves a root exactly as every rooted command does, including the index-lag bridge. */
  readonly resolveRoot: (ref: TaskRef, node: TaskNodeRef) => TaskResolution;
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

/** Which pass is closing entries, which is what a set-aside entry is reported under. */
type ClosePhase = 'close-others' | 'completion-follow-up';

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

type StartTarget =
  { readonly root: TaskSnapshot; readonly path: NodePath } | { readonly result: TaskCommandResult };

function ambiguousStart(
  resolution: Extract<TaskResolution, { readonly type: 'ambiguous' }>,
  parent: TaskNodeRef,
): TaskCommandResult {
  return {
    type: 'ambiguous',
    candidates: resolution.candidates.map((candidate) => ({
      root: candidate.root,
      target: rebaseTaskNode(parent, candidate.root.ref),
    })),
  };
}

/** The target was already tracking, so the result reports only what closing the others changed. */
function alreadyTracking(current: TaskSnapshot, pass: ClosePass): TaskCommandResult {
  return {
    type: 'ok',
    changed: pass.closed > 0,
    outcome: {
      type: 'task',
      task: current,
      ...(pass.discarded ? { discardedShortEntry: true } : {}),
    },
  };
}

function rootKey(ref: TaskRef): string {
  return `${ref.filePath}\0${ref.line}`;
}

/** Identifies one entry line inside a root generation that a failed close leaves exactly as it was. */
function entryKey(entry: RunningEntry): string {
  return JSON.stringify([entry.path, entry.entry.originalMarkdown]);
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
  private readonly resolveRoot_abyssPrivate: TimeTrackingDependencies['resolveRoot'];
  private readonly edit_abyssPrivate: TimeTrackingDependencies['edit'];
  private readonly statusOf_abyssPrivate: TimeTrackingDependencies['statusOf'];
  private readonly serialize_abyssPrivate: TimeTrackingDependencies['serialize'];
  private readonly diagnostics_abyssPrivate: TaskDiagnosticSink;

  constructor(dependencies: TimeTrackingDependencies) {
    this.queries_abyssPrivate = dependencies.queries;
    this.resolveRoot_abyssPrivate = dependencies.resolveRoot;
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
   * the same target against a status the caller no longer sees. Never throws. Reports back only
   * whether a session was dropped for being too short, so the command that triggered it can say so.
   */
  async closeAfterCompletion(
    root: TaskSnapshot,
    target: TaskNodeRef,
    reading: ClockReading,
  ): Promise<{ readonly discardedShortEntry: boolean }> {
    try {
      const path = childIndexPath(root, target);
      if (path === undefined) return NOTHING_DISCARDED;
      const completed = nodeAtIndexPath(root, path);
      if (completed === undefined || !this.isCompleted_abyssPrivate(completed.node)) {
        return NOTHING_DISCARDED;
      }
      const closed = await this.closeInRoot_abyssPrivate(
        root,
        reading,
        (candidate) => withinSubtree(candidate, path),
        'completion-follow-up',
      );
      if (closed.type !== 'failed') return { discardedShortEntry: closed.discarded };
      this.diagnostics_abyssPrivate({
        operation: 'close-time-entry',
        phase: 'completion-follow-up',
        cause: closed.result.type,
      });
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
    return NOTHING_DISCARDED;
  }

  private async startNow_abyssPrivate(
    parent: TaskNodeRef,
    reading: ClockReading,
  ): Promise<TaskCommandResult> {
    const target = this.startTarget_abyssPrivate(parent);
    if ('result' in target) return target.result;
    const { root, path } = target;
    // Read from the resolved generation, so a stale reference cannot hide the target's own timer.
    const running = runningEntries(root).some((entry) => samePath(entry.path, path));
    const key = rootKey(root.ref);
    const pass = await this.closeOthers_abyssPrivate(
      this.queries_abyssPrivate.activeEntries(),
      reading,
      { root: key, path },
    );
    if (pass.failure !== undefined) return pass.failure;

    const current = pass.roots.get(key) ?? root;
    if (running) return alreadyTracking(current, pass);
    const located = nodeAtIndexPath(current, path);
    if (located === undefined) return { type: 'conflict', current };
    const result = await this.edit_abyssPrivate({
      type: 'add-time-entry',
      parent: located.target,
      stamp: reading.atom,
    });
    return pass.discarded ? withDiscardedShortEntry(result) : result;
  }

  /**
   * Resolves the node to start on the way every rooted command resolves its root, so a reference
   * the index has already rebased still writes, and no other root of the file is cloned to find it.
   */
  private startTarget_abyssPrivate(parent: TaskNodeRef): StartTarget {
    const resolution = this.resolveRoot_abyssPrivate(taskNodeRootRef(parent), parent);
    if (resolution.type === 'ambiguous') return { result: ambiguousStart(resolution, parent) };
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') {
      return { result: { type: 'not-found', target: parent } };
    }
    const root = resolution.type === 'exact' ? resolution.task : resolution.current;
    const path = childIndexPath(root, parent);
    const located = path === undefined ? undefined : nodeAtIndexPath(root, path);
    if (path === undefined || located === undefined) {
      return { result: { type: 'conflict', current: root } };
    }
    return this.isCompleted_abyssPrivate(located.node)
      ? { result: invalidTaskTarget('time-entry') }
      : { root, path };
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
      const root = this.rootSnapshot_abyssPrivate(first.root, first.target);
      // A root the index can no longer address is reported like any other unwritable foreign entry.
      if (root === undefined) {
        this.setAside_abyssPrivate({ type: 'not-found', target: first.target }, 'close-others');
        continue;
      }
      const pass = await this.closeInRoot_abyssPrivate(
        root,
        reading,
        (path) => exempt?.root !== key || !samePath(path, exempt.path),
        'close-others',
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
   * the previous write returned. Each iteration either writes one running line away or sets it
   * aside, so the accepted set shrinks and this ends.
   *
   * A hand-written entry the plugin cannot write, such as one whose start lies ahead of the clock,
   * is reported under the phase the caller is in and left alone rather than holding back the timers
   * this pass really ends. Only an I/O failure aborts, because then the content state is unknown.
   */
  private async closeInRoot_abyssPrivate(
    root: TaskSnapshot,
    reading: ClockReading,
    accepts: (path: NodePath) => boolean,
    phase: ClosePhase,
  ): Promise<RootClose> {
    let current = root;
    let closed = 0;
    let discarded = false;
    const setAside = new Set<string>();
    for (;;) {
      const next = runningEntries(current).find(
        (candidate) => accepts(candidate.path) && !setAside.has(entryKey(candidate)),
      );
      if (next === undefined) return { type: 'closed', root: current, closed, discarded };
      const result = await this.edit_abyssPrivate({
        type: 'close-time-entry',
        entry: timeEntryRef(next.target, next.entry),
        stamp: reading.atom,
        endMs: reading.epochMs,
        minimumMs: MINIMUM_TRACKED_MS,
      });
      // A committed close always answers with its fresh root; without one nothing can be re-read.
      if (result.type === 'ok' && result.outcome.type === 'task') {
        closed += 1;
        discarded = discarded || result.outcome.discardedShortEntry === true;
        current = result.outcome.task;
        continue;
      }
      if (!this.setAside_abyssPrivate(result, phase)) return { type: 'failed', result };
      setAside.add(entryKey(next));
    }
  }

  /** True when a foreign entry the plugin cannot write may be left alone instead of aborting. */
  private setAside_abyssPrivate(result: TaskCommandResult, phase: ClosePhase): boolean {
    if (result.type === 'ok' || result.type === 'io-error') return false;
    this.diagnostics_abyssPrivate({ operation: 'close-time-entry', phase, cause: result.type });
    return true;
  }

  private rootSnapshot_abyssPrivate(ref: TaskRef, node: TaskNodeRef): TaskSnapshot | undefined {
    const resolution = this.resolveRoot_abyssPrivate(ref, node);
    if (resolution.type === 'exact') return resolution.task;
    return resolution.type === 'rebased' ? resolution.current : undefined;
  }

  private isCompleted_abyssPrivate(node: TaskSnapshot | SubtaskSnapshot): boolean {
    const status = this.statusOf_abyssPrivate(node.statusSymbol);
    return status === 'done' || status === 'cancelled';
  }
}
