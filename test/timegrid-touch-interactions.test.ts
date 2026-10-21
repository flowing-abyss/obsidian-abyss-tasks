import { Component, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { calendarOccurrenceForRender } from '../src/views/calendarOccurrences';
import { renderTimedBlocksForDay } from '../src/views/timegrid/renderTimedBlocks';
import { createTimedInteractionOwner } from '../src/views/timegrid/timedInteractions';
import { expectDefined, freshContainer, task, useRealMoment } from './helpers';

useRealMoment();
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function setup() {
  const root = freshContainer().createDiv({ cls: 'abyss-tg-root' });
  document.body.append(root);
  const day = root.createDiv({ cls: 'abyss-tg-day-column' });
  day.dataset['tgDate'] = '2026-10-21';
  const hour = day.createDiv({ cls: 'abyss-tg-hour-column' });
  day.getBoundingClientRect = hour.getBoundingClientRect = () => new DOMRect(0, 100, 300, 1152);
  const owner = createTimedInteractionOwner();
  const component = new Component();
  const source = task({ planning: { due: '2026-10-21', time: '09:00', duration: 60 } });
  const callbacks = {
    occurrenceFor: calendarOccurrenceForRender,
    app: {} as App,
    component,
    interactionOwner: owner,
    statusRegistry: new StatusRegistry(buildDefaultTaskStatuses()),
    onTaskClick: vi.fn(),
    onTaskSelect: vi.fn(),
    onTaskActivate: vi.fn(),
    onKeyboardIntent: vi.fn(),
    onTimedMove: vi.fn(),
    onTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onExtendToSpan: vi.fn(),
    onStartChange: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
  };
  renderTimedBlocksForDay(hour, [source], callbacks, [], { date: '2026-10-21' });
  const block = expectDefined(hour.querySelector<HTMLElement>('.abyss-tg-block'));
  const body = expectDefined(block.querySelector<HTMLElement>('.abyss-tg-block-head'));
  block.getBoundingClientRect = () => new DOMRect(0, 532, 300, 48);
  const pointer = (type: string, y = 556, options: PointerEventInit = {}) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 71,
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'contextmenu' ? 0 : 1,
      clientX: 150,
      clientY: y,
      ...options,
    });
  const start = () => body.dispatchEvent(pointer('pointerdown'));
  const touchMove = () => {
    const event = new TouchEvent('touchmove', { bubbles: true, cancelable: true });
    body.dispatchEvent(event);
    return event;
  };
  const finish = (y = 556) => {
    body.dispatchEvent(pointer('pointerup', y));
    body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
    body.dispatchEvent(pointer('click', y, { detail: 1 }));
  };
  cleanups.push(() => {
    owner.disposeActive();
    component.unload();
    root.remove();
  });
  return { root, block, body, owner, source, callbacks, pointer, start, touchMove, finish };
}

