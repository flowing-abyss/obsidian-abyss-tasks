import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDashboardTimeline } from '../src/panels/projects/ProjectDashboardTimeline';
import { TaskTimelineSurface } from '../src/panels/task-collection/TaskTimelineSurface';
import { indexedRows } from '../src/panels/task-list/taskListRows';
import type {
  TimelineContextOverlay,
  TimelineContextOverlayLayout,
} from '../src/panels/timeline/TimelineContextOverlay';
import * as timelinePresentation from '../src/panels/timeline/timelinePresentation';
import { projectCalendarDayOrdinal } from '../src/projects/projectDateValue';
import { buildConfiguredProjectFieldCatalog } from '../src/projects/projectFields';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { defaultTaskTimelineSettings } from '../src/task-lists/taskTimelineSettings';
import { localDate, type TaskPlanning } from '../src/tasks';
import { expectDefined, flushMicrotasks } from './helpers';
import { serializedPercent } from './support/cssGeometry';
import { projectWindowMigration } from './support/projectWindowMigration';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { taskViewportOwner } from './support/taskViewportOwner';
afterEach(() => vi.restoreAllMocks());
it('bounds mounted rows and calendar cells and reveals a distant task through the shared viewport', () => {
  const host = document.body.createDiv({ cls: 'abyss-center-scroll' });
  prepareTaskPanelViewport(host);
  const settings = defaultTaskTimelineSettings();
  const measurementReady = vi.fn(() => true);
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
          measurementReady,
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
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: 180 }));
    expect(surface.reveal('n:4999')?.dataset['key']).toBe('n:4999');
    expect(measurementReady).toHaveBeenCalledWith(true);
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
  list:
    | number
    | {
        count: number;
        height: number;
        restore?: ReturnType<TaskTimelineSurface<TaskPlanning>['captureScroll']>;
      } = 1,
) {
  const calibration = typeof list === 'number' ? undefined : list;
  const rowCount = typeof list === 'number' ? list : list.count;
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
        const sizeRow = () => {
          if (calibration !== undefined)
            expectDefined(parent.parentElement).style.height = `${calibration.height}px`;
        };
        sizeRow();
        return {
          element,
          update: () => {
            sizeRow();
            updates();
          },
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
      ...(calibration !== undefined && {
        indexedHeights: { task: 64, group: 32, sampleOpeningTasks: true },
      }),
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
  if (calibration?.restore !== undefined) surface.restoreScroll(calibration.restore);
  update();
  return {
    settings,
    summary,
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

it('calibrates Timeline rows to their summary and preserves a deep anchor across width, card settings and reopen', () => {
  // The measured height takes the full source above the native million-pixel ceiling.
  const geometry = { count: 12000, height: 96 };
  const h = continuousTimeline(900, undefined, undefined, geometry);
  try {
    const initial = h.surface.captureScroll().rows.taskHeightSample;
    expect(initial).toMatchObject({ width: 180, height: 96 });
    h.button('Day').click();
    expect(h.surface.captureScroll().rows.taskHeightSample).toBe(initial);
    h.host.scrollTop = 640000;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    const first = expectDefined(h.surface.captureScroll().rows.anchor);
    expect(h.surface.element(first.key)?.isConnected).toBe(true);
    geometry.height = 120;
    vi.spyOn(h.summary, 'getBoundingClientRect').mockReturnValue({ width: 150 } as DOMRect);
    h.update();
    const resized = h.surface.captureScroll();
    expect(resized.rows.taskHeightSample).toMatchObject({ width: 150, height: 120 });
    expect(resized.rows.anchor).toMatchObject({ key: first.key, offset: first.offset });
    geometry.height = 76;
    h.settings.showMetadata = !h.settings.showMetadata;
    h.update();
    const changed = h.surface.captureScroll();
    expect(changed.rows.taskHeightSample).toMatchObject({ width: 150, height: 76 });
    expect(changed.rows.anchor).toMatchObject({ key: first.key, offset: first.offset });
    const restored = continuousTimeline(900, undefined, undefined, {
      count: 12000,
      height: 96,
      restore: changed,
    });
    try {
      const result = restored.surface.captureScroll().rows;
      expect(result.taskHeightSample).toMatchObject({ width: 180, height: 96 });
      expect(result.anchor).toMatchObject({ key: first.key, offset: first.offset });
      expect(restored.surface.element(first.key)?.isConnected).toBe(true);
    } finally {
      restored.dispose();
    }
  } finally {
    h.dispose();
  }
});

it('keeps a screenful of task rows ready before each fast vertical step and reversal', () => {
  const h = continuousTimeline(900, undefined, undefined, 5000);
  try {
    const firstLeft = h.host.scrollLeft;
    for (const top of [896, 1792, 2688, 1792, 896]) {
      h.host.scrollTop = top;
      // The compositor may move the viewport before notifying the virtualizer.
      for (const offset of [64, 448, 832]) {
        const index = Math.floor((top + offset) / 64);
        expect(h.surface.element(`row:${index}`)?.isConnected).toBe(true);
      }
      h.host.dispatchEvent(new Event('scroll'));
      h.flush();
      expect(h.surface.mountedKeys().length).toBeLessThanOrEqual(80);
    }
    expect(h.host.scrollLeft).toBe(firstLeft);
  } finally {
    h.dispose();
  }
});

it('synchronizes large vertical pixel-wheel steps with the painted Timeline and preserves native input elsewhere', () => {
  const h = continuousTimeline(900, undefined, undefined, 640);
  Object.defineProperty(h.host, 'scrollHeight', { configurable: true, value: 640 * 64 });
  const wheel = (init: WheelEventInit) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    h.host.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const left = h.host.scrollLeft;
    expect(wheel({ deltaY: 200 })).toBe(false);
    expect(wheel({ deltaY: 3600, ctrlKey: true })).toBe(false);
    expect(wheel({ deltaY: 3600, shiftKey: true })).toBe(false);
    expect(wheel({ deltaY: 3600, deltaX: 4800 })).toBe(false);
    const nested = h.host.createDiv();
    nested.style.overflowY = 'auto';
    Object.defineProperties(nested, { clientHeight: { value: 60 }, scrollHeight: { value: 260 } });
    const overNested = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1800 });
    nested.dispatchEvent(overNested);
    expect(overNested.defaultPrevented).toBe(false);
    nested.remove();
    expect(wheel({ deltaY: -3600 })).toBe(false);
    expect(wheel({ deltaY: 3600, deltaX: 12 })).toBe(true);
    expect(h.host.scrollTop).toBe(3600);
    expect(h.host.scrollLeft).toBe(left + 12);
    expect(wheel({ deltaY: -1500 })).toBe(true);
    expect(h.host.scrollTop).toBe(2100);
  } finally {
    h.dispose();
  }
});

