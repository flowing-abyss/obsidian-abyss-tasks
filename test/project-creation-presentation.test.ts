import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectCreationPresentation } from '../src/panels/projects/ProjectCreationPresentation';
import type { Project } from '../src/projects/types';
import { expectDefined, freshContainer } from './helpers';

function project(statusId = 'active'): Project {
  return {
    path: 'Projects/New.md',
    name: 'New',
    frontmatter: { status: statusId },
    tags: [],
    statusId,
    rawStatus: null,
    stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
  };
}

afterEach(() => {
  activeDocument.body.empty();
  vi.useRealTimers();
});

function harness(initial: readonly Project[] = []) {
  const host = freshContainer();
  activeDocument.body.append(host);
  const elements = new Map<string, HTMLElement>();
  let projects = initial;
  let presentable = true;
  const present = vi.fn((candidate: Project, focus: boolean) => {
    if (!presentable) return null;
    let element = elements.get(candidate.path);
    if (element?.isConnected !== true) {
      element = host.createDiv({ attr: { 'data-path': candidate.path } });
      element.tabIndex = -1;
      elements.set(candidate.path, element);
    }
    if (focus) element.focus({ preventScroll: true });
    return element;
  });
  const inaccessible = vi.fn();
  const controller = new ProjectCreationPresentation({
    host,
    projects: () => projects,
    present,
    inaccessible,
    reducedMotion: () => false,
    now: () => Date.now(),
  });
  return {
    host,
    controller,
    present,
    inaccessible,
    elements,
    setProjects: (next: Project[]) => (projects = next),
    setPresentable: (value: boolean) => (presentable = value),
  };
}

describe('ProjectCreationPresentation', () => {
  it('presents an already-published project immediately after command completion', () => {
    const h = harness([project()]);
    h.controller.enqueue({ path: 'Projects/New.md', expectedStatus: 'active' });

    expect(h.present).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Projects/New.md' }),
      true,
    );
    expect(expectDefined(h.elements.get('Projects/New.md')).classList).toContain('is-just-created');
  });

  it('waits for a future snapshot and ignores an intermediate template status', () => {
    const h = harness([project('planned')]);
    h.controller.enqueue({ path: 'Projects/New.md', expectedStatus: 'done' });
    expect(h.present).not.toHaveBeenCalled();

    h.setProjects([project('done')]);
    h.controller.update();

    expect(h.present).toHaveBeenCalledOnce();
  });

  it('rebinds the highlight without stealing focus and releases it on disposal', () => {
    const h = harness([project()]);
    h.controller.enqueue({ path: 'Projects/New.md', expectedStatus: 'active' });
    const stale = expectDefined(h.elements.get('Projects/New.md'));
    stale.remove();

    h.controller.update();
    const replacement = expectDefined(h.elements.get('Projects/New.md'));

    expect(stale.classList).not.toContain('is-just-created');
    expect(replacement.classList).toContain('is-just-created');
    expect(h.present).toHaveBeenLastCalledWith(expect.anything(), false);
    h.controller.destroy();
    expect(replacement.classList).not.toContain('is-just-created');
  });

  it('reports an actionable owned path when the project never enters the membership snapshot', () => {
    vi.useFakeTimers();
    const h = harness();
    h.controller.enqueue({ path: 'Projects/New.md', expectedStatus: 'active' });

    vi.advanceTimersByTime(3_000);

    expect(h.inaccessible).toHaveBeenCalledWith('Projects/New.md');
  });

  it('does not reclaim focus after the creation interaction loses ownership', () => {
    const h = harness();
    let ownsFocus = true;
    h.controller.enqueue({
      path: 'Projects/New.md',
      expectedStatus: 'active',
      ownsFocus: () => ownsFocus,
    });
    const outside = activeDocument.body.createEl('button');
    outside.focus();
    ownsFocus = false;

    h.setProjects([project()]);
    h.controller.update();

    expect(h.present).toHaveBeenCalledWith(expect.anything(), false);
    expect(activeDocument.activeElement).toBe(outside);
  });

  it('does not report a query exclusion after focus ownership is abandoned', () => {
    vi.useFakeTimers();
    const h = harness();
    let ownsFocus = true;
    h.controller.enqueue({
      path: 'Projects/New.md',
      expectedStatus: 'active',
      ownsFocus: () => ownsFocus,
    });
    ownsFocus = false;

    vi.advanceTimersByTime(3_000);

    expect(h.inaccessible).not.toHaveBeenCalled();
  });

  it('waits past the lookup timeout once membership resolves before reconciliation', () => {
    vi.useFakeTimers();
    const h = harness([project()]);
    h.setPresentable(false);
    h.controller.enqueue({ path: 'Projects/New.md', expectedStatus: 'active' });

    vi.advanceTimersByTime(3_000);
    expect(h.inaccessible).not.toHaveBeenCalled();

    h.setPresentable(true);
    h.controller.update();
    expect(h.present).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(expectDefined(h.elements.get('Projects/New.md')).classList).toContain('is-just-created');
  });

  it('silently expires unresolved DOM presentation at one fixed resolved deadline', () => {
    vi.useFakeTimers();
    const h = harness([project()]);
    h.setPresentable(false);
    h.controller.enqueue({ path: 'Projects/New.md', expectedStatus: 'active' });
    vi.advanceTimersByTime(20_000);
    h.controller.update();
    vi.advanceTimersByTime(9_999);
    h.controller.update();
    const attemptsBeforeExpiry = h.present.mock.calls.length;

    vi.advanceTimersByTime(1);
    h.setPresentable(true);
    h.controller.update();

    expect(h.present).toHaveBeenCalledTimes(attemptsBeforeExpiry);
    expect(h.elements.get('Projects/New.md')).toBeUndefined();
    expect(h.inaccessible).not.toHaveBeenCalled();
  });
});
