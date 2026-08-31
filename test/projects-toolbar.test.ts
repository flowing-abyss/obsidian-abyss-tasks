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
  it('uses the shared semantic order without a Show control', () => {
    const root = freshContainer();
    renderProjectsToolbar(root, { ...context(), timelineAvailable: true });

    const controls = root.querySelector<HTMLElement>('[data-collection-controls]')!;
    expect(
      Array.from(
        controls.querySelectorAll<HTMLElement>(':scope > [data-collection-kind]'),
        (element) => element.dataset['collectionKind'],
      ),
    ).toEqual(['scope-or-status', 'layout', 'filter', 'add']);
    expect(controls.querySelector('[data-collection-kind="search"]')).toBeNull();
    expect(root.textContent).not.toContain('Show');
    expect(root.querySelectorAll('[data-collection-controls]')).toHaveLength(1);
  });

  it('keeps Timeline in the segmented switcher when the renderer is unavailable', () => {
    const root = freshContainer();
    renderProjectsToolbar(root, { ...context(), timelineAvailable: false });

    const timeline = root.querySelector<HTMLButtonElement>(
      '[data-project-portfolio-layout="timeline"]',
    )!;
    expect(timeline.disabled).toBe(true);
  });

  it('moves overflowing direct statuses into Filter as a Status section', () => {
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
    const capturedTitles: string[] = [];
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      const item = {
        setTitle: (title: string) => {
          capturedTitles.push(title);
          return item;
        },
        setDisabled: () => item,
        setChecked: () => item,
        onClick: () => item,
      };
      callback(item as never);
      return this;
    });
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });
    try {
      const root = freshContainer();
      const result = renderProjectsToolbar(root, context());
      const filters = root.querySelector<HTMLElement>('.abyss-project-status-filters')!;
      Object.defineProperty(filters, 'clientWidth', { configurable: true, value: 120 });
      Object.defineProperty(filters, 'scrollWidth', { configurable: true, value: 420 });
      callbacks[0]?.([], {} as ResizeObserver);

      expect(filters.classList.contains('is-overflowing')).toBe(true);
      expect(
        filters.querySelectorAll('.abyss-project-status-filter:not(.is-overflow-hidden)'),
      ).toHaveLength(0);
      result.filterButton.click();
      expect(capturedTitles[0]).toBe('Status');
      expect(capturedTitles).toContain('Unmapped');
      expect(root.textContent).not.toContain('Show');
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: PreviousResizeObserver,
      });
    }
  });

  it('persists a direct status toggle immediately', async () => {
    const ctx = context();
    const root = freshContainer();
    renderProjectsToolbar(root, ctx);

    root.querySelector<HTMLButtonElement>('[data-project-status-filter]')!.click();
    await Promise.resolve();

    expect(ctx.settings.projects.view.visibleStatusIds).not.toContain(
      ctx.settings.projects.statuses[0]!.id,
    );
    expect(ctx.onSaveSettings).toHaveBeenCalledOnce();
  });
});
