import type { ProjectCreateResult } from '../../projects/ProjectManager';
import { normalizeProjectCollectionPreferences } from '../../settings/migration';
import type {
  CalendarSettings,
  CollectionSessionState,
  ProjectScopedCollectionPreferences,
  ProjectTasksCollectionPreference,
  ProjectTasksViewState,
  WorkNotesCollectionPreference,
  WorkNotesViewState,
} from '../../settings/types';
import {
  CollectionStateCoordinator,
  InMemoryCollectionSessionPort,
  type CollectionPreferencePort,
  type CollectionScopeKey,
} from '../../ui/collection/CollectionStateCoordinator';
import type { BoardViewPreference } from './boardPreferences';
import { MeasuredWindow } from './BoundedWindow';
import type { ProjectWorkspaceLayout, ProjectWorkspaceScope } from './ProjectsDashboardView';
import { ProjectTaskCollectionSession } from './ProjectTaskCollectionSession';
import type { TimelineOwnedRole } from './TimelineInteractionController';
import {
  DEFAULT_TIMELINE_IDENTITY_WIDTH,
  defaultTimelineScale,
  type TimelineScale,
  type TimelineScope,
} from './timelinePreferences';

const MAX_CLEAN_PROJECT_SESSIONS = 12;

export interface LogicalViewportSession {
  firstKey: string | null;
  firstIndex: number;
  focusedKey: string | null;
  restoreFocus: boolean;
}

/** Ephemeral continuous-Timeline state. Focal/scroll/interaction are never persisted. */
export interface TimelinePresentationSession<
  S extends TimelineScope,
> extends LogicalViewportSession {
  focalDate: string | null;
  scrollLeft: number;
  scale: TimelineScale<S>;
  identityWidth: number;
  focusedInteraction: { readonly itemKey: string; readonly role: TimelineOwnedRole } | null;
}

interface ScopeSelectionSession {
  selectedKeys: string[];
  focusedKey: string | null;
  inspectorKey: string | null;
}

export interface ProjectWorkspaceScopeSession<_TViewState> {
  layout: ProjectWorkspaceLayout;
  textQuery: string;
  readonly viewport: LogicalViewportSession;
  readonly selection: ScopeSelectionSession;
  inspectorDirty: boolean;
  captureDraft: string | null;
  openSurface: string | null;
}

type WorkspacePreference = ProjectTasksCollectionPreference | WorkNotesCollectionPreference;
type WorkspacePreferenceFor<S extends ProjectWorkspaceScope> = S extends 'tasks'
  ? ProjectTasksCollectionPreference
  : WorkNotesCollectionPreference;

interface ManagedProjectWorkspaceScopeSession<
  TViewState,
> extends ProjectWorkspaceScopeSession<TViewState> {
  rebindCollectionInstance(instanceKey: string): void;
}

export interface WorkNoteBoardSession {
  selectedColumnKey: string | null;
  focusedKey: string | null;
  restoreFocus: boolean;
  readonly columns: Record<string, LogicalViewportSession>;
  preference?: BoardViewPreference;
}

export interface WorkNotesSession {
  readonly list: LogicalViewportSession;
  readonly board: WorkNoteBoardSession;
  readonly selection: ScopeSelectionSession;
  pendingCreatedPath: string | null;
  inspectorPath: string | null;
}

export interface ProjectCaptureSession {
  open: boolean;
  draft: string;
  pending: boolean;
  createdPath: string | null;
  pendingPromise?: Promise<ProjectCreateResult | void>;
  terminalResult?: Extract<ProjectCreateResult, { type: 'file-created' }>;
}

export interface ProjectWorkspaceRecoveryEntry {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly tasks: ProjectWorkspaceScopeSession<ProjectTasksViewState>;
  readonly workNotes: ProjectWorkspaceScopeSession<WorkNotesViewState>;
  readonly taskBoardPreference?: BoardViewPreference;
  readonly workNoteBoardPreference?: BoardViewPreference;
}

interface ProjectWorkspaceEntry {
  scope: ProjectWorkspaceScope;
  readonly tasksScope: ManagedProjectWorkspaceScopeSession<ProjectTasksViewState>;
  readonly workNotesScope: ManagedProjectWorkspaceScopeSession<WorkNotesViewState>;
  readonly tasks: ProjectTaskCollectionSession;
  readonly taskBoard: WorkNoteBoardSession;
  readonly taskListGeometry: MeasuredWindow<string>;
  readonly taskListViewport: { firstRowKey: string | null; firstIndex: number };
  readonly workNotes: WorkNotesSession;
  readonly timelines: {
    tasks: TimelinePresentationSession<'tasks'>;
    workNotes: TimelinePresentationSession<'workNotes'>;
  };
}

