import { describe, expect, it } from 'vitest';
import type { ListSelection } from '../src/app/AppState';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { selectTaskNodes } from '../src/task-lists/TaskListSelector';
import { admitsTaskNode, isActiveTaskNode } from '../src/task-lists/taskNodeMembership';
import { localDate } from '../src/tasks';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

const today = localDate('2026-10-08');
const settings = {
  ...DEFAULT_SETTINGS,
  inbox: { ...DEFAULT_SETTINGS.inbox, mode: 'both' as const, tag: '#inbox' },
};
const markdown =
  '- [ ] Parent #one-off\n  - [/] Child #INBOX 🛫 2026-10-07 📅 2026-10-09\n    - [ ] Deep untagged\n    - [ ] Deep tagged #inbox\n  - [x] Done #inbox\n- [ ] Both #inbox\n  - [ ] Both child #inbox\n- [ ] Untagged\n- [ ] Work #work\n  - [ ] Nested #work/deep';

describe('own-node destination membership', () => {
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
