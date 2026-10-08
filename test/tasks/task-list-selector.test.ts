import { outgoingTaskLinkValues } from '../../src/task-lists/taskLinkValues';
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ListSelection } from '../../src/app/AppState';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../../src/settings/defaults';
import type { ListViewState } from '../../src/settings/types';
import { discoveredPrefixGroupId } from '../../src/tags/effectiveTagGroups';
import { searchTaskList, selectTaskList } from '../../src/task-lists/TaskListSelector';
import {
  localDate,
  type LocalDate,
  type SubtaskSnapshot,
  type TaskSnapshot,
  type TimeEntrySnapshot,
} from '../../src/tasks';
import { task, taskFromCodecLine } from '../helpers';

function snapshot(
  title: string,
  over: Partial<TaskSnapshot> & { filePath?: string; line?: number } = {},
): TaskSnapshot {
  const filePath = over.filePath ?? 'tasks.md';
  const line = over.line ?? 0;
  return {
    ref: { filePath, line, revision: `rev:${title}` },
    title,
    markdownTitle: title,
    status: 'open',
    statusSymbol: ' ',
    priority: 'F',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    timeEntries: [],
    source: {
      filePath,
      line,
      originalMarkdown: `- [ ] ${title}`,
      originalBlock: `- [ ] ${title}`,
    },
    presentation: { linkCount: 0 },
    ...over,
  };
}

const today = '2026-07-13' as LocalDate;

function withoutStatusGroups(state: ListViewState): ListViewState {
  const result = { ...state };
  delete result.statusGroups;
  return result;
}

function titles(
  tasks: readonly TaskSnapshot[],
  selection: ListSelection,
  viewState: ListViewState = withoutStatusGroups(getListViewDefaults('today')),
  textQuery?: string,
): string[] {
  return selectTaskList({
    tasks,
    selection,
    viewState,
    settings: DEFAULT_SETTINGS,
    today,
    nowMs: Date.parse('2026-07-13T12:00:00Z'),
    ...(textQuery === undefined ? {} : { textQuery }),
  }).map((task) => task.title);
}

