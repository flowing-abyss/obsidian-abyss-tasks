import { describe, expect, it, vi } from 'vitest';
import { BrowserTaskCancelled } from '../src/browserTaskScheduler';
import * as collection from '../src/collectionSteps';
import { drainCollectionSteps } from '../src/collectionSteps';
import { runTaskOrganization } from '../src/panels/task-list/runTaskOrganization';
import { taskDailyRowsAudit } from '../src/panels/task-list/taskDailyRows';
import type { TaskListRows } from '../src/panels/task-list/taskListRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import type { RowViewportSource } from '../src/panels/virtualization/rowViewport';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskSearchOccurrence } from '../src/task-lists/taskSearchOrganization';
import {
  organizeTaskSearch,
  type TaskSearchOrganizationInput,
} from '../src/task-lists/taskSearchOrganization';
import * as taskApi from '../src/tasks';
import { localDate, type TaskOrganizationRecord } from '../src/tasks';
import { expectDefined } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

export async function dailyFixture(markdown: string, today = '2026-10-06') {
  const h = await createCanonicalSearchHarness({ 'daily.md': markdown }, DEFAULT_SETTINGS);
  const subscription = h.index.searchSource().subscribe(() => {});
  const generation = subscription.state.generation;
  subscription.unsubscribe();
  const records: TaskOrganizationRecord[] = [];
  for await (const batch of h.index.organization(
    { expectedGeneration: generation, scope: 'nodes' },
    new AbortController().signal,
  ))
    records.push(...batch.items);
  const input: TaskSearchOrganizationInput = {
    generation,
    records,
    scope: 'nodes',
    hits: null,
    selection: 'upcoming',
    view: {
      relevance: false,
      list: { groupBy: 'date', sortBy: { field: 'date', dir: 'asc' }, filters: [] },
    },
    settings: DEFAULT_SETTINGS,
    today: localDate(today),
    nowMs: 0,
    outgoingLinks: new Map(),
  };
  return { ...h, input, rows: () => drainCollectionSteps(organizeTaskSearch(input)).rows };
}

