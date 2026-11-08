import { expect, it, vi } from 'vitest';
import { clockFrom } from '../../src/tasks/domain/clock';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { expectDefined } from '../helpers';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

it('refines only proven inserted duplicate children and retains frozen construction dates', async () => {
  const h = await taskEditPreparationHarness('- [ ] Root\n\t- [ ] Same\n');
  let p = ready(await h.service.prepare(h.root, []));
  expect(
    p.refineInitialStatus({ target: { type: 'task', ref: h.root.ref }, symbol: 'x' }).type,
  ).toBe('invalid');
  p = ready(
    p.append({
      type: 'add-subtask',
      parent: { type: 'task', ref: expectDefined(p.after).ref },
      text: 'Same',
    }),
  );
  const original = expectDefined(p.after?.subtasks[0]).ref;
  const fresh = expectDefined(p.after?.subtasks[1]).ref;
  expect(
    p.refineInitialStatus({ target: { type: 'subtask', ref: original }, symbol: 'x' }).type,
  ).toBe('invalid');
  p = ready(p.refineInitialStatus({ target: { type: 'subtask', ref: fresh }, symbol: 'x' }));
  expect(p.after?.subtasks.map((c) => c.status)).toEqual(['open', 'done']);
  expect(p.after?.subtasks[1]?.planning.completion).toBe('2026-11-07');
  expect(p.refineInitialStatus({ target: { type: 'subtask', ref: fresh }, symbol: ' ' }).type).toBe(
    'invalid',
  );
  p = ready(
    p.refineInitialStatus({
      target: { type: 'subtask', ref: expectDefined(p.after?.subtasks[1]).ref },
      symbol: ' ',
    }),
  );
  expect(p.after?.subtasks[1]?.planning.completion).toBeUndefined();
  expect(h.writes).not.toHaveBeenCalled();
  expect((await p.commit()).type).toBe('ok');
});

it('refines seeded and nested creation nodes without running completion deletion or recurrence', async () => {
  const h = await taskEditPreparationHarness('- [ ] Existing\n');
  let p = await h.service.prepareCreateTree({
    destination: {
      type: 'explicit',
      destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
    },
    tree: {
      markdownTitle: 'New',
      initial: {
        onCompletion: { type: 'set', value: 'delete' },
        recurrence: { type: 'set', value: 'every day' },
      },
      children: [
        { markdownTitle: 'Same', children: [{ markdownTitle: 'Nested' }] },
        { markdownTitle: 'Same' },
      ],
      comments: [{ text: 'Retained' }],
    },
  });
  if (p.type !== 'ready') throw new Error('Not ready');
  const comments = p.after.comments;
  p = p.refineInitialStatus({ target: { type: 'task', ref: p.after.ref }, symbol: 'x' });
  if (p.type !== 'ready') throw new Error('Not ready');
  expect(p.after.status).toBe('done');
  expect(p.after.comments.map((c) => c.text)).toEqual(comments.map((c) => c.text));
  p = p.refineInitialStatus({
    target: { type: 'subtask', ref: expectDefined(p.after.subtasks[0]?.subtasks[0]).ref },
    symbol: 'x',
  });
  if (p.type !== 'ready') throw new Error('Not ready');
  expect(p.after.subtasks[0]?.subtasks[0]?.status).toBe('done');
  expect(h.writes).not.toHaveBeenCalled();
  expect(await p.commit()).toMatchObject({ result: { type: 'ok' } });
  expect(h.index.list()).toHaveLength(2);
});

it('uses the frozen clock for appended nested nodes and rejects changed catalog meaning', async () => {
  let date = Date.UTC(2026, 10, 7, 12);
  const h = await taskEditPreparationHarness('- [ ] Existing\n', {
    clock: { read: () => clockFrom(date, 0).read() },
  });
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    p.append({
      type: 'add-subtask',
      parent: { type: 'task', ref: expectDefined(p.after).ref },
      text: 'New',
    }),
  );
  date += 86400000;
  p = ready(
    p.append({
      type: 'add-subtask',
      parent: { type: 'subtask', ref: expectDefined(p.after?.subtasks[0]).ref },
      text: 'Nested',
    }),
  );
  p = ready(
    p.refineInitialStatus({
      target: { type: 'subtask', ref: expectDefined(p.after?.subtasks[0]?.subtasks[0]).ref },
      symbol: 'x',
    }),
  );
  expect(p.after?.subtasks[0]?.subtasks[0]?.planning).toMatchObject({
    created: '2026-11-07',
    completion: '2026-11-07',
  });
  h.catalog.replace(
    h.catalog.all().map((rule) => (rule.symbol === 'x' ? { ...rule, type: 'cancelled' } : rule)),
  );
  expect(
    p.refineInitialStatus({
      target: { type: 'subtask', ref: expectDefined(p.after?.subtasks[0]).ref },
      symbol: 'x',
    }).type,
  ).toBe('invalid');
  expect((await p.commit()).type).toBe('invalid');
  expect(h.writes).not.toHaveBeenCalled();
});
it('does not infer newness from a missing native survivor map', async () => {
  const h = await taskEditPreparationHarness('- [ ] Root\n');
  const original = new TaskBlockEditor().edit.bind(new TaskBlockEditor());
  const spy = vi.spyOn(TaskBlockEditor.prototype, 'edit').mockImplementationOnce((...args) => {
    const result = original(...args);
    if (result.type !== 'changed') return result;
    const withoutProof = { ...result };
    delete withoutProof.nodeMap;
    return withoutProof;
  });
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    p.append({
      type: 'add-subtask',
      parent: { type: 'task', ref: expectDefined(p.after).ref },
      text: 'Unproven',
    }),
  );
  expect(
    p.refineInitialStatus({
      target: { type: 'subtask', ref: expectDefined(p.after?.subtasks[0]).ref },
      symbol: 'x',
    }).type,
  ).toBe('invalid');
  spy.mockRestore();
  expect(h.writes).not.toHaveBeenCalled();
});
