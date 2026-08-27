import type { DependencyCompletionDiagnostic, TaskCommandResult } from './commands';
import type { TaskRef, TaskSnapshot } from './types';

export type DependencyCompletionDecision =
  | { readonly type: 'allowed' }
  | Extract<TaskCommandResult, { readonly type: 'blocked' }>['dependency'];

export interface DependencyProjectionUpdate {
  readonly affected: readonly TaskRef[];
  readonly causalTaskPaths: readonly string[];
}

export interface DependencyInspectionRelation {
  readonly id: string;
  readonly resolution:
    | {
        readonly type: 'resolved';
        readonly prerequisite: TaskRef;
        readonly complete: boolean;
      }
    | { readonly type: 'missing' }
    | { readonly type: 'duplicate'; readonly candidates: readonly TaskRef[] };
}

export interface DependencyInspection {
  readonly decision: DependencyCompletionDecision;
  readonly relations: readonly DependencyInspectionRelation[];
}

export interface DependencyProjectionPort {
  evaluateCompletion(task: TaskSnapshot): DependencyCompletionDecision;
  inspect(task: TaskSnapshot): DependencyInspection;
  subscribe(listener: (event: DependencyProjectionUpdate) => void): () => void;
}

export interface DependencyLinkValidationInput {
  readonly prerequisite: TaskSnapshot;
  readonly dependent: TaskSnapshot;
  readonly dependencyId: string;
}

export type DependencyLinkValidation =
  | { readonly type: 'allowed' }
  | { readonly type: 'invalid'; readonly diagnostics: readonly DependencyCompletionDiagnostic[] };
