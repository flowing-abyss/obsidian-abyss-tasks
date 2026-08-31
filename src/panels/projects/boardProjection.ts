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

export interface ProjectBoardProjectionOptions {
  readonly columnOrder?: readonly string[];
  readonly includeUnmapped?: boolean;
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

function projectRole(status: ProjectStatus): Exclude<BoardColumn<Project>['role'], 'unmapped'> {
  if (status.behavior === 'dropped') return 'terminal-left';
  if (status.behavior === 'published') return 'terminal-right';
  return 'regular';
}

/** Projects keep configured non-terminal order while terminal outcomes bookend the board. */
export function projectBoardColumns(
  statuses: readonly ProjectStatus[],
  projects: readonly Project[] = [],
  options: ProjectBoardProjectionOptions = {},
): readonly BoardColumn<Project>[] {
  const columnFor = (status: ProjectStatus): BoardColumn<Project> => ({
    key: status.id,
    label: status.label,
    role: projectRole(status),
    items: projects.filter((project) => project.statusId === status.id),
  });
  const configuredById = new Map(statuses.map((status) => [status.id, status]));
  const storedOrder = options.columnOrder ?? statuses.map(({ id }) => id);
  const orderedStatuses = [
    ...storedOrder.flatMap((id) => {
      const status = configuredById.get(id);
      return status ? [status] : [];
    }),
    ...statuses.filter((status) => !storedOrder.includes(status.id)),
  ];
  const dropped = statuses
    .filter((status) => projectRole(status) === 'terminal-left')
    .map(columnFor);
  const regular = orderedStatuses
    .filter((status) => projectRole(status) === 'regular')
    .map(columnFor);
  const published = statuses
    .filter((status) => projectRole(status) === 'terminal-right')
    .map(columnFor);
  const unmapped: BoardColumn<Project> = {
    key: 'unmapped',
    label: 'Unmapped',
    role: 'unmapped',
    items: projects.filter((project) => project.statusId === null),
  };
  return [
    ...dropped,
    ...regular,
    ...(options.includeUnmapped === false ? [] : [unmapped]),
    ...published,
  ];
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

/** Project Actions retain dependency/ownership presentation through the bounded board shell. */
export function projectActionBoardColumns(
  statuses: readonly TaskStatusDef[],
  actions: readonly ProjectAction[] = [],
): readonly BoardColumn<ProjectAction>[] {
  const configuredSymbols = new Set(statuses.map(({ symbol }) => symbol));
  const columns: BoardColumn<ProjectAction>[] = statuses.map((status) => ({
    key: status.id,
    label: status.name,
    role: 'regular',
    items: actions.filter(({ task }) => task.statusSymbol === status.symbol),
  }));
  const unmapped = actions.filter(({ task }) => !configuredSymbols.has(task.statusSymbol));
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
    menuItems: (project) => projectStatusMenuModel(statuses, project),
  };
}

/** Canonical Project status action model shared by every Project status menu. */
export function projectStatusMenuModel(
  statuses: readonly ProjectStatus[],
  project: Pick<Project, 'statusId'>,
): readonly BoardStatusAction[] {
  return statuses.map((status) => ({
    columnKey: status.id,
    label: status.label,
    icon: 'circle-dot',
    checked: status.id === project.statusId,
    disabled: status.id === project.statusId,
  }));
}

const PROJECT_PRIORITIES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/** Canonical Project priority action model shared by Project table and Board menus. */
export function projectPriorityMenuModel(
  project: Pick<Project, 'priority'>,
): readonly BoardStatusAction[] {
  return PROJECT_PRIORITIES.map((priority) => ({
    columnKey: priority,
    label: priority,
    icon: 'flag',
    checked: priority === project.priority,
    disabled: priority === project.priority,
  }));
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

export function createProjectActionBoardMutation(
  statuses: readonly TaskStatusDef[],
  command: (task: TaskSnapshot, symbol: string) => Promise<BoardMutationResult>,
): BoardMutation<ProjectAction> {
  const mutation = createTaskBoardMutation(statuses, command);
  return {
    move: (action, columnKey) => mutation.move(action.task, columnKey),
    menuItems: (action) => mutation.menuItems(action.task),
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
