import moment from 'moment';
import { addIcon, removeIcon, TFile, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type {
  LocalDate,
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskCreateSession,
  TaskIndexEvent,
  TaskQueryApi,
  TaskSnapshot,
} from '../src/tasks';
import { localTime } from '../src/tasks';
import type { TaskQuery } from '../src/tasks/application/TaskApplicationApi';
import { TaskModal } from '../src/ui/TaskModal';
import { InteractionRegistry, type InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { TodayView } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import { PanelNavigator } from '../src/views/panelNavigation';
import { MIN_BLOCK_HEIGHT_PX } from '../src/views/timegrid/layout';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  fixedToday,
  flushMicrotasks,
  freshContainer,
  seedTaskCache,
  task,
  taskQueryApi,
  useRealMoment,
} from './helpers';

const TODAY = moment().format('YYYY-MM-DD');

useRealMoment();

afterEach(() => {
  vi.useRealTimers();
});

function queryApiForSnapshots(getTasks: () => readonly TaskSnapshot[]): TaskQueryApi {
  const list = (query?: TaskQuery): readonly TaskSnapshot[] =>
    getTasks()
      .filter((item) => query?.filePath === undefined || item.source.filePath === query.filePath)
      .filter(
        (item) => query?.folder === undefined || item.source.filePath.startsWith(query.folder),
      )
      .filter((item) => query?.tag === undefined || item.tags.includes(query.tag))
      .filter((item) => query?.statuses === undefined || query.statuses.includes(item.status))
      .filter((item) => {
        if (query?.dateRange === undefined) return true;
        const dates = [
          item.planning.due,
          item.planning.scheduled,
          item.planning.start,
          item.presentation.dailyNoteDate,
        ].filter((date): date is LocalDate => date !== undefined);
        return dates.some((date) => date >= query.dateRange!.from && date <= query.dateRange!.to);
      });

  return taskQueryApi({
    list,
    forCalendarProjection: (dates) => {
      const wanted = new Set(dates);
      const materialized = getTasks()
        .filter((item) => {
          const exactDate = [
            item.planning.due,
            item.planning.scheduled,
            item.planning.start,
            item.presentation.dailyNoteDate,
          ].some((date) => date !== undefined && wanted.has(date));
          if (exactDate) return true;
          return (
            item.planning.start !== undefined &&
            item.planning.due !== undefined &&
            dates.some((date) => date >= item.planning.start! && date <= item.planning.due!)
          );
        })
        .map((root) => ({
          root,
          target: { type: 'task' as const, ref: root.ref },
          node: root,
        }));
      return { materialized, recurringSources: [] };
    },
    resolve: (ref) => {
      const found = getTasks().find(
        (item) => item.ref.filePath === ref.filePath && item.ref.line === ref.line,
      );
      return found
        ? { type: 'exact', task: found, basis: { observed: found } }
        : { type: 'not-found', ref };
    },
  });
}

function makeStaticPanel(
  state: AppState,
  snapshots: readonly TaskSnapshot[],
  settings: CalendarSettings = DEFAULT_SETTINGS,
  app: App = {} as App,
  interactionOwnership?: InteractionOwnershipPort,
): CenterPanel {
  return new CenterPanel(
    state,
    app,
    settings,
    queryApiForSnapshots(() => snapshots),
    new StatusRegistry(settings.taskStatuses),
    undefined,
    null,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    interactionOwnership,
  );
}

/**
 * Read a markdown file's current content via the vault. Throws if the path is
 * not a TFile so tests fail loudly when a write didn't happen.
 */
async function readMd(app: App, path: string): Promise<string> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) throw new Error(`${path} is not a TFile`);
  return app.vault.cachedRead(f);
}

/** Bracket-access helper to call private methods (preserves `this` binding). */
function call<T>(panel: CenterPanel, method: string, ...args: unknown[]): Promise<T> | T {
  const fn = (panel as unknown as Record<string, (...a: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

async function openListCapture(container: HTMLElement): Promise<HTMLInputElement> {
  container.querySelector<HTMLElement>('.abyss-add-task-trigger')?.click();
  await flushMicrotasks();
  const input = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input');
  if (!input) throw new Error('list capture did not open');
  return input;
}

function setCaptureDraft(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressCaptureKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

async function submitListCapture(container: HTMLElement, value: string): Promise<HTMLInputElement> {
  const input = await openListCapture(container);
  setCaptureDraft(input, value);
  pressCaptureKey(input, 'Enter');
  await flushMicrotasks();
  return input;
}

/**
 * Wire up a real CenterPanel + real task index/application API + real AppState.
 * Vault is pre-populated with `files`; each seeded file also gets a task cache.
 */
async function makePanel(
  files: Record<string, string>,
  settings: CalendarSettings = DEFAULT_SETTINGS,
  seeds: Array<{ path: string; items: Array<{ task: string; parent: number; line: number }> }> = [],
): Promise<{
  panel: CenterPanel;
  state: AppState;
  index: TaskQueryApi;
  tasks: TaskApplicationApi;
  app: App;
}> {
  const app = await createAppWithFiles(files);
  for (const s of seeds) seedTaskCache(app, s.path, s.items);
  const state = new AppState();
  const taskApplication = configuredTaskApplication(app, settings);
  await taskApplication.index.initialize();
  const panel = new CenterPanel(
    state,
    app,
    settings,
    taskApplication.index,
    taskApplication.statusRegistry,
    undefined,
    null,
    null,
    taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
    undefined,
    taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
  );
  return {
    panel,
    state,
    index: taskApplication.index,
    tasks: taskApplication.tasks,
    app,
  };
}

describe('CenterPanel task-card primary row', () => {
  fixedToday('2026-06-25');

  it('keeps every primary control in one row and renders the description below it', () => {
    const snapshot = task({
      title: 'Pay Migaku',
      recurrence: 'every week',
      tags: ['#task/regular'],
      planning: { due: '2026-08-05' },
      description: 'Renew before the next lesson',
      source: { filePath: 'regular-tasks.md', line: 4 },
    });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'Migaku');
    const panel = makeStaticPanel(state, [snapshot]);
    addIcon('x', '<svg data-lucide="x"><path d="M18 6 6 18M6 6l12 12" /></svg>');
    try {
      panel.mount(freshContainer());

      const card = panel['el'].querySelector<HTMLElement>('.abyss-task-card')!;
      const mainRow = card.querySelector<HTMLElement>('.abyss-task-card-main-row')!;
      expect(Array.from(mainRow.children, (child) => child.className)).toEqual([
        expect.stringContaining('abyss-status-marker'),
        'abyss-task-body',
        'abyss-task-meta-right',
        'abyss-task-delete-btn',
      ]);

      const titleRow = mainRow.querySelector<HTMLElement>('.abyss-task-title-row')!;
      const recurrence = titleRow.querySelector<HTMLElement>('.abyss-recurrence-badge')!;
      expect(recurrence.nextElementSibling?.classList.contains('abyss-task-title')).toBe(true);

      const description = card.querySelector<HTMLElement>('.abyss-task-desc')!;
      expect(description.parentElement).toBe(card);
      expect(description.previousElementSibling).toBe(mainRow);

      const deleteButton = mainRow.querySelector<HTMLButtonElement>('.abyss-task-delete-btn')!;
      expect(deleteButton.querySelector('svg[data-lucide="x"]')).not.toBeNull();
      expect(deleteButton.textContent).toBe('');
    } finally {
      panel.destroy();
      removeIcon('x');
    }
  });

  it('does not reserve a recurrence slot for an ordinary one-line task', () => {
    const snapshot = task({
      title: 'Ordinary task',
      source: { filePath: 'inbox.md', line: 2 },
    });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'Ordinary');
    const panel = makeStaticPanel(state, [snapshot]);
    try {
      panel.mount(freshContainer());

      const mainRow = panel['el'].querySelector<HTMLElement>('.abyss-task-card-main-row')!;
      const titleRow = mainRow.querySelector<HTMLElement>('.abyss-task-title-row')!;
      expect(titleRow.querySelector('.abyss-recurrence-badge')).toBeNull();
      expect(titleRow.firstElementChild?.classList.contains('abyss-task-title')).toBe(true);
      expect(mainRow.querySelector('.abyss-task-desc')).toBeNull();
    } finally {
      panel.destroy();
    }
  });

  it('keeps a long-title fixture inside the same shrinkable primary-row body', () => {
    const snapshot = task({
      title:
        'A deliberately long task title that wraps on a narrow center panel without moving its controls',
      planning: { due: '2026-08-05', time: localTime('09:30') },
      source: { filePath: 'inbox.md', line: 3 },
    });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'deliberately');
    const panel = makeStaticPanel(state, [snapshot]);
    try {
      panel.mount(freshContainer());

      const mainRow = panel['el'].querySelector<HTMLElement>('.abyss-task-card-main-row')!;
      const body = mainRow.querySelector<HTMLElement>('.abyss-task-body')!;
      expect(body.querySelector('.abyss-task-title')).not.toBeNull();
      expect(mainRow.querySelector('.abyss-task-meta-right')).not.toBeNull();
      expect(panel['el'].querySelector('.abyss-task-card > .abyss-task-desc')).toBeNull();
    } finally {
      panel.destroy();
    }
  });
});

describe('CenterPanel list selection', () => {
  it('excludes a date-less task from today while retaining an explicitly planned task from the same daily note', () => {
    fixedToday(TODAY);
    const state = new AppState();
    state.set('selectedList', 'today');
    const source = { filePath: `daily/${TODAY}.md` };
    const dailyOnly = task({
      title: 'daily-only',
      source,
      presentation: { dailyNoteDate: TODAY },
    });
    const planned = task({
      title: 'planned',
      source: { ...source, line: 1 },
      planning: { due: TODAY },
      presentation: { dailyNoteDate: TODAY },
    });
    const panel = makeStaticPanel(state, [dailyOnly, planned]);

    expect(
      (call<TaskSnapshot[]>(panel, 'getFilteredTasks') as TaskSnapshot[]).map((item) => item.title),
    ).toEqual(['planned']);
  });
});

describe('CenterPanel semantic navigation render boundary', () => {
  it('keeps direct selectedList notification bookkeeping-only', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const panel = makeStaticPanel(state, [], settings);
    panel.mount(freshContainer());
    const current = {
      groupBy: 'priority' as const,
      sortBy: { field: 'priority' as const, dir: 'desc' as const },
      filters: [],
      statusGroups: ['todo' as const],
    };
    state.set('centerListViewState', current);
    const render = vi.spyOn(panel as unknown as { render(): void }, 'render');

    state.set('selectedList', 'inbox');

    expect(state.get('centerListViewState')).toBe(current);
    expect(render).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('performs one real full render after final state for every semantic action', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const panel = makeStaticPanel(state, [], settings);
    panel.mount(freshContainer());
    const render = vi.spyOn(panel as unknown as { render(): void }, 'render');
    const openQuickCapture = vi.spyOn(panel, 'openQuickCapture');
    const navigator = new PanelNavigator(state, settings, panel);

    const once = (run: () => void): void => {
      render.mockClear();
      run();
      expect(render).toHaveBeenCalledOnce();
    };

    once(() => navigator.openCalendar());
    expect(state.get('mode')).toBe('calendar');

    const cancelKeyboardInteraction = vi.spyOn(
      panel as unknown as { cancelKeyboardInteraction(): void },
      'cancelKeyboardInteraction',
    );
    once(() => navigator.openCalendarView('week'));
    expect(cancelKeyboardInteraction).toHaveBeenCalledOnce();
    expect(panel.calendarView()).toBe('week');
    expect(panel['calDate'].format('YYYY-MM-DD')).toBe(
      window.moment().startOf('isoWeek').format('YYYY-MM-DD'),
    );

    once(() => navigator.openProjects());
    expect(state.get('mode')).toBe('projects');

    once(() => navigator.openSearch());
    expect(state.get('mode')).toBe('search');

    once(() => navigator.openList('inbox'));
    expect(state.get('selectedList')).toBe('inbox');
    expect(panel['el'].querySelector('.abyss-center-title')?.textContent).toBe('Inbox');

    once(() => navigator.openTasks());

    once(() => navigator.openQuickCapture());
    expect(openQuickCapture).toHaveBeenCalledOnce();

    panel.destroy();
  });
});

describe('CenterPanel interaction ownership', () => {
  const cases = [
    {
      category: 'sort/group',
      mode: 'tasks' as const,
      open: (container: HTMLElement) =>
        container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!.click(),
      focus: '.abyss-view-state-row-main',
    },
    {
      category: 'month',
      mode: 'calendar' as const,
      open: (container: HTMLElement) =>
        container.querySelector<HTMLButtonElement>('.abyss-cal-nav-month')!.click(),
      focus: '.abyss-month-picker-btn',
    },
    {
      category: 'year',
      mode: 'calendar' as const,
      open: (container: HTMLElement) =>
        container.querySelector<HTMLButtonElement>('.abyss-cal-nav-year')!.click(),
      focus: '.abyss-year-picker-btn',
    },
  ];

  it.each(cases)(
    'blocks semantic navigation in the $category popover and releases on full rerender',
    ({ mode, open, focus }) => {
      const registry = new InteractionRegistry<'navigate'>();
      const state = new AppState();
      state.set('mode', mode);
      const panel = makeStaticPanel(state, [], DEFAULT_SETTINGS, {} as App, registry);
      const container = freshContainer();
      activeDocument.body.append(container);
      const navigate = vi.fn();
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'n' && registry.allows('navigate')) navigate();
      };
      activeDocument.addEventListener('keydown', onKeydown);
      panel.mount(container);

      try {
        open(container);
        const focused = container.querySelector<HTMLElement>(focus)!;
        focused.focus();
        focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
        expect(navigate).not.toHaveBeenCalled();

        panel.refresh();
        activeDocument.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'n', bubbles: true }),
        );
        expect(navigate).toHaveBeenCalledOnce();
      } finally {
        activeDocument.removeEventListener('keydown', onKeydown);
        panel.destroy();
        registry.destroy();
        container.remove();
      }
    },
  );

  it('releases and removes the sort/group popover before opening a task status menu', () => {
    const releases = [vi.fn(), vi.fn()];
    const acquire = vi
      .fn()
      .mockReturnValueOnce({ release: releases[0] })
      .mockReturnValueOnce({ release: releases[1] });
    const state = new AppState();
    state.set('mode', 'tasks');
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(
      state,
      [task({ title: 'Replace sort surface', planning: { due: TODAY } })],
      DEFAULT_SETTINGS,
      {} as App,
      { acquire },
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);

    try {
      container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!.click();
      expect(container.querySelector('.abyss-view-state-popover')).not.toBeNull();

      const statusMarker = container.querySelector<HTMLElement>('.abyss-status-marker')!;
      statusMarker.focus();
      statusMarker.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );

      expect(container.querySelector('.abyss-view-state-popover')).toBeNull();
      expect(
        activeDocument
          .querySelector<HTMLElement>('.abyss-status-popover')
          ?.contains(activeDocument.activeElement),
      ).toBe(true);
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).not.toHaveBeenCalled();
      expect(activeDocument.querySelector('.abyss-status-popover')).not.toBeNull();
      expect(releases[0]!.mock.invocationCallOrder[0]).toBeLessThan(
        acquire.mock.invocationCallOrder[1]!,
      );

      panel.destroy();
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).toHaveBeenCalledOnce();
    } finally {
      panel.destroy();
      container.remove();
    }
  });
});

