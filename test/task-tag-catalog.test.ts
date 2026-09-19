import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { collectTaskTags } from '../src/tags/taskTagCatalog';
import { normalizeTaskTagInput, type TaskNodeSnapshot } from '../src/tasks';

function node(tags: readonly string[]): TaskNodeSnapshot {
  return { node: { tags } } as TaskNodeSnapshot;
}

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
    expect(normalizeTaskTagInput('#работа')).toBeUndefined();
    expect(normalizeTaskTagInput('#worké')).toBeUndefined();
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
      collectTaskTags([node(['#task', '#nested/child']), node(['#subtask-only'])], configured, [
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
    expect(collectTaskTags([node(['#active/child'])], settings(), ['#selected/missing'])).toEqual([
      '#selected/missing',
      '#active/child',
    ]);
    expect(
      collectTaskTags([node(['#active/child'])], settings()).includes('#archive-source-only'),
    ).toBe(false);
  });
});
