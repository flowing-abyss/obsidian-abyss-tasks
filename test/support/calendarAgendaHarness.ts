import type { App } from 'obsidian';
import { afterEach, vi } from 'vitest';
import { AppState } from '../../src/app/AppState';
import { CenterPanel } from '../../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { taskQueryApi, testStatusRegistry } from '../helpers';

const panels: CenterPanel[] = [];
afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
});

/** Uses the real CenterPanel adapter and retained card renderer; only command effects are spies. */
export function calendarAgendaHarness(state = new AppState()) {
  const panel = new CenterPanel({
    app: {} as App,
    state,
    settings: structuredClone(DEFAULT_SETTINGS),
    queries: taskQueryApi(),
    statusRegistry: testStatusRegistry(),
    onSaveSettings: async () => {},
  });
  panels.push(panel);
  const toggleTask = vi.spyOn(panel['taskCommands_abyssPrivate'], 'toggleTask').mockResolvedValue();
  const patchTaskTags = vi
    .spyOn(panel['taskCommands_abyssPrivate'], 'patchTaskTags')
    .mockResolvedValue();
  const editTaskLink = vi
    .spyOn(panel['taskCommands_abyssPrivate'], 'editTaskLink')
    .mockImplementation(() => {});
  const showTaskInList = vi.spyOn(panel, 'showTaskInList').mockResolvedValue();
  const host = panel['createCalendarHost_abyssPrivate']();
  host.tagGroups();
  return {
    panel,
    state,
    toggleTask,
    patchTaskTags,
    editTaskLink,
    showTaskInList,
    mountAgendaEntry: host.mountAgendaEntry,
  };
}
