declare const __TASK_CALENDAR_BUILD_COMMIT__: string;

export function buildCommitIdentity(): string {
  return typeof __TASK_CALENDAR_BUILD_COMMIT__ === 'string'
    ? __TASK_CALENDAR_BUILD_COMMIT__
    : 'development';
}
