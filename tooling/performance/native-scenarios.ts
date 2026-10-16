import type { TaskCommand, TaskSnapshot } from '../../src/tasks';
import { click, element, frames, plugin, scrollRange, waitFor } from './native-helpers.ts';
import type { Host, NativeOptions } from './native-types.ts';
import type { Sample } from './types.ts';

export type Measure = (id: string, action: () => Promise<Sample['facts']>) => Promise<void>;

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
const ANALYSIS = [
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

export const SCENARIOS = [
  'startup.index',
  'query.roots',
  'query.nodes',
  'query.dependencies',
  'query.time',
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
  'ui.projects.table',
  'ui.projects.kanban',
  'ui.projects.timeline',
  'statistics.acquire',
  ...ANALYSIS.map((id) => `ui.analysis.${id}`),
  'command.create',
  'command.edit',
  'command.complete',
  'command.comment',
  'command.tracking',
  'command.recurrence',
  'index.external-edit',
  'panel.close',
];

export async function queryScenarios(
  host: Host,
  options: NativeOptions,
  measure: Measure,
): Promise<void> {
  const q = plugin(host).queries;
  await measure('query.roots', () => Promise.resolve({ roots: q.list().length }));
  await measure('query.nodes', () => Promise.resolve({ nodes: q.listNodes().length }));
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
      const cells = document.querySelectorAll('[data-mg-date], [data-tg-date]').length;
      if (cells === 0) throw new Error('Calendar has no date cells');
      return { view: id };
    });
  }
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
