import { SuggestModal } from 'obsidian';
import { afterEach, expect, it, vi, type MockResult } from 'vitest';
import { AppState } from '../src/app/AppState';
import { LeftPanel } from '../src/panels/LeftPanel';
import type { StatisticsChartRenderer } from '../src/panels/statistics/StatisticsChart';
import type { StatisticsChoices } from '../src/panels/statistics/StatisticsControls';
import { StatisticsMode } from '../src/panels/statistics/StatisticsMode';
import { TanStackStatisticsChart } from '../src/panels/statistics/TanStackStatisticsChart';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { StatisticsScope, StatisticsViewModel } from '../src/statistics';
import { StatisticsSession } from '../src/statistics/statisticsSession';
import { TagManager } from '../src/tags/TagManager';
import type { TaskStatisticsSnapshot, TaskStatisticsSource } from '../src/tasks';
import { configuredTaskApplication, createAppWithFiles, deferred, expectDefined } from './helpers';
import { date, request, source, task, utc, work } from './helpers/statisticsFixtures';
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => {
    fn();
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function harness(acceptedSource?: TaskStatisticsSource) {
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
  const state = new AppState();
  state.set('mode', 'statistics');
  const mode = new StatisticsMode({
    state,
    app,
    settings: structuredClone(DEFAULT_SETTINGS),
    source: acceptedSource ?? sourcePort,
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
  const left = mountAnalysisNavigation(app, state, mode, host);
  cleanups.push(() => {
    left.destroy();
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
it('exposes explicit source Retry for partial results, repeated failure and recovery without routine reads', async () => {
  const { TaskIndex } = await import('../src/tasks/infrastructure/TaskIndex');
  const { canonicalStatusCatalog } = await import('./helpers');
  const app = await createAppWithFiles({
    'live.md': '- [ ] Useful ➕ 2026-10-01\n',
    'archive.md': '- [ ] Retained ➕ 2026-10-01\n',
  });
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    excludeSource: ({ filePath }) => filePath === 'archive.md',
    statisticsFileKind: (path) => (path === 'archive.md' ? 'archive' : 'live'),
  });
  await index.initialize();
  cleanups.push(() => {
    index.destroy();
  });
  const h = await harness(index);
  h.mode.render(h.host);
  await h.wait();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const originalRead = app.vault.cachedRead.bind(app.vault);
  const read = vi
    .spyOn(app.vault, 'cachedRead')
    .mockImplementation((file) =>
      file.path === 'archive.md' ? Promise.reject(new Error('offline')) : originalRead(file),
    );
  h.reset();
  await index.refreshSourceExclusion(({ filePath }) => filePath === 'archive.md');
  await h.wait();
  const retry = () =>
    [...h.host.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
  expect(h.host.textContent).toContain('partial coverage');
  expect(h.host.textContent).toContain('archive.md: read-failed');
  expect(h.host.querySelectorAll('.abyss-statistics-section')).toHaveLength(3);
  expect(retry()).toBeDefined();
  const before = read.mock.calls.length;
  h.reset();
  h.mode.refresh();
  await h.wait();
  expect(read).toHaveBeenCalledTimes(before);
  h.reset();
  retry()?.click();
  await h.wait();
  expect(read).toHaveBeenCalledTimes(before + 1);
  expect(retry()).toBeDefined();
  expect(h.host.textContent).toContain('archive.md: read-failed');
  read.mockRestore();
  const recoveredRead = vi.spyOn(app.vault, 'cachedRead');
  h.reset();
  retry()?.click();
  await h.wait();
  expect(recoveredRead).toHaveBeenCalledTimes(1);
  expect(index.readStatistics().issues).toEqual([]);
  expect(retry()).toBeUndefined();
  expect(h.host.textContent).not.toContain('partial coverage');
  expect(h.host.textContent).not.toContain('archive.md: read-failed');
  expectDefined(h.host.querySelector<HTMLButtonElement>('[aria-label="Analysis details"]')).click();
  expect(h.host.querySelector('[role="dialog"]')?.textContent).toContain(
    '2 Tasks & subtasks in scope',
  );
});
it('captures scroll before teardown and restores after accepted content only on reentry', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const oldRoot = expectDefined(h.host.querySelector<HTMLElement>('.abyss-statistics-content'));
  // Model browser clamping at DOM boundaries; native acceptance verifies real layout.
  Object.defineProperty(oldRoot, 'scrollTop', {
    get: () => (oldRoot.querySelector('.abyss-statistics-section') === null ? 0 : 340),
  });
  h.mode.unmount();
  const gate = deferred<void>();
  h.sourcePort.whenStatisticsSettled = () => gate.promise;
  h.reset();
  h.mode.render(h.host);
  const root = expectDefined(h.host.querySelector<HTMLElement>('.abyss-statistics-content'));
  let scroll = 0;
  const writes: number[] = [];
  Object.defineProperty(root, 'scrollTop', {
    get: () => scroll,
    set: (next: number) => {
      scroll = root.querySelector('.abyss-statistics-section') === null ? 0 : next;
      writes.push(scroll);
    },
  });
  const userScroll = () => {
    root.scrollTop = 125;
  };
  expect(scroll).toBe(0);
  gate.resolve();
  await h.wait();
  expect(writes).toEqual([340]);
  expectDefined(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]')).focus();
  const focus = Reflect.get(HTMLElement.prototype, 'focus');
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    focus.call(this, options);
    // Browser focus scrolls an offscreen replacement control unless explicitly prevented.
    if (root.contains(this) && options?.preventScroll !== true) scroll = 0;
  });
  userScroll();
  h.reset();
  h.replace(source([task('Updated')]));
  await h.wait();
  expect(scroll).toBe(125);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Period');
  expect(writes).toEqual([340, 125]);
});
it('retains observation time and controls through real view switches, reusing cached models', async () => {
  const h = await harness();
  const build = vi.spyOn(StatisticsSession.prototype, 'view');
  h.mode.render(h.host);
  await h.wait();
  expect(h.listeners.size).toBe(1);
  const first: unknown = await build.mock.results[0]?.value;
  h.reset();
  h.advance();
  h.mode.navigation.selectView('allocation');
  await h.wait();
  h.reset();
  h.advance();
  h.mode.navigation.selectView('rhythm');
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
  const state = new AppState();
  state.set('mode', 'statistics');
  const mode = new StatisticsMode({
    state,
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
  const visit = async (view: Parameters<typeof h.mode.navigation.selectView>[0]) => {
    h.reset();
    h.advance();
    h.mode.navigation.selectView(view);
    await h.wait();
    expect(
      h.host.querySelector(`[data-statistics-view="${view}"]`)?.getAttribute('aria-current'),
    ).toBe('page');
  };
  for (const view of [
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
  ] as const)
    await visit(view);
  expect(h.host.querySelector('[aria-label="Period"]')).toBeNull();
  expect(h.host.textContent).toContain('Current state');
  await visit('rhythm');
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
  expect(leftButton.classList.contains('is-compact-available')).toBe(true);
  expect(leftButton.getAttribute('aria-label')).toBe('Show Analysis navigation');
  access.open('left', true);
  expect(left.classList.contains('is-compact-open')).toBe(true);
  expect(left.getAttribute('aria-labelledby')).not.toBeNull();
  access.close(true);
  expect(document.activeElement).toBe(leftButton);
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
  controls.render(element, request());
  controls.openScope({ type: 'all' });
  const picker = required(opened[0]);
  expect(await picker.getSuggestions('')).toHaveLength(50);
  expect((await picker.getSuggestions('Entire vault')).map(([scope]) => scope)).toEqual([
    { type: 'all' },
  ]);
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
    controls.render(element, { ...request(), ...next });
  });
  picker.onChooseSuggestion(last, new KeyboardEvent('keydown', { key: 'Enter' }));
  picker.onClose();
  controls.render(element, { ...request(), scope: { type: 'project', path: 'P1199.md' } });
  const serialize = vi.spyOn(JSON, 'stringify');
  for (const view of ['rhythm', 'allocation', 'movement'] as const) {
    serialize.mockClear();
    controls.render(element, { ...request(), view, scope: { type: 'tag', tag: 'tag1199' } });
    expect(controls.scopeLabel({ type: 'tag', tag: 'tag1199' })).toBe('#tag1199');
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
  h.mode.navigation.selectView('allocation');
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
    h.host.querySelector('[data-statistics-view="allocation"]')?.getAttribute('aria-current'),
  ).toBe('page');
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
      (button) => button.textContent.includes('Created'),
    ),
  );
  opener.focus();
  opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  opener.click();
  const back = expectDefined(
    h.host.querySelector<HTMLButtonElement>('.abyss-statistics-evidence button'),
  );
  expect(back.getAttribute('aria-label')).toBe('Clear selection');
  expect(owner.activeElement).toBe(h.host.querySelector('.abyss-statistics-evidence h3'));
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
  svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  mounted[2](selection);
  const svgBack = expectDefined(
    h.host.querySelector<HTMLButtonElement>('.abyss-statistics-evidence button'),
  );
  expect(owner.activeElement).toBe(h.host.querySelector('.abyss-statistics-evidence h3'));
  svgBack.click();
  expect(owner.activeElement).toBe(svg);
});

