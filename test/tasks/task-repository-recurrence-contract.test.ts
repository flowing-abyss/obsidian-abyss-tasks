import { TFile, type CachedMetadata } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { TaskAcceptedOccurrenceChange } from '../../src/tasks/application/TaskIntegrationReadApi';
import type { RecurrenceCompletionRequest } from '../../src/tasks/application/TaskRepository';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import { recurrenceOwnedSubtree } from '../../src/tasks/domain/recurrenceIteration';
import { taskNodeSourceLine, taskTreeNodes } from '../../src/tasks/domain/taskSearchProjection';
import { timeEntryRef } from '../../src/tasks/domain/timeTracking';
import type { TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { expectDefined, flushMicrotasks } from '../helpers';
import { makeRepositoryHarness as makeHarness } from '../support/taskRepositoryHarness';
type Harness = Awaited<ReturnType<typeof makeHarness>>;
const path = 'tasks.md';

function request(
  target: TaskNodeRef,
  overrides: Partial<Omit<RecurrenceCompletionRequest, 'target'>> = {},
): RecurrenceCompletionRequest {
  return {
    target,
    doneSymbol: 'x',
    today: localDate('2026-08-01'),
    todoSymbol: ' ',
    addCreatedDate: true,
    addCompletionDate: true,
    placement: 'before',
    policy: { removeScheduledDate: false },
    ...overrides,
  };
}

function rootTarget(harness: Harness, source: string, index = 0): TaskNodeRef {
  const root = harness.snapshots(source)[index];
  if (root == null) throw new Error(`missing root ${index}`);
  return { type: 'task', ref: root.ref };
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} recurrence repository contract`, () => {
    it('promotes a subtree with an owned multiline comment and preserves source bytes', async () => {
      const source =
        '- [ ] Root\r\n  - [ ] Move\r\n    - 2026-10-06: first\r\n      \\- [ ] literal\r\n      tail  ';
      const h = await makeHarness(adapter, source);
      const root = expectDefined(h.snapshots(source)[0]);
      const child = expectDefined(root.subtasks[0]);
      const target = { type: 'subtask' as const, ref: child.ref };
      await expect(
        h.repository.hierarchy({
          command: { type: 'promote-subtask', subtask: child.ref },
          source: { baseRoot: root, baseTarget: target, reconciliation: { observed: root } },
        }),
      ).resolves.toMatchObject({ type: 'committed' });
      const expected =
        '- [ ] Root\r\n- [ ] Move\r\n  - 2026-10-06: first\r\n    \\- [ ] literal\r\n    tail  ';
      expect(await h.read()).toBe(expected);
      const moved = expectDefined(h.snapshots(expected)[1]);
      expect(moved.comments[0]?.text).toBe('first\n\\- [ ] literal\ntail  ');
      expect(moved.subtasks).toHaveLength(0);
      expect(moved.timeEntries).toHaveLength(0);
    });
    it('preserves multiline comment bytes and installs their continuation in search after recurrence', async () => {
      const source =
        '- [ ] Repeat 🔁 every day 📅 2026-08-01\r\n  - 2026-07-31: first\r\n    searchable-tail\r\n    \\- [ ] literal\r\n';
      const h = await makeHarness(adapter, source);
      await expect(
        h.repository.completeRecurrence(
          request(rootTarget(h, source), { addCreatedDate: false, addCompletionDate: false }),
        ),
      ).resolves.toMatchObject({ type: 'committed' });
      const content =
        '- [ ] Repeat 🔁 every day 📅 2026-08-02\r\n  - 2026-07-31: first\r\n    searchable-tail\r\n    \\- [ ] literal\r\n- [x] Repeat 🔁 every day 📅 2026-08-01\r\n  - 2026-07-31: first\r\n    searchable-tail\r\n    \\- [ ] literal\r\n';
      expect(await h.read()).toBe(content);
      const roots = h.snapshots(content);
      expect(roots).toHaveLength(2);
      for (const root of roots) {
        expect(root.comments[0]?.text).toBe('first\nsearchable-tail\n\\- [ ] literal');
        expect(root.subtasks).toHaveLength(0);
        expect(root.timeEntries).toHaveLength(0);
      }
      const search = h.index.searchSource();
      const documents = [...search.documents(expectDefined(search.files()[0]))];
      expect(documents).toHaveLength(2);
      expect(documents.every((document) => document.comments.includes('searchable-tail'))).toBe(
        true,
      );
    });
    it.each([
      {
        rule: 'every February on the last',
        reference: '2024-02-29',
        next: '2025-02-28',
      },
      {
        rule: 'every April and December on the 1st and 24th',
        reference: '2026-04-01',
        next: '2026-04-24',
      },
      {
        rule: 'every 2 years on February 29th',
        reference: '2024-02-29',
        next: '2028-02-29',
      },
    ])('materializes Tasks yearly grammar $rule', async ({ rule, reference, next }) => {
      const source = `- [ ] Repeat 🔁 ${rule} 📅 ${reference}\n`;
      const harness = await makeHarness(adapter, source);

      const result = await harness.repository.completeRecurrence(
        request(rootTarget(harness, source), {
          addCreatedDate: false,
          addCompletionDate: false,
        }),
      );

      expect(await harness.read()).toBe(
        `- [ ] Repeat 🔁 ${rule} 📅 ${next}\n` + `- [x] Repeat 🔁 ${rule} 📅 ${reference}\n`,
      );
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'recurrence',
          active: { root: { planning: { due: next } }, target: { type: 'task' } },
        },
      });
    });

    it.each([
      {
        placement: 'before' as const,
        ending: '\n',
        policyToken: '',
        expectedRoots: ['open', 'done'],
        expected:
          '12) [ ] Repeat 🔁 every day ➕ 2026-08-01 📅 2026-08-02\n' +
          '  * [ ] Child ➕ 2026-08-01 📅 2026-08-04\n' +
          '12) [x] Repeat 🔁 every day 📅 2026-08-01 ✅ 2026-08-01\n' +
          '  * [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
          '- [ ] Outside\n',
      },
      {
        placement: 'after' as const,
        ending: '\r\n',
        policyToken: ' 🏁 keep',
        expectedRoots: ['done', 'open'],
        expected:
          '12) [x] Repeat 🔁 every day 🏁 keep 📅 2026-08-01 ✅ 2026-08-01\r\n' +
          '  * [x] Child 📅 2026-08-03 ✅ 2026-07-31\r\n' +
          '12) [ ] Repeat 🔁 every day 🏁 keep ➕ 2026-08-01 📅 2026-08-02\r\n' +
          '  * [ ] Child ➕ 2026-08-01 📅 2026-08-04\r\n' +
          '- [ ] Outside\r\n',
      },
    ])(
      'keeps exact $ending bytes and places the clean root $placement the completed root',
      async ({ placement, ending, policyToken, expected, expectedRoots }) => {
        const source = [
          `12) [ ] Repeat 🔁 every day${policyToken} 📅 2026-08-01`,
          '  * [x] Child 📅 2026-08-03 ✅ 2026-07-31',
          '- [ ] Outside',
          '',
        ].join(ending);
        const harness = await makeHarness(adapter, source);

        const result = await harness.repository.completeRecurrence(
          request(rootTarget(harness, source), { placement }),
        );

        expect(await harness.read()).toBe(expected);
        expect(harness.snapshots(expected).map((root) => root.status)).toEqual([
          ...expectedRoots,
          'open',
        ]);
        expect(result).toMatchObject({
          type: 'committed',
          changed: true,
          outcome: {
            type: 'recurrence',
            active: { root: { status: 'open' }, target: { type: 'task' } },
            completed: { root: { status: 'done' }, target: { type: 'task' } },
          },
        });
        if (result.type === 'committed' && result.outcome.type === 'recurrence') {
          const completed = result.outcome.completed;
          if (completed == null) throw new Error('missing completed occurrence');
          expect(result.outcome.active.target).toEqual({
            type: 'task',
            ref: result.outcome.active.root.ref,
          });
          expect(completed.target).toEqual({
            type: 'task',
            ref: completed.root.ref,
          });
          expect(result.outcome.active.root.ref).not.toEqual(completed.root.ref);
        }
      },
    );

    it('rebases active and completed nested owners independently in one final root', async () => {
      const source =
        '- [ ] Shell\n' +
        '  - [ ] Owner 🔁 every day 📅 2026-08-01\n' +
        '    - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
        '  - [ ] Sibling\n' +
        '- [ ] Outside\n';
      const harness = await makeHarness(adapter, source);
      const root = expectDefined(harness.snapshots(source)[0]);
      const owner = expectDefined(root.subtasks[0]);

      const result = await harness.repository.completeRecurrence(
        request({ type: 'subtask', ref: owner.ref }),
      );

      expect(await harness.read()).toBe(
        '- [ ] Shell\n' +
          '  - [ ] Owner 🔁 every day ➕ 2026-08-01 📅 2026-08-02\n' +
          '    - [ ] Child ➕ 2026-08-01 📅 2026-08-04\n' +
          '  - [x] Owner 🔁 every day 📅 2026-08-01 ✅ 2026-08-01\n' +
          '    - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
          '  - [ ] Sibling\n' +
          '- [ ] Outside\n',
      );
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'recurrence',
          active: { target: { type: 'subtask' } },
          completed: { target: { type: 'subtask' } },
        },
      });
      if (result.type === 'committed' && result.outcome.type === 'recurrence') {
        expect(result.outcome.active.root.ref).toEqual(result.outcome.completed?.root.ref);
        expect(result.outcome.active.target).not.toEqual(result.outcome.completed?.target);
        expect(result.outcome.active.target).toEqual({
          type: 'subtask',
          ref: expectDefined(result.outcome.active.root.subtasks[0]).ref,
        });
        expect(result.outcome.completed?.target).toEqual({
          type: 'subtask',
          ref: expectDefined(result.outcome.active.root.subtasks[1]).ref,
        });
      }
    });

    it('replaces a Delete recurrence subtree and returns only the clean active occurrence', async () => {
      const source =
        '- [ ] Shell\n' +
        '  - [ ] Owner 🔁 every day 🏁 delete 📅 2026-08-01\n' +
        '    - [x] Child 📅 2026-08-03 ✅ 2026-07-31\n' +
        '  - [ ] Sibling\n';
      const harness = await makeHarness(adapter, source);
      const owner = expectDefined(expectDefined(harness.snapshots(source)[0]).subtasks[0]);

      const result = await harness.repository.completeRecurrence(
        request({ type: 'subtask', ref: owner.ref }),
      );

      expect(await harness.read()).toBe(
        '- [ ] Shell\n' +
          '  - [ ] Owner 🔁 every day 🏁 delete ➕ 2026-08-01 📅 2026-08-02\n' +
          '    - [ ] Child ➕ 2026-08-01 📅 2026-08-04\n' +
          '  - [ ] Sibling\n',
      );
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: {
          type: 'recurrence',
          active: { target: { type: 'subtask' } },
        },
      });
      if (result.type === 'committed' && result.outcome.type === 'recurrence') {
        expect(result.outcome.completed).toBeUndefined();
        expect(result.outcome.active.target).toEqual({
          type: 'subtask',
          ref: expectDefined(result.outcome.active.root.subtasks[0]).ref,
        });
      }
    });

    it('removes a valid non-recurring Delete subtree only on first entry into Done', async () => {
      const source =
        '- [ ] Shell\n' +
        '  - [ ] Remove me 🏁 delete\n' +
        '    - [ ] Descendant\n' +
        '  - [ ] Keep me\n';
      const harness = await makeHarness(adapter, source);
      const owner = expectDefined(expectDefined(harness.snapshots(source)[0]).subtasks[0]);

      const result = await harness.repository.edit({
        type: 'set-status',
        target: { type: 'subtask', ref: owner.ref },
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: true,
      });

      expect(await harness.read()).toBe('- [ ] Shell\n  - [ ] Keep me\n');
      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { subtasks: [{ title: 'Keep me' }] } },
      });
    });

    it('installs a full-root Delete without minting a surviving successor', async () => {
      const source = '- [ ] Remove me 🏁 delete\n  - [ ] Descendant\n';
      const harness = await makeHarness(adapter, source);
      const target = rootTarget(harness, source);

      const result = await harness.repository.edit({
        type: 'set-status',
        target,
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: true,
      });
      await flushMicrotasks();

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'deleted' } });
      expect(await harness.read()).toBe('');
      expect(harness.index.list()).toEqual([]);
    });

    it('applies ordinary Delete completion to an invalid raw recurrence subtree', async () => {
      const source = '- [ ] Invalid repeat 🔁 tomorrow 🏁 delete\n  - [ ] Child\n';
      const harness = await makeHarness(adapter, source);

      const result = await harness.repository.edit({
        type: 'set-status',
        target: rootTarget(harness, source),
        symbol: 'x',
        stamp: localDate('2026-08-01'),
        addCompletionDate: true,
      });

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'deleted' } });
      expect(await harness.read()).toBe('');
    });

    it.each([
      {
        name: 'a recurring descendant',
        source:
          '- [ ] Invalid repeat 🔁 tomorrow 🏁 delete\n' +
          '  - [ ] Child 🔁 every week 📅 2026-08-02\n',
      },
      {
        name: 'a second recurrence marker on the selected owner',
        source: '- [ ] Invalid repeat 🔁 tomorrow 🔁 every week 🏁 delete\n' + '  - [ ] Child\n',
      },
    ])('rejects ordinary Delete for an invalid selected owner with $name', async ({ source }) => {
      const harness = await makeHarness(adapter, source);

      await expect(
        harness.repository.edit({
          type: 'set-status',
          target: rootTarget(harness, source),
          symbol: 'x',
          stamp: localDate('2026-08-01'),
          addCompletionDate: true,
        }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'nested-recurrence-conflict', field: 'recurrence' }],
      });
      expect(await harness.read()).toBe(source);
    });

    it.each([
      {
        name: 'a recurrence on the selected subtask ancestor',
        source:
          '- [ ] Shell 🔁 every week 📅 2026-08-02\n' +
          '  - [ ] Owner 🔁 every day 📅 2026-08-01\n',
        owner: (roots: readonly TaskSnapshot[]) =>
          expectDefined(expectDefined(roots[0]).subtasks[0]),
      },
      {
        name: 'a second recurrence on a child',
        source:
          '- [ ] Owner 🔁 every day 📅 2026-08-01\n' +
          '  - [ ] Child 🔁 every week 📅 2026-08-02\n',
        owner: (roots: readonly TaskSnapshot[]) => expectDefined(roots[0]),
      },
    ])('rejects $name without changing bytes', async ({ source, owner }) => {
      const harness = await makeHarness(adapter, source);
      const selected = owner(harness.snapshots(source));
      const target: TaskNodeRef =
        'source' in selected
          ? { type: 'task', ref: selected.ref }
          : { type: 'subtask', ref: selected.ref };

      await expect(harness.repository.completeRecurrence(request(target))).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'nested-recurrence-conflict', field: 'recurrence' }],
      });
      expect(await harness.read()).toBe(source);
    });

    it.each(
      [
        {
          placement: 'before' as const,
          deletes: false,
          eol: '\n',
          trailing: '\n',
          activeOffset: 0,
          completedOffset: 1,
        },
        {
          placement: 'after' as const,
          deletes: false,
          eol: '\r\n',
          trailing: '',
          activeOffset: 1,
          completedOffset: 0,
        },
        {
          placement: 'before' as const,
          deletes: true,
          eol: '\r\n',
          trailing: '\r\n',
          activeOffset: 0,
          completedOffset: 0,
        },
        {
          placement: 'after' as const,
          deletes: true,
          eol: '\n',
          trailing: '',
          activeOffset: 0,
          completedOffset: 0,
        },
      ].flatMap((policy) => [0, 1].map((selected) => ({ ...policy, selected }))),
    )(
      'completes issue 7 sibling $selected with $placement placement and delete=$deletes',
      async ({ placement, deletes, eol, trailing, selected, activeOffset, completedOffset }) => {
        const completion = deletes ? ' 🏁 delete' : '';
        const parent = ' - [ ] parent task 📅 2026-10-26';
        const siblings = [
          `     - [ ] 🔄 subtask1 🔁 every day${completion} ➕ 2026-10-26 📅 2026-10-26`,
          `     - [ ] 🔄 subtask2 🔁 every day${completion} ➕ 2026-10-26 📅 2026-10-26`,
        ];
        const source = [parent, ...siblings].join(eol) + trailing;
        const h = await makeHarness(adapter, source);
        const owner = expectDefined(expectDefined(h.snapshots(source)[0]).subtasks[selected]);
        const target = { type: 'subtask' as const, ref: owner.ref };
        const options = {
          today: localDate('2026-10-26'),
          placement,
        };

        const result = await h.repository.completeRecurrence(request(target, options));

        const clean = `     - [ ] 🔄 subtask${selected + 1} 🔁 every day${completion} ➕ 2026-10-26 📅 2026-10-27`;
        const done = `     - [x] 🔄 subtask${selected + 1} 🔁 every day ➕ 2026-10-26 📅 2026-10-26 ✅ 2026-10-26`;
        let replacement = placement === 'before' ? [clean, done] : [done, clean];
        if (deletes) replacement = [clean];
        const expected =
          [
            parent,
            ...siblings.slice(0, selected),
            ...replacement,
            ...siblings.slice(selected + 1),
          ].join(eol) + trailing;
        expect(await h.read()).toBe(expected);
        expect(result).toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
        if (result.type !== 'committed' || result.outcome.type !== 'recurrence')
          throw new Error('missing recurrence outcome');
        const installed = expectDefined(h.index.list()[0]);
        const activeIndex = selected + activeOffset;
        expect(result.outcome.active.root.ref).toEqual(installed.ref);
        expect(result.outcome.active.target).toEqual({
          type: 'subtask',
          ref: expectDefined(installed.subtasks[activeIndex]).ref,
        });
        if (deletes) expect(result.outcome.completed).toBeUndefined();
        else {
          const completedIndex = selected + completedOffset;
          expect(result.outcome.completed?.target).toEqual({
            type: 'subtask',
            ref: expectDefined(installed.subtasks[completedIndex]).ref,
          });
        }
        await expect(
          h.repository.completeRecurrence(request(target, options)),
        ).resolves.toMatchObject({ type: 'conflict' });
        expect(await h.read()).toBe(expected);
      },
    );

    it('completes successive occurrences beside history and another active recurrence', async () => {
      const source =
        '- [ ] Root\n  - [ ] Owner 🔁 every day 📅 2026-08-01\n  - [ ] Other 🔁 every week 📅 2026-08-02\n';
      const h = await makeHarness(adapter, source);
      const owner = expectDefined(expectDefined(h.snapshots(source)[0]).subtasks[0]);
      const first = await h.repository.completeRecurrence(
        request({ type: 'subtask', ref: owner.ref }),
      );
      if (first.type !== 'committed' || first.outcome.type !== 'recurrence')
        throw new Error(`first completion failed: ${first.type}`);

      await expect(
        h.repository.completeRecurrence(request(first.outcome.active.target)),
      ).resolves.toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });

      expect(await h.read()).toBe(
        '- [ ] Root\n' +
          '  - [ ] Owner 🔁 every day ➕ 2026-08-01 📅 2026-08-03\n' +
          '  - [x] Owner 🔁 every day ➕ 2026-08-01 📅 2026-08-02 ✅ 2026-08-01\n' +
          '  - [x] Owner 🔁 every day 📅 2026-08-01 ✅ 2026-08-01\n' +
          '  - [ ] Other 🔁 every week 📅 2026-08-02\n',
      );
      expect(
        expectDefined(h.index.list()[0]).subtasks.map(({ status, planning }) => [
          status,
          planning.due,
        ]),
      ).toEqual([
        ['open', '2026-08-03'],
        ['done', '2026-08-02'],
        ['done', '2026-08-01'],
        ['open', '2026-08-02'],
      ]);
    });

    it('preserves malformed neighboring branches and renews only the selected same-title subtree', async () => {
      const source = [
        '> - [ ] Root 📅 2026-02-30',
        '>   - [ ] Repeat 🔁 every day 📅 2026-08-01',
        '>     - untouched first comment ^first',
        '>   - [ ] Branch',
        '>     - [ ] Repeat 🔁 every day 📅 2026-08-01 🆔 selected ^owner',
        '>       - [x] Child 📅 2026-08-03 ✅ 2026-07-31 ^child',
        '>       - selected comment ^comment',
        '>   - [ ] Broken 🔁 📅 2026-02-30',
        '>     - untouched trailing spaces  ',
      ].join('\r\n');
      const h = await makeHarness(adapter, source);
      const root = expectDefined(h.snapshots(source)[0]);
      const owner = expectDefined(expectDefined(root.subtasks[1]).subtasks[0]);

      const result = await h.repository.completeRecurrence(
        request({ type: 'subtask', ref: owner.ref }),
      );

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
      expect(await h.read()).toBe(
        [
          '> - [ ] Root 📅 2026-02-30',
          '>   - [ ] Repeat 🔁 every day 📅 2026-08-01',
          '>     - untouched first comment ^first',
          '>   - [ ] Branch',
          '>     - [ ] Repeat 🔁 every day ➕ 2026-08-01 📅 2026-08-02',
          '>       - [ ] Child ➕ 2026-08-01 📅 2026-08-04',
          '>       - selected comment',
          '>     - [x] Repeat 🔁 every day 📅 2026-08-01 ✅ 2026-08-01 🆔 selected ^owner',
          '>       - [x] Child 📅 2026-08-03 ✅ 2026-07-31 ^child',
          '>       - selected comment ^comment',
          '>   - [ ] Broken 🔁 📅 2026-02-30',
          '>     - untouched trailing spaces  ',
        ].join('\r\n'),
      );
      const branch = expectDefined(expectDefined(h.index.list()[0]).subtasks[1]);
      expect(branch.subtasks).toHaveLength(2);
      expect(branch.subtasks.map(({ dependencyId }) => dependencyId)).toEqual([
        undefined,
        'selected',
      ]);
      if (result.type !== 'committed' || result.outcome.type !== 'recurrence')
        throw new Error('missing recurrence outcome');
      expect(result.outcome.active.target).toEqual({
        type: 'subtask',
        ref: expectDefined(branch.subtasks[0]).ref,
      });
      expect(result.outcome.completed?.target).toEqual({
        type: 'subtask',
        ref: expectDefined(branch.subtasks[1]).ref,
      });
    });

    it('rejects an unsafe descendant date without changing bytes', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 9999-12-30\n' + '  - [ ] Child 📅 9999-12-31\n';
      const harness = await makeHarness(adapter, source);

      await expect(
        harness.repository.completeRecurrence(request(rootTarget(harness, source))),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-descendant-date', field: 'recurrence' }],
      });
      expect(await harness.read()).toBe(source);
    });

    it('fails closed before commit when final snapshot projection throws', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
      const harness = await makeHarness(adapter, source, { failFinalProjection: true });

      await expect(
        harness.repository.completeRecurrence(request(rootTarget(harness, source))),
      ).resolves.toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      expect(await harness.read()).toBe(source);
    });

    it('rejects stale and ambiguous roots without changing bytes', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
      const staleHarness = await makeHarness(adapter, source);
      const staleTarget = rootTarget(staleHarness, source);
      if (staleTarget.type !== 'task') throw new Error('missing root target');
      await staleHarness.repository.edit({
        type: 'patch',
        target: staleTarget,
        patch: { priority: { type: 'set', value: 'A' } },
      });
      const changed = await staleHarness.read();

      await expect(
        staleHarness.repository.completeRecurrence(request(staleTarget)),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await staleHarness.read()).toBe(changed);

      const duplicates = `${source}${source}`;
      const ambiguousHarness = await makeHarness(adapter, duplicates);
      const first = rootTarget(ambiguousHarness, duplicates);
      if (first.type !== 'task') throw new Error('missing root target');
      const ambiguous = { type: 'task' as const, ref: { ...first.ref, line: 99 } };
      await expect(
        ambiguousHarness.repository.completeRecurrence(request(ambiguous)),
      ).resolves.toMatchObject({
        type: 'ambiguous',
        candidates: [
          { root: { source: { line: 0 } }, target: { type: 'task' } },
          { root: { source: { line: 1 } }, target: { type: 'task' } },
        ],
      });
      expect(await ambiguousHarness.read()).toBe(duplicates);
    });

    it('makes a repeated request through the stale source ref conflict instead of duplicating', async () => {
      const source = '- [ ] Owner 🔁 every day\n';
      const harness = await makeHarness(adapter, source);
      const completion = request(rootTarget(harness, source), {
        addCreatedDate: false,
        addCompletionDate: false,
      });

      const first = await harness.repository.completeRecurrence(completion);
      expect(first).toMatchObject({
        type: 'committed',
        outcome: { type: 'recurrence' },
      });
      if (first.type !== 'committed' || first.outcome.type !== 'recurrence') {
        throw new Error('missing recurrence outcome');
      }
      const active = first.outcome.active.target;
      const afterFirst = await harness.read();
      await expect(harness.repository.completeRecurrence(completion)).resolves.toMatchObject({
        type: 'conflict',
      });
      expect(await harness.read()).toBe(afterFirst);
      expect(afterFirst.match(/🔁 every day/gu) ?? []).toHaveLength(2);

      await expect(
        harness.repository.completeRecurrence({ ...completion, target: active }),
      ).resolves.toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
    });

    it('rejects an old-session ref after restart while a freshly indexed ref succeeds', async () => {
      const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
      const beforeRestart = await makeHarness(adapter, source, { session: 'old-session' });
      const oldTarget = rootTarget(beforeRestart, source);
      const afterRestart = await makeHarness(adapter, source, { session: 'new-session' });

      await expect(
        afterRestart.repository.completeRecurrence(request(oldTarget)),
      ).resolves.toMatchObject({ type: 'conflict' });
      expect(await afterRestart.read()).toBe(source);
      await expect(
        afterRestart.repository.completeRecurrence(request(rootTarget(afterRestart, source))),
      ).resolves.toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
    });

    it('publishes a fresh active ref for byte-identical Delete without a vault event', async () => {
      const source = '- [ ] Owner 🔁 every day 🏁 delete\n';
      const harness = await makeHarness(adapter, source);
      const original = rootTarget(harness, source);
      if (original.type !== 'task') throw new Error('missing original root');
      let notifications = 0;
      harness.index.subscribe((event) => {
        if (event.type === 'changed') notifications += 1;
      });

      const result = await harness.repository.completeRecurrence(
        request(original, { addCreatedDate: false, addCompletionDate: false }),
      );
      await flushMicrotasks();

      expect(await harness.read()).toBe(source);
      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'recurrence' } });
      if (result.type !== 'committed' || result.outcome.type !== 'recurrence') {
        throw new Error('missing recurrence outcome');
      }
      expect(result.outcome.active.root.ref.revision).not.toBe(original.ref.revision);
      expect(harness.index.list()[0]?.ref).toEqual(result.outcome.active.root.ref);
      expect(notifications).toBe(1);
    });

    it('allows only one of two concurrent completions from the same consumed ref to commit', async () => {
      const source = '- [ ] Owner 🔁 every day\n';
      const harness = await makeHarness(adapter, source);
      const completion = request(rootTarget(harness, source), {
        addCreatedDate: false,
        addCompletionDate: false,
      });

      const results = await Promise.all([
        harness.repository.completeRecurrence(completion),
        harness.repository.completeRecurrence(completion),
      ]);

      expect(results.filter((result) => result.type === 'committed')).toHaveLength(1);
      expect(results.filter((result) => result.type === 'conflict')).toHaveLength(1);
    });

    it('uses one successor revision for an ordinary surviving-root edit and its installed index', async () => {
      const source = '- [ ] Owner\n';
      const harness = await makeHarness(adapter, source);
      const original = rootTarget(harness, source);
      if (original.type !== 'task') throw new Error('missing original root');

      const result = await harness.repository.edit({
        type: 'patch',
        target: original,
        patch: { priority: { type: 'set', value: 'A' } },
      });

      expect(result).toMatchObject({ type: 'committed', changed: true, outcome: { type: 'task' } });
      if (result.type !== 'committed' || result.outcome.type !== 'task') {
        throw new Error('missing task outcome');
      }
      expect(result.outcome.task.ref.revision).not.toBe(original.ref.revision);
      expect(harness.index.list()[0]?.ref).toEqual(result.outcome.task.ref);
    });

    it('uses one successor revision for a cross-file move destination and its installed index', async () => {
      const source = '- [ ] Owner\n';
      const destination = 'archive.md';
      const harness = await makeHarness(adapter, source, {
        extraFiles: { [destination]: '' },
      });
      const original = rootTarget(harness, source);
      if (original.type !== 'task') throw new Error('missing original root');

      const result = await harness.repository.move(original.ref, {
        filePath: destination,
        insertion: { type: 'append' },
      });

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'task' } });
      if (result.type !== 'committed' || result.outcome.type !== 'task') {
        throw new Error('missing moved task');
      }
      expect(result.outcome.task.ref.revision).not.toBe(original.ref.revision);
      expect(harness.index.list({ filePath: destination })[0]?.ref).toEqual(
        result.outcome.task.ref,
      );
      expect(harness.index.list({ filePath: path })).toEqual([]);
    });

    it('assigns an initial revision to creation and installs the same ref in the index', async () => {
      const harness = await makeHarness(adapter, '');

      const result = await harness.repository.create(
        { filePath: path, insertion: { type: 'append' } },
        { markdownBody: 'Created' },
      );

      expect(result).toMatchObject({ type: 'committed', outcome: { type: 'task' } });
      if (result.type !== 'committed' || result.outcome.type !== 'task') {
        throw new Error('missing created task');
      }
      expect(harness.authority.evidence(result.outcome.task.ref.revision)).toMatchObject({
        generation: '1',
      });
      expect(harness.index.list()[0]?.ref).toEqual(result.outcome.task.ref);
    });
  });
}

describe('Obsidian recurrence transaction boundary', () => {
  it('publishes the same ordinary-edit successor for an early event, return value, and final index', async () => {
    const source = '- [ ] Owner\n';
    const harness = await makeHarness('obsidian', source);
    const original = rootTarget(harness, source);
    if (original.type !== 'task') throw new Error('missing original root');
    const notifications: string[] = [];
    harness.index.subscribe((event) => {
      if (event.type === 'changed') {
        const revision = harness.index.list()[0]?.ref.revision;
        if (revision !== undefined) notifications.push(revision);
      }
    });
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [
          {
            task: ' ',
            parent: -1,
            position: { start: { line: 0 }, end: { line: 0 } },
          },
        ],
      } as CachedMetadata);
      await harness.app.vault.modify(file, candidate);
      return candidate;
    });

    const result = await harness.repository.edit({
      type: 'patch',
      target: original,
      patch: { priority: { type: 'set', value: 'A' } },
    });
    await flushMicrotasks();

    expect(result).toMatchObject({ type: 'committed', outcome: { type: 'task' } });
    if (result.type !== 'committed' || result.outcome.type !== 'task') {
      throw new Error('missing task outcome');
    }
    expect(notifications).toEqual([result.outcome.task.ref.revision]);
    expect(harness.index.list()[0]?.ref).toEqual(result.outcome.task.ref);
  });

  it('restores the consumed ref when an early ordinary-edit event precedes rejection', async () => {
    const source = '- [ ] Owner\n';
    const harness = await makeHarness('obsidian', source);
    const original = rootTarget(harness, source);
    if (original.type !== 'task') throw new Error('missing original root');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after edit observation');
    });

    await expect(
      harness.repository.edit({
        type: 'patch',
        target: original,
        patch: { priority: { type: 'set', value: 'A' } },
      }),
    ).resolves.toMatchObject({ type: 'io-error' });

    expect(await harness.read()).toBe(source);
    expect(harness.index.list()[0]?.ref).toEqual(original.ref);
    expect(harness.authority.observeTransition(path, source)?.roots ?? []).toEqual([]);
  });

  it('uses exactly one synchronous vault.process callback for one completion', async () => {
    const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
    const harness = await makeHarness('obsidian', source);
    const process = vi.spyOn(harness.app.vault, 'process');

    await harness.repository.completeRecurrence(request(rootTarget(harness, source)));

    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]?.[1].constructor.name).not.toBe('AsyncFunction');
  });

  it('keeps one logical notification when the vault event arrives after commit installation', async () => {
    const source = '- [ ] Owner 🔁 every day 🏁 delete\n';
    const harness = await makeHarness('obsidian', source);
    const notifications: string[] = [];
    harness.index.subscribe((event) => {
      if (event.type === 'changed')
        notifications.push(expectDefined(harness.index.list()[0]).ref.revision);
    });

    const result = await harness.repository.completeRecurrence(
      request(rootTarget(harness, source), {
        addCreatedDate: false,
        addCompletionDate: false,
      }),
    );
    const file = harness.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('missing task file');
    harness.fireChanged(file, source, {
      listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
    } as CachedMetadata);
    await flushMicrotasks();

    if (result.type !== 'committed' || result.outcome.type !== 'recurrence') {
      throw new Error('missing recurrence outcome');
    }
    expect(notifications).toEqual([result.outcome.active.root.ref.revision]);
    expect(harness.index.list()[0]?.ref).toEqual(result.outcome.active.root.ref);
  });

  it('aborts staging and reconciles authoritative bytes when an early event precedes rejection', async () => {
    const source = '- [ ] Owner 🔁 every day 🏁 delete\n';
    const harness = await makeHarness('obsidian', source);
    const original = rootTarget(harness, source);
    const completion = request(original, {
      addCreatedDate: false,
      addCompletionDate: false,
    });
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after observation');
    });

    await expect(harness.repository.completeRecurrence(completion)).resolves.toMatchObject({
      type: 'io-error',
    });

    expect(await harness.read()).toBe(source);
    expect(harness.index.list()[0]?.source.originalBlock).toBe(source.trimEnd());
    if (original.type !== 'task') throw new Error('missing original root');
    expect(harness.index.list()[0]?.ref).toEqual(original.ref);
    expect(harness.authority.observeTransition(path, source)?.roots ?? []).toEqual([]);
  });

  it('reconciles an early full-delete event when process rejects without a successor token', async () => {
    const source = '- [ ] Remove me\n  - [ ] Child\n';
    const harness = await makeHarness('obsidian', source);
    const initial = rootTarget(harness, source);
    if (initial.type !== 'task') throw new Error('missing task root');
    const advancedResult = await harness.repository.edit({
      type: 'patch',
      target: initial,
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (advancedResult.type !== 'committed' || advancedResult.outcome.type !== 'task') {
      throw new Error('missing advanced task');
    }
    const advanced = advancedResult.outcome.task;
    const advancedContent = await harness.read();
    expect(harness.authority.evidence(advanced.ref.revision)?.generation).not.toBe('0');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {});
      throw new Error('rejected after delete observation');
    });

    await expect(
      harness.repository.edit({ type: 'delete', ref: advanced.ref }),
    ).resolves.toMatchObject({ type: 'io-error' });
    await flushMicrotasks();

    expect(await harness.read()).toBe(advancedContent);
    expect(harness.index.list()).toHaveLength(1);
    expect(harness.index.list()[0]?.ref).toEqual(advanced.ref);
  });

  it('reconciles an early create event when process rejects without a successor token', async () => {
    const harness = await makeHarness('obsidian', '');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after create observation');
    });

    await expect(
      harness.repository.create(
        { filePath: path, insertion: { type: 'append' } },
        { markdownBody: 'Created' },
      ),
    ).resolves.toMatchObject({ type: 'io-error' });
    await flushMicrotasks();

    expect(await harness.read()).toBe('');
    expect(harness.index.list()).toEqual([]);
  });

  it('aborts and reconciles an early move-destination event when process rejects', async () => {
    const source = '- [ ] Move me\n';
    const destination = 'archive.md';
    const harness = await makeHarness('obsidian', source, {
      extraFiles: { [destination]: '' },
    });
    const target = rootTarget(harness, source);
    if (target.type !== 'task') throw new Error('missing task root');
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      harness.fireChanged(file, candidate, {
        listItems: [{ task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } }],
      } as CachedMetadata);
      throw new Error('rejected after move observation');
    });

    await expect(
      harness.repository.move(target.ref, {
        filePath: destination,
        insertion: { type: 'append' },
      }),
    ).resolves.toMatchObject({ type: 'io-error' });
    await flushMicrotasks();

    expect(harness.index.list({ filePath: path })[0]?.ref).toEqual(target.ref);
    expect(harness.index.list({ filePath: destination })).toEqual([]);
  });

  it('reconciles an early move-source delete event when removal rejects', async () => {
    const source = '- [ ] Move me\n';
    const destination = 'archive.md';
    const harness = await makeHarness('obsidian', source, {
      extraFiles: { [destination]: '' },
    });
    const initial = rootTarget(harness, source);
    if (initial.type !== 'task') throw new Error('missing task root');
    const advancedResult = await harness.repository.edit({
      type: 'patch',
      target: initial,
      patch: { priority: { type: 'set', value: 'A' } },
    });
    if (advancedResult.type !== 'committed' || advancedResult.outcome.type !== 'task') {
      throw new Error('missing advanced task');
    }
    const advanced = advancedResult.outcome.task;
    expect(harness.authority.evidence(advanced.ref.revision)?.generation).not.toBe('0');
    let processCount = 0;
    vi.spyOn(harness.app.vault, 'process').mockImplementation(async (file, transform) => {
      const current = await harness.app.vault.read(file);
      const candidate = transform(current);
      processCount += 1;
      if (processCount === 1) {
        await harness.app.vault.modify(file, candidate);
        return candidate;
      }
      harness.fireChanged(file, candidate, {});
      throw new Error('rejected after source delete observation');
    });

    const result = await harness.repository.move(advanced.ref, {
      filePath: destination,
      insertion: { type: 'append' },
    });
    expect(result).toMatchObject({ type: 'partial', operation: 'move' });
    await flushMicrotasks();

    if (result.type !== 'partial') throw new Error('missing partial move');
    expect(result.recovery.source).toEqual(advanced.ref);
    expect(harness.index.list({ filePath: path })[0]?.ref).toEqual(result.recovery.source);
    expect(harness.index.list({ filePath: destination })).toHaveLength(1);
  });

  it('maps an injected process failure without changing vault bytes', async () => {
    const source = '- [ ] Owner 🔁 every day 📅 2026-08-01\n';
    const harness = await makeHarness('obsidian', source);
    vi.spyOn(harness.app.vault, 'process').mockRejectedValue(new Error('disk unavailable'));

    await expect(
      harness.repository.completeRecurrence(request(rootTarget(harness, source))),
    ).resolves.toEqual({
      type: 'io-error',
      cause: 'process-error',
      path,
      contentState: 'unknown',
    });
    expect(await harness.read()).toBe(source);
  });
});

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} occurrence producers`, () => {
    it.each([false, true])(
      'restores tracking Undo bytes but invalidates occurrences (nested=%s)',
      async (nested) => {
        const source =
          '- [ ] Root\n  - 2026-08-01T10:00:00Z →\n  - [ ] Child\n    - 2026-08-01T11:00:00Z →\n    - [ ] Grandchild\n  - [ ] Sibling\n';
        const h = await makeHarness(adapter, source);
        try {
          const reads = h.index.integrationReads();
          reads.activateOccurrences();
          const changes: TaskAcceptedOccurrenceChange[] = [];
          reads.subscribe((event) => {
            if (event.type === 'accepted') changes.push(event.change);
          });
          const root = expectDefined(h.index.list()[0]);
          const node = nested ? expectDefined(root.subtasks[0]) : root;
          const target: TaskNodeRef = nested
            ? { type: 'subtask', ref: expectDefined(root.subtasks[0]).ref }
            : { type: 'task', ref: root.ref };
          const removed = await h.repository.edit({
            type: 'delete-time-entry',
            entry: timeEntryRef(target, expectDefined(node.timeEntries[0])),
          });
          expect(removed).toMatchObject({ type: 'committed', changed: true });
          if (removed.type !== 'committed' || removed.outcome.type !== 'task')
            throw new Error('Missing removal recovery');
          const recovery = expectDefined(removed.outcome.timeEntryRemovalRecovery);
          expect(changes.flatMap((change) => change.witnesses).map((value) => value.kind)).toEqual([
            'continued',
            'continued',
            'continued',
            'continued',
          ]);
          expect(changes.flatMap((change) => change.invalidated)).toEqual([]);
          const page = reads.page({}, 20);
          if (page.type !== 'ok') throw new Error('Missing current nodes');
          const predecessors = page.value.nodes.map((node) => node.address);
          changes.length = 0;
          expect(
            await h.repository.edit({ type: 'restore-time-entry', ...recovery }),
          ).toMatchObject({ type: 'committed', changed: true });
          expect(await h.read()).toBe(source);
          expect(changes.flatMap((change) => change.witnesses)).toEqual([]);
          expect(changes.flatMap((change) => change.invalidated)).toEqual(predecessors);
        } finally {
          h.index.destroy();
        }
      },
    );

    it('leaves Delete content unchanged when authority staging rejects', async () => {
      const source = '- [ ] Root 🏁 delete\n  - [ ] Child\n';
      const h = await makeHarness(adapter, source);
      try {
        h.index.integrationReads().activateOccurrences();
        vi.spyOn(h.authority, 'stage').mockReturnValue({ type: 'conflict' });
        const root = expectDefined(h.index.list()[0]);
        expect(
          await h.repository.edit({
            type: 'set-status',
            target: { type: 'task', ref: root.ref },
            symbol: 'x',
            stamp: localDate('2026-08-01'),
          }),
        ).toMatchObject({ type: 'conflict' });
        expect(await h.read()).toBe(source);
      } finally {
        h.index.destroy();
      }
    });

    it('continues deep nodes through field, comment and tracking edits', async () => {
      const h = await makeHarness(adapter, '- [ ] Root\n  - [ ] Child\n    - [ ] Grandchild\n');
      try {
        const reads = h.index.integrationReads();
        reads.activateOccurrences();
        const changes: TaskAcceptedOccurrenceChange[] = [];
        reads.subscribe((event) => {
          if (event.type === 'accepted') changes.push(event.change);
        });
        let root = expectDefined(h.index.list()[0]);
        const deep = expectDefined(expectDefined(root.subtasks[0]).subtasks[0]);
        expect(
          await h.repository.edit({
            type: 'set-status',
            target: { type: 'subtask', ref: deep.ref },
            symbol: 'x',
            stamp: localDate('2026-08-01'),
          }),
        ).toMatchObject({ type: 'committed' });
        root = expectDefined(h.index.list()[0]);
        expect(
          await h.repository.edit({
            type: 'add-comment',
            parent: { type: 'task', ref: root.ref },
            text: 'first\nsecond',
            stamp: atomDateTime('2026-08-01T10:00:00Z'),
          }),
        ).toMatchObject({ type: 'committed' });
        root = expectDefined(h.index.list()[0]);
        expect(
          await h.repository.edit({
            type: 'add-time-entry',
            parent: { type: 'task', ref: root.ref },
            stamp: atomDateTime('2026-08-01T10:00:00Z'),
          }),
        ).toMatchObject({ type: 'committed' });
        root = expectDefined(h.index.list()[0]);
        expect(
          await h.repository.edit({
            type: 'close-time-entry',
            entry: timeEntryRef(
              { type: 'task', ref: root.ref },
              expectDefined(root.timeEntries[0]),
            ),
            stamp: atomDateTime('2026-08-01T10:00:01Z'),
            endMs: Date.parse('2026-08-01T10:00:01Z'),
            minimumMs: 2000,
          }),
        ).toMatchObject({ type: 'committed' });
        expect(changes.filter((change) => change.witnesses.length > 0)).toHaveLength(4);
        for (const change of changes.filter((value) => value.witnesses.length > 0)) {
          expect(change.witnesses.map((value) => value.kind)).toEqual([
            'continued',
            'continued',
            'continued',
          ]);
          expect(change.invalidated).toEqual([]);
        }
      } finally {
        h.index.destroy();
      }
    });

    for (const nested of [false, true])
      for (const deletes of [false, true]) {
        const indent = nested ? '  ' : '';
        const history = deletes ? '' : `${indent}  - 2026-08-01T10:00:00Z →\n`;
        it.each(['before', 'after'] as const)(
          `witnesses every recurrence node nested=${nested} delete=${deletes} placement=%s`,
          async (placement) => {
            const selected = `${indent}- [ ] Repeat 🔁 every day${deletes ? ' 🏁 delete' : ''}\n${history}${indent}  - [ ] Child\n${indent}    - [ ] Grandchild\n`;
            const source = nested ? `- [ ] Container\n${selected}  - [ ] Sibling\n` : selected;
            const h = await makeHarness(adapter, source);
            try {
              const reads = h.index.integrationReads();
              reads.activateOccurrences();
              const changes: TaskAcceptedOccurrenceChange[] = [];
              reads.subscribe((event) => {
                if (event.type === 'accepted') changes.push(event.change);
              });
              const oldRoot = expectDefined(h.snapshots(source)[0]);
              const target: TaskNodeRef = nested
                ? { type: 'subtask', ref: expectDefined(oldRoot.subtasks[0]).ref }
                : { type: 'task', ref: oldRoot.ref };
              const result = await h.repository.completeRecurrence(
                request(target, { placement, addCreatedDate: false, addCompletionDate: false }),
              );
              expect(result.type).toBe('committed');
              const change = expectDefined(changes.find((value) => value.witnesses.length > 0));
              const allBefore = [...taskTreeNodes(oldRoot)];
              const recurringOffset = taskNodeSourceLine(target) - oldRoot.source.line;
              const selectedBefore = allBefore.filter(
                (value) => !nested || value.path[0] === oldRoot.subtasks[0],
              );
              expect(change.witnesses.filter((value) => value.kind === 'created')).toHaveLength(
                selectedBefore.length,
              );
              expect(change.witnesses.filter((value) => value.kind === 'removed')).toHaveLength(
                deletes ? selectedBefore.length : 0,
              );
              expect(change.witnesses.filter((value) => value.kind === 'continued')).toHaveLength(
                allBefore.length - (deletes ? selectedBefore.length : 0),
              );
              expect(change.invalidated).toEqual([]);
              if (result.type !== 'committed' || result.outcome.type !== 'recurrence')
                throw new Error('Missing recurrence');
              const active = result.outcome.active;
              expect(h.index.authoritySuccessor(oldRoot.ref)).toEqual(active.root.ref);
              const activeOffset = taskNodeSourceLine(active.target) - active.root.source.line;
              const activeOwnership = expectDefined(
                recurrenceOwnedSubtree(active.root.source.originalBlock, activeOffset),
              );
              const created = change.witnesses.filter((value) => value.kind === 'created');
              expect(created.map((value) => value.after.nodeOffset)).toEqual(
                activeOwnership.taskLines,
              );
              expect(
                created.every(
                  (value) =>
                    value.after.rootRevision === active.root.ref.revision &&
                    value.after.rootLine === active.root.source.line,
                ),
              ).toBe(true);
              const nextOffsets = new Set(activeOwnership.taskLines);
              expect(
                change.witnesses.some(
                  (value) =>
                    value.kind === 'continued' &&
                    value.after.rootRevision === active.root.ref.revision &&
                    nextOffsets.has(value.after.nodeOffset),
                ),
              ).toBe(false);

              expect(
                change.witnesses.some(
                  (value) =>
                    value.kind === 'continued' &&
                    value.before.rootRevision === oldRoot.ref.revision &&
                    value.before.nodeOffset === recurringOffset &&
                    value.after.rootRevision === active.root.ref.revision &&
                    value.after.nodeOffset === activeOffset,
                ),
              ).toBe(false);
              if (deletes) expect(await h.read()).toBe(source);
            } finally {
              h.index.destroy();
            }
          },
        );
      }
    it.each([false, true])('witnesses ordinary Delete descendants nested=%s', async (nested) => {
      const selected = '- [ ] Remove 🏁 delete\n  - [ ] Child\n';
      const source = nested
        ? `- [ ] Container\n${selected
            .split('\n')
            .filter(Boolean)
            .map((line) => `  ${line}\n`)
            .join('')}  - [ ] Sibling\n`
        : selected;
      const h = await makeHarness(adapter, source);
      try {
        const reads = h.index.integrationReads();
        reads.activateOccurrences();
        const changes: TaskAcceptedOccurrenceChange[] = [];
        reads.subscribe((event) => {
          if (event.type === 'accepted') changes.push(event.change);
        });
        const root = expectDefined(h.snapshots(source)[0]);
        const target: TaskNodeRef = nested
          ? { type: 'subtask', ref: expectDefined(root.subtasks[0]).ref }
          : { type: 'task', ref: root.ref };
        expect(
          await h.repository.edit({
            type: 'set-status',
            target,
            symbol: 'x',
            stamp: localDate('2026-08-01'),
          }),
        ).toMatchObject({ type: 'committed' });
        const change = expectDefined(changes.find((value) => value.witnesses.length > 0));
        expect(change.witnesses.filter((value) => value.kind === 'removed')).toHaveLength(2);
        expect(change.witnesses.filter((value) => value.kind === 'continued')).toHaveLength(
          nested ? 2 : 0,
        );
        expect(change.invalidated).toEqual([]);
      } finally {
        h.index.destroy();
      }
    });
  });
}
