import { describe, expect, it } from 'vitest';
import { cloneTaskSnapshot } from '../../src/tasks/domain/cloneTaskSnapshot';
import type { TaskSnapshot } from '../../src/tasks/domain/types';
import { taskDependencyId, taskDependencyIds } from '../../src/tasks/domain/validation';

describe('task dependency carrier validation', () => {
  it('retains only the existing Tasks-compatible ID grammar in a readonly array', () => {
    const ids = taskDependencyIds(['one', 'two-2', 'three_3']);

    expect(ids).toEqual(['one', 'two-2', 'three_3']);
    expect(taskDependencyId('one')).toBe('one');
    expect(() => taskDependencyIds(['valid', 'not.valid'])).toThrow('invalid-task-dependency-id');
    expect(() => taskDependencyIds('not-an-array' as unknown as readonly string[])).toThrow(
      'invalid-task-dependency-ids',
    );
  });

  it('does not clone a dependency carrier with an invalid runtime array', () => {
    const snapshot = {
      ref: { filePath: 'Tasks.md', line: 0, revision: 'r0' },
      title: 'Task',
      markdownTitle: 'Task',
      status: 'open',
      statusSymbol: ' ',
      priority: 'D',
      planning: {},
      tags: [],
      onCompletion: 'keep',
      onCompletionExplicit: false,
      subtasks: [],
      comments: [],
      dependency: { id: 'valid', dependsOn: [42] as unknown as readonly string[] },
      source: {
        filePath: 'Tasks.md',
        line: 0,
        originalMarkdown: '- [ ] Task',
        originalBlock: '- [ ] Task',
      },
      presentation: { linkCount: 0 },
    } satisfies TaskSnapshot;

    expect(() => cloneTaskSnapshot(snapshot)).toThrow('invalid-task-dependency-id');
  });
});