function returned<T>(result: MockResult<T> | undefined): T {
  const value = expectDefined(result);
  if (value.type !== 'return') throw new Error('Expected a returned test result');
  return value.value;
}
type ScopeOption = readonly [StatisticsScope, string, string];
function captureScopePicker() {
  const opened: Array<InstanceType<typeof SuggestModal<ScopeOption>>> = [];
  vi.spyOn(SuggestModal.prototype, 'open').mockImplementation(function (
    this: InstanceType<typeof SuggestModal<ScopeOption>>,
  ) {
    opened.push(this);
  });
  return async (host: HTMLElement, query: string) => {
    expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Scope"]')).click();
    const picker = expectDefined(opened[opened.length - 1]);
    const choice = expectDefined((await picker.getSuggestions(query))[0]);
    picker.onChooseSuggestion(choice, new KeyboardEvent('keydown', { key: 'Enter' }));
    picker.onClose();
  };
}
async function selectedProjectHarness() {
  const { TaskIndex } = await import('../src/tasks/infrastructure/TaskIndex');
  const { TaskRefAuthority } = await import('../src/tasks/infrastructure/TaskRefAuthority');
  const { ProjectStore } = await import('../src/projects/ProjectStore');
  const { canonicalStatusCatalog, seedTaskCache } = await import('./helpers');
  const app = await createAppWithFiles({
    'Before.md': '---\ntags: [project]\n---\n- [ ] Original ➕ 2026-10-01\n',
  });
  seedTaskCache(app, 'Before.md', [{ task: ' ', parent: -1, line: 3 }], { tags: ['project'] });
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
  let completion = deferred<void>();
  const host = document.body.createDiv();
  const state = new AppState();
  state.set('mode', 'statistics');
  const mode = new StatisticsMode({
    state,
    app,
    settings,
    source: index,
    projects,
    context: () => ({ nowMs: Date.parse('2026-10-04T12:00Z'), offsetAt: utc }),
    renderer: { mount: () => ({ update: () => {}, destroy: () => {} }) },
    host: {
      renderRoot: () => {},
      select: () => {},
      openSource: async () => {},
      renderComplete: () => {
        completion.resolve();
      },
    },
  });
  const left = mountAnalysisNavigation(app, state, mode, host);
  // The real panel forwards note lifecycle identity to its retained mode.
  const rename = app.vault.on('rename', (file, oldPath) => {
    mode.followNote(oldPath, file.path);
  });
  const remove = app.vault.on('delete', (file) => {
    mode.followNote(file.path);
  });
  cleanups.push(() => {
    left.destroy();
    app.vault.offref(rename);
    app.vault.offref(remove);
    mode.destroy();
    projects.destroy();
    index.destroy();
    host.remove();
  });
  mode.render(host);
  await completion.promise;
  return {
    app,
    index,
    projects,
    host,
    seedTaskCache,
    reset: () => {
      completion = deferred<void>();
    },
    wait: () => completion.promise,
  };
}
it.each(['membership loss', 'deletion'] as const)(
  'follows actual selected-project rename and preserves visibly unavailable scope after %s',
  async (loss) => {
    const selectScope = captureScopePicker();
    const views = vi.spyOn(StatisticsSession.prototype, 'view');
    const h = await selectedProjectHarness();
    h.reset();
    await selectScope(h.host, 'Before.md');
    await h.wait();
    expect(h.host.querySelector('[aria-label="Scope"]')?.textContent).toBe('Before');
    expect(expectDefined(views.mock.lastCall)[0].scope).toEqual({
      type: 'project',
      path: 'Before.md',
    });
    const file = expectDefined(h.app.vault.getFileByPath('Before.md'));

    const refresh = vi.spyOn(h.index, 'refreshStatistics');
    h.reset();
    await h.app.vault.rename(file, 'After.md');
    h.seedTaskCache(h.app, 'After.md', [{ task: ' ', parent: -1, line: 3 }], { tags: ['project'] });
    await h.index.whenStatisticsSettled();
    await vi.advanceTimersByTimeAsync(150);
    await h.projects.whenSettled();
    await h.wait();
    expect(h.projects.list().map((project) => project.path)).toEqual(['After.md']);
    expect(h.host.querySelector('[aria-label="Scope"]')?.textContent).toBe('After');
    expect(expectDefined(views.mock.lastCall)[0].scope).toEqual({
      type: 'project',
      path: 'After.md',
    });
    const renamed: StatisticsViewModel | undefined = await returned(
      views.mock.results[views.mock.results.length - 1],
    );
    expect(expectDefined(renamed).coverage.scope.nodes).toBe(1);
    h.reset();
    if (loss === 'deletion') await h.app.fileManager.trashFile(file);
    else {
      await h.app.vault.adapter.write(
        'After.md',
        '---\ntags: []\n---\n- [ ] Original ➕ 2026-10-01\n',
      );
      h.seedTaskCache(h.app, 'After.md', [{ task: ' ', parent: -1, line: 3 }], { tags: [] });
    }
    await h.index.whenStatisticsSettled();
    await vi.advanceTimersByTimeAsync(150);
    await h.projects.whenSettled();
    await h.wait();
    expect(h.projects.list()).toEqual([]);
    expect(expectDefined(views.mock.lastCall)[0].scope).toEqual({
      type: 'project',
      path: 'After.md',
    });
    expect(h.host.querySelector('[aria-label="Scope"]')?.textContent).toBe(
      'After.md · unavailable',
    );
    const unavailable: StatisticsViewModel | undefined = await returned(
      views.mock.results[views.mock.results.length - 1],
    );
    expect(expectDefined(unavailable).coverage.scope.nodes).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  },
);
it('discards a superseded cold scope, period and view request and installs only matching current labels', async () => {
  const selectScope = captureScopePicker();
  const h = await harness();
  h.replace(
    source(
      Array.from({ length: 1001 }, (_, i) =>
        task(`Task ${i}`, {
          tags: [i === 0 ? 'latest' : 'old'],
          planning: { created: date('2026-10-01') },
        }),
      ),
    ),
  );
  h.mode.render(h.host);
  await h.wait();
  const previous = expectDefined(h.host.querySelector<HTMLElement>('.abyss-statistics-section'));
  const content = expectDefined(previous.parentElement);
  const original = expectDefined(
    Object.getOwnPropertyDescriptor(StatisticsSession.prototype, 'view'),
  ).value as StatisticsSession['view'];
  const views = vi.spyOn(StatisticsSession.prototype, 'view');
  const entered = deferred<void>(),
    release = deferred<void>();
  views.mockImplementation(function (this: StatisticsSession, request, work) {
    if (request.scope.type !== 'tag' || request.scope.tag !== 'old')
      return original.call(this, request, work);
    return original.call(this, request, {
      ...work,
      yieldControl: async () => {
        entered.resolve();
        await release.promise;
      },
    });
  });
  h.reset();
  await selectScope(h.host, 'old');
  await entered.promise;
  expect(content.hidden).toBe(false);
  expect(content.inert).toBe(true);
  expect(content.getAttribute('aria-busy')).toBe('true');
  expect(h.host.querySelector('.abyss-statistics-context')?.textContent).toBe(
    'Preparing analysis…',
  );
  const pending = returned(views.mock.results[0]);
  expect(expectDefined(views.mock.calls[0])[1].isCancelled()).toBe(false);
  await selectScope(h.host, 'latest');
  const period = expectDefined(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]'));
  period.value = 'month';
  period.dispatchEvent(new Event('change'));
  expectDefined(
    h.host.querySelector<HTMLButtonElement>('[data-statistics-view="cohorts"]'),
  ).click();
  expect(content.hidden).toBe(false);
  expect(content.inert).toBe(true);
  expect(content.getAttribute('aria-busy')).toBe('true');
  expect(h.host.querySelector('.abyss-statistics-context')?.textContent).toBe(
    'Preparing analysis…',
  );
  expect(expectDefined(views.mock.calls[0])[1].isCancelled()).toBe(true);
  const mounts = h.renderer.mount.mock.calls.length;
  release.resolve();
  expect(await pending).toBeUndefined();
  await h.wait();
  expect(views.mock.calls).toHaveLength(2);
  expect(expectDefined(views.mock.lastCall)[0]).toMatchObject({
    view: 'cohorts',
    period: 'month',
    scope: { type: 'tag', tag: 'latest' },
  });
  const current: StatisticsViewModel | undefined = await returned(
    views.mock.results[views.mock.results.length - 1],
  );
  expect(expectDefined(current).coverage.scope.nodes).toBe(1);
  expect(expectDefined(current).dateLabel).toBe('2026-10-01 – 2026-10-04');
  expect(content.hidden).toBe(false);
  expect(previous.isConnected).toBe(false);
  expect(h.host.querySelector('.abyss-statistics-context')?.textContent).toBe(
    '#latest · Oct 1, 2026 – Oct 4, 2026',
  );
  expect(h.host.querySelector('[aria-label="Scope"]')?.textContent).toBe('#latest');
  expect(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]')?.value).toBe('month');
  expect(
    h.host.querySelector('[data-statistics-view="cohorts"]')?.getAttribute('aria-current'),
  ).toBe('page');
  expect(h.renderer.mount.mock.calls.length - mounts).toBe(
    expectDefined(current).sections.reduce((count, section) => count + section.charts.length, 0),
  );
});
it('refreshes an open scope picker when a new inventory is accepted, preserving its query', async () => {
  const { StatisticsControls } = await import('../src/panels/statistics/StatisticsControls');
  const { prepareStatisticsDataset } = await import('../src/statistics');
  const opened: Array<InstanceType<typeof SuggestModal<ScopeOption>>> = [];
  vi.spyOn(SuggestModal.prototype, 'open').mockImplementation(function (
    this: InstanceType<typeof SuggestModal<ScopeOption>>,
  ) {
    opened.push(this);
  });
  const app = await createAppWithFiles({});
  const controls = new StatisticsControls(app, vi.fn());
  const host = document.body.createDiv();
  const choices = request();
  await controls.prepare(
    expectDefined(await prepareStatisticsDataset(source([task('Old')]), [], work)),
    work,
  );
  controls.render(host, choices);
  controls.openScope({ type: 'all' });
  const picker = expectDefined(opened[0]);
  picker.inputEl.value = 'newly-created';
  let shown: readonly ScopeOption[] = [];
  picker.inputEl.addEventListener('input', () => {
    shown = picker.getSuggestions(picker.inputEl.value) as ScopeOption[];
  });
  await controls.prepare(
    expectDefined(
      await prepareStatisticsDataset(source([task('New', { tags: ['newly-created'] })]), [], work),
    ),
    work,
  );
  expect(picker.inputEl.value).toBe('newly-created');
  expect(shown.map(([scope]) => scope)).toEqual([{ type: 'tag', tag: 'newly-created' }]);
  expect(opened).toHaveLength(1);
  controls.destroy();
});
it('retains focused Period and Group by controls across accepted navigation', async () => {
  const { StatisticsControls } = await import('../src/panels/statistics/StatisticsControls');
  const app = await createAppWithFiles({});
  const host = document.body.createDiv();
  let choices: StatisticsChoices = {
    view: 'allocation',
    period: 'week',
    scope: { type: 'all' },
    group: 'project',
  };
  const controls = new StatisticsControls(app, (next) => {
    choices = { ...choices, ...next };
    controls.render(host, choices);
  });
  controls.render(host, choices);
  for (const selector of ['select[aria-label="Period"]', 'button[aria-label="Group by Tags"]']) {
    const control = host.querySelector<HTMLElement>(selector);
    if (control === null) throw new Error(`Missing control ${selector}`);
    control.focus();
    if (control.tagName === 'SELECT') {
      (control as HTMLSelectElement).value = selector.includes('Period') ? 'month' : 'tag';
      control.dispatchEvent(new Event('change'));
    } else control.click();
    expect(document.activeElement).toBe(host.querySelector(selector));
    expect(control.isConnected).toBe(false);
  }
  const outside = document.body.createEl('button');
  outside.focus();
  controls.render(host, choices);
  expect(document.activeElement).toBe(outside);
  controls.destroy();
  host.remove();
  outside.remove();
});

