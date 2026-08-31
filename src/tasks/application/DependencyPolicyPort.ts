import type {
  DependencyLinkValidation,
  DependencyLinkValidationInput,
  DependencyProjectionPort,
} from '../domain/dependency';
import type { TaskSnapshot } from '../domain/types';
export type {
  DependencyCompletionDecision,
  DependencyInspection,
  DependencyInspectionRelation,
  DependencyLinkValidation,
  DependencyLinkValidationInput,
  DependencyProjectionPort,
  DependencyProjectionUpdate,
} from '../domain/dependency';

export interface DependencyCommittedDelta {
  /** Canonical repository snapshots consumed by the committed operation. */
  readonly replaced: readonly TaskSnapshot[];
  /** Canonical roots materialized by the same committed operation. */
  readonly roots: readonly TaskSnapshot[];
}

/** Neutral application policy; the Tasks core has no dependency on Projects. */
export interface DependencyPolicyPort extends DependencyProjectionPort {
  /** Read-side candidate preflight; mutation commands revalidate this exact intent at commit time. */
  validateLink(input: DependencyLinkValidationInput): DependencyLinkValidation;
  acceptCommittedDelta(delta: DependencyCommittedDelta): void;
}

/** Safe composition fallback: dependency carriers require a graph-backed policy to complete. */
export const unavailableDependencyPolicy: DependencyPolicyPort = {
  evaluateCompletion: (task) =>
    task.dependency?.id !== undefined || (task.dependency?.dependsOn.length ?? 0) > 0
      ? { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] }
      : { type: 'allowed' },
  inspect: (task) => ({
    decision:
      task.dependency?.id !== undefined || (task.dependency?.dependsOn.length ?? 0) > 0
        ? { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] }
        : { type: 'allowed' },
    relations: (task.dependency?.dependsOn ?? []).map((id) => ({
      id,
      resolution: { type: 'missing' },
    })),
  }),
  validateLink: () => ({
    type: 'invalid',
    diagnostics: [{ type: 'unresolved-projection' }],
  }),
  subscribe: () => () => {},
  acceptCommittedDelta: () => {},
};
