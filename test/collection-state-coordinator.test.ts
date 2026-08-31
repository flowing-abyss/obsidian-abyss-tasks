import { describe, expect, it, vi } from 'vitest';
import type { PersistedCollectionPreference } from '../src/settings/types';
import {
  CollectionPreferenceConflictError,
  CollectionStateCoordinator,
  InMemoryCollectionSessionPort,
  type CollectionPreferencePort,
  type CollectionPreferenceSnapshot,
} from '../src/ui/collection/CollectionStateCoordinator';

type Preference = PersistedCollectionPreference<string, string, string, 'list' | 'board', object>;

const preference = (layout: Preference['layout'] = 'list'): Preference => ({
  version: 1,
  layout,
  filters: [],
  group: 'none',
  sort: 'date',
  visibleFields: ['title'],
  layoutPreferences: {},
});

const snapshot = (
  persistenceIdentity: string,
  revision: number,
  value: Preference = preference(),
): CollectionPreferenceSnapshot<Preference> => ({
  persistenceIdentity,
  revision,
  preference: value,
});

function preferences(
  initial: Readonly<Record<string, Preference>>,
): CollectionPreferencePort<Preference> {
  const values = new Map(Object.entries(initial));
  const revisions = new Map<string, number>();
  const listeners = new Map<
    string,
    Set<(next: CollectionPreferenceSnapshot<Preference>) => void>
  >();
  return {
    read: (scope) => ({
      persistenceIdentity: scope,
      revision: revisions.get(scope) ?? 0,
      preference: values.get(scope) ?? preference(),
    }),
    update: async (scope, expected, next) => {
      const current = values.get(scope) ?? preference();
      const revision = revisions.get(scope) ?? 0;
      if (expected.persistenceIdentity !== scope || revision !== expected.revision)
        throw new CollectionPreferenceConflictError();
      values.set(scope, next);
      const settled = snapshot(scope, revision + 1, next);
      revisions.set(scope, settled.revision);
      for (const listener of listeners.get(scope) ?? []) listener(settled);
      return settled;
    },
    subscribe: (scope, listener) => {
      const scoped = listeners.get(scope) ?? new Set();
      scoped.add(listener);
      listeners.set(scope, scoped);
      return () => scoped.delete(listener);
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CollectionStateCoordinator', () => {
  it('isolates stable preferences from released mount session state', () => {
    const settings = preferences({
      'tasks:main': preference('list'),
      'projects:portfolio': preference('board'),
    });
    const coordinator = new CollectionStateCoordinator({
      preferences: settings,
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    });

    coordinator.updateSession('tasks:first', {
      query: 'ship',
      selectionKey: 'task-1',
      focusedKey: 'task-1',
      scrollAnchor: 'task-1',
      openSurface: 'filter',
    });

    expect(coordinator.preference('tasks:main').layout).toBe('list');
    expect(coordinator.preference('projects:portfolio').layout).toBe('board');
    coordinator.release('tasks:first');
    expect(coordinator.session('tasks:first')).toEqual({
      query: '',
      selectionKey: null,
      focusedKey: null,
      scrollAnchor: null,
      openSurface: null,
    });
  });

  it('migrates a persisted preference before the first renderer read', () => {
    const migratePreference = vi.fn((current: Preference) => ({
      ...current,
      layout: 'board' as const,
    }));
    const coordinator = new CollectionStateCoordinator({
      preferences: preferences({ 'tasks:main': preference('list') }),
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference,
    });

    expect(coordinator.preference('tasks:main').layout).toBe('board');
    expect(migratePreference).toHaveBeenCalledOnce();
  });

  it('forwards expected-revision conflicts without publishing an unsettled preference', async () => {
    const coordinator = new CollectionStateCoordinator({
      preferences: preferences({ 'tasks:main': preference() }),
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    });
    const listener = vi.fn();
    coordinator.subscribePreference('tasks:main', listener);

    await expect(
      coordinator.updatePreference('tasks:main', snapshot('tasks:main', 2), preference('board')),
    ).rejects.toThrow('revision conflict');
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects a persistence identity token captured from another collection', async () => {
    const coordinator = new CollectionStateCoordinator({
      preferences: preferences({ 'tasks:main': preference() }),
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    });
    const captured = coordinator.preferenceSnapshot('tasks:main');

    await expect(
      coordinator.updatePreference(
        'tasks:main',
        { ...captured, persistenceIdentity: 'projects:portfolio' },
        preference('board'),
      ),
    ).rejects.toBeInstanceOf(CollectionPreferenceConflictError);
    expect(coordinator.preference('tasks:main').layout).toBe('list');
  });

  it('publishes each settled preference once and never forwards session state to settings', async () => {
    const settings = preferences({ 'tasks:main': preference() });
    const update = vi.spyOn(settings, 'update');
    const coordinator = new CollectionStateCoordinator({
      preferences: settings,
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    });
    const listener = vi.fn();
    coordinator.subscribePreference('tasks:main', listener);

    coordinator.updateSession('tasks:first', {
      query: 'never persisted',
      selectionKey: 'selected',
      focusedKey: 'focused',
      scrollAnchor: 'anchor',
      openSurface: 'capture',
    });
    await coordinator.updatePreference(
      'tasks:main',
      coordinator.preferenceSnapshot('tasks:main'),
      preference('board'),
    );

    expect(update).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      persistenceIdentity: 'tasks:main',
      revision: 1,
      preference: preference('board'),
    });
    expect(coordinator.session('tasks:first').query).toBe('never persisted');
  });

  it('keeps schema version one while monotonically advancing the CAS revision', async () => {
    const coordinator = new CollectionStateCoordinator({
      preferences: preferences({ 'tasks:main': preference() }),
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    });

    const first = await coordinator.updatePreference(
      'tasks:main',
      coordinator.preferenceSnapshot('tasks:main'),
      preference('board'),
    );
    const second = await coordinator.updatePreference('tasks:main', first, preference('list'));

    expect(first).toMatchObject({ revision: 1, preference: { version: 1, layout: 'board' } });
    expect(second).toMatchObject({ revision: 2, preference: { version: 1, layout: 'list' } });
    expect(coordinator.preferenceSnapshot('tasks:main')).toEqual(second);
  });

  it('serializes equal-revision writes so exactly one settles and the stale write conflicts', async () => {
    const save = deferred<void>();
    let revision = 0;
    let current = preference();
    const persistenceIdentity = 'tasks:main:today';
    const publications: CollectionPreferenceSnapshot<Preference>[] = [];
    const port: CollectionPreferencePort<Preference> = {
      read: () => snapshot(persistenceIdentity, revision, current),
      update: async (_scope, expected, next) => {
        if (expected.persistenceIdentity !== persistenceIdentity || revision !== expected.revision)
          throw new CollectionPreferenceConflictError();
        await save.promise;
        current = next;
        revision += 1;
        const settled = snapshot(persistenceIdentity, revision, current);
        publications.push(settled);
        return settled;
      },
      subscribe: () => () => undefined,
    };
    const coordinator = new CollectionStateCoordinator({
      preferences: port,
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (value) => value,
    });

    const expected = coordinator.preferenceSnapshot('tasks:main');
    const first = coordinator.updatePreference('tasks:main', expected, preference('board'));
    const stale = coordinator.updatePreference('tasks:main', expected, preference('list'));
    expect(coordinator.preferenceSnapshot('tasks:main')).toEqual({
      persistenceIdentity,
      revision: 0,
      preference: preference('list'),
    });

    save.resolve();
    await expect(first).resolves.toMatchObject({ revision: 1, preference: { layout: 'board' } });
    await expect(stale).rejects.toBeInstanceOf(CollectionPreferenceConflictError);
    expect(publications).toHaveLength(1);
    expect(coordinator.preferenceSnapshot('tasks:main')).toMatchObject({
      revision: 1,
      preference: { layout: 'board' },
    });
  });

  it('does not publish or expose a staged preference when persistence rejects', async () => {
    const save = deferred<CollectionPreferenceSnapshot<Preference>>();
    const initial = snapshot('tasks:main:today', 7, preference('list'));
    const port: CollectionPreferencePort<Preference> = {
      read: () => initial,
      update: () => save.promise,
      subscribe: () => () => undefined,
    };
    const coordinator = new CollectionStateCoordinator({
      preferences: port,
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (value) => value,
    });
    const listener = vi.fn();
    coordinator.subscribePreference('tasks:main', listener);

    const pending = coordinator.updatePreference('tasks:main', initial, preference('board'));
    expect(coordinator.preferenceSnapshot('tasks:main')).toEqual(initial);
    save.reject(new Error('disk full'));

    await expect(pending).rejects.toThrow('disk full');
    expect(coordinator.preferenceSnapshot('tasks:main')).toEqual(initial);
    expect(listener).not.toHaveBeenCalled();
  });
});
