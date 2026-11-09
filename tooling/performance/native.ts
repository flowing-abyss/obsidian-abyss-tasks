import { apiScenarios } from './native-api.ts';
import { NativeCdp } from './native-cdp.ts';
import { commandFeatureScenarios, commandStressScenarios } from './native-command.ts';
import {
  assertRoots,
  assertViewport,
  calendarDiagnostics,
  calendarPopulation,
  closePanels,
  element,
  frames,
  indexed,
  plugin,
  waitFor,
} from './native-helpers.ts';
import { noteScenarios, type SearchCallSample } from './native-note-search.ts';
import { HiddenWindowObservation, NativeObservation } from './native-observation.ts';
import {
  calendarScenarios,
  commandScenarios,
  indexScenarios,
  panelScenarios,
  projectScenarios,
  queryScenarios,
  searchEditScenario,
  statisticsScenarios,
  taskBoardScenarios,
  taskTimelineScenarios,
  type Measure,
} from './native-scenarios.ts';
import type { Host, NativeBridge, NativeOptions } from './native-types.ts';
import { AbyssProfiler, bounded, PendingWork } from './profiler.ts';
import { FIXTURE_FOLDER, type Sample } from './types.ts';

export { settings } from './options.ts';
type FixtureHost = Pick<Host, 'vault' | 'metadataCache'>;
type ResetObserver = (diagnostic: Record<string, unknown>) => void;
interface ResetOptions {
  force: boolean;
  isActive(): boolean;
  observe?: ResetObserver;
}

export async function fixtureReady(
  host: Pick<Host, 'vault' | 'metadataCache'>,
  contents: Record<string, string>,
  isActive = (): boolean => true,
  observe?: ResetObserver,
): Promise<void> {
  await waitFor(
    () => {
      if (!isActive()) throw new Error('Profile harness stopped');
      return Object.keys(contents).every((path) => host.vault.getFileByPath(path) !== null);
    },
    'fixture files',
    30000,
  );
  // A prior run may still have entries in the host cache after filesystem cleanup.
  // Force one host-owned write/event per initial file, even when bytes match.
  await resetFiles(host, contents, {
    force: true,
    isActive,
    ...(observe === undefined ? {} : { observe }),
  });
}

export async function resetFixture(
  host: Pick<Host, 'vault' | 'metadataCache'>,
  contents: Record<string, string>,
  force = false,
  isActive = (): boolean => true,
): Promise<void> {
  await resetFiles(host, contents, { force, isActive });
}

async function resetFiles(
  host: FixtureHost,
  contents: Record<string, string>,
  options: ResetOptions,
): Promise<void> {
  for (const entry of Object.entries(contents)) await resetFile(host, entry, options);
}
async function resetFile(
  host: FixtureHost,
  [path, expected]: [string, string],
  options: ResetOptions,
): Promise<void> {
  if (!options.isActive()) throw new Error('Profile harness stopped');
  if (!path.startsWith(`${FIXTURE_FOLDER}/`) || path.split('/').includes('..'))
    throw new Error('Reset is restricted to generated fixture files');
  const file = host.vault.getFileByPath(path);
  if (file === null) throw new Error(`Reset file missing: ${path}`);
  const matches = (): Promise<boolean> => fixtureMatches(host, { path, file, expected });
  if (!options.force && (await matches())) return;
  let metadataEvents = 0,
    metadata: string | undefined;
  const ref = host.metadataCache.on('changed', (updated, content) => {
    if (updated === file && updated.path === path) {
      metadataEvents++;
      metadata = content;
    }
  });
  try {
    await host.vault.modify(file, expected);
    await waitFor(
      async () =>
        metadata !== undefined && observedFixtureText(metadata, expected) && (await matches()),
      `reset contents and metadata: ${path}`,
      30000,
    );
  } catch (error) {
    await reportResetFailure(
      host,
      { path, file, expected, metadataEvents, metadataExact: metadata === expected, metadata },
      { error, observe: options.observe },
    );
    throw error;
  } finally {
    host.metadataCache.offref(ref);
  }
}

