import type {
  ApiAbortSignalV1,
  ApiEventV1,
  ApiInfoV1,
  ApiResultV1,
  ApplyTaskContentV1,
  ListTaskTagsV1,
  MutationOptionsV1,
  ObservationV1,
  ReadOptionsV1,
  ReadyV1,
  SearchTasksV1,
  TasksApiProviderV1,
  TasksApiV1,
} from '../../api';
import { NOTE_LIMITS, type NoteApplicationApi } from '../notes/noteApi';
import type {
  TaskIntegrationReadApi,
  TaskReadObservation,
  TaskSearchApi,
  TaskStatusMutationApi,
} from '../tasks';
import { NoteApi } from './noteApi';
import { NoteReadRegistry } from './NoteReadRegistry';
import { createProjectApiMutations, type ProjectPorts } from './projectApiMutations';
import { createProjectApiReads } from './projectApiReads';
import { ProjectReadRegistry } from './ProjectReadRegistry';
import { createTaskApiMutations } from './taskApiMutations';
import { createTaskApiReads, lifecycleError, readError } from './taskApiReads';
import { TaskContentApi, type TaskContentPorts } from './taskContentApi';
import { CONTENT_LIMITS } from './taskContentValidation';
import { TaskCursorRegistry } from './TaskCursorRegistry';
import { TaskIdentityRegistry } from './TaskIdentityRegistry';
import { TaskRequestRegistry } from './TaskRequestRegistry';
import { TaskSearchReads } from './taskSearchApi';
import { validateApiRequest, validateReadOptions } from './validation';
import { apiError, freezeValue } from './values';