it('fills a distant jump before the next animation callback and admits only the last position', async () => {
  const h = continuousTimeline(900, undefined, undefined, 5000);
  try {
    for (const top of [64000, 32000]) {
      h.host.scrollTop = top;
      h.host.dispatchEvent(new Event('scroll'));
    }
    await Promise.resolve();
    expect(h.surface.element('row:505')?.isConnected).toBe(true);
    expect(h.surface.element('row:1005')).toBeUndefined();
    expect(h.surface.mountedKeys().length).toBeLessThanOrEqual(80);
  } finally {
    h.dispose();
  }
});

it('reuses the calendar grid while mounting new rows on a vertical fling', () => {
  const overlayUpdate = vi.fn();
  const h = continuousTimeline(
    900,
    undefined,
    () => ({
      range: () => ({ kind: 'unscheduled' }),
      update: overlayUpdate,
      mountTrack: () => () => {},
      cancel: () => {},
      destroy: () => {},
    }),
    5000,
  );
  try {
    h.flush();
    const grid = () => expectDefined(h.host.querySelector('.abyss-project-timeline-grid'));
    const definition = expectDefined(
      h.host.querySelector('symbol.abyss-project-timeline-grid-definition'),
    );
    const positions = () => [...definition.children].map((line) => line.getAttribute('x'));
    const expected = positions();
    expect(expected.length).toBeGreaterThan(0);
    expect(grid().querySelector('use')?.getAttribute('href')).toBe(`#${definition.id}`);
    const patch = vi.spyOn(timelinePresentation, 'patchTimelineGrid');
    overlayUpdate.mockClear();
    h.host.scrollTop = 32000;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(h.surface.element('row:505')?.isConnected).toBe(true);
    expect(positions()).toEqual(expected);
    expect(grid().querySelector('use')?.getAttribute('href')).toBe(`#${definition.id}`);
    expect(patch).not.toHaveBeenCalled();
    expect(overlayUpdate).not.toHaveBeenCalled();
    h.host.scrollLeft += 400;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(overlayUpdate).toHaveBeenCalled();
    expect(positions()).not.toEqual(expected);
    expect(patch).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

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
    const grids = vi.spyOn(timelinePresentation, 'patchTimelineGrid');
    target.doc.body.append(h.host);
    migration.notify(h.host);
    h.surface.resume();
    h.flush();
    target.flush();
    expect(h.surface.captureScroll().center).toBeCloseTo(center, 9);
    h.host.scrollLeft += 400;
    h.host.dispatchEvent(new Event('scroll'));
    target.flush();
    expect(grids).toHaveBeenCalled();
    expect(grids.mock.calls.every(([grid]) => grid.ownerDocument === target.doc)).toBe(true);
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
        const offset =
          expectedOrdinal - (projectCalendarDayOrdinal(after.window.startDay) as number);
        expect(line.style.left).toBe(
          serializedPercent(((offset + 0.5) / after.window.dayCount) * 100),
        );
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
      const offset =
        (projectCalendarDayOrdinal('2026-10-28') as number) -
        (projectCalendarDayOrdinal(after.window.startDay) as number);
      expect(line.style.left).toBe(
        serializedPercent(((offset + 0.5) / after.window.dayCount) * 100),
      );
    } finally {
      h.dispose();
    }
  },
);

