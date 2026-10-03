import { cloneTaskSnapshot } from '../domain/cloneTaskSnapshot';
import type { TaskCommandResult } from '../domain/commands';
import { taskNodeAtSourcePath, taskNodeRootRef } from '../domain/taskCommandTargets';
import {
  hierarchySource,
  hierarchyWouldCycle,
  type TaskHierarchyCommand,
} from '../domain/taskHierarchy';
import { sameTaskNodeRef, type TaskNodeRef } from '../domain/types';
import { invalidTaskTarget } from '../domain/validation';
import type { TaskQueryApi } from './TaskApplicationApi';
import type { TaskDiagnosticSink } from './TaskDependencyService';
import type { RevisionPrecondition, TaskHierarchyRequest, TaskRepository } from './TaskRepository';

type Resolution =
  { readonly precondition: RevisionPrecondition } | { readonly result: TaskCommandResult };
export class TaskHierarchyService {
  constructor(
    private readonly queries: TaskQueryApi,
    private readonly repository: TaskRepository,
    private readonly diagnostics: TaskDiagnosticSink,
  ) {}

  async execute(command: TaskHierarchyCommand): Promise<TaskCommandResult> {
    const target = hierarchySource(command);
    const source = this.resolve(target);
    if ('result' in source) return source.result;
    const parent = command.type === 'reparent-task' ? this.resolve(command.parent) : undefined;
    if (parent !== undefined && 'result' in parent) return parent.result;
    const relation = this.relationResult(command, source.precondition);
    if (relation !== undefined) return relation;
    return this.commit({
      command,
      source: source.precondition,
      ...(parent !== undefined && { parent: parent.precondition }),
    });
  }

  private relationResult(
    command: TaskHierarchyCommand,
    source: RevisionPrecondition,
  ): TaskCommandResult | undefined {
    if (command.type !== 'reparent-task') return undefined;
    if (hierarchyWouldCycle(command.source, command.parent)) return invalidTaskTarget('hierarchy');
    if (
      command.source.type !== 'subtask' ||
      !sameTaskNodeRef(command.source.ref.parent, command.parent)
    )
      return undefined;
    return {
      type: 'ok',
      changed: false,
      outcome: {
        type: 'hierarchy',
        source: command.source,
        moved: { root: source.baseRoot, target: command.source },
        affectedRoots: [source.baseRoot],
      },
    };
  }

  private async commit(request: TaskHierarchyRequest): Promise<TaskCommandResult> {
    const { command } = request;
    const target = hierarchySource(command);
    try {
      const result = await this.repository.hierarchy({
        ...request,
        diagnostic: (phase, cause, path) => {
          this.diagnostics({
            operation: command.type,
            phase: `hierarchy-${phase}`,
            cause,
            ...(path !== undefined && { path }),
          });
        },
      });
      if (result.type === 'committed') return { ...result, type: 'ok' };
      if (result.type === 'rebased') return { type: 'conflict', current: result.current };
      if (result.type === 'uncertain') return { type: 'not-found', target: result.target };
      return result;
    } catch (error) {
      try {
        this.diagnostics(
          { operation: command.type, phase: 'unexpected', cause: 'hierarchy-error' },
          error,
        );
      } catch {
        console.error('[abyss-tasks] Hierarchy diagnostic failed', { cause: 'diagnostic-error' });
      }
      return {
        type: 'partial',
        operation: 'hierarchy',
        recovery: {
          source: target,
          sourcePath: taskNodeRootRef(target).filePath,
          destinationPath:
            command.type === 'reparent-task'
              ? taskNodeRootRef(command.parent).filePath
              : taskNodeRootRef(target).filePath,
          state: 'unknown',
          cause: 'io-error',
        },
      };
    }
  }

  private resolve(target: TaskNodeRef): Resolution {
    const resolution = this.queries.resolve(taskNodeRootRef(target));
    if (resolution.type === 'ambiguous') return { result: resolution };
    if (resolution.type === 'visual' || resolution.type === 'rebased')
      return { result: { type: 'conflict', current: resolution.current } };
    if (resolution.type !== 'exact') return { result: { type: 'not-found', target } };
    if (taskNodeAtSourcePath(resolution.task, target) === undefined)
      return { result: { type: 'conflict', current: resolution.task } };
    return {
      precondition: {
        baseRoot: cloneTaskSnapshot(resolution.task),
        baseTarget: target,
        reconciliation: resolution.basis,
      },
    };
  }
}
