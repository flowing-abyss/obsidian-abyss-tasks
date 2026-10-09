import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatisticsCharts } from '../src/panels/statistics/StatisticsCharts';
import { StatisticsDetails } from '../src/panels/statistics/StatisticsDetails';
import { StatisticsSections } from '../src/panels/statistics/StatisticsSections';
import { TanStackStatisticsChart } from '../src/panels/statistics/TanStackStatisticsChart';
import {
  statisticsMarkContent,
  statisticsMarkDescription,
  statisticsMarkTitle,
} from '../src/panels/statistics/statisticsFormat';
import type { StatisticsChartModel, StatisticsViewModel } from '../src/statistics';
import { prepareStatisticsDataset, StatisticsSession } from '../src/statistics';
import { contracts } from '../tooling/css-contracts.mjs';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
import { resetStatisticsScrollAtCommit } from './support/statisticsNativeScroll';

const capture = vi.hoisted<{
  options: Array<{ onSelect?: ((point: unknown) => void) | undefined }>;
  point: unknown;
}>(() => ({
  options: [],
  point: null,
}));
vi.mock('@tanstack/charts/dom', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const realMount = original['mountChart'] as (
    host: HTMLElement,
    options: Record<string, unknown>,
  ) => { update(options: Record<string, unknown>): void; destroy(): void };
  const observed = (options: Record<string, unknown>) => {
    const select = options['onSelect'] as ((point: unknown) => void) | undefined;
    capture.options.push({ onSelect: select });
    return {
      ...options,
      onSelect: (point: unknown) => {
        capture.point = point;
        select?.(point);
      },
    };
  };
  return {
    ...original,
    mountChart: (element: HTMLElement, options: Record<string, unknown>) => {
      const mounted = realMount(element, observed(options));
      return {
        ...mounted,
        update: (next: Record<string, unknown>) => {
          mounted.update(observed(next));
        },
      };
    },
  };
});
const mounts: Array<{ destroy(): void }> = [];
const realms: JSDOM[] = [];
afterEach(() => {
  for (const mount of mounts.splice(0)) mount.destroy();
  for (const realm of realms.splice(0)) realm.window.close();
  document.body.replaceChildren();
  capture.options.length = 0;
  capture.point = null;
});
function host(doc = document, width = 640): HTMLElement {
  const el = doc.body.createDiv();
  el.className = 'abyss-statistics';
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 280,
    width,
    height: 280,
    toJSON: () => ({}),
  });
  doc.body.append(el);
  return el;
}
function model(overrides: Partial<StatisticsChartModel> = {}): StatisticsChartModel {
  return {
    id: 'events',
    accessibleLabel: 'Recorded events',
    kind: 'bars',
    layout: 'diverging',
    x: { type: 'band', label: 'Day', categories: ['Mon', 'Tue'] },
    y: { type: 'number', label: 'Tasks', domain: [-5, 5] },
    series: [
      { key: 'created', label: 'Created', tone: 'created' },
      { key: 'completed', label: 'Completed', tone: 'completed' },
    ],
    marks: [
      { key: 'c', x: 'Mon', y: 3, y2: 0, series: 'created', selectionId: 'created', weight: 3 },
      { key: 'r', x: 'Mon', y: 5, y2: 3, series: 'created', selectionId: 'recurring', weight: 2 },
      {
        key: 'd',
        x: 'Mon',
        y: -2,
        y2: 0,
        series: 'completed',
        selectionId: 'completed',
        weight: 2,
      },
    ],
    ...overrides,
  };
}
function mount(el: HTMLElement, value = model(), select = vi.fn()) {
  const handle = new TanStackStatisticsChart().mount(el, value, select);
  mounts.push(handle);
  return { handle, select, svg: () => required(el.querySelector('svg')) };
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected rendered chart value');
  return value;
}
function key(svg: SVGSVGElement, value: string) {
  const view = required(svg.ownerDocument.defaultView);
  svg.dispatchEvent(new view.KeyboardEvent('keydown', { key: value, bubbles: true }));
}
function marks(el: HTMLElement, selector = 'rect') {
  return Array.from(el.querySelectorAll<SVGGraphicsElement>(`.ts-chart__marks ${selector}`)).filter(
    (mark) => mark.closest('clipPath') === null,
  );
}
function n(el: Element, name: string) {
  return Number(el.getAttribute(name));
}
function expectVisible(
  element: Element,
  bounds: { left: number; top: number; right: number; bottom: number },
  svg: SVGSVGElement,
) {
  const contains = (left: number, top: number, right: number, bottom: number) => {
    expect(bounds.left, `${element.tagName} left extent`).toBeGreaterThanOrEqual(left);
    expect(bounds.top, `${element.tagName} top extent`).toBeGreaterThanOrEqual(top);
    expect(bounds.right, `${element.tagName} right extent`).toBeLessThanOrEqual(right);
    expect(bounds.bottom, `${element.tagName} bottom extent`).toBeLessThanOrEqual(bottom);
  };
  const viewport = required(svg.getAttribute('viewBox')).split(/\s+/).map(Number);
  contains(
    required(viewport[0]),
    required(viewport[1]),
    required(viewport[2]),
    required(viewport[3]),
  );
  for (
    let ancestor: Element | null = element;
    ancestor !== svg;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor === null) throw new Error('Expected mark inside SVG');
    const id = ancestor.getAttribute('clip-path')?.match(/^url\(#(.+)\)$/)?.[1];
    if (id === undefined) continue;
    const clip = required(required(svg.ownerDocument.getElementById(id)).querySelector('rect'));
    contains(
      n(clip, 'x'),
      n(clip, 'y'),
      n(clip, 'x') + n(clip, 'width'),
      n(clip, 'y') + n(clip, 'height'),
    );
  }
}

describe('Statistics chart adapter', () => {
  it('describes the selected stacked contribution rather than its cumulative endpoint', () => {
    const value = model();
    const recurring = required(value.marks.find((mark) => mark.key === 'r'));
    expect(statisticsMarkDescription(recurring, value)).toContain('Created: 2 tasks');
    expect(statisticsMarkDescription(recurring, value)).toContain('Created');
  });
  it('describes a horizontal stacked segment once with its own task magnitude', () => {
    const chart = model({
      layout: 'stacked',
      x: { type: 'number', label: 'Tasks', unit: 'count', domain: [0, 20] },
      y: { type: 'band', label: '', categories: ['New tasks'] },
    });
    const description = statisticsMarkDescription(
      { key: 'm', x: 6, x2: 14, y: 'New tasks', weight: 8, series: 'completed' },
      chart,
    );
    expect(description).toBe('New tasks\nCompleted: 8 tasks');
    expect(
      statisticsMarkContent(
        { key: 'm', x: 6, x2: 14, y: 'New tasks', weight: 8, series: 'completed' },
        chart,
      ),
    ).toEqual({ title: 'New tasks', rows: [{ label: 'Completed', value: '8 tasks' }] });
  });
  it('describes a negative vertical segment with positive task magnitude', () => {
    expect(
      statisticsMarkDescription({ key: 'm', x: 'Mon', y: -8, series: 'completed' }, model()),
    ).toBe('Mon\nCompleted: 8 tasks');
  });
  it('describes a session histogram range with the actual session count', () => {
    const chart = model({
      x: { type: 'band', label: 'Session length', categories: ['15–30 min'] },
      y: { type: 'number', label: 'Sessions', unit: 'count', domain: [0, 10] },
    });
    expect(statisticsMarkDescription({ key: 'bin', x: '15–30 min', y: 3 }, chart)).toBe(
      '15–30 min\nSessions: 3 sessions',
    );
  });
  it('formats provided observations once and uses their concise title for evidence', () => {
    const mark = {
      key: 'rate',
      x: 2,
      y: 'Sun',
      observation: {
        title: 'Sunday at 02:00',
        values: [
          { label: 'Recording rate', value: 1 / 3, unit: 'min/h' },
          { label: 'Completion', value: 25, unit: 'percent' },
          { label: 'Elapsed time', value: 0.00025, unit: 'hours' },
          { label: 'Timing', value: null, unit: 'days' },
        ],
        note: 'Through now',
      },
    };
    expect(statisticsMarkContent(mark, model())).toEqual({
      title: 'Sunday at 02:00',
      rows: [
        { label: 'Recording rate', value: '0.3 min/h' },
        { label: 'Completion', value: '25%' },
        { label: 'Elapsed time', value: '0.00025 h' },
        { label: 'Timing', value: 'Unavailable' },
        { label: 'Reading', value: 'Through now' },
      ],
    });
    expect(statisticsMarkTitle(mark, model())).toBe('Sunday at 02:00');
  });
  it('renders explicit diverging endpoints in one shared column and activates semantic evidence', () => {
    const el = host();
    const chart = mount(el);
    const [created, recurring, completed] = marks(el);
    expect(created).toBeDefined();
    expect(recurring).toBeDefined();
    expect(completed).toBeDefined();
    expect(n(required(created), 'x')).toBe(n(required(recurring), 'x'));
    expect(n(required(created), 'x')).toBe(n(required(completed), 'x'));
    expect(n(required(recurring), 'y') + n(required(recurring), 'height')).toBeCloseTo(
      n(required(created), 'y'),
      1,
    );
    expect(n(required(created), 'y') + n(required(created), 'height')).toBeCloseTo(
      n(required(completed), 'y'),
      1,
    );
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select.mock.calls.flat()).toContain('recurring');
    key(chart.svg(), 'ArrowRight');
    key(chart.svg(), ' ');
    expect(chart.select).toHaveBeenLastCalledWith('created');
    expect(el.getAttribute('aria-label')).toBe('Recorded events');
    expect(el.getAttribute('role')).toBe('group');
    expect(chart.svg().getAttribute('aria-label')).toBe('');
  });
  it('shares cumulative domains without stacking and preserves nonselectable zero origins', () => {
    const el = host();
    const chart = mount(
      el,
      model({
        kind: 'lines',
        x: { type: 'number', domain: [0, 2], label: 'Bucket' },
        y: { type: 'number', domain: [0, 8], label: 'Tasks' },
        marks: [
          { key: 'o', x: 0, y: 0, series: 'created' },
          { key: 'a', x: 1, y: 4, series: 'created', selectionId: 'a' },
          { key: 'b', x: 2, y: 8, series: 'created', selectionId: 'b' },
          { key: 'p', x: 0, y: 0, series: 'completed' },
          { key: 'q', x: 1, y: 2, series: 'completed', selectionId: 'q' },
          { key: 's', x: 2, y: 4, series: 'completed', selectionId: 's' },
        ],
      }),
    );
    expect(marks(el, 'path')).toHaveLength(2);
    const dots = marks(el, 'circle');
    expect(dots).toHaveLength(6);
    expect(n(required(dots[1]), 'cy')).toBe(n(required(dots[5]), 'cy'));
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select).not.toHaveBeenCalled();
  });
  it('keeps measured zero, unknown and immature heat cells visually distinct and selectable', () => {
    const el = host();
    const chart = mount(
      el,
      model({
        kind: 'heatmap',
        x: { type: 'band', label: 'Horizon', categories: ['1', '7', '30'] },
        y: { type: 'band', label: 'Cohort', categories: ['Sep 28'] },
        marks: [
          {
            key: 'zero',
            x: '1',
            y: 'Sep 28',
            state: 'measured',
            weight: 0,
            numerator: 0,
            denominator: 3,
            selectionId: 'zero',
          },
          { key: 'unknown', x: '7', y: 'Sep 28', state: 'unknown', selectionId: 'unknown' },
          { key: 'young', x: '30', y: 'Sep 28', state: 'immature', selectionId: 'young' },
        ],
      }),
    );
    const cells = marks(el);
    expect(cells).toHaveLength(3);
    expect(new Set(cells.map((cell) => cell.getAttribute('fill'))).size).toBe(3);
    expect(el.textContent).toContain('—');
    key(chart.svg(), 'End');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('young');
  });
  it('renders grouped scatter points with the model count and directed dependency endpoints', () => {
    const el = host();
    const chart = mount(
      el,
      model({
        kind: 'scatter',
        x: { type: 'number', label: 'Age', domain: [0, 10] },
        y: { type: 'number', label: 'Time', domain: [0, 60] },
        marks: [{ key: 'group', x: 2, y: 0, weight: 5, overdue: 2, selectionId: 'five' }],
      }),
    );
    expect(marks(el, 'circle')).toHaveLength(1);
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('five');
    chart.handle.update(
      model({
        kind: 'network',
        x: { type: 'number', label: '', domain: [0, 2] },
        y: { type: 'number', label: '', domain: [0, 2] },
        marks: [
          { key: 'a', x: 0, y: 1, label: 'Prerequisite', selectionId: 'a' },
          { key: 'b', x: 2, y: 1, label: 'Dependent', selectionId: 'b' },
        ],
        edges: [{ from: 'a', to: 'b', selectionId: 'link' }],
      }),
    );
    const link = el.querySelector('.ts-chart__arrow');
    expect(link).not.toBeNull();
    expect(marks(el, 'circle')).toHaveLength(2);
    const shaft = required(el.querySelector('.ts-chart__arrow-shaft')),
      target = required(marks(el, 'circle')[1]);
    expect(n(shaft, 'x2')).toBeLessThanOrEqual(n(target, 'cx') - 8);
    expect(n(shaft, 'x2')).toBeGreaterThan(n(shaft, 'x1'));
    expect(el.textContent).toContain('Prerequisite');
    chart.select.mockClear();
    key(chart.svg(), 'Home');
    key(chart.svg(), 'ArrowRight');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('link');
  });
  it.each([640, 240])(
    'keeps origin and first-row network node and label extents visible at width %i',
    (width) => {
      const el = host(document, width);
      const original = model({
        id: 'dependency-chain',
        kind: 'network',
        layout: undefined,
        x: { type: 'number', label: 'Local layout', domain: [0, 9] },
        y: { type: 'number', label: 'Local layout', domain: [0, 10] },
        series: [
          { key: 'focus', label: 'Selected prerequisite', tone: 'accent' },
          { key: 'scope', label: 'In scope', tone: 'neutral' },
        ],
        marks: Array.from({ length: 9 }, (_, index) => ({
          key: `node:${index}`,
          x: index,
          y: 0,
          label: 'W'.repeat(24),
          series: index === 0 ? 'focus' : 'scope',
          selectionId: `opaque:${index}`,
        })),
        edges: [{ from: 'node:0', to: 'node:1', selectionId: 'opaque:edge' }],
      });
      const saved = structuredClone(original);
      const chart = mount(el, original);
      const circles = marks(el, 'circle');
      const labels = marks(el, 'text');
      expect(circles).toHaveLength(9);
      expect(labels).toHaveLength(9);
      for (const circle of circles) {
        const radius = n(circle, 'r') + n(circle, 'stroke-width') / 2;
        expectVisible(
          circle,
          {
            left: n(circle, 'cx') - radius,
            top: n(circle, 'cy') - radius,
            right: n(circle, 'cx') + radius,
            bottom: n(circle, 'cy') + radius,
          },
          chart.svg(),
        );
      }
      for (const label of labels) {
        const size = n(label, 'font-size');
        expect(size).toBe(11);
        expect(label.textContent).toContain('W');
        // A conservative one-em width per ASCII W covers this fixture beyond the engine's
        // deterministic JSDOM estimate. SVG uses a middle baseline for Cartesian text.
        const textWidth = label.textContent.length * size;
        const anchor = label.getAttribute('text-anchor');
        let left = n(label, 'x');
        if (anchor === 'end') left -= textWidth;
        else if (anchor === 'middle') left -= textWidth / 2;
        expectVisible(
          label,
          {
            left,
            top: n(label, 'y') - size / 2,
            right: left + textWidth,
            bottom: n(label, 'y') + size / 2,
          },
          chart.svg(),
        );
      }
      expect(original).toEqual(saved);
      key(chart.svg(), 'Home');
      key(chart.svg(), 'Enter');
      expect(chart.select).toHaveBeenLastCalledWith('opaque:0');
      key(chart.svg(), 'ArrowRight');
      key(chart.svg(), 'Enter');
      expect(chart.select).toHaveBeenLastCalledWith('opaque:edge');
    },
  );
  it('distinguishes density weights without changing model coordinates or populations', () => {
    const element = host();
    const chart = mount(
      element,
      model({
        kind: 'scatter',
        layout: 'density',
        x: { type: 'number', label: 'Age', domain: [0, 10] },
        y: { type: 'number', label: 'Minutes', domain: [0, 60] },
        marks: [
          { key: 'few', x: 0, x2: 5, y: 0, y2: 30, weight: 1, selectionId: 'few' },
          { key: 'many', x: 5, x2: 10, y: 0, y2: 30, weight: 8, selectionId: 'many' },
        ],
      }),
    );
    const [few, many] = marks(element);
    expect(marks(element)).toHaveLength(2);
    expect([
      required(few).getAttribute('fill'),
      required(few).getAttribute('fill-opacity'),
    ]).not.toEqual([
      required(many).getAttribute('fill'),
      required(many).getAttribute('fill-opacity'),
    ]);
    key(chart.svg(), 'End');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('many');
  });
  it('preserves local-clock interval geometry and partial-hour density gaps', () => {
    const el = host();
    mount(
      el,
      model({
        kind: 'timeline',
        x: { type: 'number', label: 'Time of day', domain: [0, 1440] },
        y: { type: 'band', label: 'Day', categories: ['Mon', 'Tue'] },
        marks: [
          {
            key: 'a',
            x: 540,
            x2: 600,
            y: 'Mon',
            weight: 60,
            selectionId: 'a',
            clock: {
              startMs: 0,
              endMs: 3600000,
              offsetMinutes: 60,
              localStartMinutes: 540,
              localEndMinutes: 600,
              startLabel: '09:00 UTC+01:00',
              endLabel: '10:00 UTC+01:00',
            },
          },
          { key: 'b', x: 540, x2: 600, y: 'Tue', weight: 60, selectionId: 'b' },
        ],
      }),
    );
    const rectangles = marks(el);
    expect(n(required(rectangles[0]), 'x')).toBe(n(required(rectangles[1]), 'x'));
    const densityHost = host();
    mount(
      densityHost,
      model({
        kind: 'timeline',
        layout: 'density',
        x: { type: 'number', label: 'Time of day', domain: [0, 1440] },
        y: { type: 'band', label: 'Day', categories: ['Sun'] },
        marks: [
          {
            key: 'gap',
            x: 120,
            x2: 180,
            y: 'Sun',
            weight: 15,
            selectionId: 'gap',
            clockRanges: [
              {
                startMs: 0,
                endMs: 900000,
                offsetMinutes: 90,
                localStartMinutes: 165,
                localEndMinutes: 180,
                startLabel: '02:45 UTC+01:30',
                endLabel: '03:00 UTC+01:30',
              },
            ],
          },
        ],
      }),
    );
    const segment = required(marks(densityHost)[0]);
    expect(n(segment, 'width')).toBeCloseTo(n(required(rectangles[0]), 'width') / 4, 0);
  });
  it('updates current selection through a stable port and releases all markup on repeated destroy', () => {
    const el = host();
    const chart = mount(el);
    const oldSvg = chart.svg();
    chart.handle.update(model({ marks: [{ key: 'new', x: 'Tue', y: 4, selectionId: 'current' }] }));
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenLastCalledWith('current');
    chart.handle.destroy();
    chart.handle.destroy();
    key(oldSvg, 'Enter');
    expect(el.children).toHaveLength(0);
    expect(chart.select.mock.calls).toHaveLength(1);
  });
  it('rejects a superseded callback even when the new model reuses its selection string', () => {
    const element = host(),
      chart = mount(
        element,
        model({ marks: [{ key: 'before', x: 'Mon', y: 1, selectionId: 'same' }] }),
      );
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    const oldCallback = capture.options[0]?.onSelect,
      oldPoint = capture.point;
    expect(oldPoint).not.toBeNull();
    chart.select.mockClear();
    chart.handle.update(model({ marks: [{ key: 'after', x: 'Tue', y: 2, selectionId: 'same' }] }));
    oldCallback?.(oldPoint);
    expect(chart.select).not.toHaveBeenCalled();
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('same');
  });
  it('propagates malformed construction and update failures instead of empty success', () => {
    const invalid = model({ marks: [{ key: 'invalid', x: 'Mon', y: 'unavailable' }] });
    const element = host();
    const added = vi.spyOn(element, 'addEventListener'),
      removed = vi.spyOn(element, 'removeEventListener');
    expect(() => {
      mount(element, invalid);
    }).toThrow('coordinate must be finite');
    expect(element.querySelector('svg')).toBeNull();
    for (const [type, listener] of added.mock.calls)
      expect(
        removed.mock.calls.some(
          ([removedType, removedListener]) => removedType === type && removedListener === listener,
        ),
      ).toBe(true);
    const chart = mount(element);
    expect(() => {
      chart.handle.update(invalid);
    }).toThrow('coordinate must be finite');
    chart.handle.destroy();
    expect(element.children).toHaveLength(0);
  });
  it('labels supplied neutral guides and preserves weighted clock density', () => {
    const element = host();
    mount(
      element,
      model({
        kind: 'timeline',
        layout: 'density',
        x: { type: 'number', label: 'Clock', domain: [0, 1440] },
        y: { type: 'band', label: 'Day', categories: ['Mon'] },
        guides: [{ axis: 'x', value: 720, label: 'Midday' }],
        marks: [
          { key: 'few', x: 540, x2: 600, y: 'Mon', weight: 10, selectionId: 'few' },
          { key: 'many', x: 600, x2: 660, y: 'Mon', weight: 60, selectionId: 'many' },
        ],
      }),
    );
    expect(element.textContent).toContain('Midday');
    const [few, many] = marks(element);
    expect([
      required(few).getAttribute('fill'),
      required(few).getAttribute('fill-opacity'),
    ]).not.toEqual([
      required(many).getAttribute('fill'),
      required(many).getAttribute('fill-opacity'),
    ]);
    const numeric = host();
    mount(
      numeric,
      model({
        kind: 'lines',
        x: { type: 'number', label: 'Age', domain: [0, 2] },
        y: { type: 'number', label: 'Count', domain: [0, 5] },
        guides: [{ axis: 'x', value: 1, label: 'Median' }],
        marks: [{ key: 'one', x: 1, y: 2 }],
      }),
    );
    const label = required(
        [...numeric.querySelectorAll('text')].find((text) => text.textContent === 'Median'),
      ),
      clip = required(numeric.querySelector('clipPath rect'));
    expect(n(label, 'y')).toBeGreaterThanOrEqual(n(clip, 'y') + 11);
  });
  it('shows explicit civil date labels instead of ordinal bucket numbers', () => {
    const element = host();
    mount(
      element,
      model({
        kind: 'lines',
        x: {
          type: 'number',
          label: 'Date',
          domain: [0, 2],
          tickLabels: [
            [1, '2026-10-01'],
            [2, '2026-10-02'],
          ],
        },
        marks: [
          { key: 'origin', x: 0, y: 0 },
          { key: 'day1', x: 1, y: 1 },
          { key: 'day2', x: 2, y: 2 },
        ],
      }),
    );
    expect(element.textContent).toContain('2026-10-01');
    expect(element.textContent).toContain('2026-10-02');
  });
  it('exposes numerator, denominator and fractional mean inside owner-document portal tooltips', () => {
    const element = host();
    const chart = mount(
      element,
      model({
        kind: 'heatmap',
        x: { type: 'number', label: 'Hour', domain: [0, 24] },
        y: { type: 'band', label: 'Weekday', categories: ['Sun'] },
        marks: [
          {
            key: 'mean',
            x: 2,
            y: 'Sun',
            weight: 0.00025,
            numerator: 0.0005,
            denominator: 2,
            selectionId: 'mean',
            detail:
              '0.0005 recorded minutes / 2 elapsed exposure hours; mean 0.00025 minutes per hour',
          },
        ],
      }),
    );
    key(chart.svg(), 'Home');
    const tooltip = element.ownerDocument.querySelector<HTMLElement>('.abyss-statistics-tooltip');
    expect(tooltip?.textContent).toContain('0.00025');
    expect(tooltip?.textContent).toContain('0.0005 / 2');
    expect(tooltip?.textContent).toContain('0.0005 recorded minutes / 2 elapsed exposure hours');
    expect(tooltip?.textContent).toContain('mean 0.00025 minutes per hour');
    expect(element.contains(tooltip)).toBe(false);
    expect(tooltip?.parentElement).toBe(element.ownerDocument.body);
    const inputs = contracts.runtime.consumed.filter((name) =>
      name.startsWith('--ts-chart-tooltip-'),
    );
    expect(inputs).toHaveLength(8);
    for (const variable of inputs)
      expect(tooltip?.getAttribute('style')).toContain(`var(${variable},`);
    expect(tooltip?.style.background).toContain('var(--ts-chart-tooltip-background,');
  });
  it('escapes observation text and releases its owner-document tooltip on destroy', () => {
    const element = host();
    const chart = mount(
      element,
      model({
        marks: [
          {
            key: 'escaped',
            x: 'Mon',
            y: 1,
            selectionId: 'record',
            observation: {
              title: '<img src=x onerror=alert(1)>',
              values: [{ label: '<b>Tasks</b>', value: '<script>bad()</script>' }],
            },
          },
        ],
      }),
    );
    key(chart.svg(), 'Home');
    const tooltip = required(element.ownerDocument.querySelector('.abyss-statistics-tooltip'));
    expect(tooltip.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(tooltip.querySelector('img, script, b')).toBeNull();
    element.setAttribute('inert', '');
    key(chart.svg(), 'Enter');
    expect(chart.select).not.toHaveBeenCalled();
    chart.handle.destroy();
    expect(tooltip.isConnected).toBe(false);
    expect(element.ownerDocument.querySelector('.abyss-statistics-tooltip')).toBeNull();
  });
  it('relayouts at the measured width and makes a queued resize inert after destroy', () => {
    const observers: ResizeObserverCallback[] = [],
      frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    class Observer {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Observer);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const element = host();
    const chart = mount(element);
    const fire = (width: number) =>
      observers[0]?.(
        [
          {
            target: element,
            contentRect: { ...element.getBoundingClientRect(), width },
            contentBoxSize: [{ inlineSize: width, blockSize: 280 }],
            borderBoxSize: [{ inlineSize: width, blockSize: 280 }],
            devicePixelContentBoxSize: [{ inlineSize: width, blockSize: 280 }],
          },
        ],
        {} as ResizeObserver,
      );
    fire(280);
    for (const callback of frames.values()) callback(1);
    frames.clear();
    expect(chart.svg().getAttribute('viewBox')).toContain('280');
    fire(400);
    const pending = [...frames.values()];
    chart.handle.destroy();
    for (const callback of pending) callback(2);
    expect(element.children).toHaveLength(0);
  });
  it('mounts in a second owner document and updates theme without global realm dependence', () => {
    const realm = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    realms.push(realm);
    Object.defineProperty(
      realm.window.Node.prototype,
      'createEl',
      Object.getOwnPropertyDescriptor(Node.prototype, 'createEl') ?? {},
    );
    Object.defineProperty(
      realm.window.Node.prototype,
      'createDiv',
      Object.getOwnPropertyDescriptor(Node.prototype, 'createDiv') ?? {},
    );
    const el = host(realm.window.document);
    const chart = mount(el);
    expect(chart.svg().ownerDocument).toBe(realm.window.document);
    el.setCssProps({ '--color-blue': 'rgb(1, 2, 3)' });
    chart.handle.update(model());
    expect(marks(el)[0]?.getAttribute('fill')).toBe('var(--color-blue, var(--text-normal))');
    expect(el.style.getPropertyValue('--color-blue')).toBe('rgb(1, 2, 3)');
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('recurring');
    const tooltip = required(realm.window.document.querySelector('.abyss-statistics-tooltip'));
    expect(tooltip.parentElement).toBe(realm.window.document.body);
    expect(document.querySelector('.abyss-statistics-tooltip')).toBeNull();
    chart.handle.destroy();
    expect(tooltip.isConnected).toBe(false);
  });
});

