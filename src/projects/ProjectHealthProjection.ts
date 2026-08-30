import { getTaskDateCategory } from '../domain/taskDateCategory';
import { NEXT_ACTION_TAG } from './NextActionService';
import type { ProjectAction, ProjectWorkspaceSnapshot } from './types';

type ProjectHealthSeverity = 'off-track' | 'at-risk' | 'on-track' | 'unknown';

type ProjectHealthReason =
  | { readonly type: 'overdue-next-action'; readonly task: ProjectAction['task']['ref'] }
  | { readonly type: 'blocked-critical-path'; readonly task: ProjectAction['task']['ref'] }
  | { readonly type: 'overdue-actionable-work'; readonly task: ProjectAction['task']['ref'] }
  | { readonly type: 'blocked-next-action'; readonly task: ProjectAction['task']['ref'] }
  | { readonly type: 'unblocked-next-action'; readonly task: ProjectAction['task']['ref'] }
  | { readonly type: 'insufficient-actionable-evidence' };

type ProjectHealthDateSignal =
  | {
      readonly type: 'overdue-actionable-task' | 'future-actionable-task';
      readonly value: string;
      readonly task: ProjectAction['task']['ref'];
    }
  | { readonly type: 'project-range-end' | 'project-range-start'; readonly value: string };

interface ProjectHealthFlags {
  readonly noNextAction: boolean;
  readonly duplicateNextAction: boolean;
  readonly malformedNextAction: boolean;
  readonly dependencyDiagnostics: boolean;
  readonly rangeIssue: ProjectWorkspaceSnapshot['project']['range']['issue'];
  readonly workspaceDiagnostics: boolean;
}

export interface ProjectHealthProjection {
  readonly severity: ProjectHealthSeverity;
  readonly reason: ProjectHealthReason;
  readonly selectedNextAction?: ProjectAction;
  readonly flags: ProjectHealthFlags;
  readonly date?: ProjectHealthDateSignal;
}

export interface ProjectHealthProjectionOptions {
  /** Civil date supplied by the caller so the projection is deterministic at a day boundary. */
  readonly today: string;
}

function isActionable(action: ProjectAction): boolean {
  return action.task.status === 'open' || action.task.status === 'in-progress';
}

function hasNextActionTag(action: ProjectAction): boolean {
  return action.task.tags.includes(NEXT_ACTION_TAG);
}

function priorityRank(priority: ProjectAction['task']['priority']): number {
  return ['A', 'B', 'C', 'D', 'E', 'F'].indexOf(priority);
}

function compareOptionalDate(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}

function compareAction(left: ProjectAction, right: ProjectAction): number {
  const owner = Number(left.owner.type === 'work-note') - Number(right.owner.type === 'work-note');
  return (
    owner ||
    compareOptionalDate(left.task.planning.due, right.task.planning.due) ||
    priorityRank(left.task.priority) - priorityRank(right.task.priority) ||
    compareOptionalDate(left.task.planning.created, right.task.planning.created) ||
    left.task.source.filePath.localeCompare(right.task.source.filePath) ||
    left.task.source.line - right.task.source.line ||
    left.task.ref.revision.localeCompare(right.task.ref.revision)
  );
}

function firstByActionOrder(actions: readonly ProjectAction[]): ProjectAction | undefined {
  return [...actions].sort(compareAction)[0];
}

function relevantTaskDate(action: ProjectAction): string | undefined {
  return action.task.planning.due ?? action.task.planning.scheduled ?? action.task.planning.start;
}

function earliestTaskDate(
  actions: readonly ProjectAction[],
  date: (action: ProjectAction) => string | undefined,
): ProjectAction | undefined {
  return [...actions]
    .filter((action) => date(action) !== undefined)
    .sort(
      (left, right) => date(left)!.localeCompare(date(right)!) || compareAction(left, right),
    )[0];
}

