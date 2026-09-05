import { setIcon } from 'obsidian';
import type {
  DependencyDirection,
  TaskDependencyProjection,
  TaskDependencyRelation,
  TaskSnapshot,
} from '../tasks';

export type TaskDependencyLookup = (task: TaskSnapshot) => TaskDependencyProjection | undefined;

export type DependencyIndicatorPresentation =
  | { readonly type: 'none' }
  | { readonly type: 'blocked-by'; readonly blockedBy: number; readonly ariaLabel: string }
  | { readonly type: 'blocks'; readonly blocks: number; readonly ariaLabel: string }
  | {
      readonly type: 'both';
      readonly blockedBy: number;
      readonly blocks: number;
      readonly ariaLabel: string;
    };

export function dependencyIndicatorPresentation(
  projection: TaskDependencyProjection | undefined,
): DependencyIndicatorPresentation {
  if (projection === undefined) return { type: 'none' };
  const { blockedBy, blocks, ariaLabel } = dependencyCountPresentation(projection);
  if (blockedBy > 0 && blocks > 0) return { type: 'both', blockedBy, blocks, ariaLabel };
  if (blockedBy > 0) return { type: 'blocked-by', blockedBy, ariaLabel };
  if (blocks > 0) return { type: 'blocks', blocks, ariaLabel };
  return { type: 'none' };
}

export function dependencyCompletionBlocked(
  projection: TaskDependencyProjection | undefined,
): boolean {
  return (projection?.activeBlockedByCount ?? 0) > 0;
}

export function renderDependencyIndicator(
  parent: HTMLElement,
  projection: TaskDependencyProjection | undefined,
): void {
  const presentation = dependencyIndicatorPresentation(projection);
  if (presentation.type === 'none') return;
  const group = parent.createSpan({
    cls: 'abyss-dep-indicator',
    attr: { role: 'img', 'aria-label': presentation.ariaLabel, title: presentation.ariaLabel },
  });
  const direction = presentation.type === 'blocks' ? 'blocks' : 'blocked-by';
  setIcon(
    group.createSpan({
      cls: `abyss-dep-lock abyss-dep-count-${direction}`,
      attr: { 'aria-hidden': 'true', 'data-dependency-direction': direction },
    }),
    'lock',
  );
  if ('blockedBy' in presentation)
    renderIndicatorCount(group, 'blocked-by', presentation.blockedBy);
  if (presentation.type === 'both')
    group.createSpan({ cls: 'abyss-dep-divider', attr: { 'aria-hidden': 'true' } });
  if ('blocks' in presentation) renderIndicatorCount(group, 'blocks', presentation.blocks);
}

function renderIndicatorCount(
  group: HTMLElement,
  direction: DependencyDirection,
  count: number,
): void {
  group.createSpan({
    cls: `abyss-dep-count-${direction}`,
    text: String(count),
    attr: { 'aria-hidden': 'true', 'data-dependency-count': direction },
  });
}

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
