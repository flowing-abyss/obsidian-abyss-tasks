export type FixtureKind = 'standard' | 'wide-tree';

export interface Sample {
  scenario: string;
  iteration: number;
  durationMs: number;
  longTasks: number | null;
  longTaskMs: number | null;
  maxFrameGapMs: number;
  domNodes: number;
  facts: Record<string, string | number | boolean>;
}

export interface ProfileRun {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  status: 'complete' | 'failed';
  restored: boolean;
  identity: Record<string, string | number | boolean>;
  build: { commit: string; dirty: boolean; sha256: string };
  expectedScenarios: string[];
  samples: Sample[];
  diagnostics: string[];
  errors: string[];
}

export interface Distribution {
  n: number;
  median: number;
  p95: number;
  mad: number;
  min: number;
  max: number;
  lowSampleCount: boolean;
}

interface ScenarioComparison {
  scenario: string;
  before: Distribution;
  after: Distribution;
  deltaMs: number;
  deltaPercent: number | null;
  intervalMs: [number, number];
  practicalMarginMs: number;
  verdict: 'regression' | 'improvement' | 'no-material-difference' | 'inconclusive';
}

export interface Comparison {
  compatible: boolean;
  reasons: string[];
  scenarios: ScenarioComparison[];
}
export const FIXTURE_FOLDER = '__abyss_profile_fixture_v1__';

export const ANALYSIS = [
  'rhythm',
  'completion',
  'deadlines',
  'cohorts',
  'allocation',
  'timeline',
  'sessions',
  'patterns',
  'movement',
  'aging',
  'dependencies',
];

const SCENARIOS = [
  'startup.index',
  'query.roots',
  'query.nodes',
  'query.dependencies',
  'query.time',
  'query.project',
  'query.tag',
  'query.project-tag',
  'query.nodes-no-tag',
  'search.cold',
  'search.warm',
  'search.no-results',
  'search.subtree',
  'panel.first-open',
  'ui.search',
  'ui.scroll',
  'ui.inspector',
  'ui.inspector.link-input',
  'ui.calendar.day',
  'ui.calendar.week',
  'ui.calendar.month',
  'ui.tasks.kanban',
  'ui.tasks.kanban-scroll',
  'ui.tasks.timeline',
  'ui.tasks.timeline-scroll',
  'ui.projects.table',
  'ui.projects.kanban',
  'ui.projects.timeline',
  'ui.projects.timeline-scroll',
  'statistics.acquire',
  ...ANALYSIS.map((id) => `ui.analysis.${id}`),
  'search.edit-to-query',
  'command.create',
  'command.edit',
  'command.complete',
  'command.comment',
  'command.tracking',
  'command.recurrence',
  'index.external-edit',
  'panel.close',
];

export function scenarioIds(kind: FixtureKind, startup: boolean, api = false): string[] {
  if (api) return ['startup.index', 'api.scan', 'api.status'];
  if (startup) return ['startup.index'];
  const scenarios = [...SCENARIOS];
  if (kind === 'wide-tree')
    scenarios.splice(
      scenarios.indexOf('search.edit-to-query'),
      0,
      'index.wide-child-edit',
      'index.metadata-only',
    );
  return scenarios;
}

function apiSelection(identity: ProfileRun['identity']): boolean | undefined {
  const api = identity['apiOnly'];
  if (api === undefined) return false;
  if (typeof api !== 'boolean' || (api && identity['startupOnly'] === true)) return undefined;
  return api;
}

/** Legacy schema-1 runs without fixtureKind remain readable for historical comparisons. */
export function fixtureScenarioProblem(
  run: Pick<ProfileRun, 'identity' | 'expectedScenarios'>,
): string | undefined {
  const kind = run.identity['fixtureKind'];
  const api = apiSelection(run.identity);
  const startup = run.identity['startupOnly'];
  if (api === undefined) return 'Invalid fixture scenario roster';
  if (kind === undefined && !api) return undefined;
  if (
    (kind !== 'standard' && kind !== 'wide-tree') ||
    typeof startup !== 'boolean' ||
    JSON.stringify(run.expectedScenarios) !== JSON.stringify(scenarioIds(kind, startup, api))
  )
    return 'Invalid fixture scenario roster';
  return undefined;
}
