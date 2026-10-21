// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { localTime, type TaskCommand } from '../src/tasks';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from '../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import {
  proveOwnedRootPlanningReceipt,
  proveOwnedTaskSelection,
} from '../src/ui/ownedTaskSelection';
import { canonicalStatusCatalog, expectDefined } from './helpers';

function snapshot(markdown: string, line = 0, filePath = 'tasks.md') {
  const statuses = canonicalStatusCatalog();
  return expectDefined(
    projectTaskSnapshot({
      codec: new TaskMarkdownCodec(statuses),
      statusCatalog: statuses,
      filePath,
      lines: [...Array<string>(line).fill('# Header'), ...markdown.split('\n')],
      line,
      exactBlock: markdown,
      ref: { filePath, line, revision: `${line}:${markdown}` },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
}
const markdown = '- [ ] Root ⏰ 09:00 ⏱️ 1h ^opaque\n  - [ ] First\n  - [ ] Second';
const before = snapshot(markdown);
const changed = markdown.replace('09:00', '09:15');
const command: Extract<TaskCommand, { type: 'patch' }> = {
  type: 'patch',
  target: { type: 'task', ref: before.ref },
  patch: { time: { type: 'set', value: localTime('09:15') } },
};

describe('owned root planning relocation receipts', () => {
  it('preserves actual relocated refs without changing the ordinary selection proof', () => {
    const current = snapshot(changed, 3);
    expect(proveOwnedTaskSelection(current, [before], command)).toBeUndefined();
    const proof = expectDefined(proveOwnedRootPlanningReceipt(current, before, command));
    expect(proof.selection).toEqual([current]);
    expect(proof.successor(before)).toBe(current);
    expect(proof.successor(expectDefined(before.subtasks[1]))).toBe(current.subtasks[1]);
    expect(
      proof.nodeSuccessor({ type: 'task', ref: { ...before.ref, revision: 'foreign' } }),
    ).toBeUndefined();
  });
  it('accepts an unchanged clamped planning receipt after source relocation', () => {
    const current = snapshot(markdown, 2);
    expect(
      proveOwnedRootPlanningReceipt(current, before, {
        ...command,
        patch: { time: { type: 'set', value: localTime('09:00') } },
      }),
    ).toBeDefined();
  });
  it.each([
    ['missing requested value', markdown],
    ['priority', changed.replace('Root', 'Root 🔺')],
    ['title', changed.replace('Root', 'Foreign')],
    ['tag', changed.replace('Root', 'Root #foreign')],
    ['child change', changed.replace('First', 'Changed')],
    ['child removal', changed.replace('\n  - [ ] Second', '')],
    ['child insertion', `${changed}\n  - [ ] Third`],
    [
      'child reorder',
      changed
        .replace('First', 'Placeholder')
        .replace('Second', 'First')
        .replace('Placeholder', 'Second'),
    ],
    ['child opaque source', changed.replace('First', 'First ^foreign')],
  ])('rejects %s alongside a root line move', (_name, source) => {
    expect(proveOwnedRootPlanningReceipt(snapshot(source, 3), before, command)).toBeUndefined();
  });
  it('rejects a different file and unrelated original targets', () => {
    expect(
      proveOwnedRootPlanningReceipt(snapshot(changed, 3, 'other.md'), before, command),
    ).toBeUndefined();
    const current = snapshot(changed, 3);
    for (const ref of [
      { ...before.ref, line: 3 },
      { ...before.ref, revision: 'foreign' },
      { ...before.ref, filePath: 'other.md' },
    ]) {
      expect(
        proveOwnedRootPlanningReceipt(current, before, {
          ...command,
          target: { type: 'task', ref },
        }),
      ).toBeUndefined();
    }
    expect(
      proveOwnedRootPlanningReceipt(current, before, {
        ...command,
        target: { type: 'subtask', ref: expectDefined(before.subtasks[0]).ref },
      }),
    ).toBeUndefined();
  });
  it('does not authorize non-planning edits or commands', () => {
    const current = snapshot(changed, 3);
    expect(
      proveOwnedRootPlanningReceipt(current, before, {
        ...command,
        patch: { ...command.patch, markdownTitle: { type: 'set', value: 'Root' } },
      }),
    ).toBeUndefined();
    expect(
      proveOwnedRootPlanningReceipt(current, before, {
        type: 'toggle-completion',
        target: command.target,
      }),
    ).toBeUndefined();
  });
});
