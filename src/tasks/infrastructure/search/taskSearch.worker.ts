import type { TaskSearchMessage, TaskSearchReply } from '../../application/TaskSearchBackend';
import { TaskSearchError } from '../../domain/taskSearchTypes';
import { createMiniSearchTaskEngine } from './MiniSearchTaskEngine';
import { createSearchWordSegmenter } from './searchWordSegmenter';
import { TaskSearchRuntime } from './TaskSearchRuntime';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function cursor(value: unknown): boolean {
  return (
    record(value) &&
    typeof value['id'] === 'string' &&
    integer(value['generation']) &&
    integer(value['total']) &&
    ((value['kind'] === 'roots' && value['access'] === 'forward') ||
      (value['kind'] === 'nodes' && value['access'] === 'random'))
  );
}
function token(value: unknown): boolean {
  return (
    record(value) &&
    typeof value['term'] === 'string' &&
    typeof value['edits'] === 'number' &&
    [0, 1, 2].includes(value['edits']) &&
    typeof value['prefix'] === 'boolean' &&
    Array.isArray(value['swaps']) &&
    value['swaps'].every((swap: unknown) => typeof swap === 'string')
  );
}
function query(value: unknown): boolean {
  return (
    record(value) &&
    typeof value['original'] === 'string' &&
    value['original'].length <= 4096 &&
    Array.isArray(value['tokens']) &&
    value['tokens'].length <= 32 &&
    value['tokens'].every(token)
  );
}
function request(value: unknown): boolean {
  return (
    record(value) &&
    (value['kind'] === 'roots' || value['kind'] === 'nodes') &&
    typeof value['includeSourcePath'] === 'boolean' &&
    query(value['query']) &&
    ['filePath', 'preferFilePath'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    )
  );
}
function order(value: unknown): boolean {
  return (
    record(value) &&
    typeof value['filePath'] === 'string' &&
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
      return typeof value['path'] === 'string';
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
function page(value: Record<string, unknown>): boolean {
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
      return page(value);
    case 'open':
      return (
        integer(value['generation']) &&
        request(value['request']) &&
        (value['allocationId'] === undefined || typeof value['allocationId'] === 'string')
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
interface SearchWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: TaskSearchReply): void;
}
const scope = self as unknown as SearchWorkerScope;
if (!('document' in self) && typeof scope.postMessage === 'function') {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(createSearchWordSegmenter()));
  let epoch: number | undefined;
  let queue = Promise.resolve();
  runtime.subscribeFailure(() => {
    if (epoch !== undefined)
      scope.postMessage({
        epoch,
        id: 0,
        type: 'failure',
        code: 'unavailable',
        message: 'Search maintenance failed',
      });
  });
  scope.onmessage = (event): void => {
    const message = decodeTaskSearchRequest(event.data);
    if (message === undefined) return;
    if (message.type === 'init') {
      if (epoch === undefined) {
        epoch = message.epoch;
        scope.postMessage({ epoch, type: 'ready' });
      }
      return;
    }
    if (message.epoch !== epoch) return;
    queue = queue.then(async () => {
      try {
        let value: Extract<TaskSearchReply, { type: 'success' }>['value'];
        switch (message.type) {
          case 'mutate':
            await runtime.mutate(message.operation);
            break;
          case 'open':
            value = await runtime.open(message.request, message.generation, message.allocationId);
            break;
          case 'read':
            value = await runtime.read(message.cursor, message.offset, message.limit);
            break;
          case 'release':
            runtime.release(message.cursor);
            break;
        }
        scope.postMessage({ epoch: message.epoch, id: message.id, type: 'success', value });
      } catch (error) {
        scope.postMessage({
          epoch: message.epoch,
          id: message.id,
          type: 'failure',
          code: error instanceof TaskSearchError ? error.code : 'unavailable',
          message: 'Search operation failed',
        });
      }
    });
  };
}
