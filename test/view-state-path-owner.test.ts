import { Notice, TFile, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { ViewStateWritesSuspendedError } from '../src/settings/persistence';
import type { CalendarSettings } from '../src/settings/types';
import { ViewStatePathOwner } from '../src/settings/ViewStatePathOwner';
import { createAppWithFiles } from './helpers';

const FILES = {
  'Projects/A.md': '',
  'Projects/B.md': '',
  'Projects/C.md': '',
  'Notes/Other.md': '',
  'Projects/image.png': '',
};

function rankedSettings(): CalendarSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.kanban = {
    ...buildDefaultProjectKanbanSettings(settings.projects.table),
    manualOrder: {
      'id:active': ['Projects/A.md', 'Projects/B.md'],
      'id:planned': ['Projects/C.md'],
    },
  };
  settings.listViewStates = {
    'project:Projects/A.md': getListViewDefaults('project:Projects/A.md'),
    'project:Projects/B.md': getListViewDefaults('project:Projects/B.md'),
  };
  return settings;
}

async function ownerFor(
  settings: CalendarSettings,
  save = vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
) {
  const app = await createAppWithFiles(FILES);
  const owner = new ViewStatePathOwner(settings, save);
  owner.listen(app.vault);
  return { app, owner, save };
}

function file(app: App, path: string): TFile {
  const found = app.vault.getAbstractFileByPath(path);
  if (!(found instanceof TFile)) throw new Error(`Missing ${path}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ViewStatePathOwner', () => {
  it('follows vault deletes and renames without a panel and saves once after 150 ms', async () => {
    const settings = rankedSettings();
    const { app, save } = await ownerFor(settings);

    await app.fileManager.trashFile(file(app, 'Projects/A.md'));
    await app.vault.rename(file(app, 'Projects/B.md'), 'Projects/B2.md');
    await vi.advanceTimersByTimeAsync(149);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledOnce();
    expect(settings.projects.kanban?.manualOrder).toEqual({
      'id:active': ['Projects/B2.md'],
      'id:planned': ['Projects/C.md'],
    });
    expect(Object.keys(settings.listViewStates ?? {})).toEqual(['project:Projects/B2.md']);
  });

  it('saves once for a burst in one turn and across turns inside 150 ms', async () => {
    const { app, save } = await ownerFor(rankedSettings());

    await Promise.all([
      app.fileManager.trashFile(file(app, 'Projects/A.md')),
      app.fileManager.trashFile(file(app, 'Projects/C.md')),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await app.vault.rename(file(app, 'Projects/B.md'), 'Projects/B2.md');
    await vi.advanceTimersByTimeAsync(149);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledOnce();
  });

  it('saves nothing for unrelated notes, attachments, folders, or absent saved state', async () => {
    const settings = rankedSettings();
    const manualOrder = settings.projects.kanban?.manualOrder;
    const listViewStates = settings.listViewStates;
    const { app, save } = await ownerFor(settings);

    await app.vault.rename(file(app, 'Notes/Other.md'), 'Notes/Renamed.md');
    await app.fileManager.trashFile(file(app, 'Notes/Renamed.md'));
    await app.fileManager.trashFile(file(app, 'Projects/image.png'));
    await app.fileManager.trashFile(await app.vault.createFolder('Empty'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(save).not.toHaveBeenCalled();
    expect(settings.projects.kanban?.manualOrder).toBe(manualOrder);
    expect(settings.listViewStates).toBe(listViewStates);

    const bare = structuredClone(DEFAULT_SETTINGS);
    const other = await ownerFor(bare);
    await other.app.fileManager.trashFile(file(other.app, 'Projects/A.md'));
    await other.app.vault.rename(file(other.app, 'Projects/B.md'), 'Projects/B2.md');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(other.save).not.toHaveBeenCalled();
    expect(bare.projects.kanban).toBeUndefined();
    expect(bare.listViewStates).toBeUndefined();
  });

  it('cancels and flushes a pending save and leaves no timer behind', async () => {
    const { app, owner, save } = await ownerFor(rankedSettings());
    const timersBefore = vi.getTimerCount();

    await app.fileManager.trashFile(file(app, 'Projects/A.md'));
    owner.cancelPendingSave();
    await vi.advanceTimersByTimeAsync(150);
    expect(save).not.toHaveBeenCalled();

    await app.fileManager.trashFile(file(app, 'Projects/C.md'));
    owner.flushPendingSave();
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(save).toHaveBeenCalledOnce();

    owner.flushPendingSave();
    owner.cancelPendingSave();
    expect(save).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('logs a failed save once without a Notice and stays silent for suspended writes', async () => {
    const error = new Error('disk full');
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(new ViewStateWritesSuspendedError());
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notices = vi.spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown, duration?: number): void },
      'constructor__',
    );
    const { app } = await ownerFor(rankedSettings(), save);

    await app.fileManager.trashFile(file(app, 'Projects/A.md'));
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not save view state after a note change',
      error,
    );

    await app.fileManager.trashFile(file(app, 'Projects/C.md'));
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(notices).not.toHaveBeenCalled();
  });
});
