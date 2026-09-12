import { addIcon, Menu, moment, removeIcon, TFile, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
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
import { localDate, localTime } from '../src/tasks';
import type { TaskQuery } from '../src/tasks/application/TaskApplicationApi';
import { TaskModal } from '../src/ui/TaskModal';
import { InteractionRegistry, type InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { PanelShortcutRouter } from '../src/ui/panelShortcutRouter';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { TodayView } from '../src/views/TodayView';
import { WeekTimeGridView } from '../src/views/WeekTimeGridView';
import {
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import { PanelNavigator } from '../src/views/panelNavigation';
import { MIN_BLOCK_HEIGHT_PX } from '../src/views/timegrid/layout';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  expectDefined,
  fixedToday,
  flushMicrotasks,
  freshContainer,
  methodOf,
  seedTaskCache,
  task,
  taskQueryApi,
  useRealMoment,
} from './helpers';

const TODAY = moment().format('YYYY-MM-DD');

type CalendarViewLabel = 'Day' | 'Week' | 'Month';
type TimeGridViewInstance = TodayView | WeekTimeGridView | null;
type ExecutedTaskCommand = Parameters<TaskApplicationApi['execute']>[0];

function successfulCapture(title = 'Captured'): TaskCommandResult {
  return {
    type: 'ok',
    changed: true,
    outcome: {
      type: 'task',
      task: task({ title, source: { filePath: 'Capture.md', line: 0 } }),
    },
  };
}

function expectRootTaskPatch(
  command: ExecutedTaskCommand,
  expected: { readonly line: number; readonly revision: string },
): Extract<ExecutedTaskCommand, { readonly type: 'patch'; readonly target: { type: 'task' } }> {
  expect(command.type).toBe('patch');
  if (command.type !== 'patch') throw new Error(`expected patch command, got ${command.type}`);
  expect(command.target.type).toBe('task');
  if (command.target.type !== 'task') throw new Error('expected a root task patch');
  expect(command.target.ref.line).toBe(expected.line);
  expect(command.target.ref.revision).toBe(expected.revision);
  return { type: 'patch', target: command.target, patch: command.patch };
}

useRealMoment();

afterEach(() => {
  vi.useRealTimers();
});

function queryApiForSnapshots(
  getTasks: () => readonly TaskSnapshot[],
): TaskApplicationApi['queries'] {
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
        return dates.some(
          (date) =>
            date >= expectDefined(query.dateRange).from &&
            date <= expectDefined(query.dateRange).to,
        );
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
            dates.some(
              (date) =>
                date >= expectDefined(item.planning.start) &&
                date <= expectDefined(item.planning.due),
            )
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
      return found != null
        ? { type: 'exact', task: found, basis: { observed: found } }
        : { type: 'not-found', ref };
    },
  });
}

function makeStaticPanel(
  ...[
    state,
    snapshots,
    settings = DEFAULT_SETTINGS,
    app = {} as App,
    interactionOwnership,
  ]: readonly [
    state: AppState,
    snapshots: readonly TaskSnapshot[],
    settings?: CalendarSettings,
    app?: App,
    interactionOwnership?: InteractionOwnershipPort,
  ]
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
  const fn = expectDefined(
    (panel as unknown as Record<string, (...a: unknown[]) => T>)[`${method}_abyssPrivate`],
  );
  return fn.call(panel, ...args);
}

async function openListCapture(container: HTMLElement): Promise<HTMLInputElement> {
  container.querySelector<HTMLElement>('.abyss-add-task-trigger')?.click();
  await flushMicrotasks();
  const input = container.querySelector<HTMLInputElement>('.abyss-quick-capture-input');
  if (input == null) throw new Error('list capture did not open');
  return input;
}

function setCaptureDraft(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressCaptureKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function returnToTasksMode(state: AppState): void {
  state.set('mode', 'tasks');
}

function visibleChildren(element: HTMLElement): HTMLElement[] {
  return [...element.children].filter(
    (child): child is HTMLElement => child.instanceOf(HTMLElement) && !child.hidden,
  );
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
    taskApplication.tasks,
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

  it('mounts the delete control in the primary row only after task activation', () => {
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

      const card = expectDefined(panel['el'].querySelector<HTMLElement>('.abyss-task-card'));
      const mainRow = expectDefined(card.querySelector<HTMLElement>('.abyss-task-card-main-row'));
      expect(Array.from(mainRow.children, (child) => child.className)).toEqual([
        expect.stringContaining('abyss-status-marker'),
        'abyss-task-body',
        'abyss-task-meta-right',
      ]);
      expect(mainRow.querySelector('.abyss-task-delete-btn')).toBeNull();

      const titleRow = expectDefined(mainRow.querySelector<HTMLElement>('.abyss-task-title-row'));
      const recurrence = expectDefined(
        titleRow.querySelector<HTMLElement>('.abyss-recurrence-badge'),
      );
      expect(recurrence.nextElementSibling?.classList.contains('abyss-task-title')).toBe(true);

      const description = expectDefined(card.querySelector<HTMLElement>('.abyss-task-desc'));
      expect(description.parentElement).toBe(card);
      expect(description.previousElementSibling).toBe(mainRow);

      card.click();
      expect(state.get('taskStack')).toEqual([snapshot]);
      const activeCard = expectDefined(
        panel['el'].querySelector<HTMLElement>('.abyss-task-card.is-selected'),
      );
      const activeMainRow = expectDefined(
        activeCard.querySelector<HTMLElement>('.abyss-task-card-main-row'),
      );
      const deleteButton = expectDefined(
        activeMainRow.querySelector<HTMLButtonElement>('.abyss-task-delete-btn'),
      );
      expect(Array.from(activeMainRow.children, (child) => child.className)).toEqual([
        expect.stringContaining('abyss-status-marker'),
        'abyss-task-body',
        'abyss-task-meta-right',
        'abyss-task-delete-btn',
      ]);
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

      const mainRow = expectDefined(
        panel['el'].querySelector<HTMLElement>('.abyss-task-card-main-row'),
      );
      const titleRow = expectDefined(mainRow.querySelector<HTMLElement>('.abyss-task-title-row'));
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

      const mainRow = expectDefined(
        panel['el'].querySelector<HTMLElement>('.abyss-task-card-main-row'),
      );
      const body = expectDefined(mainRow.querySelector<HTMLElement>('.abyss-task-body'));
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
  it('does not expose or forward the PanelView-owned Quick Capture action', () => {
    const panel = makeStaticPanel(new AppState(), [], structuredClone(DEFAULT_SETTINGS));

    expect('openQuickCapture' in panel).toBe(false);

    panel.destroy();
  });

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
    const render = vi.spyOn(
      panel as unknown as { render_abyssPrivate(): void },
      'render_abyssPrivate',
    );

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
    const render = vi.spyOn(
      panel as unknown as { render_abyssPrivate(): void },
      'render_abyssPrivate',
    );
    const openQuickCapture = vi.fn();
    const navigator = new PanelNavigator(state, settings, {
      calendarView: () => panel.calendarView(),
      setCalendarView: (view) => {
        panel.setCalendarView(view);
      },
      openQuickCapture,
    });

    const once = (run: () => void): void => {
      render.mockClear();
      run();
      expect(render).toHaveBeenCalledOnce();
    };

    once(() => {
      navigator.openCalendar();
    });
    expect(state.get('mode')).toBe('calendar');

    const cancelKeyboardInteraction = vi.spyOn(
      panel as unknown as { cancelKeyboardInteraction_abyssPrivate(): void },
      'cancelKeyboardInteraction_abyssPrivate',
    );
    once(() => {
      navigator.openCalendarView('week');
    });
    expect(cancelKeyboardInteraction).toHaveBeenCalledOnce();
    expect(panel.calendarView()).toBe('week');
    expect(panel['calDate_abyssPrivate'].format('YYYY-MM-DD')).toBe(
      window.moment().startOf('isoWeek').format('YYYY-MM-DD'),
    );

    once(() => {
      navigator.openProjects();
    });
    expect(state.get('mode')).toBe('projects');

    once(() => {
      navigator.openSearch();
    });
    expect(state.get('mode')).toBe('search');

    once(() => {
      navigator.openList('inbox');
    });
    expect(state.get('selectedList')).toBe('inbox');
    expect(panel['el'].querySelector('.abyss-center-title')?.textContent).toBe('Inbox');

    once(() => {
      navigator.openTasks();
    });

    navigator.openSearch();
    render.mockClear();
    navigator.openQuickCapture();
    expect(openQuickCapture).toHaveBeenCalledOnce();
    expect(state.get('mode')).toBe('search');
    expect(render).not.toHaveBeenCalled();

    panel.destroy();
  });

  it('renders once with final batch state after rejecting a listener mutation', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    state.set('centerFilter', 'before');
    const panel = makeStaticPanel(state, [], settings);
    panel.mount(freshContainer());
    const render = vi.spyOn(
      panel as unknown as { render_abyssPrivate(): void },
      'render_abyssPrivate',
    );
    const commits = vi.fn();
    state.on('selectedList', () => {
      state.set('centerFilter', 'listener-final');
    });
    state.onCommit(commits);
    const navigator = new PanelNavigator(state, settings, {
      calendarView: () => panel.calendarView(),
      setCalendarView: (view) => {
        panel.setCalendarView(view);
      },
      openQuickCapture: () => undefined,
    });

    let thrown: unknown;
    try {
      navigator.openList('inbox');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: 'AppStateReentrantMutationError' });
    expect(state.get('centerFilter')).toBe('');
    expect(panel['el'].querySelector<HTMLInputElement>('.abyss-center-search')?.value).toBe('');
    expect(commits).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    panel.destroy();
  });
});

