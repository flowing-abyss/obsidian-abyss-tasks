import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { TaskCreatePreparation } from '../../src/tasks/application/TaskCreatePreparationApi';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';
import { expectDefined, useRealMoment } from '../helpers';
import { taskCreatePreparationHarness } from '../support/taskCreatePreparationHarness';
import { taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

useRealMoment();
const explicit = {
  type: 'explicit' as const,
  destination: { filePath: 'tasks.md', insertion: { type: 'append' as const } },
};
const configured = { type: 'configured-default' as const };
function ready(p: TaskCreatePreparation): Extract<TaskCreatePreparation, { type: 'ready' }> {
  expect(p).toMatchObject({ type: 'ready' });
  if (p.type !== 'ready') throw new Error('Expected ready candidate');
  return p;
}
const behavior = () => ({
  taskPrefix: '#task #inbox',
  applyTaskPrefixToSubtasks: true,
  inbox: { mode: 'tag' as const, tag: '#inbox', removeTagOnAssign: true },
  taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
  recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
});

describe('complete creation metadata', () => {
  it('previews native child prefixes, lifecycle, status, dates, timing and frozen comments', async () => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n', { behavior });
    const done = expectDefined(h.catalog.defaultForType('done'));
    const p = ready(
      await h.service.prepareCreateTree({
        destination: explicit,
        tree: {
          markdownTitle: 'Root',
          comments: [{ text: 'Root comment' }],
          children: [
            {
              markdownTitle: 'Child',
              initial: {
                status: done,
                due: { type: 'set', value: localDate('2026-11-10') },
                time: { type: 'set', value: localTime('10:15') },
                duration: { type: 'set', value: durationMinutes(45) },
                tags: { add: ['#work'] },
              },
              comments: [{ text: '  Child\r\ncomment  ' }],
            },
          ],
        },
      }),
    );
    const child = expectDefined(p.after.subtasks[0]);
    expect(child.status).toBe('done');
    expect(child.planning).toMatchObject({
      created: '2026-11-07',
      completion: '2026-11-07',
      due: '2026-11-10',
      time: '10:15',
      duration: 45,
    });
    expect(p.after.tags).toContain('#task');
    expect(child.tags).toEqual(['#work']);
    expect(child.tags).not.toContain('#inbox');
    expect(child.comments[0]?.text).toBe('  Child\ncomment  ');
    expect(child.comments[0]?.timestamp).toBeDefined();
    const preview = p.after.source.originalBlock;
    expect(await p.commit()).toMatchObject({ result: { type: 'ok' } });
    expect(h.index.list()[1]?.source.originalBlock).toBe(preview);
    expect(h.index.list()).toHaveLength(2);
  });

  it.each([
    'empty-title',
    'empty-metadata-title',
    'invalid-date',
    'newline',
    'child-newline',
    'empty-tag',
    'empty-due',
  ])('rejects %s without side effects', async (kind) => {
    const h = await taskCreatePreparationHarness();
    const tree = {
      markdownTitle:
        (
          {
            'empty-title': '',
            'empty-metadata-title': '📅 2026-11-10',
            newline: 'Root\n- [ ] injected',
          } as Record<string, string>
        )[kind] ?? 'Root',
      ...(kind === 'invalid-date'
        ? {
            initial: {
              due: { type: 'set' as const, value: '2026-02-30' as ReturnType<typeof localDate> },
            },
          }
        : {}),
      ...(kind === 'empty-due'
        ? { initial: { due: { type: 'set' as const, value: '' as ReturnType<typeof localDate> } } }
        : {}),
      ...(kind === 'empty-tag' ? { initial: { tags: { add: [''] } } } : {}),
      ...(kind === 'child-newline' ? { children: [{ markdownTitle: 'Bad\n- [ ] injected' }] } : {}),
    };
    const p = await h.service.prepareCreateTree({ destination: configured, tree });
    expect(p.type).toBe('invalid');
    expect(h.app.vault.getAbstractFileByPath('draft')).toBeNull();
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('rejects root deletion and stale draft refs while preserving the earlier candidate', async () => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n');
    const p = ready(
      await h.service.prepareCreateTree({
        destination: explicit,
        tree: {
          markdownTitle: 'Root',
          children: [{ markdownTitle: 'Same' }, { markdownTitle: 'Same' }],
        },
      }),
    );
    expect(p.append({ type: 'delete', ref: p.after.ref }).type).toBe('invalid');
    const q = ready(
      p.append({ type: 'add-subtask', parent: { type: 'task', ref: p.after.ref }, text: 'Same' }),
    );
    const before = q.after;
    const r = ready(
      q.append({ type: 'delete-subtask', subtask: expectDefined(before.subtasks[0]).ref }),
    );
    expect(r.continuations).toContainEqual({
      before: { type: 'subtask', ref: expectDefined(before.subtasks[2]).ref },
      after: { type: 'subtask', ref: expectDefined(r.after.subtasks[1]).ref },
    });
    Object.assign(r.continuations[0] ?? {}, { after: undefined });
    expect(r.continuations[0]?.after).toBeDefined();
    expect(
      r.append({ type: 'add-subtask', parent: { type: 'task', ref: p.after.ref }, text: 'Stale' })
        .type,
    ).toBe('invalid');
    expect(p.after.subtasks).toHaveLength(2);
  });

  it('does not accept draft references as ordinary persisted mutation authority', async () => {
    const h = await taskEditPreparationHarness('- [ ] Same\n');
    const p = ready(
      await h.service.prepareCreateTree({ destination: explicit, tree: { markdownTitle: 'Same' } }),
    );
    const result = await h.service.execute({
      type: 'patch',
      target: { type: 'task', ref: p.after.ref },
      patch: { markdownTitle: { type: 'set', value: 'Wrong' } },
    });
    expect(result.type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Same\n');
  });
});

describe('creation destination races and effects', () => {
  it.each(['bytes', 'replacement', 'scope', 'semantics', 'catalog'])(
    'rejects %s changed while queued in the writer',
    async (kind) => {
      const h = await taskEditPreparationHarness('- [ ] Existing\n');
      const p = ready(
        await h.service.prepareCreateTree({
          destination: explicit,
          tree: { markdownTitle: 'Planned' },
        }),
      );
      h.writes.mockImplementationOnce(async (file, callback) => {
        if (kind === 'bytes') await h.app.vault.modify(file, '- [ ] External\n');
        if (kind === 'replacement') {
          await h.app.vault.rename(file, 'old.md');
          await h.app.vault.create('tasks.md', '- [ ] Replacement\n');
        }
        if (kind === 'scope') await h.index.refreshSourceExclusion(() => true);
        if (kind === 'semantics') h.index.updateIntegrationSemantics('changed');
        if (kind === 'catalog') h.catalog.replace([]);
        return h.process(file, callback);
      });
      expect(await p.commit()).toMatchObject({
        result: { type: 'invalid' },
        destinationEffects: 'unchanged',
      });
      expect(await h.read()).not.toContain('Planned');
    },
  );

  it.each(['before', 'queued'])('rejects changed settings %s provisioning', async (phase) => {
    const settings = behavior();
    const h = await taskCreatePreparationHarness({ behavior: () => settings });
    const p = ready(
      await h.service.prepareCreateTree({
        destination: configured,
        tree: { markdownTitle: 'Planned' },
      }),
    );
    if (phase === 'before') settings.taskPrefix = '#changed';
    else
      h.writes.mockImplementationOnce(async (file, callback) => {
        settings.taskPrefix = '#changed';
        return h.process(file, callback);
      });
    expect(await p.commit()).toMatchObject({
      result: { type: 'invalid' },
      destinationEffects: phase === 'before' ? 'unchanged' : 'committed',
    });
  });

  it('rejects a changed template before creating folders', async () => {
    const h = await taskCreatePreparationHarness();
    const p = ready(
      await h.service.prepareCreateTree({
        destination: configured,
        tree: { markdownTitle: 'Planned' },
      }),
    );
    const template = h.app.vault.getAbstractFileByPath('template.md');
    if (!(template instanceof TFile)) throw new Error('Missing template');
    await h.app.vault.modify(template, 'Changed');
    expect(await p.commit()).toMatchObject({
      result: { type: 'invalid' },
      destinationEffects: 'unchanged',
    });
    expect(h.app.vault.getAbstractFileByPath('draft')).toBeNull();
  });

  it('uses existing configured notes without executing or requiring their template', async () => {
    const h = await taskCreatePreparationHarness({
      files: { 'template.md': '<% throw new Error() %>' },
    });
    h.configuration.taskFilePath = 'tasks.md';
    const p = ready(
      await h.service.prepareCreateTree({
        destination: configured,
        tree: { markdownTitle: 'Planned' },
      }),
    );
    expect(await p.commit()).toMatchObject({
      result: { type: 'ok' },
      destinationEffects: 'unchanged',
    });
  });

  it('provisions an explicitly authorized missing note', async () => {
    const h = await taskCreatePreparationHarness();
    const p = ready(
      await h.service.prepareCreateTree({
        destination: {
          type: 'explicit',
          destination: { filePath: 'explicit.md', insertion: { type: 'append' } },
          provision: 'if-missing',
        },
        tree: { markdownTitle: 'Planned' },
      }),
    );
    expect(await p.commit()).toMatchObject({
      result: { type: 'ok' },
      destinationEffects: 'committed',
    });
  });

  it.each([false, true])(
    'retains unknown aggregate provisioning after rejected create (written=%s)',
    async (written) => {
      const h = await taskCreatePreparationHarness();
      const p = ready(
        await h.service.prepareCreateTree({
          destination: configured,
          tree: { markdownTitle: 'Planned' },
        }),
      );
      const create = h.app.vault.create.bind(h.app.vault);
      const writes = vi
        .spyOn(h.app.vault, 'create')
        .mockImplementationOnce(async (path, content) => {
          if (written) await create(path, content);
          throw new Error('Denied');
        });
      const first = await p.commit();
      expect(first).toMatchObject({ result: { type: 'invalid' }, destinationEffects: 'unknown' });
      expect(await p.commit()).toEqual(first);
      expect(h.app.vault.getAbstractFileByPath('draft')).not.toBeNull();
      expect(h.app.vault.getAbstractFileByPath('draft/new.md') !== null).toBe(written);
      expect(writes).toHaveBeenCalledTimes(1);
    },
  );

  it('reports unknown provisioning after a folder write rejects', async () => {
    const h = await taskCreatePreparationHarness();
    const p = ready(
      await h.service.prepareCreateTree({
        destination: configured,
        tree: { markdownTitle: 'Planned' },
      }),
    );
    const createFolder = h.app.vault.createFolder.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'createFolder').mockImplementationOnce(async (path) => {
      await createFolder(path);
      throw new Error('Lost response');
    });
    expect(await p.commit()).toMatchObject({
      result: { type: 'invalid' },
      destinationEffects: 'unknown',
    });
    expect(h.app.vault.getAbstractFileByPath('draft')).not.toBeNull();
  });

  it.each(['reject', 'write-reject', 'lost-readback'])(
    'retains one failed insertion attempt for %s',
    async (kind) => {
      const h = await taskEditPreparationHarness('- [ ] Existing\n');
      const p = ready(
        await h.service.prepareCreateTree({
          destination: explicit,
          tree: { markdownTitle: 'Planned' },
        }),
      );
      h.writes.mockImplementationOnce(async (file, callback) => {
        if (kind !== 'reject') await h.process(file, callback);
        if (kind === 'lost-readback')
          vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('Unavailable'));
        throw new Error('Lost response');
      });
      const first = await p.commit();
      expect(first).toMatchObject({
        result: { type: 'io-error', contentState: kind === 'reject' ? 'unchanged' : 'unknown' },
        destinationEffects: 'unchanged',
      });
      expect(await p.commit()).toEqual(first);
      expect(h.writes).toHaveBeenCalledTimes(1);
    },
  );
});