describe('keyed chart owner', () => {
  it('reuses surviving charts, removes empty charts, and suspends/resumes across document adoption', () => {
    const el = host();
    const owner = new StatisticsCharts(el, new TanStackStatisticsChart(), vi.fn());
    mounts.push(owner);
    owner.update([model(), model({ id: 'other', facet: { key: 'project', label: 'Project' } })]);
    const first = el.querySelector('svg');
    expect(el.querySelectorAll('svg')).toHaveLength(2);
    owner.update([model()]);
    expect(el.querySelector('svg')).toBe(first);
    expect(el.querySelectorAll('svg')).toHaveLength(1);
    owner.suspend();
    expect(el.querySelector('svg')).toBeNull();
    owner.resume();
    expect(el.querySelector('svg')).not.toBeNull();
    const realm = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    realms.push(realm);
    Object.defineProperty(
      realm.window.Node.prototype,
      'createEl',
      Object.getOwnPropertyDescriptor(Node.prototype, 'createEl') ?? {},
    );
    Object.defineProperty(
      realm.window.Node.prototype,
      'createDiv',
      Object.getOwnPropertyDescriptor(Node.prototype, 'createDiv') ?? {},
    );
    const next = host(realm.window.document);
    owner.resume(next);
    expect(el.querySelector('svg')).toBeNull();
    expect(next.querySelector('svg')?.ownerDocument).toBe(realm.window.document);
    owner.update([model({ marks: [] })]);
    expect(next.children).toHaveLength(0);
  });
});
it('renders typed horizontal stacks, supplied cell text and fixed percent intensity', () => {
  const el = host();
  mount(
    el,
    model({
      kind: 'bars',
      layout: 'stacked',
      x: { type: 'number', label: 'Tasks', domain: [0, 10] },
      y: { type: 'band', label: 'Project', categories: ['A'] },
      marks: [{ key: 'one', x: 2, x2: 5, y: 'A', series: 'created', selectionId: 'one' }],
    }),
  );
  expect(n(required(marks(el)[0]), 'width')).toBeGreaterThan(100);
  expect(Number(el.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[3])).toBeLessThan(120);
  const heat = host();
  mount(
    heat,
    model({
      kind: 'heatmap',
      intensityScale: { domain: [0, 100], unit: '%' },
      x: { type: 'number', label: 'Days', domain: [0, 3] },
      y: { type: 'band', label: 'Week', categories: ['A'] },
      series: [],
      marks: [
        { key: 'percent', x: 1, y: 'A', weight: 20, displayText: '20%', state: 'measured' },
        { key: 'immature', x: 3, y: 'A', displayText: '…', state: 'immature' },
      ],
    }),
  );
  expect(heat.textContent).toContain('20%');
  expect(heat.textContent).toContain('…');
  const measured = marks(heat).find((mark) => mark.getAttribute('fill')?.includes('20%') === true);
  expect(measured).toBeDefined();
});

