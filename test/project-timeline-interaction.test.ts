import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectTimelinePointerInteraction,
  type FrozenProjectTimelineRangeSource,
} from '../src/panels/projects/projectTimelineInteraction';
import type { ProjectEditResult } from '../src/projects/projectEdits';
import type { ProjectTimelineWindow } from '../src/projects/projectTimelineModel';
import { flushMicrotasks, freshContainer } from './helpers';

function pointerEvent(type: string, clientX: number, pointerId = 1): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: 30 },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
  });
  return event;
}

function source(
  range: FrozenProjectTimelineRangeSource['range'] = {
    kind: 'closed',
    startDay: '2026-09-02',
    endDay: '2026-09-04',
  },
): FrozenProjectTimelineRangeSource {
  return {
    occurrenceId: 'group\0Projects/A.md',
    path: 'Projects/A.md',
    range,
    start: {
      field: { id: 'start', label: 'Start', type: 'date', property: 'start' },
      expectedExists: range.kind !== 'unscheduled' && range.kind !== 'open-start',
      expectedValue:
        range.kind === 'closed' || range.kind === 'open-end' ? range.startDay : undefined,
      sourceProperty: 'start',
      sourceKey: 'start',
    },
    end: {
      field: { id: 'end', label: 'End', type: 'date', property: 'end' },
      expectedExists: range.kind === 'closed' || range.kind === 'open-start',
      expectedValue:
        range.kind === 'closed' || range.kind === 'open-start' ? range.endDay : undefined,
      sourceProperty: 'end',
      sourceKey: 'end',
    },
  };
}

function geometry(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 20,
    left,
    right: left + width,
    top: 20,
    bottom: 40,
    width,
    height: 20,
    toJSON: () => ({}),
  };
}

const defaultWindow: ProjectTimelineWindow = {
  startDay: '2026-09-01',
  endDay: '2026-09-10',
  dayCount: 10,
  scale: 'day',
  ticks: [],
};

function mount(
  range: FrozenProjectTimelineRangeSource['range'] = source().range,
  window: ProjectTimelineWindow = defaultWindow,
) {
  const root = freshContainer();
  activeDocument.body.append(root);
  const scroll = root.createDiv({ cls: 'abyss-project-timeline-scroll' });
  const row = scroll.createDiv({ attr: { 'data-occurrence-id': 'group\0Projects/A.md' } });
  const track = row.createDiv({
    cls: 'abyss-project-timeline-track',
    attr: { tabindex: '0', 'data-timeline-part': 'track' },
  });
  const bar = track.createDiv({
    cls: 'abyss-project-timeline-bar',
    attr: { tabindex: '0', 'data-timeline-part': 'bar' },
  });
  bar.createSpan({
    cls: 'abyss-project-timeline-handle is-start',
    attr: { 'data-timeline-part': 'start' },
  });
  bar.createSpan({
    cls: 'abyss-project-timeline-handle is-end',
    attr: { 'data-timeline-part': 'end' },
  });
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(geometry(10, 100));
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(geometry(0, 120));
  const captured = source(range);
  const commitRangeEdit = vi.fn().mockResolvedValue({ applied: [], failed: [] });
  const reportRangeFailure = vi.fn();
  const selected: HTMLElement[] = [];
  const interaction = new ProjectTimelinePointerInteraction({
    root,
    scroll,
    window: () => window,
    captureRangeSource: () => ({ kind: 'ready', source: captured }),
    commitRangeEdit,
    finishEditor: async () => true,
    selectRange: (_occurrenceId, focus) => {
      selected.push(focus);
      focus.focus();
    },
    reportRangeFailure,
  });
  return { root, scroll, track, bar, interaction, commitRangeEdit, reportRangeFailure, selected };
}

function deferredResult(): {
  readonly promise: Promise<ProjectEditResult>;
  readonly resolve: (result: ProjectEditResult) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: ((result: ProjectEditResult) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<ProjectEditResult>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve: (result) => resolve?.(result),
    reject: (error) => reject?.(error),
  };
}

