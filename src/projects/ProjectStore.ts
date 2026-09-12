import { getAllTags, TFile, type App, type CachedMetadata, type TAbstractFile } from 'obsidian';
import { evaluateQuery } from '../query/evaluateQuery';
import type { CalendarSettings } from '../settings/types';
import type { TaskIndexEvent, TaskQueryApi, TaskSnapshot } from '../tasks';
import { resolveStatus } from './status';
import type { Project, ProjectStats } from './types';

/** A verified native source observation for one project path. */
export interface ProjectSourceObservation {
  readonly path: string;
  readonly revision: number;
  readonly project: Project | undefined;
}

interface PendingSourceObservation {
  readonly revision: number;
  readonly data: string | undefined;
  readonly cache: CachedMetadata | undefined;
}

interface PublishedSourceObservation {
  readonly pending: PendingSourceObservation;
  readonly observation: ProjectSourceObservation;
}

export function computeStats(tasks: readonly TaskSnapshot[]): ProjectStats {
  let done = 0;
  let cancelled = 0;
  let inProgress = 0;
  for (const t of tasks) {
    if (t.status === 'done') done++;
    else if (t.status === 'cancelled') cancelled++;
    else if (t.status === 'in-progress') inProgress++;
  }
  return { total: tasks.length, done, cancelled, inProgress };
}

function basename(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/, '');
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension === 'md';
}

