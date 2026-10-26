import { Platform } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSearchApi, TaskSearchState } from '../src/tasks';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import * as native from '../tooling/performance/native';
import { fixtureReady, install, resetFixture } from '../tooling/performance/native';
import { NativeCdp } from '../tooling/performance/native-cdp';
import {
  assertViewport,
  calendarDiagnostics,
  calendarEvidence,
  calendarPopulation,
  scrollRange,
} from '../tooling/performance/native-helpers';
import { activityMetrics, NativeObservation } from '../tooling/performance/native-observation';
import * as scenarios from '../tooling/performance/native-scenarios';
import {
  queryScenarios,
  scenarioIds,
  taskTextTyping,
} from '../tooling/performance/native-scenarios';
import type {
  CdpListener,
  Host,
  NativeBridge,
  NativeOptions,
} from '../tooling/performance/native-types';
import { parseCliResult, parseOptions } from '../tooling/performance/options';
import { AbyssProfiler, bounded, PendingWork } from '../tooling/performance/profiler';
import type { Sample } from '../tooling/performance/types';
import { canonicalStatusCatalog, createAppWithFiles, seedTaskCache } from './helpers';

const loadClock = async () => {
  if (!Platform.isDesktop) throw new Error('Native clock test requires desktop');
  return (await import('node:perf_hooks')).performance;
};
const performance = await loadClock();

