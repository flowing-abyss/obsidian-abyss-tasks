import { expect, it, vi } from 'vitest';
import { drainCollectionSteps } from '../src/collectionSteps';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { resolveEffectiveTagGroupsSteps } from '../src/tags/effectiveTagGroups';
import { outgoingTaskLinkValuesSteps } from '../src/task-lists/taskLinkValues';
import {
  filterTaskValuesSteps,
  selectTaskValues,
  selectTaskValuesSteps,
} from '../src/task-lists/TaskListSelector';
import { localDate } from '../src/tasks';
import { task } from './helpers';

it('yields immediately after the first resolver before further resolution or deduplication', () => {
  const resolve = vi.fn(() => 'A.md');
  const steps = outgoingTaskLinkValuesSteps(
    { markdownTitle: '[[A]] [[A]] [[B]]', source: { filePath: 'x.md', line: 0 } },
    resolve,
  );
  while (resolve.mock.calls.length === 0) expect(steps.next().done).toBe(false);
  expect(resolve).toHaveBeenCalledTimes(1);
  steps.return(undefined);
  expect(resolve).toHaveBeenCalledTimes(1);
});
it('checkpoints nested catalog/manual candidates and can close inside them', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.tagGroups = [
    { id: 'g', name: 'g', mode: 'manual', tags: Array.from({ length: 100 }, (_, i) => `#tag${i}`) },
  ];
  const steps = resolveEffectiveTagGroupsSteps(settings, ['#other']);
  let count = 0;
  while (steps.next().done !== true) count++;
  expect(count).toBeGreaterThan(200);
});
it('ordinary sorts stay native while all cooperative sorting bypasses native sort', () => {
  const tasks = [task({ title: 'z' }), task({ title: 'a' })];
  const input = {
    tasks,
    selection: null,
    settings: DEFAULT_SETTINGS,
    today: localDate('2026-10-04'),
    nowMs: 0,
    viewState: {
      sortBy: { field: 'title' as const, dir: 'asc' as const },
      groupBy: 'none' as const,
      filters: [],
    },
    depth: () => 0,
    treeTags: () => [],
    trackedMs: () => 0,
  };
  const native = vi.spyOn(Array.prototype, 'sort');
  selectTaskValues(input);
  expect(native).toHaveBeenCalled();
  native.mockImplementation(() => {
    throw new Error('native full sort');
  });
  try {
    expect(drainCollectionSteps(selectTaskValuesSteps(input)).map((t) => t.title)).toEqual([
      'a',
      'z',
    ]);
  } finally {
    native.mockRestore();
  }
});
it('skips unused subtree/catalog/tracked preparation outside relevant membership or sort', () => {
  const input = {
    tasks: [task({ title: 'a' }), task({ title: 'b' })],
    selection: null,
    settings: DEFAULT_SETTINGS,
    today: localDate('2026-10-04'),
    nowMs: 0,
    viewState: {
      sortBy: { field: 'title' as const, dir: 'asc' as const },
      groupBy: 'none' as const,
      filters: [],
    },
    depth: () => 0,
    treeTags: vi.fn(() => {
      throw new Error('unused tree tags');
    }),
    trackedMs: vi.fn(() => {
      throw new Error('unused tracked total');
    }),
  };
  expect(drainCollectionSteps(filterTaskValuesSteps(input))).toHaveLength(2);
  expect(drainCollectionSteps(selectTaskValuesSteps(input))).toHaveLength(2);
  expect(input.treeTags).not.toHaveBeenCalled();
  expect(input.trackedMs).not.toHaveBeenCalled();
});
it('compact organization is lazy cooperative work, not a synchronous native sort', async () => {
  const { organizeTaskSearch } = await import('../src/task-lists/taskSearchOrganization');
  const steps = organizeTaskSearch({
    generation: 1,
    records: [],
    hits: [],
    selection: null,
    settings: DEFAULT_SETTINGS,
    today: localDate('2026-10-04'),
    nowMs: 0,
    outgoingLinks: new Map(),
    view: {
      relevance: false,
      list: { sortBy: { field: 'title', dir: 'asc' }, groupBy: 'none', filters: [] },
    },
  });
  expect(typeof steps.next).toBe('function');
  expect(drainCollectionSteps(steps).rootTotal).toBe(0);
});