describe('CenterPanel sort and group popover keyboard ownership', () => {
  it('moves focus from the trigger to an interactive control inside the opened popover', () => {
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(state, []);
    const container = freshContainer();
    activeDocument.body.append(container);

    try {
      panel.mount(container);
      const trigger = container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!;
      trigger.focus();
      trigger.dispatchEvent(new PointerEvent('click', { bubbles: true }));

      const popover = container.querySelector<HTMLElement>('.abyss-view-state-popover')!;
      expect(activeDocument.activeElement).toBe(
        popover.querySelector<HTMLElement>('.abyss-view-state-row-main'),
      );
      expect(popover.contains(activeDocument.activeElement)).toBe(true);
      const focusedRow = activeDocument.activeElement as HTMLElement;
      focusedRow.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      expect(focusedRow.getAttribute('aria-expanded')).toBe('true');
      expect(
        focusedRow.parentElement?.querySelector('.abyss-view-state-sublist')?.classList,
      ).not.toContain('abyss-hidden');
      focusedRow.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
      );
      expect(focusedRow.getAttribute('aria-expanded')).toBe('false');
      expect(
        focusedRow.parentElement?.querySelector('.abyss-view-state-sublist')?.classList,
      ).toContain('abyss-hidden');
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('closes on Escape and restores focus to its trigger', () => {
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(state, []);
    const container = freshContainer();
    activeDocument.body.append(container);

    try {
      panel.mount(container);
      const trigger = container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!;
      trigger.focus();
      trigger.dispatchEvent(new PointerEvent('click', { bubbles: true }));
      const popover = container.querySelector<HTMLElement>('.abyss-view-state-popover')!;

      (activeDocument.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

      expect(container.querySelector('.abyss-view-state-popover')).toBeNull();
      expect(activeDocument.activeElement).toBe(trigger);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('removes its registered outside-click listener on trigger toggle, rerender, and destroy', () => {
    vi.useFakeTimers();
    const addListener = vi.spyOn(activeDocument, 'addEventListener');
    const removeListener = vi.spyOn(activeDocument, 'removeEventListener');
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(state, []);
    const container = freshContainer();
    activeDocument.body.append(container);
    let destroyed = false;

    const openAndRegisteredListener = (): EventListener => {
      const start = addListener.mock.calls.length;
      const trigger = container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!;
      trigger.click();
      vi.runOnlyPendingTimers();
      const registration = addListener.mock.calls
        .slice(start)
        .find(([type, , options]) => type === 'click' && options === true);
      expect(registration).toBeDefined();
      return registration![1] as EventListener;
    };

    try {
      panel.mount(container);

      const toggledListener = openAndRegisteredListener();
      container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!.click();
      expect(removeListener).toHaveBeenCalledWith('click', toggledListener, true);

      const rerenderedListener = openAndRegisteredListener();
      panel.refresh();
      expect(removeListener).toHaveBeenCalledWith('click', rerenderedListener, true);

      const destroyedListener = openAndRegisteredListener();
      panel.destroy();
      destroyed = true;
      expect(removeListener).toHaveBeenCalledWith('click', destroyedListener, true);
    } finally {
      if (!destroyed) panel.destroy();
      for (const [type, listener, options] of addListener.mock.calls) {
        if (type === 'click' && options === true) {
          activeDocument.removeEventListener('click', listener as EventListener, true);
        }
      }
      addListener.mockRestore();
      removeListener.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
      container.remove();
    }
  });

  it('keeps dismissal and cleanup owned by the mounted document after activeDocument changes', () => {
    vi.useFakeTimers();
    const originalActiveDocument = activeDocument;
    const ownerDocument = document.implementation.createHTMLDocument('mounted panel');
    const replacementActiveDocument = document.implementation.createHTMLDocument('active window');
    const ownerAdd = vi.spyOn(ownerDocument, 'addEventListener');
    const ownerRemove = vi.spyOn(ownerDocument, 'removeEventListener');
    const replacementAdd = vi.spyOn(replacementActiveDocument, 'addEventListener');
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(state, []);
    const container = ownerDocument.createElement('div');
    ownerDocument.body.append(container);
    let destroyed = false;

    try {
      panel.mount(container);
      container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!.click();
      vi.stubGlobal('activeDocument', replacementActiveDocument);
      vi.runOnlyPendingTimers();

      const outsideRegistration = ownerAdd.mock.calls.find(
        ([type, , options]) => type === 'click' && options === true,
      );
      expect(outsideRegistration).toBeDefined();
      expect(
        replacementAdd.mock.calls.some(([type, , options]) => type === 'click' && options === true),
      ).toBe(false);

      ownerDocument.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(container.querySelector('.abyss-view-state-popover')).toBeNull();
      expect(ownerRemove).toHaveBeenCalledWith('click', outsideRegistration![1], true);

      container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!.click();
      vi.runOnlyPendingTimers();
      const ownerClickRegistrations = ownerAdd.mock.calls.filter(
        ([type, , options]) => type === 'click' && options === true,
      );
      const destroyRegistration = ownerClickRegistrations[ownerClickRegistrations.length - 1]!;
      vi.stubGlobal('activeDocument', originalActiveDocument);
      panel.destroy();
      destroyed = true;
      expect(ownerRemove).toHaveBeenCalledWith('click', destroyRegistration[1], true);
    } finally {
      if (!destroyed) panel.destroy();
      for (const doc of [ownerDocument, replacementActiveDocument]) {
        const addSpy = doc === ownerDocument ? ownerAdd : replacementAdd;
        for (const [type, listener, options] of addSpy.mock.calls) {
          if (type === 'click' && options === true) {
            doc.removeEventListener('click', listener as EventListener, true);
          }
        }
      }
      vi.stubGlobal('activeDocument', originalActiveDocument);
      ownerAdd.mockRestore();
      ownerRemove.mockRestore();
      replacementAdd.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
      container.remove();
    }
  });

  it('exposes selected group, sort, preset, and status-toggle state through aria-pressed', () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CalendarSettings;
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(state, [], settings);
    const container = freshContainer();
    activeDocument.body.append(container);

    const open = (): HTMLElement => {
      container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')!.click();
      return container.querySelector<HTMLElement>('.abyss-view-state-popover')!;
    };
    const row = (popover: HTMLElement, label: string): HTMLElement =>
      Array.from(popover.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
        (candidate) =>
          candidate.querySelector('.abyss-view-state-row-label')?.textContent === label,
      )!;
    const option = (popover: HTMLElement, rowLabel: string, label: string): HTMLButtonElement =>
      Array.from(row(popover, rowLabel).querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) =>
          candidate.querySelector('.abyss-view-state-option-label')?.textContent === label,
      )!;

    try {
      panel.mount(container);

      let popover = open();
      expect(option(popover, 'Group by', 'Date').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Group by', 'None').getAttribute('aria-pressed')).toBe('false');
      option(popover, 'Group by', 'None').click();

      popover = open();
      expect(option(popover, 'Group by', 'None').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Group by', 'Date').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Sort by', 'Date ↑').getAttribute('aria-pressed')).toBe('true');
      option(popover, 'Sort by', 'Priority').click();

      popover = open();
      expect(option(popover, 'Sort by', 'Priority ↑').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Sort by', 'Date').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'Active').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Show', 'All').getAttribute('aria-pressed')).toBe('false');
      option(popover, 'Show', 'All').click();

      popover = container.querySelector<HTMLElement>('.abyss-view-state-popover')!;
      expect(option(popover, 'Show', 'All').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Show', 'Active').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'Done').getAttribute('aria-pressed')).toBe('true');
      option(popover, 'Show', 'Done').click();

      popover = container.querySelector<HTMLElement>('.abyss-view-state-popover')!;
      expect(option(popover, 'Show', 'Done').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'To do').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Show', 'All').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'Active').getAttribute('aria-pressed')).toBe('false');
    } finally {
      panel.destroy();
      container.remove();
    }
  });
});

describe('CenterPanel shared list capture', () => {
  function captureHarness(implementation: () => Promise<TaskCommandResult>): {
    readonly panel: CenterPanel;
    readonly state: AppState;
    readonly planCreate: ReturnType<typeof vi.fn>;
    readonly sessionExecute: ReturnType<typeof vi.fn>;
  } {
    const state = new AppState();
    const queries = taskQueryApi();
    const sessionExecute = vi.fn(implementation);
    const planCreate = vi.fn(async () => ({
      type: 'ready' as const,
      destination: { filePath: 'Capture.md', insertion: { type: 'append' as const } },
      execute: sessionExecute,
    }));
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries,
      planCreate,
      execute: vi.fn(async () => ({
        type: 'invalid' as const,
        issues: [{ code: 'invalid-target' as const }],
      })),
    };
    return {
      panel: new CenterPanel(
        state,
        {} as App,
        { ...DEFAULT_SETTINGS, taskPrefix: '' },
        queries,
        new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
        undefined,
        null,
        null,
        application,
        undefined,
        application,
      ),
      state,
      planCreate,
      sessionExecute,
    };
  }

  function captureSuccess(title = 'Captured'): TaskCommandResult {
    return {
      type: 'ok',
      changed: true,
      outcome: {
        type: 'task',
        task: task({ title, source: { filePath: 'Capture.md', line: 0 } }),
      },
    };
  }

  const captureFailure = (): TaskCommandResult => ({
    type: 'io-error',
    cause: 'repository-error',
    contentState: 'unknown',
  });

  it('keeps one focused session open across consecutive Enter successes', async () => {
    const { panel, planCreate, sessionExecute } = captureHarness(async () => captureSuccess());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const input = await openListCapture(container);
      input.focus();
      setCaptureDraft(input, 'first task');
      pressCaptureKey(input, 'Enter');
      await flushMicrotasks();

      expect(container.querySelector('.abyss-quick-capture-input')).toBe(input);
      expect(input.value).toBe('');
      expect(activeDocument.activeElement).toBe(input);
      setCaptureDraft(input, 'second task');
      pressCaptureKey(input, 'Enter');
      await flushMicrotasks();

      expect(planCreate).toHaveBeenCalledOnce();
      expect(sessionExecute).toHaveBeenCalledTimes(2);
      expect(sessionExecute.mock.calls.map(([request]) => request.markdownBody)).toEqual([
        'first task',
        'second task',
      ]);
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(input);
      expect(activeDocument.activeElement).toBe(input);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('closes after blur success without taking focus from the next control', async () => {
    const { panel, sessionExecute } = captureHarness(async () => captureSuccess());
    const container = freshContainer();
    const next = activeDocument.body.createEl('button', { text: 'Next control' });
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const input = await openListCapture(container);
      setCaptureDraft(input, 'blurred task');
      input.focus();
      next.focus();
      await flushMicrotasks();

      expect(sessionExecute).toHaveBeenCalledOnce();
      expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(next);
    } finally {
      panel.destroy();
      container.remove();
      next.remove();
    }
  });

  it.each(['Enter', 'blur'] as const)(
    'preserves the exact draft and shared error state after a %s failure',
    async (cause) => {
      const { panel, sessionExecute } = captureHarness(async () => captureFailure());
      const container = freshContainer();
      const next = activeDocument.body.createEl('button', { text: 'Next control' });
      activeDocument.body.append(container);
      panel.mount(container);
      try {
        const input = await openListCapture(container);
        setCaptureDraft(input, '  repair this exact draft  ');
        if (cause === 'Enter') pressCaptureKey(input, cause);
        else {
          input.focus();
          next.focus();
        }
        await flushMicrotasks();

        const current = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input');
        expect(sessionExecute).toHaveBeenCalledOnce();
        expect(current).toBe(input);
        expect(current?.value).toBe('  repair this exact draft  ');
        expect(current?.closest('.abyss-capture-surface')?.classList).toContain('has-error');
        expect(current?.getAttribute('aria-invalid')).toBe('true');
      } finally {
        panel.destroy();
        container.remove();
        next.remove();
      }
    },
  );

  it('remounts the active draft and focus across a full CenterPanel rerender', async () => {
    const { panel, state, sessionExecute } = captureHarness(async () => captureSuccess());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const before = await openListCapture(container);
      setCaptureDraft(before, 'survive the render');
      before.focus();

      state.set('centerFilter', 'force full render');

      const after = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input');
      expect(after).not.toBe(before);
      expect(before.isConnected).toBe(false);
      expect(after?.value).toBe('survive the render');
      expect(activeDocument.activeElement).toBe(after);
      expect(sessionExecute).not.toHaveBeenCalled();
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('keeps an escaped pending failure editable on only the remounted surface', async () => {
    const result = deferred<TaskCommandResult>();
    const { panel, state, sessionExecute } = captureHarness(() => result.promise);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const before = await openListCapture(container);
      setCaptureDraft(before, 'pending repair');
      before.focus();
      pressCaptureKey(before, 'Enter');
      pressCaptureKey(before, 'Escape');
      state.set('centerFilter', 'rerender while pending');

      const after = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
      expect(after).not.toBe(before);
      expect(after.readOnly).toBe(true);
      expect(after.value).toBe('pending repair');
      result.resolve(captureFailure());
      await flushMicrotasks();

      expect(sessionExecute).toHaveBeenCalledOnce();
      expect(before.isConnected).toBe(false);
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(after);
      expect(after.readOnly).toBe(false);
      expect(after.value).toBe('pending repair');
      expect(after.closest('.abyss-capture-surface')?.classList).toContain('has-error');
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('freezes the configured destination when the inline capture opens', async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'first.md',
      taskPrefix: '',
    };
    const { panel, state, app } = await makePanel({ 'first.md': '', 'changed.md': '' }, settings);
    state.set('selectedList', 'today');
    const container = freshContainer();
    panel.mount(container);

    container.querySelector<HTMLElement>('.abyss-add-task-trigger')?.click();
    await flushMicrotasks();
    settings.customFilePath = 'changed.md';
    const input = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
    setCaptureDraft(input, 'frozen target');
    pressCaptureKey(input, 'Enter');

    await vi.waitFor(async () => {
      expect(await readMd(app, 'first.md')).toContain('- [ ] frozen target');
    });
    expect(await readMd(app, 'changed.md')).toBe('');
  });

  it("sel='today' creates through TaskApplicationApi in customFilePath when addToToday=false", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'inbox.md',
      taskPrefix: '',
    };
    const { panel, state, app } = await makePanel({ 'inbox.md': '- [ ] existing' }, settings);
    state.set('selectedList', 'today');
    fixedToday(TODAY);
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'buy milk');
    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] buy milk ➕ ${TODAY} 📅 ${TODAY}`);
  });

  it("sel='upcoming' freezes tomorrow through the capture application route", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'inbox.md',
      taskPrefix: '',
    };
    const { panel, state, app } = await makePanel({ 'inbox.md': '' }, settings);
    state.set('selectedList', 'upcoming');
    fixedToday(TODAY);
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'future task');
    const content = await readMd(app, 'inbox.md');
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    expect(content).toContain(`- [ ] future task ➕ ${TODAY} 📅 ${tomorrow}`);
  });

  it("sel='inbox' tag mode appends task line with inboxTag to customFilePath", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'Inbox.md',
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    };
    const { panel, state, app } = await makePanel({ 'Inbox.md': '- [ ] existing' }, settings);
    state.set('selectedList', 'inbox');
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'new inbox task');
    const content = await readMd(app, 'Inbox.md');
    expect(content).toContain('- [ ] new inbox task #inbox');
  });

  it("sel='inbox' untagged mode appends plain task line to customFilePath", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'Inbox.md',
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    };
    const { panel, state, app } = await makePanel({ 'Inbox.md': '- [ ] existing' }, settings);
    state.set('selectedList', 'inbox');
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'plain task');
    const content = await readMd(app, 'Inbox.md');
    expect(content).toContain('- [ ] plain task');
    expect(content).not.toContain('#inbox');
  });

  it("sel={type:'tag'} appends task line with the tag to customFilePath", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: false,
      customFilePath: 'Inbox.md',
    };
    const { panel, state, app } = await makePanel({ 'Inbox.md': '' }, settings);
    state.set('selectedList', { type: 'tag', tag: '#work' });
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'tagged task');
    const content = await readMd(app, 'Inbox.md');
    expect(content).toContain('- [ ] tagged task #work');
  });

  it('routes the inbox body/tag rule through TaskApplicationApi to the configured daily note', async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      addToToday: true,
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
      dailyNoteProvider: 'manual',
      manualDailyNotePath: 'periodic/daily/YYYY-MM-DD',
    };
    const { panel, state, app } = await makePanel(
      { [`periodic/daily/${TODAY}.md`]: '# Today\n' },
      settings,
    );
    state.set('selectedList', 'inbox');
    fixedToday(TODAY);
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'today inbox task');
    const content = await readMd(app, `periodic/daily/${TODAY}.md`);
    expect(content).toContain('- [ ] today inbox task #inbox');
  });
});

describe('CenterPanel.deleteTask', () => {
  it('single-line task (no subtaskRange) removes exactly one line', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] keep\n- [ ] delete me\n- [ ] keep2' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 1 }] }],
    );
    const target = index.list().find((item) => item.title === 'delete me')!;
    await call<void>(panel, 'deleteTask', target);
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] keep\n- [ ] keep2');
  });

  it('multi-line root task removes its complete source block', async () => {
    // The root snapshot owns the indented subtask in source.originalBlock.
    const content = '- [ ] parent\n    - [ ] sub\n- [ ] other';
    const { panel, index, app } = await makePanel({ 't.md': content }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const target = index.list()[0]!;
    await call<void>(panel, 'deleteTask', target);
    const after = await readMd(app, 't.md');
    expect(after).toBe('- [ ] other');
  });

  it('file not found (task source path missing from vault) is a no-op', async () => {
    const { panel, index } = await makePanel({ 't.md': '- [ ] x' }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const original = index.list()[0]!;
    const target: TaskSnapshot = {
      ...original,
      ref: { ...original.ref, filePath: 'does-not-exist.md' },
      source: { ...original.source, filePath: 'does-not-exist.md' },
    };
    await expect(call<void>(panel, 'deleteTask', target)).resolves.toBeUndefined();
  });

  it('clears taskStack when the deleted task was the stack top', async () => {
    const { panel, state, index } = await makePanel({ 't.md': '- [ ] x' }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const target = index.list()[0]!;
    state.set('taskStack', [target]);
    await call<void>(panel, 'deleteTask', target);
    expect(state.get('taskStack')).toEqual([]);
  });
});

describe('CenterPanel.rescheduleTask', () => {
  it('task with due date → 📅 replaced with targetDate', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
  });

  it('task with scheduled (no due) → ⏳ replaced with targetDate', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task ⏳ 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task ⏳ 2026-06-28');
  });

  it('task with no due/scheduled → 📅 targetDate appended', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] plain task' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] plain task 📅 2026-06-28');
  });

  it('invalid dragData (no ::: separator) → no-op', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    await call<void>(panel, 'rescheduleTask', 'bogus', '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-20');
    expect(index.list()[0]?.planning.due).toBe('2026-06-20');
  });

  it('task not found in the query index → no-op', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    // Reference a line that doesn't match any parsed task
    await call<void>(panel, 'rescheduleTask', 't.md:::999', '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-20');
    expect(index.list()[0]?.planning.due).toBe('2026-06-20');
  });

  // Task 26: dropping a previously-timed block onto the all-day/"No-time" row reuses this
  // same onDrop path (renderAllDayCell's generic onDrop callback) — the inverse of Round 2
  // Task 8's setTaskTimeFromDrop. A task carrying ⏰/⏱️ tokens must have both stripped, in
  // addition to the date move every onDrop call already performs.
  it('a previously-timed task dropped onto the all-day row has ⏰ time and ⏱️ duration stripped, date still moved', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20 ⏰ 09:00 ⏱️ 1h30m' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    expect(target.planning.time).toBe('09:00');
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
    expect(content).not.toContain('⏰');
    expect(content).not.toContain('⏱️');
  });

  it('a task with time but no duration dropped onto the all-day row strips only ⏰', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20 ⏰ 09:00' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
  });

  it('a task with no time is unaffected by the time/duration-stripping branch (unchanged prior behavior)', async () => {
    const { panel, index, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-20' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const target = index.list()[0]!;
    await call<void>(panel, 'rescheduleTask', `${target.source.filePath}:::0`, '2026-06-28');
    const content = await readMd(app, 't.md');
    expect(content).toBe('- [ ] task 📅 2026-06-28');
  });
});

describe('CenterPanel.renderWithGrouping (date grouping)', () => {
  fixedToday('2026-06-25');

  /**
   * Call the private renderWithGrouping directly with groupBy='date' to exercise
   * the bucketing logic in isolation.
   */
  function renderWithGroupingByDate(tasks: TaskSnapshot[]): HTMLElement {
    const state = new AppState();
    state.set('centerListViewState', {
      groupBy: 'date',
      sortBy: { field: 'date', dir: 'asc' },
      statusGroups: undefined,
      filters: [],
    });
    const panel = makeStaticPanel(state, tasks);
    const container = freshContainer();
    void call<void>(panel, 'renderWithGrouping', container, tasks);
    return container;
  }

  it('buckets tasks into Overdue/Today/Tomorrow/Upcoming with counts', () => {
    const tasks = [
      task({
        title: 'overdue',
        planning: { due: '2026-06-20' },
        source: { filePath: 't.md', line: 0 },
      }),
      task({
        title: 'today',
        planning: { due: '2026-06-25' },
        source: { filePath: 't.md', line: 1 },
      }),
      task({
        title: 'tomorrow',
        planning: { due: '2026-06-26' },
        source: { filePath: 't.md', line: 2 },
      }),
      task({
        title: 'upcoming',
        planning: { due: '2026-07-05' },
        source: { filePath: 't.md', line: 3 },
      }),
    ];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.abyss-group-header');
    const labels = Array.from(headers).map((h) => h.textContent?.trim());
    expect(labels).toContain('Overdue  1');
    expect(labels).toContain('Today  1');
    expect(labels).toContain('Tomorrow  1');
    expect(labels).toContain('Upcoming  1');
  });

  it('renders a daily-note-only task in No date rather than Today', () => {
    const container = renderWithGroupingByDate([
      task({ title: 'daily-only', presentation: { dailyNoteDate: '2026-06-25' } }),
    ]);
    expect(
      Array.from(container.querySelectorAll('.abyss-group-header')).map(
        (header) => header.textContent,
      ),
    ).toContain('No date  1');
  });

  it('empty groups are skipped (only non-empty groups render)', () => {
    const tasks = [
      task({
        title: 'today only',
        planning: { due: '2026-06-25' },
        source: { filePath: 't.md', line: 0 },
      }),
    ];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.abyss-group-header');
    const labels = Array.from(headers).map((h) => h.textContent?.trim());
    expect(labels).toEqual(['Today  1']);
  });

  it('no-date task falls into "No date" bucket (not Overdue)', () => {
    const tasks = [task({ title: 'no date', source: { filePath: 't.md', line: 0 } })];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.abyss-group-header');
    const labels = Array.from(headers).map((h) => h.textContent?.trim());
    expect(labels).toEqual(['No date  1']);
  });
});

describe('CenterPanel.renderSearch', () => {
  fixedToday('2026-06-25');

  function withQueuedAnimationFrames(
    run: (flush: () => void, callbacks: Map<number, FrameRequestCallback>) => void,
  ): void {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestAnimationFrame = window.requestAnimationFrame;
    const cancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((frame: number): void => {
      callbacks.delete(frame);
    }) as typeof window.cancelAnimationFrame;

    try {
      run(() => {
        const queued = [...callbacks.entries()];
        callbacks.clear();
        for (const [, callback] of queued) callback(0);
      }, callbacks);
    } finally {
      window.requestAnimationFrame = requestAnimationFrame;
      window.cancelAnimationFrame = cancelAnimationFrame;
    }
  }

  it('renders matching task cards for a query', () => {
    const tasks = [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
      task({ title: 'walk dog', source: { filePath: 'b.md', line: 0 } }),
    ];
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'milk');
    const panel = makeStaticPanel(state, tasks);
    panel.mount(freshContainer());
    const cards = panel['el'].querySelectorAll('.abyss-task-card');
    expect(cards).toHaveLength(1);
    // Title renders via MarkdownRenderer (mocked as a noop in tests), so identity
    // is asserted via the card's stable file-path/line dataset instead of title text.
    expect(cards[0]?.querySelector('.abyss-task-title')).toBeTruthy();
    expect((cards[0] as HTMLElement).dataset['filePath']).toBe('a.md');
    expect((cards[0] as HTMLElement).dataset['line']).toBe('0');
    panel.destroy();
  });

  it('searches the persisted query list without requesting calendar projections', () => {
    const persisted = task({
      title: 'forecast boundary needle',
      recurrence: 'every day',
      planning: { due: '2026-06-01' },
      source: { filePath: 'persisted.md', line: 4 },
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
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'needle');
    const panel = new CenterPanel(
      state,
      {} as App,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    );

    panel.mount(freshContainer());

    expect(panel['el'].querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(panel['el'].querySelector<HTMLElement>('.abyss-task-card')?.dataset['filePath']).toBe(
      'persisted.md',
    );
    expect(list).toHaveBeenCalled();
    expect(forCalendarProjection).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('keeps the live search input mounted and coalesces result refreshes into one frame', () => {
    const tasks = [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
      task({ title: 'walk dog', source: { filePath: 'b.md', line: 0 } }),
    ];
    const state = new AppState();
    state.set('mode', 'search');
    const panel = makeStaticPanel(state, tasks);
    const container = freshContainer();
    document.body.append(container);
    panel.mount(container);
    const originalInput = panel['el'].querySelector<HTMLInputElement>('.abyss-search-global')!;
    originalInput.focus();
    const renderSpy = vi.spyOn(panel as unknown as { render: () => void }, 'render');
    const renderFlatSpy = vi.spyOn(
      panel as unknown as { renderFlat: (host: HTMLElement, tasks: TaskSnapshot[]) => void },
      'renderFlat',
    );

    withQueuedAnimationFrames((flush) => {
      originalInput.value = 'mil';
      originalInput.dispatchEvent(new Event('input', { bubbles: true }));
      originalInput.value = 'milk';
      originalInput.dispatchEvent(new Event('input', { bubbles: true }));
      flush();
    });

    expect(panel['el'].querySelector('.abyss-search-global')).toBe(originalInput);
    expect(document.activeElement).toBe(originalInput);
    expect(originalInput.value).toBe('milk');
    expect(panel['el'].querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(renderFlatSpy).toHaveBeenCalledTimes(1);
    panel.destroy();
    container.remove();
  });

  it('preserves the live search shell and coalesces task-index refreshes into one frame', () => {
    const tasks = [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
      task({ title: 'walk dog', source: { filePath: 'b.md', line: 0 } }),
    ];
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'milk');
    const panel = makeStaticPanel(state, tasks);
    const container = freshContainer();
    document.body.append(container);
    panel.mount(container);
    const originalInput = panel['el'].querySelector<HTMLInputElement>('.abyss-search-global')!;
    originalInput.focus();
    originalInput.setSelectionRange(1, 3);
    const renderFlatSpy = vi.spyOn(
      panel as unknown as { renderFlat: (host: HTMLElement, tasks: TaskSnapshot[]) => void },
      'renderFlat',
    );

    tasks.splice(
      0,
      tasks.length,
      task({ title: 'walk dog', source: { filePath: 'b.md', line: 0 } }),
      task({ title: 'milk delivery', source: { filePath: 'c.md', line: 0 } }),
    );

    withQueuedAnimationFrames((flush, callbacks) => {
      panel.refresh();
      panel.refresh();

      expect(callbacks).toHaveLength(1);
      expect(panel['el'].querySelector('.abyss-search-global')).toBe(originalInput);
      expect(panel['el'].querySelector<HTMLElement>('.abyss-task-card')?.dataset['filePath']).toBe(
        'a.md',
      );
      flush();
    });

    expect(panel['el'].querySelector('.abyss-search-global')).toBe(originalInput);
    expect(document.activeElement).toBe(originalInput);
    expect(originalInput.value).toBe('milk');
    expect(originalInput.selectionStart).toBe(1);
    expect(originalInput.selectionEnd).toBe(3);
    expect(panel['el'].querySelectorAll('.abyss-task-card')).toHaveLength(1);
    expect(panel['el'].querySelector<HTMLElement>('.abyss-task-card')?.dataset['filePath']).toBe(
      'c.md',
    );
    expect(renderFlatSpy).toHaveBeenCalledTimes(1);
    panel.destroy();
    container.remove();
  });

  it('leaves a queued search refresh inert after changing modes', () => {
    const state = new AppState();
    state.set('mode', 'search');
    const panel = makeStaticPanel(state, [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
    ]);
    const container = freshContainer();
    document.body.append(container);
    panel.mount(container);
    const input = panel['el'].querySelector<HTMLInputElement>('.abyss-search-global')!;

    withQueuedAnimationFrames((_flush, callbacks) => {
      input.value = 'milk';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(callbacks).toHaveLength(1);
      const callback = [...callbacks.values()][0]!;
      state.set('mode', 'projects');
      expect(() => callback(0)).not.toThrow();
    });

    expect(panel['el'].querySelector('.abyss-search-global')).toBeNull();
    expect(panel['el'].querySelectorAll('.abyss-task-card')).toHaveLength(0);
    panel.destroy();
    container.remove();
  });

  it('leaves a queued search refresh inert after destruction', () => {
    const state = new AppState();
    state.set('mode', 'search');
    const panel = makeStaticPanel(state, [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
    ]);
    const container = freshContainer();
    document.body.append(container);
    panel.mount(container);
    const input = panel['el'].querySelector<HTMLInputElement>('.abyss-search-global')!;

    withQueuedAnimationFrames((_flush, callbacks) => {
      input.value = 'milk';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(callbacks).toHaveLength(1);
      const callback = [...callbacks.values()][0]!;
      panel.destroy();
      expect(() => callback(0)).not.toThrow();
    });

    expect(panel['el'].childElementCount).toBe(0);
    container.remove();
  });

  it('clicking a result sets selectedList + mode + taskStack on state', () => {
    const t = task({
      title: 'buy milk',
      planning: { due: '2026-06-25' },
      source: { filePath: 'a.md', line: 0 },
    });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'milk');
    const panel = makeStaticPanel(state, [t]);
    panel.mount(freshContainer());
    const card = panel['el'].querySelector<HTMLElement>('.abyss-task-card')!;
    card.click();
    expect(state.get('mode')).toBe('tasks');
    expect(state.get('selectedList')).toBe('today');
    expect(state.get('taskStack')).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
        title: t.title,
      }),
    ]);
    panel.destroy();
  });

  it('routes a daily-note-only search result to inbox', () => {
    const t = task({ title: 'daily-only', presentation: { dailyNoteDate: '2026-06-25' } });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'daily');
    const panel = makeStaticPanel(state, [t]);
    panel.mount(freshContainer());
    panel['el'].querySelector<HTMLElement>('.abyss-task-card')!.click();
    expect(state.get('selectedList')).toBe('inbox');
    panel.destroy();
  });
});

describe('CenterPanel source note chip', () => {
  fixedToday('2026-06-25');

  function makeSearchPanel(
    tasks: TaskSnapshot[],
    settingsOverrides: Partial<typeof DEFAULT_SETTINGS> = {},
  ): CenterPanel {
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', tasks[0]?.title ?? '');
    const panel = makeStaticPanel(state, tasks, {
      ...DEFAULT_SETTINGS,
      ...settingsOverrides,
    });
    panel.mount(freshContainer());
    return panel;
  }

  it('sourceNoteDisplay always → chip shown for daily note task', () => {
    const t = task({
      title: 'daily task',
      planning: { due: '2026-06-25' },
      source: { filePath: 'periodic/daily/2026-06-25.md' },
      presentation: { dailyNoteDate: '2026-06-25' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'always' });
    expect(panel['el'].querySelector('.abyss-task-source-note')).not.toBeNull();
    panel.destroy();
  });

  it('sourceNoteDisplay never → no chip', () => {
    const t = task({
      title: 'project task',
      tags: ['#work'],
      planning: { due: '2026-06-25' },
      source: { filePath: 'Projects/alpha.md' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'never' });
    expect(panel['el'].querySelector('.abyss-task-source-note')).toBeNull();
    panel.destroy();
  });

  it('sourceNoteDisplay non-default → chip for project note', () => {
    const t = task({
      title: 'project task',
      planning: { due: '2026-06-25' },
      source: { filePath: 'Projects/alpha.md' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'non-default' });
    const chip = panel['el'].querySelector('.abyss-task-source-note');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('alpha');
    panel.destroy();
  });

  it('sourceNoteDisplay non-default → no chip for daily note task', () => {
    const t = task({
      title: 'daily task',
      planning: { due: '2026-06-25' },
      source: { filePath: 'periodic/daily/2026-06-25.md' },
      presentation: { dailyNoteDate: '2026-06-25' },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'non-default' });
    expect(panel['el'].querySelector('.abyss-task-source-note')).toBeNull();
    panel.destroy();
  });

  it('chip appears before tag in abyss-task-meta-right', () => {
    const t = task({
      title: 'project task',
      tags: ['#work'],
      planning: { due: '2026-06-25' },
      source: {
        filePath: 'Projects/alpha.md',
        originalMarkdown: '- [ ] project task #work',
        originalBlock: '- [ ] project task #work',
      },
    });
    const panel = makeSearchPanel([t], { sourceNoteDisplay: 'always' });
    const meta = panel['el'].querySelector('.abyss-task-meta-right');
    expect(meta).not.toBeNull();
    const children = Array.from(meta!.children);
    const noteIdx = children.findIndex((el) => el.classList.contains('abyss-task-source-note'));
    const tagIdx = children.findIndex((el) => el.classList.contains('abyss-task-tag'));
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(noteIdx);
    panel.destroy();
  });
});

describe('CenterPanel project selection', () => {
  it("sel={type:'project'} filters tasks to that note and titles by basename", async () => {
    const files = {
      'Projects/A.md': '- [ ] task one\n- [ ] task two\n',
      'Other.md': '- [ ] elsewhere\n',
    };
    const seeds = [
      {
        path: 'Projects/A.md',
        items: [
          { task: ' ', parent: -1, line: 0 },
          { task: ' ', parent: -1, line: 1 },
        ],
      },
      { path: 'Other.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ];
    const { panel, state } = await makePanel(files, DEFAULT_SETTINGS, seeds);
    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks') as TaskSnapshot[];
    expect(tasks.length).toBe(2);
    expect(tasks.every((item) => item.source.filePath === 'Projects/A.md')).toBe(true);
    expect(call<string>(panel, 'getTitle')).toBe('A');
  });

  it("sel={type:'project'} capture appends into the project note", async () => {
    const { panel, state, app } = await makePanel({ 'Projects/A.md': '# Project A\n' });
    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'write the brief');
    const content = await readMd(app, 'Projects/A.md');
    expect(content).toContain('- [ ] write the brief');
  });

  it("sel={type:'project'} capture honors the project section-insertion setting", async () => {
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      // Project creation uses the project-specific insertion setting, not the global one.
      projects: {
        ...DEFAULT_SETTINGS.projects,
        taskInsertionMode: 'section',
        taskInsertionSection: '## Tasks',
      },
    };
    const { panel, state, app } = await makePanel(
      { 'Projects/A.md': '# Project A\n\n## Tasks\n- [ ] existing\n' },
      settings,
    );
    state.set('selectedList', { type: 'project', path: 'Projects/A.md' });
    fixedToday(TODAY);
    const container = freshContainer();
    panel.mount(container);
    await submitListCapture(container, 'under section');
    const content = await readMd(app, 'Projects/A.md');
    const lines = content.split('\n');
    const sectionIdx = lines.findIndex((l) => l.trim() === '## Tasks');
    expect(lines[sectionIdx + 1]).toBe(`- [ ] under section ➕ ${TODAY}`);
  });
});

describe('CenterPanel projects mode teardown (regression)', () => {
  function stubProjectStore() {
    return {
      list: () => [],
      get: () => undefined,
      activeForLeftPanel: () => [],
      onUpdate: () => () => {},
      refresh: () => {},
    } as never;
  }
  function stubProjectManager() {
    return { setStatus: async () => {}, create: async () => null } as never;
  }

  async function makeProjectsPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    el: HTMLElement;
  }> {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\nstatus: active\n---\n' });
    const taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await taskApplication.index.initialize();
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      taskApplication.index,
      taskApplication.statusRegistry,
      async () => {},
      stubProjectStore(),
      stubProjectManager(),
      taskApplication.tasks,
    );
    const el = freshContainer();
    panel.mount(el);
    return { panel, state, el };
  }

  it('mounts the projects panel on a child host, not the shared center element', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    // The projects panel class lives on the child host, never on the center el.
    expect(el.classList.contains('abyss-projects-panel')).toBe(false);
    expect(el.querySelector('.abyss-projects-host .abyss-projects-list')).toBeTruthy();
  });

  it('leaving projects mode restores a clean tasks center (no leaked class or DOM)', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    // Back to tasks with a tag selection.
    state.set('selectedList', { type: 'tag', tag: '#work' });
    state.set('mode', 'tasks');
    expect(el.classList.contains('abyss-projects-panel')).toBe(false);
    expect(el.classList.contains('abyss-center--projects')).toBe(false);
    expect(el.querySelector('.abyss-projects-host')).toBeNull();
    // Normal tasks-mode header (title + controls) renders again.
    expect(el.querySelector('.abyss-center-header')).toBeTruthy();
    expect(el.querySelector('.abyss-center-scroll')).toBeTruthy();
  });

  it('keeps a project-dashboard capture session across success and a full panel rerender', async () => {
    const app = await createAppWithFiles({ 'Projects/A.md': '# Project\n' });
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const queries = taskQueryApi();
    const sessionExecute = vi.fn<TaskCreateSession['execute']>(async () => ({
      type: 'ok' as const,
      changed: true,
      outcome: {
        type: 'task' as const,
        task: task({ title: 'Captured', source: { filePath: 'Projects/A.md', line: 1 } }),
      },
    }));
    const planCreate = vi.fn(async () => ({
      type: 'ready' as const,
      destination: { filePath: 'Projects/A.md', insertion: { type: 'append' as const } },
      execute: sessionExecute,
    }));
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries,
      planCreate,
      execute: vi.fn(async () => ({
        type: 'invalid' as const,
        issues: [{ code: 'invalid-target' as const }],
      })),
    };
    const project = {
      path: 'Projects/A.md',
      name: 'A',
      frontmatter: {},
      tags: [],
      statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
      rawStatus: null,
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
    };
    const projectStore = {
      list: () => [project],
      get: () => project,
      activeForLeftPanel: () => [project],
      onUpdate: () => () => {},
      refresh: () => {},
    } as never;
    const panel = new CenterPanel(
      state,
      app,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      projectStore,
      stubProjectManager(),
      application,
      undefined,
      application,
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      state.set('mode', 'projects');
      const first = await openListCapture(container);
      first.focus();
      setCaptureDraft(first, 'first project task');
      pressCaptureKey(first, 'Enter');
      await flushMicrotasks();
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(first);

      state.set('centerFilter', 'force project rerender');
      const remounted = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input')!;
      expect(remounted).not.toBe(first);
      expect(activeDocument.activeElement).toBe(remounted);
      setCaptureDraft(remounted, 'second project task');
      pressCaptureKey(remounted, 'Enter');
      await flushMicrotasks();

      expect(planCreate).toHaveBeenCalledOnce();
      expect(planCreate).toHaveBeenCalledWith({
        type: 'explicit',
        destination: { filePath: 'Projects/A.md', insertion: { type: 'append' } },
      });
      expect(sessionExecute.mock.calls.map(([request]) => request.markdownBody)).toEqual([
        'first project task',
        'second project task',
      ]);
    } finally {
      panel.destroy();
      container.remove();
    }
  });
});

describe('CenterPanel calendar mode — Today/Week/Month switcher', () => {
  async function makeCalendarPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, app } = await makePanel(
      { 't.md': '- [ ] task 📅 2026-06-15' },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, el, app };
  }

  it('view switcher shows Day, Week, Month (not Today/Week/Month)', async () => {
    const { el } = await makeCalendarPanel();
    const labels = Array.from(el.querySelectorAll('.abyss-cal-view-btn')).map((b) => b.textContent);
    expect(labels).toEqual(['Day', 'Week', 'Month']);
  });

  it('defaults to Month and mounts MonthGridView', async () => {
    const { el } = await makeCalendarPanel();
    expect(el.querySelector('.abyss-mg-grid')).not.toBeNull();
  });

  it('renders forecast occurrences as inert, non-draggable calendar items', () => {
    const root = task({
      title: 'Repeat source',
      recurrence: 'every day',
      planning: { due: '2026-08-08', time: '09:00', duration: 60 },
    });
    const source = {
      root,
      target: { type: 'task' as const, ref: root.ref },
      node: root,
    };
    const spanRoot = task({
      title: 'Span repeat',
      recurrence: 'every day',
      planning: { start: '2026-08-07', due: '2026-08-08' },
    });
    const spanSource = {
      root: spanRoot,
      target: { type: 'task' as const, ref: spanRoot.ref },
      node: spanRoot,
    };
    const queries = taskQueryApi({
      list: () => [root, spanRoot],
      forCalendarProjection: () => ({
        materialized: [],
        recurringSources: [source, spanSource],
      }),
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      {} as App,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      { queries, execute },
    );
    const el = freshContainer();
    panel.mount(el);
    (panel as unknown as { calDate: moment.Moment }).calDate = moment('2026-08-09');

    state.set('mode', 'calendar');

    const forecastBadge = el.querySelector<HTMLElement>("[data-recurrence-forecast='true']");
    expect(forecastBadge).not.toBeNull();
    const item = forecastBadge?.parentElement;
    expect(item?.getAttribute('draggable')).toBeNull();
    item
      ?.querySelector<HTMLElement>('.abyss-status-marker')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(execute).not.toHaveBeenCalled();

    clickCalendarView(el, 'Day');
    const timedForecastBadge = el.querySelector<HTMLElement>(
      ".abyss-tg-block [data-recurrence-forecast='true']",
    );
    expect(timedForecastBadge).not.toBeNull();
    const timedBlock = timedForecastBadge?.closest<HTMLElement>('.abyss-tg-block');
    expect(timedBlock?.querySelector('.abyss-status-marker')).toBeNull();
    expect(timedBlock?.getAttribute('tabindex')).toBeNull();
    expect(timedBlock?.querySelector('[data-resize-edge]')).toBeNull();
    timedBlock?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(execute).not.toHaveBeenCalled();
    const spanBadge = el.querySelector<HTMLElement>(
      ".abyss-tg-body [data-recurrence-forecast='true']",
    );
    const spanBody = spanBadge?.closest<HTMLElement>('.abyss-tg-body');
    expect(spanBody).not.toBeNull();
    expect(spanBody?.getAttribute('draggable')).toBeNull();
    expect(spanBody?.querySelector('[data-resize-edge]')).toBeNull();
    panel.destroy();
  });

  it('routes a materialized nested recurrence owner through its subtask target', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const baseRoot = task({ title: 'Root' });
    const child = {
      ref: {
        parent: { type: 'task' as const, ref: baseRoot.ref },
        relativeLine: 1,
        originalBlock: '  - [ ] Nested repeat 🔁 every day 📅 2026-08-09',
      },
      title: 'Nested repeat',
      markdownTitle: 'Nested repeat',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      planning: { due: '2026-08-09' as LocalDate, time: localTime('09:00') },
      tags: [],
      recurrence: 'every day',
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      subtasks: [],
      comments: [],
    };
    const root = { ...baseRoot, subtasks: [child] };
    const source = {
      root,
      target: { type: 'subtask' as const, ref: child.ref },
      node: child,
    };
    const queries = taskQueryApi({
      list: () => [root],
      forCalendarProjection: () => ({ materialized: [source], recurringSources: [] }),
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      {} as App,
      DEFAULT_SETTINGS,
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      { queries, execute },
    );
    const el = freshContainer();
    panel.mount(el);
    const openModal = vi.spyOn(
      (panel as unknown as { taskModal: { open(task: TaskSnapshot): void } }).taskModal,
      'open',
    );
    (panel as unknown as { calDate: moment.Moment }).calDate = moment('2026-08-09');
    state.set('mode', 'calendar');

    const item = el.querySelector<HTMLElement>('.abyss-mg-block-dot');
    expect(item).not.toBeNull();
    expect(item?.getAttribute('draggable')).toBeNull();
    item?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(openModal).not.toHaveBeenCalled();
    const marker = item?.querySelector<HTMLElement>('.abyss-status-marker');
    marker?.click();

    expect(execute).toHaveBeenCalledWith({
      type: 'toggle-completion',
      target: source.target,
    });

    clickCalendarView(el, 'Day');
    const timedBlock = el.querySelector<HTMLElement>('.abyss-tg-block');
    expect(timedBlock).not.toBeNull();
    expect(timedBlock?.getAttribute('tabindex')).toBeNull();
    expect(timedBlock?.querySelector('[data-resize-edge]')).toBeNull();
  });

  it('keeps direct RightPanel and modal completion on the same exact application target seam', async () => {
    const app = await createAppWithFiles({
      'repeat.md': '- [ ] Shared surface repeat 🔁 every day 📅 2026-08-09\n',
    });
    const recurring = task({
      title: 'Shared surface repeat',
      recurrence: 'every day',
      planning: { due: '2026-08-09' },
      ref: { filePath: 'repeat.md', line: 0, revision: 'exact-shared-surface-ref' },
      source: {
        filePath: 'repeat.md',
        line: 0,
        originalMarkdown: '- [ ] Shared surface repeat 🔁 every day 📅 2026-08-09',
        originalBlock: '- [ ] Shared surface repeat 🔁 every day 📅 2026-08-09',
      },
    });
    const queries = taskQueryApi({
      list: () => [recurring],
      resolve: () => ({ type: 'exact', task: recurring, basis: { observed: recurring } }),
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: recurring },
    });
    const application: TaskApplicationApi = { queries, execute };
    const registry = new StatusRegistry(DEFAULT_SETTINGS.taskStatuses);
    const state = new AppState();
    const panel = new RightPanel(state, app, registry, DEFAULT_SETTINGS, undefined, application);
    const panelHost = freshContainer();
    panel.mount(panelHost);
    state.set('taskStack', [recurring]);

    const modal = new TaskModal(app, registry, DEFAULT_SETTINGS, queries, application);
    try {
      panelHost
        .querySelector<HTMLElement>('.abyss-right-header > .abyss-status-marker')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();

      modal.open(recurring);
      activeDocument
        .querySelector<HTMLElement>('.abyss-modal .abyss-right-header > .abyss-status-marker')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flushMicrotasks();

      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        {
          type: 'toggle-completion',
          target: { type: 'task', ref: recurring.ref },
        },
        {
          type: 'toggle-completion',
          target: { type: 'task', ref: recurring.ref },
        },
      ]);
    } finally {
      modal.close();
      panel.destroy();
    }
  });

  it('clicking Today switches to TodayView', async () => {
    const { el } = await makeCalendarPanel();
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();
    expect(el.querySelector('.abyss-tg-root')).not.toBeNull();
  });

  it('clicking a Month day cell drills into Day (Today) view for that specific date', async () => {
    const { el } = await makeCalendarPanel();
    const cell = el.querySelector(
      '.abyss-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    const date = cell.getAttribute('data-mg-date')!;
    cell.click();
    // A single day column for the clicked date — not a 7-column week — confirms Today, not Week.
    const columns = el.querySelectorAll('.abyss-tg-day-column');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.getAttribute('data-tg-date')).toBe(date);
  });

  it('clicking a Week header cell drills into Day (Today) view for that specific date', async () => {
    const { el } = await makeCalendarPanel();
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Week',
      ) as HTMLElement
    ).click();
    const headerCells = Array.from(el.querySelectorAll('.abyss-tg-header-cell'));
    expect(headerCells.length).toBeGreaterThan(1); // sanity: still in Week (multi-column)
    const dayColumnsBefore = Array.from(el.querySelectorAll('.abyss-tg-day-column'));
    const targetDate = dayColumnsBefore[2]?.getAttribute('data-tg-date');
    (headerCells[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const columns = el.querySelectorAll('.abyss-tg-day-column');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.getAttribute('data-tg-date')).toBe(targetDate);
  });

  it('clicking inside the all-day band in Week view does not drill into Today (separate row from the header)', async () => {
    const { el } = await makeCalendarPanel();
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Week',
      ) as HTMLElement
    ).click();
    const alldayCell = el.querySelector('.abyss-tg-allday-cell') as HTMLElement;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelectorAll('.abyss-tg-day-column')).toHaveLength(7);
  });

  it('no 🎨 style-cycle button is rendered in the new calendar toolbar', async () => {
    const { el } = await makeCalendarPanel();
    expect(el.querySelector('.abyss-cal-style-btn')).toBeNull();
  });

  it.each([
    ['month', '.abyss-cal-nav-month', '.abyss-month-picker', '.abyss-month-picker-btn'],
    ['year', '.abyss-cal-nav-year', '.abyss-year-picker', '.abyss-year-picker-btn'],
  ] as const)(
    '%s picker removes its document dismiss listener after selection, toggle-close, and destroy',
    async (_kind, anchorSelector, pickerSelector, optionSelector) => {
      const addSpy = vi.spyOn(activeDocument, 'addEventListener');
      const removeSpy = vi.spyOn(activeDocument, 'removeEventListener');
      const openHarness = async () => {
        const harness = await makeCalendarPanel();
        activeDocument.body.append(harness.el);
        const anchor = harness.el.querySelector<HTMLElement>(anchorSelector)!;
        anchor.click();
        expect(anchor.getAttribute('aria-expanded')).toBe('true');
        await flushMicrotasks();
        const registration = [...addSpy.mock.calls].reverse().find(([type]) => type === 'click');
        expect(registration).toBeDefined();
        return { ...harness, anchor, registration };
      };
      const wasRemoved = (registration: (typeof addSpy.mock.calls)[number]): boolean =>
        removeSpy.mock.calls.some(
          ([type, listener, options]) =>
            type === 'click' && listener === registration[1] && options === registration[2],
        );

      try {
        const selected = await openHarness();
        selected.el.querySelector<HTMLElement>(`${pickerSelector} ${optionSelector}`)!.click();
        expect(selected.anchor.getAttribute('aria-expanded')).toBe('false');
        expect(wasRemoved(selected.registration!)).toBe(true);
        selected.panel.destroy();
        selected.el.remove();

        const toggled = await openHarness();
        toggled.anchor.click();
        expect(toggled.el.querySelector(pickerSelector)).toBeNull();
        expect(toggled.anchor.getAttribute('aria-expanded')).toBe('false');
        expect(wasRemoved(toggled.registration!)).toBe(true);
        toggled.panel.destroy();
        toggled.el.remove();

        const destroyed = await openHarness();
        destroyed.panel.destroy();
        expect(destroyed.anchor.getAttribute('aria-expanded')).toBe('false');
        expect(wasRemoved(destroyed.registration!)).toBe(true);
        destroyed.el.remove();
      } finally {
        addSpy.mockRestore();
        removeSpy.mockRestore();
      }
    },
  );

  it.each([
    ['month', '.abyss-cal-nav-month', '.abyss-month-picker-btn'],
    ['year', '.abyss-cal-nav-year', '.abyss-year-picker-btn'],
  ] as const)(
    '%s picker selection before deferred registration does not install a stale document listener',
    async (_kind, anchorSelector, optionSelector) => {
      const addSpy = vi.spyOn(activeDocument, 'addEventListener');
      try {
        const { panel, el } = await makeCalendarPanel();
        activeDocument.body.append(el);
        addSpy.mockClear();
        el.querySelector<HTMLElement>(anchorSelector)!.click();
        el.querySelector<HTMLElement>(optionSelector)!.click();
        await flushMicrotasks();

        expect(addSpy.mock.calls.some(([type]) => type === 'click')).toBe(false);
        panel.destroy();
        el.remove();
      } finally {
        addSpy.mockRestore();
      }
    },
  );

  it.each([
    ['month', '.abyss-cal-nav-month', '.abyss-month-picker', '.abyss-month-picker-btn'],
    ['year', '.abyss-cal-nav-year', '.abyss-year-picker', '.abyss-year-picker-btn'],
  ] as const)(
    '%s picker owns initial focus and Escape dismissal',
    async (_kind, anchorSelector, pickerSelector, optionSelector) => {
      const addSpy = vi.spyOn(activeDocument, 'addEventListener');
      const documentKeydown = vi.fn();
      activeDocument.addEventListener('keydown', documentKeydown);
      let panel: CenterPanel | undefined;
      let el: HTMLElement | undefined;
      try {
        ({ panel, el } = await makeCalendarPanel());
        activeDocument.body.append(el);
        const anchor = el.querySelector<HTMLElement>(anchorSelector)!;
        expect(anchor.getAttribute('aria-haspopup')).toBe('dialog');
        expect(anchor.getAttribute('aria-expanded')).toBe('false');
        anchor.focus();
        anchor.click();
        expect(anchor.getAttribute('aria-expanded')).toBe('true');

        const picker = el.querySelector<HTMLElement>(pickerSelector)!;
        const selected = picker.querySelector<HTMLElement>(`${optionSelector}.is-active`)!;
        expect(selected).not.toBeNull();
        expect(picker.getAttribute('role')).toBe('dialog');
        expect(picker.getAttribute('aria-modal')).toBe('false');
        expect(picker.getAttribute('aria-label')).toBe(`Select ${_kind}`);
        expect(selected.getAttribute('aria-pressed')).toBe('true');
        expect(
          Array.from(picker.querySelectorAll<HTMLElement>(optionSelector))
            .filter((option) => option !== selected)
            .every((option) => option.getAttribute('aria-pressed') === 'false'),
        ).toBe(true);
        expect(picker.contains(activeDocument.activeElement)).toBe(true);
        expect(activeDocument.activeElement).toBe(selected);

        const escape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        selected.dispatchEvent(escape);

        expect(escape.defaultPrevented).toBe(true);
        expect(documentKeydown).not.toHaveBeenCalled();
        expect(el.querySelector(pickerSelector)).toBeNull();
        expect(anchor.getAttribute('aria-expanded')).toBe('false');
        expect(activeDocument.activeElement).toBe(anchor);

        anchor.click();
        const reopenedPicker = el.querySelector<HTMLElement>(pickerSelector)!;
        const reopenedSelected = reopenedPicker.querySelector<HTMLElement>(
          `${optionSelector}.is-active`,
        )!;
        expect(activeDocument.activeElement).toBe(reopenedSelected);
        reopenedSelected.click();
        expect(el.querySelector(pickerSelector)).toBeNull();
        expect(anchor.getAttribute('aria-expanded')).toBe('false');
        expect(activeDocument.activeElement).toBe(anchor);

        await flushMicrotasks();
        expect(
          addSpy.mock.calls.filter(([type]) => type === 'click'),
          'Escape before deferred outside-dismiss registration must not leave a listener',
        ).toHaveLength(0);
      } finally {
        panel?.destroy();
        el?.remove();
        activeDocument.removeEventListener('keydown', documentKeydown);
        addSpy.mockRestore();
      }
    },
  );

  it('right-clicking a Month-view checkbox opens the status/priority popover instead of the task-edit modal, and picking a priority mutates the file through the task API', async () => {
    // The task must fall on a currently-visible day of the default (today's) month, so it's
    // anchored to TODAY rather than makeCalendarPanel's fixed June 2026 seed task.
    const { panel, state, app } = await makePanel(
      { 't.md': `- [ ] task 📅 ${TODAY}` },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    const marker = el.querySelector(
      '.abyss-mg-plain .abyss-status-marker, .abyss-mg-deadline-marker .abyss-status-marker',
    ) as HTMLElement;
    expect(marker).not.toBeNull();

    // Right-click the checkbox: opens the popover, not the TaskModal (no modal container appended).
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const popover = document.querySelector('.abyss-status-popover');
    expect(popover).not.toBeNull();
    expect(document.querySelector('.modal')).toBeNull();

    const flagBtn = popover!.querySelector(
      '.abyss-status-popover-flag[data-abyss-priority="A"]',
    ) as HTMLElement;
    expect(flagBtn).not.toBeNull();
    flagBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 't.md');
    expect(content).toContain('🔺');
  });
});

describe('CenterPanel calendar mode — scroll-to-now dedup (Task 27)', () => {
  async function makeCalendarPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    index: TaskQueryApi;
    tasks: TaskApplicationApi;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, index, tasks, app } = await makePanel(
      { 't.md': `- [ ] task 📅 ${TODAY}` },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, index, tasks, el, app };
  }

  function clickViewBtn(el: HTMLElement, label: 'Day' | 'Week' | 'Month'): void {
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === label,
      ) as HTMLElement
    ).click();
  }

  function lastShouldScrollToNow(spy: { mock: { calls: unknown[][] } }): unknown {
    const calls = spy.mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[3];
  }

  it('switching into Week view for the first time scrolls (shouldScrollToNow=true)', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    renderSpy.mockRestore();
  });

  it('a reactive task-index update patches the same view/date without rendering or scrolling again', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const patchSpy = vi.spyOn(WeekTimeGridView.prototype, 'patch');
    const { el, index, tasks } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    const renderCalls = renderSpy.mock.calls.length;

    const seededTask = index.list({ filePath: 't.md' })[0]!;
    await tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: seededTask.ref },
    });
    await flushMicrotasks();

    expect(renderSpy).toHaveBeenCalledTimes(renderCalls);
    expect(patchSpy).toHaveBeenCalledOnce();
    renderSpy.mockRestore();
    patchSpy.mockRestore();
  });

  it('switching view type (Week -> Day -> Week) scrolls again each time, since it is a new pair', async () => {
    const weekSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const todaySpy = vi.spyOn(TodayView.prototype, 'render');
    const { el } = await makeCalendarPanel();

    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(weekSpy)).toBe(true);

    clickViewBtn(el, 'Day');
    expect(lastShouldScrollToNow(todaySpy)).toBe(true);

    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(weekSpy)).toBe(true);

    weekSpy.mockRestore();
    todaySpy.mockRestore();
  });

  it('navigating to a different date (next week) scrolls again, since it is a new pair', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);

    const nextBtn = el.querySelector('.abyss-cal-nav-btn[aria-label="Next"]') as HTMLElement;
    expect(nextBtn).not.toBeNull();
    nextBtn.click();

    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    renderSpy.mockRestore();
  });

  it("Round 2 Task 16's periodic now-line interval remains registered across a query patch", async () => {
    const { el, index, tasks } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');

    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const seededTask = index.list({ filePath: 't.md' })[0]!;
    await tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: seededTask.ref },
    });
    await flushMicrotasks();

    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe('CenterPanel calendar mode — preserve scroll position across reactive re-render (Task 31)', () => {
  async function makeCalendarPanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    index: TaskQueryApi;
    tasks: TaskApplicationApi;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, index, tasks, app } = await makePanel(
      { 't.md': `- [ ] task 📅 ${TODAY}` },
      DEFAULT_SETTINGS,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, index, tasks, el, app };
  }

  function clickViewBtn(el: HTMLElement, label: 'Day' | 'Week' | 'Month'): void {
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === label,
      ) as HTMLElement
    ).click();
  }

  it('patches only the task layer on a query notification while retaining the calendar skeleton, view instance, and scroll position', async () => {
    const { panel, el, index, tasks } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');
    await flushMicrotasks();

    const nav = el.querySelector('.abyss-cal-nav');
    const body = el.querySelector('.abyss-cal-body');
    const header = el.querySelector('.abyss-tg-header-row');
    const gridRowEl = el.querySelector('.abyss-tg-grid-row') as HTMLElement;
    const hourRow = el.querySelector('.abyss-tg-hour-row');
    const dayCell = el.querySelector(`[data-tg-date="${TODAY}"].abyss-tg-day-column`);
    const nowLine = el.querySelector('.abyss-tg-now-line');
    const taskNode = el.querySelector('.abyss-tg-plain');
    const viewInstance = (
      panel as unknown as {
        calViewInstance: TodayView | WeekTimeGridView | null;
      }
    ).calViewInstance;
    expect(gridRowEl).not.toBeNull();
    gridRowEl.scrollTop = 777;

    const seededTask = index.list({ filePath: 't.md' })[0]!;
    await tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: seededTask.ref },
    });
    await flushMicrotasks();

    expect(el.querySelector('.abyss-cal-nav')).toBe(nav);
    expect(el.querySelector('.abyss-cal-body')).toBe(body);
    expect(
      (
        panel as unknown as {
          calViewInstance: TodayView | WeekTimeGridView | null;
        }
      ).calViewInstance,
    ).toBe(viewInstance);
    expect(el.querySelector('.abyss-tg-header-row')).toBe(header);
    expect(el.querySelector('.abyss-tg-grid-row')).toBe(gridRowEl);
    expect(el.querySelector('.abyss-tg-hour-row')).toBe(hourRow);
    expect(el.querySelector(`[data-tg-date="${TODAY}"].abyss-tg-day-column`)).toBe(dayCell);
    expect(el.querySelector('.abyss-tg-now-line')).toBe(nowLine);
    expect(el.querySelector('.abyss-tg-plain')).not.toBe(taskNode);
    expect(gridRowEl.scrollTop).toBe(777);
  });

  it('a genuine navigation to a new view/date (Week -> Day) does not inherit the stale prior scroll position', async () => {
    const { el } = await makeCalendarPanel();
    clickViewBtn(el, 'Week');

    const gridRowEl = el.querySelector('.abyss-tg-grid-row') as HTMLElement;
    gridRowEl.scrollTop = 777;

    // Genuine navigation: switching view type is a new (viewType, date) pair, so
    // shouldScrollToNow is true here and must take priority over any stale prior scrollTop.
    clickViewBtn(el, 'Day');

    const newGridRowEl = el.querySelector('.abyss-tg-grid-row') as HTMLElement;
    expect(newGridRowEl).not.toBeNull();
    expect(newGridRowEl).not.toBe(gridRowEl);
    // Must NOT equal the stale Week-view scrollTop (777) it never asked to inherit.
    expect(newGridRowEl.scrollTop).not.toBe(777);
  });

  it('switching from Month (no grid-row) into Week does not error and scrolls to now as a fresh navigation', async () => {
    const { el } = await makeCalendarPanel();
    // Default calViewType is 'month' — no `.abyss-tg-grid-row` exists yet.
    expect(el.querySelector('.abyss-tg-grid-row')).toBeNull();

    clickViewBtn(el, 'Week');
    const gridRowEl = el.querySelector('.abyss-tg-grid-row') as HTMLElement;
    expect(gridRowEl).not.toBeNull();
  });
});

describe('CenterPanel calendar mode — click-to-create', () => {
  const clickToCreateSettings: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    addToToday: false,
    customFilePath: 'inbox.md',
    taskPrefix: '',
  };

  async function makeClickToCreatePanel(): Promise<{
    panel: CenterPanel;
    state: AppState;
    el: HTMLElement;
    app: App;
  }> {
    const { panel, state, app } = await makePanel({ 'inbox.md': '' }, clickToCreateSettings);
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    return { panel, state, el, app };
  }

  type CalendarCaptureKind = 'month' | 'timed' | 'all-day';

  function calendarCaptureSuccess(title = 'Captured'): TaskCommandResult {
    return {
      type: 'ok',
      changed: true,
      outcome: {
        type: 'task',
        task: task({ title, source: { filePath: 'Capture.md', line: 0 } }),
      },
    };
  }

  function sharedCalendarCaptureHarness(implementation: () => Promise<TaskCommandResult>): {
    readonly panel: CenterPanel;
    readonly el: HTMLElement;
    readonly planCreate: ReturnType<typeof vi.fn>;
    readonly sessionExecute: ReturnType<typeof vi.fn>;
    emitQueryChange(): void;
  } {
    const listeners = new Set<(event: TaskIndexEvent) => void>();
    const queries = taskQueryApi({
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sessionExecute = vi.fn(implementation);
    const planCreate = vi.fn(async () => ({
      type: 'ready' as const,
      destination: { filePath: 'Capture.md', insertion: { type: 'append' as const } },
      execute: sessionExecute,
    }));
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries,
      planCreate,
      execute: vi.fn(async () => ({
        type: 'invalid' as const,
        issues: [{ code: 'invalid-target' as const }],
      })),
    };
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      {} as App,
      { ...clickToCreateSettings },
      queries,
      new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      undefined,
      null,
      null,
      application,
      undefined,
      application,
    );
    const el = freshContainer();
    activeDocument.body.append(el);
    panel.mount(el);
    state.set('mode', 'calendar');
    return {
      panel,
      el,
      planCreate,
      sessionExecute,
      emitQueryChange: () => {
        for (const listener of [...listeners]) {
          listener({ type: 'changed', files: ['Capture.md'] });
        }
      },
    };
  }

  async function openCalendarCapture(
    el: HTMLElement,
    kind: CalendarCaptureKind,
  ): Promise<{
    readonly input: HTMLInputElement;
    readonly wrapper: HTMLElement;
    readonly date: string;
    readonly time?: string;
  }> {
    if (kind !== 'month') {
      (
        Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
          (button) => button.textContent === 'Day',
        ) as HTMLElement
      ).click();
    }

    let wrapperSelector: string;
    let date: string;
    let time: string | undefined;
    if (kind === 'month') {
      const cell = el.querySelector<HTMLElement>(
        '.abyss-mg-cell:not(.is-outside-month)[data-mg-date]',
      )!;
      date = cell.dataset['mgDate']!;
      cell.querySelector<HTMLElement>('.abyss-mg-add-btn')!.click();
      wrapperSelector = '.abyss-mg-quick-add';
    } else if (kind === 'all-day') {
      const cell = el.querySelector<HTMLElement>('.abyss-tg-allday-cell[data-tg-date]')!;
      date = cell.dataset['tgDate']!;
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      wrapperSelector = '.abyss-tg-allday-quick-add';
    } else {
      const day = el.querySelector<HTMLElement>('.abyss-tg-day-column[data-tg-date]')!;
      const hourColumn = day.querySelector<HTMLElement>('.abyss-tg-hour-column')!;
      date = day.dataset['tgDate']!;
      time = '10:00';
      vi.spyOn(hourColumn, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
      } as DOMRect);
      hourColumn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 480 }));
      wrapperSelector = '.abyss-tg-quick-add';
    }

    await flushMicrotasks();
    const wrapper = el.querySelector<HTMLElement>(wrapperSelector)!;
    const input = wrapper?.querySelector<HTMLInputElement>('.abyss-capture-input');
    if (!wrapper || !input) throw new Error(`${kind} shared capture did not open`);
    return { input, wrapper, date, ...(time !== undefined && { time }) };
  }

  it.each(['month', 'timed', 'all-day'] as const)(
    '%s capture freezes its date/time and keeps one session across consecutive Enter successes',
    async (kind) => {
      const { panel, el, planCreate, sessionExecute } = sharedCalendarCaptureHarness(async () =>
        calendarCaptureSuccess(),
      );
      try {
        const opened = await openCalendarCapture(el, kind);
        opened.input.focus();
        const frozenDate = opened.date;
        const positionedParent = opened.wrapper.parentElement;
        if (kind === 'timed') {
          expect(opened.wrapper.style.top).not.toBe('');
        }

        // Change the live DOM metadata after open: the capture request must retain the
        // placement that was selected when its controller/session was created.
        if (kind === 'month') positionedParent!.dataset['mgDate'] = '2099-12-31';
        else positionedParent!.dataset['tgDate'] = '2099-12-31';

        setCaptureDraft(opened.input, 'first calendar task');
        pressCaptureKey(opened.input, 'Enter');
        await flushMicrotasks();
        expect(opened.input.isConnected).toBe(true);
        expect(opened.input.value).toBe('');
        expect(activeDocument.activeElement).toBe(opened.input);

        setCaptureDraft(opened.input, 'second calendar task');
        pressCaptureKey(opened.input, 'Enter');
        await flushMicrotasks();

        expect(planCreate).toHaveBeenCalledOnce();
        expect(sessionExecute).toHaveBeenCalledTimes(2);
        expect(sessionExecute.mock.calls.map(([request]) => request.markdownBody)).toEqual([
          'first calendar task',
          'second calendar task',
        ]);
        for (const [request] of sessionExecute.mock.calls) {
          expect(request.initial?.due).toEqual({ type: 'set', value: frozenDate });
          if (kind === 'timed') {
            expect(request.initial?.time).toEqual({ type: 'set', value: '10:00' });
          } else {
            expect(request.initial?.time).toBeUndefined();
          }
        }
        expect(opened.wrapper.parentElement).toBe(positionedParent);
      } finally {
        panel.destroy();
        el.remove();
      }
    },
  );

  it.each(['month', 'timed', 'all-day'] as const)(
    '%s capture remounts pending/error state for query and full rerenders without updating the stale surface',
    async (kind) => {
      const result = deferred<TaskCommandResult>();
      const { panel, el, sessionExecute, emitQueryChange } = sharedCalendarCaptureHarness(
        () => result.promise,
      );
      try {
        const opened = await openCalendarCapture(el, kind);
        setCaptureDraft(opened.input, 'repair this calendar task');
        opened.input.focus();
        pressCaptureKey(opened.input, 'Enter');
        pressCaptureKey(opened.input, 'Escape');
        expect(opened.input.readOnly).toBe(true);

        emitQueryChange();
        const afterQuery = el.querySelector<HTMLInputElement>('.abyss-capture-input')!;
        expect(afterQuery).not.toBe(opened.input);
        expect(opened.input.isConnected).toBe(false);
        expect(afterQuery.value).toBe('repair this calendar task');
        expect(afterQuery.readOnly).toBe(true);

        result.resolve({
          type: 'io-error',
          cause: 'repository-error',
          contentState: 'unknown',
        });
        await flushMicrotasks();
        expect(sessionExecute).toHaveBeenCalledOnce();
        expect(el.querySelector('.abyss-capture-input')).toBe(afterQuery);
        expect(afterQuery.readOnly).toBe(false);
        expect(afterQuery.closest('.abyss-capture-surface')?.classList).toContain('has-error');

        panel.refresh();
        const afterFullRender = el.querySelector<HTMLInputElement>('.abyss-capture-input')!;
        expect(afterFullRender).not.toBe(afterQuery);
        expect(afterQuery.isConnected).toBe(false);
        expect(afterFullRender.value).toBe('repair this calendar task');
        expect(afterFullRender.closest('.abyss-capture-surface')?.classList).toContain('has-error');
      } finally {
        panel.destroy();
        el.remove();
      }
    },
  );

  it.each(['month', 'timed', 'all-day'] as const)(
    'destroying an idle %s capture does not synthesize a blur submission',
    async (kind) => {
      const { panel, el, sessionExecute } = sharedCalendarCaptureHarness(async () =>
        calendarCaptureSuccess(),
      );
      const opened = await openCalendarCapture(el, kind);
      setCaptureDraft(opened.input, 'must not submit during teardown');
      opened.input.focus();

      panel.destroy();
      await flushMicrotasks();

      expect(opened.input.isConnected).toBe(false);
      expect(sessionExecute).not.toHaveBeenCalled();
      el.remove();
    },
  );

  it('Month quick-add relies on the task-index patch and retains the mounted grid and header', async () => {
    const { panel, el, app } = await makeClickToCreatePanel();
    const cell = el.querySelector(
      '.abyss-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    const header = el.querySelector('.abyss-mg-head-row');
    const row = cell.closest('.abyss-mg-row');
    const viewInstance = (
      panel as unknown as {
        calViewInstance: TodayView | WeekTimeGridView | null;
      }
    ).calViewInstance;
    const date = cell.getAttribute('data-mg-date')!;
    const addBtn = cell.querySelector('.abyss-mg-add-btn') as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const input = el.querySelector('.abyss-mg-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    setCaptureDraft(input, 'water the plants');
    pressCaptureKey(input, 'Enter');
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] water the plants ➕ ${TODAY} 📅 ${date}`);
    expect(el.querySelector('.abyss-mg-head-row')).toBe(header);
    expect(el.querySelector(`[data-mg-date="${date}"]`)).toBe(cell);
    expect(cell.closest('.abyss-mg-row')).toBe(row);
    expect(
      (
        panel as unknown as {
          calViewInstance: TodayView | WeekTimeGridView | null;
        }
      ).calViewInstance,
    ).toBe(viewInstance);
    expect(cell.textContent).toContain('water the plants');
  });

  it('clicking the + button does not also drill into Week (onDayClick suppressed)', async () => {
    const { el } = await makeClickToCreatePanel();
    const cell = el.querySelector(
      '.abyss-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    const addBtn = cell.querySelector('.abyss-mg-add-btn') as HTMLElement;
    addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Still on Month (a drill-down would swap in the hour grid).
    expect(el.querySelector('.abyss-mg-grid')).not.toBeNull();
    expect(el.querySelector('.abyss-tg-day-column')).toBeNull();
  });

  it('clicking elsewhere in a Month day cell still drills into Day (Today) view, unaffected by the + button', async () => {
    const { el } = await makeClickToCreatePanel();
    const cell = el.querySelector(
      '.abyss-mg-cell:not(.is-outside-month)[data-mg-date]',
    ) as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelectorAll('.abyss-tg-day-column')).toHaveLength(1);
  });

  it('clicking empty hour-grid space in Today view opens an inline quick-add; Enter writes a timed task', async () => {
    const { el, app } = await makeClickToCreatePanel();
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const hourColumnEl = el.querySelector('.abyss-tg-hour-column') as HTMLElement;
    const date = (el.querySelector('.abyss-tg-day-column') as HTMLElement).getAttribute(
      'data-tg-date',
    )!;
    vi.spyOn(hourColumnEl, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
    } as DOMRect);
    hourColumnEl.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 480 })); // 480px = 10:00
    await flushMicrotasks();

    const input = el.querySelector('.abyss-tg-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toBe('Task at 10:00…');
    setCaptureDraft(input, 'stand-up');
    pressCaptureKey(input, 'Enter');
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] stand-up ⏰ 10:00 ➕ ${TODAY} 📅 ${date}`);
  });

  it('clicking on an existing timed block in the hour grid does not open the quick-add', async () => {
    const { panel, state } = await makePanel(
      { 't.md': `- [ ] timed ⏰ 09:00 📅 ${TODAY}` },
      clickToCreateSettings,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const block = el.querySelector('.abyss-tg-block') as HTMLElement;
    expect(block).toBeTruthy();
    block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelector('.abyss-tg-quick-add')).toBeNull();
  });

  it('clicking empty space in the all-day/"no-time" row in Today view opens an inline quick-add; Enter writes a plain (untimed) task', async () => {
    const { el, app } = await makeClickToCreatePanel();
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const alldayCell = el.querySelector('.abyss-tg-allday-cell') as HTMLElement;
    const date = (el.querySelector('.abyss-tg-day-column') as HTMLElement).getAttribute(
      'data-tg-date',
    )!;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const input = el.querySelector('.abyss-tg-allday-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    setCaptureDraft(input, 'renew passport');
    pressCaptureKey(input, 'Enter');
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] renew passport ➕ ${TODAY} 📅 ${date}`);
  });

  it('clicking empty space in the all-day row in Week view opens an inline quick-add; Enter writes a plain task on that day', async () => {
    const { el, app } = await makeClickToCreatePanel();
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Week',
      ) as HTMLElement
    ).click();

    const alldayCell = el.querySelector('.abyss-tg-allday-cell') as HTMLElement;
    const date = alldayCell.getAttribute('data-tg-date')!;
    alldayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const input = el.querySelector('.abyss-tg-allday-quick-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    setCaptureDraft(input, 'water plants');
    pressCaptureKey(input, 'Enter');
    await flushMicrotasks();

    const content = await readMd(app, 'inbox.md');
    expect(content).toContain(`- [ ] water plants ➕ ${TODAY} 📅 ${date}`);
  });

  it('clicking on an existing item in the all-day row does not open the quick-add (guarded, same as the hour grid)', async () => {
    const { panel, state } = await makePanel(
      { 't.md': `- [ ] plain task 📅 ${TODAY}` },
      clickToCreateSettings,
      [{ path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] }],
    );
    fixedToday(TODAY);
    const el = freshContainer();
    panel.mount(el);
    state.set('mode', 'calendar');
    (
      Array.from(el.querySelectorAll('.abyss-cal-view-btn')).find(
        (b) => b.textContent === 'Day',
      ) as HTMLElement
    ).click();

    const chip = el.querySelector('.abyss-tg-plain') as HTMLElement;
    expect(chip).toBeTruthy();
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelector('.abyss-tg-allday-quick-add')).toBeNull();
  });
});

