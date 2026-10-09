import { afterEach, expect, it, vi } from 'vitest';
import { StatisticsEvidence } from '../src/panels/statistics/StatisticsEvidence';
import { prepareStatisticsDataset, StatisticsSession } from '../src/statistics';
import { required } from '../src/statistics/statisticsWork';
import type { TaskStatisticsSource } from '../src/tasks';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { canonicalStatusCatalog, createAppWithFiles } from './helpers';
import { closed, date, request, source, task, work } from './helpers/statisticsFixtures';
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => {
    dispose();
  });
  vi.restoreAllMocks();
});
async function archivedEvidence() {
  const path = 'archive.md',
    content = '- [ ] Original ➕ 2026-10-01\n  - [ ] Child ➕ 2026-10-01\n- [ ] Other\n';
  const app = await createAppWithFiles({ [path]: content });
  const authority = new TaskRefAuthority();
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    refAuthority: authority,
    excludeSource: () => true,
    statisticsFileKind: () => 'archive',
  });
  const element = document.body.createDiv();
  cleanup.push(() => {
    index.destroy();
    element.remove();
  });
  await index.initialize();
  index.subscribeStatistics(() => {});
  await index.whenStatisticsSettled();
  const snapshot = index.readStatistics();
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request(),
      work,
    ),
  );
  const host = { renderRoot: vi.fn(), select: vi.fn(), openSource: vi.fn(async () => {}) };
  const queries = {
    resolve: vi.fn(() => {
      throw new Error('Archive evidence cannot acquire mutation authority');
    }),
  };
  new StatisticsEvidence(index, queries, host).render(
    element,
    model,
    { id: 'created', label: 'Created' },
    vi.fn(),
  );
  const buttons = [...element.querySelectorAll('button')].filter((button) =>
    button.textContent.startsWith('Open archived source'),
  );
  expect(buttons).toHaveLength(2);
  return { app, index, authority, element, snapshot, content, path, host, buttons };
}
it.each(['Original', 'Child'])(
  'rejects old archived root/child evidence after same-line %s replacement',
  async (title) => {
    const h = await archivedEvidence();
    h.index.installCommittedContent(h.path, h.content.replace('Other', 'Unrelated edit'));
    await h.index.whenStatisticsSettled();
    expect(h.index.readStatistics().files[0]?.roots[0]?.ref).toEqual(
      h.snapshot.files[0]?.roots[0]?.ref,
    );
    h.buttons.forEach((button) => {
      button.click();
    });
    expect(h.host.openSource.mock.calls).toEqual([
      [h.path, 0],
      [h.path, 1],
    ]);
    expect(
      h.authority.evidence(required(h.snapshot.files[0]?.roots[0]).ref.revision),
    ).toBeUndefined();
    h.index.installCommittedContent(h.path, h.content.replace(title, 'Replacement'));
    await h.index.whenStatisticsSettled();
    expect(h.index.isStatisticsCurrent(h.index.readStatistics())).toBe(true);
    h.buttons.forEach((button) => {
      button.click();
    });
    expect(h.host.openSource).toHaveBeenCalledTimes(2);
    expect(h.element.textContent).toContain('changed or was removed');
    expect(h.index.readStatistics().files[0]?.roots[0]?.ref).not.toEqual(
      h.snapshot.files[0]?.roots[0]?.ref,
    );
  },
);
it('rejects retained archive evidence when its settled current source has an acquisition issue', async () => {
  const h = await archivedEvidence();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.spyOn(h.app.vault, 'cachedRead').mockRejectedValue(new Error('offline'));
  await h.index.refreshSourceExclusion(() => true);
  await h.index.whenStatisticsSettled();
  const partial = h.index.readStatistics();
  expect(h.index.isStatisticsCurrent(partial)).toBe(true);
  expect(partial.files[0]?.roots).toEqual(h.snapshot.files[0]?.roots);
  expect(partial.issues).toEqual([{ path: h.path, reason: 'read-failed' }]);
  h.buttons.forEach((button) => {
    button.click();
  });
  expect(h.host.openSource).not.toHaveBeenCalled();
  expect(h.element.textContent).toContain('changed or was removed');
  read.mockRestore();
  await h.index.refreshStatistics();
  h.buttons.forEach((button) => {
    button.click();
  });
  expect(h.host.openSource.mock.calls).toEqual([
    [h.path, 0],
    [h.path, 1],
  ]);
});
it('renders one shared live root with exact matched children, and archives have source-only actions', async () => {
  const root = task('Root');
  const children = [0, 1].map((index) => ({
    ...task(`Child ${index}`, { planning: { created: date('2026-10-01') } }),
    ref: {
      parent: { type: 'task' as const, ref: root.ref },
      relativeLine: index + 1,
      originalBlock: `child${index}`,
    },
  }));
  const live = { ...root, subtasks: children };
  const archived = task('Archived', { planning: { created: date('2026-10-01') } });
  const snapshot = source([live], [archived]);
  let current = true;
  const port: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    isStatisticsCurrent: () => current,
    whenStatisticsSettled: async () => {},
    refreshStatistics: async () => {},
    subscribeStatistics: () => () => {},
  };
  const queries = {
    resolve: vi.fn(() =>
      current
        ? { type: 'exact' as const, task: live, basis: { observed: live } }
        : { type: 'not-found' as const, ref: live.ref },
    ),
  };
  const host = {
    renderRoot: vi.fn((host: HTMLElement, _root: unknown, activate: () => void) => {
      const card = host.createEl('button', { text: 'Root card' });
      card.addEventListener('click', activate);
    }),
    select: vi.fn(),
    openSource: vi.fn(async () => {}),
  };
  const evidence = new StatisticsEvidence(port, queries, host);
  const dataset = required(await prepareStatisticsDataset(snapshot, [], work));
  const model = required(await new StatisticsSession(dataset).view(request(), work));
  const element = document.body.createDiv();
  evidence.render(element, model, { id: 'created', label: 'Created' }, vi.fn());
  expect(host.renderRoot).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain('3 matching records');
  expect(element.textContent).toContain('2 matched subtask records shown');
  const buttons = [...element.querySelectorAll('button')];
  buttons.find((button) => button.textContent === 'Root card')?.click();
  expect(host.select).toHaveBeenCalledWith([live]);
  expect(element.textContent).not.toContain('Select task · Root');
  buttons.find((button) => button.textContent.includes('Child 1'))?.click();
  expect(host.select).toHaveBeenCalledWith([live, children[1]]);
  buttons.find((button) => button.textContent.includes('Archived'))?.click();
  expect(host.openSource).toHaveBeenCalledWith('Archived.md', 0);
  expect(queries.resolve).not.toHaveBeenCalledWith(archived.ref);
  current = false;
  buttons.find((button) => button.textContent.includes('Child 0'))?.click();
  buttons.find((button) => button.textContent.includes('Archived'))?.click();
  buttons.find((button) => button.textContent === 'Root card')?.click();
  expect(host.select).toHaveBeenCalledTimes(2);
  expect(host.openSource).toHaveBeenCalledTimes(1);
  expect(element.textContent).toContain('changed or was removed');
  element.remove();
});
it('pages physical source rows in batches of 50 and retains occurrence-specific keys', async () => {
  const nodes = Array.from({ length: 101 }, (_, i) =>
    task(`Task${i}`, { planning: { created: date('2026-10-01') } }),
  );
  const snapshot = source([], nodes);
  const port: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    isStatisticsCurrent: () => true,
    whenStatisticsSettled: async () => {},
    refreshStatistics: async () => {},
    subscribeStatistics: () => () => {},
  };
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request(),
      work,
    ),
  );
  const element = document.body.createDiv();
  new StatisticsEvidence(
    port,
    { resolve: (ref) => ({ type: 'not-found', ref }) },
    { renderRoot: vi.fn(), select: vi.fn(), openSource: async () => {} },
  ).render(element, model, { id: 'created', label: 'Created' }, vi.fn());
  expect(element.querySelectorAll('[data-evidence-key]')).toHaveLength(50);
  [...element.querySelectorAll('button')]
    .find((button) => button.textContent === 'Load more')
    ?.click();
  expect(element.querySelectorAll('[data-evidence-key]')).toHaveLength(100);
  [...element.querySelectorAll('button')]
    .find((button) => button.textContent === 'Load more')
    ?.click();
  expect(element.querySelectorAll('[data-evidence-key]')).toHaveLength(101);
  element.remove();
});

