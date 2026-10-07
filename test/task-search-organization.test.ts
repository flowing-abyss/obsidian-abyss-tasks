import { describe, expect, it } from 'vitest';
import { drainCollectionSteps } from '../src/collectionSteps';
import { buildTaskListRows, taskListGrouping } from '../src/panels/task-list/taskListRows';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ListViewState } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { outgoingTaskLinkValues } from '../src/task-lists/taskLinkValues';
import { selectTaskList } from '../src/task-lists/TaskListSelector';
import {
  organizeTaskSearch as organizationSteps,
  type TaskSearchOrganizationInput,
} from '../src/task-lists/taskSearchOrganization';
import { localDate, taskSearchAddressKey } from '../src/tasks';
import { assertNoRevision, createCanonicalSearchHarness } from './support/taskSearchHarness';
import { taskKeys } from './task-list-row-assertions';
const organizeTaskSearch = (input: TaskSearchOrganizationInput) =>
  drainCollectionSteps(organizationSteps(input));

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

function checkCompact(compact: ReturnType<typeof organizeTaskSearch>, revision: string): void {
  assertNoRevision(compact, revision);
  const repeated = compact.occurrences.filter((o) => o.taskKey === 'a.md:0');
  if (repeated.length > 1) expect(repeated[0]?.menu).toBe(repeated[1]?.menu);
  expect(compact.occurrences.every((o) => !('title' in o.menu))).toBe(true);
}

describe('compact organization shares ordinary list semantics', () => {
  it('organizes every sort/group and direction before viewport mounting without relevance ties', async () => {
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
            ).toEqual(taskKeys(rows));
            expect(compact.scope === 'roots' ? compact.rootTotal : undefined).toBe(selected.length);
            checkCompact(compact, tasks[0]?.ref.revision ?? '');
            expect([...compact.groupCounts.values()].reduce((a, b) => a + b, 0)).toBe(
              groupBy === 'none' ? 0 : compact.occurrences.length,
            );
          }
    } finally {
      h.close();
    }
  });
  it('uses own-tag membership and property/status filters with resolved link changes', async () => {
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
        filters: [
          { type: 'tag', value: '#work' },
          { type: 'file', filePath: 'a.md' },
        ],
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
          selection: { type: 'tag', tag: '#work' },
          view: { list, relevance: false },
          settings,
          today,
          nowMs: 0,
          outgoingLinks,
        });
        expect(organized.scope === 'roots' ? organized.rootTotal : undefined).toBe(1);
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
        '- [ ] Running #child\n  - [ ] child #child\n    - 2026-10-04T10:00:00+07:00 →\n- [ ] Closed #home\n  - 2026-10-04T10:00:00+07:00 → 2026-10-04T10:30:00+07:00',
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
      expect(group.scope === 'roots' ? group.rootTotal : undefined).toBe(1);
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

it('groups mixed Today dates together and orders compact records by time', async () => {
  const h = await createCanonicalSearchHarness(
    {
      'a.md':
        '- [ ] late 📅 2026-10-04 ⏰ 18:00\n- [ ] untimed 📅 2026-10-04\n- [ ] early scheduled ⏳ 2026-10-04 📅 2026-10-05 ⏰ 08:00\n- [ ] morning 📅 2026-10-04 ⏰ 09:00\n- [ ] same morning ⏳ 2026-10-04 📅 2026-10-06 ⏰ 09:00\n- [ ] overdue 📅 2026-10-03 ⏳ 2026-10-04 ⏰ 20:00',
    },
    settings,
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    const compact = organizeTaskSearch({
      generation,
      records,
      hits: null,
      selection: 'today',
      view: {
        list: { groupBy: 'date', sortBy: { field: 'date', dir: 'asc' }, filters: [] },
        relevance: false,
      },
      settings,
      today,
      nowMs: 0,
      outgoingLinks: new Map(),
    });
    expect(compact.occurrences.map((o) => [o.key, o.group?.label])).toEqual([
      ['a.md:5', 'Overdue'],
      ['a.md:2', 'Today'],
      ['a.md:3', 'Today'],
      ['a.md:4', 'Today'],
      ['a.md:0', 'Today'],
      ['a.md:1', 'Today'],
    ]);
  } finally {
    h.close();
  }
});