function wasMarkdown(path: string): boolean {
  const name = path.replace(/^.*\//u, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 && name.slice(dot + 1) === 'md';
}

function metadataMayContainTasks(data: string, cache: CachedMetadata): boolean {
  if (cache.listItems?.some((item) => item.task !== undefined) ?? false) return true;
  return data.split('\n').some((line) => /^[\s>]*- \[.\]/u.test(line));
}

/**
 * Enumerates and caches project notes (markdown files matching the membership
 * query), computing per-note task stats. Registers its own vault/metadata
 * listeners — it must NOT depend only on task-index events, because a project
 * note with no tasks is never in the task map and its create/delete/rename
 * would be missed.
 */
export class ProjectStore {
  private cache_abyssPrivate: Project[] = [];
  private byPath_abyssPrivate = new Map<string, Project>();
  private listeners_abyssPrivate: Array<() => void> = [];
  private sourceListeners_abyssPrivate: Array<(observation: ProjectSourceObservation) => void> = [];
  private eventUnsubs_abyssPrivate: Array<() => void> = [];
  private queryUnsub_abyssPrivate: (() => void) | undefined;
  private reconciliationUnsub_abyssPrivate: (() => void) | undefined;
  private debounce_abyssPrivate: number | undefined;
  private readonly waitingPaths_abyssPrivate = new Set<string>();
  private readonly readyPaths_abyssPrivate = new Set<string>();
  private readyFull_abyssPrivate = false;
  private readonly pendingCreates_abyssPrivate = new Set<string>();
  private readonly pendingSourceObservations_abyssPrivate = new Map<
    string,
    PendingSourceObservation
  >();
  private readonly publishedSourceObservations_abyssPrivate = new Map<
    string,
    PublishedSourceObservation
  >();
  private sourceRevision_abyssPrivate = 0;
  private settingsSignature_abyssPrivate = '';

  constructor(
    private readonly app_abyssPrivate: App,
    private readonly queries_abyssPrivate: TaskQueryApi,
    private readonly settings_abyssPrivate: CalendarSettings,
  ) {}

  initialize(): void {
    this.recomputeAll_abyssPrivate();
    this.settingsSignature_abyssPrivate = this.projectEntrySettingsSignature_abyssPrivate();
    // A single note edit re-evaluates only that note (O(1) note + its tasks).
    // Create/delete/rename change the membership set → full rescan (rare events).
    const metadataRef = this.app_abyssPrivate.metadataCache.on('changed', (file, data, cache) => {
      if (
        file.extension === 'md' &&
        this.app_abyssPrivate.vault.getAbstractFileByPath(file.path) === file
      ) {
        this.recordSourceObservation_abyssPrivate(file.path, data, cache);
        if (this.pendingCreates_abyssPrivate.has(file.path)) {
          if (
            !metadataMayContainTasks(data, cache) &&
            !this.hasIndexedTasks_abyssPrivate(file.path)
          ) {
            this.pendingCreates_abyssPrivate.delete(file.path);
            this.releasePath_abyssPrivate(file.path);
            return;
          }
        }
        this.awaitBarrier_abyssPrivate(file.path);
      }
    });
    this.eventUnsubs_abyssPrivate.push(() => {
      this.app_abyssPrivate.metadataCache.offref(metadataRef);
    });
    const createRef = this.app_abyssPrivate.vault.on('create', (file) => {
      if (isMarkdownFile(file)) this.pendingCreates_abyssPrivate.add(file.path);
    });
    const deleteRef = this.app_abyssPrivate.vault.on('delete', (file) => {
      if (!isMarkdownFile(file)) return;
      this.pendingCreates_abyssPrivate.delete(file.path);
      this.recordSourceObservation_abyssPrivate(file.path, undefined, undefined);
      const project = this.byPath_abyssPrivate.get(file.path);
      if (project?.stats.total === 0 && !this.hasIndexedTasks_abyssPrivate(file.path)) {
        this.releasePath_abyssPrivate(file.path);
      } else {
        this.awaitBarrier_abyssPrivate(file.path);
      }
    });
    const renameRef = this.app_abyssPrivate.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && (file.extension === 'md' || wasMarkdown(oldPath))) {
        this.pendingCreates_abyssPrivate.delete(oldPath);
        this.recordSourceObservation_abyssPrivate(oldPath, undefined, undefined);
        const project = this.byPath_abyssPrivate.get(oldPath);
        if (
          (project === undefined || project.stats.total === 0) &&
          !this.hasIndexedTasks_abyssPrivate(oldPath, file.path)
        ) {
          this.releasePath_abyssPrivate(oldPath, file.path);
        } else {
          this.awaitBarrier_abyssPrivate(oldPath, file.path);
        }
      }
    });
    this.eventUnsubs_abyssPrivate.push(
      () => {
        this.app_abyssPrivate.vault.offref(createRef);
      },
      () => {
        this.app_abyssPrivate.vault.offref(deleteRef);
      },
      () => {
        this.app_abyssPrivate.vault.offref(renameRef);
      },
    );
    this.queryUnsub_abyssPrivate = this.queries_abyssPrivate.subscribe((event) => {
      this.onTaskIndexEvent_abyssPrivate(event);
    });
    this.reconciliationUnsub_abyssPrivate = this.queries_abyssPrivate.subscribeReconciled(
      (files) => {
        this.releaseChangedPaths_abyssPrivate(files);
      },
    );
  }

  private onTaskIndexEvent_abyssPrivate(event: TaskIndexEvent): void {
    if (event.type === 'changed') {
      this.releaseChangedPaths_abyssPrivate(event.files);
    } else if (event.type === 'initialized') {
      this.releaseFull_abyssPrivate();
    } else if (event.type === 'renamed') {
      this.pendingCreates_abyssPrivate.delete(event.oldPath);
      this.pendingCreates_abyssPrivate.delete(event.newPath);
      this.releasePath_abyssPrivate(event.oldPath, event.newPath);
    } else {
      this.pendingCreates_abyssPrivate.delete(event.path);
      this.releasePath_abyssPrivate(event.path);
    }
  }

  private releaseChangedPaths_abyssPrivate(files: readonly string[]): void {
    for (const path of files) {
      this.pendingCreates_abyssPrivate.delete(path);
      this.releasePath_abyssPrivate(path);
    }
  }

  private awaitBarrier_abyssPrivate(...paths: string[]): void {
    if (this.readyFull_abyssPrivate) return;
    for (const path of paths) {
      if (!this.readyPaths_abyssPrivate.has(path)) this.waitingPaths_abyssPrivate.add(path);
    }
  }

  private releasePath_abyssPrivate(...paths: string[]): void {
    for (const path of paths) {
      this.waitingPaths_abyssPrivate.delete(path);
      this.readyPaths_abyssPrivate.add(path);
    }
    this.scheduleFlush_abyssPrivate();
  }

  private releaseFull_abyssPrivate(): void {
    this.waitingPaths_abyssPrivate.clear();
    this.readyFull_abyssPrivate = true;
    this.scheduleFlush_abyssPrivate();
  }

  private scheduleFlush_abyssPrivate(): void {
    if (this.debounce_abyssPrivate !== undefined) window.clearTimeout(this.debounce_abyssPrivate);
    this.debounce_abyssPrivate = window.setTimeout(() => {
      this.flush_abyssPrivate();
    }, 150);
  }

  private flush_abyssPrivate(): void {
    const before = this.cacheSignature_abyssPrivate();
    const observedPaths = new Set(this.readyPaths_abyssPrivate);
    if (this.readyFull_abyssPrivate) {
      this.recomputeAll_abyssPrivate();
      for (const path of this.pendingSourceObservations_abyssPrivate.keys())
        observedPaths.add(path);
    } else if (this.readyPaths_abyssPrivate.size > 0) {
      for (const path of this.readyPaths_abyssPrivate) this.updateOne_abyssPrivate(path);
      this.rebuildCache_abyssPrivate();
    }
    this.readyFull_abyssPrivate = false;
    this.readyPaths_abyssPrivate.clear();
    this.notifyIfChanged_abyssPrivate(before);
    for (const path of observedPaths) this.reconcileSourceObservation_abyssPrivate(path);
  }

  private recordSourceObservation_abyssPrivate(
    path: string,
    data: string | undefined,
    cache: CachedMetadata | undefined,
  ): void {
    this.pendingSourceObservations_abyssPrivate.set(path, {
      revision: ++this.sourceRevision_abyssPrivate,
      data,
      cache,
    });
  }

  private reconcileSourceObservation_abyssPrivate(path: string): void {
    const pending = this.pendingSourceObservations_abyssPrivate.get(path);
    if (pending === undefined) return;
    if (this.sourceListeners_abyssPrivate.length === 0) {
      this.pendingSourceObservations_abyssPrivate.delete(path);
      return;
    }
    const project =
      pending.cache === undefined
        ? undefined
        : (this.makeEntry_abyssPrivate(
            path,
            pending.cache,
            this.queries_abyssPrivate.list({ filePath: path }),
          ) ?? undefined);
    if (pending.data === undefined) {
      this.publishSourceObservation_abyssPrivate(path, pending, project);
      return;
    }
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') {
      this.publishSourceObservation_abyssPrivate(path, pending, project);
      return;
    }
    void this.app_abyssPrivate.vault.read(file).then(
      (currentData) => {
        if (currentData === pending.data)
          this.publishSourceObservation_abyssPrivate(path, pending, project);
      },
      (error: unknown) => {
        if (this.pendingSourceObservations_abyssPrivate.get(path) !== pending) return;
        console.error('[abyss-tasks] Could not reconcile project source observation', {
          path,
          cause: error,
        });
      },
    );
  }

  private publishSourceObservation_abyssPrivate(
    path: string,
    pending: PendingSourceObservation,
    project: Project | undefined,
  ): void {
    if (this.pendingSourceObservations_abyssPrivate.get(path) !== pending) return;
    this.pendingSourceObservations_abyssPrivate.delete(path);
    const observation: ProjectSourceObservation = {
      path,
      revision: pending.revision,
      project,
    };
    this.publishedSourceObservations_abyssPrivate.set(path, { pending, observation });
    for (const listener of this.sourceListeners_abyssPrivate) listener(observation);
  }

  private hasIndexedTasks_abyssPrivate(...paths: string[]): boolean {
    return paths.some((path) => this.queries_abyssPrivate.list({ filePath: path }).length > 0);
  }

  private cacheSignature_abyssPrivate(): string {
    return JSON.stringify(this.cache_abyssPrivate);
  }

  private notifyIfChanged_abyssPrivate(before: string): void {
    if (this.cacheSignature_abyssPrivate() === before) return;
    for (const cb of this.listeners_abyssPrivate) cb();
  }

  /** Full O(N + T) rescan of every markdown file. Used on init, create/delete/rename, refresh(). */
  private recomputeAll_abyssPrivate(): void {
    const tasksByPath = this.groupTasksByPath_abyssPrivate();
    this.byPath_abyssPrivate = new Map();
    for (const file of this.app_abyssPrivate.vault.getMarkdownFiles()) {
      const cache = this.app_abyssPrivate.metadataCache.getFileCache(file);
      const entry = this.makeEntry_abyssPrivate(file.path, cache, tasksByPath.get(file.path) ?? []);
      if (entry != null) this.byPath_abyssPrivate.set(file.path, entry);
    }
    this.rebuildCache_abyssPrivate();
  }

  /** Re-evaluate a single note in place — O(1 note + T for its task filter). */
  private updateOne_abyssPrivate(path: string): void {
    // Only markdown files are projects; folders/non-md drop out.
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') {
      this.byPath_abyssPrivate.delete(path);
      return;
    }
    const cache = this.app_abyssPrivate.metadataCache.getFileCache(file);
    const tasks = this.queries_abyssPrivate.list({ filePath: path });
    const entry = this.makeEntry_abyssPrivate(path, cache, tasks);
    if (entry != null) this.byPath_abyssPrivate.set(path, entry);
    else this.byPath_abyssPrivate.delete(path);
  }

  private makeEntry_abyssPrivate(
    path: string,
    cache: CachedMetadata | null,
    tasks: readonly TaskSnapshot[],
  ): Project | null {
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const tags = (cache != null ? (getAllTags(cache) ?? []) : []).map((tag) => tag.toLowerCase());
    if (!evaluateQuery(this.settings_abyssPrivate.projects.membershipQuery, path, tags, fm))
      return null;
    const { statusId, rawStatus } = resolveStatus(this.settings_abyssPrivate.projects, fm);
    return {
      path,
      name: basename(path),
      frontmatter: fm,
      tags,
      statusId,
      rawStatus,
      stats: computeStats(tasks),
    };
  }

  private groupTasksByPath_abyssPrivate(): Map<string, TaskSnapshot[]> {
    const map = new Map<string, TaskSnapshot[]>();
    for (const t of this.queries_abyssPrivate.list()) {
      const arr = map.get(t.source.filePath) ?? [];
      arr.push(t);
      map.set(t.source.filePath, arr);
    }
    return map;
  }

  private rebuildCache_abyssPrivate(): void {
    this.cache_abyssPrivate = Array.from(this.byPath_abyssPrivate.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  list(): Project[] {
    return this.cache_abyssPrivate;
  }

  get(path: string): Project | undefined {
    return this.byPath_abyssPrivate.get(path);
  }

  activeForLeftPanel(): Project[] {
    const onPanel = new Set(
      this.settings_abyssPrivate.projects.statuses.filter((s) => s.onLeftPanel).map((s) => s.id),
    );
    return this.cache_abyssPrivate.filter((p) => p.statusId !== null && onPanel.has(p.statusId));
  }

  refresh(): void {
    this.recomputeAll_abyssPrivate();
    this.settingsSignature_abyssPrivate = this.projectEntrySettingsSignature_abyssPrivate();
    for (const cb of this.listeners_abyssPrivate) cb();
  }

  private projectEntrySettingsSignature_abyssPrivate(): string {
    const projects = this.settings_abyssPrivate.projects;
    return JSON.stringify({
      membershipQuery: projects.membershipQuery,
      statusProperty: projects.statusProperty,
      statuses: projects.statuses.map(({ id, name }) => [id, name]),
    });
  }

  /** Refreshes settings without rescanning unless project membership or raw status identity changed. */
  refreshSettings(): 'rescanned' | 'presentation' {
    const signature = this.projectEntrySettingsSignature_abyssPrivate();
    if (signature !== this.settingsSignature_abyssPrivate) {
      this.recomputeAll_abyssPrivate();
      this.settingsSignature_abyssPrivate = signature;
      for (const cb of this.listeners_abyssPrivate) cb();
      return 'rescanned';
    }
    return 'presentation';
  }

  onUpdate(cb: () => void): () => void {
    this.listeners_abyssPrivate.push(cb);
    return () => {
      this.listeners_abyssPrivate = this.listeners_abyssPrivate.filter((l) => l !== cb);
    };
  }

  /** Subscribes only to verified native source observations, never task/settings refreshes. */
  onSourceObservation(cb: (observation: ProjectSourceObservation) => void): () => void {
    this.sourceListeners_abyssPrivate.push(cb);
    return () => {
      this.sourceListeners_abyssPrivate = this.sourceListeners_abyssPrivate.filter(
        (listener) => listener !== cb,
      );
    };
  }

  /** Rechecks that a previously published native observation still describes the current source. */
  async revalidateSourceObservation(observation: ProjectSourceObservation): Promise<boolean> {
    const published = this.publishedSourceObservations_abyssPrivate.get(observation.path);
    if (published?.observation !== observation) return false;
    const { pending } = published;
    if (pending.data === undefined) {
      return this.app_abyssPrivate.vault.getAbstractFileByPath(observation.path) === null;
    }
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(observation.path);
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    try {
      const currentData = await this.app_abyssPrivate.vault.read(file);
      return (
        this.publishedSourceObservations_abyssPrivate.get(observation.path) === published &&
        currentData === pending.data
      );
    } catch (error) {
      console.error('[abyss-tasks] Could not revalidate project source observation', {
        path: observation.path,
        cause: error,
      });
      return false;
    }
  }

  destroy(): void {
    if (this.debounce_abyssPrivate !== undefined) window.clearTimeout(this.debounce_abyssPrivate);
    this.queryUnsub_abyssPrivate?.();
    this.queryUnsub_abyssPrivate = undefined;
    this.reconciliationUnsub_abyssPrivate?.();
    this.reconciliationUnsub_abyssPrivate = undefined;
    for (const unsubscribe of this.eventUnsubs_abyssPrivate) unsubscribe();
    this.eventUnsubs_abyssPrivate = [];
    this.waitingPaths_abyssPrivate.clear();
    this.readyPaths_abyssPrivate.clear();
    this.pendingCreates_abyssPrivate.clear();
    this.pendingSourceObservations_abyssPrivate.clear();
    this.publishedSourceObservations_abyssPrivate.clear();
    this.listeners_abyssPrivate = [];
    this.sourceListeners_abyssPrivate = [];
  }
}
