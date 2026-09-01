import type { ProjectCreateResult } from '../../projects/ProjectManager';
import { getListViewDefaults } from '../../settings/defaults';
import { normalizeProjectCollectionPreferences } from '../../settings/migration';
import type {
  CalendarSettings,
  CollectionSessionState,
  ListViewState,
  MainTasksCollectionPreference,
  PortfolioCollectionPreference,
  ProjectScopedCollectionPreferences,
  ProjectTasksCollectionPreference,
  ProjectTasksViewState,
  WorkNotesCollectionPreference,
  WorkNotesViewState,
} from '../../settings/types';
import {
  CollectionPreferenceConflictError,
  CollectionStateCoordinator,
  InMemoryCollectionSessionPort,
  type CollectionPreferencePort,
  type CollectionPreferenceSnapshot,
  type CollectionScopeKey,
  type CollectionSessionPort,
} from '../../ui/collection/CollectionStateCoordinator';
import type { BoardViewPreference } from './boardPreferences';
import { MeasuredWindow } from './BoundedWindow';
import type { ProjectWorkspaceLayout, ProjectWorkspaceScope } from './ProjectsDashboardView';
import { ProjectTaskCollectionSession } from './ProjectTaskCollectionSession';
import type { TimelineOwnedRole } from './TimelineInteractionController';
import {
  DEFAULT_TIMELINE_IDENTITY_WIDTH,
  defaultTimelineScale,
  reconcileTimelinePreference,
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

type WorkspacePreference =
  | MainTasksCollectionPreference
  | PortfolioCollectionPreference
  | ProjectTasksCollectionPreference
  | WorkNotesCollectionPreference;
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
  sessions: CollectionSessionPort,
  instanceKey: () => string,
  changes: Partial<CollectionSessionState>,
): void {
  sessions.update(instanceKey(), { ...sessions.read(instanceKey()), ...changes });
}

function scopeSession<TViewState>(
  coordinator: CollectionStateCoordinator<WorkspacePreference>,
  sessions: CollectionSessionPort,
  initialInstanceKey: string,
): ManagedProjectWorkspaceScopeSession<TViewState> {
  let instanceKey = initialInstanceKey;
  const selectionState: ScopeSelectionSession = {
    get selectedKeys(): string[] {
      const selected = sessions.read(instanceKey).selectionKey;
      return selected ? [selected] : [];
    },
    set selectedKeys(next: string[]) {
      updateCollectionSession(sessions, () => instanceKey, { selectionKey: next[0] ?? null });
    },
    get focusedKey(): string | null {
      return sessions.read(instanceKey).focusedKey;
    },
    set focusedKey(next: string | null) {
      updateCollectionSession(sessions, () => instanceKey, { focusedKey: next });
    },
    get inspectorKey(): string | null {
      return sessions.read(instanceKey).selectionKey;
    },
    set inspectorKey(next: string | null) {
      updateCollectionSession(sessions, () => instanceKey, { selectionKey: next });
    },
  };
  const localViewport = viewport();
  const viewportState: LogicalViewportSession = {
    get firstKey(): string | null {
      return sessions.read(instanceKey).scrollAnchor;
    },
    set firstKey(next: string | null) {
      updateCollectionSession(sessions, () => instanceKey, { scrollAnchor: next });
    },
    get focusedKey(): string | null {
      return sessions.read(instanceKey).focusedKey;
    },
    set focusedKey(next: string | null) {
      updateCollectionSession(sessions, () => instanceKey, { focusedKey: next });
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
      return layout === 'table' || layout === 'board' || layout === 'timeline' ? layout : 'list';
    },
    set layout(next: ProjectWorkspaceLayout) {
      const scope = instanceKey as CollectionScopeKey;
      const current = coordinator.preferenceSnapshot(scope);
      void coordinator
        .updatePreference(scope, current, {
          ...current.preference,
          layout: next,
        } as WorkspacePreference)
        .catch(() => undefined);
    },
    get textQuery(): string {
      return sessions.read(instanceKey).query;
    },
    set textQuery(next: string) {
      updateCollectionSession(sessions, () => instanceKey, { query: next });
    },
    get openSurface(): string | null {
      return sessions.read(instanceKey).openSurface;
    },
    set openSurface(next: string | null) {
      updateCollectionSession(sessions, () => instanceKey, { openSurface: next });
    },
    rebindCollectionInstance(nextInstanceKey: string): void {
      const current = sessions.read(instanceKey);
      sessions.update(nextInstanceKey, current);
      sessions.release(instanceKey);
      instanceKey = nextInstanceKey;
    },
  } satisfies ManagedProjectWorkspaceScopeSession<TViewState>;
  return managed;
}

