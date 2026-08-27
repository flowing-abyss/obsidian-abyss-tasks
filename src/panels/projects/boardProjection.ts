import type { ProjectPropertyCommandResult } from '../../projects/ProjectCommandService';
import type { Project, ProjectAction } from '../../projects/types';
import type {
  WorkNoteCommandResult,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
import type { ProjectStatus, TaskStatusDef } from '../../settings/types';
import type { TaskCommandResult, TaskSnapshot } from '../../tasks';

export interface BoardColumn<T> {
  readonly key: string;
  readonly label: string;
  readonly role: 'terminal-left' | 'regular' | 'unmapped' | 'terminal-right';
  readonly items: readonly T[];
}

export type BoardMutationResult =
  | ProjectPropertyCommandResult
  | WorkNoteCommandResult
  | TaskCommandResult
  | void;

export interface BoardStatusAction {
  readonly columnKey: string;
  readonly label: string;
  readonly icon: string;
  readonly checked: boolean;
  readonly disabled: boolean;
}

export interface BoardMutation<T> {
  move(item: T, columnKey: string): Promise<BoardMutationResult>;
  menuItems(item: T): readonly BoardStatusAction[];
}

/** Work Notes gain board mutation support only after their guarded writer exists. */
export function projectBoardTasks(actions: readonly ProjectAction[]): readonly TaskSnapshot[] {
  return actions.filter(({ owner }) => owner.type === 'project').map(({ task }) => task);
}

function projectRole(status: ProjectStatus): Exclude<BoardColumn<Project>['role'], 'unmapped'> {
  if (status.behavior === 'dropped') return 'terminal-left';
  if (status.behavior === 'published') return 'terminal-right';
  return 'regular';
}

/** Projects keep configured non-terminal order while terminal outcomes bookend the board. */
export function projectBoardColumns(
  statuses: readonly ProjectStatus[],
  projects: readonly Project[] = [],
): readonly BoardColumn<Project>[] {
  const columnFor = (status: ProjectStatus): BoardColumn<Project> => ({
    key: status.id,
    label: status.label,
    role: projectRole(status),
    items: projects.filter((project) => project.statusId === status.id),
  });
  const dropped = statuses
    .filter((status) => projectRole(status) === 'terminal-left')
    .map(columnFor);
  const regular = statuses.filter((status) => projectRole(status) === 'regular').map(columnFor);
  const published = statuses
    .filter((status) => projectRole(status) === 'terminal-right')
    .map(columnFor);
  const unmapped: BoardColumn<Project> = {
    key: 'unmapped',
    label: 'Unmapped',
    role: 'unmapped',
    items: projects.filter((project) => project.statusId === null),
  };
  return [...dropped, ...regular, unmapped, ...published];
}

/** Each configured task status remains an independent column, even when types match. */
export function taskBoardColumns(
  statuses: readonly TaskStatusDef[],
  tasks: readonly TaskSnapshot[] = [],
): readonly BoardColumn<TaskSnapshot>[] {
  const configuredSymbols = new Set(statuses.map(({ symbol }) => symbol));
  const columns: BoardColumn<TaskSnapshot>[] = statuses.map((status) => ({
    key: status.id,
    label: status.name,
    role: 'regular',
    items: tasks.filter((task) => task.statusSymbol === status.symbol),
  }));
  const unmapped = tasks.filter((task) => !configuredSymbols.has(task.statusSymbol));
  if (unmapped.length > 0) {
    columns.push({ key: 'unmapped', label: 'Unmapped', role: 'unmapped', items: unmapped });
  }
  return columns;
}

/** Work Notes use the Project lifecycle catalog without becoming Project records. */
export function workNoteBoardColumns(
  statuses: readonly WorkNoteStatusDefinition[],
  notes: readonly WorkNoteSnapshot[] = [],
): readonly BoardColumn<WorkNoteSnapshot>[] {
  const columns: BoardColumn<WorkNoteSnapshot>[] = statuses.map((status) => ({
    key: status.id,
    label: status.label,
    role: 'regular',
    items: notes.filter((note) => note.statusId === status.id),
  }));
  columns.push({
    key: 'unmapped',
    label: 'Unmapped',
    role: 'unmapped',
    items: notes.filter((note) => note.statusId === null),
  });
  return columns;
}

export function createProjectBoardMutation(
  statuses: readonly ProjectStatus[],
  command: (project: Project, statusId: string) => Promise<ProjectPropertyCommandResult>,
): BoardMutation<Project> {
  return {
    move: (project, columnKey) => {
      if (!statuses.some(({ id }) => id === columnKey) || project.statusId === columnKey) {
        return Promise.resolve();
      }
      return command(project, columnKey);
    },
    menuItems: (project) =>
      statuses.map((status) => ({
        columnKey: status.id,
        label: status.label,
        icon: 'circle-dot',
        checked: status.id === project.statusId,
        disabled: status.id === project.statusId,
      })),
  };
}

export function createTaskBoardMutation(
  statuses: readonly TaskStatusDef[],
  command: (task: TaskSnapshot, symbol: string) => Promise<BoardMutationResult>,
): BoardMutation<TaskSnapshot> {
  return {
    move: (task, columnKey) => {
      const status = statuses.find(({ id }) => id === columnKey);
      if (!status || status.symbol === task.statusSymbol) return Promise.resolve();
      return command(task, status.symbol);
    },
    menuItems: (task) =>
      statuses.map((status) => ({
        columnKey: status.id,
        label: status.name,
        icon: status.icon,
        checked: status.symbol === task.statusSymbol,
        disabled: status.symbol === task.statusSymbol,
      })),
  };
}

/** Canonical configured Work Note status model shared by drag and native menus. */
export function createWorkNoteBoardMutation(
  statuses: readonly WorkNoteStatusDefinition[],
  command: (note: WorkNoteSnapshot, statusId: string) => Promise<WorkNoteCommandResult>,
): BoardMutation<WorkNoteSnapshot> {
  return {
    move: (note, columnKey) => {
      if (!statuses.some(({ id }) => id === columnKey) || note.statusId === columnKey) {
        return Promise.resolve();
      }
      return command(note, columnKey);
    },
    menuItems: (note) => workNoteStatusMenuModel(statuses, note),
  };
}

export function workNoteStatusMenuModel(
  statuses: readonly WorkNoteStatusDefinition[],
  note: WorkNoteSnapshot,
): readonly BoardStatusAction[] {
  return statuses.map((status) => ({
    columnKey: status.id,
    label: status.label,
    icon: 'circle-dot',
    checked: status.id === note.statusId,
    disabled: status.id === note.statusId,
  }));
}
