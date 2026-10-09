import type {
  StatisticsAxis,
  StatisticsChartModel,
  StatisticsMark,
  StatisticsObservation,
  StatisticsTone,
} from '../../statistics';

type PaintKey = {
  readonly key: string;
  readonly tone: StatisticsTone;
  readonly muted?: boolean | undefined;
};
const CATEGORY_TOKENS = [
  '--color-blue',
  '--color-green',
  '--color-purple',
  '--color-orange',
  '--color-red',
  '--color-yellow',
  '--interactive-accent',
] as const;
const TONE_TOKENS: Record<StatisticsTone, string> = {
  created: '--color-blue',
  completed: '--color-green',
  cancelled: '--color-orange',
  overdue: '--color-red',
  neutral: '--text-muted',
  muted: '--text-faint',
  accent: '--interactive-accent',
};
function categorySlot(key: string): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % 14;
}
function categorySlots(peers: readonly PaintKey[]): Map<string, number> {
  const slots = new Map<string, number>();
  const occupied = new Set<number>();
  for (const key of [
    ...new Set(peers.filter((peer) => peer.tone === 'accent').map((peer) => peer.key)),
  ].sort((a, b) => a.localeCompare(b))) {
    let slot = categorySlot(key);
    for (let attempts = 0; occupied.has(slot) && attempts < 14; attempts++) slot = (slot + 1) % 14;
    slots.set(key, slot);
    occupied.add(slot);
  }
  return slots;
}
/** Shared by chart series and evidence legends; peers are the same section's full series. */
export function statisticsSeriesPaint(series: PaintKey, peers: readonly PaintKey[] = []): string {
  if (
    series.tone !== 'accent' ||
    peers.length === 0 ||
    peers.some((peer) => peer.tone !== 'accent')
  )
    return `var(${TONE_TOKENS[series.tone]}, var(--text-normal))`;
  const slot = categorySlots(peers).get(series.key) ?? categorySlot(series.key);
  const paint = `var(${CATEGORY_TOKENS[slot % 7]}, var(--interactive-accent))`;
  return slot < 7 ? paint : `color-mix(in srgb, ${paint} 60%, var(--background-primary))`;
}
export function statisticsSeriesOpacity(series: PaintKey): number {
  return series.muted === true ? 0.45 : 1;
}
export function statisticsNumber(value: number, unit = ''): string {
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 0.1) return `${Number(value.toPrecision(2))}${unit}`;
  if (absolute >= 10000) return `${(value / 1000).toFixed(0)}k${unit}`;
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)}k${unit}`;
  return `${Number(value.toFixed(1))}${unit}`;
}
function axisDescription(axis: StatisticsAxis, value: number | string): string {
  const formatted = axisValue(axis, value);
  return axis.label === '' ? formatted : `${axis.label}: ${formatted}`;
}
type ContentRow = { label: string; value: string };
type MarkContent = { title: string; rows: readonly ContentRow[] };
function axisValue(axis: StatisticsAxis, value: number | string): string {
  const label = axis.tickLabels?.find(([position]) => position === value)?.[1];
  if (label !== undefined) return label;
  if (typeof value === 'string') return value;
  const unit = axis.type === 'number' ? axis.unit : undefined;
  return observationValue(value, unit);
}
function observationValue(value: number | string | null, unit?: string): string {
  if (value === null) return 'Unavailable';
  if (typeof value === 'string') return value;
  return statisticsNumber(value, unitSuffix(unit, value));
}
function unitSuffix(unit: string | undefined, value: number): string {
  if (unit === undefined || unit === 'count') return '';
  const singular = { days: 'day', tasks: 'task', sessions: 'session' }[unit];
  if (singular !== undefined) return ` ${singular}${value === 1 ? '' : 's'}`;
  return { percent: '%', '%': '%', minutes: ' min', hours: ' h' }[unit] ?? ` ${unit}`;
}
function countUnit(axis: StatisticsAxis): string | undefined {
  if (axis.type !== 'number') return undefined;
  if (axis.unit !== undefined && axis.unit !== 'count') return axis.unit;
  if (/sessions/i.test(axis.label)) return 'sessions';
  if (/tasks/i.test(axis.label)) return 'tasks';
  return axis.unit;
}
function suppliedContent(observation: StatisticsObservation): MarkContent {
  const { title, values, note } = observation;
  const rows = values.map(({ label, value, unit }) => ({
    label,
    value: observationValue(value, unit),
  }));
  if (note !== undefined && note !== '') rows.push({ label: 'Reading', value: note });
  return { title, rows };
}
function barContent(mark: StatisticsMark, model: StatisticsChartModel): MarkContent {
  const series = model.series.find((candidate) => candidate.key === mark.series);
  if (model.x.type === 'number' && model.y.type === 'band')
    return barAxesContent(
      mark,
      {
        categoryAxis: model.y,
        valueAxis: model.x,
        category: mark.y,
        endpoint: mark.x,
        baseline: mark.x2,
      },
      series?.label,
    );
  return barAxesContent(
    mark,
    {
      categoryAxis: model.x,
      valueAxis: model.y,
      category: mark.x,
      endpoint: mark.y,
      baseline: mark.y2,
    },
    series?.label,
  );
}
function barAxesContent(
  mark: StatisticsMark,
  geometry: {
    categoryAxis: StatisticsAxis;
    valueAxis: StatisticsAxis;
    category: number | string;
    endpoint: number | string;
    baseline: number | undefined;
  },
  seriesLabel: string | undefined,
): MarkContent {
  const { categoryAxis, valueAxis, category, endpoint, baseline } = geometry;
  const distance = typeof endpoint === 'number' ? Math.abs(endpoint - (baseline ?? 0)) : 0;
  return {
    title: mark.label ?? axisValue(categoryAxis, category),
    rows: [
      {
        label: seriesLabel ?? valueAxis.label,
        value: observationValue(mark.weight ?? distance, countUnit(valueAxis)),
      },
    ],
  };
}
function weightedRow(
  weight: number,
  model: StatisticsChartModel,
  seriesLabel: string | undefined,
): ContentRow {
  const unit = model.intensityScale?.unit;
  return {
    label: seriesLabel ?? unit ?? 'Tasks',
    value: observationValue(weight, unit ?? 'tasks'),
  };
}
function fallbackRows(mark: StatisticsMark, model: StatisticsChartModel): ContentRow[] {
  if (mark.state !== undefined && mark.state !== 'measured')
    return [
      {
        label: 'Timing',
        value: {
          unknown: 'Unknown timing',
          immature: 'Not yet observable',
          unavailable: 'No elapsed exposure',
        }[mark.state],
      },
    ];
  const series = model.series.find((candidate) => candidate.key === mark.series);
  if (mark.weight !== undefined) return [weightedRow(mark.weight, model, series?.label)];
  if (model.kind === 'lines' && typeof mark.y === 'number')
    return [
      {
        label: series?.label ?? model.y.label,
        value: observationValue(mark.y, countUnit(model.y)),
      },
    ];
  return [];
}
function fallbackContent(mark: StatisticsMark, model: StatisticsChartModel): MarkContent {
  if (model.kind === 'bars') return barContent(mark, model);
  if (mark.clock !== undefined || mark.clockRanges !== undefined)
    return {
      title: mark.label ?? axisValue(model.y, mark.y),
      rows: [{ label: 'Recorded time', value: observationValue(mark.weight ?? 0, 'minutes') }],
    };
  const title =
    model.kind === 'lines'
      ? axisValue(model.x, mark.x)
      : `${axisDescription(model.x, mark.x)} · ${axisDescription(model.y, mark.y)}`;
  return { title: mark.label ?? title, rows: fallbackRows(mark, model) };
}
function supplementalRows(mark: StatisticsMark): ContentRow[] {
  const rows: ContentRow[] = [];
  if (mark.numerator !== undefined && mark.denominator !== undefined)
    rows.push({
      label: 'Count',
      value: `${statisticsNumber(mark.numerator)} / ${statisticsNumber(mark.denominator)}`,
    });
  if (mark.overdue !== undefined)
    rows.push({ label: 'Overdue', value: observationValue(mark.overdue, 'tasks') });
  const ranges = mark.clockRanges ?? [];
  for (const range of ranges)
    rows.push({ label: 'Clock range', value: `${range.startLabel} – ${range.endLabel}` });
  if (mark.clockRanges === undefined && mark.clock !== undefined)
    rows.push({ label: 'Clock range', value: `${mark.clock.startLabel} – ${mark.clock.endLabel}` });
  if (mark.detail !== undefined && mark.detail !== '')
    rows.push({ label: 'Reading', value: mark.detail });
  return rows;
}
export function statisticsMarkContent(
  mark: StatisticsMark,
  model: StatisticsChartModel,
): MarkContent {
  if (mark.observation !== undefined) return suppliedContent(mark.observation);
  const content = fallbackContent(mark, model);
  return { title: content.title, rows: [...content.rows, ...supplementalRows(mark)] };
}
export function statisticsMarkTitle(mark: StatisticsMark, model: StatisticsChartModel): string {
  const content = statisticsMarkContent(mark, model);
  if (mark.observation !== undefined) return content.title;
  const series = model.series.find((candidate) => candidate.key === mark.series);
  return series === undefined ? content.title : `${content.title} · ${series.label}`;
}
export function statisticsMarkDescription(
  mark: StatisticsMark,
  model: StatisticsChartModel,
): string {
  const { title, rows } = statisticsMarkContent(mark, model);
  return [title, ...rows.map((row) => `${row.label}: ${row.value}`)].join('\n');
}

export type StatisticsIntensity =
  'unknown' | 'immature' | 'unavailable' | 'zero' | 'low' | 'medium' | 'high';
export function statisticsIntensityPaint(level: StatisticsIntensity): string {
  const accent = 'var(--interactive-accent)',
    background = 'var(--background-primary)';
  return {
    unknown: 'var(--text-muted)',
    immature: 'var(--background-secondary)',
    unavailable: 'var(--background-modifier-border)',
    zero: background,
    low: `color-mix(in srgb, ${accent} 20%, ${background})`,
    medium: `color-mix(in srgb, ${accent} 50%, ${background})`,
    high: accent,
  }[level];
}
