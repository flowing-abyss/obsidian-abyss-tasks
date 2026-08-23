import moment from 'moment';
import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import type { CalendarSettings, TagGroup } from '../src/settings/types';
import type { TaskSnapshot } from '../src/tasks';
import { PanelNavigator } from '../src/views/panelNavigation';
import { fixedToday, makeCenterPanelForTest, makeStubStore, task, useRealMoment } from './helpers';

const TODAY = moment().format('YYYY-MM-DD');

useRealMoment();

/**
 * Construct a CenterPanel wired to a stub store + real AppState + DEFAULT_SETTINGS.
 * Pure helpers don't touch the DOM or vault, so `app` is a minimal stub.
 */
function makePanel(
  tasks: TaskSnapshot[],
  settings: CalendarSettings = DEFAULT_SETTINGS,
  state: AppState = new AppState(),
): { panel: CenterPanel; state: AppState } {
  const store = makeStubStore(tasks);
  const app = {} as App;
  const panel = makeCenterPanelForTest(state, store, app, settings, null as never);
  return { panel, state };
}

/** Bracket-access helper to call private methods (preserves `this` binding). */
function call<T>(panel: CenterPanel, method: string, ...args: unknown[]): T {
  const fn = (panel as unknown as Record<string, (...a: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

describe('CenterPanel pure helpers', () => {
  describe('getFilteredTasks', () => {
    it('inbox delegates to getInboxTasks (untagged mode excludes tagged)', () => {
      const tasks = [
        task({
          title: 'no tag',
          source: { originalMarkdown: '- [ ] no tag', originalBlock: '- [ ] no tag' },
        }),
        task({
          title: 'tagged',
          tags: ['#work'],
          source: { originalMarkdown: '- [ ] tagged #work', originalBlock: '- [ ] tagged #work' },
        }),
      ];
      const settings: CalendarSettings = {
        ...DEFAULT_SETTINGS,
        inbox: { mode: 'untagged', tag: '', removeTagOnAssign: false },
      };
      const { panel, state } = makePanel(tasks, settings);
      state.set('selectedList', 'inbox');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['no tag']);
    });

    it('today includes only tasks due or scheduled today', () => {
      const tasks = [
        task({
          title: 'dueToday',
          planning: { due: TODAY },
          source: { originalMarkdown: '- [ ] dueToday', originalBlock: '- [ ] dueToday' },
        }),
        task({
          title: 'schedToday',
          planning: { scheduled: TODAY },
          source: { originalMarkdown: '- [ ] schedToday', originalBlock: '- [ ] schedToday' },
        }),
        task({
          title: 'dnToday',
          source: { originalMarkdown: '- [ ] dnToday', originalBlock: '- [ ] dnToday' },
          presentation: { dailyNoteDate: TODAY },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'today');
      fixedToday(TODAY);
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title).sort((a, b) => a.localeCompare(b))).toEqual([
        'dueToday',
        'schedToday',
      ]);
    });

    it('today includes overdue (due < today)', () => {
      const tasks = [
        task({
          title: 'overdue',
          planning: { due: '2026-06-20' },
          source: { originalMarkdown: '- [ ] overdue', originalBlock: '- [ ] overdue' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'today');
      fixedToday('2026-06-25');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['overdue']);
    });

    it('today does NOT include overdue via scheduled/dailyNoteDate only (CURRENT BEHAVIOR: only due<today counts as overdue, follow-up: FU-31)', () => {
      const tasks = [
        task({
          title: 'sched-overdue',
          planning: { scheduled: '2026-06-20', due: undefined },
          source: { originalMarkdown: '- [ ] sched-overdue', originalBlock: '- [ ] sched-overdue' },
        }),
        task({
          title: 'dn-overdue',
          planning: { due: undefined },
          source: { originalMarkdown: '- [ ] dn-overdue', originalBlock: '- [ ] dn-overdue' },
          presentation: { dailyNoteDate: '2026-06-20' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'today');
      fixedToday('2026-06-25');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      // FU-31: only t.due < today triggers overdue inclusion; scheduled/dailyNoteDate overdue are NOT included
      expect(result).toHaveLength(0);
    });

    it('today excludes done tasks', () => {
      const tasks = [
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          planning: { due: '2026-06-25' },
          source: { originalMarkdown: '- [x] done', originalBlock: '- [x] done' },
        }),
        task({
          title: 'open',
          planning: { due: '2026-06-25' },
          source: { originalMarkdown: '- [ ] open', originalBlock: '- [ ] open' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'today');
      fixedToday('2026-06-25');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['open']);
    });

    it('today excludes future tasks (due > today, not overdue)', () => {
      // Date relative to "now" so the test stays correct as real time passes.
      const future = moment().add(5, 'days').format('YYYY-MM-DD');
      const tasks = [
        task({
          title: 'future',
          planning: { due: future },
          source: { originalMarkdown: '- [ ] future', originalBlock: '- [ ] future' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'today');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result).toHaveLength(0);
    });

    it('upcoming returns open tasks with date > today, sorted', () => {
      // Dates relative to "now" so the test stays correct as real time passes.
      const near = moment().add(3, 'days').format('YYYY-MM-DD');
      const far = moment().add(15, 'days').format('YYYY-MM-DD');
      const past = moment().subtract(5, 'days').format('YYYY-MM-DD');
      const tasks = [
        task({
          title: 'far',
          planning: { due: far },
          source: { originalMarkdown: '- [ ] far', originalBlock: '- [ ] far' },
        }),
        task({
          title: 'near',
          planning: { due: near },
          source: { originalMarkdown: '- [ ] near', originalBlock: '- [ ] near' },
        }),
        task({
          title: 'past',
          planning: { due: past },
          source: { originalMarkdown: '- [ ] past', originalBlock: '- [ ] past' },
        }),
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          planning: { due: near },
          source: { originalMarkdown: '- [x] done', originalBlock: '- [x] done' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'upcoming');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['near', 'far']);
    });

    it('upcoming uses due or scheduled dates, not daily-note metadata', () => {
      // Dates relative to "now" so the test stays correct as real time passes.
      const sched = moment().add(3, 'days').format('YYYY-MM-DD');
      const dn = moment().add(4, 'days').format('YYYY-MM-DD');
      const tasks = [
        task({
          title: 'sched',
          planning: { scheduled: sched },
          source: { originalMarkdown: '- [ ] sched', originalBlock: '- [ ] sched' },
        }),
        task({
          title: 'dn',
          source: { originalMarkdown: '- [ ] dn', originalBlock: '- [ ] dn' },
          presentation: { dailyNoteDate: dn },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'upcoming');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['sched']);
    });

    it('default string selection returns all open tasks', () => {
      // 'today' is a known string; use a non-matching string by casting
      const tasks = [
        task({
          title: 'open',
          source: { originalMarkdown: '- [ ] open', originalBlock: '- [ ] open' },
        }),
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          source: { originalMarkdown: '- [x] done', originalBlock: '- [x] done' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'unknown-list' as unknown as 'inbox');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['open']);
    });

    it('{type:"tag"} filters query snapshots by tag and open status', () => {
      const tasks = [
        task({
          title: 'work',
          tags: ['#work'],
          source: { originalMarkdown: '- [ ] work #work', originalBlock: '- [ ] work #work' },
        }),
        task({
          title: 'workDone',
          status: 'done',
          statusSymbol: 'x',
          tags: ['#work'],
          source: {
            originalMarkdown: '- [x] workDone #work',
            originalBlock: '- [x] workDone #work',
          },
        }),
        task({
          title: 'personal',
          tags: ['#personal'],
          source: {
            originalMarkdown: '- [ ] personal #personal',
            originalBlock: '- [ ] personal #personal',
          },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', { type: 'tag', tag: '#work' });
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['work']);
    });

    it('{type:"group"} prefix mode matches rawText includes #prefix', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
        color: '#f00',
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const tasks = [
        task({
          title: 'work',
          tags: ['#work'],
          source: { originalMarkdown: '- [ ] work #work', originalBlock: '- [ ] work #work' },
        }),
        task({
          title: 'workSub',
          tags: ['#work/deep'],
          source: {
            originalMarkdown: '- [ ] workSub #work/deep',
            originalBlock: '- [ ] workSub #work/deep',
          },
        }),
        task({
          title: 'other',
          tags: ['#personal'],
          source: {
            originalMarkdown: '- [ ] other #personal',
            originalBlock: '- [ ] other #personal',
          },
        }),
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          tags: ['#work'],
          source: { originalMarkdown: '- [x] done #work', originalBlock: '- [x] done #work' },
        }),
      ];
      const { panel, state } = makePanel(tasks, settings);
      state.set('selectedList', { type: 'group', groupId: 'g1' });
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title).sort((a, b) => a.localeCompare(b))).toEqual([
        'work',
        'workSub',
      ]);
    });

    it('{type:"group"} manual mode matches any tag in group.tags', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Manual',
        mode: 'manual',
        tags: ['#a', '#b'],
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const tasks = [
        task({
          title: 'a',
          tags: ['#a'],
          source: { originalMarkdown: '- [ ] a #a', originalBlock: '- [ ] a #a' },
        }),
        task({
          title: 'b',
          tags: ['#b'],
          source: { originalMarkdown: '- [ ] b #b', originalBlock: '- [ ] b #b' },
        }),
        task({
          title: 'c',
          tags: ['#c'],
          source: { originalMarkdown: '- [ ] c #c', originalBlock: '- [ ] c #c' },
        }),
      ];
      const { panel, state } = makePanel(tasks, settings);
      state.set('selectedList', { type: 'group', groupId: 'g1' });
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title).sort((a, b) => a.localeCompare(b))).toEqual(['a', 'b']);
    });

    it('{type:"group"} with missing groupId returns empty', () => {
      const tasks = [
        task({
          title: 'a',
          tags: ['#a'],
          source: { originalMarkdown: '- [ ] a #a', originalBlock: '- [ ] a #a' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', { type: 'group', groupId: 'nope' });
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result).toHaveLength(0);
    });

    it('centerFilter filters by text (case-insensitive)', () => {
      const tasks = [
        task({
          title: 'Buy Milk',
          source: { originalMarkdown: '- [ ] Buy Milk', originalBlock: '- [ ] Buy Milk' },
        }),
        task({
          title: 'Walk dog',
          source: { originalMarkdown: '- [ ] Walk dog', originalBlock: '- [ ] Walk dog' },
        }),
      ];
      const settings: CalendarSettings = {
        ...DEFAULT_SETTINGS,
        inbox: { mode: 'untagged', tag: '', removeTagOnAssign: false },
      };
      const { panel, state } = makePanel(tasks, settings);
      state.set('selectedList', 'inbox');
      state.set('centerFilter', 'milk');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result.map((t) => t.title)).toEqual(['Buy Milk']);
    });

    it('centerFilter filters by rawText', () => {
      const tasks = [
        task({
          title: 'task',
          tags: ['#urgent-marker'],
          source: {
            originalMarkdown: '- [ ] task #urgent-marker',
            originalBlock: '- [ ] task #urgent-marker',
          },
        }),
        task({
          title: 'task2',
          tags: ['#other'],
          source: { originalMarkdown: '- [ ] task2 #other', originalBlock: '- [ ] task2 #other' },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', 'inbox');
      state.set('centerFilter', 'urgent-marker');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      // CURRENT BEHAVIOR: inbox=untagged mode excludes tagged tasks before filter,
      // so the #urgent-marker task is removed by getInboxTasks; centerFilter then
      // has nothing to match. Use tag selection to keep tagged tasks.
      // This test documents the inbox pre-filter interaction.
      expect(result).toHaveLength(0);
    });

    it('centerFilter filters by rawText on tag selection', () => {
      const tasks = [
        task({
          title: 'same',
          tags: ['#work'],
          source: {
            originalMarkdown: '- [ ] same #work urgent-marker',
            originalBlock: '- [ ] same #work urgent-marker',
          },
        }),
        task({
          title: 'same',
          tags: ['#work'],
          source: {
            originalMarkdown: '- [ ] same #work other',
            originalBlock: '- [ ] same #work other',
          },
        }),
      ];
      const { panel, state } = makePanel(tasks);
      state.set('selectedList', { type: 'tag', tag: '#work' });
      state.set('centerFilter', 'urgent-marker');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result).toHaveLength(1);
      expect(result[0]?.source.originalMarkdown).toContain('urgent-marker');
    });

    it('centerFilter empty returns all (no filtering)', () => {
      const tasks = [
        task({ title: 'a', source: { originalMarkdown: '- [ ] a', originalBlock: '- [ ] a' } }),
        task({ title: 'b', source: { originalMarkdown: '- [ ] b', originalBlock: '- [ ] b' } }),
      ];
      const settings: CalendarSettings = {
        ...DEFAULT_SETTINGS,
        inbox: { mode: 'untagged', tag: '', removeTagOnAssign: false },
      };
      const { panel, state } = makePanel(tasks, settings);
      state.set('selectedList', 'inbox');
      state.set('centerFilter', '');
      const result = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
      expect(result).toHaveLength(2);
    });
  });

  describe('getTitle', () => {
    it('inbox → "Inbox"', () => {
      const { panel, state } = makePanel([]);
      state.set('selectedList', 'inbox');
      expect(call<string>(panel, 'getTitle')).toBe('Inbox');
    });

    it('today → "Today"', () => {
      const { panel, state } = makePanel([]);
      state.set('selectedList', 'today');
      expect(call<string>(panel, 'getTitle')).toBe('Today');
    });

    it('upcoming → "Upcoming"', () => {
      const { panel, state } = makePanel([]);
      state.set('selectedList', 'upcoming');
      expect(call<string>(panel, 'getTitle')).toBe('Upcoming');
    });

    it('{type:"tag"} → the tag string', () => {
      const { panel, state } = makePanel([]);
      state.set('selectedList', { type: 'tag', tag: '#work' });
      expect(call<string>(panel, 'getTitle')).toBe('#work');
    });

    it('{type:"group"} → group.name', () => {
      const group: TagGroup = { id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const { panel, state } = makePanel([], settings);
      state.set('selectedList', { type: 'group', groupId: 'g1' });
      expect(call<string>(panel, 'getTitle')).toBe('Work');
    });

    it('{type:"group"} with missing group → "Group"', () => {
      const { panel, state } = makePanel([]);
      state.set('selectedList', { type: 'group', groupId: 'nope' });
      expect(call<string>(panel, 'getTitle')).toBe('Group');
    });

    it('unknown selection → "Tasks"', () => {
      const { panel, state } = makePanel([]);
      state.set('selectedList', 'unknown' as unknown as 'inbox');
      expect(call<string>(panel, 'getTitle')).toBe('Tasks');
    });
  });

  describe('formatDate', () => {
    fixedToday('2026-06-25');

    it('today → "Today"', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'formatDate', '2026-06-25')).toBe('Today');
    });

    it('tomorrow → "Tomorrow"', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'formatDate', '2026-06-26')).toBe('Tomorrow');
    });

    it('within ±7 days → "ddd D MMM" format', () => {
      const { panel } = makePanel([]);
      // 2026-06-28 is +3 days → within range
      const result = call<string>(panel, 'formatDate', '2026-06-28');
      // moment formats: e.g. "Sun 28 Jun"
      expect(result).toMatch(/^[A-Z][a-z]{2} 28 Jun$/);
    });

    it('beyond 7 days → "D MMM" format (no weekday)', () => {
      const { panel } = makePanel([]);
      // 2026-07-25 is +30 days → outside ±7
      const result = call<string>(panel, 'formatDate', '2026-07-25');
      expect(result).toBe('25 Jul');
    });
  });

  describe('getDateClass', () => {
    fixedToday('2026-06-25');

    it('d < today → "is-overdue"', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'getDateClass', '2026-06-20')).toBe('is-overdue');
    });

    it('d === today → "is-today"', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'getDateClass', '2026-06-25')).toBe('is-today');
    });

    it('d === tomorrow → "is-tomorrow"', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'getDateClass', '2026-06-26')).toBe('is-tomorrow');
    });

    it('d === dayAfterTomorrow → "is-soon"', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'getDateClass', '2026-06-27')).toBe('is-soon');
    });

    it('other future date → ""', () => {
      const { panel } = makePanel([]);
      expect(call<string>(panel, 'getDateClass', '2026-07-10')).toBe('');
    });
  });

  describe('getListViewDefaults', () => {
    it('today list uses date grouping', () => {
      expect(getListViewDefaults('today').groupBy).toBe('date');
    });

    it('upcoming list uses date grouping', () => {
      expect(getListViewDefaults('upcoming').groupBy).toBe('date');
    });

    it('inbox list uses no grouping', () => {
      expect(getListViewDefaults('inbox').groupBy).toBe('none');
    });

    it('tag list uses no grouping', () => {
      expect(getListViewDefaults('tag:#work').groupBy).toBe('none');
    });

    it('all lists default to active show and date sort ascending', () => {
      for (const key of ['today', 'upcoming', 'inbox', 'tag:#work']) {
        const d = getListViewDefaults(key);
        expect(d.statusGroups).toEqual(['todo', 'in-progress']);
        expect(d.sortBy.field).toBe('date');
        expect(d.sortBy.dir).toBe('asc');
        expect(d.filters).toHaveLength(0);
      }
    });
  });

  describe('per-list state management', () => {
    it('loads default state for today list on mount', () => {
      const { state, panel } = makePanel([]);
      const container = document.createElement('div');
      panel.mount(container);
      const vs = state.get('centerListViewState');
      expect(vs.groupBy).toBe('date');
      expect(vs.statusGroups).toEqual(['todo', 'in-progress']);
    });

    it('switches to inbox defaults through semantic navigation', () => {
      const settings = structuredClone(DEFAULT_SETTINGS);
      const { state, panel } = makePanel([], settings);
      const container = document.createElement('div');
      panel.mount(container);
      new PanelNavigator(state, settings, panel).openList('inbox');
      const vs = state.get('centerListViewState');
      expect(vs.groupBy).toBe('none');
    });
  });

  describe('getTagColor', () => {
    it('prefix mode: exact match returns group.color', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
        color: '#ff0000',
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const { panel } = makePanel([], settings);
      expect(call<string | undefined>(panel, 'getTagColor', '#work')).toBe('#ff0000');
    });

    it('prefix mode: slash-subtag matches (e.g. #work/deep)', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
        color: '#ff0000',
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const { panel } = makePanel([], settings);
      expect(call<string | undefined>(panel, 'getTagColor', '#work/deep')).toBe('#ff0000');
    });

    it('manual mode: matches tag with or without leading #', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Manual',
        mode: 'manual',
        tags: ['#urgent', 'low'],
        color: '#00ff00',
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const { panel } = makePanel([], settings);
      expect(call<string | undefined>(panel, 'getTagColor', '#urgent')).toBe('#00ff00');
      expect(call<string | undefined>(panel, 'getTagColor', '#low')).toBe('#00ff00');
    });

    it('no matching group → undefined', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
        color: '#ff0000',
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const { panel } = makePanel([], settings);
      expect(call<string | undefined>(panel, 'getTagColor', '#personal')).toBeUndefined();
    });

    it('empty tagGroups → undefined', () => {
      const { panel } = makePanel([]);
      expect(call<string | undefined>(panel, 'getTagColor', '#anything')).toBeUndefined();
    });

    it('group with no color property → undefined', () => {
      const group: TagGroup = {
        id: 'g1',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
        // no color
      };
      const settings: CalendarSettings = { ...DEFAULT_SETTINGS, tagGroups: [group] };
      const { panel } = makePanel([], settings);
      expect(call<string | undefined>(panel, 'getTagColor', '#work')).toBeUndefined();
    });
  });
});

