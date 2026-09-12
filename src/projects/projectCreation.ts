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