function deferredResult(): {
  promise: Promise<TaskCommandResult>;
  resolve(result: TaskCommandResult): void;
} {
  let resolve!: (result: TaskCommandResult) => void;
  const promise = new Promise<TaskCommandResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function keyboardSnapshot(
  date: string,
  time = '09:00',
  filePath = 'Folder/[qa] "task".md',
  revision = 'revision-1',
  line = 0,
): TaskSnapshot {
  return task({
    ref: { filePath, line, revision },
    source: { filePath, line },
    title: filePath,
    planning: { due: date, time, duration: 60 },
  });
}

function okTask(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: true, outcome: { type: 'task', task: updated } };
}

function okTaskUnchanged(updated: TaskSnapshot): TaskCommandResult {
  return { type: 'ok', changed: false, outcome: { type: 'task', task: updated } };
}

function keyboardPanelHarness(
  initial: readonly TaskSnapshot[],
  execute: TaskApplicationApi['execute'],
  ownerDocument: Document = activeDocument,
): {
  panel: CenterPanel;
  state: AppState;
  el: HTMLElement;
  setSnapshots(next: readonly TaskSnapshot[]): void;
  emit(): void;
  listenerCount(): number;
} {
  let snapshots = initial;
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  const queries = queryApiForSnapshots(() => snapshots);
  queries.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const tasks: TaskApplicationApi = { queries, execute };
  const state = new AppState();
  const panel = new CenterPanel(
    state,
    {} as App,
    DEFAULT_SETTINGS,
    queries,
    new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    undefined,
    null,
    null,
    tasks,
  );
  const el = ownerDocument.createElement('div');
  ownerDocument.body.append(el);
  panel.mount(el);
  state.set('mode', 'calendar');
  return {
    panel,
    state,
    el,
    setSnapshots: (next) => {
      snapshots = next;
    },
    emit: () => {
      for (const listener of [...listeners]) {
        listener({ type: 'changed', files: snapshots.map((item) => item.source.filePath) });
      }
    },
    listenerCount: () => listeners.size,
  };
}

