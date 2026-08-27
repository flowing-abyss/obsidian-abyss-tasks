import { Menu, type MenuItem } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import { attachLongPress } from '../src/ui/MobileTouch';
import { freshContainer } from './helpers';

describe('attachLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire onLongPress when touchend comes before delay', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'hello';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    el.dispatchEvent(new TouchEvent('touchend', { cancelable: true }));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('fires onLongPress with dataset.taskText after the delay', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'hello';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith('hello');
  });

  it('prevents default and stops propagation on touchend after a long press', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'x';
    attachLongPress(el, vi.fn(), 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);

    const endEvent = new TouchEvent('touchend', { cancelable: true });
    const preventDefault = vi.spyOn(endEvent, 'preventDefault');
    const stopPropagation = vi.spyOn(endEvent, 'stopPropagation');
    el.dispatchEvent(endEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('cancel timer on touchmove (no fire)', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    el.dispatchEvent(new TouchEvent('touchmove'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancel timer on touchcancel (no fire)', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    el.dispatchEvent(new TouchEvent('touchcancel'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('suppresses contextmenu (preventDefault)', () => {
    const el = activeDocument.createElement('div');
    attachLongPress(el, vi.fn(), 500);

    const ctx = new Event('contextmenu', { cancelable: true });
    const preventDefault = vi.spyOn(ctx, 'preventDefault');
    el.dispatchEvent(ctx);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('sets userSelect, webkitUserSelect, touchAction on the element', () => {
    const el = activeDocument.createElement('div');
    attachLongPress(el, vi.fn(), 500);
    expect(el.style.userSelect).toBe('none');
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(el.style.webkitUserSelect).toBe('none');
    expect(el.style.touchAction).toBe('manipulation');
  });

  it('passes an empty string to onLongPress when dataset.taskText is absent', () => {
    const el = activeDocument.createElement('div');
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledWith('');
  });

  it('respects a custom delayMs', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 2000);

    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cleanup removes all listeners (no further fire)', () => {
    const el = activeDocument.createElement('div');
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    const cleanup = attachLongPress(el, onLongPress, 500);

    cleanup();
    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('opens the explicit Board status action after a short coarse-pointer tap', () => {
    const menuActions: Array<() => void> = [];
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
      const item = {
        setTitle() {
          return this;
        },
        setIcon() {
          return this;
        },
        setChecked() {
          return this;
        },
        setDisabled() {
          return this;
        },
        onClick(action: () => void) {
          menuActions.push(action);
          return this;
        },
      } as unknown as MenuItem;
      build(item);
      return this;
    });
    const root = freshContainer();
    renderBoard(root, {
      columns: [
        { key: 'active', label: 'Active', role: 'regular', items: [{ id: 'a' }] },
        { key: 'done', label: 'Done', role: 'regular', items: [] },
      ],
      mutation: {
        move: vi.fn().mockResolvedValue({ type: 'ok' }),
        menuItems: () => [
          { columnKey: 'done', label: 'Done', icon: 'check', checked: false, disabled: false },
        ],
      },
      itemKey: ({ id }) => id,
      renderItem: (host) => host.createDiv({ text: 'A' }),
    });
    const action = root.querySelector<HTMLButtonElement>('[data-board-status-menu="a"]')!;

    action.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    action.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    action.click();

    expect(menuActions).toHaveLength(1);
  });
});
