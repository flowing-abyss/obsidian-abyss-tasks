import type * as ObsidianModule from 'obsidian';
import { Notice } from 'obsidian';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ViewStateWritesSuspendedError } from '../src/settings/persistence';
import { reportSettingsDraftSaveFailure } from '../src/settings/settingsSaveFailure';
import { expectDefined } from './helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

const LOG_MESSAGE = '[abyss-tasks] Could not save project table settings';

// Every row reports one failure, and each ends with the exact log it expects.
let log: MockInstance<typeof console.error>;

beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function noticeFragment(): DocumentFragment {
  return vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment;
}

describe('reportSettingsDraftSaveFailure', () => {
  it('keeps one period after a cause that ends with one', () => {
    const failure = new Error('Disk is full.');

    reportSettingsDraftSaveFailure(
      { action: 'save project table settings', save: vi.fn().mockResolvedValue(undefined) },
      failure,
    );

    expect(noticeFragment().textContent).toBe(
      'Could not save project table settings: Disk is full. Changes are kept in this session. Retry',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(LOG_MESSAGE, { cause: failure });
  });

  it('keeps a cause without a period as it is and offers a persistent Retry that saves', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const failure = new Error('disk full');

    reportSettingsDraftSaveFailure({ action: 'save project table settings', save }, failure);

    expect(noticeFragment().textContent).toBe(
      'Could not save project table settings: disk full. Changes are kept in this session. Retry',
    );
    expect(vi.mocked(Notice).mock.calls[0]?.[1]).toBe(0);
    expectDefined(noticeFragment().querySelector('button')).click();
    expect(save).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(LOG_MESSAGE, { cause: failure });
  });

  it('reports suspended view-state writes once without a Retry', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const failure = new ViewStateWritesSuspendedError();

    reportSettingsDraftSaveFailure({ action: 'save project table settings', save }, failure);

    expect(Notice).toHaveBeenCalledExactlyOnceWith(
      'Could not save project table settings: Saved view state writes are suspended. Changes are kept in this session.',
    );
    expect(save).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(LOG_MESSAGE, { cause: failure });
  });
});
