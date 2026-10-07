export type {
  CalendarProjectionSources,
  CalendarTaskSource,
  CreateTaskCommandInitial,
  TaskApplicationApi,
  TaskArchiveSession,
  TaskCaptureApplicationApi,
  TaskCreateSession,
  TaskDependencyQueryApi,
  TaskIndexEvent,
  TaskQueryApi,
  TaskSearchEligibilityBatch,
  TaskSearchEligibilityRequest,
  TimeTrackingQueryApi,
} from './application/TaskApplicationApi';
export { cloneTaskSnapshot } from './domain/cloneTaskSnapshot';
export type {
  ArchiveRecovery,
  CreateDependencySubtaskCommand,
  FieldUpdate,
  MoveRecovery,
  PlanningTarget,
  SubtaskPatch,
  TaskCommand,
  TaskCommandResult,
  TaskOccurrenceResult,
  TaskPatch,
  TimeEntryRemovalRecovery,
} from './domain/commands';
export {
  formatCommentTimeLabel,
  type CommentTimeContext,
  type CommentTimeContextProvider,
} from './domain/commentTimeLabel';
export { dependencySubtaskChild } from './domain/dependencySubtaskProof';
export { daysBetweenLocalDates, shiftLocalDate } from './domain/localDateMath';
export {
  expandRecurrenceReferences,
  parseRecurrenceRule,
  type RecurrenceParseResult,
  type RecurrencePolicy,
} from './domain/recurrence';
export { taskCommandRootRef } from './domain/taskCommandTargets';
export type {
  DependencyDirection,
  TaskDependencyEligibility,
  TaskDependencyProjection,
  TaskDependencyRelation,
  TaskNodeSnapshot,
} from './domain/taskDependencies';
export {
  sameTaskTreeExceptDependencies,
  sameTaskTreeExceptTimeEntries,
  taskReconciliationKey,
  type CompletionTrackingWitness,
  type TaskResolution,
} from './domain/taskReconciliation';
export { normalizeTaskTagInput, taskPrefixForSubtask } from './domain/taskTags';
export { sameTaskTreeWithOwnedChanges } from './domain/taskTreeChangeProof';
export type { OffsetAt } from './domain/timeEntry';
export {
  entryDurationMs,
  formatTrackedDuration,
  formatTrackedDurationWithSeconds,
  groupTrackedDays,
  localDayStartMs,
  openTimersExtraMs,
  recentTrackingWindow,
  resumeTarget,
  shiftLocalDayStartMs,
  subtreeRunning,
  subtreeTotal,
  taskNodeAddress,
  timeEntryRef,
  totalMs,
  type TimeEntrySnapshot,
  type TrackedDay,
  type TrackedDayRow,
  type TrackedEntry,
  type TrackedTotal,
} from './domain/timeTracking';
export { sameTaskNodeRef } from './domain/types';
export type {
  CommentRef,
  DateRange,
  LocalDate,
  LocalTime,
  SubtaskRef,
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskInsertionPolicy,
  TaskNodeRef,
  TaskPlanning,
  TaskPriority,
  TaskRef,
  TaskSnapshot,
  TaskStatus,
  TaskStatusType,
  TaskTextTarget,
  TimeEntryRef,
} from './domain/types';
export { durationMinutes, localDate, localTime } from './domain/validation';

export { clampDurationToDay } from './domain/taskDuration';

export type { TaskHierarchyRecovery } from './domain/taskHierarchy';

export { hierarchyWouldCycle } from './domain/taskHierarchy';

export type { TaskDependencySummary } from './domain/taskSearchTypes';

export type {
  TaskReadProjectionApi,
  TaskSearchApi,
  TaskSearchState,
} from './application/TaskSearchApi';
export { TaskSearchError } from './domain/taskSearchTypes';
export type {
  TaskOrganizationRecord,
  TaskSearchAddress,
  TaskSearchHit,
  TaskSearchHydratedHit,
} from './domain/taskSearchTypes';

export {
  matchSearchText,
  matchesSearchText,
  prepareSearchQuery,
  type PreparedSearchQuery,
  type SearchWordSegmenter,
} from './domain/searchMatchPolicy';
export {
  taskSearchContext,
  type TaskSearchContext,
  type TaskSearchEvidence,
  type TaskSearchTreeNode,
} from './infrastructure/search/taskSearchContext';

export { createSearchWordSegmenter } from './infrastructure/search/searchWordSegmenter';

export { normalizeCommentText } from './domain/commentText';

export {
  taskHasFutureDate,
  taskOccupiedDates,
  taskTodayOccurrence,
} from './domain/taskOccupiedDates';
export { taskNodeSourceLine } from './domain/taskSearchProjection';

export type { TaskOccurrenceCompletion } from './domain/taskOccupiedDates';
export {
  nodeAtSearchAddress,
  rootTaskNodeSnapshot,
  taskSearchAddressKey,
  taskTreeNodes,
} from './domain/taskSearchProjection';

export type { TaskDateRole } from './domain/taskOccupiedDates';
