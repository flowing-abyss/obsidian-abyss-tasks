import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectTimelinePointerInteraction,
  type FrozenProjectTimelineRangeSource,
} from '../src/panels/projects/projectTimelineInteraction';
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

function mount(range: FrozenProjectTimelineRangeSource['range'] = source().range) {
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
    window: () => ({
      startDay: '2026-09-01',
      endDay: '2026-09-10',
      dayCount: 10,
      scale: 'day',
      ticks: [],
    }),
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
    expect(mounted.root.querySelector('.abyss-project-timeline-tooltip')?.textContent).toContain(
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
