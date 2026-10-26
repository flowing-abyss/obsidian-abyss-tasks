import { expect, it, vi } from 'vitest';
import { mountProjectCellEditorPosition } from '../src/panels/projects/projectCellEditorPosition';

it('places a floating property editor below its field and keeps it within a narrow owner', () => {
  const boundary = document.body.createDiv();
  const anchor = boundary.createDiv();
  const host = boundary.createDiv();
  vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 320, 500));
  Object.defineProperties(boundary, { clientWidth: { value: 320 }, clientHeight: { value: 500 } });
  let top = 80;
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(190, top, 120, 26),
  );
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 264, 180));
  const release = mountProjectCellEditorPosition({
    boundary,
    anchor,
    host,
    positioningContainer: boundary,
    preferredWidth: 264,
    placement: 'below',
  });
  try {
    expect(host.style.top).toBe('100px');
    expect(host.style.left).toBe('48px');
    top = 450;
    window.dispatchEvent(new Event('resize'));
    expect(host.style.top).toBe('256px');
    expect(host.dataset['side']).toBe('above');
  } finally {
    release();
    boundary.remove();
    vi.restoreAllMocks();
  }
});

it('follows asynchronous layout changes above an unchanged field inside a scrollable menu', () => {
  const callbacks: Array<{ targets: Set<Element>; notify: () => void }> = [];
  class LayoutObserver {
    readonly targets = new Set<Element>();
    constructor(readonly notify: () => void) {
      callbacks.push(this);
    }
    observe(target: Element): void {
      this.targets.add(target);
    }
    disconnect(): void {
      this.targets.clear();
    }
  }
  vi.stubGlobal('ResizeObserver', LayoutObserver);
  const boundary = document.body.createDiv();
  const menu = boundary.createDiv();
  const description = menu.createDiv();
  const anchor = menu.createDiv();
  const host = boundary.createDiv();
  vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));
  Object.defineProperties(boundary, { clientWidth: { value: 400 }, clientHeight: { value: 600 } });
  let top = 100;
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, top, 100, 24));
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 264, 180));
  const release = mountProjectCellEditorPosition({
    boundary,
    host,
    anchor,
    positioningContainer: boundary,
    placement: 'below',
    layoutElements: [menu, description],
  });
  try {
    const observer = callbacks.find((o) => o.targets.has(description));
    expect(observer).toBeDefined();
    top = 160;
    observer?.notify();
    expect(host.style.top).toBe('188px');
  } finally {
    release();
    boundary.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