function viewport(): LogicalViewportSession {
  return { firstKey: null, firstIndex: 0, focusedKey: null, restoreFocus: false };
}

function timelineViewport<S extends TimelineScope>(scope: S): TimelinePresentationSession<S> {
  return {
    ...viewport(),
    focalDate: null,
    scrollLeft: 0,
    scale: defaultTimelineScale(scope),
    identityWidth: DEFAULT_TIMELINE_IDENTITY_WIDTH,
    focusedInteraction: null,
  };
}

function updateCollectionSession(
  coordinator: CollectionStateCoordinator<WorkspacePreference>,
  instanceKey: () => string,
  changes: Partial<CollectionSessionState>,
): void {
  coordinator.updateSession(instanceKey(), { ...coordinator.session(instanceKey()), ...changes });
}

function scopeSession<TViewState>(
  coordinator: CollectionStateCoordinator<WorkspacePreference>,
  initialInstanceKey: string,
): ManagedProjectWorkspaceScopeSession<TViewState> {
  let instanceKey = initialInstanceKey;
  const selectionState: ScopeSelectionSession = {
    get selectedKeys(): string[] {
      const selected = coordinator.session(instanceKey).selectionKey;
      return selected ? [selected] : [];
    },
    set selectedKeys(next: string[]) {
      updateCollectionSession(coordinator, () => instanceKey, { selectionKey: next[0] ?? null });
    },
    get focusedKey(): string | null {
      return coordinator.session(instanceKey).focusedKey;
    },
    set focusedKey(next: string | null) {
      updateCollectionSession(coordinator, () => instanceKey, { focusedKey: next });
    },
    get inspectorKey(): string | null {
      return coordinator.session(instanceKey).selectionKey;
    },
    set inspectorKey(next: string | null) {
      updateCollectionSession(coordinator, () => instanceKey, { selectionKey: next });
    },
  };
  const localViewport = viewport();
  const viewportState: LogicalViewportSession = {
    get firstKey(): string | null {
      return coordinator.session(instanceKey).scrollAnchor;
    },
    set firstKey(next: string | null) {
      updateCollectionSession(coordinator, () => instanceKey, { scrollAnchor: next });
    },
    get focusedKey(): string | null {
      return coordinator.session(instanceKey).focusedKey;
    },
    set focusedKey(next: string | null) {
      updateCollectionSession(coordinator, () => instanceKey, { focusedKey: next });
    },
    get firstIndex(): number {
      return localViewport.firstIndex;
    },
    set firstIndex(next: number) {
      localViewport.firstIndex = next;
    },
    get restoreFocus(): boolean {
      return localViewport.restoreFocus;
    },
    set restoreFocus(next: boolean) {
      localViewport.restoreFocus = next;
    },
  };
  const managed = {
    viewport: viewportState,
    selection: selectionState,
    inspectorDirty: false,
    captureDraft: null,
    get layout(): ProjectWorkspaceLayout {
      const layout = coordinator.preference(instanceKey as CollectionScopeKey).layout;
      return layout === 'board' || layout === 'timeline' ? layout : 'list';
    },
    set layout(next: ProjectWorkspaceLayout) {
      const scope = instanceKey as CollectionScopeKey;
      const current = coordinator.preference(scope);
      void coordinator.updatePreference(scope, current.version, { ...current, layout: next });
    },
    get textQuery(): string {
      return coordinator.session(instanceKey).query;
    },
    set textQuery(next: string) {
      updateCollectionSession(coordinator, () => instanceKey, { query: next });
    },
    get openSurface(): string | null {
      return coordinator.session(instanceKey).openSurface;
    },
    set openSurface(next: string | null) {
      updateCollectionSession(coordinator, () => instanceKey, { openSurface: next });
    },
    rebindCollectionInstance(nextInstanceKey: string): void {
      const current = coordinator.session(instanceKey);
      coordinator.updateSession(nextInstanceKey, current);
      coordinator.release(instanceKey);
      instanceKey = nextInstanceKey;
    },
  } satisfies ManagedProjectWorkspaceScopeSession<TViewState>;
  return managed;
}

