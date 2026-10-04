import { allocation } from './statisticsAllocation';
import type { StatisticsChartModel } from './statisticsChartModel';
import { bands, numeric } from './statisticsChartModel';
import { inScope } from './statisticsDataset';
import { percentile } from './statisticsFlow';
import { contribution, ownerTransitions, recordedSpans } from './statisticsIntervals';
import { patternsSection } from './statisticsPatterns';
import { timeline } from './statisticsTimeline';
import { finish, metric } from './statisticsViews';
import { required, sorted } from './statisticsWork';
import type {
  StatisticsAction,
  StatisticsContext,
  StatisticsEntry,
  StatisticsSection,
  StatisticsViewModel,
} from './types';
interface ClosedSession {
  entry: number;
  minutes: number;
}
interface SessionPopulation {
  entries: ClosedSession[];
  running: number;
  broken: number;
  future: number;
}
function classifySession(
  ctx: StatisticsContext,
  population: SessionPopulation,
  entry: StatisticsEntry,
): void {
  if (entry.state === 'running') {
    population.running++;
    return;
  }
  if (entry.state === 'broken') {
    population.broken++;
    return;
  }
  if (required(entry.endMs) > ctx.request.nowMs) {
    population.future++;
    return;
  }
  if (
    required(entry.startMs) >= ctx.calendar.startMs &&
    required(entry.startMs) < ctx.calendar.civilEndMs
  )
    population.entries.push({
      entry: entry.index,
      minutes: (required(entry.endMs) - required(entry.startMs)) / 60000,
    });
}
async function sessionPopulation(ctx: StatisticsContext): Promise<SessionPopulation> {
  const population: SessionPopulation = { entries: [], running: 0, broken: 0, future: 0 };
  for (const entry of ctx.dataset.entries) {
    if (inScope(required(ctx.dataset.tasks[entry.owner]), ctx.request.scope))
      classifySession(ctx, population, entry);
    await ctx.budget.step();
  }
  return population;
}
async function sessionChart(
  ctx: StatisticsContext,
  entries: readonly ClosedSession[],
): Promise<StatisticsChartModel> {
  const edges = [0, 5, 15, 30, 60, 120, 240, Infinity],
    bins = edges.map(() => [] as number[]);
  for (const item of entries) {
    required(bins[edges.findIndex((edge) => item.minutes <= edge)]).push(item.entry);
    await ctx.budget.step();
  }
  return {
    id: 'session-lengths',
    accessibleLabel: 'Full closed-session length distribution',
    kind: 'bars',
    x: bands('Minutes', edges.map(String)),
    y: numeric('Entries', Math.max(0, ...bins.map((bin) => bin.length))),
    series: [],
    marks: bins.map((bin, i) => ({
      key: `session-bin:${i}`,
      x: String(edges[i]),
      y: bin.length,
      selectionId: ctx.evidence.rows(`session-bin:${i}`, bin.length, (index) =>
        ctx.evidence.entryRow(required(ctx.dataset.entries[required(bin[index])])),
      ),
    })),
  };
}
async function changesSection(ctx: StatisticsContext): Promise<StatisticsSection> {
  const transitions = await ownerTransitions(ctx.dataset, ctx.request, ctx.calendar, ctx.budget);
  ctx.evidence.rows('recorded-changes', transitions.length, (index) => {
    const transition = required(transitions[index]);
    return {
      ...ctx.evidence.taskRow(
        required(ctx.dataset.tasks[transition.to]),
        `${transition.gapMs / 60000} minute gap`,
      ),
      relatedNode: required(ctx.dataset.tasks[transition.from]).ref,
    };
  });
  return {
    id: 'changes',
    title: 'Recorded task changes',
    context:
      'Consecutive sole owners within five minutes. Overlaps and hidden owners break adjacency; this is not a cognitive-switch count.',
    metrics: [
      metric('recorded-changes', 'Recorded changes', transitions.length, {
        selectionId: 'recorded-changes',
        unit: 'changes',
      }),
    ],
    charts: [],
    legend: [],
  };
}
async function sessions(ctx: StatisticsContext): Promise<StatisticsSection[]> {
  const population = await sessionPopulation(ctx),
    ordered = await sorted(population.entries, (a, z) => a.minutes - z.minutes, ctx.budget),
    values: number[] = [];
  for (const value of ordered) {
    values.push(value.minutes);
    await ctx.budget.step();
  }
  ctx.evidence.rows('sessions', population.entries.length, (index) => {
    const item = required(population.entries[index]);
    return ctx.evidence.entryRow(required(ctx.dataset.entries[item.entry]), item.minutes);
  });
  return [
    {
      id: 'sessions',
      title: 'Full closed-session lengths',
      context:
        'Starts within this period and ends by as-of; includes valid zero-length sessions. Running and broken recordings are excluded.',
      metrics: [
        metric('session-count', 'Closed sessions', population.entries.length, {
          selectionId: 'sessions',
          unit: 'entries',
        }),
        metric('median', 'Median', percentile(values, 0.5), { unit: 'minutes' }),
        metric('p90', 'P90', percentile(values, 0.9), { unit: 'minutes' }),
        metric('running-excluded', 'Running', population.running, { unit: 'entries' }),
        metric('broken-excluded', 'Broken', population.broken, { unit: 'entries' }),
        metric('future-end-excluded', 'Ends after as-of', population.future, { unit: 'entries' }),
      ],
      charts: [await sessionChart(ctx, population.entries)],
      legend: [],
    },
    await changesSection(ctx),
  ];
}
export async function timeView({
  dataset,
  request: r,
  calendar: c,
  evidence: e,
  budget: b,
}: StatisticsContext): Promise<StatisticsViewModel> {
  const spans = await recordedSpans(dataset, r, c, b);
  let total = 0;
  for (const s of spans) {
    total += (s.end - s.start) / 60000;
    await b.step();
  }
  e.entryQuery('recorded-time', (entry) => {
    if (!inScope(required(dataset.tasks[entry.owner]), r.scope)) return undefined;
    const amount = contribution(entry, c.startMs, c.endMs, r.nowMs);
    return amount > 0 ? amount : undefined;
  });
  let sections: StatisticsSection[],
    actions: StatisticsAction[] = [],
    chartActions: ReadonlyArray<readonly [string, StatisticsAction]> = [];
  if (r.view === 'patterns')
    sections = [
      await patternsSection({ dataset, request: r, calendar: c, evidence: e, budget: b }, spans),
    ];
  else if (r.view === 'sessions')
    sections = await sessions({
      dataset,
      request: r,
      calendar: c,
      evidence: e,
      budget: b,
    });
  else if (r.view === 'timeline') {
    const result = await timeline(
      { dataset, request: r, calendar: c, evidence: e, budget: b },
      spans,
    );
    sections = result.sections;
    actions = result.actions;
    chartActions = result.chartActions;
  } else {
    const result = await allocation(
      { dataset, request: r, calendar: c, evidence: e, budget: b },
      spans,
    );
    sections = result.sections;
    actions = result.actions;
  }
  sections[0] = {
    ...required(sections[0]),
    metrics: [
      metric('recorded-minutes', 'Recorded time', total, {
        selectionId: 'recorded-time',
        unit: 'minutes',
      }),
      ...required(sections[0]).metrics,
    ],
  };
  return finish({ dataset, request: r, calendar: c, evidence: e }, sections, actions, chartActions);
}
