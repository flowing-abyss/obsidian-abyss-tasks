import { afterEach, expect, it, vi } from 'vitest';
import { TaskTimelineSurface } from '../src/panels/task-collection/TaskTimelineSurface';
import { indexedRows } from '../src/panels/task-list/taskListRows';
import { defaultTaskTimelineSettings } from '../src/task-lists/taskTimelineSettings';
import {
  rootTaskNodeSnapshot,
  type TaskNodeSnapshot,
  type TaskPatch,
  type TaskPlanning,
} from '../src/tasks';
import { expectDefined, flushMicrotasks, task } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
afterEach(() => vi.restoreAllMocks());
function pointer(type: string, x: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: 120 },
    isPrimary: { value: true },
    pointerId: { value: 1 },
  });
  return event;
}
function mount(
  planning: TaskPlanning = {
    start: '2026-10-26',
    due: '2026-10-28',
    scheduled: '2026-10-30',
  } as TaskPlanning,
) {
  const host = document.body.createDiv({ cls: 'abyss-center-scroll' });
  prepareTaskPanelViewport(host);
  let current = rootTaskNodeSnapshot(task({ planning }));
  const commit = vi.fn(
    async (_source: TaskNodeSnapshot, _patch: TaskPatch, accept: () => boolean) => accept(),
  );
  const openDates = vi.fn(),
    inspect = vi.fn();
  const surface = new TaskTimelineSurface<TaskNodeSnapshot>(
    {
      host,
      scroll: host,
      mountedChanged: () => {},
      reportFailure: (e) => {
        throw e;
      },
      mount: (parent) => {
        const element = parent.createDiv({ cls: 'abyss-task-card' });
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
      settings: () => ({ ...defaultTaskTimelineSettings(), scale: 'day' }),
      now: () => new Date(2026, 9, 26),
      planning: (value) => value.node.planning,
      snapshot: () => current,
      commit,
      select: () => {},
      openDates,
      inspect,
      changeScale: () => {},
    },
  );
  surface.update(indexedRows([{ kind: 'task', key: 'one', taskKey: 'one', task: current }]), {
    revision: 'one',
    preserveAnchor: true,
    estimate: () => 64,
    measurementRevision: () => '',
  });
  const track = expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-track'));
  const scheduledTrack = expectDefined(
    host.querySelector<HTMLElement>('.abyss-task-timeline-scheduled-track'),
  );
  for (const element of [track, scheduledTrack])
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      right: 380,
      top: 100,
      bottom: 160,
      width: 280,
      height: 60,
      toJSON: () => ({}),
    });
  const bar = expectDefined(
    track.querySelector<HTMLElement>(':scope > .abyss-project-timeline-bar'),
  );
  const scheduled = expectDefined(
    scheduledTrack.querySelector<HTMLElement>('.abyss-project-timeline-bar'),
  );
  return {
    host,
    surface,
    track,
    bar,
    scheduled,
    commit,
    openDates,
    inspect,
    replace: () => {
      current = rootTaskNodeSnapshot(task({ title: 'replacement', planning }));
    },
    dispose: () => {
      surface.destroy();
      host.remove();
    },
  };
}
async function start(element: HTMLElement, x = 130): Promise<void> {
  element.dispatchEvent(pointer('pointerdown', x));
  await flushMicrotasks();
}
async function finish(element: HTMLElement, x = 170): Promise<void> {
  element.dispatchEvent(pointer('pointermove', x));
  element.dispatchEvent(pointer('pointerup', x));
  await flushMicrotasks();
}
it.each(['range', 'scheduled'] as const)(
  'commits one exact %s date patch through the shared pointer engine',
  async (part) => {
    const h = mount();
    try {
      const bar = part === 'scheduled' ? h.scheduled : h.bar;
      await start(bar, part === 'scheduled' ? 190 : 130);
      await finish(bar, part === 'scheduled' ? 230 : 170);
      expect(h.commit).toHaveBeenCalledTimes(1);
      expect(h.commit.mock.calls[0]?.[1]).toEqual(
        part === 'scheduled'
          ? { scheduled: { type: 'set', value: '2026-11-01' } }
          : {
              start: { type: 'set', value: '2026-10-28' },
              due: { type: 'set', value: '2026-10-30' },
            },
      );
      expect(h.inspect).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);
it('resizes Due through the visible shared end handle without moving Start', async () => {
  const h = mount();
  try {
    const end = expectDefined(
      h.bar.querySelector<HTMLElement>('.abyss-project-timeline-handle.is-end'),
    );
    expect(end.querySelector('.abyss-project-timeline-grip')).not.toBeNull();
    await start(end, 150);
    await finish(end, 190);
    expect(h.commit.mock.calls[0]?.[1]).toEqual({ due: { type: 'set', value: '2026-10-30' } });
  } finally {
    h.dispose();
  }
});
it('sets Due on a short track press and draws both dates in one patch on drag', async () => {
  const h = mount({});
  try {
    const state = expectDefined(h.track.querySelector<HTMLButtonElement>('.is-unscheduled'));
    expect(state.disabled).toBe(true);
    state.click();
    expect(h.openDates).not.toHaveBeenCalled();
    await start(h.track);
    h.track.dispatchEvent(pointer('pointerup', 130));
    await flushMicrotasks();
    expect(h.openDates).not.toHaveBeenCalled();
    expect(h.commit.mock.calls[0]?.[1]).toEqual({ due: { type: 'set', value: '2026-10-27' } });
    h.commit.mockClear();
    await start(h.track);
    await finish(h.track);
    expect(h.commit.mock.calls[0]?.[1]).toEqual({
      start: { type: 'set', value: '2026-10-27' },
      due: { type: 'set', value: '2026-10-29' },
    });
  } finally {
    h.dispose();
  }
});
it.each(['replacement', 'escape', 'suspend', 'destroy'] as const)(
  'cancels a captured drag on %s',
  async (cancel) => {
    const h = mount();
    try {
      await start(h.bar);
      if (cancel === 'replacement') h.replace();
      if (cancel === 'escape')
        h.bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (cancel === 'suspend') h.surface.suspend();
      if (cancel === 'destroy') h.surface.destroy();
      await finish(h.bar);
      expect(h.commit).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);
it('keeps keyboard range edits separate from Scheduled and inspector activation', async () => {
  const h = mount();
  try {
    h.bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    await flushMicrotasks();
    expect(h.commit.mock.calls[0]?.[1]).toEqual({ due: { type: 'set', value: '2026-10-29' } });
    h.scheduled.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flushMicrotasks();
    expect(h.commit.mock.calls[1]?.[1]).toEqual({
      scheduled: { type: 'set', value: '2026-10-29' },
    });
    h.bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.inspect).toHaveBeenCalledWith('one');
  } finally {
    h.dispose();
  }
});

it('opens the inspector from a short captured bar press, including the first press after a drag', async () => {
  const h = mount();
  try {
    await start(h.bar);
    await finish(h.bar);
    await start(h.bar);
    h.bar.dispatchEvent(pointer('pointerup', 130));
    expect(h.inspect).toHaveBeenCalledTimes(1);
    expect(h.inspect).toHaveBeenCalledWith('one');
    expect(h.commit).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
});

it('rejects a short track press after its task was replaced', async () => {
  const h = mount({});
  try {
    await start(h.track);
    h.replace();
    h.track.dispatchEvent(pointer('pointerup', 130));
    await flushMicrotasks();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.openDates).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
