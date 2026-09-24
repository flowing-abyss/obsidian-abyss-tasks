import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindSegmentedInputCommit,
  type SegmentedCommitReason,
} from '../src/ui/segmentedInputCommit';
import { dispatchImeKey } from './helpers';

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
  return { input, clear, outside, commit, handle };
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function change(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('change', { bubbles: true }));
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

  it('ends a draft on a pointer press, so the picker change commits at once', () => {
    const { input, commit } = field();

    key(input, '1');
    input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    change(input);

    // Without the pointer reset, the typed draft would hold back the picker's change.
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