it('observes transient navigation without acquiring source subscriptions while hidden', async () => {
  const h = await harness();
  const observations: string[] = [];
  const off = h.mode.navigation.subscribe(() => {
    observations.push(h.mode.navigation.snapshot().view);
  });
  h.mode.navigation.selectView('timeline');
  expect(observations).toEqual(['timeline']);
  expect(h.listeners.size).toBe(0);
  off();
  h.mode.navigation.selectView('allocation');
  expect(observations).toEqual(['timeline']);
});
it('navigates all eleven analyses through its transient port and retains the selected period', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const period = expectDefined(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]'));
  h.reset();
  period.value = '90d';
  period.dispatchEvent(new Event('change'));
  await h.wait();
  for (const view of [
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
  ] as const) {
    h.reset();
    h.mode.navigation.selectView(view);
    await h.wait();
    expect(h.mode.navigation.snapshot()).toEqual({ view, scopeLabel: 'Entire vault' });
    expect(h.host.querySelector('.abyss-statistics .abyss-center-title')?.textContent).toBe(
      expectDefined(view[0]).toUpperCase() + view.slice(1),
    );
  }
  h.reset();
  h.mode.navigation.selectView('rhythm');
  await h.wait();
  expect(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]')?.value).toBe('90d');
});
it('keeps charts visible for pointer evidence, preserves scroll on Clear, and retains unchanged selections', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const chart = expectDefined(h.host.querySelector('.abyss-statistics-chart'));
  const content = expectDefined(h.host.querySelector<HTMLElement>('.abyss-statistics-content'));
  content.scrollTop = 128;
  const outside = document.body.createEl('button');
  cleanups.push(() => {
    outside.remove();
  });
  outside.focus();
  const mounted = expectDefined(h.renderer.mount.mock.calls[0]);
  mounted[2](
    expectDefined(mounted[1].marks.find((mark) => mark.selectionId !== undefined)?.selectionId),
  );
  expect(chart.isConnected).toBe(true);
  expect(chart.closest('[hidden]')).toBeNull();
  expect(h.host.querySelector('.abyss-statistics-evidence')?.textContent).toContain(
    'matching records',
  );
  expect(document.activeElement).toBe(outside);
  h.reset();
  h.mode.refresh();
  await h.wait();
  expect(h.host.querySelector('.abyss-statistics-evidence')?.textContent).toContain(
    'matching records',
  );
  expectDefined(h.host.querySelector<HTMLButtonElement>('[aria-label="Clear selection"]')).click();
  expect(content.scrollTop).toBe(128);
  expect(document.activeElement).toBe(outside);
});
it('keeps the primary plot ahead of summary stacks before and after evidence opens', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const section = expectDefined(h.host.querySelector('.abyss-statistics-section'));
  const plot = expectDefined(section.querySelector('.abyss-statistics-charts'));
  const metrics = expectDefined(section.querySelector('.abyss-statistics-metrics'));
  const legend = expectDefined(section.querySelector('.abyss-statistics-legend'));
  expect(plot.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(plot.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const originalChildren = [...section.children];
  const mounted = expectDefined(h.renderer.mount.mock.calls[0]);
  mounted[2](
    expectDefined(mounted[1].marks.find((mark) => mark.selectionId !== undefined)?.selectionId),
  );
  expect([...section.children]).toEqual(originalChildren);
  expect(plot.closest('[hidden]')).toBeNull();
});
it('keeps Allocation grouping in a distinct header row outside the global controls', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  h.reset();
  h.mode.navigation.selectView('allocation');
  await h.wait();
  const header = expectDefined(h.host.querySelector('.abyss-statistics .abyss-center-header'));
  const global = expectDefined(header.querySelector('.abyss-center-controls'));
  const grouping = expectDefined(header.querySelector('[aria-label="Group by"]'));
  expect(global.contains(grouping)).toBe(false);
  expect(global.querySelector('[aria-label="Period"]')).not.toBeNull();
  expect(global.querySelector('[aria-label="Analysis details"]')).not.toBeNull();
  expect([...grouping.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    'Project',
    'Tags',
    'Priority',
  ]);
  h.reset();
  expectDefined(grouping.querySelector<HTMLButtonElement>('[aria-label="Group by Tags"]')).click();
  await h.wait();
  expect(header.querySelector('[aria-label="Group by Tags"]')?.getAttribute('aria-pressed')).toBe(
    'true',
  );
});
it('identifies the selected Rhythm date and series in the result heading', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const mounted = expectDefined(h.renderer.mount.mock.calls[0]);
  const mark = expectDefined(mounted[1].marks.find((mark) => (mark.weight ?? 0) > 0));
  mounted[2](expectDefined(mark.selectionId));
  const heading = expectDefined(h.host.querySelector('.abyss-statistics-evidence-header h3'));
  expect(heading.textContent).toContain(String(mark.x));
  expect(heading.textContent).toContain(
    expectDefined(mounted[1].series.find((series) => series.key === mark.series)).label,
  );
  expect(heading.textContent).not.toBe(mounted[1].accessibleLabel);
});
it('identifies a selected numeric heatmap hour using its typed axis label', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  h.reset();
  h.mode.navigation.selectView('patterns');
  await h.wait();
  const mounted = expectDefined(
    h.renderer.mount.mock.calls.find((call) => call[1].kind === 'heatmap'),
  );
  const mark = expectDefined(mounted[1].marks.find((mark) => mark.x === 7));
  mounted[2](expectDefined(mark.selectionId));
  const heading = expectDefined(h.host.querySelector('.abyss-statistics-evidence-header h3'));
  expect(heading.textContent).toContain('Local hour: 07:00');
  expect(heading.textContent).toContain(`Weekday: ${mark.y}`);
});
it.each([true, false])(
  'clears obsolete evidence and restores focus only when removed results owned it (%s)',
  async (focusedResult) => {
    const h = await harness();
    h.mode.render(h.host);
    await h.wait();
    const opener = expectDefined(
      h.host.querySelector<HTMLButtonElement>('.abyss-statistics-metrics button'),
    );
    opener.focus();
    opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    opener.click();
    const clear = expectDefined(
      h.host.querySelector<HTMLButtonElement>('[aria-label="Clear selection"]'),
    );
    clear.focus();
    const outside = document.body.createEl('button');
    cleanups.push(() => {
      outside.remove();
    });
    if (!focusedResult) outside.focus();
    h.reset();
    h.replace(source([task('Changed', { planning: { created: date('2026-10-01') } })]));
    await h.wait();
    expect(h.host.querySelector('.abyss-statistics-evidence')?.textContent).toBe('');
    expect(document.activeElement).toBe(
      focusedResult ? h.host.querySelector('.abyss-statistics .abyss-center-title') : outside,
    );
  },
);

