import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { WorkNoteDeletionCoordinator } from '../src/projects/work-notes/WorkNoteDeletionCoordinator';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import type { TaskSnapshot } from '../src/tasks';
import { createAppWithFiles, task } from './helpers';

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
    'Work/A.md': '# A\n- [ ] one\n- [ ] two\n- [ ] three\n',
    'Work/B.md': '# B\n',
  });
  const tasks = {
    queries: {
      list: vi.fn().mockReturnValue(snapshots),
      rescan: vi.fn().mockResolvedValue({ type: 'settled', files: [] }),
    },
    execute: vi.fn().mockResolvedValue({ type: 'ok', changed: true }),
  };
  const workNotes = {
    list: () => [note(), note('Work/B.md')],
    get: (path: string) => [note(), note('Work/B.md')].find((entry) => entry.path === path),
  };
  const coordinator = new WorkNoteDeletionCoordinator(app, tasks as never, workNotes);
  return { app, tasks, workNotes, coordinator };
}

function expectedRevisions(tasks: readonly TaskSnapshot[]) {
  return tasks.map(({ ref }) => ({ ...ref }));
}

async function exists(app: App, path: string): Promise<boolean> {
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
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
      .mockResolvedValueOnce({ type: 'ok', changed: true })
      .mockResolvedValueOnce({ type: 'conflict', current: snapshots[1] });
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
    h.tasks.execute.mockResolvedValueOnce({ type: 'ok', changed: true }).mockResolvedValueOnce({
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

    h.tasks.execute.mockResolvedValue({ type: 'ok', changed: true });
    await expect(
      h.coordinator.delete({
        action: 'move-to-project',
        expectedTaskRevisions: expectedRevisions(snapshots),
        recovery: first.recovery,
      }),
    ).resolves.toMatchObject({ type: 'ok', movedTaskCount: 2 });
    expect(h.tasks.execute.mock.calls.filter(([command]) => command.ref.line === 1)).toHaveLength(
      1,
    );
    expect(h.tasks.execute.mock.calls.filter(([command]) => command.ref.line === 2)).toHaveLength(
      2,
    );
  });

  it('refuses an externally edited Task revision before moving and applies the same policy to Milestones', async () => {
    const current = ownedTask(1);
    const h = await fixture([current]);
    await h.coordinator.preview(note('Work/A.md', 'milestone'));

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
