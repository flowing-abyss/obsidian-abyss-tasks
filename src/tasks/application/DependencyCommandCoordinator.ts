import type {
  TaskCommandOutcome,
  TaskCommandResult,
  TaskResolutionCandidate,
} from '../domain/commands';
import type { RootReconciliationBasis, TaskResolution } from '../domain/taskReconciliation';
import type { TaskMutationTarget, TaskRef, TaskSnapshot } from '../domain/types';
import { isTaskDependencyId } from '../domain/validation';
import type { DependencyCommandIntent, TaskQueryApi } from './TaskApplicationApi';
import type {
  TaskDependencyEditCommand,
  TaskDependencyEditRequest,
  TaskDependencyRevisionChange,
  TaskEditRequest,
  TaskRepository,
  TaskRepositoryResult,
} from './TaskRepository';

export type { DependencyCommandIntent } from './TaskApplicationApi';

export interface DependencyCommittedProjection {
  acceptCommittedRoots(roots: readonly TaskSnapshot[]): void;
}

interface ResolvedRoot {
  readonly current: TaskSnapshot;
  readonly reconciliation: RootReconciliationBasis;
}

type ResolveRootResult =
  | { readonly type: 'resolved'; readonly value: ResolvedRoot }
  | { readonly type: 'terminal'; readonly result: TaskCommandResult };

function sameRoot(left: TaskRef, right: TaskRef): boolean {
  return (
    left.filePath === right.filePath && left.line === right.line && left.revision === right.revision
  );
}

function target(ref: TaskRef): TaskMutationTarget {
  return { type: 'task', ref };
}

function candidates(
  resolution: Extract<TaskResolution, { readonly type: 'ambiguous' }>,
): readonly TaskResolutionCandidate[] {
  return resolution.candidates.map((candidate) => ({
    root: candidate.root,
    target: { type: 'task', ref: candidate.root.ref },
  }));
}

function terminalRepositoryResult(result: TaskRepositoryResult): TaskCommandResult {
  switch (result.type) {
    case 'committed':
      return { type: 'ok', outcome: result.outcome, changed: result.changed };
    case 'rebased':
      return { type: 'conflict', current: result.current };
    case 'uncertain':
      return { type: 'not-found', target: result.target };
    default:
      return result;
  }
}

function failureCause(
  result: Exclude<TaskCommandResult, { readonly type: 'ok' | 'partial' }>,
): 'conflict' | 'not-found' | 'ambiguous' | 'invalid' | 'io-error' {
  return result.type;
}

/** Coordinates one dependency relation without creating another identity or write subsystem. */
export class DependencyCommandCoordinator {
  constructor(
    private readonly rootResolver: Pick<TaskQueryApi, 'resolve'>,
    private readonly repository: TaskRepository,
    private readonly projection?: DependencyCommittedProjection,
    private readonly onCommitted?: (task: TaskSnapshot) => void,
  ) {}

