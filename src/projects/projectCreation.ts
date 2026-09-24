export interface ProjectCreateOptions {
  readonly statusId?: string;
  readonly openFile?: boolean;
}

export interface ProjectCreateRequest {
  readonly name: string;
  readonly statusId?: string;
  readonly recoveryPath?: string;
}

export type ProjectCreationPhase = 'template' | 'status';

export class ProjectCreationError extends Error {
  readonly createdPath: string;
  readonly phase: ProjectCreationPhase;
  readonly statusId: string | undefined;
  readonly cause: unknown;

  constructor(
    message: string,
    options: {
      readonly createdPath: string;
      readonly phase: ProjectCreationPhase;
      readonly statusId?: string;
      readonly cause: unknown;
    },
  ) {
    super(message);
    this.name = 'ProjectCreationError';
    this.createdPath = options.createdPath;
    this.phase = options.phase;
    this.statusId = options.statusId;
    this.cause = options.cause;
  }
}

export function isProjectCreationError(error: unknown): error is ProjectCreationError {
  return error instanceof ProjectCreationError;
}

/** The user-facing cause of a failed create: a partial create reports the step's own error. */
export function creationFailureMessage(error: unknown): string {
  const cause = isProjectCreationError(error) ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Appends the failure's cause to a sentence when the cause has text. */
export function withCreationFailureCause(sentence: string, error: unknown): string {
  const cause = creationFailureMessage(error).trim();
  return cause.length > 0 ? `${sentence} ${cause}` : sentence;
}

const PARTIAL_CREATE_STEPS: Readonly<Record<ProjectCreationPhase, string>> = {
  status: 'set its status',
  template: 'apply its template',
};

/** One Notice sentence for a failed project create, naming the created note when one exists. */
export function projectCreationFailureNotice(error: unknown): string {
  const sentence = isProjectCreationError(error)
    ? `Created ${error.createdPath}, but could not ${PARTIAL_CREATE_STEPS[error.phase]}.`
    : 'Could not create the project.';
  return withCreationFailureCause(sentence, error);
}
