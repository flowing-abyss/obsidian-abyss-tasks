import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import type { TaskRepository } from '../../src/tasks/application/TaskRepository';
import type { TaskCommand } from '../../src/tasks/domain/commands';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskRef } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { applyTaskCommand } from '../../src/tasks/infrastructure/markdown/applyTaskCommand';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import {
  canonicalStatusCatalog,
  configuredTaskApplication,
  createAppWithFiles,
  seedTaskCache,
} from '../helpers';

const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
const ref: TaskRef = { filePath: 'Tasks.md', line: 0, revision: 'dependency-test' };

type DependencyTaskCommand = Extract<
  TaskCommand,
  { readonly type: 'set-task-id' | 'set-task-dependency' }
>;

function runtimeDependencyCommand(command: Record<string, unknown>): DependencyTaskCommand {
  return command as DependencyTaskCommand;
}

describe('single-task dependency carrier commands', () => {
  it('sets and removes the canonical task ID without changing any other source bytes', () => {
    const source =
      '>\t- [ ] Ship 🧭 opaque #work 🔁 every week ➕ 2026-08-01 📅 2026-08-09 ⛔ prep-1 ^ship\r\n';
    const set = applyTaskCommand(codec, source, { type: 'set-task-id', ref, id: 'ship_2' });

    expect(set).toEqual({
      type: 'changed',
      content:
        '>\t- [ ] Ship 🧭 opaque #work 🔁 every week ➕ 2026-08-01 📅 2026-08-09 🆔 ship_2 ⛔ prep-1 ^ship\r\n',
    });
    expect(
      applyTaskCommand(codec, set.type === 'changed' ? set.content : source, {
        type: 'set-task-id',
        ref,
        id: null,
      }),
    ).toEqual({ type: 'changed', content: source });
  });

  it('normalizes duplicate valid ID carriers to exactly one requested carrier', () => {
    const source = '- [ ] Ship 🆔 old 🧭 opaque 🆔️ stale ⛔ prep ^ship';

    expect(applyTaskCommand(codec, source, { type: 'set-task-id', ref, id: 'stable' })).toEqual({
      type: 'changed',
      content: '- [ ] Ship 🆔 stable 🧭 opaque ⛔ prep ^ship',
    });
  });

  it('adds one dependency and consolidates duplicate IDs and carriers in source order', () => {
    const source = '- [ ] Ship ⛔ prep, prep 🧭 opaque ⛔ review,prep 🆔 ship ^ship';

    expect(
      applyTaskCommand(codec, source, {
        type: 'set-task-dependency',
        ref,
        dependencyId: 'publish',
        enabled: true,
      }),
    ).toEqual({
      type: 'changed',
      content: '- [ ] Ship ⛔ prep, review, publish 🧭 opaque 🆔 ship ^ship',
    });
  });

  it('removes exactly one dependency and removes an empty carrier', () => {
    const source = '- [ ] Ship 🆔 ship ⛔ prep, review, prep ^ship';
    const withoutPrep = applyTaskCommand(codec, source, {
      type: 'set-task-dependency',
      ref,
      dependencyId: 'prep',
      enabled: false,
    });

    expect(withoutPrep).toEqual({
      type: 'changed',
      content: '- [ ] Ship 🆔 ship ⛔ review ^ship',
    });
    expect(
      applyTaskCommand(codec, withoutPrep.type === 'changed' ? withoutPrep.content : source, {
        type: 'set-task-dependency',
        ref,
        dependencyId: 'review',
        enabled: false,
      }),
    ).toEqual({ type: 'changed', content: '- [ ] Ship 🆔 ship ^ship' });
  });

  it('returns exact no-ops when the requested ID and edge state already hold', () => {
    const source = '- [ ] Ship 🆔 ship ⛔ prep, review ^ship\r\n';

    expect(applyTaskCommand(codec, source, { type: 'set-task-id', ref, id: 'ship' })).toEqual({
      type: 'unchanged',
      content: source,
    });
    expect(
      applyTaskCommand(codec, source, {
        type: 'set-task-dependency',
        ref,
        dependencyId: 'prep',
        enabled: true,
      }),
    ).toEqual({ type: 'unchanged', content: source });
    expect(
      applyTaskCommand(codec, source, {
        type: 'set-task-dependency',
        ref,
        dependencyId: 'absent',
        enabled: false,
      }),
    ).toEqual({ type: 'unchanged', content: source });
  });

  it.each([
    ['task ID', { type: 'set-task-id', ref, id: 'bad.id' }, 'task-id'],
    [
      'dependency ID',
      { type: 'set-task-dependency', ref, dependencyId: 'bad/id', enabled: true },
      'dependency',
    ],
  ])('rejects an invalid %s before repository access', async (_name, command, field) => {
    const edit = vi.fn<TaskRepository['edit']>();
    const task = {
      ref,
      title: 'Ship',
      markdownTitle: 'Ship',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      planning: {},
      tags: [],
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      subtasks: [],
      comments: [],
      dependency: { dependsOn: [] },
      source: {
        filePath: ref.filePath,
        line: ref.line,
        originalMarkdown: '- [ ] Ship',
        originalBlock: '- [ ] Ship',
      },
      presentation: { linkCount: 0 },
    };
    const application = new TaskApplicationService(
      {
        list: () => [task],
        forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
        resolve: () => ({ type: 'exact', task, basis: { observed: task } }),
        subscribe: () => () => undefined,
      },
      { edit, create: vi.fn(), move: vi.fn(), completeRecurrence: vi.fn() },
      new StatusCatalog([{ id: 'todo', symbol: ' ', type: 'todo', defaultForType: true }]),
      { today: () => localDate('2026-08-27') },
    );

    await expect(application.execute(runtimeDependencyCommand(command))).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field }],
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it('writes one root through TaskApplicationApi while preserving children and comments byte-for-byte', async () => {
    const source =
      '> - [ ] Root 🧭 opaque #work 🔁 every week ➕ 2026-08-01 📅 2026-08-09 ^root\r\n' +
      '>   - > Description keeps 🆔 prose and ⛔ prose\r\n' +
      '>   - 2026-08-27T08:30:00+07:00: Comment keeps spacing\r\n' +
      '>   - [ ] Child 🆔 child-id ⛔ child-prep\r\n';
    const app = await createAppWithFiles({ 'Tasks.md': source });
    seedTaskCache(app, 'Tasks.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: 0, line: 3 },
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const root = stack.tasks.queries.list().find((task) => task.source.line === 0)!;

    await expect(
      stack.tasks.execute({ type: 'set-task-id', ref: root.ref, id: 'root-id' }),
    ).resolves.toMatchObject({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: { dependency: { id: 'root-id', dependsOn: [] } } },
    });
    expect(await app.vault.cachedRead(app.vault.getMarkdownFiles()[0]!)).toBe(
      '> - [ ] Root 🧭 opaque #work 🔁 every week ➕ 2026-08-01 📅 2026-08-09 🆔 root-id ^root\r\n' +
        '>   - > Description keeps 🆔 prose and ⛔ prose\r\n' +
        '>   - 2026-08-27T08:30:00+07:00: Comment keeps spacing\r\n' +
        '>   - [ ] Child 🆔 child-id ⛔ child-prep\r\n',
    );
    stack.index.destroy();
  });
});