it('shows every histogram session with its own timing and duration under one live root card', async () => {
  const entries = [
    closed('2026-10-04T08:00Z', '2026-10-04T08:10Z'),
    closed('2026-10-04T09:00Z', '2026-10-04T09:12Z', 2),
  ];
  const root = task('One task', { timeEntries: entries });
  const snapshot = source([root]);
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request({ view: 'sessions' }),
      work,
    ),
  );
  const selection = required(
    model.sections
      .flatMap((section) => section.charts)
      .flatMap((chart) => chart.marks)
      .find((mark) => mark.key === 'session-bin:2'),
  );
  const id = required(selection.selectionId);
  const page = model.evidence(id, 0, 50);
  expect(page.total).toBe(2);
  expect(page.rows.map((row) => row.entry)).toEqual(
    entries.map((entry) => ({
      parent: { type: 'task', ref: root.ref },
      relativeLine: entry.relativeLine,
      originalMarkdown: entry.originalMarkdown,
    })),
  );
  const element = document.body.createDiv();
  cleanup.push(() => {
    element.remove();
  });
  new StatisticsEvidence(
    {
      readStatistics: () => snapshot,
      isStatisticsCurrent: () => true,
      whenStatisticsSettled: async () => {},
      refreshStatistics: async () => {},
      subscribeStatistics: () => () => {},
    },
    { resolve: () => ({ type: 'exact', task: root, basis: { observed: root } }) },
    {
      renderRoot: (host) => {
        host.createDiv({ cls: 'root-card', text: root.title });
      },
      select: vi.fn(),
      openSource: async () => {},
    },
  ).render(element, model, { id, label: required(selection.label) }, vi.fn());
  const rows = [...element.querySelectorAll<HTMLElement>('[data-evidence-key]')];
  expect(rows).toHaveLength(2);
  expect(element.querySelectorAll('.root-card')).toHaveLength(1);
  expect(new Set(rows.map((row) => row.dataset['evidenceKey'])).size).toBe(2);
  expect(new Set(rows.map((row) => row.textContent)).size).toBe(2);
  for (const [index, duration] of ['10m', '12m'].entries()) {
    const entry = required(entries[index]);
    expect(rows[index]?.textContent).toContain('Full session');
    expect(rows[index]?.textContent).toContain(duration);
    for (const instant of [required(entry.startMs), required(entry.endMs)])
      expect(rows[index]?.textContent).toContain(
        new Date(instant).toLocaleString('en', { timeZoneName: 'short' }),
      );
  }
});

