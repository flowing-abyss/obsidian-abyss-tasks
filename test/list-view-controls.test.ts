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
