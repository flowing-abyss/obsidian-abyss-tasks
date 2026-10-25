import type { TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import {
  sameTaskNodeRef,
  type TaskCommand,
  type TaskQueryApi,
  type TaskSearchApi,
  type TaskSearchHydratedHit,
  type TaskSearchState,
  type TaskSnapshot,
} from '../../src/tasks';
import {
  calendarEvidence,
  click,
  element,
  frames,
  plugin,
  scrollRange,
  taskBoardEvidence,
  waitFor,
} from './native-helpers.ts';
import type { Host, NativeOptions } from './native-types.ts';
import { ANALYSIS, type Sample } from './types.ts';
export { scenarioIds } from './types.ts';

export type Measure = (
  id: string,
  action: () => Promise<Sample['facts']>,
  prepare?: () => Promise<void>,
) => Promise<void>;

export async function taskTextTyping(input: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  const original = input.value;
  const cancel = (): void => {
    input.value = original;
    for (let i = 0; i < 2; i++) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  };
  input.focus();
  try {
    for (const value of ['Check [', 'Check [[', 'Check [[P', 'Check [[Pro', 'Check [[Project']) {
      input.value = value;
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (value.includes('[[')) {
        const query = value.split('[[')[1] ?? '';
        await waitFor(() => {
          const titles = [...document.querySelectorAll('.abyss-link-suggest .abyss-suggest-title')];
          return (
            titles.length > 0 &&
            titles.every((title) => title.textContent.trim().length > 0) &&
            (query === '' ||
              titles.some((title) => {
                const highlighted = [...title.querySelectorAll('.suggestion-highlight')]
                  .map((part) => part.textContent)
                  .join('');
                return highlighted.toLowerCase() === query.toLowerCase();
              }))
          );
        }, 'updated wiki-link results');
      }
      await frames();
    }
  } finally {
    cancel();
    await frames();
  }
}
export async function queryScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const q = plugin(host).queries;
  await measure('query.roots', () => {
    const roots = q.list().length;
    if (roots !== options.expectedRoots)
      throw new Error(`Fixture roots: expected ${options.expectedRoots}, received ${roots}`);
    return Promise.resolve({ roots });
  });
  await measure('query.nodes', () => {
    const nodes = q.listNodes().length;
    if (nodes !== options.expectedNodes)
      throw new Error(`Fixture nodes: expected ${options.expectedNodes}, received ${nodes}`);
    return Promise.resolve({ nodes });
  });
  const first = q.list()[0];
  if (first === undefined) throw new Error('Dependency fixture missing');
  await measure('query.dependencies', () => {
    q.dependencies({ type: 'task', ref: first.ref });
    return Promise.resolve({ targets: 1 });
  });
  await measure('query.time', () => {
    const from = Date.parse(`${options.anchor}T00:00:00Z`) - 180 * 86400000;
    return Promise.resolve({ entries: q.entriesOverlapping(from, from + 365 * 86400000).length });
  });
  await measure('search.cold', async () => {
    await plugin(host).search.prepare(new AbortController().signal);
    return { prepared: true };
  });
  for (const [id, query, matchScope] of [
    ['search.warm', 'database', 'node'],
    ['search.no-results', 'zzzznonexistentzzzz', 'node'],
    ['search.subtree', 'child', 'subtree'],
  ] as const) {
    await measure(id, async () => {
      const search = plugin(host).search;
      const signal = new AbortController().signal;
      const cursor = await search.open({ kind: 'nodes', query, matchScope }, signal);
      try {
        const batch = await search.read(cursor, 0, 40, signal);
        const rows = await search.resolveHits(batch.hits, signal);
        return { results: cursor.total, hydrated: rows.length };
      } finally {
        search.release(cursor);
      }
    });
  }
}

type SearchCursor = Awaited<ReturnType<TaskSearchApi['open']>>;
interface SearchEdits {
  readonly signal: AbortSignal;
  check(): void;
  generation(): number;
  matchingGeneration(cursor: SearchCursor, after: number): boolean;
  select(path: string, title: string): void;
  canonical(): Promise<TaskSnapshot>;
  publication(after: number): Promise<number>;
  start(): void;
  close(): void;
}

