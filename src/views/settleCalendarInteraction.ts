import { runAsyncAction } from '../ui/runAsyncAction';

/** Releases a preview after its command, preserving synchronous callback compatibility. */
export function settleCalendarInteraction(
  commit: () => void | Promise<void>,
  dispose: () => void = () => undefined,
): void {
  let completion: void | Promise<void>;
  try {
    completion = commit();
  } catch (error) {
    dispose();
    runAsyncAction(
      Promise.reject(
        error instanceof Error
          ? error
          : Object.assign(new Error('Calendar interaction failed'), { cause: error }),
      ),
    );
    return;
  }
  if (completion === undefined) dispose();
  else runAsyncAction(completion.finally(dispose));
}
