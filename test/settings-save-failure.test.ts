import type * as ObsidianModule from 'obsidian';
import { Notice } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewStateWritesSuspendedError } from '../src/settings/persistence';
import { reportSettingsDraftSaveFailure } from '../src/settings/settingsSaveFailure';
import { expectDefined } from './helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function noticeFragment(): DocumentFragment {
  return vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment;
}

describe('reportSettingsDraftSaveFailure', () => {
  it('keeps one period after a cause that ends with one', () => {
    reportSettingsDraftSaveFailure(
      { action: 'save project table settings', save: vi.fn().mockResolvedValue(undefined) },
      new Error('Disk is full.'),
    );

    expect(noticeFragment().textContent).toBe(
      'Could not save project table settings: Disk is full. Changes are kept in this session. Retry',
    );
  });

  it('keeps a cause without a period as it is and offers a persistent Retry that saves', () => {
    const save = vi.fn().mockResolvedValue(undefined);

    reportSettingsDraftSaveFailure(
      { action: 'save project table settings', save },
      new Error('disk full'),
    );

    expect(noticeFragment().textContent).toBe(
      'Could not save project table settings: disk full. Changes are kept in this session. Retry',
    );
    expect(vi.mocked(Notice).mock.calls[0]?.[1]).toBe(0);
    expectDefined(noticeFragment().querySelector('button')).click();
    expect(save).toHaveBeenCalledOnce();
  });

  it('reports suspended view-state writes once without a Retry', () => {
    const save = vi.fn().mockResolvedValue(undefined);

    reportSettingsDraftSaveFailure(
      { action: 'save project table settings', save },
      new ViewStateWritesSuspendedError(),
    );

    expect(Notice).toHaveBeenCalledExactlyOnceWith(
      'Could not save project table settings: Saved view state writes are suspended. Changes are kept in this session.',
    );
    expect(save).not.toHaveBeenCalled();
  });
});