function observeSearchEdits(queries: TaskQueryApi, search: TaskSearchApi): SearchEdits {
  const controller = new AbortController();
  let latest: TaskSearchState | undefined;
  let invalid: Error | undefined;
  let wanted: { path: string; title: string } | undefined;
  let accepted: TaskSnapshot | undefined;
  let offQuery = (): void => {};
  let offSearch = (): void => {};
  const check = (): void => {
    if (invalid !== undefined) throw invalid;
    controller.signal.throwIfAborted();
  };
  const ready = (after: number): Extract<TaskSearchState, { phase: 'ready' }> | undefined => {
    check();
    return latest?.phase === 'ready' && latest.compatibility === false && latest.generation > after
      ? latest
      : undefined;
  };
  return {
    signal: controller.signal,
    check,
    generation: () => latest?.generation ?? -1,
    matchingGeneration: (cursor: SearchCursor, after: number) =>
      ready(after)?.generation === cursor.generation,
    select: (path: string, title: string) => {
      wanted = { path, title };
      accepted = undefined;
    },
    canonical: () =>
      waitFor(() => {
        check();
        return accepted;
      }, 'exact accepted search edit'),
    publication: async (after: number): Promise<number> => {
      await search.prepare(controller.signal);
      return (await waitFor(() => ready(after), 'Worker search publication')).generation;
    },
    start: () => {
      offQuery = queries.subscribe((event) => {
        if (event.type !== 'changed' || wanted === undefined || !event.files.includes(wanted.path))
          return;
        accepted = queries
          .list({ filePath: wanted.path })
          .find((task) => task.title === wanted?.title);
      });
      offSearch = search.subscribe((state) => {
        latest = state;
        if (
          (state.phase === 'ready' && state.compatibility !== false) ||
          ['recovering', 'failed', 'disposed'].includes(state.phase)
        ) {
          invalid ??= new Error(
            `Worker search workload invalidated: ${state.phase}${state.phase === 'ready' ? ' inline' : ''}`,
          );
          controller.abort(invalid);
        }
      });
    },
    close: () => {
      offQuery();
      offSearch();
      controller.abort();
    },
  };
}

interface SearchEditMatches {
  exactTitle: boolean;
  exactPath: boolean;
  currentTarget: boolean;
}
function searchEditMatches(
  row: TaskSearchHydratedHit | undefined,
  current: TaskSnapshot | undefined,
  path: string,
  title: string,
): SearchEditMatches {
  const missing = { exactTitle: false, exactPath: false, currentTarget: false };
  if (row === undefined || current === undefined || row.task.path.length !== 0) return missing;
  const ref = row.task.node.ref;
  if (!('filePath' in ref)) return missing;
  const target = { type: 'task' as const, ref: current.ref };
  const exactTitle = row.task.node.title === title && row.task.root.title === title;
  const exactPath = row.task.root.ref.filePath === path && ref.filePath === path;
  const currentTarget = [
    row.task.target,
    { type: 'task' as const, ref: row.task.root.ref },
    { type: 'task' as const, ref },
  ].every((candidate) => sameTaskNodeRef(candidate, target));
  return { exactTitle, exactPath, currentTarget };
}

function validateSearchEditBatch(
  cursor: SearchCursor,
  batch: Awaited<ReturnType<TaskSearchApi['read']>>,
): void {
  if (
    batch.cursor.id !== cursor.id ||
    batch.cursor.generation !== cursor.generation ||
    batch.offset !== 0 ||
    !batch.done ||
    batch.hits.length !== 1
  )
    throw new Error('Search edit incomplete or stale batch');
}

interface SearchEditWorkload {
  host: Host;
  options: NativeOptions;
  observed: SearchEdits;
  primingGeneration: number;
  path: string;
  title: string;
}

async function readSearchEdit(workload: SearchEditWorkload): Promise<Sample['facts']> {
  const { host, options, observed, primingGeneration, path, title } = workload;
  const { queries, search } = plugin(host);
  const cursor = await search.open(
    { kind: 'nodes', query: 'abysssearchlatency', matchScope: 'node' },
    observed.signal,
  );
  try {
    if (!observed.matchingGeneration(cursor, primingGeneration))
      throw new Error('Search cursor publication generation mismatch');
    if (cursor.total !== 1)
      throw new Error(`Search edit expected one result, received ${cursor.total}`);
    const batch = await search.read(cursor, 0, 1, observed.signal);
    validateSearchEditBatch(cursor, batch);
    const rows = await search.resolveHits(batch.hits, observed.signal);
    const current = queries.list({ filePath: path }).find((task) => task.title === title);
    const matches = searchEditMatches(rows[0], current, path, title);
    const matchingGeneration = observed.matchingGeneration(cursor, primingGeneration);
    if (
      rows.length !== 1 ||
      !matches.exactTitle ||
      !matches.exactPath ||
      !matches.currentTarget ||
      !matchingGeneration
    )
      throw new Error('Search edit hydration is not the exact current inbox task/publication');
    const roots = queries.list().length;
    const nodes = queries.listNodes().length;
    if (roots !== options.expectedRoots + 1 || nodes !== options.expectedNodes + 1)
      throw new Error(`Search edit population mismatch: ${roots} roots, ${nodes} nodes`);
    return {
      primingEdits: 1,
      edits: 1,
      roots,
      nodes,
      results: cursor.total,
      hydrated: rows.length,
      ...matches,
      matchingGeneration,
      backend: 'worker',
    };
  } finally {
    search.release(cursor);
    observed.check();
  }
}

