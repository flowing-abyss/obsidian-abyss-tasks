export interface BrowserTaskScheduler {
  now(): number;
  yield(signal: AbortSignal): Promise<void>;
  delay(ms: number, signal: AbortSignal): Promise<void>;
}
export class BrowserTaskCancelled extends Error {
  constructor() {
    super('Browser task cancelled');
  }
}
export class BrowserTaskScheduleError extends Error {
  constructor(
    readonly kind: 'construction' | 'enqueue' | 'cleanup',
    readonly cleanupFailed = false,
  ) {
    super('Browser task scheduling failed');
  }
}
type ScheduleFailure = BrowserTaskCancelled | BrowserTaskScheduleError;
function cleanupResources(actions: Array<() => void>): boolean {
  let failed = false;
  for (const action of actions) {
    try {
      action();
    } catch {
      failed = true;
    }
  }
  actions.length = 0;
  return failed;
}
function outcome(
  signal: AbortSignal,
  failure: ScheduleFailure | undefined,
  cleanupFailed: boolean,
): ScheduleFailure | undefined {
  if (signal.aborted) return new BrowserTaskCancelled();
  if (failure instanceof BrowserTaskScheduleError)
    return new BrowserTaskScheduleError(failure.kind, cleanupFailed || failure.cleanupFailed);
  if (failure !== undefined) return failure;
  return cleanupFailed ? new BrowserTaskScheduleError('cleanup', true) : undefined;
}
interface ChannelResources {
  detach: Array<() => void>;
  release: Array<() => void>;
  finish: (failure?: ScheduleFailure) => void;
}
function acquireChannel(Channel: typeof MessageChannel, resources: ChannelResources): () => void {
  let channel: MessageChannel;
  try {
    channel = new Channel();
  } catch {
    throw new BrowserTaskScheduleError('construction');
  }
  const port1 = channel.port1;
  resources.release.push(() => {
    port1.close();
  });
  const port2 = channel.port2;
  resources.release.push(() => {
    port2.close();
  });
  resources.detach.push(() => {
    port1.onmessage = null;
  });
  port1.onmessage = () => {
    resources.finish();
  };
  return () => {
    port2.postMessage(null);
  };
}
/** Captures one explicit window. Each invocation owns and releases its resources independently. */
export function createBrowserTaskScheduler(owner: Window): BrowserTaskScheduler {
  const performance = owner.performance;
  const Channel = (owner as Window & { MessageChannel?: typeof MessageChannel }).MessageChannel;
  const enqueue = owner.setTimeout.bind(owner),
    clear = owner.clearTimeout.bind(owner);
  const schedule = (signal: AbortSignal, ms?: number): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const detach: Array<() => void> = [],
        release: Array<() => void> = [];
      let accept: (() => void) | undefined = resolve,
        decline: ((error: Error) => void) | undefined = reject;
      const finish = (failure?: ScheduleFailure): void => {
        if (settled) return;
        settled = true;
        const detachFailed = cleanupResources(detach),
          releaseFailed = cleanupResources(release);
        const error = outcome(signal, failure, detachFailed || releaseFailed);
        const done = accept,
          fail = decline;
        accept = undefined;
        decline = undefined;
        if (error === undefined) done?.();
        else fail?.(error);
      };
      const abort = (): void => {
        finish(new BrowserTaskCancelled());
      };
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        let post: (() => void) | undefined;
        if (ms === undefined && typeof Channel === 'function') {
          post = acquireChannel(Channel, { detach, release, finish });
        }
        detach.push(() => {
          signal.removeEventListener('abort', abort);
        });
        signal.addEventListener('abort', abort, { once: true });
        // Read through a function: the listener installation can synchronously abort in injected owners.
        if (isAborted(signal)) {
          abort();
          return;
        }
        if (post !== undefined) post();
        else {
          const timer = enqueue(() => {
            finish();
          }, ms ?? 0);
          release.push(() => {
            clear(timer);
          });
        }
      } catch (error) {
        finish(
          error instanceof BrowserTaskScheduleError
            ? error
            : new BrowserTaskScheduleError('enqueue'),
        );
      }
    });
  return {
    now: () => performance.now(),
    yield: (signal) => schedule(signal),
    delay: (ms, signal) => schedule(signal, ms),
  };
}
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