it.each([640, 240])(
  'paints horizontal stack endpoints against the actual scale at %ipx',
  (width) => {
    const el = host(document, width);
    mount(
      el,
      model({
        layout: 'stacked',
        x: { type: 'number', label: 'Tasks', unit: 'count', domain: [0, 3] },
        y: { type: 'band', label: '', categories: ['A', 'B'] },
        marks: [
          { key: 'before', x: 0, x2: 1, y: 'A', series: 'created', selectionId: 'before' },
          { key: 'new', x: 1, x2: 3, y: 'A', series: 'completed', selectionId: 'new' },
          { key: 'b', x: 0, x2: 2, y: 'B', series: 'completed', selectionId: 'b' },
        ],
      }),
    );
    const clip = required(el.querySelector('clipPath rect'));
    const [before, fresh, b] = marks(el).map((element) => ({
      x: n(element, 'x'),
      width: n(element, 'width'),
    }));
    expect(required(before).x).toBeCloseTo(n(clip, 'x'));
    expect(required(before).width).toBeCloseTo(n(clip, 'width') / 3);
    expect(required(fresh).x).toBeCloseTo(n(clip, 'x') + n(clip, 'width') / 3);
    expect(required(fresh).width).toBeCloseTo((n(clip, 'width') * 2) / 3);
    expect(required(b).width).toBeCloseTo((n(clip, 'width') * 2) / 3);
    const ticks = [...el.querySelectorAll('.ts-chart__axis text')].map((text) => text.textContent);
    expect(ticks.some((tick) => /^\d+\.\d/.test(tick))).toBe(false);
  },
);
it.each([640, 240])(
  'keeps full scatter extents visible at zero and maximum coordinates at %ipx',
  (width) => {
    const el = host(document, width);
    const chart = mount(
      el,
      model({
        kind: 'scatter',
        layout: undefined,
        x: { type: 'number', label: 'Age', domain: [0, 45] },
        y: { type: 'number', label: 'Recorded time', domain: [0, 450], unit: 'minutes' },
        series: [],
        marks: [
          { key: 'zero', x: 0, y: 0, weight: 100000, selectionId: 'zero' },
          { key: 'max', x: 45, y: 450, weight: 2, selectionId: 'max' },
          { key: 'edge', x: 45, y: 0, selectionId: 'edge' },
        ],
      }),
    );
    for (const circle of marks(el, 'circle')) {
      const r = n(circle, 'r') + n(circle, 'stroke-width') / 2;
      expectVisible(
        circle,
        {
          left: n(circle, 'cx') - r,
          top: n(circle, 'cy') - r,
          right: n(circle, 'cx') + r,
          bottom: n(circle, 'cy') + r,
        },
        chart.svg(),
      );
    }
    const axisTitle = required(
      [...el.querySelectorAll('text')].find((node) => node.textContent === 'Recorded time'),
    );
    // The rotated label's transverse ink is bounded conservatively by one font em.
    expect(n(axisTitle, 'x') - n(axisTitle, 'font-size')).toBeGreaterThanOrEqual(0);
    key(chart.svg(), 'End');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenCalledWith('edge');
  },
);
it.each(['time', 'age'] as const)('renders and selects dense Aging with zero %s', async (zero) => {
  const now = Date.parse('2026-10-04T12:00Z');
  const nodes = Array.from({ length: 601 }, (_, i) =>
    task(`owner${i}`, {
      planning: {
        created: date(
          new Date(now - (zero === 'time' ? i * 86400000 : 0)).toISOString().slice(0, 10),
        ),
      },
      timeEntries:
        zero === 'age' && i > 0
          ? [closed(new Date(now - i * 60000).toISOString(), new Date(now).toISOString())]
          : [],
    }),
  );
  const dataset = required(await prepareStatisticsDataset(source(nodes), [], work));
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'aging' }), work),
  );
  const value = required(
    view.sections.flatMap((section) => section.charts).find((chart) => chart.id === 'aging'),
  );
  expect(value.layout).toBe('density');
  expect(value.marks.reduce((sum, mark) => sum + required(mark.weight), 0)).toBe(601);
  const el = host(document, 240),
    chart = mount(el, value);
  const rectangles = marks(el);
  expect(rectangles).toHaveLength(zero === 'time' ? 30 : 20);
  for (const rectangle of rectangles) {
    expect(n(rectangle, 'width')).toBeGreaterThan(0);
    expect(n(rectangle, 'height')).toBeGreaterThan(0);
  }
  const all = new Set<string>();
  for (const mark of value.marks) {
    expect(zero === 'time' ? mark.y : mark.x).toBe(0);
    const bin = Number(mark.key.split(':')[zero === 'time' ? 0 : 1]),
      bins = zero === 'time' ? 30 : 20;
    const expected = nodes
      .filter((_, i) => Math.min(bins - 1, Math.floor((i / 600) * bins)) === bin)
      .map((node) => node.title)
      .sort((a, b) => a.localeCompare(b));
    const page = view.evidence(required(mark.selectionId), 0, 50);
    expect(page.total).toBe(expected.length);
    expect(page.rows.map((row) => row.title).sort((a, b) => a.localeCompare(b))).toEqual(expected);
    page.rows.forEach((row) => all.add(row.title));
  }
  expect(all.size).toBe(601);
  for (const position of ['Home', 'End']) {
    key(chart.svg(), position);
    key(chart.svg(), 'Enter');
    const selection: unknown = chart.select.mock.lastCall?.[0];
    expect(typeof selection).toBe('string');
    expect(view.evidence(String(selection), 0, 50).total).toBeGreaterThan(0);
  }
});
it('shows overlapping timeline intervals in separate subrows without changing clock positions', () => {
  const el = host();
  mount(
    el,
    model({
      kind: 'timeline',
      layout: undefined,
      x: { type: 'number', label: 'Clock', domain: [0, 1440] },
      y: { type: 'band', label: 'Day', categories: ['Mon', 'Tue'] },
      series: [],
      marks: [
        { key: 'a', x: 480, x2: 600, y: 'Mon', selectionId: 'a' },
        { key: 'b', x: 480, x2: 540, y: 'Mon', selectionId: 'b' },
        { key: 'c', x: 540, x2: 600, y: 'Mon', selectionId: 'c' },
        { key: 'd', x: 480, x2: 600, y: 'Tue', selectionId: 'd' },
      ],
    }),
  );
  const [a, b, c, d] = marks(el).map((element) => ({
    x: n(element, 'x'),
    y: n(element, 'y'),
    h: n(element, 'height'),
    w: n(element, 'width'),
  }));
  expect(required(a).x).toBe(required(b).x);
  expect(required(a).x).toBe(required(d).x);
  expect(Math.abs(required(b).w - required(a).w / 2)).toBeLessThanOrEqual(0.01);
  expect(required(a).y + required(a).h).toBeLessThanOrEqual(required(b).y);
  expect(required(c).y).toBe(required(b).y);
});
it.each([640, 240])('expands folded clock fragments once before packing at %ipx', (width) => {
  const el = host(document, width);
  const value = model({
    kind: 'timeline',
    layout: undefined,
    x: { type: 'number', label: 'Clock', domain: [0, 1440] },
    y: { type: 'band', label: 'Day', categories: ['Sun'] },
    series: [],
    marks: [
      {
        key: 'source:entry',
        x: 90,
        x2: 105,
        y: 'Sun',
        weight: 75,
        selectionId: 'source:entry',
        label: 'Folded interval',
        detail: 'One physical tracking entry',
        clockRanges: [
          {
            startMs: 0,
            endMs: 1800000,
            offsetMinutes: 120,
            localStartMinutes: 90,
            localEndMinutes: 120,
            startLabel: '01:30 UTC+02:00',
            endLabel: '02:00 UTC+02:00',
          },
          {
            startMs: 1800000,
            endMs: 4500000,
            offsetMinutes: 60,
            localStartMinutes: 60,
            localEndMinutes: 105,
            startLabel: '01:00 UTC+01:00',
            endLabel: '01:45 UTC+01:00',
          },
        ],
      },
    ],
  });
  const original = structuredClone(value),
    chart = mount(el, value);
  const rectangles = marks(el),
    clip = required(el.querySelector('clipPath rect'));
  expect(rectangles).toHaveLength(2);
  for (const [index, [start, end]] of [
    [60, 105],
    [90, 120],
  ].entries()) {
    const fragment = required(rectangles[index]);
    expect(n(fragment, 'x')).toBeCloseTo(
      n(clip, 'x') + (n(clip, 'width') * required(start)) / 1440,
    );
    expect(n(fragment, 'width')).toBeCloseTo(
      (n(clip, 'width') * (required(end) - required(start))) / 1440,
    );
  }
  const [first, second] = rectangles.map((rectangle) => ({
    y: n(rectangle, 'y'),
    h: n(rectangle, 'height'),
  }));
  expect(required(first).h).toBeCloseTo(required(second).h);
  expect(required(second).y - required(first).y).toBeCloseTo(required(first).h / 0.8);
  for (const position of ['Home', 'End']) {
    key(chart.svg(), position);
    const tooltip = required(
      el.ownerDocument.querySelector('.abyss-statistics-tooltip'),
    ).textContent;
    expect(tooltip).toContain('01:30 UTC+02:00 – 02:00 UTC+02:00');
    expect(tooltip).toContain('01:00 UTC+01:00 – 01:45 UTC+01:00');
    expect(tooltip).toContain('One physical tracking entry');
    key(chart.svg(), 'Enter');
  }
  expect(chart.select.mock.calls).toEqual([['source:entry'], ['source:entry']]);
  // Numeric lanes and density bypass band packing, but still expand each range once.
  for (const variant of [
    {
      ...value,
      y: { type: 'number' as const, label: 'Lane', domain: [0, 2] as const },
      marks: value.marks.map((mark) => ({ ...mark, y: 0, y2: 1 })),
    },
    { ...value, layout: 'density' as const },
  ]) {
    chart.handle.update(variant);
    const fragments = marks(el),
      plot = required(el.querySelector('clipPath rect'));
    expect(fragments).toHaveLength(2);
    for (const [index, [start, end]] of [
      [90, 120],
      [60, 105],
    ].entries()) {
      const fragment = required(fragments[index]);
      expect(n(fragment, 'x')).toBeCloseTo(
        n(plot, 'x') + (n(plot, 'width') * required(start)) / 1440,
      );
      expect(n(fragment, 'width')).toBeCloseTo(
        (n(plot, 'width') * (required(end) - required(start))) / 1440,
      );
    }
    key(chart.svg(), 'Home');
    key(chart.svg(), 'Enter');
    expect(chart.select).toHaveBeenLastCalledWith('source:entry');
  }
  expect(value).toEqual(original);
});
it('relayouts horizontal stacks with their axes when the host grows after initial mounting', () => {
  let resized: ResizeObserverCallback | undefined;
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      resized = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const el = host(document, 320);
  mount(
    el,
    model({
      layout: 'stacked',
      x: { type: 'number', label: 'Tasks', domain: [0, 3] },
      y: { type: 'band', label: '', categories: ['A'] },
      marks: [
        { key: 'a', x: 0, x2: 1, y: 'A', series: 'created' },
        { key: 'b', x: 1, x2: 3, y: 'A', series: 'completed' },
      ],
    }),
  );
  resized?.(
    [
      {
        target: el,
        contentRect: { ...el.getBoundingClientRect(), width: 1640 },
        contentBoxSize: [{ inlineSize: 1640, blockSize: 76 }],
        borderBoxSize: [],
        devicePixelContentBoxSize: [],
      },
    ],
    {} as ResizeObserver,
  );
  const clip = required(el.querySelector('clipPath rect'));
  expect(n(required(marks(el)[1]), 'width')).toBeCloseTo((n(clip, 'width') * 2) / 3);
});
it('namespaces plot clipping across concurrently mounted facets and plugin leaves', () => {
  const hosts = [host(document, 240), host(document, 640), host(document, 320)];
  for (const el of hosts) mount(el);
  const ids = hosts.map((el) => required(el.querySelector('clipPath')).id);
  expect(new Set(ids).size).toBe(3);
  for (const [i, el] of hosts.entries()) {
    const group = required(el.querySelector('[clip-path]'));
    expect(group.getAttribute('clip-path')).toBe(`url(#${ids[i]})`);
    expect(document.getElementById(required(ids[i]))?.closest('svg')).toBe(el.querySelector('svg'));
  }
});
it('uses actual integer count ticks without rounding fractional positions into duplicate labels', () => {
  const el = host();
  mount(
    el,
    model({
      x: { type: 'band', label: '', categories: ['A'] },
      y: { type: 'number', label: 'Tasks', domain: [0, 2], unit: 'count' },
      marks: [{ key: 'a', x: 'A', y: 2 }],
      series: [],
      layout: undefined,
    }),
  );
  const labels = [...el.querySelectorAll('text')].map((text) => text.textContent);
  expect(labels.some((label) => label.includes('0.5') || label.includes('1.5'))).toBe(false);
  expect(labels).toContain('1');
});
it('bounds mounted charts and releases observers and listeners after thirty view switches', () => {
  const active = new Set<object>();
  class Observer {
    observe() {
      active.add(this);
    }
    unobserve() {
      active.delete(this);
    }
    disconnect() {
      active.delete(this);
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  const added = vi.spyOn(HTMLElement.prototype, 'addEventListener'),
    removed = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
  const el = host(),
    owner = new StatisticsCharts(el, new TanStackStatisticsChart(), vi.fn());
  mounts.push(owner);
  for (let i = 0; i < 30; i++) {
    owner.update([model({ id: `view:${i % 11}` })]);
    expect(el.querySelectorAll('svg')).toHaveLength(1);
    expect(active.size).toBe(1);
  }
  owner.destroy();
  expect(el.querySelector('svg')).toBeNull();
  expect(active.size).toBe(0);
  for (const [index, [type, listener]] of added.mock.calls.entries()) {
    const target = added.mock.contexts[index];
    expect(
      removed.mock.calls.some(
        ([removedType, removedListener], i) =>
          removedType === type &&
          removedListener === listener &&
          removed.mock.contexts[i] === target,
      ),
    ).toBe(true);
  }
});
it('keeps positive rank geometry with long human labels at constrained width', () => {
  const el = host(document, 300);
  const titles = [0, 1, 2].map((i) => `${i} ${'long dependency boundary title '.repeat(3)}`);
  mount(
    el,
    model({
      x: {
        type: 'band',
        label: 'Prerequisite',
        categories: ['a', 'b', 'c'],
        tickLabels: titles.map((label, i) => [String.fromCharCode(97 + i), label]),
      },
      y: { type: 'number', label: 'Direct waiting dependents', domain: [0, 100], unit: 'count' },
      series: [],
      layout: undefined,
      marks: titles.map((label, i) => ({
        key: `node:${i}`,
        x: String.fromCharCode(97 + i),
        y: 100 - i,
        label,
        selectionId: `select:${i}`,
      })),
    }),
  );
  expect(n(required(el.querySelector('clipPath rect')), 'width')).toBeGreaterThan(160);
  for (const mark of marks(el)) expect(n(mark, 'width')).toBeGreaterThan(20);
  const ticks = [...el.querySelectorAll('text')].filter((node) => /^\d /.test(node.textContent));
  expect(ticks.length).toBeGreaterThan(0);
  expect(ticks.every((node) => node.textContent.length <= 12)).toBe(true);
});
it('bounds dense graph height while preserving every selectable node and the focus label', () => {
  const el = host(document, 300);
  mount(
    el,
    model({
      kind: 'network',
      x: { type: 'number', label: '', domain: [0, 1] },
      y: { type: 'number', label: '', domain: [0, 79] },
      series: [
        { key: 'focus', label: 'Selected', tone: 'accent' },
        { key: 'scope', label: 'Other', tone: 'neutral' },
      ],
      marks: Array.from({ length: 80 }, (_, i) => ({
        key: `n${i}`,
        x: i === 0 ? 0 : 1,
        y: i === 0 ? 39 : i,
        label: `Readable task ${i}`,
        series: i === 0 ? 'focus' : 'scope',
        selectionId: `select:${i}`,
      })),
      edges: Array.from({ length: 79 }, (_, i) => ({ from: 'n0', to: `n${i + 1}` })),
    }),
  );
  expect(
    Number(required(el.querySelector('svg')?.getAttribute('viewBox')).split(' ')[3]),
  ).toBeLessThanOrEqual(640);
  expect(marks(el, 'circle')).toHaveLength(80);
  expect(marks(el, 'text')).toHaveLength(1);
  expect(required(marks(el, 'text')[0]).textContent).toContain('0');
});
it('keeps compact date and exact clock labels with positive Timeline geometry at the narrow viewport minimum', () => {
  const el = host(document, 240);
  mount(
    el,
    model({
      kind: 'timeline',
      layout: undefined,
      series: [],
      x: {
        type: 'number',
        label: 'Time of day',
        domain: [0, 1440],
        tickLabels: [
          [0, '00:00'],
          [720, '12:00'],
          [1440, '24:00'],
        ],
      },
      y: {
        type: 'band',
        label: 'Local day',
        categories: ['2026-09-28', '2026-09-29'],
        tickLabels: [
          ['2026-09-28', '2026-09-28 · 495 min'],
          ['2026-09-29', '2026-09-29 · 0 min'],
        ],
      },
      marks: [{ key: 'interval', x: 480, x2: 975, y: '2026-09-28', selectionId: 'record' }],
    }),
  );
  const clip = required(el.querySelector('clipPath rect'));
  expect(n(clip, 'width')).toBeGreaterThan(40);
  expect(n(clip, 'x') + n(clip, 'width')).toBeLessThanOrEqual(240);
  expect([...el.querySelectorAll('text')].map((node) => node.textContent)).toContain(
    'Mon 28 · 495 min',
  );
  const interval = required(marks(el)[0]);
  expect(n(interval, 'width')).toBeCloseTo((n(clip, 'width') * 495) / 1440);
});
it.each([
  [
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
  ],
  [
    '7+ days early',
    '1–6 days early',
    'On due date',
    '1 day late',
    '2–3 days late',
    '4–7 days late',
    '8–30 days late',
    '31+ days late',
  ],
])('preserves meaningful compact axis labels beginning with %s at240px', (...categories) => {
  const el = host(document, 240);
  mount(
    el,
    model({
      x: { type: 'band', label: '', categories },
      y: { type: 'number', label: 'Tasks', domain: [0, 2], unit: 'count' },
      series: [],
      layout: undefined,
      marks: categories.map((label, i) => ({ key: String(i), x: label, y: 1 })),
    }),
  );
  const labels = [...el.querySelectorAll('text')]
    .map((node) => node.textContent)
    .filter((label) => categories.includes(label));
  expect(labels).toContain(categories[0]);
  expect(labels.length).toBeLessThan(categories.length);
  expect(labels.length).toBeGreaterThan(1);
});

it('renders concise section reading and empty guidance with only a zero heatmap scale', async () => {
  const dataset = required(await prepareStatisticsDataset(source([task('A')]), [], work));
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'rhythm' }), work),
  );
  const surface = host();
  const renderer = { mount: vi.fn(() => ({ update: vi.fn(), destroy: vi.fn() })) };
  const sections = new StatisticsSections(surface, renderer, vi.fn());
  mounts.push(sections);
  sections.update({
    ...view,
    sections: [
      {
        ...required(view.sections[0]),
        reading: 'Through the selected period.',
        emptyMessage: 'No recorded time.',
        charts: [
          model({ kind: 'heatmap', intensityScale: { domain: [0, 0], unit: 'min/h' }, marks: [] }),
        ],
        metrics: [],
        legend: [],
      },
    ],
  });
  expect(surface.textContent).toContain('Through the selected period.');
  expect(surface.textContent).toContain('No recorded time.');
  expect(
    surface.querySelectorAll('.abyss-statistics-intensity .abyss-statistics-swatch'),
  ).toHaveLength(1);
  expect(surface.textContent).not.toContain('>0');
});
it('keeps nonzero selectable coverage and source issues in compact labelled Details', async () => {
  const dataset = required(await prepareStatisticsDataset(source([task('A')]), [], work));
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'rhythm' }), work),
  );
  const surface = host();
  const anchor = surface.createEl('button');
  const select = vi.fn();
  const details = new StatisticsDetails();
  mounts.push({
    destroy: () => {
      details.close();
    },
  });
  details.open(
    surface,
    anchor,
    {
      ...view,
      coverage: {
        ...view.coverage,
        scope: { ...view.coverage.scope, archive: 2 },
        source: {
          ...view.coverage.source,
          sourceIssues: [{ path: 'offline.md', reason: 'read-failed' }],
        },
      },
      sections: [
        {
          ...required(view.sections[0]),
          metrics: [
            { id: 'empty', role: 'coverage', label: 'Missing creation', value: 0 },
            {
              id: 'missing',
              role: 'coverage',
              label: 'Undated in scope',
              value: 3,
              selectionId: 'missing',
            },
          ],
        },
      ],
    },
    select,
  );
  const dialog = required(surface.querySelector('[role="dialog"]'));
  expect(dialog.textContent).toContain('Definition:');
  expect(dialog.textContent).toContain('Archived: 2');
  expect(dialog.textContent).toContain('offline.md: read-failed');
  expect(dialog.textContent).not.toContain('Missing creation');
  expect(dialog.textContent).not.toContain('Node or ancestor');
  expect(dialog.textContent).not.toContain('0 broken entries');
  required(dialog.querySelector('button')).click();
  expect(select).toHaveBeenCalledWith('missing');
  expect(dialog.isConnected).toBe(false);
});