describe('getFilteredTasks respects the unified Show status filter (statusGroups)', () => {
  const untaggedSettings: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    inbox: { mode: 'untagged', tag: '', removeTagOnAssign: false },
  };

  it('statusGroups=[todo,in-progress] (Active preset) excludes done tasks', () => {
    const { panel, state } = makePanel(
      [
        task({
          title: 'open',
          status: 'open',
          statusSymbol: ' ',
          source: { originalMarkdown: '- [ ] open', originalBlock: '- [ ] open' },
        }),
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          source: { originalMarkdown: '- [x] done', originalBlock: '- [x] done' },
        }),
      ],
      untaggedSettings,
    );
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      statusGroups: ['todo', 'in-progress'],
      filters: [],
    });
    state.set('selectedList', 'inbox');
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks.every((t) => t.status !== 'done')).toBe(true);
  });

  it('statusGroups=[done,cancelled] returns only done/cancelled tasks', () => {
    const { panel, state } = makePanel(
      [
        task({
          title: 'open',
          status: 'open',
          statusSymbol: ' ',
          source: { originalMarkdown: '- [ ] open', originalBlock: '- [ ] open' },
        }),
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          source: { originalMarkdown: '- [x] done', originalBlock: '- [x] done' },
        }),
      ],
      untaggedSettings,
    );
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      statusGroups: ['done', 'cancelled'],
      filters: [],
    });
    state.set('selectedList', 'inbox');
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
  });

  it('statusGroups=undefined (All preset) returns both', () => {
    const { panel, state } = makePanel(
      [
        task({
          title: 'open',
          status: 'open',
          statusSymbol: ' ',
          source: { originalMarkdown: '- [ ] open', originalBlock: '- [ ] open' },
        }),
        task({
          title: 'done',
          status: 'done',
          statusSymbol: 'x',
          source: { originalMarkdown: '- [x] done', originalBlock: '- [x] done' },
        }),
      ],
      untaggedSettings,
    );
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      statusGroups: undefined,
      filters: [],
    });
    state.set('selectedList', 'inbox');
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks.length).toBe(2);
  });
});

