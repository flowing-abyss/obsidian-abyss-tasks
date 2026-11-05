import type { ApiResultV1 } from '../../api';
import type {
  ProjectIntegrationReads,
  ProjectReadRecord,
  ProjectReadSummary,
} from '../projects/projectApi';
import type { TaskReadObservation } from '../tasks';
import { readError, readFailure } from './taskApiReads';

interface Handle {
  readonly created: number;
  readonly path: string;
  readonly identity: object;
  version: number;
  semantics: object;
  revision: string;
  expires: number;
}
interface Cursor {
  readonly created: number;
  readonly binding: string;
  readonly semantics: object;
  readonly after: string;
  readonly expires: number;
}
interface RegistryOptions {
  readonly epoch: string;
  readonly now: () => number;
  readonly maxTargets?: number;
  readonly maxCursors?: number;
}
function failure(): ApiResultV1<never> {
  return readError('resource', 'RESOURCE_LIMIT', 'Project capacity is exhausted.');
}
function binding(limit: number, observation: TaskReadObservation): string {
  return JSON.stringify([
    limit,
    observation.generation,
    observation.scopeRevision,
    observation.semanticsRevision,
  ]);
}
/** Provider-owned; stores only opaque file identity and current revision evidence. */
export class ProjectReadRegistry {
  private readonly handles_abyssPrivate = new Map<string, Handle>();
  private readonly reverse_abyssPrivate = new WeakMap<object, { path: string; target: string }>();
  private readonly cursors_abyssPrivate = new Map<string, Cursor>();
  private count_abyssPrivate = 0;
  private disposed_abyssPrivate = false;
  constructor(
    private readonly port_abyssPrivate: ProjectIntegrationReads,
    private readonly options_abyssPrivate: RegistryOptions,
  ) {}
  private token_abyssPrivate(kind: string): string {
    return `${this.options_abyssPrivate.epoch}:${kind}:${++this.count_abyssPrivate}`;
  }
  clean(): void {
    const now = this.options_abyssPrivate.now();
    for (const [key, value] of this.handles_abyssPrivate)
      if (value.expires <= now) this.handles_abyssPrivate.delete(key);
    for (const [key, value] of this.cursors_abyssPrivate)
      if (value.expires <= now) this.cursors_abyssPrivate.delete(key);
  }
  checkpoint(): number {
    return this.count_abyssPrivate;
  }
  rollback(checkpoint: number): void {
    for (const [key, handle] of this.handles_abyssPrivate)
      if (handle.created > checkpoint) this.handles_abyssPrivate.delete(key);
    for (const [key, cursor] of this.cursors_abyssPrivate)
      if (cursor.created > checkpoint) this.cursors_abyssPrivate.delete(key);
  }
  project<T extends ProjectReadSummary>(
    value: T,
  ): ApiResultV1<
    Omit<T, 'identity' | 'version' | 'semantics'> & { target: string; revision: string }
  > {
    const entry = this.handle_abyssPrivate(value);
    if (!entry.ok) return entry;
    const { target, handle } = entry.value;
    if (handle.version !== value.version || handle.semantics !== value.semantics) {
      if (this.count_abyssPrivate >= Number.MAX_SAFE_INTEGER) return failure();
      handle.version = value.version;
      handle.semantics = value.semantics;
      handle.revision = this.token_abyssPrivate('r');
    }
    handle.expires = this.options_abyssPrivate.now() + 1_800_000;
    const data = { ...value } as {
      -readonly [K in keyof ProjectReadSummary]?: ProjectReadSummary[K];
    };
    delete data.identity;
    delete data.version;
    delete data.semantics;
    return {
      ok: true,
      value: { ...data, target, revision: handle.revision } as Omit<
        T,
        'identity' | 'version' | 'semantics'
      > & { target: string; revision: string },
    };
  }
  private handle_abyssPrivate(
    value: ProjectReadSummary,
  ): ApiResultV1<{ target: string; handle: Handle }> {
    const prior = this.reverse_abyssPrivate.get(value.identity);
    let target = prior?.path === value.path ? prior.target : undefined;
    let handle = target === undefined ? undefined : this.handles_abyssPrivate.get(target);
    if (handle === undefined) {
      if (this.disposed_abyssPrivate) return readFailure('disposed');
      if (
        this.handles_abyssPrivate.size >= (this.options_abyssPrivate.maxTargets ?? 50_000) ||
        this.count_abyssPrivate >= Number.MAX_SAFE_INTEGER - 2
      )
        return failure();
      target = this.token_abyssPrivate('p');
      handle = {
        created: this.count_abyssPrivate,
        path: value.path,
        identity: value.identity,
        version: value.version,
        semantics: value.semantics,
        revision: this.token_abyssPrivate('r'),
        expires: 0,
      };
      this.handles_abyssPrivate.set(target, handle);
      this.reverse_abyssPrivate.set(value.identity, { path: value.path, target });
    }
    return { ok: true, value: { target: target ?? '', handle } };
  }
  acquire(target: string, expectedRevision?: string): ApiResultV1<ProjectReadRecord> {
    if (this.disposed_abyssPrivate) return readFailure('disposed');
    this.clean();
    const handle = this.handles_abyssPrivate.get(target);
    if (handle === undefined) return readFailure('stale');
    const read = this.port_abyssPrivate.get(handle.path);
    if (read.type === 'error') return readFailure(read.reason);
    if (read.value?.identity !== handle.identity) return readFailure('stale');
    if (
      expectedRevision !== undefined &&
      (handle.revision !== expectedRevision ||
        handle.version !== read.value.version ||
        handle.semantics !== read.value.semantics)
    )
      return readError('conflict', 'STALE_REVISION', 'Project has changed.');
    return { ok: true, value: read.value };
  }
  resume(token: string, limit: number, observation: TaskReadObservation): ApiResultV1<string> {
    const cursor = this.cursors_abyssPrivate.get(token);
    if (
      cursor?.binding !== binding(limit, observation) ||
      cursor.semantics !== this.port_abyssPrivate.semantics()
    )
      return readFailure('generation-changed');
    return { ok: true, value: cursor.after };
  }
  open(after: string, limit: number, observation: TaskReadObservation): ApiResultV1<string> {
    if (
      this.cursors_abyssPrivate.size >= (this.options_abyssPrivate.maxCursors ?? 1_024) ||
      this.count_abyssPrivate >= Number.MAX_SAFE_INTEGER
    )
      return failure();
    const token = this.token_abyssPrivate('pc');
    this.cursors_abyssPrivate.set(token, {
      created: this.count_abyssPrivate,
      binding: binding(limit, observation),
      semantics: this.port_abyssPrivate.semantics(),
      after,
      expires: this.options_abyssPrivate.now() + 60_000,
    });
    return { ok: true, value: token };
  }
  dispose(): void {
    this.disposed_abyssPrivate = true;
    this.handles_abyssPrivate.clear();
    this.cursors_abyssPrivate.clear();
  }
}
