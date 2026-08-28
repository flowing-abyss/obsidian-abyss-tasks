import { Menu } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectsToolbar } from '../src/panels/projects/ProjectsToolbar';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer } from './helpers';

function context() {
  return {
    state: new AppState(),
    settings: structuredClone(DEFAULT_SETTINGS),
    onSaveSettings: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn(),
    onSetStatus: vi.fn(),
    openNote: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('renderProjectsToolbar', () => {
  it('orders the working-set filters before layout and New project in DOM and tab order', () => {
    const root = freshContainer();
    renderProjectsToolbar(root, { ...context(), timelineAvailable: true });

    const controls = root.querySelector<HTMLElement>('.abyss-center-controls')!;
    expect(
      Array.from(controls.children, (element) => element.getAttribute('data-portfolio-zone')),
    ).toEqual(['filters', 'layout', 'add']);
    expect(
      Array.from(
        controls.querySelectorAll<HTMLElement>('button:not([hidden])'),
        (button) =>
          button.dataset['projectStatusFilter'] ??
          (button.hasAttribute('data-project-unmapped-filter') ? 'unmapped' : undefined) ??
          button.dataset['projectPortfolioLayout'] ??
          button.getAttribute('aria-label'),
      ),
    ).toEqual([
      ...context().settings.projects.statuses.map(({ id }) => id),
      'unmapped',
      'overview',
      'board',
      'timeline',
      'New project',
    ]);
  });

  it('keeps Timeline in the segmented switcher when the renderer is unavailable', () => {
    const root = freshContainer();
    renderProjectsToolbar(root, { ...context(), timelineAvailable: false });

    const timeline = root.querySelector<HTMLButtonElement>(
      '[data-project-portfolio-layout="timeline"]',
    )!;
    expect(timeline).not.toBeNull();
    expect(timeline.disabled).toBe(true);
  });

  it('replaces overflowing inactive chips with one native Show summary without a filter scroller', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const PreviousResizeObserver = globalThis.ResizeObserver;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    const menu = { addItem: vi.fn().mockReturnThis(), showAtMouseEvent: vi.fn() };
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(menu.addItem as never);
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(menu.showAtMouseEvent as never);
    const root = freshContainer();
    try {
      const result = renderProjectsToolbar(root, context());
      const filters = root.querySelector<HTMLElement>('.abyss-project-status-filters')!;
      Object.defineProperty(filters, 'clientWidth', { configurable: true, value: 120 });
      Object.defineProperty(filters, 'scrollWidth', { configurable: true, value: 420 });
      callbacks[0]?.([], {} as ResizeObserver);

      expect(filters.classList.contains('is-overflowing')).toBe(true);
      expect(result.statusSummaryButton.hidden).toBe(false);
      expect(result.statusSummaryButton.textContent).toMatch(/^Show(?: \d+)?$/u);
      expect(root.querySelectorAll('.abyss-project-status-summary')).toHaveLength(1);
      result.statusSummaryButton.click();
      expect(Menu.prototype.addItem).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: PreviousResizeObserver,
      });
    }
  });

  it('persists a filter changed from the compact summary through the same callback', async () => {
    let invokeFirstItem: (() => void) | undefined;
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      const item = {
        setTitle: () => item,
        setChecked: () => item,
        onClick: (handler: () => void) => {
          invokeFirstItem ??= handler;
          return item;
        },
      };
      callback(item as never);
      return this;
    });
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });
    const ctx = context();
    const root = freshContainer();
    const result = renderProjectsToolbar(root, ctx);

    result.statusSummaryButton.click();
    invokeFirstItem?.();
    await Promise.resolve();

    expect(ctx.settings.projects.view.visibleStatusIds).not.toContain(
      ctx.settings.projects.statuses[0]!.id,
    );
    expect(ctx.onSaveSettings).toHaveBeenCalledOnce();
  });

  it('retains no long active chips when only the Show summary fits', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const PreviousResizeObserver = globalThis.ResizeObserver;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    try {
      const root = freshContainer();
      const result = renderProjectsToolbar(root, context());
      const filters = root.querySelector<HTMLElement>('.abyss-project-status-filters')!;
      Object.defineProperty(filters, 'clientWidth', { configurable: true, value: 54 });
      Object.defineProperty(filters, 'scrollWidth', { configurable: true, value: 600 });
      Object.defineProperty(result.statusSummaryButton, 'offsetWidth', {
        configurable: true,
        value: 50,
      });
      for (const chip of filters.querySelectorAll<HTMLElement>('.abyss-project-status-filter')) {
        Object.defineProperty(chip, 'offsetWidth', { configurable: true, value: 80 });
      }
      callbacks[0]?.([], {} as ResizeObserver);

      expect(
        filters.querySelectorAll('.abyss-project-status-filter:not(.is-overflow-hidden)'),
      ).toHaveLength(0);
      expect(result.statusSummaryButton.hidden).toBe(false);
      expect(result.statusSummaryButton.textContent).not.toBe('Show 0');
      expect(filters.getAttribute('role')).toBe('group');
      expect(result.statusSummaryButton.getAttribute('aria-haspopup')).toBe('menu');
      expect(result.statusSummaryButton.getAttribute('aria-expanded')).toBe('false');
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: PreviousResizeObserver,
      });
    }
  });
});
