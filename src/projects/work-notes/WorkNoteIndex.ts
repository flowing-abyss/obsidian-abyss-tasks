import {
  getAllTags,
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
  type TAbstractFile,
} from 'obsidian';
import type { TaskIndexSettledEvent, TaskQueryApi } from '../../tasks';
import { auditWorkNotes, computeWorkNotePresetFingerprint } from './compatibility';
import type {
  WorkNoteAuditResult,
  WorkNoteAuditSource,
  WorkNoteCompatibilityPreset,
  WorkNoteDiagnostic,
  WorkNoteIndexEvent,
  WorkNoteIndexSettledEvent,
  WorkNoteSnapshot,
} from './types';

type PresetProvider = WorkNoteCompatibilityPreset | (() => WorkNoteCompatibilityPreset);
type TaskTopologySettlement = Extract<TaskIndexSettledEvent, { readonly reason: 'topology' }>;

function isMarkdown(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension === 'md';
}

function isDescendant(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

function renamedDescendant(path: string, oldFolder: string, newFolder: string): string {
  return `${newFolder}${path.slice(oldFolder.length)}`;
}

function topologyKey(oldPath: string, newPath: string): string {
  return `${oldPath}\0${newPath}`;
}

export class WorkNoteIndex {
  private byPath = new Map<string, WorkNoteSnapshot>();
  private diagnosticsByPath = new Map<string, readonly WorkNoteDiagnostic[]>();
  private listeners = new Set<(event: WorkNoteIndexEvent) => void>();
  private settledListeners = new Set<(event: WorkNoteIndexSettledEvent) => void>();
  private unsubs: Array<() => void> = [];
  private pendingPaths = new Set<string>();
  private invalidatedProjectPaths = new Set<string>();
  private fullRefreshPending = false;
  private explicitRefreshPending = false;
  private debounce = 0;
  private indexedFingerprint = '';
  private generations = new Map<string, number>();
  private pendingSettledPaths = new Set<string>();
  private waitingForTaskPaths = new Set<string>();
  private taskBarriers = new Map<string, number>();
  private pendingTaskTopologies = new Set<string>();
  private settledTaskTopologies = new Map<string, TaskTopologySettlement>();
  private topologyBarrierPaths = new Set<string>();
  private topologyRefreshPending = false;
  private taskSettlementUnsub?: () => void;
  private ready = false;

  constructor(
    private readonly app: App,
    private readonly presetProvider: PresetProvider,
    private readonly taskSettlements?: Pick<TaskQueryApi, 'subscribeSettled'>,
  ) {}

  private preset(): WorkNoteCompatibilityPreset {
    return typeof this.presetProvider === 'function' ? this.presetProvider() : this.presetProvider;
  }

  private source(paths?: ReadonlySet<string>): WorkNoteAuditSource {
    return {
      files: () =>
        this.app.vault
          .getMarkdownFiles()
          .filter((file) => paths === undefined || paths.has(file.path))
          .map((file) => {
            const cache = this.app.metadataCache.getFileCache(file);
            return {
              path: file.path,
              tags: cache ? (getAllTags(cache) ?? []) : [],
              frontmatter: cache?.frontmatter ?? {},
            };
          }),
      allPaths: () => this.app.vault.getMarkdownFiles().map(({ path }) => path),
      resolveLink: (linkpath, sourcePath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null,
      fileExists: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
    };
  }

  initialize(): void {
    if (this.ready) return;
    const preset = this.preset();
    const audit = this.auditPreset(preset);
    this.replaceFromAudit(audit);
    this.indexedFingerprint = audit.presetFingerprint;
    if (preset.enabled) {
      for (const file of this.app.vault.getMarkdownFiles()) this.generations.set(file.path, 1);
    }
    this.taskSettlementUnsub = this.taskSettlements?.subscribeSettled?.((event) =>
      this.onTaskSettled(event),
    );
    const metadataRef = this.app.metadataCache.on(
      'changed',
      (file: TFile, _data: string, _cache: CachedMetadata) => {
        if (file.extension === 'md') {
          this.advanceGeneration(file.path);
          this.queuePathAfterTask(file.path);
        }
      },
    );
    const createRef = this.app.vault.on('create', (file) => {
      if (isMarkdown(file)) {
        this.advanceGeneration(file.path);
        this.queueFullAfterTask([file.path]);
      }
    });
    const deleteRef = this.app.vault.on('delete', (file) => {
      if (!isMarkdown(file)) return;
      this.advanceGeneration(file.path);
      const snapshot = this.byPath.get(file.path);
      if (snapshot) this.invalidatedProjectPaths.add(snapshot.projectPath);
      if ([...this.byPath.values()].some(({ projectPath }) => projectPath === file.path)) {
        this.invalidatedProjectPaths.add(file.path);
      }
      this.queueFullAfterTask([file.path]);
    });
    const renameRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFolder) {
        const snapshots = [...this.byPath.values()].sort((left, right) =>
          left.path.localeCompare(right.path),
        );
        for (const snapshot of snapshots) {
          if (isDescendant(snapshot.path, oldPath)) {
            this.invalidatedProjectPaths.add(snapshot.projectPath);
            this.advanceGeneration(snapshot.path);
            this.advanceGeneration(renamedDescendant(snapshot.path, oldPath, file.path), true);
          }
          if (isDescendant(snapshot.projectPath, oldPath)) {
            this.invalidatedProjectPaths.add(snapshot.projectPath);
            this.invalidatedProjectPaths.add(
              renamedDescendant(snapshot.projectPath, oldPath, file.path),
            );
            if (!isDescendant(snapshot.path, oldPath)) this.advanceGeneration(snapshot.path);
          }
        }
        this.queueFullAfterTopology(oldPath, file.path);
        return;
      }
      if (!(file instanceof TFile) || (file.extension !== 'md' && !oldPath.endsWith('.md'))) return;
      this.advanceGeneration(oldPath);
      if (file.extension === 'md') this.advanceGeneration(file.path, true);
      const snapshot = this.byPath.get(oldPath);
      if (snapshot) this.invalidatedProjectPaths.add(snapshot.projectPath);
      if ([...this.byPath.values()].some(({ projectPath }) => projectPath === oldPath)) {
        this.invalidatedProjectPaths.add(oldPath);
        this.invalidatedProjectPaths.add(file.path);
      }
      this.queueFullAfterTask([oldPath, ...(file.extension === 'md' ? [file.path] : [])]);
    });
    this.unsubs.push(
      () => this.app.metadataCache.offref(metadataRef),
      () => this.app.vault.offref(createRef),
      () => this.app.vault.offref(deleteRef),
      () => this.app.vault.offref(renameRef),
    );
    this.ready = true;
    const event: WorkNoteIndexSettledEvent = {
      reason: 'initialization',
      files: [...this.generations]
        .map(([path, generation]) => ({ path, generation }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    for (const listener of this.settledListeners) listener(event);
  }

  isReady(): boolean {
    return this.ready;
  }

  async audit(): Promise<WorkNoteAuditResult> {
    return Promise.resolve(this.auditPreset(this.preset()));
  }

  private auditPreset(preset: WorkNoteCompatibilityPreset): WorkNoteAuditResult {
    if (preset.enabled) return auditWorkNotes(this.source(), preset);
    return {
      presetFingerprint: computeWorkNotePresetFingerprint(preset),
      eligiblePaths: [],
      snapshots: [],
      diagnosticsByPath: {},
      issues: [],
      capabilities: { update: false, create: false },
    };
  }

  private advanceGeneration(path: string, reset = false): void {
    this.generations.set(path, reset ? 1 : (this.generations.get(path) ?? 0) + 1);
    this.pendingSettledPaths.add(path);
  }

  private queuePath(path: string): void {
    if (!this.fullRefreshPending) this.pendingPaths.add(path);
    this.schedule();
  }

  private queuePathAfterTask(path: string): void {
    if (!this.taskSettlements?.subscribeSettled) {
      this.queuePath(path);
      return;
    }
    this.waitingForTaskPaths.add(path);
  }

  private queueFullAfterTask(paths: readonly string[]): void {
    this.fullRefreshPending = true;
    this.pendingPaths.clear();
    if (!this.taskSettlements?.subscribeSettled) {
      this.schedule();
      return;
    }
    for (const path of paths) this.waitingForTaskPaths.add(path);
    if (this.waitingForTaskPaths.size === 0) this.schedule();
  }

  private queueFullAfterTopology(oldPath: string, newPath: string): void {
    this.fullRefreshPending = true;
    this.topologyRefreshPending = true;
    this.pendingPaths.clear();
    if (!this.taskSettlements?.subscribeSettled) {
      this.schedule();
      return;
    }
    const key = topologyKey(oldPath, newPath);
    const settled = this.settledTaskTopologies.get(key);
    if (settled) {
      this.settledTaskTopologies.delete(key);
      this.acceptTaskTopology(settled);
      return;
    }
    this.pendingTaskTopologies.add(key);
  }

  private onTaskSettled(event: TaskIndexSettledEvent): void {
    for (const { path, generation } of event.files) {
      if (!this.waitingForTaskPaths.delete(path)) continue;
      this.taskBarriers.set(path, generation);
      if (!this.fullRefreshPending) this.pendingPaths.add(path);
    }
    if (event.reason === 'topology') {
      const key = topologyKey(event.topology.oldPath, event.topology.newPath);
      if (this.pendingTaskTopologies.delete(key)) this.acceptTaskTopology(event);
      else this.settledTaskTopologies.set(key, event);
    }
    if (
      this.waitingForTaskPaths.size === 0 &&
      this.pendingTaskTopologies.size === 0 &&
      (this.fullRefreshPending || this.pendingPaths.size > 0)
    ) {
      this.schedule();
    }
  }

  private acceptTaskTopology(event: TaskTopologySettlement): void {
    for (const { path, generation } of event.files) {
      this.taskBarriers.set(path, generation);
      this.topologyBarrierPaths.add(path);
    }
    if (this.waitingForTaskPaths.size === 0 && this.pendingTaskTopologies.size === 0)
      this.schedule();
  }

  private queueFull(): void {
    this.fullRefreshPending = true;
    this.pendingPaths.clear();
    this.schedule();
  }

  private schedule(): void {
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.debounce = 0;
    const oldSnapshots = new Map(this.byPath);
    const oldDiagnostics = new Map(this.diagnosticsByPath);
    const oldProjects = new Map(
      [...this.byPath].map(([path, snapshot]) => [path, snapshot.projectPath]),
    );
    const preset = this.preset();
    const presetChanged = computeWorkNotePresetFingerprint(preset) !== this.indexedFingerprint;
    const fullRefresh = this.fullRefreshPending || presetChanged;
    const auditPaths = fullRefresh ? undefined : this.pendingPaths;
    const audit = preset.enabled
      ? auditWorkNotes(this.source(auditPaths), preset)
      : this.auditPreset(preset);
    const auditByPath = new Map(audit.snapshots.map((snapshot) => [snapshot.path, snapshot]));
    if (fullRefresh) {
      this.replaceFromAudit(audit);
    } else {
      for (const path of this.pendingPaths) {
        const next = auditByPath.get(path);
        if (next) this.byPath.set(path, next);
        else this.byPath.delete(path);
        const diagnostics = audit.diagnosticsByPath[path];
        if (diagnostics) this.diagnosticsByPath.set(path, diagnostics);
        else this.diagnosticsByPath.delete(path);
      }
    }
    const comparedPaths = fullRefresh
      ? new Set([
          ...oldSnapshots.keys(),
          ...this.byPath.keys(),
          ...oldDiagnostics.keys(),
          ...this.diagnosticsByPath.keys(),
        ])
      : new Set(this.pendingPaths);
    const changedPaths = this.changedPaths(comparedPaths, oldSnapshots, oldDiagnostics);
    if (this.topologyRefreshPending) {
      this.deriveTopologySettlements(changedPaths, comparedPaths);
    }
    this.invalidateChangedProjects(changedPaths, oldProjects);
    const invalidatedProjectPaths = [...this.invalidatedProjectPaths];
    this.pendingPaths.clear();
    this.invalidatedProjectPaths.clear();
    this.fullRefreshPending = false;
    this.indexedFingerprint = audit.presetFingerprint;
    const cause = this.explicitRefreshPending ? 'refresh' : 'index';
    if (changedPaths.length > 0 || invalidatedProjectPaths.length > 0) {
      const event: WorkNoteIndexEvent = {
        cause,
        changedPaths,
        invalidatedProjectPaths,
        taskBarriers:
          cause === 'index'
            ? [...this.taskBarriers]
                .filter(([path]) => comparedPaths.has(path))
                .map(([path, generation]) => ({ path, generation }))
                .sort((left, right) => left.path.localeCompare(right.path))
            : [],
      };
      for (const listener of this.listeners) listener(event);
    }
    const settled = [...this.pendingSettledPaths]
      .map((path) => ({ path, generation: this.generations.get(path) ?? 1 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    this.pendingSettledPaths.clear();
    for (const { path } of settled) this.taskBarriers.delete(path);
    if (settled.length > 0) {
      const event: WorkNoteIndexSettledEvent = {
        reason: this.explicitRefreshPending ? 'refresh' : 'index',
        files: settled,
      };
      for (const listener of this.settledListeners) listener(event);
    }
    for (const path of this.topologyBarrierPaths) this.taskBarriers.delete(path);
    this.topologyBarrierPaths.clear();
    this.topologyRefreshPending = false;
    this.explicitRefreshPending = false;
  }

  private deriveTopologySettlements(
    changedPaths: readonly string[],
    comparedPaths: ReadonlySet<string>,
  ): void {
    const finalPaths = new Set([
      ...changedPaths,
      ...[...this.pendingSettledPaths].filter((path) => comparedPaths.has(path)),
      ...[...this.topologyBarrierPaths].filter((path) => comparedPaths.has(path)),
    ]);
    for (const path of [...this.pendingSettledPaths]) {
      if (!finalPaths.has(path)) this.pendingSettledPaths.delete(path);
    }
    for (const path of changedPaths) {
      if (this.pendingSettledPaths.has(path)) continue;
      this.generations.set(path, (this.generations.get(path) ?? 0) + 1);
      this.pendingSettledPaths.add(path);
    }
  }

  private replaceFromAudit(audit: WorkNoteAuditResult): void {
    this.byPath = new Map(audit.snapshots.map((snapshot) => [snapshot.path, snapshot]));
    this.diagnosticsByPath = new Map(Object.entries(audit.diagnosticsByPath));
  }

  private changedPaths(
    comparedPaths: ReadonlySet<string>,
    oldSnapshots: ReadonlyMap<string, WorkNoteSnapshot>,
    oldDiagnostics: ReadonlyMap<string, readonly WorkNoteDiagnostic[]>,
  ): string[] {
    return [...comparedPaths]
      .filter((path) => {
        const beforeDiagnostics = oldDiagnostics.get(path);
        const afterDiagnostics = this.diagnosticsByPath.get(path);
        const relevant =
          oldSnapshots.has(path) ||
          this.byPath.has(path) ||
          this.isCandidateDiagnostics(beforeDiagnostics) ||
          this.isCandidateDiagnostics(afterDiagnostics);
        if (!relevant) return false;
        return (
          JSON.stringify({ snapshot: oldSnapshots.get(path), diagnostics: beforeDiagnostics }) !==
          JSON.stringify({ snapshot: this.byPath.get(path), diagnostics: afterDiagnostics })
        );
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private invalidateChangedProjects(
    changedPaths: readonly string[],
    oldProjects: ReadonlyMap<string, string | undefined>,
  ): void {
    for (const path of changedPaths) {
      const beforeProject = oldProjects.get(path);
      const afterProject = this.byPath.get(path)?.projectPath;
      if (beforeProject) this.invalidatedProjectPaths.add(beforeProject);
      if (afterProject) this.invalidatedProjectPaths.add(afterProject);
    }
  }

  private isCandidateDiagnostics(diagnostics: readonly WorkNoteDiagnostic[] | undefined): boolean {
    return (
      diagnostics !== undefined &&
      diagnostics.every(({ type }) => type !== 'membership-mismatch' && type !== 'outside-folder')
    );
  }

  refresh(): void {
    this.explicitRefreshPending = true;
    if (this.preset().enabled) {
      for (const file of this.app.vault.getMarkdownFiles()) this.advanceGeneration(file.path);
    } else {
      for (const path of new Set([...this.byPath.keys(), ...this.diagnosticsByPath.keys()])) {
        this.advanceGeneration(path);
      }
    }
    this.queueFull();
  }

  list(): readonly WorkNoteSnapshot[] {
    return [...this.byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  get(path: string): WorkNoteSnapshot | undefined {
    return this.byPath.get(path);
  }

  diagnosticsFor(path: string): readonly WorkNoteDiagnostic[] {
    return this.diagnosticsByPath.get(path) ?? [];
  }

  onUpdate(listener: (event: WorkNoteIndexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSettled(listener: (event: WorkNoteIndexSettledEvent) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  destroy(): void {
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = 0;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.taskSettlementUnsub?.();
    this.taskSettlementUnsub = undefined;
    this.pendingPaths.clear();
    this.pendingSettledPaths.clear();
    this.invalidatedProjectPaths.clear();
    this.waitingForTaskPaths.clear();
    this.taskBarriers.clear();
    this.pendingTaskTopologies.clear();
    this.settledTaskTopologies.clear();
    this.topologyBarrierPaths.clear();
    this.topologyRefreshPending = false;
    this.listeners.clear();
    this.settledListeners.clear();
    this.generations.clear();
    this.ready = false;
  }
}
