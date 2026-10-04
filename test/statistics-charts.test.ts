import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatisticsCharts } from '../src/panels/statistics/StatisticsCharts';
import { TanStackStatisticsChart } from '../src/panels/statistics/TanStackStatisticsChart';
import type { StatisticsChartModel } from '../src/statistics';
import { contracts } from '../tooling/css-contracts.mjs';

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

describe('Statistics chart adapter', () => {
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
    expect(chart.svg().getAttribute('aria-label')).toBe('Recorded events');
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
  it('exposes numerator, denominator and fractional mean inside local tooltips', () => {
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
    const tooltip = element.querySelector<HTMLElement>('.abyss-statistics-tooltip');
    expect(tooltip?.textContent).toContain('0.00025');
    expect(tooltip?.textContent).toContain('0.0005 / 2');
    expect(tooltip?.textContent).toContain('0.0005 recorded minutes / 2 elapsed exposure hours');
    expect(tooltip?.textContent).toContain('mean 0.00025 minutes per hour');
    expect(element.contains(tooltip)).toBe(true);
    const inputs = contracts.runtime.consumed.filter((name) =>
      name.startsWith('--ts-chart-tooltip-'),
    );
    expect(inputs).toHaveLength(8);
    for (const variable of inputs)
      expect(tooltip?.getAttribute('style')).toContain(`var(${variable},`);
    expect(tooltip?.style.background).toContain('var(--ts-chart-tooltip-background,');
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
