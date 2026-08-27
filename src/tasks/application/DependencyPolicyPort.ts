import type { TaskCommandResult } from '../domain/commands';
import type { TaskRef, TaskSnapshot } from '../domain/types';

export type DependencyCompletionDecision =
  | { readonly type: 'allowed' }
  | Extract<TaskCommandResult, { readonly type: 'blocked' }>['dependency'];

export interface DependencyProjectionUpdate {
  /** Every Task whose dependency projection may have changed. */
  readonly affected: readonly TaskRef[];
  /** Task files whose eventual index settlement makes this projection update observable. */
  readonly causalTaskPaths: readonly string[];
}

export interface DependencyCommittedDelta {
  /** Canonical repository snapshots consumed by the committed operation. */
  readonly replaced: readonly TaskSnapshot[];
  /** Canonical roots materialized by the same committed operation. */
  readonly roots: readonly TaskSnapshot[];
}

/** Read-only dependency projection consumed by joined read models. */
export interface DependencyProjectionPort {
  evaluateCompletion(task: TaskSnapshot): DependencyCompletionDecision;
  subscribe(listener: (event: DependencyProjectionUpdate) => void): () => void;
}

/** Neutral application policy; the Tasks core has no dependency on Projects. */
export interface DependencyPolicyPort extends DependencyProjectionPort {
  acceptCommittedDelta(delta: DependencyCommittedDelta): void;
}

/** Safe composition fallback: dependency carriers require a graph-backed policy to complete. */
export const unavailableDependencyPolicy: DependencyPolicyPort = {
  evaluateCompletion: (task) =>
    task.dependency?.id !== undefined || (task.dependency?.dependsOn.length ?? 0) > 0
      ? { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] }
      : { type: 'allowed' },
  subscribe: () => () => {},
  acceptCommittedDelta: () => {},
};
