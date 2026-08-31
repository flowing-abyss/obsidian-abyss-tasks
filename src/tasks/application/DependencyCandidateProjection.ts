import type { DependencyLinkValidation } from '../domain/dependency';
import type { TaskSnapshot } from '../domain/types';

export interface DependencyCandidate {
  readonly task: TaskSnapshot;
  readonly rank: number;
  readonly availability:
    | { readonly type: 'available' }
    /** Graph-safe but requires an ID from the command-capable picker on activation. */
    | { readonly type: 'id-required' }
    | { readonly type: 'disabled'; readonly reason: string };
}

export interface DependencyCandidateProjectionInput {
  readonly dependent: TaskSnapshot;
  readonly tasks: readonly TaskSnapshot[];
  readonly projectTasks: readonly TaskSnapshot[];
  /** Read-side preflight only; the command validates again immediately before writing. */
  readonly validateLink: (
    prerequisite: TaskSnapshot,
    dependent: TaskSnapshot,
    dependencyId: string,
  ) => DependencyLinkValidation;
  /** Identity-only graph preflight for an ID-less prerequisite. */
  readonly preflightIdentityLink?: (
    prerequisite: TaskSnapshot,
    dependent: TaskSnapshot,
  ) => DependencyLinkValidation;
}

function sameTask(left: TaskSnapshot, right: TaskSnapshot): boolean {
  return left.ref.filePath === right.ref.filePath && left.ref.line === right.ref.line;
}

function key(task: TaskSnapshot): string {
  return `${task.ref.filePath}\u0000${String(task.ref.line)}`;
}

function disabledReason(validation: DependencyLinkValidation): string | undefined {
  if (validation.type === 'allowed') return undefined;
  const diagnostic = validation.diagnostics[0];
  if (!diagnostic) return 'Dependency is unavailable';
  if (diagnostic.type === 'cycle') return 'Would create a cycle';
  if (diagnostic.type === 'self-edge') return 'Task cannot block itself';
  if (diagnostic.type === 'duplicate-id') return 'Duplicate ID';
  if (diagnostic.type === 'missing-prerequisite') return 'Missing prerequisite';
  return 'Dependency data unavailable';
}

/**
 * A read-only, flat picker projection. It deliberately does not reserve an ID or
 * mutate graph state: DependencyCommandCoordinator remains the race-safe authority.
 */
export function projectDependencyCandidates(
  input: DependencyCandidateProjectionInput,
): readonly DependencyCandidate[] {
  const projectKeys = new Set(input.projectTasks.map(key));
  const existing = new Set(input.dependent.dependency?.dependsOn ?? []);
  const seen = new Set<string>();
  const candidates = input.tasks.filter((candidate) => {
    if (sameTask(candidate, input.dependent) || seen.has(key(candidate))) return false;
    seen.add(key(candidate));
    return candidate.dependency?.id === undefined || !existing.has(candidate.dependency.id);
  });
  // Modern engines guarantee stable sort: retain the provider/query order inside each rank.
  candidates.sort(
    (left, right) => Number(!projectKeys.has(key(left))) - Number(!projectKeys.has(key(right))),
  );
  return candidates.map((task) => {
    const id = task.dependency?.id;
    if (id === undefined) {
      const reason = disabledReason(
        input.preflightIdentityLink?.(task, input.dependent) ?? { type: 'allowed' },
      );
      return {
        task,
        rank: projectKeys.has(key(task)) ? 0 : 1,
        availability: reason
          ? ({ type: 'disabled' as const, reason } as const)
          : ({ type: 'id-required' as const } as const),
      };
    }
    const reason = disabledReason(input.validateLink(task, input.dependent, id));
    return {
      task,
      rank: projectKeys.has(key(task)) ? 0 : 1,
      availability: reason ? { type: 'disabled' as const, reason } : { type: 'available' as const },
    };
  });
}