describe('complete Upcoming daily organization', () => {
  it('counts dates as appearances, preserves terminal completion and selects one physical node', async () => {
    const h = await dailyFixture('- [ ] Range 🛫 2026-10-07 📅 2026-10-09');
    try {
      const rows = h.rows();
      expect(rows.rowCount).toBe(6);
      expect(rows.taskCount).toBe(3);
      expect(rows.rowAt(0)).toMatchObject({
        kind: 'group',
        count: 1,
        dateGroup: { date: '2026-10-07' },
      });
      expect(rows.task(expectDefined(rows.taskKeyAt(0)))?.presentation).toMatchObject({
        displayDate: '2026-10-07',
        completion: { kind: 'continuation', due: '2026-10-09' },
      });
      expect(rows.task(expectDefined(rows.taskKeyAt(2)))?.presentation).toMatchObject({
        displayDate: '2026-10-09',
        completion: { kind: 'allowed' },
      });
      const all = rows.captureSelection({ spans: [{ from: 0, to: 2 }], include: [], exclude: [] });
      expect(rows.selectedCount(all)).toBe(3);
      expect(rows.selectedNodes(all)).toHaveLength(1);
      expect(rows.selectedNodes(all)[0]?.completion).toEqual({ kind: 'allowed' });
      const middle = rows.captureSelection({
        spans: [{ from: 1, to: 1 }],
        include: [],
        exclude: [],
      });
      expect(rows.firstSelectedKey(middle)).toBe(rows.taskKeyAt(1));
      expect(rows.selectedNodes(middle)[0]?.completion.kind).toBe('continuation');
      const withoutMiddle = rows.captureSelection({
        ranges: all,
        spans: [],
        include: [],
        exclude: [expectDefined(rows.taskKeyAt(1))],
      });
      expect(rows.selectedCount(withoutMiddle)).toBe(2);
      expect(withoutMiddle).toHaveLength(2);
    } finally {
      h.close();
    }
  });
  it.each(['asc', 'desc'] as const)(
    'compares time within a day independently of authored due (%s)',
    async (dir) => {
      const h = await dailyFixture(
        '- [ ] A 🛫 2026-10-08 📅 2026-10-09 ⏰ 15:00\n- [ ] B 🛫 2026-10-08 📅 2026-10-10 ⏰ 09:00\n- [ ] C 🛫 2026-10-08 📅 2026-10-11',
      );
      try {
        const rows = drainCollectionSteps(
          organizeTaskSearch({
            ...h.input,
            view: {
              relevance: false,
              list: { ...h.input.view.list, sortBy: { field: 'date', dir } },
            },
          }),
        ).rows;
        const day = [...rows.slice(0, rows.rowCount)].filter(
          (r) => r.kind === 'task' && String(r.task.presentation.displayDate) === '2026-10-08',
        );
        expect(day.map((r) => (r.kind === 'task' ? r.taskKey : ''))).toEqual(
          dir === 'asc'
            ? ['daily.md:1', 'daily.md:0', 'daily.md:2']
            : ['daily.md:2', 'daily.md:0', 'daily.md:1'],
        );
      } finally {
        h.close();
      }
    },
  );
  it('reaches the actual final day with finite descriptors, selection and exact inverse lookup', async () => {
    const h = await dailyFixture('- [ ] All 🛫 0000-01-01 📅 9999-12-31', '0000-01-01');
    try {
      const rows = h.rows();
      expect(rows.taskCount).toBe(3652424);
      expect(rows.rowCount).toBe(7304848);
      expect(rows.rowAt(0)).toMatchObject({ dateGroup: { date: '0000-01-02' } });
      expect(rows.rowAt(rows.rowCount - 2)).toMatchObject({ dateGroup: { date: '9999-12-31' } });
      const last = expectDefined(rows.taskKeyAt(rows.taskCount - 1));
      expect(rows.task(last)?.presentation.displayDate).toBe('9999-12-31');
      expect(rows.rowIndexOf(last)).toBe(rows.rowCount - 1);
      expect(rows.indexOf(last)).toBe(rows.taskCount - 1);
      expect(rows.anchorRanges().length).toBeLessThanOrEqual(2);
      const ranges = rows.captureSelection({
        spans: [{ from: 0, to: rows.taskCount - 1 }],
        include: [],
        exclude: [],
      });
      expect(ranges).toHaveLength(1);
      expect(rows.selectedCount(ranges)).toBe(rows.taskCount);
      expect(rows.selectedNodes(ranges)).toHaveLength(1);
      expect(rows.estimatedOffset(rows.rowCount, { group: 30, task: 80 })).toBe(401766640);
    } finally {
      h.close();
    }
  });
  it.each([
    ['2026-10-07', 2],
    ['2026-10-08', 1],
    ['2026-10-09', 0],
    ['9999-12-31', 0],
  ] as const)('clips strictly after today %s', async (today, count) => {
    const h = await dailyFixture('- [ ] Range 🛫 2026-10-07 📅 2026-10-09', today);
    try {
      expect(h.rows().taskCount).toBe(count);
    } finally {
      h.close();
    }
  });
});

