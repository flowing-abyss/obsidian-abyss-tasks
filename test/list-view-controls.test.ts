import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { ListViewControls } from '../src/panels/center/ListViewControls';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import type { ListViewState } from '../src/settings/types';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import { deferred, expectDefined, makeStubStore } from './helpers';

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

describe('initial list options indicator', () => {
  it('renders filter-only inactive and a real group customization active', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'tag', tag: '#work' });
    const settings = structuredClone(DEFAULT_SETTINGS);
    const store = makeStubStore([]);
    const container = activeDocument.body.createDiv();
    const controls = new ListViewControls({
      state,
      settings,
      statusRegistry: store.statusRegistry,
      interactionOwnership: noInteractionOwnership,
      saveViewState: async () => {},
      host: { root: () => container, formatDate: (value) => value },
    });
    const filtered: ListViewState = {
      ...getListViewDefaults('tag:#work'),
      filters: [{ type: 'tag', value: '#home' }],
    };
    state.set('centerListViewState', filtered);
    expect(
      controls.renderViewStateButton(container).classList.contains('abyss-view-state-btn--active'),
    ).toBe(false);
    state.set('centerListViewState', { ...filtered, groupBy: 'priority' });
    expect(
      controls.renderViewStateButton(container).classList.contains('abyss-view-state-btn--active'),
    ).toBe(true);
    container.remove();
  });
});

describe('mounted tag polarity chips', () => {
  it('retains focused filter controls on a source refresh and removes the correct updated filter', () => {
    const state = new AppState();
    const root = document.body.createDiv();
    const controls = new ListViewControls({
      state,
      settings: structuredClone(DEFAULT_SETTINGS),
      statusRegistry: makeStubStore([]).statusRegistry,
      interactionOwnership: noInteractionOwnership,
      saveViewState: async () => {},
      host: { root: () => root, formatDate: (value) => value },
    });
    try {
      controls.addPropertyFilter({ type: 'tag', value: '#work' });
      controls.addPropertyFilter({ type: 'priority', value: 'A' });
      let chips = controls.renderPropertyChips(root);
      const close = expectDefined(root.querySelector<HTMLButtonElement>('.abyss-filter-chip-x'));
      close.focus();
      chips = controls.renderPropertyChips(root, undefined, chips);
      expect(document.activeElement).toBe(close);
      expect(root.querySelectorAll('.abyss-filter-chip')).toHaveLength(2);
      close.click();
      chips = controls.renderPropertyChips(root, undefined, chips);
      expect(root.querySelectorAll('.abyss-filter-chip')).toHaveLength(1);
      expect(chips[0]?.textContent).toContain('Highest');
      expectDefined(root.querySelector<HTMLButtonElement>('.abyss-filter-chip-x')).click();
      expect(state.get('centerListViewState').filters).toEqual([]);
    } finally {
      root.remove();
    }
  });
  it('replaces aliases at the original slot, preserves selected spelling and removes through the chip button', () => {
    const state = new AppState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    state.set('selectedList', 'inbox');
    const saveViewState = vi.fn(async () => {});
    const root = document.body.createDiv();
    const controls = new ListViewControls({
      state,
      settings,
      saveViewState,
      statusRegistry: makeStubStore([]).statusRegistry,
      interactionOwnership: noInteractionOwnership,
      host: { root: () => root, formatDate: (value) => value },
    });
    const button = controls.renderViewStateButton(root);
    const render = () => {
      root.querySelectorAll('.abyss-filter-chip').forEach((chip) => {
        chip.remove();
      });
      controls.renderPropertyChips(root, button);
    };
    const off = state.on('centerListViewState', render);
    try {
      controls.addPropertyFilter({ type: 'tag', value: '#work' });
      const included = state.get('centerListViewState');
      controls.addPropertyFilter({ type: 'tag', value: '#WORK' });
      expect(state.get('centerListViewState')).toBe(included);
      expect(saveViewState).toHaveBeenCalledTimes(1);
      controls.addPropertyFilter({ type: 'priority', value: 'A' });
      controls.addPropertyFilter({ type: 'tag-exclude', value: '#Work' });
      expect(
        [...root.querySelectorAll('.abyss-filter-chip-label')].map((el) => el.textContent),
      ).toEqual(['−#Work', '🔺 Highest']);
      expect(saveViewState).toHaveBeenCalledTimes(3);
      controls.addPropertyFilter({ type: 'tag-exclude', value: '#WORK' });
      expect(saveViewState).toHaveBeenCalledTimes(3);
      expect(state.get('centerListViewState').filters).toEqual([
        { type: 'tag-exclude', value: '#Work' },
        { type: 'priority', value: 'A' },
      ]);
      controls.addPropertyFilter({ type: 'tag', value: '#work/deep' });
      expect(state.get('centerListViewState').filters).toHaveLength(3);
      root.querySelector<HTMLButtonElement>('.abyss-filter-chip-x')?.click();
      expect(state.get('centerListViewState').filters).toEqual([
        { type: 'priority', value: 'A' },
        { type: 'tag', value: '#work/deep' },
      ]);
      expect(settings.listViewStates?.['inbox']?.filters).toEqual(
        state.get('centerListViewState').filters,
      );
      expect(saveViewState).toHaveBeenCalledTimes(5);
    } finally {
      off();
      root.remove();
    }
  });
  it('displays canonical hashes for bare and authored inclusion and exclusion values', () => {
    const state = new AppState();
    state.set('centerListViewState', {
      ...getListViewDefaults('all'),
      filters: [
        { type: 'tag', value: 'Work' },
        { type: 'tag-exclude', value: '#Private' },
        { type: 'tag-exclude', value: 'Work/deep' },
      ],
    });
    const root = document.body.createDiv();
    const controls = new ListViewControls({
      state,
      settings: structuredClone(DEFAULT_SETTINGS),
      statusRegistry: makeStubStore([]).statusRegistry,
      interactionOwnership: noInteractionOwnership,
      saveViewState: async () => {},
      host: { root: () => root, formatDate: (value) => value },
    });
    try {
      controls.renderPropertyChips(root, controls.renderViewStateButton(root));
      expect(
        [...root.querySelectorAll('.abyss-filter-chip-label')].map((el) => el.textContent),
      ).toEqual(['#Work', '−#Private', '−#Work/deep']);
    } finally {
      root.remove();
    }
  });
});

