export interface TaskReadObservation {
  readonly revision: number;
  readonly generation: number;
  readonly scopeRevision: number;
  readonly semanticsRevision: number;
  readonly lifecycle: 'initializing' | 'ready' | 'failed' | 'disposed';
}
export interface TaskReadScope {
  readonly path?: string;
  readonly folder?: string;
}
export type TaskReadFailure = 'not-ready' | 'failed' | 'disposed' | 'incomplete';
export type TaskReadResult<T> =
  | { readonly type: 'ok'; readonly value: T; readonly observation: TaskReadObservation }
  | { readonly type: 'error'; readonly reason: TaskReadFailure };
export interface TaskSourceHealthChange {
  readonly filePath: string;
  readonly fileIdentity: object;
  readonly acquisition: object;
  readonly phase: 'pending' | 'failed' | 'settled';
}
export type TaskReadEvent =
  | { readonly type: 'state' | 'changed'; readonly observation: TaskReadObservation }
  | {
      readonly type: 'health';
      readonly observation: TaskReadObservation;
      readonly change: TaskSourceHealthChange;
    };
export interface TaskIntegrationReadStateApi {
  capture(): TaskReadObservation;
  subscribe(listener: (event: TaskReadEvent) => void): {
    readonly state: TaskReadObservation;
    readonly unsubscribe: () => void;
  };
  coverage(scope?: TaskReadScope): TaskReadResult<true>;
}
