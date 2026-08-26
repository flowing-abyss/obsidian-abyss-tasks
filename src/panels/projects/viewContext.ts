import type { AppState } from '../../app/AppState';
import type { ProjectAction } from '../../projects/types';
import type { CalendarSettings } from '../../settings/types';

export function joinedNextAction(actions: readonly ProjectAction[]): ProjectAction | undefined {
  return actions.find(({ task }) => task.tags?.includes('#task/next_action') === true);
}

export interface ProjectsListContext {
  state: AppState;
  settings: CalendarSettings;
  onSaveSettings: () => Promise<void>;
  onFiltersChanged?: () => void;
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