function workspaceEntry(
  coordinator: CollectionStateCoordinator<WorkspacePreference>,
  projectPath: string,
): ProjectWorkspaceEntry {
  const workNotesScope = scopeSession<WorkNotesViewState>(
    coordinator,
    `project:${projectPath}:work-notes`,
  );
  return {
    scope: 'tasks',
    tasksScope: scopeSession<ProjectTasksViewState>(coordinator, `project:${projectPath}:tasks`),
    workNotesScope,
    tasks: new ProjectTaskCollectionSession(),
    taskBoard: {
      selectedColumnKey: null,
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    },
    taskListGeometry: new MeasuredWindow<string>([], { estimateExtent: 56, overscan: 8 }),
    taskListViewport: { firstRowKey: null, firstIndex: 0 },
    workNotes: {
      list: workNotesScope.viewport,
      selection: workNotesScope.selection,
      pendingCreatedPath: null,
      inspectorPath: null,
      board: {
        selectedColumnKey: null,
        focusedKey: null,
        restoreFocus: false,
        columns: {},
      },
    },
    timelines: { tasks: timelineViewport('tasks'), workNotes: timelineViewport('workNotes') },
  };
}

function copyScope<TViewState>(
  source: ProjectWorkspaceScopeSession<TViewState>,
): ProjectWorkspaceScopeSession<TViewState> {
  return {
    layout: source.layout,
    textQuery: source.textQuery,
    viewport: { ...source.viewport },
    selection: {
      selectedKeys: [...source.selection.selectedKeys],
      focusedKey: source.selection.focusedKey,
      inspectorKey: source.selection.inspectorKey,
    },
    inspectorDirty: source.inspectorDirty,
    captureDraft: source.captureDraft,
    openSurface: source.openSurface,
  };
}

