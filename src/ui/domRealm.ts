type NodeType =
  | 'Node'
  | 'Element'
  | 'HTMLElement'
  | 'HTMLInputElement'
  | 'HTMLTextAreaElement'
  | 'HTMLButtonElement';

/** Obsidian nodes may be created in one window and displayed in another. */
export function isRealmNode<K extends NodeType>(
  target: EventTarget | null | undefined,
  type: K,
): target is InstanceType<(typeof window)[K]> {
  if (target == null || !('ownerDocument' in target)) return false;
  const node = target as Node & { readonly defaultView?: Document['defaultView'] };
  if (typeof node.instanceOf === 'function' && node.instanceOf(window[type])) return true;
  const realm = node.ownerDocument?.defaultView ?? node.defaultView;
  return realm != null && target instanceof realm[type];
}

export function isRealmHTMLElement(target: EventTarget | null): target is HTMLElement {
  return isRealmNode(target, 'HTMLElement');
}
