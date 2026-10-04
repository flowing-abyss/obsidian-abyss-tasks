import { HOUR, type CalendarSegment } from './statisticsCalendar';
import { bands, numeric } from './statisticsChartModel';
import { inScope } from './statisticsDataset';
import { endpoints, span, type RecordedSpan } from './statisticsIntervals';
import type { WorkBudget } from './statisticsWork';
import { required } from './statisticsWork';
import type { StatisticsContext, StatisticsSection } from './types';
const WEEK_MS = 168 * HOUR;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mod = (value: number, n: number): number => ((value % n) + n) % n;
/** Circular-hour range additions: full weeks are one scalar, residual whole hours one range. */
class HourAccumulator {
  private base = 0;
  private readonly diff = Array<number>(169).fill(0);
  private readonly partial = Array<number>(168).fill(0);
  add(start: number, end: number, offset: number, weight: number): void {
    if (end <= start) return;
    const a = start + offset * 60000 + 96 * HOUR,
      z = end + offset * 60000 + 96 * HOUR;
    const first = Math.floor(a / HOUR),
      last = Math.floor(z / HOUR);
    if (first === last) {
      this.partial[mod(first, 168)] = required(this.partial[mod(first, 168)]) + (z - a) * weight;
      return;
    }
    this.partial[mod(first, 168)] =
      required(this.partial[mod(first, 168)]) + ((first + 1) * HOUR - a) * weight;
    this.partial[mod(last, 168)] =
      required(this.partial[mod(last, 168)]) + (z - last * HOUR) * weight;
    const count = last - first - 1;
    this.base += Math.floor(count / 168) * HOUR * weight;
    const length = count % 168,
      from = mod(first + 1, 168),
      to = from + length;
    if (to <= 168) {
      this.diff[from] = required(this.diff[from]) + HOUR * weight;
      this.diff[to] = required(this.diff[to]) - HOUR * weight;
    } else {
      this.diff[from] = required(this.diff[from]) + HOUR * weight;
      this.diff[168] = required(this.diff[168]) - HOUR * weight;
      this.diff[0] = required(this.diff[0]) + HOUR * weight;
      this.diff[to - 168] = required(this.diff[to - 168]) - HOUR * weight;
    }
  }
  values(): number[] {
    let total = this.base;
    return this.partial.map((value, i) => {
      total += required(this.diff[i]);
      return value + total;
    });
  }
}
function periodicBefore(ms: number, cell: number): number {
  const shifted = ms + 96 * HOUR,
    cycles = Math.floor(shifted / WEEK_MS),
    residual = mod(shifted, WEEK_MS);
  return cycles * HOUR + Math.max(0, Math.min(HOUR, residual - cell * HOUR));
}
function segmentCell(a: number, z: number, offset: number, cell: number): number {
  return periodicBefore(z + offset * 60000, cell) - periodicBefore(a + offset * 60000, cell);
}
/** Calendar-only prefixes: O(168 × transitions), never 168 × entry endpoints. */
class ExposureIndex {
  private readonly prefixes: number[][] = Array.from({ length: 168 }, () => [0]);
  constructor(private readonly segments: readonly CalendarSegment[]) {}
  async prepare(b: WorkBudget): Promise<void> {
    for (const s of this.segments)
      for (let cell = 0; cell < 168; cell++) {
        const p = required(this.prefixes[cell]);
        p.push(required(p[p.length - 1]) + segmentCell(s.startMs, s.endMs, s.offsetMinutes, cell));
        await b.step();
      }
  }
  private before(ms: number, cell: number): number {
    let lo = 0,
      hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (required(this.segments[mid]).endMs <= ms) lo = mid + 1;
      else hi = mid;
    }
    const s = this.segments[lo],
      prefix = required(required(this.prefixes[cell])[lo]);
    return s === undefined
      ? prefix
      : prefix + segmentCell(s.startMs, Math.max(s.startMs, ms), s.offsetMinutes, cell);
  }
  between(a: number, z: number, cell: number): number {
    return this.before(z, cell) - this.before(a, cell);
  }
}
class PatternSweep {
  private segmentIndex = 0;
  constructor(
    private readonly segments: readonly CalendarSegment[],
    private readonly accumulator: HourAccumulator,
    private readonly budget: WorkBudget,
  ) {}
  async span(start: number, end: number, count: number): Promise<void> {
    let cursor = start;
    while (cursor < end) {
      await this.advance(cursor);
      const segment = this.segments[this.segmentIndex];
      if (segment === undefined) return;
      const stop = Math.min(end, segment.endMs);
      this.accumulator.add(cursor, stop, segment.offsetMinutes, count);
      cursor = stop;
      await this.budget.step();
    }
  }
  private async advance(cursor: number): Promise<void> {
    while (
      this.segments[this.segmentIndex] !== undefined &&
      required(this.segments[this.segmentIndex]).endMs <= cursor
    ) {
      this.segmentIndex++;
      await this.budget.step();
    }
  }
}
async function patternNumerators(
  segments: readonly CalendarSegment[],
  spans: readonly RecordedSpan[],
  accumulator: HourAccumulator,
  budget: WorkBudget,
): Promise<void> {
  const events = await endpoints(spans, budget),
    sweep = new PatternSweep(segments, accumulator, budget);
  let count = 0,
    i = 0;
  while (i < events.length) {
    const at = required(events[i]).at;
    while (i < events.length && required(events[i]).at === at) {
      count += required(events[i++]).delta;
      await budget.step();
    }
    const next = events[i]?.at;
    if (next !== undefined) await sweep.span(at, next, count);
  }
}
export async function patternsSection(
  { dataset, request: r, calendar: c, evidence: e, budget: b }: StatisticsContext,
  spans: readonly RecordedSpan[],
): Promise<StatisticsSection> {
  const exposure = new HourAccumulator(),
    numerator = new HourAccumulator();
  for (const s of c.segments) {
    exposure.add(s.startMs, s.endMs, s.offsetMinutes, 1);
    await b.step();
  }
  await patternNumerators(c.segments, spans, numerator, b);
  const minutes = numerator.values().map((ms) => ms / 60000),
    hours = exposure.values().map((ms) => ms / HOUR),
    index = new ExposureIndex(c.segments);
  await index.prepare(b);
  const marks = minutes.map((value, cell) => ({
    key: `pattern:${cell}`,
    x: cell % 24,
    y: required(DAYS[Math.floor(cell / 24)]),
    numerator: value,
    denominator: required(hours[cell]),
    weight: hours[cell] === 0 ? undefined : value / required(hours[cell]),
    state: hours[cell] === 0 ? ('unavailable' as const) : ('measured' as const),
    detail:
      hours[cell] === 0
        ? 'No elapsed exposure for this local calendar hour'
        : `${value} recorded minutes / ${required(hours[cell])} elapsed exposure hours; mean ${value / required(hours[cell])} minutes per hour`,
    selectionId: e.entryQuery(`pattern:${cell}`, (entry) => {
      if (!inScope(required(dataset.tasks[entry.owner]), r.scope)) return undefined;
      const s = span(entry, c.startMs, c.endMs, r.nowMs);
      if (s === undefined) return undefined;
      const amount = index.between(s.start, s.end, cell) / 60000;
      return amount > 0 ? amount : undefined;
    }),
  }));
  return {
    id: 'patterns',
    title: 'Recorded time by local calendar hour',
    context:
      'Mean recorded minutes per elapsed hour. Overlapping recordings add; zero exposure is unavailable.',
    metrics: [],
    charts: [
      {
        id: 'patterns',
        accessibleLabel: 'Weekday by hour recorded minutes divided by calendar exposure',
        kind: 'heatmap',
        intensityScale: {
          domain: [0, Math.max(0, ...marks.map((mark) => mark.weight ?? 0))],
          unit: 'mean minutes per elapsed hour',
        },
        x: {
          ...numeric('Local hour', 24),
          tickLabels: Array.from(
            { length: 24 },
            (_, hour) => [hour, `${String(hour).padStart(2, '0')}:00`] as const,
          ),
        },
        y: bands('Weekday', DAYS),
        series: [],
        marks,
      },
    ],
    legend: [],
  };
}
