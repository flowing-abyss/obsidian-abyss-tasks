import { describe, expect, it } from 'vitest';
import { localDate, type TaskCommand } from '../src/tasks';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from '../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import { rebuildOwnedTaskSelection } from '../src/ui/ownedTaskSelection';
import { canonicalStatusCatalog, expectDefined } from './helpers';

function snapshot(markdown: string, revision: string) {
  const statuses = canonicalStatusCatalog();
  return expectDefined(
    projectTaskSnapshot({
      codec: new TaskMarkdownCodec(statuses),
      statusCatalog: statuses,
      filePath: 'tasks.md',
      lines: markdown.split('\n'),
      line: 0,
      exactBlock: markdown,
      ref: { filePath: 'tasks.md', line: 0, revision },
      presentation: { linkCount: 0 },
    }),
  );
}

const source = '- [ ] B\n  - [ ] B.1\n  - [ ] B.2\n    - > Before\n    - [ ] Deep\n  - [ ] B.3';
const before = snapshot(source, 'before');
const target = { type: 'subtask' as const, ref: expectDefined(before.subtasks[1]).ref };
const selection = [before, expectDefined(before.subtasks[1])];

describe('owned non-structural inspector selection', () => {
  it('retains a parent that becomes byte-identical to its sibling after deleting its only child', () => {
    const original = snapshot(
      '- [ ] Root\n  - [ ] Parent\n    - [ ] Only\n  - [ ] Parent',
      'before',
    );
    const parent = expectDefined(original.subtasks[0]);
    const child = expectDefined(parent.subtasks[0]);
    const current = snapshot('- [ ] Root\n  - [ ] Parent\n  - [ ] Parent', 'after');
    const result = rebuildOwnedTaskSelection(current, [original, parent], {
      type: 'delete-subtask',
      subtask: child.ref,
    });
    expect(result?.map((node) => node.title)).toEqual(['Root', 'Parent']);
    expect(result?.[1]?.ref).toEqual(current.subtasks[0]?.ref);
  });

  it.each(['delete-subtask', 'restore-subtask'] as const)(
    'refuses a concurrent parent block-id replacement during %s proof',
    (type) => {
      const original = snapshot('- [ ] Root\n  - [ ] Parent ^original\n    - [ ] Only', 'before');
      const parent = expectDefined(original.subtasks[0]);
      const child = expectDefined(parent.subtasks[0]);
      const removed = snapshot('- [ ] Root\n  - [ ] Parent ^original', 'removed');
      const removedParent = expectDefined(removed.subtasks[0]);
      const changedMarkdown =
        type === 'delete-subtask'
          ? '- [ ] Root\n  - [ ] Parent ^changed'
          : '- [ ] Root\n  - [ ] Parent ^changed\n    - [ ] Only';
      const changed = snapshot(changedMarkdown, 'after');
      const prior = type === 'delete-subtask' ? [original, parent] : [removed, removedParent];
      const restoredChild = changed.subtasks[0]?.subtasks[0];
      const command: TaskCommand =
        type === 'delete-subtask'
          ? { type, subtask: child.ref }
          : {
              type,
              parent: { type: 'subtask', ref: removedParent.ref },
              markdown: `${expectDefined(restoredChild).ref.originalBlock}\n`,
              placement: { relativeLine: expectDefined(restoredChild).ref.relativeLine },
            };
      expect(rebuildOwnedTaskSelection(changed, prior, command)).toBeUndefined();
    },
  );

  it.each([
    ['wrong removed child', source.replace('  - [ ] B.1\n', '')],
    ['extra deletion', source.replace('    - [ ] Deep\n', '').replace('  - [ ] B.1\n', '')],
    ['parent title', source.replace('    - [ ] Deep\n', '').replace('B.2', 'Changed')],
    ['sibling source', source.replace('    - [ ] Deep\n', '').replace('B.1', 'B.1 ^changed')],
  ])('refuses a %s during owned subtree deletion', (_label, markdown) => {
    const current = snapshot(markdown, 'after');
    expect(
      rebuildOwnedTaskSelection(current, selection, {
        type: 'delete-subtask',
        subtask: expectDefined(before.subtasks[1]?.subtasks[0]).ref,
      }),
    ).toBeUndefined();
  });

  it('does not identify an unrelated insertion as the pending Undo subtree', () => {
    const removed = snapshot(source.replace('    - [ ] Deep\n', ''), 'removed');
    const parent = expectDefined(removed.subtasks[1]);
    const current = snapshot(source.replace('Deep', 'Imposter'), 'restored');
    expect(
      rebuildOwnedTaskSelection(current, [removed, parent], {
        type: 'restore-subtask',
        parent: { type: 'subtask', ref: parent.ref },
        markdown: '    - [ ] Deep\n',
        placement: { relativeLine: 2 },
      }),
    ).toBeUndefined();
  });

  it.each(['blocks', 'blocked-by'] as const)(
    'retains the selected nested current after owned %s creation',
    (direction) => {
      const edge = direction === 'blocks' ? '🆔 new_id' : '⛔ new_id';
      const child = direction === 'blocks' ? '⛔ new_id' : '🆔 new_id';
      const current = snapshot(
        source
          .replace('B.2', `B.2 ${edge}`)
          .replace('  - [ ] B.3', `    - [ ] Added ${child}\n  - [ ] B.3`),
        'after',
      );
      const result = rebuildOwnedTaskSelection(current, selection, {
        type: 'create-dependency-subtask',
        current: target,
        direction,
        text: 'Added',
      });
      expect(result?.map((node) => node.title)).toEqual(['B', 'B.2']);
      expect(result?.[1]?.ref).toEqual(current.subtasks[1]?.ref);
    },
  );

  it('retains root selection after owned linked creation', () => {
    const current = snapshot(
      `${source.replace('[ ] B\n', '[ ] B ⛔ new_id\n')}\n  - [ ] Added 🆔 new_id`,
      'after',
    );
    expect(
      rebuildOwnedTaskSelection(current, [before], {
        type: 'create-dependency-subtask',
        current: { type: 'task', ref: before.ref },
        direction: 'blocked-by',
        text: 'Added',
      }),
    ).toEqual([current]);
  });

  it('preserves the exact duplicate current occurrence through its owned linked insertion', () => {
    const original = snapshot('- [ ] Root\n  - [ ] Same\n  - [ ] Same', 'before');
    const selected = expectDefined(original.subtasks[1]);
    const current = snapshot(
      '- [ ] Root\n  - [ ] Same\n  - [ ] Same ⛔ new_id\n    - [ ] Added 🆔 new_id',
      'after',
    );
    expect(
      rebuildOwnedTaskSelection(current, [original, selected], {
        type: 'create-dependency-subtask',
        current: { type: 'subtask', ref: selected.ref },
        direction: 'blocked-by',
        text: 'Added',
      })?.[1]?.ref,
    ).toEqual(current.subtasks[1]?.ref);
  });

  it.each([
    ['wrong text', 'Added', 'Other'],
    ['wrong child edge', '🆔 new_id', '🆔 other_id'],
    ['unrelated title', '[ ] B.1', '[ ] Edited'],
    ['unrelated source', '[ ] B.1', '[ ] B.1 ^changed'],
    ['extra child', '    - [ ] Added', '    - [ ] Extra\n    - [ ] Added'],
    ['removed child', '    - [ ] Deep\n', ''],
  ])('refuses %s during owned linked creation', (_label, from, to) => {
    const current = snapshot(
      source
        .replace('B.2', 'B.2 ⛔ new_id')
        .replace('  - [ ] B.3', '    - [ ] Added 🆔 new_id\n  - [ ] B.3')
        .replace(from, to),
      'after',
    );
    expect(
      rebuildOwnedTaskSelection(current, selection, {
        type: 'create-dependency-subtask',
        current: target,
        direction: 'blocked-by',
        text: 'Added',
      }),
    ).toBeUndefined();
  });
  it.each([
    {
      label: 'title',
      from: 'B.2',
      to: 'Renamed',
      command: {
        type: 'patch',
        target,
        patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
      },
    },
    {
      label: 'multiline description',
      from: '- > Before',
      to: '- > After\n    - > Second line',
      command: { type: 'set-description', target, text: 'After\nSecond line' },
    },
    {
      label: 'planning',
      from: 'B.2',
      to: 'B.2 📅 2026-09-09',
      command: {
        type: 'patch',
        target,
        patch: { due: { type: 'set', value: localDate('2026-09-09') } },
      },
    },
    {
      label: 'status',
      from: '[ ] B.2',
      to: '[/] B.2',
      command: { type: 'set-status', target, symbol: '/' },
    },
  ] satisfies Array<{ label: string; from: string; to: string; command: TaskCommand }>)(
    'retains the exact selected path after an owned $label edit',
    ({ from, to, command }) => {
      const current = snapshot(source.replace(from, to), 'after');
      const result = rebuildOwnedTaskSelection(current, selection, command);
      expect(result?.map((node) => node.title)).toEqual([
        'B',
        command.type === 'patch' && command.patch.markdownTitle !== undefined ? 'Renamed' : 'B.2',
      ]);
      expect(result?.[1]?.ref).toEqual(current.subtasks[1]?.ref);
    },
  );

  it.each(['title', 'description', 'planning', 'status'] as const)(
    'retains a deep selected target after an owned %s edit',
    (kind) => {
      const node = expectDefined(before.subtasks[1]?.subtasks[0]);
      const deep = { type: 'subtask' as const, ref: node.ref };
      const commands: Record<typeof kind, TaskCommand> = {
        title: {
          type: 'patch',
          target: deep,
          patch: { markdownTitle: { type: 'set', value: 'Edited deep' } },
        },
        description: { type: 'set-description', target: deep, text: 'New description' },
        planning: {
          type: 'patch',
          target: deep,
          patch: { due: { type: 'set', value: localDate('2026-09-09') } },
        },
        status: { type: 'set-status', target: deep, symbol: '/' },
      };
      const content = {
        title: '[ ] Edited deep',
        description: '[ ] Deep\n      - > New description',
        planning: '[ ] Deep 📅 2026-09-09',
        status: '[/] Deep',
      };
      const current = snapshot(source.replace('[ ] Deep', content[kind]), 'after');
      const result = rebuildOwnedTaskSelection(current, [...selection, node], commands[kind]);
      expect(result?.map((item) => item.title)).toEqual([
        'B',
        'B.2',
        kind === 'title' ? 'Edited deep' : 'Deep',
      ]);
      expect(result?.[2]?.ref).toEqual(current.subtasks[1]?.subtasks[0]?.ref);
    },
  );

  it.each([
    ['insertion', source.replace('  - [ ] B.1', '  - [ ] Inserted\n  - [ ] B.1')],
    ['deletion', source.replace('  - [ ] B.1\n', '')],
    [
      'reorder',
      source.replace('  - [ ] B.1\n', '').replace('  - [ ] B.3', '  - [ ] B.3\n  - [ ] B.1'),
    ],
    ['unowned field', source.replace('B.2', 'B.2 🆔 concurrent')],
    ['unowned content', source.replace('B.2', 'Other rename')],
    ['off-target source edit', source.replace('B.1', 'B.1 ^changed')],
  ])('refuses a concurrent %s while a title edit is pending', (_label, markdown) => {
    const current = snapshot(markdown.replace('B.2', 'Renamed'), 'after');
    expect(
      rebuildOwnedTaskSelection(current, selection, {
        type: 'patch',
        target,
        patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
      }),
    ).toBeUndefined();
  });

  it('refuses ambiguous duplicate siblings even when the selected position appears to match', () => {
    const markdown = '- [ ] B\n  - [ ] Same\n  - [ ] Same';
    const original = snapshot(markdown, 'before');
    const selected = expectDefined(original.subtasks[1]);
    const current = snapshot('- [ ] B\n  - [ ] Same\n  - [ ] Renamed', 'after');
    expect(
      rebuildOwnedTaskSelection(current, [original, selected], {
        type: 'patch',
        target: { type: 'subtask', ref: selected.ref },
        patch: { markdownTitle: { type: 'set', value: 'Renamed' } },
      }),
    ).toBeUndefined();
  });

  it('never grants structural commands the owned content-edit proof', () => {
    const current = snapshot(source.replace('  - [ ] B.3', '  - [ ] Added\n  - [ ] B.3'), 'after');
    expect(
      rebuildOwnedTaskSelection(current, selection, {
        type: 'add-subtask',
        parent: target,
        text: 'Added',
      }),
    ).toBeUndefined();
  });
});
