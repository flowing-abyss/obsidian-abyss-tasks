import { describe, expect, it } from 'vitest';
import { buildTaskListRows, taskListGrouping } from '../src/panels/task-list/taskListRows';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ListViewState } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { outgoingTaskLinkValues } from '../src/task-lists/taskLinkValues';
import { selectTaskList } from '../src/task-lists/TaskListSelector';
import { organizeTaskSearch } from '../src/task-lists/taskSearchOrganization';
import { localDate } from '../src/tasks';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

const fields: Array<ListViewState['sortBy']['field']> = [
  'date',
  'priority',
  'title',
  'tag',
  'status',
  'tracked',
  'source-note',
  'outgoing-link',
];
const groups: Array<ListViewState['groupBy']> = [
  'none',
  'date',
  'priority',
  'tag',
  'status',
  'source-note',
  'outgoing-link',
];
const settings = structuredClone(DEFAULT_SETTINGS);
const today = localDate('2026-10-04');
const files = {
  'a.md':
    '- [ ] Zebra [[Alice|Alias]] [[Bob]] #work 📅 2026-10-04 ⏫\n    - [ ] child #nested/one\n- [x] Alpha #home 📅 2026-10-03\n- [ ] Same ➕ 2026-10-01',
  'b.md': '- [ ] Same ➕ 2026-10-02\n- [ ] Loose [[Alice#Heading]] #work\n- [/] Busy',
};

describe('compact organization shares ordinary list semantics', () => {
  it('organizes every sort/group and direction before paging without relevance ties', async () => {
    const h = await createCanonicalSearchHarness(files, settings);
    try {
      const signal = new AbortController().signal;
      const subscription = h.index.searchSource().subscribe(() => {});
      const generation = subscription.state.generation;
      subscription.unsubscribe();
      const records = [];
      for await (const batch of h.index.organization({ expectedGeneration: generation }, signal))
        records.push(...batch.items);
      const tasks = h.index.list();
      const links = new Map(
        records.map((r) => [
          `${r.source.filePath}:${r.source.line}`,
          outgoingTaskLinkValues(r, (target) => `${target}.md`),
        ]),
      );
      const hits = records.map((r, i) => ({ address: r.address, score: 100 - i })).reverse();
      for (const field of fields)
        for (const groupBy of groups)
          for (const dir of ['asc', 'desc'] as const) {
            const list: ListViewState = { sortBy: { field, dir }, groupBy, filters: [] };
            const input = { settings, today, nowMs: 1800000000000, outgoingLinks: links };
            const selected = selectTaskList({ ...input, tasks, selection: null, viewState: list });
            const rows = buildTaskListRows(
              selected,
              taskListGrouping(groupBy, {
                today,
                tomorrow: '2026-10-05',
                statuses: new StatusRegistry(settings.taskStatuses),
                outgoingLinks: links,
              }),
            );
            const compact = organizeTaskSearch({
              ...input,
              generation,
              records,
              hits,
              selection: null,
              view: { list, relevance: false },
            });
            expect(
              compact.occurrences.map((o) => o.key),
              `${field}/${groupBy}/${dir}`,
            ).toEqual(rows.taskKeys);
            expect(compact.rootTotal).toBe(selected.length);
            expect([...compact.groupCounts.values()].reduce((a, b) => a + b, 0)).toBe(
              groupBy === 'none' ? 0 : compact.occurrences.length,
            );
          }
    } finally {
      h.close();
    }
  });
  it('uses subtree membership and property/status filters with resolved link changes', async () => {
    const h = await createCanonicalSearchHarness(files, settings);
    try {
      const signal = new AbortController().signal;
      const subscription = h.index.searchSource().subscribe(() => {});
      const generation = subscription.state.generation;
      subscription.unsubscribe();
      const records = [];
      for await (const b of h.index.organization({ expectedGeneration: generation }, signal))
        records.push(...b.items);
      const list: ListViewState = {
        sortBy: { field: 'title', dir: 'asc' },
        groupBy: 'outgoing-link',
        filters: [{ type: 'tag', value: '#work' }],
        statusGroups: ['todo'],
      };
      for (const resolved of ['Alice.md', 'People/Alice.md']) {
        const outgoingLinks = new Map(
          records.map((r) => [
            `${r.source.filePath}:${r.source.line}`,
            outgoingTaskLinkValues(r, (target) => (target === 'Alice' ? resolved : undefined)),
          ]),
        );
        const organized = organizeTaskSearch({
          generation,
          records,
          hits: null,
          selection: { type: 'tag', tag: '#nested/one' },
          view: { list, relevance: false },
          settings,
          today,
          nowMs: 0,
          outgoingLinks,
        });
        expect(organized.rootTotal).toBe(1);
        expect(organized.occurrences).toHaveLength(2);
        expect(organized.occurrences.some((o) => o.group?.key === `note:${resolved}`)).toBe(true);
      }
    } finally {
      h.close();
    }
  });
});

