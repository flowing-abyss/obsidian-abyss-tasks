import { expect, it, vi } from 'vitest';
import type { TaskFieldSelection } from '../../src/tasks/application/TaskEditPreparationApi';
import type { TaskPatch } from '../../src/tasks/domain/commands';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';
import { expectDefined } from '../helpers';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

const body = '\n\t- > Existing description\n\t- 2020-01-02: Historical [[Note]]\n\t- [ ] Child\n';
const fields: TaskFieldSelection['fields'] = [
  'due',
  'scheduled',
  'start',
  'time',
  'duration',
  'priority',
  'recurrence',
  'onCompletion',
  'tags',
];
const initial =
  '- [ ] Original [unknown:: keep] #old #shared ⏫ 🔁 every day 🏁 delete 📅 2026-11-08 ⏳ 2026-11-07 🛫 2026-11-06 ⏰ 09:00 ⏱️ 30m';
const setting: TaskPatch = {
  due: { type: 'set', value: localDate('2026-12-01') },
  scheduled: { type: 'set', value: localDate('2026-11-30') },
  start: { type: 'set', value: localDate('2026-11-29') },
  time: { type: 'set', value: localTime('13:45') },
  duration: { type: 'set', value: durationMinutes(90) },
  priority: { type: 'set', value: 'A' },
  recurrence: { type: 'set', value: 'every week' },
  onCompletion: { type: 'set', value: 'keep' },
  tags: { add: ['#new'], remove: ['#old'] },
};
const clearing: TaskPatch = {
  due: { type: 'clear' },
  scheduled: { type: 'clear' },
  start: { type: 'clear' },
  time: { type: 'clear' },
  duration: { type: 'clear' },
  priority: { type: 'clear' },
  recurrence: { type: 'clear' },
  onCompletion: { type: 'clear' },
  tags: { remove: ['#old'] },
};

it.each(['set', 'clear'] as const)(
  'selects %s metadata from sealed values while conserving historical content and a pending title',
  async (mode) => {
    const h = await taskEditPreparationHarness(initial + body);
    let full = ready(
      await h.service.prepare(h.root, [
        {
          type: 'patch',
          target: { type: 'task', ref: h.root.ref },
          patch: mode === 'set' ? setting : clearing,
        },
      ]),
    );
    const metadata = expectDefined(full.after);
    full = ready(
      full.append({
        type: 'patch',
        target: { type: 'task', ref: metadata.ref },
        patch: {
          markdownTitle: {
            type: 'set',
            value: metadata.markdownTitle.replace('Original', 'Pending'),
          },
        },
      }),
    );
    const partition = expectDefined(
      full.partitionFields([
        { target: { type: 'task', ref: expectDefined(full.after).ref }, fields },
      ]),
    );
    const selected = ready(partition.selected);
    const selectedAfter = expectDefined(selected.after);
    expect(selectedAfter.planning).toEqual(metadata.planning);
    expect(selectedAfter.priority).toBe(metadata.priority);
    expect(selectedAfter.recurrence).toBe(mode === 'set' ? 'every week' : undefined);
    expect(selectedAfter.onCompletionExplicit).toBe(mode === 'set');
    expect(selectedAfter.onCompletion).toBe('keep');
    expect(selectedAfter.tags).toEqual(mode === 'set' ? ['#shared', '#new'] : ['#shared']);
    expect(selectedAfter.markdownTitle).toContain('Original [unknown:: keep]');
    expect((await selected.commit()).type).toBe('ok');
    expect(await h.read()).toContain(body.trimEnd());
    expect(await h.read()).not.toContain('Pending');
    const remaining = ready(await partition.rebase(expectDefined(h.index.list()[0])));
    expect((await remaining.commit()).type).toBe('ok');
    expect(await h.read()).toContain('Pending [unknown:: keep]');
    expect(await h.read()).toContain(body.trimEnd());
    expect(h.writes).toHaveBeenCalledTimes(2);
  },
);

it('clears only the selected description and preserves shifted duplicate comments and children for the remainder', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Original\n\t- > First\n\t- > Second\n\t- Same\n\t- [ ] Same\n\t- Same\n\t- [ ] Same\n',
  );
  let full = ready(
    await h.service.prepare(h.root, [
      { type: 'set-description', target: { type: 'task', ref: h.root.ref }, text: null },
    ]),
  );
  full = ready(
    full.append({
      type: 'patch',
      target: { type: 'task', ref: expectDefined(full.after).ref },
      patch: { markdownTitle: { type: 'set', value: 'Pending' } },
    }),
  );
  const partition = expectDefined(
    full.partitionFields([
      {
        target: { type: 'task', ref: expectDefined(full.after).ref },
        fields: ['description', 'due'],
      },
    ]),
  );
  const selected = ready(partition.selected);
  expect(selected.after?.description).toBeUndefined();
  expect((await selected.commit()).type).toBe('ok');
  const remaining = ready(await partition.rebase(expectDefined(h.index.list()[0])));
  expect(remaining.after?.comments.map((comment) => comment.text)).toEqual(['Same', 'Same']);
  expect(remaining.after?.subtasks.map((child) => child.title)).toEqual(['Same', 'Same']);
  expect((await remaining.commit()).type).toBe('ok');
  expect(await h.read()).toBe('- [ ] Pending\n\t- Same\n\t- [ ] Same\n\t- Same\n\t- [ ] Same\n');
});