describe('getFilteredTasks respects property filters', () => {
  it('tag filter keeps only tasks with matching tag', () => {
    const { panel, state } = makePanel([
      task({
        title: 'work task',
        status: 'open',
        tags: ['#work'],
        source: {
          originalMarkdown: '- [ ] work task #work',
          originalBlock: '- [ ] work task #work',
        },
      }),
      task({
        title: 'personal',
        status: 'open',
        tags: ['#personal'],
        source: {
          originalMarkdown: '- [ ] personal #personal',
          originalBlock: '- [ ] personal #personal',
        },
      }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'tag', value: '#work' }],
    });
    state.set('selectedList', { type: 'tag', tag: '#work' });
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('work task');
  });

  it('tag filter does not match partial tags (#work does not match #work/deep)', () => {
    const { panel, state } = makePanel([
      task({
        title: 'exact',
        status: 'open',
        tags: ['#work'],
        source: { originalMarkdown: '- [ ] task #work', originalBlock: '- [ ] task #work' },
      }),
      task({
        title: 'sub',
        status: 'open',
        tags: ['#work/deep'],
        source: {
          originalMarkdown: '- [ ] task #work/deep',
          originalBlock: '- [ ] task #work/deep',
        },
      }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'tag', value: '#work' }],
    });
    // 'upcoming' with no dates → default branch returns all query snapshots
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('exact');
  });

  it('file filter keeps only tasks from that file', () => {
    const { panel, state } = makePanel([
      task({ title: 'from a', status: 'open', source: { filePath: 'notes/a.md' } }),
      task({ title: 'from b', status: 'open', source: { filePath: 'notes/b.md' } }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'file', filePath: 'notes/a.md' }],
    });
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('from a');
  });

  it('time filter keeps only tasks with matching time', () => {
    const { panel, state } = makePanel([
      task({ title: 'morning', status: 'open', planning: { time: '09:00' } }),
      task({ title: 'afternoon', status: 'open', planning: { time: '14:00' } }),
      task({ title: 'no time', status: 'open' }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'time', value: '09:00' }],
    });
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('morning');
  });

  it('priority filter keeps only tasks with matching priority', () => {
    const { panel, state } = makePanel([
      task({ title: 'high', status: 'open', priority: 'B' }),
      task({ title: 'normal', status: 'open', priority: 'D' }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'priority', value: 'B' }],
    });
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('high');
  });

  it('status filter keeps only tasks with matching statusSymbol', () => {
    const { panel, state } = makePanel([
      task({ title: 'inProgress', status: 'in-progress', statusSymbol: '/' }),
      task({ title: 'todo', status: 'open', statusSymbol: ' ' }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'status', value: '/' }],
    });
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('inProgress');
  });

  it('date filter matches explicit planning dates, not daily-note metadata', () => {
    const { panel, state } = makePanel([
      task({ title: 'due', status: 'open', planning: { due: '2026-01-10' } }),
      task({ title: 'sched', status: 'open', planning: { scheduled: '2026-01-10' } }),
      task({ title: 'daily', status: 'open', presentation: { dailyNoteDate: '2026-01-10' } }),
      task({ title: 'other', status: 'open', planning: { due: '2026-01-11' } }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'date', value: '2026-01-10' }],
    });
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['due', 'sched']));
  });

  it('multiple property filters are combined with AND', () => {
    const { panel, state } = makePanel([
      task({
        title: 'work morning',
        status: 'open',
        tags: ['#work'],
        planning: { time: '09:00' },
        source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
      }),
      task({
        title: 'work afternoon',
        status: 'open',
        tags: ['#work'],
        planning: { time: '14:00' },
        source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
      }),
      task({
        title: 'personal morning',
        status: 'open',
        tags: ['#personal'],
        planning: { time: '09:00' },
        source: { originalMarkdown: '- [ ] t #personal', originalBlock: '- [ ] t #personal' },
      }),
    ]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [
        { type: 'tag', value: '#work' },
        { type: 'time', value: '09:00' },
      ],
    });
    state.set(
      'selectedList',
      'all-tasks' as unknown as import('../src/app/AppState').ListSelection,
    );
    const tasks = call<TaskSnapshot[]>(panel, 'getFilteredTasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('work morning');
  });
});