function sourceFirst<T>(source: readonly T[], destination: readonly T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const value of [...source, ...destination]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function rebaseValue(
  value: string | null,
  sourcePath: string,
  destinationPath: string,
): string | null {
  return value === sourcePath ? destinationPath : value;
}

function rebaseViewport(
  target: LogicalViewportSession,
  sourcePath: string,
  destinationPath: string,
): void {
  target.firstKey = rebaseValue(target.firstKey, sourcePath, destinationPath);
  target.focusedKey = rebaseValue(target.focusedKey, sourcePath, destinationPath);
}

function rebaseTimelineIdentity(
  value: string | null,
  sourcePath: string,
  destinationPath: string,
): string | null {
  for (const prefix of ['project:', 'work-note:'] as const) {
    if (value === `${prefix}${sourcePath}`) return `${prefix}${destinationPath}`;
  }
  return value;
}

function rebaseTimelineViewport(
  target: TimelinePresentationSession<TimelineScope>,
  sourcePath: string,
  destinationPath: string,
): void {
  target.firstKey = rebaseTimelineIdentity(target.firstKey, sourcePath, destinationPath);
  target.focusedKey = rebaseTimelineIdentity(target.focusedKey, sourcePath, destinationPath);
  if (target.focusedInteraction) {
    target.focusedInteraction = {
      ...target.focusedInteraction,
      itemKey:
        rebaseTimelineIdentity(target.focusedInteraction.itemKey, sourcePath, destinationPath) ??
        target.focusedInteraction.itemKey,
    };
  }
}

function reconcileSafeArrays<TViewState>(
  source: ProjectWorkspaceScopeSession<TViewState>,
  destination: ProjectWorkspaceScopeSession<TViewState>,
): void {
  source.selection.selectedKeys = sourceFirst(
    source.selection.selectedKeys,
    destination.selection.selectedKeys,
  );
}

export function logicalViewportFirst(
  session: LogicalViewportSession | undefined,
  keys: readonly string[],
): number {
  if (!session) return 0;
  const keyedFirst = session.firstKey === null ? -1 : keys.indexOf(session.firstKey);
  return Math.max(0, keyedFirst < 0 ? session.firstIndex : keyedFirst);
}

export function boardColumnViewport(
  session: WorkNoteBoardSession | undefined,
  columnKey: string,
): LogicalViewportSession | undefined {
  if (!session) return undefined;
  const current = session.columns[columnKey];
  if (current) return current;
  const created = viewport();
  session.columns[columnKey] = created;
  return created;
}

function emptyWorkspacePreference(): WorkNotesCollectionPreference {
  return {
    version: 1,
    layout: 'list',
    filters: [],
    group: 'none',
    sort: { field: 'updated', dir: 'desc' },
    visibleFields: [],
    layoutPreferences: {},
  };
}

function scopeParts(
  scope: CollectionScopeKey,
): { readonly path: string; readonly kind: 'tasks' | 'work-notes' } | null {
  if (!scope.startsWith('project:')) return null;
  if (scope.endsWith(':tasks'))
    return { path: scope.slice('project:'.length, -':tasks'.length), kind: 'tasks' };
  if (scope.endsWith(':work-notes')) {
    return { path: scope.slice('project:'.length, -':work-notes'.length), kind: 'work-notes' };
  }
  return null;
}

/** Versioned settings-backed preference store; mount sessions never write into it. */
class ProjectWorkspacePreferencePort implements CollectionPreferencePort<WorkspacePreference> {
  private settings: CalendarSettings | null = null;
  private onSaveSettings: (() => Promise<void>) | undefined;
  private readonly fallback = new Map<CollectionScopeKey, WorkspacePreference>();
  private readonly listeners = new Map<
    CollectionScopeKey,
    Set<(next: WorkspacePreference) => void>
  >();

  bind(settings: CalendarSettings, onSaveSettings?: () => Promise<void>): void {
    normalizeProjectCollectionPreferences(
      settings.projects.view as unknown as Record<string, unknown>,
    );
    this.settings = settings;
    this.onSaveSettings = onSaveSettings;
    if (onSaveSettings) this.fallback.clear();
  }

  private taskBaseline(settings: CalendarSettings): ProjectTasksCollectionPreference {
    const view = settings.projects.view.tasks;
    return {
      version: 1,
      layout: 'list',
      filters: [...view.filters],
      group: view.groupBy,
      sort: { ...view.sortBy },
      visibleFields: view.table.columns
        .filter(({ visible }) => visible)
        .map(({ propertyId }) => propertyId),
      layoutPreferences: {
        primary: { table: structuredClone(view.table), statusGroups: view.statusGroups },
      },
    };
  }

  private workNotesBaseline(settings: CalendarSettings): WorkNotesCollectionPreference {
    const view = settings.projects.view.workNotes;
    return {
      version: 1,
      layout: 'list',
      filters: [...view.statusIds],
      group: view.groupBy,
      sort: { ...view.sortBy },
      visibleFields: [],
      layoutPreferences: {},
    };
  }

  private stored(scope: CollectionScopeKey): WorkspacePreference | undefined {
    const fallback = this.fallback.get(scope);
    if (fallback) return fallback;
    const settings = this.settings;
    const parts = scopeParts(scope);
    if (!settings || !parts) return undefined;
    return settings.projects.view.collectionPreferences[parts.path]?.[
      parts.kind === 'tasks' ? 'tasks' : 'workNotes'
    ];
  }

  read(scope: CollectionScopeKey): WorkspacePreference {
    const settings = this.settings;
    const parts = scopeParts(scope);
    const stored = this.stored(scope);
    if (stored) return structuredClone(stored);
    if (!settings || !parts) return emptyWorkspacePreference();
    return parts.kind === 'tasks' ? this.taskBaseline(settings) : this.workNotesBaseline(settings);
  }

  update(
    scope: CollectionScopeKey,
    expectedVersion: number,
    next: WorkspacePreference,
  ): Promise<WorkspacePreference> {
    const parts = scopeParts(scope);
    const settings = this.settings;
    if (!parts || !settings || !this.onSaveSettings) {
      if (this.read(scope).version !== expectedVersion)
        return Promise.reject(new Error('version conflict'));
      this.fallback.set(scope, structuredClone(next));
      for (const listener of this.listeners.get(scope) ?? []) listener(next);
      return Promise.resolve(next);
    }
    if (this.read(scope).version !== expectedVersion)
      return Promise.reject(new Error('version conflict'));
    const current = settings.projects.view.collectionPreferences[parts.path];
    const nextRecord: ProjectScopedCollectionPreferences = {
      tasks: current?.tasks ?? this.taskBaseline(settings),
      workNotes: current?.workNotes ?? this.workNotesBaseline(settings),
      [parts.kind === 'tasks' ? 'tasks' : 'workNotes']: structuredClone(next) as never,
    };
    settings.projects.view.collectionPreferences[parts.path] = nextRecord;
    for (const listener of this.listeners.get(scope) ?? []) listener(next);
    return Promise.resolve(this.onSaveSettings()).then(() => next);
  }

  subscribe(scope: CollectionScopeKey, listener: (next: WorkspacePreference) => void): () => void {
    const scoped = this.listeners.get(scope) ?? new Set<(next: WorkspacePreference) => void>();
    scoped.add(listener);
    this.listeners.set(scope, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) this.listeners.delete(scope);
    };
  }

  renameProject(sourcePath: string, destinationPath: string): void {
    const settings = this.settings;
    if (!settings || sourcePath === destinationPath) return;
    const source = settings.projects.view.collectionPreferences[sourcePath];
    if (!source) return;
    settings.projects.view.collectionPreferences[destinationPath] = source;
    delete settings.projects.view.collectionPreferences[sourcePath];
  }
}

