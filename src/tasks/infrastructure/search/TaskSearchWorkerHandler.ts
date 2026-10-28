import type {
  TaskSearchBackend,
  TaskSearchMessage,
  TaskSearchReply,
} from '../../application/TaskSearchBackend';
import { validTaskSearchMatchScope } from '../../application/TaskSearchEngine';
import { TaskSearchError } from '../../domain/taskSearchTypes';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function string(value: unknown): value is string {
  return typeof value === 'string';
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function cursor(value: unknown): boolean {
  return (
    record(value) &&
    string(value['id']) &&
    integer(value['generation']) &&
    integer(value['total']) &&
    ((value['kind'] === 'roots' && value['access'] === 'forward') ||
      (value['kind'] === 'nodes' && value['access'] === 'random'))
  );
}
function token(value: unknown): boolean {
  return (
    record(value) &&
    string(value['term']) &&
    typeof value['edits'] === 'number' &&
    [0, 1, 2].includes(value['edits']) &&
    typeof value['prefix'] === 'boolean' &&
    Array.isArray(value['swaps']) &&
    value['swaps'].every(string)
  );
}
function query(value: unknown): boolean {
  return (
    record(value) &&
    string(value['original']) &&
    value['original'].length <= 4096 &&
    Array.isArray(value['tokens']) &&
    value['tokens'].length <= 32 &&
    value['tokens'].every(token)
  );
}
function request(value: unknown): boolean {
  return (
    record(value) &&
    validTaskSearchMatchScope({ kind: value['kind'], matchScope: value['matchScope'] }) &&
    typeof value['includeSourcePath'] === 'boolean' &&
    query(value['query']) &&
    ['filePath', 'preferFilePath'].every((key) => value[key] === undefined || string(value[key]))
  );
}
function order(value: unknown): boolean {
  return (
    record(value) &&
    string(value['filePath']) &&
    integer(value['line']) &&
    Array.isArray(value['childLines']) &&
    value['childLines'].every(integer)
  );
}
function document(value: unknown): boolean {
  return (
    record(value) &&
    integer(value['id']) &&
    integer(value['rootId']) &&
    order(value['order']) &&
    ['title', 'description', 'comments', 'tags', 'metadata', 'links', 'sourcePath'].every(
      (key) => typeof value[key] === 'string',
    )
  );
}
function mutation(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value['type']) {
    case 'publish':
      return integer(value['generation']);
    case 'begin':
    case 'commit':
    case 'remove':
      return string(value['path']);
    case 'add':
      return (
        Array.isArray(value['documents']) &&
        value['documents'].length <= 128 &&
        value['documents'].every(document)
      );
    default:
      return false;
  }
}
function batch(value: Record<string, unknown>): boolean {
  return (
    cursor(value['cursor']) &&
    integer(value['offset']) &&
    integer(value['limit']) &&
    value['limit'] > 0 &&
    value['limit'] <= 200
  );
}
function operation(value: Record<string, unknown>): boolean {
  switch (value['type']) {
    case 'init':
      return true;
    case 'release':
      return cursor(value['cursor']);
    case 'read':
      return batch(value);
    case 'open':
      return (
        integer(value['generation']) &&
        request(value['request']) &&
        (value['allocationId'] === undefined || string(value['allocationId']))
      );
    case 'mutate':
      return mutation(value['operation']);
    default:
      return false;
  }
}
/** Decoder is shared with protocol/artifact tests; malformed requests never enter the engine. */
export function decodeTaskSearchRequest(value: unknown): TaskSearchMessage | undefined {
  if (!record(value) || !integer(value['epoch']) || !integer(value['id']) || !operation(value))
    return undefined;
  return value as TaskSearchMessage;
}

export function createTaskSearchWorkerHandler(
  runtime: TaskSearchBackend,
  postMessage: (reply: TaskSearchReply) => void,
): (data: unknown) => Promise<void> {
  let epoch: number | undefined;
  let queue = Promise.resolve();
  const failure = (id: number, phase: 'operation' | 'maintenance', error?: unknown): void => {
    if (epoch !== undefined)
      postMessage({
        epoch,
        id,
        type: 'failure',
        code: error instanceof TaskSearchError ? error.code : 'unavailable',
        message: `Search ${phase} failed`,
      });
  };
  runtime.subscribeFailure(() => {
    failure(0, 'maintenance');
  });
  return async (data): Promise<void> => {
    const message = decodeTaskSearchRequest(data);
    if (message?.type === 'init') {
      if (epoch === undefined) {
        epoch = message.epoch;
        postMessage({ epoch, type: 'ready' });
      }
    } else if (message !== undefined && message.epoch === epoch) {
      queue = queue.then(async () => {
        try {
          let value: Promise<Extract<TaskSearchReply, { type: 'success' }>['value']> | undefined;
          switch (message.type) {
            case 'mutate':
              await runtime.mutate(message.operation);
              break;
            case 'open':
              value = runtime.open(message.request, message.generation, message.allocationId);
              break;
            case 'read':
              value = runtime.read(message.cursor, message.offset, message.limit);
              break;
            case 'release':
              await runtime.release(message.cursor);
              break;
          }
          postMessage({
            epoch: message.epoch,
            id: message.id,
            type: 'success',
            value: await value,
          });
        } catch (error) {
          failure(message.id, 'operation', error);
        }
      });
      return queue;
    }
  };
}
