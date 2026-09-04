import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const el = freshContainer();
    el.dataset['taskText'] = 'hello';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    el.dispatchEvent(new TouchEvent('touchend', { cancelable: true }));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('fires onLongPress with dataset.taskText after the delay', () => {
    const el = freshContainer();
    el.dataset['taskText'] = 'hello';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith('hello');
  });

  it('prevents default and stops propagation on touchend after a long press', () => {
    const el = freshContainer();
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
    const el = freshContainer();
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    el.dispatchEvent(new TouchEvent('touchmove'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancel timer on touchcancel (no fire)', () => {
    const el = freshContainer();
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    el.dispatchEvent(new TouchEvent('touchcancel'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('suppresses contextmenu (preventDefault)', () => {
    const el = freshContainer();
    attachLongPress(el, vi.fn(), 500);

    const ctx = new Event('contextmenu', { cancelable: true });
    const preventDefault = vi.spyOn(ctx, 'preventDefault');
    el.dispatchEvent(ctx);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('sets userSelect, webkitUserSelect, touchAction on the element', () => {
    const el = freshContainer();
    attachLongPress(el, vi.fn(), 500);
    expect(el.style.userSelect).toBe('none');

    expect(el.style.getPropertyValue('-webkit-user-select')).toBe('none');
    expect(el.style.touchAction).toBe('manipulation');
  });

  it('passes an empty string to onLongPress when dataset.taskText is absent', () => {
    const el = freshContainer();
    const onLongPress = vi.fn();
    attachLongPress(el, onLongPress, 500);

    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledWith('');
  });

  it('respects a custom delayMs', () => {
    const el = freshContainer();
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
    const el = freshContainer();
    el.dataset['taskText'] = 'x';
    const onLongPress = vi.fn();
    const cleanup = attachLongPress(el, onLongPress, 500);

    cleanup();
    el.dispatchEvent(new TouchEvent('touchstart'));
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
