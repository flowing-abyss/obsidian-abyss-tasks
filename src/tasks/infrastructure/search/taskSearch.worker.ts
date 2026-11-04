import type { TaskSearchReply } from '../../application/TaskSearchBackend';
import { createMiniSearchTaskEngine } from './MiniSearchTaskEngine';
import { createSearchWordSegmenter } from './searchWordSegmenter';
import { TaskSearchRuntime } from './TaskSearchRuntime';
import { createTaskSearchWorkerHandler } from './TaskSearchWorkerHandler';

interface SearchWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: TaskSearchReply): void;
}
const scope = self as unknown as SearchWorkerScope;
if (!('document' in self) && typeof scope.postMessage === 'function') {
  const runtime = new TaskSearchRuntime(createMiniSearchTaskEngine(createSearchWordSegmenter()));
  const fatal = (): void => {
    queueMicrotask(() => {
      throw new Error('Search worker failed');
    });
  };
  const receive = createTaskSearchWorkerHandler(runtime, (reply) => {
    try {
      scope.postMessage(reply);
    } catch {
      fatal();
    }
  });
  // Dedicated Worker channel owned by BrowserTaskSearchBackend, not a Window listener.
  // These messages have an empty origin; a Window-style origin allowlist would reject them.
  // https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-dedicatedworkerglobalscope-interface
  scope.onmessage = (event): void => {
    receive(event.data).catch(fatal);
  };
}
