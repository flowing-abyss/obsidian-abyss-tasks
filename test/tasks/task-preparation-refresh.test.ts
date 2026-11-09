import { describe, expect, it, vi } from 'vitest';
import { createProjectIntegrationReads } from '../../src/projects/projectIntegration';
import { createProjectTaskCommands } from '../../src/projects/projectTaskCommands';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskCreatePreparation } from '../../src/tasks/application/TaskCreatePreparationApi';
import { clockFrom } from '../../src/tasks/domain/clock';
import { localDate } from '../../src/tasks/domain/validation';
import { expectDefined, useRealMoment } from '../helpers';
import { taskCreatePreparationHarness } from '../support/taskCreatePreparationHarness';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

useRealMoment();
function creation(value: TaskCreatePreparation) {
  expect(value.type).toBe('ready');
  if (value.type !== 'ready') throw new Error('Creation unavailable');
  return value;
}
const destination = {
  type: 'explicit' as const,
  destination: { filePath: 'tasks.md', insertion: { type: 'append' as const } },
};

describe('sealed preparation refresh', () => {
  it.each(['refreshed selection', 'later sibling write'] as const)(
    'retains selected commit proof across %s',
    async (mode) => {
      const h = await taskEditPreparationHarness('- [ ] One\n- [ ] Two\n- [ ] Three\n- [ ] Four\n');
      h.index.integrationReads().activateOccurrences();
      const full = ready(
        await h.service.prepare(h.root, [
          {
            type: 'patch',
            target: { type: 'task', ref: h.root.ref },
            patch: {
              markdownTitle: { type: 'set', value: 'Pending' },
              scheduled: { type: 'set', value: localDate('2026-08-02') },
            },
          },
        ]),
      );
      const partition = expectDefined(
        full.partitionFields([
          { target: { type: 'task', ref: expectDefined(full.after).ref }, fields: ['scheduled'] },
        ]),
      );
      const selected = ready(partition.selected);
      const writer =
        mode === 'refreshed selection' ? ready(await selected.refresh(h.root)) : selected;
      const outcome = await writer.commit();
      expect(outcome.type).toBe('ok');
      const committed = expectDefined(h.index.list()[0]);
      if (mode === 'later sibling write') {
        for (let index = 1; index < 4; index++) {
          const sibling = expectDefined(h.index.list()[index]);
          expect(
            (
              await h.service.execute({
                type: 'set-description',
                target: { type: 'task', ref: sibling.ref },
                text: 'Unrelated sibling',
              })
            ).type,
          ).toBe('ok');
          expect(h.index.resolve(committed.ref)).toMatchObject({
            type: 'exact',
            task: { ref: committed.ref },
          });
        }
      }
      const remainder = ready(await partition.rebase(expectDefined(h.index.list()[0])));
      expect((await remainder.commit()).type).toBe('ok');
      expect(h.index.list()[0]?.title).toBe('Pending');
      if (mode === 'later sibling write') expect(await h.read()).toContain('Unrelated sibling');
    },
  );
  it('preserves a pending deletion identity after merging into a duplicate root above it', async () => {
    const h = await taskEditPreparationHarness('- [ ] Same\n- [ ] Same\n');
    h.index.integrationReads().activateOccurrences();
    const source = expectDefined(h.index.list()[1]);
    const remove = ready(await h.service.prepare(source, [{ type: 'delete', ref: source.ref }]));
    const merge = ready(
      await h.service.prepare(h.root, [
        { type: 'add-subtask', parent: { type: 'task', ref: h.root.ref }, text: 'Merged' },
      ]),
    );
    expect((await merge.commit()).type).toBe('ok');
    const current = expectDefined(h.index.list()[1]);
    expect(current.ref.line).toBeGreaterThan(source.ref.line);
    const refreshed = ready(await remove.refresh(current));
    expect(refreshed.before).toEqual(source);
    expect(refreshed.after).toBeNull();
    expect((await refreshed.commit()).type).toBe('ok');
    expect(await h.read()).toBe('- [ ] Same\n\t- [ ] Merged ➕ 2026-11-07\n');
  });

  it('transplants exact sealed comments and child correspondence while preserving sibling changes', async () => {
    const h = await taskEditPreparationHarness(
      '- [ ] Above\n- [ ] Root\n\t- [ ] Same\n\t- [ ] Same\n',
    );
    h.index.integrationReads().activateOccurrences();
    const root = expectDefined(h.index.list()[1]);
    const p = ready(
      await h.service.prepare(root, [
        {
          type: 'add-comment',
          parent: { type: 'subtask', ref: expectDefined(root.subtasks[1]).ref },
          text: 'Frozen',
        },
      ]),
    );
    const after = expectDefined(p.after);
    expect(
      (
        await h.service.execute({
          type: 'set-description',
          target: { type: 'task', ref: h.root.ref },
          text: 'External sibling',
        })
      ).type,
    ).toBe('ok');
    const refreshed = ready(await p.refresh(expectDefined(h.index.list()[1])));
    expect(refreshed.before).toEqual(root);
    expect(refreshed.after?.source.originalBlock).toBe(after.source.originalBlock);
    expect(refreshed.continuations).toContainEqual({
      before: { type: 'subtask', ref: expectDefined(after.subtasks[1]).ref },
      after: { type: 'subtask', ref: expectDefined(refreshed.after?.subtasks[1]).ref },
    });
    expect((await refreshed.commit()).type).toBe('ok');
    expect(await h.read()).toContain('External sibling');
    expect(h.index.list()[1]?.source.originalBlock).toBe(after.source.originalBlock);
    expect(p.after).toEqual(after);
  });

  it('inserts two reviewed creations in an existing note without restamping', async () => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n');
    const first = creation(
      await h.service.prepareCreateTree({ destination, tree: { markdownTitle: 'First' } }),
    );
    const second = creation(
      await h.service.prepareCreateTree({
        destination,
        tree: {
          markdownTitle: 'Second',
          comments: [{ text: 'Frozen' }],
          children: [{ markdownTitle: 'Child' }],
        },
      }),
    );
    const reviewed = second.after;
    expect((await first.commit()).result.type).toBe('ok');
    const refreshed = creation(await second.refresh());
    expect(refreshed.after.source.originalBlock).toBe(reviewed.source.originalBlock);
    expect((await refreshed.commit()).result.type).toBe('ok');
    expect(h.index.list().map((root) => root.title)).toEqual(['Existing', 'First', 'Second']);
    expect(h.index.list()[2]?.source.originalBlock).toBe(reviewed.source.originalBlock);
  });

  it.each(['unchanged', 'unknown'] as const)(
    'refuses refresh across every version of an attempted family (%s)',
    async (effect) => {
      const h = await taskEditPreparationHarness('- [ ] Root\n');
      const original = ready(await h.service.prepare(h.root, []));
      const p = ready(
        original.append({
          type: 'add-comment',
          parent: { type: 'task', ref: h.root.ref },
          text: 'Pending',
        }),
      );
      h.writes.mockImplementationOnce(async (file, callback) => {
        if (effect === 'unknown') await h.process(file, callback);
        throw new Error('Failed');
      });
      expect(await p.commit()).toMatchObject({ type: 'io-error', contentState: effect });
      expect((await original.refresh(expectDefined(h.index.list()[0]))).type).toBe('invalid');
      expect((await p.refresh(expectDefined(h.index.list()[0]))).type).toBe('invalid');
      expect(h.writes).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses target changes and forged current roots', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n- [ ] Other\n');
    const p = ready(await h.service.prepare(h.root, [{ type: 'delete', ref: h.root.ref }]));
    expect((await p.refresh(expectDefined(h.index.list()[1]))).type).toBe('invalid');
    expect(
      (
        await h.service.execute({
          type: 'add-subtask',
          parent: { type: 'task', ref: h.root.ref },
          text: 'Changed',
        })
      ).type,
    ).toBe('ok');
    expect((await p.refresh(expectDefined(h.index.list()[0]))).type).toBe('invalid');
  });

  it('requires fresh accepted readback after a committed result', async () => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n');
    const p = creation(
      await h.service.prepareCreateTree({ destination, tree: { markdownTitle: 'Pending' } }),
    );
    const first = creation(
      await h.service.prepareCreateTree({ destination, tree: { markdownTitle: 'First' } }),
    );
    expect((await first.commit()).result.type).toBe('ok');
    vi.spyOn(h.sources, 'get').mockReturnValue({ type: 'error', reason: 'incomplete' });
    expect((await p.refresh()).type).toBe('invalid');
  });
});

