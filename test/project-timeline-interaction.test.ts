import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyProjectTimelineBarGeometry,
  ProjectTimelinePointerInteraction,
  type FrozenProjectTimelineRangeSource,
} from '../src/panels/projects/projectTimelineInteraction';
import type { ProjectEditResult } from '../src/projects/projectEdits';
import {
  projectTimelineBarGeometry,
  type ProjectTimelineWindow,
} from '../src/projects/projectTimelineModel';
import { expectDefined, flushMicrotasks, freshContainer } from './helpers';

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
  const controls = track.createDiv({ cls: 'abyss-project-timeline-range-controls' });
  controls.createDiv({ cls: 'abyss-project-timeline-move', attr: { 'data-timeline-part': 'bar' } });
  controls.createSpan({
    cls: 'abyss-project-timeline-handle is-start',
    attr: { 'data-timeline-part': 'start' },
  });
  controls.createSpan({
    cls: 'abyss-project-timeline-handle is-end',
    attr: { 'data-timeline-part': 'end' },
  });
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(geometry(10, 100));
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(geometry(0, 120));
  let captured = source(range);
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
  return {
    root,
    scroll,
    track,
    bar,
    controls,
    interaction,
    commitRangeEdit,
    reportRangeFailure,
    selected,
    setCapturedSource: (value: FrozenProjectTimelineRangeSource) => {
      captured = value;
    },
    setCapturedRange: (nextRange: FrozenProjectTimelineRangeSource['range']) => {
      captured = source(nextRange);
    },
  };
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
  if (process.env['TZ'] === 'America/New_York') {
    it('restores rejected DST preview and reports its reason only once on release', async () => {
      const range = { kind: 'open-end', startDay: '2026-03-07' } as const;
      const window = {
        startDay: '2026-03-01',
        endDay: '2026-03-10',
        dayCount: 10,
        scale: 'day',
      } as const;
      const mounted = mount(range, window);
      const captured = source(range);
      mounted.setCapturedSource({
        ...captured,
        start: { ...captured.start, expectedValue: '2026-03-07T02:30' },
      });
      applyProjectTimelineBarGeometry(
        mounted.bar,
        range,
        expectDefined(projectTimelineBarGeometry(range, window)),
      );
      const initialBar = mounted.bar.style.cssText;
      const initialControls = mounted.controls.style.cssText;
      mounted.bar.dispatchEvent(pointerEvent('pointerdown', 75));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 95));
      expect(mounted.bar.style.left).toBe('80%');
      mounted.track.dispatchEvent(pointerEvent('pointermove', 85));
      expect(mounted.bar.style.cssText).toBe(initialBar);
      expect(mounted.controls.style.cssText).toBe(initialControls);
      expect(mounted.root.querySelector('.abyss-project-timeline-tooltip')?.textContent).toMatch(
        /does not exist/u,
      );
      expect(mounted.reportRangeFailure).not.toHaveBeenCalled();
      mounted.track.dispatchEvent(pointerEvent('pointerup', 85));
      await flushMicrotasks();
      expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
      expect(mounted.reportRangeFailure).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/does not exist/u),
      );
    });
  }

  it.each([
    { kind: 'open-start', endDay: '2026-06-23' },
    { kind: 'closed', startDay: '2026-06-23', endDay: '2026-06-23' },
    { kind: 'closed', startDay: '2026-06-22', endDay: '2026-06-23' },
    { kind: 'closed', startDay: '2026-06-21', endDay: '2026-06-23' },
  ] as const)(
    'retains the exact fixed End for $kind at year scale through pending and cancel/failure',
    async (range) => {
      const window = {
        startDay: '2025-01-01',
        endDay: '2028-12-31',
        dayCount: 1461,
        scale: 'year',
      } as const;
      const mounted = mount(range, window);
      applyProjectTimelineBarGeometry(
        mounted.bar,
        range,
        expectDefined(projectTimelineBarGeometry(range, window)),
      );
      const right = () =>
        Number.parseFloat(mounted.bar.style.left) + Number.parseFloat(mounted.bar.style.width);
      const fixedRight = right();
      const initialControls = mounted.controls.style.cssText;
      expect(
        mounted.controls.style.getPropertyValue('--abyss-project-timeline-range-left'),
      ).not.toBe('');
      const handle = expectDefined(
        mounted.controls.querySelector<HTMLElement>('[data-timeline-part="start"]'),
      );
      const held = deferredResult();
      mounted.commitRangeEdit.mockReturnValueOnce(held.promise);
      handle.dispatchEvent(pointerEvent('pointerdown', 46.86));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 44.86));
      expect(right()).toBeCloseTo(fixedRight);
      mounted.track.dispatchEvent(pointerEvent('pointermove', 40.86));
      expect(right()).toBeCloseTo(fixedRight);
      expect(mounted.controls.classList).toContain('is-previewing');
      mounted.track.dispatchEvent(pointerEvent('pointerup', 40.86));
      expect(right()).toBeCloseTo(fixedRight);
      held.reject(new Error('Conflict'));
      await flushMicrotasks();
      expect(right()).toBeCloseTo(fixedRight);
      expect(mounted.controls.style.cssText).toBe(initialControls);
      expect(mounted.controls.classList).not.toContain('is-previewing');
      handle.dispatchEvent(pointerEvent('pointerdown', 46.86, 2));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 40.86, 2));
      mounted.interaction.cancelActive();
      expect(right()).toBeCloseTo(fixedRight);
      expect(mounted.controls.style.cssText).toBe(initialControls);
    },
  );

  it('reconciles the fixed End to an authoritative compact receipt without a geometry jump', async () => {
    const range = { kind: 'open-start', endDay: '2026-06-23' } as const;
    const committed = { kind: 'closed', startDay: '2026-06-22', endDay: '2026-06-23' } as const;
    const window = {
      startDay: '2025-01-01',
      endDay: '2028-12-31',
      dayCount: 1461,
      scale: 'year',
    } as const;
    const mounted = mount(range, window);
    vi.spyOn(mounted.track, 'getBoundingClientRect').mockReturnValue(geometry(0, 14610));
    vi.spyOn(mounted.scroll, 'getBoundingClientRect').mockReturnValue(geometry(0, 14610));
    applyProjectTimelineBarGeometry(
      mounted.bar,
      range,
      expectDefined(projectTimelineBarGeometry(range, window)),
    );
    const fixedRight =
      Number.parseFloat(mounted.bar.style.left) + Number.parseFloat(mounted.bar.style.width);
    mounted.controls
      .querySelector<HTMLElement>('[data-timeline-part="start"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 5385));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 5375));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 5375));
    expect(
      Number.parseFloat(mounted.bar.style.left) + Number.parseFloat(mounted.bar.style.width),
    ).toBeCloseTo(fixedRight);
    expect(mounted.controls.classList).toContain('is-previewing');
    mounted.setCapturedRange(committed);
    applyProjectTimelineBarGeometry(
      mounted.bar,
      committed,
      expectDefined(projectTimelineBarGeometry(committed, window)),
    );
    mounted.interaction.reconcileAfterRender();
    expect(
      Number.parseFloat(mounted.bar.style.left) + Number.parseFloat(mounted.bar.style.width),
    ).toBeCloseTo(fixedRight);
    expect(Number.parseFloat(mounted.bar.style.width)).toBeCloseTo(200 / 1461);
    expect(mounted.controls.classList).not.toContain('is-previewing');
    expect(mounted.bar.classList).not.toContain('is-previewing');
  });

  it('previews the clamped clock-aware Start day and preserves raw source evidence', async () => {
    const range = { kind: 'closed', startDay: '2026-09-01', endDay: '2026-09-03' } as const;
    const mounted = mount(range);
    const evidence = source(range);
    const captured = {
      ...evidence,
      start: { ...evidence.start, expectedValue: '2026-09-01T18:00' },
      end: { ...evidence.end, expectedValue: '2026-09-03T09:00' },
    };
    mounted.setCapturedSource(captured);
    mounted.controls
      .querySelector<HTMLElement>('[data-timeline-part="start"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 15));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 35));
    expect(mounted.bar.style.left).toBe('10%');
    expect(mounted.bar.style.width).toBe('20%');
    mounted.track.dispatchEvent(pointerEvent('pointerup', 35));
    expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
      kind: 'pointer',
      source: captured,
      intent: { type: 'resizeStart', day: '2026-09-03' },
    });
  });

  it.each([
    ['start-only', { kind: 'open-end', startDay: '2026-09-02' }],
    ['same-day', { kind: 'closed', startDay: '2026-09-02', endDay: '2026-09-02' }],
  ] as const)(
    'keeps a %s End resize anchored through threshold, preview, and cancel',
    async (_label, range) => {
      const mounted = mount(range);
      applyProjectTimelineBarGeometry(
        mounted.bar,
        range,
        expectDefined(projectTimelineBarGeometry(range, defaultWindow)),
      );
      const initialLeft = mounted.bar.style.left;
      const endHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="end"]');

      endHandle?.dispatchEvent(pointerEvent('pointerdown', 25));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 27));
      expect(mounted.bar.style.left).toBe(initialLeft);
      expect(mounted.bar.classList).toContain('is-one-date');

      mounted.track.dispatchEvent(pointerEvent('pointermove', 55));
      expect(mounted.bar.style.left).toBe(initialLeft);
      expect(mounted.bar.classList).not.toContain('is-one-date');

      mounted.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(mounted.bar.style.left).toBe(initialLeft);
      expect(mounted.bar.classList).toContain('is-one-date');
      expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    },
  );

  it('keeps the start anchor while an End resize is pending and restores the marker on failure', async () => {
    const range = { kind: 'open-end', startDay: '2026-09-02' } as const;
    const mounted = mount(range);
    applyProjectTimelineBarGeometry(
      mounted.bar,
      range,
      expectDefined(projectTimelineBarGeometry(range, defaultWindow)),
    );
    const initialLeft = mounted.bar.style.left;
    const held = deferredResult();
    mounted.commitRangeEdit.mockReturnValueOnce(held.promise);

    mounted.track
      .querySelector<HTMLElement>('[data-timeline-part="end"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 55));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 55));

    expect(mounted.bar.classList).toContain('is-previewing');
    expect(mounted.bar.style.left).toBe(initialLeft);
    held.resolve({ applied: [], failed: [{ path: 'Projects/A.md', message: 'Conflict' }] });
    await flushMicrotasks();

    expect(mounted.bar.classList).toContain('is-one-date');
    expect(mounted.bar.classList).not.toContain('is-previewing');
    expect(mounted.bar.style.left).toBe(initialLeft);
  });

  it('keeps the 2026-02-20 start anchor through a successful End commit to 2026-06-23', async () => {
    const range = { kind: 'open-end', startDay: '2026-02-20' } as const;
    const committedRange = {
      kind: 'closed',
      startDay: '2026-02-20',
      endDay: '2026-06-23',
    } as const;
    const window = {
      startDay: '2025-01-01',
      endDay: '2028-12-31',
      dayCount: 1461,
      scale: 'year',
    } as const;
    const mounted = mount(range, window);
    applyProjectTimelineBarGeometry(
      mounted.bar,
      range,
      expectDefined(projectTimelineBarGeometry(range, window)),
    );
    const initialLeft = mounted.bar.style.left;
    const held = deferredResult();
    mounted.commitRangeEdit.mockReturnValueOnce(held.promise);

    mounted.track
      .querySelector<HTMLElement>('[data-timeline-part="end"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 38.44));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 46.86));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 46.86));

    expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
      kind: 'pointer',
      source: source(range),
      intent: { type: 'resizeEnd', day: '2026-06-23' },
    });
    expect(mounted.bar.classList).toContain('is-previewing');
    expect(mounted.bar.style.left).toBe(initialLeft);

    held.resolve({
      applied: [
        {
          path: 'Projects/A.md',
          field: { id: 'end', label: 'End', type: 'date', property: 'end' },
          value: '2026-06-23',
          expectedValue: undefined,
          expectedExists: false,
          valueExists: true,
          sourceProperty: 'end',
          sourceKey: 'end',
          previousValue: undefined,
          previousExists: false,
          appliedExists: true,
        },
      ],
      failed: [],
    });
    await flushMicrotasks();

    mounted.setCapturedRange(committedRange);
    applyProjectTimelineBarGeometry(
      mounted.bar,
      committedRange,
      expectDefined(projectTimelineBarGeometry(committedRange, window)),
    );
    mounted.interaction.reconcileAfterRender();

    expect(mounted.bar.style.left).toBe(initialLeft);
    expect(mounted.bar.classList).not.toContain('is-one-date');
    expect(mounted.bar.classList).not.toContain('is-previewing');
  });

  it('previews a bar move and commits its frozen pointer intent only on release', async () => {
    const mounted = mount();

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 45));

    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    expect(mounted.bar.classList).toContain('is-previewing');
    expect(mounted.bar.style.left).toBe(mounted.bar.style.left);
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
    const desiredRangeLeft = mounted.controls.style.getPropertyValue(
      '--abyss-project-timeline-range-left',
    );

    mounted.track.dispatchEvent(pointerEvent('pointerup', 45));

    expect(mounted.bar.style.left).toBe(desiredLeft);
    expect(mounted.bar.style.width).toBe(desiredWidth);
    expect(mounted.bar.classList).toContain('is-previewing');

    mounted.bar.className = 'abyss-project-timeline-bar is-closed';
    mounted.bar.setCssProps({
      left: '10%',
      width: '30%',
    });
    mounted.controls.setCssProps({ '--abyss-project-timeline-range-left': '10%' });
    mounted.interaction.reconcileAfterRender();

    expect(mounted.bar.style.left).toBe(desiredLeft);
    expect(mounted.bar.style.width).toBe(desiredWidth);
    expect(mounted.controls.style.getPropertyValue('--abyss-project-timeline-range-left')).toBe(
      desiredRangeLeft,
    );
    held.resolve({ applied: [], failed: [] });
    await flushMicrotasks();
    expect(mounted.bar.style.left).toBe('10%');
    expect(mounted.bar.style.width).toBe('30%');
    expect(mounted.bar.style.left).toBe('10%');
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
    expect(mounted.bar.style.left).toBe('');
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
      const handle = mounted.track.querySelector<HTMLElement>(`[data-timeline-part="${part}"]`);

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
    });
    const endHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="end"]');
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
    const endHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="end"]');
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
    expect(mounted.bar.style.left).toBe('');
    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    mounted.interaction.destroy();
  });
});
