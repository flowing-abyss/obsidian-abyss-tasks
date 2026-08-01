import { describe, expect, it } from 'vitest';
import type { ListSelection } from '../../src/app/AppState';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../../src/settings/defaults';
import type { ListViewState } from '../../src/settings/types';
import { searchTaskList, selectTaskList } from '../../src/task-lists/TaskListSelector';
import type { LocalDate, TaskSnapshot } from '../../src/tasks';

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
    subtasks: [],
    comments: [],
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

function titles(
  tasks: readonly TaskSnapshot[],
  selection: ListSelection,
  viewState: ListViewState = { ...getListViewDefaults('today'), statusGroups: undefined },
  textQuery?: string,
): string[] {
  return selectTaskList({
    tasks,
    selection,
    viewState,
    settings: DEFAULT_SETTINGS,
    today,
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
    ['inbox', 'inbox', ['inbox']],
    ['today', 'today', ['overdue', 'today due']],
    ['upcoming', 'upcoming', ['future']],
    ['tag', { type: 'tag', tag: '#work' }, ['tagged']],
    ['project', { type: 'project', path: 'Projects/A.md' }, ['project']],
  ] as const)('selects the %s list', (_name, selection, expected) => {
    expect(titles(tasks, selection)).toEqual(expected);
  });

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

  it('does not treat a start-only task as Today list membership', () => {
    const startOnly = snapshot('start only', { planning: { start: today } });
    expect(titles([startOnly], 'today')).toEqual([]);
  });

  it('includes Today when scheduled matches despite a future due date', () => {
    const scheduled = snapshot('scheduled', {
      planning: { due: '2026-07-20' as LocalDate, scheduled: today },
    });
    const daily = snapshot('daily', {
      line: 1,
      planning: { due: '2026-07-20' as LocalDate },
      presentation: { linkCount: 0, dailyNoteDate: today },
    });
    expect(titles([scheduled, daily], 'today')).toEqual(['scheduled']);
  });

  it('uses only planning dates for list membership, date filters, and date sorting', () => {
    const dailyOnly = snapshot('daily only', {
      line: 1,
      presentation: { linkCount: 0, dailyNoteDate: today },
    });
    const tomorrowDailyOnly = snapshot('tomorrow daily only', {
      line: 2,
      presentation: { linkCount: 0, dailyNoteDate: '2026-07-14' as LocalDate },
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
      planning: { due: today, time: '10:00' as TaskSnapshot['planning']['time'] },
    });
    const earlier = snapshot('earlier', {
      line: 1,
      planning: { due: today, time: '09:00' as TaskSnapshot['planning']['time'] },
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
