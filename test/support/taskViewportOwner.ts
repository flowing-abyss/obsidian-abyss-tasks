import { vi } from 'vitest';
import { expectDefined } from '../helpers';

/** Independent native queues for adoption tests; never runs the previous owner's frames. */
export function taskViewportOwner() {
  const iframe = document.body.createEl('iframe');
  const doc = expectDefined(iframe.contentDocument);
  const win = expectDefined(iframe.contentWindow) as Window & typeof window;
  const frames = new Map<number, FrameRequestCallback>();
  const observers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = [];
  let next = 0;
  const request = vi.spyOn(win, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  const cancel = vi.spyOn(win, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  Object.defineProperty(doc, 'fonts', { value: new win.EventTarget(), configurable: true });
  Object.defineProperty(win, 'ResizeObserver', {
    configurable: true,
    value: class {
      readonly elements = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, elements: this.elements });
      }
      observe(element: Element) {
        this.elements.add(element);
      }
      unobserve(element: Element) {
        this.elements.delete(element);
      }
      disconnect() {
        this.elements.clear();
      }
    },
  });
  return {
    doc,
    win,
    frames,
    observers,
    request,
    cancel,
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    destroy() {
      iframe.remove();
    },
  };
}
