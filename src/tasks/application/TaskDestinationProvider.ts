import type { TaskDestination } from '../domain/types';

export type TaskDestinationResolution =
  | { readonly type: 'resolved'; readonly destination: TaskDestination }
  | { readonly type: 'unavailable' };

export interface TaskDestinationPlan {
  readonly destination: TaskDestination;
  prepare(): Promise<TaskDestinationResolution>;
}

/** Resolves and, when configured policy requires it, prepares the current default note. */
export interface TaskDestinationProvider {
  planConfiguredDefault(): Promise<TaskDestinationPlan | undefined>;
  planExplicit(destination: TaskDestination): Promise<TaskDestinationPlan>;

  /** Legacy eager adapter retained for existing create callers. */
  resolveConfiguredDefault(): Promise<TaskDestinationResolution>;

  /** Legacy eager adapter retained for existing provision-if-missing callers. */
  prepare(destination: TaskDestination): Promise<TaskDestinationResolution>;
}
