import type { DependencyCompletionDecision, TaskSnapshot } from '../tasks';
import type { CommentTimestamp } from '../tasks/domain/commentTimestamp';
import type { WorkNoteRelationProjection } from './work-notes/WorkNoteRelationProjection';
import type { MilestoneRollup, WorkNoteRollup } from './work-notes/rollups';
import type { WorkNoteDiagnostic, WorkNoteSnapshot } from './work-notes/types';

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

export type ProjectPriority = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** Raw frontmatter values captured with a Project projection for narrow command CAS. */
export interface ProjectMetadataObservation {
  readonly priority: unknown;
  readonly description: unknown;
  readonly comments: unknown;
  readonly start: unknown;
  readonly end: unknown;
}

export type ProjectComment =
  | {
      readonly kind: 'timestamp';
      readonly raw: string;
      readonly timestamp: CommentTimestamp;
      readonly text: string;
    }
  | { readonly kind: 'undated'; readonly raw: string; readonly text: string }
  | { readonly kind: 'malformed'; readonly raw: string };

export type ProjectMetadataDiagnostic =
  | { readonly field: 'priority' | 'description' | 'comments'; readonly issue: 'unsupported' }
  | { readonly field: 'comments'; readonly issue: 'malformed'; readonly index: number };

export interface Project {
  path: string;
  name: string;
  frontmatter: Record<string, unknown>;
  tags: string[]; // '#'-prefixed, lower-cased
  statusId: string | null;
  rawStatus: string | null;
  range: ProjectRange;
  /** Present on ProjectStore snapshots; optional for legacy projection fixtures. */
  priority?: ProjectPriority | null;
  /** Present on ProjectStore snapshots; optional for legacy projection fixtures. */
  description?: string | null;
  /** Present on ProjectStore snapshots; optional for legacy projection fixtures. */
  comments?: readonly ProjectComment[];
  /** Raw values captured by ProjectStore for narrow command CAS. */
  observed?: ProjectMetadataObservation;
  /** Read-only metadata warnings emitted by ProjectStore. */
  metadataDiagnostics?: readonly ProjectMetadataDiagnostic[];
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
