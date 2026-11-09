export type FixtureKind = 'standard' | 'wide-tree' | 'single-note';
export type CommandProfile = 'none' | 'stress' | 'feature';

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

export function scenarioIds(
  kind: FixtureKind,
  startup: boolean,
  api = false,
  command: CommandProfile = 'none',
): string[] {
  if (command === 'stress')
    return ['startup.index', 'command.dense-edit', 'command.dense-line-shift'];
  if (command === 'feature')
    return [
      'startup.index',
      'content.prepare',
      'content.apply',
      'notes.prepare',
      'notes.apply',
      'notes.read-pages',
      ...['target', 'over-target', 'ceiling'].flatMap((size) => [
        `notes.search.${size}.hit`,
        `notes.search.${size}.absent`,
      ]),
      'notes.search.continuation.first',
      'notes.search.continuation.next',
      'notes.search.continuation.complete',
      'notes.search.over-ceiling',
      'notes.search.projects.absent',
    ];
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
  const command = commandSelection(run.identity);
  if (command === undefined) return 'Invalid fixture scenario roster';
  if (api === undefined) return 'Invalid fixture scenario roster';
  if (kind === undefined && !api) return undefined;
  if (
    (kind !== 'standard' && kind !== 'wide-tree' && kind !== 'single-note') ||
    typeof startup !== 'boolean' ||
    JSON.stringify(run.expectedScenarios) !==
      JSON.stringify(scenarioIds(kind, startup, api, command))
  )
    return 'Invalid fixture scenario roster';
  return undefined;
}

function commandSelection(identity: ProfileRun['identity']): CommandProfile | undefined {
  const command = identity['commandProfile'] ?? 'none';
  if (command === 'none') return identity['fixtureKind'] === 'single-note' ? undefined : command;
  if (command !== 'stress' && command !== 'feature') return undefined;
  if (
    identity['fixtureKind'] !== 'single-note' ||
    identity['startupOnly'] !== false ||
    identity['apiOnly'] === true
  )
    return undefined;
  return command;
}

/** Reject two equally incomplete new workloads instead of accepting matching empty facts. */
export function completedWorkProblem(sample: Sample): string | undefined {
  const fixed = commandFacts(sample.scenario);
  if (fixed === undefined) return undefined;
  if (Object.entries(fixed).some(([key, value]) => sample.facts[key] !== value))
    return `Invalid completed work: ${sample.scenario}`;
  if (sample.scenario.startsWith('notes.search.')) {
    const pages = sample.facts['pages'];
    if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1)
      return `Invalid completed work: ${sample.scenario}`;
    if (
      ['notes.search.continuation.first', 'notes.search.over-ceiling'].includes(sample.scenario) &&
      sample.facts['emptyPrefixPages'] !== pages - 1
    )
      return `Invalid completed work: ${sample.scenario}`;
  }
  return undefined;
}
function commandFacts(id: string): Sample['facts'] | undefined {
  const population = { roots: 4000, nodes: 6000, exactBytes: true };
  if (id === 'content.prepare' || id === 'notes.prepare')
    return { ...population, writes: 0, complete: true };
  if (
    ['content.apply', 'command.dense-edit', 'command.dense-line-shift', 'notes.apply'].includes(id)
  )
    return {
      ...population,
      writes: 1,
      retainedRoots: id === 'notes.apply' ? 4000 : 3999,
      lineShift: id === 'notes.apply' || id === 'command.dense-line-shift' ? 1 : 0,
    };
  if (id === 'notes.read-pages')
    return { characters: 120027, bytes: 140029, complete: true, pageCharacters: 127 };
  return searchFacts(id);
}
function searchFacts(id: string): Sample['facts'] | undefined {
  if (id === 'notes.search.projects.absent' || id === 'notes.search.projects.hidden')
    return { sources: 100, zeroTaskSources: 99, results: 0, complete: true, coverage: 'complete' };
  if (id === 'notes.search.over-ceiling')
    return {
      characters: 4194305,
      bytes: 4194307,
      code: 'RESOURCE_LIMIT',
      certifiedComplete: false,
      readable: true,
    };
  const single = singleSearchFacts(id);
  if (single !== undefined) return single;
  const small = 'quartzneedle amberneedle\n'.length;
  const continuation: Record<string, Sample['facts']> = {
    first: { characters: small, bytes: small, sources: 1, results: 1, complete: false },
    next: { characters: 262145, bytes: 262147, sources: 1, results: 1, complete: true },
    complete: {
      characters: 262145 + small,
      bytes: 262147 + small,
      sources: 2,
      results: 2,
      complete: true,
    },
  };
  const facts = continuation[id.replace('notes.search.continuation.', '')];
  return facts === undefined ? undefined : { ...facts, coverage: 'complete' };
}

function singleSearchFacts(id: string): Sample['facts'] | undefined {
  const sizes: Record<string, number> = { target: 262144, 'over-target': 262145, ceiling: 4194304 };
  const [owner, operation, name, result, extra] = id.split('.');
  if (owner !== 'notes' || operation !== 'search' || extra !== undefined || name === undefined)
    return undefined;
  const characters = sizes[name];
  if (characters === undefined || (result !== 'hit' && result !== 'absent')) return undefined;
  return {
    characters,
    bytes: characters + 2,
    sources: 1,
    results: result === 'hit' ? 1 : 0,
    complete: true,
    coverage: 'complete',
    target: 262144,
    ceiling: 4194304,
  };
}
