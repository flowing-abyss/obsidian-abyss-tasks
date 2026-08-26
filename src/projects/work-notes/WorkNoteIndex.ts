import {
  getAllTags,
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
  type TAbstractFile,
} from 'obsidian';
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

function isMarkdown(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension === 'md';
}

function isDescendant(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

function renamedDescendant(path: string, oldFolder: string, newFolder: string): string {
  return `${newFolder}${path.slice(oldFolder.length)}`;
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

  constructor(
    private readonly app: App,
    private readonly presetProvider: PresetProvider,
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
    const preset = this.preset();
    const audit = this.auditPreset(preset);
    this.replaceFromAudit(audit);
    this.indexedFingerprint = audit.presetFingerprint;
    if (preset.enabled) {
      for (const file of this.app.vault.getMarkdownFiles()) this.generations.set(file.path, 1);
    }
    const metadataRef = this.app.metadataCache.on(
      'changed',
      (file: TFile, _data: string, _cache: CachedMetadata) => {
        if (file.extension === 'md') {
          this.advanceGeneration(file.path);
          this.queuePath(file.path);
        }
      },
    );
    const createRef = this.app.vault.on('create', (file) => {
      if (isMarkdown(file)) {
        this.advanceGeneration(file.path);
        this.queueFull();
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
      this.queueFull();
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
        this.queueFull();
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
      this.queueFull();
    });
    this.unsubs.push(
      () => this.app.metadataCache.offref(metadataRef),
      () => this.app.vault.offref(createRef),
      () => this.app.vault.offref(deleteRef),
      () => this.app.vault.offref(renameRef),
    );
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
      : this.pendingPaths;
    const changedPaths = [...comparedPaths]
      .filter((path) => {
        const beforeDiagnostics = oldDiagnostics.get(path);
        const afterDiagnostics = this.diagnosticsByPath.get(path);
        const relevant =
          oldSnapshots.has(path) ||
          this.byPath.has(path) ||
          this.isCandidateDiagnostics(beforeDiagnostics) ||
          this.isCandidateDiagnostics(afterDiagnostics);
        return (
          relevant &&
          JSON.stringify({ snapshot: oldSnapshots.get(path), diagnostics: beforeDiagnostics }) !==
            JSON.stringify({
              snapshot: this.byPath.get(path),
              diagnostics: afterDiagnostics,
            })
        );
      })
      .sort((left, right) => left.localeCompare(right));
    for (const path of changedPaths) {
      const beforeProject = oldProjects.get(path);
      const afterProject = this.byPath.get(path)?.projectPath;
      if (beforeProject) this.invalidatedProjectPaths.add(beforeProject);
      if (afterProject) this.invalidatedProjectPaths.add(afterProject);
    }
    const invalidatedProjectPaths = [...this.invalidatedProjectPaths];
    this.pendingPaths.clear();
    this.invalidatedProjectPaths.clear();
    this.fullRefreshPending = false;
    this.indexedFingerprint = audit.presetFingerprint;
    if (changedPaths.length > 0 || invalidatedProjectPaths.length > 0) {
      const event = { changedPaths, invalidatedProjectPaths };
      for (const listener of this.listeners) listener(event);
    }
    const settled = [...this.pendingSettledPaths]
      .map((path) => ({ path, generation: this.generations.get(path) ?? 1 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    this.pendingSettledPaths.clear();
    if (settled.length > 0) {
      const event: WorkNoteIndexSettledEvent = {
        reason: this.explicitRefreshPending ? 'refresh' : 'index',
        files: settled,
      };
      for (const listener of this.settledListeners) listener(event);
    }
    this.explicitRefreshPending = false;
  }

  private replaceFromAudit(audit: WorkNoteAuditResult): void {
    this.byPath = new Map(audit.snapshots.map((snapshot) => [snapshot.path, snapshot]));
    this.diagnosticsByPath = new Map(Object.entries(audit.diagnosticsByPath));
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
    this.pendingPaths.clear();
    this.pendingSettledPaths.clear();
    this.invalidatedProjectPaths.clear();
    this.listeners.clear();
    this.settledListeners.clear();
    this.generations.clear();
  }
}
