import type { BrowserTaskScheduler } from '../../browserTaskScheduler';
import type {
  TaskSearchOccurrence,
  TaskSearchOrganization,
} from '../../task-lists/taskSearchOrganization';
import {
  TaskSearchError,
  nodeAtSearchAddress,
  taskSearchAddressKey,
  type TaskNodeSnapshot,
  type TaskSearchAddress,
  type TaskSearchApi,
  type TaskSearchHydratedHit,
  type TaskSnapshot,
} from '../../tasks';
import type { TaskRenderOutcome } from '../../ui/taskRenderScope';
import type { TaskCardMount } from '../center/TaskCardRenderer';
import { indexedRows, type TaskListRow, type TaskListRows } from './taskListRows';
import { mountTaskListRow } from './taskListRowView';
import type { TaskRowMount } from './TaskListSurface';

export interface TaskSearchRowsIdentity {
  readonly request: number;
  readonly generation: number;
  readonly semanticsRevision: number;
  readonly query: string;
  readonly signal: AbortSignal;
}
export interface TaskSearchRowsOptions {
  readonly search: TaskSearchApi;
  readonly scheduler: Pick<BrowserTaskScheduler, 'yield'>;
  prepareDependencies(generation: number, signal: AbortSignal): Promise<void>;
  isCurrent(identity: TaskSearchRowsIdentity): boolean;
  mountCard(
    element: HTMLElement,
    task: TaskNodeSnapshot,
    occurrence: TaskSearchOccurrence,
  ): TaskCardMount;
  updateCard(card: TaskCardMount, task: TaskNodeSnapshot, occurrence: TaskSearchOccurrence): void;
  refreshMeasurements(): void;
  reportFailure(error: unknown): void;
}
interface RootLease {
  readonly key: string;
  readonly occurrence: TaskSearchOccurrence;
  users: number;
  task?: TaskSnapshot | undefined;
  failure?: { readonly type: 'failed'; readonly error: unknown };
}
interface MountedRow {
  dirty: boolean;
  leased: boolean;
  occurrence: TaskSearchOccurrence;
  readonly element: HTMLElement;
  readonly document: Document;
  readonly window: Window | null;
  root: RootLease;
  card?: TaskCardMount | undefined;
  receipt?: Promise<TaskRenderOutcome>;
  readyReceipt?: Promise<TaskRenderOutcome>;
  failure?: { readonly type: 'failed'; readonly error: unknown };
}
function rootKey(address: TaskSearchAddress): string {
  return JSON.stringify([address.epoch, address.version, address.rootId]);
}
const cancelled: TaskRenderOutcome = { type: 'cancelled' };

/** Compact order plus finite, shared exact-root leases. Geometry stays with TaskListSurface. */
export class TaskSearchRows {
  readonly #options: TaskSearchRowsOptions;
  #rows: TaskListRows<TaskSearchOccurrence> = indexedRows([]);
  #identity: TaskSearchRowsIdentity | undefined;
  #controller = new AbortController();
  #releaseIdentity: (() => void) | undefined;
  readonly #roots = new Map<string, RootLease>();
  readonly #mounted = new Map<string, MountedRow>();
  readonly #changed = new Set<() => void>();
  #keys: readonly string[] = [];
  #revision = 0;
  #disposed = false;
  #pumping = false;
  #dependencies: Promise<void> | undefined;
  #batch:
    { readonly roots: readonly RootLease[]; readonly controller: AbortController } | undefined;

  constructor(options: TaskSearchRowsOptions) {
    this.#options = options;
  }

