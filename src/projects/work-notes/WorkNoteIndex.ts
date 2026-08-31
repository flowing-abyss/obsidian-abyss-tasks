import {
  getAllTags,
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
  type TAbstractFile,
} from 'obsidian';
import type { ProjectStatus } from '../../settings/types';
import type { TaskIndexSettledEvent, TaskQueryApi } from '../../tasks';
import {
  acceptWorkNoteAudit,
  auditWorkNotes,
  compileWorkNoteQueries,
  computeWorkNotePresetFingerprint,
  computeWorkNoteStructuralFingerprint,
  invalidWorkNoteQueryAudit,
  isAuditAccepted,
  suggestWorkNotePreset,
} from './compatibility';
import type {
  WorkNoteAuditResult,
  WorkNoteAuditSource,
  WorkNoteCompatibilityDisableResult,
  WorkNoteCompatibilityPreset,
  WorkNoteCompatibilityPreview,
  WorkNoteCompatibilityToken,
  WorkNoteCompatibilityValidationResult,
  WorkNoteDiagnostic,
  WorkNoteIndexEvent,
  WorkNoteIndexSettledEvent,
  WorkNoteQueryDiagnostic,
  WorkNoteSnapshot,
  WorkNoteValidatedApplyResult,
} from './types';

type PresetProvider = WorkNoteCompatibilityPreset | (() => WorkNoteCompatibilityPreset);
type ProjectStatusProvider = () => readonly ProjectStatus[];
type TaskTopologySettlement = Extract<TaskIndexSettledEvent, { readonly reason: 'topology' }>;

export interface WorkNoteCompatibilityTransactionOptions {
  readonly persist: (preset: WorkNoteCompatibilityPreset) => Promise<void>;
  readonly settingsSignature?: () => unknown;
  readonly acceptedAt?: () => string;
}

interface CapturedCompatibilityAudit {
  readonly audit: WorkNoteAuditResult;
  readonly preview: WorkNoteCompatibilityPreview;
  readonly auditInputsSignature: string;
}

interface PendingCompatibilityValidation {
  readonly candidateReference: WorkNoteCompatibilityPreset;
  readonly candidate: WorkNoteCompatibilityPreset;
  readonly candidateSignature: string;
  readonly settingsSignature: string;
  readonly auditInputsSignature: string;
  readonly epoch: number;
}

interface AuditAttempt {
  readonly audit: WorkNoteAuditResult;
  readonly queryDiagnostics: readonly WorkNoteQueryDiagnostic[];
}

function clonePreset(preset: WorkNoteCompatibilityPreset): WorkNoteCompatibilityPreset {
  return structuredClone(preset);
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) immutable(entry);
    Object.freeze(value);
  }
  return value;
}

function configurationFingerprint(preset: WorkNoteCompatibilityPreset): string {
  const candidate = preset as WorkNoteCompatibilityPreset & Record<string, unknown>;
  const configuration = Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) => key !== 'revision' && key !== 'acceptedAudit' && key !== 'rawStatusByStatusId',
    ),
  );
  return computeWorkNoteStructuralFingerprint({
    configuration,
    statusMappingEntries: Object.entries(preset.rawStatusByStatusId),
  });
}

function mappingRelevantStatuses(projectStatuses: readonly ProjectStatus[]): unknown {
  return projectStatuses.map(({ id, label, behavior, match }) => ({ id, label, behavior, match }));
}

function intersectCapabilities(
  live: WorkNoteAuditResult['capabilities'],
  accepted: WorkNoteAuditResult['capabilities'] | undefined,
): WorkNoteAuditResult['capabilities'] {
  return {
    update: live.update && accepted?.update === true,
    create: live.create && accepted?.create === true,
  };
}

