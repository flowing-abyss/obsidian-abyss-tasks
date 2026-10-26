import { describe, expect, it } from 'vitest';
import { drainCollectionSteps } from '../src/collectionSteps';
import { buildTaskListRows, taskListGrouping } from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ListViewState } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { outgoingTaskLinkValues } from '../src/task-lists/taskLinkValues';
import { selectTaskList, selectTaskNodes } from '../src/task-lists/TaskListSelector';
import {
  organizeTaskSearch as organizationSteps,
  type TaskSearchOrganizationInput,
} from '../src/task-lists/taskSearchOrganization';
import {
  localDate,
  taskNodeSourceLine,
  taskSearchAddressKey,
  type TaskOrganizationRecord,
} from '../src/tasks';
import { expectDefined } from './helpers';
import { finiteGroupCounts, finiteOccurrences } from './support/taskOrganizationRows';
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
  const { rows, ...metadata } = compact;
  assertNoRevision(metadata, revision);
  assertNoRevision([...rows.slice(0, rows.rowCount)], revision);
  expect(rows.revision).not.toContain(revision);
  const repeated = finiteOccurrences(compact).filter((o) => o.taskKey === 'a.md:0');
  if (repeated.length > 1) expect(repeated[0]?.menu).toBe(repeated[1]?.menu);
  expect(finiteOccurrences(compact).every((o) => !('title' in o.menu))).toBe(true);
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
              finiteOccurrences(compact).map((o) => o.key),
              `${field}/${groupBy}/${dir}`,
            ).toEqual(taskKeys(rows));
            expect(compact.scope === 'roots' ? compact.rootTotal : undefined).toBe(selected.length);
            checkCompact(compact, tasks[0]?.ref.revision ?? '');
            expect([...finiteGroupCounts(compact).values()].reduce((a, b) => a + b, 0)).toBe(
              groupBy === 'none' ? 0 : finiteOccurrences(compact).length,
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
        expect(finiteOccurrences(organized)).toHaveLength(2);
        expect(finiteOccurrences(organized).some((o) => o.group?.key === `note:${resolved}`)).toBe(
          true,
        );
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
      expect(finiteOccurrences(organization).map((o) => o.key)).toEqual(
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
    expect(finiteOccurrences(result).map((o) => o.key)).toEqual(['a.md:0', 'a.md:1']);
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
    expect(finiteOccurrences(compact).map((o) => [o.key, o.group?.label])).toEqual([
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

it('matches ordinary Today rows through filtering and keeps a proved compact selection', async () => {
  const h = await createCanonicalSearchHarness(
    { 'today.md': '- [ ] Due today #keep 📅 2026-10-04\n- [ ] Overdue #old 📅 2026-10-03' },
    settings,
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    const baseList: ListViewState = {
      groupBy: 'date',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [],
    };
    const input: TaskSearchOrganizationInput = {
      generation,
      records,
      hits: null,
      selection: 'today',
      view: { list: baseList, relevance: false },
      settings,
      today,
      nowMs: 0,
      outgoingLinks: new Map(),
    };
    const withHeader = organizeTaskSearch(input).rows;
    const filteredList = { ...baseList, filters: [{ type: 'tag' as const, value: '#keep' }] };
    const withoutHeader = organizeTaskSearch({
      ...input,
      view: { list: filteredList, relevance: false },
    }).rows;
    const ordinary = (list: ListViewState) => {
      const selected = selectTaskList({
        tasks: h.index.list(),
        settings,
        today,
        nowMs: 0,
        selection: 'today' as const,
        viewState: list,
      });
      return buildTaskListRows(
        selected,
        taskListGrouping('date', {
          today,
          tomorrow: '2026-10-05',
          todayList: true,
          statuses: new StatusRegistry(settings.taskStatuses),
        }),
      );
    };
    for (const [compact, list] of [
      [withHeader, baseList],
      [withoutHeader, filteredList],
    ] as const) {
      const rows = ordinary(list);
      expect([...compact.slice(0, compact.rowCount)].map((row) => [row.kind, row.key])).toEqual(
        [...rows.slice(0, rows.rowCount)].map((row) => [row.kind, row.key]),
      );
    }
    expect([...withHeader.slice(0, withHeader.rowCount)].map((row) => row.kind)).toEqual([
      'group',
      'task',
      'group',
      'task',
    ]);
    expect([...withoutHeader.slice(0, withoutHeader.rowCount)].map((row) => row.kind)).toEqual([
      'task',
    ]);
    expect(withoutHeader.rowCount).toBe(1);
    const overdueOnly = organizeTaskSearch({
      ...input,
      view: {
        list: { ...baseList, filters: [{ type: 'tag', value: '#old' }] },
        relevance: false,
      },
    }).rows;
    expect([...overdueOnly.slice(0, overdueOnly.rowCount)].map((row) => row.kind)).toEqual([
      'group',
      'task',
    ]);
    const allTasksDate = organizeTaskSearch({
      ...input,
      selection: null,
      view: { list: filteredList, relevance: false },
    }).rows;
    expect([...allTasksDate.slice(0, allTasksDate.rowCount)].map((row) => row.kind)).toEqual([
      'group',
      'task',
    ]);
    const todayPriority = organizeTaskSearch({
      ...input,
      view: { list: { ...filteredList, groupBy: 'priority' }, relevance: false },
    }).rows;
    expect([...todayPriority.slice(0, todayPriority.rowCount)].map((row) => row.kind)).toEqual([
      'group',
      'task',
    ]);
    const selection = new TaskRowSelection();
    const proof = { physicalKeys: new Map([['today.md:0', 'today.md:0']]) };
    selection.bind(withHeader);
    selection.collapseTo('today.md:0');
    selection.extendTo('today.md:0', withHeader);
    selection.bind(withoutHeader, proof);
    expect(selection.size).toBe(1);
    expect(selection.has('today.md:0')).toBe(true);
    selection.bind(withHeader, proof);
    expect(selection.size).toBe(1);
    expect(selection.has('today.md:0')).toBe(true);
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
      expect(finiteOccurrences(revealed).map((row) => row.taskKey)).toEqual(['a.md:0', 'a.md:1']);
      expect(finiteOccurrences(revealed)[1]?.group?.label).toBe(
        kind === 'creation' ? 'Created task' : 'Revealed task',
      );
      expect(revealed.scope === 'roots' ? revealed.rootTotal : undefined).toBe(2);
      const retired = organizeTaskSearch(input);
      expect(finiteOccurrences(retired).map((row) => row.taskKey)).toEqual(['a.md:0']);
      expect(retired.revealIndex).toBeUndefined();
      expect(retired.scope === 'roots' ? retired.rootTotal : undefined).toBe(1);
      const alreadyMatching = organizeTaskSearch({
        ...input,
        reveal: matching.address,
        revealKind: kind,
      });
      expect(finiteOccurrences(alreadyMatching)).toHaveLength(1);
      expect(finiteOccurrences(alreadyMatching)[0]?.group).toBeNull();
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
    expect(
      new Set(finiteOccurrences(organization).map((o) => taskSearchAddressKey(o.address))).size,
    ).toBe(2);
    expect(finiteOccurrences(organization).map((o) => o.depth)).toEqual([2, 1]);
    const relevanceNodes = organizeTaskSearch({
      ...input,
      hits: finiteOccurrences(organization),
      view: { ...input.view, relevance: true },
    });
    expect(
      new Set(finiteOccurrences(relevanceNodes).map((row) => taskSearchAddressKey(row.address)))
        .size,
    ).toBe(2);
    const parent = records.find((r) => r.title === 'Parent');
    if (parent === undefined) throw new Error('parent missing');
    const revealed = organizeTaskSearch({ ...input, reveal: parent.address });
    expect(finiteOccurrences(revealed)[revealed.revealIndex ?? -1]?.address).toEqual(
      parent.address,
    );
    expect(finiteOccurrences(revealed)).toHaveLength(3);
    const roots = organizeTaskSearch({ ...input, scope: 'roots', selection: null });
    expect(roots.scope).toBe('roots');
    expect(finiteOccurrences(roots)).toHaveLength(1);
  } finally {
    h.close();
  }
});

it('filters intervals and independent scheduled dates with own-node AND clauses in hydrated and cooperative organization', async () => {
  const h = await createCanonicalSearchHarness(
    {
      'dates.md': [
        '- [ ] Same #keep 🛫 2026-10-09 📅 2026-10-11',
        '- [ ] Same #keep 📅 2026-10-14',
        '  - [ ] Same #keep 🛫 2026-10-09 ⏳ 2026-10-08 📅 2026-10-13',
        '  - [ ] Same 🛫 2026-10-09 📅 2026-10-13',
        '- [ ] Points #keep ⏳ 2026-10-10 📅 2026-10-12',
      ].join('\n'),
    },
    settings,
  );
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    const nodes = h.index.listNodes();
    const selection = 'upcoming' as const;
    const shared = { settings, today: localDate('2026-10-07'), nowMs: 0, selection };
    const base: ListViewState = {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'tag', value: '#keep' }],
    };
    // Due anchors still order the point task after the earlier-due interval, regardless of start.
    expect(
      selectTaskNodes({ ...shared, tasks: nodes, viewState: base }).map((node) =>
        taskNodeSourceLine(node.target),
      ),
    ).toEqual([0, 4, 2, 1]);
    for (const [value, expected] of [
      ['2026-10-08', [2]], // independent scheduled date outside the valid interval
      ['2026-10-09', [0, 2]], // start endpoints, excluding parent and sibling decoys
      ['2026-10-10', [0, 4, 2]], // interior and scheduled point
      ['2026-10-11', [0, 2]], // due endpoint and gap between fallback points
      ['2026-10-12', [4, 2]], // due point
      ['2026-10-13', [2]],
      ['2026-10-10x', []], // malformed date lexically inside the interval
      ['2026-02-30', []],
    ] as const) {
      const viewState: ListViewState = {
        ...base,
        filters: [
          { type: 'date', value },
          { type: 'tag', value: '#keep' },
        ],
      };
      expect(
        selectTaskNodes({ ...shared, tasks: nodes, viewState }).map((node) =>
          taskNodeSourceLine(node.target),
        ),
        value,
      ).toEqual(expected);
      const compact = organizeTaskSearch({
        ...shared,
        scope: 'nodes',
        generation,
        records,
        hits: null,
        view: { list: viewState, relevance: false },
        outgoingLinks: new Map(),
      });
      expect(
        finiteOccurrences(compact).map((row) => {
          const record = records.find(
            (record) => taskSearchAddressKey(record.address) === taskSearchAddressKey(row.address),
          );
          return record?.source.line;
        }),
        value,
      ).toEqual(expected);
    }
  } finally {
    h.close();
  }
});

async function filteredTreeInput(markdown: string): Promise<TaskSearchOrganizationInput> {
  const h = await createCanonicalSearchHarness({ 'tree.md': markdown }, settings);
  try {
    const subscription = h.index.searchSource().subscribe(() => {});
    const generation = subscription.state.generation;
    subscription.unsubscribe();
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    return {
      scope: 'nodes',
      generation,
      records,
      hits: records.map((record) => ({ address: record.address, score: 1 })),
      selection: { type: 'tag', tag: '#keep' },
      view: {
        list: { groupBy: 'priority', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
        relevance: false,
      },
      settings,
      today,
      nowMs: 0,
      outgoingLinks: new Map(),
    };
  } finally {
    h.close();
  }
}

it.each([
  {
    markdown: '- [ ] Z parent #keep\n  - [ ] A child #keep\n    - [ ] B grandchild #keep',
    lines: [0],
  },
  { markdown: '- [ ] Z parent #keep\n  - [ ] Excluded\n    - [ ] A grandchild #keep', lines: [0] },
  {
    markdown:
      '- [ ] Excluded\n  - [ ] A #keep\n    - [ ] Same #keep\n  - [ ] B #keep\n    - [ ] Same #keep',
    lines: [1, 3],
  },
  {
    markdown: '- [ ] Same #keep\n  - [ ] Same #keep\n- [ ] Same #keep\n  - [ ] Same #keep',
    lines: [0, 2],
  },
])(
  'retains outermost eligible exact bases before child-first sorting and groups: $lines',
  async ({ markdown, lines }) => {
    const input = await filteredTreeInput(markdown);
    const result = organizeTaskSearch(input);
    expect(finiteOccurrences(result).map((row) => row.taskKey)).toEqual(
      lines.map((line) => `tree.md:${line}`),
    );
    expect(result.scope === 'nodes' && result.nodeTotal).toBe(lines.length);
    expect([...finiteGroupCounts(result).values()]).toEqual([lines.length]);
    const selection = new TaskRowSelection();
    selection.bind(result.rows);
    selection.selectAll(result.rows, {});
    expect(selection.size).toBe(lines.length);
    expect(organizeTaskSearch({ ...input, hits: null }).rows.taskCount).toBe(
      input.records.filter((r) => r.tags.includes('#keep')).length,
    );
  },
);

it.each(['status', 'property'] as const)(
  'does not grant ownership to an ancestor excluded by saved %s',
  async (filter) => {
    const input = await filteredTreeInput('- [x] Z parent #keep\n  - [ ] A child #keep #child');
    const result = organizeTaskSearch({
      ...input,
      view: {
        ...input.view,
        list: {
          ...input.view.list,
          ...(filter === 'status'
            ? { statusGroups: ['todo'] }
            : { filters: [{ type: 'tag', value: '#child' }] }),
        },
      },
    });
    expect(finiteOccurrences(result).map((row) => row.taskKey)).toEqual(['tree.md:1']);
  },
);

it.each(['navigation', 'creation'] as const)(
  'reconciles covered, covering and disjoint %s before counting and expires it',
  async (kind) => {
    const input = await filteredTreeInput(
      '- [ ] Z parent #keep\n  - [ ] A child #keep\n    - [ ] Unmatched\n- [ ] Disjoint',
    );
    const parent = expectDefined(input.records[0]),
      child = expectDefined(input.records[1]),
      unmatched = expectDefined(input.records[2]),
      disjoint = expectDefined(input.records[3]);
    for (const target of [child, unmatched]) {
      const result = organizeTaskSearch({ ...input, reveal: target.address, revealKind: kind });
      expect(finiteOccurrences(result).map((row) => row.taskKey)).toEqual(['tree.md:0']);
      expect(finiteOccurrences(result)[result.revealIndex ?? -1]?.address).toEqual(parent.address);
      expect(result.revealTarget).toEqual(target.address);
      expect(result.scope === 'nodes' && result.nodeTotal).toBe(1);
    }
    const childOnly = { ...input, hits: [{ address: child.address, score: 1 }] };
    const covered = organizeTaskSearch({ ...childOnly, reveal: parent.address, revealKind: kind });
    expect(finiteOccurrences(covered).map((row) => row.taskKey)).toEqual(['tree.md:0']);
    expect(covered.scope === 'nodes' && covered.nodeTotal).toBe(1);
    const retired = organizeTaskSearch(childOnly);
    expect(finiteOccurrences(retired).map((row) => row.taskKey)).toEqual(['tree.md:1']);
    expect(retired.revealIndex).toBeUndefined();
    const separate = organizeTaskSearch({ ...input, reveal: disjoint.address, revealKind: kind });
    expect(finiteOccurrences(separate).map((row) => row.taskKey)).toEqual([
      'tree.md:0',
      'tree.md:3',
    ]);
  },
);

it('drops covered child selection without transferring it to the ancestor', async () => {
  const input = await filteredTreeInput('- [ ] Z parent #keep\n  - [ ] A child #keep');
  const selection = new TaskRowSelection();
  const before = organizeTaskSearch({ ...input, hits: null });
  selection.bind(before.rows);
  selection.collapseTo('tree.md:1');
  selection.bind(organizeTaskSearch(input).rows);
  expect(selection.size).toBe(0);
  expect(selection.has('tree.md:0')).toBe(false);
});

it('uses the complete root identity and relative path for ownership', async () => {
  const input = await filteredTreeInput('- [ ] Parent #keep\n  - [ ] Same #keep');
  const parent = expectDefined(input.records[0]),
    child = expectDefined(input.records[1]);
  const records = [
    parent,
    child,
    ...[
      { ...child.address, epoch: 'other' },
      { ...child.address, version: child.address.version + 1 },
      { ...child.address, rootId: child.address.rootId + 1 },
    ].map((address, i) => ({ ...child, address, source: { filePath: `other${i}.md`, line: 1 } })),
  ];
  const result = organizeTaskSearch({
    ...input,
    records,
    hits: records.map((r) => ({ address: r.address, score: 1 })),
  });
  expect(new Set(finiteOccurrences(result).map((row) => row.taskKey))).toEqual(
    new Set(['tree.md:0', 'other0.md:1', 'other1.md:1', 'other2.md:1']),
  );
});

it('retains grouped occurrences of an owner and deduplicates physical bulk targets', async () => {
  const input = await filteredTreeInput(
    '- [ ] Parent #keep [[A]] [[B]]\n  - [ ] Child #keep [[A]] [[B]]',
  );
  const outgoingLinks = new Map(
    input.records.map((r) => [
      `${r.source.filePath}:${r.source.line}`,
      outgoingTaskLinkValues(r, (target) => `${target}.md`),
    ]),
  );
  const result = organizeTaskSearch({
    ...input,
    outgoingLinks,
    view: { ...input.view, list: { ...input.view.list, groupBy: 'outgoing-link' } },
  });
  expect(finiteOccurrences(result).map((row) => row.taskKey)).toEqual(['tree.md:0', 'tree.md:0']);
  expect([...finiteGroupCounts(result).values()]).toEqual([1, 1]);
  const selection = new TaskRowSelection();
  selection.bind(result.rows);
  selection.selectAll(result.rows, {});
  expect(result.rows.selectedNodes(selection.ranges()).map((node) => node.taskKey)).toEqual([
    'tree.md:0',
  ]);
});

it('counts an interval owner once while retaining its daily occurrences', async () => {
  const input = await filteredTreeInput(
    '- [ ] Parent #keep 🛫 2026-10-04 📅 2026-10-06\n  - [ ] Child #keep 🛫 2026-10-04 📅 2026-10-06',
  );
  const result = organizeTaskSearch({
    ...input,
    selection: 'upcoming',
    view: { ...input.view, list: { ...input.view.list, groupBy: 'date' } },
  });
  expect(result.scope === 'nodes' && result.nodeTotal).toBe(1);
  // Upcoming starts tomorrow; the current day belongs to Today.
  expect(result.rows.taskCount).toBe(2);
  expect([...finiteGroupCounts(result).values()]).toEqual([1, 1]);
  const selection = new TaskRowSelection();
  selection.bind(result.rows);
  selection.selectAll(result.rows, {});
  expect(result.rows.selectedNodes(selection.ranges()).map((node) => node.taskKey)).toEqual([
    'tree.md:0',
  ]);
});

it('keeps one dated card per task in Upcoming Kanban instead of expanding daily occurrences', async () => {
  const input = await filteredTreeInput('- [ ] Parent #keep 🛫 2026-10-04 📅 2026-10-30');
  const result = organizeTaskSearch({
    ...input,
    selection: 'upcoming',
    view: { ...input.view, list: { ...input.view.list, view: 'kanban', groupBy: 'date' } },
  });
  expect(result.rows.taskCount).toBe(1);
  expect(result.rows.rowCount).toBe(2);
});
