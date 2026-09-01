import { describe, expect, it, vi } from 'vitest';
import {
  createOptimisticOverlayStore,
  disposeOptimisticOverlayStores,
  optimisticOverlayStoreFor,
  type CommandResult,
} from '../src/ui/interaction/OptimisticOverlayStore';

interface Card {
  readonly id: string;
  readonly status: string;
  readonly note: { readonly title: string; readonly tags: readonly string[] };
}

const observed: Card = {
  id: 'Projects/Alpha.md',
  status: 'todo',
  note: { title: 'Keep this exact note payload', tags: ['keep'] },
};

function store(announce = vi.fn(), options: { readonly timeoutMs?: number } = {}) {
  return createOptimisticOverlayStore<Card, string, CommandResult>({
    keyOf: ({ id }) => id,
    apply: (card, status) => ({ ...card, status }),
    matches: (card, status) => card.status === status,
    isSuccess: (result) => result.type === 'ok',
    announce,
    ...options,
  });
}

describe('OptimisticOverlayStore', () => {
  it('projects one immediate frozen overlay without mutating its observed snapshot', () => {
    const overlays = store();

    const transaction = overlays.begin(observed, 'revision:1', 'doing');

    expect(transaction).toMatchObject({
      key: 'Projects/Alpha.md',
      observedRevision: 'revision:1',
      patch: 'doing',
    });
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(Object.isFrozen(transaction.observed)).toBe(true);
    expect(Object.isFrozen(transaction.observed.note)).toBe(true);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'doing' });
    expect(observed).toMatchObject({ status: 'todo', note: { tags: ['keep'] } });
  });

  it('keeps a successful command overlay until the matching canonical publication arrives', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const transaction = overlays.begin(observed, 'revision:1', 'doing');

    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'doing' });
    expect(announce).not.toHaveBeenCalled();

    const canonical = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, canonical, 'revision:2');

    expect(overlays.read(observed.id)).toBe(canonical);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['conflict', { type: 'conflict' }],
    ['io', { type: 'io-error' }],
    ['timeout', { type: 'timeout' }],
  ] as const)(
    'rolls back to the frozen observation once for a %s command result',
    (_reason, result) => {
      const announce = vi.fn();
      const overlays = store(announce);
      const transaction = overlays.begin(observed, 'revision:1', 'doing');

      overlays.observeCommandResult(observed.id, result, transaction.id);
      overlays.observeCommandResult(observed.id, result, transaction.id);

      expect(overlays.read(observed.id)).toMatchObject({ status: 'todo', note: observed.note });
      expect(announce).toHaveBeenCalledTimes(1);
    },
  );

  it('rolls back for a competing authoritative publication without altering note data', () => {
    const overlays = store();
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    const competing: Card = { ...observed, status: 'dropped' };

    overlays.observePublication(observed.id, competing, 'revision:2');

    expect(overlays.read(observed.id)).toBe(competing);
    expect(competing.note).toBe(observed.note);
    expect(overlays.read(observed.id)?.note).toEqual({
      title: 'Keep this exact note payload',
      tags: ['keep'],
    });
  });

  it('keeps the pending transaction across remounts and ignores duplicate events', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const transaction = overlays.begin(observed, 'revision:1', 'doing');

    // A renderer can unmount and remount while this application-scoped store remains pending.
    expect(overlays.read(observed.id)).toMatchObject({ status: 'doing' });
    const canonical = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, canonical, 'revision:2');
    overlays.observePublication(observed.id, canonical, 'revision:2');
    overlays.cancel(observed.id, 'timeout', transaction.id);

    expect(overlays.read(observed.id)).toBe(canonical);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('shares one named overlay registry for an application lifetime without crossing scopes', () => {
    const application = {};
    const otherApplication = {};
    const options = {
      keyOf: ({ id }: Card) => id,
      apply: (card: Card, status: string) => ({ ...card, status }),
      matches: (card: Card, status: string) => card.status === status,
      isSuccess: (result: CommandResult) => result.type === 'ok',
    };

    const first = optimisticOverlayStoreFor(application, 'task-status', options);
    const remounted = optimisticOverlayStoreFor(application, 'task-status', options);
    const isolated = optimisticOverlayStoreFor(otherApplication, 'task-status', options);
    first.begin(observed, 'revision:1', 'doing');

    expect(remounted.read(observed.id)).toMatchObject({ status: 'doing' });
    expect(isolated.read(observed.id)).toBeUndefined();
  });

  it('automatically rolls back an unacknowledged overlay after its timeout', () => {
    vi.useFakeTimers();
    const announce = vi.fn();
    const overlays = store(announce, { timeoutMs: 100 });
    overlays.begin(observed, 'revision:1', 'doing');

    vi.advanceTimersByTime(100);

    expect(overlays.read(observed.id)).toMatchObject({ status: 'todo' });
    expect(announce).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores a late command result from an earlier transaction for the same stable key', () => {
    const overlays = store();
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, published, 'revision:2');
    const second = overlays.begin(published, 'revision:2', 'done');

    overlays.observeCommandResult(observed.id, { type: 'conflict' }, first.id);

    expect(second.id).not.toBe(first.id);
    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
  });

  it('ignores an obsolete timeout after a later transaction takes ownership of the key', () => {
    vi.useFakeTimers();
    const overlays = store(vi.fn(), { timeoutMs: 100 });
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, published, 'revision:2');
    const second = overlays.begin(published, 'revision:2', 'done');

    overlays.cancel(observed.id, 'timeout', first.id);

    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
    vi.useRealTimers();
  });

  it('rejects delayed and duplicate canonical publications by their source sequence', () => {
    const overlays = store();
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, published, 'revision:2', 2);
    const second = overlays.begin(published, 'revision:2', 'done');

    // The old source batch arrived after r2. Its sequence, not its arrival time,
    // proves that it cannot settle or cancel the second command.
    overlays.observePublication(observed.id, observed, 'revision:1', 1);
    overlays.observePublication(observed.id, published, 'revision:2', 2);

    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
    overlays.observePublication(observed.id, { ...published, status: 'done' }, 'revision:3', 3);
    expect(overlays.active(observed.id)).toBeUndefined();
    expect(first.token).not.toBe(second.token);
  });

  it('requires the immutable transaction token when a result races a later transaction', () => {
    const overlays = store();
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, published, 'revision:2', 2);
    const second = overlays.begin(published, 'revision:2', 'done');

    overlays.observeCommandResult(observed.id, { type: 'conflict' }, second.id, first.token);

    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
  });

  it('settles a proven successor under a changed canonical key without fuzzy matching', () => {
    const overlays = store();
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    const renamed = { ...observed, id: 'Archive/Alpha.md', status: 'doing' };

    overlays.observePublication(
      renamed.id,
      renamed,
      'revision:2',
      2,
      (before, after) => before.id === observed.id && after.id === renamed.id,
    );

    expect(overlays.active(renamed.id)).toBeUndefined();
    expect(overlays.read(renamed.id)).toBe(renamed);
    expect(overlays.active(observed.id)).toBeUndefined();
    expect(transaction.key).toBe(observed.id);
  });

  it('keeps an initiating owner, falls back only to a live mount, and never calls a closed pane', () => {
    const overlays = store();
    const first = vi.fn();
    const fallback = vi.fn();
    const releaseFirst = overlays.subscribe(vi.fn(), { id: 'first', announce: first });
    overlays.subscribe(vi.fn(), { id: 'fallback', announce: fallback });
    const transaction = overlays.begin(observed, 'revision:1', 'doing', { id: 'first' });
    releaseFirst();

    overlays.observeCommandResult(
      observed.id,
      { type: 'conflict' },
      transaction.id,
      transaction.token,
    );

    expect(first).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('uses the current registry presentation callback after remounting', () => {
    const application = {};
    const firstAnnounce = vi.fn();
    const currentAnnounce = vi.fn();
    const options = (announce: (message: string) => void) => ({
      keyOf: ({ id }: Card) => id,
      apply: (card: Card, status: string) => ({ ...card, status }),
      matches: (card: Card, status: string) => card.status === status,
      isSuccess: (result: CommandResult) => result.type === 'ok',
      announce,
    });
    const first = optimisticOverlayStoreFor(application, 'task-status', options(firstAnnounce));
    const transaction = first.begin(observed, 'revision:1', 'doing');
    const remounted = optimisticOverlayStoreFor(
      application,
      'task-status',
      options(currentAnnounce),
    );

    remounted.observeCommandResult(observed.id, { type: 'conflict' }, transaction.id);

    expect(firstAnnounce).not.toHaveBeenCalled();
    expect(currentAnnounce).toHaveBeenCalledTimes(1);
  });

  it('delivers a registry settlement only to the active mount subscription', () => {
    const application = {};
    const options = {
      keyOf: ({ id }: Card) => id,
      apply: (card: Card, status: string) => ({ ...card, status }),
      matches: (card: Card, status: string) => card.status === status,
      isSuccess: (result: CommandResult) => result.type === 'ok',
    };
    const overlays = optimisticOverlayStoreFor(application, 'task-status', options);
    const closedMount = vi.fn();
    const activeMount = vi.fn();
    const releaseClosedMount = overlays.subscribe(closedMount);
    releaseClosedMount();
    overlays.subscribe(activeMount);
    overlays.begin(observed, 'revision:1', 'doing');

    overlays.observePublication(observed.id, { ...observed, status: 'doing' }, 'revision:2');

    expect(closedMount).not.toHaveBeenCalled();
    expect(activeMount).toHaveBeenCalledOnce();
  });

  it('disposes an application registry without leaving its timeout alive', () => {
    vi.useFakeTimers();
    const application = {};
    const announce = vi.fn();
    const overlays = optimisticOverlayStoreFor(application, 'task-status', {
      keyOf: ({ id }: Card) => id,
      apply: (card: Card, status: string) => ({ ...card, status }),
      matches: (card: Card, status: string) => card.status === status,
      isSuccess: (result: CommandResult) => result.type === 'ok',
      announce,
      timeoutMs: 100,
    });
    overlays.begin(observed, 'revision:1', 'doing');

    disposeOptimisticOverlayStores(application);
    vi.advanceTimersByTime(100);

    expect(announce).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
