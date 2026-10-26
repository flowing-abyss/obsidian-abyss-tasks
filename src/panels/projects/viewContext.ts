import type { App } from 'obsidian';
import type { AppState } from '../../app/AppState';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import type { Project } from '../../projects/types';
import type { CalendarSettings } from '../../settings/types';
import type { ProjectCellEditSession } from './ProjectCellEditor';

export interface ProjectsDashboardContext {
  editor?: {
    readonly app: App;
    readonly catalog: ProjectPropertyCatalog;
    readonly capture: (
      project: Project,
      field: ProjectFieldCatalogItem,
    ) => ProjectCellEditSession | undefined;
  };
  finishEditorBefore?: (action: () => void) => void;
  state: AppState;
  settings: CalendarSettings;
  onSetStatus: (path: string, statusId: string) => void;
  openNote: (path: string) => void;
  /** Renders the project's tasks into `host` (wired by PanelView to reuse task rendering). */
  renderTasks: (host: HTMLElement, path: string) => void;
}