it('keeps point holes, ignores scheduled outside valid ranges and orders tied times by creation then source', async () => {
  const h = await dailyFixture(
    '- [ ] later due 🛫 2026-10-08 📅 2026-10-11 ⏰ 09:00 ➕ 2026-01-01\n- [ ] earlier due 🛫 2026-10-08 📅 2026-10-09 ⏰ 09:00 ➕ 2026-02-01\n- [ ] inverted 🛫 2026-10-12 📅 2026-10-07 ⏳ 2026-10-12\n- [ ] same 🛫 2026-10-08 📅 2026-10-08 ⏳ 2026-10-30\n- [ ] start 🛫 2026-10-15',
  );
  try {
    const rows = h.rows();
    const headers = [...rows.slice(0, rows.rowCount)].filter((r) => r.kind === 'group');
    expect(headers).toHaveLength(7);
    const dates = headers.map((r) => r.key);
    expect(dates.some((key) => key.includes('2026-10-30'))).toBe(false);
    const day = [...rows.slice(0, rows.rowCount)].filter(
      (r) => r.kind === 'task' && String(r.presentation?.displayDate) === '2026-10-08',
    );
    expect(day.map((r) => (r.kind === 'task' ? r.taskKey : ''))).toEqual([
      'daily.md:0',
      'daily.md:1',
      'daily.md:3',
    ]);
    const none = drainCollectionSteps(
      organizeTaskSearch({
        ...h.input,
        view: { ...h.input.view, list: { ...h.input.view.list, groupBy: 'none' } },
      }),
    ).rows;
    expect(
      Array.from(none.slice(0, none.rowCount)).flatMap((r) =>
        r.kind === 'task' ? [r.taskKey] : [],
      ),
    ).toEqual(['daily.md:2', 'daily.md:3', 'daily.md:1', 'daily.md:0', 'daily.md:4']);
    const reversed = drainCollectionSteps(
      organizeTaskSearch({ ...h.input, records: [...h.input.records].reverse() }),
    ).rows;
    expect([...reversed.slice(0, reversed.rowCount)].map((r) => r.key)).toEqual(
      [...rows.slice(0, rows.rowCount)].map((r) => r.key),
    );
  } finally {
    h.close();
  }
});

it.each(['title', 'priority'] as const)(
  'keeps date groups ascending for descending %s sort',
  async (field) => {
    const h = await dailyFixture(
      '- [ ] Alpha 🛫 2026-10-07 📅 2026-10-09 ⏫\n- [ ] Zebra 🛫 2026-10-07 📅 2026-10-09',
    );
    try {
      const rows = drainCollectionSteps(
        organizeTaskSearch({
          ...h.input,
          view: { ...h.input.view, list: { ...h.input.view.list, sortBy: { field, dir: 'desc' } } },
        }),
      ).rows;
      expect(rows.task(expectDefined(rows.taskKeyAt(0)))?.presentation.displayDate).toBe(
        '2026-10-07',
      );
      expect(rows.physicalKey(expectDefined(rows.taskKeyAt(0)))).toBe('daily.md:1');
      expect(rows.task(expectDefined(rows.taskKeyAt(5)))?.presentation.displayDate).toBe(
        '2026-10-09',
      );
    } finally {
      h.close();
    }
  },
);

it('intersects canonical selections across clipping, reordering and removed nodes without selecting earlier copies', async () => {
  const h = await dailyFixture(
    '- [ ] A 🛫 2026-10-07 📅 2026-10-09\n- [ ] B 🛫 2026-10-07 📅 2026-10-10',
  );
  try {
    const rows = h.rows();
    const selection = rows.captureSelection({
      spans: [{ from: 2, to: 5 }],
      include: [expectDefined(rows.taskKeyAt(6))],
      exclude: [expectDefined(rows.taskKeyAt(3))],
    });
    expect(rows.selectedCount(selection)).toBe(4);
    expect(rows.firstSelectedKey(selection)).toBe(rows.taskKeyAt(2));
    const next = drainCollectionSteps(
      organizeTaskSearch({
        ...h.input,
        today: localDate('2026-10-08'),
        view: {
          ...h.input.view,
          list: { ...h.input.view.list, sortBy: { field: 'date', dir: 'desc' } },
        },
      }),
    ).rows;
    const rebound = next.captureSelection({
      ranges: selection,
      spans: [],
      include: [],
      exclude: [],
    });
    expect(next.selectedCount(rebound)).toBe(3);
    expect(next.firstSelectedKey(rebound)).toBe(next.taskKeyAt(0));
    expect(
      next.firstSelectedKey([
        {
          kind: 'dates',
          taskKey: 'daily.md:0',
          occurrenceKind: 'today',
          groupKey: 'upcoming-date',
          from: localDate('2026-10-09'),
          to: localDate('2026-10-09'),
        },
      ]),
    ).toBeUndefined();
    const removed = drainCollectionSteps(
      organizeTaskSearch({ ...h.input, records: [expectDefined(h.input.records[1])] }),
    ).rows;
    expect(removed.selectedCount(selection)).toBe(2);
  } finally {
    h.close();
  }
});

