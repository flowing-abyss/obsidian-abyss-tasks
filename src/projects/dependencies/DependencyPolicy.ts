import type {
  DependencyCommittedDelta,
  DependencyCompletionDecision,
  DependencyInspection,
  DependencyLinkValidation,
  DependencyLinkValidationInput,
  DependencyPolicyPort,
  DependencyProjectionUpdate,
} from '../../tasks/application/DependencyPolicyPort';
import type { TaskSnapshot } from '../../tasks/domain/types';
import { DependencyIndex } from './DependencyIndex';

/** Graph-backed completion policy and read-only projection adapter. */
export class DependencyPolicy implements DependencyPolicyPort {
  constructor(private readonly index: DependencyIndex) {}

  evaluateCompletion(task: TaskSnapshot): DependencyCompletionDecision {
    const projection = this.index.projectionFor(task);
    if (projection === undefined) {
      return task.dependency?.id !== undefined || (task.dependency?.dependsOn.length ?? 0) > 0
        ? { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] }
        : { type: 'allowed' };
    }
    if (projection.type === 'ready') return { type: 'allowed' };
    if (projection.type === 'blocked') {
      return { type: 'blocked', prerequisites: projection.prerequisites };
    }
    return { type: 'invalid', diagnostics: projection.diagnostics };
  }

  inspect(task: TaskSnapshot): DependencyInspection {
    return {
      decision: this.evaluateCompletion(task),
      relations:
        this.index.inspect(task) ??
        (task.dependency?.dependsOn ?? []).map((id) => ({
          id,
          resolution: { type: 'missing' },
        })),
    };
  }

  validateLink(input: DependencyLinkValidationInput): DependencyLinkValidation {
    return this.index.validateLink(input.prerequisite, input.dependent, input.dependencyId);
  }

  subscribe(listener: (event: DependencyProjectionUpdate) => void): () => void {
    return this.index.subscribeUpdates(listener);
  }

  acceptCommittedDelta(delta: DependencyCommittedDelta): void {
    this.index.acceptCommittedDelta(delta);
  }
}