describe('addPropertyFilter', () => {
  it('adds a filter to the current list view state', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [],
    });
    call(panel, 'addPropertyFilter', { type: 'tag', value: '#work' });
    expect(state.get('centerListViewState').filters).toHaveLength(1);
    expect(state.get('centerListViewState').filters[0]).toEqual({ type: 'tag', value: '#work' });
  });

  it('deduplicates tag filters by value', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'tag', value: '#work' }],
    });
    call(panel, 'addPropertyFilter', { type: 'tag', value: '#work' });
    expect(state.get('centerListViewState').filters).toHaveLength(1);
  });

  it('deduplicates file filters by filePath', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'file', filePath: 'a.md' }],
    });
    call(panel, 'addPropertyFilter', { type: 'file', filePath: 'a.md' });
    expect(state.get('centerListViewState').filters).toHaveLength(1);
  });

  it('deduplicates date filters by value', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'date', value: '2026-01-10' }],
    });
    call(panel, 'addPropertyFilter', { type: 'date', value: '2026-01-10' });
    expect(state.get('centerListViewState').filters).toHaveLength(1);
  });

  it('deduplicates status filters by value', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'status', value: '/' }],
    });
    call(panel, 'addPropertyFilter', { type: 'status', value: '/' });
    expect(state.get('centerListViewState').filters).toHaveLength(1);
  });

  it('allows different filter types with the same value', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [{ type: 'tag', value: '#work' }],
    });
    call(panel, 'addPropertyFilter', { type: 'time', value: '#work' });
    expect(state.get('centerListViewState').filters).toHaveLength(2);
  });
});