async function pending() {
  const h = await taskEditPreparationHarness('- [ ] Original\n');
  const full = ready(
    await h.service.prepare(h.root, [
      {
        type: 'patch',
        target: { type: 'task', ref: h.root.ref },
        patch: {
          markdownTitle: { type: 'set', value: 'Pending' },
          due: { type: 'set', value: localDate('2026-12-01') },
        },
      },
    ]),
  );
  const selection: TaskFieldSelection = {
    target: { type: 'task', ref: expectDefined(full.after).ref },
    fields: ['due'],
  };
  return { ...h, full, selection };
}

it.each([
  'empty selection',
  'empty fields',
  'duplicate field',
  'duplicate node',
  'foreign node',
  'draft child',
  'unchanged field',
  'deleted root',
] as const)('refuses %s without effects and leaves the complete plan usable', async (mode) => {
  const h = await pending();
  let full = h.full;
  let selections: readonly TaskFieldSelection[] = [h.selection];
  switch (mode) {
    case 'empty selection':
      selections = [];
      break;
    case 'empty fields':
      selections = [{ ...h.selection, fields: [] }];
      break;
    case 'duplicate field':
      selections = [{ ...h.selection, fields: ['due', 'due'] }];
      break;
    case 'duplicate node':
      selections = [h.selection, h.selection];
      break;
    case 'foreign node':
      selections = [
        {
          ...h.selection,
          target: { type: 'task', ref: { ...h.root.ref, filePath: 'foreign.md' } },
        },
      ];
      break;
    case 'unchanged field':
      selections = [{ ...h.selection, fields: ['scheduled'] }];
      break;
    case 'deleted root':
      full = ready(full.append({ type: 'delete', ref: expectDefined(full.after).ref }));
      break;
    case 'draft child': {
      full = ready(
        full.append({
          type: 'add-subtask',
          parent: { type: 'task', ref: expectDefined(full.after).ref },
          text: 'Draft child',
        }),
      );
      selections = [
        {
          target: { type: 'subtask', ref: expectDefined(full.after?.subtasks[0]).ref },
          fields: ['markdownTitle'],
        },
      ];
    }
  }
  expect(full.partitionFields(selections)).toBeUndefined();
  expect(h.writes).not.toHaveBeenCalled();
  expect(await h.read()).toBe('- [ ] Original\n');
  expect((await full.commit()).type).toBe('ok');
});

it.each(['before selection', 'before rebase', 'during rebase'] as const)(
  'retains the frozen application settings guard %s',
  async (phase) => {
    const h = await pending();
    if (phase === 'before selection') {
      h.catalog.replace([]);
      expect(h.full.partitionFields([h.selection])).toBeUndefined();
      expect(h.writes).not.toHaveBeenCalled();
      return;
    }
    const partition = expectDefined(h.full.partitionFields([h.selection]));
    expect((await ready(partition.selected).commit()).type).toBe('ok');
    if (phase === 'before rebase') h.catalog.replace([]);
    else {
      const read = h.app.vault.read.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'read').mockImplementationOnce(async (file) => {
        h.catalog.replace([]);
        return read(file);
      });
    }
    expect(await partition.rebase(expectDefined(h.index.list()[0]))).toMatchObject({
      type: 'invalid',
      result: { issues: [{ field: 'settings' }] },
    });
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(await h.read()).not.toContain('Pending');
  },
);

it.each(['not committed', 'failed write', 'changed root', 'failed refresh'] as const)(
  'does not authorize a remainder from %s',
  async (mode) => {
    const h = await pending();
    const partition = expectDefined(h.full.partitionFields([h.selection]));
    const selected = ready(partition.selected);
    if (mode === 'failed write') h.writes.mockRejectedValueOnce(new Error('Unavailable'));
    if (mode !== 'not committed') {
      const outcome = await selected.commit();
      expect(outcome.type).toBe(mode === 'failed write' ? 'io-error' : 'ok');
    }
    if (mode === 'changed root') {
      const current = expectDefined(h.index.list()[0]);
      expect(
        (
          await h.service.execute({
            type: 'patch',
            target: { type: 'task', ref: current.ref },
            patch: { markdownTitle: { type: 'set', value: 'External' } },
          })
        ).type,
      ).toBe('ok');
    }
    if (mode === 'failed refresh')
      vi.spyOn(h.sources, 'acquire').mockResolvedValueOnce({ type: 'error', reason: 'incomplete' });
    expect((await partition.rebase(expectDefined(h.index.list()[0]))).type).toBe('invalid');
    expect(await h.read()).not.toContain('Pending');
  },
);

it('keeps a failed ordinary selected refresh from creating commit or remainder authority', async () => {
  const h = await pending();
  const partition = expectDefined(h.full.partitionFields([h.selection]));
  const selected = ready(partition.selected);
  expect(
    (
      await h.service.execute({
        type: 'patch',
        target: { type: 'task', ref: h.root.ref },
        patch: { markdownTitle: { type: 'set', value: 'External' } },
      })
    ).type,
  ).toBe('ok');
  expect((await selected.refresh(expectDefined(h.index.list()[0]))).type).toBe('invalid');
  expect((await partition.rebase(expectDefined(h.index.list()[0]))).type).toBe('invalid');
  expect(h.writes).toHaveBeenCalledTimes(1);
  expect(await h.read()).toBe('- [ ] External\n');
});
