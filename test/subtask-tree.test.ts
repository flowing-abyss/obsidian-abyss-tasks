import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { sameTaskNodeRef, type TaskNodeRef } from '../src/tasks/domain/types';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { createAppWithFiles, expectDefined } from './helpers';

describe('subtask snapshot tree', () => {
  it('retains a complete immediate-parent reference chain for duplicate nested text', async () => {
    const source =
      '- [ ] root\n' +
      '  - [ ] duplicate\n' +
      '    - [ ] nested duplicate\n' +
      '  - [ ] duplicate\n' +
      '    - [ ] nested duplicate\n';
    const app = await createAppWithFiles({ 'tasks.md': source });
    const index = new TaskIndex(app, {
      statusCatalog: new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
    });
    const root = expectDefined(index.snapshotsFromContent('tasks.md', source)[0]);
    const secondNested = expectDefined(expectDefined(root.subtasks[1]).subtasks[0]);

    expect(secondNested.ref.relativeLine).toBe(1);
    expect(secondNested.ref.parent).toEqual({
      type: 'subtask',
      ref: expectDefined(root.subtasks[1]).ref,
    });
    expect(expectDefined(root.subtasks[1]).ref.relativeLine).toBe(3);
    expect(expectDefined(root.subtasks[1]).ref.parent).toEqual({ type: 'task', ref: root.ref });
  });

  it('compares complete root and ancestor evidence structurally', () => {
    const root: TaskNodeRef = {
      type: 'task',
      ref: { filePath: 'tasks.md', line: 0, revision: 'root' },
    };
    const parent: TaskNodeRef = {
      type: 'subtask',
      ref: { parent: root, relativeLine: 1, originalBlock: '  - [ ] parent' },
    };

    expect(sameTaskNodeRef(root, { type: 'task', ref: { ...root.ref } })).toBe(true);
    expect(
      sameTaskNodeRef(root, {
        type: 'task',
        ref: { ...root.ref, revision: 'changed' },
      }),
    ).toBe(false);
    expect(sameTaskNodeRef(root, parent)).toBe(false);
    expect(
      sameTaskNodeRef(parent, {
        type: 'subtask',
        ref: { ...parent.ref, parent: { type: 'task', ref: { ...root.ref } } },
      }),
    ).toBe(true);
    expect(
      sameTaskNodeRef(parent, {
        type: 'subtask',
        ref: { ...parent.ref, originalBlock: '  - [ ] changed' },
      }),
    ).toBe(false);
  });
});