/** Ephemeral Project workspace continuity; never persisted to settings or the vault. */
export class ProjectWorkspaceSession {
  private readonly preferencePort = new ProjectWorkspacePreferencePort();
  private readonly coordinator = new CollectionStateCoordinator<WorkspacePreference>({
    preferences: this.preferencePort,
    sessions: new InMemoryCollectionSessionPort(),
    migratePreference: (current) => current,
  });
  private readonly sessions = new Map<string, ProjectWorkspaceEntry>();
  private readonly idle = workspaceEntry(this.coordinator, '__idle__');
  private readonly recoveries: ProjectWorkspaceRecoveryEntry[] = [];
  private projectPath: string | null = null;
  /** Portfolio continuity is independent of whichever Project workspace is open. */
  readonly portfolioTimeline = timelineViewport('portfolio');
  /** Portfolio Board continuity is independent of Project dashboard scope/layout state. */
  readonly portfolioBoard: WorkNoteBoardSession = {
    selectedColumnKey: null,
    focusedKey: null,
    restoreFocus: false,
    columns: {},
  };
  /** New Project continuity is shared by Overview, Board, Timeline, and panel remounts. */
  readonly portfolioCapture: ProjectCaptureSession = {
    open: false,
    draft: '',
    pending: false,
    createdPath: null,
  };

  bindCollectionPreferences(
    settings: CalendarSettings,
    onSaveSettings?: () => Promise<void>,
  ): void {
    this.preferencePort.bind(settings, onSaveSettings);
    this.coordinator.invalidatePreferences();
  }

  collectionScopeKey(path: string, scope: ProjectWorkspaceScope): CollectionScopeKey {
    return `project:${path}:${scope}`;
  }

  collectionSession(path: string, scope: ProjectWorkspaceScope): CollectionSessionState {
    return this.coordinator.session(this.collectionScopeKey(path, scope));
  }

  subscribeCollectionSession(
    path: string,
    scope: ProjectWorkspaceScope,
    listener: (next: CollectionSessionState) => void,
  ): () => void {
    return this.coordinator.subscribeSession(this.collectionScopeKey(path, scope), listener);
  }

  collectionPreference(path: string, scope: ProjectWorkspaceScope): WorkspacePreference {
    return this.coordinator.preference(this.collectionScopeKey(path, scope));
  }

  subscribeCollectionPreference(
    path: string,
    scope: ProjectWorkspaceScope,
    listener: (next: WorkspacePreference) => void,
  ): () => void {
    return this.coordinator.subscribePreference(this.collectionScopeKey(path, scope), listener);
  }

  updateCollectionPreference<S extends ProjectWorkspaceScope>(
    path: string,
    scope: S,
    mutate: (current: WorkspacePreferenceFor<S>) => WorkspacePreferenceFor<S>,
  ): Promise<WorkspacePreferenceFor<S>> {
    const key = this.collectionScopeKey(path, scope);
    const current = this.coordinator.preference(key) as WorkspacePreferenceFor<S>;
    return this.coordinator.updatePreference(key, current.version, mutate(current)) as Promise<
      WorkspacePreferenceFor<S>
    >;
  }

