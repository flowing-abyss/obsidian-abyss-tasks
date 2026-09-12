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
  const present = vi.fn((candidate: Project, focus: boolean) => {
    let element = elements.get(candidate.path);
    if (element?.isConnected !== true) {
      element = host.createDiv({ attr: { 'data-path': candidate.path } });
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
});
