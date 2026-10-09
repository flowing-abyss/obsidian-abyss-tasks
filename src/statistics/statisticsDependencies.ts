import {
  bands,
  numeric,
  type StatisticsChartModel,
  type StatisticsMark,
  type StatisticsObservation,
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
  readonly missingIds = new Map<number, string[]>();
  readonly ambiguousIds = new Map<number, string[]>();
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
        this.recordIssue(task.index, id, matches === undefined);
      } else {
        const prerequisite = required(matches[0]);
        required(this.prerequisites[task.index]).push(prerequisite);
        required(this.dependents[prerequisite]).push(task.index);
        if (prerequisite === task.index) this.self.add(task.index);
      }
      await this.budget.step();
    }
  }
  private recordIssue(node: number, id: string, missing: boolean): void {
    const issues = missing ? this.missing : this.ambiguous;
    issues.add(node);
    const details = missing ? this.missingIds : this.ambiguousIds;
    const ids = details.get(node) ?? [];
    ids.push(id);
    details.set(node, ids);
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
  for (const [name, label, indices, details] of [
    ['missing', 'Tasks with unresolved IDs', graph.missing, graph.missingIds],
    ['ambiguous', 'Tasks with duplicate-ID references', graph.ambiguous, graph.ambiguousIds],
    ['self', 'Tasks referencing themselves', graph.self, undefined],
    ['cyclic', 'Tasks in cycles', graph.cyclic, undefined],
  ] as const) {
    const scoped: number[] = [];
    for (const index of indices) {
      const task = required(ctx.dataset.tasks[index]);
      if (active(task) && inScope(task, ctx.request.scope)) scoped.push(index);
      await ctx.budget.step();
    }
    metrics.push({
      ...metric(
        `dependency:${name}`,
        label,
        scoped.length,
        ctx.evidence.rows(`dependency:${name}`, scoped.length, (index) => {
          const node = required(scoped[index]);
          const ids = details?.get(node);
          return ctx.evidence.taskRow(
            required(ctx.dataset.tasks[node]),
            ids === undefined ? undefined : `Referenced IDs: ${ids.join(', ')}`,
          );
        }),
      ),
      context:
        'Live open/in-progress tasks in scope; categories may overlap. Cycles use resolved live relations across all statuses.',
    });
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
    observation: {
      title: required(tasks[index]).title,
      values: [
        {
          label: 'Direct waiting',
          value: required(waiting.direct.get(index)).length,
          unit: 'tasks',
        },
      ],
      note: 'Live open/in-progress dependents in scope. Inspect dependencies.',
    },
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
  return scopedNeighborhood(ctx, graph, { nodes, visited, downstream: result });
}
async function scopedNeighborhood(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  neighborhood: Neighborhood,
): Promise<Neighborhood> {
  // Keep outside-scope paths only when they explain a scoped waiting descendant.
  const relevant = new Set([required(neighborhood.nodes[0])]),
    pending: number[] = [];
  for (const node of neighborhood.downstream) {
    relevant.add(node);
    pending.push(node);
    await ctx.budget.step();
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    for (const prerequisite of required(graph.prerequisites[required(pending[cursor])])) {
      appendUnvisited(prerequisite, neighborhood.visited, relevant, pending);
      await ctx.budget.step();
    }
    await ctx.budget.step();
  }
  const retained: number[] = [];
  for (const node of neighborhood.nodes) {
    if (relevant.has(node)) retained.push(node);
    await ctx.budget.step();
  }
  return { nodes: retained, visited: relevant, downstream: neighborhood.downstream };
}
function appendUnvisited(
  node: number,
  allowed: ReadonlySet<number>,
  seen: Set<number>,
  target: number[],
): void {
  if (allowed.has(node) && !seen.has(node)) {
    seen.add(node);
    target.push(node);
  }
}
async function includePrerequisites(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  neighborhood: Neighborhood,
): Promise<Neighborhood> {
  const descendants = neighborhood.nodes.length;
  for (let i = 0; i < descendants; i++) {
    for (const prerequisite of required(graph.prerequisites[required(neighborhood.nodes[i])])) {
      if (
        active(required(ctx.dataset.tasks[prerequisite])) &&
        !neighborhood.visited.has(prerequisite)
      ) {
        neighborhood.visited.add(prerequisite);
        neighborhood.nodes.push(prerequisite);
      }
      await ctx.budget.step();
    }
    await ctx.budget.step();
  }
  // Context co-prerequisites precede fan-out so the cap does not hide a shared blocker.
  const prioritized = [required(neighborhood.nodes[0])];
  await appendNodes(ctx, neighborhood.nodes, prioritized, [descendants, neighborhood.nodes.length]);
  await appendNodes(ctx, neighborhood.nodes, prioritized, [1, descendants]);
  return { ...neighborhood, nodes: prioritized };
}
async function appendNodes(
  ctx: StatisticsContext,
  source: readonly number[],
  target: number[],
  [start, end]: readonly [number, number],
): Promise<void> {
  for (let i = start; i < end; i++) {
    target.push(required(source[i]));
    await ctx.budget.step();
  }
}
function nodeSeries(ctx: StatisticsContext, node: number, focus: number): string {
  if (node === focus) return 'focus';
  return inScope(required(ctx.dataset.tasks[node]), ctx.request.scope) ? 'scope' : 'external';
}
interface NeighborhoodEdges {
  edges: Array<{ from: string; to: string; selectionId: string }>;
  total: number;
  omitted: number;
  incoming: Map<number, number>;
}
interface EdgeCollection {
  shown: ReadonlySet<number>;
  visited: ReadonlySet<number>;
  edges: NeighborhoodEdges['edges'];
  all: Array<readonly [number, number]>;
  omitted: Array<readonly [number, number]>;
  incoming: Map<number, number>;
}
function collectEdge(
  ctx: StatisticsContext,
  relation: readonly [number, number],
  collection: EdgeCollection,
): void {
  const [prerequisite, node] = relation;
  if (!active(required(ctx.dataset.tasks[prerequisite]))) return;
  collection.incoming.set(node, (collection.incoming.get(node) ?? 0) + 1);
  if (!collection.visited.has(prerequisite)) return;
  collection.all.push(relation);
  if (visibleEdge(relation, collection.shown, collection.edges.length))
    collection.edges.push({
      from: required(ctx.dataset.tasks[prerequisite]).key,
      to: required(ctx.dataset.tasks[node]).key,
      selectionId: ctx.evidence.tasks(`edge:${prerequisite}:${node}`, [prerequisite, node]),
    });
  else collection.omitted.push(relation);
}
async function neighborhoodEdges(
  ctx: StatisticsContext,
  graph: DependencyGraph,
  neighborhood: Neighborhood,
): Promise<NeighborhoodEdges> {
  const collection: EdgeCollection = {
    shown: new Set(neighborhood.nodes.slice(0, 80)),
    visited: neighborhood.visited,
    edges: [],
    all: [],
    omitted: [],
    incoming: new Map(),
  };
  for (const node of neighborhood.nodes) {
    for (const prerequisite of required(graph.prerequisites[node])) {
      await ctx.budget.step();
      collectEdge(ctx, [prerequisite, node], collection);
    }
    await ctx.budget.step();
  }
  edgeEvidence(ctx, 'chain-edges', collection.all);
  edgeEvidence(ctx, 'chain-omitted-edges', collection.omitted);
  return {
    edges: collection.edges,
    total: collection.all.length,
    omitted: collection.omitted.length,
    incoming: collection.incoming,
  };
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
function nodeObservation(
  ctx: StatisticsContext,
  node: number,
  prerequisites: number,
  omitted: number,
): StatisticsObservation {
  const task = required(ctx.dataset.tasks[node]);
  return {
    title: task.title,
    values: [
      { label: 'Scope', value: inScope(task, ctx.request.scope) ? 'In scope' : 'Outside scope' },
      { label: 'Current status', value: task.status },
      { label: 'Unsatisfied prerequisites', value: prerequisites },
      { label: 'Omitted prerequisites or relations', value: omitted },
    ],
    note:
      omitted > 0
        ? 'Partial incoming context; omitted counts include upstream prerequisites outside this local neighborhood.'
        : 'Prerequisite → dependent. Only unsatisfied resolved relations are shown.',
  };
}
function neighborhoodDescription(shown: number, total: number, links: NeighborhoodEdges): string {
  const partial = shown < total || links.edges.length < links.total ? ' · partial graph' : '';
  return `Prerequisite → dependent. Showing ${shown} of ${total} tasks and ${links.edges.length} of ${links.total} relations${partial}. Direct, downstream and sole counts cover the complete live open/in-progress population in scope; outside-scope tasks provide context.`;
}
function focusLabel(ctx: StatisticsContext, focus: number): string {
  return inScope(required(ctx.dataset.tasks[focus]), ctx.request.scope)
    ? 'Selected prerequisite'
    : 'Selected prerequisite · Outside scope';
}
function networkChart(
  ctx: StatisticsContext,
  focus: number,
  nodes: readonly number[],
  links: NeighborhoodEdges,
): StatisticsChartModel {
  const { edges, incoming } = links;
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
    const prerequisites = incoming.get(node) ?? 0;
    const shownPrerequisites = edges.filter((edge) => edge.to === key).length;
    const omitted = prerequisites - shownPrerequisites;
    return {
      key,
      x: vertical ? position : level,
      y: vertical ? level : position,
      label: required(ctx.dataset.tasks[node]).title,
      observation: nodeObservation(ctx, node, prerequisites, omitted),
      series: nodeSeries(ctx, node, focus),
      selectionId: ctx.evidence.tasks(`node:${node}`, [node]),
    };
  });
  return {
    id: 'dependency-chain',
    accessibleLabel: 'Directed local prerequisite chain; arrows point toward waiting dependents',
    facet: {
      key: required(ctx.dataset.tasks[focus]).key,
      label: `Waiting neighborhood · ${required(ctx.dataset.tasks[focus]).title}`,
      description: neighborhoodDescription(shown.length, nodes.length, links),
    },
    kind: 'network',
    x: numeric('Local layout', vertical ? rows - 1 : depth),
    y: numeric('Local layout', vertical ? depth : rows - 1),
    series: [
      { key: 'focus', label: focusLabel(ctx, focus), tone: 'accent' },
      { key: 'scope', label: 'In scope', tone: 'neutral' },
      { key: 'external', label: 'Outside scope', tone: 'muted' },
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
  const neighborhood = await includePrerequisites(ctx, graph, await downstream(ctx, graph, focus));
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
  return {
    chart: networkChart(ctx, focus, neighborhood.nodes, edges),
    metrics,
  };
}
async function findFocus(ctx: StatisticsContext, ranked: readonly number[]): Promise<number> {
  if (ctx.request.focusKey === undefined) return -1;
  for (const index of ranked) {
    if (required(ctx.dataset.tasks[index]).key === ctx.request.focusKey) return index;
    await ctx.budget.step();
  }
  return ranked[0] ?? -1;
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
  const page = Math.min(
      Math.max(0, Math.ceil(ranked.length / 12) - 1),
      Math.max(0, Math.floor(ctx.request.page ?? 0)),
    ),
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
      'Tasks with resolved waiting prerequisites',
      waiting.nodes.length,
      ctx.evidence.tasks('dependency:waiting', waiting.nodes),
    ),
    ...(await issueMetrics(ctx, graph)),
  ];
  const focus = await findFocus(ctx, ranked);
  if (focus >= 0) {
    const chain = await focusedChain(ctx, graph, waiting, focus);
    charts.push(chain.chart);
    metrics.push(...chain.metrics);
    actions.push({ type: 'focus', label: 'Back to prerequisites', focusKey: undefined });
  }
  return {
    sections: [
      {
        id: 'dependencies',
        title: 'Current dependencies',
        reading: 'Direct counts overlap for shared prerequisites; waiting tasks are counted once.',
        emptyMessage:
          ranked.length === 0
            ? 'No resolved waiting prerequisites among live open/in-progress tasks in scope.'
            : undefined,
        context:
          'Current live open/in-progress tasks in scope. Lookup uses live tasks across scopes; unresolved IDs may refer to absent or archived targets. Satisfied prerequisites are excluded from the waiting graph. Direct and downstream counts do not promise release: waiting only on this is a conservative sole-prerequisite count, excluding unresolved IDs and structural cycles. Choose a prerequisite to inspect its downstream chain.',
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
