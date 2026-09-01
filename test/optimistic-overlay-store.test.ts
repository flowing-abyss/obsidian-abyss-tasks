import { describe, expect, it, vi } from 'vitest';
import {
  createOptimisticOverlayStore,
  disposeOptimisticOverlayStores,
  nextOptimisticPublicationSequence,
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

    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
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

      overlays.observeCommandResult(observed.id, result, transaction.id, transaction.token);
      overlays.observeCommandResult(observed.id, result, transaction.id, transaction.token);

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
    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);

    // A renderer can unmount and remount while this application-scoped store remains pending.
    expect(overlays.read(observed.id)).toMatchObject({ status: 'doing' });
    const canonical = { ...observed, status: 'doing' };
    overlays.observePublication(observed.id, canonical, 'revision:2');
    overlays.observePublication(observed.id, canonical, 'revision:2');
    overlays.cancel(observed.id, 'timeout', transaction.id, transaction.token);

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
    overlays.observeCommandResult(observed.id, { type: 'ok' }, first.id, first.token);
    overlays.observePublication(observed.id, published, 'revision:2', 2);
    const second = overlays.begin(published, 'revision:2', 'done');

    overlays.observeCommandResult(observed.id, { type: 'conflict' }, first.id, first.token);

    expect(second.id).not.toBe(first.id);
    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
  });

  it('ignores an obsolete timeout after a later transaction takes ownership of the key', () => {
    vi.useFakeTimers();
    const overlays = store(vi.fn(), { timeoutMs: 100 });
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observeCommandResult(observed.id, { type: 'ok' }, first.id, first.token);
    overlays.observePublication(observed.id, published, 'revision:2');
    const second = overlays.begin(published, 'revision:2', 'done');

    overlays.cancel(observed.id, 'timeout', first.id, first.token);

    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
    vi.useRealTimers();
  });

  it('rejects delayed and duplicate canonical publications by their source sequence', () => {
    const overlays = store();
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observeCommandResult(observed.id, { type: 'ok' }, first.id, first.token);
    overlays.observePublication(observed.id, published, 'revision:2');
    const second = overlays.begin(published, 'revision:2', 'done');

    // The old source batch arrived after r2. Its sequence, not its arrival time,
    // proves that it cannot settle or cancel the second command.
    overlays.observePublication(observed.id, observed, 'revision:1', 1);
    overlays.reconcileCanonicalKeys(new Set(), 1);
    overlays.observePublication(observed.id, published, 'revision:2', 2);

    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
    overlays.observeCommandResult(observed.id, { type: 'ok' }, second.id, second.token);
    overlays.observePublication(observed.id, { ...published, status: 'done' }, 'revision:3', 3);
    expect(overlays.active(observed.id)).toBeUndefined();
    expect(first.token).not.toBe(second.token);
  });

  it('accepts a newer complete batch when presentation data changes without a revision change', () => {
    const overlays = store();
    overlays.observePublication(observed.id, observed, 'revision:1', 1);
    const dependencyChanged = {
      ...observed,
      note: { ...observed.note, tags: ['keep', 'blocked'] },
    };

    overlays.observePublication(observed.id, dependencyChanged, 'revision:1', 2);

    expect(overlays.read(observed.id)).toBe(dependencyChanged);
  });

  it('does not let an omitted key from a delayed older complete batch cancel a newer move', () => {
    const overlays = store();
    overlays.observePublication(observed.id, observed, 'revision:1', 10);
    overlays.begin(observed, 'revision:1', 'doing');

    overlays.reconcileCanonicalKeys(new Set(), 9);

    expect(overlays.active(observed.id)).toBeDefined();
    expect(overlays.read(observed.id)).toMatchObject({ status: 'doing' });
  });

  it('rolls back an unproven moved or deleted entity as soon as a complete batch omits it', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    overlays.begin(observed, 'revision:1', 'doing');

    overlays.reconcileCanonicalKeys(new Set(), 2);

    expect(overlays.active(observed.id)).toBeUndefined();
    expect(overlays.read(observed.id)).toBeUndefined();
    expect(announce).toHaveBeenCalledWith('Item changed outside the board');
  });

  it('requires the immutable transaction token when a result races a later transaction', () => {
    const overlays = store();
    const first = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observeCommandResult(observed.id, { type: 'ok' }, first.id, first.token);
    overlays.observePublication(observed.id, published, 'revision:2', 2);
    const second = overlays.begin(published, 'revision:2', 'done');

    overlays.observeCommandResult(observed.id, { type: 'conflict' }, second.id, first.token);

    expect(overlays.active(observed.id)?.id).toBe(second.id);
    expect(overlays.read(observed.id)).toMatchObject({ status: 'done' });
  });

  it('settles a proven successor under a changed canonical key without fuzzy matching', () => {
    const overlays = store();
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
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

  it('correlates a command failure by immutable token after successor rebinding', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    const renamed = { ...observed, id: 'Archive/Alpha.md', status: 'doing' };

    overlays.observePublication(
      renamed.id,
      renamed,
      'revision:2',
      2,
      (before, after) => before.id === observed.id && after.id === renamed.id,
    );
    overlays.observeCommandResult(
      observed.id,
      { type: 'conflict' },
      transaction.id,
      transaction.token,
    );

    expect(overlays.active(renamed.id)).toBeUndefined();
    expect(announce).toHaveBeenCalledWith('Item changed outside the board');
  });

  it('correlates a timeout by immutable token after successor rebinding', () => {
    vi.useFakeTimers();
    const announce = vi.fn();
    const overlays = store(announce, { timeoutMs: 100 });
    overlays.begin(observed, 'same-revision', 'doing');
    const renamed = { ...observed, id: 'Archive/Alpha.md', status: 'doing' };
    overlays.observeCanonicalBatch(
      [{ key: renamed.id, snapshot: renamed, revision: 'same-revision' }],
      2,
      (before, after) => before.note.title === after.note.title,
    );

    vi.advanceTimersByTime(100);

    expect(overlays.active(renamed.id)).toBeUndefined();
    expect(overlays.read(observed.id)).toBeUndefined();
    expect(announce).toHaveBeenCalledWith('Item move timed out');
    vi.useRealTimers();
  });

  it('rebinds a complete successor batch atomically when task locations overlap', () => {
    const overlays = store();
    const first = { ...observed, id: 'Tasks.md:1', note: { ...observed.note, title: 'A' } };
    const second = { ...observed, id: 'Tasks.md:2', note: { ...observed.note, title: 'B' } };
    overlays.begin(first, 'same-revision', 'doing');
    overlays.begin(second, 'same-revision', 'doing');
    const shiftedFirst = { ...first, id: 'Tasks.md:2', status: 'doing' };
    const shiftedSecond = { ...second, id: 'Tasks.md:3', status: 'doing' };

    overlays.observeCanonicalBatch(
      [
        { key: shiftedFirst.id, snapshot: shiftedFirst, revision: 'same-revision' },
        { key: shiftedSecond.id, snapshot: shiftedSecond, revision: 'same-revision' },
      ],
      2,
      (before, after) => before.note.title === after.note.title,
    );

    expect(overlays.active(shiftedFirst.id)).toBeDefined();
    expect(overlays.active(shiftedSecond.id)).toBeDefined();
    expect(overlays.active(first.id)).toBeUndefined();
    expect(overlays.read(shiftedFirst.id)).toMatchObject({ status: 'doing', note: { title: 'A' } });
    expect(overlays.read(shiftedSecond.id)).toMatchObject({
      status: 'doing',
      note: { title: 'B' },
    });
  });

  it('does not orphan a transaction when a successor collision invalidates a move chain', () => {
    const overlays = store();
    const cards = ['A', 'B', 'C', 'D'].map((title, index) => ({
      ...observed,
      id: `Tasks.md:${String(index + 1)}`,
      note: { ...observed.note, title },
    }));
    for (const card of cards) overlays.begin(card, 'same-revision', 'doing');
    const publication = [
      { ...cards[0]!, id: 'Tasks.md:2', status: 'doing' },
      { ...cards[1]!, id: 'Tasks.md:3', status: 'doing' },
      // C and the unchanged D collide at D's location.
      { ...cards[2]!, id: 'Tasks.md:4', status: 'doing' },
    ];

    overlays.observeCanonicalBatch(
      publication.map((snapshot) => ({
        key: snapshot.id,
        snapshot,
        revision: 'same-revision',
      })),
      2,
      (before, after) => before.note.title === after.note.title,
    );

    expect(overlays.active('Tasks.md:2')).toBeUndefined();
    expect(overlays.read('Tasks.md:2')?.note.title).toBe('A');
    expect(overlays.read('Tasks.md:3')?.note.title).toBe('B');
    expect(overlays.read('Tasks.md:4')?.note.title).toBe('C');
  });

  it('competes when an unrelated entity reuses an active transaction key without continuity proof', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const original = {
      ...observed,
      id: 'Tasks.md:1',
      note: { ...observed.note, title: 'Original' },
    };
    const transaction = overlays.begin(original, 'original-revision', 'doing');
    overlays.observeCommandResult(original.id, { type: 'ok' }, transaction.id, transaction.token);
    const replacement = {
      ...original,
      status: 'doing',
      note: { ...original.note, title: 'Replacement' },
    };

    overlays.observeCanonicalBatch(
      [{ key: replacement.id, snapshot: replacement, revision: 'replacement-revision' }],
      2,
      (before, after) => before.note.title === after.note.title,
    );

    expect(overlays.active(original.id)).toBeUndefined();
    expect(overlays.read(original.id)).toBe(replacement);
    expect(announce).toHaveBeenCalledWith('Item changed outside the board');
    expect(announce).not.toHaveBeenCalledWith('Item moved.');
  });

  it('requires continuity proof for same-key replacement through single-publication API', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const original = {
      ...observed,
      note: { ...observed.note, title: 'Original' },
    };
    const transaction = overlays.begin(original, 'original-revision', 'doing');
    overlays.observeCommandResult(original.id, { type: 'ok' }, transaction.id, transaction.token);
    const replacement = {
      ...original,
      status: 'doing',
      note: { ...original.note, title: 'Replacement' },
    };

    overlays.observePublication(
      replacement.id,
      replacement,
      'replacement-revision',
      2,
      (before, after) => before.note.title === after.note.title,
    );

    expect(overlays.active(original.id)).toBeUndefined();
    expect(overlays.read(original.id)).toBe(replacement);
    expect(announce).toHaveBeenCalledWith('Item changed outside the board');
  });

  it('treats a same-revision relocated successor as a matching publication', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const transaction = overlays.begin(observed, 'same-revision', 'doing');
    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
    const renamed = { ...observed, id: 'Archive/Alpha.md', status: 'doing' };

    overlays.observeCanonicalBatch(
      [{ key: renamed.id, snapshot: renamed, revision: 'same-revision' }],
      2,
      (before, after) => before.note.title === after.note.title,
    );

    expect(overlays.active(renamed.id)).toBeUndefined();
    expect(overlays.read(renamed.id)).toBe(renamed);
    expect(announce).toHaveBeenCalledOnce();
  });

  it('waits silently for command success after a matching publication', () => {
    const announce = vi.fn();
    const settlements = vi.fn();
    const overlays = store(announce);
    overlays.subscribe(settlements);
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };

    overlays.observeCanonicalBatch(
      [{ key: observed.id, snapshot: published, revision: 'revision:2' }],
      2,
    );
    expect(overlays.active(observed.id)).toBe(transaction);
    expect(announce).not.toHaveBeenCalled();
    expect(settlements).not.toHaveBeenCalled();

    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
    expect(overlays.active(observed.id)).toBeUndefined();
    expect(overlays.read(observed.id)).toBe(published);
    expect(announce).toHaveBeenCalledOnce();
  });

  it('rolls back when a command conflicts after a matching publication', () => {
    const announce = vi.fn();
    const overlays = store(announce);
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    const published = { ...observed, status: 'doing' };
    overlays.observeCanonicalBatch(
      [{ key: observed.id, snapshot: published, revision: 'revision:2' }],
      2,
    );

    overlays.observeCommandResult(
      observed.id,
      { type: 'conflict' },
      transaction.id,
      transaction.token,
    );

    expect(overlays.active(observed.id)).toBeUndefined();
    expect(announce).toHaveBeenCalledWith('Item changed outside the board');
  });

  it('removes canonical-only and predecessor records across mass rename and deletion batches', () => {
    const overlays = store();
    const initial = Array.from({ length: 50 }, (_, index) => ({
      ...observed,
      id: `Tasks.md:${String(index)}`,
      note: { ...observed.note, title: `Task ${String(index)}` },
    }));
    overlays.observeCanonicalBatch(
      initial.map((snapshot) => ({ key: snapshot.id, snapshot, revision: 'one' })),
      1,
    );
    const moved = initial.map((snapshot, index) => ({
      ...snapshot,
      id: `Archive.md:${String(index + 100)}`,
    }));

    overlays.observeCanonicalBatch(
      moved.map((snapshot) => ({ key: snapshot.id, snapshot, revision: 'two' })),
      2,
    );
    overlays.observeCanonicalBatch([], 3);

    for (const snapshot of [...initial, ...moved])
      expect(overlays.read(snapshot.id)).toBeUndefined();
  });

  it('does not resurrect a deleted canonical entry from a delayed older complete batch', () => {
    const overlays = store();
    overlays.observeCanonicalBatch([{ key: observed.id, snapshot: observed, revision: 'one' }], 8);
    overlays.observeCanonicalBatch([], 10);

    overlays.observeCanonicalBatch([{ key: observed.id, snapshot: observed, revision: 'one' }], 9);

    expect(overlays.read(observed.id)).toBeUndefined();
  });

  it('settles overlapping mass line shifts without retaining predecessor aliases', () => {
    const overlays = store();
    const initial = Array.from({ length: 30 }, (_, index) => ({
      ...observed,
      id: `Tasks.md:${String(index)}`,
      note: { ...observed.note, title: `Task ${String(index)}` },
    }));
    for (const snapshot of initial) {
      const transaction = overlays.begin(snapshot, 'preserved-revision', 'doing');
      overlays.observeCommandResult(snapshot.id, { type: 'ok' }, transaction.id, transaction.token);
    }
    const shifted = initial.map((snapshot, index) => ({
      ...snapshot,
      id: `Tasks.md:${String(index + 1)}`,
      status: 'doing',
    }));

    overlays.observeCanonicalBatch(
      shifted.map((snapshot) => ({
        key: snapshot.id,
        snapshot,
        revision: 'preserved-revision',
      })),
      2,
      (before, after) => before.note.title === after.note.title,
    );

    for (const snapshot of initial) {
      const successor = shifted.find((candidate) => candidate.note.title === snapshot.note.title)!;
      expect(overlays.active(successor.id)).toBeUndefined();
      expect(overlays.read(successor.id)).toBe(successor);
    }
    expect(overlays.read(initial[0]!.id)).toBeUndefined();
    overlays.observeCanonicalBatch([], 3);
    for (const snapshot of shifted) expect(overlays.read(snapshot.id)).toBeUndefined();
  });

  it('releases a predecessor key when a proven successor is rebound', () => {
    const overlays = store();
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
    const renamed = { ...observed, id: 'Archive/Alpha.md', status: 'doing' };

    overlays.observePublication(
      renamed.id,
      renamed,
      'revision:2',
      2,
      (before, after) => before.id === observed.id && after.id === renamed.id,
    );
    const reusedPath = { ...observed, status: 'todo' };
    overlays.observePublication(observed.id, reusedPath, 'revision:new-entity', 3);

    expect(overlays.read(renamed.id)).toBe(renamed);
    expect(overlays.read(observed.id)).toBe(reusedPath);
  });

  it('allocates publication sequences monotonically for an application lifetime', () => {
    const application = {};
    const otherApplication = {};

    expect(nextOptimisticPublicationSequence(application)).toBe(1);
    expect(nextOptimisticPublicationSequence(application)).toBe(2);
    expect(nextOptimisticPublicationSequence(otherApplication)).toBe(1);
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

  it('downgrades fallback success when the closed initiator owned the non-transferable Undo', () => {
    const overlays = store();
    const initiatingAnnouncement = vi.fn();
    const fallbackAnnouncement = vi.fn();
    const releaseInitiator = overlays.subscribe(vi.fn(), {
      id: 'initiator',
      announce: initiatingAnnouncement,
      undoAvailable: true,
    });
    overlays.subscribe(vi.fn(), {
      id: 'fallback',
      announce: fallbackAnnouncement,
      // Its own Undo port cannot control authority retained by the closed initiator.
      undoAvailable: true,
    });
    const transaction = overlays.begin(observed, 'revision:1', 'doing', {
      id: 'initiator',
      undoAvailable: true,
    });
    releaseInitiator();

    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
    overlays.observePublication(observed.id, { ...observed, status: 'doing' }, 'revision:2', 2);

    expect(initiatingAnnouncement).not.toHaveBeenCalled();
    expect(fallbackAnnouncement).toHaveBeenCalledOnce();
    expect(fallbackAnnouncement).toHaveBeenCalledWith('Item moved.');
  });

  it('retains fallback Undo wording only for explicitly transferable application authority', () => {
    const overlays = store();
    const fallbackAnnouncement = vi.fn();
    const releaseInitiator = overlays.subscribe(vi.fn(), {
      id: 'initiator',
      undoAvailable: true,
      undoTransferable: true,
    });
    overlays.subscribe(vi.fn(), {
      id: 'fallback',
      announce: fallbackAnnouncement,
      undoAvailable: true,
    });
    const transaction = overlays.begin(observed, 'revision:1', 'doing', {
      id: 'initiator',
      undoAvailable: true,
      undoTransferable: true,
    });
    releaseInitiator();

    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);
    overlays.observePublication(observed.id, { ...observed, status: 'doing' }, 'revision:2', 2);

    expect(fallbackAnnouncement).toHaveBeenCalledWith('Item moved. Undo available.');
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

    remounted.observeCommandResult(
      observed.id,
      { type: 'conflict' },
      transaction.id,
      transaction.token,
    );

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
    const transaction = overlays.begin(observed, 'revision:1', 'doing');
    overlays.observeCommandResult(observed.id, { type: 'ok' }, transaction.id, transaction.token);

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