/** Public publication and current hydrated data define this end-to-end endpoint. */
export async function searchEditScenario(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const { queries, search } = plugin(host);
  const project = host.vault.getFileByPath(`${options.fixtureFolder}/projects/Project-000.md`);
  const inbox = host.vault.getFileByPath(`${options.fixtureFolder}/inbox.md`);
  if (project === null || inbox === null) throw new Error('Search edit fixture missing');
  const projectSource = await host.vault.read(project);
  const inboxSource = await host.vault.read(inbox);
  const originalTitle = 'Profile task 0 database';
  const primedTitle = `${originalTitle} abysssearchprime`;
  const measuredTitle = 'abysssearchlatency sandbox';
  const original = queries
    .list({ filePath: project.path })
    .find((task) => task.dependencyId === 'profile-0' && task.title === originalTitle);
  if (original === undefined || projectSource.split(originalTitle).length !== 2)
    throw new Error('Search priming root missing or ambiguous');
  const observed = observeSearchEdits(queries, search);
  let primingGeneration = -1;
  try {
    observed.start();
    await measure(
      'search.edit-to-query',
      async () => {
        observed.check();
        observed.select(inbox.path, measuredTitle);
        await host.vault.modify(inbox, `${inboxSource}\n- [ ] ${measuredTitle}\n`);
        await observed.canonical();
        await observed.publication(primingGeneration);
        return readSearchEdit({
          host,
          options,
          observed,
          primingGeneration,
          path: inbox.path,
          title: measuredTitle,
        });
      },
      async () => {
        observed.check();
        const before = observed.generation();
        observed.select(project.path, primedTitle);
        await host.vault.modify(project, projectSource.replace(originalTitle, primedTitle));
        const primed = await observed.canonical();
        if (
          primed.ref.line !== original.ref.line ||
          primed.dependencyId !== original.dependencyId ||
          primed.ref.revision === original.ref.revision
        )
          throw new Error('Search priming task identity mismatch');
        primingGeneration = await observed.publication(before);
      },
    );
    observed.check();
  } finally {
    observed.close();
  }
}

async function searchReady(expected?: number): Promise<void> {
  await waitFor(() => {
    const node = document.querySelector<HTMLElement>('[data-search-phase="complete"]');
    return (
      node !== null &&
      (expected === undefined || Number(node.dataset['searchLogicalResults']) === expected)
    );
  }, 'applied search render receipt');
  await frames();
}

export async function panelScenarios(host: Host, measure: Measure): Promise<void> {
  await measure('panel.first-open', async () => {
    if (!host.commands.executeCommandById('abyss-tasks:open-panel'))
      throw new Error('Open panel command missing');
    await waitFor(() => document.querySelector('.abyss-rail-btn'), 'panel rail');
    await frames();
    return { panels: host.workspace.getLeavesOfType('task-calendar-panel').length };
  });
  await click('.abyss-rail-btn[aria-label="Search"]');
  await searchReady();
  await measure('ui.search', async () => {
    const input = element<HTMLInputElement>('input.abyss-search-global');
    input.value = 'database';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await searchReady(2000);
    const total = Number(element('[data-search-logical-results]').dataset['searchLogicalResults']);
    if (total <= 0) throw new Error('Expected nonempty database results');
    return { results: total };
  });
  await measure('ui.scroll', async () => {
    const scroller = [...element('.abyss-center').querySelectorAll<HTMLElement>('*')].find(
      (node) =>
        node.scrollHeight > node.clientHeight + 100 &&
        ['auto', 'scroll'].includes(getComputedStyle(node).overflowY),
    );
    if (scroller === undefined) throw new Error('Search scroll surface missing');
    for (const fraction of [0.5, 1, 0]) {
      await scrollRange(scroller, fraction);
    }
    return { scrolls: 3 };
  });
  await measure('ui.inspector', async () => {
    element('.abyss-center .abyss-task-card').click();
    await waitFor(
      () => document.querySelector('.abyss-right .abyss-right-title-view'),
      'task inspector',
    );
    await frames();
    return { opened: true };
  });
  await measure('ui.inspector.link-input', async () => {
    await click('.abyss-right .abyss-right-title-view');
    await taskTextTyping(element<HTMLTextAreaElement>('.abyss-right-title-edit'));
    return { inputs: 5 };
  });
}

