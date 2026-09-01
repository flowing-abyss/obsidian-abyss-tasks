import type { QueryDiagnostic } from '../../query/compileQuery';
import type { ProjectDateValue, ProjectRange } from '../types';

export type WorkNoteKindMarker =
  | { readonly kind: 'frontmatter-tag'; readonly value: string }
  | { readonly kind: 'property'; readonly property: string; readonly value: string };

export interface AcceptedWorkNoteAudit {
  readonly presetFingerprint: string;
  readonly acceptedRevision: number;
  readonly acceptedAt: string;
  readonly capabilities: { readonly update: boolean; readonly create: boolean };
}

export interface WorkNoteCompatibilityPreset {
  readonly revision: number;
  readonly enabled: boolean;
  readonly membershipQuery: string;
  readonly ordinaryKindQuery: string;
  readonly milestoneKindQuery: string;
  readonly folder: string;
  readonly fields: Readonly<
    Record<
      | 'project'
      | 'status'
      | 'priority'
      | 'description'
      | 'start'
      | 'end'
      | 'created'
      | 'updated'
      | 'id'
      | 'milestone'
      | 'blockedBy'
      | 'related',
      string
    >
  >;
  readonly rawStatusByStatusId: Readonly<Record<string, string>>;
  readonly creation?: {
    readonly folder: string;
    readonly templatePath?: string;
    readonly defaultKind: 'ordinary' | 'milestone';
    readonly kindMarkers: Readonly<Record<'ordinary' | 'milestone', WorkNoteKindMarker>>;
    readonly defaultStatusId: string;
  };
  readonly acceptedAudit?: AcceptedWorkNoteAudit;
}

export interface WorkNoteDiagnostic {
  readonly type:
    | 'outside-folder'
    | 'membership-mismatch'
    | 'ambiguous-kind'
    | 'missing-kind'
    | 'missing-project'
    | 'multiple-projects'
    | 'multiple-milestones'
    | 'ambiguous-project'
    | 'broken-project'
    | 'invalid-project-entry'
    | 'non-scalar-status'
    | 'non-scalar-description'
    | 'unknown-status'
    | 'non-scalar-date'
    | 'invalid-relation-entry'
    | 'broken-relation'
    | 'ambiguous-relation'
    | 'invalid-status-mapping'
    | 'ambiguous-status-mapping'
    | 'invalid-query';
  readonly field?: string;
  readonly rawValue?: unknown;
  readonly detail?: string;
  readonly offset?: number;
}

export type WorkNoteQuerySource = 'membershipQuery' | 'ordinaryKindQuery' | 'milestoneKindQuery';

export interface WorkNoteQueryDiagnostic extends QueryDiagnostic {
  readonly source: WorkNoteQuerySource;
}

export interface WorkNoteSnapshot {
  readonly path: string;
  readonly presetRevision: number;
  readonly presetFingerprint: string;
  readonly kind: 'ordinary' | 'milestone';
  readonly projectPath: string;
  readonly statusId: string | null;
  readonly rawStatus: string | null;
  readonly writableStatusShape: boolean;
  readonly priority?: string;
  /** Supported configured scalar metadata; never synthesized from structured values. */
  readonly description?: string;
  readonly updated?: string;
  readonly range: ProjectRange;
  readonly id?: string;
  readonly milestonePath?: string;
  readonly blockedByPaths: readonly string[];
  readonly relatedPaths: readonly string[];
  readonly diagnostics: readonly WorkNoteDiagnostic[];
}

export interface WorkNoteObservedFields {
  readonly path: string;
  readonly presetRevision: number;
  readonly presetFingerprint: string;
  readonly projectPath: string;
  readonly kind: 'ordinary' | 'milestone';
  readonly fields: Readonly<Record<string, unknown>>;
}

/** One exact render-time observation used for both date movement and write guards. */
export interface WorkNoteRangeObservation {
  readonly observed: WorkNoteObservedFields;
  readonly start?: ProjectDateValue;
  readonly end?: ProjectDateValue;
  readonly updated?: ProjectDateValue;
}

export interface WorkNoteStatusDefinition {
  readonly id: string;
  readonly label: string;
}

export interface WorkNoteCreateRequest {
  readonly title: string;
  readonly projectPath: string;
  readonly kind?: 'ordinary' | 'milestone';
}

export type WorkNoteCommandResult =
  | { type: 'ok' | 'unchanged'; path: string }
  | { type: 'conflict'; field: string }
  | { type: 'compatibility-conflict'; reason: string }
  | { type: 'partial'; path: string; reason: string }
  | { type: 'invalid'; field: string; reason?: string }
  | { type: 'io-error' };

export interface RelationWriteCommand<TValue> {
  readonly notePath: string;
  readonly expectedRaw: unknown;
  readonly expectedPresetRevision: string;
  readonly expectedPresetFingerprint: string;
  readonly value: TValue;
}

