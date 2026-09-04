import { expectDefined, freshContainer, methodOf } from './helpers';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { showDatePickerPopover } from '../src/ui/DatePickerPopover';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  activeDocument.querySelectorAll('.abyss-date-picker-popover').forEach((element) => {
    element.remove();
  });
});

function host(ownerDocument: Document = activeDocument): {
  anchor: HTMLElement;
  boundary: HTMLElement;
  owner: HTMLElement;
} {
  const owner = ownerDocument.adoptNode(freshContainer());
  const anchor = ownerDocument.adoptNode(freshContainer().createEl('button'));
  owner.append(anchor);
  ownerDocument.body.append(owner);
  return { anchor, boundary: owner, owner };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function mockPopoverRect(width: number, height: number): void {
  const real = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('abyss-date-picker-popover')) return rect(0, 0, width, height);
    return real.call(this);
  });
}

describe('showDatePickerPopover', () => {
  it('acquires one blocking owner and releases it idempotently on replacement and close', () => {
    vi.useFakeTimers();
    const { anchor, boundary, owner } = host();
    const releases = [vi.fn(), vi.fn()];
    const acquire = vi
      .fn()
      .mockReturnValueOnce({ release: releases[0] })
      .mockReturnValueOnce({ release: releases[1] });
    const interactionOwnership = { acquire };

    const firstClose = showDatePickerPopover({
      owner,
      anchor,
      boundary,
      onPick: vi.fn(),
      interactionOwnership,
    });
    const secondClose = showDatePickerPopover({
      owner,
      anchor,
      boundary,
      onPick: vi.fn(),
      interactionOwnership,
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenNthCalledWith(1, { blocksShortcuts: true });
    expect(releases[0]).toHaveBeenCalledOnce();
    firstClose();
    secondClose();
    secondClose();
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
    owner.remove();
  });

  it('prefills the initial value and commits change exactly once', () => {
    vi.useFakeTimers();
    const { anchor, boundary, owner } = host();
    const onPick = vi.fn();
    const onClose = vi.fn();
    anchor.focus();
    showDatePickerPopover({
      owner,
      anchor,
      boundary,
      initialValue: '2026-07-30',
      onPick,
      onClose,
    });
    const input = expectDefined(owner.querySelector<HTMLInputElement>('input[type="date"]'));
    vi.runAllTimers();

    expect(input.value).toBe('2026-07-30');
    expect(input.getAttribute('aria-label')).toBe('Set date');
    input.value = '2026-08-02';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith('2026-08-02');
    expect(onClose).toHaveBeenCalledOnce();
    expect(owner.querySelector('.abyss-date-picker-popover')).toBeNull();
    expect(owner.ownerDocument.activeElement).toBe(anchor);
    owner.remove();
  });

  it('closes on Escape without picking', () => {
    vi.useFakeTimers();
    const { anchor, boundary, owner } = host();
    const onPick = vi.fn();
    const onClose = vi.fn();
    anchor.focus();
    showDatePickerPopover({ owner, anchor, boundary, onPick, onClose });
    vi.runAllTimers();

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    owner.ownerDocument.dispatchEvent(event);

    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(owner.querySelector('.abyss-date-picker-popover')).toBeNull();
    expect(owner.ownerDocument.activeElement).toBe(anchor);
    owner.remove();
  });

  it('closes on blur and outside pointer interaction', () => {
    vi.useFakeTimers();
    const blurHost = host();
    const blurClose = vi.fn();
    showDatePickerPopover({ ...blurHost, onPick: vi.fn(), onClose: blurClose });
    const input = expectDefined(
      blurHost.owner.querySelector<HTMLInputElement>('input[type="date"]'),
    );
    input.dispatchEvent(new FocusEvent('blur'));
    vi.runAllTimers();
    expect(blurClose).toHaveBeenCalledOnce();
    expect(blurHost.owner.querySelector('.abyss-date-picker-popover')).toBeNull();
    blurHost.owner.remove();

    const outsideHost = host();
    const outsideClose = vi.fn();
    outsideHost.anchor.focus();
    showDatePickerPopover({ ...outsideHost, onPick: vi.fn(), onClose: outsideClose });
    vi.runAllTimers();
    outsideHost.owner.ownerDocument.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(outsideClose).toHaveBeenCalledOnce();
    expect(outsideHost.owner.querySelector('.abyss-date-picker-popover')).toBeNull();
    expect(outsideHost.owner.ownerDocument.activeElement).toBe(outsideHost.anchor);
    outsideHost.owner.remove();
  });

  it('lets forward focus traversal leave without restoring the anchor after delayed cleanup', () => {
    vi.useFakeTimers();
    const { anchor, boundary, owner } = host();
    const next = owner.createEl('button', { text: 'Next control' });
    anchor.focus();
    showDatePickerPopover({ owner, anchor, boundary, onPick: vi.fn() });
    vi.advanceTimersByTime(0);
    const input = expectDefined(owner.querySelector<HTMLInputElement>('input[type="date"]'));
    expect(owner.ownerDocument.activeElement).toBe(input);

    next.focus();
    vi.advanceTimersByTime(201);

    expect(owner.querySelector('.abyss-date-picker-popover')).toBeNull();
    expect(owner.ownerDocument.activeElement).toBe(next);
    owner.remove();
  });

  it('creates and focuses the input in the owner document', () => {
    vi.useFakeTimers();
    const ownerDocument = document.implementation.createHTMLDocument('owner');
    const { anchor, boundary, owner } = host(ownerDocument);
    const onClose = vi.fn();
    showDatePickerPopover({ owner, anchor, boundary, onPick: vi.fn(), onClose });
    const input = expectDefined(owner.querySelector<HTMLInputElement>('input[type="date"]'));
    const focus = vi.spyOn(input, 'focus');

    vi.runAllTimers();
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(input.ownerDocument).toBe(ownerDocument);
    expect(focus).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(owner.querySelector('.abyss-date-picker-popover')).not.toBeNull();
    owner.remove();
  });

  it('places below-start in owner-local coordinates when the surface fits', () => {
    const ownerDocument = document.implementation.createHTMLDocument('owner');
    const { anchor, boundary, owner } = host(ownerDocument);
    Object.defineProperty(boundary, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 50, 300, 200),
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(140, 70, 20, 20),
    });
    mockPopoverRect(120, 40);

    showDatePickerPopover({ owner, anchor, boundary, onPick: vi.fn() });

    const popover = expectDefined(owner.querySelector<HTMLElement>('.abyss-date-picker-popover'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('40px');
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('44px');
    expect(popover.dataset['side']).toBe('below');
    owner.remove();
  });

  it('converts viewport placement to a bordered and scrolled owner padding box', () => {
    const { anchor, boundary, owner } = host();
    Object.defineProperty(boundary, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 50, 300, 200),
    });
    Object.defineProperties(owner, {
      clientLeft: { configurable: true, value: 3 },
      clientTop: { configurable: true, value: 5 },
      scrollLeft: { configurable: true, value: 11 },
      scrollTop: { configurable: true, value: 13 },
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(140, 70, 20, 20),
    });
    mockPopoverRect(120, 40);

    showDatePickerPopover({ owner, anchor, boundary, onPick: vi.fn() });

    const popover = expectDefined(owner.querySelector<HTMLElement>('.abyss-date-picker-popover'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('48px');
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('52px');
    owner.remove();
  });

  it.each([
    {
      edge: 'left',
      anchor: rect(96, 70, 20, 20),
      left: '8px',
      top: '44px',
      side: 'below',
    },
    {
      edge: 'right',
      anchor: rect(390, 70, 20, 20),
      left: '172px',
      top: '44px',
      side: 'below',
    },
    {
      edge: 'top',
      anchor: rect(140, 52, 20, 20),
      left: '40px',
      top: '26px',
      side: 'below',
    },
    {
      edge: 'bottom',
      anchor: rect(140, 230, 20, 20),
      left: '40px',
      top: '136px',
      side: 'above',
    },
  ])('keeps the surface inside the owner boundary near the $edge edge', (expected) => {
    const ownerDocument = document.implementation.createHTMLDocument('owner');
    const { anchor, boundary, owner } = host(ownerDocument);
    Object.defineProperty(boundary, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 50, 300, 200),
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => expected.anchor,
    });
    mockPopoverRect(120, 40);

    showDatePickerPopover({ owner, anchor, boundary, onPick: vi.fn() });

    const popover = expectDefined(owner.querySelector<HTMLElement>('.abyss-date-picker-popover'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe(expected.left);
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe(expected.top);
    expect(popover.dataset['side']).toBe(expected.side);
    owner.remove();
  });

  it('repositions on owner-window resize and removes resize and scroll listeners on cleanup', () => {
    const { anchor, boundary, owner } = host();
    let anchorRect = rect(40, 20, 20, 20);
    Object.defineProperty(boundary, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 300, 200),
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => anchorRect,
    });
    mockPopoverRect(120, 40);
    const ownerWindow = expectDefined(owner.ownerDocument.defaultView);
    const removeWindowListener = vi.spyOn(ownerWindow, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(owner.ownerDocument, 'removeEventListener');

    const cleanup = showDatePickerPopover({
      owner,
      anchor,
      boundary,
      onPick: vi.fn(),
    });
    const popover = expectDefined(owner.querySelector<HTMLElement>('.abyss-date-picker-popover'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('40px');

    anchorRect = rect(280, 20, 20, 20);
    ownerWindow.dispatchEvent(new Event('resize'));
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('172px');

    cleanup();
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    owner.remove();
  });

  it('uses the owner document for listener registration and cleanup', () => {
    vi.useFakeTimers();
    const ownerDocument = document.implementation.createHTMLDocument('owner');
    const { anchor, boundary, owner } = host(ownerDocument);
    Object.defineProperty(boundary, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 300, 200),
    });
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(20, 20, 20, 20),
    });
    mockPopoverRect(120, 40);
    const globalAdd = vi.spyOn(document, 'addEventListener');
    const globalRemove = vi.spyOn(document, 'removeEventListener');

    const cleanup = showDatePickerPopover({
      owner,
      anchor,
      boundary,
      onPick: vi.fn(),
    });
    vi.runAllTimers();
    cleanup();

    expect(globalAdd).not.toHaveBeenCalled();
    expect(globalRemove).not.toHaveBeenCalled();
    owner.remove();
  });

  it('returns idempotent cleanup that removes listeners and calls onClose once', () => {
    vi.useFakeTimers();
    const { anchor, boundary, owner } = host();
    const onClose = vi.fn();
    anchor.focus();
    const cleanup = showDatePickerPopover({
      owner,
      anchor,
      boundary,
      onPick: vi.fn(),
      onClose,
    });
    vi.runAllTimers();

    cleanup();
    cleanup();
    owner.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    owner.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(owner.querySelector('.abyss-date-picker-popover')).toBeNull();
    expect(owner.ownerDocument.activeElement).toBe(anchor);
    owner.remove();
  });

  it('removes the exact owner-document listeners on external cleanup', () => {
    vi.useFakeTimers();
    const ownerDocument = document.implementation.createHTMLDocument('owner');
    const { anchor, boundary, owner } = host(ownerDocument);
    const addSpy = vi.spyOn(ownerDocument, 'addEventListener');
    const removeSpy = vi.spyOn(ownerDocument, 'removeEventListener');
    anchor.focus();
    const cleanup = showDatePickerPopover({ owner, anchor, boundary, onPick: vi.fn() });
    vi.runAllTimers();
    const registrations = addSpy.mock.calls.filter(
      ([type]) => type === 'mousedown' || type === 'keydown',
    );

    cleanup();

    expect(registrations).toHaveLength(2);
    for (const registration of registrations) {
      expect(removeSpy.mock.calls).toContainEqual(registration);
    }
    owner.remove();
  });
});