it('reads actual subtree tracked totals at two explicit instants and configured group identities', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.tagGroups = [{ id: 'configured', name: 'Work', mode: 'manual', tags: ['#child'] }];
  settings.pinnedTags = ['#child'];
  const h = await createCanonicalSearchHarness(
    {
      'a.md':
        '- [ ] Running\n  - [ ] child #child\n    - 2026-10-04T10:00:00+07:00 →\n- [ ] Closed #home\n  - 2026-10-04T10:00:00+07:00 → 2026-10-04T10:30:00+07:00',
    },
    settings,
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records = [];
    for await (const b of h.index.organization(
      { expectedGeneration: generation },
      new AbortController().signal,
    ))
      records.push(...b.items);
    expect(records.some((r) => r.tracked.openStartsMs.length > 0)).toBe(true);
    for (const nowMs of [
      new Date(2026, 9, 4, 10, 10).getTime(),
      new Date(2026, 9, 4, 11, 0).getTime(),
    ]) {
      const list: ListViewState = {
        groupBy: 'none',
        sortBy: { field: 'tracked', dir: 'desc' },
        filters: [],
      };
      const selected = selectTaskList({
        tasks: h.index.list(),
        selection: null,
        viewState: list,
        settings,
        today,
        nowMs,
      });
      const organization = organizeTaskSearch({
        generation,
        records,
        hits: null,
        selection: null,
        view: { list, relevance: false },
        settings,
        today,
        nowMs,
        outgoingLinks: new Map(),
      });
      expect(organization.occurrences.map((o) => o.key)).toEqual(
        selected.map((r) => `${r.source.filePath}:${r.source.line}`),
      );
      const group = organizeTaskSearch({
        generation,
        records,
        hits: null,
        selection: { type: 'group', groupId: 'configured' },
        view: { list, relevance: false },
        settings,
        today,
        nowMs,
        outgoingLinks: new Map(),
      });
      expect(group.rootTotal).toBe(1);
    }
  } finally {
    h.close();
  }
});

it('preserves engine relevance order even when exact-title precedence has a smaller score', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': '- [ ] Exact\n- [ ] Other' },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records = [];
    for await (const b of h.index.organization(
      { expectedGeneration: generation },
      new AbortController().signal,
    ))
      records.push(...b.items);
    const first = records[0],
      second = records[1];
    if (first === undefined || second === undefined) throw new Error('Fixture roots missing');
    const result = organizeTaskSearch({
      generation,
      records,
      hits: [
        { address: first.address, score: 1 },
        { address: second.address, score: 1000 },
      ],
      selection: null,
      view: {
        list: { groupBy: 'none', sortBy: { field: 'date', dir: 'asc' }, filters: [] },
        relevance: true,
      },
      settings: DEFAULT_SETTINGS,
      today,
      nowMs: 0,
      outgoingLinks: new Map(),
    });
    expect(result.occurrences.map((o) => o.key)).toEqual(['a.md:0', 'a.md:1']);
  } finally {
    h.close();
  }
});
