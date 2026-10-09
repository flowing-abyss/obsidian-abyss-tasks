import type { App as ObsidianApp } from 'obsidian';
import type { AppState } from '../../src/app/AppState';
import type { CalendarCommands } from '../../src/panels/calendar/calendarCommands';
import type { CalendarMoment } from '../../src/panels/calendar/calendarDateNavigation';
import type { CalendarMode } from '../../src/panels/calendar/CalendarMode';
import type { CalendarViewInstance } from '../../src/panels/calendar/calendarViewFactory';
import type { CalViewType } from '../../src/panels/calendar/calendarViewType';
import type { CaptureSessions } from '../../src/panels/center/CaptureSessions';
import type { ListViewControls } from '../../src/panels/center/ListViewControls';
import type { TaskCommands } from '../../src/panels/center/TaskCommands';
import { CenterPanel } from '../../src/panels/CenterPanel';
import { LeftPanel } from '../../src/panels/LeftPanel';
import type { ProjectManager } from '../../src/projects/ProjectManager';
import type { ProjectStore } from '../../src/projects/ProjectStore';
import type { CalendarSettings } from '../../src/settings/types';
import type { TagManager } from '../../src/tags/TagManager';
import type { TaskApplicationApi } from '../../src/tasks';
import type { TrackingSurface } from '../../src/ui/timeTracking/TimeBadge';
import { expectDefined, type TestTaskHarness } from '../helpers';
import { useTaskPanelViewport } from './taskPanelViewport';

useTaskPanelViewport();

// The center and left panels built for tests, and the calendar state a center panel's calendar
// mode keeps. test/helpers.ts loads no presentation module, so a suite that builds a panel takes
// its harness from here.

type CenterPanelTestArgs = readonly [
  state: AppState,
  taskHarness: TestTaskHarness,
  app: ObsidianApp,
  settings: CalendarSettings,
  tagManager: TagManager,
  onSaveSettings?: () => Promise<void>,
  projectStore?: ProjectStore | null,
  projectManager?: ProjectManager | null,
  tasks?: TaskApplicationApi,
  timeTracking?: TrackingSurface,
];

export function makeCenterPanelForTest(
  ...[
    state,
    taskHarness,
    app,
    settings,
    _tagManager,
    onSaveSettings = async () => {},
    projectStore = null,
    projectManager = null,
    tasks,
    timeTracking,
  ]: CenterPanelTestArgs
): CenterPanel {
  const application = tasks ?? taskHarness;
  return new CenterPanel({
    state,
    app,
    settings,
    queries: taskHarness.queries,
    statusRegistry: taskHarness.statusRegistry,
    onSaveSettings,
    projectStore,
    projectManager,
    tasks: application,
    timeTracking,
  });
}

/** The centre list controls; callers use its public filters and popover API. */
export function listViewControlsOf(panel: CenterPanel): ListViewControls {
  return panel['listViewControls_abyssPrivate'];
}

/** The centre capture owner; callers use its typed public session API. */
export function captureSessionsOf(panel: CenterPanel): CaptureSessions {
  return panel['captureSessions_abyssPrivate'];
}

/** The centre command service; callers use its typed public submission API. */
export function taskCommandsOf(panel: CenterPanel): TaskCommands {
  return panel['taskCommands_abyssPrivate'];
}

/** The calendar controller a CenterPanel owns; tests reach calendar session state through it. */
export function calendarOf(panel: CenterPanel): CalendarMode {
  return panel['calendar_abyssPrivate'];
}

/** The calendar commands the panel's calendar mode owns; tests drive gestures through them. */
function calendarCommandsOf(panel: CenterPanel): CalendarCommands {
  return calendarOf(panel)['commands_abyssPrivate'];
}

/** Calls one calendar command by name on the commands the panel's calendar mode owns. */
export function calendarCommand<T>(
  panel: CenterPanel,
  method: string,
  ...args: unknown[]
): Promise<T> | T {
  const commands = calendarCommandsOf(panel) as unknown as Record<string, (...a: unknown[]) => T>;
  return expectDefined(commands[method]).call(commands, ...args);
}

/** The date the calendar shows, or will show on its next render. */
export function calendarDateOf(panel: CenterPanel): CalendarMoment {
  return calendarOf(panel)['date_abyssPrivate'];
}

/** Sets the calendar date without rendering; the next render or refresh shows it. */
export function setCalendarDate(panel: CenterPanel, date: CalendarMoment): void {
  calendarOf(panel)['date_abyssPrivate'] = date;
}

/** Sets the calendar view type without rendering and without moving the date. */
export function setCalendarViewType(panel: CenterPanel, view: CalViewType): void {
  calendarOf(panel)['viewType_abyssPrivate'] = view;
}

/** The mounted calendar view instance while calendar mode is rendered. */
export function calendarViewInstanceOf(panel: CenterPanel): CalendarViewInstance | null {
  return calendarOf(panel)['viewInstance_abyssPrivate'];
}

/** The timed-block focus the calendar is retaining across re-renders, if any. */
export function pendingTimedBlockFocusOf(
  panel: CenterPanel,
): { readonly originElement?: HTMLElement } | undefined {
  return calendarOf(panel)['focusRetention_abyssPrivate']['pendingFocus_abyssPrivate'];
}

type LeftPanelTestArgs = readonly [
  state: AppState,
  taskHarness: TestTaskHarness,
  settings: CalendarSettings,
  tagManager: TagManager,
  app: ObsidianApp,
  onSaveSettings?: () => Promise<void>,
  projectStore?: ProjectStore | null,
  projectManager?: ProjectManager | null,
  tasks?: TaskApplicationApi,
  onSaveViewState?: () => Promise<void>,
];

export function makeLeftPanelForTest(
  ...[
    state,
    taskHarness,
    settings,
    tagManager,
    app,
    ,
    projectStore = null,
    projectManager = null,
    tasks,
    onSaveViewState,
  ]: LeftPanelTestArgs
): LeftPanel {
  const application = tasks ?? taskHarness;
  return new LeftPanel({
    state,
    settings,
    tagManager,
    app,
    tasks: application,
    projectStore,
    projectManager,
    onSaveViewState,
  });
}
