/** Returns true while Chromium routes the keyboard event through an IME. */
export function isImeOwnedEvent(event: KeyboardEvent): boolean {
  const legacyEvent = event as unknown as { readonly keyCode?: number };
  return event.isComposing || event.key === 'Process' || legacyEvent.keyCode === 229;
}
