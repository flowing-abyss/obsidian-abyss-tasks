import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { DependencyCompletionDecision } from '../src/tasks/application/DependencyPolicyPort';
import { renderDependencyBadge } from '../src/ui/dependencyPresentation';
import { renderStatusMarker } from '../src/ui/StatusMarker';
import { freshContainer } from './helpers';

const registry = new StatusRegistry(DEFAULT_SETTINGS.taskStatuses);
const blocked: DependencyCompletionDecision = {
  type: 'blocked',
  prerequisites: [{ filePath: 'Prep.md', line: 0, revision: 'prep' }],
};

describe('Project dependency accessibility', () => {
  it('marks only an open root completion control aria-disabled without suppressing activation', () => {
    const host = freshContainer();
    const activate = vi.fn();
    const marker = renderStatusMarker(host, {
      task: { status: 'open', statusSymbol: ' ', priority: 'D' },
      registry,
      completionDecision: blocked,
      onLeftClick: activate,
      onContextMenu: vi.fn(),
    });

    expect(marker.getAttribute('aria-disabled')).toBe('true');
    expect(marker.classList.contains('abyss-status-marker--completion-blocked')).toBe(true);
    expect(marker.hasAttribute('disabled')).toBe(false);
    marker.click();
    marker.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    marker.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['already Done root', { status: 'done', statusSymbol: 'x' }, blocked, true],
    ['subtask without a root projection', { status: 'open', statusSymbol: ' ' }, undefined, true],
    ['forecast-only inert marker', { status: 'open', statusSymbol: ' ' }, blocked, false],
  ] as const)('does not aria-disable the %s', (_label, task, decision, interactive) => {
    const marker = renderStatusMarker(freshContainer(), {
      task,
      registry,
      interactive,
      ...(decision && { completionDecision: decision }),
      onLeftClick: vi.fn(),
      onContextMenu: vi.fn(),
    });

    expect(marker.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('uses the existing compact count-badge dialect for blocked and invalid dependency state', () => {
    const host = freshContainer();
    const blockedBadge = renderDependencyBadge(host, blocked)!;
    const invalidBadge = renderDependencyBadge(host, {
      type: 'invalid',
      diagnostics: [{ type: 'missing-prerequisite', id: 'missing' }],
    })!;

    expect(blockedBadge.classList.contains('abyss-task-count-badge')).toBe(true);
    expect(blockedBadge.classList.contains('abyss-task-dependency-badge')).toBe(true);
    expect(blockedBadge.textContent?.trim()).toBe('1');
    expect(blockedBadge.getAttribute('aria-label')).toBe('Blocked by 1 prerequisite');
    expect(blockedBadge.getAttribute('title')).toBe('Blocked by 1 prerequisite');
    expect(invalidBadge.textContent?.trim()).toBe('1');
    expect(invalidBadge.getAttribute('aria-label')).toBe('Dependency issue');
    expect(invalidBadge.getAttribute('title')).toBe('Dependency issue');
  });
});
