import { getAllTags, TFile, type App, type CachedMetadata, type TAbstractFile } from 'obsidian';
import { evaluateQuery } from '../query/evaluateQuery';
import type { CalendarSettings } from '../settings/types';
import type { TaskIndexEvent, TaskQueryApi, TaskSnapshot } from '../tasks';
import { resolveStatus } from './status';
import type { Project, ProjectStats } from './types';

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
  private cache: Project[] = [];
  private byPath = new Map<string, Project>();
  private listeners: Array<() => void> = [];
  private eventUnsubs: Array<() => void> = [];
  private queryUnsub: (() => void) | undefined;
  private reconciliationUnsub: (() => void) | undefined;
  private debounce: number | undefined;
  private readonly waitingPaths = new Set<string>();
  private readonly readyPaths = new Set<string>();
  private readyFull = false;
  private readonly pendingCreates = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly queries: TaskQueryApi,
    private readonly settings: CalendarSettings,
  ) {}

  initialize(): void {
    this.recomputeAll();
    // A single note edit re-evaluates only that note (O(1) note + its tasks).
    // Create/delete/rename change the membership set → full rescan (rare events).
    const metadataRef = this.app.metadataCache.on('changed', (file, data, cache) => {
      if (file.extension === 'md' && this.app.vault.getAbstractFileByPath(file.path) === file) {
        if (this.pendingCreates.has(file.path)) {
          if (!metadataMayContainTasks(data, cache) && !this.hasIndexedTasks(file.path)) {
            this.pendingCreates.delete(file.path);
            this.releasePath(file.path);
            return;
          }
        }
        this.awaitBarrier(file.path);
      }
    });
    this.eventUnsubs.push(() => {
      this.app.metadataCache.offref(metadataRef);
    });
    const createRef = this.app.vault.on('create', (file) => {
      if (isMarkdownFile(file)) this.pendingCreates.add(file.path);
    });
    const deleteRef = this.app.vault.on('delete', (file) => {
      if (!isMarkdownFile(file)) return;
      this.pendingCreates.delete(file.path);
      const project = this.byPath.get(file.path);
      if (project?.stats.total === 0 && !this.hasIndexedTasks(file.path)) {
        this.releasePath(file.path);
      } else {
        this.awaitBarrier(file.path);
      }
    });
    const renameRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && (file.extension === 'md' || wasMarkdown(oldPath))) {
        this.pendingCreates.delete(oldPath);
        const project = this.byPath.get(oldPath);
        if (
          (project === undefined || project.stats.total === 0) &&
          !this.hasIndexedTasks(oldPath, file.path)
        ) {
          this.releasePath(oldPath, file.path);
        } else {
          this.awaitBarrier(oldPath, file.path);
        }
      }
    });
    this.eventUnsubs.push(
      () => {
        this.app.vault.offref(createRef);
      },
      () => {
        this.app.vault.offref(deleteRef);
      },
      () => {
        this.app.vault.offref(renameRef);
      },
    );
    this.queryUnsub = this.queries.subscribe((event) => {
      this.onTaskIndexEvent(event);
    });
    this.reconciliationUnsub = this.queries.subscribeReconciled((files) => {
      this.releaseChangedPaths(files);
    });
  }

  private onTaskIndexEvent(event: TaskIndexEvent): void {
    if (event.type === 'changed') {
      this.releaseChangedPaths(event.files);
    } else if (event.type === 'initialized') {
      this.releaseFull();
    } else if (event.type === 'renamed') {
      this.pendingCreates.delete(event.oldPath);
      this.pendingCreates.delete(event.newPath);
      this.releasePath(event.oldPath, event.newPath);
    } else {
      this.pendingCreates.delete(event.path);
      this.releasePath(event.path);
    }
  }

  private releaseChangedPaths(files: readonly string[]): void {
    for (const path of files) {
      this.pendingCreates.delete(path);
      this.releasePath(path);
    }
  }

  private awaitBarrier(...paths: string[]): void {
    if (this.readyFull) return;
    for (const path of paths) {
      if (!this.readyPaths.has(path)) this.waitingPaths.add(path);
    }
  }

  private releasePath(...paths: string[]): void {
    for (const path of paths) {
      this.waitingPaths.delete(path);
      this.readyPaths.add(path);
    }
    this.scheduleFlush();
  }

  private releaseFull(): void {
    this.waitingPaths.clear();
    this.readyFull = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounce !== undefined) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      this.flush();
    }, 150);
  }

  private flush(): void {
    const before = this.cacheSignature();
    if (this.readyFull) {
      this.recomputeAll();
      this.readyPaths.clear();
    } else if (this.readyPaths.size > 0) {
      for (const path of this.readyPaths) this.updateOne(path);
      this.rebuildCache();
    }
    this.readyFull = false;
    this.readyPaths.clear();
    this.notifyIfChanged(before);
  }

  private hasIndexedTasks(...paths: string[]): boolean {
    return paths.some((path) => this.queries.list({ filePath: path }).length > 0);
  }

  private cacheSignature(): string {
    return JSON.stringify(this.cache);
  }

  private notifyIfChanged(before: string): void {
    if (this.cacheSignature() === before) return;
    for (const cb of this.listeners) cb();
  }

  /** Full O(N + T) rescan of every markdown file. Used on init, create/delete/rename, refresh(). */
  private recomputeAll(): void {
    const tasksByPath = this.groupTasksByPath();
    this.byPath = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const entry = this.makeEntry(file.path, cache, tasksByPath.get(file.path) ?? []);
      if (entry != null) this.byPath.set(file.path, entry);
    }
    this.rebuildCache();
  }

  /** Re-evaluate a single note in place — O(1 note + T for its task filter). */
  private updateOne(path: string): void {
    // Only markdown files are projects; folders/non-md drop out.
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') {
      this.byPath.delete(path);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const tasks = this.queries.list({ filePath: path });
    const entry = this.makeEntry(path, cache, tasks);
    if (entry != null) this.byPath.set(path, entry);
    else this.byPath.delete(path);
  }

  private makeEntry(
    path: string,
    cache: CachedMetadata | null,
    tasks: readonly TaskSnapshot[],
  ): Project | null {
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const tags = (cache != null ? (getAllTags(cache) ?? []) : []).map((tag) => tag.toLowerCase());
    if (!evaluateQuery(this.settings.projects.membershipQuery, path, tags, fm)) return null;
    const { statusId, rawStatus } = resolveStatus(this.settings.projects, fm);
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

  private groupTasksByPath(): Map<string, TaskSnapshot[]> {
    const map = new Map<string, TaskSnapshot[]>();
    for (const t of this.queries.list()) {
      const arr = map.get(t.source.filePath) ?? [];
      arr.push(t);
      map.set(t.source.filePath, arr);
    }
    return map;
  }

  private rebuildCache(): void {
    this.cache = Array.from(this.byPath.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  list(): Project[] {
    return this.cache;
  }

  get(path: string): Project | undefined {
    return this.byPath.get(path);
  }

  activeForLeftPanel(): Project[] {
    const onPanel = new Set(
      this.settings.projects.statuses.filter((s) => s.onLeftPanel).map((s) => s.id),
    );
    return this.cache.filter((p) => p.statusId !== null && onPanel.has(p.statusId));
  }

  refresh(): void {
    this.recomputeAll();
    for (const cb of this.listeners) cb();
  }

  onUpdate(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  destroy(): void {
    if (this.debounce !== undefined) window.clearTimeout(this.debounce);
    this.queryUnsub?.();
    this.queryUnsub = undefined;
    this.reconciliationUnsub?.();
    this.reconciliationUnsub = undefined;
    for (const unsubscribe of this.eventUnsubs) unsubscribe();
    this.eventUnsubs = [];
    this.waitingPaths.clear();
    this.readyPaths.clear();
    this.pendingCreates.clear();
    this.listeners = [];
  }
}