it('bounds day cache and analytic old-order survivor lookup across the complete domain', async () => {
  const h = await dailyFixture('- [ ] All 🛫 0000-01-01 📅 9999-12-31', '0000-01-01');
  try {
    const rows = h.rows();
    for (let i = 0; i < 100; i++) rows.taskKeyAt(i * 30000);
    expect(taskDailyRowsAudit(rows)).toEqual({
      descriptors: 1,
      events: 2,
      segments: 1,
      cachedDays: 64,
    });
    const next = drainCollectionSteps(
      organizeTaskSearch({
        ...h.input,
        today: localDate('9999-12-29'),
        view: {
          ...h.input.view,
          list: { ...h.input.view.list, sortBy: { field: 'date', dir: 'desc' } },
        },
      }),
    ).rows;
    const source = viewportSource(next);
    expect(rows.survivingNeighbor(0, 1, source)).toBe(
      JSON.stringify(['upcoming-date', '9999-12-30']),
    );
    expect(rows.survivingNeighbor(rows.rowCount, -1, source)).toBe(
      rows.taskKeyAt(rows.taskCount - 1),
    );
    expect(rows.survivingNeighbor(0, -1, source)).toBeUndefined();
    const selection = new TaskRowSelection();
    selection.bind(rows);
    selection.collapseTo(expectDefined(rows.taskKeyAt(0)));
    selection.extendTo(expectDefined(rows.taskKeyAt(rows.taskCount - 1)), rows);
    expect(selection.size).toBe(3652424);
    expect(selection.ranges()).toHaveLength(1);
    expect(selection.selectedNodes(rows)).toHaveLength(1);
    selection.bind(next, { physicalKeys: new Map([['daily.md:0', 'daily.md:0']]) });
    expect(selection.size).toBe(2);
    expect(selection.focus).toBe(next.taskKeyAt(0));
  } finally {
    h.close();
  }
});

function viewportSource(rows: TaskListRows<TaskSearchOccurrence>): RowViewportSource {
  return {
    length: rows.rowCount,
    rowAt: (i) => {
      const row = rows.rowAt(i);
      return row === undefined
        ? undefined
        : {
            key: row.key,
            estimatedHeight: row.kind === 'group' ? 30 : 80,
            measurementRevision: rows.revision,
          };
    },
    indexOf: (key) => rows.rowIndexOf(key),
    estimatedOffset: (i) => rows.estimatedOffset(i, { group: 30, task: 80 }),
    anchorRanges: () => rows.anchorRanges(),
    survivingNeighbor: (i, direction, current) => rows.survivingNeighbor(i, direction, current),
  };
}