function mountAnalysisNavigation(
  app: Awaited<ReturnType<typeof createAppWithFiles>>,
  state: AppState,
  mode: StatisticsMode,
  host: HTMLElement,
): LeftPanel {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const application = configuredTaskApplication(app, settings);
  const tags = new TagManager(app, settings, async () => {}, {
    check: () => 'ready',
    apply: async (_change, live) => {
      live();
    },
  });
  const left = new LeftPanel({
    state,
    settings,
    app,
    tagManager: tags,
    tasks: application.tasks,
    statisticsNavigation: mode.navigation,
  });
  left.mount(host.createDiv({ cls: 'abyss-left' }));
  return left;
}

it('owns one details popover with definitions and coverage and releases it on navigation and unmount', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const details = expectDefined(
    h.host.querySelector<HTMLButtonElement>('[aria-label="Analysis details"]'),
  );
  details.focus();
  details.click();
  const dialog = expectDefined(h.host.querySelector<HTMLElement>('[role="dialog"]'));
  expect(dialog.textContent).toContain('Rhythm details');
  expect(dialog.textContent).toContain('Tasks & subtasks in scope');
  expect(dialog.textContent).toContain('Recorded task dates');
  expect(h.host.querySelector('details')).toBeNull();
  dialog.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(dialog.isConnected).toBe(false);
  expect(document.activeElement).toBe(details);
  details.click();
  h.reset();
  h.mode.navigation.selectView('completion');
  await h.wait();
  expect(h.host.querySelector('[role="dialog"]')).toBeNull();
  details.click();
  h.mode.unmount();
  expect(h.host.querySelector('[role="dialog"]')).toBeNull();
  expect(h.listeners.size).toBe(0);
});