  async setDependency(intent: DependencyCommandIntent): Promise<TaskCommandResult> {
    if (
      !isTaskDependencyId(intent.dependencyId) ||
      typeof intent.enabled !== 'boolean' ||
      sameRoot(intent.prerequisite, intent.dependent)
    ) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'dependency' }] };
    }

    let prerequisite: ResolveRootResult;
    try {
      prerequisite = this.resolve(intent.prerequisite);
    } catch {
      return { type: 'io-error', cause: 'repository-error', contentState: 'unchanged' };
    }
    if (prerequisite.type === 'terminal') return prerequisite.result;
    let dependent: ResolveRootResult;
    try {
      dependent = this.resolve(intent.dependent);
    } catch {
      return { type: 'io-error', cause: 'repository-error', contentState: 'unchanged' };
    }
    if (dependent.type === 'terminal') return dependent.result;
    if (sameRoot(prerequisite.value.current.ref, dependent.value.current.ref)) {
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'dependency' }] };
    }

    const dependencyId = prerequisite.value.current.dependency?.id ?? intent.dependencyId;
    const needsId = prerequisite.value.current.dependency?.id === undefined && intent.enabled;
    if (
      needsId &&
      prerequisite.value.current.ref.filePath === dependent.value.current.ref.filePath
    ) {
      return await this.sameFile(prerequisite.value, dependent.value, dependencyId, intent.enabled);
    }
    return await this.sequential(
      prerequisite.value,
      dependent.value,
      dependencyId,
      intent.enabled,
      needsId,
    );
  }

  private resolve(ref: TaskRef): ResolveRootResult {
    const resolution = this.rootResolver.resolve(ref);
    if (resolution.type === 'ambiguous') {
      return {
        type: 'terminal',
        result: { type: 'ambiguous', candidates: candidates(resolution) },
      };
    }
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') {
      return { type: 'terminal', result: { type: 'not-found', target: target(ref) } };
    }
    return {
      type: 'resolved',
      value: {
        current: resolution.type === 'exact' ? resolution.task : resolution.current,
        reconciliation: resolution.basis,
      },
    };
  }

  private change(
    current: ResolvedRoot,
    command: TaskDependencyEditCommand,
  ): TaskDependencyRevisionChange {
    return {
      baseRoot: current.current,
      baseTarget: target(current.current.ref),
      reconciliation: current.reconciliation,
      command,
    };
  }

  private async sameFile(
    prerequisite: ResolvedRoot,
    dependent: ResolvedRoot,
    dependencyId: string,
    enabled: boolean,
  ): Promise<TaskCommandResult> {
    if (!this.repository.editTaskDependencies) {
      return { type: 'io-error', cause: 'repository-error', contentState: 'unchanged' };
    }
    const request: TaskDependencyEditRequest = {
      filePath: dependent.current.ref.filePath,
      primary: dependent.current.ref,
      changes: [
        this.change(prerequisite, {
          type: 'set-task-id',
          ref: prerequisite.current.ref,
          id: dependencyId,
        }),
        this.change(dependent, {
          type: 'set-task-dependency',
          ref: dependent.current.ref,
          dependencyId,
          enabled,
        }),
      ],
    };
    let result: TaskRepositoryResult;
    try {
      result = await this.repository.editTaskDependencies(request);
    } catch {
      return {
        type: 'io-error',
        cause: 'repository-error',
        path: request.filePath,
        contentState: 'unknown',
      };
    }
    if (result.type === 'committed')
      this.publish(result.roots ?? [result.outcome].flatMap(outcomeTask));
    return terminalRepositoryResult(result);
  }

  private async sequential(
    prerequisite: ResolvedRoot,
    dependent: ResolvedRoot,
    dependencyId: string,
    enabled: boolean,
    needsId: boolean,
  ): Promise<TaskCommandResult> {
    let committedPrerequisite: TaskSnapshot | undefined;
    let changed = false;
    if (needsId) {
      const first = await this.edit(
        this.change(prerequisite, {
          type: 'set-task-id',
          ref: prerequisite.current.ref,
          id: dependencyId,
        }),
      );
      if (first.type !== 'committed') return terminalRepositoryResult(first);
      if (first.outcome.type !== 'task') {
        return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
      }
      committedPrerequisite = first.outcome.task;
      changed ||= first.changed;
    }

    const second = await this.edit(
      this.change(dependent, {
        type: 'set-task-dependency',
        ref: dependent.current.ref,
        dependencyId,
        enabled,
      }),
    );
    if (second.type !== 'committed') {
      if (committedPrerequisite) this.publish([committedPrerequisite]);
      const terminal = terminalRepositoryResult(second);
      if (
        !committedPrerequisite ||
        !changed ||
        terminal.type === 'partial' ||
        terminal.type === 'ok'
      ) {
        return terminal;
      }
      return {
        type: 'partial',
        operation: 'dependency',
        recovery: {
          state:
            terminal.type === 'io-error' && terminal.contentState === 'unknown'
              ? 'prerequisite-id-committed-dependent-edge-unknown'
              : 'prerequisite-id-committed-dependent-edge-remains',
          prerequisite: committedPrerequisite,
          dependent: terminal.type === 'conflict' ? terminal.current : dependent.current,
          dependencyId,
          enabled,
          cause: failureCause(terminal),
        },
      };
    }
    if (second.outcome.type !== 'task') {
      if (committedPrerequisite) this.publish([committedPrerequisite]);
      return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    changed ||= second.changed;
    this.publish(
      committedPrerequisite ? [committedPrerequisite, second.outcome.task] : [second.outcome.task],
    );
    return { type: 'ok', outcome: second.outcome, changed };
  }

  private async edit(change: TaskDependencyRevisionChange): Promise<TaskRepositoryResult> {
    const request: TaskEditRequest = { ...change, command: change.command };
    try {
      return await this.repository.edit(
        this.repository.supportsRevisionPreconditions === true ? request : change.command,
      );
    } catch {
      return {
        type: 'io-error',
        cause: 'repository-error',
        path: change.baseRoot.ref.filePath,
        contentState: 'unknown',
      };
    }
  }

  private publish(roots: readonly TaskSnapshot[]): void {
    for (const root of roots) {
      try {
        this.onCommitted?.(root);
      } catch {
        // Repository outcomes remain authoritative when a read-model observer fails.
      }
    }
    try {
      this.projection?.acceptCommittedRoots(roots);
    } catch {
      // Projection delivery is best-effort; eventual index events provide convergence.
    }
  }
}

function outcomeTask(outcome: TaskCommandOutcome): readonly TaskSnapshot[] {
  return outcome.type === 'task' ? [outcome.task] : [];
}
