import { getAllTags, TFile, type App, type CachedMetadata, type TAbstractFile } from 'obsidian';
import { auditWorkNotes, computeWorkNotePresetFingerprint } from './compatibility';
import type {
  WorkNoteAuditResult,
  WorkNoteAuditSource,
  WorkNoteCompatibilityPreset,
  WorkNoteDiagnostic,
  WorkNoteIndexEvent,
  WorkNoteSnapshot,
} from './types';

type PresetProvider = WorkNoteCompatibilityPreset | (() => WorkNoteCompatibilityPreset);

function isMarkdown(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension === 'md';
}

export class WorkNoteIndex {
  private byPath = new Map<string, WorkNoteSnapshot>();
  private diagnosticsByPath = new Map<string, readonly WorkNoteDiagnostic[]>();
  private listeners = new Set<(event: WorkNoteIndexEvent) => void>();
  private unsubs: Array<() => void> = [];
  private pendingPaths = new Set<string>();
  private invalidatedProjectPaths = new Set<string>();
  private fullRefreshPending = false;
  private debounce = 0;
  private indexedFingerprint = '';

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
    const audit = auditWorkNotes(this.source(), this.preset());
    this.replaceFromAudit(audit);
    this.indexedFingerprint = audit.presetFingerprint;
    const metadataRef = this.app.metadataCache.on(
      'changed',
      (file: TFile, _data: string, _cache: CachedMetadata) => {
        if (file.extension === 'md') this.queuePath(file.path);
      },
    );
    const createRef = this.app.vault.on('create', (file) => {
      if (isMarkdown(file)) this.queueFull();
    });
    const deleteRef = this.app.vault.on('delete', (file) => {
      if (!isMarkdown(file)) return;
      const snapshot = this.byPath.get(file.path);
      this.invalidatedProjectPaths.add(snapshot?.projectPath ?? file.path);
      this.queueFull();
    });
    const renameRef = this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile) && !oldPath.endsWith('.md')) return;
      const snapshot = this.byPath.get(oldPath);
      if (snapshot) {
        this.invalidatedProjectPaths.add(snapshot.projectPath);
      } else {
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
    return Promise.resolve(auditWorkNotes(this.source(), this.preset()));
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
    const audit = auditWorkNotes(this.source(fullRefresh ? undefined : this.pendingPaths), preset);
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
    if (changedPaths.length === 0 && invalidatedProjectPaths.length === 0) return;
    const event = { changedPaths, invalidatedProjectPaths };
    for (const listener of this.listeners) listener(event);
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

  destroy(): void {
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = 0;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.pendingPaths.clear();
    this.invalidatedProjectPaths.clear();
    this.listeners.clear();
  }
}
