export interface ProjectCreateOptions {
  readonly statusId?: string;
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

/**
 * The user-facing cause of a failed create: a partial create reports the step's own error. An
 * `Error` gives its message and a string stays as it is. A cause without text gives `''`, whether
 * it is blank or any other value, so a failure shows its cause exactly when this is not empty.
 */
export function creationFailureMessage(error: unknown): string {
  const cause = isProjectCreationError(error) ? error.cause : error;
  let text = '';
  if (cause instanceof Error) text = cause.message;
  else if (typeof cause === 'string') text = cause;
  return text.trim().length > 0 ? text : '';
}

/** The shared sentence-plus-cause helper. A project creation error contributes its cause. */
export function withFailureCause(sentence: string, error: unknown): string {
  const cause = creationFailureMessage(error);
  return cause.length > 0 ? `${sentence} ${cause.trim()}` : sentence;
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
  return withFailureCause(sentence, error);
}
