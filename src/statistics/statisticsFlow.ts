import {
  bucketAt,
  dateInterval,
  dateOf,
  dayOf,
  weekFloor,
  type StatisticsBucket,
  type StatisticsCalendar,
} from './statisticsCalendar';
import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { active, inScope } from './statisticsDataset';
import { dateProblem } from './statisticsDates';
import { finish, metric } from './statisticsViews';
import { required, sorted } from './statisticsWork';
import type {
  StatisticsAction,
  StatisticsContext,
  StatisticsMetric,
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
type EligibilityField = 'created' | 'completed' | 'cancelled' | 'due';
function dateApplies(task: StatisticsTask, field: EligibilityField): boolean {
  if (field === 'completed') return task.status === 'done';
  if (field === 'cancelled') return task.status === 'cancelled';
  return true;
}
async function datePopulation(
  ctx: StatisticsContext,
  field: EligibilityField,
): Promise<readonly [number[], number[]]> {
  const known: number[] = [],
    unavailable: number[] = [];
  for (const task of ctx.dataset.tasks) {
    if (
      (ctx.request.view !== 'cohorts' || !task.recurring) &&
      dateApplies(task, field) &&
      inScope(task, ctx.request.scope)
    ) {
      const valid =
        field === 'due'
          ? task.due !== undefined
          : datedEvent(task, field, ctx.calendar) !== undefined;
      (valid ? known : unavailable).push(task.index);
    }
    await ctx.budget.step();
  }
  return [known, unavailable];
}
/** Scope-wide applicability, independent of the selected-period event numerator. */
export async function dateEligibility(
  ctx: StatisticsContext,
  fields: readonly EligibilityField[],
): Promise<StatisticsMetric[]> {
  const metrics: StatisticsMetric[] = [];
  for (const field of fields) {
    const [known, unavailable] = await datePopulation(ctx, field);
    for (const [state, indices] of [
      ['known', known],
      ['unavailable', unavailable],
    ] as const) {
      const id = `${field}-${state}`;
      metrics.push({
        ...metric(id, `${field} date · ${state} in scope`, indices.length, {
          role: 'coverage',
          selectionId: ctx.evidence.tasks(id, indices),
        }),
        context:
          field === 'due'
            ? 'Saved due-date availability across this scope, including future planning; independent of period outcomes.'
            : 'Date availability by as-of across this scope, independent of period events; terminal dates apply only to the matching current terminal status.',
      });
    }
  }
  return metrics;
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
function histogramLabel(id: string, label: string): string {
  return id === 'due-delta' || label === 'Same day' ? label : `${label} days`;
}
function completionContext(task: StatisticsTask): string {
  return `Created ${task.created} · Completed ${task.completion} · ${dayOf(required(task.completion)) - dayOf(required(task.created))} days`;
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
  const labels =
    id === 'due-delta'
      ? [
          '7+ days early',
          '1–6 days early',
          'On due date',
          '1 day late',
          '2–3 days late',
          '4–7 days late',
          '8–30 days late',
          '31+ days late',
        ]
      : ['Same day', '1', '2–3', '4–7', '8–14', '15–30', '31–60', '61+'];
  return {
    id,
    accessibleLabel:
      id === 'completion-age'
        ? 'Days from creation to completion for one-off tasks completed in this period'
        : id,
    kind: 'bars',
    x: bands(unit, labels),
    y: numeric('Tasks', Math.max(0, ...bins.map((bin) => bin.length)), 0, 'count'),
    series: [{ key: 'count', label: 'Tasks', tone: 'accent' }],
    marks: bins.map((bin, i) => ({
      key: `${id}:${i}`,
      x: required(labels[i]),
      y: bin.length,
      selectionId: contextualTasks(ctx, `${id}:${i}`, bin, (task) =>
        id === 'due-delta' ? deadlineContext(task, ctx.calendar) : completionContext(task),
      ),
      observation: {
        title: histogramLabel(id, required(labels[i])),
        values: [{ label: 'Completions', value: bin.length, unit: 'tasks' }],
      },
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
    if (event === 'created') addIndex(ids, `new-${task.status}`, task.index);
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
  if (task.status === 'in-progress') addIndex(ids, 'in-progress-now', task.index);
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
function bucketNote(bucket: StatisticsBucket): string {
  return bucket.partial === true ? `Partial ${bucket.granularity}. ` : '';
}
function rhythmBucket(
  ctx: StatisticsContext,
  ids: Map<string, number[]>,
  bucket: number,
): StatisticsMark[] {
  const marks: StatisticsMark[] = [];
  let positive = 0,
    negative = 0;
  for (const event of EVENTS) {
    const id = `${event}:${bucket}`,
      list = ['one-off', 'recurring'].flatMap((r) => ids.get(`${id}:${r}`) ?? []),
      recurring = (ids.get(`${id}:recurring`) ?? []).length,
      sign = event === 'created' ? 1 : -1,
      baseline = sign === 1 ? positive : negative,
      interval = required(ctx.calendar.buckets[bucket]);
    marks.push({
      key: id,
      x: interval.key,
      y: baseline + sign * list.length,
      y2: baseline,
      series: event,
      selectionId: ctx.evidence.tasks(id, list),
      weight: list.length,
      observation: {
        title: `${dateInterval(interval.fromDay, interval.toDay)} · ${required(RHYTHM_LABELS[event])}`,
        values: [{ label: 'Count', value: list.length, unit: 'tasks' }],
        note: `${bucketNote(interval)}${recurring} recurring retained instances included.`,
      },
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
      '',
      ctx.calendar.buckets.map((b) => b.key),
    ),
    y: {
      ...numeric('Tasks', magnitude, -magnitude, 'count'),
      tickLabels: [-magnitude, 0, magnitude].map(
        (value) => [value, String(Math.abs(value))] as const,
      ),
    },
    series: EVENTS.map((event) => ({
      key: event,
      label: required(RHYTHM_LABELS[event]),
      tone: event,
    })),
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
        observation: {
          title: `${required(AGE_LABELS[i])} days · ${state === 'overdue' ? 'Overdue' : 'Not overdue'}`,
          values: [{ label: 'Count', value: list.length, unit: 'tasks' }],
        },
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
    y: numeric('Tasks', Math.max(0, ...marks.map((m) => Number(m.y))), 0, 'count'),
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
  'new-open': 'Not started',
  'new-in-progress': 'In progress',
  'new-done': 'Completed',
  'new-cancelled': 'Cancelled',
  'in-progress-now': 'Including In progress',
  'open-now': 'Open now',
  'created-unknown': 'Creation date unavailable or future',
  'completed-unknown': 'Completion date unavailable or future',
  'cancelled-unknown': 'Cancellation date unavailable or future',
};
function newOutcomes(metrics: readonly StatisticsMetric[]): StatisticsSection {
  const values = metrics.filter((value) => value.id.startsWith('new-'));
  const series = values.map((value, index) => ({
    key: value.id,
    label: value.label,
    tone: required((['neutral', 'progress', 'completed', 'cancelled'] as const)[index]),
  }));
  const denominator = values.reduce((sum, value) => sum + (value.value ?? 0), 0);
  let total = 0;
  const marks = values.map((value) => {
    const start = total;
    total += value.value ?? 0;
    return {
      key: value.id,
      series: value.id,
      x: start,
      x2: total,
      y: 'New tasks',
      weight: value.value ?? 0,
      selectionId: value.selectionId,
      observation: {
        title: value.label,
        values: [
          { label: 'Count', value: value.value, unit: 'tasks' },
          { label: 'Created in period', value: denominator, unit: 'tasks' },
        ],
      },
    };
  });
  return {
    id: 'new-outcomes',
    title: `Of ${total} new tasks`,
    context: 'Tasks created in the selected period, classified by their current state.',
    metrics: [],
    legend: series,
    charts: [
      {
        id: 'new-outcomes',
        accessibleLabel: 'Current outcomes of new tasks',
        kind: 'bars',
        layout: 'stacked',
        x: numeric('Tasks', total, 0, 'count'),
        y: bands('', ['New tasks']),
        series,
        marks,
      },
    ],
  };
}
async function rhythm(ctx: StatisticsContext): Promise<StatisticsSection[]> {
  const ids = await rhythmPopulation(ctx),
    chart = await rhythmChart(ctx, ids);
  const metrics = [
    'created',
    'completed',
    'cancelled',
    'new-open',
    'new-in-progress',
    'new-done',
    'new-cancelled',
    'open-now',
    'in-progress-now',
    'created-unknown',
    'completed-unknown',
    'cancelled-unknown',
  ].map((id) =>
    metric(id, required(RHYTHM_LABELS[id]), (ids.get(id) ?? []).length, {
      selectionId: ctx.evidence.tasks(id, ids.get(id) ?? []),
      role: id.endsWith('-unknown') ? 'coverage' : undefined,
    }),
  );
  return [
    {
      id: 'events',
      title: 'Recorded task dates',
      reading:
        'Created above zero; completed and cancelled below. Retained dates and current statuses can change earlier totals.',
      context: 'Current outcomes of new tasks are separate from recorded completions.',
      metrics: metrics.filter(
        (value) =>
          !value.id.startsWith('new-') && value.id !== 'open-now' && value.id !== 'in-progress-now',
      ),
      charts: [chart],
      legend: chart.series,
    },
    newOutcomes(metrics),
    {
      id: 'current',
      title: `Open now · ${dateOf(ctx.calendar.todayDay)}`,
      context: 'Live tasks; overdue means the saved due date is before today.',
      reading: 'Current live open work, including In progress; independent of the selected period.',
      metrics: metrics.filter((value) => value.id === 'open-now' || value.id === 'in-progress-now'),
      charts: [ageChart(ctx, ids)],
      legend: [],
    },
  ];
}
const DATE_REASONS: Record<string, string> = {
  'creation-missing': 'Creation date missing',
  'creation-invalid': 'Creation date invalid or ambiguous',
  'creation-reversed': 'Completion before creation',
  'completion-missing': 'Completion date missing',
  'completion-invalid': 'Completion date invalid or ambiguous',
  'completion-future': 'Completion date after today',
};
function contextualTasks(
  ctx: StatisticsContext,
  id: string,
  indices: readonly number[],
  context: (task: StatisticsTask) => string,
): string {
  return ctx.evidence.rows(id, indices.length, (index) => {
    const task = required(ctx.dataset.tasks[required(indices[index])]);
    return ctx.evidence.taskRow(task, context(task));
  });
}
function completionReason(task: StatisticsTask, ctx: StatisticsContext): string | undefined {
  const problem = dateProblem(task, 'completion', ctx.calendar);
  if (problem !== undefined) return `completion-${problem}`;
  const end = dayOf(required(task.completion));
  if (!inPeriod(end, ctx.calendar)) return undefined;
  const creation = dateProblem(task, 'created', ctx.calendar);
  if (creation === 'invalid' || creation === 'missing') return `creation-${creation}`;
  if (dayOf(required(task.created)) > end) return 'creation-reversed';
  return undefined;
}
async function completion(ctx: StatisticsContext): Promise<StatisticsSection[]> {
  const pairs: Array<{ value: number; index: number }> = [],
    groups = new Map<string, number[]>();
  for (const t of ctx.dataset.tasks) {
    if (inScope(t, ctx.request.scope) && !t.recurring && t.status === 'done') {
      const reason = completionReason(t, ctx),
        end = datedEvent(t, 'completed', ctx.calendar);
      if (reason !== undefined) addIndex(groups, reason, t.index);
      else if (inPeriod(end, ctx.calendar))
        pairs.push({ value: end - dayOf(required(t.created)), index: t.index });
    }
    await ctx.budget.step();
  }
  const values = (await sorted(pairs, (a, z) => a.value - z.value, ctx.budget)).map((p) => p.value);
  const excluded = ['creation-missing', 'creation-invalid', 'creation-reversed'].flatMap(
    (id) => groups.get(id) ?? [],
  );
  const problemMetrics = Object.entries(DATE_REASONS).map(([id, reason]) => {
    const indices = groups.get(id) ?? [];
    return metric(
      id,
      id.startsWith('completion-') ? `${reason} · scope-wide` : reason,
      indices.length,
      {
        selectionId: contextualTasks(ctx, id, indices, () => reason),
        role: id.startsWith('completion-') ? 'coverage' : undefined,
      },
    );
  });
  return [
    {
      id: 'completion',
      title: 'Time from creation to completion',
      reading:
        'One-off tasks and subtasks completed in this period · days from their saved creation dates.',
      context:
        'Measured completions require usable creation/completion dates. Undatable completions are scope-wide coverage, independent of this period.',
      emptyMessage:
        pairs.length === 0 ? 'No usable creation-to-completion pairs in this period.' : undefined,
      metrics: [
        metric(
          'valid-pairs',
          'Measured completions',
          pairs.length,
          contextualTasks(
            ctx,
            'valid-pairs',
            pairs.map((p) => p.index),
            completionContext,
          ),
        ),
        metric('missing-pairs', 'Excluded creations in period', excluded.length, {
          role: 'coverage',
          selectionId: contextualTasks(ctx, 'missing-pairs', excluded, (t) =>
            required(DATE_REASONS[required(completionReason(t, ctx))]),
          ),
        }),
        ...problemMetrics,
        metric('median', 'Median', percentile(values, 0.5), { unit: 'days' }),
        metric('p90', '90% completed within', percentile(values, 0.9), { unit: 'days' }),
      ],
      charts: [
        await histogram(ctx, pairs, {
          edges: [0, 1, 3, 7, 14, 30, 60, Infinity],
          id: 'completion-age',
          unit: 'Days',
        }),
      ],
      legend: [],
    },
  ];
}
function deadlineOutcome(t: StatisticsTask, c: StatisticsCalendar): string {
  if (t.status === 'cancelled') return 'cancelled';
  if (active(t)) {
    if (t.fileKind === 'archive') return 'archived-open';
    return overdue(t, c) ? 'overdue' : 'upcoming';
  }
  const end = datedEvent(t, 'completed', c);
  if (end === undefined) return 'unknown';
  return end <= dayOf(required(t.due)) ? 'on-time' : 'late';
}
const DEADLINE_LABELS: Record<string, string> = {
  'on-time': 'Completed on time',
  late: 'Completed late',
  overdue: 'Due cohort · overdue',
  upcoming: 'Due today',
  cancelled: 'Cancelled',
  unknown: 'Completion date unavailable',
  'archived-open': 'Archived open',
};
function deadlineContext(task: StatisticsTask, calendar: StatisticsCalendar): string {
  const problem = dateProblem(task, 'completion', calendar);
  if (task.status === 'done' && problem !== undefined) {
    const reason = required(DATE_REASONS[`completion-${problem}`]);
    return `Due ${task.due} · ${reason}`;
  }
  if (task.status === 'done')
    return `Due ${task.due} · Completed ${task.completion} · ${dayOf(required(task.completion)) - dayOf(required(task.due))} days after due`;
  return `Due ${task.due} · ${required(DEADLINE_LABELS[deadlineOutcome(task, calendar)])}`;
}
async function deadlinePopulation(
  ctx: StatisticsContext,
): Promise<{ groups: Map<string, number[]>; deltas: Array<{ value: number; index: number }> }> {
  const groups = new Map<string, number[]>(),
    deltas: Array<{ value: number; index: number }> = [];
  for (const t of ctx.dataset.tasks) {
    if (inScope(t, ctx.request.scope) && t.due !== undefined) {
      if (inPeriod(dayOf(t.due), ctx.calendar))
        addIndex(groups, deadlineOutcome(t, ctx.calendar), t.index);
      const end = datedEvent(t, 'completed', ctx.calendar);
      if (inPeriod(end, ctx.calendar)) deltas.push({ value: end - dayOf(t.due), index: t.index });
    }
    await ctx.budget.step();
  }
  return { groups, deltas };
}
async function dueCoverage(ctx: StatisticsContext): Promise<StatisticsMetric[]> {
  const groups = new Map<string, number[]>();
  for (const task of ctx.dataset.tasks) {
    if (inScope(task, ctx.request.scope)) {
      const reason = dateProblem(task, 'due', ctx.calendar);
      if (reason !== undefined) addIndex(groups, reason, task.index);
    }
    await ctx.budget.step();
  }
  return (['missing', 'invalid'] as const).map((reason) => {
    const id = `due-${reason}`,
      label = reason === 'missing' ? 'No due date' : 'Due date invalid or ambiguous';
    const indices = groups.get(reason) ?? [];
    return metric(id, `${label} · scope-wide`, indices.length, {
      role: 'coverage',
      selectionId: contextualTasks(ctx, id, indices, () => label),
    });
  });
}
async function deadlines(ctx: StatisticsContext): Promise<StatisticsSection[]> {
  const { groups, deltas } = await deadlinePopulation(ctx),
    keys = Object.keys(DEADLINE_LABELS);
  const { marks, maximum } = await deadlineMarks(ctx, groups, keys);
  const series = keys.map((key, index) => ({
    key,
    label: required(DEADLINE_LABELS[key]),
    tone: required(
      (['completed', 'cancelled', 'overdue', 'created', 'neutral', 'muted', 'muted'] as const)[
        index
      ],
    ),
  }));
  return [
    {
      id: 'deadlines',
      title: 'Tasks due in this period',
      reading: `Saved outcomes as of ${dateOf(ctx.calendar.todayDay)}; due-date edits change this comparison.`,
      context:
        'Retained tasks and subtasks due in this period. Archived open records are separate from live work.',
      emptyMessage: maximum === 0 ? 'No tasks due in this period.' : undefined,
      metrics: [
        ...keys.map((key) =>
          metric(key, required(DEADLINE_LABELS[key]), (groups.get(key) ?? []).length, {
            role: 'coverage',
            selectionId: `deadline:${key}`,
          }),
        ),
        ...(await dateEligibility(ctx, ['due'])),
        ...(await dueCoverage(ctx)),
      ],
      charts: [
        {
          id: 'deadline-outcomes',
          accessibleLabel: 'Current outcomes of tasks due in this period',
          kind: 'bars',
          layout: 'stacked',
          x: bands(
            'Due cohort',
            ctx.calendar.buckets.map((bucket) => bucket.key),
          ),
          y: numeric('Tasks', maximum, 0, 'count'),
          series,
          marks,
        },
      ],
      legend: series,
    },
    await latenessSection(ctx, deltas),
  ];
}
async function latenessSection(
  ctx: StatisticsContext,
  deltas: Array<{ value: number; index: number }>,
): Promise<StatisticsSection> {
  return {
    id: 'lateness',
    title: 'How early or late completed tasks finished',
    reading: 'Tasks and subtasks completed in this period with usable saved due dates · days.',
    context: 'Completion-period population; due dates may be outside the selected period.',
    emptyMessage:
      deltas.length === 0
        ? 'No dated completions with usable due dates in this period.'
        : undefined,
    metrics: [
      metric(
        'dated-completions',
        'Measured completions',
        deltas.length,
        contextualTasks(
          ctx,
          'dated-completions',
          deltas.map((p) => p.index),
          (t) => deadlineContext(t, ctx.calendar),
        ),
      ),
    ],
    charts: [
      {
        ...(await histogram(ctx, deltas, {
          edges: [-7, -1, 0, 1, 3, 7, 30, Infinity],
          id: 'due-delta',
          unit: 'Days from due date',
        })),
        accessibleLabel: 'Completion minus saved due date for tasks completed in this period',
      },
    ],
    legend: [],
  };
}
async function deadlineMarks(
  ctx: StatisticsContext,
  groups: Map<string, number[]>,
  keys: readonly string[],
): Promise<{ marks: StatisticsMark[]; maximum: number }> {
  const { calendar: c, budget: b, dataset } = ctx;
  const marks: StatisticsMark[] = [];
  const buckets = c.buckets.map(() => new Map<string, number[]>());
  for (const [key, indices] of groups) {
    contextualTasks(ctx, `deadline:${key}`, indices, (t) => deadlineContext(t, c));
    for (const index of indices) {
      const task = required(dataset.tasks[index]);
      const bucket = required(buckets[bucketAt(c, dayOf(required(task.due)))]);
      const list = bucket.get(key) ?? [];
      list.push(index);
      bucket.set(key, list);
      await b.step();
    }
  }
  let maximum = 0;
  for (let i = 0; i < buckets.length; i++) {
    let base = 0;
    for (const key of keys) {
      const list = required(buckets[i]).get(key) ?? [];
      marks.push({
        key: `${i}:${key}`,
        x: required(c.buckets[i]).key,
        y: base + list.length,
        y2: base,
        weight: list.length,
        series: key,
        selectionId: contextualTasks(ctx, `deadline:${i}:${key}`, list, (t) =>
          deadlineContext(t, c),
        ),
        observation: {
          note: bucketNote(required(c.buckets[i])),
          title: `Due ${dateInterval(required(c.buckets[i]).fromDay, required(c.buckets[i]).toDay)} · ${required(DEADLINE_LABELS[key])}`,
          values: [{ label: 'Count', value: list.length, unit: 'tasks' }],
        },
      });
      base += list.length;
    }
    maximum = Math.max(maximum, base);
  }
  return { marks, maximum };
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
    if (!task.recurring && inScope(task, ctx.request.scope) && inPeriod(created, ctx.calendar)) {
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
function cohortText(mature: boolean, unknown: number, percent: number): string {
  if (!mature) return '…';
  return unknown > 0 ? '?' : `${Number(percent.toFixed(1))}%`;
}
function cohortMaturity(mature: boolean, unknown: number): string {
  if (!mature) return 'Not yet observable';
  return unknown > 0 ? 'Unknown completion timing' : 'Mature';
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
      displayText: cohortText(mature, cohort.unknown, (within / cohort.indices.length) * 100),
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
      observation: {
        title: `Created ${dateInterval(Math.max(week, ctx.calendar.fromDay), Math.min(week + 7, ctx.calendar.toDay))} · Completed within ${horizon} days`,
        values: [
          { label: 'Completed', value: within, unit: 'tasks' },
          { label: 'Cohort', value: cohort.indices.length, unit: 'tasks' },
          {
            label: 'Share',
            value: mature && cohort.unknown === 0 ? (within / cohort.indices.length) * 100 : null,
            unit: '%',
          },
          {
            label: 'Maturity',
            value: cohortMaturity(mature, cohort.unknown),
          },
        ],
        note: `${week < ctx.calendar.fromDay || week + 7 > ctx.calendar.toDay ? 'Partial week. ' : ''}${cohort.cancelled} cancelled; ${cohort.unknown} unknown timing.`,
      },
      detail: `${within} within ${horizon} days; ${cohort.cancelled} cancelled; ${cohort.unknown} unknown timing`,
    };
  });
}
async function cohorts(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  const groups = await cohortGroups(ctx),
    weeks = await sorted([...groups.keys()], (a, z) => z - a, ctx.budget),
    size = ctx.request.cohortsExpanded === true ? 104 : 8,
    requestedPage = Number.isFinite(ctx.request.page)
      ? Math.max(0, Math.floor(ctx.request.page ?? 0))
      : 0,
    page =
      ctx.request.cohortsExpanded === true
        ? Math.min(requestedPage, Math.max(0, Math.ceil(weeks.length / size) - 1))
        : 0,
    shown = weeks.slice(page * size, (page + 1) * size),
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
        title: 'Completed within days of creation',
        reading:
          'One-off tasks and subtasks · cancellations included. Partial weeks use only included creation dates.',
        context:
          'N includes cancellations. A horizon matures after the youngest creation completes its final horizon day.',
        metrics: [
          metric('cohorts', 'Cohorts', weeks.length),
          ...(await dateEligibility(ctx, ['created'])),
        ],
        charts: [
          {
            id: 'cohorts',
            accessibleLabel: 'Completion within fixed horizons by creation week',
            kind: 'heatmap',
            intensityScale: { domain: [0, 100], unit: '%' },
            x: {
              ...numeric('Completed within', 30, 0, 'days'),
              ticks: HORIZONS,
              tickLabels: HORIZONS.map((value) => [value, `${value} days`] as const),
            },
            y: {
              ...bands('Creation week', shown.map(dateOf)),
              tickLabels: shown.map(
                (week) =>
                  [
                    dateOf(week),
                    `${dateInterval(Math.max(week, ctx.calendar.fromDay), Math.min(week + 7, ctx.calendar.toDay))} · ${required(groups.get(week)).indices.length} tasks${week < ctx.calendar.fromDay || week + 7 > ctx.calendar.toDay ? ' · partial' : ''}`,
                  ] as const,
              ),
            },
            series: [],
            marks,
          },
        ],
        legend: [],
      },
    ],
    cohortActions(ctx, page, weeks.length),
  );
}
function cohortActions(ctx: StatisticsContext, page: number, total: number): StatisticsAction[] {
  if (total <= 8) return [];
  const expanded = ctx.request.cohortsExpanded === true;
  const actions: StatisticsAction[] = [
    {
      type: 'cohorts',
      label: expanded ? 'Show recent cohorts' : 'Show older cohorts',
      expanded: !expanded,
    },
  ];
  if (expanded && page > 0) actions.push({ type: 'page', label: 'Newer weeks', page: page - 1 });
  if (expanded && (page + 1) * 104 < total)
    actions.push({ type: 'page', label: 'Older weeks', page: page + 1 });
  return actions;
}
export async function flowView(ctx: StatisticsContext): Promise<StatisticsViewModel> {
  if (ctx.request.view === 'cohorts') return cohorts(ctx);
  const builders = { rhythm, completion, deadlines };
  const view = ctx.request.view;
  const builder = view === 'rhythm' || view === 'completion' ? builders[view] : deadlines;
  return finish(ctx, await builder(ctx));
}
