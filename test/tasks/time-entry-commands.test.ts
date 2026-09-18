import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { TaskCommandResult } from '../../src/tasks/domain/commands';
import { timeEntryRef } from '../../src/tasks/domain/timeTracking';
import type { SubtaskSnapshot, TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  useRealMoment,
} from '../helpers';

useRealMoment();

const PATH = 'tasks.md';
const ROOT_ENTRY = '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00';
const ROOT_COMMENT = '    - 2026-09-17T12:00:00+03:00: a comment';
const CHILD_ENTRY = '        - 2026-09-18T11:00:00+03:00 → 2026-09-18T11:25:10+03:00';
const SOURCE = [
  '- [ ] Track me',
  ROOT_ENTRY,
  ROOT_COMMENT,
  '    - [ ] Subtask',
  CHILD_ENTRY,
  '',
].join('\n');

type Stack = ReturnType<typeof configuredTaskApplication> & { readonly app: App };

async function stackFor(authority: boolean): Promise<Stack> {
  const app = await createAppWithFiles({ [PATH]: SOURCE });
  const stack = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority });
  await stack.index.initialize();
  if (authority) stack.index.installCommittedContent(PATH, SOURCE);
  return { ...stack, app };
}

async function read(app: App): Promise<string> {
  const file = app.vault.getAbstractFileByPath(PATH);
  if (!(file instanceof TFile)) throw new Error(`missing ${PATH}`);
  return await app.vault.read(file);
}

function rootOf(stack: Stack): TaskSnapshot {
  return expectDefined(stack.index.list()[0]);
}

function childOf(root: TaskSnapshot): SubtaskSnapshot {
  return expectDefined(root.subtasks[0]);
}

function taskNode(root: TaskSnapshot): TaskNodeRef {
  return { type: 'task', ref: root.ref };
}

function subtaskNode(child: SubtaskSnapshot): TaskNodeRef {
  return { type: 'subtask', ref: child.ref };
}

function committedTask(
  result: TaskCommandResult,
): Extract<TaskCommandResult, { readonly type: 'ok' }>['outcome'] & { readonly type: 'task' } {
  if (result.type !== 'ok' || result.outcome.type !== 'task') {
    throw new Error(`expected a committed task outcome, saw ${result.type}`);
  }
  return result.outcome;
}