function observedFixtureText(observed: string, expected: string): boolean {
  return observed === expected || expected === `\uFEFF${observed}`;
}
async function fixtureMatches(
  host: FixtureHost,
  source: {
    path: string;
    file: NonNullable<ReturnType<Host['vault']['getFileByPath']>>;
    expected: string;
  },
): Promise<boolean> {
  const { path, file, expected } = source,
    stamp = { ...file.stat };
  const current = (): boolean =>
    file.path === path &&
    host.vault.getFileByPath(path) === file &&
    JSON.stringify(stamp) === JSON.stringify(file.stat);
  if (!current()) return false;
  const fresh = await host.vault.read(file);
  if (!current() || !observedFixtureText(fresh, expected)) return false;
  const cached = await host.vault.cachedRead(file);
  if (!current() || !observedFixtureText(cached, expected)) return false;
  const bytes = await host.vault.readBinary(file);
  if (!current()) return false;
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === expected;
}

function textDifference(text: string, expected: string): Record<string, number | boolean> {
  let index = 0;
  while (index < Math.min(text.length, expected.length) && text[index] === expected[index]) index++;
  return {
    characters: text.length,
    bytes: new TextEncoder().encode(text).length,
    firstCodePoint: text.codePointAt(0) ?? -1,
    exact: text === expected,
    leadingBomOnly: expected === `\uFEFF${text}`,
    crlfEquivalent: text.replace(/\r\n/gu, '\n') === expected.replace(/\r\n/gu, '\n'),
    firstDifference: text === expected ? -1 : index,
  };
}
async function readDifference(
  read: () => Promise<string>,
  expected: string,
): Promise<Record<string, unknown>> {
  try {
    return textDifference(await read(), expected);
  } catch (error) {
    return { readError: String(error) };
  }
}
async function resetFailure(
  host: FixtureHost,
  state: {
    path: string;
    file: NonNullable<ReturnType<Host['vault']['getFileByPath']>>;
    expected: string;
    metadataEvents: number;
    metadataExact: boolean;
    metadata: string | undefined;
  },
): Promise<Record<string, unknown>> {
  const { file, expected } = state,
    path = state.path,
    stamp = { ...file.stat };
  const sameFile = (): boolean => file.path === path && host.vault.getFileByPath(path) === file;
  const sameFileBefore = sameFile();
  const read = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!sameFile()) return Promise.reject(new Error('Generated fixture file identity changed'));
    return operation();
  };
  const fresh = await readDifference(() => read(() => host.vault.read(file)), expected);
  const cached = await readDifference(() => read(() => host.vault.cachedRead(file)), expected);
  // Diagnostic reads only the already-validated generated file; it grants no readiness authority.
  const binary = await readDifference(
    async () =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await read(() => host.vault.readBinary(file)),
      ),
    expected,
  );
  return {
    path,
    metadataEvents: state.metadataEvents,
    metadataExact: state.metadataExact,
    expected: textDifference(expected, expected),
    metadata: state.metadata === undefined ? null : textDifference(state.metadata, expected),
    fresh,
    cached,
    binary,
    sameFile: sameFileBefore && sameFile(),
    sameStamp: JSON.stringify(stamp) === JSON.stringify(file.stat),
  };
}

interface MeasurementContext {
  host: Host;
  cdp: NativeCdp | undefined;
  bridge: NativeBridge;
  iteration: number;
  diagnostic: boolean;
  samples: Sample[];
  pending: PendingWork;
  viewport: string;
  isActive(): boolean;
}

async function completeCalendarSample(context: MeasurementContext, sample: Sample): Promise<void> {
  const id = sample.scenario;
  if (!id.startsWith('ui.calendar.')) return;
  const visibleDates = sample.facts['visibleDates'];
  if (typeof visibleDates !== 'string') throw new Error('Calendar work dates missing');
  Object.assign(sample.facts, calendarPopulation(context.host, visibleDates.split(',')));
  if (context.diagnostic) {
    context.bridge.save(
      `calendar-${id.slice('ui.calendar.'.length)}-dom.json`,
      calendarDiagnostics(element('.abyss-cal-body')),
    );
    await context.cdp?.screenshot(`calendar-${id.slice('ui.calendar.'.length)}`);
  }
}

async function captureTaskBoard(context: MeasurementContext, id: string): Promise<void> {
  if (!context.diagnostic || id !== 'ui.tasks.kanban') return;
  const board = element('.abyss-task-kanban');
  context.bridge.save('task-kanban-dom.json', {
    mounted: board.querySelectorAll('.abyss-task-card').length,
    html: board.outerHTML,
    viewport: context.viewport,
  });
  await context.cdp?.screenshot('task-kanban');
}

