import type { CalendarSettings, ProjectTasksViewState } from '../settings/types';
import { selectTaskCollection } from '../task-lists/TaskListSelector';
import type { TaskSnapshot } from '../tasks';
import { NEXT_ACTION_TAG } from './NextActionService';
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
  const nextActionOrder =
    Number(!left.tags.includes(NEXT_ACTION_TAG)) - Number(!right.tags.includes(NEXT_ACTION_TAG));
  return (
    nextActionOrder ||
    sourceOrder ||
    compareCreated(left, right) ||
    left.source.filePath.localeCompare(right.source.filePath) ||
    left.source.line - right.source.line
  );
}

export interface SelectProjectTasksInput {
  readonly actions: readonly ProjectAction[];
  readonly viewState: ProjectTasksViewState;
  readonly settings: CalendarSettings;
  readonly textQuery?: string;
}

/** Selects joined direct and inherited Project actions with the canonical task-list semantics. */
export function selectProjectTasks(input: SelectProjectTasksInput): readonly ProjectAction[] {
  const actionByTask = new Map(input.actions.map((action) => [key(action.task), action]));
  return selectTaskCollection({
    tasks: input.actions.map(({ task }) => task),
    viewState: input.viewState,
    settings: input.settings,
    ...(input.textQuery !== undefined && { textQuery: input.textQuery }),
    tieBreak: (left, right) => projectTieBreak(actionByTask, left, right),
  }).flatMap((task) => {
    const action = actionByTask.get(key(task));
    return action ? [action] : [];
  });
}