describe('native profile boundaries', () => {
  it('waits for updated link results before typing the next prefix and cancels the draft', async () => {
    const input = document.body.createEl('textarea');
    input.value = 'Original task';
    const seen: string[] = [];
    const ready: string[] = [];
    const keys: string[] = [];
    const menu = document.body.createDiv({ cls: 'abyss-link-suggest' });
    let pending = false;
    let raced = false;
    input.addEventListener('input', () => {
      if (pending) raced = true;
      seen.push(input.value);
      menu.empty();
      if (!input.value.includes('[[')) return;
      const query = input.value.split('[[')[1] ?? '';
      pending = true;
      window.setTimeout(() => {
        const row = menu.createDiv({ cls: 'abyss-link-suggest-option' });
        const title = row.createDiv({ cls: 'abyss-suggest-title' });
        if (query.length > 0) title.createSpan({ cls: 'suggestion-highlight', text: query });
        else title.textContent = 'Project';
        ready.push(query);
        pending = false;
      }, 80);
    });
    input.addEventListener('keydown', (event) => keys.push(event.key));
    try {
      await taskTextTyping(input);
      expect(raced).toBe(false);
      expect(ready).toEqual(['', 'P', 'Pro', 'Project']);
      expect(seen).toEqual(['Check [', 'Check [[', 'Check [[P', 'Check [[Pro', 'Check [[Project']);
      expect(keys).toEqual(['Escape', 'Escape']);
      expect(input.value).toBe('Original task');
    } finally {
      input.remove();
      menu.remove();
    }
  });
  it('drains in-flight preparation and cancels later writes before restoration', async () => {
    const folder = '__abyss_profile_fixture_v1__';
    const contents = { [`${folder}/first.md`]: 'expected', [`${folder}/second.md`]: 'expected' };
    const app = await createAppWithFiles(contents);
    const getName = vi.spyOn(app.vault, 'getName').mockReturnValue('dev-vault-tasks');
    let release = (): void => {};
    const modify = vi.spyOn(app.vault, 'modify').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const bridge: NativeBridge = {
      debugger: {
        isAttached: () => false,
        sendCommand: () => Promise.resolve({}),
        on: () => {},
        removeListener: () => {},
      },
      save: () => {},
      saveImage: () => {},
      matchesWorkerSource: () => false,
    };
    const harness = install(app as Host, bridge, {
      vault: 'dev-vault-tasks',
      fixtureFolder: folder,
      anchor: '2026-10-16',
      fixtureKind: 'standard',
      expectedRoots: 4000,
      expectedNodes: 6000,
      startup: true,
      viewport: '1024x768',
    });
    const prepared = harness.prepareFixture(contents).then(
      () => 'prepared',
      (error: unknown) => String(error),
    );
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      expect(modify).toHaveBeenCalledOnce();
      let clean = false;
      const cleanup = harness.cleanup().then(() => {
        clean = true;
      });
      await Promise.resolve();
      expect(clean).toBe(false);
      release();
      app.metadataCache.trigger(
        'changed',
        app.vault.getFileByPath(`${folder}/first.md`),
        'expected',
        {},
      );
      expect(await prepared).toContain('Profile harness stopped');
      await cleanup;
      expect(clean).toBe(true);
      expect(modify).toHaveBeenCalledOnce();
    } finally {
      getName.mockRestore();
      modify.mockRestore();
    }
  });
  it('rejects a viewport that changes after preflight', () => {
    expect(() => {
      assertViewport(`${window.innerWidth}x${window.innerHeight}`);
    }).not.toThrow();
    expect(() => {
      assertViewport('420x800');
    }).toThrow('Viewport changed');
  });
  it.each(['initial', 'reset'])(
    'waits for %s metadata and exact cached content before allowing the next cycle',
    async (phase) => {
      const path = '__abyss_profile_fixture_v1__/inbox.md';
      const app = await createAppWithFiles({ [path]: 'old' });
      seedTaskCache(app, path, []);
      const content = {
        cached: phase === 'initial' ? 'expected' : 'old',
        disk: phase === 'initial' ? 'expected' : 'old',
      };
      let settled = false;
      const read = vi
        .spyOn(app.vault, 'read')
        .mockImplementation(() => Promise.resolve(content.disk));
      const cachedRead = vi
        .spyOn(app.vault, 'cachedRead')
        .mockImplementation(() => Promise.resolve(content.cached));
      const modify = vi.spyOn(app.vault, 'modify').mockImplementation((_file, value) => {
        content.disk = value;
        return Promise.resolve();
      });
      const prepare = phase === 'initial' ? fixtureReady : resetFixture;
      const pending = prepare(app, { [path]: 'expected' }).then(() => {
        settled = true;
      });
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        expect(modify).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        content.cached = 'old';
        app.metadataCache.trigger('changed', app.vault.getFileByPath(path), 'expected', {});
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        expect(settled).toBe(false);
        content.cached = 'expected';
        await pending;
        expect(settled).toBe(true);
      } finally {
        read.mockRestore();
        cachedRead.mockRestore();
        modify.mockRestore();
      }
    },
  );
  it.each([true, false])(
    'only owned Worker failures are fatal; always detach (disconnect=%s)',
    async (disconnected) => {
      let listener: CdpListener | undefined;
      const commands: string[] = [];
      const saved = new Map<string, unknown>();
      const bridge: NativeBridge = {
        debugger: {
          isAttached: () => true,
          on: (_event, handler) => {
            listener = handler;
          },
          removeListener: () => {
            listener = undefined;
          },
          sendCommand: (method, _params, session) => {
            commands.push(`${session ?? 'root'}:${method}`);
            if (method === 'Target.getTargetInfo')
              return Promise.resolve({ targetInfo: { targetId: 'page' } });
            if (method === 'Target.attachToTarget')
              return Promise.resolve({ sessionId: 'renderer' });
            if (method === 'Runtime.evaluate')
              return Promise.resolve({
                result: { value: { url: 'blob:search', dedicated: true } },
              });
            if (disconnected && method === 'Profiler.stop' && session === 'worker')
              return Promise.reject(new Error('Worker disconnected'));
            return Promise.resolve({});
          },
        },
        matchesWorkerSource: () => true,
        save: (name, value) => {
          saved.set(name, value);
        },
        saveImage: () => {},
      };
      vi.stubGlobal(
        'XMLHttpRequest',
        class {
          responseText = '/* abyss-task-search-worker */';
          onload?: () => void;
          onerror?: () => void;
          url = '';
          open(_method: string, url: string): void {
            this.url = url;
          }
          send(): void {
            if (this.url === 'blob:foreign') this.onerror?.();
            else this.onload?.();
          }
        },
      );
      const cdp = new NativeCdp(bridge);
      try {
        await cdp.open();
        listener?.(
          undefined,
          'Target.attachedToTarget',
          {
            sessionId: 'foreign',
            targetInfo: { targetId: 'foreign', type: 'worker', url: 'blob:foreign' },
          },
          'renderer',
        );
        listener?.(
          undefined,
          'Target.attachedToTarget',
          {
            sessionId: 'worker',
            targetInfo: { targetId: 'search', type: 'worker', url: 'blob:search' },
          },
          'renderer',
        );
        await cdp.memory('search-ready');
        if (disconnected) await expect(cdp.stop()).rejects.toThrow('Worker profile unavailable');
        else await expect(cdp.stop()).resolves.toBeUndefined();
        expect(saved.has('diagnostic-notes.json')).toBe(true);
      } finally {
        await cdp.close();
        vi.unstubAllGlobals();
      }
      expect(commands[commands.length - 1]).toBe('root:Target.detachFromTarget');
      expect(listener).toBeUndefined();
    },
  );
  it('does not allow restoration until timed-out work has actually settled', async () => {
    const work = new PendingWork();
    let release = (): void => {};
    const action = work.track(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await expect(bounded(action, 5, 'action')).rejects.toThrow('Timed out');
    let drained = false;
    const cleanup = work.settle().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await cleanup;
    expect(drained).toBe(true);
  });
  it('rejects ambiguous or invalid CLI arguments', () => {
    expect(parseOptions(['--runs', '12', '--startup']).runs).toBe(12);
    expect(parseOptions(['--width', '420']).width).toBe(420);
    expect(() => parseOptions(['--width', '12'])).toThrow();
    for (const args of [
      ['--runs', '0'],
      ['--runs', 'NaN'],
      ['--unknown'],
      ['--runs'],
      ['--runs', '1', '--runs', '2'],
      ['--compare', 'one'],
    ])
      expect(() => parseOptions(args)).toThrow();
    expect(parseOptions(['--compare', 'before', 'after']).compare).toEqual(['before', 'after']);
    expect(parseOptions(['--recover-offline', 'run']).recoverOffline).toBe('run');
    expect(() => parseOptions(['--recover-offline', 'run', '--runs', '2'])).toThrow();
  });
  it('selects only the finite fixture roster and keeps startup mode startup-only', () => {
    expect(parseOptions([]).fixture).toBe('standard');
    expect(parseOptions(['--fixture', 'wide-tree']).fixture).toBe('wide-tree');
    expect(() => parseOptions(['--fixture', 'unknown'])).toThrow();
    expect(scenarioIds('standard', true)).toEqual(['startup.index']);
    expect(scenarioIds('wide-tree', true)).toEqual(['startup.index']);
    expect(scenarioIds('standard', false)).not.toContain('index.wide-child-edit');
    expect(scenarioIds('standard', false).slice(-9, -7)).toEqual([
      'search.edit-to-query',
      'command.create',
    ]);
    expect(scenarioIds('wide-tree', false)).toEqual([
      ...scenarioIds('standard', false).slice(0, -9),
      'index.wide-child-edit',
      'index.metadata-only',
      ...scenarioIds('standard', false).slice(-9),
    ]);
  });
  it.each([
    ['abyss-mg-cell', 'data-mg-date', 'abyss-mg-plain'],
    ['abyss-mg-cell', 'data-mg-date', 'abyss-mg-block-dot'],
    ['abyss-mg-cell', 'data-mg-date', 'abyss-mg-deadline-marker'],
    ['abyss-tg-header-cell', 'data-tg-date', 'abyss-tg-block'],
    ['abyss-calendar-date', 'data-calendar-date', 'abyss-calendar-item'],
    ['abyss-calendar-date', 'data-calendar-date', 'abyss-task-card'],
  ])('accepts populated calendar evidence from %s', (cls, attribute, cardClass) => {
    const root = document.body.createDiv();
    const date = root.createDiv({ cls });
    date.setAttribute(attribute, '2026-10-16');
    const cards =
      cls === 'abyss-calendar-date' ? root.createDiv({ cls: 'abyss-calendar-agenda' }) : date;
    if (cls === 'abyss-calendar-date') cards.setAttribute('data-calendar-date', '2026-10-16');
    try {
      expect(() => calendarEvidence(root, 1)).toThrow('populated');
      const card = cards.createDiv({ cls: cardClass, text: 'Profile task' });
      expect(calendarEvidence(root, 1)).toMatchObject({ dates: ['2026-10-16'], renderedCards: 1 });
      card.setAttribute('aria-busy', 'true');
      expect(() => calendarEvidence(root, 1)).toThrow('populated');
      card.removeAttribute('aria-busy');
      card.textContent = '';
      expect(() => calendarEvidence(root, 1)).toThrow('populated');
    } finally {
      root.remove();
    }
  });
  it('counts canonical task cards only inside the agenda and counts a matching card once', () => {
    const root = document.body.createDiv();
    root.createDiv({ cls: 'abyss-calendar-date', attr: { 'data-calendar-date': '2026-10-16' } });
    const agenda = root.createDiv({
      cls: 'abyss-calendar-agenda',
      attr: { 'data-calendar-date': '2026-10-16' },
    });
    root.createDiv({ cls: 'abyss-task-card', text: 'Unrelated inspector card' });
    try {
      expect(() => calendarEvidence(root, 1)).toThrow('populated');
      const card = agenda.createDiv({
        cls: 'abyss-task-card abyss-calendar-item',
        text: 'Agenda task',
      });
      expect(calendarEvidence(root, 1).renderedCards).toBe(1);
      card.remove();
      expect(() => calendarEvidence(root, 1)).toThrow('populated');
    } finally {
      root.remove();
    }
  });
  it('counts compact month cards and shared span bodies once in a populated month', () => {
    const root = document.body.createDiv();
    const cell = root.createDiv({ cls: 'abyss-mg-cell', attr: { 'data-mg-date': '2026-10-16' } });
    try {
      for (const cls of ['abyss-mg-plain', 'abyss-mg-block-dot', 'abyss-mg-deadline-marker']) {
        cell.createDiv({ cls, text: 'Profile task' });
      }
      expect(calendarEvidence(root, 3)).toMatchObject({ dates: ['2026-10-16'], renderedCards: 3 });
      cell.createDiv({ cls: 'abyss-tg-body', text: 'Shared span body' });
      expect(calendarEvidence(root, 4).renderedCards).toBe(4);
      expect(calendarDiagnostics(root).renderedCards).toBe(4);
    } finally {
      root.remove();
    }
  });
  it('rejects invalid dates and a compact calendar without its selected agenda', () => {
    const root = document.body.createDiv();
    const date = root.createDiv({ cls: 'abyss-calendar-date' });
    date.dataset['calendarDate'] = '2026-02-31';
    try {
      expect(() => calendarEvidence(root, 0)).toThrow('date');
      date.dataset['calendarDate'] = '2026-10-16';
      expect(() => calendarEvidence(root, 0)).toThrow('agenda');
      const agenda = root.createDiv({ cls: 'abyss-calendar-agenda' });
      agenda.dataset['calendarDate'] = '2026-10-17';
      expect(() => calendarEvidence(root, 0)).toThrow('outside');
      agenda.dataset['calendarDate'] = '2026-10-16';
      expect(calendarEvidence(root, 0)).toMatchObject({
        renderedCards: 0,
        agendaDate: '2026-10-16',
      });
    } finally {
      root.remove();
    }
  });
  it('keeps semantic occurrence identity when compact rendering reduces cards and records zero-height geometry', async () => {
    const app = await createAppWithFiles({
      'calendar.md': '- [ ] First 📅 2026-10-16\n- [ ] Second 📅 2026-10-17',
    });
    seedTaskCache(app, 'calendar.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
    ]);
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    Object.defineProperty(app, 'plugins', {
      value: { plugins: { 'abyss-tasks': { queries: index } } },
    });
    const root = document.body.createDiv();
    try {
      await index.initialize();
      for (const day of ['2026-10-16', '2026-10-17']) {
        const cell = root.createDiv({ cls: 'abyss-mg-cell' });
        cell.dataset['mgDate'] = day;
        cell.createDiv({ cls: 'abyss-mg-plain', text: 'Populated' });
      }
      const options = {
        vault: 'dev-vault-tasks',
        fixtureFolder: '__abyss_profile_fixture_v1__',
        anchor: '2026-10-16',
        fixtureKind: 'standard' as const,
        expectedRoots: 2,
        expectedNodes: 3,
        startup: false,
        viewport: '1024x768',
      };
      const onlyPopulation = async (
        id: string,
        action: () => Promise<Record<string, string | number | boolean>>,
      ): Promise<void> => {
        if (id === 'query.roots' || id === 'query.nodes') await action();
      };
      await expect(queryScenarios(app as Host, options, onlyPopulation)).rejects.toThrow(
        'Fixture nodes',
      );
      await expect(
        queryScenarios(app as Host, { ...options, expectedRoots: 3 }, onlyPopulation),
      ).rejects.toThrow('Fixture roots');
      const before = calendarPopulation(app as Host, calendarEvidence(root, 2).dates);
      expect(before.occurrences).toBe(2);
      expect(JSON.parse(before.occurrencePopulation)).toEqual([
        ['calendar.md:0:2026-10-16', 'materialized', { due: '2026-10-16' }],
        ['calendar.md:1:2026-10-17', 'materialized', { due: '2026-10-17' }],
      ]);
      root.empty();
      for (const day of ['2026-10-16', '2026-10-17'])
        root.createDiv({ cls: 'abyss-calendar-date', attr: { 'data-calendar-date': day } });
      const agenda = root.createDiv({
        cls: 'abyss-calendar-agenda',
        attr: { 'data-calendar-date': '2026-10-16' },
      });
      agenda.createDiv({ cls: 'abyss-calendar-item', text: 'First' });
      expect(calendarEvidence(root, 2).renderedCards).toBe(1);
      expect(calendarPopulation(app as Host, calendarEvidence(root, 2).dates)).toEqual(before);
      const grid = root.createDiv({ cls: 'abyss-tg-grid-row' });
      Object.defineProperty(grid, 'scrollHeight', { value: 1440 });
      const diagnostics = calendarDiagnostics(root);
      expect(diagnostics.renderedCards).toBe(1);
      expect(
        diagnostics.surfaces.find((surface) => surface.className === 'abyss-tg-grid-row'),
      ).toMatchObject({ height: 0, clientHeight: 0, scrollHeight: 1440 });
    } finally {
      root.remove();
      index.destroy();
    }
  });
  it('recognizes only an explicit successful CLI envelope', () => {
    expect(parseCliResult('=> {"ok":true,"value":{"n":12}}\n')).toEqual({ n: 12 });
    expect(() => parseCliResult('Error: app missing')).toThrow();
    expect(() => parseCliResult('=> {"ok":false,"error":"fixture missing"}')).toThrow(
      'fixture missing',
    );
  });
  it('cleans owned marks after failed actions and preserves other marks', async () => {
    performance.mark('unrelated');
    const profiler = new AbyssProfiler(performance);
    await expect(
      profiler.measure('failure', 0, async () => {
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');
    expect(
      performance.getEntriesByType('mark').filter((m) => m.name.startsWith('abyss-profile:')),
    ).toEqual([]);
    expect(performance.getEntriesByName('unrelated')).toHaveLength(1);
    const sample = await profiler.measure('read', 0, () => Promise.resolve({ nodes: 6000 }));
    expect(sample.durationMs).toBeGreaterThanOrEqual(0);
    expect(sample.facts).toEqual({ nodes: 6000 });
    performance.clearMarks('unrelated');
  });
  it('bounds a hanging operation without hiding its original rejection', async () => {
    await expect(bounded(new Promise(() => {}), 5, 'native readiness')).rejects.toThrow(
      'native readiness',
    );
    await expect(bounded(Promise.reject(new Error('original')), 100, 'operation')).rejects.toThrow(
      'original',
    );
  });
  it('counts a long task that starts before the measured action and clips its overlap', () => {
    expect(
      activityMetrics(
        [
          { startTime: 90, duration: 70 },
          { startTime: 180, duration: 60 },
        ],
        [120, 140],
        100,
        200,
      ),
    ).toEqual({ longTasks: 2, longTaskMs: 80, maxFrameGapMs: 60 });
    expect(activityMetrics([], [], 100, 103)).toEqual({
      longTasks: 0,
      longTaskMs: 0,
      maxFrameGapMs: 3,
    });
  });
  it('waits for the new scroll range to hydrate before proceeding', async () => {
    const scroller = document.body.createDiv();
    const card = scroller.createDiv();
    card.className = 'abyss-task-card';
    card.textContent = 'Old range';
    scroller.append(card);
    document.body.append(scroller);
    Object.defineProperties(scroller, {
      scrollHeight: { value: 5000 },
      clientHeight: { value: 500 },
    });
    let hydrated = false;
    scroller.addEventListener('scroll', () => {
      card.inert = true;
      card.setAttribute('aria-busy', 'true');
      window.setTimeout(() => {
        card.textContent = 'New range';
        card.inert = false;
        card.removeAttribute('aria-busy');
        hydrated = true;
      }, 100);
    });
    try {
      await scrollRange(scroller, 0.5);
      expect(hydrated).toBe(true);
      expect(scroller.scrollTop).toBe(2250);
    } finally {
      scroller.remove();
    }
  });
});

type SearchCursor = Awaited<ReturnType<TaskSearchApi['open']>>;
type SearchRequest = Parameters<TaskSearchApi['open']>[0];

async function searchEditHarness() {
  const folder = '__abyss_profile_fixture_v1__';
  const project = `${folder}/projects/Project-000.md`;
  const inbox = `${folder}/inbox.md`;
  const originalProject =
    '- [ ] Profile task 0 database #profile/group0 🆔 profile-0\n  - [ ] Child 0\n';
  const originalInbox = '# Performance command sandbox\n';
  const app = await createAppWithFiles({ [project]: originalProject, [inbox]: originalInbox });
  seedTaskCache(app, project, [{ task: ' ', parent: -1, line: 0 }]);
  seedTaskCache(app, inbox, []);
  const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
  await index.initialize();
  const states = new Set<(state: TaskSearchState) => void>();
  const signals: AbortSignal[] = [];
  let generation = 1;
  let current: TaskSearchState = {
    phase: 'ready',
    generation,
    compatibility: false,
    semanticsRevision: 0,
  };
  const publish = (state: TaskSearchState): void => {
    current = state;
    for (const listener of states) listener(state);
  };
  const hit = { address: { epoch: 'profile', version: 1, rootId: 2, childLines: [] }, score: 1 };
  const cursor = {
    id: 'profile',
    generation: 3,
    total: 1,
    kind: 'nodes' as const,
    access: 'random' as const,
  };
  const resolveHits: TaskSearchApi['resolveHits'] = (_hits, _signal) => {
    const task = index.listNodes({ filePath: inbox })[0];
    if (task === undefined) throw new Error('Canonical inbox task missing');
    return Promise.resolve([{ hit, task }]);
  };
  const search = {
    subscribe: (listener) => {
      states.add(listener);
      listener(current);
      return () => {
        states.delete(listener);
      };
    },
    prepare: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      publish({
        phase: 'ready',
        generation: ++generation,
        compatibility: false,
        semanticsRevision: 0,
      });
      return Promise.resolve();
    }),
    open: vi.fn((_request: SearchRequest, _signal: AbortSignal) => Promise.resolve(cursor)),
    read: vi.fn((_cursor: SearchCursor, _offset: number, _limit: number, _signal: AbortSignal) =>
      Promise.resolve({ cursor, offset: 0, hits: [hit], done: true }),
    ),
    resolveHits: vi.fn(resolveHits),
    release: vi.fn((_cursor: SearchCursor) => {}),
  } satisfies TaskSearchApi;
  Object.defineProperty(app, 'plugins', {
    value: { plugins: { 'abyss-tasks': { queries: index, search } } },
  });
  const modify = app.vault.modify.bind(app.vault);
  const writes: string[] = [];
  const modifySpy = vi.spyOn(app.vault, 'modify').mockImplementation(async (file, content) => {
    writes.push(content);
    await modify(file, content);
    seedTaskCache(
      app,
      file.path,
      content
        .split('\n')
        .flatMap((line, n) => (line.startsWith('- [') ? [{ task: ' ', parent: -1, line: n }] : [])),
    );
  });
  const subscribe = index.subscribe.bind(index);
  const subscriptions = vi
    .spyOn(index, 'subscribe')
    .mockImplementation((listener) => vi.fn(subscribe(listener)));
  const options: NativeOptions = {
    vault: 'dev-vault-tasks',
    fixtureFolder: folder,
    anchor: '2026-10-16',
    fixtureKind: 'standard',
    expectedRoots: 1,
    expectedNodes: 2,
    startup: false,
    viewport: '1024x768',
  };
  let facts: Record<string, string | number | boolean> | undefined;
  const run = async (): Promise<void> => {
    expect(scenarios).toHaveProperty('searchEditScenario', expect.any(Function));
    await scenarios.searchEditScenario(app as Host, options, async (id, action, prepare) => {
      expect(id).toBe('search.edit-to-query');
      expect(prepare).toBeTypeOf('function');
      await prepare?.();
      facts = await action();
    });
  };
  const cleanup = (): void => {
    modifySpy.mockRestore();
    subscriptions.mockRestore();
    index.destroy();
  };
  return {
    app,
    index,
    search,
    resolveHits,
    publish,
    cursor,
    hit,
    states,
    signals,
    writes,
    subscriptions,
    options,
    run,
    cleanup,
    project,
    inbox,
    originalProject,
    originalInbox,
    facts: () => facts,
  };
}

