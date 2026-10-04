import { BrowserTaskCancelled, createBrowserTaskScheduler } from '../../../browserTaskScheduler';
import type { TaskSearchCursor } from '../../application/TaskSearchApi';
import type {
  TaskSearchBackend,
  TaskSearchBackendPage,
  TaskSearchMutation,
  TaskSearchOperation,
  TaskSearchReply,
  TaskSearchScheduler,
} from '../../application/TaskSearchBackend';
import type { TaskSearchEngineRequest } from '../../application/TaskSearchEngine';
import { TaskSearchError } from '../../domain/taskSearchTypes';
let nextEpoch = 0;
/** Owns exactly one Blob URL, Worker, timeout and pending-request table. */
export class BrowserTaskSearchBackend implements TaskSearchBackend {
  private readonly epoch = ++nextEpoch;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Extract<TaskSearchReply, { type: 'success' }>['value']) => void;
      reject: (error: TaskSearchError) => void;
    }
  >();
  private readonly listeners = new Set<(cause: unknown) => void>();
  private readonly url: string;
  private worker: Worker | undefined;
  private sequence = 0;
  private disposed = false;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((cause: unknown) => void) | undefined;
  private readonly timer: number | undefined;
  private readonly ready: Promise<void>;
  private constructor(source: string) {
    this.url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    try {
      this.worker = new Worker(this.url);
      this.worker.onmessage = (event: MessageEvent<TaskSearchReply>) => {
        this.receive(event.data);
      };
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.failure();
      };
      this.worker.onmessageerror = () => {
        this.failure();
      };
      this.timer = window.setTimeout(() => {
        this.failure();
      }, 5000);
      this.worker.postMessage({ type: 'init', epoch: this.epoch, id: 0 });
    } catch {
      this.failure();
    }
  }
  static async create(source: string, signal?: AbortSignal): Promise<BrowserTaskSearchBackend> {
    const check = (): void => {
      if (signal?.aborted === true)
        throw new TaskSearchError('aborted', 'Search startup cancelled');
    };
    check();
    const backend = new BrowserTaskSearchBackend(source);
    const abort = (): void => {
      backend.dispose();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await backend.ready;
      check();
      return backend;
    } catch (error) {
      check();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private receive(reply: TaskSearchReply): void {
    if (this.disposed || reply.epoch !== this.epoch) return;
    if (reply.type === 'ready') {
      window.clearTimeout(this.timer);
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (reply.type === 'failure' && reply.id === 0) {
      this.failure();
      return;
    }
    const pending = this.pending.get(reply.id);
    if (pending === undefined) return;
    this.pending.delete(reply.id);
    if (reply.type === 'success') pending.resolve(reply.value);
    else pending.reject(new TaskSearchError(reply.code, 'Search operation failed'));
  }
  private request(
    operation: TaskSearchOperation,
  ): Promise<Extract<TaskSearchReply, { type: 'success' }>['value']> {
    if (this.disposed)
      return Promise.reject(new TaskSearchError('unavailable', 'Search worker unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker?.postMessage({ ...operation, epoch: this.epoch, id });
      } catch {
        this.failure();
      }
    });
  }
  subscribeFailure(listener: (cause: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async mutate(operation: TaskSearchMutation): Promise<void> {
    await this.request({ type: 'mutate', operation });
  }
  async open(
    request: TaskSearchEngineRequest,
    generation: number,
    allocationId?: string,
  ): Promise<TaskSearchCursor> {
    return (await this.request({
      type: 'open',
      request,
      generation,
      ...(allocationId === undefined ? {} : { allocationId }),
    })) as TaskSearchCursor;
  }
  async read(
    cursor: TaskSearchCursor,
    offset: number,
    limit: number,
  ): Promise<TaskSearchBackendPage> {
    return (await this.request({ type: 'read', cursor, offset, limit })) as TaskSearchBackendPage;
  }
  async release(cursor: TaskSearchCursor): Promise<void> {
    if (!this.disposed) await this.request({ type: 'release', cursor });
  }
  private failure(): void {
    if (this.disposed) return;
    const listeners = [...this.listeners];
    this.dispose();
    for (const listener of listeners)
      listener(new TaskSearchError('unavailable', 'Search worker failed'));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = undefined;
    URL.revokeObjectURL(this.url);
    const error = new TaskSearchError('unavailable', 'Search worker stopped');
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.listeners.clear();
  }
}
export function createBrowserSearchScheduler(): TaskSearchScheduler {
  const scheduler = createBrowserTaskScheduler(window);
  const adapt = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      throw new TaskSearchError(
        error instanceof BrowserTaskCancelled ? 'aborted' : 'unavailable',
        error instanceof BrowserTaskCancelled ? 'Search cancelled' : 'Search scheduling failed',
      );
    }
  };
  return {
    now: () => scheduler.now(),
    yield: (signal) => adapt(() => scheduler.yield(signal)),
    delay: (ms, signal) => adapt(() => scheduler.delay(ms, signal)),
  };
}
