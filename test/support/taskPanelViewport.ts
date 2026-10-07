import { afterEach, beforeEach, vi } from 'vitest';
import { CenterPanel } from '../../src/panels/CenterPanel';
import { expectDefined, methodOf } from '../helpers';

const geometryRestores = new Map<
  object,
  { key: string; descriptor: PropertyDescriptor | undefined }
>();
const clampedRoots = new Map<HTMLElement, Document>();
afterEach(() => {
  clampedRoots.clear();
  for (const [prototype, { key, descriptor }] of geometryRestores) {
    if (descriptor === undefined) Reflect.deleteProperty(prototype, key);
    else Object.defineProperty(prototype, key, descriptor);
  }
  geometryRestores.clear();
});

/** jsdom task-list geometry; clamping is opt-in so explicit elastic-scroll fixtures keep their values. */
export function useTaskPanelViewport(clampWrites = false): void {
  const mounted = new Map<CenterPanel, HTMLElement>();
  beforeEach(() => {
    const mount = methodOf(CenterPanel.prototype, 'mount');
    vi.spyOn(CenterPanel.prototype, 'mount').mockImplementation(function (this: CenterPanel, el) {
      mounted.set(this, el);
      prepareTaskPanelViewport(el, clampWrites);
      mount.call(this, el);
    });
    installTaskListGeometry(window);
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

/** Opt-in native clamping belongs to the captured realm; call again to enroll an adopted root. */
export function prepareTaskPanelViewport(el: HTMLElement, clampWrites = false): void {
  if (clampWrites) clampedRoots.set(el, el.ownerDocument);
  const owner = el.ownerDocument.defaultView;
  if (!el.isConnected) {
    let root = el;
    while (root.parentElement !== null) root = root.parentElement;
    el.ownerDocument.body.append(root);
  }
  if (owner === null) return;
  installTaskListGeometry(owner);
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

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function rowHeight(element: Element): number {
  const row = element as HTMLElement;
  if (row.classList.contains('abyss-virtual-row-spacer'))
    return pixels(row.style.getPropertyValue('--abyss-virtual-row-height'));
  if (row.classList.contains('abyss-dep-search-option')) return 48;
  const explicit = pixels(row.style.height);
  if (explicit > 0) return explicit;
  return row.classList.contains('abyss-group-header') ? 32 : 64;
}
function hostPadding(host: HTMLElement): { top: number; bottom: number } {
  const style = host.ownerDocument.defaultView?.getComputedStyle(host);
  return { top: pixels(style?.paddingTop ?? ''), bottom: pixels(style?.paddingBottom ?? '') };
}
/** Actual task-list DOM geometry, leaving unrelated widgets and explicit element overrides intact. */
export function taskListRect(element: HTMLElement): DOMRect | undefined {
  const host = element.classList.contains('abyss-task-list-surface')
    ? element
    : element.parentElement;
  const scroll = taskListScroll(element, host);
  if (scroll === null) return;
  if (element === scroll) return geometryRect(0, scroll.clientWidth, scroll.clientHeight);
  if (host?.classList.contains('abyss-task-list-surface') !== true) return;
  const origin = scroll.clientTop - scroll.scrollTop;
  if (element === host) return geometryRect(origin, host.clientWidth, 0);
  let top = origin + (host === scroll ? 0 : host.clientTop) + hostPadding(host).top;
  for (const row of host.children) {
    if (row === element) break;
    top += rowHeight(row);
  }
  return geometryRect(top, host.clientWidth, rowHeight(element));
}
function taskListScroll(element: HTMLElement, host: HTMLElement | null): HTMLElement | null {
  return host?.classList.contains('abyss-dep-search-results') === true
    ? host
    : element.closest<HTMLElement>('.abyss-center-scroll');
}
function geometryRect(top: number, width: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}
function installTaskListGeometry(owner: Window & typeof window): void {
  const prototype = owner.HTMLElement.prototype;
  if (geometryRestores.has(prototype)) return;
  const rectDescriptor = Object.getOwnPropertyDescriptor(prototype, 'getBoundingClientRect');
  geometryRestores.set(prototype, { key: 'getBoundingClientRect', descriptor: rectDescriptor });
  const readMethod = methodOf(prototype, 'getBoundingClientRect');
  const read = vi.isMockFunction(readMethod)
    ? expectDefined(vi.mocked(readMethod).getMockImplementation())
    : readMethod;
  Object.defineProperty(prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    ...rectDescriptor,
    value(this: HTMLElement) {
      return taskListRect(this) ?? read.call(this);
    },
  });
  const descriptor = expectDefined(
    Object.getOwnPropertyDescriptor(owner.Element.prototype, 'scrollTop'),
  );
  geometryRestores.set(owner.Element.prototype, { key: 'scrollTop', descriptor });
  const writeMethod = expectDefined(methodOf(descriptor, 'set'));
  const write = vi.isMockFunction(writeMethod)
    ? expectDefined(vi.mocked(writeMethod).getMockImplementation())
    : writeMethod;
  Object.defineProperty(owner.Element.prototype, 'scrollTop', {
    ...descriptor,
    set(this: HTMLElement, requested: number) {
      if (
        ![...clampedRoots].some(
          ([root, capturedDocument]) =>
            root.ownerDocument === capturedDocument && root.contains(this),
        )
      ) {
        write.call(this, requested);
        return;
      }
      const host = this.classList.contains('abyss-task-list-surface')
        ? this
        : this.querySelector<HTMLElement>('.abyss-task-list-surface');
      if (host === null || (!this.classList.contains('abyss-center-scroll') && host !== this)) {
        write.call(this, requested);
        return;
      }
      const padding = hostPadding(host);
      const extent =
        host.clientTop +
        padding.top +
        padding.bottom +
        [...host.children].reduce((sum, row) => sum + rowHeight(row), 0);
      write.call(this, Math.max(0, Math.min(requested, Math.max(0, extent - this.clientHeight))));
    },
  });
}