it.each(['creation', 'navigation'] as const)(
  'retires the exact %s exception without expanding query hits or filters',
  async (kind) => {
    const h = await createCanonicalSearchHarness(
      { 'a.md': '- [ ] Filler #keep\n- [ ] New astronomy\n- [ ] Unrelated astronomy' },
      settings,
    );
    try {
      const subscription = h.index.searchSource().subscribe(() => {});
      const generation = subscription.state.generation;
      subscription.unsubscribe();
      const records = [];
      for await (const batch of h.index.organization(
        { expectedGeneration: generation },
        new AbortController().signal,
      ))
        records.push(...batch.items);
      const matching = records[0],
        created = records[1];
      if (matching === undefined || created === undefined) throw new Error('Fixture roots missing');
      const input: TaskSearchOrganizationInput = {
        generation,
        records,
        hits: [{ address: matching.address, score: 1 }],
        selection: null,
        view: {
          list: {
            groupBy: 'none',
            sortBy: { field: 'date', dir: 'asc' },
            filters: [{ type: 'tag', value: '#keep' }],
          },
          relevance: false,
        },
        settings,
        today,
        nowMs: 0,
        outgoingLinks: new Map(),
      };
      const revealed = organizeTaskSearch({ ...input, reveal: created.address, revealKind: kind });
      expect(revealed.occurrences.map((row) => row.taskKey)).toEqual(['a.md:0', 'a.md:1']);
      expect(revealed.occurrences[1]?.group?.label).toBe(
        kind === 'creation' ? 'Created task' : 'Revealed task',
      );
      expect(revealed.scope === 'roots' ? revealed.rootTotal : undefined).toBe(2);
      const retired = organizeTaskSearch(input);
      expect(retired.occurrences.map((row) => row.taskKey)).toEqual(['a.md:0']);
      expect(retired.revealIndex).toBeUndefined();
      expect(retired.scope === 'roots' ? retired.rootTotal : undefined).toBe(1);
      const alreadyMatching = organizeTaskSearch({
        ...input,
        reveal: matching.address,
        revealKind: kind,
      });
      expect(alreadyMatching.occurrences).toHaveLength(1);
      expect(alreadyMatching.occurrences[0]?.group).toBeNull();
    } finally {
      h.close();
    }
  },
);

it('organizes exact sibling addresses and reveals a filtered nested parent without a root receipt', async () => {
  const h = await createCanonicalSearchHarness(
    {
      'tree.md':
        '- [ ] Grandparent #one-off\n  - [ ] Parent #private\n    - [ ] Same #inbox 📅 2026-10-08\n  - [ ] Same #inbox 📅 2026-10-08',
    },
    settings,
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    const input: TaskSearchOrganizationInput = {
      scope: 'nodes',
      generation,
      records,
      hits: null,
      selection: { type: 'tag', tag: '#inbox' },
      view: {
        list: { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
        relevance: false,
      },
      settings,
      today,
      nowMs: 0,
      outgoingLinks: new Map(),
    };
    const organization = organizeTaskSearch(input);
    expect(organization.scope).toBe('nodes');
    if (organization.scope !== 'nodes') throw new Error('node organization expected');
    expect(organization.nodeTotal).toBe(2);
    expect(new Set(organization.occurrences.map((o) => taskSearchAddressKey(o.address))).size).toBe(
      2,
    );
    expect(organization.occurrences.map((o) => o.depth)).toEqual([2, 1]);
    const relevanceNodes = organizeTaskSearch({
      ...input,
      hits: organization.occurrences,
      view: { ...input.view, relevance: true },
    });
    expect(
      new Set(relevanceNodes.occurrences.map((row) => taskSearchAddressKey(row.address))).size,
    ).toBe(2);
    const parent = records.find((r) => r.title === 'Parent');
    if (parent === undefined) throw new Error('parent missing');
    const revealed = organizeTaskSearch({ ...input, reveal: parent.address });
    expect(revealed.occurrences[revealed.revealIndex ?? -1]?.address).toEqual(parent.address);
    expect(revealed.occurrences).toHaveLength(3);
    const roots = organizeTaskSearch({ ...input, scope: 'roots', selection: null });
    expect(roots.scope).toBe('roots');
    expect(roots.occurrences).toHaveLength(1);
  } finally {
    h.close();
  }
});
