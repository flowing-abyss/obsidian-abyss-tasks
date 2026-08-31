import { Menu, Notice } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ProjectWorkspaceSessionRegistry } from '../src/panels/projects/ProjectWorkspaceSession';
import { renderProjectsToolbar } from '../src/panels/projects/ProjectsToolbar';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { freshContainer } from './helpers';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return { ...actual, Notice: vi.fn() };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncQueue(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function context(onSaveSettings = vi.fn().mockResolvedValue(undefined)) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const collectionState = new ProjectWorkspaceSessionRegistry();
  collectionState.bindCollectionPreferences(settings, onSaveSettings);
  return {
    state: new AppState(),
    settings,
    onSaveSettings,
    collectionState,
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
    ).toEqual(['scope-or-status', 'layout', 'filter', 'group', 'sort', 'fields', 'add']);
    expect(controls.querySelector('[data-collection-kind="search"]')).toBeNull();
    expect(root.textContent).not.toContain('Show');
    expect(root.querySelectorAll('[data-collection-controls]')).toHaveLength(1);
    expect(controls.getAttribute('role')).toBe('toolbar');
    expect(controls.getAttribute('aria-label')).toBe('Project portfolio controls');
    expect(root.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
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
      const ctx = context();
      const result = renderProjectsToolbar(root, ctx);
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
      expect(result.filterButton.getAttribute('aria-label')).toContain(
        String(ctx.settings.projects.view.visibleStatusIds.length),
      );
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
    await flushAsyncQueue();

    expect(ctx.settings.projects.view.visibleStatusIds).not.toContain(
      ctx.settings.projects.statuses[0]!.id,
    );
    expect(ctx.onSaveSettings).toHaveBeenCalledOnce();
  });

  it('renders a portfolio layout change only after the settings save settles', async () => {
    const save = deferred<void>();
    const onSaveSettings = vi.fn().mockReturnValue(save.promise);
    const ctx = { ...context(onSaveSettings), onPortfolioLayoutChanged: vi.fn() };
    const root = freshContainer();
    renderProjectsToolbar(root, ctx);

    root.querySelector<HTMLButtonElement>('[data-project-portfolio-layout="board"]')!.click();
    await flushAsyncQueue();

    expect(ctx.settings.projects.view.portfolioLayout).toBe('board');
    expect(ctx.collectionState.portfolioPreference().layout).toBe('overview');
    expect(ctx.onPortfolioLayoutChanged).not.toHaveBeenCalled();
    save.resolve();
    await flushAsyncQueue();
    expect(ctx.collectionState.portfolioPreference().layout).toBe('board');
    expect(ctx.onPortfolioLayoutChanged).toHaveBeenCalledOnce();
  });

  it('settles one equal-revision layout write and reports the stale UI write', async () => {
    vi.mocked(Notice).mockClear();
    const save = deferred<void>();
    const ctx = {
      ...context(vi.fn().mockReturnValue(save.promise)),
      onPortfolioLayoutChanged: vi.fn(),
    };
    const root = freshContainer();
    renderProjectsToolbar(root, ctx);

    root.querySelector<HTMLButtonElement>('[data-project-portfolio-layout="board"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-project-portfolio-layout="timeline"]')!.click();
    await flushAsyncQueue();
    save.resolve();
    await flushAsyncQueue();
    await flushAsyncQueue();

    expect(ctx.collectionState.portfolioPreference().layout).toBe('board');
    expect(ctx.onPortfolioLayoutChanged).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledOnce();
    expect(String(vi.mocked(Notice).mock.calls[0]?.[0])).toContain('changed elsewhere');
  });

  it('restores portfolio settings and reports a rejected save without rerendering', async () => {
    vi.mocked(Notice).mockClear();
    const save = deferred<void>();
    const ctx = {
      ...context(vi.fn().mockReturnValue(save.promise)),
      onPortfolioLayoutChanged: vi.fn(),
    };
    const priorView = ctx.settings.projects.view;
    const root = freshContainer();
    renderProjectsToolbar(root, ctx);

    root.querySelector<HTMLButtonElement>('[data-project-portfolio-layout="board"]')!.click();
    await flushAsyncQueue();
    save.reject(new Error('disk full'));
    await flushAsyncQueue();

    expect(ctx.settings.projects.view).toBe(priorView);
    expect(ctx.collectionState.portfolioPreference().layout).toBe('overview');
    expect(ctx.onPortfolioLayoutChanged).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledOnce();
    expect(String(vi.mocked(Notice).mock.calls[0]?.[0])).toContain('not saved');
  });

  it('persists portfolio grouping, sorting, and field order through the coordinator', async () => {
    const callbacks = new Map<string, () => void>();
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      let title = '';
      const item = {
        setTitle: (next: string) => {
          title = next;
          return item;
        },
        setDisabled: () => item,
        setChecked: () => item,
        onClick: (onClick: () => void) => {
          callbacks.set(title, onClick);
          return item;
        },
      };
      callback(item as never);
      return this;
    });
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });

    const groupContext = context();
    const groupRoot = freshContainer();
    renderProjectsToolbar(groupRoot, groupContext);
    groupRoot.querySelector<HTMLButtonElement>('[data-collection-group]')!.click();
    callbacks.get('Priority')!();
    await flushAsyncQueue();
    expect(groupContext.collectionState.portfolioPreference().group).toBe('priority');
    expect(groupContext.settings.projects.view.portfolioGroupBy).toBe('priority');

    callbacks.clear();
    const sortContext = context();
    const sortRoot = freshContainer();
    renderProjectsToolbar(sortRoot, sortContext);
    sortRoot.querySelector<HTMLButtonElement>('[data-collection-sort]')!.click();
    callbacks.get('Priority')!();
    await flushAsyncQueue();
    expect(sortContext.collectionState.portfolioPreference().sort).toEqual({
      field: 'priority',
      dir: 'asc',
    });
    expect(sortContext.settings.projects.view.portfolioSortBy).toEqual({
      field: 'priority',
      dir: 'asc',
    });

    callbacks.clear();
    const fieldContext = context();
    const fieldRoot = freshContainer();
    renderProjectsToolbar(fieldRoot, fieldContext);
    fieldRoot.querySelector<HTMLButtonElement>('[data-collection-fields]')!.click();
    callbacks.get('Move Priority earlier')!();
    await flushAsyncQueue();
    const preference = fieldContext.collectionState.portfolioPreference();
    expect(
      preference.layoutPreferences['overview']?.table?.columns.map(({ propertyId }) => propertyId),
    ).toEqual(['project', 'priority', 'status', 'progress', 'nextAction', 'start', 'end']);
    expect(preference.visibleFields).toEqual([
      'project',
      'priority',
      'status',
      'progress',
      'nextAction',
      'start',
      'end',
    ]);
    expect(
      fieldContext.settings.projects.view.table.columns.map(({ propertyId }) => propertyId),
    ).toEqual(['project', 'priority', 'status', 'progress', 'nextAction', 'start', 'end']);
  });

  it('offers safe custom Project descriptors in Fields before they are configured', () => {
    const titles: string[] = [];
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
      const item = {
        setTitle: (title: string) => {
          titles.push(title);
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
    const root = freshContainer();
    renderProjectsToolbar(root, {
      ...context(),
      portfolioFields: [['client', 'Client note']],
    } as never);

    root.querySelector<HTMLButtonElement>('[data-collection-fields]')!.click();
    expect(titles).toContain('Client note');
  });
});