describe('selectTaskList', () => {
  const tasks = [
    snapshot('inbox', {
      line: 0,
      tags: ['#task/inbox'],
      source: {
        filePath: 'tasks.md',
        line: 0,
        originalMarkdown: '- [ ] inbox #task/inbox',
        originalBlock: '- [ ] inbox #task/inbox',
      },
    }),
    snapshot('untagged', { line: 1 }),
    snapshot('today due', { line: 2, planning: { due: today } }),
    snapshot('overdue', { line: 3, planning: { due: '2026-07-12' as LocalDate } }),
    snapshot('future', { line: 4, planning: { scheduled: '2026-07-14' as LocalDate } }),
    snapshot('tagged', {
      line: 5,
      tags: ['#work'],
      source: {
        filePath: 'tasks.md',
        line: 5,
        originalMarkdown: '- [ ] tagged #work',
        originalBlock: '- [ ] tagged #work',
      },
    }),
    snapshot('project', { filePath: 'Projects/A.md', line: 0 }),
  ];

  it.each([
    ['inbox', 'inbox', ['overdue', 'today due', 'future', 'project', 'untagged']],
    ['today', 'today', ['overdue', 'today due']],
    ['upcoming', 'upcoming', ['future']],
    ['tag', { type: 'tag', tag: '#work' }, ['tagged']],
    ['project', { type: 'project', path: 'Projects/A.md' }, ['project']],
  ] as const)('selects the %s list', (_name, selection, expected) => {
    expect(titles(tasks, selection)).toEqual(expected);
  });

  it('sorts mixed Today dates by time, retaining elapsed and equal-time order', () => {
    const candidates = [
      task({
        source: { filePath: 'tasks.md' },
        title: 'late',
        planning: { due: today, time: '18:00' },
      }),
      task({ source: { filePath: 'tasks.md' }, title: 'untimed', planning: { due: today } }),
      task({
        source: { filePath: 'tasks.md' },
        title: 'early scheduled',
        planning: { scheduled: today, due: '2026-07-14', time: '08:00' },
      }),
      task({
        source: { filePath: 'tasks.md' },
        title: 'morning',
        planning: { due: today, time: '09:00' },
      }),
      task({
        source: { filePath: 'tasks.md' },
        title: 'same morning',
        planning: { scheduled: today, due: '2026-07-20', time: '09:00' },
      }),
      task({
        source: { filePath: 'tasks.md' },
        title: 'overdue',
        planning: { due: '2026-07-12', scheduled: today, time: '20:00' },
      }),
    ];
    expect(titles(candidates, 'today')).toEqual([
      'overdue',
      'early scheduled',
      'morning',
      'same morning',
      'late',
      'untimed',
    ]);
    expect(
      titles(candidates, 'today', {
        groupBy: 'none',
        sortBy: { field: 'date', dir: 'desc' },
        filters: [],
      }),
    ).toEqual(['untimed', 'late', 'morning', 'same morning', 'early scheduled', 'overdue']);
    expect(
      titles(candidates, 'today', {
        groupBy: 'none',
        sortBy: { field: 'title', dir: 'asc' },
        filters: [],
      }),
    ).toEqual(['early scheduled', 'late', 'morning', 'overdue', 'same morning', 'untimed']);
    expect(titles(candidates, { type: 'project', path: 'tasks.md' })).toEqual([
      'overdue',
      'morning',
      'late',
      'untimed',
      'early scheduled',
      'same morning',
    ]);
  });

  it('keeps Today membership date-only and respects requested completed statuses', () => {
    const candidates = [
      task({
        title: 'completed due today',
        source: { line: 0 },
        status: 'done',
        planning: { due: '2026-10-03' },
      }),
      task({
        title: 'completed overlap',
        source: { line: 1 },
        status: 'done',
        planning: { due: '2026-10-02', scheduled: '2026-10-03' },
      }),
      task({ title: 'open due today', source: { line: 2 }, planning: { due: '2026-10-03' } }),
      task({
        title: 'past scheduled only',
        source: { line: 3 },
        status: 'done',
        planning: { scheduled: '2026-10-02' },
      }),
      task({
        title: 'scheduled today before future due',
        source: { line: 4 },
        status: 'done',
        planning: { due: '2026-10-04', scheduled: '2026-10-03' },
      }),
    ];
    expect(
      selectTaskList({
        tasks: candidates,
        selection: 'today',
        viewState: {
          groupBy: 'date',
          sortBy: { field: 'title', dir: 'asc' },
          filters: [],
          statusGroups: ['done'],
        },
        settings: DEFAULT_SETTINGS,
        today: localDate('2026-10-03'),
        nowMs: Date.parse('2026-10-03T12:00:00Z'),
      }).map((candidate) => candidate.title),
    ).toEqual(['completed due today', 'completed overlap', 'scheduled today before future due']);
  });

  it('matches a normalized legacy Inbox tag setting', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.inbox = { mode: 'tag', tag: '##work', removeTagOnAssign: true };

    expect(
      selectTaskList({
        tasks,
        selection: 'inbox',
        viewState: withoutStatusGroups(getListViewDefaults('inbox')),
        settings,
        today,
        nowMs: Date.parse('2026-07-13T12:00:00Z'),
      }).map((task) => task.title),
    ).toEqual(['tagged']);
  });

  it('does not borrow child tags for root-only tag or group selections', () => {
    const rootRef = snapshot('root').ref;
    const child = {
      ...snapshot('child'),
      ref: {
        parent: { type: 'task' as const, ref: rootRef },
        relativeLine: 1,
        originalBlock: '  - [ ] child #work/client',
      },
      tags: ['#work/client'],
    } as unknown as SubtaskSnapshot;
    const root = snapshot('root', { subtasks: [child] });
    const configured = structuredClone(DEFAULT_SETTINGS);

    expect(
      selectTaskList({
        tasks: [root],
        selection: { type: 'tag', tag: '#work/client' },
        viewState: withoutStatusGroups(getListViewDefaults('tag:#work/client')),
        settings: configured,
        today,
        nowMs: Date.parse('2026-07-13T12:00:00Z'),
      }).map((task) => task.title),
    ).toEqual([]);
    expect(
      selectTaskList({
        tasks: [root],
        selection: { type: 'group', groupId: discoveredPrefixGroupId('work') },
        viewState: withoutStatusGroups(getListViewDefaults('group:work')),
        settings: configured,
        today,
        nowMs: Date.parse('2026-07-13T12:00:00Z'),
      }).map((task) => task.title),
    ).toEqual([]);
  });

  it.each([
    ['discovered:prefix:work', false, ['needle']],
    ['discovered:prefix:WORK', false, ['needle']],
    ['discovered:prefix:work', true, ['needle configured']],
    ['discovered:prefix:WORK::1', true, ['needle']],
  ] as const)(
    'keeps the full catalog while text filtering %s (collision: %s)',
    (groupId, collision, want) => {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.tagGroups = collision
        ? [
            {
              id: 'discovered:prefix:work',
              name: 'Configured',
              mode: 'manual',
              tags: ['#personal'],
            },
          ]
        : [];
      const tasks = [
        snapshot('needle', { tags: ['#Work'] }),
        snapshot('unrelated', { line: 1, tags: ['#work/child'] }),
        snapshot('needle configured', { line: 2, tags: ['#personal'] }),
      ];
      expect(
        selectTaskList({
          tasks,
          selection: { type: 'group', groupId },
          viewState: withoutStatusGroups(getListViewDefaults('group:work')),
          settings,
          today,
          nowMs: 0,
          textQuery: 'needle',
        }).map((task) => task.title),
      ).toEqual(want);
    },
  );

  it('applies status and property filters before sorting', () => {
    const candidates = [
      snapshot('Zulu', { priority: 'A', planning: { due: today } }),
      snapshot('Alpha', { line: 1, priority: 'C', planning: { due: today } }),
      snapshot('Done', {
        line: 2,
        status: 'done',
        statusSymbol: 'x',
        priority: 'A',
        onCompletion: 'keep' as const,
        onCompletionExplicit: false,
        planning: { due: today },
      }),
    ];
    const viewState: ListViewState = {
      groupBy: 'priority',
      sortBy: { field: 'title', dir: 'asc' },
      filters: [{ type: 'priority', value: 'C' }],
      statusGroups: ['todo'],
    };
    expect(titles(candidates, 'today', viewState)).toEqual(['Alpha']);
  });

  it('uses undated then ascending created order to quietly break equal explicit priorities', () => {
    const viewState: ListViewState = {
      groupBy: 'priority',
      sortBy: { field: 'priority', dir: 'desc' },
      filters: [],
    };

    expect(
      titles(
        [
          snapshot('legacy', { priority: 'A' }),
          snapshot('old', {
            line: 1,
            priority: 'A',
            planning: { created: '2026-08-01' as LocalDate },
          }),
          snapshot('new', {
            line: 2,
            priority: 'A',
            planning: { created: '2026-08-22' as LocalDate },
          }),
          snapshot('lower', {
            line: 3,
            priority: 'B',
            planning: { created: '2026-08-23' as LocalDate },
          }),
        ],
        { type: 'project', path: 'tasks.md' },
        viewState,
      ),
    ).toEqual(['lower', 'legacy', 'old', 'new']);
  });

  it('uses ascending source lines for equal created dates', () => {
    const viewState: ListViewState = {
      groupBy: 'priority',
      sortBy: { field: 'priority', dir: 'desc' },
      filters: [],
    };

    expect(
      titles(
        [
          snapshot('second', { line: 1, planning: { created: '2026-08-22' as LocalDate } }),
          snapshot('first', { planning: { created: '2026-08-22' as LocalDate } }),
        ],
        { type: 'project', path: 'tasks.md' },
        viewState,
      ),
    ).toEqual(['first', 'second']);
  });

  it.each(['asc', 'desc'] as const)(
    'keeps creation, source path and source line ties ascending for %s priority',
    (dir) => {
      const created = localDate('2026-08-22');
      expect(
        titles(
          [
            snapshot('z new', { filePath: 'z.md', planning: { created } }),
            snapshot('a later line', { filePath: 'a.md', line: 8, planning: { created } }),
            snapshot('a earlier line', { filePath: 'a.md', line: 2, planning: { created } }),
            snapshot('z old', {
              filePath: 'z.md',
              line: 1,
              planning: { created: localDate('2026-08-01') },
            }),
          ],
          'inbox',
          { groupBy: 'none', sortBy: { field: 'priority', dir }, filters: [] },
        ),
      ).toEqual(['z old', 'a earlier line', 'a later line', 'z new']);
    },
  );

  it('does not reverse created order for a descending explicit sort', () => {
    const viewState: ListViewState = {
      groupBy: 'priority',
      sortBy: { field: 'priority', dir: 'desc' },
      filters: [],
    };

    expect(
      titles(
        [
          snapshot('new', { planning: { created: '2026-08-22' as LocalDate } }),
          snapshot('old', { line: 1, planning: { created: '2026-08-01' as LocalDate } }),
        ],
        { type: 'project', path: 'tasks.md' },
        viewState,
      ),
    ).toEqual(['old', 'new']);
  });

  it('does not override non-equal explicit title, priority, or date comparisons', () => {
    const selection = { type: 'project', path: 'tasks.md' } as const;

    expect(
      titles(
        [
          snapshot('Zulu', { planning: { created: '2026-08-01' as LocalDate } }),
          snapshot('Alpha', { line: 1, planning: { created: '2026-08-22' as LocalDate } }),
        ],
        selection,
        { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
      ),
    ).toEqual(['Alpha', 'Zulu']);
    expect(
      titles(
        [
          snapshot('A', { priority: 'A', planning: { created: '2026-08-01' as LocalDate } }),
          snapshot('B', {
            line: 1,
            priority: 'B',
            planning: { created: '2026-08-22' as LocalDate },
          }),
        ],
        selection,
        { groupBy: 'priority', sortBy: { field: 'priority', dir: 'desc' }, filters: [] },
      ),
    ).toEqual(['B', 'A']);
    expect(
      titles(
        [
          snapshot('later due', {
            planning: {
              due: '2026-08-22' as LocalDate,
              created: '2026-08-01' as LocalDate,
            },
          }),
          snapshot('earlier due', {
            line: 1,
            planning: {
              due: '2026-08-01' as LocalDate,
              created: '2026-08-22' as LocalDate,
            },
          }),
        ],
        selection,
        { groupBy: 'date', sortBy: { field: 'date', dir: 'asc' }, filters: [] },
      ),
    ).toEqual(['earlier due', 'later due']);
  });

  it('Y1m sorts by title with the full note names that master cut to one name', () => {
    // The titles come from the codec's parse, as the index gives them, with the creation dates.
    const source = (line: number) => ({ source: { filePath: 'tasks.md', line } });
    const ordered = selectTaskList({
      tasks: [
        taskFromCodecLine('- [ ] Read [[v1.2 notes]] ➕ 2026-08-22', source(0)),
        taskFromCodecLine('- [ ] Read [[v1.5 plans]] ➕ 2026-08-01', source(1)),
      ],
      selection: { type: 'project', path: 'tasks.md' },
      viewState: { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
      settings: DEFAULT_SETTINGS,
      today,
      nowMs: Date.parse('2026-07-13T12:00:00Z'),
    });

    expect(ordered.map((task) => task.markdownTitle)).toEqual([
      'Read [[v1.2 notes]]',
      'Read [[v1.5 plans]]',
    ]);
  });

  it.each(['none', 'date', 'priority', 'tag', 'status'] as const)(
    'accepts the %s grouping input without changing membership',
    (groupBy) => {
      const viewState: ListViewState = {
        groupBy,
        sortBy: { field: 'title', dir: 'asc' },
        filters: [],
      };
      expect(titles(tasks, { type: 'project', path: 'tasks.md' }, viewState)).toEqual([
        'future',
        'inbox',
        'overdue',
        'tagged',
        'today due',
        'untagged',
      ]);
    },
  );

  it('owns case-insensitive list/search text filtering', () => {
    expect(titles(tasks, { type: 'project', path: 'tasks.md' }, undefined, 'TODAY')).toEqual([
      'today due',
    ]);
  });

  it('uses canonical tags instead of inline-code lookalikes for list membership', () => {
    const inlineOnly = snapshot('inline only', {
      source: {
        filePath: 'tasks.md',
        line: 0,
        originalMarkdown: '- [ ] inline only `#work`',
        originalBlock: '- [ ] inline only `#work`',
      },
      tags: [],
    });

    expect(titles([inlineOnly], { type: 'tag', tag: '#work' })).toEqual([]);
  });

  it('admits a start-only task to Today', () => {
    const startOnly = snapshot('start only', { planning: { start: today } });
    expect(titles([startOnly], 'today')).toEqual(['start only']);
  });

  it('includes Today when scheduled matches despite a future due date', () => {
    const scheduled = snapshot('scheduled', {
      planning: { due: '2026-07-20' as LocalDate, scheduled: today },
    });
    const daily = snapshot('daily', {
      line: 1,
      planning: { due: '2026-07-20' as LocalDate },
      presentation: { linkCount: 0 },
    });
    expect(titles([scheduled, daily], 'today')).toEqual(['scheduled']);
  });

  it('uses only planning dates for list membership, date filters, and date sorting', () => {
    const dailyOnly = snapshot('daily only', {
      line: 1,
      presentation: { linkCount: 0 },
    });
    const tomorrowDailyOnly = snapshot('tomorrow daily only', {
      line: 2,
      presentation: { linkCount: 0 },
    });
    const dueToday = snapshot('due today', { line: 3, planning: { due: today } });
    const scheduledToday = snapshot('scheduled today', {
      line: 4,
      planning: { scheduled: today },
    });
    const overdueDue = snapshot('overdue due', {
      line: 5,
      planning: { due: '2026-07-12' as LocalDate },
    });
    const futureDue = snapshot('future due', {
      line: 6,
      planning: { due: '2026-07-14' as LocalDate },
    });
    const dateFilter: ListViewState = {
      groupBy: 'none',
      sortBy: { field: 'title', dir: 'asc' },
      filters: [{ type: 'date', value: today }],
    };
    const dateSort: ListViewState = {
      groupBy: 'date',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [],
    };

    expect(titles([dailyOnly, dueToday, scheduledToday, overdueDue], 'today')).toEqual([
      'overdue due',
      'due today',
      'scheduled today',
    ]);
    expect(titles([tomorrowDailyOnly, futureDue], 'upcoming')).toEqual(['future due']);
    expect(
      titles([dailyOnly, dueToday], { type: 'project', path: 'tasks.md' }, dateFilter),
    ).toEqual(['due today']);
    expect(
      titles(
        [dueToday, dailyOnly, snapshot('undated', { line: 7 })],
        {
          type: 'project',
          path: 'tasks.md',
        },
        dateSort,
      ),
    ).toEqual(['due today', 'daily only', 'undated']);
  });

  it('uses time as the secondary key for date sorting', () => {
    const later = snapshot('later', {
      planning: { due: today, time: '10:00' as NonNullable<TaskSnapshot['planning']['time']> },
    });
    const earlier = snapshot('earlier', {
      line: 1,
      planning: { due: today, time: '09:00' as NonNullable<TaskSnapshot['planning']['time']> },
    });
    const viewState: ListViewState = {
      groupBy: 'date',
      sortBy: { field: 'date', dir: 'asc' },
      filters: [],
    };
    expect(titles([later, earlier], 'today', viewState)).toEqual(['earlier', 'later']);
  });

  it('normalizes uppercase X when sorting by configured status order', () => {
    const done = snapshot('done', { status: 'done', statusSymbol: 'X' });
    const unknown = snapshot('unknown', { line: 1, statusSymbol: '?' });
    const viewState: ListViewState = {
      groupBy: 'status',
      sortBy: { field: 'status', dir: 'asc' },
      filters: [],
    };
    expect(titles([unknown, done], { type: 'project', path: 'tasks.md' }, viewState)).toEqual([
      'done',
      'unknown',
    ]);
  });

  it('preserves literal whitespace search semantics', () => {
    const spaced = snapshot('two  spaces');
    const plain = snapshot('plain', { line: 1 });
    expect(searchTaskList([plain, spaced], '  ').map((task) => task.title)).toEqual([
      'two  spaces',
    ]);
  });
});

describe('selectTaskList sorted by tracked time', () => {
  const NOW = Date.parse('2026-07-13T12:00:00Z');

  const closed = (minutes: number): TimeEntrySnapshot => ({
    relativeLine: 1,
    originalMarkdown: '- closed session',
    state: 'closed',
    startMs: NOW - minutes * 60_000,
    endMs: NOW,
  });

  const running = (minutes: number): TimeEntrySnapshot => ({
    relativeLine: 1,
    originalMarkdown: '- running session',
    state: 'running',
    startMs: NOW - minutes * 60_000,
  });

  const child = (entries: readonly TimeEntrySnapshot[]): SubtaskSnapshot => ({
    ref: {
      parent: { type: 'task', ref: { filePath: 'tasks.md', line: 0, revision: 'rev:parent' } },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    },
    title: 'child',
    markdownTitle: 'child',
    status: 'open',
    statusSymbol: ' ',
    priority: 'F',
    onCompletion: 'keep',
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    timeEntries: entries,
  });

  const viewState = (dir: 'asc' | 'desc'): ListViewState => ({
    groupBy: 'none',
    sortBy: { field: 'tracked', dir },
    filters: [],
  });

  const order = (dir: 'asc' | 'desc'): string[] =>
    selectTaskList({
      tasks: [
        snapshot('untracked', { line: 0 }),
        snapshot('subtasks only', { line: 1, subtasks: [child([closed(30)])] }),
        snapshot('running', { line: 2, timeEntries: [running(45)] }),
        snapshot('closed', { line: 3, timeEntries: [closed(10)] }),
      ],
      selection: { type: 'project', path: 'tasks.md' },
      viewState: viewState(dir),
      settings: DEFAULT_SETTINGS,
      today,
      nowMs: NOW,
    }).map((task) => task.title);

  it('sorts discovered prefix members by their subtree tracked totals', () => {
    const taggedChild = { ...child([closed(30)]), tags: ['#work/client'] };
    const result = selectTaskList({
      tasks: [
        snapshot('unrelated', { tags: ['#home'], timeEntries: [running(90)] }),
        snapshot('root tag', { line: 1, tags: ['#work'], timeEntries: [closed(10)] }),
        snapshot('nested tag', { line: 2, subtasks: [taggedChild] }),
      ],
      selection: { type: 'group', groupId: discoveredPrefixGroupId('work') },
      viewState: viewState('desc'),
      settings: DEFAULT_SETTINGS,
      today,
      nowMs: NOW,
    });

    expect(result.map((task) => task.title)).toEqual(['root tag']);
  });

  it('puts the most tracked task first when sorting down', () => {
    expect(order('desc')).toEqual(['running', 'subtasks only', 'closed', 'untracked']);
  });

  it('puts untracked tasks first when sorting up', () => {
    expect(order('asc')).toEqual(['untracked', 'closed', 'subtasks only', 'running']);
  });

  it('falls back to the created date when two tasks tracked the same time', () => {
    const first = snapshot('first', {
      line: 0,
      planning: { created: '2026-07-01' as LocalDate },
      timeEntries: [closed(20)],
    });
    const second = snapshot('second', {
      line: 1,
      planning: { created: '2026-07-02' as LocalDate },
      timeEntries: [closed(20)],
    });

    expect(
      selectTaskList({
        tasks: [second, first],
        selection: { type: 'project', path: 'tasks.md' },
        viewState: viewState('desc'),
        settings: DEFAULT_SETTINGS,
        today,
        nowMs: NOW,
      }).map((task) => task.title),
    ).toEqual(['first', 'second']);
  });
});

describe('source and outgoing note sorting', () => {
  const alpha = task({
    title: 'older',
    planning: { created: '2026-01-01' },
    source: { filePath: 'A/Tasks.md', line: 0 },
  });
  const newer = task({
    title: 'newer',
    planning: { created: '2026-02-01' },
    source: { filePath: 'A/Tasks.md', line: 1 },
  });
  const beta = task({ title: 'beta', source: { filePath: 'B/Tasks.md', line: 0 } });
  const none = task({ title: 'none', source: { filePath: 'C/Tasks.md', line: 0 } });
  it.each(['source-note', 'outgoing-link'] as const)(
    'sorts %s with creation tie-break preserved in both directions',
    (field) => {
      const outgoingLinks = new Map([
        ['A/Tasks.md:0', [{ key: 'note:Alice.md', label: 'Alice', target: 'Alice.md' }]],
        ['A/Tasks.md:1', [{ key: 'note:Alice.md', label: 'Alice', target: 'Alice.md' }]],
        ['B/Tasks.md:0', [{ key: 'note:Bob.md', label: 'Bob', target: 'Bob.md' }]],
      ]);
      const sorted = (dir: 'asc' | 'desc') =>
        selectTaskList({
          tasks: [newer, none, beta, alpha],
          selection: 'inbox',
          settings: { ...DEFAULT_SETTINGS, inbox: { ...DEFAULT_SETTINGS.inbox, mode: 'untagged' } },
          viewState: { groupBy: 'none', sortBy: { field, dir }, filters: [] },
          today,
          nowMs: 0,
          outgoingLinks,
        }).map((value) => value.title);
      expect(sorted('asc')).toEqual(['older', 'newer', 'beta', 'none']);
      expect(sorted('desc')).toEqual(['none', 'beta', 'older', 'newer']);
    },
  );
});

describe('complete outgoing sequence ordering', () => {
  const fixtures = [
    ['zoe', 'A/tasks.md', '[[Alice]] [[Zoe]]', '2026-01-01'],
    ['bob-new', 'A/tasks.md', '[[Bob]] [[Alice]] [[Bob|alias]]', '2026-03-01'],
    ['bob-old', 'A/tasks.md', '[[Alice]] [[Bob]]', '2026-02-01'],
    ['prefix', 'A/tasks.md', '[[Alice]]', '2026-04-01'],
    ['none', 'A/tasks.md', 'none', '2026-01-01'],
    ['unresolved-z', 'Z/tasks.md', '[[Missing]]', '2026-01-01'],
    ['unresolved-a', 'A/tasks.md', '[[Missing]]', '2026-03-01'],
  ] as const;
  const tasks = fixtures.map(([title, filePath, markdownTitle, created], line) =>
    task({
      title,
      markdownTitle,
      source: { filePath, line },
      planning: { created },
    }),
  );
  const outgoingLinks = new Map(
    tasks.map((value) => [
      `${value.source.filePath}:${value.source.line}`,
      outgoingTaskLinkValues(value, (target) =>
        target === 'Missing' ? undefined : `People/${target}.md`,
      ),
    ]),
  );
  it.each([
    ['asc', ['prefix', 'bob-old', 'bob-new', 'zoe', 'unresolved-a', 'unresolved-z', 'none']],
    ['desc', ['none', 'unresolved-z', 'unresolved-a', 'zoe', 'bob-old', 'bob-new', 'prefix']],
  ] as const)('compares every label/identity before creation in %s order', (dir, expected) => {
    expect(
      selectTaskList({
        tasks,
        outgoingLinks,
        selection: 'inbox',
        settings: { ...DEFAULT_SETTINGS, inbox: { ...DEFAULT_SETTINGS.inbox, mode: 'untagged' } },
        viewState: { groupBy: 'none', sortBy: { field: 'outgoing-link', dir }, filters: [] },
        today,
        nowMs: 0,
      }).map((value) => value.title),
    ).toEqual(expected);
  });
});
