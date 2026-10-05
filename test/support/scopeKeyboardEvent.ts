/** The native popout bridge forwards only the actual focused target in its path. */
export function scopeKeyboardEvent(
  target: Element,
  init: KeyboardEventInit,
  path: readonly EventTarget[] = [target],
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
