import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ListViewControls } from '../src/panels/center/ListViewControls';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ListViewState } from '../src/settings/types';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { deferred, makeStubStore } from './helpers';

describe('list view persistence ordering', () => {
  it('updates the settings entry, starts one save, then notifies state without waiting for persistence', async () => {
    const state = new AppState();
    state.set('selectedList', 'inbox');
    const settings = structuredClone(DEFAULT_SETTINGS);
    const pending = deferred<void>();
    const events: string[] = [];
    const store = makeStubStore([]);
    const previous = state.get('centerListViewState');
    const expected: ListViewState = { ...previous, filters: [{ type: 'tag', value: '#work' }] };
    const saveViewState = vi.fn(() => {
      expect(settings.listViewStates?.['inbox']).toEqual(expected);
      expect(state.get('centerListViewState')).toBe(previous);
      events.push('save');
      return pending.promise;
    });
    const controls = new ListViewControls({
      state,
      settings,
      statusRegistry: store.statusRegistry,
      interactionOwnership: noInteractionOwnership,
      saveViewState,
      host: {
        root: () => activeDocument.body,
        formatDate: (value) => value,
      },
    });
    const off = state.on('centerListViewState', (next) => {
      expect(next).toEqual(expected);
      expect(saveViewState).toHaveBeenCalledTimes(1);
      events.push('state');
    });
    try {
      controls.addPropertyFilter({ type: 'tag', value: '#work' });
      expect(events).toEqual(['save', 'state']);
      expect(state.get('centerListViewState')).toEqual(expected);
      pending.resolve();
      await pending.promise;
      expect(events).toEqual(['save', 'state']);
      expect(saveViewState).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});

describe('case-compatible physical saved keys', () => {
  it('reads and stores one old tag alias without deleting it', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'tag', tag: '#work' });
    const settings = structuredClone(DEFAULT_SETTINGS),
      saved = {
        groupBy: 'priority' as const,
        sortBy: { field: 'title' as const, dir: 'asc' as const },
        filters: [],
      };
    settings.listViewStates = { 'tag:#Work': saved };
    const store = makeStubStore([]),
      controls = new ListViewControls({
        state,
        settings,
        statusRegistry: store.statusRegistry,
        interactionOwnership: noInteractionOwnership,
        saveViewState: async () => {},
        host: { root: () => activeDocument.body, formatDate: (value) => value },
      });
    expect(controls.activeListKey()).toBe('tag:#work');
    controls.initializeListViewState();
    expect(state.get('centerListViewState')).toBe(saved);
    controls.addPropertyFilter({ type: 'tag', value: '#new' });
    expect(Object.keys(settings.listViewStates)).toEqual(['tag:#Work']);
    expect(settings.listViewStates['tag:#Work']?.filters).toEqual([{ type: 'tag', value: '#new' }]);
  });
  it('promoted discovered-looking configured ID uses its own missing/existing physical key', () => {
    const state = new AppState(),
      id = 'discovered:tag:%23Work';
    state.set('selectedList', { type: 'group', groupId: id });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.tagGroups = [{ id, name: 'Promoted', mode: 'manual', tags: ['#Work'] }];
    settings.listViewStates = {
      'group:discovered:tag:%23work': {
        groupBy: 'priority',
        sortBy: { field: 'title', dir: 'asc' },
        filters: [],
      },
    };
    const store = makeStubStore([]),
      controls = new ListViewControls({
        state,
        settings,
        statusRegistry: store.statusRegistry,
        interactionOwnership: noInteractionOwnership,
        saveViewState: async () => {},
        host: { root: () => activeDocument.body, formatDate: (value) => value },
      });
    controls.initializeListViewState();
    expect(state.get('centerListViewState').groupBy).toBe('none');
    controls.addPropertyFilter({ type: 'tag', value: '#new' });
    expect(settings.listViewStates[`group:${id}`]?.filters).toEqual([
      { type: 'tag', value: '#new' },
    ]);
    expect(settings.listViewStates['group:discovered:tag:%23work']?.groupBy).toBe('priority');
    controls.initializeListViewState();
    expect(state.get('centerListViewState').filters).toEqual([{ type: 'tag', value: '#new' }]);
  });
});
