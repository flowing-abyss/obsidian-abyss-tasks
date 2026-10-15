import type { App } from 'obsidian';

const queues = new WeakMap<App, Map<string, Promise<void>>>();

/** Orders repository host writes and their awaited cleanup without nesting file locks. */
export async function runTaskFileMutation<T>(
  app: App,
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  let paths = queues.get(app);
  if (paths === undefined) {
    paths = new Map();
    queues.set(app, paths);
  }
  const previous = paths.get(path) ?? Promise.resolve();
  const current = previous.then(work);
  // A failed operation releases its successors; its caller still receives the rejection.
  const settled = current.then(
    () => {},
    () => {},
  );
  paths.set(path, settled);
  try {
    return await current;
  } finally {
    if (paths.get(path) === settled) paths.delete(path);
    if (paths.size === 0) queues.delete(app);
  }
}
