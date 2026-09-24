import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindSegmentedInputCommit,
  type SegmentedCommitReason,
} from '../src/ui/segmentedInputCommit';
import { dispatchImeKey, expectDefined } from './helpers';

afterEach(() => {
  activeDocument.body.empty();
});

function field() {
  const boundary = activeDocument.body.createDiv();
  const input = boundary.createEl('input', { attr: { type: 'time', value: '09:30' } });
  const clear = boundary.createEl('button', { text: 'Clear time' });
  const outside = activeDocument.body.createEl('button', { text: 'Outside' });
  const commit = vi.fn<(reason: SegmentedCommitReason) => void>();
  const handle = bindSegmentedInputCommit({ input, boundary, commit });
  return { boundary, input, clear, outside, commit, handle };
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function change(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function press(input: HTMLInputElement): void {
  input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
}

describe('bindSegmentedInputCommit', () => {
  it.each(['ArrowUp', 'Backspace', 'Process'])('starts a keyboard draft on %s', (value) => {
    const { input, commit } = field();

    key(input, value);
    change(input);

    // A draft limited to printable keys would commit here; an IME early return would for Process.
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits a native change after Tab, which types nothing', () => {
    const { input, commit } = field();

    key(input, 'Tab');
    change(input);

    // Starting a draft on every key would hold this change back.
    expect(commit.mock.calls).toEqual([['change']]);
  });

  it('commits a draft on Enter and keeps the key from the owner', () => {
    const { input, commit } = field();

    key(input, '1');
    const enter = key(input, 'Enter');

    // Committing without preventDefault would let the owner act on this Enter as well.
    expect(enter.defaultPrevented).toBe(true);
    expect(commit.mock.calls).toEqual([['enter']]);
  });

  it('stops a committed Enter before it reaches the element around the field', () => {
    const { boundary, input, commit } = field();
    const owner = expectDefined(boundary.parentElement);
    const ownerKeydown = vi.fn();
    key(input, '1');
    owner.addEventListener('keydown', ownerKeydown);

    try {
      key(input, 'Enter');

      // A commit that only prevents the Enter lets it reach the panel's own Enter handling.
      expect(ownerKeydown).not.toHaveBeenCalled();
      expect(commit.mock.calls).toEqual([['enter']]);
    } finally {
      owner.removeEventListener('keydown', ownerKeydown);
    }
  });

  it('leaves Enter without a draft to the owner', () => {
    const { input, commit } = field();

    const enter = key(input, 'Enter');

    // Preventing every Enter would take the key from the owner when nothing is being typed.
    expect(enter.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['composing', 'legacy'] as const)('leaves an IME Enter to the IME (%s)', (ime) => {
    const { input, commit } = field();

    key(input, '1');
    const enter = dispatchImeKey(input, 'Enter', ime);

    // Without isImeOwnedEvent, as the inspector date popover had, this Enter would commit.
    expect(enter.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits a draft when focus leaves the boundary, not while it moves inside', () => {
    const { input, clear, outside, commit } = field();
    input.focus();
    key(input, '1');

    clear.focus();
    // Watching the input instead of the boundary would commit as soon as focus reaches Clear.
    expect(commit).not.toHaveBeenCalled();
    outside.focus();

    expect(commit.mock.calls).toEqual([['departure']]);
  });

  it('keeps a draft across a window switch and commits on the next departure', () => {
    const { input, outside, commit } = field();
    input.focus();
    key(input, '1');

    // A window switch fires focusout without a related target and keeps the field active.
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(activeDocument.activeElement).toBe(input);
    // Treating every focusout without a related target as a departure would commit here.
    expect(commit).not.toHaveBeenCalled();
    outside.focus();

    expect(commit.mock.calls).toEqual([['departure']]);
  });

  it('commits a draft when the field blurs to the body', () => {
    const { input, commit } = field();
    input.focus();
    key(input, '1');

    input.blur();

    // Treating every focusout without a related target as a window switch would keep the draft.
    expect(commit.mock.calls).toEqual([['departure']]);
  });

  it('keeps a draft the owner refused, so the next Enter commits again', () => {
    const { input, commit } = field();

    key(input, '1');
    key(input, 'Enter');
    key(input, 'Enter');

    // Clearing the draft before `commit` would turn the second Enter into a plain key.
    expect(commit.mock.calls).toEqual([['enter'], ['enter']]);
  });

  it('commits a picker change during a draft after a pointer press', () => {
    const { input, commit } = field();

    key(input, '1');
    press(input);
    change(input);

    // A press that marks nothing would hold the picker's choice back as a typed draft.
    expect(commit.mock.calls).toEqual([['change']]);
  });

  it('commits a typed draft on departure after a press that changes nothing', () => {
    const { input, outside, commit } = field();
    input.focus();
    key(input, '1');
    press(input);

    outside.focus();

    // A press that ends the draft would drop the typed value the field still shows.
    expect(commit.mock.calls).toEqual([['departure']]);
  });

  it('commits a typed draft on Enter after a press that changes nothing', () => {
    const { input, commit } = field();
    key(input, '1');
    press(input);

    const enter = key(input, 'Enter');

    // A press that ends the draft would leave this Enter to owners that ignore it.
    expect(enter.defaultPrevented).toBe(true);
    expect(commit.mock.calls).toEqual([['enter']]);
  });

  it('flushes a typed draft after a press that changes nothing', () => {
    const { input, commit, handle } = field();
    key(input, '1');
    press(input);

    handle.flush();

    // A press that ends the draft would let an outside press close the field without its value.
    expect(commit.mock.calls).toEqual([['flush']]);
  });

  it('holds a typed change back again once a key follows the press', () => {
    const { input, commit } = field();
    key(input, '1');
    press(input);
    key(input, '2');

    change(input);

    // A pointer mark that a later key leaves in place would commit this typed segment.
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps the pointer mark through Shift, which types nothing', () => {
    const { input, commit } = field();
    key(input, '1');
    press(input);
    key(input, 'Shift');

    change(input);

    // A pointer mark that any keydown clears would hold this picker change back as a typed draft.
    expect(commit.mock.calls).toEqual([['change']]);
  });

  it('flushes only a draft', () => {
    const { input, commit, handle } = field();

    handle.flush();
    // A flush that always commits would pick the untouched value on every outside press.
    expect(commit).not.toHaveBeenCalled();
    key(input, '1');
    handle.flush();

    expect(commit.mock.calls).toEqual([['flush']]);
  });

  it('commits nothing after cancel', () => {
    const { input, outside, commit, handle } = field();
    input.focus();
    key(input, '1');

    handle.cancel();
    outside.focus();
    change(input);
    const enter = key(input, 'Enter');
    handle.flush();

    // Clearing only the draft would let the change commit; unhooking only would let flush commit.
    expect(enter.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
});
