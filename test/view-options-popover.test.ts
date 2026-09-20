import { afterEach, describe, expect, it, vi } from 'vitest';
import { openViewOptionsPopover } from '../src/ui/ViewOptionsPopover';
import {
  cssDeclarationValue,
  cssDeclarationsFor,
  expectDefined,
  freshContainer,
  loadPluginStyles,
  methodOf,
} from './helpers';

let resizeObserverCallback: ResizeObserverCallback | undefined;
let resizeObserverDisconnected = false;
const observedElements: Element[] = [];

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
    resizeObserverDisconnected = false;
  }

  observe(element: Element): void {
    observedElements.push(element);
  }

  disconnect(): void {
    resizeObserverDisconnected = true;
  }
}

function triggerResizeObserver(): void {
  if (!resizeObserverDisconnected) {
    resizeObserverCallback?.([], {} as ResizeObserver);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resizeObserverCallback = undefined;
  resizeObserverDisconnected = false;
  observedElements.length = 0;
  activeDocument.querySelectorAll('.abyss-view-state-popover').forEach((element) => {
    element.remove();
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

describe('openViewOptionsPopover', () => {
  it('anchors the menu end to its trigger through the actual bordered and scrolled offset parent', () => {
    const host = freshContainer();
    const controls = host.createDiv({ cls: 'abyss-center-controls' });
    const anchor = controls.createEl('button');
    activeDocument.body.append(host);
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 20, 900, 600),
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(600, 80, 30, 30),
    });
    Object.defineProperties(controls, {
      clientLeft: { configurable: true, value: 7 },
      clientTop: { configurable: true, value: 5 },
      scrollLeft: { configurable: true, value: 11 },
      scrollTop: { configurable: true, value: 13 },
    });
    Object.defineProperty(controls, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(500, 50, 500, 60),
    });
    const realRect = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('.abyss-view-state-popover')) return rect(0, 0, 240, 120);
      return realRect.call(this);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.matches('.abyss-view-state-popover') ? controls : null;
    });

    const cleanup = openViewOptionsPopover({ host, anchor, rows: [] });
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    const viewportLeft =
      Number.parseFloat(popover.style.getPropertyValue('--abyss-pop-left')) +
      500 +
      controls.clientLeft -
      controls.scrollLeft;

    expect(viewportLeft + 240).toBe(630);
    expect(viewportLeft + 240).not.toBe(1000);
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('72px');
    expect(popover.dataset['side']).toBe('below');

    cleanup();
    host.remove();
  });

  it('repositions for owner-window movement and menu growth, then tears down idempotently', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const host = freshContainer();
    const controls = host.createDiv({ cls: 'abyss-center-controls' });
    const anchor = controls.createEl('button');
    activeDocument.body.append(host);
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 400, 300),
    });
    let anchorRect = rect(300, 200, 30, 20);
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => anchorRect,
    });
    Object.defineProperty(controls, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 400, 40),
    });
    let floatingRect = rect(0, 0, 100, 40);
    const realRect = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('.abyss-view-state-popover')) return floatingRect;
      return realRect.call(this);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.matches('.abyss-view-state-popover') ? controls : null;
    });
    const ownerWindow = expectDefined(host.ownerDocument.defaultView);
    const removeWindowListener = vi.spyOn(ownerWindow, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(host.ownerDocument, 'removeEventListener');
    const onClose = vi.fn();

    const cleanup = openViewOptionsPopover({ host, anchor, rows: [], onClose });
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    expect(observedElements).toContain(popover);
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('230px');
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('224px');

    anchorRect = rect(200, 200, 30, 20);
    ownerWindow.dispatchEvent(new Event('resize'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('130px');

    anchorRect = rect(180, 200, 30, 20);
    ownerWindow.dispatchEvent(new Event('scroll'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('110px');

    floatingRect = rect(0, 0, 160, 100);
    expect(resizeObserverCallback).toBeDefined();
    triggerResizeObserver();
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('50px');
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('96px');
    expect(popover.dataset['side']).toBe('above');

    cleanup();
    cleanup();
    anchorRect = rect(100, 20, 30, 20);
    ownerWindow.dispatchEvent(new Event('resize'));
    triggerResizeObserver();

    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('50px');
    expect(resizeObserverDisconnected).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    host.remove();
  });

  it('publishes narrow-boundary constraints consumed without legacy toolbar offsets', async () => {
    const host = freshContainer();
    const controls = host.createDiv({ cls: 'abyss-center-controls' });
    const anchor = controls.createEl('button');
    activeDocument.body.append(host);
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 200, 180),
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(160, 30, 30, 20),
    });

    const cleanup = openViewOptionsPopover({ host, anchor, rows: [] });
    const popover = expectDefined(host.querySelector<HTMLElement>('.abyss-view-state-popover'));
    const declarations = cssDeclarationsFor(await loadPluginStyles(), '.abyss-view-state-popover');

    expect(popover.style.getPropertyValue('--abyss-view-state-max-width')).toBe('184px');
    expect(popover.style.getPropertyValue('--abyss-view-state-max-height')).toBe('164px');
    expect(cssDeclarationValue(declarations, 'min-width')).toBe('0');
    expect(cssDeclarationValue(declarations, 'width')).toBeDefined();
    expect(cssDeclarationValue(declarations, 'max-width')).toBe(
      'var(--abyss-view-state-max-width)',
    );
    expect(cssDeclarationValue(declarations, 'max-height')).toBe(
      'min(420px, var(--abyss-view-state-max-height))',
    );
    expect(cssDeclarationValue(declarations, 'top')).toBeUndefined();
    expect(cssDeclarationValue(declarations, 'right')).toBeUndefined();
    expect(cssDeclarationValue(declarations, 'margin-top')).toBeUndefined();

    cleanup();
    host.remove();
  });
});