describe('sealed destination refresh', () => {
  it('refreshes a newly provisioned note only with a retained creation anchor and matching sealed basis', async () => {
    const h = await taskCreatePreparationHarness();
    const first = creation(
      await h.service.prepareCreateTree({
        destination: { type: 'configured-default' },
        tree: { markdownTitle: 'First' },
      }),
    );
    const second = creation(
      await h.service.prepareCreateTree({
        destination: { type: 'configured-default' },
        tree: { markdownTitle: 'Second', comments: [{ text: 'Frozen' }] },
      }),
    );
    expect(second.sharesDestinationBasis(first)).toBe(true);
    const result = await first.commit();
    expect(result.result.type).toBe('ok');
    expect((await second.refresh()).type).toBe('invalid');
    const anchor = expectDefined(h.index.list().find((root) => root.title === 'First'));
    const refreshed = creation(await second.refresh({ createdDestinationAnchor: anchor }));
    expect(refreshed.sharesDestinationBasis(first)).toBe(true);
    expect(refreshed.after.source.originalBlock).toBe(second.after.source.originalBlock);
    expect(await refreshed.commit()).toMatchObject({
      result: { type: 'ok' },
      destinationEffects: 'unchanged',
    });
    expect(
      h.index
        .list()
        .filter((root) => root.ref.filePath === 'draft/new.md')
        .map((root) => root.title),
    ).toEqual(['First', 'Second']);
  });

  it('keeps template and destination selection in the private basis predicate', async () => {
    const h = await taskCreatePreparationHarness();
    const input = {
      destination: { type: 'configured-default' as const },
      tree: { markdownTitle: 'Pending' },
    };
    const first = creation(await h.service.prepareCreateTree(input));
    const template = h.app.vault.getFileByPath('template.md');
    await h.app.vault.modify(expectDefined(template), '# Changed\n');
    const second = creation(await h.service.prepareCreateTree(input));
    expect(second.sharesDestinationBasis(first)).toBe(false);
    expect((await first.refresh()).type).toBe('invalid');
    expect(second.sharesDestinationBasis({ ...second })).toBe(false);
  });
});

