const NATIVE_INTERACTION_SELECTOR = '.menu, .modal-container, .suggestion-container';

/** Keeps Obsidian-owned surface selectors out of the generic shortcut router. */
export function nativeInteractionBlocksPanelShortcuts(ownerDocument: Document): boolean {
  return ownerDocument.querySelector(NATIVE_INTERACTION_SELECTOR) !== null;
}