it('keeps prose readable in the engine wrapping label column and short units in the value column', () => {
  const element = host();
  const chart = mount(
    element,
    model({
      marks: [
        {
          key: 'note',
          x: 'Mon',
          y: 1,
          observation: {
            title: 'Monday',
            values: [{ label: 'Tasks', value: 1, unit: 'tasks' }],
            note: 'A long contextual reading that stays fully readable.',
          },
        },
      ],
    }),
  );
  key(chart.svg(), 'Home');
  const rows = Array.from(
    element.ownerDocument.querySelectorAll('.abyss-statistics-tooltip .ts-chart-tooltip__row'),
  );
  expect(rows[0]?.textContent).toBe('Tasks1 task');
  const prose = required(rows[1]);
  expect(prose.children[1]?.textContent).toBe(
    'Reading: A long contextual reading that stays fully readable.',
  );
  expect(prose.children[2]?.textContent).toBe('');
});

it('separates adjacent selectable Details coverage metrics into accessible rows with exact selections', async () => {
  const dataset = required(await prepareStatisticsDataset(source([task('A')]), [], work));
  const original = required(
    await new StatisticsSession(dataset).view(request({ view: 'rhythm' }), work),
  );
  const labels = ['Creation date unavailable or future', 'Completion date unavailable or future'];
  const ids = ['created-unavailable', 'completed-unavailable'];
  const view = {
    ...original,
    sections: [
      {
        ...required(original.sections[0]),
        metrics: labels.map((label, index) => ({
          id: required(ids[index]),
          role: 'coverage' as const,
          label,
          value: 1,
          selectionId: required(ids[index]),
        })),
      },
    ],
  };
  const surface = host();
  const anchor = surface.createEl('button');
  const select = vi.fn();
  const details = new StatisticsDetails();
  mounts.push({
    destroy: () => {
      details.close();
    },
  });
  for (let index = 0; index < labels.length; index++) {
    details.open(surface, anchor, view, select);
    expect(surface.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    const list = required(surface.querySelector('[role="list"]'));
    expect(list.getAttribute('aria-label')).toBe(`${required(view.sections[0]).title} coverage`);
    const rows = Array.from(list.querySelectorAll('[role="listitem"]'));
    expect(rows).toHaveLength(2);
    rows.forEach((row, rowIndex) => {
      expect(row.parentElement).toBe(list);
      expect(row.textContent).toBe(`${required(labels[rowIndex])}: 1`);
      const button = required(row.querySelector('button'));
      expect(button.type).toBe('button');
      expect(button.textContent).toBe(`${required(labels[rowIndex])}: 1`);
    });
    const button = required(required(rows[index]).querySelector('button'));
    button.focus();
    expect(surface.ownerDocument.activeElement).toBe(button);
    button.click();
    expect(select).toHaveBeenLastCalledWith(required(ids[index]));
    expect(surface.querySelector('[role="dialog"]')).toBeNull();
  }
  expect(select.mock.calls).toEqual([['created-unavailable'], ['completed-unavailable']]);
});

it.each([1360, 320])(
  'renders exact compact cohort intervals and counts without truncation at %ipx',
  async (width) => {
    const dataset = required(
      await prepareStatisticsDataset(
        source([
          ...[
            '2026-09-21',
            '2026-09-14',
            '2026-09-07',
            '2026-08-31',
            '2026-08-24',
            '2026-08-17',
          ].map((created) => task(created, { planning: { created: date(created) } })),
          task('cross-month', { planning: { created: date('2026-09-28') } }),
          task('current-a', { planning: { created: date('2026-10-06') } }),
          task('current-b', { planning: { created: date('2026-10-07') } }),
        ]),
        [],
        work,
      ),
    );
    const view = required(
      await new StatisticsSession(dataset).view(
        request({ view: 'cohorts', period: 'all', nowMs: Date.parse('2026-10-09T12:00Z') }),
        work,
      ),
    );
    const chart = required(view.sections[0]?.charts[0]);
    const el = host(document, width);
    mount(el, chart);
    const ticks = [...el.querySelectorAll('svg text')].map((node) => node.textContent);
    expect(ticks).toContain('2026-10-05–10-09·2*');
    expect(ticks).toContain('2026-09-28–10-04·1');
    expect(ticks).toContain('Creation dates · task count');
    expect(ticks).toContain('1 day');
    const clip = required(el.querySelector('clipPath rect'));
    expect(n(clip, 'width')).toBeGreaterThan(100);
    expect(marks(el).every((cell) => n(cell, 'width') > 15)).toBe(true);
    expect(
      ticks.filter((label) => label.startsWith('2026-')).some((label) => label.includes('…')),
    ).toBe(false);
    expect(chart.marks.find((mark) => mark.y === '2026-10-05')?.observation?.title).toContain(
      '2026-10-05 – 2026-10-09',
    );
    expect(view.sections[0]?.reading).toContain('* partial week');
  },
);

it.each([1360, 320])(
  'preserves cross-year cohort range and maximum integer population at %ipx',
  (width) => {
    const el = host(document, width);
    const label = '2025-12-29–01-04·9010T';
    mount(
      el,
      model({
        id: 'cohorts',
        kind: 'heatmap',
        layout: undefined,
        x: { type: 'number', label: 'Completed within', domain: [0, 30] },
        y: {
          type: 'band',
          label: 'Creation dates · task count',
          categories: ['2025-12-29'],
          tickLabels: [['2025-12-29', label]],
        },
        series: [],
        marks: [
          {
            key: 'maximum',
            x: 1,
            y: '2025-12-29',
            denominator: Number.MAX_SAFE_INTEGER,
            numerator: 0,
            weight: 0,
          },
        ],
      }),
    );
    const texts = [...el.querySelectorAll('svg text')].map((node) => node.textContent);
    expect(texts).toContain(label);
    expect(texts.some((text) => text.includes('…'))).toBe(false);
    expect(n(required(el.querySelector('clipPath rect')), 'width')).toBeGreaterThan(0);
  },
);

it('retains an empty timeline frame and formats null units separately from measured zero', async () => {
  const dataset = required(await prepareStatisticsDataset(source([]), [], work));
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'timeline', period: 'today' }), work),
  );
  const surface = host(),
    sections = new StatisticsSections(surface, new TanStackStatisticsChart(), vi.fn());
  mounts.push(sections);
  sections.update({
    ...view,
    sections: [
      {
        ...required(view.sections[0]),
        metrics: [
          { id: 'absent-days', label: 'Absent days', value: null, unit: 'days' },
          { id: 'absent-time', label: 'Absent time', value: null, unit: 'minutes' },
          { id: 'zero-time', label: 'Measured zero', value: 0, unit: 'minutes' },
        ],
      },
    ],
  });
  expect(surface.querySelectorAll('svg')).toHaveLength(2);
  expect(surface.textContent).toContain('No recorded time in this week.');
  expect(
    [...surface.querySelectorAll('.abyss-statistics-metric-value')].map((el) => el.textContent),
  ).toEqual(['Unavailable', 'Unavailable', '0 min']);
});