function clickCalendarView(el: HTMLElement, label: 'Day' | 'Week' | 'Month'): void {
  const button = Array.from(el.querySelectorAll<HTMLElement>('.abyss-cal-view-btn')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`missing ${label} calendar view button`);
  button.click();
}

function timedBlock(el: HTMLElement, filePath?: string): HTMLElement {
  const blocks = Array.from(el.querySelectorAll<HTMLElement>('.abyss-tg-block'));
  const found = filePath
    ? blocks.find((block) => block.dataset['abyssTaskFile'] === filePath)
    : blocks[0];
  if (!found) throw new Error(`missing timed block${filePath ? ` for ${filePath}` : ''}`);
  return found;
}

function press(block: HTMLElement, key: string, shiftKey = false): void {
  block.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
}

describe('CenterPanel calendar mode — task-index patch coordinator', () => {
  it('keeps one subscription and performs one patch for each notification after repeated updates', () => {
    const original = keyboardSnapshot(TODAY);
    const h = keyboardPanelHarness([original], vi.fn());
    const patch = vi.spyOn(TodayView.prototype, 'patch');
    try {
      clickCalendarView(h.el, 'Day');
      expect(h.listenerCount()).toBe(1);

      for (let revision = 2; revision <= 4; revision++) {
        h.setSnapshots([
          keyboardSnapshot(
            TODAY,
            `09:${revision * 5}`,
            original.source.filePath,
            `revision-${revision}`,
          ),
        ]);
        const callsBefore = patch.mock.calls.length;
        h.emit();
        expect(patch).toHaveBeenCalledTimes(callsBefore + 1);
        expect(h.listenerCount()).toBe(1);
      }

      clickCalendarView(h.el, 'Week');
      clickCalendarView(h.el, 'Day');
      expect(h.listenerCount()).toBe(1);
      const callsBeforeFinalNotification = patch.mock.calls.length;
      h.emit();
      expect(patch).toHaveBeenCalledTimes(callsBeforeFinalNotification + 1);
      expect(h.listenerCount()).toBe(1);
    } finally {
      patch.mockRestore();
      h.panel.destroy();
      h.el.remove();
    }
  });

  it('closes an anchored recurrence editor before a query patch replaces its task anchor', () => {
    const original = task({
      title: 'Before patch',
      recurrence: 'every week',
      planning: { due: TODAY },
    });
    const h = keyboardPanelHarness([original], vi.fn());
    try {
      const marker = h.el.querySelector<HTMLElement>(
        '.abyss-mg-plain .abyss-status-marker, .abyss-mg-deadline-marker .abyss-status-marker',
      )!;
      (
        h.panel as unknown as {
          openRecurrenceEditor(anchor: HTMLElement, task: TaskSnapshot): void;
        }
      ).openRecurrenceEditor(marker, original);
      expect(activeDocument.querySelector('.abyss-recurrence-popover')).not.toBeNull();

      h.setSnapshots([
        task({ title: 'After patch', recurrence: 'every week', planning: { due: TODAY } }),
      ]);
      h.emit();

      expect(marker.isConnected).toBe(false);
      expect(activeDocument.querySelector('.abyss-recurrence-popover')).toBeNull();
    } finally {
      h.panel.destroy();
      h.el.remove();
    }
  });

  it('closes an anchored recurrence editor before a calendar mount replaces its task anchor', () => {
    const recurring = task({ recurrence: 'every week', planning: { due: TODAY } });
    const h = keyboardPanelHarness([recurring], vi.fn());
    try {
      const marker = h.el.querySelector<HTMLElement>(
        '.abyss-mg-plain .abyss-status-marker, .abyss-mg-deadline-marker .abyss-status-marker',
      )!;
      (
        h.panel as unknown as {
          openRecurrenceEditor(anchor: HTMLElement, task: TaskSnapshot): void;
        }
      ).openRecurrenceEditor(marker, recurring);
      expect(activeDocument.querySelector('.abyss-recurrence-popover')).not.toBeNull();

      h.el.querySelector<HTMLButtonElement>('[aria-label="Next"]')?.click();

      expect(marker.isConnected).toBe(false);
      expect(activeDocument.querySelector('.abyss-recurrence-popover')).toBeNull();
    } finally {
      h.panel.destroy();
      h.el.remove();
    }
  });
});

