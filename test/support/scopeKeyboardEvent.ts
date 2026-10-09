/** Synthetic Scope transport: target/view and path are independent host-provided values. */
export function scopeKeyboardEvent(
  target: Element,
  init: KeyboardEventInit,
  path: readonly EventTarget[],
): KeyboardEvent {
  const { view = target.ownerDocument.defaultView, ...keys } = init;
  const event = new KeyboardEvent('keydown', {
    cancelable: true,
    ...keys,
  });
  Object.defineProperties(event, {
    view: { value: view },
    target: { value: target },
    composedPath: { value: () => [...path] },
  });
  return event;
}
