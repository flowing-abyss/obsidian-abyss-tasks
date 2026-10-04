import { bucketAt, dateOf, dayOf, weekFloor, type StatisticsCalendar } from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { active, inScope } from './statisticsDataset';
import { finish, metric, pageActions } from './statisticsViews';
import { required, sorted } from './statisticsWork';
import type {
  StatisticsContext,
  StatisticsSection,
  StatisticsTask,
  StatisticsViewModel,
} from './types';
export function datedEvent(
  t: StatisticsTask,
  event: 'created' | 'completed' | 'cancelled',
  calendar: StatisticsCalendar,
): number | undefined {
  let value = t.created;
  if (event === 'completed') value = t.status === 'done' ? t.completion : undefined;
  if (event === 'cancelled') value = t.status === 'cancelled' ? t.cancelled : undefined;
  if (value === undefined) return undefined;
  const day = dayOf(value);
  return day <= calendar.todayDay ? day : undefined;
}
export function inPeriod(day: number | undefined, calendar: StatisticsCalendar): day is number {
  return day !== undefined && day >= calendar.fromDay && day < calendar.toDay;
}
export function age(t: StatisticsTask, calendar: StatisticsCalendar): number | undefined {
  return t.created === undefined || dayOf(t.created) > calendar.todayDay
    ? undefined
    : calendar.todayDay - dayOf(t.created);
}
export function overdue(t: StatisticsTask, calendar: StatisticsCalendar): boolean {
  return t.due !== undefined && dayOf(t.due) < calendar.todayDay;
}
const AGE_LABELS = ['0–7', '8–14', '15–30', '31–60', '61+', 'Unknown'];
export function ageBand(value: number | undefined): number {
  if (value === undefined) return 5;
  const index = [7, 14, 30, 60].findIndex((limit) => value <= limit);
  return index < 0 ? 4 : index;
}
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p === 0.5) {
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0
      ? (required(values[mid - 1]) + required(values[mid])) / 2
      : required(values[mid]);
  }
  return required(values[Math.max(0, Math.ceil(values.length * p) - 1)]);
}
interface HistogramValue {
  value: number;
  index: number;
}
async function histogram(
  ctx: StatisticsContext,
  values: readonly HistogramValue[],
  options: { edges: readonly number[]; id: string; unit: string },
): Promise<StatisticsChartModel> {
  const { edges, id, unit } = options;
  const bins = edges.map(() => [] as number[]);
  for (const item of values) {
    let index = edges.findIndex((edge) => item.value <= edge);
    if (index < 0) index = edges.length - 1;
    required(bins[index]).push(item.index);
    await ctx.budget.step();
  }
  const labels = edges.map((end, i) => {
    if (i === 0) return `≤ ${end}`;
    return `${required(edges[i - 1]) + 1}–${end === Infinity ? '∞' : end}`;
  });
  return {
    id,
    accessibleLabel: id,
    kind: 'bars',
    x: bands(unit, labels),
    y: numeric('Tasks', Math.max(0, ...bins.map((bin) => bin.length))),
    series: [{ key: 'count', label: 'Tasks', tone: 'accent' }],
    marks: bins.map((bin, i) => ({
      key: `${id}:${i}`,
      x: required(labels[i]),
      y: bin.length,
      selectionId: ctx.evidence.tasks(`${id}:${i}`, bin),
    })),
  };
}
const EVENTS = ['created', 'completed', 'cancelled'] as const;
function addIndex(ids: Map<string, number[]>, key: string, index: number): void {
  const list = ids.get(key) ?? [];
  list.push(index);
  ids.set(key, list);
}
function rhythmTask(
  ctx: StatisticsContext,
  ids: Map<string, number[]>,
  task: StatisticsTask,
): void {
  const { calendar } = ctx;
  for (const event of EVENTS) {
    const day = datedEvent(task, event, calendar);
    if (!inPeriod(day, calendar)) continue;
    addIndex(ids, event, task.index);
    addIndex(
      ids,
      `${event}:${bucketAt(calendar, day)}:${task.recurring ? 'recurring' : 'one-off'}`,
      task.index,
    );
    if (event === 'created')
      addIndex(ids, `new-${active(task) ? 'open' : task.status}`, task.index);
  }
  unknownEvents(ctx, ids, task);
  currentAge(ctx, ids, task);
}
function unknownEvents(
  ctx: StatisticsContext,
  ids: Map<string, number[]>,
  task: StatisticsTask,
): void {
  if (datedEvent(task, 'created', ctx.calendar) === undefined)
    addIndex(ids, 'created-unknown', task.index);
  if (task.status === 'done' && datedEvent(task, 'completed', ctx.calendar) === undefined)
    addIndex(ids, 'completed-unknown', task.index);
  if (task.status === 'cancelled' && datedEvent(task, 'cancelled', ctx.calendar) === undefined)
    addIndex(ids, 'cancelled-unknown', task.index);
}
function currentAge(
  ctx: StatisticsContext,
  ids: Map<string, number[]>,
  task: StatisticsTask,
): void {
  const { calendar } = ctx;
  if (task.fileKind !== 'live' || !active(task)) return;
  addIndex(ids, 'open-now', task.index);
  const band = ageBand(age(task, calendar));
  addIndex(ids, `age:${band === 5 ? 'unknown' : band}`, task.index);
  addIndex(ids, `age:${band}:${overdue(task, calendar) ? 'overdue' : 'current'}`, task.index);
}
async function rhythmPopulation(ctx: StatisticsContext): Promise<Map<string, number[]>> {
  const ids = new Map<string, number[]>();
  for (const task of ctx.dataset.tasks) {
    if (inScope(task, ctx.request.scope)) rhythmTask(ctx, ids, task);
    await ctx.budget.step();
  }
  return ids;
}
function rhythmBucket(
  ctx: StatisticsContext,
  ids: Map<string, number[]>,
  bucket: number,
): StatisticsMark[] {
  const marks: StatisticsMark[] = [];
  let positive = 0,
    negative = 0;
  const series = EVENTS.flatMap((event) =>
    ['one-off', 'recurring'].map((recurring) => ({ event, recurring })),
  );
  for (const { event, recurring } of series) {
    const id = `${event}:${bucket}:${recurring}`,
      list = ids.get(id) ?? [],
      sign = event === 'created' ? 1 : -1,
      baseline = sign === 1 ? positive : negative;
    marks.push({
      key: id,
      x: required(ctx.calendar.buckets[bucket]).key,
      y: baseline + sign * list.length,
      y2: baseline,
      series: `${event}:${recurring}`,
      selectionId: ctx.evidence.tasks(id, list),
      weight: list.length,
    });
    if (sign === 1) positive += list.length;
    else negative -= list.length;
  }
  return marks;
}
async function rhythmChart(
  ctx: StatisticsContext,
  ids: Map<string, number[]>,
): Promise<StatisticsChartModel> {
  const marks: StatisticsMark[] = [];
  let magnitude = 0;
  for (let i = 0; i < ctx.calendar.buckets.length; i++) {
    for (const mark of rhythmBucket(ctx, ids, i)) {
      marks.push(mark);
      magnitude = Math.max(magnitude, Math.abs(Number(mark.y)));
    }
    await ctx.budget.step();
  }
  return {
    id: 'rhythm',
    accessibleLabel: 'Created, completed and cancelled retained tasks',
    kind: 'bars',
    layout: 'diverging',
    x: bands(
      'Date',
      ctx.calendar.buckets.map((b) => b.key),
    ),
    y: numeric('Tasks', magnitude, -magnitude),
    series: EVENTS.flatMap((event) =>
      ['one-off', 'recurring'].map((r) => ({
        key: `${event}:${r}`,
        label: `${event} · ${r}`,
        tone: event,
        muted: r === 'recurring',
      })),
    ),
    marks,
  };
}
function ageChart(ctx: StatisticsContext, ids: Map<string, number[]>): StatisticsChartModel {
  const marks: StatisticsMark[] = [];
  for (let i = 0; i < 6; i++) {
    ctx.evidence.tasks(
      `age:${i === 5 ? 'unknown' : i}`,
      ids.get(`age:${i === 5 ? 'unknown' : i}`) ?? [],
    );
    let base = 0;
    for (const state of ['current', 'overdue']) {
      const id = `age:${i}:${state}`,
        list = ids.get(id) ?? [];
      marks.push({
        key: id,
        x: required(AGE_LABELS[i]),
        y: base + list.length,
        y2: base,
        series: state,
        selectionId: ctx.evidence.tasks(id, list),
        weight: list.length,
      });
      base += list.length;
    }
  }
  return {
    id: 'ages',
    accessibleLabel: 'Current open task ages',
    kind: 'bars',
    layout: 'stacked',
    x: bands('Age in days', AGE_LABELS),
    y: numeric('Tasks', Math.max(0, ...marks.map((m) => Number(m.y)))),
    series: [
      { key: 'current', label: 'Not overdue', tone: 'neutral' },
      { key: 'overdue', label: 'Overdue', tone: 'overdue' },
    ],
    marks,
  };
}
const RHYTHM_LABELS: Record<string, string> = {
  created: 'Created',
  completed: 'Completed',
  cancelled: 'Cancelled',
  'new-open': 'New tasks still open',
  'new-done': 'New tasks now done',
  'new-cancelled': 'New tasks now cancelled',
  'open-now': 'Open now',
  'created-unknown': 'Creation date unavailable or future',
  'completed-unknown': 'Completion date unavailable or future',
  'cancelled-unknown': 'Cancellation date unavailable or future',
};
async function rhythm(ctx: StatisticsContext): Promise<StatisticsSection[]> {
  const ids = await rhythmPopulation(ctx),
    chart = await rhythmChart(ctx, ids);
  const metrics = [
    'created',
    'completed',
    'cancelled',
    'new-open',
    'new-done',
    'new-cancelled',
    'open-now',
    'created-unknown',
    'completed-unknown',
    'cancelled-unknown',
  ].map((id) =>
    metric(
      id,
      required(RHYTHM_LABELS[id]),
      (ids.get(id) ?? []).length,
      ctx.evidence.tasks(id, ids.get(id) ?? []),
    ),
  );
  return [
    {
      id: 'events',
      title: 'Recorded task events',
      context: 'Current outcomes of new tasks are separate from recorded completions.',
      metrics,
      charts: [chart],
      legend: chart.series,
    },
    {
      id: 'current',
      title: 'Open now',
      context: 'Live tasks; overdue means the saved due date is before today.',
      metrics: [],
      charts: [ageChart(ctx, ids)],
      legend: [],
    },
  ];
}
async function completion({
  dataset,
  request,
  calendar: c,
  evidence: e,
  budget: b,
}: StatisticsContext): Promise<StatisticsSection[]> {
  const pairs: Array<{
      value: number;
      index: number;
    }> = [],
    missing: number[] = [];
  for (const t of dataset.tasks) {
    if (inScope(t, request.scope) && !t.recurring && t.status === 'done') {
      const end = datedEvent(t, 'completed', c);
      if (inPeriod(end, c) && t.created !== undefined && dayOf(t.created) <= end)
        pairs.push({ value: end - dayOf(t.created), index: t.index });
      else if (end === undefined || inPeriod(end, c)) missing.push(t.index);
    }
    await b.step();
  }
  const values = (await sorted(pairs, (a, z) => a.value - z.value, b)).map((p) => p.value);
  return [
    {
      id: 'completion',
      title: 'Recorded completion age',
      context: 'One-off tasks with valid creation/completion dates; this is not active cycle time.',
      metrics: [
        metric(
          'valid-pairs',
          'Valid pairs',
          pairs.length,
          e.tasks(
            'valid-pairs',
            pairs.map((p) => p.index),
          ),
        ),
        metric(
          'missing-pairs',
          'Unknown or invalid timing',
          missing.length,
          e.tasks('missing-pairs', missing),
        ),
        metric('median', 'Median', percentile(values, 0.5), {
          selectionId: undefined,
          unit: 'days',
        }),
        metric('p90', 'P90', percentile(values, 0.9), { selectionId: undefined, unit: 'days' }),
      ],
      charts: [
        await histogram({ dataset, request, calendar: c, evidence: e, budget: b }, pairs, {
          edges: [0, 1, 3, 7, 14, 30, 60, Infinity],
          id: 'completion-age',
          unit: 'Civil days',
        }),
      ],
      legend: [],
    },
  ];
}
function deadlineOutcome(t: StatisticsTask, c: StatisticsCalendar): string {
  if (t.status === 'cancelled') return 'cancelled';
  if (active(t)) return overdue(t, c) ? 'overdue' : 'upcoming';
  const end = datedEvent(t, 'completed', c);
  if (end === undefined) return 'unknown';
  return end <= dayOf(required(t.due)) ? 'on-time' : 'late';
}
async function deadlines({
  dataset,
  request: r,
  calendar: c,
  evidence: e,
  budget: b,
}: StatisticsContext): Promise<StatisticsSection[]> {
  const groups = new Map<string, number[]>(),
    deltas: Array<{
      value: number;
      index: number;
    }> = [];
  for (const t of dataset.tasks) {
    if (inScope(t, r.scope) && t.due !== undefined && inPeriod(dayOf(t.due), c)) {
      const outcome = deadlineOutcome(t, c);
      const list = groups.get(outcome) ?? [];
      list.push(t.index);
      groups.set(outcome, list);
      const end = datedEvent(t, 'completed', c);
      if (end !== undefined) deltas.push({ value: end - dayOf(t.due), index: t.index });
    }
    await b.step();
  }
  const keys = ['on-time', 'late', 'overdue', 'upcoming', 'cancelled', 'unknown'];
  const marks: StatisticsMark[] = [];
  let base = 0;
  for (const key of keys) {
    const list = groups.get(key) ?? [];
    marks.push({
      key,
      x: 'Saved due dates',
      y: base + list.length,
      y2: base,
      weight: list.length,
      series: key,
      selectionId: e.tasks(`deadline:${key}`, list),
    });
    base += list.length;
  }
  return [
    {
      id: 'deadlines',
      title: 'Against currently saved due dates',
      context: 'Current outcomes; edits to due dates change this comparison.',
      metrics: keys.map((key) =>
        metric(key, key, (groups.get(key) ?? []).length, `deadline:${key}`),
      ),
      charts: [
        {
          id: 'deadline-outcomes',
          accessibleLabel: 'Current outcomes against saved due dates',
          kind: 'bars',
          layout: 'stacked',
          x: bands('Due cohort', ['Saved due dates']),
          y: numeric('Tasks', base),
          series: keys.map((key) => ({
            key,
            label: key,
            tone: key === 'overdue' ? 'overdue' : 'accent',
          })),
          marks,
        },
        {
          ...(await histogram(
            { dataset, request: r, calendar: c, evidence: e, budget: b },
            deltas,
            {
              edges: [-7, -1, 0, 1, 3, 7, 30, Infinity],
              id: 'due-delta',
              unit: 'Completion minus due',
            },
          )),
          accessibleLabel: 'Completion minus saved due date',
        },
      ],
      legend: [],
    },
  ];
}
interface Cohort {
  indices: number[];
  youngest: number;
  within: number[];
  unknown: number;
  cancelled: number;
}
const HORIZONS = [1, 3, 7, 14, 30];
function cohortOutcome(
  task: StatisticsTask,
  horizon: number,
  calendar: StatisticsCalendar,
): 'within' | 'later' | 'open' | 'cancelled' | 'unknown' {
  if (task.status === 'cancelled') return 'cancelled';
  if (active(task)) return 'open';
  const end = datedEvent(task, 'completed', calendar),
    created = dayOf(required(task.created));
  if (end === undefined || end < created) return 'unknown';
  return end - created <= horizon ? 'within' : 'later';
}
function countCohort(cohort: Cohort, task: StatisticsTask, calendar: StatisticsCalendar): void {
  cohort.indices.push(task.index);
  cohort.youngest = Math.max(cohort.youngest, dayOf(required(task.created)));
  const initial = cohortOutcome(task, 1, calendar);
  if (initial === 'cancelled') cohort.cancelled++;
  if (initial === 'unknown') cohort.unknown++;
  for (let i = 0; i < HORIZONS.length; i++)
    if (cohortOutcome(task, required(HORIZONS[i]), calendar) === 'within')
      cohort.within[i] = required(cohort.within[i]) + 1;
}
function cohortContext(
  task: StatisticsTask,
  horizon: number,
  calendar: StatisticsCalendar,
): string {
  const outcome = cohortOutcome(task, horizon, calendar);
  const labels = {
    within: `Within ${horizon} days`,
    later: `Later than ${horizon} days`,
    open: 'Open',
    cancelled: 'Cancelled',
    unknown: 'Unknown timing',
  };
  return labels[outcome];
}
async function cohortGroups(ctx: StatisticsContext): Promise<Map<number, Cohort>> {
  const groups = new Map<number, Cohort>();
  for (const task of ctx.dataset.tasks) {
    const created = datedEvent(task, 'created', ctx.calendar);
    if (inScope(task, ctx.request.scope) && inPeriod(created, ctx.calendar)) {
      const week = weekFloor(created, ctx.request.firstDayOfWeek),
        cohort = groups.get(week) ?? {
          indices: [],
          youngest: -Infinity,
          within: [0, 0, 0, 0, 0],
          unknown: 0,
          cancelled: 0,
        };
      countCohort(cohort, task, ctx.calendar);
      groups.set(week, cohort);
    }
    await ctx.budget.step();
  }
  return groups;
}
function cohortState(mature: boolean, unknown: number): StatisticsMark['state'] {
  if (!mature) return 'immature';
  return unknown > 0 ? 'unknown' : 'measured';
}
function cohortMarks(ctx: StatisticsContext, week: number, cohort: Cohort): StatisticsMark[] {
  return HORIZONS.map((horizon, i) => {
    const mature = ctx.calendar.todayDay > cohort.youngest + horizon,
      within = required(cohort.within[i]);
    return {
      key: `${week}:${horizon}`,
      x: horizon,
      y: dateOf(week),
      state: cohortState(mature, cohort.unknown),
      weight: mature && cohort.unknown === 0 ? (within / cohort.indices.length) * 100 : undefined,
      numerator: within,
      denominator: cohort.indices.length,
      selectionId: ctx.evidence.rows(
        `cohort:${week}:${horizon}`,
        cohort.indices.length,
        (index) => {
          const task = required(ctx.dataset.tasks[required(cohort.indices[index])]);
          return ctx.evidence.taskRow(task, cohortContext(task, horizon, ctx.calendar));
        },
      ),
      detail: `${within} within ${horizon} days; ${cohort.cancelled} cancelled; ${cohort.unknown} unknown timing`,
    };
  });
}
async function cohorts(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  const groups = await cohortGroups(ctx),
    weeks = await sorted([...groups.keys()], (a, z) => z - a, ctx.budget),
    page = Math.max(0, Math.floor(ctx.request.page ?? 0)),
    shown = weeks.slice(page * 104, (page + 1) * 104),
    marks: StatisticsMark[] = [];
  for (const week of shown) {
    marks.push(...cohortMarks(ctx, week, required(groups.get(week))));
    await ctx.budget.step();
  }
  return finish(
    ctx,
    [
      {
        id: 'cohorts',
        title: 'Weekly creation cohorts',
        context:
          'N includes cancellations. A horizon matures after the youngest creation completes its final horizon day.',
        metrics: [metric('cohorts', 'Cohorts', weeks.length)],
        charts: [
          {
            id: 'cohorts',
            accessibleLabel: 'Completion within fixed horizons by creation week',
            kind: 'heatmap',
            x: numeric('Horizon days', 30),
            y: bands('Creation week', shown.map(dateOf)),
            series: [],
            marks,
          },
        ],
        legend: [],
      },
    ],
    [
      ...pageActions(page, weeks.length, 104),
      { type: 'period', label: 'Include older cohorts', period: 'all' },
    ],
  );
}
export async function flowView(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  if (ctx.request.view === 'cohorts') return cohorts(ctx);
  const builders = { rhythm, completion, deadlines };
  const view = ctx.request.view;
  const builder = view === 'rhythm' || view === 'completion' ? builders[view] : deadlines;
  return finish(ctx, await builder(ctx));
}