async function captureTimeline(context: MeasurementContext, id: string): Promise<void> {
  if (!context.diagnostic) return;
  let kind: 'task' | 'project';
  if (id === 'ui.tasks.timeline') kind = 'task';
  else if (id === 'ui.projects.timeline') kind = 'project';
  else return;
  const root = element(`.abyss-center .abyss-${kind}-timeline`);
  const scroll = root.matches('.abyss-project-timeline-scroll')
    ? root
    : root.querySelector<HTMLElement>('.abyss-project-timeline-scroll');
  if (scroll === null) throw new Error('Timeline diagnostic scroll surface missing');
  const rect = scroll.getBoundingClientRect();
  context.bridge.save(`${kind}-timeline-dom.json`, {
    mounted: root.querySelectorAll('.abyss-project-timeline-row').length,
    html: root.outerHTML,
    viewport: context.viewport,
    scroll: {
      left: scroll.scrollLeft,
      top: scroll.scrollTop,
      width: scroll.scrollWidth,
      height: scroll.scrollHeight,
      clientWidth: scroll.clientWidth,
      clientHeight: scroll.clientHeight,
      x: rect.x,
      y: rect.y,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
    },
  });
  await context.cdp?.screenshot(`${kind}-timeline`);
}

export function createMeasure(context: MeasurementContext): Measure {
  const { bridge, iteration, diagnostic, samples, pending } = context;
  const observation = new NativeObservation();
  const profiler = new AbyssProfiler(performance, async (start, end) => {
    await frames();
    return observation.read(start, end);
  });
  return async (id, action, prepare) => {
    if (!context.isActive()) throw new Error('Profile harness stopped');
    assertViewport(context.viewport);
    if (document.visibilityState !== 'visible')
      throw new Error('Profile window is no longer visible');
    bridge.save('progress.json', {
      scenario: id,
      iteration,
      diagnostic,
      state: 'started',
      at: new Date().toISOString(),
    });
    await frames();
    try {
      if (!context.isActive()) throw new Error('Profile harness stopped');
      if (prepare !== undefined)
        await bounded(pending.track(prepare()), 30000, `${id} preparation`);
      if (!context.isActive()) throw new Error('Profile harness stopped');
      observation.start();
      const sample = await profiler.measure(id, iteration, () =>
        bounded(pending.track(action()), 30000, id),
      );
      assertViewport(context.viewport);
      await completeCalendarSample(context, sample);
      await captureTaskBoard(context, id);
      await captureTimeline(context, id);
      samples.push(sample);
      bridge.save(diagnostic ? 'diagnostic-samples.json' : `iteration-${iteration}.json`, samples);
      bridge.save('progress.json', {
        scenario: id,
        iteration,
        diagnostic,
        state: 'complete',
        at: new Date().toISOString(),
      });
    } catch (error) {
      bridge.save('failure-dom.json', {
        scenario: id,
        error: String(error),
        html: document.querySelector('.abyss-panel-view')?.outerHTML ?? '',
      });
      throw error;
    } finally {
      observation.stop();
    }
  };
}

interface NativeHarness {
  cycle(iteration: number, diagnostic: boolean): Promise<Sample[]>;
  prepareFixture(contents: Record<string, string>): Promise<void>;
  resetFixture(contents: Record<string, string>): Promise<void>;
  cleanup(): Promise<void>;
}

export function install(host: Host, bridge: NativeBridge, options: NativeOptions): NativeHarness {
  if (host.vault.getName() !== 'dev-vault-tasks') throw new Error('Wrong vault');
  const resources = new Map<string, NativeCdp>();
  const pending = new PendingWork();
  const hidden =
    bridge.window === undefined
      ? undefined
      : new HiddenWindowObservation(
          bridge.window,
          document,
          (evidence) => {
            bridge.save('hidden-window.json', evidence);
          },
          pending,
        );
  let active = true;
  const cleanup = async (): Promise<void> => {
    active = false;
    await hidden?.restore();
    await pending.settle();
    await resources.get('cdp')?.close();
    resources.delete('cdp');
  };
  const runCycle = async (iteration: number, diagnostic: boolean): Promise<Sample[]> => {
    if (!active) throw new Error('Profile harness stopped');
    await closePanels(host);
    await host.plugins.disablePlugin('abyss-tasks');
    if (diagnostic) {
      const cdp = new NativeCdp(bridge);
      resources.set('cdp', cdp);
      await cdp.open();
      await cdp.start();
    }
    const samples: Sample[] = [];
    const measure = createMeasure({
      host,
      cdp: resources.get('cdp'),
      bridge,
      iteration,
      diagnostic,
      samples,
      pending,
      viewport: options.viewport,
      isActive: () => active,
    });
    await measure('startup.index', async () => {
      await host.plugins.enablePlugin('abyss-tasks');
      await indexed(host);
      return { roots: options.expectedRoots, nodes: options.expectedNodes };
    });
    assertRoots(host, options.expectedRoots);
    const nodes = plugin(host).queries.listNodes().length;
    if (nodes !== options.expectedNodes)
      throw new Error(`Fixture nodes: expected ${options.expectedNodes}, received ${nodes}`);
    if (options.command === 'stress') await commandStressScenarios(host, options, measure);
    else if (options.command === 'feature') {
      await featureScenarios(host, options, measure, { bridge, diagnostic, iteration, hidden });
    } else if (options.api === true) await apiScenarios(host, options, measure);
    else if (!options.startup)
      await suite(host, options, measure, { cdp: resources.get('cdp'), bridge });
    const cdp = resources.get('cdp');
    if (cdp !== undefined) {
      await cdp.stop();
      await cdp.close();
      resources.delete('cdp');
    }
    return samples;
  };
  return {
    cycle: (iteration, diagnostic) => pending.track(runCycle(iteration, diagnostic)),
    ...fixtureHarness(host, bridge, pending, () => active),
    cleanup,
  };
}