it('bounds sparse Timeline height at the sixteen-overlap boundary and uses the existing hourly plot above it', async () => {
  for (const count of [16, 17, 700, 701]) {
    const dataset = required(
      await prepareStatisticsDataset(
        source(
          Array.from({ length: count }, (_, i) =>
            task(`overlap${i}`, {
              timeEntries: [closed('2026-10-04T10:10Z', '2026-10-04T10:15Z')],
            }),
          ),
        ),
        [],
        work,
      ),
    );
    const view = required(
      await new StatisticsSession(dataset).view(
        request({ view: 'timeline', period: 'today' }),
        work,
      ),
    );
    const chart = required(view.sections[0]?.charts[0]),
      surface = host();
    const handle = new TanStackStatisticsChart().mount(surface, chart, vi.fn());
    mounts.push(handle);
    const dimensions = required(surface.querySelector('svg')?.getAttribute('viewBox')).split(' ');
    expect(Number(dimensions[3])).toBeLessThanOrEqual(489);
    expect(chart.layout).toBe(count === 16 ? undefined : 'density');
  }
});

it.each([1, 17].flatMap((count) => [320, 1360].map((width) => ({ count, width }))))(
  'retains configured Timeline day order at $width pixels with $count Friday recordings',
  async ({ count, width }) => {
    const dataset = required(
      await prepareStatisticsDataset(
        source(
          Array.from({ length: count }, (_, i) =>
            task(`Friday${i}`, {
              timeEntries: [closed('2026-10-09T09:00Z', '2026-10-09T09:40Z')],
            }),
          ),
        ),
        [],
        work,
      ),
    );
    const view = required(
      await new StatisticsSession(dataset).view(
        request({
          view: 'timeline',
          period: 'today',
          nowMs: Date.parse('2026-10-09T13:10:09.249Z'),
        }),
        work,
      ),
    );
    const chart = required(view.sections[0]?.charts[0]),
      element = host(document, width);
    const rendered = mount(element, chart);
    const labels = [...element.querySelectorAll('svg text')].map((text) => text.textContent);
    const expected = [
      'Mon 5 · Outside',
      'Tue 6 · Outside',
      'Wed 7 · Outside',
      'Thu 8 · Outside',
      `Fri 9 · ${count * 40} min`,
      'Sat 10 · Future',
      'Sun 11 · Future',
    ];
    for (const day of expected) expect(labels).toContain(day);
    expect(n(required(element.querySelector('clipPath rect')), 'width')).toBeGreaterThanOrEqual(
      180,
    );
    expect(chart.y.tickLabels).toContainEqual(['2026-10-09', `2026-10-09 · ${count * 40} min`]);
    expect(chart.marks[0]?.observation?.title).toContain('2026-10-09');
    expect(chart.layout).toBe(count === 1 ? undefined : 'density');
    expect(marks(element).length).toBeGreaterThan(0);
    expect(rendered.svg().getAttribute('viewBox')).toContain(String(width));
    const positions = expected.map((label) => {
      const text = required(
        [...element.querySelectorAll('svg text')].find((text) => text.textContent === label),
      );
      return Number(text.getAttribute('y'));
    });
    for (let i = 1; i < positions.length; i++)
      expect(required(positions[i])).toBeGreaterThan(required(positions[i - 1]));
  },
);