it.each(['asc', 'desc'] as const)(
  'finds exact survivors in immutable %s old order after filtering and opposite sorting',
  async (dir) => {
    const h = await dailyFixture(
      '- [ ] A 🛫 2026-10-07 📅 2026-10-11\n- [ ] B 🛫 2026-10-08 📅 2026-10-10',
    );
    try {
      const before = drainCollectionSteps(
        organizeTaskSearch({
          ...h.input,
          view: { ...h.input.view, list: { ...h.input.view.list, sortBy: { field: 'date', dir } } },
        }),
      ).rows;
      expect(before.rowAt(0)).toMatchObject({
        dateGroup: { date: dir === 'asc' ? '2026-10-07' : '2026-10-11' },
      });
      const after = drainCollectionSteps(
        organizeTaskSearch({
          ...h.input,
          records: [expectDefined(h.input.records[1])],
          today: localDate('2026-10-08'),
          view: {
            ...h.input.view,
            list: {
              ...h.input.view.list,
              sortBy: { field: 'date', dir: dir === 'asc' ? 'desc' : 'asc' },
            },
          },
        }),
      ).rows;
      const oldKeys = [...before.slice(0, before.rowCount)].map((r) => r.key);
      const current = viewportSource(after);
      for (let pivot = 0; pivot < oldKeys.length; pivot++)
        for (const direction of [1, -1] as const) {
          const candidates =
            direction === 1 ? oldKeys.slice(pivot + 1) : oldKeys.slice(0, pivot).reverse();
          const expected = candidates.find((key) => after.rowIndexOf(key) >= 0);
          expect(before.survivingNeighbor(pivot, direction, current)).toBe(expected);
        }
    } finally {
      h.close();
    }
  },
);

it.each([
  { count: 10000, start: '2026-10-07', due: '2026-10-07', logical: 10000 },
  { count: 100, start: '2026-10-07', due: '2036-10-06', logical: 365300 },
])(
  'constructs $count canonical nodes with storage independent of occupied days',
  async ({ count, start, due, logical }) => {
    const h = await dailyFixture(
      Array.from({ length: count }, (_, i) => `- [ ] Task ${i} 🛫 ${start} 📅 ${due}`).join('\n'),
    );
    try {
      const steps = organizeTaskSearch(h.input);
      let checkpoints = 0;
      let result = steps.next();
      while (result.done !== true) {
        checkpoints++;
        result = steps.next();
      }
      const rows = expectDefined(result.value).rows;
      expect(checkpoints).toBeGreaterThan(count);
      expect(rows.taskCount).toBe(logical);
      expect(taskDailyRowsAudit(rows)).toMatchObject({
        descriptors: count,
        events: count * 2,
        segments: 1,
        cachedDays: 1,
      });
      expect(
        rows.selectedNodes(
          rows.captureSelection({
            spans: [{ from: 0, to: rows.taskCount - 1 }],
            include: [],
            exclude: [],
          }),
        ),
      ).toHaveLength(count);
      const partial = organizeTaskSearch(h.input);
      for (let i = 0; i < count; i++) expect(partial.next().done).not.toBe(true);
      expect(partial.return(undefined).done).toBe(true);
    } finally {
      h.close();
    }
  },
);

it('resolves selected lead in only the earliest selected day vector', async () => {
  const h = await dailyFixture(
    Array.from(
      { length: 25 },
      (_, i) => `- [ ] Point ${i} 📅 2026-10-${String(i + 7).padStart(2, '0')}`,
    ).join('\n'),
  );
  try {
    const rows = h.rows();
    const ranges = h.input.records.map((record) => ({
      kind: 'dates' as const,
      taskKey: `${record.source.filePath}:${record.source.line}`,
      occurrenceKind: 'daily' as const,
      groupKey: 'upcoming-date',
      from: expectDefined(record.planning.due),
      to: expectDefined(record.planning.due),
    }));
    expect(rows.firstSelectedKey(ranges)).toBe(rows.taskKeyAt(0));
    expect(taskDailyRowsAudit(rows)?.cachedDays).toBe(1);
  } finally {
    h.close();
  }
});

