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
import type { ChartMark, ChartPoint, ChartPositionScaleOptions } from '@tanstack/charts/types';
import type { StatisticsAxis, StatisticsChartModel, StatisticsMark } from '../../statistics';
import type { StatisticsChartHandle, StatisticsChartRenderer } from './StatisticsChart';
import {
  statisticsMarkDescription,
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
const NETWORK_MARGIN = { top: 35, left: 55, right: 55, bottom: 20 };

function height(model: StatisticsChartModel): number {
  if (model.y.type === 'band' && (model.kind === 'heatmap' || model.kind === 'timeline'))
    return Math.max(150, model.y.categories.length * (model.kind === 'timeline' ? 36 : 26) + 48);
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
  if (value.type === 'band')
    return scaleBand<string>().domain(value.categories).padding(bandPadding(model));
  if (model.kind === 'heatmap')
    return scaleBand<number>().domain([...new Set(model.marks.map((mark) => number(mark, side)))]);
  return scaleLinear().domain([...value.domain]);
}
function tickCandidates(value: StatisticsAxis, width: number): number[] | undefined {
  if (value.type !== 'number') return undefined;
  const candidates = value.ticks ?? value.tickLabels?.map(([position]) => position);
  if (candidates === undefined) return undefined;
  const stride = Math.max(1, Math.ceil(candidates.length / Math.max(2, Math.floor(width / 105))));
  return candidates.filter((_, index) => index % stride === 0 || index === candidates.length - 1);
}
function axisPolicy(
  value: StatisticsAxis,
  width: number,
  side: 'x' | 'y',
): Exclude<ChartPositionScaleOptions<Value>['axis'], false | undefined> {
  const labels =
    value.type === 'number' ? new Map(value.tickLabels ?? []) : new Map<number, string>();
  const candidates = tickCandidates(value, width);
  const count = side === 'x' ? Math.max(2, Math.floor(width / 105)) : 4;
  const unit = value.type === 'number' ? value.unit : '';
  return {
    line: false,
    ...(value.label === '' ? {} : { label: { text: value.label, fontSize: 11, fill: MUTED } }),
    ticks: {
      size: 0,
      ...(candidates === undefined ? { count } : { values: candidates }),
      format: (tick) =>
        typeof tick === 'number' ? (labels.get(tick) ?? statisticsNumber(tick, unit)) : tick,
    },
    tickLabels: { fontSize: 11, opacity: 1, thin: { minGap: 9, priority: 'ends' } },
  };
}
function axis(
  model: StatisticsChartModel,
  side: 'x' | 'y',
  width: number,
): ChartPositionScaleOptions<Value> {
  const hidden = model.kind === 'network';
  const grid = !hidden && model[side].type === 'number' && model.kind !== 'heatmap' && side === 'y';
  return {
    scale: positionScale(model, side),
    reverse: hidden && side === 'y',
    grid: grid ? { stroke: 'var(--background-modifier-border)', strokeOpacity: 0.55 } : false,
    axis: hidden ? false : axisPolicy(model[side], width, side),
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
      ? 7
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
  const maximum = Math.max(0, ...model.marks.map((mark) => mark.weight ?? 0));
  const buckets = ['unknown', 'immature', 'unavailable', 'zero', 'low', 'medium', 'high'];
  const colors = [
    MUTED,
    'var(--background-secondary)',
    'var(--background-modifier-border)',
    BACKGROUND,
    `color-mix(in srgb, ${ACCENT} 20%, ${BACKGROUND})`,
    `color-mix(in srgb, ${ACCENT} 50%, ${BACKGROUND})`,
    ACCENT,
  ];
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
          fill: colors[i] ?? ACCENT,
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
            mark.state !== undefined && mark.state !== 'measured'
              ? '—'
              : statisticsNumber(mark.weight ?? 0),
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
function timelineMarks(model: StatisticsChartModel): RenderMark[] {
  if (model.layout === 'density') return densityMarks(model);
  const rows = timelineRows(model);
  return [
    rect(rows, {
      id: 'intervals',
      x1: 'x',
      x2: 'x2',
      x: (mark) => (number(mark, 'x') + (mark.x2 ?? number(mark, 'x'))) / 2,
      y: 'y',
      key: 'key',
      fill: ACCENT,
      fillOpacity: 0.8,
      radius: 2,
      inset: 0,
    }),
  ];
}
function densityMarks(model: StatisticsChartModel): RenderMark[] {
  const rows = model.kind === 'timeline' ? timelineRows(model) : model.marks;
  const maximum = Math.max(0, ...rows.map((mark) => mark.weight ?? 0));
  const paints = [
    ['zero', BACKGROUND],
    ['low', `color-mix(in srgb, ${ACCENT} 25%, ${BACKGROUND})`],
    ['medium', `color-mix(in srgb, ${ACCENT} 55%, ${BACKGROUND})`],
    ['high', ACCENT],
  ] as const;
  return paints.flatMap(([bucket, fill]) => {
    const values = rows.filter((mark) => heatBucket(mark, maximum) === bucket);
    return values.length === 0
      ? []
      : [
          rect(values, {
            id: `density:${bucket}`,
            x1: 'x',
            x2: 'x2',
            x: (mark) => (number(mark, 'x') + (mark.x2 ?? number(mark, 'x'))) / 2,
            ...(model.kind === 'timeline'
              ? { y: 'y' as const }
              : { y1: 'y' as const, y2: 'y2' as const }),
            key: 'key',
            fill,
            radius: 2,
            inset: 0,
          }),
        ];
  });
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
      text(model.marks, {
        id: 'node-labels',
        x: 'x',
        y: 'y',
        key: 'key',
        text: (mark) =>
          (mark.label ?? '').length > labelLength
            ? `${(mark.label ?? '').slice(0, labelLength - 1)}…`
            : (mark.label ?? ''),
        anchor: (mark) =>
          model.x.type === 'number' &&
          number(mark, 'x') > (model.x.domain[0] + model.x.domain[1]) / 2
            ? 'end'
            : 'start',
        dy: -16,
        fontSize: 11,
        fill: FOREGROUND,
      }),
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
    let generation = 0,
      destroyed = false;
    const options = (model: StatisticsChartModel): HostOptions => {
      const epoch = ++generation;
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
            // Network boundary nodes/labels use the explicit viewport margins; a plot
            // clip would cut their circles and hide every first-row label at y=0.
            clip: model.kind !== 'network',
            ...(model.kind === 'network' ? { margin: NETWORK_MARGIN } : {}),
          }),
          focus: 'nearest',
          focusRing: { fill: BACKGROUND, radius: 6, strokeWidth: 2 },
          svgAnimation: false,
          tooltip: {
            use: tooltip,
            className: 'abyss-statistics-tooltip',
            motion: false,
            format: (point: ChartPoint<StatisticsMark, Value, Value>) =>
              statisticsMarkDescription(point.datum, model),
          },
        }),
        height: height(model),
        initialWidth: measuredWidth(host),
        ariaLabel: model.accessibleLabel,
        ariaDescription:
          'Use arrow keys to inspect marks; Enter or Space opens the underlying records.',
        className: 'abyss-statistics-chart-svg',
        onSelect: (point) => {
          const id = point?.datum.selectionId;
          if (!destroyed && generation === epoch && id !== undefined && selections.has(id))
            onSelect(id);
        },
      };
    };
    const chart = acquireChart(host, options(initial), () => {
      destroyed = true;
      generation++;
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
        generation++;
        chart.destroy();
      },
    };
  }
}