  set(
    organization: TaskSearchOrganization,
    groupBy: string,
    identity: TaskSearchRowsIdentity,
  ): TaskListRows<TaskSearchOccurrence> {
    const semanticsChanged = this.#identity?.semanticsRevision !== identity.semanticsRevision;
    this.#releaseIdentity?.();
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#identity = identity;
    this.#dependencies = undefined;
    const abort = (): void => {
      this.#controller.abort();
      this.#notify();
    };
    identity.signal.addEventListener('abort', abort, { once: true });
    this.#releaseIdentity = () => {
      identity.signal.removeEventListener('abort', abort);
    };
    if (identity.signal.aborted) abort();
    const rows: Array<TaskListRow<TaskSearchOccurrence>> = [];
    let previous: string | undefined;
    for (const occurrence of organization.occurrences) {
      const group = occurrence.group;
      if (group !== null && group.key !== previous) {
        rows.push({
          kind: 'group',
          key: `group:${groupBy}:${group.key}`,
          label: group.label,
          count: organization.groupCounts.get(group.key) ?? 0,
          first: rows.length === 0,
          ...(groupBy === 'source-note' ? { sourcePath: group.key } : {}),
        });
        previous = group.key;
      }
      rows.push({
        kind: 'task',
        key: occurrence.key,
        taskKey: occurrence.taskKey,
        task: occurrence,
      });
    }
    this.#rows = indexedRows(rows);
    this.#reconcileRoots(semanticsChanged);
    this.#notify();
    this.#pump();
    return this.#rows;
  }

  #reconcileRoots(semanticsChanged: boolean): void {
    // Exact addresses prove source identity, not descendant status classification.
    // Keep finite leases/cards; reacquire their classified snapshots only on semantic changes.
    for (const root of this.#roots.values()) {
      if (semanticsChanged) root.task = undefined;
      delete root.failure;
    }
    // A surviving exact address keeps its root across unrelated G after dependency readiness.
    for (const row of this.#mounted.values()) {
      const next = this.#rows.task(row.occurrence.key);
      if (
        next === undefined ||
        taskSearchAddressKey(next.address) !== taskSearchAddressKey(row.occurrence.address)
      )
        this.#retire(row);
      else {
        row.occurrence = next;
        row.dirty = true;
        if (semanticsChanged) delete row.receipt;
      }
    }
  }

  mount(
    host: HTMLElement,
    row: TaskListRow<TaskSearchOccurrence>,
  ): TaskRowMount<TaskSearchOccurrence> {
    if (row.kind === 'group') {
      const element = mountTaskListRow(host, row, () => {
        throw new Error('Expected group');
      });
      return {
        element,
        update: (next) => {
          if (next.kind === 'group') {
            element.setText(`${next.label}  ${next.count}`);
            element.toggleClass('abyss-group-header--first', next.first);
            if (next.sourcePath === undefined) element.removeAttribute('aria-label');
            else element.setAttribute('aria-label', next.sourcePath);
          }
        },
        destroy: () => {
          element.remove();
        },
      };
    }
    const element = host.createDiv({ cls: 'abyss-task-card' });
    element.setAttribute('aria-busy', 'true');
    element.inert = true;
    const mounted: MountedRow = {
      dirty: true,
      leased: true,
      element,
      document: element.ownerDocument,
      window: element.ownerDocument.defaultView,
      occurrence: row.task,
      root: this.#acquire(row.task),
    };
    this.#mounted.set(row.key, mounted);
    this.#notify();
    this.#pump();
    let live = true;
    return {
      element,
      measurementReady: () =>
        !mounted.dirty &&
        mounted.card !== undefined &&
        mounted.card.settled === mounted.readyReceipt,
      update: (next) => {
        if (!live || next.kind !== 'task') return;
        if (
          !mounted.leased ||
          taskSearchAddressKey(mounted.occurrence.address) !==
            taskSearchAddressKey(next.task.address)
        ) {
          mounted.card?.destroy();
          mounted.card = undefined;
          if (mounted.leased) this.#release(mounted.root);
          mounted.root = this.#acquire(next.task);
          mounted.leased = true;
          delete mounted.failure;
          // Card destruction detaches; the surface retains and places the same holder.
          element.empty();
          element.inert = true;
          element.setAttribute('aria-busy', 'true');
        }
        mounted.dirty = true;
        mounted.occurrence = next.task;
        this.#mounted.set(next.key, mounted);
        this.#notify();
        this.#pump();
      },
      destroy: () => {
        if (!live) return;
        live = false;
        this.#retire(mounted);
        element.remove();
      },
    };
  }

  get receiptRevision(): number {
    return this.#revision;
  }

  mountedChanged(keys: readonly string[]): void {
    if (
      keys.length === this.#keys.length &&
      keys.every((key, index) => this.#keys[index] === key)
    ) {
      this.#pump();
      return;
    }
    this.#keys = [...keys];
    this.#notify();
    this.#pump();
  }

  async settleMounted(signal: AbortSignal): Promise<TaskRenderOutcome> {
    const identity = this.#identity;
    for (;;) {
      // Surface callbacks may run within reconciliation. Join only its final mounted set.
      await Promise.resolve();
      if (!this.#currentWait(identity, signal)) return cancelled;
      const revision = this.#revision;
      const outcomes = await Promise.all(
        this.#keys
          .filter((key) => this.#rows.task(key) !== undefined)
          .map((key) => this.settleRow(key, signal)),
      );
      if (!this.#currentWait(identity, signal)) return cancelled;
      if (revision !== this.#revision) continue;
      return (
        outcomes.find((outcome) => outcome.type === 'failed') ??
        outcomes.find((outcome) => outcome.type === 'cancelled') ?? { type: 'ready' }
      );
    }
  }

  async settleRow(key: string, signal: AbortSignal): Promise<TaskRenderOutcome> {
    const identity = this.#identity;
    const occurrence = this.#rows.task(key);
    if (occurrence === undefined) return cancelled;
    let seen: MountedRow | undefined;
    while (this.#rowCurrent(occurrence, identity, signal)) {
      const row = this.#mounted.get(key);
      if (seen !== undefined && row !== seen) return cancelled;
      seen = row;
      const outcome = await this.#settleCard(row, signal);
      if (outcome !== undefined)
        return this.#rowCurrent(occurrence, identity, signal) ? outcome : cancelled;
    }
    return cancelled;
  }

  #rowCurrent(
    occurrence: TaskSearchOccurrence,
    identity: TaskSearchRowsIdentity | undefined,
    signal: AbortSignal,
  ): boolean {
    return (
      this.#current(identity) && !signal.aborted && this.#rows.task(occurrence.key) === occurrence
    );
  }

  async #settleCard(
    row: MountedRow | undefined,
    signal: AbortSignal,
  ): Promise<TaskRenderOutcome | undefined> {
    if (row === undefined) {
      await this.#wait(undefined, signal);
      return undefined;
    }
    const initial = this.#mountedOutcome(row);
    if (initial !== undefined) return initial;
    const receipt = row.dirty ? undefined : row.card?.settled;
    const outcome = await this.#wait(receipt, signal);
    return this.#mountedOutcome(row) ?? this.#currentReceiptOutcome(row, receipt, outcome);
  }

  #currentReceiptOutcome(
    row: MountedRow,
    receipt: Promise<TaskRenderOutcome> | undefined,
    outcome: TaskRenderOutcome | undefined,
  ): TaskRenderOutcome | undefined {
    if (row.card?.settled !== receipt) return undefined;
    if (receipt !== undefined && outcome?.type === 'ready') row.readyReceipt = receipt;
    return outcome;
  }

  #mountedOutcome(row: MountedRow): TaskRenderOutcome | undefined {
    if (this.#mounted.get(row.occurrence.key) !== row) return cancelled;
    return row.failure ?? row.root.failure ?? (this.#eligible(row) ? undefined : cancelled);
  }

  async snapshot(key: string, signal: AbortSignal): Promise<TaskNodeSnapshot> {
    const identity = this.#identity;
    const occurrence = this.#rows.task(key);
    this.#check(identity, signal);
    if (occurrence === undefined) throw new TaskSearchError('stale', 'Search row missing');
    const root = this.#acquire(occurrence);
    this.#pump();
    try {
      while (root.task === undefined || this.#dependencies === undefined) {
        this.#check(identity, signal);
        if (root.failure !== undefined) throw root.failure.error;
        await this.#wait(undefined, signal);
      }
      let outcome: TaskRenderOutcome | undefined;
      while (outcome === undefined) {
        outcome = await this.#wait(
          this.#dependencies.then(() => ({ type: 'ready' as const })),
          signal,
        );
        this.#check(identity, signal);
      }
      if (outcome.type === 'failed') throw outcome.error;
      this.#check(identity, signal);
      return nodeAtSearchAddress(root.task, occurrence.address);
    } finally {
      this.#release(root);
    }
  }

  async resolve(
    keys: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly TaskNodeSnapshot[]> {
    const identity = this.#identity;
    this.#check(identity, signal);
    const distinct = new Map<string, TaskSearchOccurrence>();
    for (const key of keys) {
      const occurrence = this.#rows.task(key);
      if (occurrence === undefined) throw new TaskSearchError('stale', 'Search row missing');
      distinct.set(occurrence.taskKey, occurrence);
    }
    const occurrences = [...distinct.values()];
    const tasks: TaskNodeSnapshot[] = [];
    for (let offset = 0; offset < occurrences.length; offset += 50) {
      this.#check(identity, signal);
      const hits = await this.#options.search.resolveHits(
        occurrences.slice(offset, offset + 50),
        signal,
      );
      this.#check(identity, signal);
      tasks.push(...hits.map((hit) => hit.task));
      if (offset + 50 < occurrences.length) await this.#options.scheduler.yield(signal);
    }
    this.#check(identity, signal);
    return tasks;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseIdentity?.();
    this.#controller.abort();
    for (const row of [...this.#mounted.values()]) this.#retire(row);
    this.#roots.clear();
    this.#rows = indexedRows([]);
    this.#keys = [];
    this.#notify();
  }
  #current(identity = this.#identity): boolean {
    return (
      !this.#disposed &&
      identity !== undefined &&
      identity === this.#identity &&
      !identity.signal.aborted &&
      !this.#controller.signal.aborted &&
      this.#options.isCurrent(identity)
    );
  }
  #currentWait(identity: TaskSearchRowsIdentity | undefined, signal: AbortSignal): boolean {
    return this.#current(identity) && !signal.aborted;
  }
  #check(identity: TaskSearchRowsIdentity | undefined, signal: AbortSignal): void {
    if (signal.aborted) throw new TaskSearchError('aborted', 'Search row cancelled');
    if (!this.#current(identity)) throw new TaskSearchError('stale', 'Search rows replaced');
  }
  #eligible(row: MountedRow): boolean {
    const element = row.element;
    if (
      !element.isConnected ||
      element.ownerDocument !== row.document ||
      row.document.defaultView !== row.window ||
      row.document.hidden ||
      row.window === null
    )
      return false;
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      const style = row.window.getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility))
        return false;
    }
    return true;
  }
  #acquire(occurrence: TaskSearchOccurrence): RootLease {
    const key = rootKey(occurrence.address);
    let root = this.#roots.get(key);
    if (root === undefined) {
      root = { key, occurrence, users: 0 };
      this.#roots.set(key, root);
    }
    root.users++;
    return root;
  }
  #release(root: RootLease): void {
    if (--root.users > 0) return;
    root.task = undefined;
    if (this.#roots.get(root.key) === root) this.#roots.delete(root.key);
    if (this.#batch?.roots.every((candidate) => candidate.users === 0) === true)
      this.#batch.controller.abort();
    this.#notify();
  }
  #retire(row: MountedRow): void {
    if (this.#mounted.get(row.occurrence.key) !== row) return;
    this.#mounted.delete(row.occurrence.key);
    row.card?.destroy();
    row.card = undefined;
    if (row.leased) this.#release(row.root);
    row.leased = false;
    this.#notify();
  }
  #notify(): void {
    this.#revision++;
    for (const wake of [...this.#changed]) wake();
  }
  #wait(
    receipt: Promise<TaskRenderOutcome> | undefined,
    signal: AbortSignal,
  ): Promise<TaskRenderOutcome | undefined> {
    const lifetime = this.#controller.signal;
    return new Promise((resolve) => {
      const finish = (outcome: TaskRenderOutcome | undefined): void => {
        this.#changed.delete(wake);
        signal.removeEventListener('abort', abort);
        lifetime.removeEventListener('abort', abort);
        resolve(outcome);
      };
      const wake = (): void => {
        finish(undefined);
      };
      const abort = (): void => {
        finish(cancelled);
      };
      this.#changed.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      lifetime.addEventListener('abort', abort, { once: true });
      if (signal.aborted || lifetime.aborted) abort();
      if (receipt !== undefined)
        void receipt.then(finish, (error) => {
          finish({ type: 'failed', error });
        });
    });
  }
  #demanded(root: RootLease): boolean {
    let rowUsers = 0;
    for (const row of this.#mounted.values()) {
      if (row.root !== root || !row.leased) continue;
      rowUsers++;
      if (this.#eligible(row)) return true;
    }
    return root.users > rowUsers;
  }

  async #hydrateBatch(
    roots: readonly RootLease[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[] | undefined> {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    const batch = { roots, controller };
    this.#batch = batch;
    let release: (() => void) | undefined;
    try {
      if (signal.aborted) abort();
      const cancelled = new Promise<undefined>((resolve) => {
        const done = (): void => {
          resolve(undefined);
        };
        controller.signal.addEventListener('abort', done, { once: true });
        release = () => {
          controller.signal.removeEventListener('abort', done);
        };
        if (controller.signal.aborted) done();
      });
      return await Promise.race([
        this.#options.search.resolveHits(
          roots.map((root) => ({
            ...root.occurrence,
            address: { ...root.occurrence.address, childLines: [] },
          })),
          controller.signal,
        ),
        cancelled,
      ]);
    } catch (error) {
      if (!controller.signal.aborted && this.#current()) this.#failDemand(roots, error);
      return undefined;
    } finally {
      signal.removeEventListener('abort', abort);
      release?.();
      if (this.#batch === batch) this.#batch = undefined;
    }
  }

  #hasWork(): boolean {
    return (
      [...this.#roots.values()].some(
        (root) => root.task === undefined && root.failure === undefined && this.#demanded(root),
      ) ||
      [...this.#mounted.values()].some(
        (row) =>
          row.dirty &&
          row.failure === undefined &&
          row.root.failure === undefined &&
          this.#eligible(row),
      )
    );
  }
  #pump(): void {
    if (this.#pumping || !this.#current() || !this.#hasWork()) return;
    this.#pumping = true;
    const identity = this.#identity;
    const signal = this.#controller.signal;
    void this.#hydrate(identity, signal)
      .catch((error: unknown) => {
        if (!this.#current(identity) || signal.aborted) return;
        this.#dependencies = undefined;
        this.#failDemand(this.#roots.values(), error);
      })
      .finally(() => {
        this.#pumping = false;
        this.#pump();
      });
  }
  #failDemand(roots: Iterable<RootLease>, error: unknown): void {
    let failed = false;
    for (const root of roots) {
      if (this.#roots.get(root.key) !== root || !this.#demanded(root)) continue;
      root.failure = { type: 'failed', error };
      for (const row of this.#mounted.values()) {
        if (row.root !== root) continue;
        row.card?.destroy();
        row.card = undefined;
        row.element.inert = true;
        row.element.empty();
        delete row.receipt;
        delete row.readyReceipt;
      }
      failed = true;
    }
    this.#notify();
    if (failed) this.#options.reportFailure(error);
  }
  async #hydrate(identity: TaskSearchRowsIdentity | undefined, signal: AbortSignal): Promise<void> {
    await this.#options.scheduler.yield(signal);
    this.#check(identity, signal);
    if (this.#roots.size === 0 || identity === undefined) return;
    this.#dependencies ??= this.#options.prepareDependencies(identity.generation, signal);
    await this.#dependencies;
    this.#check(identity, signal);
    for (;;) {
      const batch = [...this.#roots.values()]
        .filter(
          (root) =>
            root.users > 0 &&
            root.task === undefined &&
            root.failure === undefined &&
            this.#demanded(root),
        )
        .slice(0, 50);
      if (batch.length === 0) break;
      const hits = await this.#hydrateBatch(batch, signal);
      if (hits === undefined) {
        this.#check(identity, signal);
        continue;
      }
      this.#check(identity, signal);
      this.#acceptBatch(batch, hits);
      this.#paint();
      this.#notify();
      if (
        [...this.#roots.values()].some(
          (root) => root.task === undefined && root.failure === undefined && this.#demanded(root),
        )
      )
        await this.#options.scheduler.yield(signal);
      this.#check(identity, signal);
    }
    this.#paint();
    this.#notify();
  }
  #acceptBatch(batch: readonly RootLease[], hits: readonly TaskSearchHydratedHit[]): void {
    for (const [index, root] of batch.entries()) {
      if (this.#roots.get(root.key) !== root || root.users === 0 || !this.#demanded(root)) continue;
      const hit = hits[index];
      if (hit === undefined || rootKey(hit.hit.address) !== root.key)
        throw new TaskSearchError('stale', 'Search hydration changed');
      root.task = hit.task.root;
    }
  }

  #receiptFinished(
    row: MountedRow,
    receipt: Promise<TaskRenderOutcome>,
    outcome: TaskRenderOutcome,
  ): void {
    if (
      !this.#current() ||
      this.#mounted.get(row.occurrence.key) !== row ||
      row.receipt !== receipt ||
      !this.#eligible(row)
    )
      return;
    if (outcome.type === 'failed' && row.failure === undefined) {
      row.failure = outcome;
      row.card?.destroy();
      row.card = undefined;
      if (row.leased) this.#release(row.root);
      row.leased = false;
      this.#options.reportFailure(outcome.error);
    }
    if (outcome.type === 'ready') row.readyReceipt = receipt;
    this.#options.refreshMeasurements();
    this.#notify();
  }

  #failRow(row: MountedRow, error: unknown): void {
    row.card?.destroy();
    row.card = undefined;
    row.failure = { type: 'failed', error };
    if (row.leased) this.#release(row.root);
    row.leased = false;
    this.#options.reportFailure(error);
  }

  #paint(): void {
    for (const row of this.#mounted.values()) {
      const task = row.root.task;
      if (!row.dirty || task === undefined || !this.#eligible(row) || row.failure !== undefined)
        continue;
      row.dirty = false;
      try {
        if (row.card === undefined)
          row.card = this.#options.mountCard(
            row.element,
            nodeAtSearchAddress(task, row.occurrence.address),
            row.occurrence,
          );
        else
          this.#options.updateCard(
            row.card,
            nodeAtSearchAddress(task, row.occurrence.address),
            row.occurrence,
          );
        row.element.inert = false;
        row.element.removeAttribute('aria-busy');
        const receipt = row.card.settled;
        if (row.receipt !== receipt) {
          row.receipt = receipt;
          void receipt
            .then((outcome) => {
              this.#receiptFinished(row, receipt, outcome);
            })
            .catch((error: unknown) => {
              this.#receiptFinished(row, receipt, { type: 'failed', error });
            });
        }
      } catch (error) {
        this.#failRow(row, error);
      }
    }
    this.#options.refreshMeasurements();
  }
}
