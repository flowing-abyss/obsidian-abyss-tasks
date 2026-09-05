import type {
  DependencyDirection,
  TaskDependencyProjection,
  TaskDependencyRelation,
} from '../tasks';

export interface DependencyCountPresentation {
  readonly blockedBy: number;
  readonly blocks: number;
  readonly ariaLabel: string;
  readonly title: string;
}

export function dependencyCountPresentation(
  projection: TaskDependencyProjection,
): DependencyCountPresentation {
  const blockedBy = projection.activeBlockedByCount;
  const blocks = projection.activeBlocksCount;
  const summary = `Dependencies: blocked by ${blockedBy}; blocks ${blocks}`;
  return { blockedBy, blocks, ariaLabel: summary, title: summary };
}

export function dependencyDirectionLabel(direction: DependencyDirection): string {
  return direction === 'blocked-by' ? 'Blocked by' : 'Blocks';
}

export function dependencyRelationPresentation(relation: TaskDependencyRelation): {
  readonly title: string;
  readonly removeLabel: string;
  readonly done: boolean;
  readonly unavailable: boolean;
  readonly state: 'active' | 'satisfied';
} {
  if (relation.type === 'resolved') {
    return {
      title: relation.task.node.title,
      removeLabel: `Remove dependency: ${relation.task.node.title}`,
      done: relation.task.node.status === 'done',
      unavailable: false,
      state: relation.state,
    };
  }
  if (relation.type === 'ambiguous') {
    return {
      title: 'Multiple tasks use this ID',
      removeLabel: 'Remove ambiguous dependency',
      done: false,
      unavailable: true,
      state: relation.state,
    };
  }
  return {
    title: 'Task unavailable',
    removeLabel: 'Remove unavailable dependency',
    done: false,
    unavailable: true,
    state: 'satisfied',
  };
}
