import { enumerateTaskNodes } from '../src/tasks/domain/taskDependencies';
import { queryApiForTasks, subtask, task, taskQueryApi } from './helpers';
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { collectTaskTags } from '../src/tags/taskTagCatalog';
import { normalizeTaskTagInput } from '../src/tasks';

function settings(overrides: Partial<CalendarSettings> = {}): CalendarSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...overrides,
  };
}

describe('task tag policy', () => {
  it('normalizes bare, repeated-hash, and multiple tag input with stable deduplication', () => {
    expect(normalizeTaskTagInput('##work #home work')).toEqual(['#work', '#home']);
    expect(normalizeTaskTagInput('##  #')).toEqual([]);
  });

  it('rejects the complete input when any nonempty token is invalid', () => {
    expect(normalizeTaskTagInput('#work #bad! #home')).toBeUndefined();
    expect(normalizeTaskTagInput('#работа')).toEqual(['#работа']);
    expect(normalizeTaskTagInput('#worké')).toEqual(['#worké']);
  });
});

describe('task tag catalog', () => {
  it('combines indexed task nodes, configured candidates, and selected tags in stable order', () => {
    const configured = settings({
      taskPrefix: '#prefix prose `#code` #prefix/two',
      inbox: { mode: 'tag', tag: 'inbox', removeTagOnAssign: true },
      pinnedTags: ['#pinned'],
      archivedTags: ['#archived-navigation'],
      archivedTagPrefixes: ['#zero-prefix'],
      tagGroups: [
        { id: 'prefix', name: 'Work', mode: 'prefix', prefix: 'work' },
        { id: 'manual', name: 'Manual', mode: 'manual', tags: ['#manual', '#task'] },
      ],
    });

    expect(
      collectTaskTags(['#task', '#nested/child', '#subtask-only'], configured, [
        '#selected',
        '#task',
      ]),
    ).toEqual([
      '#selected',
      '#task',
      '#nested/child',
      '#subtask-only',
      '#pinned',
      '#archived-navigation',
      '#zero-prefix',
      '#work',
      '#manual',
      '#prefix',
      '#prefix/two',
      '#inbox',
    ]);
  });

  it('does not invent parent tags or include archive-source-only tags absent from public task nodes', () => {
    expect(collectTaskTags(['#active/child'], settings(), ['#selected/missing'])).toEqual([
      '#selected/missing',
      '#active/child',
    ]);
    expect(collectTaskTags(['#active/child'], settings()).includes('#archive-source-only')).toBe(
      false,
    );
  });
});

describe('query fixture read defaults', () => {
  it('retains list-only child, listNodes-only third and configured tags', () => {
    const root = task({ tags: ['#root'], subtasks: [subtask({ tags: ['#child'] })] });
    const listed = taskQueryApi({ list: () => [root] });
    expect(listed.observedTags()).toEqual(['#root', '#child']);
    const nodes = taskQueryApi({
      listNodes: () => enumerateTaskNodes([task({ tags: ['#third'] })]),
    });
    expect(
      collectTaskTags(nodes.observedTags(), settings({ pinnedTags: ['#configured'] })),
    ).toEqual(['#third', '#configured']);
    expect(queryApiForTasks(() => [root]).observedTags()).toEqual(['#root', '#child']);
  });
  it('preserves customized active dependency counts', () => {
    const api = taskQueryApi({
      dependencies: () => ({
        blockedBy: [],
        blocks: [],
        activeBlockedByCount: 3,
        activeBlocksCount: 4,
      }),
    });
    expect(api.dependencySummary({ type: 'task', ref: task().ref })).toEqual({
      activeBlockedByCount: 3,
      activeBlocksCount: 4,
    });
  });
  it('empty search fixtures report generation zero and reject invented nonempty reads', async () => {
    const empty = taskQueryApi();
    const signal = new AbortController().signal;
    expect(await empty.resolveSearchHits([], signal)).toEqual([]);
    expect(
      await empty.organization({ expectedGeneration: 0 }, signal)[Symbol.asyncIterator]().next(),
    ).toEqual({ done: false, value: { generation: 0, items: [] } });
    const nonempty = taskQueryApi({ list: () => [task()] });
    await expect(nonempty.resolveSearchHits([], signal)).rejects.toThrow(
      'Search reads require configuredTaskApplication',
    );
    await expect(
      nonempty.organization({ expectedGeneration: 0 }, signal)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow('Search reads require configuredTaskApplication');
  });
});