describe('removePropertyFilter', () => {
  it('removes filter at given index', () => {
    const { panel, state } = makePanel([]);
    state.set('centerListViewState', {
      groupBy: 'none',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [
        { type: 'tag', value: '#work' },
        { type: 'tag', value: '#personal' },
      ],
    });
    call(panel, 'removePropertyFilter', 0);
    const filters = state.get('centerListViewState').filters;
    expect(filters).toHaveLength(1);
    expect(filters[0]).toEqual({ type: 'tag', value: '#personal' });
  });
});

describe('filterChipLabel', () => {
  it('tag filter → tag value', () => {
    const { panel } = makePanel([]);
    expect(call<string>(panel, 'filterChipLabel', { type: 'tag', value: '#work' })).toBe('#work');
  });

  it('file filter → filename without extension', () => {
    const { panel } = makePanel([]);
    expect(
      call<string>(panel, 'filterChipLabel', { type: 'file', filePath: 'notes/Daily Note.md' }),
    ).toBe('📄 Daily Note');
  });

  it('time filter → clock emoji + time', () => {
    const { panel } = makePanel([]);
    expect(call<string>(panel, 'filterChipLabel', { type: 'time', value: '09:00' })).toBe(
      '⏰ 09:00',
    );
  });

  it('priority filter → emoji label', () => {
    const { panel } = makePanel([]);
    expect(call<string>(panel, 'filterChipLabel', { type: 'priority', value: 'B' })).toBe(
      '⏫ High',
    );
  });

  it('status filter → status name from registry', () => {
    const { panel } = makePanel([]);
    expect(call<string>(panel, 'filterChipLabel', { type: 'status', value: '/' })).toBe(
      'In progress',
    );
  });

  it('status filter → raw symbol fallback when unknown', () => {
    const { panel } = makePanel([]);
    expect(call<string>(panel, 'filterChipLabel', { type: 'status', value: '~' })).toBe('~');
  });
});
