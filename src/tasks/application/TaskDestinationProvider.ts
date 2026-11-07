import type { TaskDestination } from '../domain/types';

export type TaskDestinationResolution =
  | { readonly type: 'resolved'; readonly destination: TaskDestination }
  | { readonly type: 'unavailable' };

interface TaskDestinationCommitResolution {
  readonly resolution: TaskDestinationResolution;
  readonly effects: 'unchanged' | 'committed' | 'unknown';
}
export interface TaskDestinationPlan {
  seal?(): Promise<TaskDestinationPlan>;
  readonly preparedFailure?: 'unsupported-template';
  readonly plannedContent?: string;
  validatePrepared?(): Promise<boolean>;
  checkPrepared?(file: object, live: string): boolean;
  prepareGuarded?(validate: () => Promise<boolean>): Promise<TaskDestinationCommitResolution>;
  readonly destination: TaskDestination;
  prepare(): Promise<TaskDestinationResolution>;
  validate?(destination: TaskDestination): Promise<boolean>;
}

/** Resolves and, when configured policy requires it, prepares the current default note. */
export interface TaskDestinationProvider {
  planConfiguredDefault(): Promise<TaskDestinationPlan | undefined>;
  planArchive?(): Promise<TaskDestinationPlan | undefined>;
  planExplicit(
    destination: TaskDestination,
    options?: { readonly provision: boolean },
  ): Promise<TaskDestinationPlan>;

  /** Legacy eager adapter retained for existing create callers. */
  resolveConfiguredDefault(): Promise<TaskDestinationResolution>;

  /** Legacy eager adapter retained for existing provision-if-missing callers. */
  prepare(destination: TaskDestination): Promise<TaskDestinationResolution>;
}
