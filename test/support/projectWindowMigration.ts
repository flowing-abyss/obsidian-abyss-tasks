import { vi } from 'vitest';

/** Deliver Obsidian's native migration notification after real DOM adoption. */
export function projectWindowMigration() {
  const bindings = new Map<HTMLElement, Set<(win: Window) => unknown>>();
  const retired: Array<() => void> = [];
  vi.spyOn(HTMLElement.prototype, 'onWindowMigrated').mockImplementation(function (
    this: HTMLElement,
    listener,
  ) {
    const listeners = bindings.get(this) ?? new Set<(win: Window) => unknown>();
    bindings.set(this, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) bindings.delete(this);
    };
  });
  return {
    bindings,
    retired,
    notify(host: HTMLElement) {
      const win = host.ownerDocument.defaultView;
      if (win === null) throw new Error('Expected window');
      for (const [element, listeners] of bindings) {
        if (host !== element && !host.contains(element)) continue;
        for (const listener of listeners) {
          retired.push(() => listener(win));
          listener(win);
        }
      }
    },
  };
}

/** Records the actual native acquisitions and validates matching-owner release. */
export function projectNativeBindings(doc: Document) {
  const targets: EventTarget[] = [doc];
  if (doc.defaultView !== null) targets.push(doc.defaultView);
  const audits = targets.map((target) => ({
    add: vi.spyOn(target, 'addEventListener'),
    remove: vi.spyOn(target, 'removeEventListener'),
  }));
  return { audits };
}
