import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi } from '../src/tasks';
import { CalendarRenderer } from '../src/ui/CalendarRenderer';
import {
  Toolbar,
  type ToolbarCallbacks,
  type ToolbarState,
  type ViewEntry,
} from '../src/ui/Toolbar';
import { freshContainer, resolvedConfig, task, taskQueryApi, useRealMoment } from './helpers';

useRealMoment();

const VIEWS: ViewEntry[] = [
  { id: 'list', icon: '', label: 'List' },
  { id: 'month', icon: '', label: 'Month' },
  { id: 'week', icon: '', label: 'Week' },
];

type ToolbarSpies = {
  [K in keyof ToolbarCallbacks]: ReturnType<typeof vi.fn>;
};

function makeCallbacks(): { callbacks: ToolbarCallbacks; spies: ToolbarSpies } {
  const spies: ToolbarSpies = {
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToday: vi.fn(),
    onViewSwitch: vi.fn(),
    onFilterToggle: vi.fn(),
    onOverdueHighlight: vi.fn(),
    onStatFilter: vi.fn(),
    onStyleChange: vi.fn(),
  };
  return { spies, callbacks: spies as unknown as ToolbarCallbacks };
}

function secondaryDocument(): { ownerDocument: Document; remove: () => void } {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const ownerWindow = frame.contentWindow as Window & typeof globalThis;
  for (const method of ['createDiv', 'createEl', 'empty', 'addClass'] as const) {
    Object.defineProperty(ownerWindow.HTMLElement.prototype, method, {
      configurable: true,
      value: HTMLElement.prototype[method],
    });
  }
  return { ownerDocument, remove: () => frame.remove() };
}

const baseState: ToolbarState = {
  currentView: 'month',
  currentTitle: 'June 2026',
  currentStyle: 'style1',
  filterActive: false,
  overdueHighlightActive: false,
  stats: { done: 0, due: 0, overdue: 0, start: 0, scheduled: 0, recurrence: 0, dailyNote: 0 },
  activeStatGroup: null,
};

