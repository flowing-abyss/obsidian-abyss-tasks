import { arrow } from '@tanstack/charts/arrow';
import { barY } from '@tanstack/charts/bar';
import { mountChart } from '@tanstack/charts/dom';
import { dot } from '@tanstack/charts/dot';
import { lineY } from '@tanstack/charts/line';
import { decorative } from '@tanstack/charts/mark/decorative';
import { cell, rect } from '@tanstack/charts/rect';
import { ruleX, ruleY } from '@tanstack/charts/rule';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { defineChart } from '@tanstack/charts/scene';
import { text } from '@tanstack/charts/text';
import { tooltip } from '@tanstack/charts/tooltip';
import { portal } from '@tanstack/charts/tooltip/portal';
import type {
  ChartMark,
  ChartPositionScaleOptions,
  ChartTooltipInput,
} from '@tanstack/charts/types';
import type { StatisticsAxis, StatisticsChartModel, StatisticsMark } from '../../statistics';
import type { StatisticsChartHandle, StatisticsChartRenderer } from './StatisticsChart';
import {
  statisticsIntensityPaint,
  statisticsMarkContent,
  statisticsNumber,
  statisticsSeriesOpacity,
  statisticsSeriesPaint,
} from './statisticsFormat';

type Value = number | string;
type HostOptions = Parameters<typeof mountChart<StatisticsMark, Value, Value>>[1];
type RenderMark = ChartMark<StatisticsMark, Value, Value>;
const FOREGROUND = 'var(--text-normal)';
const MUTED = 'var(--text-muted)';
const BACKGROUND = 'var(--background-primary)';
const ACCENT = 'var(--interactive-accent)';
const SCATTER_MARGIN = { top: 16, right: 16, bottom: 42, left: 76 };
const NETWORK_MARGIN = { top: 35, left: 55, right: 55, bottom: 20 };
const TIMELINE_MARGIN = { top: 12, left: 116, right: 12, bottom: 40 };
const CHART_MARGINS: Partial<Record<StatisticsChartModel['kind'], typeof TIMELINE_MARGIN>> = {
  scatter: SCATTER_MARGIN,
  network: NETWORK_MARGIN,
  timeline: TIMELINE_MARGIN,
};

function chartMargin(model: StatisticsChartModel): { margin?: typeof TIMELINE_MARGIN } {
  const margin =
    model.rowViewport === true
      ? { top: 0, bottom: 0, left: 160, right: 64 }
      : CHART_MARGINS[model.kind];
  return margin === undefined ? {} : { margin };
}