export async function calendarScenarios(measure: Measure): Promise<void> {
  for (const [id, label] of [
    ['day', 'Day'],
    ['week', 'Week'],
    ['month', 'Month'],
  ] as const) {
    await measure(`ui.calendar.${id}`, async () => {
      if (id === 'day') await click('.abyss-rail-btn[aria-label="Calendar"]');
      const button = [...document.querySelectorAll<HTMLElement>('.abyss-cal-view-btn')].find(
        (b) => b.textContent === label,
      );
      if (button === undefined) throw new Error(`Missing calendar view ${label}`);
      button.click();
      await waitFor(
        () =>
          [...document.querySelectorAll('.abyss-cal-view-btn.is-active')].some(
            (b) => b.textContent === label,
          ),
        `calendar ${id}`,
      );
      await frames();
      const evidence = calendarEvidence(element('.abyss-cal-body'), 1);
      const expectedDays = { day: 1, week: 7, month: 42 }[id];
      if (
        evidence.dates.length !== expectedDays ||
        evidence.dates.some(
          (date, index) =>
            index > 0 &&
            Date.parse(`${date}T12:00:00Z`) -
              Date.parse(`${evidence.dates[index - 1]}T12:00:00Z`) !==
              86400000,
        )
      )
        throw new Error(`Incomplete calendar ${id} range`);
      return { view: id, visibleDates: evidence.dates.join(',') };
    });
  }
}