describe('Toolbar', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = freshContainer();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it('adds one .buttons div to container', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      expect(container.querySelectorAll('.buttons')).toHaveLength(1);
      tb.destroy();
    });

    it('creates expected buttons', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const cls = [
        '.filter',
        '.listView',
        '.monthView',
        '.weekView',
        '.current',
        '.previous',
        '.next',
        '.overdueHighlighter',
        '.statistic',
      ];
      for (const c of cls) {
        expect(container.querySelector(c), `missing ${c}`).not.toBeNull();
      }
      tb.destroy();
    });

    it('weekViewContext has 11 style li entries', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      expect(container.querySelectorAll('.weekViewContext li')).toHaveLength(11);
      tb.destroy();
    });

    it('statisticPopup has 6 stat li entries', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      expect(container.querySelectorAll('.statisticPopup li')).toHaveLength(6);
      tb.destroy();
    });

    it('each stat li has data-group + stat-count initialized to "0"', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const lis = container.querySelectorAll('.statisticPopup li');
      lis.forEach((li) => {
        expect((li as HTMLElement).getAttribute('data-group')).not.toBeNull();
        expect(li.querySelector('.stat-count')?.textContent).toBe('0');
      });
      tb.destroy();
    });
  });

  describe('button click routing', () => {
    it('filter button → onFilterToggle', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      (container.querySelector('.filter') as HTMLButtonElement).click();
      expect(spies.onFilterToggle).toHaveBeenCalledTimes(1);
      tb.destroy();
    });

    it('inactive monthView click → onViewSwitch("month")', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'list' });
      (container.querySelector('.monthView') as HTMLButtonElement).click();
      expect(spies.onViewSwitch).toHaveBeenCalledWith('month');
      tb.destroy();
    });

    it('active view button click → opens style popup', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'month' });
      const btn = container.querySelector('.monthView') as HTMLButtonElement;
      btn.click();
      const popup = container.querySelector('.weekViewContext') as HTMLElement;
      expect(popup.classList.contains('active')).toBe(true);
      tb.destroy();
    });

    it('second click on active view button closes style popup', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'month' });
      const btn = container.querySelector('.monthView') as HTMLButtonElement;
      btn.click();
      expect(
        (container.querySelector('.weekViewContext') as HTMLElement).classList.contains('active'),
      ).toBe(true);
      btn.click();
      expect(
        (container.querySelector('.weekViewContext') as HTMLElement).classList.contains('active'),
      ).toBe(false);
      tb.destroy();
    });

    it('style li click → onStyleChange + popup closes', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'month' });
      (container.querySelector('.monthView') as HTMLButtonElement).click();
      const li = container.querySelector('.weekViewContext li[data-style="style3"]') as HTMLElement;
      li.click();
      expect(spies.onStyleChange).toHaveBeenCalledWith('style3');
      expect(
        (container.querySelector('.weekViewContext') as HTMLElement).classList.contains('active'),
      ).toBe(false);
      tb.destroy();
    });

    it('current button → onToday', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      (container.querySelector('.current') as HTMLButtonElement).click();
      expect(spies.onToday).toHaveBeenCalledTimes(1);
      tb.destroy();
    });

    it('previous → onPrev, next → onNext', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      (container.querySelector('.previous') as HTMLButtonElement).click();
      expect(spies.onPrev).toHaveBeenCalledTimes(1);
      (container.querySelector('.next') as HTMLButtonElement).click();
      expect(spies.onNext).toHaveBeenCalledTimes(1);
      tb.destroy();
    });

    it('overdueHighlighter → onOverdueHighlight', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      (container.querySelector('.overdueHighlighter') as HTMLButtonElement).click();
      expect(spies.onOverdueHighlight).toHaveBeenCalledTimes(1);
      tb.destroy();
    });

    it('statistic button toggles active on statBtn + statPopup', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const statBtn = container.querySelector('.statistic') as HTMLButtonElement;
      statBtn.click();
      expect(statBtn.classList.contains('active')).toBe(true);
      expect(
        (container.querySelector('.statisticPopup') as HTMLElement).classList.contains('active'),
      ).toBe(true);
      tb.destroy();
    });

    it('stat li click when inactive → onStatFilter(group) + active', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const li = container.querySelector('.statisticPopup li[data-group="done"]') as HTMLElement;
      li.click();
      expect(spies.onStatFilter).toHaveBeenCalledWith('done');
      expect(li.classList.contains('active')).toBe(true);
      tb.destroy();
    });

    it('stat li click when active → onStatFilter(null) + not active', () => {
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const li = container.querySelector('.statisticPopup li[data-group="done"]') as HTMLElement;
      li.click(); // activate
      li.click(); // deactivate
      expect(spies.onStatFilter).toHaveBeenLastCalledWith(null);
      expect(li.classList.contains('active')).toBe(false);
      tb.destroy();
    });
  });

  describe('update(state)', () => {
    it('currentBtn textContent = currentTitle', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentTitle: 'July 2026' });
      expect((container.querySelector('.current') as HTMLButtonElement).textContent).toBe(
        'July 2026',
      );
      tb.destroy();
    });

    it('filterBtn active toggles per filterActive', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, filterActive: true });
      expect((container.querySelector('.filter') as HTMLElement).classList.contains('active')).toBe(
        true,
      );
      tb.update({ ...baseState, filterActive: false });
      expect((container.querySelector('.filter') as HTMLElement).classList.contains('active')).toBe(
        false,
      );
      tb.destroy();
    });

    it('overdueBtn active toggles per overdueHighlightActive', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, overdueHighlightActive: true });
      expect(
        (container.querySelector('.overdueHighlighter') as HTMLElement).classList.contains(
          'active',
        ),
      ).toBe(true);
      tb.destroy();
    });

    it('view buttons active reflects currentView', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'week' });
      expect(
        (container.querySelector('.weekView') as HTMLElement).classList.contains('active'),
      ).toBe(true);
      expect(
        (container.querySelector('.monthView') as HTMLElement).classList.contains('active'),
      ).toBe(false);
      tb.destroy();
    });

    it('stat counts update for all 6 groups', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({
        ...baseState,
        stats: { done: 3, due: 5, overdue: 2, start: 1, scheduled: 4, recurrence: 6, dailyNote: 7 },
      });
      expect(
        container.querySelector('.statisticPopup li[data-group="done"] .stat-count')?.textContent,
      ).toBe('3');
      expect(
        container.querySelector('.statisticPopup li[data-group="due"] .stat-count')?.textContent,
      ).toBe('5');
      expect(
        container.querySelector('.statisticPopup li[data-group="start"] .stat-count')?.textContent,
      ).toBe('1');
      expect(
        container.querySelector('.statisticPopup li[data-group="scheduled"] .stat-count')
          ?.textContent,
      ).toBe('4');
      expect(
        container.querySelector('.statisticPopup li[data-group="recurrence"] .stat-count')
          ?.textContent,
      ).toBe('6');
      expect(
        container.querySelector('.statisticPopup li[data-group="dailyNote"] .stat-count')
          ?.textContent,
      ).toBe('7');
      tb.destroy();
    });

    it('keeps toolbar statistics on persisted snapshots while the calendar renders forecasts', () => {
      vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
      const persisted = task({
        title: 'Daily toolbar repeat',
        recurrence: 'every day',
        planning: { due: '2026-08-03' },
        source: { filePath: 'persisted.md', line: 0 },
      });
      const source = {
        root: persisted,
        target: { type: 'task' as const, ref: persisted.ref },
        node: persisted,
      };
      const list = vi.fn(() => [persisted]);
      const forCalendarProjection = vi.fn(() => ({
        materialized: [source],
        recurringSources: [source],
      }));
      const queries = taskQueryApi({ list, forCalendarProjection });
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'invalid',
        issues: [{ code: 'invalid-target' }],
      });
      const root = freshContainer();
      const renderer = new CalendarRenderer(
        root,
        resolvedConfig({ defaultView: 'month', startPosition: '2026-08' }),
        {} as App,
        queries,
        { queries, execute },
        new StatusRegistry(buildDefaultTaskStatuses()),
      );

      renderer.mount();

      expect(root.querySelectorAll("[data-recurrence-forecast='true']").length).toBeGreaterThan(1);
      expect(
        root.querySelector('.statisticPopup li[data-group="due"] .stat-count')?.textContent,
      ).toBe('1');
      expect(
        root.querySelector('.statisticPopup li[data-group="recurrence"] .stat-count')?.textContent,
      ).toBe('1');
      expect(list).toHaveBeenCalled();
      expect(forCalendarProjection).toHaveBeenCalled();
      renderer.destroy();
    });

    it('active style li highlights per currentStyle', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentStyle: 'style5' });
      const activeLi = container.querySelector(
        '.weekViewContext li[data-style="style5"]',
      ) as HTMLElement;
      expect(activeLi.classList.contains('active')).toBe(true);
      const otherLi = container.querySelector(
        '.weekViewContext li[data-style="style1"]',
      ) as HTMLElement;
      expect(otherLi.classList.contains('active')).toBe(false);
      tb.destroy();
    });

    it('activeStatGroup null → no stat li active', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, activeStatGroup: null });
      const activeLis = container.querySelectorAll('.statisticPopup li.active');
      expect(activeLis).toHaveLength(0);
      tb.destroy();
    });

    it('activeStatGroup set → corresponding li active', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, activeStatGroup: 'due' });
      const activeLi = container.querySelector(
        '.statisticPopup li[data-group="due"]',
      ) as HTMLElement;
      expect(activeLi.classList.contains('active')).toBe(true);
      tb.destroy();
    });
  });

  describe('popup dismissal', () => {
    it('owns accessible popup focus and keyboard activation in the toolbar document', () => {
      const secondary = secondaryDocument();
      const { ownerDocument } = secondary;
      const ownerContainer = ownerDocument.createElement('div');
      ownerDocument.body.append(ownerContainer);
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(ownerContainer, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'month', currentStyle: 'style3' });
      const trigger = ownerContainer.querySelector<HTMLButtonElement>('.monthView')!;
      const popup = ownerContainer.querySelector<HTMLElement>('.weekViewContext')!;

      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(popup.getAttribute('role')).toBe('menu');

      trigger.focus();
      trigger.click();
      const selected = popup.querySelector<HTMLElement>('li[data-style="style3"]')!;
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(ownerDocument.activeElement).toBe(selected);
      expect(selected.getAttribute('role')).toBe('menuitemradio');
      expect(selected.getAttribute('aria-checked')).toBe('true');

      selected.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
      );
      expect(spies.onStyleChange).toHaveBeenCalledWith('style3');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(ownerDocument.activeElement).toBe(trigger);
      tb.destroy();
      secondary.remove();
    });

    it('uses one exact owner-document lifecycle for Escape, toggle, update, and destroy', () => {
      const secondary = secondaryDocument();
      const { ownerDocument } = secondary;
      const ownerContainer = ownerDocument.createElement('div');
      ownerDocument.body.append(ownerContainer);
      const addSpy = vi.spyOn(ownerDocument, 'addEventListener');
      const removeSpy = vi.spyOn(ownerDocument, 'removeEventListener');
      const globalAddSpy = vi.spyOn(activeDocument, 'addEventListener');
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(ownerContainer, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'month' });
      const trigger = ownerContainer.querySelector<HTMLButtonElement>('.monthView')!;
      const popup = ownerContainer.querySelector<HTMLElement>('.weekViewContext')!;
      const registrations = (): (typeof addSpy.mock.calls)[number][] => {
        vi.runAllTimers();
        return addSpy.mock.calls.filter(([type]) => type === 'mousedown' || type === 'keydown');
      };
      const expectRemoved = (registered: (typeof addSpy.mock.calls)[number][]): void => {
        expect(registered).toHaveLength(2);
        for (const listener of registered) expect(removeSpy.mock.calls).toContainEqual(listener);
      };

      trigger.focus();
      trigger.click();
      let registered = registrations();
      ownerDocument.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(popup.classList.contains('active')).toBe(false);
      expect(ownerDocument.activeElement).toBe(trigger);
      expectRemoved(registered);

      trigger.click();
      registered = registrations().slice(-2);
      trigger.click();
      expect(popup.classList.contains('active')).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expectRemoved(registered);

      trigger.click();
      registered = registrations().slice(-2);
      tb.update({ ...baseState, currentView: 'month', currentTitle: 'August 2026' });
      expect(popup.classList.contains('active')).toBe(false);
      expectRemoved(registered);

      trigger.click();
      registered = registrations().slice(-2);
      tb.destroy();
      expectRemoved(registered);
      expect(globalAddSpy).not.toHaveBeenCalled();
      secondary.remove();
    });

    it('gives the statistics popup menu semantics, initial focus, and Enter activation', () => {
      activeDocument.body.append(container);
      const { callbacks, spies } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const trigger = container.querySelector<HTMLButtonElement>('.statistic')!;
      const popup = container.querySelector<HTMLElement>('.statisticPopup')!;
      trigger.focus();
      trigger.click();

      const first = popup.querySelector<HTMLElement>('li[data-group="done"]')!;
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(popup.getAttribute('role')).toBe('menu');
      expect(first.getAttribute('role')).toBe('menuitemradio');
      expect(activeDocument.activeElement).toBe(first);

      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      expect(spies.onStatFilter).toHaveBeenCalledWith('done');
      expect(first.getAttribute('aria-checked')).toBe('true');
      tb.destroy();
      container.remove();
    });

    it('style popup: outside mousedown closes it (after timer advances)', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      tb.update({ ...baseState, currentView: 'month' });
      (container.querySelector('.monthView') as HTMLButtonElement).click();
      const popup = container.querySelector('.weekViewContext') as HTMLElement;
      expect(popup.classList.contains('active')).toBe(true);
      // advance the setTimeout(0) that registers the mousedown listener
      vi.advanceTimersByTime(1);
      // dispatch mousedown outside the popup
      activeDocument.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(popup.classList.contains('active')).toBe(false);
      tb.destroy();
    });

    it('stat popup: outside mousedown closes it (after timer advances)', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const statBtn = container.querySelector('.statistic') as HTMLButtonElement;
      statBtn.click();
      vi.advanceTimersByTime(1);
      // mousedown on a target that is NOT statBtn and NOT inside statPopup
      activeDocument.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(
        (container.querySelector('.statisticPopup') as HTMLElement).classList.contains('active'),
      ).toBe(false);
      expect(statBtn.classList.contains('active')).toBe(false);
      tb.destroy();
    });
  });

  describe('destroy', () => {
    it('removes toolbar element from DOM', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const el = container.querySelector('.buttons') as HTMLElement;
      tb.destroy();
      expect(el.isConnected).toBe(false);
    });

    it('cleans up active mousedown close handler', () => {
      const { callbacks } = makeCallbacks();
      const tb = new Toolbar(container, VIEWS, callbacks);
      const statBtn = container.querySelector('.statistic') as HTMLButtonElement;
      statBtn.click();
      vi.advanceTimersByTime(1);
      tb.destroy();
      // dispatching mousedown after destroy should not throw and should be a no-op
      expect(() =>
        activeDocument.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      ).not.toThrow();
    });
  });
});