it('rejects template changes inside the queued insertion while retaining provisioning effects', async () => {
  const h = await taskCreatePreparationHarness();
  const p = ready(
    await h.service.prepareCreateTree({
      destination: configured,
      tree: { markdownTitle: 'Planned' },
    }),
  );
  h.writes.mockImplementationOnce(async (file, callback) => {
    const template = h.app.vault.getAbstractFileByPath('template.md');
    if (!(template instanceof TFile)) throw new Error('Missing template');
    await h.app.vault.modify(template, 'Changed template');
    return h.process(file, callback);
  });
  expect(await p.commit()).toMatchObject({
    result: { type: 'invalid' },
    destinationEffects: 'committed',
  });
});

it('rechecks configuration after each created folder', async () => {
  const h = await taskCreatePreparationHarness();
  h.configuration.taskFilePath = 'first/second/note.md';
  const p = ready(
    await h.service.prepareCreateTree({
      destination: configured,
      tree: { markdownTitle: 'Planned' },
    }),
  );
  const createFolder = h.app.vault.createFolder.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'createFolder').mockImplementationOnce(async (path) => {
    const folder = await createFolder(path);
    h.configuration.taskFilePath = 'redirect.md';
    return folder;
  });
  expect(await p.commit()).toMatchObject({
    result: { type: 'invalid' },
    destinationEffects: 'committed',
  });
  expect(h.app.vault.getAbstractFileByPath('first')).not.toBeNull();
  expect(h.app.vault.getAbstractFileByPath('first/second')).toBeNull();
  expect(h.app.vault.getAbstractFileByPath('redirect.md')).toBeNull();
});

