import { describe, expect, it } from 'vitest';
import type { TaskAcceptedOccurrenceChange } from '../../src/tasks/application/TaskIntegrationReadApi';
import { localDate } from '../../src/tasks/domain/validation';
import { expectDefined } from '../helpers';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

const source =
  '---\r\nkind: project\r\n---\r\n- [ ] Old 📅 2026-11-08 [unknown:: keep]\r\n\t- > Description [[Note]]\r\n\t- 2026-11-01T12:00:00+00:00: Comment\r\n\t- 2026-11-01T12:00:00+00:00 → 2026-11-01T13:00:00+00:00\r\n- [ ] Sibling\r\n';

describe('canonical task edit preparation', () => {
  it('previews without writes or accepted publications, then commits the sealed tree once', async () => {
    const h = await taskEditPreparationHarness(source);
    const reads = h.index.integrationReads();
    reads.activateOccurrences();
    const events: string[] = [];
    const subscription = reads.subscribe((event) => events.push(event.type));
    const initial = reads.capture();
    const roots = h.index.list();
    const preparation = ready(
      h.service.prepare(h.root, [
        {
          type: 'patch',
          target: { type: 'task', ref: h.root.ref },
          patch: {
            markdownTitle: { type: 'set', value: 'Renamed [unknown:: keep]' },
            due: { type: 'set', value: localDate('2026-11-12') },
          },
        },
      ]),
    );
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.index.integrationReads().capture()).toEqual(initial);
    expect(h.index.list()).toEqual(roots);
    expect(events).toEqual([]);
    subscription.unsubscribe();
    expect(preparation.after?.source.originalBlock).toContain('Description [[Note]]');
    expect(preparation.after?.comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Comment' })]),
    );
    expect(preparation.after?.timeEntries).toHaveLength(1);
    expect(preparation.after?.timeEntries).toEqual(h.root.timeEntries);
    const after = expectDefined(preparation.after);
    Object.assign(after.source, { originalBlock: '- [ ] Forged' });
    Object.assign(after, { markdownTitle: 'Forged' });
    const receipts = await Promise.all([preparation.commit(), preparation.commit()]);
    expect(receipts[0]).toMatchObject({ type: 'ok', changed: true });
    expect(receipts[1]).toEqual(receipts[0]);
    expect(await preparation.commit()).toEqual(receipts[0]);
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(await h.read()).toBe(
      source.replace(
        'Old 📅 2026-11-08 [unknown:: keep]',
        'Renamed [unknown:: keep] 📅 2026-11-12',
      ),
    );
  });

  it('uses each preceding preview ref for nested child comments and structural changes', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n\t- [ ] Child\n\t\t- [ ] Grandchild\n');
    const original = ready(h.service.prepare(h.root, []));
    let p = original;
    const child = () => expectDefined(expectDefined(p.after).subtasks[0]);
    const grandchild = () => expectDefined(child().subtasks[0]);
    p = ready(
      p.append({
        type: 'add-comment',
        parent: { type: 'subtask', ref: grandchild().ref },
        text: '  hello\r\nworld  ',
      }),
    );
    expect(grandchild().comments[0]?.text).toBe('  hello\nworld  ');
    p = ready(
      p.append({
        type: 'update-comment',
        comment: expectDefined(grandchild().comments[0]).ref,
        text: 'updated',
      }),
    );
    expect(grandchild().comments[0]?.text).toBe('updated');
    p = ready(
      p.append({ type: 'delete-comment', comment: expectDefined(grandchild().comments[0]).ref }),
    );
    expect(grandchild().comments).toEqual([]);
    p = ready(
      p.append({
        type: 'add-subtask',
        parent: { type: 'subtask', ref: child().ref },
        text: 'Another',
      }),
    );
    expect(child().subtasks).toHaveLength(2);
    p = ready(
      p.append({ type: 'delete-subtask', subtask: expectDefined(child().subtasks[1]).ref }),
    );
    expect(child().subtasks).toHaveLength(1);
    expect(original.after).toEqual(h.root);
    expect((await p.commit()).type).toBe('ok');
    expect(h.writes).toHaveBeenCalledTimes(1);
  });

  it('keeps stale preview refs from modifying another revision', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const p = ready(
      h.service.prepare(h.root, [
        {
          type: 'patch',
          target: { type: 'task', ref: h.root.ref },
          patch: { markdownTitle: { type: 'set', value: 'Next' } },
        },
      ]),
    );
    expect(p.append({ type: 'delete', ref: h.root.ref }).type).toBe('invalid');
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('uses the same prefix and lifecycle normalization as an ordinary command', async () => {
    const behavior = () => ({
      taskPrefix: '#task',
      applyTaskPrefixToSubtasks: true,
      inbox: { mode: 'tag' as const, tag: '#inbox', removeTagOnAssign: true },
      taskLifecycle: { addCreatedDate: true, addCompletionDate: true },
      recurrence: { newOccurrencePlacement: 'after' as const, removeScheduledDate: false },
    });
    const h = await taskEditPreparationHarness('- [ ] Root #work\n', { behavior });
    const ordinary = await taskEditPreparationHarness('- [ ] Root #work\n', { behavior });
    const p = ready(
      h.service.prepare(h.root, [
        { type: 'add-subtask', parent: { type: 'task', ref: h.root.ref }, text: 'Child' },
      ]),
    );
    expect(p.after?.subtasks[0]?.planning.created).toBe('2026-11-07');
    expect(p.after?.subtasks[0]?.tags).toContain('#task');
    expect(
      (
        await ordinary.service.execute({
          type: 'add-subtask',
          parent: { type: 'task', ref: ordinary.root.ref },
          text: 'Child',
        })
      ).type,
    ).toBe('ok');
    expect((await p.commit()).type).toBe('ok');
    expect(await h.read()).toBe(await ordinary.read());
  });

  it.each(['invalid-date', 'line-injection'])('rejects %s before writing', async (kind) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n');
    const p = h.service.prepare(h.root, [
      {
        type: 'patch',
        target: { type: 'task', ref: h.root.ref },
        patch:
          kind === 'line-injection'
            ? { markdownTitle: { type: 'set', value: 'bad\n- [ ] injected' } }
            : { due: { type: 'set', value: '2026-02-30' as ReturnType<typeof localDate> } },
      },
    ]);
    expect(p.type).toBe('invalid');
    expect(h.writes).not.toHaveBeenCalled();
  });

  it('preserves absent descriptions and clears them only on explicit null', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n\t- > Description\n');
    const p = ready(h.service.prepare(h.root, []));
    expect(p.after?.description).toBe('Description');
    const cleared = ready(
      p.append({
        type: 'set-description',
        target: { type: 'task', ref: expectDefined(p.after).ref },
        text: null,
      }),
    );
    expect(cleared.after?.description).toBeUndefined();
    const deleted = ready(
      cleared.append({ type: 'delete', ref: expectDefined(cleared.after).ref }),
    );
    expect(deleted.after).toBeNull();
    expect(await deleted.commit()).toMatchObject({
      type: 'ok',
      outcome: { type: 'deleted', ref: h.root.ref },
    });
    expect(await h.read()).toBe('');
  });
});