describe('timed touch activation', () => {
  it('opens the inspector once on a short tap, without arming a timed move', () => {
    const h = setup();
    h.start();
    vi.advanceTimersByTime(150);
    expect(h.block.classList.contains('is-picked-up')).toBe(false);
    h.finish();
    vi.advanceTimersByTime(1000);
    expect(h.callbacks.onTaskActivate).toHaveBeenCalledExactlyOnceWith(h.source);
    expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
    expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
    expect(h.block.classList.contains('is-picked-up')).toBe(false);
  });

  it.each([
    { delta: -48, time: '08:00', minutes: 480 },
    { delta: 48, time: '10:00', minutes: 600 },
  ])('moves after holding, without opening the inspector ($time)', ({ delta, time, minutes }) => {
    const h = setup();
    h.start();
    vi.advanceTimersByTime(500);
    h.body.dispatchEvent(h.pointer('contextmenu'));
    expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
    expect(h.block.classList.contains('is-picked-up')).toBe(true);
    h.body.dispatchEvent(h.pointer('pointermove', 556 + delta));
    expect(h.touchMove().defaultPrevented).toBe(true);
    expect(h.root.querySelector('.abyss-calendar-preview')?.textContent).toContain(time);
    h.finish(556 + delta);
    expect(h.callbacks.onTimedMove).toHaveBeenCalledExactlyOnceWith(h.source, {
      destination: 'time-grid',
      date: '2026-10-21',
      startMinutes: minutes,
      dayDelta: 0,
    });
    expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
  });

  it('consumes a stationary long press and leaves the next short tap usable', () => {
    const h = setup();
    h.start();
    vi.advanceTimersByTime(500);
    h.body.dispatchEvent(h.pointer('contextmenu'));
    h.finish();
    expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
    expect(h.callbacks.onTaskClick).not.toHaveBeenCalled();
    expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
    h.start();
    h.finish();
    expect(h.callbacks.onTaskActivate).toHaveBeenCalledExactlyOnceWith(h.source);
  });

  it('leaves an early swipe to native scrolling and never turns it into a delayed drag', () => {
    const h = setup();
    h.start();
    vi.advanceTimersByTime(100);
    h.body.dispatchEvent(h.pointer('pointermove', 580));
    expect(h.touchMove().defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(h.block.classList.contains('is-picked-up')).toBe(false);
    h.finish(580);
    expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
    expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
  });

  it('does not try to cancel touchend after the browser has committed native scrolling', () => {
    const h = setup();
    h.start();
    h.body.dispatchEvent(h.pointer('pointermove', 580));
    h.body.dispatchEvent(h.pointer('pointercancel', 580));
    const end = new TouchEvent('touchend', { bubbles: true, cancelable: false });
    const preventDefault = vi.spyOn(end, 'preventDefault');
    h.body.dispatchEvent(end);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
    h.start();
    h.finish();
    expect(h.callbacks.onTaskActivate).toHaveBeenCalledExactlyOnceWith(h.source);
  });

  it.each(['pointercancel', 'blur', 'dispose', 'second finger'] as const)(
    'cancels a pending hold on %s',
    (ending) => {
      const h = setup();
      h.start();
      vi.advanceTimersByTime(200);
      if (ending === 'dispose') h.owner.disposeActive();
      else if (ending === 'blur') window.dispatchEvent(new Event('blur'));
      else if (ending === 'second finger')
        document.body.dispatchEvent(
          h.pointer('pointerdown', 600, { pointerId: 72, isPrimary: false }),
        );
      else h.body.dispatchEvent(h.pointer('pointercancel'));
      vi.advanceTimersByTime(1000);
      h.body.dispatchEvent(h.pointer('pointermove', 604));
      expect(h.touchMove().defaultPrevented).toBe(false);
      expect(h.block.classList.contains('is-picked-up')).toBe(false);
      h.finish(604);
      expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
    },
  );

  it.each(['pointercancel', 'blur', 'dispose', 'second finger'] as const)(
    'releases an activated hold on %s without writing its preview',
    (ending) => {
      const h = setup();
      h.start();
      vi.advanceTimersByTime(500);
      h.body.dispatchEvent(h.pointer('pointermove', 604));
      expect(h.root.querySelector('.abyss-calendar-preview')).not.toBeNull();
      if (ending === 'dispose') h.owner.disposeActive();
      else if (ending === 'blur') window.dispatchEvent(new Event('blur'));
      else if (ending === 'second finger')
        document.body.dispatchEvent(
          h.pointer('pointerdown', 600, { pointerId: 72, isPrimary: false }),
        );
      else h.body.dispatchEvent(h.pointer('pointercancel'));
      expect(h.root.querySelector('.abyss-calendar-preview')).toBeNull();
      expect(h.touchMove().defaultPrevented).toBe(false);
      h.finish(604);
      expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
      expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
    },
  );

  it.each([200, 500])(
    'keeps a cancelled stationary touch from clicking through after another finger touches the same block (held=%s)',
    (held) => {
      const h = setup();
      h.start();
      vi.advanceTimersByTime(held);
      h.body.dispatchEvent(h.pointer('pointerdown', 556, { pointerId: 72, isPrimary: false }));
      h.body.dispatchEvent(h.pointer('pointerup', 556, { pointerId: 72, isPrimary: false }));
      h.finish();
      expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
      expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
      h.start();
      h.finish();
      expect(h.callbacks.onTaskActivate).toHaveBeenCalledOnce();
    },
  );

  it('does not start resizing with a second finger after cancelling a held move', () => {
    const h = setup();
    h.start();
    vi.advanceTimersByTime(500);
    h.body.dispatchEvent(h.pointer('pointermove', 604));
    const handle = expectDefined(
      h.block.querySelector<HTMLElement>('.abyss-tg-resize-handle--duration'),
    );
    const other = (type: string, y: number) =>
      h.pointer(type, y, { pointerId: 72, isPrimary: false });
    handle.dispatchEvent(other('pointerdown', 580));
    handle.dispatchEvent(other('pointermove', 604));
    handle.dispatchEvent(other('pointerup', 604));
    expect(h.callbacks.onDurationChange).not.toHaveBeenCalled();
    expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
    expect(h.root.querySelector('.abyss-calendar-preview')).toBeNull();
  });

  it('tolerates small hold drift and ignores another pointer release', () => {
    const h = setup();
    h.start();
    h.body.dispatchEvent(h.pointer('pointermove', 559));
    window.dispatchEvent(h.pointer('pointerup', 559, { pointerId: 72 }));
    vi.advanceTimersByTime(500);
    h.body.dispatchEvent(h.pointer('pointermove', 604));
    h.finish(604);
    expect(h.callbacks.onTimedMove).toHaveBeenCalledOnce();
    expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
  });

  it('keeps desktop context menu activation', () => {
    const h = setup();
    h.body.dispatchEvent(h.pointer('contextmenu', 556, { pointerType: 'mouse', button: 2 }));
    expect(h.callbacks.onTaskClick).toHaveBeenCalledExactlyOnceWith(h.source);
  });

  it('does not arm a body move for the status marker', () => {
    const h = setup();
    const marker = expectDefined(h.block.querySelector<HTMLElement>('.abyss-status-marker'));
    marker.dispatchEvent(h.pointer('pointerdown'));
    vi.advanceTimersByTime(1000);
    expect(h.block.classList.contains('is-picked-up')).toBe(false);
    marker.dispatchEvent(h.pointer('pointerup'));
    marker.dispatchEvent(h.pointer('click', 556, { detail: 1 }));
    expect(h.callbacks.onToggle).toHaveBeenCalledOnce();
    expect(h.callbacks.onTaskActivate).not.toHaveBeenCalled();
    expect(h.callbacks.onTimedMove).not.toHaveBeenCalled();
  });
});
