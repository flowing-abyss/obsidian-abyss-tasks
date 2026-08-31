import { describe, expect, it, vi } from 'vitest';
import type { PersistedCollectionPreference } from '../src/settings/types';
import {
  CollectionStateCoordinator,
  InMemoryCollectionSessionPort,
  type CollectionPreferencePort,
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

function preferences(
  initial: Readonly<Record<string, Preference>>,
): CollectionPreferencePort<Preference> {
  const values = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<(next: Preference) => void>>();
  return {
    read: (scope) => values.get(scope) ?? preference(),
    update: async (scope, expectedVersion, next) => {
      const current = values.get(scope) ?? preference();
      if (current.version !== expectedVersion) throw new Error('version conflict');
      values.set(scope, next);
      for (const listener of listeners.get(scope) ?? []) listener(next);
      return next;
    },
    subscribe: (scope, listener) => {
      const scoped = listeners.get(scope) ?? new Set();
      scoped.add(listener);
      listeners.set(scope, scoped);
      return () => scoped.delete(listener);
    },
  };
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

  it('forwards expected-version conflicts without publishing an unsettled preference', async () => {
    const coordinator = new CollectionStateCoordinator({
      preferences: preferences({ 'tasks:main': preference() }),
      sessions: new InMemoryCollectionSessionPort(),
      migratePreference: (current) => current,
    });
    const listener = vi.fn();
    coordinator.subscribePreference('tasks:main', listener);

    await expect(
      coordinator.updatePreference('tasks:main', 2, preference('board')),
    ).rejects.toThrow('version conflict');
    expect(listener).not.toHaveBeenCalled();
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
    await coordinator.updatePreference('tasks:main', 1, preference('board'));

    expect(update).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(preference('board'));
    expect(coordinator.session('tasks:first').query).toBe('never persisted');
  });
});
