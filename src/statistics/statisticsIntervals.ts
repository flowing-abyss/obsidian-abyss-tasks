import type { StatisticsCalendar } from './statisticsCalendar';
import { inScope } from './statisticsDataset';
import { required, sorted, type WorkBudget } from './statisticsWork';
import type { StatisticsDataset, StatisticsEntry, StatisticsRequest } from './types';
export interface RecordedSpan {
  readonly entry: number;
  readonly owner: number;
  readonly start: number;
  readonly end: number;
}
export interface Endpoint {
  readonly at: number;
  readonly owner: number;
  readonly delta: 1 | -1;
}
export interface OwnerTransition {
  readonly from: number;
  readonly to: number;
  readonly at: number;
  readonly gapMs: number;
}
export function span(
  entry: StatisticsEntry,
  from: number,
  to: number,
  now: number,
): RecordedSpan | undefined {
  if (entry.state === 'broken' || entry.startMs === undefined) return undefined;
  const start = Math.max(from, entry.startMs),
    end = Math.min(to, entry.state === 'running' ? now : required(entry.endMs));
  return end > start ? { entry: entry.index, owner: entry.owner, start, end } : undefined;
}
export function contribution(
  entry: StatisticsEntry,
  from: number,
  to: number,
  now: number,
): number {
  const value = span(entry, from, to, now);
  return value === undefined ? 0 : (value.end - value.start) / 60000;
}
export async function recordedSpans(
  dataset: StatisticsDataset,
  r: StatisticsRequest,
  c: StatisticsCalendar,
  b: WorkBudget,
): Promise<RecordedSpan[]> {
  const result: RecordedSpan[] = [];
  for (const e of dataset.entries) {
    if (inScope(required(dataset.tasks[e.owner]), r.scope)) {
      const value = span(e, c.startMs, c.endMs, r.nowMs);
      if (value !== undefined) result.push(value);
    }
    await b.step();
  }
  return result;
}
export async function endpoints(
  spans: readonly RecordedSpan[],
  b: WorkBudget,
): Promise<Endpoint[]> {
  const events: Endpoint[] = [];
  for (const s of spans) {
    events.push(
      { at: s.start, owner: s.owner, delta: 1 },
      { at: s.end, owner: s.owner, delta: -1 },
    );
    await b.step();
  }
  return sorted(events, (a, z) => a.at - z.at, b);
}
class OwnerSweep {
  readonly counts = new Map<number, number>();
  readonly transitions: OwnerTransition[] = [];
  private previous: { owner: number; end: number } | undefined;
  constructor(
    private readonly context: {
      dataset: StatisticsDataset;
      request: StatisticsRequest;
      calendar: StatisticsCalendar;
    },
  ) {}
  delta(event: Endpoint): void {
    const count = (this.counts.get(event.owner) ?? 0) + event.delta;
    if (count === 0) this.counts.delete(event.owner);
    else this.counts.set(event.owner, count);
  }
  block(at: number, end: number): void {
    if (this.counts.size > 1) {
      this.previous = undefined;
      return;
    }
    if (this.counts.size === 0) return;
    const owner = required(this.counts.keys().next().value),
      previous = this.previous;
    if (
      previous !== undefined &&
      previous.owner !== owner &&
      at - previous.end <= 300000 &&
      this.inWindow(at) &&
      this.inScope(previous.owner) &&
      this.inScope(owner)
    )
      this.transitions.push({ from: previous.owner, to: owner, at, gapMs: at - previous.end });
    this.previous = { owner, end };
  }
  private inScope(owner: number): boolean {
    return inScope(required(this.context.dataset.tasks[owner]), this.context.request.scope);
  }
  private inWindow(at: number): boolean {
    return at >= this.context.calendar.startMs && at < this.context.calendar.endMs;
  }
}
/** All physical owners participate before scope. Equal-time deltas are atomic. */
export async function ownerTransitions(
  dataset: StatisticsDataset,
  r: StatisticsRequest,
  c: StatisticsCalendar,
  b: WorkBudget,
): Promise<OwnerTransition[]> {
  const all: RecordedSpan[] = [];
  for (const entry of dataset.entries) {
    const value = span(entry, -Infinity, r.nowMs, r.nowMs);
    if (value !== undefined) all.push(value);
    await b.step();
  }
  const events = await endpoints(all, b),
    sweep = new OwnerSweep({ dataset, request: r, calendar: c });
  for (let i = 0; i < events.length;) {
    const at = required(events[i]).at;
    while (i < events.length && required(events[i]).at === at) {
      sweep.delta(required(events[i++]));
      await b.step();
    }
    const end = events[i]?.at;
    if (end !== undefined && end > at) sweep.block(at, end);
    await b.step();
  }
  return sweep.transitions;
}
/** Two boundary contributions plus an interior range delta, independent of interval length. */
export class BucketDurations {
  private readonly partial: number[];
  private readonly difference: number[];
  constructor(private readonly calendar: StatisticsCalendar) {
    this.partial = Array<number>(calendar.buckets.length).fill(0);
    this.difference = Array<number>(calendar.buckets.length + 1).fill(0);
  }
  private bucket(ms: number, end = false): number {
    let lo = 0,
      hi = this.calendar.buckets.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (
        end
          ? required(this.calendar.buckets[m]).endMs < ms
          : required(this.calendar.buckets[m]).endMs <= ms
      )
        lo = m + 1;
      else hi = m;
    }
    return lo;
  }
  add(s: RecordedSpan): void {
    const first = this.bucket(s.start),
      last = this.bucket(s.end, true);
    if (first >= this.partial.length || last >= this.partial.length) return;
    if (first === last) {
      this.partial[first] = required(this.partial[first]) + (s.end - s.start);
      return;
    }
    this.partial[first] =
      required(this.partial[first]) + (required(this.calendar.buckets[first]).endMs - s.start);
    this.partial[last] =
      required(this.partial[last]) + (s.end - required(this.calendar.buckets[last]).startMs);
    this.difference[first + 1] = required(this.difference[first + 1]) + 1;
    this.difference[last] = required(this.difference[last]) - 1;
  }
  values(): number[] {
    let count = 0;
    return this.partial.map((value, i) => {
      count += required(this.difference[i]);
      const bucket = required(this.calendar.buckets[i]);
      return (value + count * (bucket.endMs - bucket.startMs)) / 60000;
    });
  }
}
