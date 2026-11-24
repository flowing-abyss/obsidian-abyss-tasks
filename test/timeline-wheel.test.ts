import { expect, it, vi } from 'vitest';
import { bindTimelineWheel } from '../src/panels/virtualization/timelineWheel';

function wheelSurface() {
  const scroll = document.createElement('div');
  document.body.append(scroll);
  Object.defineProperties(scroll, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 2400 },
  });
  scroll.style.lineHeight = '20px';
  const canPublish = vi.fn(() => true);
  const positions: Array<[number, number]> = [];
  const dispose = bindTimelineWheel(scroll, canPublish, () => {
    positions.push([scroll.scrollTop, scroll.scrollLeft]);
  });
  return {
    scroll,
    canPublish,
    positions,
    wheel(init: WheelEventInit, target: HTMLElement = scroll) {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    dispose() {
      dispose();
      scroll.remove();
    },
  };
}

it('publishes the clamped destination once for dominant vertical pixel, line and page wheels', () => {
  const h = wheelSurface();
  try {
    expect(h.wheel({ deltaY: 600, deltaX: 10 })).toBe(true);
    expect(h.wheel({ deltaMode: 1, deltaY: 30 })).toBe(true);
    expect(h.wheel({ deltaMode: 2, deltaY: 6 })).toBe(true);
    expect(h.wheel({ deltaMode: 2, deltaY: 1 })).toBe(false);
    expect(h.wheel({ deltaY: -3200 })).toBe(true);
    expect(h.positions).toEqual([
      [600, 10],
      [1200, 10],
      [2000, 10],
      [0, 10],
    ]);
  } finally {
    h.dispose();
  }
});

it('leaves mixed line and page input and native value controls to the browser', () => {
  const h = wheelSurface();
  try {
    const number = h.scroll.createEl('input', { type: 'number' });
    const select = h.scroll.createEl('select');
    expect.soft(h.wheel({ deltaMode: 1, deltaY: 40, deltaX: 2 })).toBe(false);
    expect.soft(h.wheel({ deltaMode: 2, deltaY: 2, deltaX: 1 })).toBe(false);
    for (const control of [select, number]) {
      control.focus();
      expect.soft(h.wheel({ deltaY: 600 }, control)).toBe(false);
    }
    expect(h.positions).toEqual([]);
    for (const target of [
      h.scroll.createEl('button', { cls: 'abyss-status-marker' }),
      h.scroll.createSpan(),
    ])
      expect(h.wheel({ deltaY: 600 }, target)).toBe(true);
  } finally {
    h.dispose();
  }
});

it.each(['contain', 'none'] as const)(
  'preserves %s scroll chaining at the edge of a nested vertical scrollport',
  (overscroll) => {
    const h = wheelSurface();
    try {
      const nested = h.scroll.createDiv();
      nested.style.overflowY = 'auto';
      nested.style.overscrollBehaviorY = overscroll;
      Object.defineProperties(nested, {
        clientHeight: { value: 80 },
        scrollHeight: { value: 180 },
      });
      nested.scrollTop = 100;
      const child = nested.createSpan();
      expect(h.wheel({ deltaY: 600 }, child)).toBe(false);
      nested.style.overscrollBehaviorY = 'auto';
      expect(h.wheel({ deltaY: 600 }, child)).toBe(true);
    } finally {
      h.dispose();
    }
  },
);

it.each(['ltr', 'rtl'] as const)(
  'preserves a consumable horizontal component in a nested %s scrollport',
  (direction) => {
    const h = wheelSurface();
    try {
      const nested = h.scroll.createDiv();
      nested.style.overflowX = 'auto';
      nested.style.direction = direction;
      Object.defineProperties(nested, { clientWidth: { value: 100 }, scrollWidth: { value: 240 } });
      const dx = direction === 'rtl' ? -20 : 20;
      expect(h.wheel({ deltaX: dx, deltaY: 600 }, nested)).toBe(false);
      nested.scrollLeft = direction === 'rtl' ? -140 : 140;
      nested.style.overscrollBehaviorX = 'contain';
      expect(h.wheel({ deltaX: dx, deltaY: 600 }, nested)).toBe(false);
      nested.style.overscrollBehaviorX = 'auto';
      expect(h.wheel({ deltaX: dx, deltaY: 600 }, nested)).toBe(true);
    } finally {
      h.dispose();
    }
  },
);

it('keeps small, modified, horizontal, nested and unavailable Timeline input native', () => {
  const h = wheelSurface();
  try {
    for (const init of [
      { deltaY: 230 },
      { deltaY: 800, ctrlKey: true },
      { deltaY: 800, metaKey: true },
      { deltaY: 800, shiftKey: true },
      { deltaY: 800, altKey: true },
      { deltaY: 800, cancelable: false },
      { deltaY: 800, deltaX: -820 },
    ])
      expect(h.wheel(init)).toBe(false);
    const nested = h.scroll.createDiv();
    nested.style.overflowY = 'auto';
    Object.defineProperties(nested, {
      clientHeight: { value: 50 },
      scrollHeight: { value: 250 },
    });
    expect(h.wheel({ deltaY: 600 }, nested)).toBe(false);
    nested.scrollTop = 200;
    h.canPublish.mockReturnValue(false);
    expect(h.wheel({ deltaY: 600 }, nested)).toBe(false);
    expect(h.positions).toEqual([]);
    h.canPublish.mockReturnValue(true);
    expect(h.wheel({ deltaY: 600 }, nested)).toBe(true);
    expect(h.positions).toEqual([[600, 0]]);
  } finally {
    h.dispose();
  }
  expect(h.wheel({ deltaY: 600 })).toBe(false);
});