for (const authority of [false, true]) {
  describe(`time entry commands ${authority ? 'with' : 'without'} root authority`, () => {
    it('removes exactly the targeted root entry line and reports its recovery', async () => {
      const stack = await stackFor(authority);
      try {
        const root = rootOf(stack);
        const entry = expectDefined(root.timeEntries[0]);
        const result = await stack.tasks.execute({
          type: 'delete-time-entry',
          entry: timeEntryRef(taskNode(root), entry),
        });

        expect(result).toMatchObject({ type: 'ok', changed: true });
        const outcome = committedTask(result);
        expect(outcome.timeEntryRemovalRecovery).toEqual({
          parent: { type: 'task', ref: outcome.task.ref },
          markdown: ROOT_ENTRY,
          relativeLine: 1,
        });
        expect(outcome.task.timeEntries).toEqual([]);
        expect(await read(stack.app)).toBe(SOURCE.replace(`${ROOT_ENTRY}\n`, ''));
        expect(rootOf(stack).timeEntries).toEqual([]);

        const recovery = expectDefined(outcome.timeEntryRemovalRecovery);
        expect(Object.isFrozen(recovery)).toBe(true);
        expect(recovery.parent.ref).not.toBe(outcome.task.ref);
        expect(Object.isFrozen(outcome.task.ref)).toBe(false);
      } finally {
        stack.index.destroy();
      }
    });

    it('restores a removed entry to the identical file content', async () => {
      const stack = await stackFor(authority);
      try {
        const root = rootOf(stack);
        const deleted = committedTask(
          await stack.tasks.execute({
            type: 'delete-time-entry',
            entry: timeEntryRef(taskNode(root), expectDefined(root.timeEntries[0])),
          }),
        );
        const recovery = expectDefined(deleted.timeEntryRemovalRecovery);

        const restored = await stack.tasks.execute({ type: 'restore-time-entry', ...recovery });

        expect(restored).toMatchObject({ type: 'ok', changed: true });
        expect(await read(stack.app)).toBe(SOURCE);
      } finally {
        stack.index.destroy();
      }
    });

    it('removes an entry owned by a subtask and restores it in place', async () => {
      const stack = await stackFor(authority);
      try {
        const child = childOf(rootOf(stack));
        const deleted = committedTask(
          await stack.tasks.execute({
            type: 'delete-time-entry',
            entry: timeEntryRef(subtaskNode(child), expectDefined(child.timeEntries[0])),
          }),
        );

        expect(deleted.timeEntryRemovalRecovery).toEqual({
          parent: { type: 'subtask', ref: childOf(deleted.task).ref },
          markdown: CHILD_ENTRY,
          relativeLine: 1,
        });
        expect(childOf(deleted.task).timeEntries).toEqual([]);
        expect(await read(stack.app)).toBe(SOURCE.replace(`\n${CHILD_ENTRY}`, ''));

        const restored = await stack.tasks.execute({
          type: 'restore-time-entry',
          ...expectDefined(deleted.timeEntryRemovalRecovery),
        });
        expect(restored.type).toBe('ok');
        expect(await read(stack.app)).toBe(SOURCE);
      } finally {
        stack.index.destroy();
      }
    });

    it('refuses a stale entry ref exactly as it refuses a stale comment ref', async () => {
      const stack = await stackFor(authority);
      try {
        const root = rootOf(stack);
        const entry = expectDefined(root.timeEntries[0]);
        const comment = expectDefined(root.comments[0]);

        const staleEntry = await stack.tasks.execute({
          type: 'delete-time-entry',
          entry: {
            ...timeEntryRef(taskNode(root), entry),
            originalMarkdown: '    - 2026-01-01T00:00:00Z → 2026-01-01T01:00:00Z',
          },
        });
        const staleComment = await stack.tasks.execute({
          type: 'delete-comment',
          comment: { ...comment.ref, originalMarkdown: '    - 2026-01-01T00:00:00Z: gone' },
        });

        expect(staleEntry.type).toBe(staleComment.type);
        expect(staleEntry.type).toBe('conflict');
        expect(await read(stack.app)).toBe(SOURCE);
      } finally {
        stack.index.destroy();
      }
    });

    it('deletes an entry addressed through the root a previous command returned', async () => {
      const stack = await stackFor(authority);
      try {
        const fresh = committedTask(
          await stack.tasks.execute({
            type: 'patch',
            target: { type: 'task', ref: rootOf(stack).ref },
            patch: { priority: { type: 'set', value: 'A' } },
          }),
        ).task;
        const retitled = await read(stack.app);
        expect(retitled).not.toBe(SOURCE);

        const result = await stack.tasks.execute({
          type: 'delete-time-entry',
          entry: timeEntryRef(taskNode(fresh), expectDefined(fresh.timeEntries[0])),
        });

        expect(result).toMatchObject({ type: 'ok', changed: true });
        expect(committedTask(result).task.timeEntries).toEqual([]);
        expect(await read(stack.app)).toBe(retitled.replace(`${ROOT_ENTRY}\n`, ''));
      } finally {
        stack.index.destroy();
      }
    });

    it('rejects a multi-line restoration payload before any write', async () => {
      const stack = await stackFor(authority);
      try {
        const result = await stack.tasks.execute({
          type: 'restore-time-entry',
          parent: taskNode(rootOf(stack)),
          markdown: `${ROOT_ENTRY}\n${ROOT_ENTRY}`,
          relativeLine: 1,
        });

        expect(result).toEqual({
          type: 'invalid',
          issues: [{ code: 'invalid-target', field: 'time-entry' }],
        });
        expect(await read(stack.app)).toBe(SOURCE);
      } finally {
        stack.index.destroy();
      }
    });
  });
}