it('refreshes the project owner guard after insertion and rejects changed project meaning', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS.projects);
  settings.membershipQuery = 'status=active';
  const h = await taskEditPreparationHarness('---\nstatus: active\n---\n- [ ] Existing\n');
  const reads = createProjectIntegrationReads(h.sources, () => settings);
  const commands = createProjectTaskCommands(reads, h.sources, h.service, () => settings);
  const summary = reads.summary('tasks.md');
  if (summary.type !== 'ok') throw new Error('Missing project');
  const capture = vi.spyOn(h.service, 'prepareProjectCreate');
  commands.prepareCreate(expectDefined(summary.value), 'Unused');
  const selected = expectDefined(capture.mock.calls[0])[0];
  const input = {
    destination: { type: 'project' as const, destination: selected },
    tree: { markdownTitle: 'Pending' },
  };
  const first = creation(await h.service.prepareCreateTree(input));
  const second = creation(await h.service.prepareCreateTree(input));
  expect((await first.commit()).result.type).toBe('ok');
  const refreshed = creation(await second.refresh());
  expect((await refreshed.commit()).result.type).toBe('ok');
  const third = creation(
    await h.service.prepareCreateTree({
      ...input,
      destination: { type: 'project', destination: expectDefined(selected.refreshPrepared?.()) },
    }),
  );
  settings.taskInsertionMode = settings.taskInsertionMode === 'append' ? 'prepend' : 'append';
  expect((await third.refresh()).type).toBe('invalid');
});