async function featureScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
  context: {
    bridge: NativeBridge;
    diagnostic: boolean;
    iteration: number;
    hidden: HiddenWindowObservation | undefined;
  },
): Promise<void> {
  const { bridge, diagnostic, iteration, hidden } = context;
  if (diagnostic && hidden === undefined) throw new Error('Native window bridge unavailable');
  await commandFeatureScenarios(host, options, measure, {
    failure: (evidence) => {
      bridge.save('note-apply-failure.json', evidence);
    },
  });
  const calls: SearchCallSample[] = [];
  await noteScenarios(host, options, measure, {
    record: (sample) => {
      calls.push(sample);
      bridge.save(
        diagnostic ? 'diagnostic-search-calls.json' : `search-calls-${iteration}.json`,
        calls,
      );
    },
    ...(diagnostic && hidden !== undefined ? { hidden } : {}),
  });
}

async function suite(
  host: Host,
  options: NativeOptions,
  measure: Measure,
  diagnostics: { cdp: NativeCdp | undefined; bridge: NativeBridge },
): Promise<void> {
  const { cdp, bridge } = diagnostics;
  await queryScenarios(host, options, measure);
  await cdp?.memory('search-ready');
  await panelScenarios(host, measure);
  await calendarScenarios(measure);
  await taskBoardScenarios(host, measure);
  await taskTimelineScenarios(host, measure);
  await projectScenarios(measure);
  await statisticsScenarios(host, measure);
  await cdp?.memory('analysis-ready');
  if (cdp !== undefined)
    bridge.save('analysis-dom.json', {
      html: document.querySelector('.abyss-panel-view')?.outerHTML,
      width: innerWidth,
      height: innerHeight,
    });
  await cdp?.screenshot('analysis');
  await indexScenarios(host, options, measure);
  await searchEditScenario(host, options, measure);
  await commandScenarios(host, options, measure);
  await measure('panel.close', async () => {
    await closePanels(host);
    return { panels: host.workspace.getLeavesOfType('task-calendar-panel').length };
  });
  // A ready service does not imply a terminated shared Worker after panel close.
  await plugin(host).search.prepare(new AbortController().signal);
  await cdp?.memory('panel-closed');
}

function fixtureHarness(
  host: FixtureHost,
  bridge: NativeBridge,
  pending: PendingWork,
  isActive: () => boolean,
): Pick<NativeHarness, 'prepareFixture' | 'resetFixture'> {
  const observe: ResetObserver = (diagnostic) => {
    bridge.save('fixture-reset-failure.json', diagnostic);
  };
  return {
    prepareFixture: (contents) => pending.track(fixtureReady(host, contents, isActive, observe)),
    resetFixture: (contents) =>
      pending.track(resetFiles(host, contents, { force: false, isActive, observe })),
  };
}

async function reportResetFailure(
  host: FixtureHost,
  state: Parameters<typeof resetFailure>[1],
  failure: { error: unknown; observe: ResetObserver | undefined },
): Promise<void> {
  if (failure.observe === undefined) return;
  try {
    failure.observe(await resetFailure(host, state));
  } catch (diagnosticError) {
    throw new AggregateError(
      [failure.error, diagnosticError],
      'Fixture readiness and diagnosis failed',
    );
  }
}
