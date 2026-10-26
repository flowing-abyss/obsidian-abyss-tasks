import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDashboardTimeline } from '../src/panels/projects/ProjectDashboardTimeline';
import { TaskTimelineSurface } from '../src/panels/task-collection/TaskTimelineSurface';
import { indexedRows } from '../src/panels/task-list/taskListRows';
import type {
  TimelineContextOverlay,
  TimelineContextOverlayLayout,
} from '../src/panels/timeline/TimelineContextOverlay';
import { projectCalendarDayOrdinal } from '../src/projects/projectDateValue';
import { buildConfiguredProjectFieldCatalog } from '../src/projects/projectFields';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { defaultTaskTimelineSettings } from '../src/task-lists/taskTimelineSettings';
import { localDate, type TaskPlanning } from '../src/tasks';
import { expectDefined, flushMicrotasks } from './helpers';
import { projectWindowMigration } from './support/projectWindowMigration';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { taskViewportOwner } from './support/taskViewportOwner';
afterEach(() => vi.restoreAllMocks());
it('bounds mounted rows and calendar cells and reveals a distant task through the shared viewport', () => {
  const host = document.body.createDiv({ cls: 'abyss-center-scroll' });
  prepareTaskPanelViewport(host);
  const settings = defaultTaskTimelineSettings();
  const surface = new TaskTimelineSurface<TaskPlanning>(
    {
      host,
      scroll: host,
      mountedChanged: () => {},
      reportFailure: (error) => {
        throw error;
      },
      mount: (parent, row) => {
        const element = parent.createDiv({ cls: 'abyss-task-card' });
        element.dataset['key'] = row.key;
        return {
          element,
          update: () => {},
          destroy: () => {
            element.remove();
          },
        };
      },
    },
    {
      settings: () => settings,
      now: () => new Date(2026, 9, 26),
      planning: (value) => value,
      snapshot: () => undefined,
      commit: async () => false,
      select: () => {},
      openDates: () => {},
      changeScale: () => {},
    },
  );
  try {
    const rows = indexedRows(
      Array.from({ length: 5000 }, (_, i) => ({
        kind: 'task' as const,
        key: `n:${i}`,
        taskKey: `n:${i}`,
        task: { start: localDate('2026-10-24'), due: localDate('2026-10-28') },
      })),
    );
    surface.update(rows, {
      revision: 'one',
      preserveAnchor: true,
      estimate: () => 64,
      measurementRevision: () => '',
    });
    const today = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
      ),
    );
    const tracks = [
      ...host.querySelectorAll<HTMLElement>(
        '.abyss-task-timeline-row > .abyss-project-timeline-track',
      ),
    ];
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      expect(
        track.querySelector<HTMLElement>(':scope > .abyss-project-timeline-today')?.style.left,
      ).toBe(today.style.left);
    }
    expect(host.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.abyss-task-card').length).toBeLessThan(100);
    expect(host.querySelectorAll('.abyss-project-timeline-axis-cell').length).toBeLessThan(100);
    expect(surface.reveal('n:4999')?.dataset['key']).toBe('n:4999');
    expect(surface.mountedKeys().length).toBeLessThan(100);
    const card = expectDefined(surface.element('n:4999'));
    expect(card.classList.contains('abyss-task-card')).toBe(true);
  } finally {
    surface.destroy();
    host.remove();
  }
});

