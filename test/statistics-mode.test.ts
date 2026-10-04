import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import type { StatisticsChartRenderer } from '../src/panels/statistics/StatisticsChart';
import type { StatisticsChoices } from '../src/panels/statistics/StatisticsControls';
import { StatisticsMode } from '../src/panels/statistics/StatisticsMode';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { StatisticsScope } from '../src/statistics';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import type { TaskStatisticsSnapshot, TaskStatisticsSource } from '../src/tasks';
import { createAppWithFiles, deferred, expectDefined } from './helpers';
import { date, source, task, utc } from './helpers/statisticsFixtures';
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => {
    fn();
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function harness() {
  const app = await createAppWithFiles({});
  let snapshot = source([task('A', { planning: { created: date('2026-10-01') } })]);
  const listeners = new Set<() => void>();
  const sourcePort: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    subscribeStatistics: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refreshStatistics: async () => {},
    whenStatisticsSettled: async () => {},
    isStatisticsCurrent: (value) => value === snapshot,
  };
  let nowMs = Date.parse('2026-10-04T12:00Z');
  let rendered = deferred<void>();
  const host = createDiv();
  document.body.append(host);
  const renderer = {
    mount: vi.fn<StatisticsChartRenderer['mount']>(() => ({ update: vi.fn(), destroy: vi.fn() })),
  };
  const mode = new StatisticsMode({
    state: new AppState(),
    app,
    settings: structuredClone(DEFAULT_SETTINGS),
    source: sourcePort,
    projects: { list: () => [], onUpdate: () => () => {}, whenSettled: async () => {} },
    renderer,
    context: () => ({ nowMs, offsetAt: utc }),
    host: {
      renderComplete: () => {
        rendered.resolve();
      },
      renderRoot: () => {},
      select: () => {},
      openSource: async () => {},
    },
  });
  cleanups.push(() => {
    mode.destroy();
    host.remove();
  });
  return {
    mode,
    host,
    listeners,
    renderer,
    sourcePort,
    advance: (milliseconds = 60000) => {
      nowMs += milliseconds;
    },
    wait: () => rendered.promise,
    reset: () => {
      rendered = deferred<void>();
    },
    replace: (value: TaskStatisticsSnapshot) => {
      snapshot = value;
      listeners.forEach((fn) => {
        fn();
      });
    },
  };
}
it('retains observation time and controls through real view switches, reusing cached models', async () => {
  const h = await harness();
  const build = vi.spyOn(StatisticsSession.prototype, 'view');
  h.mode.render(h.host);
  await h.wait();
  expect(h.listeners.size).toBe(1);
  const first: unknown = await build.mock.results[0]?.value;
  h.reset();
  h.advance();
  h.host.querySelector<HTMLButtonElement>('[data-statistics-family="Time"]')?.click();
  await h.wait();
  h.reset();
  h.advance();
  h.host.querySelector<HTMLButtonElement>('[data-statistics-family="Flow"]')?.click();
  await h.wait();
  const last: unknown = await build.mock.results[build.mock.results.length - 1]?.value;
  expect(last).toBe(first);
  expect(h.host.querySelector('[aria-label="Scope"]')).not.toBeNull();
  expect(h.host.querySelector('[aria-label="Period"]')).not.toBeNull();
  expect(h.host.querySelector('[data-statistics-view="cohorts"]')).not.toBeNull();
  h.mode.unmount();
  expect(h.listeners.size).toBe(0);
  const count = build.mock.calls.length;
  h.mode.refresh();
  h.replace(source([]));
  await Promise.resolve();
  expect(build.mock.calls).toHaveLength(count);
});
it('cancels stale settlement after unmount and never installs an old snapshot', async () => {
  const h = await harness();
  const gate = deferred<void>();
  h.sourcePort.whenStatisticsSettled = () => gate.promise;
  h.mode.render(h.host);
  h.mode.unmount();
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.renderer.mount).not.toHaveBeenCalled();
  expect(h.listeners.size).toBe(0);
});
it('keeps the complete previous chart DOM when a later background chart mount fails', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const before = h.host.querySelector('.abyss-statistics-section');
  const failed = deferred<void>();
  vi.spyOn(console, 'error').mockImplementation(() => {
    failed.resolve();
  });
  const stagedDestroy = vi.fn();
  const originalLabel = h.host.querySelector('.abyss-statistics-context')?.textContent;
  let count = 0;
  h.renderer.mount.mockImplementation(() => {
    count++;
    if (count === 2) throw new Error('second chart failed');
    return { update: vi.fn(), destroy: stagedDestroy };
  });
  h.replace({
    ...source([task('Changed', { planning: { created: date('2026-10-02') } })]),
    revision: 2,
  });
  await failed.promise;
  expect(h.host.querySelector('.abyss-statistics-section')).toBe(before);
  expect(before?.isConnected).toBe(true);
  expect(h.host.querySelectorAll('.abyss-statistics-section')).toHaveLength(3);
  expect(h.host.textContent).toContain('stale');
  expect(h.host.querySelector('.abyss-statistics-context')?.textContent).toBe(originalLabel);
  expect(stagedDestroy).toHaveBeenCalledTimes(1);
});
it('joins real accepted source and project membership only after both barriers, including held and unchanged work', async () => {
  const { TaskIndex } = await import('../src/tasks/infrastructure/TaskIndex');
  const { TaskRefAuthority } = await import('../src/tasks/infrastructure/TaskRefAuthority');
  const { ProjectStore } = await import('../src/projects/ProjectStore');
  const { canonicalStatusCatalog, seedTaskCache } = await import('./helpers');
  const app = await createAppWithFiles({
    'Note.md': '---\ntags: []\n---\n- [ ] Original ➕ 2026-10-01\n',
  });
  seedTaskCache(app, 'Note.md', [{ task: ' ', parent: -1, line: 3 }], { tags: [] });
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    refAuthority: new TaskRefAuthority(),
  });
  await index.initialize();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.membershipQuery = '#project';
  const projects = new ProjectStore(app, index, settings);
  projects.initialize();
  vi.useFakeTimers();
  const completion = { current: deferred<void>() };
  const nextCompletion = () => {
    completion.current = deferred<void>();
  };
  const element = document.body.createDiv();
  const mode = new StatisticsMode({
    state: new AppState(),
    app,
    settings,
    source: index,
    projects,
    context: () => ({ nowMs: Date.parse('2026-10-04T12:00Z'), offsetAt: utc }),
    renderer: {
      mount: () => {
        return { update: () => {}, destroy: () => {} };
      },
    },
    host: {
      renderRoot: () => {},
      select: () => {},
      openSource: async () => {},
      renderComplete: () => {
        completion.current.resolve();
      },
    },
  });
  cleanups.push(() => {
    mode.destroy();
    projects.destroy();
    index.destroy();
    element.remove();
    vi.useRealTimers();
  });
  const refresh = vi.spyOn(index, 'refreshStatistics');
  mode.render(element);
  await completion.current.promise;
  const first = element.querySelector('.abyss-statistics-section');
  const release = index.holdStatisticsPublication();
  nextCompletion();
  await app.vault.adapter.write(
    'Note.md',
    '---\ntags: [project]\n---\n- [ ] Updated ➕ 2026-10-01\n',
  );
  seedTaskCache(app, 'Note.md', [{ task: ' ', parent: -1, line: 3 }], { tags: ['project'] });
  await vi.advanceTimersByTimeAsync(150);
  await projects.whenSettled();
  expect(projects.list()).toHaveLength(1);
  expect(element.querySelector('.abyss-statistics-section')).toBe(first);
  release();
  await index.whenStatisticsSettled();
  await completion.current.promise;
  expect(element.querySelector('.abyss-statistics-section')).not.toBe(first);
  nextCompletion();
  await app.vault.adapter.write(
    'Note.md',
    '---\ntags: []\n---\n- [ ] Updated again ➕ 2026-10-01\n',
  );
  seedTaskCache(app, 'Note.md', [{ task: ' ', parent: -1, line: 3 }], { tags: [] });
  await index.whenStatisticsSettled();
  await vi.advanceTimersByTimeAsync(150);
  await projects.whenSettled();
  await completion.current.promise;
  expect(projects.list()).toHaveLength(0);
  expect(refresh).not.toHaveBeenCalled();
});
it('routes every native analysis control and keeps Period across current-state views', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const visit = async (selector: string) => {
    h.reset();
    h.advance();
    const button = h.host.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    button?.click();
    await h.wait();
  };
  for (const [family, views] of [
    ['Flow', ['rhythm', 'completion', 'deadlines', 'cohorts']],
    ['Time', ['allocation', 'timeline', 'sessions', 'patterns']],
    ['Projects', ['movement', 'aging', 'dependencies']],
  ] as const) {
    await visit(`[data-statistics-family="${family}"]`);
    for (const view of views) {
      await visit(`[data-statistics-view="${view}"]`);
      expect(
        h.host.querySelector(`[data-statistics-view="${view}"]`)?.getAttribute('aria-pressed'),
      ).toBe('true');
    }
  }
  expect(h.host.querySelector('[aria-label="Period"]')).toBeNull();
  expect(h.host.textContent).toContain('Current state');
  await visit('[data-statistics-family="Flow"]');
  expect(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]')?.value).toBe('week');
});
it('uses right overlay at every Statistics width without inheriting an old selection or reopening on resize', async () => {
  const { CompactPaneAccess } = await import('../src/views/CompactPaneAccess');
  let mode: 'tasks' | 'statistics' = 'tasks',
    width = 1300;
  const layout = document.body.createDiv();
  const left = layout.createDiv(),
    right = layout.createDiv(),
    leftButton = layout.createEl('button'),
    rightButton = layout.createEl('button');
  vi.spyOn(layout, 'getBoundingClientRect').mockImplementation(() => ({
    width,
    height: 800,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 800,
    toJSON: () => ({}),
  }));
  const access = new CompactPaneAccess({
    mode: () => mode,
    hasSelectedTask: () => true,
    captureState: () => undefined,
    allowsPaneInteraction: () => true,
  });
  access.mount({ layout, left, right, leftButton, rightButton });
  expect(rightButton.classList.contains('is-compact-available')).toBe(false);
  mode = 'statistics';
  access.modeChanged(mode);
  expect(right.classList.contains('is-compact-open')).toBe(false);
  expect(rightButton.classList.contains('is-compact-available')).toBe(true);
  access.open('left', true);
  expect(left.classList.contains('is-compact-open')).toBe(false);
  rightButton.click();
  expect(right.classList.contains('is-compact-open')).toBe(true);
  access.close(true);
  expect(document.activeElement).toBe(rightButton);
  width = 420;
  access.refreshWidth();
  expect(right.classList.contains('is-compact-open')).toBe(false);
  access.selectionChanged(true);
  expect(right.classList.contains('is-compact-open')).toBe(true);
  access.close(false);
  width = 1300;
  access.refreshWidth();
  expect(right.classList.contains('is-compact-open')).toBe(false);
  mode = 'tasks';
  access.modeChanged(mode);
  access.refreshWidth();
  expect(rightButton.classList.contains('is-compact-available')).toBe(false);
  access.reset();
  layout.remove();
});
it('prepares a yielding cached scope inventory, bounds native suggestions and distinguishes duplicate names', async () => {
  const { SuggestModal } = await import('obsidian');
  const { StatisticsControls } = await import('../src/panels/statistics/StatisticsControls');
  const { prepareStatisticsDataset } = await import('../src/statistics');
  const { work, request } = await import('./helpers/statisticsFixtures');
  const { required } = await import('../src/statistics/statisticsWork');
  type ScopeOption = readonly [StatisticsScope, string, string];
  const opened: Array<InstanceType<typeof SuggestModal<ScopeOption>>> = [];
  vi.spyOn(SuggestModal.prototype, 'open').mockImplementation(function (
    this: InstanceType<typeof SuggestModal<ScopeOption>>,
  ) {
    opened.push(this);
  });
  const app = await createAppWithFiles({}),
    change = vi.fn();
  const controls = new StatisticsControls(app, change);
  const dataset = required(
    await prepareStatisticsDataset(
      source(
        Array.from({ length: 1200 }, (_, index) =>
          task(`P${index}`, { tags: [`tag${index}`, `tag1199-extra${index}`] }),
        ),
      ),
      Array.from({ length: 1200 }, (_, index) => ({
        path: `P${index}.md`,
        name: index < 2 ? 'Same name' : `Project ${index}`,
      })),
      work,
    ),
  );
  const yields = vi.fn(async () => {});
  await controls.prepare(dataset, { yieldControl: yields, isCancelled: () => false });
  expect(yields).toHaveBeenCalled();
  const calls = yields.mock.calls.length;
  await controls.prepare(dataset, { yieldControl: yields, isCancelled: () => false });
  expect(yields).toHaveBeenCalledTimes(calls);
  const element = document.body.createDiv();
  controls.render(element, request(), dataset);
  element.querySelector<HTMLButtonElement>('[aria-label="Scope"]')?.click();
  const picker = required(opened[0]);
  expect(await picker.getSuggestions('')).toHaveLength(50);
  const duplicate = await picker.getSuggestions('Same name');
  expect(duplicate.map((item) => item[1])).toEqual(['Same name · P0.md', 'Same name · P1.md']);
  const last = required((await picker.getSuggestions('P1199.md'))[0]);
  picker.onChooseSuggestion(last, new MouseEvent('click'));
  expect(change).toHaveBeenCalledWith({
    scope: { type: 'project', path: 'P1199.md' },
    page: undefined,
    focusKey: undefined,
  });
  expect((await picker.getSuggestions('tag1199'))[0]?.[0]).toEqual({ type: 'tag', tag: 'tag1199' });
  change.mockImplementation((next: Partial<StatisticsChoices>) => {
    controls.render(element, { ...request(), ...next }, dataset);
  });
  picker.onChooseSuggestion(last, new KeyboardEvent('keydown', { key: 'Enter' }));
  picker.onClose();
  expect(document.activeElement).toBe(element.querySelector('[aria-label="Scope"]'));
  controls.render(element, { ...request(), scope: { type: 'project', path: 'P1199.md' } }, dataset);
  expect(document.activeElement).toBe(element.querySelector('[aria-label="Scope"]'));
  const serialize = vi.spyOn(JSON, 'stringify');
  for (const view of ['rhythm', 'allocation', 'movement'] as const) {
    serialize.mockClear();
    controls.render(
      element,
      { ...request(), view, scope: { type: 'tag', tag: 'tag1199' } },
      dataset,
    );
    expect(element.querySelector('[aria-label="Scope"]')?.textContent).toContain('#tag1199');
    expect(serialize.mock.calls.length).toBeLessThanOrEqual(1);
  }
  controls.destroy();
  element.remove();
});
it('refreshes visible running archive time each minute and disposes its timers', async () => {
  vi.useFakeTimers();
  const h = await harness();
  h.replace(
    source(
      [],
      [
        task('Running archive', {
          timeEntries: [
            {
              state: 'running',
              startMs: Date.parse('2026-10-04T11:00Z'),
              relativeLine: 1,
              originalMarkdown: 'running',
            },
          ],
        }),
      ],
    ),
  );
  const views = vi.spyOn(StatisticsSession.prototype, 'view');
  h.mode.render(h.host);
  await h.wait();
  const initial = views.mock.calls[0]?.[0].nowMs;
  h.reset();
  h.advance();
  await vi.advanceTimersByTimeAsync(60000);
  await h.wait();
  expect(views.mock.calls[views.mock.calls.length - 1]?.[0].nowMs).toBe((initial ?? 0) + 60000);
  h.mode.unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('invalidates an idle observation at local midnight without a running entry', async () => {
  vi.useFakeTimers();
  const h = await harness(),
    views = vi.spyOn(StatisticsSession.prototype, 'view');
  h.mode.render(h.host);
  await h.wait();
  const initial = views.mock.calls[0]?.[0].nowMs ?? 0,
    midnight = new Date(initial);
  midnight.setHours(24, 0, 0, 0);
  const elapsed = midnight.getTime() - initial;
  h.reset();
  h.advance(elapsed);
  await vi.advanceTimersByTimeAsync(elapsed);
  await h.wait();
  expect(views.mock.calls[views.mock.calls.length - 1]?.[0].nowMs).toBe(midnight.getTime());
  h.mode.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it('settles canceled scheduler work and closes both owner ports on disposal', async () => {
  const { StatisticsWorkScheduler } =
    await import('../src/panels/statistics/StatisticsWorkScheduler');
  const port1 = { onmessage: undefined, close: vi.fn() },
    port2 = { postMessage: vi.fn(), close: vi.fn() };
  const owner = {
    MessageChannel: class {
      port1 = port1;
      port2 = port2;
    },
  } as unknown as Window;
  const scheduler = new StatisticsWorkScheduler(owner);
  const first = scheduler.yieldControl(),
    second = scheduler.yieldControl();
  expect(port2.postMessage).toHaveBeenCalledTimes(1);
  scheduler.destroy();
  await Promise.all([first, second, scheduler.yieldControl()]);
  expect(port1.close).toHaveBeenCalledTimes(1);
  expect(port2.close).toHaveBeenCalledTimes(1);
});
it('retains choices across hide/show and adopts the new owner without rebuilding for a routine refresh', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  h.reset();
  h.host.querySelector<HTMLButtonElement>('[data-statistics-family="Time"]')?.click();
  await h.wait();
  const mountCount = h.renderer.mount.mock.calls.length;
  h.reset();
  h.advance();
  h.mode.refresh();
  await h.wait();
  expect(h.renderer.mount).toHaveBeenCalledTimes(mountCount);
  h.mode.unmount();
  const frame = document.body.createEl('iframe');
  const owner = frame.contentDocument;
  expect(owner).not.toBeNull();
  owner?.body.append(owner.adoptNode(h.host));
  h.reset();
  h.mode.render(h.host);
  await h.wait();
  expect(
    h.host.querySelector('[data-statistics-view="allocation"]')?.getAttribute('aria-pressed'),
  ).toBe('true');
  expect(h.listeners.size).toBe(1);
  expect(h.host.querySelector('.abyss-statistics')?.ownerDocument).toBe(owner);
  h.mode.unmount();
  expect(h.listeners.size).toBe(0);
  frame.remove();
});
it('moves keyboard focus into evidence and returns it to the retained analytical opener', async () => {
  const h = await harness();
  const frame = document.body.createEl('iframe');
  const owner = expectDefined(frame.contentDocument);
  owner.body.append(owner.adoptNode(h.host));
  cleanups.push(() => {
    frame.remove();
  });
  h.mode.render(h.host);
  await h.wait();
  const opener = expectDefined(
    [...h.host.querySelectorAll<HTMLButtonElement>('.abyss-statistics-metrics button')].find(
      (button) => button.textContent.startsWith('Created'),
    ),
  );
  opener.focus();
  opener.click();
  const back = expectDefined(
    h.host.querySelector<HTMLButtonElement>('.abyss-statistics-evidence button'),
  );
  expect(back.textContent).toBe('Back to analysis');
  expect(owner.activeElement).toBe(back);
  back.click();
  expect(owner.activeElement).toBe(opener);
  const svg = h.host.createSvg('svg');
  svg.setAttribute('tabindex', '0');
  expectDefined(h.host.querySelector('.abyss-statistics-section')).append(svg);
  svg.focus();
  expect(owner.activeElement).toBe(svg);
  const mounted = expectDefined(h.renderer.mount.mock.calls[0]);
  const selection = expectDefined(
    mounted[1].marks.find((mark) => mark.selectionId !== undefined)?.selectionId,
  );
  mounted[2](selection);
  const svgBack = expectDefined(
    h.host.querySelector<HTMLButtonElement>('.abyss-statistics-evidence button'),
  );
  expect(owner.activeElement).toBe(svgBack);
  svgBack.click();
  expect(owner.activeElement).toBe(svg);
});