export type TaskReadClientV1 = Omit<TasksApiV1, 'tasks'> & {
  readonly tasks: Pick<TasksApiV1['tasks'], 'list' | 'get' | 'resolve' | 'statuses'>;
};
export interface TaskApiContext {
  readonly reads: TaskIntegrationReadApi;
  readonly identities: TaskIdentityRegistry;
  readonly cursors: TaskCursorRegistry;
  observation(value: TaskReadObservation): ObservationV1;
  check(signal?: ApiAbortSignalV1): ApiResultV1<never> | undefined;
  internal(operation: string): ApiResultV1<never>;
}
interface ClientRecord {
  live: boolean;
  readonly listeners: Set<(event: ApiEventV1) => void>;
  readonly waits: Set<() => void>;
  content?: TaskContentApi;
  notes?: NoteApi;
  search?: TaskSearchReads;
}
interface Publication {
  readonly event: ApiEventV1;
  readonly audience: ReadonlyArray<{
    readonly client: ClientRecord;
    readonly listeners: ReadonlyArray<(event: ApiEventV1) => void>;
  }>;
}
interface ProviderOptions {
  readonly notes?: NoteApplicationApi;
  readonly search?: TaskSearchApi;
  readonly content?: TaskContentPorts;
  readonly projects?: ProjectPorts;
  readonly mutations: TaskStatusMutationApi;
  readonly reads: TaskIntegrationReadApi;
  readonly pluginVersion: string;
  readonly epoch: string;
  readonly now: () => number;
  readonly diagnostic: (operation: string, code: string, diagnosticId: string) => void;
}
interface ProviderOwner {
  readonly notes?: NoteReadRegistry;
  readonly projects?: { ports: ProjectPorts; registry: ProjectReadRegistry };
  readonly requests: TaskRequestRegistry;
  readonly options: ProviderOptions;
  readonly identities: TaskIdentityRegistry;
  readonly cursors: TaskCursorRegistry;
  readonly clients: Set<ClientRecord>;
  readonly info: ApiInfoV1;
  readonly publications: Publication[];
  publishing: boolean;
  closed: boolean;
  diagnostics: number;
  terminal?: ApiResultV1<never>;
  unsubscribe?: () => void;
}
function apiInfo(options: ProviderOptions): ApiInfoV1 {
  return freezeValue({
    apiVersion: 1,
    pluginVersion: options.pluginVersion,
    providerEpoch: options.epoch,
    capabilities: [
      'tasks.read',
      ...(options.notes === undefined
        ? []
        : ['notes.search', 'notes.read', 'notes.prepare', 'notes.create', 'notes.apply']),
      'tasks.tags',
      ...(options.search === undefined ? [] : ['tasks.search']),
      ...(options.content === undefined
        ? []
        : ['tasks.tree', 'tasks.prepare', 'tasks.apply', 'tasks.create']),
      'tasks.resolve',
      'tasks.statuses',
      'tasks.complete',
      'tasks.setStatus',
      'tasks.toggleCompletion',
      'events.invalidate',
      'requests.epochDeduplication',
      ...(options.projects === undefined
        ? []
        : [
            'projects.read',
            'projects.schema',
            'projects.create',
            'projects.update',
            'projects.createTask',
            'projects.moveTask',
          ]),
    ],
    ...(options.projects === undefined
      ? {}
      : {
          projectLimits: {
            maxFieldsPerWrite: 64,
            maxValuesPerField: 256,
            maxTextLength: 16_384,
            maxProjectInputBytes: 65_536,
            maxProjectResultBytes: 262_144,
            maxRetainedProjectBytes: 4 * 1024 * 1024,
          },
        }),
    ...(options.notes === undefined ? {} : { noteLimits: NOTE_LIMITS }),
    ...(options.content === undefined ? {} : { contentLimits: CONTENT_LIMITS }),
    limits: {
      defaultPageSize: 100,
      maxPageSize: 500,
      cursorTtlMs: 60_000,
      maxCursors: 1_024,
      targetIdleTtlMs: 1_800_000,
      maxTargets: 50_000,
      maxRequestWindowMs: 300_000,
      maxPendingRequestsPerConsumer: 32,
      maxRetainedRequestsPerConsumer: 1_024,
      maxRetainedRequests: 4_096,
      maxClients: 128,
      maxListenersPerClient: 32,
    },
  });
}
function internal(owner: ProviderOwner, operation: string): ApiResultV1<never> {
  if (owner.diagnostics < Number.MAX_SAFE_INTEGER) owner.diagnostics++;
  const id = `${owner.options.epoch}:d:${owner.diagnostics}`;
  try {
    owner.options.diagnostic(operation, 'INTERNAL_ERROR', id);
  } catch {
    console.error('[abyss-tasks] API diagnostic callback failed', {
      operation,
      code: 'INTERNAL_ERROR',
      diagnosticId: id,
    });
  }
  return freezeValue({
    ok: false,
    error: apiError('internal', 'INTERNAL_ERROR', 'Task API operation failed.', id),
  });
}
function observation(owner: ProviderOwner, value: TaskReadObservation): ObservationV1 {
  return {
    providerEpoch: owner.options.epoch,
    revision: value.revision,
    generation: value.generation,
    scopeRevision: value.scopeRevision,
    semanticsRevision: value.semanticsRevision,
  };
}
function closeClient(owner: ProviderOwner, client: ClientRecord): void {
  if (!client.live) return;
  client.live = false;
  client.content?.dispose();
  client.notes?.dispose();
  client.search?.dispose();
  client.listeners.clear();
  owner.clients.delete(client);
  for (const wake of [...client.waits]) wake();
  client.waits.clear();
}
function closeProvider(owner: ProviderOwner): void {
  if (owner.closed) return;
  owner.closed = true;
  owner.publications.length = 0;
  for (const client of [...owner.clients]) closeClient(owner, client);
  owner.unsubscribe?.();
  delete owner.unsubscribe;
  owner.requests.dispose();
  owner.identities.dispose();
  owner.cursors.dispose();
  owner.projects?.registry.dispose();
  owner.notes?.dispose();
}
function checkProvider(owner: ProviderOwner): ApiResultV1<never> | undefined {
  if (owner.terminal !== undefined) return owner.terminal;
  if (owner.closed) return readError('lifecycle', 'DISPOSED', 'Task API is disposed.');
  const state = owner.options.reads.capture();
  if (
    [state.revision, state.generation, state.scopeRevision, state.semanticsRevision].some(
      (value) => !Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER,
    )
  ) {
    owner.terminal = internal(owner, 'observation');
    closeProvider(owner);
    return owner.terminal;
  }
  if (state.lifecycle === 'disposed') {
    closeProvider(owner);
    return readError('lifecycle', 'DISPOSED', 'Task API is disposed.');
  }
  return undefined;
}
function invoke(
  owner: ProviderOwner,
  client: ClientRecord,
  listener: (event: ApiEventV1) => void,
  event: ApiEventV1,
): void {
  if (!client.live || !client.listeners.has(listener)) return;
  try {
    listener(event);
  } catch {
    internal(owner, 'subscribe');
  }
}
function deliver(owner: ProviderOwner, publication: Publication): void {
  for (const { client } of publication.audience) for (const wake of [...client.waits]) wake();
  for (const { client, listeners } of publication.audience)
    for (const listener of listeners) invoke(owner, client, listener, publication.event);
}
function publish(owner: ProviderOwner, event: ApiEventV1): void {
  owner.publications.push({
    event,
    audience: [...owner.clients].map((client) => ({ client, listeners: [...client.listeners] })),
  });
  // Inward acceptance may reenter this loop; its identities are already installed.
  // Keep outward callbacks ordered, with the audience captured before any reentry.
  if (owner.publishing) return;
  owner.publishing = true;
  try {
    for (
      let next = owner.publications.shift();
      next !== undefined;
      next = owner.publications.shift()
    ) {
      deliver(owner, next);
    }
  } finally {
    owner.publishing = false;
  }
}
function activate(owner: ProviderOwner): void {
  if (owner.unsubscribe !== undefined) return;
  const registration = owner.options.reads.subscribe((event) => {
    try {
      if (checkProvider(owner) !== undefined) return;
      if (event.type === 'accepted') owner.identities.apply(event.change);
      publish(
        owner,
        freezeValue({
          ...observation(owner, event.observation),
          lifecycle: event.observation.lifecycle,
          type: event.type === 'state' ? ('state' as const) : ('changed' as const),
        }),
      );
    } catch {
      owner.terminal = internal(owner, 'observation');
      closeProvider(owner);
    }
  });
  owner.unsubscribe = registration.unsubscribe;
  owner.options.reads.activateOccurrences();
}
function clientContext(owner: ProviderOwner, client: ClientRecord): TaskApiContext {
  return {
    reads: owner.options.reads,
    identities: owner.identities,
    cursors: owner.cursors,
    observation: (value) => observation(owner, value),
    internal: (operation) => internal(owner, operation),
    check: (signal) => {
      const failure = checkProvider(owner);
      if (failure !== undefined) return failure;
      if (!client.live) return readError('lifecycle', 'DISPOSED', 'Task API is disposed.');
      if (signal?.aborted === true)
        return readError('lifecycle', 'ABORTED', 'Task read was aborted.');
      return undefined;
    },
  };
}
function subscribe(
  owner: ProviderOwner,
  context: TaskApiContext,
  client: ClientRecord,
  listener: (event: ApiEventV1) => void,
): ApiResultV1<() => void> {
  try {
    if (typeof listener !== 'function')
      return readError('validation', 'INVALID_ARGUMENT', 'Invalid API listener.');
    const failed = context.check();
    if (failed !== undefined) return failed;
    if (client.listeners.size >= owner.info.limits.maxListenersPerClient)
      return readError('resource', 'RESOURCE_LIMIT', 'Task listener capacity is exhausted.');
    // Repeated callbacks still have distinct registration lifetimes.
    const record = (event: ApiEventV1): void => {
      listener(event);
    };
    client.listeners.add(record);
    const state = context.reads.capture();
    invoke(
      owner,
      client,
      record,
      freezeValue({ ...context.observation(state), type: 'state', lifecycle: state.lifecycle }),
    );
    return Object.freeze({
      ok: true,
      value: () => {
        client.listeners.delete(record);
      },
    });
  } catch {
    return internal(owner, 'subscribe');
  }
}
function clientTasks(
  owner: ProviderOwner,
  client: ClientRecord,
  mutation: Omit<Parameters<typeof createTaskApiMutations>[0], 'mutations'>,
): TasksApiV1['tasks'] {
  const context = mutation.api;
  const content =
    owner.options.content === undefined
      ? undefined
      : new TaskContentApi({
          ...mutation,
          ports: owner.options.content,
          now: owner.options.now,
          ...(owner.projects === undefined ? {} : { projects: owner.projects }),
        });
  if (content !== undefined) client.content = content;
  const searches = new TaskSearchReads(
    context,
    owner.options.search,
    owner.options.now,
    owner.options.epoch,
  );
  client.search = searches;
  return Object.freeze({
    ...createTaskApiReads(context),
    tags: (query?: ListTaskTagsV1, options?: ReadOptionsV1) => searches.tags(query, options),
    ...(owner.options.search === undefined
      ? {}
      : {
          search: (query: SearchTasksV1, options?: ReadOptionsV1) =>
            searches.search(query, options),
        }),
    ...(content === undefined
      ? {}
      : {
          tree: content.tree.bind(content),
          prepare: content.prepare.bind(content),
          apply: (input: ApplyTaskContentV1, options?: MutationOptionsV1) =>
            content.mutate('tasks.apply', input, options),
          create: (input: ApplyTaskContentV1, options?: MutationOptionsV1) =>
            content.mutate('tasks.create', input, options),
        }),
    ...createTaskApiMutations({ ...mutation, mutations: owner.options.mutations }),
  });
}
function getApi(
  owner: ProviderOwner,
  version: number,
  input: { consumerId: string },
): ApiResultV1<TasksApiV1> {
  try {
    const validation = validateApiRequest(version, input);
    if (!validation.ok) return validation;
    const failed = checkProvider(owner);
    if (failed !== undefined) return failed;
    if (owner.clients.size >= owner.info.limits.maxClients)
      return readError('resource', 'RESOURCE_LIMIT', 'Task client capacity is exhausted.');
    activate(owner);
    const client: ClientRecord = { live: true, listeners: new Set(), waits: new Set() };
    owner.clients.add(client);
    const context = clientContext(owner, client);
    const mutation = {
      api: context,
      consumerId: validation.value,
      requests: owner.requests,
      epoch: owner.options.epoch,
      isDisposed: () => owner.closed || !client.live,
    };
    const notes =
      owner.notes === undefined
        ? undefined
        : new NoteApi({ ...mutation, registry: owner.notes, now: owner.options.now });
    if (notes !== undefined) client.notes = notes;
    const api: TasksApiV1 = {
      ...(notes === undefined ? {} : { notes: notes.api }),
      info: owner.info,
      ready: (input) => ready(context, client, input),
      subscribe: (listener) => subscribe(owner, context, client, listener),
      dispose: () => {
        closeClient(owner, client);
      },
      tasks: clientTasks(owner, client, mutation),
      ...(owner.projects === undefined
        ? {}
        : {
            projects: Object.freeze({
              ...createProjectApiReads(context, owner.projects.ports.reads, owner.projects.registry)
                .api,
              ...createProjectApiMutations({
                ...mutation,
                projects: owner.projects.registry,
                ports: owner.projects.ports,
              }),
            }),
          }),
    };
    return Object.freeze({ ok: true, value: Object.freeze(api) });
  } catch {
    return internal(owner, 'getApi');
  }
}
/** One optional, epoch-local facade. Mutable ownership remains constructor-local. */
export class TaskApiProvider implements TasksApiProviderV1 {
  readonly getApi: (version: number, options: { consumerId: string }) => ApiResultV1<TasksApiV1>;
  readonly dispose: () => void;
  constructor(options: ProviderOptions) {
    const owner: ProviderOwner = {
      options,
      ...(options.notes === undefined
        ? {}
        : { notes: new NoteReadRegistry(options.notes, options.epoch, options.now) }),
      ...(options.projects === undefined
        ? {}
        : {
            projects: {
              ports: options.projects,
              registry: new ProjectReadRegistry(options.projects.reads, options),
            },
          }),
      requests: new TaskRequestRegistry({ epoch: options.epoch, now: options.now }),
      identities: new TaskIdentityRegistry({ epoch: options.epoch, now: options.now }),
      cursors: new TaskCursorRegistry({ epoch: options.epoch, now: options.now }),
      clients: new Set(),
      publications: [],
      publishing: false,
      info: apiInfo(options),
      closed: false,
      diagnostics: 0,
    };
    this.getApi = (version, input) => getApi(owner, version, input);
    this.dispose = () => {
      closeProvider(owner);
    };
  }
}

