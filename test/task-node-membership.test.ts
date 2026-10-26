import { describe, expect, it } from 'vitest';
import type { ListSelection } from '../src/app/AppState';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { selectTaskNodes } from '../src/task-lists/TaskListSelector';
import {
  admitsTaskNode,
  isActiveTaskNode,
  taskNodeMembershipValue,
} from '../src/task-lists/taskNodeMembership';
import { localDate } from '../src/tasks';
import { expectDefined } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

const today = localDate('2026-10-08');
const settings = {
  ...DEFAULT_SETTINGS,
  inbox: { ...DEFAULT_SETTINGS.inbox, mode: 'both' as const, tag: '#inbox' },
};
const markdown =
  '- [ ] Parent #one-off\n  - [/] Child #INBOX 🛫 2026-10-07 📅 2026-10-09\n    - [ ] Deep untagged\n    - [ ] Deep tagged #inbox\n  - [x] Done #inbox\n- [ ] Both #inbox\n  - [ ] Both child #inbox\n- [ ] Untagged\n- [ ] Work #work\n  - [ ] Nested #work/deep';

describe('own-node destination membership', () => {
  it('keeps active overdue in Today and excludes finished work from Upcoming by own lifecycle dates', async () => {
    const customSettings = structuredClone(settings);
    customSettings.taskStatuses.push({
      id: 'approved',
      symbol: 'v',
      name: 'Approved',
      type: 'done',
      icon: '',
      core: false,
    });
    const h = await createCanonicalSearchHarness(
      {
        'dates.md': [
          '- [ ] Overdue 📅 2026-09-01',
          '- [/] Ongoing 🛫 2026-10-07 📅 2026-10-10',
          '- [ ] Scheduled today ⏳ 2026-10-08',
          '- [ ] Starts today 🛫 2026-10-08',
          '- [ ] Tomorrow 📅 2026-10-09',
          '- [ ] Scheduled future ⏳ 2026-10-10',
          '- [ ] Starts future 🛫 2026-10-11',
          '- [ ] Undated',
          '- [ ] Created today ➕ 2026-10-08',
          '- [ ] Old scheduled ⏳ 2026-10-07',
          '- [x] Done today ✅ 2026-10-08',
          '- [x] Done today old due 📅 2026-09-01 ✅ 2026-10-08',
          '- [x] Done today future due 📅 2026-10-11 ✅ 2026-10-08',
          '- [x] Old done due today 📅 2026-10-08 ✅ 2026-10-07',
          '- [x] Old done overdue 📅 2026-09-01 ✅ 2026-10-07',
          '- [x] Old done future 📅 2026-10-09 ✅ 2026-10-07',
          '- [x] Missing completion 📅 2026-10-08',
          '- [x] Future completion 📅 2026-10-08 ✅ 2026-10-09',
          '- [-] Cancelled today ❌ 2026-10-08',
          '- [-] Old cancelled 📅 2026-10-08 ❌ 2026-10-07',
          '- [-] Cancelled future 📅 2026-10-09 ❌ 2026-10-07',
          '- [v] Custom done ✅ 2026-10-08',
          '- [v] Custom old 📅 2026-10-08 ✅ 2026-10-07',
          '- [ ] Parent',
          '  - [x] Child done ✅ 2026-10-08',
          '  - [x] Child old 📅 2026-10-08 ✅ 2026-10-07',
          '  - [ ] Child overdue 📅 2026-10-07',
          '  - [ ] Child future 🛫 2026-10-09',
        ].join('\n'),
      },
      customSettings,
    );
    try {
      const tasks = h.index.listNodes();
      const select = (selection: 'today' | 'upcoming') =>
        selectTaskNodes({
          tasks,
          selection,
          settings: customSettings,
          today,
          nowMs: 0,
          viewState: {
            ...getListViewDefaults(selection),
            statusGroups: [],
            groupBy: 'none',
            sortBy: { field: 'title', dir: 'asc' },
          },
        }).map(({ node }) => node.title);
      expect(select('today')).toEqual([
        'Cancelled today',
        'Child done',
        'Child overdue',
        'Custom done',
        'Done today',
        'Done today future due',
        'Done today old due',
        'Ongoing',
        'Overdue',
        'Scheduled today',
        'Starts today',
      ]);
      expect(select('upcoming')).toEqual([
        'Child future',
        'Ongoing',
        'Scheduled future',
        'Starts future',
        'Tomorrow',
      ]);
    } finally {
      h.close();
    }
  });
  it.each(['Parent', 'Deep tagged'])(
    'reads only membership fields from %s without enumerating the node',
    async (title) => {
      const h = await createCanonicalSearchHarness({ 'tasks.md': markdown }, settings);
      try {
        const node = expectDefined(h.index.listNodes().find(({ node }) => node.title === title));
        let enumerations = 0;
        const projected = taskNodeMembershipValue({
          ...node,
          node: new Proxy(node.node, {
            ownKeys(target) {
              enumerations++;
              return Reflect.ownKeys(target);
            },
          }),
        });
        expect(enumerations).toBe(0);
        expect(projected).toEqual({
          depth: node.path.length,
          tags: node.node.tags,
          planning: node.node.planning,
          status: node.node.status,
          statusSymbol: node.node.statusSymbol,
          source: { filePath: 'tasks.md', line: title === 'Parent' ? 0 : 3 },
        });
      } finally {
        h.close();
      }
    },
  );
  it.each([
    ['tag', 'tag', ['Both', 'Both child', 'Child', 'Deep tagged']],
    ['both', 'both', ['Both', 'Both child', 'Child', 'Deep tagged', 'Untagged']],
    ['untagged', 'untagged', ['Untagged']],
  ] as const)(
    'selects Inbox %s without borrowing ancestor tags or promoting untagged children',
    async (_name, mode, expected) => {
      const h = await createCanonicalSearchHarness({ 'tasks.md': markdown }, settings);
      try {
        const nodes = h.index.listNodes();
        const result = selectTaskNodes({
          tasks: nodes,
          selection: 'inbox',
          settings: { ...settings, inbox: { ...settings.inbox, mode } },
          today,
          nowMs: 0,
          viewState: { ...getListViewDefaults('inbox'), sortBy: { field: 'title', dir: 'asc' } },
        });
        expect(result.map(({ node }) => node.title)).toEqual(expected);
        const parent = nodes.find(({ node }) => node.title === 'Parent');
        expect(parent?.node.subtasks).toHaveLength(2);
        expect(parent?.node.subtasks.map(({ status }) => status)).toEqual(['in-progress', 'done']);
        const parentSelection = selectTaskNodes({
          tasks: nodes,
          selection: { type: 'tag', tag: '#one-off' },
          settings,
          today,
          nowMs: 0,
          viewState: getListViewDefaults('inbox'),
        });
        expect(parentSelection[0]?.node).toBe(parent?.node);
        expect(
          parentSelection[0]?.node.subtasks.filter(({ status }) => status === 'done'),
        ).toHaveLength(1);
        expect(parent?.node.subtasks[0]?.subtasks).toHaveLength(2);
        expect(result.find(({ node }) => node.title === 'Child')?.target.type).toBe(
          mode === 'untagged' ? undefined : 'subtask',
        );
      } finally {
        h.close();
      }
    },
  );
  it('shares own tags, exact aliases, prefix policy, root-only projects and explicit filters', async () => {
    const h = await createCanonicalSearchHarness(
      { 'tasks.md': markdown, 'hidden.md': '- [ ] Hidden #inbox\n  - [ ] Hidden child #inbox' },
      settings,
    );
    try {
      await h.index.refreshSourceExclusion((source) => source.filePath === 'hidden.md');
      const tasks = h.index.listNodes();
      const select = (selection: ListSelection | null, textQuery?: string) =>
        selectTaskNodes({
          tasks,
          selection,
          settings,
          today,
          nowMs: 0,
          viewState: { ...getListViewDefaults('inbox'), sortBy: { field: 'title', dir: 'asc' } },
          ...(textQuery === undefined ? {} : { textQuery }),
        }).map(({ node }) => node.title);
      expect(select({ type: 'tag', tag: '#one-off' })).toEqual(['Parent']);
      expect(select({ type: 'tag', tag: '#INBOX' })).toEqual([
        'Both',
        'Both child',
        'Child',
        'Deep tagged',
      ]);
      expect(select({ type: 'tag', tag: '#work' })).toEqual(['Work']);
      expect(select({ type: 'group', groupId: 'discovered:prefix:WORK' })).toEqual([
        'Nested',
        'Work',
      ]);
      expect(select({ type: 'project', path: 'tasks.md' })).toEqual([
        'Both',
        'Parent',
        'Untagged',
        'Work',
      ]);
      expect(select(null)).toEqual(['Both', 'Parent', 'Untagged', 'Work']);
      expect(select('today')).toEqual(['Child']);
      expect(select('upcoming')).toEqual(['Child']);
      expect(select('inbox', 'deep')).toEqual(['Deep tagged']);
      expect(select('inbox', '#inbox')).toEqual(['Both', 'Both child', 'Child', 'Deep tagged']);
      expect(select('inbox', 'Parent')).toEqual([]);
      expect(
        selectTaskNodes({
          tasks,
          selection: 'inbox',
          settings,
          today,
          nowMs: 0,
          viewState: {
            ...getListViewDefaults('inbox'),
            filters: [{ type: 'tag', value: '#one-off' }],
          },
        }),
      ).toEqual([]);
    } finally {
      h.close();
    }
  });
  it('invalid Inbox tag leaves only the allowed untagged root branch and status is semantic', () => {
    const context = {
      selection: 'inbox' as const,
      settings: { ...settings, inbox: { ...settings.inbox, tag: 'two tags' } },
      today,
      observedTags: [],
    };
    const value = {
      depth: 0,
      tags: [],
      planning: {},
      status: 'open' as const,
      statusSymbol: '?',
      source: { filePath: 'x.md', line: 0 },
    };
    expect(admitsTaskNode(value, context)).toBe(true);
    expect(admitsTaskNode({ ...value, depth: 2 }, context)).toBe(false);
    expect(admitsTaskNode({ ...value, tags: ['#two'] }, context)).toBe(false);
    expect(isActiveTaskNode(value)).toBe(true);
    expect(isActiveTaskNode({ status: 'in-progress' })).toBe(true);
    expect(isActiveTaskNode({ status: 'done' })).toBe(false);
    expect(isActiveTaskNode({ status: 'cancelled' })).toBe(false);
  });
});