  collectionView(path: string, scope: 'tasks'): ProjectTasksViewState;
  collectionView(path: string, scope: 'work-notes'): WorkNotesViewState;
  collectionView(
    path: string,
    scope: ProjectWorkspaceScope,
  ): ProjectTasksViewState | WorkNotesViewState {
    const preference = this.collectionPreference(path, scope);
    if (scope === 'tasks') {
      const tasks = preference as ProjectTasksCollectionPreference;
      return {
        groupBy: tasks.group,
        sortBy: tasks.sort,
        filters: tasks.filters,
        ...(tasks.layoutPreferences['primary']?.statusGroups && {
          statusGroups: tasks.layoutPreferences['primary'].statusGroups,
        }),
        table: tasks.layoutPreferences['primary']?.table ?? {
          version: 1,
          columns: [],
          collapsedGroups: [],
        },
      };
    }
    const workNotes = preference as WorkNotesCollectionPreference;
    return {
      groupBy: workNotes.group,
      sortBy: workNotes.sort,
      statusIds: workNotes.filters,
    };
  }

  releaseProject(path: string): void {
    this.sessions.delete(path);
    this.releaseCollectionSessions(path);
    if (this.projectPath === path) this.projectPath = null;
  }

  releaseCollectionSessions(path: string): void {
    this.coordinator.release(this.collectionScopeKey(path, 'tasks'));
    this.coordinator.release(this.collectionScopeKey(path, 'work-notes'));
  }

  destroy(): void {
    for (const path of this.sessions.keys()) this.releaseProject(path);
    this.coordinator.release('project:__idle__:tasks');
    this.coordinator.release('project:__idle__:work-notes');
    this.projectPath = null;
  }

  get size(): number {
    return this.sessions.size;
  }

  get scope(): ProjectWorkspaceScope {
    return this.current().scope;
  }

  set scope(value: ProjectWorkspaceScope) {
    this.current().scope = value;
  }

  get layout(): ProjectWorkspaceLayout {
    return this.scopeSession(this.scope).layout;
  }

  set layout(value: ProjectWorkspaceLayout) {
    this.scopeSession(this.scope).layout = value;
  }

  /** Sole logical authority for Project Tasks/List selection, focus, inspector, and bulk inputs. */
  get tasks(): ProjectTaskCollectionSession {
    return this.current().tasks;
  }

  get taskBoard(): WorkNoteBoardSession {
    return this.current().taskBoard;
  }

  /** Geometry-only companion; it never owns semantic selection or focus. */
  get taskListGeometry(): MeasuredWindow<string> {
    return this.current().taskListGeometry;
  }

  get taskListViewport(): { firstRowKey: string | null; firstIndex: number } {
    return this.current().taskListViewport;
  }

  get workNotes(): WorkNotesSession {
    return this.current().workNotes;
  }

  get timelines(): {
    tasks: TimelinePresentationSession<'tasks'>;
    workNotes: TimelinePresentationSession<'workNotes'>;
  } {
    return this.current().timelines;
  }

  openProject(path: string): void {
    const existing = this.sessions.get(path);
    const entry = existing ?? workspaceEntry(this.coordinator, path);
    if (!existing) this.sessions.set(path, entry);
    else {
      this.sessions.delete(path);
      this.sessions.set(path, entry);
    }
    this.projectPath = path;
    this.evictCleanSessions();
  }

  closeProject(): void {
    this.projectPath = null;
  }

  hasProject(path: string): boolean {
    return this.sessions.has(path);
  }

  scopeSession(scope: 'tasks'): ProjectWorkspaceScopeSession<ProjectTasksViewState>;
  scopeSession(scope: 'work-notes'): ProjectWorkspaceScopeSession<WorkNotesViewState>;
  scopeSession(
    scope: ProjectWorkspaceScope,
  ): ProjectWorkspaceScopeSession<ProjectTasksViewState | WorkNotesViewState>;
  scopeSession(
    scope: ProjectWorkspaceScope,
  ):
    | ProjectWorkspaceScopeSession<ProjectTasksViewState>
    | ProjectWorkspaceScopeSession<WorkNotesViewState> {
    const entry = this.current();
    return scope === 'tasks' ? entry.tasksScope : entry.workNotesScope;
  }

  recoveryEntries(): readonly ProjectWorkspaceRecoveryEntry[] {
    return this.recoveries;
  }