async function ready(
  context: TaskApiContext,
  client: ClientRecord,
  input: unknown,
): Promise<ApiResultV1<ReadyV1>> {
  try {
    const options = validateReadOptions(input);
    if (!options.ok) return options;
    const { signal } = options.value;
    const check = (): ApiResultV1<ReadyV1> | undefined => {
      const failed = context.check(signal);
      if (failed !== undefined) return failed;
      const state = context.reads.capture();
      if (state.lifecycle === 'initializing') return undefined;
      const failure = lifecycleError(state);
      if (failure !== undefined) return failure;
      return freezeValue({
        ok: true,
        value: { ...context.observation(state), lifecycle: 'ready' as const },
      });
    };
    const initial = check();
    if (initial !== undefined) {
      await Promise.resolve();
      return (
        context.check(signal) ??
        check() ??
        readError('lifecycle', 'NOT_READY', 'Task reads are initializing.')
      );
    }
    const result = await new Promise<ApiResultV1<ReadyV1>>((resolve) => {
      let settled = false;
      const wake = (): void => {
        if (settled) return;
        let result: ApiResultV1<ReadyV1> | undefined;
        try {
          result = check();
        } catch {
          result = context.internal('ready');
        }
        if (result === undefined) return;
        settled = true;
        client.waits.delete(wake);
        try {
          signal?.removeEventListener('abort', wake);
        } catch {
          result = context.internal('ready');
        }
        resolve(result);
      };
      client.waits.add(wake);
      try {
        signal?.addEventListener('abort', wake, { once: true });
        wake();
      } catch {
        client.waits.delete(wake);
        settled = true;
        try {
          signal?.removeEventListener('abort', wake);
        } catch {
          context.internal('ready');
        }
        resolve(context.internal('ready'));
      }
    });
    return context.check(signal) ?? result;
  } catch {
    return context.internal('ready');
  }
}
