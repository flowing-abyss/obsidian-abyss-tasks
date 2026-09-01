import type { CalendarSettings, ProjectTasksViewState } from '../settings/types';
import { StatusRegistry } from '../status/StatusRegistry';
import { selectTaskCollection } from '../task-lists/TaskListSelector';
import type { TaskSnapshot } from '../tasks';
import { NEXT_ACTION_TAG } from './NextActionService';
import { addCivilDays } from './projectDates';
import type { ProjectAction } from './types';

function key(task: TaskSnapshot): string {
  return `${task.ref.filePath}\0${task.ref.line}\0${task.ref.revision}`;
}

function compareCreated(left: TaskSnapshot, right: TaskSnapshot): number {
  const a = left.planning.created;
  const b = right.planning.created;
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a.localeCompare(b);
}

function projectTieBreak(
  actionByTask: ReadonlyMap<string, ProjectAction>,
  left: TaskSnapshot,
  right: TaskSnapshot,
): number {
  const leftAction = actionByTask.get(key(left));
  const rightAction = actionByTask.get(key(right));
  const sourceOrder =
    Number(leftAction?.owner.type === 'work-note') -
    Number(rightAction?.owner.type === 'work-note');
  return (
    sourceOrder ||
    compareCreated(left, right) ||
    left.source.filePath.localeCompare(right.source.filePath) ||
    left.source.line - right.source.line
  );
}

function groupKey(
  task: TaskSnapshot,
  groupBy: ProjectTasksViewState['groupBy'],
  today: string,
  tomorrow: string,
  statusRegistry: StatusRegistry | undefined,
): string {
  if (groupBy === 'date') {
    const date = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
    if (!date) return 'no-date';
    if (date < today) return 'overdue';
    if (date === today) return 'today';
    return date === tomorrow ? 'tomorrow' : 'upcoming';
  }
  if (groupBy === 'priority') return task.priority ?? 'D';
  if (groupBy === 'tag') return task.tags[0] ?? 'none';
  if (groupBy === 'status') return statusRegistry?.bySymbol(task.statusSymbol)?.id ?? '__other__';
  return 'all';
}

function pinNextActionWithinGroups(
  actions: readonly ProjectAction[],
  viewState: ProjectTasksViewState,
  settings: CalendarSettings,
  today: string,
  projectedState: ((task: TaskSnapshot) => boolean | undefined) | undefined,
): readonly ProjectAction[] {
  const tomorrow = addCivilDays(today, 1) ?? today;
  const statusRegistry =
    viewState.groupBy === 'status' ? new StatusRegistry(settings.taskStatuses) : undefined;
  const keyOf = (task: TaskSnapshot): string =>
    groupKey(task, viewState.groupBy, today, tomorrow, statusRegistry);
  const grouped = new Map<string, { pinned: ProjectAction[]; ordinary: ProjectAction[] }>();
  for (const action of actions) {
    const group = keyOf(action.task);
    const bucket = grouped.get(group) ?? { pinned: [], ordinary: [] };
    const pinned = projectedState?.(action.task) ?? action.task.tags.includes(NEXT_ACTION_TAG);
    bucket[pinned ? 'pinned' : 'ordinary'].push(action);
    grouped.set(group, bucket);
  }
  const ordered = new Map(
    [...grouped].map(([group, bucket]) => [group, [...bucket.pinned, ...bucket.ordinary]] as const),
  );
  const indices = new Map<string, number>();
  return actions.map((action) => {
    const group = keyOf(action.task);
    const index = indices.get(group) ?? 0;
    indices.set(group, index + 1);
    return ordered.get(group)![index]!;
  });
}

export interface SelectProjectTasksInput {
  readonly actions: readonly ProjectAction[];
  readonly viewState: ProjectTasksViewState;
  readonly settings: CalendarSettings;
  readonly today: string;
  readonly textQuery?: string;
  readonly nextActionState?: (task: TaskSnapshot) => boolean | undefined;
}

/** Selects joined direct and inherited Project actions with the canonical task-list semantics. */
export function selectProjectTasks(input: SelectProjectTasksInput): readonly ProjectAction[] {
  const actionByTask = new Map(input.actions.map((action) => [key(action.task), action]));
  const selected = selectTaskCollection({
    tasks: input.actions.map(({ task }) => task),
    viewState: input.viewState,
    settings: input.settings,
    ...(input.textQuery !== undefined && { textQuery: input.textQuery }),
    tieBreak: (left, right) => projectTieBreak(actionByTask, left, right),
  }).flatMap((task) => {
    const action = actionByTask.get(key(task));
    return action ? [action] : [];
  });
  return pinNextActionWithinGroups(
    selected,
    input.viewState,
    input.settings,
    input.today,
    input.nextActionState,
  );
}