it.each([320, 1360])(
  'windows 10,000 ranking rows at %i pixels with exact 32px native geometry and stable domain',
  async (width) => {
    const values = Array.from({ length: 10000 }, (_, i) => ({
      key: `group:${i}`,
      x: 10000 - i,
      x2: 0,
      y: `group:${i}`,
      selectionId: `opaque:${i}`,
      label: i === 0 ? 'Common tag with a much longer label than later groups' : `Group ${i}`,
    }));
    const ranking = model({
      id: 'allocation-ranking:project',
      rowViewport: true,
      layout: undefined,
      series: [],
      x: { type: 'number', label: 'Recorded minutes', domain: [0, 10000], unit: 'minutes' },
      y: {
        type: 'band',
        label: '',
        categories: values.map((m) => m.key),
        tickLabels: values.map((m) => [m.key, m.label]),
      },
      marks: values,
    });
    const element = host(document, width),
      selected = vi.fn();
    const engine = new TanStackStatisticsChart();
    const renderer = {
      mount: (surface: HTMLElement, value: StatisticsChartModel, select: (id: string) => void) => {
        // JSDOM does not lay out the absolute row window; supply its real native-width contract.
        Object.defineProperty(surface, 'clientWidth', { configurable: true, value: width });
        return engine.mount(surface, value, select);
      },
    };
    const charts = new StatisticsCharts(element, renderer, selected);
    mounts.push(charts);
    charts.update([ranking]);
    const scroller = required(element.querySelector<HTMLElement>('.abyss-statistics-row-viewport'));
    expect(marks(element).length).toBeLessThan(40);
    expect(required(element.querySelector('svg')).getAttribute('viewBox')?.split(' ')[2]).toBe(
      String(width),
    );
    const rects = marks(element);
    expect(n(required(rects[0]), 'x')).toBe(160);
    expect(n(required(rects[0]), 'width')).toBe(width - 224);
    expect(element.querySelectorAll('.abyss-statistics-row-button').length).toBeLessThan(40);
    expect(n(required(rects[1]), 'y') - n(required(rects[0]), 'y')).toBeCloseTo(32, 2);
    scroller.scrollTop = 319712;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => {
        resolve();
      }),
    );
    expect(marks(element).length).toBeLessThan(40);
    expect(element.textContent).toContain('Group 9999');
    expect(element.textContent).not.toContain('Group 0');
    expect(
      required(element.querySelector('.abyss-statistics-row-content')).getAttribute('style'),
    ).toContain('319');
    const last = required(marks(element)[marks(element).length - 1]);
    expect(n(last, 'x')).toBe(160);
    expect(element.querySelectorAll('.abyss-statistics-row-button').length).toBeLessThan(40);
    expect(
      n(last, 'y') +
        Number(
          element
            .querySelector<HTMLElement>('.abyss-statistics-row-content')
            ?.style.getPropertyValue('--abyss-statistics-row-offset')
            .slice(0, -2),
        ),
    ).toBeCloseTo(319972, 1);
    expect(n(last, 'width')).toBeCloseTo((width - 224) / 10000, 2);
    const current = required(capture.options[capture.options.length - 1]?.onSelect);
    current({ datum: required(values[9999]) });
    expect(selected).toHaveBeenLastCalledWith('opaque:9999');
    charts.update([
      {
        ...ranking,
        marks: values.slice(0, 1),
        y: {
          type: 'band',
          label: '',
          categories: ['group:0'],
          tickLabels: [['group:0', 'Group 0']],
        },
      },
    ]);
    expect(scroller.scrollTop).toBe(0);
    expect(element.textContent).toContain('Group 0');
  },
);