describe('task collection view controls', () => {
  it.each(['kanban', 'timeline'] as const)(
    'edits %s organization and visibility without changing saved List preferences',
    async (view) => {
      const state = new AppState();
      const settings = structuredClone(DEFAULT_SETTINGS);
      const root = document.body.createDiv();
      const controls = new ListViewControls({
        state,
        settings,
        saveViewState: async () => {},
        statusRegistry: makeStubStore([]).statusRegistry,
        interactionOwnership: noInteractionOwnership,
        host: { root: () => root, formatDate: (v) => v },
      });
      const list: ListViewState = {
        groupBy: 'date',
        sortBy: { field: 'title', dir: 'desc' },
        statusGroups: ['todo'],
        filters: [{ type: 'tag', value: '#work' }],
      };
      state.set('centerListViewState', list);
      controls.setView(view);
      const options = controls.renderViewStateButton(root);
      options.click();
      const row = (label: string): HTMLElement => {
        const value = [...root.querySelectorAll<HTMLElement>('.abyss-view-state-row')].find(
          (el) => el.querySelector('.abyss-view-state-row-label')?.textContent === label,
        );
        if (value === undefined) throw new Error(`Missing row ${label}`);
        return value;
      };
      const choose = (label: string, option: string): void => {
        const section = row(label);
        const main = section.querySelector<HTMLButtonElement>('.abyss-view-state-row-main');
        if (main?.getAttribute('aria-expanded') !== 'true') main?.click();
        const button = [
          ...section.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option'),
        ].find((el) => el.querySelector('.abyss-view-state-option-label')?.textContent === option);
        if (button === undefined) throw new Error(`Missing option ${option}`);
        button.click();
      };
      try {
        choose('Group by', 'Priority');
        choose('Sort by', view === 'timeline' ? 'Priority' : 'Priority ↑');
        expect(state.get('centerListViewState')).toMatchObject({
          ...list,
          view,
          [view]: {
            groupBy: 'priority',
            sortBy: { field: 'priority', dir: view === 'timeline' ? 'asc' : 'desc' },
          },
        });
        if (view === 'timeline') {
          choose('Scale', 'Week');
          choose('Scheduled', 'Hidden');
          choose('Undated tasks', 'Hidden');
          expect(state.get('centerListViewState').timeline).toMatchObject({
            scale: 'week',
            showScheduled: false,
            showUnscheduled: false,
          });
        }
        choose('Show', 'Active');
        await Promise.resolve();
        expect(row('Show').querySelector('.abyss-view-state-row-value')?.textContent).toBe(
          'Active',
        );
        expect(state.get('centerListViewState')[view]?.hiddenStatuses).toEqual([
          'status-3',
          'status-4',
        ]);
        choose('Show', 'All');
        expect(state.get('centerListViewState')[view]?.hiddenStatuses).toEqual([]);
        choose('Show', 'Done');
        expect(state.get('centerListViewState')[view]?.hiddenStatuses.length).toBe(1);
        controls.closeViewStatePopover();
        controls.setView('list');
        expect(state.get('centerListViewState')).toMatchObject({ ...list, view: 'list' });
        controls.setView(view);
        options.click();
        root.querySelector<HTMLButtonElement>('.abyss-view-state-reset-btn')?.click();
        expect(state.get('centerListViewState')).toMatchObject({
          view,
          sortBy: list.sortBy,
          groupBy: 'date',
          filters: [],
          [view]: {
            groupBy: 'none',
            hiddenStatuses: [],
            sortBy: { field: view === 'kanban' ? 'priority' : 'date', dir: 'asc' },
          },
        });
      } finally {
        controls.closeViewStatePopover();
        root.remove();
      }
    },
  );
});

