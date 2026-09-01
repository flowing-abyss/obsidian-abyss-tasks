import { describe, expect, it, vi } from 'vitest';
import {
  MilestoneCommandAdapter,
  createTaskInWorkNote,
  moveTaskToWorkNote,
} from '../src/projects/work-notes/MilestoneCommandAdapter';
import type {
  RelationWriteCommand,
  WorkNoteObservedFields,
  WorkNoteRangeObservation,
  WorkNoteSnapshot,
} from '../src/projects/work-notes/types';
import { task } from './helpers';

const milestone: WorkNoteSnapshot = {
  path: 'Work/Milestone.md',
  presetRevision: 4,
  presetFingerprint: 'preset-4',
  kind: 'milestone',
  projectPath: 'Projects/P.md',
  statusId: 'active',
  rawStatus: 'Active',
  writableStatusShape: true,
  range: {},
  blockedByPaths: [],
  relatedPaths: [],
  diagnostics: [],
};

const ordinary: WorkNoteSnapshot = {
  ...milestone,
  path: 'Work/Research.md',
  kind: 'ordinary',
};

const observed: WorkNoteObservedFields = {
  path: milestone.path,
  presetRevision: milestone.presetRevision,
  presetFingerprint: milestone.presetFingerprint,
  projectPath: milestone.projectPath,
  kind: 'milestone',
  fields: {},
};

function fixture() {
  const tasks = { execute: vi.fn().mockResolvedValue({ type: 'ok', changed: true }) };
  const workNotes = {
    create: vi.fn().mockResolvedValue({ type: 'ok', path: milestone.path }),
    observe: vi.fn().mockReturnValue(observed),
    observeRange: vi.fn().mockReturnValue({ observed }),
    setStatus: vi.fn().mockResolvedValue({ type: 'ok', path: milestone.path }),
    setRange: vi.fn().mockResolvedValue({ type: 'ok', path: milestone.path }),
    setPriority: vi.fn().mockResolvedValue({ type: 'ok', path: milestone.path }),
    setDescription: vi.fn().mockResolvedValue({ type: 'ok', path: milestone.path }),
  };
  const relations = {
    setMilestone: vi.fn().mockResolvedValue({ type: 'ok', path: ordinary.path }),
    clearMilestone: vi.fn(),
    addRelated: vi.fn(),
    removeRelated: vi.fn(),
    addBlockedBy: vi.fn(),
    removeBlockedBy: vi.fn(),
  };
  const open = vi.fn();
  const rename = vi.fn().mockResolvedValue({ type: 'ok', path: 'Work/Renamed.md' });
  const authority = {
    refresh: vi.fn().mockResolvedValue(undefined),
    taskMemberships: vi.fn((candidate: ReturnType<typeof task>) => {
      const owner = candidate.ref.filePath.startsWith('Projects/')
        ? ({ type: 'project', path: milestone.projectPath } as const)
        : ({ type: 'work-note', path: candidate.ref.filePath } as const);
      const ownerNote =
        owner.type === 'work-note'
          ? owner.path === ordinary.path
            ? ordinary
            : { ...milestone, path: owner.path }
          : undefined;
      return [
        {
          projectPath: milestone.projectPath,
          owner,
          task: candidate,
          ...(ownerNote && { ownerNote }),
        },
      ];
    }),
    workNoteMemberships: vi.fn((path: string) => [{ ...milestone, path }]),
  };
  return {
    tasks,
    workNotes,
    relations,
    open,
    rename,
    authority,
    adapter: new MilestoneCommandAdapter({ tasks, workNotes, relations, open, rename, authority }),
  };
}

