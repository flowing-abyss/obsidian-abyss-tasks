import { Platform } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { fixtureReady, install, resetFixture } from '../tooling/performance/native';
import { NativeCdp } from '../tooling/performance/native-cdp';
import { assertViewport, scrollRange } from '../tooling/performance/native-helpers';
import { activityMetrics } from '../tooling/performance/native-observation';
import type { CdpListener, Host, NativeBridge } from '../tooling/performance/native-types';
import { parseCliResult, parseOptions } from '../tooling/performance/options';
import { AbyssProfiler, bounded, PendingWork } from '../tooling/performance/profiler';
import { createAppWithFiles, seedTaskCache } from './helpers';

const loadClock = async () => {
  if (!Platform.isDesktop) throw new Error('Native clock test requires desktop');
  return (await import('node:perf_hooks')).performance;
};
const performance = await loadClock();

describe('native profile boundaries', () => {
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