function continuousTimeline(
  initialWidth = 900,
  planning: TaskPlanning = { start: localDate('2026-10-24'), due: localDate('2026-10-28') },
  mountContext?: (
    host: HTMLElement,
    layout: TimelineContextOverlayLayout,
  ) => TimelineContextOverlay,
  rowCount = 1,
) {
  const host = document.body.createDiv({ cls: 'abyss-center-scroll' });
  prepareTaskPanelViewport(host);
  let width = initialWidth;
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width });
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  let now = new Date(2026, 9, 26);
  const settings = defaultTaskTimelineSettings();
  const updates = vi.fn();
  const changeScale = vi.fn((scale: typeof settings.scale) => {
    settings.scale = scale;
    update();
  });
  const surface = new TaskTimelineSurface<TaskPlanning>(
    {
      host,
      scroll: host,
      mountedChanged: () => {},
      reportFailure: (error) => {
        throw error;
      },
      mount: (parent) => {
        const element = parent.createDiv({ cls: 'abyss-task-card' });
        return {
          element,
          update: updates,
          destroy: () => {
            element.remove();
          },
        };
      },
    },
    {
      settings: () => settings,
      now: () => now,
      planning: (value) => value,
      snapshot: () => undefined,
      commit: async () => false,
      select: () => {},
      openDates: () => {},
      changeScale,
      mountContext: (host, layout) => mountContext?.(host, layout),
    },
  );
  const summary = expectDefined(
    host.querySelector<HTMLElement>('.abyss-project-timeline-axis-summary'),
  );
  vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue({ width: 180 } as DOMRect);
  const rows = indexedRows(
    Array.from({ length: rowCount }, (_, index) => ({
      kind: 'task' as const,
      key: index === 0 ? 'one' : `row:${index}`,
      taskKey: `task:${index}`,
      task: planning,
    })),
  );
  function update() {
    surface.update(rows, {
      revision: 'one',
      preserveAnchor: true,
      estimate: () => 64,
      measurementRevision: () => '',
    });
  }
  function flush() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  }
  const button = (name: string) =>
    expectDefined(
      [...host.querySelectorAll('button')].find((button) => button.textContent === name),
    );
  const todayX = () => {
    const marker = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
      ),
    );
    return (
      180 +
      (parseFloat(marker.style.left) / 100) * surface.captureScroll().viewport.trackWidth -
      host.scrollLeft
    );
  };
  update();
  return {
    host,
    surface,
    updates,
    changeScale,
    update,
    flush,
    button,
    todayX,
    resize: (value: number) => {
      width = value;
      surface.refreshMeasurements();
      flush();
    },
    nextDay: (refresh = true) => {
      now = new Date(2026, 9, 27);
      if (refresh) update();
    },
    dispose: () => {
      surface.destroy();
      host.remove();
    },
  };
}

it('centers Today, keeps a fractional zoom center, and centers active scales without a settings write', () => {
  const h = continuousTimeline();
  try {
    expect(h.host.querySelector('[aria-label="Previous range"]')).toBeNull();
    expect(
      [...h.host.querySelectorAll('button')].some((button) => button.textContent === 'Today'),
    ).toBe(false);
    expect(h.todayX()).toBeCloseTo(540, 1);
    h.host.scrollLeft += 153.375;
    const center = h.surface.captureScroll().center;
    if (center === 'today') throw new Error('Expected a measured timeline center');
    h.button('Day').click();
    expect(h.surface.captureScroll().center).toBeCloseTo(center, 9);
    h.button('Day').click();
    expect(h.todayX()).toBeCloseTo(540, 1);
    expect(h.changeScale).toHaveBeenCalledTimes(1);
    expect(h.button('Day').title).toContain('Today');
    h.host.scrollTop = 83.5;
    h.resize(550);
    expect(h.todayX()).toBeCloseTo(365, 1);
    expect(h.host.scrollTop).toBe(83.5);
  } finally {
    h.dispose();
  }
});

it('retains pending Today until nonzero measurement and yields to a newer reveal', () => {
  const h = continuousTimeline(0, { scheduled: localDate('2032-04-08') });
  try {
    h.surface.reveal('one');
    h.resize(900);
    const state = expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-timeline-state'),
    );
    expect(state.hidden).toBe(true);
    expect(h.surface.captureScroll().center).toBe(
      (projectCalendarDayOrdinal('2032-04-08') as number) + 0.5,
    );
    h.button('Month').click();
    expect(h.todayX()).toBeCloseTo(540, 1);
  } finally {
    h.dispose();
  }
  const initial = continuousTimeline(0);
  try {
    initial.resize(900);
    expect(initial.todayX()).toBeCloseTo(540, 1);
  } finally {
    initial.dispose();
  }
});

it.each(['initial', 'active', 'restored'] as const)(
  'resolves deferred Today after midnight (%s)',
  (entry) => {
    const h = continuousTimeline(entry === 'active' ? 900 : 0);
    try {
      if (entry === 'active') {
        h.resize(0);
        h.button('Month').click();
      }
      const saved = h.surface.captureScroll();
      h.nextDay();
      if (entry === 'restored') h.surface.restoreScroll(saved);
      h.resize(900);
      expect(h.surface.captureScroll().center).toBe(20753.5);
      expect(h.todayX()).toBeCloseTo(540, 1);
    } finally {
      h.dispose();
    }
  },
);

