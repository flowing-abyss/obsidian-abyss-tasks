import {
  DAY,
  dateOf,
  dayOf,
  midnight,
  weekFloor,
  type StatisticsBucket,
} from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { inScope } from './statisticsDataset';
import { BucketDurations, contribution, type RecordedSpan } from './statisticsIntervals';
import { metric } from './statisticsViews';
import { required } from './statisticsWork';
import type { StatisticsAction, StatisticsContext, StatisticsSection } from './types';
interface Lane {
  day: number;
  start: number;
  end: number;
}
interface ClockWindow extends Lane {
  offset: number;
}
interface Fragment {
  span: RecordedSpan;
  window: ClockWindow;
  start: number;
  end: number;
}
function clockPosition(ms: number, window: ClockWindow): number {
  return (ms + window.offset * 60000 - window.day * DAY) / 60000;
}
function clockMetadata(
  start: number,
  end: number,
  offset: number,
): NonNullable<StatisticsMark['clock']> {
  const label = (ms: number): string =>
    `${new Date(ms + offset * 60000).toISOString().replace('Z', '')} (UTC${offset >= 0 ? '+' : ''}${offset / 60})`;
  return {
    startMs: start,
    endMs: end,
    offsetMinutes: offset,
    localStartMinutes:
      (start + offset * 60000) / 60000 - Math.floor((start + offset * 60000) / DAY) * 1440,
    localEndMinutes:
      (end + offset * 60000) / 60000 - Math.floor((start + offset * 60000) / DAY) * 1440,
    startLabel: label(start),
    endLabel: label(end),
  };
}
class Timeline {
  readonly week: number;
  readonly days: Lane[];
  readonly dayTotals: number[] = [];
  readonly overviewBuckets: StatisticsBucket[];
  readonly overviewPage: number;
  readonly weekCount: number;
  private readonly windows: ClockWindow[] = [];
  private readonly densityWindows: ClockWindow[] = [];
  private readonly fragments: Fragment[] = [];
  private dense = false;
  private readonly daily: BucketDurations;
  private density: BucketDurations | undefined;
  private readonly overview: BucketDurations;
  constructor(private readonly ctx: StatisticsContext) {
    const { request: r, calendar: c } = ctx,
      first = weekFloor(c.fromDay, r.firstDayOfWeek),
      last = weekFloor(c.todayDay, r.firstDayOfWeek),
      requested =
        r.weekStart === undefined ? last : weekFloor(dayOf(r.weekStart), r.firstDayOfWeek);
    this.week = Math.max(first, Math.min(requested, last));
    this.days = Array.from({ length: 7 }, (_, i) => ({
      day: this.week + i,
      start: midnight(this.week + i, r),
      end: midnight(this.week + i + 1, r),
    }));
    this.weekCount = (last - first) / 7 + 1;
    this.overviewPage = Math.max(
      0,
      Math.min(
        Math.floor(r.page ?? (this.week - first) / 7 / 104),
        Math.floor((this.weekCount - 1) / 104),
      ),
    );
    const count = Math.min(104, this.weekCount - this.overviewPage * 104);
    this.overviewBuckets = Array.from({ length: count }, (_, i) => {
      const day = first + (this.overviewPage * 104 + i) * 7;
      return {
        key: dateOf(day),
        fromDay: day,
        toDay: day + 7,
        startMs: midnight(day, r),
        endMs: midnight(day + 7, r),
      };
    });
    this.overview = new BucketDurations({ ...c, buckets: this.overviewBuckets });
    this.daily = new BucketDurations({
      ...c,
      buckets: this.days.map((lane) => ({
        key: dateOf(lane.day),
        fromDay: lane.day,
        toDay: lane.day + 1,
        startMs: lane.start,
        endMs: lane.end,
      })),
    });
  }
  private async makeWindows(): Promise<void> {
    for (const segment of this.ctx.calendar.segments) {
      for (const lane of this.days) {
        const start = Math.max(segment.startMs, lane.start),
          end = Math.min(segment.endMs, lane.end);
        if (end > start) {
          const window = { ...lane, start, end, offset: segment.offsetMinutes };
          this.windows.push(window);
          let a = start;
          while (a < end) {
            const nextHour =
                (Math.floor((a + window.offset * 60000) / 3600000) + 1) * 3600000 -
                window.offset * 60000,
              z = Math.min(end, nextHour);
            this.densityWindows.push({ ...window, start: a, end: z });
            a = z;
            await this.ctx.budget.step();
          }
        }
        await this.ctx.budget.step();
      }
    }
    this.density = new BucketDurations({
      ...this.ctx.calendar,
      buckets: this.densityWindows.map((w) => ({
        key: `${w.start}`,
        fromDay: w.day,
        toDay: w.day + 1,
        startMs: w.start,
        endMs: w.end,
      })),
    });
  }
  async prepare(spans: readonly RecordedSpan[]): Promise<void> {
    await this.makeWindows();
    for (const span of spans) {
      const overviewSpan = {
        ...span,
        start: Math.max(span.start, required(this.overviewBuckets[0]).startMs),
        end: Math.min(
          span.end,
          required(this.overviewBuckets[this.overviewBuckets.length - 1]).endMs,
        ),
      };
      if (overviewSpan.end > overviewSpan.start) this.overview.add(overviewSpan);
      const clipped = {
        ...span,
        start: Math.max(span.start, required(this.days[0]).start),
        end: Math.min(span.end, required(this.days[6]).end),
      };
      if (clipped.end > clipped.start) {
        this.daily.add(clipped);
        required(this.density).add(clipped);
        if (!this.dense) await this.fragmentsFor(clipped);
      }
      await this.ctx.budget.step();
    }
    this.dayTotals.push(...this.daily.values());
  }
  private async fragmentsFor(span: RecordedSpan): Promise<void> {
    for (const window of this.windows) {
      const start = Math.max(span.start, window.start),
        end = Math.min(span.end, window.end);
      if (end > start) {
        this.fragments.push({ span, window, start, end });
        if (this.fragments.length > 700) {
          this.dense = true;
          break;
        }
      }
      await this.ctx.budget.step();
    }
  }
  private intervalMarks(): StatisticsMark[] {
    return this.fragments.map((fragment) => {
      const entry = required(this.ctx.dataset.entries[fragment.span.entry]),
        key = `timeline:${entry.key}:${fragment.start}`,
        duration = (fragment.end - fragment.start) / 60000;
      return {
        key,
        x: clockPosition(fragment.start, fragment.window),
        x2: clockPosition(fragment.end, fragment.window),
        y: dateOf(fragment.window.day),
        weight: duration,
        clock: clockMetadata(fragment.start, fragment.end, fragment.window.offset),
        label: required(this.ctx.dataset.tasks[fragment.span.owner]).title,
        selectionId: this.ctx.evidence.rows(key, 1, () =>
          this.ctx.evidence.entryRow(entry, duration),
        ),
      };
    });
  }
  selection(id: string, windows: ReadonlyArray<readonly [number, number]>): string {
    return this.ctx.evidence.entryQuery(id, (entry) => {
      if (!inScope(required(this.ctx.dataset.tasks[entry.owner]), this.ctx.request.scope))
        return undefined;
      let amount = 0;
      for (const window of windows)
        amount += contribution(
          entry,
          Math.max(this.ctx.calendar.startMs, window[0]),
          Math.min(this.ctx.calendar.endMs, window[1]),
          this.ctx.request.nowMs,
        );
      return amount > 0 ? amount : undefined;
    });
  }
  private densityMarks(): StatisticsMark[] {
    const groups = new Map<
        string,
        { window: ClockWindow; value: number; windows: ClockWindow[] }
      >(),
      values = required(this.density).values();
    for (let i = 0; i < values.length; i++) {
      const window = required(this.densityWindows[i]),
        hour = Math.floor(clockPosition(window.start, window) / 60),
        key = `${window.day}:${hour}`,
        group = groups.get(key) ?? { window, value: 0, windows: [] };
      group.value += required(values[i]);
      group.windows.push(window);
      groups.set(key, group);
    }
    return [...groups]
      .filter(([, g]) => g.value > 0)
      .map(([key, g]) => {
        const x = Math.floor(clockPosition(g.window.start, g.window) / 60) * 60;
        return {
          key,
          x,
          x2: x + 60,
          y: dateOf(g.window.day),
          weight: g.value,
          clockRanges: g.windows.map((w) => clockMetadata(w.start, w.end, w.offset)),
          selectionId: this.selection(
            `timeline-density:${key}`,
            g.windows.map((w) => [w.start, w.end] as const),
          ),
        };
      });
  }
  private overviewChart(): StatisticsChartModel {
    const values = this.overview.values();
    return {
      id: 'timeline-overview',
      accessibleLabel: 'Select a calendar week in the period',
      kind: 'bars',
      x: bands(
        'Week starting',
        this.overviewBuckets.map((b) => b.key),
      ),
      y: numeric('Minutes', Math.max(0, ...values)),
      series: [],
      marks: values.map((value, i) => {
        const bucket = required(this.overviewBuckets[i]);
        return {
          key: bucket.key,
          x: bucket.key,
          y: value,
          selected: bucket.fromDay === this.week,
          selectionId: `select-week:${bucket.key}`,
        };
      }),
    };
  }
  charts(): StatisticsChartModel[] {
    return [
      {
        id: 'timeline',
        accessibleLabel: 'Recorded intervals in the selected local week',
        kind: 'timeline',
        layout: this.dense ? 'density' : undefined,
        x: {
          ...numeric('Time of day', 1440),
          tickLabels: Array.from(
            { length: 25 },
            (_, hour) => [hour * 60, `${String(hour).padStart(2, '0')}:00`] as const,
          ),
        },
        y: bands(
          'Local day',
          this.days.map((lane) => dateOf(lane.day)),
        ),
        series: [],
        marks: this.dense ? this.densityMarks() : this.intervalMarks(),
      },
      this.overviewChart(),
    ];
  }
  chartActions(): Array<readonly [string, StatisticsAction]> {
    return this.overviewBuckets.map(
      (b) =>
        [
          `select-week:${b.key}`,
          { type: 'week', label: `Week of ${b.key}`, weekStart: dateOf(b.fromDay) },
        ] as const,
    );
  }
  actions(): StatisticsAction[] {
    const result: StatisticsAction[] = [],
      { calendar: c, request: r } = this.ctx;
    if (this.week > weekFloor(c.fromDay, r.firstDayOfWeek))
      result.push({ type: 'week', label: 'Previous week', weekStart: dateOf(this.week - 7) });
    if (this.week + 7 <= c.todayDay)
      result.push({ type: 'week', label: 'Next week', weekStart: dateOf(this.week + 7) });
    if (this.overviewPage > 0)
      result.push({ type: 'page', label: 'Earlier weeks', page: this.overviewPage - 1 });
    if ((this.overviewPage + 1) * 104 < this.weekCount)
      result.push({ type: 'page', label: 'Later weeks', page: this.overviewPage + 1 });
    return result;
  }
}
export async function timeline(
  ctx: StatisticsContext,
  spans: readonly RecordedSpan[],
): Promise<{
  sections: StatisticsSection[];
  actions: StatisticsAction[];
  chartActions: Array<readonly [string, StatisticsAction]>;
}> {
  const model = new Timeline(ctx);
  await model.prepare(spans);
  return {
    sections: [
      {
        id: 'timeline',
        title: 'Recorded intervals',
        context:
          'Local time of day; offset changes split intervals. Gaps stay empty and repeated clock hours retain explicit offsets. Durations use actual elapsed time.',
        metrics: [
          metric(
            'week-minutes',
            'This week',
            model.dayTotals.reduce((a, z) => a + z, 0),
            {
              unit: 'minutes',
              selectionId: model.selection('week-time', [
                [required(model.days[0]).start, required(model.days[6]).end],
              ]),
            },
          ),
          ...model.days.map((lane, i) =>
            metric(`day:${i}`, dateOf(lane.day), required(model.dayTotals[i]), {
              unit: 'minutes',
              selectionId: model.selection(`day-time:${i}`, [[lane.start, lane.end]]),
            }),
          ),
        ],
        charts: model.charts(),
        legend: [],
      },
    ],
    actions: model.actions(),
    chartActions: model.chartActions(),
  };
}
