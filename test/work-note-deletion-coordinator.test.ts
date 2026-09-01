import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkNoteDeletionCoordinator,
  type WorkNoteDeletionPort,
} from '../src/projects/work-notes/WorkNoteDeletionCoordinator';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import type { TaskCommandResult, TaskRef, TaskSnapshot } from '../src/tasks';
import { createAppWithFiles, deferred, task } from './helpers';

function note(path = 'Work/A.md', kind: WorkNoteSnapshot['kind'] = 'ordinary'): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    presetFingerprint: 'preset',
    kind,
    projectPath: 'Projects/P.md',
    statusId: 'active',
    rawStatus: 'Active',
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
  };
}

function ownedTask(index: number, path = 'Work/A.md'): TaskSnapshot {
  return task({
    title: `Task ${String(index)}`,
    ref: { filePath: path, line: index, revision: `revision-${String(index)}` },
    source: { filePath: path, line: index },
  });
}

async function fixture(
  snapshots: readonly TaskSnapshot[] = [ownedTask(1), ownedTask(2), ownedTask(3)],
) {
  const app = await createAppWithFiles({
    'Projects/P.md': '# Project\n',
    'Work/A.md': `# A\n${snapshots.map(({ source }) => source.originalBlock).join('\n')}${snapshots.length > 0 ? '\n' : ''}`,
    'Work/B.md': '# B\n',
  });
  const settleTask = async (command: {
    readonly type: string;
    readonly ref?: TaskRef;
  }): Promise<TaskCommandResult> => {
    const ref = command.ref;
    if ((command.type === 'move' || command.type === 'delete') && ref) {
      const snapshot = snapshots.find(
        ({ ref: candidate }) =>
          candidate.filePath === ref.filePath &&
          candidate.line === ref.line &&
          candidate.revision === ref.revision,
      );
      if (snapshot) {
        const file = await fileAt(app, snapshot.ref.filePath);
        const content = await app.vault.read(file);
        const block = snapshot.source.originalBlock;
        const next = content.includes(`${block}\n`)
          ? content.replace(`${block}\n`, '')
          : content.replace(`\n${block}`, '');
        await app.vault.modify(file, next);
      }
    }
    return {
      type: 'ok',
      changed: true,
      outcome: { type: 'deleted', ref: ref ?? ownedTask(0).ref },
    };
  };
  const tasks = {
    queries: {
      list: vi.fn().mockReturnValue(snapshots),
      rescan: vi.fn().mockResolvedValue({ type: 'settled', files: [] }),
    },
    execute: vi.fn(settleTask),
  };
  const workNotes = {
    list: () => [note(), note('Work/B.md')],
    get: (path: string) => [note(), note('Work/B.md')].find((entry) => entry.path === path),
  };
  const coordinator = new WorkNoteDeletionCoordinator(app, tasks as never, workNotes);
  return { app, tasks, workNotes, coordinator, settleTask };
}

function expectedRevisions(tasks: readonly TaskSnapshot[]) {
  return tasks.map(({ ref }) => ({ ...ref }));
}

async function exists(app: App, path: string): Promise<boolean> {
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

async function fileAt(app: App, path: string): Promise<TFile> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`Expected ${path}`);
  return file;
}