it('gives an immediate reveal priority over a pending restored center', () => {
  const h = continuousTimeline(900, { scheduled: localDate('2026-10-29') });
  try {
    h.surface.restoreScroll(h.surface.captureScroll());
    h.host.scrollLeft += 4;
    h.surface.reveal('one');
    expect(h.surface.captureScroll().center).toBe(
      (projectCalendarDayOrdinal('2026-10-29') as number) + 0.5,
    );
  } finally {
    h.dispose();
  }
});

it('positions a revealed row at the native offset and reconciles an immediate return before any scroll event', () => {
  const h = continuousTimeline(900, { scheduled: localDate('2027-04-08') }, undefined, 5000);
  try {
    h.flush();
    const originalLeft = h.host.scrollLeft;
    const saved = h.surface.captureScroll();
    if (saved.center === 'today') throw new Error('Expected a measured calendar center');
    const day = (projectCalendarDayOrdinal('2027-04-08') as number) + 0.5;
    h.host.scrollLeft += (day - saved.center) * saved.viewport.dayWidth;
    const card = expectDefined(h.surface.reveal('row:4900'));
    const marker = expectDefined(
      card
        .closest('.abyss-task-timeline-row')
        ?.querySelector<HTMLButtonElement>('.abyss-project-timeline-state'),
    );
    expect(h.surface.captureScroll().center).toBeCloseTo(day, 6);
    expect(marker.hidden).toBe(true);
    h.host.scrollLeft = originalLeft;
    h.flush();
    expect(marker.isConnected).toBe(true);
    expect(marker.hidden).toBe(false);
    expect(marker.classList.contains('is-after')).toBe(true);
    expect(marker.style.getPropertyValue('--abyss-project-timeline-range-state-left')).toBe(
      `${String(originalLeft + 10)}px`,
    );
  } finally {
    h.dispose();
  }
});

it('positions only the row markers from the applied scroll offset, including newly mounted rows', () => {
  const h = continuousTimeline(900, {}, undefined, 5000);
  let left = 100.375;
  Object.defineProperty(h.host, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (requested: number) => {
      left = Math.floor(requested) + 0.25;
    },
  });
  const marker = () =>
    expectDefined(h.host.querySelector<HTMLElement>('.abyss-project-timeline-state'));
  try {
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(left).toBeGreaterThan(1000);
    const first = marker();
    const leftProperty = '--abyss-project-timeline-range-state-left';
    const rightProperty = '--abyss-project-timeline-range-state-right';
    const right = h.surface.captureScroll().viewport.trackWidth - left - 720 + 10;
    expect(first.style.getPropertyValue(leftProperty)).toBe(`${left + 10}px`);
    expect(first.style.getPropertyValue(rightProperty)).toBe(`${right}px`);
    expect(h.host.style.getPropertyValue(leftProperty)).toBe('');
    expect(h.host.style.getPropertyValue(rightProperty)).toBe('');
    h.host.scrollTop = 60000;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(first.isConnected).toBe(false);
    expect(marker().style.getPropertyValue(leftProperty)).toBe(`${left + 10}px`);
  } finally {
    h.dispose();
  }
});

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

it('samples the horizontal offset once per window while revealing a distant batch', () => {
  const h = continuousTimeline(900, undefined, undefined, 5000);
  try {
    h.flush();
    let left = h.host.scrollLeft;
    const read = vi.fn(() => left);
    Object.defineProperty(h.host, 'scrollLeft', {
      configurable: true,
      get: read,
      set: (next: number) => {
        left = next;
      },
    });
    const initial = new Set(h.surface.mountedKeys());
    h.host.scrollTop = 60000;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    const inserted = h.surface.mountedKeys().filter((key) => !initial.has(key));
    expect(inserted.length).toBeGreaterThan(12);
    expect(read.mock.calls.length).toBeLessThan(inserted.length);
  } finally {
    h.dispose();
  }
});