describe('refresh guard and correspondence boundaries', () => {
  it('keeps creation continuation endpoints on the immediately preceding preview', async () => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n');
    const p = creation(
      await h.service.prepareCreateTree({
        destination,
        tree: {
          markdownTitle: 'Root',
          children: [{ markdownTitle: 'Same' }, { markdownTitle: 'Same' }],
        },
      }),
    );
    const prior = p.after;
    const refreshed = creation(await p.refresh());
    expect(refreshed.continuations).toContainEqual({
      before: { type: 'subtask', ref: expectDefined(prior.subtasks[1]).ref },
      after: { type: 'subtask', ref: expectDefined(refreshed.after.subtasks[1]).ref },
    });
    expect(refreshed.continuations).toContainEqual({
      before: { type: 'task', ref: prior.ref },
      after: { type: 'task', ref: refreshed.after.ref },
    });
  });

  it('refreshes an original plan after two separate sibling shifts', async () => {
    const h = await taskEditPreparationHarness(
      '- [ ] Above\n- [ ] Same\n\t- [ ] Child\n- [ ] Same\n\t- [ ] Child\n',
    );
    h.index.integrationReads().activateOccurrences();
    const root = expectDefined(h.index.list()[2]);
    const p = ready(
      await h.service.prepare(root, [
        { type: 'add-comment', parent: { type: 'task', ref: root.ref }, text: 'Retained' },
      ]),
    );
    for (const text of ['First', 'Second']) {
      const above = expectDefined(h.index.list()[0]);
      expect(
        (
          await h.service.execute({
            type: 'add-subtask',
            parent: { type: 'task', ref: above.ref },
            text,
          })
        ).type,
      ).toBe('ok');
    }
    const refreshed = ready(await p.refresh(expectDefined(h.index.list()[2])));
    expect((await refreshed.commit()).type).toBe('ok');
    expect(h.index.list()[1]?.comments).toHaveLength(0);
    expect(h.index.list()[2]?.comments[0]?.text).toBe('Retained');
  });

  it('preserves the duplicate survivor and its child after deleting an earlier root', async () => {
    const h = await taskEditPreparationHarness(
      '- [ ] Same\n\t- [ ] Child\n- [ ] Same\n\t- [ ] Child\n',
    );
    h.index.integrationReads().activateOccurrences();
    const root = expectDefined(h.index.list()[1]);
    const p = ready(
      await h.service.prepare(root, [
        {
          type: 'add-comment',
          parent: { type: 'subtask', ref: expectDefined(root.subtasks[0]).ref },
          text: 'Only survivor',
        },
      ]),
    );
    expect((await h.service.execute({ type: 'delete', ref: h.root.ref })).type).toBe('ok');
    const refreshed = ready(await p.refresh(expectDefined(h.index.list()[0])));
    expect((await refreshed.commit()).type).toBe('ok');
    expect(h.index.list()).toHaveLength(1);
    expect(h.index.list()[0]?.subtasks[0]?.comments[0]?.text).toBe('Only survivor');
  });

  it.each(['edit', 'creation'] as const)(
    'rejects replaced native files for %s refresh',
    async (kind) => {
      const h = await taskEditPreparationHarness('- [ ] Root\n');
      const p =
        kind === 'edit'
          ? ready(await h.service.prepare(h.root, []))
          : creation(
              await h.service.prepareCreateTree({
                destination,
                tree: { markdownTitle: 'Pending' },
              }),
            );
      await h.app.vault.rename(h.file, 'old.md');
      const file = await h.app.vault.create('tasks.md', '- [ ] Root\n');
      await h.sources.reconcile('tasks.md', file, '- [ ] Root\n');
      const result =
        p.before === null
          ? await p.refresh()
          : await p.refresh(
              expectDefined(h.index.list().find((root) => root.ref.filePath === 'tasks.md')),
            );
      expect(result.type).toBe('invalid');
    },
  );

  it('rejects changed settings and a post-refresh writer race', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const h = await taskEditPreparationHarness('- [ ] Root\n', { behavior: () => settings });
    const p = ready(await h.service.prepare(h.root, [{ type: 'delete', ref: h.root.ref }]));
    settings.taskPrefix = '#new';
    expect((await p.refresh(h.root)).type).toBe('invalid');
    settings.taskPrefix = DEFAULT_SETTINGS.taskPrefix;
    const refreshed = ready(await p.refresh(h.root));
    h.writes.mockImplementationOnce(async (file, callback) => {
      await h.app.vault.modify(file, '- [ ] Root\nUnrelated later write\n');
      return h.process(file, callback);
    });
    expect((await refreshed.commit()).type).not.toBe('ok');
    expect(await h.read()).toContain('Unrelated later write');
  });

  it('rejects missing and stale created anchors and refresh after a failed creation attempt', async () => {
    const h = await taskCreatePreparationHarness();
    const input = {
      destination: { type: 'configured-default' as const },
      tree: { markdownTitle: 'Pending' },
    };
    const p = creation(await h.service.prepareCreateTree(input));
    const first = creation(await h.service.prepareCreateTree(input));
    expect((await first.commit()).result.type).toBe('ok');
    expect((await p.refresh({ createdDestinationAnchor: h.root })).type).toBe('invalid');
    const anchor = expectDefined(
      h.index.list().find((root) => root.ref.filePath === 'draft/new.md'),
    );
    expect((await h.service.execute({ type: 'delete', ref: anchor.ref })).type).toBe('ok');
    expect((await p.refresh({ createdDestinationAnchor: anchor })).type).toBe('invalid');
    expect((await p.commit()).result.type).not.toBe('ok');
    expect((await p.refresh()).type).toBe('invalid');
  });

  it('returns a typed unchanged failure when refresh cannot read the native file', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const p = ready(await h.service.prepare(h.root, []));
    vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('Unavailable'));
    expect(await p.refresh(h.root)).toMatchObject({
      type: 'invalid',
      result: { type: 'io-error', contentState: 'unchanged' },
    });
  });
});

