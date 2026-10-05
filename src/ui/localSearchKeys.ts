import type { Keymap, Scope } from 'obsidian';
import { isImeOwnedEvent } from './ime';

export interface LocalSearchFocusTarget {
  readonly input: HTMLInputElement;
  readonly owner: HTMLElement;
}

function isFind(event: KeyboardEvent, primary: 'meta' | 'ctrl'): boolean {
  return (
    (event.code === 'KeyF' || (event.code === '' && event.key.toLowerCase() === 'f')) &&
    !event.altKey &&
    !event.shiftKey &&
    event.metaKey === (primary === 'meta') &&
    event.ctrlKey === (primary === 'ctrl')
  );
}

export function isPlainSearchEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey
  );
}

function connectedTarget({ input, owner }: LocalSearchFocusTarget): boolean {
  return (
    localSearchSurfaceIsVisible(input) &&
    localSearchSurfaceIsVisible(owner) &&
    !input.disabled &&
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
  if (localSearchKeyIsBlocked(event)) return false;
  if (!connectedTarget(target)) return false;
  const { input, owner } = target;
  const doc = owner.ownerDocument;
  if (isFind(event, primary)) {
    input.focus({ preventScroll: true });
    if (doc.activeElement !== input) return false;
    input.select();
  } else {
    if (!isPlainSearchEscape(event) || doc.activeElement !== input) return false;
    owner.focus({ preventScroll: true });
    if (doc.activeElement !== owner) return false;
  }
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  return true;
}

export function localSearchKeyIsBlocked(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.repeat || isImeOwnedEvent(event);
}

export interface LocalSearchScopeHost {
  readonly parent: Scope;
  readonly keymap: Pick<Keymap, 'pushScope' | 'popScope'>;
}

export function bindLocalSearchScope(
  scope: Scope,
  route: (event: KeyboardEvent) => boolean,
): () => void {
  let disposed = false;
  const callback = (event: KeyboardEvent): false | undefined =>
    !disposed && route(event) ? false : undefined;
  const find = scope.register(['Mod'], 'f', callback);
  const escape = scope.register([], 'Escape', callback);
  return () => {
    if (disposed) return;
    disposed = true;
    scope.unregister(find);
    scope.unregister(escape);
  };
}

function localSearchElementIsHidden(element: HTMLElement, win: Window | null): boolean {
  const style = win?.getComputedStyle(element);
  return (
    element.hidden === true ||
    element.getAttribute('aria-hidden') === 'true' ||
    style?.display === 'none' ||
    style?.visibility === 'hidden' ||
    style?.visibility === 'collapse'
  );
}

export function localSearchSurfaceIsVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const win = element.ownerDocument.defaultView;
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    if (localSearchElementIsHidden(current, win)) return false;
  }
  return true;
}

function neutralDocumentFocus(value: EventTarget | null, doc: Document): boolean {
  return value === null || value === doc || value === doc.body || value === doc.documentElement;
}

export function localSearchEditorOwnsEvent(
  event: KeyboardEvent,
  doc: Document,
  input?: HTMLInputElement,
): boolean {
  const editable =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor, .CodeMirror';
  const blocked = (value: EventTarget | null): boolean => {
    if (input !== undefined && value === input) return false;
    return (
      typeof (value as Element | null)?.closest === 'function' &&
      (value as Element).closest(editable) !== null
    );
  };
  return blocked(doc.activeElement) || event.composedPath().some(blocked);
}

/** Scope callbacks can precede DOM listeners, but never gain another pane's focus. */
export function localSearchEventIsOwned(
  event: KeyboardEvent,
  owner: HTMLElement,
  origin: 'dom' | 'scope',
  neutral = false,
): boolean {
  const doc = owner.ownerDocument;
  if (!localSearchDocumentOwnsFocus(event, owner)) return false;
  const path = event.composedPath();
  const active = doc.activeElement;

  if (path.includes(owner)) return true;
  if (origin === 'dom') return false;
  if (event.target === null && owner.contains(active)) return true;
  if (scopeOwnsFocusedTarget(event, owner, path)) return true;
  return neutral && neutralDocumentFocus(active, doc) && neutralDocumentFocus(event.target, doc);
}

function scopeOwnsFocusedTarget(
  event: KeyboardEvent,
  owner: HTMLElement,
  path: readonly EventTarget[],
): boolean {
  const doc = owner.ownerDocument;
  const active = doc.activeElement;
  // Native popout Scope forwarding can retain only the focused target in its path.
  return (
    event.target === active &&
    active?.ownerDocument === doc &&
    owner.contains(active) &&
    path.length === 1 &&
    path[0] === active
  );
}

function localSearchDocumentOwnsFocus(event: KeyboardEvent, owner: HTMLElement): boolean {
  const doc = owner.ownerDocument;
  if (event.view !== null && event.view.document !== doc) return false;
  return neutralDocumentFocus(doc.activeElement, doc) || owner.contains(doc.activeElement);
}