it.each(['events', 'event-sort', 'first-day-sort'] as const)(
  'cancels actual daily %s work through the production driver without publishing',
  async (target) => {
    const h = await dailyFixture(
      '- [ ] B 🛫 2026-10-07 📅 2026-10-09\n- [ ] A 🛫 2026-10-07 📅 2026-10-10',
    );
    const controller = new AbortController();
    const reached: string[] = [];
    let stage = 'ordinary';
    const occupied = taskApi.taskOccupiedDates;
    vi.spyOn(taskApi, 'taskOccupiedDates').mockImplementation((planning) => {
      const value = occupied(planning);
      stage = 'events';
      reached.push(stage);
      return value;
    });
    const sort = collection.stableSortSteps;
    const assertSortClosed: Array<() => void> = [];
    vi.spyOn(collection, 'stableSortSteps').mockImplementation(
      <T>(values: T[], compare: (a: T, b: T) => number) => {
        const first: unknown = values[0];
        let kind = stage === 'event-sort' ? 'first-day-sort' : 'ordinary';
        if (first !== null && typeof first === 'object' && 'delta' in first) kind = 'event-sort';
        const steps = sort(values, (a, b) => {
          if (kind !== 'ordinary') {
            stage = kind;
            reached.push(kind);
          }
          return compare(a, b);
        });
        if (kind !== 'ordinary') {
          const closed = vi.spyOn(steps, 'return');
          assertSortClosed.push(() => {
            expect(closed).toHaveBeenCalledExactlyOnceWith(undefined);
          });
        }
        return steps;
      },
    );
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const log = vi.spyOn(console, 'error');
    const publish = vi.fn();
    const continuations = new Set<AbortSignal>();
    const steps = organizeTaskSearch(h.input);
    const next = vi.spyOn(steps, 'next');
    const close = vi.spyOn(steps, 'return');
    const handoff = vi.fn(async (signal: AbortSignal) => {
      continuations.add(signal);
      if (stage === target) controller.abort();
    });
    try {
      await expect(
        runTaskOrganization(steps, {
          signal: controller.signal,
          scheduler: { now: () => 0, yield: handoff },
          assertCurrent: () => {},
          phase: 'organization',
          budget: { targetMs: 4, maxSteps: 1, clockCheckEvery: 1 },
        }).then(publish),
      ).rejects.toBeInstanceOf(BrowserTaskCancelled);
      expect(reached).toContain(target);
      expect(stage).toBe(target);
      expect(publish).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledExactlyOnceWith(undefined);
      if (target !== 'events') expectDefined(assertSortClosed[assertSortClosed.length - 1])();
      expect([...continuations]).toHaveLength(1);
      expect([...continuations].every((signal) => signal.aborted)).toBe(true);
      expect(add).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function), { once: true });
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]?.[1]);
      const advances = next.mock.calls.length;
      const handoffs = handoff.mock.calls.length;
      await Promise.resolve();
      expect(next).toHaveBeenCalledTimes(advances);
      expect(handoff).toHaveBeenCalledTimes(handoffs);
      expect(steps.next()).toEqual({ done: true, value: undefined });
    } finally {
      controller.abort();
      h.close();
      vi.restoreAllMocks();
    }
  },
);

it('keeps compact and snapshot date bucket authority distinct from aggregate labels', async () => {
  const h = await dailyFixture(
    '- [ ] Now 📅 2026-10-06\n- [ ] Later 📅 2026-10-07\n- [ ] Old 📅 2026-10-01',
  );
  try {
    const rows = drainCollectionSteps(organizeTaskSearch({ ...h.input, selection: null })).rows;
    expect(
      [...rows.slice(0, rows.rowCount)]
        .filter((row) => row.kind === 'group')
        .map((row) => [row.label, row.dateGroup]),
    ).toEqual([
      ['Overdue', {}],
      ['Today', { date: '2026-10-06' }],
      ['Tomorrow', { date: '2026-10-07' }],
    ]);
    const today = drainCollectionSteps(organizeTaskSearch({ ...h.input, selection: 'today' })).rows;
    expect(today.rowAt(today.rowIndexOf('group:date:Today'))).toMatchObject({
      dateGroup: { date: '2026-10-06' },
      count: 1,
    });
  } finally {
    h.close();
  }
});
