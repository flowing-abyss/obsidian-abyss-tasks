import { describe, expect, it } from 'vitest';
import { evaluateQuery } from '../src/query/evaluateQuery';
import { localDate } from '../src/tasks';
import { projectCalendarOccurrences } from '../src/views/calendarOccurrences';
import { task, taskQueryApi } from './helpers';

const fm = (o: Record<string, unknown> = {}) => o;

describe('evaluateQuery', () => {
  it('matches a folder prefix', () => {
    expect(evaluateQuery('Projects/', 'Projects/A.md', [], fm())).toBe(true);
    expect(evaluateQuery('Projects/', 'Other/A.md', [], fm())).toBe(false);
  });
  it('matches a tag or child tag', () => {
    expect(evaluateQuery('#book', 'A.md', ['#book'], fm())).toBe(true);
    expect(evaluateQuery('#book', 'A.md', ['#book/scifi'], fm())).toBe(true);
    expect(evaluateQuery('#book', 'A.md', ['#audiobook'], fm())).toBe(false);
  });
  it('matches a frontmatter key=value', () => {
    expect(evaluateQuery('status=active', 'A.md', [], fm({ status: 'active' }))).toBe(true);
    expect(evaluateQuery('status=active', 'A.md', [], fm({ status: 'done' }))).toBe(false);
    expect(evaluateQuery('status=', 'A.md', [], fm())).toBe(false); // missing values are invalid
  });
  it('supports AND / OR / NOT / parens', () => {
    expect(evaluateQuery('Projects/ AND #book', 'Projects/A.md', ['#book'], fm())).toBe(true);
    expect(evaluateQuery('Projects/ AND #book', 'Projects/A.md', [], fm())).toBe(false);
    expect(evaluateQuery('#a OR #b', 'A.md', ['#b'], fm())).toBe(true);
    expect(evaluateQuery('Projects/ AND -#archived', 'Projects/A.md', ['#archived'], fm())).toBe(
      false,
    );
    expect(evaluateQuery('Projects/ AND NOT #archived', 'Projects/A.md', [], fm())).toBe(true);
    expect(evaluateQuery('(#a OR #b) AND Notes/', 'Notes/A.md', ['#a'], fm())).toBe(true);
  });
  it('empty query matches nothing', () => {
    expect(evaluateQuery('', 'A.md', ['#x'], fm({ status: 'active' }))).toBe(false);
    expect(evaluateQuery('   ', 'A.md', [], fm())).toBe(false);
  });

  it('evaluates persisted query candidates independently from calendar forecasts', () => {
    const persisted = task({
      title: 'Daily project task',
      tags: ['#project'],
      recurrence: 'every day',
      planning: { due: '2026-08-03' },
      source: { filePath: 'Projects/A.md', line: 0 },
    });
    const source = {
      root: persisted,
      target: { type: 'task' as const, ref: persisted.ref },
      node: persisted,
    };
    const queries = taskQueryApi({
      list: () => [persisted],
      forCalendarProjection: () => ({ materialized: [source], recurringSources: [source] }),
    });

    const matches = queries
      .list()
      .filter((candidate) =>
        evaluateQuery('#project', candidate.source.filePath, [...candidate.tags], fm()),
      );
    const projection = projectCalendarOccurrences(
      queries.forCalendarProjection([
        localDate('2026-08-03'),
        localDate('2026-08-04'),
        localDate('2026-08-05'),
      ]),
      { from: localDate('2026-08-03'), to: localDate('2026-08-05') },
      { removeScheduledDate: false },
    );

    expect(projection.occurrences).toHaveLength(3);
    expect(matches.map(({ ref }) => ref)).toEqual([persisted.ref]);
  });
});