it('rebases repeatedly in both directions with continuous coordinates and retained card DOM', () => {
  const h = continuousTimeline();
  try {
    const card = h.surface.element('one');
    const initial = h.surface.captureScroll();
    h.updates.mockClear();
    for (const left of [100.375, 30000.125, 50.625, 32000.875]) {
      const before = h.surface.captureScroll().viewport;
      const expected =
        (projectCalendarDayOrdinal(before.window.startDay) as number) +
        (left + 360) / before.dayWidth;
      h.host.scrollLeft = left;
      h.host.dispatchEvent(new Event('scroll'));
      h.flush();
      expect(h.surface.captureScroll().center).toBeCloseTo(expected, 9);
      expect(h.surface.captureScroll().viewport.trackWidth).toBe(initial.viewport.trackWidth);
      expect(h.surface.element('one')).toBe(card);
      expect(h.host.querySelectorAll('.abyss-project-timeline-axis-cell').length).toBeLessThan(100);
    }
    expect(h.updates).not.toHaveBeenCalled();
    const saved = h.surface.captureScroll();
    if (saved.center === 'today') throw new Error('Expected a measured timeline center');
    h.surface.suspend();
    h.surface.resume();
    h.flush();
    expect(h.surface.captureScroll().center).toBeCloseTo(saved.center, 9);
    h.button('Month').click();
    h.surface.restoreScroll(saved);
    h.resize(600);
    expect(h.surface.captureScroll().center).toBeCloseTo(saved.center, 9);
  } finally {
    h.dispose();
  }
});

it('reveals a Scheduled-only task that is in the physical buffer but outside the exposed viewport without replacing its card', () => {
  const h = continuousTimeline(900, { scheduled: localDate('2027-04-08') });
  try {
    const card = h.surface.element('one');
    const scheduled = expectDefined(
      h.host.querySelector<HTMLElement>(
        '.abyss-task-timeline-scheduled-track .abyss-project-timeline-bar',
      ),
    );
    const state = expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-project-timeline-state'),
    );
    expect(scheduled.hidden).toBe(false);
    expect(state.hidden).toBe(false);
    expect(state.disabled).toBe(false);
    state.click();
    expect(state.hidden).toBe(true);
    expect(h.surface.element('one')).toBe(card);
    expect(h.surface.captureScroll().center).toBe(
      (projectCalendarDayOrdinal('2027-04-08') as number) + 0.5,
    );
  } finally {
    h.dispose();
  }
});

it('preserves logical focus while moving the retained surface to another owning window and retires old native work', () => {
  const migration = projectWindowMigration();
  const h = continuousTimeline();
  const target = taskViewportOwner();
  try {
    h.host.scrollLeft += 123.375;
    h.host.dispatchEvent(new Event('scroll'));
    const center = h.surface.captureScroll().center;
    if (center === 'today') throw new Error('Expected a measured timeline center');
    target.doc.body.append(h.host);
    migration.notify(h.host);
    h.surface.resume();
    h.flush();
    target.flush();
    expect(h.surface.captureScroll().center).toBeCloseTo(center, 9);
    expect(target.observers.some((observer) => observer.elements.has(h.host))).toBe(true);
    h.surface.destroy();
    expect(target.frames.size).toBe(0);
    expect(target.observers.every((observer) => observer.elements.size === 0)).toBe(true);
    expect(migration.bindings.size).toBe(0);
  } finally {
    h.dispose();
    target.destroy();
  }
});

it('updates mounted Today markers when the civil day changes without a row revision', () => {
  const h = continuousTimeline();
  try {
    h.nextDay();
    const header = expectDefined(
      h.host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
      ),
    );
    const row = expectDefined(
      h.host.querySelector<HTMLElement>('.abyss-task-timeline-row .abyss-project-timeline-today'),
    );
    expect(header.getAttribute('aria-label')).toBe('Today, 2026-10-27');
    expect(row.getAttribute('aria-label')).toBe(header.getAttribute('aria-label'));
    expect(row.style.left).toBe(header.style.left);
  } finally {
    h.dispose();
  }
});

