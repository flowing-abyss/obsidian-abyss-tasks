import type * as ObsidianModule from 'obsidian';
import { Notice } from 'obsidian';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ViewStateWritesSuspendedError } from '../src/settings/persistence';
import {
  reportSettingsDraftSaveFailure,
  saveSettingsDraft,
} from '../src/settings/settingsSaveFailure';
import { deferred, expectDefined, flushMicrotasks } from './helpers';

import type { ConnectedNoticeFixture } from './support/connectedNoticeFixture';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  const { ConnectedNoticeFixture } = await import('./support/connectedNoticeFixture');
  return { ...actual, Notice: vi.fn(ConnectedNoticeFixture) };
});

const LOG_MESSAGE = '[abyss-tasks] Could not save project table settings';

// Every row reports one failure, and each ends with the exact log it expects.
let log: MockInstance<typeof console.error>;

beforeEach(() => {
  document.querySelectorAll('.settings-test-notice').forEach((element) => {
    element.remove();
  });
  log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function noticeFragment(): HTMLElement {
  return (vi.mocked(Notice).mock.results[0]?.value as ConnectedNoticeFixture).messageEl;
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

describe('owner-scoped settings drafts', () => {
  it('reuses one failure and retries the latest draft for the same owner and action', async () => {
    const owner = {};
    let draft = 'first';
    const saved: string[] = [];
    const failure = new Error('disk unavailable');
    let failing = true;
    const save = vi.fn(async () => {
      saved.push(draft);
      if (failing) throw failure;
    });
    saveSettingsDraft({ owner, action: 'save project membership query', save });
    await flushMicrotasks();
    draft = 'second';
    saveSettingsDraft({ owner, action: 'save project membership query', save });
    await flushMicrotasks();
    expect(Notice).toHaveBeenCalledOnce();
    failing = false;
    expectDefined(noticeFragment().querySelector('button')).click();
    await flushMicrotasks();
    expect(saved).toEqual(['first', 'second', 'second']);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('keeps separate owners and actions and unscoped calls independent', async () => {
    const owner = {};
    const save = async (): Promise<void> => {
      throw new Error('disk unavailable');
    };
    for (const options of [
      { owner, action: 'save query', save },
      { owner: {}, action: 'save query', save },
      { owner, action: 'save folder', save },
      { action: 'save query', save },
      { action: 'save query', save },
    ])
      saveSettingsDraft(options);
    await flushMicrotasks();
    expect(Notice).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenCalledTimes(5);
  });

  it('keeps the latest failure actionable when an older pending Retry succeeds', async () => {
    const owner = {};
    const retry = deferred<void>();
    const failure = new Error('first failure');
    const newerFailure = new Error('newer failure');
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(retry.promise)
      .mockRejectedValueOnce(newerFailure)
      .mockResolvedValueOnce(undefined);
    const options = { owner, action: 'save query', save };
    saveSettingsDraft(options);
    await flushMicrotasks();
    const button = expectDefined(noticeFragment().querySelector('button'));
    button.click();
    expect(button.disabled).toBe(true);
    saveSettingsDraft(options);
    await flushMicrotasks();
    expect(button.disabled).toBe(false);
    expect(noticeFragment().textContent).toContain('newer failure');
    retry.resolve();
    await flushMicrotasks();
    expect(noticeFragment().isConnected).toBe(true);
    expect(button.disabled).toBe(false);
    expect(Notice).toHaveBeenCalledOnce();
    button.click();
    await flushMicrotasks();
    expect(noticeFragment().isConnected).toBe(false);
    expect(log).toHaveBeenNthCalledWith(2, '[abyss-tasks] Could not save query', {
      cause: newerFailure,
    });
  });

  it('logs an obsolete failure after newer success without resurrecting feedback', async () => {
    const owner = {};
    const older = deferred<Error>();
    const pending = older.promise.then((error) => {
      throw error;
    });
    const caught = pending.catch(() => undefined);
    const failure = new Error('obsolete failure');
    saveSettingsDraft({ owner, action: 'save query', save: () => pending });
    saveSettingsDraft({ owner, action: 'save query', save: async () => {} });
    await flushMicrotasks();
    older.resolve(failure);
    await caught;
    await flushMicrotasks();
    expect(Notice).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not save query', {
      cause: failure,
    });
  });

  it('retires an active failure on the latest ordinary save success', async () => {
    const owner = {};
    saveSettingsDraft({
      owner,
      action: 'save query',
      save: async () => {
        throw new Error('disk');
      },
    });
    await flushMicrotasks();
    saveSettingsDraft({ owner, action: 'save query', save: async () => {} });
    await flushMicrotasks();
    expect(noticeFragment().isConnected).toBe(false);
    expect(Notice).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });

  it('keeps a newer failure when an older ordinary save succeeds', async () => {
    const owner = {};
    const older = deferred<void>();
    saveSettingsDraft({ owner, action: 'save query', save: () => older.promise });
    saveSettingsDraft({
      owner,
      action: 'save query',
      save: async () => {
        throw new Error('newer');
      },
    });
    await flushMicrotasks();
    older.resolve();
    await flushMicrotasks();
    expect(noticeFragment().isConnected).toBe(true);
    expect(Notice).toHaveBeenCalledOnce();
    expect(expectDefined(noticeFragment().querySelector('button')).disabled).toBe(false);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('settings Retry current closure', () => {
  it('uses the newest save closure and reports repeated Retry failure in the same Notice', async () => {
    const owner = {};
    const initialFailure = new Error('first');
    const latestFailure = new Error('latest');
    const oldSave = vi.fn<() => Promise<void>>().mockRejectedValue(initialFailure);
    const latestSave = vi.fn<() => Promise<void>>().mockRejectedValue(latestFailure);
    saveSettingsDraft({ owner, action: 'save query', save: oldSave });
    await flushMicrotasks();
    saveSettingsDraft({ owner, action: 'save query', save: latestSave });
    await flushMicrotasks();
    const button = expectDefined(noticeFragment().querySelector('button'));
    button.click();
    expect(button.disabled).toBe(true);
    await flushMicrotasks();
    expect(button.disabled).toBe(false);
    expect(Notice).toHaveBeenCalledOnce();
    expect(noticeFragment().textContent).toContain('latest');
    expect(oldSave).toHaveBeenCalledOnce();
    expect(latestSave).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith('[abyss-tasks] Could not save query', {
      cause: latestFailure,
    });
  });

  it('logs an older failure without replacing the current failure or its Retry', async () => {
    const owner = {};
    const older = deferred<Error>();
    const pending = older.promise.then((error) => {
      throw error;
    });
    const caught = pending.catch(() => undefined);
    const oldFailure = new Error('old');
    const latestSave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('latest'))
      .mockResolvedValue(undefined);
    saveSettingsDraft({ owner, action: 'save query', save: () => pending });
    saveSettingsDraft({ owner, action: 'save query', save: latestSave });
    await flushMicrotasks();
    older.resolve(oldFailure);
    await caught;
    await flushMicrotasks();
    expect(Notice).toHaveBeenCalledOnce();
    expect(noticeFragment().textContent).toContain('latest');
    expectDefined(noticeFragment().querySelector('button')).click();
    await flushMicrotasks();
    expect(latestSave).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith('[abyss-tasks] Could not save query', {
      cause: oldFailure,
    });
  });

  it('keeps suspended view-state feedback free of Retry after a retryable failure', async () => {
    const owner = {};
    saveSettingsDraft({
      owner,
      action: 'save query',
      save: async () => {
        throw new Error('disk');
      },
    });
    await flushMicrotasks();
    const failure = new ViewStateWritesSuspendedError();
    saveSettingsDraft({
      owner,
      action: 'save query',
      save: async () => {
        throw failure;
      },
    });
    await flushMicrotasks();
    expect(noticeFragment().isConnected).toBe(false);
    expect(vi.mocked(Notice).mock.calls[1]).toEqual([
      'Could not save query: Saved view state writes are suspended. Changes are kept in this session.',
    ]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

it('shows a fresh actionable failure after the previous Notice was detached', async () => {
  const owner = {};
  const failure = new Error('disk unavailable');
  let failing = true;
  const saved: string[] = [];
  let draft = 'first';
  const save = async (): Promise<void> => {
    saved.push(draft);
    if (failing) throw failure;
  };
  saveSettingsDraft({ owner, action: 'save query', save });
  await flushMicrotasks();
  const first = vi.mocked(Notice).mock.results[0]?.value as ConnectedNoticeFixture;
  expect(first.messageEl.isConnected).toBe(true);
  first.containerEl.remove();
  expect(first.messageEl.isConnected).toBe(false);
  draft = 'latest';
  saveSettingsDraft({ owner, action: 'save query', save });
  await flushMicrotasks();
  expect(Notice).toHaveBeenCalledTimes(2);
  const current = vi.mocked(Notice).mock.results[1]?.value as ConnectedNoticeFixture;
  expect(current.messageEl.isConnected).toBe(true);
  failing = false;
  expectDefined(current.messageEl.querySelector('button')).click();
  await flushMicrotasks();
  expect(saved).toEqual(['first', 'latest', 'latest']);
  expect(current.messageEl.isConnected).toBe(false);
  expect(log).toHaveBeenCalledTimes(2);
});

it('replaces feedback when dismissal starts before detachment and ignores an old Notice hide', async () => {
  const owner = {};
  let draft = 'first';
  const saved: string[] = [];
  let failing = true;
  const save = async (): Promise<void> => {
    saved.push(draft);
    if (failing) throw new Error('disk unavailable');
  };
  saveSettingsDraft({ owner, action: 'save query', save });
  await flushMicrotasks();
  const first = vi.mocked(Notice).mock.results[0]?.value as ConnectedNoticeFixture;
  first.deferDetach = true;
  first.containerEl.click();
  expect(first.messageEl.isConnected).toBe(true);
  draft = 'latest';
  saveSettingsDraft({ owner, action: 'save query', save });
  await flushMicrotasks();
  expect(Notice).toHaveBeenCalledTimes(2);
  const current = vi.mocked(Notice).mock.results[1]?.value as ConnectedNoticeFixture;
  expect(current.messageEl.isConnected).toBe(true);
  first.containerEl.click();
  first.containerEl.remove();
  failing = false;
  expectDefined(current.messageEl.querySelector('button')).click();
  await flushMicrotasks();
  expect(saved).toEqual(['first', 'latest', 'latest']);
  expect(current.messageEl.isConnected).toBe(false);
  expect(log).toHaveBeenCalledTimes(2);
});
