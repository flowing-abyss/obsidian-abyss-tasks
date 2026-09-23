/** Whether `target` is an HTMLElement of its own realm (the main window or a popout window). */
export function isRealmHTMLElement(target: EventTarget | null): target is HTMLElement {
  if (target == null || !('ownerDocument' in target)) return false;
  const ownerDocument = (target as { readonly ownerDocument?: Document }).ownerDocument;
  const realm = ownerDocument?.defaultView;
  return realm !== null && realm !== undefined && target instanceof realm.HTMLElement;
}