function searchFailureMessage(failure: string): string {
  if (failure === 'preparation-failure') return 'prepare failed';
  if (failure.startsWith('inline-') || ['recovering', 'failed', 'disposed'].includes(failure))
    return 'Worker search workload invalidated';
  if (failure === 'cursor-generation') return 'generation mismatch';
  if (failure === 'wrong-count') return 'expected one result';
  return 'hydration';
}

describe('edit-to-search native scenario', () => {
  it('waits beyond canonical acceptance for actual search readiness and hydration, releases before completion, and leaves reset bytes', async () => {
    expect(scenarios).toHaveProperty('searchEditScenario', expect.any(Function));
    const h = await searchEditHarness();
    let publishSearch = (): void => {};
    let hydrate = (): void => {};
    vi.mocked(h.search.prepare)
      .mockImplementationOnce(() => {
        h.publish({ phase: 'ready', generation: 2, compatibility: false, semanticsRevision: 0 });
        return Promise.resolve();
      })
      .mockImplementationOnce((signal) => {
        h.signals.push(signal);
        h.publish({
          phase: 'updating',
          generation: 3,
          semanticsRevision: 0,
          completedFiles: 0,
          totalFiles: 2,
        });
        publishSearch = () => {
          h.publish({ phase: 'ready', generation: 3, compatibility: false, semanticsRevision: 0 });
        };
        return Promise.resolve();
      });
    const resolve = h.resolveHits;
    vi.mocked(h.search.resolveHits).mockImplementation(
      (hits, signal) =>
        new Promise((accept, reject) => {
          hydrate = () => {
            resolve(hits, signal).then(accept, reject);
          };
        }),
    );
    let complete = false;
    const pending = h.run().then(() => {
      complete = true;
    });
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => {
        expect(h.search.prepare).toHaveBeenCalledTimes(2);
      });
      expect(h.index.list({ filePath: h.inbox })[0]?.title).toBe('abysssearchlatency sandbox');
      expect(complete).toBe(false);
      expect(h.search.open).not.toHaveBeenCalled();
      publishSearch();
      await vi.waitFor(() => {
        expect(h.search.resolveHits).toHaveBeenCalledOnce();
      });
      expect(complete).toBe(false);
      expect(h.search.release).not.toHaveBeenCalled();
      hydrate();
      await pending;
      expect(h.search.release).toHaveBeenCalledExactlyOnceWith(h.cursor);
      expect(h.search.open).toHaveBeenCalledWith(
        { kind: 'nodes', query: 'abysssearchlatency', matchScope: 'node' },
        expect.any(AbortSignal),
      );
      expect(h.facts()).toEqual({
        primingEdits: 1,
        edits: 1,
        roots: 2,
        nodes: 3,
        results: 1,
        hydrated: 1,
        exactTitle: true,
        exactPath: true,
        currentTarget: true,
        matchingGeneration: true,
        backend: 'worker',
      });
      expect(h.writes).toEqual([
        h.originalProject.replace(
          'Profile task 0 database',
          'Profile task 0 database abysssearchprime',
        ),
        `${h.originalInbox}\n- [ ] abysssearchlatency sandbox\n`,
      ]);
      expect(h.states.size).toBe(0);
      expect(h.signals.every((signal) => signal.aborted)).toBe(true);
      expect(h.subscriptions).toHaveBeenCalledOnce();
      for (const result of h.subscriptions.mock.results)
        if (result.type === 'return') expect(result.value).toHaveBeenCalledOnce();
    } finally {
      h.cleanup();
    }
  });
  it.each([
    'inline-prime',
    'inline-measured',
    'recovering',
    'failed',
    'disposed',
    'cursor-generation',
    'changed-after-hydration',
    'stale-target',
    'wrong-title',
    'wrong-path',
    'wrong-count',
    'empty-hydration',
    'preparation-failure',
    'cancelled-measure',
  ])('rejects %s and always cleans subscriptions and search work', async (failure) => {
    expect(scenarios).toHaveProperty('searchEditScenario', expect.any(Function));
    const h = await searchEditHarness();
    let primed = false;
    vi.mocked(h.search.prepare).mockImplementation((signal) => {
      h.signals.push(signal);
      const generation = primed ? 3 : 2;
      if (failure === 'preparation-failure') return Promise.reject(new Error('prepare failed'));
      const inline = failure === (primed ? 'inline-measured' : 'inline-prime');
      h.publish({ phase: 'ready', generation, compatibility: inline, semanticsRevision: 0 });
      primed = true;
      return Promise.resolve();
    });
    if (['recovering', 'failed', 'disposed'].includes(failure))
      vi.mocked(h.search.open).mockImplementation(() => {
        const common = { generation: 3, semanticsRevision: 0 };
        if (failure === 'recovering')
          h.publish({ ...common, phase: 'recovering', completedFiles: 0, totalFiles: 2 });
        if (failure === 'failed') h.publish({ ...common, phase: 'failed', episode: 1 });
        if (failure === 'disposed') h.publish({ ...common, phase: 'disposed' });
        h.publish({ ...common, phase: 'ready', compatibility: false });
        return Promise.resolve(h.cursor);
      });
    if (failure === 'cursor-generation')
      vi.mocked(h.search.open).mockResolvedValue({ ...h.cursor, generation: 2 });
    if (failure === 'wrong-count')
      vi.mocked(h.search.open).mockResolvedValue({ ...h.cursor, total: 2 });
    const resolve = h.resolveHits;
    vi.mocked(h.search.resolveHits).mockImplementation(async (hits, signal) => {
      const rows = await resolve(hits, signal);
      const row = rows[0];
      if (row === undefined) throw new Error('Missing test row');
      if (failure === 'empty-hydration') return [];
      if (failure === 'changed-after-hydration')
        h.publish({ phase: 'ready', generation: 4, compatibility: false, semanticsRevision: 0 });
      if (failure === 'stale-target')
        return [
          {
            ...row,
            task: {
              ...row.task,
              target: {
                type: 'task',
                ref: { ...row.task.root.ref, revision: `${row.task.root.ref.revision}-stale` },
              },
            },
          },
        ];
      if (failure === 'wrong-title')
        return [{ ...row, task: { ...row.task, node: { ...row.task.root, title: 'old title' } } }];
      if (failure === 'wrong-path')
        return [
          {
            ...row,
            task: {
              ...row.task,
              root: { ...row.task.root, ref: { ...row.task.root.ref, filePath: 'other.md' } },
            },
          },
        ];
      return rows;
    });
    try {
      if (failure === 'cancelled-measure') {
        expect(scenarios).toHaveProperty('searchEditScenario', expect.any(Function));
        await expect(
          scenarios.searchEditScenario(h.app as Host, h.options, async (_id, _action, prepare) => {
            await prepare?.();
            throw new Error('cancelled');
          }),
        ).rejects.toThrow('cancelled');
      } else await expect(h.run()).rejects.toThrow(searchFailureMessage(failure));
      for (const result of h.subscriptions.mock.results)
        if (result.type === 'return') expect(result.value).toHaveBeenCalledOnce();
      expect(h.states.size).toBe(0);
      expect(h.signals.every((signal) => signal.aborted)).toBe(true);
      if (vi.mocked(h.search.open).mock.results.some((result) => result.type === 'return'))
        expect(h.search.release).toHaveBeenCalledOnce();
      expect(h.writes.length).toBeLessThanOrEqual(2);
    } finally {
      h.cleanup();
    }
  });
});

