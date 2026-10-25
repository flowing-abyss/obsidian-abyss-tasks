import { afterEach, expect, it, vi } from 'vitest';
import { CompactPaneAccess } from '../src/views/CompactPaneAccess';
import { expectDefined } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('defers header resize writes out of observer delivery and cancels them on replacement or reset', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const observers: Observer[] = [];
  class Observer implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
    trigger() {
      this.callback([], this);
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  const layout = document.body.createDiv();
  const left = layout.createDiv(),
    right = layout.createDiv();
  const leftButton = layout.createEl('button'),
    rightButton = layout.createEl('button');
  const header = layout.createDiv(),
    controls = header.createDiv();
  const bounds = vi
    .spyOn(header, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 100, 400, 48));
  vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 700));
  const access = new CompactPaneAccess({
    mode: () => 'projects',
    projectDashboard: () => true,
    hasSelectedTask: () => false,
    captureState: () => undefined,
    allowsPaneInteraction: () => true,
  });
  try {
    access.mount({ layout, left, right, leftButton, rightButton });
    access.attachHeader(header, controls);
    expect(layout.style.getPropertyValue('--abyss-compact-overlay-top')).toBe('148px');
    const observer = expectDefined(observers.find((o) => o.targets.has(header)));
    bounds.mockReturnValue(new DOMRect(0, 100, 400, 64));
    observer.trigger();
    observer.trigger();
    expect(layout.style.getPropertyValue('--abyss-compact-overlay-top')).toBe('148px');
    expect(frames.size).toBe(1);
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
    expect(layout.style.getPropertyValue('--abyss-compact-overlay-top')).toBe('164px');
    observer.trigger();
    access.attachHeader(header, controls);
    expect(frames.size).toBe(0);
    const replacement = expectDefined(observers.find((o) => o.targets.has(header)));
    replacement.trigger();
    access.reset();
    expect(frames.size).toBe(0);
    expect(replacement.targets.size).toBe(0);
  } finally {
    access.reset();
    layout.remove();
  }
});
