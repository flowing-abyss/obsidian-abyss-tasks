import { setIcon } from 'obsidian';
import type { DependencyCompletionDecision } from '../tasks';

function dependencyLabel(decision: Exclude<DependencyCompletionDecision, { type: 'allowed' }>): {
  label: string;
  count: number;
} {
  if (decision.type === 'blocked') {
    const count = decision.prerequisites.length;
    return {
      label: `Blocked by ${String(count)} prerequisite${count === 1 ? '' : 's'}`,
      count,
    };
  }
  return { label: 'Dependency issue', count: Math.max(1, decision.diagnostics.length) };
}

/** Compact, shared dependency state; allowed Tasks intentionally render no placeholder. */
export function renderDependencyBadge(
  parent: HTMLElement,
  decision: DependencyCompletionDecision,
): HTMLElement | null {
  if (decision.type === 'allowed') return null;
  const { label, count } = dependencyLabel(decision);
  const badge = parent.createSpan({
    cls: `abyss-task-count-badge abyss-task-dependency-badge${decision.type === 'invalid' ? ' is-invalid' : ''}`,
    attr: { 'aria-label': label, title: label },
  });
  const icon = badge.createSpan({
    cls: 'abyss-task-dependency-badge-icon',
    attr: { 'aria-hidden': 'true' },
  });
  setIcon(icon, decision.type === 'invalid' ? 'triangle-alert' : 'lock-keyhole');
  badge.createSpan({ text: String(count) });
  return badge;
}