it('keeps the captured clock through refresh and subsequent append', async () => {
  let now = Date.UTC(2026, 10, 7, 12);
  const h = await taskEditPreparationHarness('- [ ] Root\n', {
    clock: { read: () => clockFrom(now, 0).read() },
  });
  const p = creation(
    await h.service.prepareCreateTree({
      destination,
      tree: { markdownTitle: 'Pending', comments: [{ text: 'Before' }] },
    }),
  );
  const stamp = expectDefined(p.after.comments[0]).timestamp;
  now = Date.UTC(2026, 10, 8, 18);
  const refreshed = creation(await p.refresh());
  const appended = creation(
    refreshed.append({
      type: 'add-comment',
      parent: { type: 'task', ref: refreshed.after.ref },
      text: 'After',
    }),
  );
  expect(appended.after.comments.map((comment) => comment.timestamp)).toEqual([stamp, stamp]);
  expect(appended.after.planning.created).toBe('2026-11-07');
  expect((await appended.commit()).result.type).toBe('ok');
});

it('advances a generation-zero private anchor after each acknowledged sibling write', async () => {
  const h = await taskEditPreparationHarness('- [ ] Above\n- [ ] Unique\n');
  const root = expectDefined(h.index.list()[1]);
  expect(h.authority.evidence(root.ref.revision)?.generation).toBe('0');
  const original = ready(
    await h.service.prepare(root, [
      { type: 'add-comment', parent: { type: 'task', ref: root.ref }, text: 'Frozen' },
    ]),
  );
  let p = original;
  for (const text of ['First', 'Second']) {
    const above = expectDefined(h.index.list()[0]);
    expect(
      (
        await h.service.execute({
          type: 'add-subtask',
          parent: { type: 'task', ref: above.ref },
          text,
        })
      ).type,
    ).toBe('ok');
    p = ready(await p.refresh(expectDefined(h.index.list()[1])));
  }
  expect(p.before).toEqual(root);
  expect(p.after?.source.originalBlock).toBe(original.after?.source.originalBlock);
  expect((await original.refresh(expectDefined(h.index.list()[1]))).type).toBe('invalid');
  expect((await p.commit()).type).toBe('ok');
});

