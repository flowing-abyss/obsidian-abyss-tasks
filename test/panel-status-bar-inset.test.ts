import { describe, expect, it, vi } from 'vitest';
import { mountPanelStatusBarInset } from '../src/views/panelStatusBarInset';

describe('desktop panel status-bar overlap', () => {
  it('reserves only overlapping host space, releases it when hidden, and disposes pending work', () => {
    vi.useFakeTimers();
    const owner = document.body.createDiv();
    const bar = document.body.createDiv({ cls: 'status-bar' });
    let bounds = new DOMRect(210, 873, 201, 27);
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 40, 363, 860));
    vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => bounds);
    let resize: ResizeObserverCallback = () => {};
    const disconnect = vi.fn();
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe = observer.observe;
        unobserve = observer.unobserve;
        disconnect = disconnect;
      },
    );
    const stop = mountPanelStatusBarInset(owner);
    const value = () => owner.style.getPropertyValue('--abyss-shell-bottom-inset');
    try {
      vi.advanceTimersByTime(20);
      expect(value()).toBe('27px');
      bounds = new DOMRect(210, 873, 0, 0);
      resize([], observer);
      vi.advanceTimersByTime(20);
      expect(value()).toBe('0px');
      bounds = new DOMRect(500, 873, 200, 27);
      resize([], observer);
      vi.advanceTimersByTime(20);
      expect(value()).toBe('0px');
      bounds = new DOMRect(210, 873, 201, 27);
      resize([], observer);
      stop();
      vi.advanceTimersByTime(20);
      expect(value()).toBe('');
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      owner.remove();
      bar.remove();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
