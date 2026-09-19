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
} from './application/TaskApplicationApi';
export { cloneTaskSnapshot } from './domain/cloneTaskSnapshot';
export type {
  ArchiveRecovery,
  CreateDependencySubtaskCommand,
  MoveRecovery,
  PlanningTarget,
  SubtaskPatch,
  TaskCommand,
  TaskCommandResult,
  TaskOccurrenceResult,
  TaskPatch,
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
  taskReconciliationKey,
  type TaskResolution,
} from './domain/taskReconciliation';
export { normalizeTaskTagInput } from './domain/taskTags';
export { sameTaskTreeWithOwnedChanges } from './domain/taskTreeChangeProof';
export { sameTaskNodeRef } from './domain/types';
export type {
  CommentRef,
  DateRange,
  LocalDate,
  SubtaskRef,
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskInsertionPolicy,
  TaskNodeRef,
  TaskPlanning,
  TaskPriority,
  TaskRef,
  TaskSnapshot,
  TaskStatusType,
  TaskTextTarget,
} from './domain/types';
export { durationMinutes, localDate, localTime } from './domain/validation';