describe('WorkNoteDeletionCoordinator', () => {
  it('refuses a source removed since the rendered snapshot', async () => {
    const h = await fixture();
    h.workNotes.get = () => undefined;
    await expect(h.coordinator.preview(note())).resolves.toEqual({
      type: 'invalid',
      reason: 'missing-source',
    });
  });

  it('requires an explicit decision and cancel leaves the Work Note and every Task unchanged', async () => {
    const h = await fixture();

    await expect(h.coordinator.preview(note())).resolves.toEqual({
      type: 'decision-required',
      taskCount: 3,
    });
    await expect(
      h.coordinator.delete({ action: 'cancel', expectedTaskRevisions: [] }),
    ).resolves.toEqual({ type: 'cancelled' });
    expect(h.coordinator.pendingRecovery(note().path)).toBeUndefined();
    expect(h.coordinator.abandonRecovery(note().path)).toEqual({ type: 'ok' });
    expect(h.tasks.execute).not.toHaveBeenCalled();
    expect(await exists(h.app, note().path)).toBe(true);
  });

  it('keeps the note when no authoritative Task settlement barrier is available', async () => {
    const h = await fixture([]);
    await h.coordinator.preview(note());
    h.tasks.queries.rescan = undefined as never;

    await expect(
      h.coordinator.delete({ action: 'move-to-project', expectedTaskRevisions: [] }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'io-error' });
    expect(await exists(h.app, note().path)).toBe(true);
  });

  it('moves every complete guarded Task block to the owning Project before deleting the Work Note', async () => {
    const snapshots = [ownedTask(1), ownedTask(2), ownedTask(3)];
    const h = await fixture(snapshots);
    await h.coordinator.preview(note());

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 3 });
    expect(h.tasks.execute.mock.calls.map(([command]) => command)).toEqual(
      snapshots.map((snapshot) => ({
        type: 'move',
        ref: snapshot.ref,
        destination: { filePath: note().projectPath, insertion: { type: 'append' } },
      })),
    );
    expect(await exists(h.app, note().path)).toBe(false);
  });

  it('serializes concurrent deletion transactions across coordinators for the same vault note', async () => {
    const snapshots = [ownedTask(1)];
    const h = await fixture(snapshots);
    const release = deferred<void>();
    h.tasks.execute.mockImplementationOnce(async (command) => {
      await release.promise;
      return h.settleTask(command);
    });
    const peer = new WorkNoteDeletionCoordinator(h.app, h.tasks as never, h.workNotes);
    await Promise.all([h.coordinator.preview(note()), peer.preview(note())]);
    const command = {
      action: 'move-to-project' as const,
      expectedTaskRevisions: expectedRevisions(snapshots),
    };

    const first = h.coordinator.delete(command);
    const overlapping = peer.delete(command);
    await vi.waitFor(() => expect(h.tasks.execute).toHaveBeenCalledTimes(1));
    expect(await exists(h.app, note().path)).toBe(true);
    release.resolve();

    await expect(first).resolves.toMatchObject({ type: 'ok', movedTaskCount: 1 });
    await expect(overlapping).resolves.toMatchObject({ type: 'invalid-decision' });
    expect(h.tasks.execute).toHaveBeenCalledTimes(1);
    expect(await exists(h.app, note().path)).toBe(false);
  });

  it('invalidates an overlapping preview after a partial copy and allows only explicit cleanup recovery', async () => {
    const source = ownedTask(1);
    const copiedTask = ownedTask(8, 'Projects/P.md');
    const h = await fixture([source]);
    const peer = new WorkNoteDeletionCoordinator(h.app, h.tasks as never, h.workNotes);
    const partialMove = deferred<TaskCommandResult>();
    h.tasks.execute.mockImplementationOnce(() => partialMove.promise);
    await h.coordinator.preview(note());
    const command = {
      action: 'move-to-project' as const,
      expectedTaskRevisions: expectedRevisions([source]),
    };

    const first = h.coordinator.delete(command);
    await vi.waitFor(() => expect(h.tasks.execute).toHaveBeenCalledOnce());
    await peer.preview(note());
    const overlapping = peer.delete(command);
    partialMove.resolve({
      type: 'partial',
      operation: 'move',
      recovery: {
        source: source.ref,
        targetPath: 'Projects/P.md',
        copiedTask,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    });
    const firstResult = await first;
    if (firstResult.type !== 'partial') throw new Error('Expected recovery');
    await expect(overlapping).resolves.toMatchObject({ type: 'invalid-decision' });
    expect(h.tasks.execute).toHaveBeenCalledOnce();

    h.tasks.queries.list.mockImplementation((query?: { filePath?: string }) =>
      query?.filePath === 'Projects/P.md' ? [copiedTask] : [source],
    );
    h.tasks.execute.mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'deleted', ref: source.ref },
    });
    const failedCleanup = await h.coordinator.delete({
      ...command,
      recovery: firstResult.recovery,
    });
    expect(failedCleanup).toMatchObject({
      type: 'partial',
      recovery: { copiedSourceRemains: [{ source: source.ref }] },
    });
    if (failedCleanup.type !== 'partial') throw new Error('Expected cleanup recovery');
    await peer.preview(note());
    await expect(peer.delete(command)).resolves.toMatchObject({ type: 'invalid-decision' });
    expect(h.tasks.execute).toHaveBeenCalledTimes(2);

    h.tasks.execute.mockImplementation(h.settleTask);
    await expect(
      h.coordinator.delete({ ...command, recovery: failedCleanup.recovery }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 1 });
    expect(h.tasks.execute.mock.calls.map(([executed]) => executed.type)).toEqual([
      'move',
      'delete',
      'delete',
    ]);
  });

  it('refuses an ok command that did not remove the exact guarded root block', async () => {
    const snapshots = [ownedTask(1)];
    const h = await fixture(snapshots);
    h.tasks.execute.mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'deleted', ref: snapshots[0]!.ref },
    });
    await h.coordinator.preview(note());

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(await exists(h.app, note().path)).toBe(true);
  });

  it('uses the guarded source line to settle duplicate identical complete root blocks', async () => {
    const snapshots = [
      task({
        title: 'same',
        ref: { filePath: note().path, line: 1, revision: 'same-1' },
        source: { filePath: note().path, line: 1 },
      }),
      task({
        title: 'same',
        ref: { filePath: note().path, line: 2, revision: 'same-2' },
        source: { filePath: note().path, line: 2 },
      }),
    ];
    const h = await fixture(snapshots);
    await h.coordinator.preview(note());

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 2 });
    expect(h.tasks.execute).toHaveBeenCalledTimes(2);
  });

  it('tracks cumulative line shifts across separated identical roots', async () => {
    const snapshots = [1, 3, 5].map((line, index) =>
      task({
        title: 'same',
        ref: { filePath: note().path, line, revision: `same-${String(index + 1)}` },
        source: { filePath: note().path, line },
      }),
    );
    const h = await fixture(snapshots);
    const file = await fileAt(h.app, note().path);
    await h.app.vault.modify(
      file,
      '# A\n- [ ] same\nprose one\n- [ ] same\nprose two\n- [ ] same\n',
    );
    await h.coordinator.preview(note());

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 3 });
    expect(h.tasks.execute).toHaveBeenCalledTimes(3);
  });

  it('moves to a selected same-Project Work Note and rejects invalid destinations', async () => {
    const snapshots = [ownedTask(1)];
    const h = await fixture(snapshots);
    await h.coordinator.preview(note());

    await expect(
      h.coordinator.delete({
        action: 'move-to-work-note',
        destinationWorkNotePath: 'Work/Missing.md',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({ type: 'invalid-decision' });
    await expect(
      h.coordinator.delete({
        action: 'move-to-work-note',
        destinationWorkNotePath: 'Work/B.md',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({ type: 'ok' });
    expect(h.tasks.execute).toHaveBeenCalledWith({
      type: 'move',
      ref: snapshots[0]!.ref,
      destination: { filePath: 'Work/B.md', insertion: { type: 'append' } },
    });
  });

  it('returns structured partial recovery after conflict and never deletes the source note', async () => {
    const snapshots = [ownedTask(1), ownedTask(2), ownedTask(3)];
    const h = await fixture(snapshots);
    h.tasks.execute
      .mockImplementationOnce(h.settleTask)
      .mockResolvedValueOnce({ type: 'conflict', current: snapshots[1]! });
    await h.coordinator.preview(note());

    const result = await h.coordinator.delete({
      action: 'move-to-project',
      expectedTaskRevisions: expectedRevisions(snapshots),
    });
    expect(result).toMatchObject({
      type: 'partial',
      reason: 'external-edit',
      recovery: { settledTaskCount: 1, remainingTaskCount: 2 },
    });
    expect(await exists(h.app, note().path)).toBe(true);
  });

  it('restarts from recovery without replaying settled moves and reports I/O state precisely', async () => {
    const snapshots = [ownedTask(1), ownedTask(2)];
    const h = await fixture(snapshots);
    h.tasks.execute.mockImplementationOnce(h.settleTask).mockResolvedValueOnce({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unchanged',
    });
    await h.coordinator.preview(note());
    const first = await h.coordinator.delete({
      action: 'move-to-project',
      expectedTaskRevisions: expectedRevisions(snapshots),
    });
    expect(first).toMatchObject({ type: 'partial', reason: 'io-error' });
    if (first.type !== 'partial') throw new Error('Expected recovery');

    h.tasks.execute.mockImplementation(h.settleTask);
    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 2 });
    expect(h.tasks.execute.mock.calls.filter(([command]) => command.ref?.line === 1)).toHaveLength(
      1,
    );
    expect(h.tasks.execute.mock.calls.filter(([command]) => command.ref?.line === 2)).toHaveLength(
      2,
    );
  });

  it('refuses an externally edited Task revision before moving and applies the same policy to Milestones', async () => {
    const current = ownedTask(1);
    const h = await fixture([current]);
    const milestone = note('Work/A.md', 'milestone');
    h.workNotes.get = () => milestone;
    await h.coordinator.preview(milestone);

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: [{ ...current.ref, revision: 'stale' }],
      }),
    ).resolves.toMatchObject({
      type: 'partial',
      reason: 'external-edit',
      recovery: { settledTaskCount: 0, remainingTaskCount: 1 },
    });
    expect(h.tasks.execute).not.toHaveBeenCalled();
    expect(await exists(h.app, 'Work/A.md')).toBe(true);
  });

  it('records target-copied-source-remains and restarts by deleting the source without recopying', async () => {
    const source = ownedTask(1);
    const copiedTask = ownedTask(8, 'Projects/P.md');
    const h = await fixture([source]);
    h.tasks.queries.list.mockImplementation((query?: { filePath?: string }) =>
      query?.filePath === 'Projects/P.md' ? [copiedTask] : [source],
    );
    h.tasks.execute.mockResolvedValueOnce({
      type: 'partial',
      operation: 'move',
      recovery: {
        source: source.ref,
        targetPath: 'Projects/P.md',
        copiedTask,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    });
    await h.coordinator.preview(note());

    const first = await h.coordinator.delete({
      action: 'move-to-project',
      expectedTaskRevisions: expectedRevisions([source]),
    });
    expect(first).toMatchObject({
      type: 'partial',
      recovery: {
        copiedSourceRemains: [
          { state: 'target-copied-source-remains', targetPath: 'Projects/P.md' },
        ],
      },
    });
    if (first.type !== 'partial') throw new Error('Expected recovery');

    h.tasks.execute.mockImplementation(h.settleTask);
    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 1 });
    expect(h.tasks.execute.mock.calls.map(([command]) => command.type)).toEqual(['move', 'delete']);
  });

  it('retains copied-source recovery across destination validation failures and resumes without recopying', async () => {
    const source = ownedTask(1);
    const copiedTask = ownedTask(8, 'Work/B.md');
    const h = await fixture([source]);
    h.tasks.queries.list.mockImplementation((query?: { filePath?: string }) =>
      query?.filePath === 'Work/B.md' ? [copiedTask] : [source],
    );
    h.tasks.execute.mockResolvedValueOnce({
      type: 'partial',
      operation: 'move',
      recovery: {
        source: source.ref,
        targetPath: 'Work/B.md',
        copiedTask,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    });
    await h.coordinator.preview(note());

    const first = await h.coordinator.delete({
      action: 'move-to-work-note',
      destinationWorkNotePath: 'Work/B.md',
      expectedTaskRevisions: expectedRevisions([source]),
    });
    if (first.type !== 'partial') throw new Error('Expected recovery');
    expect(h.coordinator.pendingRecovery(note().path)).toEqual(first.recovery);
    expect(h.coordinator.abandonRecovery(note().path)).toEqual({
      type: 'blocked',
      reason: 'source-cleanup-required',
    });

    h.workNotes.get = (path: string) => (path === note().path ? note() : undefined);
    await expect(
      h.coordinator.delete({
        action: 'move-to-work-note',
        destinationWorkNotePath: 'Work/B.md',
        expectedTaskRevisions: expectedRevisions([source]),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'invalid-decision' });
    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'invalid-decision' });
    expect(h.coordinator.pendingRecovery(note().path)).toEqual(first.recovery);
    expect(h.tasks.execute).toHaveBeenCalledTimes(1);

    h.workNotes.get = (path: string) =>
      [note(), note('Work/B.md')].find((entry) => entry.path === path);
    h.tasks.execute.mockImplementation(h.settleTask);
    const reacquired = h.coordinator.pendingRecovery(note().path);
    if (!reacquired) throw new Error('Expected coordinator-owned recovery');
    await expect(
      h.coordinator.delete({
        action: 'move-to-work-note',
        destinationWorkNotePath: 'Work/B.md',
        expectedTaskRevisions: [...reacquired.settledTaskRefs, ...reacquired.remainingTaskRefs],
        recovery: reacquired,
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 1 });
    expect(h.tasks.execute.mock.calls.map(([command]) => command.type)).toEqual(['move', 'delete']);
    expect(h.coordinator.pendingRecovery(note().path)).toBeUndefined();
    expect(h.coordinator.abandonRecovery(note().path)).toEqual({ type: 'ok' });
  });

  it('retains copied-source recovery when source observation rejects during cleanup', async () => {
    const source = ownedTask(1);
    const copiedTask = ownedTask(8, 'Projects/P.md');
    const h = await fixture([source]);
    h.tasks.queries.list.mockImplementation((query?: { filePath?: string }) =>
      query?.filePath === 'Projects/P.md' ? [copiedTask] : [source],
    );
    h.tasks.execute.mockResolvedValueOnce({
      type: 'partial',
      operation: 'move',
      recovery: {
        source: source.ref,
        targetPath: 'Projects/P.md',
        copiedTask,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    });
    await h.coordinator.preview(note());
    const first = await h.coordinator.delete({
      action: 'move-to-project',
      expectedTaskRevisions: expectedRevisions([source]),
    });
    if (first.type !== 'partial') throw new Error('Expected recovery');

    const read = h.app.vault.read.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'read')
      .mockImplementationOnce(read)
      .mockRejectedValueOnce(new Error('injected read failure'));
    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
        recovery: first.recovery,
      }),
    ).rejects.toThrow('injected read failure');
    expect(h.coordinator.pendingRecovery(note().path)).toEqual(first.recovery);
    expect(h.coordinator.abandonRecovery(note().path)).toEqual({
      type: 'blocked',
      reason: 'source-cleanup-required',
    });

    const reopened = new WorkNoteDeletionCoordinator(h.app, h.tasks as never, h.workNotes);
    await reopened.preview(note());
    expect(reopened.pendingRecovery(note().path)).toEqual(first.recovery);
    await expect(
      reopened.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
      }),
    ).resolves.toMatchObject({ type: 'invalid-decision' });
    expect(h.tasks.execute).toHaveBeenCalledTimes(1);

    h.tasks.execute.mockImplementation(h.settleTask);
    const recovery = reopened.pendingRecovery(note().path);
    if (!recovery) throw new Error('Expected coordinator-owned recovery');
    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
        recovery,
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 1 });
    expect(h.tasks.execute.mock.calls.map(([command]) => command.type)).toEqual(['move', 'delete']);
    expect(h.coordinator.pendingRecovery(note().path)).toBeUndefined();
  });

  it('restarts a later copied-source-remains move using its stable preview Task identity', async () => {
    const firstTask = ownedTask(1);
    const secondTask = ownedTask(2);
    const copiedTask = ownedTask(8, 'Projects/P.md');
    const rebasedSecond = task({
      ...secondTask,
      ref: { ...secondTask.ref, line: 1, revision: 'rebased-second' },
      source: { ...secondTask.source, line: 1 },
    });
    const h = await fixture([firstTask, secondTask]);
    h.tasks.execute.mockImplementationOnce(h.settleTask).mockResolvedValueOnce({
      type: 'partial',
      operation: 'move',
      recovery: {
        source: rebasedSecond.ref,
        targetPath: 'Projects/P.md',
        copiedTask,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    });
    await h.coordinator.preview(note());
    const first = await h.coordinator.delete({
      action: 'move-to-project',
      expectedTaskRevisions: expectedRevisions([firstTask, secondTask]),
    });
    if (first.type !== 'partial') throw new Error('Expected recovery');
    let sourcePresent = true;
    h.tasks.queries.list.mockImplementation((query?: { filePath?: string }) => {
      if (query?.filePath === 'Projects/P.md') return [copiedTask];
      return sourcePresent ? [rebasedSecond] : [];
    });
    h.tasks.execute.mockImplementation(async (command) => {
      if (command.type !== 'delete') throw new Error('Recovery must not recopy the Task');
      sourcePresent = false;
      const file = await fileAt(h.app, note().path);
      await h.app.vault.modify(
        file,
        (await h.app.vault.read(file)).replace(`${secondTask.source.originalBlock}\n`, ''),
      );
      return {
        type: 'ok',
        changed: true,
        outcome: { type: 'deleted', ref: rebasedSecond.ref },
      };
    });

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([firstTask, secondTask]),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 2 });
    expect(h.tasks.execute.mock.calls.map(([command]) => command.type)).toEqual([
      'move',
      'move',
      'delete',
    ]);
  });

  it('rejects a recovery restart when prose changed after the partial settlement', async () => {
    const source = ownedTask(1);
    const copiedTask = ownedTask(8, 'Projects/P.md');
    const h = await fixture([source]);
    h.tasks.queries.list.mockImplementation((query?: { filePath?: string }) =>
      query?.filePath === 'Projects/P.md' ? [copiedTask] : [source],
    );
    h.tasks.execute.mockResolvedValueOnce({
      type: 'partial',
      operation: 'move',
      recovery: {
        source: source.ref,
        targetPath: 'Projects/P.md',
        copiedTask,
        state: 'target-copied-source-remains',
        cause: 'io-error',
      },
    });
    await h.coordinator.preview(note());
    const first = await h.coordinator.delete({
      action: 'move-to-project',
      expectedTaskRevisions: expectedRevisions([source]),
    });
    if (first.type !== 'partial') throw new Error('Expected recovery');
    const file = await fileAt(h.app, note().path);
    await h.app.vault.modify(file, `${await h.app.vault.read(file)}\nuser prose`);

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(h.tasks.execute).toHaveBeenCalledTimes(1);
    expect(await h.app.vault.read(await fileAt(h.app, note().path))).toContain('user prose');
  });

  it('leaves an externally edited source in place when it changes after final rescan before quarantine', async () => {
    const h = await fixture([]);
    const observe = async (path: string) => {
      const file = h.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      return {
        path,
        content: await h.app.vault.read(file),
        mtime: file.stat.mtime,
        size: file.stat.size,
      };
    };
    const deletion: WorkNoteDeletionPort = {
      observe,
      quarantine: async (expected) => {
        const file = h.app.vault.getAbstractFileByPath(expected.path);
        if (file instanceof TFile) await h.app.vault.modify(file, `${expected.content}\nexternal`);
        return { type: 'conflict' };
      },
      remove: vi.fn(),
      restore: vi.fn(),
    };
    const coordinator = new WorkNoteDeletionCoordinator(
      h.app,
      h.tasks as never,
      h.workNotes,
      deletion,
    );
    await coordinator.preview(note());

    await expect(
      coordinator.delete({ action: 'move-to-project', expectedTaskRevisions: [] }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(await exists(h.app, note().path)).toBe(true);
    expect(await h.app.vault.read(await fileAt(h.app, note().path))).toContain('external');
  });

  it('keeps prose added by the settlement rescan instead of accepting it as the deletion baseline', async () => {
    const h = await fixture([]);
    await h.coordinator.preview(note());
    h.tasks.queries.rescan.mockImplementation(async () => {
      const file = await fileAt(h.app, note().path);
      await h.app.vault.modify(file, `${await h.app.vault.read(file)}\nrescan prose`);
      return { type: 'settled', files: [] };
    });

    await expect(
      h.coordinator.delete({ action: 'move-to-project', expectedTaskRevisions: [] }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(await h.app.vault.read(await fileAt(h.app, note().path))).toContain('rescan prose');
  });

  it('rejects prose edited while a successful production-style Task move is awaited', async () => {
    const source = task({
      title: 'one',
      ref: { filePath: note().path, line: 1, revision: 'one-revision' },
      source: {
        filePath: note().path,
        line: 1,
        originalMarkdown: '- [ ] one',
        originalBlock: '- [ ] one',
      },
    });
    const h = await fixture([source]);
    h.tasks.execute.mockImplementation(async () => {
      const file = await fileAt(h.app, note().path);
      const current = await h.app.vault.read(file);
      await h.app.vault.modify(file, `${current.replace('- [ ] one\n', '')}\nuser prose`);
      return {
        type: 'ok',
        changed: true,
        outcome: { type: 'deleted', ref: source.ref },
      };
    });
    await h.coordinator.preview(note());

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions([source]),
      }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(await h.app.vault.read(await fileAt(h.app, note().path))).toContain('user prose');
  });

  it('restores a source edited in the production observe-to-quarantine rename window', async () => {
    const h = await fixture([]);
    await h.coordinator.preview(note());
    const rename = h.app.vault.rename.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'rename').mockImplementation(async (file, path) => {
      if (file instanceof TFile && file.path === note().path) {
        await h.app.vault.modify(file, `${await h.app.vault.read(file)}\nrename-window prose`);
      }
      await rename(file, path);
    });

    await expect(
      h.coordinator.delete({ action: 'move-to-project', expectedTaskRevisions: [] }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(await h.app.vault.read(await fileAt(h.app, note().path))).toContain(
      'rename-window prose',
    );
  });

  it('keeps the note when an expected Task disappears before deletion', async () => {
    const snapshots = [ownedTask(1), ownedTask(2)];
    const h = await fixture(snapshots);
    await h.coordinator.preview(note());
    h.tasks.queries.list.mockReturnValue([snapshots[0]]);

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({
      type: 'partial',
      reason: 'external-edit',
      recovery: { settledTaskCount: 0, remainingTaskCount: 2 },
    });
    expect(h.tasks.execute).not.toHaveBeenCalled();
    expect(await exists(h.app, note().path)).toBe(true);
  });

  it('rejects any raw note edit after preview before beginning Task settlement', async () => {
    const h = await fixture([]);
    await h.coordinator.preview(note());
    const file = await fileAt(h.app, note().path);
    await h.app.vault.modify(file, `${await h.app.vault.read(file)}\nexternal body edit`);

    await expect(
      h.coordinator.delete({ action: 'move-to-project', expectedTaskRevisions: [] }),
    ).resolves.toMatchObject({ type: 'partial', reason: 'external-edit' });
    expect(h.tasks.execute).not.toHaveBeenCalled();
    expect(await exists(h.app, note().path)).toBe(true);
  });

  it('rechecks source Tasks after every guarded move settles and before trashing the note', async () => {
    const snapshots = [ownedTask(1)];
    const added = ownedTask(2);
    const h = await fixture(snapshots);
    await h.coordinator.preview(note());
    h.tasks.queries.list.mockReturnValueOnce(snapshots).mockReturnValueOnce([...snapshots, added]);

    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
      }),
    ).resolves.toMatchObject({
      type: 'partial',
      reason: 'external-edit',
      recovery: { settledTaskCount: 1, remainingTaskCount: 1 },
    });
    expect(await exists(h.app, note().path)).toBe(true);
  });
});
