import { afterEach, expect, it, vi } from 'vitest';
import { bindTaskListTouch } from '../src/panels/virtualization/taskListTouch';

function surface() {
  const scroll = document.body.createDiv();
  Object.defineProperties(scroll, { clientHeight: { value: 400 }, scrollHeight: { value: 2400 } });
  const row = scroll.createDiv({ cls: 'abyss-task-card', attr: { draggable: 'true' } });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((request) => {
    frames.delete(request);
  });
  const canPublish = vi.fn(() => true);
  const positions: number[] = [];
  const dispose = bindTaskListTouch(scroll, canPublish, () => positions.push(scroll.scrollTop));
  function touch(
    type: string,
    y: number,
    time: number,
    options: {
      x?: number;
      count?: number;
      identifier?: number;
      cancelable?: boolean;
      target?: Element;
    } = {},
  ) {
    const count = options.count ?? (type === 'touchend' || type === 'touchcancel' ? 0 : 1);
    const event = new Event(type, { bubbles: true, cancelable: options.cancelable ?? true });
    Object.defineProperties(event, {
      touches: {
        value: Array.from({ length: count }, (_, i) => ({
          identifier: i,
          clientX: options.x ?? 50,
          clientY: y,
        })),
      },
      changedTouches: {
        value: [{ identifier: options.identifier ?? 0, clientX: options.x ?? 50, clientY: y }],
      },
      timeStamp: { value: time },
    });
    (options.target ?? row).dispatchEvent(event);
    return event.defaultPrevented;
  }
  function paint(time: number) {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => {
      callback(time);
    });
  }
  return { scroll, row, frames, canPublish, positions, dispose, touch, paint };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('coalesces a vertical drag to a single canonical destination per paint and coasts after release', () => {
  const h = surface();
  try {
    expect(h.touch('touchstart', 300, 10)).toBe(false);
    expect(h.touch('touchmove', 298, 12)).toBe(false);
    expect(h.touch('touchmove', 210, 34)).toBe(true);
    expect(h.touch('touchmove', 110, 50)).toBe(true);
    expect(h.frames.size).toBe(1);
    h.paint(52);
    expect(h.positions).toEqual([190]);
    h.touch('touchend', 110, 55);
    h.paint(71);
    expect(h.scroll.scrollTop).toBeGreaterThan(190);
    const before = h.scroll.scrollTop;
    h.paint(2000);
    // A busy renderer must not resume a two-second-old fling on its next paint.
    expect(h.scroll.scrollTop - before).toBeLessThan(2);
    expect(h.frames.size).toBe(0);
    expect(h.positions[h.positions.length - 1]).toBe(h.scroll.scrollTop);
    h.row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.frames.size).toBe(0);
    expect(h.touch('touchstart', 200, 2005)).toBe(false);
    expect(h.touch('touchend', 200, 2020)).toBe(false);
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('keeps horizontal, multitouch, uncancelable and unavailable gestures native through release', () => {
  const h = surface();
  try {
    h.touch('touchstart', 200, 0);
    expect(h.touch('touchmove', 190, 10, { x: 110 })).toBe(false);
    expect(h.touch('touchmove', 30, 20)).toBe(false);
    h.touch('touchend', 30, 30);
    h.touch('touchstart', 200, 50);
    expect(h.touch('touchmove', 140, 70, { count: 2 })).toBe(false);
    expect(h.touch('touchmove', 30, 90)).toBe(false);
    h.touch('touchend', 30, 100);
    h.touch('touchstart', 200, 110);
    expect(h.touch('touchmove', 100, 130, { cancelable: false })).toBe(false);
    h.touch('touchend', 100, 140);
    h.canPublish.mockReturnValue(false);
    h.touch('touchstart', 200, 160);
    expect(h.touch('touchmove', 100, 180)).toBe(false);
    expect(h.frames.size).toBe(0);
    expect(h.positions).toEqual([]);
  } finally {
    h.dispose();
  }
});

it('leaves taps, slight finger movement and horizontal travel free of layout reads', () => {
  const h = surface();
  try {
    const nested = h.row.createDiv();
    nested.style.overflowY = 'auto';
    const height = vi.fn(() => 80);
    Object.defineProperties(nested, {
      scrollHeight: { get: height },
      clientHeight: { get: height },
    });
    const target = nested.createSpan();
    const editable = vi.fn(() => false);
    Object.defineProperty(target, 'isContentEditable', { get: editable });
    const styles = vi.spyOn(window, 'getComputedStyle');
    h.touch('touchstart', 250, 0, { target });
    expect(h.touch('touchmove', 248, 12, { target })).toBe(false);
    expect(h.touch('touchend', 249, 30, { target })).toBe(false);
    h.touch('touchstart', 250, 40, { target });
    expect(h.touch('touchend', 248, 64, { target, x: 95 })).toBe(false);
    expect(styles).not.toHaveBeenCalled();
    expect(editable).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
    expect(h.canPublish).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('checks the original scroller on first vertical travel even for a detached touchend target', () => {
  const h = surface();
  try {
    const nested = h.row.createDiv();
    const target = nested.createSpan();
    h.touch('touchstart', 250, 0, { target });
    nested.style.overflowY = 'auto';
    Object.defineProperties(nested, { scrollHeight: { value: 200 }, clientHeight: { value: 80 } });
    target.remove();
    expect(h.touch('touchend', 140, 30, { target })).toBe(false);
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('preserves native range editing, form controls and nested scrollers while accepting a task action button', () => {
  const h = surface();
  try {
    const track = h.row.createDiv({ attr: { 'data-timeline-part': 'track' } });
    const nested = h.row.createDiv();
    nested.style.overflowY = 'auto';
    Object.defineProperties(nested, { clientHeight: { value: 50 }, scrollHeight: { value: 200 } });
    for (const target of [track.createSpan(), h.row.createEl('input'), nested.createSpan()]) {
      h.touch('touchstart', 240, 0, { target });
      expect(h.touch('touchmove', 80, 20, { target })).toBe(false);
      h.touch('touchend', 80, 30, { target });
    }
    const action = h.row.createEl('button').createSvg('svg');
    h.touch('touchstart', 180, 40, { target: action });
    expect(h.touch('touchmove', 110, 60, { target: action })).toBe(true);
    h.paint(64);
    expect(h.positions).toEqual([70]);
    h.touch('touchcancel', 110, 65, { target: action });
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('flushes finger travel without inertia for reduced motion, late release, or a boundary', () => {
  const h = surface();
  try {
    const preference = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('matchMedia', preference);
    h.touch('touchstart', 170, 0);
    h.touch('touchmove', 80, 20);
    h.touch('touchend', 80, 22);
    h.paint(35);
    expect(h.positions).toEqual([90]);
    expect(h.frames.size).toBe(0);
    preference.mockReturnValue({ matches: false });
    h.touch('touchstart', 170, 50);
    h.touch('touchmove', 80, 70);
    h.touch('touchend', 80, 400);
    h.paint(415);
    expect(h.positions).toEqual([90, 180]);
    expect(h.frames.size).toBe(0);
    h.scroll.scrollTop = 1990;
    h.touch('touchstart', 200, 500);
    h.touch('touchmove', 100, 520);
    h.touch('touchend', 100, 525);
    h.paint(540);
    h.paint(555);
    expect(h.scroll.scrollTop).toBe(2000);
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('cleans up a queued move and its original touch target even after the row is unmounted', () => {
  const h = surface();
  h.touch('touchstart', 250, 0);
  h.touch('touchmove', 200, 20);
  h.row.remove();
  h.dispose();
  expect(h.frames.size).toBe(0);
  expect(h.touch('touchmove', 100, 30)).toBe(false);
  h.paint(32);
  expect(h.positions).toEqual([]);
});

it('yields a long press to native dragstart and keeps independently draggable descendants native', () => {
  const h = surface();
  try {
    const title = h.row.createSpan();
    h.touch('touchstart', 300, 0, { target: title });
    title.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(h.touch('touchmove', 180, 800, { target: title })).toBe(false);
    const image = h.row.createEl('img', { attr: { draggable: 'true' } });
    h.touch('touchstart', 300, 900, { target: image });
    expect(h.touch('touchmove', 180, 920, { target: image })).toBe(false);
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('stops queued travel on a second contact, a suspended surface, or an owner-window change', () => {
  const h = surface();
  const other = document.body.createEl('iframe');
  try {
    h.touch('touchstart', 200, 0);
    h.touch('touchmove', 100, 25);
    expect(h.touch('touchstart', 100, 26, { count: 2 })).toBe(false);
    expect(h.frames.size).toBe(0);
    h.touch('touchstart', 200, 50);
    h.touch('touchmove', 100, 75);
    h.canPublish.mockReturnValue(false);
    h.paint(80);
    expect(h.positions).toEqual([]);
    h.canPublish.mockReturnValue(true);
    h.touch('touchstart', 200, 100);
    h.touch('touchmove', 100, 125);
    other.contentDocument?.adoptNode(h.scroll);
    h.paint(130);
    expect(h.positions).toEqual([]);
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('leaves the first tap after coasting on its actual card and never creates a substitute click', () => {
  const h = surface();
  try {
    const nextRow = h.scroll.createDiv({ cls: 'abyss-task-card', attr: { draggable: 'true' } });
    const clicks: Array<EventTarget | null> = [];
    h.scroll.addEventListener('click', (e) => {
      clicks.push(e.target);
    });
    h.touch('touchstart', 300, 5);
    h.touch('touchmove', 175, 30);
    h.paint(34);
    h.touch('touchend', 175, 40);
    h.paint(56);
    const atPress = h.scroll.scrollTop;
    nextRow.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.touch('touchstart', 250, 60, { target: nextRow })).toBe(false);
    h.paint(72);
    expect(h.scroll.scrollTop).toBe(atPress);
    expect(h.touch('touchend', 250, 82, { target: nextRow })).toBe(false);
    expect(clicks).toEqual([]);
    nextRow.click();
    expect(clicks).toEqual([nextRow]);
  } finally {
    h.dispose();
  }
});

it('consumes a coalesced swipe reported only on touchend, including on a detached original target', () => {
  const h = surface();
  try {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const original = h.row.createSpan();
    h.scroll.scrollTop = 900;
    h.touch('touchstart', 261, 100, { target: original });
    original.remove();
    expect(h.touch('touchend', 758, 240, { target: original })).toBe(true);
    h.paint(256);
    expect(h.positions).toEqual([403]);
    h.touch('touchstart', 200, 300);
    expect(h.touch('touchend', 60, 350, { identifier: 1 })).toBe(false);
    h.touch('touchstart', 200, 400);
    expect(h.touch('touchend', 185, 430, { x: 195 })).toBe(false);
    expect(h.frames.size).toBe(0);
  } finally {
    h.dispose();
  }
});

it('applies only the unreported tail of a claimed swipe and prevents its compatibility click', () => {
  const h = surface();
  try {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    h.touch('touchstart', 490, 10);
    h.touch('touchmove', 220, 32);
    h.paint(36);
    expect(h.touch('touchend', 135, 52)).toBe(true);
    h.paint(68);
    expect(h.positions).toEqual([270, 355]);
    h.touch('touchstart', 490, 100);
    h.touch('touchmove', 220, 120);
    h.paint(128);
    expect(h.touch('touchend', 220, 140)).toBe(true);
    h.paint(156);
    expect(h.positions).toEqual([270, 355, 625]);
  } finally {
    h.dispose();
  }
});
