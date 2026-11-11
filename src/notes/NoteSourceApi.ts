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
type TaskReadFailure =
  | 'not-ready'
  | 'failed'
  | 'disposed'
  | 'incomplete'
  | 'generation-changed'
  | 'unavailable'
  | 'missing'
  | 'stale'
  | 'ambiguous';
export type TaskReadResult<T> =
  | { readonly type: 'ok'; readonly value: T; readonly observation: TaskReadObservation }
  | { readonly type: 'error'; readonly reason: TaskReadFailure };

/** Borrowed accepted Markdown; identities are native incarnation tokens, never paths. */
export interface AcceptedNoteSource {
  readonly path: string;
  readonly identity: object;
  readonly version: number;
  readonly content: string;
  readonly metadata: {
    readonly tags: readonly string[];
    readonly frontmatter: Readonly<Record<string, unknown>>;
  };
}
export interface NoteSourceReadApi {
  paths(): readonly string[];
  coverage(scope?: TaskReadScope): TaskReadResult<true>;
  get(path: string): TaskReadResult<AcceptedNoteSource | undefined>;
  acquire(path: string): Promise<TaskReadResult<AcceptedNoteSource | undefined>>;
  matchesFile(
    proof: Pick<AcceptedNoteSource, 'path' | 'identity' | 'version'>,
    native: object,
  ): boolean;
  prospective(path: string, content: string): TaskReadResult<AcceptedNoteSource['metadata']>;
  candidate(
    proof: Pick<AcceptedNoteSource, 'path' | 'identity' | 'version'>,
    live: string,
    candidate: string,
  ): TaskReadResult<AcceptedNoteSource['metadata']>;
  reconcile(path: string, native: object, content: string): Promise<boolean>;
}