  renameProject(sourcePath: string, destinationPath: string): void {
    if (sourcePath === destinationPath) return;
    const source = this.sessions.get(sourcePath);
    if (!source) return;
    this.preferencePort.renameProject(sourcePath, destinationPath);
    const destination = this.sessions.get(destinationPath);
    if (destination) {
      if (this.isDirty(destination)) {
        this.recoveries.push({
          sourcePath,
          destinationPath,
          tasks: copyScope(destination.tasksScope),
          workNotes: copyScope(destination.workNotesScope),
          ...(destination.taskBoard.preference && {
            taskBoardPreference: structuredClone(destination.taskBoard.preference),
          }),
          ...(destination.workNotes.board.preference && {
            workNoteBoardPreference: structuredClone(destination.workNotes.board.preference),
          }),
        });
      }
      reconcileSafeArrays(source.tasksScope, destination.tasksScope);
      reconcileSafeArrays(source.workNotesScope, destination.workNotesScope);
      this.sessions.delete(destinationPath);
      this.coordinator.release(this.collectionScopeKey(destinationPath, 'tasks'));
      this.coordinator.release(this.collectionScopeKey(destinationPath, 'work-notes'));
    }
    this.sessions.delete(sourcePath);
    source.tasksScope.rebindCollectionInstance(this.collectionScopeKey(destinationPath, 'tasks'));
    source.workNotesScope.rebindCollectionInstance(
      this.collectionScopeKey(destinationPath, 'work-notes'),
    );
    this.sessions.set(destinationPath, source);
    if (this.projectPath === sourcePath) this.projectPath = destinationPath;
    this.evictCleanSessions();
  }

  renamePath(sourcePath: string, destinationPath: string): void {
    if (sourcePath === destinationPath) return;
    this.renameProject(sourcePath, destinationPath);
    this.portfolioBoard.focusedKey = rebaseValue(
      this.portfolioBoard.focusedKey,
      sourcePath,
      destinationPath,
    );
    for (const viewport of Object.values(this.portfolioBoard.columns)) {
      rebaseViewport(viewport, sourcePath, destinationPath);
    }
    rebaseTimelineViewport(this.portfolioTimeline, sourcePath, destinationPath);
    this.portfolioCapture.createdPath = rebaseValue(
      this.portfolioCapture.createdPath,
      sourcePath,
      destinationPath,
    );
    if (this.portfolioCapture.terminalResult?.path === sourcePath) {
      this.portfolioCapture.terminalResult = {
        ...this.portfolioCapture.terminalResult,
        path: destinationPath,
      };
    }
    for (const entry of this.sessions.values()) {
      const selection = entry.workNotesScope.selection;
      selection.selectedKeys = selection.selectedKeys.map((path) =>
        path === sourcePath ? destinationPath : path,
      );
      selection.focusedKey = rebaseValue(selection.focusedKey, sourcePath, destinationPath);
      selection.inspectorKey = rebaseValue(selection.inspectorKey, sourcePath, destinationPath);
      entry.workNotes.inspectorPath = rebaseValue(
        entry.workNotes.inspectorPath,
        sourcePath,
        destinationPath,
      );
      entry.workNotes.pendingCreatedPath = rebaseValue(
        entry.workNotes.pendingCreatedPath,
        sourcePath,
        destinationPath,
      );
      rebaseViewport(entry.workNotes.list, sourcePath, destinationPath);
      rebaseViewport(entry.timelines.workNotes, sourcePath, destinationPath);
      entry.workNotes.board.focusedKey = rebaseValue(
        entry.workNotes.board.focusedKey,
        sourcePath,
        destinationPath,
      );
      for (const viewport of Object.values(entry.workNotes.board.columns)) {
        rebaseViewport(viewport, sourcePath, destinationPath);
      }
    }
  }

  private current(): ProjectWorkspaceEntry {
    return this.projectPath === null
      ? this.idle
      : (this.sessions.get(this.projectPath) ?? this.idle);
  }

  private isDirty(entry: ProjectWorkspaceEntry): boolean {
    return (
      entry.taskBoard.preference !== undefined ||
      entry.workNotes.board.preference !== undefined ||
      [entry.tasksScope, entry.workNotesScope].some(
        (scope) => scope.inspectorDirty || scope.captureDraft !== null,
      )
    );
  }

  private evictCleanSessions(): void {
    while (this.sessions.size > MAX_CLEAN_PROJECT_SESSIONS) {
      const evicted = [...this.sessions].find(
        ([path, entry]) => path !== this.projectPath && !this.isDirty(entry),
      );
      if (!evicted) return;
      this.releaseProject(evicted[0]);
    }
  }
}

/** Named registry alias for owners that want to make Project-path scoping explicit. */
export class ProjectWorkspaceSessionRegistry extends ProjectWorkspaceSession {}