it('keeps full session timing separate from clipped contributions and running archive records', async () => {
  const snapshot = source(
    [],
    [
      task('Archive', {
        timeEntries: [
          closed('2026-10-03T23:50Z', '2026-10-04T00:20Z'),
          {
            state: 'running',
            startMs: Date.parse('2026-10-04T10:10Z'),
            relativeLine: 2,
            originalMarkdown: 'running',
          },
          { state: 'broken', relativeLine: 3, originalMarkdown: 'broken' },
          closed('2026-10-04T09:00Z', '2026-10-04T08:00Z', 4),
        ],
      }),
    ],
  );
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request({ view: 'allocation', period: 'today', nowMs: Date.parse('2026-10-04T10:30Z') }),
      work,
    ),
  );
  const element = document.body.createDiv();
  cleanup.push(() => {
    element.remove();
  });
  const openSource = vi.fn(async () => {});
  new StatisticsEvidence(
    {
      readStatistics: () => snapshot,
      isStatisticsCurrent: () => true,
      whenStatisticsSettled: async () => {},
      refreshStatistics: async () => {},
      subscribeStatistics: () => () => {},
    },
    {
      resolve: () => {
        throw new Error('Archive evidence cannot acquire mutation authority');
      },
    },
    { renderRoot: vi.fn(), select: vi.fn(), openSource },
  ).render(element, model, { id: 'recorded-time', label: 'Recorded time' }, vi.fn());
  const rows = [...element.querySelectorAll<HTMLElement>('[data-evidence-key]')];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('Full session');
  expect(rows[0]?.textContent).toContain('30m');
  expect(rows[0]?.textContent).toContain(
    new Date('2026-10-03T23:50Z').toLocaleString('en', { timeZoneName: 'short' }),
  );
  expect(rows[1]?.textContent).toContain('Running session');
  expect(rows[1]?.textContent).not.toContain('Full session');
  expect(rows[1]?.textContent).toContain(
    new Date('2026-10-04T10:10Z').toLocaleString('en', { timeZoneName: 'short' }),
  );
  for (const row of rows) {
    expect(row.textContent).toContain('20 recorded minutes');
    row.querySelector('button')?.click();
  }
  expect(openSource.mock.calls).toEqual([
    ['Archive.md', 0],
    ['Archive.md', 0],
  ]);
});

it('renders repeated owner changes as distinct native evidence rows with their event context', async () => {
  const snapshot = source(
    [],
    [
      task('A', {
        timeEntries: [
          closed('2026-10-04T08:00Z', '2026-10-04T08:10Z'),
          closed('2026-10-04T08:20Z', '2026-10-04T08:30Z', 2),
        ],
      }),
      task('B', {
        timeEntries: [
          closed('2026-10-04T08:10Z', '2026-10-04T08:20Z'),
          closed('2026-10-04T08:30Z', '2026-10-04T08:40Z', 2),
        ],
      }),
    ],
  );
  const model = required(
    await new StatisticsSession(required(await prepareStatisticsDataset(snapshot, [], work))).view(
      request({ view: 'sessions' }),
      work,
    ),
  );
  const port: TaskStatisticsSource = {
    readStatistics: () => snapshot,
    isStatisticsCurrent: () => true,
    whenStatisticsSettled: async () => {},
    refreshStatistics: async () => {},
    subscribeStatistics: () => () => {},
  };
  const element = document.body.createDiv();
  new StatisticsEvidence(
    port,
    { resolve: (ref) => ({ type: 'not-found', ref }) },
    { renderRoot: vi.fn(), select: vi.fn(), openSource: async () => {} },
  ).render(element, model, { id: 'recorded-changes', label: 'Recorded changes' }, vi.fn());
  const rows = [...element.querySelectorAll<HTMLElement>('[data-evidence-key]')];
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.dataset['evidenceKey'])).size).toBe(3);
  for (const [index, row] of model.evidence('recorded-changes', 0, 50).rows.entries())
    expect(rows[index]?.textContent).toContain(new Date(required(row.atMs)).toLocaleString('en'));
  element.remove();
});
