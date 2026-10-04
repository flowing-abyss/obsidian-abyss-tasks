import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
} from './statisticsChartModel';
import { active, inScope } from './statisticsDataset';
import { metric, pageActions } from './statisticsViews';
import { rankedNumber, required, sorted, type WorkBudget } from './statisticsWork';
import type {
  StatisticsAction,
  StatisticsContext,
  StatisticsDataset,
  StatisticsMetric,
  StatisticsSection,
  StatisticsTask,
} from './types';
class DependencyGraph {
  readonly prerequisites: number[][] = [];
  readonly dependents: number[][] = [];
  readonly missing = new Set<number>();
  readonly ambiguous = new Set<number>();
  readonly self = new Set<number>();
  readonly cyclic = new Set<number>();
  private readonly ids = new Map<string, number[]>();
  constructor(
    private readonly dataset: StatisticsDataset,
    private readonly budget: WorkBudget,
  ) {}
  async build(): Promise<void> {
    await this.initialize();
    for (const task of this.dataset.tasks) {
      if (task.fileKind === 'live') await this.resolve(task);
      await this.budget.step();
    }
    await this.cycles();
  }
  private async initialize(): Promise<void> {
    for (const task of this.dataset.tasks) {
      this.prerequisites.push([]);
      this.dependents.push([]);
      if (task.fileKind === 'live' && task.dependencyId !== undefined) {
        const list = this.ids.get(task.dependencyId) ?? [];
        list.push(task.index);
        this.ids.set(task.dependencyId, list);
      }
      await this.budget.step();
    }
  }
  private async resolve(task: StatisticsTask): Promise<void> {
    for (const id of task.dependsOn) {
      const matches = this.ids.get(id);
      if (matches?.length !== 1) {
        const issues = matches === undefined ? this.missing : this.ambiguous;
        issues.add(task.index);
      } else {
        const prerequisite = required(matches[0]);
        required(this.prerequisites[task.index]).push(prerequisite);
        required(this.dependents[prerequisite]).push(task.index);
        if (prerequisite === task.index) this.self.add(task.index);
      }
      await this.budget.step();
    }
  }
  private async finishOrder(root: number, seen: Set<number>, order: number[]): Promise<void> {
    const stack = [{ node: root, next: 0 }];
    seen.add(root);
    while (stack.length > 0) {
      const frame = required(stack[stack.length - 1]),
        next = required(this.prerequisites[frame.node])[frame.next++];
      if (next === undefined) {
        order.push(frame.node);
        stack.pop();
      } else if (!seen.has(next)) {
        seen.add(next);
        stack.push({ node: next, next: 0 });
      }
      await this.budget.step();
    }
  }
  private async component(root: number, seen: Set<number>): Promise<number[]> {
    const stack = [root],
      result: number[] = [];
    seen.add(root);
    while (stack.length > 0) {
      const node = required(stack.pop());
      result.push(node);
      for (const next of required(this.dependents[node])) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
        await this.budget.step();
      }
      await this.budget.step();
    }
    return result;
  }
  private async cycles(): Promise<void> {
    const seen = new Set<number>(),
      order: number[] = [];
    for (let root = 0; root < this.dataset.tasks.length; root++) {
      if (!seen.has(root)) await this.finishOrder(root, seen, order);
      await this.budget.step();
    }
    seen.clear();
    for (let i = order.length - 1; i >= 0; i--) {
      const root = required(order[i]);
      if (!seen.has(root)) await this.markComponent(root, seen);
      await this.budget.step();
    }
    for (const node of this.self) {
      this.cyclic.add(node);
      await this.budget.step();
    }
  }
  private async markComponent(root: number, seen: Set<number>): Promise<void> {
    const component = await this.component(root, seen);
    if (component.length < 2) return;
    for (const node of component) {
      this.cyclic.add(node);
      await this.budget.step();
    }
  }
  unresolved(node: number): boolean {
    return this.missing.has(node) || this.ambiguous.has(node);
  }
}
function addDependent(map: Map<number, number[]>, owner: number, dependent: number): void {
  const list = map.get(owner) ?? [];
  list.push(dependent);
  map.set(owner, list);
}
interface Waiting {
  direct: Map<number, number[]>;
  sole: Map<number, number[]>;
  nodes: number[];
}
async function waitingFor(
  task: StatisticsTask,
  ctx: StatisticsContext,
  graph: DependencyGraph,
  waiting: Waiting,
): Promise<void> {
  let count = 0,
    only = -1;
  for (const prerequisite of required(graph.prerequisites[task.index])) {
    if (active(required(ctx.dataset.tasks[prerequisite]))) {
      addDependent(waiting.direct, prerequisite, task.index);
      count++;
      only = prerequisite;
    }
    await ctx.budget.step();
  }
  if (count > 0) waiting.nodes.push(task.index);
  if (
    count === 1 &&
    !graph.unresolved(task.index) &&
    !graph.cyclic.has(task.index) &&
    !graph.cyclic.has(only)
  )
    addDependent(waiting.sole, only, task.index);
}
async function waitingPopulation(ctx: StatisticsContext, graph: DependencyGraph): Promise<Waiting> {
  const waiting: Waiting = { direct: new Map(), sole: new Map(), nodes: [] };
  for (const task of ctx.dataset.tasks) {
    if (task.fileKind === 'live' && active(task) && inScope(task, ctx.request.scope))
      await waitingFor(task, ctx, graph, waiting);
    await ctx.budget.step();
  }
  return waiting;
}
async function issueMetrics(
  ctx: StatisticsContext,
  graph: DependencyGraph,
): Promise<StatisticsMetric[]> {
  const metrics: StatisticsMetric[] = [];
  for (const [name, indices] of [
    ['missing', graph.missing],
    ['ambiguous', graph.ambiguous],
    ['self', graph.self],
    ['cyclic', graph.cyclic],
  ] as const) {
    const scoped: number[] = [];
    for (const index of indices) {
      if (inScope(required(ctx.dataset.tasks[index]), ctx.request.scope)) scoped.push(index);
      await ctx.budget.step();
    }
    metrics.push(
      metric(
        `dependency:${name}`,
        `${name} links`,
        scoped.length,
        ctx.evidence.tasks(`dependency:${name}`, scoped),
      ),
    );
  }
  return metrics;
}
function rankChart(
  ctx: StatisticsContext,
  visible: readonly number[],
  waiting: Waiting,
): StatisticsChartModel {
  const tasks = ctx.dataset.tasks;
  const marks = visible.map((index) => ({
    key: required(tasks[index]).key,
    x: required(tasks[index]).key,
    y: required(waiting.direct.get(index)).length,
    label: required(tasks[index]).title,
    selectionId: ctx.evidence.tasks(`direct:${index}`, required(waiting.direct.get(index))),
  }));
  return {
    id: 'dependency-rank',
    accessibleLabel: 'Prerequisites ranked by direct waiting dependents',
    kind: 'bars',
    x: {
      ...bands(
        'Prerequisite',
        marks.map((m) => m.key),
      ),
      tickLabels: marks.map((m) => [m.key, m.label] as const),
    },
    y: numeric('Direct waiting dependents', Math.max(0, ...marks.map((m) => m.y)), 0, 'count'),
    series: [],
    marks,
  };
}
interface Neighborhood {
  nodes: number[];
  visited: Set<number>;
  downstream: number[];
}
async function downstream(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  focus: number,
): Promise<Neighborhood> {
  const nodes = [focus],
    visited = new Set(nodes),
    result: number[] = [];
  for (let cursor = 0; cursor < nodes.length; cursor++) {
    for (const next of required(graph.dependents[required(nodes[cursor])])) {
      if (active(required(ctx.dataset.tasks[next])) && !visited.has(next)) {
        visited.add(next);
        nodes.push(next);
        appendScoped(ctx, next, result);
      }
      await ctx.budget.step();
    }
    await ctx.budget.step();
  }
  return { nodes, visited, downstream: result };
}
async function includePrerequisites(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  neighborhood: Neighborhood,
): Promise<void> {
  const descendants = neighborhood.nodes.length;
  for (let i = 0; i < descendants; i++) {
    for (const prerequisite of required(graph.prerequisites[required(neighborhood.nodes[i])])) {
      if (!neighborhood.visited.has(prerequisite)) {
        neighborhood.visited.add(prerequisite);
        neighborhood.nodes.push(prerequisite);
      }
      await ctx.budget.step();
    }
    await ctx.budget.step();
  }
}
function nodeSeries(ctx: StatisticsContext, node: number, focus: number): string {
  if (node === focus) return 'focus';
  return inScope(required(ctx.dataset.tasks[node]), ctx.request.scope) ? 'scope' : 'external';
}
async function neighborhoodEdges(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  neighborhood: Neighborhood,
): Promise<{ edges: NonNullable<StatisticsChartModel['edges']>; total: number; omitted: number }> {
  const shown = new Set(neighborhood.nodes.slice(0, 80)),
    edges: Array<{ from: string; to: string; selectionId: string }> = [];
  const all: Array<readonly [number, number]> = [],
    omitted: Array<readonly [number, number]> = [];
  for (const node of neighborhood.nodes) {
    for (const prerequisite of required(graph.prerequisites[node])) {
      await ctx.budget.step();
      if (!neighborhood.visited.has(prerequisite)) continue;
      const relation: readonly [number, number] = [prerequisite, node];
      all.push(relation);
      if (visibleEdge(relation, shown, edges.length))
        edges.push({
          from: required(ctx.dataset.tasks[prerequisite]).key,
          to: required(ctx.dataset.tasks[node]).key,
          selectionId: ctx.evidence.tasks(`edge:${prerequisite}:${node}`, [prerequisite, node]),
        });
      else omitted.push(relation);
    }
    await ctx.budget.step();
  }
  edgeEvidence(ctx, 'chain-edges', all);
  edgeEvidence(ctx, 'chain-omitted-edges', omitted);
  return { edges, total: all.length, omitted: omitted.length };
}
function visibleEdge(
  relation: readonly [number, number],
  shown: ReadonlySet<number>,
  count: number,
): boolean {
  return count < 160 && shown.has(relation[0]) && shown.has(relation[1]);
}
function edgeEvidence(
  ctx: StatisticsContext,
  id: string,
  relations: ReadonlyArray<readonly [number, number]>,
): void {
  ctx.evidence.rows(id, relations.length, (index) => {
    const [from, to] = required(relations[index]),
      prerequisite = required(ctx.dataset.tasks[from]),
      dependent = required(ctx.dataset.tasks[to]);
    return {
      ...ctx.evidence.taskRow(dependent, `Prerequisite: ${prerequisite.title}`),
      key: JSON.stringify(['edge', prerequisite.key, dependent.key]),
      relatedNode: prerequisite.ref,
    };
  });
}
function networkChart(
  ctx: StatisticsContext,
  focus: number,
  nodes: readonly number[],
  edges: NonNullable<StatisticsChartModel['edges']>,
): StatisticsChartModel {
  const shown = nodes.slice(0, 80);
  const keys = shown.map((node) => required(ctx.dataset.tasks[node]).key);
  const levels = new Map<string, number>(),
    pending = new Set(keys);
  while (pending.size > 0) {
    const ready = [...pending].filter((key) =>
      edges.every((edge) => edge.to !== key || !pending.has(edge.from)),
    );
    // Cycles have no topological order; retain their identities in distinct sibling rows.
    if (ready.length === 0) ready.push(...pending);
    for (const key of ready) {
      levels.set(
        key,
        Math.max(
          0,
          ...edges
            .filter((edge) => edge.to === key)
            .map((edge) => (levels.get(edge.from) ?? -1) + 1),
        ),
      );
    }
    for (const key of ready) pending.delete(key);
  }
  const columns = new Map<number, string[]>();
  for (const key of keys) {
    const level = required(levels.get(key)),
      list = columns.get(level) ?? [];
    list.push(key);
    columns.set(level, list);
  }
  const depth = Math.max(0, ...levels.values()),
    rows = Math.max(1, ...[...columns.values()].map((list) => list.length));
  const vertical = depth > 5;
  const marks: StatisticsMark[] = shown.map((node) => {
    const key = required(ctx.dataset.tasks[node]).key,
      level = required(levels.get(key)),
      siblings = required(columns.get(level));
    const position = siblings.indexOf(key) + (rows - siblings.length) / 2;
    return {
      key,
      x: vertical ? position : level,
      y: vertical ? level : position,
      label: required(ctx.dataset.tasks[node]).title,
      series: nodeSeries(ctx, node, focus),
      selectionId: ctx.evidence.tasks(`node:${node}`, [node]),
    };
  });
  return {
    id: 'dependency-chain',
    accessibleLabel: 'Directed local prerequisite chain; arrows point toward waiting dependents',
    kind: 'network',
    x: numeric('Local layout', vertical ? rows - 1 : depth),
    y: numeric('Local layout', vertical ? depth : rows - 1),
    series: [
      { key: 'focus', label: 'Selected prerequisite', tone: 'accent' },
      { key: 'scope', label: 'In scope', tone: 'neutral' },
      { key: 'external', label: 'External prerequisite', tone: 'muted' },
    ],
    marks,
    edges,
  };
}
async function focusedChain(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  waiting: Waiting,
  focus: number,
): Promise<{ chart: StatisticsChartModel; metrics: StatisticsMetric[] }> {
  const neighborhood = await downstream(ctx, graph, focus);
  await includePrerequisites(ctx, graph, neighborhood);
  const edges = await neighborhoodEdges(ctx, graph, neighborhood);
  const populations: Array<[string, string, readonly number[]]> = [
    ['direct', 'Direct waiting', waiting.direct.get(focus) ?? []],
    ['downstream', 'Downstream waiting', neighborhood.downstream],
    ['sole', 'Waiting only on this', waiting.sole.get(focus) ?? []],
    ['chain-omitted', 'Omitted neighborhood nodes', neighborhood.nodes.slice(80)],
  ];
  const metrics = populations.map(([id, label, indices]) =>
    metric(id, label, indices.length, ctx.evidence.tasks(id, indices)),
  );
  metrics.push(
    metric('chain-edges', 'Neighborhood edges', edges.total, 'chain-edges'),
    metric(
      'chain-omitted-edges',
      'Omitted neighborhood edges',
      edges.omitted,
      'chain-omitted-edges',
    ),
  );
  return { chart: networkChart(ctx, focus, neighborhood.nodes, edges.edges), metrics };
}
async function findFocus(ctx: StatisticsContext): Promise<number> {
  if (ctx.request.focusKey === undefined) return -1;
  for (const task of ctx.dataset.tasks) {
    if (task.fileKind === 'live' && task.key === ctx.request.focusKey) return task.index;
    await ctx.budget.step();
  }
  return -1;
}
export async function dependencySections(ctx: StatisticsContext): Promise<{
  sections: StatisticsSection[];
  actions: StatisticsAction[];
  chartActions: Array<readonly [string, StatisticsAction]>;
}> {
  const graph = new DependencyGraph(ctx.dataset, ctx.budget);
  await graph.build();
  const waiting = await waitingPopulation(ctx, graph);
  const ranked = await sorted(
    [...waiting.direct.keys()],
    (a, z) =>
      rankedNumber(
        required(waiting.direct.get(z)).length,
        required(waiting.direct.get(a)).length,
        () => required(ctx.dataset.tasks[a]).key.localeCompare(required(ctx.dataset.tasks[z]).key),
      ),
    ctx.budget,
  );
  const page = Math.max(0, Math.floor(ctx.request.page ?? 0)),
    visible = ranked.slice(page * 12, (page + 1) * 12),
    actions: StatisticsAction[] = pageActions(page, ranked.length, 12),
    charts = [rankChart(ctx, visible, waiting)];
  const chartActions: Array<readonly [string, StatisticsAction]> = [];
  for (const index of visible)
    chartActions.push([
      `direct:${index}`,
      {
        type: 'chain',
        label: `Inspect ${required(ctx.dataset.tasks[index]).title}`,
        focusKey: required(ctx.dataset.tasks[index]).key,
      },
    ]);
  const metrics = [
    metric(
      'waiting',
      'Current waiting dependents',
      waiting.nodes.length,
      ctx.evidence.tasks('dependency:waiting', waiting.nodes),
    ),
    ...(await issueMetrics(ctx, graph)),
  ];
  const focus = await findFocus(ctx);
  if (focus >= 0) {
    const chain = await focusedChain(ctx, graph, waiting, focus);
    charts.push(chain.chart);
    metrics.push(...chain.metrics);
  }
  return {
    sections: [
      {
        id: 'dependencies',
        title: 'Current dependencies',
        context:
          'Live canonical status; external prerequisites remain visible. Missing, ambiguous and cyclic relations cannot establish a sole blocker. Choose a prerequisite to inspect its downstream chain.',
        metrics: metrics.map((value) =>
          value.value === 0 &&
          (value.id.startsWith('dependency:') || value.id.startsWith('chain-omitted'))
            ? { ...value, role: 'coverage' }
            : value,
        ),
        charts,
        legend: [],
      },
    ],
    actions,
    chartActions,
  };
}

function appendScoped(ctx: StatisticsContext, index: number, indices: number[]): void {
  if (inScope(required(ctx.dataset.tasks[index]), ctx.request.scope)) indices.push(index);
}