function height(model: StatisticsChartModel): number {
  if (model.rowViewport === true && model.y.type === 'band') return model.y.categories.length * 32;
  if (model.id === 'allocation-focus') return 288;
  if (model.id === 'completion-origins') return 384;
  return baseHeight(model);
}
function baseHeight(model: StatisticsChartModel): number {
  if (model.y.type === 'number') return numericHeight(model, model.y.domain[1]);
  if (model.kind === 'bars' && model.x.type === 'number')
    return model.y.categories.length * 28 + 48;
  if (model.kind === 'heatmap' || model.kind === 'timeline')
    return Math.max(150, model.y.categories.length * (model.kind === 'timeline' ? 36 : 26) + 48);
  return model.facet === undefined ? 250 : 205;
}
function numericHeight(model: StatisticsChartModel, max: number): number {
  if (model.kind === 'network') return Math.min(640, Math.max(180, max * 40 + 60));
  if (model.kind === 'timeline') return max * 14 + 48;
  return model.facet === undefined ? 250 : 205;
}
function measuredWidth(host: HTMLElement): number {
  const width = host.clientWidth > 0 ? host.clientWidth : host.getBoundingClientRect().width;
  return width > 0 ? width : 320;
}
function number(mark: StatisticsMark, channel: 'x' | 'y'): number {
  const value = mark[channel];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Statistics ${channel} coordinate must be finite`);
  return value;
}
function bandPadding(model: StatisticsChartModel): number {
  if (model.kind === 'bars') return 0.18;
  return model.kind === 'timeline' ? 0.12 : 0;
}
function positionScale(
  model: StatisticsChartModel,
  side: 'x' | 'y',
): ChartPositionScaleOptions<Value>['scale'] {
  const value = model[side];
  if (value.type === 'band') {
    const scale = scaleBand<string>().domain(value.categories);
    return model.rowViewport === true
      ? scale.paddingInner(0.25).paddingOuter(0.125)
      : scale.padding(bandPadding(model));
  }
  if (model.kind === 'heatmap')
    return scaleBand<number>().domain([...new Set(model.marks.map((mark) => number(mark, side)))]);
  return scaleLinear().domain([...value.domain]);
}
function tickCandidates(value: StatisticsAxis, width: number): number[] | undefined {
  if (value.type !== 'number') return undefined;
  const step = Math.max(1, Math.ceil((value.domain[1] - value.domain[0]) / 4));
  const counts =
    value.unit === 'count'
      ? Array.from(
          { length: Math.floor((value.domain[1] - Math.ceil(value.domain[0])) / step) + 1 },
          (_, i) => Math.ceil(value.domain[0]) + i * step,
        )
      : undefined;
  const candidates = value.ticks ?? value.tickLabels?.map(([position]) => position) ?? counts;
  if (candidates === undefined) return undefined;
  const stride = Math.max(1, Math.ceil(candidates.length / Math.max(2, Math.floor(width / 105))));
  return candidates.filter((_, index) => index % stride === 0 || index === candidates.length - 1);
}
function shortLabel(label: string, length: number): string {
  return label.length > length
    ? `${label.slice(0, Math.ceil((length - 1) / 2))}…${label.slice(-Math.floor((length - 1) / 2))}`
    : label;
}
function tickLabelLength(value: StatisticsAxis, side: 'x' | 'y', width: number): number {
  const slots = value.type === 'band' && side === 'x' ? value.categories.length : 2;
  return Math.max(4, Math.min(24, Math.floor(width / slots / 9)));
}
function axisPolicy(
  value: StatisticsAxis,
  width: number,
  side: 'x' | 'y',
): Exclude<ChartPositionScaleOptions<Value>['axis'], false | undefined> {
  const labels = new Map<string | number, string>(value.tickLabels ?? []);
  const candidates = tickCandidates(value, width);
  const count = side === 'x' ? Math.max(2, Math.floor(width / 105)) : 4;
  const unit =
    value.type === 'number'
      ? ({ count: '', days: ' d', minutes: ' min' }[value.unit ?? ''] ?? value.unit)
      : '';
  return {
    line: false,
    ...(value.label === '' ? {} : { label: { text: value.label, fontSize: 11, fill: MUTED } }),
    ticks: {
      size: 0,
      ...(candidates === undefined ? { count } : { values: candidates }),
      format: (tick) => {
        const label =
          labels.get(tick) ?? (typeof tick === 'number' ? statisticsNumber(tick, unit) : tick);
        return value.type === 'band' && label.length > 24
          ? shortLabel(label, tickLabelLength(value, side, width))
          : label;
      },
    },
    tickLabels: { fontSize: 11, opacity: 1, thin: { minGap: 9, priority: 'ends' } },
  };
}
function timelineDayLabel(label: string): string {
  const date = new Date(`${label.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return label;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()],
    detail = label.slice(13);
  let status = detail;
  if (detail === 'Outside period') status = 'Outside';
  else if (detail === 'Not yet elapsed') status = 'Future';
  else if (detail.endsWith(' min')) status = statisticsNumber(Number(detail.slice(0, -4)), ' min');
  return `${weekday ?? ''} ${date.getUTCDate()} · ${status}`;
}
function timelineDayAxis(
  value: StatisticsAxis,
): Exclude<ChartPositionScaleOptions<Value>['axis'], false | undefined> {
  const labels = new Map<string | number, string>(value.tickLabels ?? []),
    positions =
      value.type === 'band'
        ? value.categories
        : (value.tickLabels?.map(([position]) => position) ?? []);
  return {
    line: false,
    ticks: {
      size: 0,
      values: positions,
      format: (tick) => timelineDayLabel(labels.get(tick) ?? String(tick)),
    },
    tickLabels: { fontSize: 11, opacity: 1, thin: false },
  };
}
function reverseY(model: StatisticsChartModel): boolean {
  return model.kind === 'network' || (model.kind === 'timeline' && model.y.type === 'number');
}
function hiddenAxis(model: StatisticsChartModel): boolean {
  return model.kind === 'network' || model.rowViewport === true;
}
function axis(
  model: StatisticsChartModel,
  side: 'x' | 'y',
  width: number,
): ChartPositionScaleOptions<Value> {
  const hidden = model.kind === 'network',
    policy =
      model.kind === 'timeline' && side === 'y'
        ? timelineDayAxis(model.y)
        : axisPolicy(model[side], width, side);
  const grid = !hidden && model[side].type === 'number' && model.kind !== 'heatmap' && side === 'y';
  return {
    scale: positionScale(model, side),
    reverse: reverseY(model) && side === 'y',
    grid: grid ? { stroke: 'var(--background-modifier-border)', strokeOpacity: 0.55 } : false,
    axis: hiddenAxis(model) ? false : policy,
  };
}
function seriesMarks(model: StatisticsChartModel): RenderMark[] {
  const result: RenderMark[] = [];
  const series = [...model.series];
  if (model.marks.some((mark) => mark.series === undefined))
    series.push({ key: '', label: '', tone: 'accent' });
  for (const item of series) {
    const rows = model.marks.filter((mark) => (mark.series ?? '') === item.key);
    if (rows.length === 0) continue;
    result.push(seriesMark(model, item, rows));
  }
  return result;
}
function seriesMark(
  model: StatisticsChartModel,
  item: StatisticsChartModel['series'][number],
  rows: readonly StatisticsMark[],
): RenderMark {
  const paint = statisticsSeriesPaint(item, model.series),
    opacity = statisticsSeriesOpacity(item);
  if (model.kind === 'bars' && model.x.type === 'number' && model.y.type === 'band')
    return rect(rows, {
      id: `bars:${item.key}`,
      x1: (mark) => number(mark, 'x'),
      x2: (mark) => mark.x2 ?? number(mark, 'x'),
      y: 'y',
      key: 'key',
      fill: paint,
      fillOpacity: opacity,
      inset: 0,
    });
  if (model.kind === 'bars')
    return barY(rows, {
      id: `bars:${item.key}`,
      x: 'x',
      y1: (mark) => mark.y2 ?? 0,
      y2: (mark) => number(mark, 'y'),
      key: 'key',
      fill: paint,
      fillOpacity: opacity,
      inset: 0,
      stroke: (mark) => (mark.selected === true ? FOREGROUND : 'none'),
      strokeWidth: 1.5,
      maxThickness: 42,
    });
  if (model.kind === 'lines')
    return lineY(rows, {
      id: `lines:${item.key}`,
      x: 'x',
      y: (mark) => number(mark, 'y'),
      key: 'key',
      stroke: paint,
      strokeOpacity: opacity,
      strokeWidth: 2,
      points: true,
    });
  const radius =
    model.kind === 'network'
      ? (mark: StatisticsMark) => (model.marks.length > 16 && mark.series !== 'focus' ? 3 : 7)
      : (mark: StatisticsMark) => Math.min(10, 4 + Math.log2(Math.max(1, mark.weight ?? 1)));
  return dot(rows, {
    id: `points:${item.key}`,
    x: 'x',
    y: 'y',
    key: 'key',
    fill: paint,
    fillOpacity: opacity,
    r: radius,
    stroke: BACKGROUND,
    strokeWidth: 1.5,
  });
}
function heatBucket(mark: StatisticsMark, maximum: number): string {
  if (mark.state !== undefined && mark.state !== 'measured') return mark.state;
  const fraction = maximum > 0 ? (mark.weight ?? 0) / maximum : 0;
  if (fraction === 0) return 'zero';
  if (fraction < 0.34) return 'low';
  return fraction < 0.67 ? 'medium' : 'high';
}
function heatMarks(model: StatisticsChartModel): RenderMark[] {
  const maximum =
    model.intensityScale?.domain[1] ?? Math.max(0, ...model.marks.map((mark) => mark.weight ?? 0));
  const buckets = ['unknown', 'immature', 'unavailable', 'zero', 'low', 'medium', 'high'] as const;
  const result: RenderMark[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const rows = model.marks.filter((mark) => heatBucket(mark, maximum) === buckets[i]);
    if (rows.length > 0)
      result.push(
        cell(rows, {
          id: `cells:${buckets[i]}`,
          x: 'x',
          y: 'y',
          key: 'key',
          fill: statisticsIntensityPaint(buckets[i] ?? 'high'),
          stroke: 'var(--background-modifier-border)',
          strokeWidth: 0.6,
          inset: 1,
          radius: 2,
        }),
      );
  }
  // Patterns are already dense at 24 columns; only smaller matrices carry direct values.
  if (new Set(model.marks.map((mark) => mark.x)).size <= 8)
    result.push(
      decorative(
        text(model.marks, {
          id: 'cell-labels',
          x: 'x',
          y: 'y',
          key: 'key',
          anchor: 'middle',
          fontSize: 11,
          fill: FOREGROUND,
          text: (mark) =>
            mark.displayText ??
            (mark.state !== undefined && mark.state !== 'measured'
              ? '—'
              : statisticsNumber(mark.weight ?? 0)),
        }),
      ),
    );
  return result;
}
function timelineRows(model: StatisticsChartModel): StatisticsMark[] {
  return model.marks.flatMap((mark) =>
    mark.clockRanges === undefined
      ? [mark]
      : mark.clockRanges.map((range, index) => ({
          ...mark,
          key: `${mark.key}:clock:${index}`,
          x: range.localStartMinutes,
          x2: range.localEndMinutes,
        })),
  );
}
/** Pack bounded clock intervals so simultaneous records remain separate selectable marks. */
function timelineLayout(model: StatisticsChartModel): StatisticsChartModel {
  if (model.kind !== 'timeline' || model.layout === 'density') return model;
  const rows = timelineRows(model);
  if (model.y.type !== 'band') return { ...model, marks: rows };
  const marks: StatisticsMark[] = [],
    ticks: Array<readonly [number, string]> = [];
  const labels = new Map(model.y.tickLabels);
  let base = 0;
  for (const day of model.y.categories) {
    const ends: number[] = [];
    const values = rows
      .filter((mark) => mark.y === day)
      .sort((a, b) => number(a, 'x') - number(b, 'x'));
    for (const mark of values) {
      let slot = ends.findIndex((end) => end <= number(mark, 'x'));
      if (slot < 0) slot = ends.length;
      ends[slot] = mark.x2 ?? number(mark, 'x');
      marks.push({ ...mark, y: base + slot + 0.1, y2: base + slot + 0.9 });
    }
    const lanes = Math.max(2, ends.length);
    ticks.push([base + lanes / 2, labels.get(day) ?? day]);
    base += lanes + 0.5;
  }
  return {
    ...model,
    marks,
    y: { type: 'number', label: model.y.label, domain: [0, base], tickLabels: ticks },
  };
}
function timelineMarks(model: StatisticsChartModel): RenderMark[] {
  if (model.layout === 'density') return densityMarks(model);
  const rows = model.marks;
  const series = [...model.series];
  if (rows.some((mark) => mark.series === undefined))
    series.push({ key: '', label: '', tone: 'accent' });
  return series.flatMap((item) => {
    const values = rows.filter((mark) => (mark.series ?? '') === item.key);
    return values.length === 0
      ? []
      : [
          rect(values, {
            id: `intervals:${item.key}`,
            x1: 'x',
            x2: 'x2',
            x: (mark) => (number(mark, 'x') + (mark.x2 ?? number(mark, 'x'))) / 2,
            y1: 'y',
            y2: 'y2',
            y: (mark) => (number(mark, 'y') + (mark.y2 ?? number(mark, 'y'))) / 2,
            key: 'key',
            fill: statisticsSeriesPaint(item, model.series),
            fillOpacity: 0.8,
            radius: 2,
            inset: 0,
          }),
        ];
  });
}
function densityMarks(model: StatisticsChartModel): RenderMark[] {
  const rows = model.kind === 'timeline' ? timelineRows(model) : model.marks;
  const maximum =
    model.intensityScale?.domain[1] ?? Math.max(0, ...rows.map((mark) => mark.weight ?? 0));
  const paints = ['zero', 'low', 'medium', 'high'] as const;
  const series =
    model.kind === 'scatter' && rows.some((mark) => mark.series !== undefined)
      ? model.series
      : [undefined];
  return series.flatMap((item) =>
    paints.flatMap((bucket) => {
      const values = rows.filter(
        (mark) =>
          heatBucket(mark, maximum) === bucket && (item === undefined || mark.series === item.key),
      );
      return values.length === 0
        ? []
        : [
            rect(values, {
              id: `density:${item?.key ?? ''}:${bucket}`,
              x1: 'x',
              x2: 'x2',
              x: (mark) => (number(mark, 'x') + (mark.x2 ?? number(mark, 'x'))) / 2,
              ...(model.kind === 'timeline'
                ? { y: 'y' as const }
                : { y1: 'y' as const, y2: 'y2' as const }),
              key: 'key',
              fill: statisticsIntensityPaint(bucket),
              stroke: item === undefined ? 'none' : statisticsSeriesPaint(item, model.series),
              strokeWidth: item === undefined ? 0 : 1.5,
              radius: 2,
              inset: 0,
            }),
          ];
    }),
  );
}
function networkMarks(model: StatisticsChartModel, width: number, height: number): RenderMark[] {
  const nodes = new Map(model.marks.map((mark) => [mark.key, mark]));
  const edges: StatisticsMark[] = [];
  // Each label points into the viewport from its node. Budget one em per character,
  // including the ellipsis, within that viewport half at constrained widths.
  const labelLength = Math.max(1, Math.min(24, Math.floor((width / 2 - 4) / 11)));
  for (const [index, edge] of (model.edges ?? []).entries()) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const end = arrowEnd(from, to, model, { width, height });
    edges.push({
      key: `edge:${index}`,
      x: from.x,
      y: from.y,
      x2: end.x,
      y2: end.y,
      selectionId: edge.selectionId,
      label: `${from.label ?? from.key} → ${to.label ?? to.key}`,
    });
  }
  return [
    arrow(edges, {
      id: 'dependency-arrows',
      x1: 'x',
      y1: 'y',
      x2: 'x2',
      y2: 'y2',
      key: 'key',
      stroke: MUTED,
      strokeWidth: 1.5,
      headLength: 10,
    }),
    ...seriesMarks(model),
    decorative(
      text(
        model.marks.filter((mark) => model.marks.length <= 16 || mark.series === 'focus'),
        {
          id: 'node-labels',
          x: 'x',
          y: 'y',
          key: 'key',
          text: (mark) => shortLabel(mark.label ?? '', labelLength),
          anchor: (mark) =>
            model.x.type === 'number' &&
            number(mark, 'x') > (model.x.domain[0] + model.x.domain[1]) / 2
              ? 'end'
              : 'start',
          dy: -16,
          fontSize: 11,
          fill: FOREGROUND,
        },
      ),
    ),
  ];
}
function arrowEnd(
  from: StatisticsMark,
  to: StatisticsMark,
  model: StatisticsChartModel,
  size: { width: number; height: number },
): { x: number; y: number } {
  if (model.x.type !== 'number' || model.y.type !== 'number')
    throw new Error('Statistics network requires numeric axes');
  const dx = number(to, 'x') - number(from, 'x'),
    dy = number(to, 'y') - number(from, 'y');
  const length = Math.hypot(
    (dx * (size.width - NETWORK_MARGIN.left - NETWORK_MARGIN.right)) /
      (model.x.domain[1] - model.x.domain[0]),
    (dy * (size.height - NETWORK_MARGIN.top - NETWORK_MARGIN.bottom)) /
      (model.y.domain[1] - model.y.domain[0]),
  );
  // Keep the arrowhead outside the seven-pixel node and its stroke. This is display geometry;
  // source endpoints/topology and edge evidence remain unchanged.
  const inset = length > 0 ? Math.min(0.4, 8 / length) : 0;
  return { x: number(to, 'x') - dx * inset, y: number(to, 'y') - dy * inset };
}
function marks(model: StatisticsChartModel, width: number, height: number): RenderMark[] {
  let result: RenderMark[];
  if (model.kind === 'heatmap') result = heatMarks(model);
  else if (model.kind === 'timeline') result = timelineMarks(model);
  else if (model.kind === 'network') result = networkMarks(model, width, height);
  else if (model.kind === 'scatter' && model.layout === 'density') result = densityMarks(model);
  else result = seriesMarks(model);
  if (model.layout === 'diverging')
    result.push(decorative(ruleY([0], { id: 'zero', stroke: MUTED, strokeWidth: 1 })));
  for (const [index, guide] of (model.guides ?? []).entries())
    result.push(
      decorative(
        guide.axis === 'x'
          ? ruleX([guide.value], { id: `guide:${index}`, stroke: MUTED, strokeDasharray: '3 3' })
          : ruleY([guide.value], { id: `guide:${index}`, stroke: MUTED, strokeDasharray: '3 3' }),
      ),
      guideLabel(model, guide, index),
    );
  return result;
}
function guideLabel(
  model: StatisticsChartModel,
  guide: NonNullable<StatisticsChartModel['guides']>[number],
  index: number,
): RenderMark {
  const leading = (value: StatisticsAxis): Value =>
    value.type === 'band' ? (value.categories[0] ?? '') : value.domain[0];
  const trailing = (value: StatisticsAxis): Value =>
    value.type === 'band' ? (value.categories[0] ?? '') : value.domain[1];
  return decorative(
    text<StatisticsMark, 'x', 'y'>(
      [
        {
          key: `guide-label:${index}`,
          x: guide.axis === 'x' ? guide.value : leading(model.x),
          y: guide.axis === 'y' ? guide.value : trailing(model.y),
          label: guide.label,
        },
      ],
      {
        id: `guide-label:${index}`,
        x: 'x',
        y: 'y',
        key: 'key',
        text: 'label',
        fill: MUTED,
        fontSize: 11,
        anchor: 'start',
        dx: 4,
        dy: guide.axis === 'x' && model.y.type === 'number' ? 12 : -4,
      },
    ),
  );
}
function acquireChart(
  host: HTMLElement,
  options: HostOptions,
  onFailure: () => void,
): ReturnType<typeof mountChart<StatisticsMark, Value, Value>> {
  const emptyMarks: RenderMark[] = [];
  // Acquire a disposable host before rendering user-derived coordinates: the pinned host
  // registers listeners before its first render and cannot return a handle when that throws.
  const chart = mountChart(host, {
    ...options,
    definition: defineChart({
      marks: emptyMarks,
      scales: {
        x: { scale: scaleLinear().domain([0, 1]), axis: false },
        y: { scale: scaleLinear().domain([0, 1]), axis: false },
      },
      focus: false,
      svgAnimation: false,
    }),
  });
  try {
    chart.update(options);
  } catch (error) {
    onFailure();
    chart.destroy();
    throw error;
  }
  return chart;
}

