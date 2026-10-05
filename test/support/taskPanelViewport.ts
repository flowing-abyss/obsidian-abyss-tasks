import { afterEach, beforeEach, vi } from 'vitest';
import { CenterPanel } from '../../src/panels/CenterPanel';
import { methodOf } from '../helpers';

/** jsdom has no layout: provide a connected native viewport for real panel integration tests. */
export function useTaskPanelViewport(): void {
  const mounted = new Map<CenterPanel, HTMLElement>();
  beforeEach(() => {
    const mount = methodOf(CenterPanel.prototype, 'mount');
    vi.spyOn(CenterPanel.prototype, 'mount').mockImplementation(function (this: CenterPanel, el) {
      mounted.set(this, el);
      prepareTaskPanelViewport(el);
      mount.call(this, el);
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
    Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    for (const [panel, el] of mounted) {
      panel.destroy();
      el.remove();
    }
    mounted.clear();
  });
}

/** Also usable when a test deliberately restores spies mid-case or mounts in another realm. */
export function prepareTaskPanelViewport(el: HTMLElement): void {
  const owner = el.ownerDocument.defaultView;
  if (!el.isConnected) {
    let root = el;
    while (root.parentElement !== null) root = root.parentElement;
    el.ownerDocument.body.append(root);
  }
  if (owner === null) return;
  vi.spyOn(owner.HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
  vi.spyOn(owner.HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
  Object.defineProperty(el.ownerDocument, 'fonts', {
    value: new EventTarget(),
    configurable: true,
  });
  Object.defineProperty(owner, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
}

/** Capacity from the fixture's measured cards, native viewport and existing 170px overscan. */
export function taskCardMountBound(root: HTMLElement, pins = 0): number {
  const scroll = root.querySelector<HTMLElement>('.abyss-center-scroll');
  const heights = [...root.querySelectorAll<HTMLElement>('.abyss-task-card')].map(
    (card) => card.getBoundingClientRect().height,
  );
  const minimum = Math.min(...heights);
  if (scroll === null || !Number.isFinite(minimum) || minimum <= 0)
    throw new Error('Expected positive native card/viewport geometry');
  return Math.ceil((scroll.clientHeight + 2 * 170) / minimum) + 2 + pins;
}