describe('CenterPanel calendar mode — timed pointer command bridge', () => {
  it('does not execute a command for stationary visible-body clicks on short terminal or ghost segments', async () => {
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const weekStart = moment().startOf('isoWeek');
    const start = weekStart.format('YYYY-MM-DD');
    const due = weekStart.clone().add(2, 'days').format('YYYY-MM-DD');
    const t = task({
      ref: { filePath: 'short-span.md', line: 4, revision: 'revision-1' },
      source: { filePath: 'short-span.md', line: 4 },
      planning: { start, due, time: '09:00', duration: 5 },
    });
    const h = keyboardPanelHarness([t], execute);
    clickCalendarView(h.el, 'Week');

    const days = Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column'));
    for (const [index, day] of days.entries()) {
      day.getBoundingClientRect = () =>
        ({
          left: index * 100,
          right: (index + 1) * 100,
          top: 100,
          bottom: 100 + 24 * 48,
          width: 100,
          height: 24 * 48,
        }) as DOMRect;
      const hour = day.querySelector<HTMLElement>('.abyss-tg-hour-column');
      if (!hour) throw new Error('missing hour column');
      hour.getBoundingClientRect = day.getBoundingClientRect;
    }
    const allDayCells = Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-allday-cell'));
    for (const [index, cell] of allDayCells.entries()) {
      cell.getBoundingClientRect = () =>
        ({
          left: index * 100,
          right: (index + 1) * 100,
          top: 10,
          bottom: 40,
          width: 100,
          height: 30,
        }) as DOMRect;
    }

    const segments = [start, due].map((date) => {
      const block = h.el.querySelector<HTMLElement>(
        `.abyss-tg-block[data-tg-segment-date="${date}"]`,
      );
      if (!block) throw new Error(`missing timed segment ${date}`);
      const index = days.findIndex((day) => day.dataset['tgDate'] === date);
      block.getBoundingClientRect = () =>
        ({
          left: index * 100,
          right: (index + 1) * 100,
          top: 9 * 48 + 100,
          bottom: 9 * 48 + 100 + MIN_BLOCK_HEIGHT_PX,
          width: 100,
          height: MIN_BLOCK_HEIGHT_PX,
        }) as DOMRect;
      return { block, clientX: index * 100 + 25 };
    });

    for (const [index, { block, clientX }] of segments.entries()) {
      const pointerId = 40 + index;
      const clientY = 9 * 48 + 100 + 14;
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX, clientY, pointerId }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { clientX, clientY, pointerId }));
      expect(h.el.querySelector('.abyss-tg-drag-preview')).toBeNull();
    }
    await flushMicrotasks();
    expect(execute).not.toHaveBeenCalled();
    h.panel.destroy();
    h.el.remove();
  });

  it('routes exact move, all-day, duration, and actual boundary targets through TaskApplicationApi', async () => {
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: task() },
    });
    const t = task({
      ref: { filePath: 'span.md', line: 4, revision: 'revision-1' },
      source: { filePath: 'span.md', line: 4 },
      planning: {
        start: '2026-07-06',
        due: '2026-07-08',
        time: '09:00',
        duration: 60,
      },
    });
    const h = keyboardPanelHarness([t], execute);

    await call<void>(h.panel, 'commitTimedMove', t, {
      date: '2026-07-07',
      startMinutes: 600,
      dayDelta: 1,
      destination: 'time-grid',
    });
    await call<void>(h.panel, 'commitTimedMove', t, {
      date: '2026-07-07',
      startMinutes: 540,
      dayDelta: 1,
      destination: 'all-day',
    });
    await call<void>(h.panel, 'commitTimedDuration', t, {
      edge: 'end',
      startMinutes: 540,
      durationMinutes: 120,
      endMinutes: 660,
    });
    await call<void>(h.panel, 'commitTimedBoundary', t, {
      boundary: 'start',
      date: '2026-07-05',
      dayDelta: -1,
    });

    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'move-time-slot',
      ref: t.ref,
      days: 1,
      time: '10:00',
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'move-to-all-day',
      ref: t.ref,
      days: 1,
    });
    expect(execute).toHaveBeenNthCalledWith(3, {
      type: 'patch',
      target: { type: 'task', ref: t.ref },
      patch: {
        time: { type: 'set', value: '09:00' },
        duration: { type: 'set', value: 120 },
      },
    });
    expect(execute).toHaveBeenNthCalledWith(4, {
      type: 'set-span-boundary',
      ref: t.ref,
      boundary: 'start',
      date: '2026-07-05',
    });
  });

  it('keeps create-span as the explicit single-date exception', async () => {
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: task() },
    });
    const t = task({
      ref: { filePath: 'single.md', line: 2, revision: 'revision-1' },
      source: { filePath: 'single.md', line: 2 },
      planning: { due: '2026-07-08', time: '09:00', duration: 60 },
    });
    const h = keyboardPanelHarness([t], execute);

    await call<void>(h.panel, 'commitTimedBoundary', t, {
      boundary: 'create-span',
      date: '2026-07-10',
      dayDelta: 2,
    });

    expect(execute).toHaveBeenCalledWith({
      type: 'extend-span',
      ref: t.ref,
      due: '2026-07-10',
    });
  });
});