it('keeps failed note creation uncertain when the native create writes then rejects', async () => {
  const h = await taskCreatePreparationHarness();
  h.configuration.taskFilePath = 'new.md';
  const p = ready(
    await h.service.prepareCreateTree({
      destination: configured,
      tree: { markdownTitle: 'Planned' },
    }),
  );
  const create = h.app.vault.create.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'create').mockImplementationOnce(async (path, text, options) => {
    await create(path, text, options);
    throw new Error('Lost response');
  });
  expect(await p.commit()).toMatchObject({
    result: { type: 'invalid' },
    destinationEffects: 'unknown',
  });
  expect(h.app.vault.getAbstractFileByPath('new.md')).not.toBeNull();
  expect(h.writes).not.toHaveBeenCalled();
});

it('keeps the first prepared core-template time when commit happens later', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(2026, 10, 7, 1, 2));
    const h = await taskCreatePreparationHarness();
    const p = ready(
      await h.service.prepareCreateTree({
        destination: configured,
        tree: { markdownTitle: 'Planned' },
      }),
    );
    vi.setSystemTime(new Date(2026, 10, 7, 5, 6));
    expect(await p.commit()).toMatchObject({ result: { type: 'ok' } });
    const file = h.app.vault.getAbstractFileByPath('draft/new.md');
    if (!(file instanceof TFile)) throw new Error('Missing new note');
    expect(await h.app.vault.read(file)).toContain('# new\n2026-11-07 01:02\n');
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the captured project checker when the supplied destination object is mutated', async () => {
  const h = await taskEditPreparationHarness('- [ ] Existing\n');
  const destination = {
    filePath: 'tasks.md',
    insertion: { type: 'append' as const },
    check: (): 'stale' | undefined => 'stale',
    checkCopy: () => true,
  };
  const p = ready(
    await h.service.prepareCreateTree({
      destination: { type: 'project', destination },
      tree: { markdownTitle: 'Planned' },
    }),
  );
  destination.check = () => undefined;
  expect(await p.commit()).toMatchObject({
    result: { type: 'invalid' },
    destinationEffects: 'unchanged',
  });
  expect(h.writes).not.toHaveBeenCalled();
});