export interface WorkNoteRelationCommands {
  setMilestone(command: RelationWriteCommand<string | null>): Promise<WorkNoteCommandResult>;
  clearMilestone(command: RelationWriteCommand<null>): Promise<WorkNoteCommandResult>;
  addRelated(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult>;
  removeRelated(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult>;
  addBlockedBy(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult>;
  removeBlockedBy(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult>;
}

export interface WorkNoteSourceFile {
  readonly path: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly revision?: { readonly mtime: number; readonly size: number };
}

export interface WorkNoteAuditSource {
  readonly files: () => readonly WorkNoteSourceFile[];
  readonly allPaths?: () => readonly string[];
  readonly resolveLink: (linkpath: string, sourcePath: string) => string | null;
  readonly fileExists: (path: string) => boolean;
}

export interface WorkNoteAuditResult {
  readonly presetFingerprint: string;
  readonly eligiblePaths: readonly string[];
  readonly snapshots: readonly WorkNoteSnapshot[];
  readonly diagnosticsByPath: Readonly<Record<string, readonly WorkNoteDiagnostic[]>>;
  readonly issues: readonly WorkNoteDiagnostic[];
  readonly capabilities: { readonly update: boolean; readonly create: boolean };
}

/** Aggregate-only compatibility preview safe to render or export without vault identities. */
export interface WorkNoteCompatibilityPreview {
  /** Legacy Task 12C UI bridge; production never returns it. */
  readonly acceptanceToken?: string;
  readonly preset: { readonly enabled: boolean; readonly accepted: boolean };
  readonly notes: {
    readonly scanned: number;
    readonly eligible: number;
    readonly excluded: number;
  };
  readonly kinds: {
    readonly ordinary: number;
    readonly milestone: number;
    readonly ambiguous: number;
    readonly missing: number;
  };
  readonly statuses: {
    readonly mapped: number;
    readonly unknown: number;
    readonly missing: number;
    readonly nonScalar: number;
  };
  readonly links: {
    readonly brokenProject: number;
    readonly ambiguousProject: number;
    readonly brokenRelation: number;
    readonly ambiguousRelation: number;
    readonly invalidProjectEntry: number;
    readonly invalidRelationEntry: number;
  };
  readonly cardinality: {
    readonly missingProject: number;
    readonly multipleProjects: number;
    readonly multipleMilestones: number;
  };
  readonly duplicateBasenames: { readonly project: number; readonly relation: number };
  readonly diagnostics: Readonly<Partial<Record<WorkNoteDiagnostic['type'], number>>>;
  readonly capabilities: { readonly update: boolean; readonly create: boolean };
}

declare const workNoteCompatibilityTokenBrand: unique symbol;

/** Opaque, owner-bound, single-use handle for one exact in-memory validation. */
export interface WorkNoteCompatibilityToken {
  readonly [workNoteCompatibilityTokenBrand]: never;
}

export type WorkNoteCompatibilityValidationResult =
  | {
      readonly type: 'audited';
      readonly token: WorkNoteCompatibilityToken;
      readonly presetFingerprint: string;
      readonly preview: WorkNoteCompatibilityPreview;
    }
  | {
      readonly type: 'invalid-draft';
      readonly reason: 'syntax-invalid' | 'candidate-disabled';
      readonly diagnostics: readonly WorkNoteQueryDiagnostic[];
    };

export type WorkNoteValidatedApplyResult =
  | {
      readonly type: 'applied' | 'unchanged';
      readonly preset: WorkNoteCompatibilityPreset;
      readonly preview: WorkNoteCompatibilityPreview;
    }
  | {
      readonly type: 'revalidation-required';
      readonly reason:
        | 'invalid-token'
        | 'candidate-changed'
        | 'audit-inputs-changed'
        | 'settings-changed'
        | 'save-failed'
        | 'persistence-unavailable';
    };

export type WorkNoteCompatibilityDisableResult =
  | { readonly type: 'disabled' | 'unchanged'; readonly preset: WorkNoteCompatibilityPreset }
  | { readonly type: 'save-failed' | 'persistence-unavailable' };

export type WorkNoteCompatibilityAcceptanceResult =
  | {
      readonly type: 'ok';
      readonly preset: WorkNoteCompatibilityPreset;
      readonly preview: WorkNoteCompatibilityPreview;
    }
  | { readonly type: 'stale-preview' }
  | { readonly type: 'compatibility-conflict'; readonly reason: string };

export interface WorkNoteIndexEvent {
  readonly cause: 'index' | 'refresh';
  readonly changedPaths: readonly string[];
  readonly invalidatedProjectPaths: readonly string[];
  readonly taskBarriers: readonly { readonly path: string; readonly generation: number }[];
  readonly queryDiagnostics?: readonly WorkNoteQueryDiagnostic[];
}

export interface WorkNoteIndexSettledEvent {
  readonly reason: 'initialization' | 'index' | 'refresh';
  readonly files: readonly { readonly path: string; readonly generation: number }[];
}
