import type { AppState } from '../../app/AppState';
import type { ProjectCreateResult } from '../../projects/ProjectManager';
import type { ProjectAction, ProjectPriority } from '../../projects/types';
import type { WorkNoteSnapshot, WorkNoteStatusDefinition } from '../../projects/work-notes/types';
import type {
  CalendarSettings,
  ProjectTasksViewState,
  PropertyFilter,
  WorkNotesViewState,
} from '../../settings/types';
import type { ProjectCaptureSession, ProjectWorkspaceSession } from './ProjectWorkspaceSession';

/** Lifecycle owned by a Project dashboard child renderer. */
export interface ProjectChildRenderHandle {
  destroy(): void;
}

export function joinedNextAction(actions: readonly ProjectAction[]): ProjectAction | undefined {
  return actions.find(({ task }) => task.tags?.includes('#task/next_action') === true);
}

export interface ProjectsListContext {
  state: AppState;
  settings: CalendarSettings;
  onSaveSettings: () => Promise<void>;
  collectionState?: ProjectWorkspaceSession;
  onFiltersChanged?: () => void;
  onPortfolioLayoutChanged?: () => void;
  onCaptureSettled?: () => void;
  timelineAvailable?: boolean;
  /** Safe built-in/frontmatter descriptors exposed by the shared Fields menu. */
  portfolioFields?: readonly (readonly [string, string])[];
  captureSession?: ProjectCaptureSession;
  today?: () => string;
  onCreate: (name: string) => Promise<ProjectCreateResult>;
  onSetStatus: (path: string, statusId: string) => void;
  onSetPriority?: (path: string, priority: ProjectPriority | null) => void;
  openNote: (path: string) => void;
  /** Overview body adapter; the list shell remains the owner of toolbar/capture continuity. */
  renderOverview?: (
    host: HTMLElement,
    snapshots: readonly import('../../projects/types').ProjectWorkspaceSnapshot[],
  ) => ProjectChildRenderHandle;
}

export interface ProjectsDashboardContext {
  state: AppState;
  settings: CalendarSettings;
  onSaveSettings?: () => Promise<void>;
  onSetStatus: (path: string, statusId: string) => void;
  openNote: (path: string) => void;
  workspaceSession?: ProjectWorkspaceSession;
  /** Renders the project's tasks into `host` (wired by PanelView to reuse task rendering). */
  renderTasks: (
    host: HTMLElement,
    path: string,
    tasks: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
    allTasks?: readonly ProjectAction[],
    onAddPropertyFilter?: (filter: PropertyFilter) => void,
  ) => ProjectChildRenderHandle;
  /** Renders the same task cards through the shared status-board shell. */
  renderTaskBoard?: (
    host: HTMLElement,
    path: string,
    tasks: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
    allTasks?: readonly ProjectAction[],
    onAddPropertyFilter?: (filter: PropertyFilter) => void,
  ) => ProjectChildRenderHandle;
  /** Renders dated Project Tasks through the shared Timeline shell. */
  renderTaskTimeline?: (
    host: HTMLElement,
    path: string,
    tasks: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
    allTasks?: readonly ProjectAction[],
    onAddPropertyFilter?: (filter: PropertyFilter) => void,
  ) => ProjectChildRenderHandle;
  /** Renders rich supporting notes without projecting them into checkbox Tasks. */
  renderWorkNotes?: (
    host: HTMLElement,
    path: string,
    notes: readonly WorkNoteSnapshot[],
    viewState: WorkNotesViewState,
  ) => ProjectChildRenderHandle;
  /** Renders the same Work Notes through the shared guarded board shell. */
  renderWorkNoteBoard?: (
    host: HTMLElement,
    path: string,
    notes: readonly WorkNoteSnapshot[],
  ) => ProjectChildRenderHandle;
  /** Renders dated Work Notes through the shared Timeline shell. */
  renderWorkNoteTimeline?: (
    host: HTMLElement,
    path: string,
    notes: readonly WorkNoteSnapshot[],
  ) => ProjectChildRenderHandle;
  /** Applies the configured Work Note filter/sort before alternate layouts render. */
  selectWorkNotes?: (
    notes: readonly WorkNoteSnapshot[],
    viewState: WorkNotesViewState,
    textQuery: string,
  ) => readonly WorkNoteSnapshot[];
  /** Audited compatibility catalog shared by the Work Note filter and selector. */
  workNoteStatuses?: readonly WorkNoteStatusDefinition[];
  /** Eligible records or an audited create capability make the optional scope visible. */
  workNotesAvailable?: boolean;
  /** Explicit capability state distinguishes disabled setup from an invalid enabled source. */
  workNotesAvailability?:
    | { readonly state: 'hidden' | 'available' }
    | { readonly state: 'invalid'; readonly reason: string };
  onOpenWorkNotesSettings?: () => void;
  /** Deterministic civil day for Project health presentation tests. */
  today?: () => string;
}