it('refreshes row Today markers on a scroll frame after midnight without repainting cards', () => {
  const h = continuousTimeline();
  try {
    const card = h.surface.element('one');
    h.updates.mockClear();
    h.nextDay(false);
    h.host.scrollLeft += 37.25;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    const header = expectDefined(
      h.host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
      ),
    );
    const row = expectDefined(
      h.host.querySelector<HTMLElement>('.abyss-task-timeline-row .abyss-project-timeline-today'),
    );
    expect(header.getAttribute('aria-label')).toBe('Today, 2026-10-27');
    expect(row.getAttribute('aria-label')).toBe('Today, 2026-10-27');
    expect(row.style.left).toBe(header.style.left);
    expect(h.surface.element('one')).toBe(card);
    expect(h.updates).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('lets newer horizontal user motion supersede pending initial Today', () => {
  const h = continuousTimeline(0);
  try {
    h.host.scrollLeft = 211.75;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    const center = h.surface.captureScroll().center;
    if (center === 'today') throw new Error('Expected a measured timeline center');
    h.nextDay();
    h.resize(900);
    expect(h.surface.captureScroll().center).toBeCloseTo(center, 9);
    expect(center).not.toBe((projectCalendarDayOrdinal('2026-10-26') as number) + 0.5);
  } finally {
    h.dispose();
  }
});

it('keeps dashboard boundaries actionable when active-scale Today leaves the geometry unchanged', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const apply = vi.fn(async () => ({ applied: [], failed: [] }));
  const h = continuousTimeline(
    900,
    {},
    (host, layout) =>
      new ProjectDashboardTimeline(host, {
        ...layout,
        project: () => ({
          path: 'Projects/A.md',
          name: 'A',
          frontmatter: { start: '2026-10-24', end: '2026-10-28' },
          statusId: null,
          rawStatus: null,
          tags: [],
          stats: {
            total: 0,
            done: 0,
            cancelled: 0,
            inProgress: 0,
            tracked: { closedMs: 0, openStartsMs: [] },
          },
        }),
        fields: () => buildConfiguredProjectFieldCatalog(DEFAULT_SETTINGS.projects),
        apply,
        history: async () => ({ applied: [], failed: [] }),
      }),
  );
  try {
    h.button('Month').click();
    const end = expectDefined(
      h.host.querySelector<HTMLElement>('.abyss-project-boundary-handle.is-end'),
    );
    const boundaries = expectDefined(end.closest('.abyss-project-timeline-boundaries'));
    expect(boundaries.parentElement).toBe(h.host.querySelector('.abyss-task-timeline-heading'));
    expect(boundaries.previousElementSibling).toBe(
      h.host.querySelector('.abyss-project-timeline-axis'),
    );
    expect(boundaries.querySelector('.abyss-project-timeline-axis-summary')?.textContent).toBe(
      'Project dates',
    );
    end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushMicrotasks();
    expect(apply).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sourceProperty: 'end', value: '2026-10-29' }),
      ]),
    );
    expect(logged).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('lets a reveal supersede delayed Today even when its date is exposed in retained geometry', () => {
  const h = continuousTimeline(900, { start: localDate('2032-04-08') });
  try {
    h.surface.reveal('one');
    const center = h.surface.captureScroll().center;
    if (center === 'today') throw new Error('Expected a measured timeline center');
    h.resize(0);
    h.surface.focusToday();
    h.surface.reveal('one');
    h.resize(900);
    expect(h.surface.captureScroll().center).toBe(center);
  } finally {
    h.dispose();
  }
});

