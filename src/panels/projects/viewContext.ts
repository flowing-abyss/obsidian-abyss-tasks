import type { AppState } from '../../app/AppState';
import type { ProjectAction } from '../../projects/types';
import type { CalendarSettings } from '../../settings/types';

export interface ProjectsListContext {
  state: AppState;
  settings: CalendarSettings;
  onCreate: (name: string) => Promise<void>;
  onSetStatus: (path: string, statusId: string) => void;
  openNote: (path: string) => void;
}

export interface ProjectsDashboardContext {
  state: AppState;
  settings: CalendarSettings;
  onSetStatus: (path: string, statusId: string) => void;
  openNote: (path: string) => void;
  /** Renders the project's tasks into `host` (wired by PanelView to reuse task rendering). */
  renderTasks: (host: HTMLElement, path: string, tasks: readonly ProjectAction[]) => void;
}
