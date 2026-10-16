import { Platform } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { fixtureReady, install, resetFixture } from '../tooling/performance/native';
import { NativeCdp } from '../tooling/performance/native-cdp';
import {
  assertViewport,
  calendarDiagnostics,
  calendarEvidence,
  calendarPopulation,
  scrollRange,
} from '../tooling/performance/native-helpers';
import { activityMetrics } from '../tooling/performance/native-observation';
import {
  queryScenarios,
  scenarioIds,
  taskTextTyping,
} from '../tooling/performance/native-scenarios';
import type { CdpListener, Host, NativeBridge } from '../tooling/performance/native-types';
import { parseCliResult, parseOptions } from '../tooling/performance/options';
import { AbyssProfiler, bounded, PendingWork } from '../tooling/performance/profiler';
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
    expect(scenarioIds('wide-tree', false)).toEqual([
      ...scenarioIds('standard', false).slice(0, -8),
      'index.wide-child-edit',
      'index.metadata-only',
      ...scenarioIds('standard', false).slice(-8),
    ]);
  });
  it.each([
    ['abyss-mg-cell', 'data-mg-date', 'abyss-tg-body'],
    ['abyss-tg-header-cell', 'data-tg-date', 'abyss-tg-block'],
    ['abyss-calendar-date', 'data-calendar-date', 'abyss-calendar-item'],
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
        cell.createDiv({ cls: 'abyss-tg-body', text: 'Populated' });
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
