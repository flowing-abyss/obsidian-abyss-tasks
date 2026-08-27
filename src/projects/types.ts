export interface ProjectDateValue {
  readonly raw: string;
  readonly precision: 'date' | 'datetime';
  readonly instantMs: number;
  readonly offsetMinutes?: number;
}

export interface ProjectRange {
  readonly start?: ProjectDateValue;
  readonly end?: ProjectDateValue;
  readonly issue?: 'invalid-start' | 'invalid-end' | 'reversed';
}

export interface TaskRollup {
  readonly total: number;
  readonly done: number;
  readonly cancelled: number;
  readonly inProgress: number;
  readonly open: number;
  readonly progress: number | null;
}

export type ProjectStats = TaskRollup;

export interface Project {
  path: string;
  name: string;
  frontmatter: Record<string, unknown>;
  tags: string[]; // '#'-prefixed, lower-cased
  statusId: string | null;
  rawStatus: string | null;
  range: ProjectRange;
  stats: ProjectStats;
}

export interface ProjectAction {
  readonly task: TaskSnapshot;
  readonly projectPath: string;
  readonly dependency: DependencyCompletionDecision;
  readonly owner:
    | { readonly type: 'project'; readonly path: string }
    | { readonly type: 'work-note'; readonly path: string };
}

export type ProjectWorkspaceDiagnostic =
  | {
      readonly type: 'work-note';
      readonly path: string;
      readonly diagnostic: WorkNoteDiagnostic;
    }
  | {
      readonly type: 'relation';
      readonly path: string;
      readonly relation: Extract<WorkNoteRelationProjection, { readonly type: 'invalid' }>;
    };

export interface ProjectWorkspaceSnapshot {
  readonly project: Project;
  readonly tasks: readonly ProjectAction[];
  readonly workNotes: readonly WorkNoteSnapshot[];
  readonly milestones: readonly WorkNoteSnapshot[];
  readonly taskRollup: TaskRollup;
  readonly workNoteRollup: WorkNoteRollup;
  readonly milestoneRollups: ReadonlyMap<string, MilestoneRollup>;
  readonly workNoteRelations: readonly WorkNoteRelationProjection[];
  readonly overdue: { readonly tasks: number; readonly workNotes: number };
  readonly dependencies: {
    readonly blocked: number;
    readonly invalid: number;
    readonly diagnostics: readonly {
      readonly ref: TaskSnapshot['ref'];
      readonly diagnostics: Extract<
        DependencyCompletionDecision,
        { readonly type: 'invalid' }
      >['diagnostics'];
    }[];
  };
  readonly diagnostics: readonly ProjectWorkspaceDiagnostic[];
}
import type { TaskSnapshot } from '../tasks';
import type { DependencyCompletionDecision } from '../tasks/application/DependencyPolicyPort';
import type { WorkNoteRelationProjection } from './work-notes/WorkNoteRelationProjection';
import type { MilestoneRollup, WorkNoteRollup } from './work-notes/rollups';
import type { WorkNoteDiagnostic, WorkNoteSnapshot } from './work-notes/types';