export async function taskBoardScenarios(host: Host, measure: Measure): Promise<void> {
  const expected = new Map(
    DEFAULT_SETTINGS.taskStatuses.map((status) => [`status:${status.id}`, 0]),
  );
  const keys = new Map(
    DEFAULT_SETTINGS.taskStatuses.map((status) => [status.symbol, `status:${status.id}`]),
  );
  for (const task of plugin(host).queries.listNodes()) {
    const key = keys.get(task.node.statusSymbol);
    if (key === undefined) throw new Error('Task board fixture contains an unknown status');
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  await click('.abyss-rail-btn[aria-label="Tasks"]');
  const group = [...document.querySelectorAll<HTMLElement>('.abyss-tag-group-header')].find(
    (node) => node.querySelector('.abyss-left-label')?.textContent.toLowerCase() === 'profile',
  );
  if (group === undefined) throw new Error('Profile task group missing');
  group.click();
  await click('.abyss-task-collection-switcher [aria-label="List view"]');
  // An unsearched List uses the ordinary collection path, without a Search receipt.
  await waitFor(
    () => document.querySelector('.abyss-center .abyss-task-card'),
    'task list preparation',
  );
  await frames();
  await measure('ui.tasks.kanban', async () => {
    await click('.abyss-task-collection-switcher [aria-label="Kanban view"]');
    await searchReady();
    const { tasks, columns } = taskBoardEvidence(element('.abyss-task-kanban'), expected);
    return { tasks, columns };
  });
  await measure('ui.tasks.kanban-scroll', async () => {
    const board = element('.abyss-task-kanban');
    const scroller = [
      ...board.querySelectorAll<HTMLElement>('.abyss-task-kanban-column-body'),
    ].find((node) => node.scrollHeight > node.clientHeight + 100 && node.clientHeight > 0);
    if (scroller === undefined) throw new Error('Populated task board scroll column missing');
    for (const fraction of [0.5, 1, 0]) await scrollRange(scroller, fraction);
    const { tasks, columns } = taskBoardEvidence(board, expected);
    return { tasks, columns, scrolls: 3 };
  });
}

export async function projectScenarios(measure: Measure): Promise<void> {
  for (const [id, label, selector] of [
    ['table', 'Table view', '.abyss-project-table-row'],
    ['kanban', 'Kanban view', '.abyss-project-kanban-card'],
    ['timeline', 'Timeline view', '.abyss-project-timeline-row'],
  ] as const) {
    await measure(`ui.projects.${id}`, async () => {
      if (id === 'table') await click('.abyss-rail-btn[aria-label="Projects"]');
      await click(`.abyss-project-overview-switcher [aria-label="${label}"]`);
      await waitFor(() => document.querySelector(selector), `project ${id} rows`);
      await frames();
      return { projects: 100, view: id };
    });
  }
}

export async function statisticsScenarios(host: Host, measure: Measure): Promise<void> {
  const source = plugin(host).taskStatistics;
  let off = (): void => {};
  try {
    await measure('statistics.acquire', async () => {
      off = source.subscribeStatistics(() => {});
      await source.whenStatisticsSettled();
      const snapshot = source.readStatistics();
      if (!snapshot.ready || snapshot.issues.length > 0)
        throw new Error('Incomplete statistics acquisition');
      return {
        files: snapshot.files.length,
        archive: snapshot.files.filter((f) => f.kind === 'archive').length,
      };
    });
    for (const id of ANALYSIS) {
      await measure(`ui.analysis.${id}`, async () => {
        if (id === 'rhythm') element('.abyss-rail-btn[aria-label="Analysis"]').click();
        else element(`[data-statistics-view="${id}"]`).click();
        await waitFor(() => {
          const content = document.querySelector('.abyss-statistics-content');
          return (
            content !== null &&
            content.getAttribute('aria-busy') !== 'true' &&
            content.children.length > 0
          );
        }, `statistics ${id} render complete`);
        await frames();
        return { view: id };
      });
    }
  } finally {
    off();
  }
}

async function command(host: Host, input: TaskCommand): Promise<TaskSnapshot | undefined> {
  const result = await plugin(host).tasks.execute(input);
  if (result.type !== 'ok') throw new Error(`Command ${input.type} did not commit: ${result.type}`);
  return result.outcome.type === 'task' ? result.outcome.task : undefined;
}

export async function commandScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const tasks = new Map<string, TaskSnapshot | undefined>();
  await measure('command.create', async () => {
    const created = await command(host, {
      type: 'create',
      markdownBody: 'Profile command sandbox',
      destination: { type: 'configured-default' },
    });
    tasks.set('current', created);
    return { writes: 1 };
  });
  for (const [id, edit] of [
    ['command.edit', 'edit'],
    ['command.complete', 'complete'],
    ['command.comment', 'comment'],
  ] as const) {
    await measure(id, async () => {
      const task = tasks.get('current');
      if (task === undefined) throw new Error('Created task receipt missing');
      const target = { type: 'task' as const, ref: task.ref };
      const inputs: Record<typeof edit, TaskCommand> = {
        edit: { type: 'append-title', target, markdown: ' edited' },
        complete: { type: 'toggle-completion', target },
        comment: { type: 'add-comment', parent: target, text: 'Profile evidence' },
      };
      const input = inputs[edit];
      const receipt = await command(host, input);
      tasks.set('current', receipt);
      return { writes: 1 };
    });
  }
  const recurring = plugin(host)
    .queries.list({ filePath: `${options.fixtureFolder}/projects/Project-000.md` })
    .find((t) => t.recurrence !== undefined);
  if (recurring === undefined) throw new Error('Recurring fixture missing');
  await measure('command.tracking', async () => {
    await command(host, { type: 'start-tracking', parent: { type: 'task', ref: recurring.ref } });
    await command(host, { type: 'stop-tracking' });
    return { commands: 2 };
  });
  const fresh = plugin(host)
    .queries.list({ filePath: recurring.ref.filePath })
    .find((t) => t.recurrence !== undefined);
  if (fresh === undefined) throw new Error('Recurring task missing after tracking');
  await measure('command.recurrence', async () => {
    await command(host, { type: 'toggle-completion', target: { type: 'task', ref: fresh.ref } });
    return { occurrences: 1 };
  });
  await measure('index.external-edit', async () => {
    const file = host.vault.getFileByPath(`${options.fixtureFolder}/inbox.md`);
    if (file === null) throw new Error('External edit sandbox missing');
    let unsubscribe = (): void => {};
    const changed = new Promise<void>((resolve) => {
      unsubscribe = plugin(host).queries.subscribe((event) => {
        if (event.type === 'changed' && event.files.includes(file.path)) resolve();
      });
    });
    try {
      await host.vault.modify(
        file,
        `${await host.vault.read(file)}\n- [ ] External profile edit\n`,
      );
      await changed;
    } finally {
      unsubscribe();
    }
    return { edits: 1 };
  });
}