it('refuses an edited generation even if its root bytes are later restored', async () => {
  const h = await taskEditPreparationHarness('- [ ] Same\n- [ ] Same\n');
  const source = expectDefined(h.index.list()[1]);
  const p = ready(await h.service.prepare(source, [{ type: 'delete', ref: source.ref }]));
  for (const title of ['Changed', 'Same']) {
    const current = expectDefined(h.index.list()[1]);
    expect(
      (
        await h.service.execute({
          type: 'patch',
          target: { type: 'task', ref: current.ref },
          patch: { markdownTitle: { type: 'set', value: title } },
        })
      ).type,
    ).toBe('ok');
  }
  expect(h.index.list()[1]?.source.originalBlock).toBe(source.source.originalBlock);
  expect((await p.refresh(expectDefined(h.index.list()[1]))).type).toBe('invalid');
});

it('refuses every creation version after an unknown insertion attempt', async () => {
  const h = await taskEditPreparationHarness('- [ ] Existing\n');
  const p = creation(
    await h.service.prepareCreateTree({ destination, tree: { markdownTitle: 'Pending' } }),
  );
  const appended = creation(
    p.append({
      type: 'add-comment',
      parent: { type: 'task', ref: p.after.ref },
      text: 'Saved maybe',
    }),
  );
  h.writes.mockImplementationOnce(async (file, callback) => {
    await h.process(file, callback);
    throw new Error('Unknown');
  });
  expect(await appended.commit()).toMatchObject({
    result: { type: 'io-error', contentState: 'unknown' },
  });
  expect((await p.refresh()).type).toBe('invalid');
  expect((await appended.refresh()).type).toBe('invalid');
  expect(h.writes).toHaveBeenCalledTimes(1);
});

it('returns an accepted receipt for an unchanged refreshed edit and then seals its family', async () => {
  const h = await taskEditPreparationHarness('- [ ] Root\n');
  const original = ready(await h.service.prepare(h.root, []));
  const refreshed = ready(await original.refresh(h.root));
  const result = await refreshed.commit();
  expect(result).toMatchObject({
    type: 'ok',
    changed: false,
    outcome: { type: 'task', task: { ref: h.root.ref } },
  });
  expect((await original.refresh(h.root)).type).toBe('invalid');
});

it('refreshes both an existing sealed note plan and its repository basis', async () => {
  const h = await taskCreatePreparationHarness({
    files: { 'draft/new.md': '# Existing\n- [ ] Root\n' },
  });
  const input = {
    destination: { type: 'configured-default' as const },
    tree: { markdownTitle: 'Pending' },
  };
  const first = creation(await h.service.prepareCreateTree(input));
  const second = creation(await h.service.prepareCreateTree(input));
  expect((await first.commit()).result.type).toBe('ok');
  const refreshed = creation(await second.refresh());
  expect(await refreshed.commit()).toMatchObject({
    result: { type: 'ok' },
    destinationEffects: 'unchanged',
  });
  const file = expectDefined(h.app.vault.getFileByPath('draft/new.md'));
  expect(await h.app.vault.read(file)).toContain('# Existing\n');
  expect(h.index.list().filter((root) => root.title === 'Pending')).toHaveLength(2);
});

it('preserves an accepted external sibling edit outside the reviewed root', async () => {
  const h = await taskEditPreparationHarness('- [ ] Root\n- [ ] Sibling\n');
  const p = ready(
    await h.service.prepare(h.root, [
      { type: 'add-comment', parent: { type: 'task', ref: h.root.ref }, text: 'Frozen' },
    ]),
  );
  const external = '- [ ] Root\n- [ ] External sibling\n';
  await h.app.vault.modify(h.file, external);
  expect(await h.sources.reconcile('tasks.md', h.file, external)).toBe(true);
  const refreshed = ready(await p.refresh(expectDefined(h.index.list()[0])));
  expect((await refreshed.commit()).type).toBe('ok');
  expect(await h.read()).toContain('- [ ] External sibling\n');
});

