import type { ProjectCreateResult } from '../../projects/ProjectManager';
import type { ProjectTasksViewState, WorkNotesViewState } from '../../settings/types';
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

export interface ProjectWorkspaceScopeSession<TViewState> {
  layout: ProjectWorkspaceLayout;
  textQuery: string;
  viewOverride: TViewState | undefined;
  readonly viewport: LogicalViewportSession;
  readonly selection: ScopeSelectionSession;
  inspectorDirty: boolean;
  captureDraft: string | null;
  effectiveView(defaultView: TViewState): TViewState;
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

export interface UseProjectWorkspaceDefaultIntent {
  readonly scope: ProjectWorkspaceScope;
  readonly viewState: ProjectTasksViewState | WorkNotesViewState;
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
  readonly tasksScope: ProjectWorkspaceScopeSession<ProjectTasksViewState>;
  readonly workNotesScope: ProjectWorkspaceScopeSession<WorkNotesViewState>;
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

function selection(): ScopeSelectionSession {
  return { selectedKeys: [], focusedKey: null, inspectorKey: null };
}

function scopeSession<TViewState>(): ProjectWorkspaceScopeSession<TViewState> {
  return {
    layout: 'list',
    textQuery: '',
    viewOverride: undefined,
    viewport: viewport(),
    selection: selection(),
    inspectorDirty: false,
    captureDraft: null,
    effectiveView(defaultView: TViewState): TViewState {
      return this.viewOverride ?? defaultView;
    },
  };
}

function workspaceEntry(): ProjectWorkspaceEntry {
  const workNotesScope = scopeSession<WorkNotesViewState>();
  return {
    scope: 'tasks',
    tasksScope: scopeSession<ProjectTasksViewState>(),
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
  const copy = scopeSession<TViewState>();
  copy.layout = source.layout;
  copy.textQuery = source.textQuery;
  copy.viewOverride = source.viewOverride && structuredClone(source.viewOverride);
  Object.assign(copy.viewport, source.viewport);
  copy.selection.selectedKeys.push(...source.selection.selectedKeys);
  copy.selection.focusedKey = source.selection.focusedKey;
  copy.selection.inspectorKey = source.selection.inspectorKey;
  copy.inspectorDirty = source.inspectorDirty;
  copy.captureDraft = source.captureDraft;
  return copy;
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

function reconcileSafeArrays<TViewState>(
  source: ProjectWorkspaceScopeSession<TViewState>,
  destination: ProjectWorkspaceScopeSession<TViewState>,
): void {
  if (!source.viewOverride || !destination.viewOverride) return;
  const sourceRecord = source.viewOverride as Record<string, unknown>;
  const destinationRecord = destination.viewOverride as Record<string, unknown>;
  const merged = { ...sourceRecord };
  for (const [key, value] of Object.entries(sourceRecord)) {
    const other = destinationRecord[key];
    if (Array.isArray(value) && Array.isArray(other)) merged[key] = sourceFirst(value, other);
  }
  source.viewOverride = merged as TViewState;
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

/** Ephemeral Project workspace continuity; never persisted to settings or the vault. */
export class ProjectWorkspaceSession {
  private readonly sessions = new Map<string, ProjectWorkspaceEntry>();
  private readonly idle = workspaceEntry();
  private readonly recoveries: ProjectWorkspaceRecoveryEntry[] = [];
  private projectPath: string | null = null;
  private useAsDefaultIntent: UseProjectWorkspaceDefaultIntent | null = null;
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
    const entry = existing ?? workspaceEntry();
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

  requestUseAsDefault(scope: ProjectWorkspaceScope = this.scope): void {
    const viewState = this.scopeSession(scope).viewOverride;
    if (viewState) this.useAsDefaultIntent = { scope, viewState };
  }

  consumeUseAsDefaultIntent(): UseProjectWorkspaceDefaultIntent | null {
    const intent = this.useAsDefaultIntent;
    this.useAsDefaultIntent = null;
    return intent;
  }

  recoveryEntries(): readonly ProjectWorkspaceRecoveryEntry[] {
    return this.recoveries;
  }

  renameProject(sourcePath: string, destinationPath: string): void {
    if (sourcePath === destinationPath) return;
    const source = this.sessions.get(sourcePath);
    if (!source) return;
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
    }
    this.sessions.delete(sourcePath);
    this.sessions.set(destinationPath, source);
    if (this.projectPath === sourcePath) this.projectPath = destinationPath;
    this.evictCleanSessions();
  }

  renamePath(sourcePath: string, destinationPath: string): void {
    if (sourcePath === destinationPath) return;
    this.renameProject(sourcePath, destinationPath);
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
      this.sessions.delete(evicted[0]);
    }
  }
}

/** Named registry alias for owners that want to make Project-path scoping explicit. */
export class ProjectWorkspaceSessionRegistry extends ProjectWorkspaceSession {}
