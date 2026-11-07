import { describe, expect, it, vi } from 'vitest';
import { expectDefined, useRealMoment } from '../helpers';
import { taskCreatePreparationHarness } from '../support/taskCreatePreparationHarness';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

useRealMoment();

describe('sealed task creation', () => {
  it('prepares a complete tree without writing and commits precisely that candidate once', async () => {
    const h = await taskEditPreparationHarness('- [ ] Existing\n');
    const p = await h.service.prepareCreateTree({
      destination: {
        type: 'explicit',
        destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
      },
      tree: {
        markdownTitle: 'Root',
        description: 'Details',
        children: [
          {
            markdownTitle: 'Child',
            comments: [{ text: 'Check the source' }],
            children: [{ markdownTitle: 'Grandchild' }],
          },
        ],
      },
    });
    expect(p, JSON.stringify(p)).toMatchObject({ type: 'ready' });
    if (p.type !== 'ready') return;
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.index.list()).toHaveLength(1);
    expect(p.after.description).toBe('Details');
    expect(p.after.subtasks[0]?.comments[0]?.text).toBe('Check the source');
    expect(p.after.subtasks[0]?.subtasks[0]?.title).toBe('Grandchild');
    expect(p.continuations).toEqual([]);
    const preview = p.after.source.originalBlock;
    Object.assign(p.after.source, { originalBlock: 'Forged' });
    const [first, second] = await Promise.all([p.commit(), p.commit()]);
    expect(first).toMatchObject({
      result: { type: 'ok', changed: true },
      destinationEffects: 'unchanged',
    });
    expect(second).toEqual(first);
    expect(await p.commit()).toEqual(first);
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(h.index.list()[1]?.source.originalBlock).toBe(preview);
  });

  it('continues duplicate draft siblings from the immediately preceding preview', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n\t- [ ] Same\n\t- [ ] Same\n');
    let p = ready(await h.service.prepare(h.root, []));
    p = ready(
      p.append({
        type: 'add-subtask',
        parent: { type: 'task', ref: expectDefined(p.after).ref },
        text: 'Same',
      }),
    );
    const before = expectDefined(p.after);
    const survivor = expectDefined(before.subtasks[2]);
    p = ready(p.append({ type: 'delete-subtask', subtask: expectDefined(before.subtasks[0]).ref }));
    expect(p.continuations).toContainEqual({
      before: { type: 'subtask', ref: survivor.ref },
      after: { type: 'subtask', ref: expectDefined(p.after?.subtasks[1]).ref },
    });
    expect(p.continuations).toContainEqual({
      before: { type: 'subtask', ref: expectDefined(before.subtasks[0]).ref },
    });
  });
});

describe('guarded creation destinations', () => {
  it('freezes a missing note template without provisioning until commit', async () => {
    const h = await taskCreatePreparationHarness();
    const creates = vi.spyOn(h.app.vault, 'create');
    const folders = vi.spyOn(h.app.vault, 'createFolder');
    const p = await h.service.prepareCreateTree({
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'Planned' },
    });
    expect(p, JSON.stringify(p)).toMatchObject({ type: 'ready' });
    expect(creates).not.toHaveBeenCalled();
    expect(folders).not.toHaveBeenCalled();
    expect(h.app.vault.getAbstractFileByPath('draft/new.md')).toBeNull();
    if (p.type !== 'ready') return;
    const result = await p.commit();
    expect(result).toMatchObject({ result: { type: 'ok' }, destinationEffects: 'committed' });
    expect(h.index.list().find((root) => root.title === 'Planned')?.source.originalBlock).toBe(
      p.after.source.originalBlock,
    );
  });
  it('rejects an executable template before any provisioning', async () => {
    const h = await taskCreatePreparationHarness({
      files: { 'template.md': '<% tp.date.now() %>' },
    });
    const p = await h.service.prepareCreateTree({
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'Planned' },
    });
    expect(p).toMatchObject({
      type: 'invalid',
      result: { type: 'invalid', issues: [{ code: 'unsupported-template' }] },
    });
    expect(h.app.vault.getAbstractFileByPath('draft')).toBeNull();
  });
  it('rejects changed default configuration before provisioning instead of redirecting', async () => {
    const h = await taskCreatePreparationHarness();
    const p = await h.service.prepareCreateTree({
      destination: { type: 'configured-default' },
      tree: { markdownTitle: 'Planned' },
    });
    expect(p, JSON.stringify(p)).toMatchObject({ type: 'ready' });
    if (p.type !== 'ready') return;
    h.configuration.taskFilePath = 'other.md';
    expect(await p.commit()).toMatchObject({
      result: { type: 'invalid' },
      destinationEffects: 'unchanged',
    });
    expect(h.app.vault.getAbstractFileByPath('draft')).toBeNull();
    expect(h.app.vault.getAbstractFileByPath('other.md')).toBeNull();
  });
});

it('rejects a stale project guard before any writer attempt', async () => {
  const h = await taskEditPreparationHarness('- [ ] Existing\n');
  let stale = false;
  const p = await h.service.prepareCreateTree({
    destination: {
      type: 'project',
      destination: {
        filePath: 'tasks.md',
        insertion: { type: 'append' },
        check: () => (stale ? 'stale' : undefined),
        checkCopy: () => true,
      },
    },
    tree: { markdownTitle: 'Project task' },
  });
  expect(p.type).toBe('ready');
  if (p.type !== 'ready') return;
  stale = true;
  expect(await p.commit()).toMatchObject({
    result: { type: 'invalid' },
    destinationEffects: 'unchanged',
  });
  expect(h.writes).not.toHaveBeenCalled();
});

it('rejects candidate source exclusions before creating its destination', async () => {
  const h = await taskCreatePreparationHarness({
    index: { excludeSource: (metadata) => metadata.tags.includes('#blocked') },
  });
  const p = await h.service.prepareCreateTree({
    destination: { type: 'configured-default' },
    tree: { markdownTitle: 'Blocked #blocked' },
  });
  expect(p.type).toBe('ready');
  if (p.type !== 'ready') return;
  expect(await p.commit()).toMatchObject({
    result: { type: 'invalid' },
    destinationEffects: 'unchanged',
  });
  expect(h.app.vault.getAbstractFileByPath('draft')).toBeNull();
});
