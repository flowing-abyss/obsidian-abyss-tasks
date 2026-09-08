/** A rejected project edit that the user can correct without an I/O notification. */
export class ProjectEditValidationError extends Error {
  readonly kind = 'validation';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectEditValidationError';
  }
}

export function isProjectEditValidationError(error: unknown): error is ProjectEditValidationError {
  return error instanceof ProjectEditValidationError;
}