function aggregateCompatibilityPreview(
  audit: WorkNoteAuditResult,
  scanned: number,
  excluded: number,
  preset: WorkNoteCompatibilityPreview['preset'] = { enabled: false, accepted: false },
  capabilities: WorkNoteCompatibilityPreview['capabilities'] = {
    update: false,
    create: false,
  },
): WorkNoteCompatibilityPreview {
  const diagnostics: Partial<Record<WorkNoteDiagnostic['type'], number>> = {};
  const increment = (type: WorkNoteDiagnostic['type']): void => {
    diagnostics[type] = (diagnostics[type] ?? 0) + 1;
  };
  for (const entries of Object.values(audit.diagnosticsByPath)) {
    const candidate = entries.every(
      ({ type }) => type !== 'outside-folder' && type !== 'membership-mismatch',
    );
    if (!candidate) continue;
    for (const diagnostic of entries) increment(diagnostic.type);
  }
  for (const issue of audit.issues) increment(issue.type);
  const count = (type: WorkNoteDiagnostic['type']): number => diagnostics[type] ?? 0;
  const nonScalarStatusPaths = new Set(
    audit.snapshots
      .filter((snapshot) =>
        snapshot.diagnostics.some((diagnostic) => diagnostic.type === 'non-scalar-status'),
      )
      .map(({ path }) => path),
  );
  return {
    preset,
    notes: { scanned, eligible: audit.snapshots.length, excluded },
    kinds: {
      ordinary: audit.snapshots.filter(({ kind }) => kind === 'ordinary').length,
      milestone: audit.snapshots.filter(({ kind }) => kind === 'milestone').length,
      ambiguous: count('ambiguous-kind'),
      missing: count('missing-kind'),
    },
    statuses: {
      mapped: audit.snapshots.filter(({ statusId }) => statusId !== null).length,
      unknown: count('unknown-status'),
      missing: audit.snapshots.filter(
        ({ path, rawStatus }) => rawStatus === null && !nonScalarStatusPaths.has(path),
      ).length,
      nonScalar: count('non-scalar-status'),
    },
    links: {
      brokenProject: count('broken-project'),
      ambiguousProject: count('ambiguous-project'),
      brokenRelation: count('broken-relation'),
      ambiguousRelation: count('ambiguous-relation'),
      invalidProjectEntry: count('invalid-project-entry'),
      invalidRelationEntry: count('invalid-relation-entry'),
    },
    cardinality: {
      missingProject: count('missing-project'),
      multipleProjects: count('multiple-projects'),
      multipleMilestones: count('multiple-milestones'),
    },
    duplicateBasenames: {
      project: count('ambiguous-project'),
      relation: count('ambiguous-relation'),
    },
    diagnostics,
    capabilities,
  };
}

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
  private flushInFlight?: Promise<void>;
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
  private compatibilityEpoch = 0;
  private compatibilityMutationQueue: Promise<void> = Promise.resolve();
  private readonly pendingCompatibilityValidations = new WeakMap<
    WorkNoteCompatibilityToken,
    PendingCompatibilityValidation
  >();
  private queryDiagnosticEntries: readonly WorkNoteQueryDiagnostic[] = [];

  constructor(
    private readonly app: App,
    private readonly presetProvider: PresetProvider,
    private readonly taskSettlements?: Pick<TaskQueryApi, 'subscribeSettled'>,
    private readonly projectStatusProvider: ProjectStatusProvider = () => [],
    private readonly compatibilityTransaction?: WorkNoteCompatibilityTransactionOptions,
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
            const stat = (file as TFile & { readonly stat?: { mtime: number; size: number } }).stat;
            return {
              path: file.path,
              tags: cache ? (getAllTags(cache) ?? []) : [],
              frontmatter: cache?.frontmatter ?? {},
              ...(stat && { revision: { mtime: stat.mtime, size: stat.size } }),
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
    const attempt = this.auditPreset(preset);
    if (attempt.queryDiagnostics.length === 0) {
      this.replaceFromAudit(attempt.audit);
      this.indexedFingerprint = attempt.audit.presetFingerprint;
    }
    this.queryDiagnosticEntries = attempt.queryDiagnostics;
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
    return Promise.resolve(this.auditPreset(this.preset()).audit);
  }

  async validateCompatibility(
    candidate: WorkNoteCompatibilityPreset,
  ): Promise<WorkNoteCompatibilityValidationResult> {
    if (!candidate.enabled) {
      return Promise.resolve({
        type: 'invalid-draft',
        reason: 'candidate-disabled',
        diagnostics: [],
      });
    }
    const compilation = compileWorkNoteQueries(candidate);
    if (compilation.state === 'invalid') {
      return Promise.resolve({
        type: 'invalid-draft',
        reason: 'syntax-invalid',
        diagnostics: compilation.diagnostics,
      });
    }
    const snapshot = clonePreset(candidate);
    const captured = this.captureCompatibilityAudit(snapshot, compilation.queries);
    const token = immutable({}) as WorkNoteCompatibilityToken;
    this.pendingCompatibilityValidations.set(token, {
      candidateReference: candidate,
      candidate: snapshot,
      candidateSignature: computeWorkNoteStructuralFingerprint(snapshot, {
        preserveObjectOrder: true,
      }),
      settingsSignature: this.compatibilitySettingsSignature(),
      auditInputsSignature: captured.auditInputsSignature,
      epoch: this.compatibilityEpoch,
    });
    return Promise.resolve({
      type: 'audited',
      token,
      presetFingerprint: captured.audit.presetFingerprint,
      preview: captured.preview,
    });
  }

  acceptValidatedCompatibility(
    token: WorkNoteCompatibilityToken,
  ): Promise<WorkNoteValidatedApplyResult> {
    return this.enqueueCompatibilityMutation(() => this.applyValidatedCompatibility(token));
  }

  private async applyValidatedCompatibility(
    token: WorkNoteCompatibilityToken,
  ): Promise<WorkNoteValidatedApplyResult> {
    const pending = this.pendingCompatibilityValidations.get(token);
    this.pendingCompatibilityValidations.delete(token);
    if (!pending) {
      return { type: 'revalidation-required', reason: 'invalid-token' };
    }
    if (pending.epoch !== this.compatibilityEpoch) {
      return { type: 'revalidation-required', reason: 'settings-changed' };
    }
    if (
      computeWorkNoteStructuralFingerprint(pending.candidateReference, {
        preserveObjectOrder: true,
      }) !== pending.candidateSignature
    ) {
      return { type: 'revalidation-required', reason: 'candidate-changed' };
    }
    if (this.compatibilitySettingsSignature() !== pending.settingsSignature) {
      return { type: 'revalidation-required', reason: 'settings-changed' };
    }
    const compilation = compileWorkNoteQueries(pending.candidate);
    if (compilation.state === 'invalid') {
      return { type: 'revalidation-required', reason: 'candidate-changed' };
    }
    const captured = this.captureCompatibilityAudit(pending.candidate, compilation.queries);
    if (captured.auditInputsSignature !== pending.auditInputsSignature) {
      return { type: 'revalidation-required', reason: 'audit-inputs-changed' };
    }
    const current = this.preset();
    if (
      configurationFingerprint(current) === configurationFingerprint(pending.candidate) &&
      isAuditAccepted(current)
    ) {
      return {
        type: 'unchanged',
        preset: clonePreset(current),
        preview: aggregateCompatibilityPreview(
          captured.audit,
          captured.preview.notes.scanned,
          captured.preview.notes.excluded,
          { enabled: true, accepted: true },
          intersectCapabilities(captured.audit.capabilities, current.acceptedAudit?.capabilities),
        ),
      };
    }
    const persist = this.compatibilityTransaction?.persist;
    if (!persist) {
      return { type: 'revalidation-required', reason: 'persistence-unavailable' };
    }
    const nextBase: WorkNoteCompatibilityPreset = {
      ...clonePreset(pending.candidate),
      revision: current.revision + 1,
      enabled: true,
      acceptedAudit: undefined,
    };
    const nextAudit = this.captureCompatibilityAudit(nextBase);
    const next = acceptWorkNoteAudit(
      nextBase,
      nextAudit.audit.capabilities,
      this.compatibilityTransaction?.acceptedAt?.() ?? new Date().toISOString(),
    );
    try {
      await persist(immutable(clonePreset(next)));
    } catch {
      return { type: 'revalidation-required', reason: 'save-failed' };
    }
    this.compatibilityEpoch += 1;
    this.publishCompatibilityAudit(nextAudit.audit);
    return {
      type: 'applied',
      preset: clonePreset(next),
      preview: aggregateCompatibilityPreview(
        nextAudit.audit,
        nextAudit.preview.notes.scanned,
        nextAudit.preview.notes.excluded,
        { enabled: true, accepted: true },
        nextAudit.audit.capabilities,
      ),
    };
  }

  disableCompatibility(): Promise<WorkNoteCompatibilityDisableResult> {
    return this.enqueueCompatibilityMutation(() => this.persistDisabledCompatibility());
  }

  private async persistDisabledCompatibility(): Promise<WorkNoteCompatibilityDisableResult> {
    const current = this.preset();
    if (!current.enabled) return { type: 'unchanged', preset: clonePreset(current) };
    const persist = this.compatibilityTransaction?.persist;
    if (!persist) return { type: 'persistence-unavailable' };
    const next: WorkNoteCompatibilityPreset = {
      ...clonePreset(current),
      revision: current.revision + 1,
      enabled: false,
    };
    try {
      await persist(immutable(clonePreset(next)));
    } catch {
      return { type: 'save-failed' };
    }
    this.compatibilityEpoch += 1;
    this.publishCompatibilityAudit(this.auditPreset(next).audit);
    return { type: 'disabled', preset: clonePreset(next) };
  }

  private enqueueCompatibilityMutation<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.compatibilityMutationQueue.then(operation, operation);
    this.compatibilityMutationQueue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private compatibilitySettingsSignature(): string {
    return computeWorkNoteStructuralFingerprint(
      {
        preset: this.preset(),
        relevant: this.compatibilityTransaction?.settingsSignature?.() ?? null,
      },
      { preserveObjectOrder: true },
    );
  }

  private captureCompatibilityAudit(
    candidate: WorkNoteCompatibilityPreset,
    compiled?: Parameters<typeof auditWorkNotes>[2],
  ): CapturedCompatibilityAudit {
    const liveSource = this.source();
    const files = structuredClone(liveSource.files());
    const allPaths = structuredClone(liveSource.allPaths?.() ?? files.map(({ path }) => path));
    const capturedSource: WorkNoteAuditSource = {
      files: () => files,
      allPaths: () => allPaths,
      resolveLink: liveSource.resolveLink,
      fileExists: liveSource.fileExists,
    };
    const projectStatuses = this.projectStatusProvider();
    const audit = auditWorkNotes(capturedSource, candidate, compiled);
    const scanned = files.length;
    const excluded = Math.max(0, scanned - audit.snapshots.length);
    return {
      audit,
      preview: aggregateCompatibilityPreview(
        audit,
        scanned,
        excluded,
        { enabled: candidate.enabled, accepted: false },
        audit.capabilities,
      ),
      auditInputsSignature: computeWorkNoteStructuralFingerprint({
        candidate,
        files,
        allPaths,
        audit,
        projectStatuses: mappingRelevantStatuses(projectStatuses),
      }),
    };
  }

  private publishCompatibilityAudit(audit: WorkNoteAuditResult): void {
    const oldSnapshots = new Map(this.byPath);
    const oldDiagnostics = new Map(this.diagnosticsByPath);
    const oldProjects = new Map(
      [...this.byPath].map(([path, snapshot]) => [path, snapshot.projectPath]),
    );
    this.replaceFromAudit(audit);
    this.queryDiagnosticEntries = [];
    this.indexedFingerprint = audit.presetFingerprint;
    const comparedPaths = new Set([
      ...oldSnapshots.keys(),
      ...this.byPath.keys(),
      ...oldDiagnostics.keys(),
      ...this.diagnosticsByPath.keys(),
    ]);
    const changedPaths = this.changedPaths(comparedPaths, oldSnapshots, oldDiagnostics);
    const invalidatedProjectPaths = new Set<string>();
    for (const path of changedPaths) {
      const beforeProject = oldProjects.get(path);
      const afterProject = this.byPath.get(path)?.projectPath;
      if (beforeProject) invalidatedProjectPaths.add(beforeProject);
      if (afterProject) invalidatedProjectPaths.add(afterProject);
    }
    if (changedPaths.length === 0 && invalidatedProjectPaths.size === 0) return;
    const event: WorkNoteIndexEvent = {
      cause: 'refresh',
      changedPaths,
      invalidatedProjectPaths: [...invalidatedProjectPaths],
      taskBarriers: [],
    };
    for (const listener of this.listeners) listener(event);
    const alreadyPending = new Set(this.pendingSettledPaths);
    const files = changedPaths.map((path) => {
      const generation = (this.generations.get(path) ?? 0) + 1;
      this.generations.set(path, generation);
      return { path, generation };
    });
    const settled: WorkNoteIndexSettledEvent = { reason: 'refresh', files };
    for (const listener of this.settledListeners) listener(settled);
    for (const { path, generation } of files) {
      if (alreadyPending.has(path)) this.generations.set(path, generation + 1);
    }
  }

  async previewCompatibility(): Promise<WorkNoteCompatibilityPreview> {
    const source = this.source();
    const configured = this.preset();
    if (configured.enabled) {
      const audit = auditWorkNotes(source, configured);
      const accepted = isAuditAccepted(configured);
      const acceptedCapabilities = configured.acceptedAudit?.capabilities;
      return Promise.resolve(
        aggregateCompatibilityPreview(
          audit,
          source.files().length,
          Math.max(0, source.files().length - audit.snapshots.length),
          { enabled: true, accepted },
          accepted
            ? intersectCapabilities(audit.capabilities, acceptedCapabilities)
            : { update: false, create: false },
        ),
      );
    }
    const projectStatuses = this.projectStatusProvider();
    const suggestion = suggestWorkNotePreset(source, projectStatuses);
    const audit = auditWorkNotes(source, suggestion.preset);
    return Promise.resolve({
      ...aggregateCompatibilityPreview(
        audit,
        suggestion.observations.fileCount,
        suggestion.preview.rejectedCandidateCount,
      ),
    });
  }

  private auditPreset(preset: WorkNoteCompatibilityPreset): AuditAttempt {
    if (preset.enabled) {
      const compilation = compileWorkNoteQueries(preset);
      if (compilation.state === 'valid') {
        return {
          audit: auditWorkNotes(this.source(), preset, compilation.queries),
          queryDiagnostics: [],
        };
      }
      return {
        audit: invalidWorkNoteQueryAudit(preset, compilation.diagnostics),
        queryDiagnostics: compilation.diagnostics,
      };
    }
    return {
      queryDiagnostics: [],
      audit: {
        presetFingerprint: computeWorkNotePresetFingerprint(preset),
        eligiblePaths: [],
        snapshots: [],
        diagnosticsByPath: {},
        issues: [],
        capabilities: { update: false, create: false },
      },
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

  private auditForFlush(
    preset: WorkNoteCompatibilityPreset,
    paths: ReadonlySet<string> | undefined,
  ): AuditAttempt {
    if (!preset.enabled) return this.auditPreset(preset);
    const compilation = compileWorkNoteQueries(preset);
    if (compilation.state === 'valid') {
      return {
        audit: auditWorkNotes(this.source(paths), preset, compilation.queries),
        queryDiagnostics: [],
      };
    }
    return {
      audit: invalidWorkNoteQueryAudit(preset, compilation.diagnostics),
      queryDiagnostics: compilation.diagnostics,
    };
  }

  private preserveIndexForInvalidAttempt(attempt: AuditAttempt): boolean {
    if (attempt.queryDiagnostics.length === 0) return false;
    const diagnosticsChanged =
      JSON.stringify(this.queryDiagnosticEntries) !== JSON.stringify(attempt.queryDiagnostics);
    this.queryDiagnosticEntries = attempt.queryDiagnostics;
    this.pendingPaths.clear();
    this.invalidatedProjectPaths.clear();
    this.fullRefreshPending = false;
    this.topologyRefreshPending = false;
    this.explicitRefreshPending = false;
    if (diagnosticsChanged) {
      const event: WorkNoteIndexEvent = {
        cause: 'index',
        changedPaths: [],
        invalidatedProjectPaths: [],
        taskBarriers: [],
        queryDiagnostics: this.queryDiagnosticEntries,
      };
      for (const listener of this.listeners) listener(event);
    }
    return true;
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
    const attempt = this.auditForFlush(preset, auditPaths);
    const audit = attempt.audit;
    if (this.preserveIndexForInvalidAttempt(attempt)) return;
    this.queryDiagnosticEntries = [];
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

  /** Forces an already queued index flush to settle before an authoritative read. */
  async flushPending(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    if (!this.debounce) return;
    window.clearTimeout(this.debounce);
    this.debounce = 0;
    const flush = Promise.resolve().then(() => this.flush());
    this.flushInFlight = flush;
    try {
      await flush;
    } finally {
      if (this.flushInFlight === flush) this.flushInFlight = undefined;
    }
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

  queryDiagnostics(): readonly WorkNoteQueryDiagnostic[] {
    return this.queryDiagnosticEntries;
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
    this.queryDiagnosticEntries = [];
    this.listeners.clear();
    this.settledListeners.clear();
    this.generations.clear();
    this.ready = false;
    this.flushInFlight = undefined;
  }
}