it('restores the ranking position through atomic group focus and source shrink', () => {
  resetStatisticsScrollAtCommit();
  const positions = new Map<string, number>(),
    element = host(),
    select = vi.fn();
  let broken = false;
  const real = new TanStackStatisticsChart();
  const renderer = {
    mount: (host: HTMLElement, value: StatisticsChartModel, select: (id: string) => void) => {
      if (broken && value.rowViewport === true && value.marks.length === 1)
        throw new Error('staging failed');
      return real.mount(host, value, select);
    },
  };
  const sections = new StatisticsSections(element, renderer, select, { positions });
  mounts.push(sections);
  const ranking = model({
    id: 'allocation-ranking:project',
    rowViewport: true,
    layout: undefined,
    series: [],
    x: { type: 'number', label: 'Recorded minutes', domain: [0, 100] },
    y: { type: 'band', label: '', categories: Array.from({ length: 100 }, (_, i) => `G${i}`) },
    marks: Array.from({ length: 100 }, (_, i) => ({
      key: `G${i}`,
      x: 100 - i,
      x2: 0,
      y: `G${i}`,
      selectionId: `G${i}`,
    })),
  });
  const view = {
    view: 'allocation' as const,
    title: 'Allocation',
    dateLabel: 'Today',
    currentState: false,
    asOfMs: 0,
    coverage: {
      source: { ready: true, sourceIssues: [], revision: 1, files: 0, archiveFiles: 0 },
      scope: { tasks: 0 },
    },
    actions: [],
    chartActions: [],
    evidence: () => ({ total: 0, rows: [] }),
    sections: [
      {
        id: 'allocation',
        title: 'Allocation',
        context: '',
        metrics: [],
        legend: [],
        charts: [ranking],
      },
    ],
  } as unknown as StatisticsViewModel;
  sections.update(view);
  required(element.querySelector<HTMLElement>('.abyss-statistics-row-viewport')).scrollTop = 2016;
  sections.update({
    ...view,
    sections: [{ ...required(view.sections[0]), charts: [model({ id: 'allocation-focus' })] }],
  });
  sections.update(view);
  expect(
    required(element.querySelector<HTMLElement>('.abyss-statistics-row-viewport')).scrollTop,
  ).toBe(2016);
  const small = {
    ...ranking,
    y: { type: 'band' as const, label: '', categories: ['G0'] },
    marks: ranking.marks.slice(0, 1),
  };
  broken = true;
  expect(() => {
    sections.update({ ...view, sections: [{ ...required(view.sections[0]), charts: [small] }] });
  }).toThrow('staging failed');
  expect(positions.get('allocation-ranking:project')).toBe(2016);
  expect(
    required(element.querySelector<HTMLElement>('.abyss-statistics-row-viewport')).scrollTop,
  ).toBe(2016);
  broken = false;
  sections.update({ ...view, sections: [{ ...required(view.sections[0]), charts: [small] }] });
  expect(
    required(element.querySelector<HTMLElement>('.abyss-statistics-row-viewport')).scrollTop,
  ).toBe(0);
  expect(positions.get('allocation-ranking:project')).toBe(0);
});
it('opens zero and subpixel ranking rows through native label/value targets and retires old targets', () => {
  const element = host(),
    selected = vi.fn();
  const ranking = model({
    id: 'allocation-ranking:tag',
    rowViewport: true,
    layout: undefined,
    series: [],
    x: { type: 'number', label: 'Recorded minutes', domain: [0, 100000] },
    y: {
      type: 'band',
      label: '',
      categories: ['tiny', 'zero'],
      tickLabels: [
        ['tiny', '#tiny'],
        ['zero', '#zero'],
      ],
    },
    marks: [
      { key: 'tiny', x: 10, x2: 0, y: 'tiny', selectionId: 'focus:tiny' },
      { key: 'zero', x: 0, x2: 0, y: 'zero', selectionId: 'focus:zero' },
    ],
  });
  const charts = new StatisticsCharts(element, new TanStackStatisticsChart(), selected);
  mounts.push(charts);
  charts.update([ranking]);
  const buttons = [...element.querySelectorAll<HTMLButtonElement>('.abyss-statistics-row-button')];
  expect(buttons).toHaveLength(2);
  const tiny = required(buttons[0]),
    zero = required(buttons[1]);
  expect(tiny.type).toBe('button');
  expect(tiny.textContent).toBe('#tiny10 min');
  required(tiny.querySelector<HTMLElement>('.abyss-statistics-row-label')).click();
  expect(selected.mock.calls).toEqual([['focus:tiny']]);
  required(zero.querySelector<HTMLElement>('.abyss-statistics-row-value')).click();
  expect(selected.mock.calls).toEqual([['focus:tiny'], ['focus:zero']]);
  tiny.focus();
  charts.update([ranking]);
  expect(document.activeElement?.textContent).toBe('#tiny10 min');
  tiny.click();
  expect(selected).toHaveBeenCalledTimes(2);
  const other = element.createEl('button', { text: 'Other owner' });
  other.dataset['rowSelection'] = 'focus:tiny';
  other.focus();
  charts.update([ranking]);
  expect(document.activeElement).toBe(other);
  element.inert = true;
  element.setAttribute('inert', '');
  required(element.querySelector<HTMLButtonElement>('.abyss-statistics-row-button')).click();
  expect(selected).toHaveBeenCalledTimes(2);
  charts.destroy();
  zero.click();
  expect(selected).toHaveBeenCalledTimes(2);
});
it('latches deferred row-render failures until explicit retry and retires pending work on destruction', async () => {
  const { StatisticsRowChart } = await import('../src/panels/statistics/StatisticsRowChart');
  const error = new Error('row update failed'),
    failure = vi.fn();
  const real = new TanStackStatisticsChart();
  let broken = true;
  const renderer = {
    mount: (element: HTMLElement, value: StatisticsChartModel, select: (id: string) => void) => {
      const handle = real.mount(element, value, select);
      return {
        destroy: () => {
          handle.destroy();
        },
        update: (value: StatisticsChartModel) => {
          if (broken) throw error;
          handle.update(value);
        },
      };
    },
  };
  const ranking = model({
    id: 'allocation-ranking:tag',
    rowViewport: true,
    layout: undefined,
    series: [],
    x: { type: 'number', label: 'Recorded minutes', domain: [0, 100] },
    y: { type: 'band', label: '', categories: Array.from({ length: 100 }, (_, i) => `G${i}`) },
    marks: Array.from({ length: 100 }, (_, i) => ({
      key: `G${i}`,
      x: 100 - i,
      x2: 0,
      y: `G${i}`,
      selectionId: `G${i}`,
    })),
  });
  const element = host(),
    row = new StatisticsRowChart(element, renderer, ranking, {
      onSelect: vi.fn(),
      positions: new Map(),
      onFailure: failure,
    });
  mounts.push(row);
  const scroll = required(element.querySelector<HTMLElement>('.abyss-statistics-row-viewport'));
  const frame = async () =>
    new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => {
        resolve();
      }),
    );
  scroll.scrollTop = 1600;
  scroll.dispatchEvent(new Event('scroll'));
  await frame();
  expect(failure).toHaveBeenCalledExactlyOnceWith(error);
  scroll.dispatchEvent(new Event('scroll'));
  await frame();
  expect(failure).toHaveBeenCalledTimes(1);
  broken = false;
  row.update(ranking);
  expect(element.textContent).toContain('G50');
  scroll.dispatchEvent(new Event('scroll'));
  row.destroy();
  await frame();
  expect(failure).toHaveBeenCalledTimes(1);
  expect(element.querySelector('svg')).toBeNull();
});

it('keeps zero-time Allocation concentration in the reserved plot with an honest empty message', async () => {
  const dataset = required(await prepareStatisticsDataset(source([task('zero')]), [], work));
  const view = required(
    await new StatisticsSession(dataset).view(request({ view: 'allocation' }), work),
  );
  const element = host(),
    sections = new StatisticsSections(element, new TanStackStatisticsChart(), vi.fn());
  mounts.push(sections);
  sections.update(view);
  const plot = required(element.querySelector('.abyss-statistics-allocation-empty-plot'));
  expect(plot.textContent).toBe('No recorded time in this period');
  expect(plot.closest('section')?.textContent).toContain('Tasks and subtasks');
  expect(plot.querySelector('svg')).toBeNull();
  const focused = required(
    await new StatisticsSession(dataset).view(
      request({ view: 'allocation', focusKey: 'unassigned' }),
      work,
    ),
  );
  sections.update(focused);
  expect(element.querySelectorAll('.abyss-statistics-allocation-empty-plot')).toHaveLength(1);
});