it.each(['original', 'refreshed'] as const)(
  'detaches the private %s anchor from caller snapshots',
  async (stage) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const supplied = structuredClone(h.root);
    let p = ready(await h.service.prepare(stage === 'original' ? supplied : h.root, []));
    if (stage === 'refreshed') p = ready(await p.refresh(supplied));
    Object.assign(supplied.ref, { filePath: 'forged.md', line: 99 });
    expect((await p.refresh(h.root)).type).toBe('ready');
  },
);

it('keeps the native anchor when caller evidence mutates during refresh readback', async () => {
  const h = await taskEditPreparationHarness('- [ ] Root\n');
  const p = ready(await h.service.prepare(h.root, []));
  const supplied = structuredClone(h.root);
  const read = h.app.vault.read.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
    Object.assign(supplied.ref, { filePath: 'forged.md' });
    return read(file);
  });
  const refreshed = ready(await p.refresh(supplied));
  expect((await refreshed.refresh(h.root)).type).toBe('ready');
});

it.each(['shift', 'same-line'] as const)(
  'refuses speculative sibling refresh after unreadable rejected persistence (%s)',
  async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Same\n- [ ] Same\n');
    const invalidated: string[] = [];
    const integration = h.index.integrationReads();
    integration.activateOccurrences();
    const subscription = integration.subscribe((event) => {
      if (event.type === 'accepted')
        invalidated.push(...event.change.invalidated.map((address) => address.rootRevision));
    });
    const sibling = expectDefined(h.index.list()[1]);
    const pending = ready(await h.service.prepare(sibling, [{ type: 'delete', ref: sibling.ref }]));
    const first = ready(
      await h.service.prepare(h.root, [
        kind === 'shift'
          ? { type: 'add-comment', parent: { type: 'task', ref: h.root.ref }, text: 'Attempted' }
          : {
              type: 'patch',
              target: { type: 'task', ref: h.root.ref },
              patch: { markdownTitle: { type: 'set', value: 'Changed' } },
            },
      ]),
    );
    const read = h.app.vault.read.bind(h.app.vault);
    h.writes.mockImplementationOnce(async (file, transform) => {
      const candidate = transform(await read(file));
      await h.app.vault.modify(file, candidate);
      h.index.installCommittedContent('tasks.md', candidate);
      throw new Error('Rejected after observation');
    });
    const reads = vi
      .spyOn(h.app.vault, 'read')
      .mockRejectedValue(new Error('Readback unavailable'));
    expect(await first.commit()).toMatchObject({ type: 'io-error', contentState: 'unknown' });
    reads.mockRestore();
    expect((await pending.refresh(sibling)).type).toBe('invalid');
    expect(h.sources.get('tasks.md')).toMatchObject({ type: 'error' });
    expect(invalidated).toContain(sibling.ref.revision);
    expect(await h.sources.reconcile('tasks.md', h.file, await h.read())).toBe(true);
    expect((await pending.refresh(expectDefined(h.index.list()[1]))).type).toBe('invalid');
    expect(['exact', 'rebased']).not.toContain(h.index.resolve(sibling.ref).type);
    subscription.unsubscribe();
  },
);

it('does not invalidate a later accepted observation through an earlier rejection capture', async () => {
  const h = await taskEditPreparationHarness('- [ ] Root\n');
  const invalidate = h.index.captureRejectedSourceInvalidation('tasks.md', h.file);
  const replacement = '- [ ] Later accepted\n';
  await h.app.vault.modify(h.file, replacement);
  expect(await h.sources.reconcile('tasks.md', h.file, replacement)).toBe(true);
  invalidate();
  expect(h.sources.get('tasks.md')).toMatchObject({ type: 'ok', value: { content: replacement } });
  expect(h.index.list()[0]?.title).toBe('Later accepted');
});