function dateSignal(
  snapshot: ProjectWorkspaceSnapshot,
  actionable: readonly ProjectAction[],
  today: string,
): ProjectHealthDateSignal | undefined {
  const overdue = earliestTaskDate(
    actionable.filter((action) => getTaskDateCategory(action.task, today) === 'overdue'),
    relevantTaskDate,
  );
  if (overdue) {
    return {
      type: 'overdue-actionable-task',
      value: relevantTaskDate(overdue)!,
      task: overdue.task.ref,
    };
  }

  const future = earliestTaskDate(
    actionable.filter((action) => {
      const date = action.task.planning.due ?? action.task.planning.scheduled;
      return date !== undefined && date > today;
    }),
    (action) => action.task.planning.due ?? action.task.planning.scheduled,
  );
  if (future) {
    return {
      type: 'future-actionable-task',
      value: future.task.planning.due ?? future.task.planning.scheduled!,
      task: future.task.ref,
    };
  }

  const range = snapshot.project.range;
  if (range.issue !== 'reversed' && range.end) {
    return { type: 'project-range-end', value: range.end.raw };
  }
  if (range.issue !== 'reversed' && range.start) {
    return { type: 'project-range-start', value: range.start.raw };
  }
  return undefined;
}

/** Projects joined workspace evidence into one read-only, deterministic health summary. */
export function projectHealthProjection(
  snapshot: ProjectWorkspaceSnapshot,
  options: ProjectHealthProjectionOptions,
): ProjectHealthProjection {
  const actionable = snapshot.tasks.filter(isActionable);
  const tagged = snapshot.tasks.filter(hasNextActionTag);
  const selectedNextAction = firstByActionOrder(tagged.filter(isActionable));
  const flags: ProjectHealthFlags = {
    noNextAction: selectedNextAction === undefined,
    duplicateNextAction: tagged.length > 1,
    malformedNextAction: tagged.some((action) => !isActionable(action)),
    dependencyDiagnostics:
      snapshot.dependencies.invalid > 0 || snapshot.dependencies.diagnostics.length > 0,
    rangeIssue: snapshot.project.range.issue,
    workspaceDiagnostics: snapshot.diagnostics.length > 0,
  };
  const overdue = actionable.filter(
    (action) => getTaskDateCategory(action.task, options.today) === 'overdue',
  );
  const blockedCriticalPath = actionable.filter(
    (action) => action !== selectedNextAction && action.dependency.type === 'blocked',
  );
  const overdueOtherWork = overdue.filter((action) => action !== selectedNextAction);
  const date = dateSignal(snapshot, actionable, options.today);

  if (
    selectedNextAction &&
    getTaskDateCategory(selectedNextAction.task, options.today) === 'overdue'
  ) {
    return {
      severity: 'off-track',
      reason: { type: 'overdue-next-action', task: selectedNextAction.task.ref },
      selectedNextAction,
      flags,
      ...(date && { date }),
    };
  }

  const blocked = firstByActionOrder(blockedCriticalPath);
  if (blocked) {
    return {
      severity: 'off-track',
      reason: { type: 'blocked-critical-path', task: blocked.task.ref },
      ...(selectedNextAction && { selectedNextAction }),
      flags,
      ...(date && { date }),
    };
  }

  const overdueOther = earliestTaskDate(overdueOtherWork, relevantTaskDate);
  if (overdueOther) {
    return {
      severity: 'at-risk',
      reason: { type: 'overdue-actionable-work', task: overdueOther.task.ref },
      ...(selectedNextAction && { selectedNextAction }),
      flags,
      ...(date && { date }),
    };
  }

  if (selectedNextAction?.dependency.type === 'blocked') {
    return {
      severity: 'at-risk',
      reason: { type: 'blocked-next-action', task: selectedNextAction.task.ref },
      selectedNextAction,
      flags,
      ...(date && { date }),
    };
  }

  if (selectedNextAction && selectedNextAction.dependency.type === 'allowed') {
    return {
      severity: 'on-track',
      reason: { type: 'unblocked-next-action', task: selectedNextAction.task.ref },
      selectedNextAction,
      flags,
      ...(date && { date }),
    };
  }

  return {
    severity: 'unknown',
    reason: { type: 'insufficient-actionable-evidence' },
    flags,
    ...(date && { date }),
  };
}