describe('measurement preparation boundary', () => {
  it.each([
    ['ui.tasks.timeline', 'task-timeline', 'abyss-task-timeline'],
    ['ui.projects.timeline', 'project-timeline', 'abyss-project-timeline'],
  ])(
    'captures %s DOM geometry and a screenshot only in the diagnostic pass',
    async (id, name, cls) => {
      const center = document.body.createDiv({ cls: 'abyss-center' });
      const root = center.createDiv({ cls });
      const scroll = cls === 'abyss-task-timeline' ? root : root.createDiv();
      scroll.addClass('abyss-project-timeline-scroll');
      scroll.createDiv({ cls: 'abyss-project-timeline-row', text: 'A ready row' });
      const saved: Record<string, unknown> = {};
      const screenshots: string[] = [];
      const start = vi.spyOn(NativeObservation.prototype, 'start').mockImplementation(() => {});
      const stop = vi.spyOn(NativeObservation.prototype, 'stop').mockImplementation(() => {});
      const read = vi.spyOn(NativeObservation.prototype, 'read').mockReturnValue({
        longTasks: 0,
        longTaskMs: 0,
        maxFrameGapMs: 0,
        domNodes: 0,
      });
      try {
        for (const diagnostic of [false, true]) {
          const measure = native.createMeasure({
            host: {} as Host,
            cdp: {
              screenshot: (label: string) => {
                screenshots.push(label);
                return Promise.resolve();
              },
            } as unknown as NativeCdp,
            bridge: {
              save: (file: string, value: unknown) => {
                saved[file] = value;
              },
            } as unknown as NativeBridge,
            iteration: 0,
            diagnostic,
            samples: [],
            pending: new PendingWork(),
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            isActive: () => true,
          });
          await measure(id, () => Promise.resolve({ view: 'timeline' }));
          if (!diagnostic) {
            expect(screenshots).toEqual([]);
            expect(saved).not.toHaveProperty(`${name}-dom.json`);
          }
        }
        expect(screenshots).toEqual([name]);
        expect(saved[`${name}-dom.json`]).toMatchObject({
          mounted: 1,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          html: root.outerHTML,
          scroll: { left: 0, top: 0 },
        });
      } finally {
        center.remove();
        start.mockRestore();
        stop.mockRestore();
        read.mockRestore();
      }
    },
  );
  it('keeps timed-out preparation tracked until it settles before restoration', async () => {
    vi.useFakeTimers();
    const pending = new PendingWork();
    const action = vi.fn(() => Promise.resolve({}));
    let release = (): void => {};
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => {
        callback(0);
      });
      return 1;
    });
    const measure = native.createMeasure({
      host: {} as Host,
      cdp: undefined,
      bridge: { save: () => {} } as unknown as NativeBridge,
      iteration: 0,
      diagnostic: false,
      samples: [],
      pending,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      isActive: () => true,
    });
    const result = measure(
      'test.timeout',
      action,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ).then(
      () => 'complete',
      (error: unknown) => String(error),
    );
    try {
      await vi.advanceTimersByTimeAsync(30001);
      expect(await result).toContain('Timed out: test.timeout preparation');
      expect(action).not.toHaveBeenCalled();
      let restored = false;
      const restoration = pending.settle().then(() => {
        restored = true;
      });
      await Promise.resolve();
      expect(restored).toBe(false);
      release();
      await restoration;
      expect(restored).toBe(true);
    } finally {
      release();
      raf.mockRestore();
      vi.useRealTimers();
    }
  });

  it('unwinds both scenario listeners and aborts search when preparation times out', async () => {
    const h = await searchEditHarness();
    vi.useFakeTimers();
    const pending = new PendingWork();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => {
        callback(0);
      });
      return 1;
    });
    vi.mocked(h.search.prepare).mockImplementation((signal) => {
      h.signals.push(signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('search aborted'));
          },
          { once: true },
        );
      });
    });
    const measure = native.createMeasure({
      host: h.app as Host,
      cdp: undefined,
      bridge: { save: () => {} } as unknown as NativeBridge,
      iteration: 0,
      diagnostic: false,
      samples: [],
      pending,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      isActive: () => true,
    });
    const result = scenarios.searchEditScenario(h.app as Host, h.options, measure).then(
      () => 'complete',
      (error: unknown) => String(error),
    );
    try {
      await vi.advanceTimersByTimeAsync(30001);
      expect(await result).toContain('Timed out: search.edit-to-query preparation');
      await pending.settle();
      expect(h.states.size).toBe(0);
      expect(h.signals).toHaveLength(1);
      expect(h.signals[0]?.aborted).toBe(true);
      for (const returned of h.subscriptions.mock.results)
        if (returned.type === 'return') expect(returned.value).toHaveBeenCalledOnce();
      expect(h.writes).toHaveLength(1);
    } finally {
      raf.mockRestore();
      vi.useRealTimers();
      h.cleanup();
    }
  });

  it('rejects cancellation during frame settling before preparation can write', async () => {
    let active = true;
    const prepare = vi.fn(() => Promise.resolve());
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => {
        active = false;
        callback(0);
      });
      return 1;
    });
    const measure = native.createMeasure({
      host: {} as Host,
      cdp: undefined,
      bridge: { save: () => {} } as unknown as NativeBridge,
      iteration: 0,
      diagnostic: false,
      samples: [],
      pending: new PendingWork(),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      isActive: () => active,
    });
    try {
      await expect(measure('test.cancelled', () => Promise.resolve({}), prepare)).rejects.toThrow(
        'Profile harness stopped',
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      raf.mockRestore();
    }
  });

  it.each(['success', 'failure', 'cancellation'] as const)(
    'settles frames before preparation and owns cleanup on %s',
    async (outcome) => {
      expect(native).toHaveProperty('createMeasure', expect.any(Function));
      const events: string[] = [];
      const samples: Sample[] = [];
      const pending = new PendingWork();
      let active = true;
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
        window.setTimeout(() => {
          events.push('frame');
          callback(0);
        }, 0),
      );
      const start = vi.spyOn(NativeObservation.prototype, 'start').mockImplementation(() => {
        events.push('observe');
      });
      const stop = vi.spyOn(NativeObservation.prototype, 'stop').mockImplementation(() => {
        events.push('stop');
      });
      const read = vi
        .spyOn(NativeObservation.prototype, 'read')
        .mockReturnValue({ longTasks: null, longTaskMs: null, maxFrameGapMs: 0, domNodes: 0 });
      const measure = native.createMeasure({
        host: {} as Host,
        cdp: undefined,
        bridge: { save: () => {} } as unknown as NativeBridge,
        iteration: 0,
        diagnostic: false,
        samples,
        pending,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        isActive: () => active,
      });
      try {
        const operation = measure(
          'test.preparation',
          () => {
            events.push('action');
            return Promise.resolve({});
          },
          () => {
            events.push('prepare');
            if (outcome === 'failure') return Promise.reject(new Error('preparation failed'));
            if (outcome === 'cancellation') active = false;
            return Promise.resolve();
          },
        );
        if (outcome === 'success') {
          await operation;
          expect(events.slice(0, 5)).toEqual(['frame', 'frame', 'prepare', 'observe', 'action']);
          expect(samples).toHaveLength(1);
        } else {
          await expect(operation).rejects.toThrow(
            outcome === 'failure' ? 'preparation failed' : 'Profile harness stopped',
          );
          expect(events).not.toContain('action');
          expect(samples).toEqual([]);
        }
        await pending.settle();
        expect(events[events.length - 1]).toBe('stop');
      } finally {
        raf.mockRestore();
        start.mockRestore();
        stop.mockRestore();
        read.mockRestore();
      }
    },
  );
});