describe('CenterPanel interaction ownership', () => {
  const cases = [
    {
      category: 'sort/group',
      mode: 'tasks' as const,
      open: (container: HTMLElement) => {
        expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
      },
      focus: '.abyss-view-state-row-main',
    },
    {
      category: 'month',
      mode: 'calendar' as const,
      open: (container: HTMLElement) => {
        expectDefined(container.querySelector<HTMLButtonElement>('.abyss-cal-nav-month')).click();
      },
      focus: '.abyss-month-picker-btn',
    },
    {
      category: 'year',
      mode: 'calendar' as const,
      open: (container: HTMLElement) => {
        expectDefined(container.querySelector<HTMLButtonElement>('.abyss-cal-nav-year')).click();
      },
      focus: '.abyss-year-picker-btn',
    },
  ];

  it.each(cases)(
    'blocks semantic navigation in the $category popover and releases when its context is replaced',
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
        const focused = expectDefined(container.querySelector<HTMLElement>(focus));
        focused.focus();
        focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
        expect(navigate).not.toHaveBeenCalled();

        panel.refresh();
        if (mode === 'tasks') state.set('selectedList', 'upcoming');
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
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
      expect(container.querySelector('.abyss-view-state-popover')).not.toBeNull();

      const statusMarker = expectDefined(
        container.querySelector<HTMLElement>('.abyss-status-marker'),
      );
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
      expect(expectDefined(releases[0]).mock.invocationCallOrder[0]).toBeLessThan(
        expectDefined(acquire.mock.invocationCallOrder[1]),
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
      const trigger = expectDefined(
        container.querySelector<HTMLButtonElement>('.abyss-view-state-btn'),
      );
      trigger.focus();
      trigger.dispatchEvent(new PointerEvent('click', { bubbles: true }));

      const popover = expectDefined(
        container.querySelector<HTMLElement>('.abyss-view-state-popover'),
      );
      expect(activeDocument.activeElement).toBe(
        popover.querySelector<HTMLElement>('.abyss-view-state-row-main'),
      );
      expect(popover.contains(activeDocument.activeElement)).toBe(true);
      const focusedRow = activeDocument.activeElement as HTMLElement;
      focusedRow.click();
      expect(focusedRow.getAttribute('aria-expanded')).toBe('true');
      expect(
        focusedRow.parentElement?.querySelector('.abyss-view-state-sublist')?.classList,
      ).not.toContain('abyss-hidden');
      focusedRow.click();
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
      const trigger = expectDefined(
        container.querySelector<HTMLButtonElement>('.abyss-view-state-btn'),
      );
      trigger.focus();
      trigger.dispatchEvent(new PointerEvent('click', { bubbles: true }));
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

  it('retains its registered outside-click listener on a same-list refresh and removes it on navigation', () => {
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
      const trigger = expectDefined(
        container.querySelector<HTMLButtonElement>('.abyss-view-state-btn'),
      );
      trigger.click();
      vi.runOnlyPendingTimers();
      const registration = addListener.mock.calls
        .slice(start)
        .find(([type, , options]) => type === 'click' && options === true);
      expect(registration).toBeDefined();
      return expectDefined(registration)[1] as EventListener;
    };

    try {
      panel.mount(container);

      const toggledListener = openAndRegisteredListener();
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
      expect(removeListener).toHaveBeenCalledWith('click', toggledListener, true);

      const retainedListener = openAndRegisteredListener();
      const retainedPopover = expectDefined(
        container.querySelector<HTMLElement>('.abyss-view-state-popover'),
      );
      panel.refresh();
      expect(container.querySelector('.abyss-view-state-popover')).toBe(retainedPopover);
      expect(removeListener).not.toHaveBeenCalledWith('click', retainedListener, true);

      state.set('selectedList', 'upcoming');
      expect(container.querySelector('.abyss-view-state-popover')).toBeNull();
      expect(removeListener).toHaveBeenCalledWith('click', retainedListener, true);

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
    const container = ownerDocument.body.createDiv();
    let destroyed = false;

    try {
      panel.mount(container);
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
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
      expect(ownerRemove).toHaveBeenCalledWith(
        'click',
        expectDefined(outsideRegistration)[1],
        true,
      );

      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
      vi.runOnlyPendingTimers();
      const ownerClickRegistrations = ownerAdd.mock.calls.filter(
        ([type, , options]) => type === 'click' && options === true,
      );
      const destroyRegistration = expectDefined(
        ownerClickRegistrations[ownerClickRegistrations.length - 1],
      );
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

  it('keeps one task header and popover while synchronizing successive group, sort, and show changes', async () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CalendarSettings;
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(state, [], settings);
    const container = freshContainer();
    activeDocument.body.append(container);

    const open = (): HTMLElement => {
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
      return expectDefined(container.querySelector<HTMLElement>('.abyss-view-state-popover'));
    };
    const row = (popover: HTMLElement, label: string): HTMLElement =>
      expectDefined(
        Array.from(popover.querySelectorAll<HTMLElement>('.abyss-view-state-row')).find(
          (candidate) =>
            candidate.querySelector('.abyss-view-state-row-label')?.textContent === label,
        ),
      );
    const option = (popover: HTMLElement, rowLabel: string, label: string): HTMLButtonElement =>
      expectDefined(
        Array.from(row(popover, rowLabel).querySelectorAll<HTMLButtonElement>('button')).find(
          (candidate) =>
            candidate.querySelector('.abyss-view-state-option-label')?.textContent === label,
        ),
      );

    try {
      panel.mount(container);

      const header = expectDefined(container.querySelector<HTMLElement>('.abyss-center-header'));
      const popover = open();
      expect(option(popover, 'Group by', 'Date').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Group by', 'None').getAttribute('aria-pressed')).toBe('false');
      option(popover, 'Group by', 'None').click();
      await flushMicrotasks();

      expect(container.querySelector('.abyss-center-header')).toBe(header);
      expect(container.querySelector('.abyss-view-state-popover')).toBe(popover);
      expect(option(popover, 'Group by', 'None').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Group by', 'Date').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Sort by', 'Date ↑').getAttribute('aria-pressed')).toBe('true');
      option(popover, 'Sort by', 'Priority').click();
      await flushMicrotasks();

      expect(container.querySelector('.abyss-center-header')).toBe(header);
      expect(container.querySelector('.abyss-view-state-popover')).toBe(popover);
      expect(option(popover, 'Sort by', 'Priority ↑').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Sort by', 'Date').getAttribute('aria-pressed')).toBe('false');
      option(popover, 'Sort by', 'Priority ↑').click();
      await flushMicrotasks();
      expect(option(popover, 'Sort by', 'Priority ↓').getAttribute('aria-pressed')).toBe('true');
      expect(
        row(popover, 'Sort by').querySelector('.abyss-view-state-row-value')?.textContent,
      ).toBe('Priority ↓');
      expect(option(popover, 'Show', 'Active').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Show', 'All').getAttribute('aria-pressed')).toBe('false');
      option(popover, 'Show', 'All').click();
      await flushMicrotasks();

      expect(container.querySelector('.abyss-center-header')).toBe(header);
      expect(container.querySelector('.abyss-view-state-popover')).toBe(popover);
      expect(option(popover, 'Show', 'All').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Show', 'Active').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'Done').getAttribute('aria-pressed')).toBe('true');
      option(popover, 'Show', 'Done').click();
      await flushMicrotasks();

      expect(container.querySelector('.abyss-view-state-popover')).toBe(popover);
      expect(option(popover, 'Show', 'Done').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'To do').getAttribute('aria-pressed')).toBe('true');
      expect(option(popover, 'Show', 'All').getAttribute('aria-pressed')).toBe('false');
      expect(option(popover, 'Show', 'Active').getAttribute('aria-pressed')).toBe('false');
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('retains task-list scroll while refreshing content under an open options popover', () => {
    const state = new AppState();
    state.set('selectedList', 'today');
    const panel = makeStaticPanel(
      state,
      [task({ title: 'Keep the task list viewport', planning: { due: TODAY } })],
      DEFAULT_SETTINGS,
    );
    const container = freshContainer();
    activeDocument.body.append(container);

    try {
      panel.mount(container);
      const scroll = expectDefined(container.querySelector<HTMLElement>('.abyss-center-scroll'));
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 900 },
        clientHeight: { configurable: true, value: 300 },
        scrollWidth: { configurable: true, value: 700 },
        clientWidth: { configurable: true, value: 400 },
      });
      scroll.scrollTop = 180;
      scroll.scrollLeft = 35;
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-view-state-btn')).click();
      const popover = expectDefined(
        container.querySelector<HTMLElement>('.abyss-view-state-popover'),
      );

      panel.refresh();

      expect(container.querySelector('.abyss-center-scroll')).toBe(scroll);
      expect(scroll.scrollTop).toBe(180);
      expect(scroll.scrollLeft).toBe(35);
      expect(container.querySelector('.abyss-view-state-popover')).toBe(popover);
    } finally {
      panel.destroy();
      container.remove();
    }
  });
});

describe('CenterPanel shared list capture', () => {
  function captureHarness(
    implementation: () => Promise<TaskCommandResult>,
    snapshots: readonly TaskSnapshot[] = [],
    plan?: () => Promise<TaskCreateSession>,
  ): {
    readonly panel: CenterPanel;
    readonly state: AppState;
    readonly planCreate: ReturnType<typeof vi.fn>;
    readonly sessionExecute: ReturnType<typeof vi.fn<TaskCreateSession['execute']>>;
  } {
    const state = new AppState();
    const queries = taskQueryApi({ list: () => snapshots });
    const sessionExecute = vi.fn<TaskCreateSession['execute']>(implementation);
    const planCreate = vi.fn(
      plan ??
        (async () => ({
          type: 'ready' as const,
          destination: { filePath: 'Capture.md', insertion: { type: 'append' as const } },
          execute: sessionExecute,
        })),
    );
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

  const captureFailure = (): TaskCommandResult => ({
    type: 'io-error',
    cause: 'repository-error',
    contentState: 'unknown',
  });

  it('keeps one focused session open across consecutive Enter successes', async () => {
    const { panel, planCreate, sessionExecute } = captureHarness(async () => successfulCapture());
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

  it('uses a native named Add task trigger and restores it only after Escape dismissal', async () => {
    const { panel } = captureHarness(async () => successfulCapture());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const trigger = expectDefined(
        container.querySelector<HTMLButtonElement>('.abyss-add-task-trigger'),
      );
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger.type).toBe('button');
      expect(trigger.textContent).toContain('Add task');
      trigger.focus();

      trigger.click();
      await flushMicrotasks();
      const input = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      expect(activeDocument.activeElement).toBe(input);
      expect(trigger.isConnected).toBe(true);
      expect(trigger.hidden).toBe(true);
      expect(
        input
          .closest('.abyss-capture-surface')
          ?.classList.contains('abyss-capture-surface--inline'),
      ).toBe(true);
      expect(trigger.parentElement?.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);

      pressCaptureKey(input, 'Escape');

      expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(trigger.hidden).toBe(false);
      expect(activeDocument.activeElement).toBe(trigger);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('closes on Escape without clearing the current multi-selection', async () => {
    const snapshots = [
      task({
        title: 'First selected task',
        tags: ['#task/inbox'],
        source: { filePath: 'Capture.md', line: 0 },
      }),
      task({
        title: 'Second selected task',
        tags: ['#task/inbox'],
        source: { filePath: 'Capture.md', line: 1 },
      }),
    ];
    const { panel, state } = captureHarness(async () => successfulCapture(), snapshots);
    state.set('selectedList', 'inbox');
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const cards = container.querySelectorAll<HTMLElement>('.abyss-task-card');
      expectDefined(cards[0]).dispatchEvent(
        new MouseEvent('click', { bubbles: true, ctrlKey: true }),
      );
      expectDefined(cards[1]).dispatchEvent(
        new MouseEvent('click', { bubbles: true, ctrlKey: true }),
      );
      expect(container.querySelectorAll('.abyss-task-card.abyss-multi-selected')).toHaveLength(2);

      const input = await openListCapture(container);
      pressCaptureKey(input, 'Escape');

      expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(container.querySelectorAll('.abyss-task-card.abyss-multi-selected')).toHaveLength(2);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('closes after blur success without taking focus from the next control', async () => {
    const { panel, sessionExecute } = captureHarness(async () => successfulCapture());
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

  it('closes after pending Enter blur without a duplicate write or focus theft', async () => {
    const pendingResult = deferred<TaskCommandResult>();
    const { panel, sessionExecute } = captureHarness(() => pendingResult.promise);
    const container = freshContainer();
    const next = activeDocument.body.createEl('button', { text: 'Next control' });
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const input = await openListCapture(container);
      setCaptureDraft(input, 'submit once then leave');
      input.focus();
      pressCaptureKey(input, 'Enter');
      next.focus();
      pendingResult.resolve(successfulCapture());
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

  it('closes an empty inline capture on blur without executing or taking focus', async () => {
    const { panel, sessionExecute } = captureHarness(async () => successfulCapture());
    const container = freshContainer();
    const next = activeDocument.body.createEl('button', { text: 'Next control' });
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const input = await openListCapture(container);
      input.focus();
      next.focus();
      await flushMicrotasks();

      expect(sessionExecute).not.toHaveBeenCalled();
      expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(next);
    } finally {
      panel.destroy();
      container.remove();
      next.remove();
    }
  });

  it('opens inline capture without moving the first card or its scrolling container', async () => {
    const snapshots = [
      task({
        title: 'First task',
        planning: { due: TODAY },
        source: { filePath: 'Capture.md', line: 0 },
      }),
    ];
    const { panel } = captureHarness(async () => successfulCapture(), snapshots);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const scroll = expectDefined(container.querySelector<HTMLElement>('.abyss-center-scroll'));
      const card = expectDefined(container.querySelector<HTMLElement>('.abyss-task-card'));
      const bar = expectDefined(container.querySelector<HTMLElement>('.abyss-add-task-bar'));
      scroll.scrollTop = 41;
      const rectForCurrentBar = (): DOMRect => {
        const visibleRows = visibleChildren(bar).length;
        return {
          x: 0,
          y: 73 + visibleRows * 24,
          top: 73 + visibleRows * 24,
          right: 100,
          bottom: 93 + visibleRows * 24,
          left: 0,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        };
      };
      vi.spyOn(card, 'getBoundingClientRect').mockImplementation(rectForCurrentBar);
      const beforeTop = card.getBoundingClientRect().top;

      await openListCapture(container);

      expect(container.querySelector('.abyss-task-card')).toBe(card);
      expect(card.getBoundingClientRect().top).toBe(beforeTop);
      expect(visibleChildren(bar)).toHaveLength(1);
      expect(scroll.scrollTop).toBe(41);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('leaves composing inline Enter and Escape to the IME', async () => {
    const { panel, sessionExecute } = captureHarness(async () => successfulCapture());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const input = await openListCapture(container);
      setCaptureDraft(input, 'composing draft');
      const composingEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      const legacyEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(legacyEscape, 'keyCode', { configurable: true, value: 229 });
      input.dispatchEvent(composingEnter);
      input.dispatchEvent(legacyEscape);
      await flushMicrotasks();

      expect(sessionExecute).not.toHaveBeenCalled();
      expect(composingEnter.defaultPrevented).toBe(false);
      expect(legacyEscape.defaultPrevented).toBe(false);
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(input);
      expect(input.value).toBe('composing draft');
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  function submitFailedCapture(
    cause: 'Enter' | 'blur',
    input: HTMLInputElement,
    next: HTMLElement,
  ): void {
    if (cause === 'Enter') {
      pressCaptureKey(input, cause);
      return;
    }
    input.focus();
    next.focus();
  }

  function expectFailedCaptureState(container: HTMLElement, input: HTMLInputElement): void {
    const current = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
    );
    const surface = expectDefined(current.closest<HTMLElement>('.abyss-capture-surface'));
    const error = expectDefined(surface.querySelector<HTMLElement>('.abyss-capture-error'));
    expect(current).toBe(input);
    expect(current.value).toBe('  repair this exact draft  ');
    expect(surface.classList).toContain('has-error');
    expect(surface.classList.contains('abyss-capture-surface--inline')).toBe(true);
    expect(current.getAttribute('aria-invalid')).toBe('true');
    expect(error.hidden).toBe(false);
    expect(current.getAttribute('aria-describedby')).toContain(error.id);
  }

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
        submitFailedCapture(cause, input, next);
        await flushMicrotasks();

        expect(sessionExecute).toHaveBeenCalledOnce();
        expectFailedCaptureState(container, input);
      } finally {
        panel.destroy();
        container.remove();
        next.remove();
      }
    },
  );

  it('remounts the active draft and focus across a full CenterPanel rerender', async () => {
    const { panel, state, sessionExecute } = captureHarness(async () => successfulCapture());
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

  it.each([
    {
      name: 'selected-list',
      navigate: (state: AppState) => {
        state.set('selectedList', 'inbox');
      },
      restore: (state: AppState) => {
        state.set('selectedList', 'today');
      },
    },
    {
      name: 'mode',
      navigate: (state: AppState) => {
        state.set('mode', 'search');
      },
      restore: (state: AppState) => {
        state.set('mode', 'tasks');
      },
    },
  ])(
    'invalidates a deferred list capture after $name navigation',
    async ({ navigate, restore }) => {
      const planned = deferred<TaskCreateSession>();
      const { panel, state, planCreate, sessionExecute } = captureHarness(
        async () => successfulCapture(),
        [],
        () => planned.promise,
      );
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      try {
        expectDefined(
          container.querySelector<HTMLButtonElement>('.abyss-add-task-trigger'),
        ).click();
        expect(planCreate).toHaveBeenCalledOnce();

        navigate(state);
        planned.resolve({
          type: 'ready',
          destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
          execute: sessionExecute,
        });
        await flushMicrotasks();
        restore(state);

        expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
        expect(sessionExecute).not.toHaveBeenCalled();
      } finally {
        panel.destroy();
        container.remove();
      }
    },
  );

  it.each([
    {
      name: 'selected-list',
      navigate: (state: AppState) => {
        state.set('selectedList', 'inbox');
      },
      restore: (state: AppState) => {
        state.set('selectedList', 'today');
      },
    },
    {
      name: 'mode',
      navigate: (state: AppState) => {
        state.set('mode', 'search');
      },
      restore: (state: AppState) => {
        state.set('mode', 'tasks');
      },
    },
  ])('detaches an active list capture after $name navigation', async ({ navigate, restore }) => {
    const { panel, state, sessionExecute } = captureHarness(async () => successfulCapture());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const input = await openListCapture(container);
      setCaptureDraft(input, 'stale draft');

      navigate(state);
      restore(state);

      expect(input.isConnected).toBe(false);
      expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
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

      const after = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
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
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
    );
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
    const target = expectDefined(index.list().find((item) => item.title === 'delete me'));
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
    const target = expectDefined(index.list()[0]);
    await call<void>(panel, 'deleteTask', target);
    const after = await readMd(app, 't.md');
    expect(after).toBe('- [ ] other');
  });

  it('file not found (task source path missing from vault) is a no-op', async () => {
    const { panel, index } = await makePanel({ 't.md': '- [ ] x' }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const original = expectDefined(index.list()[0]);
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
    const target = expectDefined(index.list()[0]);
    state.set('taskStack', [target]);
    await call<void>(panel, 'deleteTask', target);
    expect(state.get('taskStack')).toEqual([]);
  });
});

describe('CenterPanel.rescheduleTask', () => {
  it.each([
    {
      name: 'task with due date → 📅 replaced with targetDate',
      source: '- [ ] task 📅 2026-06-20',
      dragData: 'indexed-task',
      expected: '- [ ] task 📅 2026-06-28',
    },
    {
      name: 'task with scheduled (no due) → ⏳ replaced with targetDate',
      source: '- [ ] task ⏳ 2026-06-20',
      dragData: 'indexed-task',
      expected: '- [ ] task ⏳ 2026-06-28',
    },
    {
      name: 'task with no due/scheduled → 📅 targetDate appended',
      source: '- [ ] plain task',
      dragData: 'indexed-task',
      expected: '- [ ] plain task 📅 2026-06-28',
    },
    {
      name: 'invalid dragData (no ::: separator) → no-op',
      source: '- [ ] task 📅 2026-06-20',
      dragData: 'bogus',
      expected: '- [ ] task 📅 2026-06-20',
      expectedDue: '2026-06-20',
    },
    {
      name: 'task not found in the query index → no-op',
      source: '- [ ] task 📅 2026-06-20',
      dragData: 't.md:::999',
      expected: '- [ ] task 📅 2026-06-20',
      expectedDue: '2026-06-20',
    },
  ])('$name', async ({ source, dragData, expected, expectedDue }) => {
    const { panel, index, app } = await makePanel({ 't.md': source }, DEFAULT_SETTINGS, [
      { path: 't.md', items: [{ task: ' ', parent: -1, line: 0 }] },
    ]);
    const target = expectDefined(index.list()[0]);
    const resolvedDragData =
      dragData === 'indexed-task' ? `${target.source.filePath}:::0` : dragData;
    await call<void>(panel, 'rescheduleTask', resolvedDragData, '2026-06-28');
    expect(await readMd(app, 't.md')).toBe(expected);
    if (expectedDue !== undefined) {
      expect(index.list()[0]?.planning.due).toBe(expectedDue);
    }
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
    const target = expectDefined(index.list()[0]);
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
    const target = expectDefined(index.list()[0]);
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
    const target = expectDefined(index.list()[0]);
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
      filters: [],
    });
    const panel = makeStaticPanel(state, tasks);
    const container = freshContainer();
    const renderResult = call<void>(panel, 'renderWithGrouping', container, tasks);
    if (renderResult instanceof Promise) throw new Error('Expected synchronous grouped rendering');
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
    const labels = Array.from(headers).map((h) => h.textContent.trim());
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
    const labels = Array.from(headers).map((h) => h.textContent.trim());
    expect(labels).toEqual(['Today  1']);
  });

  it('no-date task falls into "No date" bucket (not Overdue)', () => {
    const tasks = [task({ title: 'no date', source: { filePath: 't.md', line: 0 } })];
    const container = renderWithGroupingByDate(tasks);
    const headers = container.querySelectorAll('.abyss-group-header');
    const labels = Array.from(headers).map((h) => h.textContent.trim());
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
    const requestAnimationFrame = methodOf(window, 'requestAnimationFrame');
    const cancelAnimationFrame = methodOf(window, 'cancelAnimationFrame');
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    };
    window.cancelAnimationFrame = (frame: number): void => {
      callbacks.delete(frame);
    };

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

  it('releases non-composing Escape from Search without changing the query or results', () => {
    vi.useFakeTimers();
    const state = new AppState();
    const panel = makeStaticPanel(state, [
      task({ title: 'buy milk', source: { filePath: 'a.md', line: 0 } }),
      task({ title: 'walk dog', source: { filePath: 'b.md', line: 0 } }),
    ]);
    const container = freshContainer();
    const ownerDocument = container.ownerDocument;
    ownerDocument.body.append(container);
    panel.mount(container);
    panel['navigation_abyssPrivate'].openSearch();
    vi.runOnlyPendingTimers();
    const input = expectDefined(
      panel['el'].querySelector<HTMLInputElement>('.abyss-search-global'),
    );
    const focus = vi.spyOn(panel['el'], 'focus');
    const router = new PanelShortcutRouter({
      ownerDocument,
      isActive: () => true,
      settings: () => DEFAULT_SETTINGS.shortcuts,
      platform: { mod: 'ctrl' },
      actions: panel['navigation_abyssPrivate'],
      registry: new InteractionRegistry(),
      nativeHostBlocks: () => false,
    });

    try {
      expect(ownerDocument.activeElement).toBe(input);
      withQueuedAnimationFrames((flush) => {
        input.value = 'milk';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        flush();
      });
      const resultText = expectDefined(
        panel['el'].querySelector<HTMLElement>('.abyss-center-scroll'),
      ).textContent;

      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(state.get('searchQuery')).toBe('milk');
      expect(
        expectDefined(panel['el'].querySelector<HTMLElement>('.abyss-center-scroll')).textContent,
      ).toBe(resultText);
      expect(state.get('mode')).toBe('search');
      expect(panel['el'].ownerDocument.activeElement).toBe(panel['el']);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });

      const shortcut = new KeyboardEvent('keydown', {
        code: 'KeyP',
        key: 'p',
        bubbles: true,
        cancelable: true,
      });
      panel['el'].dispatchEvent(shortcut);

      expect(shortcut.defaultPrevented).toBe(true);
      expect(state.get('mode')).toBe('projects');
    } finally {
      router.destroy();
      panel.destroy();
      container.remove();
    }
  });

  it('keeps Search input focus for composing Escape key events', () => {
    const state = new AppState();
    state.set('mode', 'search');
    const panel = makeStaticPanel(state, []);
    const container = freshContainer();
    const ownerDocument = container.ownerDocument;
    ownerDocument.body.append(container);
    panel.mount(container);
    const input = expectDefined(
      panel['el'].querySelector<HTMLInputElement>('.abyss-search-global'),
    );

    try {
      input.focus();
      const composing = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      input.dispatchEvent(composing);
      expect(composing.defaultPrevented).toBe(false);
      expect(ownerDocument.activeElement).toBe(input);

      const imeSentinel = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(imeSentinel, 'keyCode', { value: 229 });
      input.dispatchEvent(imeSentinel);
      expect(imeSentinel.defaultPrevented).toBe(false);
      expect(ownerDocument.activeElement).toBe(input);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

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
    const originalInput = expectDefined(
      panel['el'].querySelector<HTMLInputElement>('.abyss-search-global'),
    );
    originalInput.focus();
    const renderSpy = vi.spyOn(
      panel as unknown as { render_abyssPrivate: () => void },
      'render_abyssPrivate',
    );
    const renderFlatSpy = vi.spyOn(
      panel as unknown as {
        renderFlat_abyssPrivate: (host: HTMLElement, tasks: TaskSnapshot[]) => void;
      },
      'renderFlat_abyssPrivate',
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
    const originalInput = expectDefined(
      panel['el'].querySelector<HTMLInputElement>('.abyss-search-global'),
    );
    originalInput.focus();
    originalInput.setSelectionRange(1, 3);
    const renderFlatSpy = vi.spyOn(
      panel as unknown as {
        renderFlat_abyssPrivate: (host: HTMLElement, tasks: TaskSnapshot[]) => void;
      },
      'renderFlat_abyssPrivate',
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
    const input = expectDefined(
      panel['el'].querySelector<HTMLInputElement>('.abyss-search-global'),
    );

    withQueuedAnimationFrames((_flush, callbacks) => {
      input.value = 'milk';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(callbacks).toHaveLength(1);
      const callback = expectDefined([...callbacks.values()][0]);
      state.set('mode', 'projects');
      expect(() => {
        callback(0);
      }).not.toThrow();
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
    const input = expectDefined(
      panel['el'].querySelector<HTMLInputElement>('.abyss-search-global'),
    );

    withQueuedAnimationFrames((_flush, callbacks) => {
      input.value = 'milk';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(callbacks).toHaveLength(1);
      const callback = expectDefined([...callbacks.values()][0]);
      panel.destroy();
      expect(() => {
        callback(0);
      }).not.toThrow();
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
    const card = expectDefined(panel['el'].querySelector<HTMLElement>('.abyss-task-card'));
    card.click();
    expect(state.get('mode')).toBe('tasks');
    expect(state.get('selectedList')).toBe('today');
    const taskStack = state.get('taskStack');
    expect(taskStack).toHaveLength(1);
    const selected = expectDefined(taskStack[0]);
    if (!('filePath' in selected.ref)) throw new Error('expected a root task selection');
    expect(selected.ref.filePath).toBe(t.ref.filePath);
    expect(selected.ref.line).toBe(t.ref.line);
    expect(selected.title).toBe(t.title);
    panel.destroy();
  });

  it('routes a daily-note-only search result to inbox', () => {
    const t = task({ title: 'daily-only', presentation: { dailyNoteDate: '2026-06-25' } });
    const state = new AppState();
    state.set('mode', 'search');
    state.set('searchQuery', 'daily');
    const panel = makeStaticPanel(state, [t]);
    panel.mount(freshContainer());
    expectDefined(panel['el'].querySelector<HTMLElement>('.abyss-task-card')).click();
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
    const children = Array.from(expectDefined(meta).children);
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
    expect(tasks).toHaveLength(2);
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
      onSourceObservation: () => () => {},
      refresh: () => {},
    } as never;
  }
  function stubProjectManager() {
    return { setStatus: async () => {}, create: async () => null } as never;
  }

  async function makeProjectsPanel(options?: {
    readonly settings?: CalendarSettings;
    readonly saveSettings?: () => Promise<void>;
  }): Promise<{
    panel: CenterPanel;
    state: AppState;
    el: HTMLElement;
  }> {
    const app = await createAppWithFiles({ 'Projects/A.md': '---\nstatus: active\n---\n' });
    const settings = options?.settings ?? DEFAULT_SETTINGS;
    const taskApplication = configuredTaskApplication(app, settings);
    await taskApplication.index.initialize();
    const state = new AppState();
    const panel = new CenterPanel(
      state,
      app,
      settings,
      taskApplication.index,
      taskApplication.statusRegistry,
      options?.saveSettings ?? (async () => {}),
      stubProjectStore(),
      stubProjectManager(),
      taskApplication.tasks,
    );
    const el = freshContainer();
    panel.mount(el);
    return { panel, state, el };
  }

  function projectCaptureSuccess(): TaskCommandResult {
    return {
      type: 'ok',
      changed: true,
      outcome: {
        type: 'task',
        task: task({ title: 'Captured', source: { filePath: 'Projects/A.md', line: 1 } }),
      },
    };
  }

  async function projectCaptureHarness(
    implementation: TaskCreateSession['execute'] = async () => projectCaptureSuccess(),
  ): Promise<{
    panel: CenterPanel;
    state: AppState;
    container: HTMLElement;
    sessionExecute: ReturnType<typeof vi.fn<TaskCreateSession['execute']>>;
  }> {
    const app = await createAppWithFiles({ 'Projects/A.md': '# Project\n' });
    const state = new AppState();
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/A.md' });
    const queries = taskQueryApi({
      list: () => [
        task({ title: 'First project task', source: { filePath: 'Projects/A.md', line: 0 } }),
      ],
    });
    const sessionExecute = vi.fn<TaskCreateSession['execute']>(implementation);
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries,
      planCreate: vi.fn(async () => ({
        type: 'ready' as const,
        destination: { filePath: 'Projects/A.md', insertion: { type: 'append' as const } },
        execute: sessionExecute,
      })),
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
      statusId: expectDefined(DEFAULT_SETTINGS.projects.statuses[0]).id,
      rawStatus: null,
      stats: { total: 1, done: 0, cancelled: 0, inProgress: 0 },
    };
    const projectStore = {
      list: () => [project],
      get: () => project,
      activeForLeftPanel: () => [project],
      onUpdate: () => () => {},
      onSourceObservation: () => () => {},
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
    state.set('mode', 'projects');
    return { panel, state, container, sessionExecute };
  }

  it('mounts the projects panel on a child host, not the shared center element', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    // The projects panel class lives on the child host, never on the center el.
    expect(el.classList.contains('abyss-projects-panel')).toBe(false);
    expect(el.querySelector('.abyss-projects-host .abyss-projects-table')).toBeTruthy();
  });

  it('forwards the static settings save callback to project column type actions', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.table.columns.push({ id: 'property:Priority', visible: true });
    settings.projects.propertyDefinitions['property:Priority'] = { type: 'text' };
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const { state, el } = await makeProjectsPanel({ settings, saveSettings });
    state.set('mode', 'projects');
    expectDefined(
      el.querySelector<HTMLElement>(
        '.abyss-project-table-header-cell[data-column-id="property:Priority"]',
      ),
    ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const shown = expectDefined(show.mock.instances[show.mock.instances.length - 1]) as Menu;
    const typeMenu = (
      shown as unknown as {
        menuItems__: Array<{ title__: string; submenu: Menu | null }>;
      }
    ).menuItems__.find(({ title__ }) => title__ === 'Property type')?.submenu;
    const numberAction = (
      expectDefined(typeMenu) as unknown as {
        menuItems__: Array<{
          title__: string;
          onClick__: ((event: MouseEvent | KeyboardEvent) => void) | null;
        }>;
      }
    ).menuItems__.find(({ title__ }) => title__ === 'Number')?.onClick__;
    expectDefined(numberAction)(new MouseEvent('click'));
    await flushMicrotasks();

    expect(expectDefined(settings.projects.propertyDefinitions['property:Priority']).type).toBe(
      'number',
    );
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('leaving projects mode restores a clean tasks center (no leaked class or DOM)', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    // Back to tasks with a tag selection.
    state.set('selectedList', { type: 'tag', tag: '#work' });
    returnToTasksMode(state);
    expect(el.classList.contains('abyss-projects-panel')).toBe(false);
    expect(el.classList.contains('abyss-center--projects')).toBe(false);
    expect(el.querySelector('.abyss-projects-host')).toBeNull();
    // Normal tasks-mode header (title + controls) renders again.
    expect(el.querySelector('.abyss-center-header')).toBeTruthy();
    expect(el.querySelector('.abyss-center-scroll')).toBeTruthy();
  });

  it('leaving projects mode for Calendar removes the project mode class', async () => {
    const { state, el } = await makeProjectsPanel();
    state.set('mode', 'projects');
    expect(el.classList.contains('abyss-center--projects')).toBe(true);

    state.set('mode', 'calendar');

    expect(el.classList.contains('abyss-center--projects')).toBe(false);
    expect(el.classList.contains('abyss-center--calendar')).toBe(true);
  });

  it('restores project trigger on Escape and preserves blur focus semantics', async () => {
    const { panel, container, sessionExecute } = await projectCaptureHarness();
    const next = activeDocument.body.createEl('button', { text: 'Next project control' });
    try {
      const trigger = expectDefined(
        container.querySelector<HTMLButtonElement>('.abyss-add-task-trigger'),
      );
      const escaped = await openListCapture(container);
      escaped.focus();
      pressCaptureKey(escaped, 'Escape');

      expect(trigger.hidden).toBe(false);
      expect(activeDocument.activeElement).toBe(trigger);

      const empty = await openListCapture(container);
      empty.focus();
      next.focus();
      await flushMicrotasks();

      expect(sessionExecute).not.toHaveBeenCalled();
      expect(container.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(next);

      const blurred = await openListCapture(container);
      setCaptureDraft(blurred, 'project blur task');
      blurred.focus();
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

  it('keeps a failed project Enter open and leaves composing keys to the IME', async () => {
    const failure: TaskCommandResult = {
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    };
    const { panel, container, sessionExecute } = await projectCaptureHarness(async () => failure);
    try {
      const input = await openListCapture(container);
      setCaptureDraft(input, 'project repair draft');
      const composingEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      const legacyEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(legacyEscape, 'keyCode', { configurable: true, value: 229 });
      input.dispatchEvent(composingEnter);
      input.dispatchEvent(legacyEscape);
      await flushMicrotasks();

      expect(sessionExecute).not.toHaveBeenCalled();
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(input);
      expect(input.value).toBe('project repair draft');

      pressCaptureKey(input, 'Enter');
      await flushMicrotasks();

      const error = input
        .closest('.abyss-capture-surface')
        ?.querySelector<HTMLElement>('.abyss-capture-error');
      expect(sessionExecute).toHaveBeenCalledOnce();
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(input);
      expect(input.value).toBe('project repair draft');
      expect(error?.hidden).toBe(false);
      expect(input.getAttribute('aria-describedby')).toContain(error?.id);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('opens project inline capture without adding a visual bar row or moving its task scroll', async () => {
    const { panel, container } = await projectCaptureHarness();
    try {
      const scroll = expectDefined(
        container.querySelector<HTMLElement>('.abyss-project-tasks-scroll'),
      );
      const card = expectDefined(scroll.querySelector<HTMLElement>('.abyss-task-card'));
      const bar = expectDefined(container.querySelector<HTMLElement>('.abyss-add-task-bar'));
      scroll.scrollTop = 29;
      const rectForCurrentBar = (): DOMRect => {
        const visibleRows = visibleChildren(bar).length;
        return {
          x: 0,
          y: 51 + visibleRows * 24,
          top: 51 + visibleRows * 24,
          right: 100,
          bottom: 71 + visibleRows * 24,
          left: 0,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        };
      };
      vi.spyOn(card, 'getBoundingClientRect').mockImplementation(rectForCurrentBar);
      const beforeTop = card.getBoundingClientRect().top;

      await openListCapture(container);

      expect(card.getBoundingClientRect().top).toBe(beforeTop);
      expect(visibleChildren(bar)).toHaveLength(1);
      expect(scroll.scrollTop).toBe(29);
    } finally {
      panel.destroy();
      container.remove();
    }
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
      statusId: expectDefined(DEFAULT_SETTINGS.projects.statuses[0]).id,
      rawStatus: null,
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0 },
    };
    const projectStore = {
      list: () => [project],
      get: () => project,
      activeForLeftPanel: () => [project],
      onUpdate: () => () => {},
      onSourceObservation: () => () => {},
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
      const trigger = expectDefined(
        container.querySelector<HTMLButtonElement>('.abyss-add-task-trigger'),
      );
      expect(trigger.isConnected).toBe(true);
      expect(trigger.hidden).toBe(true);
      expect(
        first
          .closest('.abyss-capture-surface')
          ?.classList.contains('abyss-capture-surface--inline'),
      ).toBe(true);
      expect(trigger.parentElement?.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
      first.focus();
      setCaptureDraft(first, 'first project task');
      pressCaptureKey(first, 'Enter');
      await flushMicrotasks();
      expect(container.querySelector('.abyss-quick-capture-input')).toBe(first);

      state.set('centerFilter', 'force project rerender');
      const remounted = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
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
    (panel as unknown as { calDate_abyssPrivate: moment.Moment }).calDate_abyssPrivate =
      moment('2026-08-09');

    state.set('mode', 'calendar');

    const forecastBadge = expectDefined(
      el.querySelector<HTMLElement>("[data-recurrence-forecast='true']"),
    );
    const item = expectDefined(forecastBadge.parentElement);
    expect(item.getAttribute('draggable')).toBeNull();
    item.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    expect(state.get('draggingTaskNode')).toBeNull();
    item
      .querySelector<HTMLElement>('.abyss-status-marker')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(execute).not.toHaveBeenCalled();

    clickCalendarView(el, 'Day');
    const timedForecastBadge = expectDefined(
      el.querySelector<HTMLElement>(".abyss-tg-block [data-recurrence-forecast='true']"),
    );
    const timedBlock = expectDefined(timedForecastBadge.closest<HTMLElement>('.abyss-tg-block'));
    expect(timedBlock.querySelector('.abyss-status-marker')).toBeNull();
    expect(timedBlock.getAttribute('tabindex')).toBeNull();
    expect(timedBlock.querySelector('[data-resize-edge]')).toBeNull();
    timedBlock.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(execute).not.toHaveBeenCalled();
    const spanBadge = expectDefined(
      el.querySelector<HTMLElement>(".abyss-tg-body [data-recurrence-forecast='true']"),
    );
    const spanBody = expectDefined(spanBadge.closest<HTMLElement>('.abyss-tg-body'));
    expect(spanBody.getAttribute('draggable')).toBeNull();
    expect(spanBody.querySelector('[data-resize-edge]')).toBeNull();
    for (const source of [timedBlock, spanBody]) {
      source.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
      expect(state.get('draggingTaskNode')).toBeNull();
    }
    panel.destroy();
  });

  it('keeps a projected forecast non-draggable when rendered through the shared center card', () => {
    const root = task({
      title: 'Forecast',
      recurrence: 'every day',
      planning: { due: '2026-08-08' },
    });
    const source = { root, node: root, target: { type: 'task' as const, ref: root.ref } };
    const projected = projectCalendarOccurrences(
      { materialized: [], recurringSources: [source] },
      { from: localDate('2026-08-09'), to: localDate('2026-08-09') },
      { removeScheduledDate: false },
    );
    const forecast = taskSnapshotForCalendarOccurrence(expectDefined(projected.occurrences[0]));
    const state = new AppState();
    state.set('selectedList', { type: 'project', path: root.ref.filePath });
    const panel = makeStaticPanel(state, [forecast]);
    const el = freshContainer();
    panel.mount(el);
    const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
    expect(card.getAttribute('draggable')).toBeNull();
    card.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    expect(state.get('draggingTaskNode')).toBeNull();
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
      dependsOn: [],
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
      (panel as unknown as { taskModal_abyssPrivate: { open(task: TaskSnapshot): void } })
        .taskModal_abyssPrivate,
      'open',
    );
    (panel as unknown as { calDate_abyssPrivate: moment.Moment }).calDate_abyssPrivate =
      moment('2026-08-09');
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
    const date = expectDefined(cell.getAttribute('data-mg-date'));
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
        const anchor = expectDefined(harness.el.querySelector<HTMLElement>(anchorSelector));
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
        expectDefined(
          selected.el.querySelector<HTMLElement>(`${pickerSelector} ${optionSelector}`),
        ).click();
        expect(selected.anchor.getAttribute('aria-expanded')).toBe('false');
        expect(wasRemoved(expectDefined(selected.registration))).toBe(true);
        selected.panel.destroy();
        selected.el.remove();

        const toggled = await openHarness();
        toggled.anchor.click();
        expect(toggled.el.querySelector(pickerSelector)).toBeNull();
        expect(toggled.anchor.getAttribute('aria-expanded')).toBe('false');
        expect(wasRemoved(expectDefined(toggled.registration))).toBe(true);
        toggled.panel.destroy();
        toggled.el.remove();

        const destroyed = await openHarness();
        destroyed.panel.destroy();
        expect(destroyed.anchor.getAttribute('aria-expanded')).toBe('false');
        expect(wasRemoved(expectDefined(destroyed.registration))).toBe(true);
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
        expectDefined(el.querySelector<HTMLElement>(anchorSelector)).click();
        expectDefined(el.querySelector<HTMLElement>(optionSelector)).click();
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
        const anchor = expectDefined(el.querySelector<HTMLElement>(anchorSelector));
        expect(anchor.getAttribute('aria-haspopup')).toBe('dialog');
        expect(anchor.getAttribute('aria-expanded')).toBe('false');
        anchor.focus();
        anchor.click();
        expect(anchor.getAttribute('aria-expanded')).toBe('true');

        const picker = expectDefined(el.querySelector<HTMLElement>(pickerSelector));
        const selected = expectDefined(
          picker.querySelector<HTMLElement>(`${optionSelector}.is-active`),
        );
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
        const reopenedPicker = expectDefined(el.querySelector<HTMLElement>(pickerSelector));
        const reopenedSelected = expectDefined(
          reopenedPicker.querySelector<HTMLElement>(`${optionSelector}.is-active`),
        );
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

    const flagBtn = expectDefined(popover).querySelector(
      '.abyss-status-popover-flag[data-abyss-priority="A"]',
    ) as HTMLElement;
    expect(flagBtn).not.toBeNull();
    flagBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushMicrotasks();

    const content = await readMd(app, 't.md');
    expect(content).toContain('🔺');
  });
});

async function makeReactiveCalendarPanel(): Promise<{
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

describe('CenterPanel calendar mode — scroll-to-now dedup (Task 27)', () => {
  function lastShouldScrollToNow(spy: { mock: { calls: unknown[][] } }): unknown {
    const calls = spy.mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[3];
  }

  it('switching into Week view for the first time scrolls (shouldScrollToNow=true)', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el } = await makeReactiveCalendarPanel();
    clickCalendarView(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    renderSpy.mockRestore();
  });

  it('a reactive task-index update patches the same view/date without rendering or scrolling again', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const patchSpy = vi.spyOn(WeekTimeGridView.prototype, 'patch');
    const { el, index, tasks } = await makeReactiveCalendarPanel();
    clickCalendarView(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    const renderCalls = renderSpy.mock.calls.length;

    const seededTask = expectDefined(index.list({ filePath: 't.md' })[0]);
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
    const { el } = await makeReactiveCalendarPanel();

    clickCalendarView(el, 'Week');
    expect(lastShouldScrollToNow(weekSpy)).toBe(true);

    clickCalendarView(el, 'Day');
    expect(lastShouldScrollToNow(todaySpy)).toBe(true);

    clickCalendarView(el, 'Week');
    expect(lastShouldScrollToNow(weekSpy)).toBe(true);

    weekSpy.mockRestore();
    todaySpy.mockRestore();
  });

  it('navigating to a different date (next week) scrolls again, since it is a new pair', async () => {
    const renderSpy = vi.spyOn(WeekTimeGridView.prototype, 'render');
    const { el } = await makeReactiveCalendarPanel();
    clickCalendarView(el, 'Week');
    expect(lastShouldScrollToNow(renderSpy)).toBe(true);

    const nextBtn = el.querySelector('.abyss-cal-nav-btn[aria-label="Next"]') as HTMLElement;
    expect(nextBtn).not.toBeNull();
    nextBtn.click();

    expect(lastShouldScrollToNow(renderSpy)).toBe(true);
    renderSpy.mockRestore();
  });

  it("Round 2 Task 16's periodic now-line interval remains registered across a query patch", async () => {
    const { el, index, tasks } = await makeReactiveCalendarPanel();
    clickCalendarView(el, 'Week');

    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const seededTask = expectDefined(index.list({ filePath: 't.md' })[0]);
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
  it('patches only the task layer on a query notification while retaining the calendar skeleton, view instance, and scroll position', async () => {
    const { panel, el, index, tasks } = await makeReactiveCalendarPanel();
    clickCalendarView(el, 'Week');
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
        calViewInstance_abyssPrivate: TimeGridViewInstance;
      }
    ).calViewInstance_abyssPrivate;
    expect(gridRowEl).not.toBeNull();
    gridRowEl.scrollTop = 777;

    const seededTask = expectDefined(index.list({ filePath: 't.md' })[0]);
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
          calViewInstance_abyssPrivate: TimeGridViewInstance;
        }
      ).calViewInstance_abyssPrivate,
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
    const { el } = await makeReactiveCalendarPanel();
    clickCalendarView(el, 'Week');

    const gridRowEl = el.querySelector('.abyss-tg-grid-row') as HTMLElement;
    gridRowEl.scrollTop = 777;

    // Genuine navigation: switching view type is a new (viewType, date) pair, so
    // shouldScrollToNow is true here and must take priority over any stale prior scrollTop.
    clickCalendarView(el, 'Day');

    const newGridRowEl = el.querySelector('.abyss-tg-grid-row') as HTMLElement;
    expect(newGridRowEl).not.toBeNull();
    expect(newGridRowEl).not.toBe(gridRowEl);
    // Must NOT equal the stale Week-view scrollTop (777) it never asked to inherit.
    expect(newGridRowEl.scrollTop).not.toBe(777);
  });

  it('switching from Month (no grid-row) into Week does not error and scrolls to now as a fresh navigation', async () => {
    const { el } = await makeReactiveCalendarPanel();
    // Default calViewType is 'month' — no `.abyss-tg-grid-row` exists yet.
    expect(el.querySelector('.abyss-tg-grid-row')).toBeNull();

    clickCalendarView(el, 'Week');
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

  function sharedCalendarCaptureHarness(implementation: () => Promise<TaskCommandResult>): {
    readonly panel: CenterPanel;
    readonly el: HTMLElement;
    readonly planCreate: Mock<TaskCaptureApplicationApi['planCreate']>;
    readonly sessionExecute: Mock<TaskCreateSession['execute']>;
    emitQueryChange(): void;
  } {
    const listeners = new Set<(event: TaskIndexEvent) => void>();
    const queries = taskQueryApi({
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sessionExecute = vi.fn<TaskCreateSession['execute']>(implementation);
    const planCreate = vi.fn<TaskCaptureApplicationApi['planCreate']>(async () => ({
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
      const cell = expectDefined(
        el.querySelector<HTMLElement>('.abyss-mg-cell:not(.is-outside-month)[data-mg-date]'),
      );
      date = expectDefined(cell.dataset['mgDate']);
      expectDefined(cell.querySelector<HTMLElement>('.abyss-mg-add-btn')).click();
      wrapperSelector = '.abyss-mg-quick-add';
    } else if (kind === 'all-day') {
      const cell = expectDefined(
        el.querySelector<HTMLElement>('.abyss-tg-allday-cell[data-tg-date]'),
      );
      date = expectDefined(cell.dataset['tgDate']);
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      wrapperSelector = '.abyss-tg-allday-quick-add';
    } else {
      const day = expectDefined(
        el.querySelector<HTMLElement>('.abyss-tg-day-column[data-tg-date]'),
      );
      const hourColumn = expectDefined(day.querySelector<HTMLElement>('.abyss-tg-hour-column'));
      date = expectDefined(day.dataset['tgDate']);
      time = '10:00';
      vi.spyOn(hourColumn, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
      } as DOMRect);
      hourColumn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 480 }));
      wrapperSelector = '.abyss-tg-quick-add';
    }

    await flushMicrotasks();
    const wrapper = expectDefined(el.querySelector<HTMLElement>(wrapperSelector));
    const input = wrapper.querySelector<HTMLInputElement>('.abyss-capture-input');
    if (input == null) throw new Error(`${kind} shared capture did not open`);
    return { input, wrapper, date, ...(time !== undefined && { time }) };
  }

  it.each(['month', 'timed', 'all-day'] as const)(
    '%s capture freezes its date/time and keeps one session across consecutive Enter successes',
    async (kind) => {
      const { panel, el, planCreate, sessionExecute } = sharedCalendarCaptureHarness(async () =>
        successfulCapture(),
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
        if (kind === 'month') expectDefined(positionedParent).dataset['mgDate'] = '2099-12-31';
        else expectDefined(positionedParent).dataset['tgDate'] = '2099-12-31';

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

  it('gives explicit calendar placements truthful labels and due/time values', () => {
    const { panel, el } = sharedCalendarCaptureHarness(async () => successfulCapture());
    const calendarTarget: CaptureTarget = {
      label: 'Today · today',
      context: { type: 'default', source: 'calendar' },
      session: {
        type: 'ready',
        destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
        execute: vi.fn(),
      },
      markdownPrefix: '',
      markdownSuffixes: [],
      initial: { due: { type: 'set', value: localDate('2026-08-24') } },
    };

    try {
      const month = call<CaptureTarget>(panel, 'targetForCapturePlacement', calendarTarget, {
        type: 'calendar-month',
        date: '2026-09-03',
      }) as CaptureTarget;
      const timed = call<CaptureTarget>(panel, 'targetForCapturePlacement', calendarTarget, {
        type: 'calendar-timed',
        date: '2026-09-04',
        time: '10:00',
      }) as CaptureTarget;
      const allDay = call<CaptureTarget>(panel, 'targetForCapturePlacement', calendarTarget, {
        type: 'calendar-all-day',
        date: '2026-09-05',
      }) as CaptureTarget;

      expect(month.label).toBe('2026-09-03 · all day');
      expect(month.initial).toEqual({
        due: { type: 'set', value: localDate('2026-09-03') },
      });
      expect(timed.label).toBe('2026-09-04 · 10:00');
      expect(timed.initial).toEqual({
        due: { type: 'set', value: localDate('2026-09-04') },
        time: { type: 'set', value: localTime('10:00') },
      });
      expect(allDay.label).toBe('2026-09-05 · all day');
      expect(allDay.initial).toEqual({
        due: { type: 'set', value: localDate('2026-09-05') },
      });
      expect(calendarTarget.label).toBe('Today · today');
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it.each(['month', 'timed', 'all-day'] as const)(
    '%s capture portals destination, pending, and error feedback outside the clipping calendar cell',
    async (kind) => {
      const result = deferred<TaskCommandResult>();
      const { panel, el } = sharedCalendarCaptureHarness(() => result.promise);
      try {
        const opened = await openCalendarCapture(el, kind);
        const feedback = expectDefined(
          el.querySelector<HTMLElement>('.abyss-calendar-capture-feedback'),
        );
        expect(feedback).not.toBeNull();
        expect(opened.wrapper.contains(feedback)).toBe(false);
        expect(feedback.querySelector('.abyss-capture-destination')).not.toBeNull();
        expect(feedback.querySelector('.abyss-capture-pending')).not.toBeNull();
        expect(feedback.querySelector('.abyss-capture-error')).not.toBeNull();
        expect(opened.input.getAttribute('aria-describedby')).toContain(
          expectDefined(feedback.querySelector<HTMLElement>('.abyss-capture-destination')).id,
        );

        setCaptureDraft(opened.input, 'pending calendar task');
        pressCaptureKey(opened.input, 'Enter');
        expect(feedback.querySelector<HTMLElement>('.abyss-capture-pending')?.hidden).toBe(false);

        result.resolve({
          type: 'io-error',
          cause: 'repository-error',
          contentState: 'unknown',
        });
        await flushMicrotasks();
        expect(feedback.querySelector<HTMLElement>('.abyss-capture-error')?.hidden).toBe(false);
        expect(feedback.textContent).toContain('Failed to create task');
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
      const captureHarness = sharedCalendarCaptureHarness(() => result.promise);
      const { panel, el, sessionExecute } = captureHarness;
      const emitQueryChange = methodOf(captureHarness, 'emitQueryChange');
      try {
        const opened = await openCalendarCapture(el, kind);
        setCaptureDraft(opened.input, 'repair this calendar task');
        opened.input.focus();
        pressCaptureKey(opened.input, 'Enter');
        pressCaptureKey(opened.input, 'Escape');
        expect(opened.input.readOnly).toBe(true);

        emitQueryChange();
        const afterQuery = expectDefined(
          el.querySelector<HTMLInputElement>('.abyss-capture-input'),
        );
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
        const afterFullRender = expectDefined(
          el.querySelector<HTMLInputElement>('.abyss-capture-input'),
        );
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
        successfulCapture(),
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
        calViewInstance_abyssPrivate: TodayView | WeekTimeGridView | null;
      }
    ).calViewInstance_abyssPrivate;
    const date = expectDefined(cell.getAttribute('data-mg-date'));
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
          calViewInstance_abyssPrivate: TodayView | WeekTimeGridView | null;
        }
      ).calViewInstance_abyssPrivate,
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
    const date = expectDefined(
      (el.querySelector('.abyss-tg-day-column') as HTMLElement).getAttribute('data-tg-date'),
    );
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
    const date = expectDefined(
      (el.querySelector('.abyss-tg-day-column') as HTMLElement).getAttribute('data-tg-date'),
    );
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
    const date = expectDefined(alldayCell.getAttribute('data-tg-date'));
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
  ...[
    date,
    time = '09:00',
    filePath = 'Folder/[qa] "task".md',
    revision = 'revision-1',
    line = 0,
  ]: readonly [date: string, time?: string, filePath?: string, revision?: string, line?: number]
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
  const el = ownerDocument.body.createDiv();
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

function clickCalendarView(el: HTMLElement, label: CalendarViewLabel): void {
  const button = Array.from(el.querySelectorAll<HTMLElement>('.abyss-cal-view-btn')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button == null) throw new Error(`missing ${label} calendar view button`);
  button.click();
}

function timedBlock(el: HTMLElement, filePath?: string): HTMLElement {
  const blocks = Array.from(el.querySelectorAll<HTMLElement>('.abyss-tg-block'));
  const found =
    filePath !== undefined && filePath.length > 0
      ? blocks.find((block) => block.dataset['abyssTaskFile'] === filePath)
      : blocks[0];
  if (found == null)
    throw new Error(
      filePath !== undefined && filePath.length > 0
        ? `missing timed block for ${filePath}`
        : 'missing timed block',
    );
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
      const marker = expectDefined(
        h.el.querySelector<HTMLElement>(
          '.abyss-mg-plain .abyss-status-marker, .abyss-mg-deadline-marker .abyss-status-marker',
        ),
      );
      (
        h.panel as unknown as {
          openRecurrenceEditor_abyssPrivate(anchor: HTMLElement, task: TaskSnapshot): void;
        }
      ).openRecurrenceEditor_abyssPrivate(marker, original);
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
      const marker = expectDefined(
        h.el.querySelector<HTMLElement>(
          '.abyss-mg-plain .abyss-status-marker, .abyss-mg-deadline-marker .abyss-status-marker',
        ),
      );
      (
        h.panel as unknown as {
          openRecurrenceEditor_abyssPrivate(anchor: HTMLElement, task: TaskSnapshot): void;
        }
      ).openRecurrenceEditor_abyssPrivate(marker, recurring);
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
      if (hour == null) throw new Error('missing hour column');
      hour.getBoundingClientRect = methodOf(day, 'getBoundingClientRect');
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
      if (block == null) throw new Error(`missing timed segment ${date}`);
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
    if (outgoing == null) throw new Error('missing pre-due ghost');
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
        calDate_abyssPrivate: ReturnType<typeof moment>;
        render_abyssPrivate(): void;
      };
      calendar.calDate_abyssPrivate = moment('2026-07-06', 'YYYY-MM-DD');
      calendar.render_abyssPrivate();

      const outgoing = h.el.querySelector<HTMLElement>(
        `.abyss-tg-block-continuation[data-tg-segment-date="${focusedDate}"]`,
      );
      if (outgoing == null) throw new Error(`missing outgoing timed ghost ${focusedDate}`);
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
      if (preEventCandidate != null) expect(replacement).not.toBe(preEventCandidate);
      await vi.waitFor(() => {
        expect(h.el.ownerDocument.activeElement).toBe(replacement);
      });

      h.panel.destroy();
      h.el.remove();
    },
  );

  it('uses the mounted popout document for command origin and restoration through remount', async () => {
    const iframe = activeDocument.body.createEl('iframe');
    const foreignDocument = iframe.contentDocument;
    const foreignWindow = iframe.contentWindow;
    if (foreignDocument == null || foreignWindow == null) throw new Error('missing iframe realm');
    const foreignRealm = foreignWindow as unknown as typeof window;
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
        if (descriptor != null) Object.defineProperty(target, name, descriptor);
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
      const child = this.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', tag);
      const classes = Array.isArray(options.cls) ? options.cls : options.cls?.split(' ');
      if (classes != null) child.classList.add(...classes.filter(Boolean));
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
        value(
          this: HTMLElement,
          value:
            string | { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
        ) {
          return createEl.call(this, 'div', typeof value === 'string' ? { cls: value } : value);
        },
      },
      createSpan: {
        configurable: true,
        value(
          this: HTMLElement,
          value:
            string | { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
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
      expect(block).not.toBeInstanceOf(HTMLElement);
      expect(block).toBeInstanceOf(foreignRealm.HTMLElement);
      block.focus();
      expect(foreignDocument.activeElement).toBe(block);
      press(block, 'ArrowDown');
      expect(execute).toHaveBeenCalledOnce();
      const pendingFocus = (
        h.panel as unknown as {
          pendingTimedBlockFocus_abyssPrivate?: { readonly originElement?: HTMLElement };
        }
      ).pendingTimedBlockFocus_abyssPrivate;
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

    expectDefined(h.el.ownerDocument.defaultView).dispatchEvent(new Event('blur'));
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
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      const revision = `revision-${execute.mock.calls.length + 1}`;
      const isTaskPatch = command.type === 'patch' && command.target.type === 'task';
      const nextTime =
        isTaskPatch && command.patch.time?.type === 'set'
          ? command.patch.time.value
          : current.planning.time;
      const nextDuration =
        isTaskPatch && 'duration' in command.patch && command.patch.duration.type === 'set'
          ? command.patch.duration.value
          : current.planning.duration;
      current = task({
        ...current,
        ref: { ...current.ref, revision },
        planning: {
          ...current.planning,
          ...(nextTime === undefined ? {} : { time: nextTime }),
          ...(nextDuration === undefined ? {} : { duration: nextDuration }),
        },
      });
      h.setSnapshots([current]);
      h.emit();
      return okTask(current);
    });
    const h = keyboardPanelHarness([current], execute);
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
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      h.setSnapshots([updated]);
      h.emit();
      return okTask(updated);
    });
    const h = keyboardPanelHarness([original], execute);
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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
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
    await vi.waitFor(() => {
      expect(activeDocument.activeElement).toBe(timedBlock(h.el));
    });
    patch.mockRestore();
  });

  it('keeps Week anchored for an in-range move and follows only after crossing its visible edge', async () => {
    const weekStart = moment().startOf('isoWeek');
    const inside = localDate(weekStart.clone().add(2, 'days').format('YYYY-MM-DD'));
    const nextInside = localDate(weekStart.clone().add(3, 'days').format('YYYY-MM-DD'));
    const edge = localDate(weekStart.clone().add(6, 'days').format('YYYY-MM-DD'));
    const outside = localDate(weekStart.clone().add(7, 'days').format('YYYY-MM-DD'));
    let current = keyboardSnapshot(inside);
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
    const h = keyboardPanelHarness([current], execute);
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
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async () => {
      h.setSnapshots([updated]);
      h.emit();
      return okTask(updated);
    });
    const h = keyboardPanelHarness([original], execute);
    clickCalendarView(h.el, 'Week');
    const calendar = h.panel as unknown as {
      calDate_abyssPrivate: ReturnType<typeof moment>;
      render_abyssPrivate(): void;
    };
    calendar.calDate_abyssPrivate = moment('2025-12-29', 'YYYY-MM-DD');
    calendar.render_abyssPrivate();

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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
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

    const other = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
    const toolbarControl = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
    const externalControl = activeDocument.body.createEl('button');
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
    if (registration == null) throw new Error('missing CenterPanel focusin registration');
    clickCalendarView(h.el, 'Day');

    const iframe = activeDocument.body.createEl('iframe');
    const foreignDocument = iframe.contentDocument;
    const foreignWindow = iframe.contentWindow;
    if (foreignDocument == null || foreignWindow == null) throw new Error('missing iframe realm');
    const externalControl = foreignDocument.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'button',
    );
    foreignDocument.body.append(externalControl);
    expect(externalControl).not.toBeInstanceOf(HTMLElement);

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
            type === 'focusin' && listener === registration?.[1] && options === registration[2],
        ),
      ).toBe(true);
      expect(
        removeWindowSpy.mock.calls.some(
          ([type, listener, options]) =>
            type === 'blur' &&
            listener === blurRegistration?.[1] &&
            options === blurRegistration[2],
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

    const nav = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
        calViewType_abyssPrivate: 'today';
        calDate_abyssPrivate: ReturnType<typeof moment>;
      };
      calendar.calViewType_abyssPrivate = 'today';
      calendar.calDate_abyssPrivate = moment(date, 'YYYY-MM-DD');
      h.panel.refresh();

      const block = timedBlock(h.el);
      block.focus();
      press(block, key, true);
      expect(execute).not.toHaveBeenCalled();
      const other = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
        calViewType_abyssPrivate: 'today';
        calDate_abyssPrivate: ReturnType<typeof moment>;
      };
      calendar.calViewType_abyssPrivate = 'today';
      calendar.calDate_abyssPrivate = moment(date, 'YYYY-MM-DD');
      h.panel.refresh();

      const block = timedBlock(h.el);
      block.focus();
      press(block, 'ArrowDown');
      press(block, key, true);
      expect(execute).toHaveBeenCalledOnce();
      pending.resolve(okTaskUnchanged(snapshot));
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledOnce();

      const nav = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });

    h.setSnapshots([boundary]);
    h.emit();
    await flushMicrotasks();
    const restored = timedBlock(h.el);
    expect(activeDocument.activeElement).toBe(restored);
    press(restored, 'ArrowUp');

    second.resolve(okTaskUnchanged(boundary));
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(3);
    });
    third.resolve(okTaskUnchanged(boundary));
    await flushMicrotasks();

    const nav = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });

    h.setSnapshots([boundary]);
    h.emit();
    await flushMicrotasks();
    const restored = timedBlock(h.el);
    expect(activeDocument.activeElement).toBe(restored);
    press(restored, 'ArrowDown');

    second.resolve(okTaskUnchanged(boundary));
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(3);
    });
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

      const nav = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
    expectRootTaskPatch(expectDefined(execute.mock.calls[1]?.[0]), {
      line: 5,
      revision: 'revision-2',
    });

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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
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
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });

    h.setSnapshots([replacement, moved]);
    h.emit();
    await flushMicrotasks();
    const replacementBlock = expectDefined(
      Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-block')).find(
        (block) => block.dataset['abyssTaskLine'] === '4',
      ),
    );
    replacementBlock.focus();
    press(replacementBlock, 'ArrowDown');

    staleSecond.resolve(okTask(staleFinal));
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(3);
    });
    const replacementCommand = expectRootTaskPatch(expectDefined(execute.mock.calls[2]?.[0]), {
      line: 4,
      revision: 'shared-revision',
    });
    expect(replacementCommand.patch).toEqual({ time: { type: 'set', value: '14:15' } });

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

      const replacementBlock = expectDefined(
        Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-tg-block')).find(
          (block) => block.dataset['abyssTaskLine'] === '4',
        ),
      );
      expect(activeDocument.activeElement).not.toBe(replacementBlock);
      replacementBlock.focus();
      press(replacementBlock, 'ArrowDown');
      originalResult.resolve(okTask(moved));
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledTimes(2);
      });

      const replacementCommand = expectRootTaskPatch(expectDefined(execute.mock.calls[1]?.[0]), {
        line: 4,
        revision: replacementRevision,
      });
      expect(replacementCommand.patch).toEqual({ time: { type: 'set', value: '14:15' } });
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
      const other = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
    const other = expectDefined(h.el.querySelector<HTMLElement>('.abyss-cal-nav-today'));
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