it('rejects a catalog changed while the read-only destination plan is being captured', async () => {
  const h = await taskCreatePreparationHarness();
  const read = h.app.vault.read.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
    h.catalog.replace([]);
    return read(file);
  });
  expect(
    await h.service.prepareCreateTree({
      destination: configured,
      tree: { markdownTitle: 'Planned' },
    }),
  ).toMatchObject({ type: 'invalid' });
  expect(h.app.vault.getAbstractFileByPath('draft')).toBeNull();
});

it.each(['append', 'prepend', 'section'] as const)(
  'inserts the exact reviewed tree into a CRLF destination using %s policy',
  async (type) => {
    const h = await taskEditPreparationHarness('# Tasks\r\n- [ ] Existing\r\n');
    const insertion =
      type === 'section' ? { type, heading: 'Tasks', position: 'top' as const } : { type };
    const p = ready(
      await h.service.prepareCreateTree({
        destination: {
          type: 'project',
          destination: {
            filePath: 'tasks.md',
            insertion,
            check: () => undefined,
            checkCopy: () => true,
          },
        },
        tree: {
          markdownTitle: 'Planned',
          comments: [{ text: 'Comment' }],
          children: [{ markdownTitle: 'Child' }],
        },
      }),
    );
    const result = await p.commit();
    expect(result).toMatchObject({ result: { type: 'ok' }, destinationEffects: 'unchanged' });
    if (result.result.type !== 'ok' || result.result.outcome.type !== 'task')
      throw new Error('Expected task receipt');
    expect(result.result.outcome.task.source.originalBlock).toBe(p.after.source.originalBlock);
  },
);

