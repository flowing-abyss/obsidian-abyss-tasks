import type * as ObsidianModule from 'obsidian';
import { Notice } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskNodeRef,
  TaskSnapshot,
  TimeEntryRef,
  TimeEntryRemovalRecovery,
} from '../src/tasks';
import { task, taskQueryApi } from './helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

// Import AFTER vi.mock
import { presentTaskCommandResult } from '../src/ui/taskCommandResult';
import {
  createTrackingActions,
  type TrackingActions,
} from '../src/ui/timeTracking/trackingActions';

const SHORT_ENTRY_NOTICE = 'Tracking under a minute was not saved';

const parent: TaskNodeRef = {
  type: 'task',
  ref: { filePath: 'a.md', line: 3, revision: 'r3' },
};

const entryRef: TimeEntryRef = {
  parent,
  relativeLine: 1,
  originalMarkdown: '- 2026-09-20T09:12:00+03:00 → 2026-09-20T10:32:00+03:00',
};

const recovery: TimeEntryRemovalRecovery = {
  parent,
  markdown: '  - 2026-09-20T09:12:00+03:00 → 2026-09-20T10:32:00+03:00',
  relativeLine: 1,
};

function okTask(extra: Record<string, unknown> = {}): TaskCommandResult {
  const snapshot: TaskSnapshot = task({ title: 'Tracked' });
  return { type: 'ok', outcome: { type: 'task', task: snapshot, ...extra }, changed: true };
}

interface Harness {
  readonly actions: TrackingActions;
  readonly commands: TaskCommand[];
  readonly report: ReturnType<typeof vi.fn>;
}

function harness(execute: (command: TaskCommand) => Promise<TaskCommandResult>): Harness {
  const commands: TaskCommand[] = [];
  const tasks: TaskApplicationApi = {
    queries: taskQueryApi(),
    execute: async (command) => {
      commands.push(command);
      return execute(command);
    },
  };
  const report = vi.fn();
  return { actions: createTrackingActions(tasks, report), commands, report };
}

function resolving(result: TaskCommandResult): () => Promise<TaskCommandResult> {
  return () => Promise.resolve(result);
}

describe('createTrackingActions', () => {
  beforeEach(() => {
    vi.mocked(Notice).mockClear();
  });

  it('starts tracking on the addressed node', async () => {
    const { actions, commands, report } = harness(resolving(okTask()));

    await actions.start(parent);

    expect(commands).toEqual([{ type: 'start-tracking', parent }]);
    expect(report).not.toHaveBeenCalled();
  });

  it('pauses the one active timer', async () => {
    const { actions, commands } = harness(
      resolving({ type: 'ok', outcome: { type: 'stopped' }, changed: true }),
    );

    await actions.pause();

    expect(commands).toEqual([{ type: 'stop-tracking' }]);
  });

  it('returns the recovery a removed entry leaves behind', async () => {
    const { actions, commands } = harness(
      resolving(okTask({ timeEntryRemovalRecovery: recovery })),
    );

    await expect(actions.remove(entryRef)).resolves.toEqual(recovery);
    expect(commands).toEqual([{ type: 'delete-time-entry', entry: entryRef }]);
  });

  it('has nothing to recover when the removal did not report a line', async () => {
    const { actions } = harness(resolving(okTask()));

    await expect(actions.remove(entryRef)).resolves.toBeUndefined();
  });

  it('restores a removed entry through the recovery shape', async () => {
    const { actions, commands } = harness(resolving(okTask()));

    await expect(actions.restore(recovery)).resolves.toMatchObject({ type: 'ok' });
    expect(commands).toEqual([{ type: 'restore-time-entry', ...recovery }]);
  });

  it('reports a failed restore instead of claiming success', async () => {
    const failure: TaskCommandResult = { type: 'not-found', target: parent };
    const { actions, report } = harness(resolving(failure));

    await expect(actions.restore(recovery)).resolves.toEqual(failure);
    expect(report).toHaveBeenCalledWith(failure);
  });

  it('reports every non-ok result through the supplied presenter', async () => {
    const failure: TaskCommandResult = { type: 'invalid', issues: [] };
    const { actions, report } = harness(resolving(failure));

    await actions.start(parent);

    expect(report).toHaveBeenCalledWith(failure);
  });

  it('converts a rejected command into a reported repository failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { actions, report } = harness(() => Promise.reject(new Error('vault exploded')));

    await expect(actions.start(parent)).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledWith({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    });
    expect(error).toHaveBeenCalled();
  });

  it('converts a rejected removal too, and reports no recovery', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { actions, report } = harness(() => Promise.reject(new Error('vault exploded')));

    await expect(actions.remove(entryRef)).resolves.toBeUndefined();
    await expect(actions.restore(recovery)).resolves.toMatchObject({ type: 'io-error' });

    expect(report).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('says a discarded sub-minute session was not saved when a stop discards it', async () => {
    const { actions, report } = harness(
      resolving({
        type: 'ok',
        outcome: { type: 'stopped', discardedShortEntry: true },
        changed: false,
      }),
    );

    await actions.pause();

    expect(Notice).toHaveBeenCalledWith(SHORT_ENTRY_NOTICE);
    expect(report).not.toHaveBeenCalled();
  });

  it('says the same when a start discards the session it replaced', async () => {
    const { actions } = harness(resolving(okTask({ discardedShortEntry: true })));

    await actions.start(parent);

    expect(Notice).toHaveBeenCalledWith(SHORT_ENTRY_NOTICE);
  });

  it('stays quiet when a session was long enough to keep', async () => {
    const { actions } = harness(
      resolving({ type: 'ok', outcome: { type: 'stopped' }, changed: true }),
    );

    await actions.pause();

    expect(Notice).not.toHaveBeenCalled();
  });
});

describe('presentTaskCommandResult for tracking outcomes', () => {
  beforeEach(() => {
    vi.mocked(Notice).mockClear();
  });

  it('stays silent on a successful stop', () => {
    presentTaskCommandResult({ type: 'ok', outcome: { type: 'stopped' }, changed: true });

    expect(Notice).not.toHaveBeenCalled();
  });

  it('shows the shared write failure message for a rejected tracking command', () => {
    presentTaskCommandResult({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    });

    expect(Notice).toHaveBeenCalledWith('Failed to update task. Please try again.');
  });
});
