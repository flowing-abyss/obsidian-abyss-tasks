import type { AppState } from '../../app/AppState';
import type { ProjectCreateResult } from '../../projects/ProjectManager';
import type { ProjectAction } from '../../projects/types';
import type { WorkNoteSnapshot } from '../../projects/work-notes/types';
import type {
  CalendarSettings,
  ProjectTasksViewState,
  WorkNotesViewState,
} from '../../settings/types';
import type {
  ProjectCaptureSession,
  ProjectWorkspaceSession,
  UseProjectWorkspaceDefaultIntent,
} from './ProjectWorkspaceSession';

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
  onFiltersChanged?: (focusIntent?: 'status-summary') => void;
  onPortfolioLayoutChanged?: () => void;
  onCaptureSettled?: () => void;
  timelineAvailable?: boolean;
  captureSession?: ProjectCaptureSession;
  today?: () => string;
  onCreate: (name: string) => Promise<ProjectCreateResult>;
  onSetStatus: (path: string, statusId: string) => void;
  openNote: (path: string) => void;
}

export interface ProjectsDashboardContext {
  state: AppState;
  settings: CalendarSettings;
  onSetStatus: (path: string, statusId: string) => void;
  openNote: (path: string) => void;
  workspaceSession?: ProjectWorkspaceSession;
  /** Renders the project's tasks into `host` (wired by PanelView to reuse task rendering). */
  renderTasks: (
    host: HTMLElement,
    path: string,
    tasks: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
  ) => ProjectChildRenderHandle;
  /** Renders the same task cards through the shared status-board shell. */
  renderTaskBoard?: (
    host: HTMLElement,
    path: string,
    tasks: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
  ) => ProjectChildRenderHandle;
  /** Renders dated Project Tasks through the shared Timeline shell. */
  renderTaskTimeline?: (
    host: HTMLElement,
    path: string,
    tasks: readonly ProjectAction[],
    viewState: ProjectTasksViewState,
  ) => ProjectChildRenderHandle;
  /** Renders rich supporting notes without projecting them into checkbox Tasks. */
  renderWorkNotes?: (
    host: HTMLElement,
    path: string,
    notes: readonly WorkNoteSnapshot[],
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
  /** Owner callback for the explicit one-way session-to-preference promotion. */
  onUseWorkspaceDefault?: (intent: UseProjectWorkspaceDefaultIntent) => void;
  /** Eligible records or an audited create capability make the optional scope visible. */
  workNotesAvailable?: boolean;
}