function tooltipRow(row: { label: string; value: string }): { label: string; value: string } {
  // The pinned engine wraps labels, but keeps values on one line. Prose and clock
  // ranges remain complete in its flexible label column, without cascade overrides.
  if (row.label === 'Reading' || row.label === 'Clock range' || row.value.length > 24)
    return { label: `${row.label}: ${row.value}`, value: '' };
  return row;
}

function tooltipOptions(
  model: StatisticsChartModel,
): ChartTooltipInput<StatisticsMark, Value, Value, 'dom'> {
  return {
    use: tooltip,
    className: 'abyss-statistics-tooltip',
    motion: false,
    portal,
    placement: ['top', 'right', 'left', 'bottom'],
    content: (points) => {
      const point = points[0];
      if (point === undefined) return { rows: [] };
      const content = statisticsMarkContent(point.datum, model);
      return { ...content, rows: content.rows.map(tooltipRow) };
    },
  };
}

function chartDescription(model: StatisticsChartModel): string {
  return model.rowViewport === true
    ? 'Use arrow keys to inspect groups; Enter or Space opens the group timeline.'
    : 'Use arrow keys to inspect marks; Enter or Space opens the underlying records.';
}

/** The sole engine boundary; the owning mode drives data/theme updates and handles failures. */
export class TanStackStatisticsChart implements StatisticsChartRenderer {
  mount(
    host: HTMLElement,
    initial: StatisticsChartModel,
    onSelect: (selectionId: string) => void,
  ): StatisticsChartHandle {
    const document = host.ownerDocument;
    host.dataset['statisticsChartId'] = initial.id;
    if (document.defaultView === null)
      throw new Error('Statistics charts require an owning window');
    const idPrefix = `abyss-statistics-${document.defaultView.crypto.randomUUID()}`;
    let generation = 0,
      destroyed = false;
    const options = (input: StatisticsChartModel): HostOptions => {
      const model = timelineLayout(input),
        epoch = ++generation;
      host.setAttribute('role', 'group');
      host.setAttribute('aria-label', model.accessibleLabel);
      const selections = new Set(
        [...model.marks, ...(model.edges ?? [])].flatMap((mark) =>
          mark.selectionId === undefined ? [] : [mark.selectionId],
        ),
      );
      return {
        definition: defineChart({
          chart: ({ width, height }) => ({
            marks: marks(model, width, height),
            scales: { x: axis(model, 'x', width), y: axis(model, 'y', width) },
            theme: {
              foreground: FOREGROUND,
              muted: MUTED,
              grid: 'var(--background-modifier-border)',
              background: BACKGROUND,
              palette: [ACCENT],
            },
            clip:
              model.rowViewport !== true && model.kind !== 'network' && model.kind !== 'scatter',
            ...chartMargin(model),
          }),
          focus: 'nearest',
          focusRing: { fill: BACKGROUND, radius: 6, strokeWidth: 2 },
          svgAnimation: false,
          tooltip: tooltipOptions(model),
        }),
        idPrefix,
        height: height(model),
        initialWidth: measuredWidth(host),
        ariaLabel: '',
        ariaDescription: chartDescription(model),
        className: 'abyss-statistics-chart-svg',
        onSelect: (point) => {
          const id = point?.datum.selectionId;
          if (
            !destroyed &&
            generation === epoch &&
            host.closest('[inert]') === null &&
            id !== undefined &&
            selections.has(id)
          )
            onSelect(id);
        },
      };
    };
    const chart = acquireChart(host, options(initial), () => {
      destroyed = true;
    });
    return {
      update: (model) => {
        if (destroyed) return;
        if (host.ownerDocument !== document)
          throw new Error('Statistics chart owner document changed; remount required');
        chart.update(options(model));
      },
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        chart.destroy();
      },
    };
  }
}
