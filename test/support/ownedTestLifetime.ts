import type { TestContext } from 'vitest';

function failure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A cancelled row cannot resume from a late host receipt after its mocks are restored. */
export function ownedWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      action();
    };
    const abort = (): void => {
      finish(() => {
        reject(failure(signal.reason ?? new Error('Row cancelled')));
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        if (signal.aborted) abort();
        else
          finish(() => {
            resolve(value);
          });
      },
      (error: unknown) => {
        finish(() => {
          reject(failure(error));
        });
      },
    );
    if (signal.aborted) abort();
  });
}

/** Start cleanup synchronously on cancellation; the finished hook awaits the same disposal. */
export function ownTestCleanup(
  context: Pick<TestContext, 'signal' | 'onTestFinished'>,
  cleanup: () => void | Promise<void>,
): () => Promise<void> {
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal === undefined) {
      context.signal.removeEventListener('abort', abort);
      try {
        disposal = Promise.resolve(cleanup());
      } catch (error) {
        disposal = Promise.reject(failure(error));
      }
    }
    return disposal;
  };
  const abort = (): void => {
    // Keep the rejection for the awaited finished hook without an unhandled event callback.
    void dispose().catch(() => {});
  };
  context.onTestFinished(dispose);
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) abort();
  return dispose;
}