function workspaceEntry(
  coordinator: CollectionStateCoordinator<WorkspacePreference>,
  sessions: CollectionSessionPort,
  projectPath: string,
): ProjectWorkspaceEntry {
  const workNotesScope = scopeSession<WorkNotesViewState>(
    coordinator,
    sessions,
    `project:${projectPath}:work-notes`,
  );
  return {
    scope: 'tasks',
    tasksScope: scopeSession<ProjectTasksViewState>(
      coordinator,
      sessions,
      `project:${projectPath}:tasks`,
    ),
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

const PORTFOLIO_UNMAPPED_FILTER = '__unmapped__';

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

/** Settings-backed preference store shared by every production collection scope. */
class ProjectWorkspacePreferencePort implements CollectionPreferencePort<WorkspacePreference> {
  private settings: CalendarSettings | null = null;
  private onSaveSettings: (() => Promise<void>) | undefined;
  private readonly fallback = new Map<string, WorkspacePreference>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Map<
    CollectionScopeKey,
    Set<(next: CollectionPreferenceSnapshot<WorkspacePreference>) => void>
  >();
  private readonly pending = new Map<
    CollectionScopeKey,
    {
      persistenceIdentity: string;
      revision: number;
      preference: WorkspacePreference;
    }
  >();
  private readonly scopeAliases = new Map<CollectionScopeKey, CollectionScopeKey>();
  private readonly queued = new Map<CollectionScopeKey, number>();
  private saveQueue: Promise<void> = Promise.resolve();
  private mainTaskListKey = 'today';

  bind(settings: CalendarSettings, onSaveSettings?: () => Promise<void>): void {
    normalizeProjectCollectionPreferences(
      settings.projects.view as unknown as Record<string, unknown>,
    );
    this.settings = settings;
    this.onSaveSettings = onSaveSettings;
    if (onSaveSettings) this.fallback.clear();
  }

  activateMainTaskList(listKey: string): void {
    this.mainTaskListKey = listKey;
  }

  activeMainTaskList(): string {
    return this.mainTaskListKey;
  }

  resolveScope(scope: CollectionScopeKey): CollectionScopeKey {
    let current = scope;
    const visited = new Set<CollectionScopeKey>();
    while (this.scopeAliases.has(current) && !visited.has(current)) {
      visited.add(current);
      current = this.scopeAliases.get(current)!;
    }
    return current;
  }

  private revisionKey(scope: CollectionScopeKey, mainTaskListKey = this.mainTaskListKey): string {
    return scope === 'tasks:main' ? `${scope}:${mainTaskListKey}` : scope;
  }

  private mainTaskListFromIdentity(identity: string): string | null {
    const prefix = 'tasks:main:';
    return identity.startsWith(prefix) ? identity.slice(prefix.length) : null;
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
        timeline: {
          timeline: reconcileTimelinePreference('tasks', settings.projects.view.timeline.tasks),
        },
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
      layoutPreferences: {
        timeline: {
          timeline: reconcileTimelinePreference('workNotes', {
            scale: settings.projects.view.timeline.workNotes.dateRange,
            identityWidth: settings.projects.view.timeline.workNotes.identityWidth,
          }),
        },
      },
    };
  }

  private mainTaskPreference(settings: CalendarSettings): MainTasksCollectionPreference {
    const view =
      settings.listViewStates?.[this.mainTaskListKey] ?? getListViewDefaults(this.mainTaskListKey);
    return {
      version: 1,
      layout: 'list',
      filters: structuredClone(view.filters),
      group: view.groupBy,
      sort: { ...view.sortBy },
      visibleFields: [],
      layoutPreferences: {
        primary: { ...(view.statusGroups && { statusGroups: [...view.statusGroups] }) },
      },
    };
  }

  private portfolioPreference(settings: CalendarSettings): PortfolioCollectionPreference {
    const view = settings.projects.view;
    return {
      version: 1,
      layout: view.portfolioLayout,
      filters: [
        ...view.visibleStatusIds,
        ...(view.includeUnmapped ? [PORTFOLIO_UNMAPPED_FILTER] : []),
      ],
      group: view.portfolioGroupBy ?? 'none',
      sort: structuredClone(view.portfolioSortBy ?? { field: 'title', dir: 'asc' }),
      visibleFields: view.table.columns
        .filter(({ visible }) => visible)
        .map(({ propertyId }) => propertyId),
      layoutPreferences: {
        overview: { table: structuredClone(view.table) },
        board: { board: structuredClone(view.board) },
        timeline: { timeline: structuredClone(view.timeline.portfolio) },
      },
    };
  }

  private stored(scope: CollectionScopeKey): WorkspacePreference | undefined {
    const fallback = this.fallback.get(this.revisionKey(scope));
    if (fallback) return fallback;
    const settings = this.settings;
    if (!settings) return undefined;
    if (scope === 'tasks:main') return this.mainTaskPreference(settings);
    if (scope === 'projects:portfolio') return this.portfolioPreference(settings);
    const parts = scopeParts(scope);
    if (!parts) return undefined;
    return settings.projects.view.collectionPreferences[parts.path]?.[
      parts.kind === 'tasks' ? 'tasks' : 'workNotes'
    ];
  }

  read(scope: CollectionScopeKey): CollectionPreferenceSnapshot<WorkspacePreference> {
    scope = this.resolveScope(scope);
    const pending = this.pending.get(scope);
    if (pending) {
      return {
        persistenceIdentity: pending.persistenceIdentity,
        revision: pending.revision,
        preference: structuredClone(pending.preference),
      };
    }
    const settings = this.settings;
    const parts = scopeParts(scope);
    const stored = this.stored(scope);
    let preference: WorkspacePreference;
    if (stored) preference = structuredClone(stored);
    else if (!settings || !parts) preference = emptyWorkspacePreference();
    else if (parts.kind === 'tasks') preference = this.taskBaseline(settings);
    else preference = this.workNotesBaseline(settings);
    return {
      persistenceIdentity: this.revisionKey(scope),
      revision: this.revisions.get(this.revisionKey(scope)) ?? 0,
      preference,
    };
  }

  reserveScope(scope: CollectionScopeKey): () => void {
    const reservedScope = this.resolveScope(scope);
    this.queued.set(reservedScope, (this.queued.get(reservedScope) ?? 0) + 1);
    return () => {
      const settledScope = this.resolveScope(scope);
      const remaining = (this.queued.get(settledScope) ?? 1) - 1;
      if (remaining > 0) this.queued.set(settledScope, remaining);
      else this.queued.delete(settledScope);
    };
  }

  update(
    scope: CollectionScopeKey,
    expected: CollectionPreferenceSnapshot<WorkspacePreference>,
    next: WorkspacePreference,
  ): Promise<CollectionPreferenceSnapshot<WorkspacePreference>> {
    const mainTaskListKey = this.mainTaskListFromIdentity(expected.persistenceIdentity);
    const operation = this.saveQueue.then(() =>
      this.commit(scope, expected, next, mainTaskListKey),
    );
    const result = operation.catch((error: unknown) => {
      const settledScope = this.resolveScope(scope);
      const authoritative = this.read(settledScope);
      for (const listener of this.listeners.get(settledScope) ?? []) listener(authoritative);
      throw error;
    });
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  subscribe(
    scope: CollectionScopeKey,
    listener: (next: CollectionPreferenceSnapshot<WorkspacePreference>) => void,
  ): () => void {
    scope = this.resolveScope(scope);
    const scoped =
      this.listeners.get(scope) ??
      new Set<(next: CollectionPreferenceSnapshot<WorkspacePreference>) => void>();
    scoped.add(listener);
    this.listeners.set(scope, scoped);
    return () => {
      for (const [key, listeners] of this.listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) this.listeners.delete(key);
      }
    };
  }

  private async commit(
    scope: CollectionScopeKey,
    expected: CollectionPreferenceSnapshot<WorkspacePreference>,
    next: WorkspacePreference,
    mainTaskListKey: string | null,
  ): Promise<CollectionPreferenceSnapshot<WorkspacePreference>> {
    scope = this.resolveScope(scope);
    const revisionKey =
      scope === 'tasks:main' ? expected.persistenceIdentity : this.revisionKey(scope);
    const identityMatchesScope =
      scope === 'tasks:main'
        ? mainTaskListKey !== null
        : this.resolveScope(expected.persistenceIdentity as CollectionScopeKey) === scope;
    if (!identityMatchesScope) throw new CollectionPreferenceConflictError();
    const revision = this.revisions.get(revisionKey) ?? 0;
    if (revision !== expected.revision) throw new CollectionPreferenceConflictError();
    const settings = this.settings;
    if (!settings || !this.onSaveSettings) {
      this.fallback.set(revisionKey, structuredClone(next));
      return this.publish(scope, revisionKey, revision, next);
    }

    const pending = {
      persistenceIdentity: revisionKey,
      revision: expected.revision,
      preference: structuredClone(expected.preference),
    };
    const pendingScope = this.resolveScope(scope);
    this.pending.set(pendingScope, pending);
    const restore = this.stage(settings, scope, next, mainTaskListKey ?? this.mainTaskListKey);
    try {
      await this.onSaveSettings();
    } catch (error) {
      restore();
      throw error;
    } finally {
      const settledScope = this.resolveScope(scope);
      if (this.pending.get(settledScope) === pending) this.pending.delete(settledScope);
    }
    const settledScope = this.resolveScope(scope);
    const settledRevisionKey = this.revisionKey(
      settledScope,
      mainTaskListKey ?? this.mainTaskListKey,
    );
    return this.publish(settledScope, settledRevisionKey, revision, next);
  }

  private stage(
    settings: CalendarSettings,
    scope: CollectionScopeKey,
    next: WorkspacePreference,
    mainTaskListKey: string,
  ): () => void {
    if (scope === 'tasks:main') {
      const preference = next as MainTasksCollectionPreference;
      const statusGroups = preference.layoutPreferences['primary']?.statusGroups;
      const priorStates = settings.listViewStates;
      const states = priorStates ?? {};
      if (!priorStates) settings.listViewStates = states;
      const hadPrior = Object.prototype.hasOwnProperty.call(states, mainTaskListKey);
      const prior = states[mainTaskListKey];
      const staged: ListViewState = {
        ...prior,
        groupBy: preference.group,
        sortBy: { ...preference.sort },
        filters: [...preference.filters],
        ...(statusGroups && { statusGroups: [...statusGroups] }),
      };
      if (!statusGroups) delete staged.statusGroups;
      states[mainTaskListKey] = staged;
      return () => {
        if (settings.listViewStates !== states || states[mainTaskListKey] !== staged) return;
        if (hadPrior && prior) states[mainTaskListKey] = prior;
        else delete states[mainTaskListKey];
        if (!priorStates && Object.keys(states).length === 0 && settings.listViewStates === states)
          delete settings.listViewStates;
      };
    }

    const view = settings.projects.view;
    if (scope === 'projects:portfolio') {
      const preference = next as PortfolioCollectionPreference;
      const filters = new Set(preference.filters);
      const priorLayout = view.portfolioLayout;
      const priorVisibleStatusIds = view.visibleStatusIds;
      const priorIncludeUnmapped = view.includeUnmapped;
      const priorGroup = view.portfolioGroupBy;
      const priorSort = view.portfolioSortBy;
      const priorTable = view.table;
      const priorBoard = view.board;
      const priorTimeline = view.timeline;
      const stagedLayout = preference.layout;
      const stagedVisibleStatusIds = preference.filters.filter(
        (id) => id !== PORTFOLIO_UNMAPPED_FILTER,
      );
      const stagedIncludeUnmapped = filters.has(PORTFOLIO_UNMAPPED_FILTER);
      const stagedGroup = preference.group;
      const stagedSort = structuredClone(preference.sort);
      const stagedTable = structuredClone(
        preference.layoutPreferences['overview']?.table ?? view.table,
      );
      const stagedBoard = structuredClone(
        preference.layoutPreferences['board']?.board ?? view.board,
      );
      const stagedTimeline = {
        ...view.timeline,
        portfolio: structuredClone(
          preference.layoutPreferences['timeline']?.timeline ?? view.timeline.portfolio,
        ),
      };
      view.portfolioLayout = stagedLayout;
      view.visibleStatusIds = stagedVisibleStatusIds;
      view.includeUnmapped = stagedIncludeUnmapped;
      view.portfolioGroupBy = stagedGroup;
      view.portfolioSortBy = stagedSort;
      view.table = stagedTable;
      view.board = stagedBoard;
      view.timeline = stagedTimeline;
      return () => {
        if (settings.projects.view !== view) return;
        if (view.portfolioLayout === stagedLayout) view.portfolioLayout = priorLayout;
        if (view.visibleStatusIds === stagedVisibleStatusIds)
          view.visibleStatusIds = priorVisibleStatusIds;
        if (view.includeUnmapped === stagedIncludeUnmapped)
          view.includeUnmapped = priorIncludeUnmapped;
        if (view.portfolioGroupBy === stagedGroup) view.portfolioGroupBy = priorGroup;
        if (view.portfolioSortBy === stagedSort) view.portfolioSortBy = priorSort;
        if (view.table === stagedTable) view.table = priorTable;
        if (view.board === stagedBoard) view.board = priorBoard;
        if (view.timeline === stagedTimeline) view.timeline = priorTimeline;
      };
    }

    const parts = scopeParts(scope);
    if (!parts) return () => undefined;
    const records = view.collectionPreferences;
    const hadPrior = Object.prototype.hasOwnProperty.call(records, parts.path);
    const prior = records[parts.path];
    const staged: ProjectScopedCollectionPreferences = {
      ...prior,
      tasks: prior?.tasks ?? this.taskBaseline(settings),
      workNotes: prior?.workNotes ?? this.workNotesBaseline(settings),
      [parts.kind === 'tasks' ? 'tasks' : 'workNotes']: structuredClone(next) as never,
    };
    records[parts.path] = staged;
    return () => {
      const settledParts = scopeParts(this.resolveScope(scope));
      if (!settledParts || settledParts.kind !== parts.kind) return;
      if (
        settings.projects.view !== view ||
        view.collectionPreferences !== records ||
        records[settledParts.path] !== staged
      )
        return;
      if (hadPrior && prior) records[settledParts.path] = prior;
      else delete records[settledParts.path];
    };
  }

  private publish(
    scope: CollectionScopeKey,
    revisionKey: string,
    revision: number,
    preference: WorkspacePreference,
  ): CollectionPreferenceSnapshot<WorkspacePreference> {
    const settled = {
      persistenceIdentity: revisionKey,
      revision: revision + 1,
      preference: structuredClone(preference),
    };
    this.revisions.set(revisionKey, settled.revision);
    for (const listener of this.listeners.get(scope) ?? []) listener(settled);
    return settled;
  }

  renameProject(sourcePath: string, destinationPath: string): void {
    const settings = this.settings;
    if (!settings || sourcePath === destinationPath) return;
    const source = settings.projects.view.collectionPreferences[sourcePath];
    if (source) {
      settings.projects.view.collectionPreferences[destinationPath] = source;
      delete settings.projects.view.collectionPreferences[sourcePath];
    }
    for (const kind of ['tasks', 'work-notes'] as const) {
      const sourceScope = `project:${sourcePath}:${kind}` as CollectionScopeKey;
      const destinationScope = `project:${destinationPath}:${kind}` as CollectionScopeKey;
      this.rekeyScope(sourceScope, destinationScope);
    }
  }

  private rekeyScope(source: CollectionScopeKey, destination: CollectionScopeKey): void {
    const sourceIdentity = this.resolveScope(source);
    if (sourceIdentity === destination) return;
    const pending = this.pending.get(sourceIdentity);
    const queued = this.queued.get(sourceIdentity) ?? 0;
    if (pending || queued > 0) {
      // A reverse rename may target a raw key currently aliased to the source. Remove
      // that edge first so A→B→A converges on A instead of forming an alias cycle.
      this.scopeAliases.delete(destination);
      for (const [alias, target] of this.scopeAliases) {
        if (this.resolveScope(target) === sourceIdentity) this.scopeAliases.set(alias, destination);
      }
      this.scopeAliases.set(source, destination);
    }
    const revision = this.revisions.get(sourceIdentity);
    if (revision !== undefined) this.revisions.set(destination, revision);
    this.revisions.delete(sourceIdentity);
    const fallback = this.fallback.get(sourceIdentity);
    if (fallback) this.fallback.set(destination, fallback);
    this.fallback.delete(sourceIdentity);
    if (pending) {
      pending.persistenceIdentity = destination;
      this.pending.set(destination, pending);
      this.pending.delete(sourceIdentity);
    }
    if (queued > 0) {
      this.queued.set(destination, (this.queued.get(destination) ?? 0) + queued);
      this.queued.delete(sourceIdentity);
    }
    const sourceListeners = this.listeners.get(sourceIdentity);
    if (sourceListeners) {
      const existingDestination = this.listeners.get(destination);
      const destinationListeners = existingDestination ?? sourceListeners;
      if (existingDestination) {
        for (const listener of sourceListeners) destinationListeners.add(listener);
      }
      this.listeners.set(destination, destinationListeners);
      this.listeners.delete(sourceIdentity);
    }
  }

  releaseScopeAliases(scope: CollectionScopeKey): void {
    const target = this.resolveScope(scope);
    if (this.pending.has(target) || (this.queued.get(target) ?? 0) > 0) return;
    for (const alias of [...this.scopeAliases.keys()]) {
      if (this.resolveScope(alias) === target) this.scopeAliases.delete(alias);
    }
  }

  dispose(): void {
    this.settings = null;
    this.onSaveSettings = undefined;
    this.fallback.clear();
    this.revisions.clear();
    this.listeners.clear();
    this.pending.clear();
    this.scopeAliases.clear();
    this.queued.clear();
  }
}

interface ProjectWorkspacePreferenceAuthority {
  readonly preferencePort: ProjectWorkspacePreferencePort;
  readonly coordinator: CollectionStateCoordinator<WorkspacePreference>;
  readonly portfolioPreferenceFailureListeners: Set<(error: unknown) => void>;
  readonly portfolioBoardPreferenceMutationListeners: Set<() => void>;
  readonly collectionPreferenceFailureListeners: Map<
    CollectionScopeKey,
    Set<(error: unknown) => void>
  >;
  readonly collectionPreferenceMutationListeners: Map<CollectionScopeKey, Set<() => void>>;
  readonly collectionPreferenceMutationStates: Map<
    CollectionScopeKey,
    'idle' | 'pending' | 'failed'
  >;
  portfolioBoardPreferenceMutationState: 'idle' | 'pending' | 'failed';
  acquisitions: number;
  disposed: boolean;
}

const projectWorkspacePreferenceAuthorities = new WeakMap<
  object,
  ProjectWorkspacePreferenceAuthority
>();

function createProjectWorkspacePreferenceAuthority(): ProjectWorkspacePreferenceAuthority {
  const preferencePort = new ProjectWorkspacePreferencePort();
  return {
    preferencePort,
    coordinator: new CollectionStateCoordinator<WorkspacePreference>({
      preferences: preferencePort,
      // Transient selection/focus state stays pane-local in ProjectWorkspaceSession.
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    }),
    portfolioPreferenceFailureListeners: new Set(),
    portfolioBoardPreferenceMutationListeners: new Set(),
    collectionPreferenceFailureListeners: new Map(),
    collectionPreferenceMutationListeners: new Map(),
    collectionPreferenceMutationStates: new Map(),
    portfolioBoardPreferenceMutationState: 'idle',
    acquisitions: 0,
    disposed: false,
  };
}

function acquireProjectWorkspacePreferenceAuthority(
  owner?: object,
): ProjectWorkspacePreferenceAuthority {
  if (!owner) {
    const local = createProjectWorkspacePreferenceAuthority();
    local.acquisitions = 1;
    return local;
  }
  const current = projectWorkspacePreferenceAuthorities.get(owner);
  const authority = current?.disposed ? undefined : current;
  if (authority) {
    authority.acquisitions += 1;
    return authority;
  }
  const created = createProjectWorkspacePreferenceAuthority();
  created.acquisitions = 1;
  projectWorkspacePreferenceAuthorities.set(owner, created);
  return created;
}

function releaseProjectWorkspacePreferenceAuthority(
  authority: ProjectWorkspacePreferenceAuthority,
): void {
  authority.acquisitions = Math.max(0, authority.acquisitions - 1);
}

/** Plugin lifecycle boundary for application-scoped collection preference state. */
export function disposeProjectWorkspacePreferenceAuthority(owner: object): void {
  const authority = projectWorkspacePreferenceAuthorities.get(owner);
  if (!authority) return;
  projectWorkspacePreferenceAuthorities.delete(owner);
  authority.disposed = true;
  authority.portfolioPreferenceFailureListeners.clear();
  authority.portfolioBoardPreferenceMutationListeners.clear();
  authority.collectionPreferenceFailureListeners.clear();
  authority.collectionPreferenceMutationListeners.clear();
  authority.collectionPreferenceMutationStates.clear();
  authority.preferencePort.dispose();
  authority.coordinator.invalidatePreferences();
}

/** Ephemeral Project workspace continuity; never persisted to settings or the vault. */
export class ProjectWorkspaceSession {
  private readonly preferenceAuthority: ProjectWorkspacePreferenceAuthority;
  private readonly preferencePort: ProjectWorkspacePreferencePort;
  private readonly coordinator: CollectionStateCoordinator<WorkspacePreference>;
  private readonly mainTaskPreferencePort = new ProjectWorkspacePreferencePort();
  private readonly mainTaskCoordinator = new CollectionStateCoordinator<WorkspacePreference>({
    preferences: this.mainTaskPreferencePort,
    sessions: new InMemoryCollectionSessionPort(),
    migratePreference: (current) => current,
  });
  private readonly sessionPort = new InMemoryCollectionSessionPort();
  private readonly sessions = new Map<string, ProjectWorkspaceEntry>();
  private readonly idle: ProjectWorkspaceEntry;
  private readonly recoveries: ProjectWorkspaceRecoveryEntry[] = [];
  private projectPath: string | null = null;
  private destroyed = false;
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

  constructor(preferenceOwner?: object) {
    this.preferenceAuthority = acquireProjectWorkspacePreferenceAuthority(preferenceOwner);
    this.preferencePort = this.preferenceAuthority.preferencePort;
    this.coordinator = this.preferenceAuthority.coordinator;
    this.idle = workspaceEntry(this.coordinator, this.sessionPort, '__idle__');
  }

  bindCollectionPreferences(
    settings: CalendarSettings,
    onSaveSettings?: () => Promise<void>,
  ): void {
    this.preferencePort.bind(settings, onSaveSettings);
    this.mainTaskPreferencePort.bind(settings, onSaveSettings);
    this.coordinator.invalidatePreferences();
    this.mainTaskCoordinator.invalidatePreferences();
  }

  activateMainTaskCollection(listKey: string): void {
    this.mainTaskPreferencePort.activateMainTaskList(listKey);
    this.mainTaskCoordinator.invalidatePreference('tasks:main');
  }

  mainTaskPreferenceSnapshot(): CollectionPreferenceSnapshot<MainTasksCollectionPreference> {
    return this.mainTaskCoordinator.preferenceSnapshot(
      'tasks:main',
    ) as CollectionPreferenceSnapshot<MainTasksCollectionPreference>;
  }

  mainTaskView(): ListViewState {
    const preference = this.mainTaskPreferenceSnapshot().preference;
    const statusGroups = preference.layoutPreferences['primary']?.statusGroups;
    return {
      groupBy: preference.group,
      sortBy: { ...preference.sort },
      filters: [...preference.filters],
      ...(statusGroups && { statusGroups: [...statusGroups] }),
    };
  }

  updateMainTaskPreference(
    mutate: (current: MainTasksCollectionPreference) => MainTasksCollectionPreference,
  ): Promise<CollectionPreferenceSnapshot<MainTasksCollectionPreference>> {
    const listKey = this.mainTaskPreferencePort.activeMainTaskList();
    const current = this.mainTaskPreferenceSnapshot();
    const next = mutate(current.preference);
    return (
      this.mainTaskCoordinator.updatePreference('tasks:main', current, next) as Promise<
        CollectionPreferenceSnapshot<MainTasksCollectionPreference>
      >
    ).then((settled) => {
      if (this.mainTaskPreferencePort.activeMainTaskList() !== listKey)
        this.mainTaskCoordinator.invalidatePreference('tasks:main');
      return settled;
    });
  }

  mainTaskSession(): CollectionSessionState {
    return this.sessionPort.read('tasks:main');
  }

  updateMainTaskSession(changes: Partial<CollectionSessionState>): void {
    this.sessionPort.update('tasks:main', { ...this.mainTaskSession(), ...changes });
  }

  portfolioPreferenceSnapshot(): CollectionPreferenceSnapshot<PortfolioCollectionPreference> {
    return this.coordinator.preferenceSnapshot(
      'projects:portfolio',
    ) as CollectionPreferenceSnapshot<PortfolioCollectionPreference>;
  }

  portfolioPreference(): PortfolioCollectionPreference {
    return this.portfolioPreferenceSnapshot().preference;
  }

  updatePortfolioPreference(
    mutate: (current: PortfolioCollectionPreference) => PortfolioCollectionPreference,
  ): Promise<CollectionPreferenceSnapshot<PortfolioCollectionPreference>> {
    const current = this.portfolioPreferenceSnapshot();
    return this.coordinator.updatePreference(
      'projects:portfolio',
      current,
      mutate(current.preference),
    ) as Promise<CollectionPreferenceSnapshot<PortfolioCollectionPreference>>;
  }

  updatePortfolioBoardPreference(
    next: BoardViewPreference,
  ): Promise<CollectionPreferenceSnapshot<PortfolioCollectionPreference>> {
    return this.updatePortfolioPresentationPreference((current) => ({
      ...current,
      layoutPreferences: {
        ...current.layoutPreferences,
        board: { board: next },
      },
    }));
  }

  updatePortfolioTimelinePreference(next: {
    readonly scale: TimelineScale<'portfolio'>;
    readonly identityWidth: number;
  }): Promise<CollectionPreferenceSnapshot<PortfolioCollectionPreference>> {
    return this.updatePortfolioPresentationPreference((current) => ({
      ...current,
      layoutPreferences: {
        ...current.layoutPreferences,
        timeline: { timeline: next },
      },
    }));
  }

  private updatePortfolioPresentationPreference(
    mutate: (current: PortfolioCollectionPreference) => PortfolioCollectionPreference,
  ): Promise<CollectionPreferenceSnapshot<PortfolioCollectionPreference>> {
    if (this.preferenceAuthority.portfolioBoardPreferenceMutationState === 'pending') {
      const conflict = new CollectionPreferenceConflictError();
      queueMicrotask(() => {
        for (const listener of this.preferenceAuthority.portfolioPreferenceFailureListeners)
          listener(conflict);
      });
      return Promise.reject(conflict);
    }
    this.preferenceAuthority.portfolioBoardPreferenceMutationState = 'pending';
    // Automatic normalization starts before renderBoard() returns its handle. Defer the
    // remount notification so ProjectsPanel can first own and later destroy that handle.
    queueMicrotask(() => {
      for (const listener of this.preferenceAuthority.portfolioBoardPreferenceMutationListeners)
        listener();
    });
    return this.updatePortfolioPreference(mutate).then(
      (settled) => {
        this.preferenceAuthority.portfolioBoardPreferenceMutationState = 'idle';
        for (const listener of this.preferenceAuthority.portfolioBoardPreferenceMutationListeners)
          listener();
        return settled;
      },
      (error: unknown) => {
        this.preferenceAuthority.portfolioBoardPreferenceMutationState = 'failed';
        for (const listener of this.preferenceAuthority.portfolioBoardPreferenceMutationListeners)
          listener();
        for (const listener of this.preferenceAuthority.portfolioPreferenceFailureListeners)
          listener(error);
        throw error;
      },
    );
  }

  subscribePortfolioPreference(
    listener: (next: CollectionPreferenceSnapshot<PortfolioCollectionPreference>) => void,
  ): () => void {
    return this.coordinator.subscribePreference('projects:portfolio', listener as never);
  }

  subscribePortfolioPreferenceFailure(listener: (error: unknown) => void): () => void {
    this.preferenceAuthority.portfolioPreferenceFailureListeners.add(listener);
    return () => this.preferenceAuthority.portfolioPreferenceFailureListeners.delete(listener);
  }

  subscribePortfolioBoardPreferenceMutation(listener: () => void): () => void {
    this.preferenceAuthority.portfolioBoardPreferenceMutationListeners.add(listener);
    return () =>
      this.preferenceAuthority.portfolioBoardPreferenceMutationListeners.delete(listener);
  }

  portfolioBoardPreferenceSaving(): boolean {
    return this.preferenceAuthority.portfolioBoardPreferenceMutationState === 'pending';
  }

  shouldAutoPersistPortfolioBoardPreference(): boolean {
    return this.preferenceAuthority.portfolioBoardPreferenceMutationState === 'idle';
  }

  collectionScopeKey(path: string, scope: ProjectWorkspaceScope): CollectionScopeKey {
    return `project:${path}:${scope}`;
  }

  collectionSession(path: string, scope: ProjectWorkspaceScope): CollectionSessionState {
    return this.sessionPort.read(this.collectionScopeKey(path, scope));
  }

  subscribeCollectionSession(
    path: string,
    scope: ProjectWorkspaceScope,
    listener: (next: CollectionSessionState) => void,
  ): () => void {
    return this.sessionPort.subscribe(this.collectionScopeKey(path, scope), listener);
  }

  collectionPreference<S extends ProjectWorkspaceScope>(
    path: string,
    scope: S,
  ): WorkspacePreferenceFor<S> {
    return this.coordinator.preference(
      this.collectionScopeKey(path, scope),
    ) as WorkspacePreferenceFor<S>;
  }

  subscribeCollectionPreference<S extends ProjectWorkspaceScope>(
    path: string,
    scope: S,
    listener: (next: WorkspacePreferenceFor<S>) => void,
  ): () => void {
    const key = this.preferencePort.resolveScope(this.collectionScopeKey(path, scope));
    return this.coordinator.subscribePreference(key, (next) =>
      listener(next.preference as WorkspacePreferenceFor<S>),
    );
  }

  updateCollectionPreference<S extends ProjectWorkspaceScope>(
    path: string,
    scope: S,
    mutate: (current: WorkspacePreferenceFor<S>) => WorkspacePreferenceFor<S>,
  ): Promise<WorkspacePreferenceFor<S>> {
    const key = this.preferencePort.resolveScope(this.collectionScopeKey(path, scope));
    if (this.preferenceAuthority.collectionPreferenceMutationStates.get(key) === 'pending') {
      const conflict = new CollectionPreferenceConflictError();
      queueMicrotask(() => {
        for (const listener of this.preferenceAuthority.collectionPreferenceFailureListeners.get(
          key,
        ) ?? [])
          listener(conflict);
      });
      return Promise.reject(conflict);
    }
    this.preferenceAuthority.collectionPreferenceMutationStates.set(key, 'pending');
    queueMicrotask(() => {
      for (const listener of this.preferenceAuthority.collectionPreferenceMutationListeners.get(
        key,
      ) ?? [])
        listener();
    });
    const current = this.coordinator.preferenceSnapshot(key) as CollectionPreferenceSnapshot<
      WorkspacePreferenceFor<S>
    >;
    return this.coordinator.updatePreference(key, current, mutate(current.preference)).then(
      (next) => {
        const settledKey = this.preferencePort.resolveScope(key);
        this.preferenceAuthority.collectionPreferenceMutationStates.set(settledKey, 'idle');
        for (const listener of this.preferenceAuthority.collectionPreferenceMutationListeners.get(
          settledKey,
        ) ?? [])
          listener();
        this.preferencePort.releaseScopeAliases(key);
        return next.preference as WorkspacePreferenceFor<S>;
      },
      (error: unknown) => {
        const settledKey = this.preferencePort.resolveScope(key);
        this.preferenceAuthority.collectionPreferenceMutationStates.set(settledKey, 'failed');
        for (const listener of this.preferenceAuthority.collectionPreferenceMutationListeners.get(
          settledKey,
        ) ?? [])
          listener();
        for (const listener of this.preferenceAuthority.collectionPreferenceFailureListeners.get(
          settledKey,
        ) ?? [])
          listener(error);
        this.preferencePort.releaseScopeAliases(key);
        throw error;
      },
    );
  }

  subscribeCollectionPreferenceFailure(
    path: string,
    scope: ProjectWorkspaceScope,
    listener: (error: unknown) => void,
  ): () => void {
    const key = this.preferencePort.resolveScope(this.collectionScopeKey(path, scope));
    const listeners =
      this.preferenceAuthority.collectionPreferenceFailureListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.preferenceAuthority.collectionPreferenceFailureListeners.set(key, listeners);
    return () => {
      for (const [listenerKey, scoped] of this.preferenceAuthority
        .collectionPreferenceFailureListeners) {
        scoped.delete(listener);
        if (scoped.size === 0)
          this.preferenceAuthority.collectionPreferenceFailureListeners.delete(listenerKey);
      }
    };
  }

  subscribeCollectionPreferenceMutation(
    path: string,
    scope: ProjectWorkspaceScope,
    listener: () => void,
  ): () => void {
    const key = this.preferencePort.resolveScope(this.collectionScopeKey(path, scope));
    const listeners =
      this.preferenceAuthority.collectionPreferenceMutationListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.preferenceAuthority.collectionPreferenceMutationListeners.set(key, listeners);
    return () => {
      for (const [listenerKey, scoped] of this.preferenceAuthority
        .collectionPreferenceMutationListeners) {
        scoped.delete(listener);
        if (scoped.size === 0)
          this.preferenceAuthority.collectionPreferenceMutationListeners.delete(listenerKey);
      }
    };
  }

  collectionPreferenceSaving(path: string, scope: ProjectWorkspaceScope): boolean {
    return (
      this.preferenceAuthority.collectionPreferenceMutationStates.get(
        this.preferencePort.resolveScope(this.collectionScopeKey(path, scope)),
      ) === 'pending'
    );
  }

  shouldAutoPersistCollectionPreference(path: string, scope: ProjectWorkspaceScope): boolean {
    return (
      (this.preferenceAuthority.collectionPreferenceMutationStates.get(
        this.preferencePort.resolveScope(this.collectionScopeKey(path, scope)),
      ) ?? 'idle') === 'idle'
    );
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
    this.sessionPort.release(this.collectionScopeKey(path, 'tasks'));
    this.sessionPort.release(this.collectionScopeKey(path, 'work-notes'));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const path of this.sessions.keys()) this.releaseProject(path);
    this.sessionPort.release('tasks:main');
    this.sessionPort.release('project:__idle__:tasks');
    this.sessionPort.release('project:__idle__:work-notes');
    this.projectPath = null;
    this.mainTaskPreferencePort.dispose();
    this.mainTaskCoordinator.invalidatePreferences();
    releaseProjectWorkspacePreferenceAuthority(this.preferenceAuthority);
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
    const entry = existing ?? workspaceEntry(this.coordinator, this.sessionPort, path);
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
    const scopedMoves = (['tasks', 'work-notes'] as const).map((scope) => ({
      source: this.collectionScopeKey(sourcePath, scope),
      destination: this.collectionScopeKey(destinationPath, scope),
    }));
    this.preferencePort.renameProject(sourcePath, destinationPath);
    for (const { source: sourceScope, destination: destinationScope } of scopedMoves) {
      this.rekeySharedCollectionAuthority(sourceScope, destinationScope);
      this.coordinator.invalidatePreference(sourceScope);
      this.coordinator.invalidatePreference(destinationScope);
    }
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
      this.sessionPort.release(this.collectionScopeKey(destinationPath, 'tasks'));
      this.sessionPort.release(this.collectionScopeKey(destinationPath, 'work-notes'));
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

  private rekeySharedCollectionAuthority(
    source: CollectionScopeKey,
    destination: CollectionScopeKey,
  ): void {
    const states = this.preferenceAuthority.collectionPreferenceMutationStates;
    const sourceState = states.get(source);
    if (sourceState !== undefined) states.set(destination, sourceState);
    states.delete(source);
    const moveListeners = <T>(map: Map<CollectionScopeKey, Set<T>>): void => {
      const sourceListeners = map.get(source);
      if (!sourceListeners) return;
      const existingDestination = map.get(destination);
      const destinationListeners = existingDestination ?? sourceListeners;
      if (existingDestination) {
        for (const listener of sourceListeners) destinationListeners.add(listener);
      }
      map.set(destination, destinationListeners);
      map.delete(source);
    };
    moveListeners(this.preferenceAuthority.collectionPreferenceMutationListeners);
    moveListeners(this.preferenceAuthority.collectionPreferenceFailureListeners);
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