it('keeps Kanban status visibility in settings order and offers the same grouping fields as List except status', async () => {
  const state = new AppState();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const registry = makeStubStore([]).statusRegistry;
  registry.replace([
    ...registry.all(),
    { id: 'important', name: 'Important', symbol: '!', type: 'todo', icon: '', core: false },
  ]);
  const root = document.body.createDiv();
  const controls = new ListViewControls({
    state,
    settings,
    saveViewState: async () => {},
    statusRegistry: registry,
    interactionOwnership: noInteractionOwnership,
    host: { root: () => root, formatDate: (v) => v },
  });
  try {
    controls.setView('kanban');
    controls.renderViewStateButton(root).click();
    const row = (label: string) =>
      expectDefined(
        [...root.querySelectorAll<HTMLElement>('.abyss-view-state-row')].find(
          (el) => el.querySelector('.abyss-view-state-row-label')?.textContent === label,
        ),
      );
    const labels = (el: HTMLElement) =>
      [...el.querySelectorAll('.abyss-view-state-option-label')].map((x) => x.textContent);
    const groups = row('Group by');
    expectDefined(groups.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    expect(labels(groups)).toEqual([
      'None',
      'Date',
      'Priority',
      'Tag',
      'Source note',
      'Outgoing link',
    ]);
    const show = row('Show');
    expectDefined(show.querySelector<HTMLButtonElement>('.abyss-view-state-row-main')).click();
    const ordered = registry
      .grouped()
      .flatMap((g) => g.statuses)
      .map((s) => s.name);
    expect(labels(show).slice(2)).toEqual(ordered);
    expect(labels(show).slice(0, 2)).toEqual(['Active', 'All']);
    expectDefined(
      [...show.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')].find(
        (b) => b.querySelector('.abyss-view-state-option-label')?.textContent === 'Active',
      ),
    ).click();
    await Promise.resolve();
    expect(state.get('centerListViewState').kanban?.hiddenStatuses).toEqual([
      'status-3',
      'status-4',
    ]);
    expect(labels(show).slice(2)).toEqual(ordered);
    const first = expectDefined(
      [...show.querySelectorAll<HTMLButtonElement>('.abyss-view-state-option')].find(
        (b) => b.querySelector('.abyss-view-state-option-label')?.textContent === ordered[0],
      ),
    );
    first.click();
    await Promise.resolve();
    expect(labels(show).slice(2)).toEqual(ordered);
    expect(first.getAttribute('aria-pressed')).toBe('false');
    first.click();
    await Promise.resolve();
    expect(labels(show).slice(2)).toEqual(ordered);
  } finally {
    controls.closeViewStatePopover();
    root.remove();
  }
});