it.each([
  ['empty patch', false],
  ['same title', false],
  ['empty patch', true],
  ['same title', true],
] as const)(
  'keeps draft authority after %s with duplicate children = %s',
  async (operation, children) => {
    const source = children ? '- [ ] Same\n\t- [ ] Twin\n\t- [ ] Twin\n' : '- [ ] Same\n';
    const h = await taskEditPreparationHarness(source, {
      behavior: () => ({
        ...behavior(),
        taskPrefix: '',
        taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
      }),
    });
    let p = ready(
      await h.service.prepareCreateTree({ destination: explicit, tree: { markdownTitle: 'Same' } }),
    );
    if (children) {
      for (let index = 0; index < 2; index++)
        p = ready(
          p.append({
            type: 'add-subtask',
            parent: { type: 'task', ref: p.after.ref },
            text: 'Twin',
          }),
        );
    }
    const before = p.after;
    expect(before.source.originalBlock).toBe(h.root.source.originalBlock);
    const unchanged = ready(
      p.append({
        type: 'patch',
        target: { type: 'task', ref: before.ref },
        patch: operation === 'empty patch' ? {} : { markdownTitle: { type: 'set', value: 'Same' } },
      }),
    );
    const result = await h.service.execute({
      type: 'patch',
      target: { type: 'task', ref: unchanged.after.ref },
      patch: { markdownTitle: { type: 'set', value: 'Wrong persisted target' } },
    });
    expect(result.type).not.toBe('ok');
    expect(unchanged.after.ref).toEqual(before.ref);
    expect(unchanged.continuations).toContainEqual({
      before: { type: 'task', ref: before.ref },
      after: { type: 'task', ref: before.ref },
    });
    expect(await h.read()).toBe(source);
    if (children) {
      for (const child of before.subtasks)
        expect(unchanged.continuations).toContainEqual({
          before: { type: 'subtask', ref: child.ref },
          after: { type: 'subtask', ref: child.ref },
        });
      const removed = ready(
        unchanged.append({
          type: 'delete-subtask',
          subtask: expectDefined(unchanged.after.subtasks[0]).ref,
        }),
      );
      expect(removed.continuations).toContainEqual({
        before: { type: 'subtask', ref: expectDefined(before.subtasks[1]).ref },
        after: { type: 'subtask', ref: expectDefined(removed.after.subtasks[0]).ref },
      });
    }
  },
);

it.each(['initial fields', 'authored metadata'] as const)(
  'constructs a done child with delete-on-completion from %s without completing it',
  async (metadata) => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n', { behavior });
    const done = expectDefined(h.catalog.defaultForType('done'));
    const p = ready(
      await h.service.prepareCreateTree({
        destination: explicit,
        tree: {
          markdownTitle: 'Parent',
          children: [
            {
              markdownTitle: metadata === 'authored metadata' ? 'Child 🏁 delete' : 'Child',
              initial: {
                status: done,
                ...(metadata === 'initial fields'
                  ? { onCompletion: { type: 'set' as const, value: 'delete' as const } }
                  : {}),
              },
              comments: [{ text: 'Retain child comment' }],
              children: [
                { markdownTitle: 'Grandchild', comments: [{ text: 'Retain nested comment' }] },
              ],
            },
          ],
        },
      }),
    );
    expect(h.writes).not.toHaveBeenCalled();
    const child = expectDefined(p.after.subtasks[0]);
    expect(child.status).toBe('done');
    expect(child.onCompletion).toBe('delete');
    expect(child.planning).toMatchObject({ created: '2026-11-07', completion: '2026-11-07' });
    expect(child.comments[0]?.text).toBe('Retain child comment');
    expect(child.subtasks[0]?.title).toBe('Grandchild');
    expect(child.subtasks[0]?.comments[0]?.text).toBe('Retain nested comment');
    const result = await p.commit();
    expect(result).toMatchObject({ result: { type: 'ok' }, destinationEffects: 'unchanged' });
    if (result.result.type !== 'ok' || result.result.outcome.type !== 'task')
      throw new Error('Expected created task');
    expect(result.result.outcome.task.source.originalBlock).toBe(p.after.source.originalBlock);
    expect(h.index.list()).toHaveLength(2);
  },
);