it.each([false, true])(
  'preserves proven occurrences across composite edits (structure=%s)',
  async (structure) => {
    const h = await taskEditPreparationHarness('- [ ] Root\n\t- [ ] Same\n\t- [ ] Same\n');
    const reads = h.index.integrationReads();
    reads.activateOccurrences();
    const before = reads.page({}, 10);
    if (before.type !== 'ok') throw new Error('No accepted page');
    const changes: TaskAcceptedOccurrenceChange[] = [];
    const subscription = reads.subscribe((event) => {
      if (event.type === 'accepted') changes.push(event.change);
    });
    let p = ready(
      h.service.prepare(h.root, [
        {
          type: 'patch',
          target: { type: 'task', ref: h.root.ref },
          patch: { due: { type: 'set', value: localDate('2026-11-12') } },
        },
      ]),
    );
    p = ready(
      p.append({
        type: 'set-description',
        target: { type: 'task', ref: expectDefined(p.after).ref },
        text: 'Description\nsecond line',
      }),
    );
    if (structure) {
      p = ready(
        p.append({
          type: 'add-subtask',
          parent: { type: 'task', ref: expectDefined(p.after).ref },
          text: 'Same',
        }),
      );
      p = ready(
        p.append({
          type: 'delete-subtask',
          subtask: expectDefined(expectDefined(p.after).subtasks[0]).ref,
        }),
      );
    }
    expect(changes).toEqual([]);
    expect((await p.commit()).type).toBe('ok');
    subscription.unsubscribe();
    const witnesses = changes.flatMap((change) => change.witnesses);
    expect(witnesses).toHaveLength(3);
    expect(changes.flatMap((change) => change.invalidated)).toEqual([]);
    for (const [index, node] of before.value.nodes.entries()) {
      const witness = expectDefined(
        witnesses.find(
          (value) =>
            value.kind !== 'created' && value.before.nodeOffset === node.address.nodeOffset,
        ),
      );
      if (structure && index === 1) {
        expect(witness.kind).toBe('removed');
      } else {
        expect(witness.kind).toBe('continued');
        if (witness.kind !== 'continued') throw new Error('Lost occurrence');
        const resolved = reads.node(witness.after);
        expect(resolved.type).toBe('ok');
        if (index === 2) expect(witness.after.nodeOffset).toBe(structure ? 3 : 4);
      }
    }
  },
);
