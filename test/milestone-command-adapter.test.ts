import { describe, expect, it, vi } from 'vitest';
import {
  MilestoneCommandAdapter,
  createTaskInWorkNote,
  moveTaskToWorkNote,
} from '../src/projects/work-notes/MilestoneCommandAdapter';
import type {
  RelationWriteCommand,
  WorkNoteObservedFields,
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
  return {
    tasks,
    workNotes,
    relations,
    open,
    rename,
    adapter: new MilestoneCommandAdapter({ tasks, workNotes, relations, open, rename }),
  };
}

describe('MilestoneCommandAdapter', () => {
  it('owns create/open/title/lifecycle/date commands while storing Milestones as Work Notes', async () => {
    const h = fixture();

    await h.adapter.create({ title: 'Release', projectPath: milestone.projectPath });
    h.adapter.open(milestone);
    await h.adapter.setTitle(milestone, 'Renamed');
    await h.adapter.setLifecycle(milestone, 'done');
    await h.adapter.setDates(milestone, { start: null, end: null });

    expect(h.workNotes.create).toHaveBeenCalledWith({
      title: 'Release',
      projectPath: milestone.projectPath,
      kind: 'milestone',
    });
    expect(h.open).toHaveBeenCalledWith(milestone.path);
    expect(h.rename).toHaveBeenCalledWith(milestone, 'Renamed');
    expect(h.workNotes.setStatus).toHaveBeenCalledWith(observed, 'done');
    expect(h.workNotes.setRange).toHaveBeenCalledWith(observed, { start: null, end: null });
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
});
