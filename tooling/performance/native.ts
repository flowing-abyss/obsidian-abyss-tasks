import { NativeCdp } from './native-cdp.ts';
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
import { NativeObservation } from './native-observation.ts';
import {
  calendarScenarios,
  commandScenarios,
  indexScenarios,
  panelScenarios,
  projectScenarios,
  queryScenarios,
  searchEditScenario,
  statisticsScenarios,
  type Measure,
} from './native-scenarios.ts';
import type { Host, NativeBridge, NativeOptions } from './native-types.ts';
import { AbyssProfiler, bounded, PendingWork } from './profiler.ts';
import { FIXTURE_FOLDER, type Sample } from './types.ts';

export { settings } from './options.ts';

export async function fixtureReady(
  host: Pick<Host, 'vault' | 'metadataCache'>,
  contents: Record<string, string>,
  isActive = (): boolean => true,
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
  await resetFixture(host, contents, true, isActive);
}

export async function resetFixture(
  host: Pick<Host, 'vault' | 'metadataCache'>,
  contents: Record<string, string>,
  force = false,
  isActive = (): boolean => true,
): Promise<void> {
  for (const [path, expected] of Object.entries(contents)) {
    if (!isActive()) throw new Error('Profile harness stopped');
    if (!path.startsWith(`${FIXTURE_FOLDER}/`) || path.split('/').includes('..'))
      throw new Error('Reset is restricted to generated fixture files');
    const file = host.vault.getFileByPath(path);
    if (file === null) throw new Error(`Reset file missing: ${path}`);
    const matches = async (): Promise<boolean> =>
      (await host.vault.read(file)) === expected &&
      (await host.vault.cachedRead(file)) === expected;
    if (!force && (await matches())) continue;
    let changed = false;
    const ref = host.metadataCache.on('changed', (updated, content) => {
      if (updated.path === path && content === expected) changed = true;
    });
    try {
      await host.vault.modify(file, expected);
      await waitFor(
        async () => changed && (await matches()),
        `reset contents and metadata: ${path}`,
        30000,
      );
    } finally {
      host.metadataCache.offref(ref);
    }
  }
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
  let active = true;
  const cleanup = async (): Promise<void> => {
    active = false;
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
    if (!options.startup)
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
    prepareFixture: (contents) => pending.track(fixtureReady(host, contents, () => active)),
    resetFixture: (contents) => pending.track(resetFixture(host, contents, false, () => active)),
    cleanup,
  };
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
