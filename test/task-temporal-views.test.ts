import { afterEach, expect, it, vi } from 'vitest';
import { moment } from '../src/obsidianMoment';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { expectDefined, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

it.each(['list', 'kanban', 'timeline'] as const)(
  'keeps Today and Upcoming status-aware in %s, with the same membership after search',
  async (view) => {
    const today = moment().format('YYYY-MM-DD');
    const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');
    const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.listViewStates = Object.fromEntries(
      ['today', 'upcoming'].map((key) => [
        key,
        {
          ...getListViewDefaults(key),
          view,
          statusGroups: ['todo', 'in-progress', 'done', 'cancelled'],
          groupBy: 'date',
        },
      ]),
    );
    const h = await mountCanonicalSearchUi(
      {
        'dates.md': [
          `- [ ] qa overdue 📅 ${yesterday}`,
          `- [ ] qa today 📅 ${today}`,
          `- [/] qa ongoing 🛫 ${yesterday} 📅 ${tomorrow}`,
          `- [ ] qa future ⏳ ${tomorrow}`,
          `- [x] qa finished ✅ ${today}`,
          `- [x] qa finished early 🛫 ${yesterday} 📅 ${tomorrow} ✅ ${today}`,
          `- [x] qa old done 📅 ${today} ✅ ${yesterday}`,
          `- [x] qa old future 📅 ${tomorrow} ✅ ${yesterday}`,
          `- [x] qa no completion 📅 ${today}`,
          `- [-] qa cancelled today ❌ ${today}`,
          `- [-] qa cancelled future 📅 ${tomorrow} ❌ ${yesterday}`,
          `- [ ] qa rescheduled 🛫 ${yesterday} 📅 ${yesterday} ⏳ ${tomorrow}`,
          `- [ ] qa scheduled before start 🛫 ${tomorrow} 📅 ${tomorrow} ⏳ ${today}`,
        ].join('\n'),
      },
      settings,
      'tasks',
    );
    const titles = () =>
      [...h.root.querySelectorAll('.abyss-task-card .abyss-task-title')]
        .map((el) => el.textContent)
        .sort((a, b) => a.localeCompare(b));
    try {
      for (const query of ['', 'qa']) {
        h.state.batch(() => {
          h.state.set('selectedList', 'today');
          h.state.set('centerListViewState', expectDefined(settings.listViewStates?.['today']));
        });
        h.query(query);
        if (view !== 'list' || query !== '') await h.completed();
        expect(titles()).toEqual([
          'qa cancelled today',
          'qa finished',
          'qa finished early',
          'qa ongoing',
          'qa overdue',
          'qa rescheduled',
          'qa scheduled before start',
          'qa today',
        ]);
        const rows = h.panel['mountedRows_abyssPrivate'].rows;
        const finished = rows.rowAt(rows.rowIndexOf('dates.md:5'));
        expect(finished?.kind === 'task' ? finished.presentation : undefined).toMatchObject({
          kind: 'today',
          displayDate: today,
          completion: { kind: 'allowed' },
        });
        h.state.batch(() => {
          h.state.set('selectedList', 'upcoming');
          h.state.set('centerListViewState', expectDefined(settings.listViewStates?.['upcoming']));
        });
        h.query(query);
        await h.completed();
        expect(titles()).toEqual([
          'qa future',
          'qa ongoing',
          'qa rescheduled',
          'qa scheduled before start',
        ]);
      }
    } finally {
      h.dispose();
    }
  },
);