describe('MilestoneCommandAdapter', () => {
  it('owns create/open/title/lifecycle/date commands while storing Milestones as Work Notes', async () => {
    const h = fixture();

    await h.adapter.create({ title: 'Release', projectPath: milestone.projectPath });
    h.adapter.open(milestone);
    await h.adapter.setTitle(milestone, 'Renamed');
    await h.adapter.setLifecycle(milestone, 'done');
    const rangeObservation: WorkNoteRangeObservation = { observed };
    await h.adapter.setDates(rangeObservation, { start: null, end: null });
    await h.adapter.setPriority(observed, 'High');
    await h.adapter.setDescription(observed, 'Ship it');

    expect(h.workNotes.create).toHaveBeenCalledWith({
      title: 'Release',
      projectPath: milestone.projectPath,
      kind: 'milestone',
    });
    expect(h.open).toHaveBeenCalledWith(milestone.path);
    expect(h.rename).toHaveBeenCalledWith(milestone, 'Renamed');
    expect(h.workNotes.setStatus).toHaveBeenCalledWith(observed, 'done');
    expect(h.workNotes.setRange).toHaveBeenCalledWith(observed, { start: null, end: null });
    expect(h.workNotes.setPriority).toHaveBeenCalledWith(observed, 'High');
    expect(h.workNotes.setDescription).toHaveBeenCalledWith(observed, 'Ship it');
    expect(h.workNotes.observe).toHaveBeenCalledTimes(1);
  });

  it('creates and guarded-moves complete Task blocks into physical Work Note ownership', async () => {
    const h = fixture();
    const existing = task({
      ref: { filePath: 'Projects/P.md', line: 4, revision: 'observed-revision' },
      source: { filePath: 'Projects/P.md', line: 4 },
    });

    await createTaskInWorkNote(h.tasks, ordinary, 'Write release notes');
    await moveTaskToWorkNote(h.tasks, existing, ordinary);

    expect(h.tasks.execute).toHaveBeenNthCalledWith(1, {
      type: 'create',
      markdownBody: 'Write release notes',
      destination: {
        type: 'explicit',
        destination: { filePath: ordinary.path, insertion: { type: 'append' } },
      },
    });
    expect(h.tasks.execute).toHaveBeenNthCalledWith(2, {
      type: 'move',
      ref: existing.ref,
      destination: { filePath: ordinary.path, insertion: { type: 'append' } },
    });
    expect(JSON.stringify(h.tasks.execute.mock.calls)).not.toContain('Milestone:');
  });

  it('revalidates the exact canonical Work Note before production Task creation', async () => {
    const valid = fixture();
    valid.authority.workNoteMemberships.mockReturnValue([ordinary]);
    await expect(valid.adapter.createTask(ordinary, 'Write release notes')).resolves.toMatchObject({
      type: 'ok',
    });
    expect(valid.authority.refresh).toHaveBeenCalledOnce();
    expect(valid.tasks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'create', markdownBody: 'Write release notes' }),
    );

    const stale = fixture();
    stale.authority.workNoteMemberships.mockReturnValue([
      { ...ordinary, projectPath: 'Projects/Other.md' },
    ]);
    await expect(stale.adapter.createTask(ordinary, 'Unsafe')).resolves.toMatchObject({
      type: 'conflict',
      field: 'owner',
    });
    expect(stale.tasks.execute).not.toHaveBeenCalled();
  });

  it('revalidates same-Project Task and destination ownership before a production move', async () => {
    const existing = task({
      ref: { filePath: milestone.projectPath, line: 4, revision: 'observed-revision' },
      source: { filePath: milestone.projectPath, line: 4 },
    });
    const valid = fixture();
    valid.authority.workNoteMemberships.mockReturnValue([ordinary]);
    await expect(valid.adapter.moveTask(existing, ordinary)).resolves.toMatchObject({ type: 'ok' });
    expect(valid.tasks.execute).toHaveBeenCalledWith({
      type: 'move',
      ref: existing.ref,
      destination: { filePath: ordinary.path, insertion: { type: 'append' } },
    });

    const crossProject = fixture();
    crossProject.authority.workNoteMemberships.mockReturnValue([
      { ...ordinary, projectPath: 'Projects/Other.md' },
    ]);
    await expect(crossProject.adapter.moveTask(existing, ordinary)).resolves.toMatchObject({
      type: 'conflict',
      field: 'owner',
    });
    expect(crossProject.tasks.execute).not.toHaveBeenCalled();
  });

  it('moves direct Project Tasks into a Milestone but assigns Work Note-owned Tasks through relation authority', async () => {
    const h = fixture();
    const direct = task({
      ref: { filePath: milestone.projectPath, line: 2, revision: 'project-task' },
      source: { filePath: milestone.projectPath, line: 2 },
    });
    const inherited = task({
      ref: { filePath: ordinary.path, line: 3, revision: 'work-note-task' },
      source: { filePath: ordinary.path, line: 3 },
    });

    await h.adapter.assignTask({
      task: direct,
      owner: { type: 'project', path: milestone.projectPath },
      milestone,
    });
    const relation: RelationWriteCommand<string | null> = {
      notePath: ordinary.path,
      expectedRaw: undefined,
      expectedPresetRevision: String(ordinary.presetRevision),
      expectedPresetFingerprint: ordinary.presetFingerprint,
      value: milestone.path,
    };
    await h.adapter.assignTask({
      task: inherited,
      owner: { type: 'work-note', path: ordinary.path },
      ownerNote: ordinary,
      expectedMilestoneRaw: undefined,
      milestone,
    });

    expect(h.tasks.execute).toHaveBeenCalledWith({
      type: 'move',
      ref: direct.ref,
      destination: { filePath: milestone.path, insertion: { type: 'append' } },
    });
    expect(h.relations.setMilestone).toHaveBeenCalledWith(relation);
    expect(h.tasks.execute).toHaveBeenCalledTimes(1);
    expect(h.authority.refresh).toHaveBeenCalledTimes(2);
  });

  it('moves a physically Milestone-owned Task when reassigning it to another Milestone', async () => {
    const h = fixture();
    const otherMilestone = { ...milestone, path: 'Work/Other milestone.md' };
    const existing = task({
      ref: { filePath: milestone.path, line: 4, revision: 'milestone-task' },
      source: { filePath: milestone.path, line: 4 },
    });

    await h.adapter.assignTask({
      task: existing,
      owner: { type: 'work-note', path: milestone.path },
      ownerNote: milestone,
      milestone: otherMilestone,
    });

    expect(h.tasks.execute).toHaveBeenCalledWith({
      type: 'move',
      ref: existing.ref,
      destination: {
        filePath: otherMilestone.path,
        insertion: { type: 'append' },
      },
    });
    expect(h.relations.setMilestone).not.toHaveBeenCalled();
  });

  it('rejects wrong-kind, ambiguous, cross-Project, and stale-owner assignments after a fresh publication', async () => {
    const direct = task({
      ref: { filePath: milestone.projectPath, line: 2, revision: 'project-task' },
      source: { filePath: milestone.projectPath, line: 2 },
    });

    const wrongKind = fixture();
    wrongKind.authority.workNoteMemberships.mockReturnValue([ordinary]);
    await expect(
      wrongKind.adapter.assignTask({
        task: direct,
        owner: { type: 'project', path: milestone.projectPath },
        milestone: ordinary,
      }),
    ).resolves.toMatchObject({ type: 'invalid', field: 'milestone', reason: 'wrong-kind' });

    const ambiguous = fixture();
    ambiguous.authority.workNoteMemberships.mockReturnValue([
      milestone,
      { ...milestone, projectPath: 'Projects/Other.md' },
    ]);
    await expect(
      ambiguous.adapter.assignTask({
        task: direct,
        owner: { type: 'project', path: milestone.projectPath },
        milestone,
      }),
    ).resolves.toMatchObject({
      type: 'invalid',
      field: 'milestone',
      reason: 'ambiguous-ownership',
    });

    const crossProject = fixture();
    crossProject.authority.workNoteMemberships.mockReturnValue([
      { ...milestone, projectPath: 'Projects/Other.md' },
    ]);
    await expect(
      crossProject.adapter.assignTask({
        task: direct,
        owner: { type: 'project', path: milestone.projectPath },
        milestone,
      }),
    ).resolves.toMatchObject({ type: 'invalid', field: 'milestone', reason: 'cross-project' });

    const staleOwner = fixture();
    staleOwner.authority.taskMemberships.mockReturnValue([
      {
        projectPath: milestone.projectPath,
        owner: { type: 'work-note', path: ordinary.path },
        task: direct,
        ownerNote: ordinary,
      },
    ]);
    await expect(
      staleOwner.adapter.assignTask({
        task: direct,
        owner: { type: 'project', path: milestone.projectPath },
        milestone,
      }),
    ).resolves.toMatchObject({ type: 'conflict', field: 'owner' });
    expect(staleOwner.tasks.execute).not.toHaveBeenCalled();
  });

  it('writes Timeline dates from the render-captured observation without re-observing', async () => {
    const h = fixture();
    h.workNotes.setRange.mockResolvedValue({ type: 'conflict', field: 'start' });
    const captured: WorkNoteRangeObservation = {
      observed: { ...observed, fields: { Start: '2026-09-01', End: undefined } },
    };

    await expect(h.adapter.setDates(captured, { start: null })).resolves.toEqual({
      type: 'conflict',
      field: 'start',
    });
    expect(h.workNotes.setRange).toHaveBeenCalledWith(captured.observed, { start: null });
    expect(h.workNotes.observe).not.toHaveBeenCalled();
  });
});
