import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDashboardTimeline } from '../src/panels/projects/ProjectDashboardTimeline';
import { buildConfiguredProjectFieldCatalog } from '../src/projects/projectFields';
import { projectTimelineWindow } from '../src/projects/projectTimelineModel';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, flushMicrotasks } from './helpers';
afterEach(() => vi.restoreAllMocks());
function pointer(type: string, clientX: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: 40 },
    isPrimary: { value: true },
    pointerId: { value: 1 },
  });
  return event;
}
function mount(frontmatter: Project['frontmatter'] = { start: '2026-10-02', end: '2026-10-04' }) {
  const host = document.body.createDiv();
  let project: Project | undefined = {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter,
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
  };
  let fields = buildConfiguredProjectFieldCatalog(DEFAULT_SETTINGS.projects);
  const apply = vi.fn(async () => ({ applied: [], failed: [] }));
  const window = {
    ...projectTimelineWindow(new Date(2026, 9, 1), 'day'),
    startDay: '2026-10-01',
    endDay: '2026-10-14',
    dayCount: 14,
  };
  const revealDay = vi.fn();
  const view = new ProjectDashboardTimeline(host, {
    scroll: host,
    window: () => window,
    now: () => new Date(2026, 9, 1),
    revealDay,
    project: () => project,
    fields: () => fields,
    apply,
    history: async () => ({ applied: [], failed: [] }),
  });
  view.update(window);
  const track = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-track'));
  const bar = expectDefined(track.querySelector<HTMLButtonElement>('[data-timeline-part="end"]'));
  const start = expectDefined(
    track.querySelector<HTMLButtonElement>('[data-timeline-part="start"]'),
  );
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 0,
    left: 100,
    right: 380,
    top: 0,
    bottom: 70,
    width: 280,
    height: 70,
    toJSON: () => ({}),
  });
  return {
    host,
    view,
    track,
    bar,
    start,
    apply,
    window,
    revealDay,
    change: (kind: string) => {
      if (kind === 'replace' && project !== undefined)
        project = { ...project, frontmatter: { ...frontmatter, end: '2026-10-10' } };
      if (kind === 'rebind')
        fields = fields.map((f) => (f.id === 'end' ? { ...f, property: 'deadline' } : f));
      if (kind === 'duplicate' && project !== undefined)
        project = { ...project, frontmatter: { ...frontmatter, End: '2026-10-04' } };
      if (kind === 'remove') project = undefined;
      if (kind === 'cancel') view.cancel();
      if (kind === 'destroy') view.destroy();
    },
    dispose: () => {
      view.destroy();
      host.remove();
    },
  };
}
it('resizes the project End through the shared visible handle while guarding Start', async () => {
  const h = mount();
  try {
    expect(h.host.querySelector('.abyss-project-timeline-row')).toBeNull();
    expect(h.host.querySelector('.abyss-project-timeline-bar')).toBeNull();
    const end = h.bar;
    end.dispatchEvent(pointer('pointerdown', 170));
    await flushMicrotasks();
    end.dispatchEvent(pointer('pointermove', 190));
    end.dispatchEvent(pointer('pointerup', 190));
    await flushMicrotasks();
    expect(h.apply).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sourceProperty: 'end', value: '2026-10-05' }),
        expect.objectContaining({
          sourceProperty: 'start',
          restoreSourceValue: true,
          expectedValue: '2026-10-02',
          value: '2026-10-02',
        }),
      ]),
    );
  } finally {
    h.dispose();
  }
});
it('sets a missing Start from its axis handle with both endpoint guards', async () => {
  const h = mount({});
  try {
    h.start.dispatchEvent(pointer('pointerdown', 130));
    await flushMicrotasks();
    h.start.dispatchEvent(pointer('pointermove', 170));
    h.start.dispatchEvent(pointer('pointerup', 170));
    await flushMicrotasks();
    expect(h.apply).toHaveBeenCalledWith([
      expect.objectContaining({
        path: 'Projects/A.md',
        sourceProperty: 'start',
        expectedExists: false,
        value: '2026-10-04',
      }),
      expect.objectContaining({
        path: 'Projects/A.md',
        sourceProperty: 'end',
        expectedExists: false,
        valueExists: false,
        restoreSourceValue: true,
      }),
    ]);
  } finally {
    h.dispose();
  }
});
it('sets a missing End to today on a short axis press without opening a calendar', async () => {
  const h = mount({});
  try {
    h.bar.dispatchEvent(pointer('pointerdown', 110));
    await flushMicrotasks();
    h.bar.dispatchEvent(pointer('pointerup', 110));
    await flushMicrotasks();
    expect(h.apply).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceProperty: 'start',
        expectedExists: false,
        valueExists: false,
      }),
      expect.objectContaining({ sourceProperty: 'end', value: '2026-10-01' }),
    ]);
  } finally {
    h.dispose();
  }
});
it('moves the focused Start with the keyboard and preserves End', async () => {
  const h = mount();
  try {
    h.start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushMicrotasks();
    expect(h.apply).toHaveBeenCalledWith([
      expect.objectContaining({ sourceProperty: 'start', value: '2026-10-03' }),
      expect.objectContaining({
        sourceProperty: 'end',
        value: '2026-10-04',
        restoreSourceValue: true,
      }),
    ]);
  } finally {
    h.dispose();
  }
});
it.each(['replace', 'rebind', 'duplicate', 'remove', 'cancel', 'destroy'])(
  'rejects a project drag after %s',
  async (kind) => {
    const h = mount();
    try {
      h.bar.dispatchEvent(pointer('pointerdown', 130));
      await flushMicrotasks();
      h.change(kind);
      h.bar.dispatchEvent(pointer('pointermove', 170));
      h.bar.dispatchEvent(pointer('pointerup', 170));
      await flushMicrotasks();
      expect(h.apply).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);
it('does not revive a queued edit after its navigation context is cancelled and redrawn', async () => {
  const h = mount();
  try {
    h.bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    h.view.cancel();
    h.view.update(h.window);
    await flushMicrotasks();
    expect(h.apply).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('previews both vertical boundaries in mounted tracks and restores them on cancel', async () => {
  const h = mount();
  const taskTrack = h.host.createDiv();
  const release = h.view.mountTrack(taskTrack);
  try {
    const line = expectDefined(
      taskTrack.querySelector<HTMLElement>('.abyss-project-boundary-line.is-end'),
    );
    const initial = line.style.left;
    expect(line.getAttribute('aria-hidden')).toBe('true');
    h.bar.dispatchEvent(pointer('pointerdown', 170));
    await flushMicrotasks();
    h.bar.dispatchEvent(pointer('pointermove', 190));
    expect(line.style.left).not.toBe(initial);
    const remountedTrack = h.host.createDiv();
    const releaseRemount = h.view.mountTrack(remountedTrack);
    const remountedLine = expectDefined(
      remountedTrack.querySelector<HTMLElement>('.abyss-project-boundary-line.is-end'),
    );
    expect(remountedLine.style.left).toBe(line.style.left);
    h.bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(line.style.left).toBe(initial);
    expect(remountedLine.style.left).toBe(initial);
    releaseRemount();
    expect(h.apply).not.toHaveBeenCalled();
    release();
    expect(taskTrack.children).toHaveLength(0);
  } finally {
    release();
    h.dispose();
  }
});

it('keeps a project boundary in the exposed viewport and reveals its day even inside the larger buffer', () => {
  const h = mount({ start: '2026-10-02', end: '2026-10-12' });
  try {
    Object.defineProperty(h.host, 'clientWidth', { configurable: true, value: 210 });
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 210 } as DOMRect);
    h.view.update(h.window);
    expect(h.bar.classList.contains('is-offscreen')).toBe(true);
    expect(parseFloat(h.bar.style.left)).toBeCloseTo((110 / 280) * 100, 6);
    h.bar.click();
    expect(h.revealDay).toHaveBeenCalledWith('2026-10-12');
  } finally {
    h.dispose();
  }
});

it.each(['finish', 'cancel', 'reject'] as const)(
  'keeps dashboard boundary previews through several window moves until %s',
  async (outcome) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = mount();
    const track = h.host.createDiv();
    const release = h.view.mountTrack(track);
    let reject: ((error: unknown) => void) | undefined;
    if (outcome === 'reject')
      h.apply.mockReturnValueOnce(
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
      );
    try {
      h.bar.dispatchEvent(pointer('pointerdown', 170));
      await flushMicrotasks();
      h.bar.dispatchEvent(pointer('pointermove', 190));
      for (const [startDay, endDay, left] of [
        ['2026-09-29', '2026-10-12', 60],
        ['2026-10-02', '2026-10-15', 120],
      ] as const) {
        Object.assign(h.window, { startDay, endDay });
        vi.spyOn(h.track, 'getBoundingClientRect').mockReturnValue({
          left,
          right: left + 280,
          width: 280,
          top: 0,
          bottom: 70,
          height: 70,
        } as DOMRect);
        h.view.update(h.window);
        expect(
          parseFloat(expectDefined(track.querySelector<HTMLElement>('.is-end')).style.left),
        ).toBeCloseTo(startDay === '2026-10-02' ? 25 : 46.4285714286, 6);
      }
      if (outcome === 'cancel') {
        h.bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(h.apply).not.toHaveBeenCalled();
      } else {
        h.bar.dispatchEvent(pointer('pointerup', 190));
        await flushMicrotasks();
        expect(h.apply).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ sourceProperty: 'end', value: '2026-10-05' }),
          ]),
        );
        if (outcome === 'reject') {
          reject?.(new Error('Write rejected'));
          await flushMicrotasks();
          expect(logged).toHaveBeenCalledTimes(1);
        }
      }
      expect(
        parseFloat(expectDefined(track.querySelector<HTMLElement>('.is-end')).style.left),
      ).toBeCloseTo(17.8571428571, 6);
    } finally {
      release();
      h.dispose();
    }
  },
);
