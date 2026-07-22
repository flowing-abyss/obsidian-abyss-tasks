import type {
  CommentRef,
  DurationMinutes,
  LocalDate,
  LocalTime,
  SubtaskRef,
  TaskDestination,
  TaskMutationTarget,
  TaskNodeRef,
  TaskPriority,
  TaskRef,
  TaskSnapshot,
  TaskTextTarget,
} from './types';
import type { TaskIssue } from './validation';

export type FieldUpdate<T> =
  | { readonly type: 'set'; readonly value: T }
  | { readonly type: 'clear' };

export interface TaskPatch {
  readonly markdownTitle?: FieldUpdate<string>;
  readonly priority?: FieldUpdate<TaskPriority>;
  readonly due?: FieldUpdate<LocalDate>;
  readonly scheduled?: FieldUpdate<LocalDate>;
  readonly start?: FieldUpdate<LocalDate>;
  readonly time?: FieldUpdate<LocalTime>;
  readonly duration?: FieldUpdate<DurationMinutes>;
  readonly tags?: {
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  };
}

export type SubtaskPatch = Omit<TaskPatch, 'duration'>;

type TaskInitialFields = Omit<TaskPatch, 'markdownTitle'>;

type TaskCreationDestination =
  | { readonly type: 'configured-default' }
  | {
      readonly type: 'explicit';
      readonly destination: TaskDestination;
      readonly provision?: 'if-missing';
    };

export type PlanningTarget =
  | { readonly type: 'task'; readonly ref: TaskRef }
  | { readonly type: 'subtask'; readonly ref: SubtaskRef };

export type TaskStatusTarget = TaskNodeRef;

export interface Clock {
  today(): LocalDate;
}

export type TaskCommand =
  | {
      readonly type: 'create';
      readonly markdownBody: string;
      readonly destination: TaskCreationDestination;
      readonly initial?: TaskInitialFields;
    }
  | {
      readonly type: 'patch';
      readonly target: { readonly type: 'task'; readonly ref: TaskRef };
      readonly patch: TaskPatch;
    }
  | {
      readonly type: 'patch';
      readonly target: { readonly type: 'subtask'; readonly ref: SubtaskRef };
      readonly patch: SubtaskPatch;
    }
  | { readonly type: 'append-title'; readonly target: TaskNodeRef; readonly markdown: string }
  | { readonly type: 'set-status'; readonly target: TaskStatusTarget; readonly symbol: string }
  | { readonly type: 'toggle-completion'; readonly target: TaskStatusTarget }
  | { readonly type: 'reschedule'; readonly ref: TaskRef; readonly date: LocalDate }
  | { readonly type: 'shift-schedule'; readonly ref: TaskRef; readonly days: number }
  | {
      readonly type: 'move-time-slot';
      readonly ref: TaskRef;
      readonly days: number;
      readonly time: LocalTime;
    }
  | { readonly type: 'move-to-all-day'; readonly ref: TaskRef; readonly days: number }
  | {
      readonly type: 'set-time-slot';
      readonly ref: TaskRef;
      readonly date: LocalDate;
      readonly time: LocalTime;
      readonly duration?: DurationMinutes;
    }
  | { readonly type: 'convert-to-all-day'; readonly ref: TaskRef; readonly date: LocalDate }
  | {
      readonly type: 'set-span-boundary';
      readonly ref: TaskRef;
      readonly boundary: 'start' | 'due';
      readonly date: LocalDate;
    }
  | { readonly type: 'extend-span'; readonly ref: TaskRef; readonly due: LocalDate }
  | { readonly type: 'set-description'; readonly target: TaskNodeRef; readonly text: string | null }
  | { readonly type: 'add-subtask'; readonly parent: TaskNodeRef; readonly text: string }
  | { readonly type: 'delete-subtask'; readonly subtask: SubtaskRef }
  | {
      readonly type: 'reorder-subtask';
      readonly subtask: SubtaskRef;
      readonly target: SubtaskRef;
      readonly placement: 'before' | 'after';
    }
  | { readonly type: 'add-comment'; readonly parent: TaskNodeRef; readonly text: string }
  | {
      readonly type: 'update-comment';
      readonly comment: CommentRef;
      readonly text: string;
    }
  | { readonly type: 'delete-comment'; readonly comment: CommentRef }
  | {
      readonly type: 'edit-link';
      readonly target: TaskTextTarget;
      readonly occurrence: number;
      readonly replacement: string;
    }
  | { readonly type: 'delete'; readonly ref: TaskRef }
  | { readonly type: 'move'; readonly ref: TaskRef; readonly destination: TaskDestination };

export type TaskCommandOutcome =
  | { readonly type: 'task'; readonly task: TaskSnapshot }
  | { readonly type: 'deleted'; readonly ref: TaskRef };

export interface TaskResolutionCandidate {
  readonly root: TaskSnapshot;
  readonly target: TaskMutationTarget;
}

export interface MoveRecovery {
  readonly source: TaskRef;
  readonly targetPath: string;
  readonly copiedTask: TaskSnapshot;
  readonly state: 'target-copied-source-remains';
  readonly cause: 'conflict' | 'not-found' | 'ambiguous' | 'io-error';
}

export type TaskCommandResult =
  | { readonly type: 'ok'; readonly outcome: TaskCommandOutcome; readonly changed: boolean }
  | { readonly type: 'conflict'; readonly current: TaskSnapshot }
  | { readonly type: 'not-found'; readonly target: TaskMutationTarget }
  | { readonly type: 'ambiguous'; readonly candidates: readonly TaskResolutionCandidate[] }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] }
  | { readonly type: 'partial'; readonly operation: 'move'; readonly recovery: MoveRecovery }
  | {
      readonly type: 'io-error';
      readonly cause: string;
      readonly path?: string;
      readonly contentState: 'unchanged' | 'unknown';
    };