it('mounts replacement charts in a connected off-flow measurable host while preserving accepted geometry', async () => {
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const content = expectDefined(h.host.querySelector<HTMLElement>('.abyss-statistics-content'));
  const before = [...content.children];
  const mountedWidths: number[] = [];
  h.renderer.mount.mockImplementation((surface, chart, select) => {
    expect(surface.isConnected).toBe(true);
    expect(surface.closest('[hidden]')).toBeNull();
    const stage = expectDefined(surface.closest('.abyss-statistics-staging'));
    expect(stage.parentElement).toBe(content);
    expect([...content.children].filter((child) => child !== stage)).toEqual(before);
    // JSDOM has no layout. Supply the accepted measurable width at the real engine boundary;
    // connected staging/hidden assertions above check the host that supplies native layout.
    surface.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1390,
      bottom: 250,
      width: 1390,
      height: 250,
      toJSON: () => ({}),
    });
    const handle = new TanStackStatisticsChart().mount(surface, chart, select);
    mountedWidths.push(
      Number(expectDefined(surface.querySelector('svg')?.getAttribute('viewBox')).split(' ')[2]),
    );
    return handle;
  });
  h.reset();
  const period = expectDefined(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]'));
  period.value = 'month';
  period.dispatchEvent(new Event('change'));
  const prior = expectDefined(h.renderer.mount.mock.calls[0]);
  prior[2](
    expectDefined(prior[1].marks.find((mark) => mark.selectionId !== undefined)?.selectionId),
  );
  expect(h.host.querySelector('.abyss-statistics-evidence')?.textContent).toBe('');
  await h.wait();
  expect(content.inert).toBe(false);
  expect(content.querySelector('.abyss-statistics-staging')).toBeNull();
  expect(mountedWidths.length).toBeGreaterThan(0);
  expect(mountedWidths.every((width) => width === 1390)).toBe(true);
});

