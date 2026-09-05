import type { AppState, TaskNodeDragPayload } from '../app/AppState';

/** The native source owns cleanup; AppState is the sole cross-panel payload. */
export function startTaskNodeDrag(
  state: AppState,
  container: HTMLElement,
  source: HTMLElement,
  {
    payload,
    onEnd,
  }: {
    readonly payload: TaskNodeDragPayload;
    readonly onEnd: () => void;
  },
): () => void {
  const document = source.ownerDocument;
  const OwnerMutationObserver = document.defaultView?.MutationObserver;
  if (OwnerMutationObserver === undefined) {
    onEnd();
    return () => {};
  }
  state.set('draggingTaskNode', payload);
  const published = state.get('draggingTaskNode');
  const wasConnected = container.isConnected;
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    observer.disconnect();
    off();
    document.removeEventListener('dragend', finish);
    document.removeEventListener('drop', finish);
    document.removeEventListener('keydown', cancel, true);
    onEnd();
    if (state.get('draggingTaskNode') === published) state.set('draggingTaskNode', null);
  };
  const cancel = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // Native cancellation consumes Escape, preserving an explicit add disclosure beneath it.
    event.preventDefault();
    event.stopPropagation();
    finish();
  };
  const observer = new OwnerMutationObserver(() => {
    if (!container.contains(source) || (wasConnected && !source.isConnected)) finish();
  });
  const off = state.on('draggingTaskNode', (current) => {
    if (current !== published) finish();
  });
  observer.observe(document, { childList: true, subtree: true });
  if (!container.isConnected) observer.observe(container, { childList: true, subtree: true });
  document.addEventListener('dragend', finish);
  document.addEventListener('drop', finish);
  document.addEventListener('keydown', cancel, true);
  return finish;
}