it.each(['commit', 'cancel'] as const)(
  'keeps dashboard boundary %s continuous through the real surface rebase scheduler',
  async (outcome) => {
    const apply = vi.fn(async () => ({ applied: [], failed: [] }));
    const h = continuousTimeline(900, {}, (host, layout) => {
      const overlay = new ProjectDashboardTimeline(host, {
        ...layout,
        project: () => ({
          path: 'Projects/A.md',
          name: 'A',
          frontmatter: { end: '2026-10-28' },
          statusId: null,
          rawStatus: null,
          tags: [],
          stats: {
            total: 0,
            done: 0,
            cancelled: 0,
            inProgress: 0,
            tracked: { closedMs: 0, openStartsMs: [] },
          },
        }),
        fields: () => buildConfiguredProjectFieldCatalog(DEFAULT_SETTINGS.projects),
        apply,
        history: async () => ({ applied: [], failed: [] }),
      });
      const track = expectDefined(
        host.querySelector<HTMLElement>(
          '.abyss-project-timeline-boundaries > .abyss-project-timeline-track',
        ),
      );
      vi.spyOn(track, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            left: 180 - layout.scroll.scrollLeft,
            width: layout.window().dayCount * (120 / 28),
          }) as DOMRect,
      );
      return overlay;
    });
    const pointer = (type: string, clientX: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        buttons: { value: type === 'pointerup' ? 0 : 1 },
        pointerId: { value: 1 },
        isPrimary: { value: true },
        clientX: { value: clientX },
        clientY: { value: 40 },
      });
      return event;
    };
    try {
      const handle = expectDefined(
        h.host.querySelector<HTMLElement>('.abyss-project-boundary-handle.is-end'),
      );
      const line = expectDefined(
        h.host.querySelector<HTMLElement>(
          '.abyss-task-timeline-row .abyss-project-boundary-line.is-end',
        ),
      );
      const card = h.surface.element('one');
      handle.dispatchEvent(pointer('pointerdown', 550));
      await flushMicrotasks();
      handle.dispatchEvent(pointer('pointermove', 600));
      let expectedOrdinal = 0;
      for (const left of [100.375, 32000.125, 100.375, 32000.125]) {
        const before = h.surface.captureScroll().viewport;
        expectedOrdinal =
          (projectCalendarDayOrdinal(before.window.startDay) as number) +
          Math.floor((left + 420) / before.dayWidth);
        h.host.scrollLeft = left;
        h.host.dispatchEvent(new Event('scroll'));
        h.flush();
        const after = h.surface.captureScroll().viewport;
        expect(after.window.startDay).not.toBe(before.window.startDay);
        const displayedOrdinal =
          (projectCalendarDayOrdinal(after.window.startDay) as number) +
          (parseFloat(line.style.left) / 100) * after.window.dayCount -
          0.5;
        expect(displayedOrdinal).toBeCloseTo(expectedOrdinal, 7);
        expect(h.host.querySelector('.abyss-project-boundary-handle.is-end')).toBe(handle);
        expect(h.surface.element('one')).toBe(card);
      }
      const expectedDay = new Date(expectedOrdinal * 86400000).toISOString().slice(0, 10);
      if (outcome === 'cancel')
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      handle.dispatchEvent(pointer('pointerup', 600));
      await flushMicrotasks();
      if (outcome === 'commit')
        expect(apply).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              sourceProperty: 'end',
              expectedValue: '2026-10-28',
              value: expectedDay,
            }),
            expect.objectContaining({
              sourceProperty: 'start',
              expectedExists: false,
              valueExists: false,
              restoreSourceValue: true,
            }),
          ]),
        );
      else expect(apply).not.toHaveBeenCalled();
      const after = h.surface.captureScroll().viewport;
      const restoredOrdinal =
        (projectCalendarDayOrdinal(after.window.startDay) as number) +
        (parseFloat(line.style.left) / 100) * after.window.dayCount -
        0.5;
      expect(restoredOrdinal).toBeCloseTo(projectCalendarDayOrdinal('2026-10-28') as number, 7);
    } finally {
      h.dispose();
    }
  },
);

it('bounds native horizontal geometry reads as the mounted row count grows', () => {
  function sample(count: number) {
    const h = continuousTimeline(900, undefined, undefined, count);
    let left = h.host.scrollLeft;
    let reads = 0;
    Object.defineProperty(h.host, 'scrollLeft', {
      configurable: true,
      get: () => {
        reads++;
        return left;
      },
      set: (value: number) => {
        left = value;
      },
    });
    try {
      left += 37.25;
      h.updates.mockClear();
      h.host.dispatchEvent(new Event('scroll'));
      h.flush();
      expect(h.updates).not.toHaveBeenCalled();
      return { reads, mounted: h.surface.mountedKeys().length };
    } finally {
      h.dispose();
    }
  }
  const small = sample(1);
  const large = sample(5000);
  expect(large.mounted).toBeGreaterThan(small.mounted * 10);
  expect(large.reads).toBeLessThanOrEqual(small.reads + 2);
});
