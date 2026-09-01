import type { TaskApplicationApi, TaskSnapshot } from '../../tasks';
import type { ProjectRangePatch } from '../ProjectCommandService';
import type { ProjectAction } from '../types';
import type { WorkNoteCommandService } from './WorkNoteCommandService';
import type {
  RelationWriteCommand,
  WorkNoteCommandResult,
  WorkNoteCreateRequest,
  WorkNoteObservedFields,
  WorkNoteRangeObservation,
  WorkNoteRelationCommands,
  WorkNoteSnapshot,
} from './types';

type WorkNoteStorageCommands = Pick<
  WorkNoteCommandService,
  | 'create'
  | 'observe'
  | 'observeRange'
  | 'setStatus'
  | 'setRange'
  | 'setPriority'
  | 'setDescription'
>;

export interface MilestoneCommandAdapterOptions {
  readonly tasks: Pick<TaskApplicationApi, 'execute'>;
  readonly workNotes: WorkNoteStorageCommands;
  readonly relations: WorkNoteRelationCommands;
  readonly open: (path: string) => void;
  readonly rename: (milestone: WorkNoteSnapshot, title: string) => Promise<WorkNoteCommandResult>;
  /** Fresh, canonical Project/ownership publication used immediately before assignment. */
  readonly authority: MilestoneCommandAuthority;
}

export interface MilestoneTaskMembership {
  readonly projectPath: string;
  readonly owner: ProjectAction['owner'];
  readonly task: TaskSnapshot;
  readonly ownerNote?: WorkNoteSnapshot;
}

interface MilestoneCommandAuthority {
  refresh(): Promise<void>;
  taskMemberships(task: TaskSnapshot): readonly MilestoneTaskMembership[];
  workNoteMemberships(path: string): readonly WorkNoteSnapshot[];
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

  private async canonicalWorkNote(
    rendered: WorkNoteSnapshot,
  ): Promise<WorkNoteSnapshot | WorkNoteCommandResult> {
    try {
      await this.options.authority.refresh();
    } catch {
      return { type: 'io-error' };
    }
    const memberships = this.options.authority.workNoteMemberships(rendered.path);
    if (memberships.length !== 1) {
      return {
        type: 'invalid',
        field: 'owner',
        reason: memberships.length === 0 ? 'missing-source' : 'ambiguous-ownership',
      };
    }
    const canonical = memberships[0]!;
    if (
      canonical.path !== rendered.path ||
      canonical.projectPath !== rendered.projectPath ||
      canonical.kind !== rendered.kind ||
      canonical.presetRevision !== rendered.presetRevision ||
      canonical.presetFingerprint !== rendered.presetFingerprint
    ) {
      return { type: 'conflict', field: 'owner' };
    }
    return canonical;
  }

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

  setPriority(
    observed: WorkNoteObservedFields,
    value: string | null,
  ): Promise<WorkNoteCommandResult> {
    return this.options.workNotes.setPriority(observed, value);
  }

  setDescription(
    observed: WorkNoteObservedFields,
    value: string | null,
  ): Promise<WorkNoteCommandResult> {
    return this.options.workNotes.setDescription(observed, value);
  }

  setDates(
    observation: WorkNoteRangeObservation,
    patch: ProjectRangePatch,
  ): Promise<WorkNoteCommandResult> {
    return this.options.workNotes.setRange(observation.observed, patch);
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

  async assignTask(
    command: AssignTaskToMilestoneCommand,
  ): Promise<WorkNoteCommandResult | Awaited<ReturnType<TaskApplicationApi['execute']>>> {
    try {
      await this.options.authority.refresh();
    } catch {
      return { type: 'io-error' };
    }
    const milestoneMemberships = this.options.authority.workNoteMemberships(command.milestone.path);
    if (milestoneMemberships.length !== 1) {
      return {
        type: 'invalid',
        field: 'milestone',
        reason: milestoneMemberships.length === 0 ? 'missing-source' : 'ambiguous-ownership',
      };
    }
    const milestone = milestoneMemberships[0]!;
    if (milestone.kind !== 'milestone') {
      return { type: 'invalid', field: 'milestone', reason: 'wrong-kind' };
    }

    const taskMemberships = this.options.authority.taskMemberships(command.task);
    if (taskMemberships.length !== 1) {
      return {
        type: 'invalid',
        field: 'owner',
        reason: taskMemberships.length === 0 ? 'missing-source' : 'ambiguous-ownership',
      };
    }
    const membership = taskMemberships[0]!;
    if (
      membership.task.ref.filePath !== command.task.ref.filePath ||
      membership.task.ref.line !== command.task.ref.line ||
      membership.task.ref.revision !== command.task.ref.revision ||
      membership.owner.type !== command.owner.type ||
      membership.owner.path !== command.owner.path
    ) {
      return { type: 'conflict', field: 'owner' };
    }
    if (membership.projectPath !== milestone.projectPath) {
      return { type: 'invalid', field: 'milestone', reason: 'cross-project' };
    }
    if (membership.owner.type === 'project') {
      return moveTaskToWorkNote(this.options.tasks, membership.task, milestone);
    }
    if (membership.owner.path === milestone.path) {
      return { type: 'unchanged', path: milestone.path };
    }
    const ownerNote = membership.ownerNote;
    if (!ownerNote || ownerNote.path !== membership.owner.path) {
      return { type: 'invalid', field: 'owner', reason: 'missing-source' };
    }
    if (ownerNote.projectPath !== milestone.projectPath) {
      return { type: 'invalid', field: 'milestone', reason: 'cross-project' };
    }
    if (ownerNote.kind === 'milestone') {
      return moveTaskToWorkNote(this.options.tasks, membership.task, milestone);
    }
    return this.setWorkNoteMembership(ownerNote, milestone, command.expectedMilestoneRaw);
  }

  async createTask(note: WorkNoteSnapshot, markdownBody: string) {
    const canonical = await this.canonicalWorkNote(note);
    if ('type' in canonical) return canonical;
    return createTaskInWorkNote(this.options.tasks, canonical, markdownBody);
  }

  async moveTask(task: TaskSnapshot, note: WorkNoteSnapshot) {
    const canonical = await this.canonicalWorkNote(note);
    if ('type' in canonical) return canonical;
    const memberships = this.options.authority.taskMemberships(task);
    if (memberships.length !== 1) {
      return {
        type: 'invalid' as const,
        field: 'owner' as const,
        reason:
          memberships.length === 0 ? ('missing-source' as const) : ('ambiguous-ownership' as const),
      };
    }
    const membership = memberships[0]!;
    if (
      membership.task.ref.filePath !== task.ref.filePath ||
      membership.task.ref.line !== task.ref.line ||
      membership.task.ref.revision !== task.ref.revision
    ) {
      return { type: 'conflict' as const, field: 'owner' as const };
    }
    if (membership.projectPath !== canonical.projectPath) {
      return {
        type: 'invalid' as const,
        field: 'owner' as const,
        reason: 'cross-project' as const,
      };
    }
    return moveTaskToWorkNote(this.options.tasks, membership.task, canonical);
  }
}
