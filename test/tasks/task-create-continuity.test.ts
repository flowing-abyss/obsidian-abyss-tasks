import { expect, it, vi } from 'vitest';
import type { TaskCommandResult } from '../../src/tasks/domain/commands';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { expectDefined } from '../helpers';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

it.each(['ordinary', 'prepared', 'project'] as const)(
  'preserves duplicate roots and children through %s prepend insertion',
  async (mode) => {
    const h = await taskEditPreparationHarness(
      '- [ ] Same\n\t- [ ] Child\n- [ ] Same\n\t- [ ] Child\n',
    );
    const root = expectDefined(h.index.list()[1]),
      pending = ready(h.service.prepare(root, [{ type: 'delete', ref: root.ref }]));
    const destination = {
      type: 'explicit' as const,
      destination: { filePath: 'tasks.md', insertion: { type: 'prepend' as const } },
    };
    if (mode === 'project') {
      const result = await h.service.prepareProjectCreate(
        { ...destination.destination, check: () => undefined, checkCopy: () => true },
        'Inserted',
      )();
      expect(result.destinationCopy).toBe('committed');
    } else {
      let result: TaskCommandResult;
      if (mode === 'ordinary')
        result = await h.service.execute({ type: 'create', destination, markdownBody: 'Inserted' });
      else {
        const preparation = await h.service.prepareCreateTree({
          destination,
          tree: { markdownTitle: 'Inserted' },
        });
        if (preparation.type !== 'ready') throw new Error('Missing creation');
        result = (await preparation.commit()).result;
      }
      expect(result.type).toBe('ok');
    }
    const resolution = h.index.resolve(root.ref);
    expect(resolution.type).toBe('rebased');
    if (resolution.type === 'rebased') expect(resolution.basis.authorityTransition).toBeDefined();
    expect((await pending.refresh(expectDefined(h.index.list()[2]))).type).toBe('ready');
    h.index.destroy();
  },
);
it('does not give a rejected structural readback forward or completion authority', () => {
  const authority = new TaskRefAuthority('insertion-rejection'),
    path = 'tasks.md',
    before = '- [ ] Same\n',
    after = '- [ ] New\n- [ ] Same\n';
  const old = { line: 0, source: '- [ ] Same', revision: authority.revision('- [ ] Same') },
    inserted = { line: 0, source: '- [ ] New', revision: authority.mintRevision('- [ ] New') },
    retained = { ...old, line: 1 };
  const owner = expectDefined(
    authority.reserveStructuralMutation(
      [
        {
          filePath: path,
          before,
          after,
          predecessors: [old],
          roots: [inserted, retained],
          transitions: [{ ...retained, previousRevision: old.revision }],
        },
      ],
      () => [old],
    ),
  );
  expect(owner.forward(path, before)).toBe(after);
  owner.rejectSource(path, after);
  expect(owner.forward(path, before)).toBeUndefined();
  expect(owner.forward(path, after)).toBeUndefined();
  expect(owner.complete(new Map([[path, after]]))).toBe(false);
  const observation = authority.observeTransition(path, after);
  expect(observation?.revokedRevisions).toEqual(
    expect.arrayContaining([old.revision, inserted.revision]),
  );
  owner.release();
});
it.each([
  'candidate',
  'original',
  'unreadable',
  'later',
  'later-before',
  'project-candidate',
] as const)(
  'retires speculative insertion provenance after rejected persistence with %s readback',
  async (mode) => {
    const original = '- [ ] Same\n- [ ] Same\n',
      h = await taskEditPreparationHarness(original);
    h.index.integrationReads().activateOccurrences();
    const root = expectDefined(h.index.list()[1]),
      pending = ready(h.service.prepare(root, [{ type: 'delete', ref: root.ref }]));
    const read = h.app.vault.read.bind(h.app.vault);
    let restoreRead: (() => void) | undefined, laterRevision: string | undefined;
    h.writes.mockImplementationOnce(async (file, transform) => {
      const candidate = transform(await read(file));
      await h.app.vault.modify(file, candidate);
      h.index.installCommittedContent('tasks.md', candidate);
      if (mode === 'original') await h.app.vault.modify(file, original);
      if (mode === 'unreadable') {
        const spy = vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('Unavailable'));
        restoreRead = () => {
          spy.mockRestore();
        };
      }
      if (mode === 'later-before') {
        await h.app.vault.modify(file, '- [ ] Later\n');
        h.index.installCommittedContent('tasks.md', '- [ ] Later\n');
        laterRevision = h.index.list()[0]?.ref.revision;
        const spy = vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('Unavailable'));
        restoreRead = () => {
          spy.mockRestore();
        };
      }
      if (mode === 'later') {
        const spy = vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async () => {
          await h.app.vault.modify(file, '- [ ] Later\n');
          h.index.installCommittedContent('tasks.md', '- [ ] Later\n');
          laterRevision = h.index.list()[0]?.ref.revision;
          throw new Error('Old read failed');
        });
        restoreRead = () => {
          spy.mockRestore();
        };
      }
      throw new Error('Late rejection');
    });
    if (mode === 'project-candidate') {
      const result = await h.service.prepareProjectCreate(
        {
          filePath: 'tasks.md',
          insertion: { type: 'prepend' },
          check: () => undefined,
          checkCopy: () => true,
        },
        'Inserted',
      )();
      expect(result.destinationCopy).toBe('unknown');
    } else {
      const p = await h.service.prepareCreateTree({
        destination: {
          type: 'explicit',
          destination: { filePath: 'tasks.md', insertion: { type: 'prepend' } },
        },
        tree: { markdownTitle: 'Inserted' },
      });
      if (p.type !== 'ready') throw new Error('Missing preparation');
      const result = await p.commit();
      expect(result.result.type).toBe('io-error');
      expect(await p.commit()).toEqual(result);
    }
    restoreRead?.();
    if (mode === 'unreadable') {
      expect(h.index.integrationReads().coverage()).toMatchObject({ type: 'error' });
      await h.index.refreshSourceExclusion(undefined);
    }
    if (mode === 'later' || mode === 'later-before')
      expect(h.index.list()[0]?.ref.revision).toBe(laterRevision);
    if (mode !== 'original') {
      const current = h.index.list().find((t) => t.title === 'Same');
      if (current !== undefined) expect((await pending.refresh(current)).type).toBe('invalid');
    }
    h.index.destroy();
  },
);
it('preserves duplicate descendants under section insertion', async () => {
  const h = await taskEditPreparationHarness(
    '# Work\n- [ ] Same\n\t- [ ] Child\n- [ ] Same\n\t- [ ] Child\n',
  );
  const root = expectDefined(h.index.list()[1]);
  const pending = ready(h.service.prepare(root, []));
  const p = await h.service.prepareCreateTree({
    destination: {
      type: 'explicit',
      destination: {
        filePath: 'tasks.md',
        insertion: { type: 'section', heading: 'Work', position: 'top' },
      },
    },
    tree: { markdownTitle: 'Inserted' },
  });
  if (p.type !== 'ready') throw new Error('Missing creation');
  expect((await p.commit()).result.type).toBe('ok');
  const current = expectDefined(h.index.list()[2]);
  expect(current.subtasks[0]?.title).toBe('Child');
  expect((await pending.refresh(current)).type).toBe('ready');
  h.index.destroy();
});