function indexPopulation(host: Host, options: NativeOptions): { roots: number; nodes: number } {
  const q = plugin(host).queries;
  const roots = q.list().length;
  const nodes = q.listNodes().length;
  if (roots !== options.expectedRoots || nodes !== options.expectedNodes)
    throw new Error(`Wide population changed: ${roots} roots, ${nodes} nodes`);
  return { roots, nodes };
}

/** Wide scenarios precede commands so their counts describe the unchanged fixture population. */
export async function indexScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  if (options.fixtureKind !== 'wide-tree') return;
  const q = plugin(host).queries;
  const file = host.vault.getFileByPath(`${options.fixtureFolder}/projects/Project-000.md`);
  if (file === null) throw new Error('Wide project missing');
  await measure('index.wide-child-edit', async () => {
    const source = await host.vault.read(file);
    const lines = source.split('\n');
    const line = lines.findIndex((value) => value.startsWith('  - [ ] Wide child 999 '));
    const original = lines[line];
    if (original?.includes(' #profile/child') !== true)
      throw new Error('Final wide child source missing');
    const title = `${original.slice('  - [ ] '.length, original.indexOf(' #profile/child'))} edited`;
    lines[line] = original.replace(' #profile/child', ' edited #profile/child');
    await host.vault.modify(file, lines.join('\n'));
    const root = await waitFor(
      () =>
        q
          .list({ filePath: file.path })
          .find(
            (task) =>
              task.dependencyId === 'profile-0' &&
              task.subtasks.length === 1000 &&
              task.subtasks[999]?.title === title,
          ),
      'final wide descendant edit',
    );
    const last = root.subtasks[999];
    if (
      last?.ref.parent.type !== 'task' ||
      last.ref.parent.ref.revision !== root.ref.revision ||
      last.ref.parent.ref.filePath !== file.path ||
      last.ref.parent.ref.line !== root.ref.line
    )
      throw new Error('Wide descendant ancestry missing');
    return { ...indexPopulation(host, options), children: root.subtasks.length, edits: 1 };
  });
  await metadataOnly(host, file, options, measure);
}

async function metadataOnly(
  host: Host,
  file: TFile,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const q = plugin(host).queries;
  const statistics = plugin(host).taskStatistics;
  const offStatistics = statistics.subscribeStatistics(() => {});
  try {
    await statistics.whenStatisticsSettled();
    await measure('index.metadata-only', async () => {
      const source = await host.vault.read(file);
      if (!source.startsWith('---\n') || !source.includes('\nbudget: 1000\n'))
        throw new Error('Metadata fixture missing');
      const next = source.replace('\nbudget: 1000\n', '\nbudget: 1001\n');
      const prior = statistics
        .readStatistics()
        .files.find((entry) => entry.path === file.path)?.revision;
      if (prior === undefined) throw new Error('Statistics fixture missing');
      let accepted = false;
      const offChanged = q.subscribe((event) => {
        if (event.type === 'changed' && event.files.includes(file.path)) accepted = true;
      });
      const offReconciled = q.subscribeReconciled((files) => {
        if (files.includes(file.path)) accepted = true;
      });
      try {
        await host.vault.modify(file, next);
        await waitFor(async () => {
          await statistics.whenStatisticsSettled();
          const snapshot = statistics.readStatistics();
          return (
            accepted &&
            snapshot.ready &&
            snapshot.issues.length === 0 &&
            snapshot.files.some((entry) => entry.path === file.path && entry.revision > prior) &&
            host.metadataCache.getFileCache(file)?.frontmatter?.['budget'] === 1001
          );
        }, 'accepted metadata and Statistics');
        const actual = await host.vault.read(file);
        const taskBytesUnchanged =
          actual.slice(actual.indexOf('\n---\n') + 5) ===
          source.slice(source.indexOf('\n---\n') + 5);
        if (actual !== next || !taskBytesUnchanged)
          throw new Error('Metadata scenario changed task bytes');
        return { ...indexPopulation(host, options), accepted, taskBytesUnchanged };
      } finally {
        offChanged();
        offReconciled();
      }
    });
  } finally {
    offStatistics();
  }
}
