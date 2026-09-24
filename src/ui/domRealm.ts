/**
 * Whether `target` is an HTMLElement of the main window's realm or of the realm of the document
 * that owns it. A popout window holds both kinds:
 * - the plugin's own elements stay main-window objects there, because `createEl` builds through
 *   the main document and Obsidian moves the element into the popout document, so they fail the
 *   popout's `instanceof`;
 * - an element the host built in the popout belongs to the popout's realm and fails the main
 *   window's `instanceof`.
 */
export function isRealmHTMLElement(target: EventTarget | null): target is HTMLElement {
  if (target == null || !('ownerDocument' in target)) return false;
  if (target instanceof HTMLElement) return true;
  const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
  const realm = ownerDocument?.defaultView;
  return realm !== null && realm !== undefined && target instanceof realm.HTMLElement;
}
