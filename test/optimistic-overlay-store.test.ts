import { describe, expect, it, vi } from 'vitest';
import {
  createOptimisticOverlayStore,
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
    overlays.begin(observed, 'revision:1', 'doing');

    overlays.observeCommandResult(observed.id, { type: 'ok' });
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
      overlays.begin(observed, 'revision:1', 'doing');

      overlays.observeCommandResult(observed.id, result);
      overlays.observeCommandResult(observed.id, result);

      expect(overlays.read(observed.id)).toMatchObject({ status: 'todo', note: observed.note });
      expect(announce).toHaveBeenCalledTimes(1);
    },
  );

  it('rolls back for a competing authoritative publication without altering note data', () => {
    const overlays = store();
    overlays.begin(observed, 'revision:1', 'doing');
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
    overlays.begin(observed, 'revision:1', 'doing');

    // A renderer can unmount and remount while this application-scoped store remains pending.
    expect(overlays.read(observed.id)).toMatchObject({ status: 'doing' });
    const canonical = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, canonical, 'revision:2');
    overlays.observePublication(observed.id, canonical, 'revision:2');
    overlays.cancel(observed.id, 'timeout');

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
});
