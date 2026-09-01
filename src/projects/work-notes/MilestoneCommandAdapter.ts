import type { TaskApplicationApi, TaskSnapshot } from '../../tasks';
import type { ProjectRangePatch } from '../ProjectCommandService';
import type { ProjectAction } from '../types';
import type { WorkNoteCommandService } from './WorkNoteCommandService';
import type {
  RelationWriteCommand,
  WorkNoteCommandResult,
  WorkNoteCreateRequest,
  WorkNoteRelationCommands,
  WorkNoteSnapshot,
} from './types';

type WorkNoteStorageCommands = Pick<
  WorkNoteCommandService,
  'create' | 'observe' | 'observeRange' | 'setStatus' | 'setRange'
>;

export interface MilestoneCommandAdapterOptions {
  readonly tasks: Pick<TaskApplicationApi, 'execute'>;
  readonly workNotes: WorkNoteStorageCommands;
  readonly relations: WorkNoteRelationCommands;
  readonly open: (path: string) => void;
  readonly rename: (milestone: WorkNoteSnapshot, title: string) => Promise<WorkNoteCommandResult>;
}

export interface AssignTaskToMilestoneCommand {
  readonly task: TaskSnapshot;
  readonly owner: ProjectAction['owner'];
  readonly milestone: WorkNoteSnapshot;
  readonly ownerNote?: WorkNoteSnapshot;
  readonly expectedMilestoneRaw?: unknown;
}

const appendDestination = (filePath: string) => ({
  filePath,
  insertion: { type: 'append' as const },
});

export function createTaskInWorkNote(
  tasks: Pick<TaskApplicationApi, 'execute'>,
  note: WorkNoteSnapshot,
  markdownBody: string,
) {
  return tasks.execute({
    type: 'create',
    markdownBody,
    destination: {
      type: 'explicit',
      destination: appendDestination(note.path),
    },
  });
}

export function moveTaskToWorkNote(
  tasks: Pick<TaskApplicationApi, 'execute'>,
  task: TaskSnapshot,
  note: WorkNoteSnapshot,
) {
  return tasks.execute({
    type: 'move',
    ref: task.ref,
    destination: appendDestination(note.path),
  });
}

/** First-class Milestone intents backed exclusively by Work Note and Task authorities. */
export class MilestoneCommandAdapter {
  constructor(private readonly options: MilestoneCommandAdapterOptions) {}

  create(request: Omit<WorkNoteCreateRequest, 'kind'>): Promise<WorkNoteCommandResult> {
    return this.options.workNotes.create({ ...request, kind: 'milestone' });
  }

  open(milestone: WorkNoteSnapshot): void {
    this.options.open(milestone.path);
  }

  setTitle(milestone: WorkNoteSnapshot, title: string): Promise<WorkNoteCommandResult> {
    return this.options.rename(milestone, title);
  }

  setLifecycle(milestone: WorkNoteSnapshot, statusId: string): Promise<WorkNoteCommandResult> {
    const observed = this.options.workNotes.observe(milestone);
    return observed
      ? this.options.workNotes.setStatus(observed, statusId)
      : Promise.resolve({ type: 'invalid', field: 'path', reason: 'missing-source' });
  }

  setDates(milestone: WorkNoteSnapshot, patch: ProjectRangePatch): Promise<WorkNoteCommandResult> {
    const observed = this.options.workNotes.observe(milestone);
    return observed
      ? this.options.workNotes.setRange(observed, patch)
      : Promise.resolve({ type: 'invalid', field: 'path', reason: 'missing-source' });
  }

  observeDates(milestone: WorkNoteSnapshot) {
    return this.options.workNotes.observeRange(milestone);
  }

  setWorkNoteMembership(
    note: WorkNoteSnapshot,
    milestone: WorkNoteSnapshot | null,
    expectedRaw: unknown,
  ): Promise<WorkNoteCommandResult> {
    const command: RelationWriteCommand<string | null> = {
      notePath: note.path,
      expectedRaw,
      expectedPresetRevision: String(note.presetRevision),
      expectedPresetFingerprint: note.presetFingerprint,
      value: milestone?.path ?? null,
    };
    return this.options.relations.setMilestone(command);
  }

  assignTask(
    command: AssignTaskToMilestoneCommand,
  ): Promise<WorkNoteCommandResult | Awaited<ReturnType<TaskApplicationApi['execute']>>> {
    if (command.owner.type === 'project') {
      return moveTaskToWorkNote(this.options.tasks, command.task, command.milestone);
    }
    if (command.owner.path === command.milestone.path) {
      return Promise.resolve({ type: 'unchanged', path: command.milestone.path });
    }
    const ownerNote = command.ownerNote;
    if (!ownerNote || ownerNote.path !== command.owner.path) {
      return Promise.resolve({ type: 'invalid', field: 'owner', reason: 'missing-source' });
    }
    if (ownerNote.kind === 'milestone') {
      return moveTaskToWorkNote(this.options.tasks, command.task, command.milestone);
    }
    return this.setWorkNoteMembership(ownerNote, command.milestone, command.expectedMilestoneRaw);
  }

  createTask(milestone: WorkNoteSnapshot, markdownBody: string) {
    return createTaskInWorkNote(this.options.tasks, milestone, markdownBody);
  }
}