describe('CenterPanel calendar mode — serialized keyboard focus and follow', () => {
  it('restores a queued keyboard interaction to the same pre-due ghost segment', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const weekStart = moment().startOf('isoWeek');
    const start = weekStart.format('YYYY-MM-DD');
    const grabbedDate = weekStart.clone().add(1, 'day').format('YYYY-MM-DD');
    const due = weekStart.clone().add(2, 'day').format('YYYY-MM-DD');
    const original = task({
      ref: { filePath: 'span.md', line: 4, revision: 'revision-1' },
      source: { filePath: 'span.md', line: 4 },
      planning: { start, due, time: '09:00', duration: 60 },
    });
    const updated = task({
      ...original,
      ref: { filePath: 'span.md', line: 4, revision: 'revision-2' },
      planning: { start, due, time: '09:15', duration: 60 },
    });
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Week');

    const gridRow = h.el.querySelector('.abyss-tg-grid-row');
    const outgoing = h.el.querySelector<HTMLElement>(
      `.abyss-tg-block-continuation[data-tg-segment-date="${grabbedDate}"]`,
    );
    if (!outgoing) throw new Error('missing pre-due ghost');
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    pending.resolve(okTask(updated));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(outgoing);
    h.setSnapshots([updated]);
    h.emit();
    await flushMicrotasks();

    const replacement = h.el.querySelector<HTMLElement>(
      `.abyss-tg-block-continuation[data-tg-segment-date="${grabbedDate}"]`,
    );
    expect(h.el.querySelector('.abyss-tg-grid-row')).toBe(gridRow);
    expect(replacement).not.toBe(outgoing);
    expect(activeDocument.activeElement).toBe(replacement);
  });

  it.each([
    {
      direction: 'left',
      ordering: 'event-before-result',
      key: 'ArrowLeft',
      originalStart: '2026-07-06',
      originalDue: '2026-07-08',
      updatedStart: '2026-07-05',
      updatedDue: '2026-07-07',
      focusedDate: '2026-07-06',
      nextSegmentDate: '2026-07-05',
      expectedWeekStart: '2026-06-29',
    },
    {
      direction: 'left',
      ordering: 'result-before-event',
      key: 'ArrowLeft',
      originalStart: '2026-07-06',
      originalDue: '2026-07-08',
      updatedStart: '2026-07-05',
      updatedDue: '2026-07-07',
      focusedDate: '2026-07-06',
      nextSegmentDate: '2026-07-05',
      expectedWeekStart: '2026-06-29',
    },
    {
      direction: 'right',
      ordering: 'event-before-result',
      key: 'ArrowRight',
      originalStart: '2026-07-10',
      originalDue: '2026-07-22',
      updatedStart: '2026-07-11',
      updatedDue: '2026-07-23',
      focusedDate: '2026-07-12',
      nextSegmentDate: '2026-07-13',
      expectedWeekStart: '2026-07-13',
    },
    {
      direction: 'right',
      ordering: 'result-before-event',
      key: 'ArrowRight',
      originalStart: '2026-07-10',
      originalDue: '2026-07-22',
      updatedStart: '2026-07-11',
      updatedDue: '2026-07-23',
      focusedDate: '2026-07-12',
      nextSegmentDate: '2026-07-13',
      expectedWeekStart: '2026-07-13',
    },
  ] as const)(
    'follows the exact timed ghost across the Week $direction boundary with $ordering ordering',
    async ({
      ordering,
      key,
      originalStart,
      originalDue,
      updatedStart,
      updatedDue,
      focusedDate,
      nextSegmentDate,
      expectedWeekStart,
    }) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const original = task({
        ref: { filePath: 'boundary-span.md', line: 4, revision: 'revision-1' },
        source: { filePath: 'boundary-span.md', line: 4 },
        planning: {
          start: originalStart,
          due: originalDue,
          time: '09:00',
          duration: 60,
        },
      });
      const updated = task({
        ...original,
        ref: { ...original.ref, revision: 'revision-2' },
        planning: {
          start: updatedStart,
          due: updatedDue,
          time: '09:00',
          duration: 60,
        },
      });
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Week');
      const calendar = h.panel as unknown as {
        calDate: ReturnType<typeof moment>;
        render(): void;
      };
      calendar.calDate = moment('2026-07-06', 'YYYY-MM-DD');
      calendar.render();

      const outgoing = h.el.querySelector<HTMLElement>(
        `.abyss-tg-block-continuation[data-tg-segment-date="${focusedDate}"]`,
      );
      if (!outgoing) throw new Error(`missing outgoing timed ghost ${focusedDate}`);
      outgoing.focus();
      press(outgoing, key);

      let preEventCandidate: HTMLElement | null = null;
      if (ordering === 'event-before-result') {
        h.setSnapshots([updated]);
        h.emit();
        pending.resolve(okTask(updated));
      } else {
        pending.resolve(okTask(updated));
        await flushMicrotasks();
        preEventCandidate = h.el.querySelector<HTMLElement>(
          `.abyss-tg-block[data-tg-segment-date="${nextSegmentDate}"]`,
        );
        h.setSnapshots([updated]);
        h.emit();
      }
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledWith({
        type: 'shift-schedule',
        ref: original.ref,
        days: key === 'ArrowLeft' ? -1 : 1,
      });
      const visibleDates = Array.from(
        h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column'),
      ).map((column) => column.dataset['tgDate']);
      expect(visibleDates[0]).toBe(expectedWeekStart);
      expect(visibleDates).toContain(nextSegmentDate);
      expect(
        Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-block')).map(
          (block) => block.dataset['tgSegmentDate'],
        ),
      ).toContain(nextSegmentDate);
      const replacement = h.el.querySelector<HTMLElement>(
        `.abyss-tg-block-continuation[data-tg-segment-date="${nextSegmentDate}"]`,
      );
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe(outgoing);
      if (preEventCandidate) expect(replacement).not.toBe(preEventCandidate);
      await vi.waitFor(() => {
        expect(h.el.ownerDocument.activeElement).toBe(replacement);
      });

      h.panel.destroy();
      h.el.remove();
    },
  );

  it('uses the mounted popout document for command origin and restoration through remount', async () => {
    const iframe = activeDocument.createElement('iframe');
    activeDocument.body.append(iframe);
    const foreignDocument = iframe.contentDocument;
    const foreignWindow = iframe.contentWindow;
    if (!foreignDocument || !foreignWindow) throw new Error('missing iframe realm');
    const foreignRealm = foreignWindow as unknown as typeof globalThis;
    // Obsidian extends the host HTMLElement prototype with createDiv/empty/etc. Mirror that
    // prototype chain in jsdom so this is a real foreign-document CenterPanel, not a synthetic
    // event aimed at a main-window panel.
    const prototypePairs: Array<[object, object]> = [
      [HTMLElement.prototype, foreignRealm.HTMLElement.prototype],
      [Element.prototype, foreignRealm.Element.prototype],
      [Node.prototype, foreignRealm.Node.prototype],
    ];
    for (const [source, target] of prototypePairs) {
      for (const name of Object.getOwnPropertyNames(source)) {
        if (name === 'constructor' || name in target) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, name);
        if (descriptor) Object.defineProperty(target, name, descriptor);
      }
    }
    const foreignElementPrototype = foreignRealm.HTMLElement.prototype as unknown as Record<
      string,
      unknown
    >;
    const createEl = function (
      this: HTMLElement,
      tag: string,
      options: { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
    ): HTMLElement {
      const child = this.ownerDocument.createElement(tag);
      const classes = Array.isArray(options.cls) ? options.cls : options.cls?.split(' ');
      if (classes) child.classList.add(...classes.filter(Boolean));
      if (options.text !== undefined) child.textContent = options.text;
      for (const [name, value] of Object.entries(options.attr ?? {}))
        child.setAttribute(name, value);
      this.append(child);
      return child;
    };
    Object.defineProperties(foreignElementPrototype, {
      createEl: { configurable: true, value: createEl },
      createDiv: {
        configurable: true,
        value: function (
          this: HTMLElement,
          value:
            | string
            | { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
        ) {
          return createEl.call(this, 'div', typeof value === 'string' ? { cls: value } : value);
        },
      },
      createSpan: {
        configurable: true,
        value: function (
          this: HTMLElement,
          value:
            | string
            | { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
        ) {
          return createEl.call(this, 'span', typeof value === 'string' ? { cls: value } : value);
        },
      },
    });

    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(TODAY, '09:15', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute, foreignDocument);
    try {
      clickCalendarView(h.el, 'Day');
      const block = timedBlock(h.el);
      expect(block instanceof HTMLElement).toBe(false);
      expect(block instanceof foreignRealm.HTMLElement).toBe(true);
      block.focus();
      expect(foreignDocument.activeElement).toBe(block);
      press(block, 'ArrowDown');
      expect(execute).toHaveBeenCalledOnce();
      const pendingFocus = (
        h.panel as unknown as {
          pendingTimedBlockFocus?: { readonly originElement?: HTMLElement };
        }
      ).pendingTimedBlockFocus;
      expect(pendingFocus?.originElement).toBe(block);

      h.setSnapshots([updated]);
      h.emit();
      pending.resolve(okTask(updated));
      await flushMicrotasks();

      const remounted = timedBlock(h.el);
      expect(remounted).not.toBe(block);
      expect(foreignDocument.activeElement).toBe(remounted);
    } finally {
      h.panel.destroy();
      iframe.remove();
    }
  });

  it('cancels pending keyboard ownership when the mounted window blurs', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');

    h.el.ownerDocument.defaultView!.dispatchEvent(new Event('blur'));
    h.setSnapshots([updated]);
    h.emit();
    pending.resolve(okTask(updated));
    await flushMicrotasks();

    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(h.el.ownerDocument.activeElement).not.toBe(block);
    expect(h.el.ownerDocument.activeElement?.classList.contains('abyss-tg-block')).not.toBe(true);
  });

  it('retains a special-path locator across two remounts and focuses only the newest connected block', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(TODAY, '09:15', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    expect(execute).toHaveBeenCalledOnce();

    h.setSnapshots([]);
    h.emit();
    expect(outgoing.isConnected).toBe(false);
    h.setSnapshots([updated]);
    h.emit();
    pending.resolve(okTask(updated));
    await flushMicrotasks();

    const connected = timedBlock(h.el);
    expect(connected).not.toBe(outgoing);
    expect(connected.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(connected);
    expect(connected.classList.contains('is-selected')).toBe(true);
  });

  it('keeps vertical moves and duration changes on the same Day date', async () => {
    let current = keyboardSnapshot(TODAY);
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      const revision = `revision-${execute.mock.calls.length + 1}`;
      const isTaskPatch = command.type === 'patch' && command.target.type === 'task';
      const nextTime =
        isTaskPatch && command.patch.time?.type === 'set'
          ? command.patch.time.value
          : current.planning.time;
      const nextDuration =
        isTaskPatch && 'duration' in command.patch && command.patch.duration?.type === 'set'
          ? command.patch.duration.value
          : current.planning.duration;
      current = task({
        ...current,
        ref: { ...current.ref, revision },
        planning: { ...current.planning, time: nextTime, duration: nextDuration },
      });
      h.setSnapshots([current]);
      h.emit();
      return okTask(current);
    });
    h = keyboardPanelHarness([current], execute);
    clickCalendarView(h.el, 'Day');
    const dateBefore = h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date');

    let block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowDown');
    await flushMicrotasks();
    block = timedBlock(h.el);
    press(block, 'ArrowDown', true);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(
      dateBefore,
    );
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('follows a successful horizontal move in Day view and restores focus there', async () => {
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      h.setSnapshots([updated]);
      h.emit();
      return okTask(updated);
    });
    h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();

    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(tomorrow);
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('retains sequence ownership through an intermediate remount and follows two rapid Day moves', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const dayOne = keyboardSnapshot(TODAY);
    const dayTwoDate = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const dayThreeDate = moment(TODAY).add(2, 'days').format('YYYY-MM-DD');
    const dayTwo = keyboardSnapshot(dayTwoDate, '09:00', dayOne.source.filePath, 'revision-2');
    const dayThree = keyboardSnapshot(dayThreeDate, '09:00', dayOne.source.filePath, 'revision-3');
    const h = keyboardPanelHarness([dayOne], execute);
    clickCalendarView(h.el, 'Day');
    const patch = vi.spyOn(TodayView.prototype, 'patch');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    press(block, 'ArrowRight');
    expect(execute).toHaveBeenCalledOnce();

    h.setSnapshots([dayTwo]);
    h.emit();
    first.resolve(okTask(dayTwo));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await flushMicrotasks();
    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(
      dayTwoDate,
    );

    h.setSnapshots([dayThree]);
    h.emit();
    second.resolve(okTask(dayThree));
    await flushMicrotasks();

    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(
      dayThreeDate,
    );
    expect(patch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(activeDocument.activeElement).toBe(timedBlock(h.el)));
    patch.mockRestore();
  });

  it('keeps Week anchored for an in-range move and follows only after crossing its visible edge', async () => {
    const weekStart = moment().startOf('isoWeek');
    const inside = weekStart.clone().add(2, 'days').format('YYYY-MM-DD');
    const nextInside = weekStart.clone().add(3, 'days').format('YYYY-MM-DD');
    const edge = weekStart.clone().add(6, 'days').format('YYYY-MM-DD');
    const outside = weekStart.clone().add(7, 'days').format('YYYY-MM-DD');
    let current = keyboardSnapshot(inside);
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      const nextDate = current.planning.due === inside ? nextInside : outside;
      current = keyboardSnapshot(
        nextDate,
        '09:00',
        current.source.filePath,
        `revision-${execute.mock.calls.length + 1}`,
      );
      h.setSnapshots([current]);
      h.emit();
      return okTask(current);
    });
    h = keyboardPanelHarness([current], execute);
    clickCalendarView(h.el, 'Week');
    const originalDates = Array.from(
      h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column'),
    ).map((column) => column.dataset['tgDate']);

    let block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();
    expect(
      Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column')).map(
        (column) => column.dataset['tgDate'],
      ),
    ).toEqual(originalDates);

    current = keyboardSnapshot(edge, '09:00', current.source.filePath, 'revision-edge');
    h.setSnapshots([current]);
    h.emit();
    await flushMicrotasks();
    block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();
    const followedDates = Array.from(
      h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column'),
    ).map((column) => column.dataset['tgDate']);
    expect(followedDates).toContain(outside);
    expect(followedDates).not.toEqual(originalDates);
  });

  it('follows ArrowRight across the exact Dec/Jan week boundary and restores focus', async () => {
    const original = keyboardSnapshot('2026-01-04');
    const updated = keyboardSnapshot('2026-01-05', '09:00', original.source.filePath, 'revision-2');
    let h!: ReturnType<typeof keyboardPanelHarness>;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      h.setSnapshots([updated]);
      h.emit();
      return okTask(updated);
    });
    h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Week');
    const calendar = h.panel as unknown as {
      calDate: ReturnType<typeof moment>;
      render(): void;
    };
    calendar.calDate = moment('2025-12-29', 'YYYY-MM-DD');
    calendar.render();

    expect(
      Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column')).map(
        (column) => column.dataset['tgDate'],
      ),
    ).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    await flushMicrotasks();

    const followedDates = Array.from(
      h.el.querySelectorAll<HTMLElement>('.abyss-tg-day-column'),
    ).map((column) => column.dataset['tgDate']);
    expect(followedDates).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
      '2026-01-11',
    ]);
    await vi.waitFor(() => {
      expect(h.el.ownerDocument.activeElement).toBe(timedBlock(h.el));
    });
  });

  it('does not let task A late completion navigate or focus after task B owns the queue', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const taskA = keyboardSnapshot(TODAY, '09:00', 'a.md');
    const taskB = keyboardSnapshot(TODAY, '10:00', 'b.md');
    const h = keyboardPanelHarness([taskA, taskB], execute);
    clickCalendarView(h.el, 'Day');

    const blockA = timedBlock(h.el, 'a.md');
    blockA.focus();
    press(blockA, 'ArrowRight');
    const blockB = timedBlock(h.el, 'b.md');
    blockB.focus();
    press(blockB, 'ArrowDown');
    first.resolve(
      okTask(
        keyboardSnapshot(moment(TODAY).add(1, 'day').format('YYYY-MM-DD'), '09:00', 'a.md', 'a-2'),
      ),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);

    const updatedB = keyboardSnapshot(TODAY, '10:15', 'b.md', 'b-2');
    h.setSnapshots([taskA, updatedB]);
    h.emit();
    second.resolve(okTask(updatedB));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(timedBlock(h.el, 'b.md'));
  });

  it('invalidates task A focus ownership as soon as a newer task B receives focus', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const taskA = keyboardSnapshot(TODAY, '09:00', 'a.md');
    const taskB = keyboardSnapshot(TODAY, '10:00', 'b.md');
    const h = keyboardPanelHarness([taskA, taskB], execute);
    clickCalendarView(h.el, 'Day');

    const blockA = timedBlock(h.el, 'a.md');
    blockA.focus();
    press(blockA, 'ArrowRight');
    const blockB = timedBlock(h.el, 'b.md');
    blockB.focus();
    pending.resolve(
      okTask(
        keyboardSnapshot(moment(TODAY).add(1, 'day').format('YYYY-MM-DD'), '09:00', 'a.md', 'a-2'),
      ),
    );
    await flushMicrotasks();

    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(activeDocument.activeElement).toBe(blockB);
  });

  it('defers remount focus until the command commits and does not steal it after settlement', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const updated = keyboardSnapshot(TODAY, '09:15', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const gridRow = h.el.querySelector('.abyss-tg-grid-row');
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowDown');
    h.setSnapshots([updated]);
    h.emit();
    await flushMicrotasks();
    const remounted = timedBlock(h.el);
    expect(h.el.querySelector('.abyss-tg-grid-row')).toBe(gridRow);
    expect(activeDocument.activeElement).not.toBe(remounted);

    pending.resolve(okTask(updated));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(remounted);

    const other = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
    other.focus();
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(other);
  });

  it('abandons an in-flight sequence when focus moves to a non-task calendar control', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    const toolbarControl = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
    toolbarControl.focus();
    h.setSnapshots([updated]);
    h.emit();
    expect(toolbarControl.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(toolbarControl);

    pending.resolve(okTask(updated));
    await flushMicrotasks();

    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(activeDocument.activeElement).toBe(toolbarControl);
  });

  it('abandons an in-flight sequence when focus moves to a connected control outside the center pane', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    const externalControl = activeDocument.createElement('button');
    activeDocument.body.append(externalControl);
    try {
      externalControl.focus();
      h.setSnapshots([updated]);
      h.emit();
      pending.resolve(okTask(updated));
      await flushMicrotasks();

      expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
      expect(activeDocument.activeElement).toBe(externalControl);
    } finally {
      externalControl.remove();
      h.panel.destroy();
      h.el.remove();
    }
  });

  it('abandons an in-flight sequence for a focused control from another window realm', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY);
    const tomorrow = moment(TODAY).add(1, 'day').format('YYYY-MM-DD');
    const updated = keyboardSnapshot(tomorrow, '09:00', original.source.filePath, 'revision-2');
    const addSpy = vi.spyOn(activeDocument, 'addEventListener');
    const h = keyboardPanelHarness([original], execute);
    const registration = addSpy.mock.calls.find(([type]) => type === 'focusin');
    addSpy.mockRestore();
    if (!registration) throw new Error('missing CenterPanel focusin registration');
    clickCalendarView(h.el, 'Day');

    const iframe = activeDocument.createElement('iframe');
    activeDocument.body.append(iframe);
    const foreignDocument = iframe.contentDocument;
    const foreignWindow = iframe.contentWindow;
    if (!foreignDocument || !foreignWindow) throw new Error('missing iframe realm');
    const externalControl = foreignDocument.createElement('button');
    foreignDocument.body.append(externalControl);
    expect(externalControl instanceof HTMLElement).toBe(false);

    try {
      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowRight');
      externalControl.focus();
      const ForeignFocusEvent = (foreignWindow as unknown as { FocusEvent: typeof FocusEvent })
        .FocusEvent;
      const foreignFocus = new ForeignFocusEvent('focusin', { bubbles: true });
      externalControl.dispatchEvent(foreignFocus);
      // A real Obsidian popout owns its own document listener. Calling the captured listener
      // with the iframe event models that dispatch while retaining a genuinely foreign-realm
      // event target (the regression is specifically the global HTMLElement instanceof check).
      const listener = registration[1] as EventListener;
      listener(foreignFocus);

      h.setSnapshots([updated]);
      h.emit();
      pending.resolve(okTask(updated));
      await flushMicrotasks();

      expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
      expect(foreignDocument.activeElement).toBe(externalControl);
      expect(activeDocument.activeElement?.classList.contains('abyss-tg-block')).not.toBe(true);
    } finally {
      iframe.remove();
      h.panel.destroy();
      h.el.remove();
    }
  });

  it('removes its document focus ownership listener on destroy', () => {
    const addSpy = vi.spyOn(activeDocument, 'addEventListener');
    const removeSpy = vi.spyOn(activeDocument, 'removeEventListener');
    const addWindowSpy = vi.spyOn(window, 'addEventListener');
    const removeWindowSpy = vi.spyOn(window, 'removeEventListener');
    try {
      const h = keyboardPanelHarness([keyboardSnapshot(TODAY)], vi.fn());
      const registration = addSpy.mock.calls.find(([type]) => type === 'focusin');
      const blurRegistration = addWindowSpy.mock.calls.find(([type]) => type === 'blur');
      expect(registration).toBeDefined();
      expect(blurRegistration).toBeDefined();

      h.panel.destroy();

      expect(
        removeSpy.mock.calls.some(
          ([type, listener, options]) =>
            type === 'focusin' && listener === registration?.[1] && options === registration?.[2],
        ),
      ).toBe(true);
      expect(
        removeWindowSpy.mock.calls.some(
          ([type, listener, options]) =>
            type === 'blur' &&
            listener === blurRegistration?.[1] &&
            options === blurRegistration?.[2],
        ),
      ).toBe(true);
      h.el.remove();
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      addWindowSpy.mockRestore();
      removeWindowSpy.mockRestore();
    }
  });

  it('clears focus ownership when a clamped command executes without changing the task', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY, '00:00');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowUp');
    pending.resolve(okTaskUnchanged(original));
    await flushMicrotasks();

    const nav = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
    nav.focus();
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(nav);

    const current = timedBlock(h.el);
    current.focus();
    h.emit();
    await flushMicrotasks();

    const remounted = timedBlock(h.el);
    expect(remounted).not.toBe(current);
    expect(activeDocument.activeElement).toBe(remounted);
  });

  it.each([
    ['0000-01-01', 'ArrowLeft'],
    ['9999-12-31', 'ArrowRight'],
  ] as const)(
    'does not retain focus ownership for an unexecutable %s boundary extension',
    async (date, key) => {
      const execute = vi.fn<TaskApplicationApi['execute']>();
      const snapshot = keyboardSnapshot(date);
      const h = keyboardPanelHarness([snapshot], execute);
      const calendar = h.panel as unknown as {
        calViewType: 'today';
        calDate: ReturnType<typeof moment>;
      };
      calendar.calViewType = 'today';
      calendar.calDate = moment(date, 'YYYY-MM-DD');
      h.panel.refresh();

      const block = timedBlock(h.el);
      block.focus();
      press(block, key, true);
      expect(execute).not.toHaveBeenCalled();
      const other = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
      other.focus();
      h.emit();
      await flushMicrotasks();

      expect(activeDocument.activeElement).toBe(other);
    },
  );

  it.each([
    ['0000-01-01', 'ArrowLeft'],
    ['9999-12-31', 'ArrowRight'],
  ] as const)(
    'clears focus ownership when an in-flight command is followed by an unexecutable %s boundary intent',
    async (date, key) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const snapshot = keyboardSnapshot(date);
      const h = keyboardPanelHarness([snapshot], execute);
      const calendar = h.panel as unknown as {
        calViewType: 'today';
        calDate: ReturnType<typeof moment>;
      };
      calendar.calViewType = 'today';
      calendar.calDate = moment(date, 'YYYY-MM-DD');
      h.panel.refresh();

      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowDown');
      press(block, key, true);
      expect(execute).toHaveBeenCalledOnce();
      pending.resolve(okTaskUnchanged(snapshot));
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledOnce();

      const nav = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
      nav.focus();
      h.emit();
      await flushMicrotasks();

      expect(activeDocument.activeElement).toBe(nav);
    },
  );

  it('retains focus ownership when an earlier command changed and the final command is a no-op', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const original = keyboardSnapshot(TODAY, '00:15');
    const changed = keyboardSnapshot(TODAY, '00:00', original.source.filePath, 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowUp');
    press(block, 'ArrowUp');
    first.resolve(okTask(changed));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    second.resolve(okTaskUnchanged(changed));
    await flushMicrotasks();

    h.setSnapshots([changed]);
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it('preserves an intermediate restoration through two queued no-op results', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const third = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const original = keyboardSnapshot(TODAY, '00:15', 'clamped.md', 'revision-1');
    const boundary = keyboardSnapshot(TODAY, '00:00', 'clamped.md', 'revision-2');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowUp');
    press(outgoing, 'ArrowUp');
    first.resolve(okTask(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    h.setSnapshots([boundary]);
    h.emit();
    await flushMicrotasks();
    const restored = timedBlock(h.el);
    expect(activeDocument.activeElement).toBe(restored);
    press(restored, 'ArrowUp');

    second.resolve(okTaskUnchanged(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    third.resolve(okTaskUnchanged(boundary));
    await flushMicrotasks();

    const nav = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
    nav.focus();
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(nav);
  });

  it('invalidates an intermediate restoration when a later queued result changes', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const third = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const original = keyboardSnapshot(TODAY, '00:15', 'clamped.md', 'revision-1');
    const boundary = keyboardSnapshot(TODAY, '00:00', 'clamped.md', 'revision-2');
    const final = keyboardSnapshot(TODAY, '00:15', 'clamped.md', 'revision-3');
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowUp');
    press(outgoing, 'ArrowUp');
    first.resolve(okTask(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    h.setSnapshots([boundary]);
    h.emit();
    await flushMicrotasks();
    const restored = timedBlock(h.el);
    expect(activeDocument.activeElement).toBe(restored);
    press(restored, 'ArrowDown');

    second.resolve(okTaskUnchanged(boundary));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    third.resolve(okTask(final));
    await flushMicrotasks();

    h.setSnapshots([final]);
    h.emit();
    await flushMicrotasks();

    expect(activeDocument.activeElement).toBe(timedBlock(h.el));
  });

  it.each([
    ['vertical', 'ArrowDown', TODAY, '09:15'],
    ['horizontal', 'ArrowRight', moment(TODAY).add(1, 'day').format('YYYY-MM-DD'), '09:00'],
  ] as const)(
    'preserves a rebased queue locator when a %s result arrives before the index',
    async (_direction, key, updatedDate, updatedTime) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
      const moved = keyboardSnapshot(updatedDate, updatedTime, 'moved.md', 'revision-2', 5);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const outgoing = timedBlock(h.el);
      outgoing.focus();
      press(outgoing, key);
      pending.resolve(okTask(moved));
      await flushMicrotasks();

      h.setSnapshots([moved]);
      h.emit();
      await flushMicrotasks();

      const focused = timedBlock(h.el);
      expect(focused.dataset['abyssTaskLine']).toBe('5');
      expect(activeDocument.activeElement).toBe(focused);
    },
  );

  it.each(['before', 'after'] as const)(
    'retains a changed:false moved-source locator when the index arrives %s the result',
    async (indexOrder) => {
      const pending = deferredResult();
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
      const moved = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-2', 5);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const outgoing = timedBlock(h.el);
      outgoing.focus();
      press(outgoing, 'ArrowDown');
      if (indexOrder === 'before') {
        h.setSnapshots([moved]);
        h.emit();
        await flushMicrotasks();
      }

      pending.resolve(okTaskUnchanged(moved));
      await flushMicrotasks();
      if (indexOrder === 'after') {
        h.setSnapshots([moved]);
        h.emit();
        await flushMicrotasks();
      }

      const focused = timedBlock(h.el);
      expect(focused.dataset['abyssTaskLine']).toBe('5');
      expect(activeDocument.activeElement).toBe(focused);

      const nav = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
      nav.focus();
      h.emit();
      await flushMicrotasks();
      expect(activeDocument.activeElement).toBe(nav);
    },
  );

  it('finishes a pending remount restoration when changed:false settles before its timer', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'same.md', 'revision-1', 4);
    const rebuilt = keyboardSnapshot(TODAY, '09:00', 'same.md', 'revision-2', 4);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    h.setSnapshots([rebuilt]);
    h.emit();
    expect(outgoing.isConnected).toBe(false);
    pending.resolve(okTaskUnchanged(rebuilt));
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused).not.toBe(outgoing);
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('restores to an index candidate newer than the committed result revision', async () => {
    const pending = deferredResult();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'newer.md', 'revision-1', 4);
    const returned = keyboardSnapshot(TODAY, '09:15', 'newer.md', 'revision-2', 4);
    const indexed = keyboardSnapshot(TODAY, '09:30', 'newer.md', 'revision-3', 4);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    pending.resolve(okTask(returned));
    await flushMicrotasks();

    h.setSnapshots([indexed]);
    h.emit();
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused).not.toBe(outgoing);
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('rebases the pending locator when a returned snapshot moves to a new line', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
    const moved = keyboardSnapshot(TODAY, '09:15', 'moved.md', 'revision-2', 5);
    const final = keyboardSnapshot(TODAY, '09:30', 'moved.md', 'revision-3', 5);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowDown');
    press(block, 'ArrowDown');
    h.setSnapshots([moved]);
    h.emit();
    first.resolve(okTask(moved));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 5, revision: 'revision-2' }),
        },
      }),
    );

    h.setSnapshots([final]);
    h.emit();
    second.resolve(okTask(final));
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused.dataset['abyssTaskLine']).toBe('5');
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('invalidates an intermediate restored identity before the final moved outcome settles', async () => {
    const first = deferredResult();
    const second = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'moved.md', 'revision-1', 4);
    const intermediate = keyboardSnapshot(TODAY, '09:15', 'moved.md', 'revision-2', 5);
    const final = keyboardSnapshot(TODAY, '09:30', 'moved.md', 'revision-3', 6);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    press(outgoing, 'ArrowDown');
    first.resolve(okTask(intermediate));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    h.setSnapshots([intermediate]);
    h.emit();
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(timedBlock(h.el));

    second.resolve(okTask(final));
    await flushMicrotasks();
    h.setSnapshots([final]);
    h.emit();
    await flushMicrotasks();

    const focused = timedBlock(h.el);
    expect(focused.dataset['abyssTaskLine']).toBe('6');
    expect(activeDocument.activeElement).toBe(focused);
  });

  it('cancels an aliased sequence when explicit focus moves to a distinct timed block', async () => {
    const first = deferredResult();
    const staleSecond = deferredResult();
    const replacementResult = deferredResult();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(staleSecond.promise)
      .mockReturnValueOnce(replacementResult.promise);
    const original = keyboardSnapshot(TODAY, '09:00', 'shared.md', 'shared-revision', 4);
    const moved = keyboardSnapshot(TODAY, '09:15', 'shared.md', 'moved-revision', 5);
    const staleFinal = keyboardSnapshot(TODAY, '09:30', 'shared.md', 'stale-revision', 5);
    const replacement = keyboardSnapshot(TODAY, '14:00', 'shared.md', 'shared-revision', 4);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');

    const outgoing = timedBlock(h.el);
    outgoing.focus();
    press(outgoing, 'ArrowDown');
    press(outgoing, 'ArrowDown');
    first.resolve(okTask(moved));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    h.setSnapshots([replacement, moved]);
    h.emit();
    await flushMicrotasks();
    const replacementBlock = Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-block')).find(
      (block) => block.dataset['abyssTaskLine'] === '4',
    )!;
    replacementBlock.focus();
    press(replacementBlock, 'ArrowDown');

    staleSecond.resolve(okTask(staleFinal));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute).toHaveBeenNthCalledWith(3, {
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({
          line: 4,
          revision: 'shared-revision',
        }),
      },
      patch: { time: { type: 'set', value: '14:15' } },
    });

    replacementResult.resolve(
      okTask(keyboardSnapshot(TODAY, '14:15', 'shared.md', 'replacement-revision', 4)),
    );
  });

  it.each([
    ['same-revision', 'shared-revision'],
    ['different-revision', 'replacement-index-revision'],
  ] as const)(
    'cancels a pre-commit alias when %s replacement focus precedes the original result',
    async (_revisionKind, replacementRevision) => {
      const originalResult = deferredResult();
      const replacementResult = deferredResult();
      const execute = vi
        .fn<TaskApplicationApi['execute']>()
        .mockReturnValueOnce(originalResult.promise)
        .mockReturnValueOnce(replacementResult.promise);
      const original = keyboardSnapshot(TODAY, '09:00', 'shared.md', 'shared-revision', 4);
      const moved = keyboardSnapshot(TODAY, '09:15', 'shared.md', 'moved-revision', 5);
      const replacement = keyboardSnapshot(TODAY, '14:00', 'shared.md', replacementRevision, 4);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const originBlock = timedBlock(h.el);
      originBlock.focus();
      press(originBlock, 'ArrowDown');
      h.setSnapshots([replacement, moved]);
      h.emit();
      await flushMicrotasks();

      const replacementBlock = Array.from(
        h.el.querySelectorAll<HTMLElement>('.abyss-tg-block'),
      ).find((block) => block.dataset['abyssTaskLine'] === '4')!;
      expect(activeDocument.activeElement).not.toBe(replacementBlock);
      replacementBlock.focus();
      press(replacementBlock, 'ArrowDown');
      originalResult.resolve(okTask(moved));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

      expect(execute).toHaveBeenNthCalledWith(2, {
        type: 'patch',
        target: {
          type: 'task',
          ref: expect.objectContaining({ line: 4, revision: replacementRevision }),
        },
        patch: { time: { type: 'set', value: '14:15' } },
      });
      replacementResult.resolve(
        okTask(keyboardSnapshot(TODAY, '14:15', 'shared.md', 'replacement-revision', 4)),
      );
    },
  );

  it.each(['throw', 'reject'] as const)(
    'clears focus ownership after execute %s and does not refocus on a later emit',
    async (failureMode) => {
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(() => {
        if (failureMode === 'throw') throw new Error('boom');
        return Promise.reject(new Error('boom'));
      });
      const original = keyboardSnapshot(TODAY);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');

      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowDown');
      await flushMicrotasks();
      const other = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
      other.focus();
      h.emit();
      await flushMicrotasks();

      expect(activeDocument.activeElement).toBe(other);
    },
  );

  it('a failed horizontal command neither navigates nor steals focus', async () => {
    const pending = deferredResult();
    const original = keyboardSnapshot(TODAY);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Day');
    const block = timedBlock(h.el);
    block.focus();
    press(block, 'ArrowRight');
    const other = h.el.querySelector<HTMLElement>('.abyss-cal-nav-today')!;
    other.focus();
    pending.resolve({ type: 'conflict', current: original });
    await flushMicrotasks();

    expect(h.el.querySelector('.abyss-tg-day-column')?.getAttribute('data-tg-date')).toBe(TODAY);
    expect(activeDocument.activeElement).toBe(other);
  });

  it.each(['view', 'mode', 'destroy'] as const)(
    '%s cancellation suppresses every late calendar hook',
    async (kind) => {
      const pending = deferredResult();
      const original = keyboardSnapshot(TODAY);
      const updated = keyboardSnapshot(
        moment(TODAY).add(1, 'day').format('YYYY-MM-DD'),
        '09:00',
        original.source.filePath,
        'revision-2',
      );
      const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
      const h = keyboardPanelHarness([original], execute);
      clickCalendarView(h.el, 'Day');
      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowRight');

      if (kind === 'view') clickCalendarView(h.el, 'Month');
      else if (kind === 'mode') h.state.set('mode', 'tasks');
      else h.panel.destroy();
      pending.resolve(okTask(updated));
      await flushMicrotasks();

      expect(activeDocument.activeElement?.classList.contains('abyss-tg-block')).toBe(false);
      if (kind === 'view') expect(h.el.querySelector('.abyss-mg-grid')).not.toBeNull();
      if (kind === 'mode') expect(h.el.querySelector('.abyss-center-header')).not.toBeNull();
      if (kind === 'destroy') expect(h.el.children).toHaveLength(0);
    },
  );
});
