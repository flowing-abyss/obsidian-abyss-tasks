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