afterEach(() => {
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

describe('ProjectTimelinePointerInteraction', () => {
  it('previews a bar move and commits its frozen pointer intent only on release', async () => {
    const mounted = mount();

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 45));

    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    expect(mounted.bar.classList).toContain('is-previewing');
    expect(mounted.root.querySelector('.abyss-project-timeline-tooltip')?.textContent).toBe(
      '2026-09-04',
    );

    mounted.track.dispatchEvent(pointerEvent('pointerup', 45));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
      kind: 'pointer',
      source: source(),
      intent: { type: 'move', deltaDays: 2 },
    });
    expect(mounted.bar.classList).not.toContain('is-previewing');
  });

  it('retains released geometry through a held command and a benign render', async () => {
    const mounted = mount();
    const held = deferredResult();
    mounted.commitRangeEdit.mockReturnValueOnce(held.promise);

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 45));
    const desiredLeft = mounted.bar.style.left;
    const desiredWidth = mounted.bar.style.width;

    mounted.track.dispatchEvent(pointerEvent('pointerup', 45));

    expect(mounted.bar.style.left).toBe(desiredLeft);
    expect(mounted.bar.style.width).toBe(desiredWidth);
    expect(mounted.bar.classList).toContain('is-previewing');

    mounted.bar.className = 'abyss-project-timeline-bar is-closed';
    mounted.bar.setCssProps({ left: '10%', width: '30%' });
    mounted.interaction.reconcileAfterRender();

    expect(mounted.bar.style.left).toBe(desiredLeft);
    expect(mounted.bar.style.width).toBe(desiredWidth);
    held.resolve({ applied: [], failed: [] });
    await flushMicrotasks();
    expect(mounted.bar.style.left).toBe('10%');
    expect(mounted.bar.style.width).toBe('30%');
  });

  it('rolls a rejected command back and reports it once', async () => {
    const mounted = mount();
    const held = deferredResult();
    mounted.commitRangeEdit.mockReturnValueOnce(held.promise);

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 45));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 45));
    held.resolve({ applied: [], failed: [{ path: 'Projects/A.md', message: 'Conflict' }] });
    await flushMicrotasks();

    expect(mounted.bar.style.left).toBe('');
    expect(mounted.bar.style.width).toBe('');
    expect(mounted.bar.classList).not.toContain('is-previewing');
    expect(mounted.reportRangeFailure).toHaveBeenCalledOnce();
  });

  it('does not let an older command settlement undo a newer preview', async () => {
    const mounted = mount();
    const first = deferredResult();
    const second = deferredResult();
    mounted.commitRangeEdit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 35));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 35));

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 35, 2));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 55, 2));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 55, 2));
    const newestLeft = mounted.bar.style.left;
    const newestWidth = mounted.bar.style.width;

    first.resolve({ applied: [], failed: [] });
    await flushMicrotasks();

    expect(mounted.bar.style.left).toBe(newestLeft);
    expect(mounted.bar.style.width).toBe(newestWidth);
    expect(mounted.bar.classList).toContain('is-previewing');
    second.resolve({ applied: [], failed: [] });
    await flushMicrotasks();
  });

  it.each([
    ['start', { kind: 'open-start', endDay: '2026-09-08' }, '2026-09-04', 'resizeStart'],
    ['end', { kind: 'open-end', startDay: '2026-09-02' }, '2026-09-04', 'resizeEnd'],
  ] as const)(
    'sets an absent %s endpoint from the dragged pointer day',
    async (part, range, expectedDay, type) => {
      const mounted = mount(range);
      const handle = mounted.bar.querySelector<HTMLElement>(`[data-timeline-part="${part}"]`);

      handle?.dispatchEvent(pointerEvent('pointerdown', 25));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 45));
      mounted.track.dispatchEvent(pointerEvent('pointerup', 45));
      await flushMicrotasks();

      expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
        kind: 'pointer',
        source: source(range),
        intent: { type, day: expectedDay },
      });
    },
  );

  it('keeps a coarse-scale open marker unchanged until its absent endpoint actually moves', async () => {
    const range = { kind: 'open-end', startDay: '2026-09-02' } as const;
    const mounted = mount(range, {
      startDay: '2026-01-01',
      endDay: '2026-12-31',
      dayCount: 365,
      scale: 'year',
      ticks: [],
    });
    const endHandle = mounted.bar.querySelector<HTMLElement>('[data-timeline-part="end"]');
    mounted.bar.className = 'abyss-project-timeline-bar is-open-end is-one-date';
    mounted.bar.setCssProps({ left: '66.849315%', width: '0.273973%' });

    endHandle?.dispatchEvent(pointerEvent('pointerdown', 77));
    await flushMicrotasks();
    mounted.interaction.reconcileAfterRender();

    expect(mounted.bar.className).toBe('abyss-project-timeline-bar is-open-end is-one-date');
    expect(mounted.bar.style.left).toBe('66.849315%');
    expect(mounted.bar.style.width).toBe('0.273973%');

    mounted.track.dispatchEvent(pointerEvent('pointermove', 79));
    expect(mounted.bar.className).toBe('abyss-project-timeline-bar is-open-end is-one-date');

    mounted.track.dispatchEvent(pointerEvent('pointermove', 82));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 82));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
      kind: 'pointer',
      source: source(range),
      intent: { type: 'resizeEnd', day: '2026-09-20' },
    });
  });

  it('normalizes a reverse draw and keeps a click as Start-only intent', async () => {
    const mounted = mount({ kind: 'unscheduled' });

    mounted.track.dispatchEvent(pointerEvent('pointerdown', 85));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 35));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 35));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).toHaveBeenLastCalledWith({
      kind: 'pointer',
      source: source({ kind: 'unscheduled' }),
      intent: { type: 'draw', startDay: '2026-09-08', endDay: '2026-09-03' },
    });

    mounted.track.dispatchEvent(pointerEvent('pointerdown', 55, 2));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointerup', 55, 2));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).toHaveBeenLastCalledWith({
      kind: 'pointer',
      source: source({ kind: 'unscheduled' }),
      intent: { type: 'setStart', day: '2026-09-05' },
    });
  });

  it('resizes from the frozen endpoint delta instead of a minimum-width handle position', async () => {
    const mounted = mount({ kind: 'closed', startDay: '2026-09-02', endDay: '2026-09-02' });
    const endHandle = mounted.bar.querySelector<HTMLElement>('[data-timeline-part="end"]');
    expect(endHandle).not.toBeNull();

    endHandle?.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 35));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 35));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
      kind: 'pointer',
      source: source({ kind: 'closed', startDay: '2026-09-02', endDay: '2026-09-02' }),
      intent: { type: 'resizeEnd', day: '2026-09-03' },
    });
  });

  it('leaves nested track controls to their existing click workflow', async () => {
    const mounted = mount({ kind: 'open-end', startDay: '2026-09-02' });
    const button = mounted.track.createEl('button', { text: 'Show range' });

    button.dispatchEvent(pointerEvent('pointerdown', 75));
    await flushMicrotasks();
    button.dispatchEvent(pointerEvent('pointerup', 75));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
  });

  it.each(['Escape', 'blur', 'hide', 'destroy'] as const)(
    'releases owned pointer capture on %s cancellation',
    async (exit) => {
      const mounted = mount();
      const setPointerCapture = vi.fn();
      const releasePointerCapture = vi.fn();
      Object.assign(mounted.track, {
        setPointerCapture,
        hasPointerCapture: () => true,
        releasePointerCapture,
      });
      mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
      await flushMicrotasks();

      if (exit === 'Escape') {
        mounted.root.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      } else if (exit === 'blur') {
        activeWindow.dispatchEvent(new Event('blur'));
      } else if (exit === 'hide') {
        mounted.interaction.cancelActive();
      } else {
        mounted.interaction.destroy();
      }

      expect(setPointerCapture).toHaveBeenCalledWith(1);
      expect(releasePointerCapture).toHaveBeenCalledWith(1);
      expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
      mounted.interaction.destroy();
    },
  );

  it('does not start or replay a gesture released before the editor guard resolves', async () => {
    const mounted = mount();
    let releaseGuard: ((value: boolean) => void) | undefined;
    const guard = new Promise<boolean>((resolve) => {
      releaseGuard = resolve;
    });
    mounted.interaction.destroy();
    const interaction = new ProjectTimelinePointerInteraction({
      root: mounted.root,
      scroll: mounted.scroll,
      window: () => ({
        startDay: '2026-09-01',
        endDay: '2026-09-10',
        dayCount: 10,
        scale: 'day',
        ticks: [],
      }),
      captureRangeSource: () => ({ kind: 'ready', source: source() }),
      commitRangeEdit: mounted.commitRangeEdit,
      finishEditor: () => guard,
      selectRange: vi.fn(),
      reportRangeFailure: mounted.reportRangeFailure,
    });

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 45));
    releaseGuard?.(true);
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    expect(mounted.bar.classList).not.toContain('is-previewing');
    interaction.destroy();
  });

  it.each(['pointercancel', 'lostpointercapture'])('cancels preview on %s', async (type) => {
    const mounted = mount();
    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 45));

    mounted.track.dispatchEvent(pointerEvent(type, 45));

    expect(mounted.bar.classList).not.toContain('is-previewing');
    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    mounted.interaction.destroy();
  });
});
