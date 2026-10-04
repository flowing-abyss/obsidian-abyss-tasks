import type { StatisticsChartModel, StatisticsMark, StatisticsTone } from '../../statistics';

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
function observationDescription(mark: StatisticsMark): string[] {
  const pieces: string[] = [];
  if (mark.state !== undefined && mark.state !== 'measured')
    pieces.push(
      {
        unknown: 'Unknown timing',
        immature: 'Not yet observable',
        unavailable: 'No elapsed exposure',
      }[mark.state],
    );
  else if (mark.weight !== undefined) pieces.push(statisticsNumber(mark.weight));
  if (mark.numerator !== undefined && mark.denominator !== undefined)
    pieces.push(`${statisticsNumber(mark.numerator)} / ${statisticsNumber(mark.denominator)}`);
  if (mark.overdue !== undefined) pieces.push(`${mark.overdue} overdue`);
  return pieces;
}
export function statisticsMarkDescription(
  mark: StatisticsMark,
  model: StatisticsChartModel,
): string {
  const series = model.series.find((candidate) => candidate.key === mark.series);
  const pieces = [mark.label ?? `${mark.x}, ${mark.y}`, series?.label];
  pieces.push(...observationDescription(mark));
  if (mark.clock !== undefined)
    pieces.push(
      `${mark.clock.startLabel} – ${mark.clock.endLabel}`,
      `${statisticsNumber(mark.weight ?? 0)} recorded minutes`,
    );
  for (const range of mark.clockRanges ?? [])
    pieces.push(`${range.startLabel} – ${range.endLabel}`);
  if (mark.detail !== undefined) pieces.push(mark.detail);
  return pieces.filter((piece) => piece !== undefined && piece !== '').join('\n');
}
