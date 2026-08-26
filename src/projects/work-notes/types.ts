import type { ProjectRange } from '../types';

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
    | 'ambiguous-project'
    | 'broken-project'
    | 'invalid-project-entry'
    | 'non-scalar-status'
    | 'unknown-status'
    | 'non-scalar-date'
    | 'invalid-relation-entry'
    | 'broken-relation'
    | 'ambiguous-relation'
    | 'invalid-status-mapping'
    | 'ambiguous-status-mapping';
  readonly field?: string;
  readonly rawValue?: unknown;
  readonly detail?: string;
}

export interface WorkNoteSnapshot {
  readonly path: string;
  readonly presetRevision: number;
  readonly kind: 'ordinary' | 'milestone';
  readonly projectPath: string;
  readonly statusId: string | null;
  readonly rawStatus: string | null;
  readonly writableStatusShape: boolean;
  readonly priority?: string;
  readonly range: ProjectRange;
  readonly id?: string;
  readonly milestonePath?: string;
  readonly blockedByPaths: readonly string[];
  readonly relatedPaths: readonly string[];
  readonly diagnostics: readonly WorkNoteDiagnostic[];
}

export interface WorkNoteSourceFile {
  readonly path: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
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

export interface WorkNoteIndexEvent {
  readonly changedPaths: readonly string[];
  readonly invalidatedProjectPaths: readonly string[];
}