it('uses the supplied concise observation title for Results', async () => {
  const original = expectDefined(
    Object.getOwnPropertyDescriptor(StatisticsSession.prototype, 'view'),
  ).value as StatisticsSession['view'];
  vi.spyOn(StatisticsSession.prototype, 'view').mockImplementation(async function (
    this: StatisticsSession,
    request,
    work,
  ) {
    const view = await original.call(this, request, work);
    if (view === undefined) return undefined;
    return {
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        charts: section.charts.map((chart) => ({
          ...chart,
          marks: chart.marks.map((mark) => ({
            ...mark,
            observation: {
              title: 'Monday completions',
              values: [{ label: 'Completed', value: 8, unit: 'tasks' }],
            },
          })),
        })),
      })),
    };
  });
  const h = await harness();
  h.mode.render(h.host);
  await h.wait();
  const mounted = expectDefined(h.renderer.mount.mock.calls[0]);
  mounted[2](
    expectDefined(mounted[1].marks.find((mark) => mark.selectionId !== undefined)?.selectionId),
  );
  expect(h.host.querySelector('.abyss-statistics-evidence-header h3')?.textContent).toBe(
    'Monday completions',
  );
});

it('expands and restores cohort display while preserving period and resetting the page choice', async () => {
  const h = await harness();
  h.replace(
    source(
      Array.from({ length: 105 }, (_, i) =>
        task(`week${i}`, {
          planning: {
            created: date(
              new Date(Date.parse('2024-01-01') + i * 7 * 86400000).toISOString().slice(0, 10),
            ),
          },
        }),
      ),
    ),
  );
  h.mode.render(h.host);
  await h.wait();
  h.reset();
  const period = expectDefined(h.host.querySelector<HTMLSelectElement>('[aria-label="Period"]'));
  period.value = 'all';
  period.dispatchEvent(new Event('change'));
  h.mode.navigation.selectView('cohorts');
  await h.wait();
  const context = h.host.querySelector('.abyss-statistics-context')?.textContent;
  const click = async (label: string) => {
    h.reset();
    expectDefined(
      [...h.host.querySelectorAll('button')].find((button) => button.textContent === label),
    ).click();
    await h.wait();
  };
  await click('Show older cohorts');
  await click('Older weeks');
  expect(
    [...h.host.querySelectorAll('button')].some((button) => button.textContent === 'Newer weeks'),
  ).toBe(true);
  await click('Show recent cohorts');
  expect(
    [...h.host.querySelectorAll('button')].some((button) => button.textContent === 'Newer weeks'),
  ).toBe(false);
  expect(period.value).toBe('all');
  expect(h.host.querySelector('.abyss-statistics-context')?.textContent).toBe(context);
  await click('Show older cohorts');
  expect(
    [...h.host.querySelectorAll('button')].some((button) => button.textContent === 'Older weeks'),
  ).toBe(true);
  expect(
    [...h.host.querySelectorAll('button')].some((button) => button.textContent === 'Newer weeks'),
  ).toBe(false);
});
