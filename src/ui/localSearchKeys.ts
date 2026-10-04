import { isImeOwnedEvent } from './ime';

export interface LocalSearchFocusTarget {
  readonly input: HTMLInputElement;
  readonly owner: HTMLElement;
}

function isFind(event: KeyboardEvent, primary: 'meta' | 'ctrl'): boolean {
  return (
    event.code === 'KeyF' &&
    !event.altKey &&
    !event.shiftKey &&
    event.metaKey === (primary === 'meta') &&
    event.ctrlKey === (primary === 'ctrl')
  );
}

function isEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey
  );
}

function connectedTarget({ input, owner }: LocalSearchFocusTarget): boolean {
  return (
    input.isConnected &&
    owner.isConnected &&
    input.ownerDocument === owner.ownerDocument &&
    owner.contains(input)
  );
}

/** The caller has already proved the current surface and interaction ownership. */
export function handleLocalSearchKey(
  event: KeyboardEvent,
  target: LocalSearchFocusTarget,
  primary: 'meta' | 'ctrl',
): boolean {
  if (event.defaultPrevented || event.repeat || isImeOwnedEvent(event)) return false;
  if (!connectedTarget(target)) return false;
  const { input, owner } = target;
  const doc = owner.ownerDocument;
  if (isFind(event, primary)) {
    input.focus({ preventScroll: true });
    if (doc.activeElement !== input) return false;
    input.select();
  } else {
    if (!isEscape(event) || doc.activeElement !== input) return false;
    owner.focus({ preventScroll: true });
    if (doc.activeElement !== owner) return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}
