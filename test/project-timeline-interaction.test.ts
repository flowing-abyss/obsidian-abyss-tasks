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

function rangeLeft(bar: HTMLElement): string {
  return bar.style.getPropertyValue('--abyss-project-timeline-range-left');
}

/** Reads the calendar right edge whether the range is anchored at its Start or at its End. */
function rightEdgePercent(bar: HTMLElement): number {
  const endAnchored = /^calc\(([\d.]+)% - /u.exec(rangeLeft(bar));
  return endAnchored === null
    ? Number.parseFloat(rangeLeft(bar)) + Number.parseFloat(bar.style.width)
    : Number(endAnchored[1]);
}

function cursorLeftPercent(root: HTMLElement): number {
  const cursor = expectDefined(root.querySelector<HTMLElement>('.abyss-project-timeline-cursor'));
  expect(cursor.hidden).toBe(false);
  return Number.parseFloat(cursor.style.left);
}

function tooltipText(root: HTMLElement): string | null | undefined {
  return root.querySelector('.abyss-project-timeline-tooltip')?.textContent;
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
      mounted.bar.dispatchEvent(pointerEvent('pointerdown', 75));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 95));
      expect(rangeLeft(mounted.bar)).toBe('80%');
      mounted.track.dispatchEvent(pointerEvent('pointermove', 85));
      expect(mounted.bar.style.cssText).toBe(initialBar);
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
      const right = () => rightEdgePercent(mounted.bar);
      const fixedRight = right();
      const initialBar = mounted.bar.style.cssText;
      expect(rangeLeft(mounted.bar)).not.toBe('');
      const handle = expectDefined(
        mounted.bar.querySelector<HTMLElement>('[data-timeline-part="start"]'),
      );
      const held = deferredResult();
      mounted.commitRangeEdit.mockReturnValueOnce(held.promise);
      handle.dispatchEvent(pointerEvent('pointerdown', 46.86));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 44.86));
      expect(right()).toBeCloseTo(fixedRight);
      mounted.track.dispatchEvent(pointerEvent('pointermove', 40.86));
      expect(right()).toBeCloseTo(fixedRight);
      expect(mounted.bar.classList).toContain('is-previewing');
      mounted.track.dispatchEvent(pointerEvent('pointerup', 40.86));
      expect(right()).toBeCloseTo(fixedRight);
      held.reject(new Error('Conflict'));
      await flushMicrotasks();
      expect(right()).toBeCloseTo(fixedRight);
      expect(mounted.bar.style.cssText).toBe(initialBar);
      expect(mounted.bar.classList).not.toContain('is-previewing');
      handle.dispatchEvent(pointerEvent('pointerdown', 46.86, 2));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 40.86, 2));
      mounted.interaction.cancelActive();
      expect(right()).toBeCloseTo(fixedRight);
      expect(mounted.bar.style.cssText).toBe(initialBar);
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
    const fixedRight = rightEdgePercent(mounted.bar);
    mounted.bar
      .querySelector<HTMLElement>('[data-timeline-part="start"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 5385));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 5375));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 5375));
    expect(rightEdgePercent(mounted.bar)).toBeCloseTo(fixedRight);
    expect(mounted.bar.classList).toContain('is-previewing');
    mounted.setCapturedRange(committed);
    applyProjectTimelineBarGeometry(
      mounted.bar,
      committed,
      expectDefined(projectTimelineBarGeometry(committed, window)),
    );
    mounted.interaction.reconcileAfterRender();
    expect(rightEdgePercent(mounted.bar)).toBeCloseTo(fixedRight);
    expect(Number.parseFloat(mounted.bar.style.width)).toBeCloseTo(200 / 1461);
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
    mounted.bar
      .querySelector<HTMLElement>('[data-timeline-part="start"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 15));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 35));
    expect(rangeLeft(mounted.bar)).toBe('10%');
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
      const initialLeft = rangeLeft(mounted.bar);
      const endHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="end"]');

      endHandle?.dispatchEvent(pointerEvent('pointerdown', 25));
      await flushMicrotasks();
      mounted.track.dispatchEvent(pointerEvent('pointermove', 27));
      expect(rangeLeft(mounted.bar)).toBe(initialLeft);
      expect(mounted.bar.classList).toContain('is-one-date');

      mounted.track.dispatchEvent(pointerEvent('pointermove', 55));
      expect(rangeLeft(mounted.bar)).toBe(initialLeft);
      expect(mounted.bar.classList).not.toContain('is-one-date');

      mounted.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(rangeLeft(mounted.bar)).toBe(initialLeft);
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
    const initialLeft = rangeLeft(mounted.bar);
    const held = deferredResult();
    mounted.commitRangeEdit.mockReturnValueOnce(held.promise);

    mounted.track
      .querySelector<HTMLElement>('[data-timeline-part="end"]')
      ?.dispatchEvent(pointerEvent('pointerdown', 25));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 55));
    mounted.track.dispatchEvent(pointerEvent('pointerup', 55));

    expect(mounted.bar.classList).toContain('is-previewing');
    expect(rangeLeft(mounted.bar)).toBe(initialLeft);
    held.resolve({ applied: [], failed: [{ path: 'Projects/A.md', message: 'Conflict' }] });
    await flushMicrotasks();

    expect(mounted.bar.classList).toContain('is-one-date');
    expect(mounted.bar.classList).not.toContain('is-previewing');
    expect(rangeLeft(mounted.bar)).toBe(initialLeft);
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
    const initialLeft = rangeLeft(mounted.bar);
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
    expect(rangeLeft(mounted.bar)).toBe(initialLeft);

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

    expect(rangeLeft(mounted.bar)).toBe(initialLeft);
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
    expect(rangeLeft(mounted.bar)).toBe('30%');
    expect(mounted.bar.style.width).toBe('30%');

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
    const desiredLeft = rangeLeft(mounted.bar);
    const desiredWidth = mounted.bar.style.width;

    mounted.track.dispatchEvent(pointerEvent('pointerup', 45));

    expect(rangeLeft(mounted.bar)).toBe(desiredLeft);
    expect(mounted.bar.style.width).toBe(desiredWidth);
    expect(mounted.bar.classList).toContain('is-previewing');

    mounted.bar.className = 'abyss-project-timeline-bar is-closed';
    mounted.bar.setCssProps({
      '--abyss-project-timeline-range-left': '10%',
      width: '30%',
    });
    mounted.interaction.reconcileAfterRender();

    expect(rangeLeft(mounted.bar)).toBe(desiredLeft);
    expect(mounted.bar.style.width).toBe(desiredWidth);
    held.resolve({ applied: [], failed: [] });
    await flushMicrotasks();
    expect(rangeLeft(mounted.bar)).toBe('10%');
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

    expect(rangeLeft(mounted.bar)).toBe('');
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
    const newestLeft = rangeLeft(mounted.bar);
    const newestWidth = mounted.bar.style.width;

    first.resolve({ applied: [], failed: [] });
    await flushMicrotasks();

    expect(rangeLeft(mounted.bar)).toBe(newestLeft);
    expect(mounted.bar.style.width).toBe(newestWidth);
    expect(mounted.bar.classList).toContain('is-previewing');
    second.resolve({ applied: [], failed: [] });
    await flushMicrotasks();
  });

  it.each([
    ['start', { kind: 'open-start', endDay: '2026-09-08' }, '2026-09-04', 'resizeStart'],
    ['end', { kind: 'open-end', startDay: '2026-09-02' }, '2026-09-04', 'resizeEnd'],
  ] as const)(
    'sets an absent %s endpoint to the day under the pointer',
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
    mounted.bar.setCssProps({
      '--abyss-project-timeline-range-left': '66.849315%',
      width: '0.273973%',
    });

    endHandle?.dispatchEvent(pointerEvent('pointerdown', 77));
    await flushMicrotasks();
    mounted.interaction.reconcileAfterRender();

    expect(mounted.bar.className).toBe('abyss-project-timeline-bar is-open-end is-one-date');
    expect(rangeLeft(mounted.bar)).toBe('66.849315%');
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

  it.each([
    {
      label: 'native month missing End',
      range: { kind: 'open-end', startDay: '2026-09-20' },
      window: { startDay: '2026-01-01', endDay: '2026-12-31', dayCount: 365, scale: 'month' },
      trackWidth: 1565,
      part: 'end',
      handleCenter: 1301.3671875,
      targetIndex: 271,
      targetDay: '2026-09-29',
      leftOrdinal: 262,
      rangeDays: 10,
    },
    {
      label: 'native month missing Start',
      range: { kind: 'open-start', endDay: '2026-09-24' },
      window: { startDay: '2026-01-01', endDay: '2026-12-31', dayCount: 365, scale: 'month' },
      trackWidth: 1565,
      part: 'start',
      handleCenter: 1256.8046875,
      targetIndex: 257,
      targetDay: '2026-09-15',
      leftOrdinal: 257,
      rangeDays: 10,
    },
    {
      label: 'year missing End',
      range: { kind: 'open-end', startDay: '2026-06-23' },
      window: { startDay: '2025-01-01', endDay: '2028-12-31', dayCount: 1461, scale: 'year' },
      trackWidth: 1461,
      part: 'end',
      handleCenter: 716,
      targetIndex: 545,
      targetDay: '2026-06-30',
      leftOrdinal: 538,
      rangeDays: 8,
    },
    {
      label: 'year missing Start',
      range: { kind: 'open-start', endDay: '2026-06-23' },
      window: { startDay: '2025-01-01', endDay: '2028-12-31', dayCount: 1461, scale: 'year' },
      trackWidth: 1461,
      part: 'start',
      handleCenter: 651,
      targetIndex: 531,
      targetDay: '2026-06-16',
      leftOrdinal: 531,
      rangeDays: 8,
    },
    {
      label: 'left-clamped year missing Start',
      range: { kind: 'open-start', endDay: '2025-01-10' },
      window: { startDay: '2025-01-01', endDay: '2028-12-31', dayCount: 1461, scale: 'year' },
      trackWidth: 2922,
      part: 'start',
      handleCenter: 152,
      targetIndex: 7,
      targetDay: '2025-01-08',
      leftOrdinal: 7,
      rangeDays: 3,
    },
    {
      label: 'right-clamped year missing End',
      range: { kind: 'open-end', startDay: '2028-12-22' },
      window: { startDay: '2025-01-01', endDay: '2028-12-31', dayCount: 1461, scale: 'year' },
      trackWidth: 1461,
      part: 'end',
      handleCenter: 1599,
      targetIndex: 1459,
      targetDay: '2028-12-30',
      leftOrdinal: 1451,
      rangeDays: 9,
    },
  ] as const)(
    'sets $label to the day under the pointer wherever its compact handle is displayed',
    async ({
      range,
      window,
      trackWidth,
      part,
      handleCenter,
      targetIndex,
      targetDay,
      leftOrdinal,
      rangeDays,
    }) => {
      const trackLeft = 145;
      const mounted = mount(range, window);
      vi.spyOn(mounted.track, 'getBoundingClientRect').mockReturnValue(
        geometry(trackLeft, trackWidth),
      );
      vi.spyOn(mounted.scroll, 'getBoundingClientRect').mockReturnValue(
        geometry(trackLeft, trackWidth),
      );
      applyProjectTimelineBarGeometry(
        mounted.bar,
        range,
        expectDefined(projectTimelineBarGeometry(range, window)),
      );
      const handle = expectDefined(
        mounted.bar.querySelector<HTMLElement>(`[data-timeline-part="${part}"]`),
      );
      const held = deferredResult();
      mounted.commitRangeEdit.mockReturnValueOnce(held.promise);
      handle.dispatchEvent(pointerEvent('pointerdown', handleCenter));
      await flushMicrotasks();
      expect(mounted.bar.classList).not.toContain('is-previewing');
      const destination = trackLeft + ((targetIndex + 0.5) * trackWidth) / window.dayCount;
      mounted.track.dispatchEvent(pointerEvent('pointermove', destination));
      expect(Number.parseFloat(rangeLeft(mounted.bar))).toBeCloseTo(
        (leftOrdinal * 100) / window.dayCount,
      );
      expect(Number.parseFloat(mounted.bar.style.width)).toBeCloseTo(
        (rangeDays * 100) / window.dayCount,
      );
      expect(tooltipText(mounted.root)).toBe(targetDay);
      expect(cursorLeftPercent(mounted.root)).toBeCloseTo(
        ((targetIndex + 0.5) * 100) / window.dayCount,
      );
      mounted.track.dispatchEvent(pointerEvent('pointerup', destination));
      expect(mounted.commitRangeEdit).toHaveBeenCalledExactlyOnceWith({
        kind: 'pointer',
        source: source(range),
        intent: { type: part === 'start' ? 'resizeStart' : 'resizeEnd', day: targetDay },
      });
      expect(Number.parseFloat(mounted.bar.style.width)).toBeCloseTo(
        (rangeDays * 100) / window.dayCount,
      );
      expect(mounted.bar.classList).toContain('is-previewing');
      held.resolve({ applied: [], failed: [] });
      await flushMicrotasks();
    },
  );

  it.each([
    [{ kind: 'open-end', startDay: '2026-09-02' }, 'setEnd'],
    [{ kind: 'open-start', endDay: '2026-09-09' }, 'setStart'],
  ] as const)('keeps missing endpoint track clicks absolute for %s', async (range, type) => {
    const mounted = mount(range);
    mounted.track.dispatchEvent(pointerEvent('pointerdown', 55));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointerup', 55));
    await flushMicrotasks();
    expect(mounted.commitRangeEdit).toHaveBeenCalledExactlyOnceWith({
      kind: 'pointer',
      source: source(range),
      intent: { type, day: '2026-09-05' },
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

  it('resizes to the day under the pointer even from a minimum-width handle position', async () => {
    const range = { kind: 'closed', startDay: '2026-09-02', endDay: '2026-09-02' } as const;
    const mounted = mount(range);
    const endHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="end"]');
    expect(endHandle).not.toBeNull();

    // The compact handle is displayed two days to the right of the End it edits.
    endHandle?.dispatchEvent(pointerEvent('pointerdown', 45));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 65));
    expect(tooltipText(mounted.root)).toBe('2026-09-06');
    expect(cursorLeftPercent(mounted.root)).toBeCloseTo(55);
    mounted.track.dispatchEvent(pointerEvent('pointerup', 65));
    await flushMicrotasks();

    expect(mounted.commitRangeEdit).toHaveBeenCalledWith({
      kind: 'pointer',
      source: source(range),
      intent: { type: 'resizeEnd', day: '2026-09-06' },
    });
  });

  it.each([
    [{ kind: 'open-end', startDay: '2026-09-02' }, 5],
    [{ kind: 'open-start', endDay: '2026-09-09' }, -2],
  ] as const)(
    'moves the only date of %s to the day under the pointer',
    async (range, deltaDays) => {
      const mounted = mount(range);

      // The compact block is wider than its day, so the grab point is not the date itself.
      mounted.bar.dispatchEvent(pointerEvent('pointerdown', 45));
      await flushMicrotasks();
      expect(mounted.bar.classList).not.toContain('is-previewing');
      mounted.track.dispatchEvent(pointerEvent('pointermove', 47));
      expect(mounted.bar.classList).not.toContain('is-previewing');
      mounted.track.dispatchEvent(pointerEvent('pointermove', 75));
      expect(tooltipText(mounted.root)).toBe('2026-09-07');
      expect(cursorLeftPercent(mounted.root)).toBeCloseTo(65);
      mounted.track.dispatchEvent(pointerEvent('pointerup', 75));
      await flushMicrotasks();

      expect(mounted.commitRangeEdit).toHaveBeenCalledExactlyOnceWith({
        kind: 'pointer',
        source: source(range),
        intent: { type: 'move', deltaDays },
      });
    },
  );

  it('marks the written Start and reports both dates while a closed range moves', async () => {
    const mounted = mount();

    mounted.bar.dispatchEvent(pointerEvent('pointerdown', 35));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 65));

    expect(rangeLeft(mounted.bar)).toBe('40%');
    expect(tooltipText(mounted.root)).toBe('2026-09-05 → 2026-09-07');
    expect(cursorLeftPercent(mounted.root)).toBeCloseTo(40);
  });

  it('places the date above its track inside whichever ancestor positions the tooltip', () => {
    const mounted = mount();
    const tooltip = expectDefined(
      mounted.root.querySelector<HTMLElement>('.abyss-project-timeline-tooltip'),
    );
    // A contained workspace leaf, not the viewport, positions fixed descendants.
    const leaf = mounted.root.createDiv();
    vi.spyOn(leaf, 'getBoundingClientRect').mockReturnValue({
      ...geometry(30, 400),
      top: 40,
      y: 40,
    });
    Object.defineProperty(tooltip, 'offsetParent', { configurable: true, value: leaf });
    vi.spyOn(tooltip, 'getBoundingClientRect').mockReturnValue({
      ...geometry(0, 80),
      top: 0,
      bottom: 24,
      height: 24,
    });
    vi.spyOn(mounted.track, 'getBoundingClientRect').mockReturnValue({
      ...geometry(10, 100),
      top: 200,
      bottom: 268,
    });

    mounted.track.dispatchEvent(pointerEvent('pointermove', 55));

    expect(tooltip.hidden).toBe(false);
    expect(tooltip.style.left).toBe(`${55 + 12 - 30}px`);
    expect(tooltip.style.top).toBe(`${200 - 24 - 8 - 40}px`);
  });

  it('keeps the marker on the written day when the counterpart clamps a resize', async () => {
    const mounted = mount();
    const endHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="end"]');

    endHandle?.dispatchEvent(pointerEvent('pointerdown', 45));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 12));

    expect(tooltipText(mounted.root)).toBe('2026-09-02');
    expect(cursorLeftPercent(mounted.root)).toBeCloseTo(10);
    expect(rangeLeft(mounted.bar)).toBe('10%');
    expect(mounted.bar.style.width).toBe('10%');
    mounted.interaction.cancelActive();

    const startHandle = mounted.track.querySelector<HTMLElement>('[data-timeline-part="start"]');
    startHandle?.dispatchEvent(pointerEvent('pointerdown', 25, 2));
    await flushMicrotasks();
    mounted.track.dispatchEvent(pointerEvent('pointermove', 95, 2));

    expect(tooltipText(mounted.root)).toBe('2026-09-04');
    expect(
      mounted.root.querySelector<HTMLElement>('.abyss-project-timeline-cursor')?.style.left,
    ).toBe('calc(40% - 1px)');
    expect(rangeLeft(mounted.bar)).toBe('30%');
    expect(mounted.bar.style.width).toBe('10%');
  });

  it.each([
    {
      label: 'End before its Start',
      range: { kind: 'open-end', startDay: '2026-09-05' },
      clientX: 12,
      cursorLeft: '40%',
    },
    {
      label: 'Start after its End',
      range: { kind: 'open-start', endDay: '2026-09-05' },
      clientX: 88,
      cursorLeft: 'calc(50% - 1px)',
    },
  ] as const)(
    'marks the written day when a track press would set $label',
    async ({ range, clientX, cursorLeft }) => {
      const mounted = mount(range);

      mounted.track.dispatchEvent(pointerEvent('pointerdown', clientX));
      await flushMicrotasks();

      expect(tooltipText(mounted.root)).toBe('2026-09-05');
      expect(
        mounted.root.querySelector<HTMLElement>('.abyss-project-timeline-cursor')?.style.left,
      ).toBe(cursorLeft);
    },
  );

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
    expect(rangeLeft(mounted.bar)).toBe('');
    expect(mounted.commitRangeEdit).not.toHaveBeenCalled();
    mounted.interaction.destroy();
  });
});
