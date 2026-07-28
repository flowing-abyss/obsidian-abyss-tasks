// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showDatePickerPopover } from '../src/ui/DatePickerPopover';

afterEach(() => {
  vi.useRealTimers();
  activeDocument.querySelectorAll('.tc-date-picker-popover').forEach((element) => element.remove());
});

function host(ownerDocument: Document = activeDocument): {
  anchor: HTMLElement;
  owner: HTMLElement;
} {
  const owner = ownerDocument.createElement('div');
  const anchor = ownerDocument.createElement('button');
  owner.append(anchor);
  ownerDocument.body.append(owner);
  return { anchor, owner };
}

describe('showDatePickerPopover', () => {
  it('prefills the initial value and commits change exactly once', () => {
    const { anchor, owner } = host();
    const onPick = vi.fn();
    const onClose = vi.fn();
    showDatePickerPopover({
      owner,
      anchor,
      initialValue: '2026-07-30',
      onPick,
      onClose,
    });
    const input = owner.querySelector<HTMLInputElement>('input[type="date"]')!;

    expect(input.value).toBe('2026-07-30');
    expect(input.getAttribute('aria-label')).toBe('Set date');
    input.value = '2026-08-02';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith('2026-08-02');
    expect(onClose).toHaveBeenCalledOnce();
    expect(owner.querySelector('.tc-date-picker-popover')).toBeNull();
    owner.remove();
  });

  it('closes on Escape without picking', () => {
    vi.useFakeTimers();
    const { anchor, owner } = host();
    const onPick = vi.fn();
    const onClose = vi.fn();
    showDatePickerPopover({ owner, anchor, onPick, onClose });
    vi.runAllTimers();

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    owner.ownerDocument.dispatchEvent(event);

    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(owner.querySelector('.tc-date-picker-popover')).toBeNull();
    owner.remove();
  });

  it('closes on blur and outside pointer interaction', () => {
    vi.useFakeTimers();
    const blurHost = host();
    const blurClose = vi.fn();
    showDatePickerPopover({ ...blurHost, onPick: vi.fn(), onClose: blurClose });
    const input = blurHost.owner.querySelector<HTMLInputElement>('input[type="date"]')!;
    input.dispatchEvent(new FocusEvent('blur'));
    vi.runAllTimers();
    expect(blurClose).toHaveBeenCalledOnce();
    expect(blurHost.owner.querySelector('.tc-date-picker-popover')).toBeNull();
    blurHost.owner.remove();

    const outsideHost = host();
    const outsideClose = vi.fn();
    showDatePickerPopover({ ...outsideHost, onPick: vi.fn(), onClose: outsideClose });
    vi.runAllTimers();
    outsideHost.owner.ownerDocument.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(outsideClose).toHaveBeenCalledOnce();
    expect(outsideHost.owner.querySelector('.tc-date-picker-popover')).toBeNull();
    outsideHost.owner.remove();
  });

  it('creates and focuses the input in the owner document', () => {
    vi.useFakeTimers();
    const ownerDocument = document.implementation.createHTMLDocument('owner');
    const { anchor, owner } = host(ownerDocument);
    const onClose = vi.fn();
    showDatePickerPopover({ owner, anchor, onPick: vi.fn(), onClose });
    const input = owner.querySelector<HTMLInputElement>('input[type="date"]')!;
    const focus = vi.spyOn(input, 'focus');

    vi.runAllTimers();
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(input.ownerDocument).toBe(ownerDocument);
    expect(focus).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(owner.querySelector('.tc-date-picker-popover')).not.toBeNull();
    owner.remove();
  });

  it('returns idempotent cleanup that removes listeners and calls onClose once', () => {
    vi.useFakeTimers();
    const { anchor, owner } = host();
    const onClose = vi.fn();
    const cleanup = showDatePickerPopover({ owner, anchor, onPick: vi.fn(), onClose });
    vi.runAllTimers();

    cleanup();
    cleanup();
    owner.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    owner.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(owner.querySelector('.tc-date-picker-popover')).toBeNull();
    owner.remove();
  });
});
