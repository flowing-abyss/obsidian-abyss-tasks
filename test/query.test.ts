// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { evaluateQuery, validateQuerySyntax } from '../src/query/evaluateQuery';
import { localDate } from '../src/tasks';
import { projectCalendarOccurrences } from '../src/views/calendarOccurrences';
import { task, taskQueryApi } from './helpers';

const fm = (o: Record<string, unknown> = {}) => o;

describe('evaluateQuery', () => {
  it('matches a folder prefix', () => {
    expect(evaluateQuery('Projects/', 'Projects/A.md', [], fm())).toBe(true);
    expect(evaluateQuery('projects/', 'Projects/A.md', [], fm())).toBe(true);
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
    expect(evaluateQuery('status=', 'A.md', [], fm())).toBe(true); // unset === ''
  });
  it('reads numbers, booleans, lists, objects, and null as text in a frontmatter key=value', () => {
    expect(evaluateQuery('priority=3', 'A.md', [], fm({ priority: 3 }))).toBe(true);
    expect(evaluateQuery('done=true', 'A.md', [], fm({ done: true }))).toBe(true);
    expect(evaluateQuery('done=false', 'A.md', [], fm({ done: false }))).toBe(true);
    expect(evaluateQuery('tags=a,b', 'A.md', [], fm({ tags: ['a', 'b'] }))).toBe(true);
    expect(evaluateQuery('tags=a', 'A.md', [], fm({ tags: ['a', 'b'] }))).toBe(false);
    expect(evaluateQuery('tags=', 'A.md', [], fm({ tags: [] }))).toBe(true);
    expect(evaluateQuery('owner=[object Object]', 'A.md', [], fm({ owner: { name: 'Ann' } }))).toBe(
      true,
    );
    expect(evaluateQuery('status=', 'A.md', [], fm({ status: null }))).toBe(true);
  });
  it('reads a list inside itself as empty, as String() does', () => {
    const cyclic: unknown[] = ['a'];
    cyclic.push(cyclic);
    const selfOnly: unknown[] = [];
    selfOnly.push(selfOnly);
    const nested: unknown[] = ['a'];
    nested.push(['b', nested], 'c');
    const shared = ['x', 'y'];

    expect(evaluateQuery('tags=a,', 'A.md', [], fm({ tags: cyclic }))).toBe(true);
    expect(evaluateQuery('tags=', 'A.md', [], fm({ tags: selfOnly }))).toBe(true);
    expect(evaluateQuery('tags=a,b,,c', 'A.md', [], fm({ tags: nested }))).toBe(true);
    // A list that appears twice without being nested in itself is read in full each time.
    expect(evaluateQuery('tags=x,y,x,y', 'A.md', [], fm({ tags: [shared, shared] }))).toBe(true);
  });
  it('reads a flat list of primitives as join() does, and a list holding a list or an object item by item', () => {
    const flat = [null, undefined, 'a', 1, true, 2n];

    expect(evaluateQuery('tags=,,a,1,true,2', 'A.md', [], fm({ tags: flat }))).toBe(true);
    expect(evaluateQuery('tags=a,b,c', 'A.md', [], fm({ tags: ['a', ['b', 'c']] }))).toBe(true);
    expect(evaluateQuery('tags=a,[object Object]', 'A.md', [], fm({ tags: ['a', { b: 1 }] }))).toBe(
      true,
    );
    // join() cannot read an object whose toString is not a function; the helper still reads it.
    expect(
      evaluateQuery('tags=a,[object Object]', 'A.md', [], fm({ tags: ['a', { toString: 'x' }] })),
    ).toBe(true);
  });
  it('reads YAML binary bytes as String() does', () => {
    const bytes = new Uint8Array([104, 105]);

    expect(evaluateQuery('bin=104,105', 'A.md', [], fm({ bin: bytes }))).toBe(true);
    expect(evaluateQuery('bin=', 'A.md', [], fm({ bin: new Uint8Array([]) }))).toBe(true);
    expect(evaluateQuery('bin=a,104,105', 'A.md', [], fm({ bin: ['a', bytes] }))).toBe(true);
    expect(evaluateQuery('bin=[object Uint8Array]', 'A.md', [], fm({ bin: bytes }))).toBe(false);
  });
  it('reads a date as String() does', () => {
    const due = new Date(2026, 0, 2);

    expect(evaluateQuery(`due="${String(due)}"`, 'A.md', [], fm({ due }))).toBe(true);
    expect(evaluateQuery('due=2026-01-02', 'A.md', [], fm({ due }))).toBe(false);
  });
  it('reads a key naming an inherited member as String() does', () => {
    const frontmatter = fm({ status: 'x' });
    // A string key reads the member as evaluateQuery does: Object.prototype.toString, a function.
    const key: string = 'toString';
    const query = `toString="${String(frontmatter[key])}"`;

    expect(evaluateQuery(query, 'A.md', [], frontmatter)).toBe(true);
    expect(evaluateQuery('toString=[object Function]', 'A.md', [], frontmatter)).toBe(false);
  });

  it('preserves whitespace and quoted values in frontmatter equality expressions', () => {
    expect(evaluateQuery('status = done', 'A.md', [], fm({ status: 'done' }))).toBe(true);
    expect(evaluateQuery('status = "in progress"', 'A.md', [], fm({ status: 'in progress' }))).toBe(
      true,
    );
    expect(evaluateQuery('status = in progress', 'A.md', [], fm({ status: 'in progress' }))).toBe(
      true,
    );
    expect(
      evaluateQuery("status= 'needs review'", 'A.md', [], fm({ status: 'needs review' })),
    ).toBe(true);
    expect(
      evaluateQuery('status = done AND #private', 'A.md', ['#private'], fm({ status: 'done' })),
    ).toBe(true);
    expect(validateQuerySyntax('status = in progress OR owner = team')).toEqual({
      type: 'valid',
    });
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

  it('matches quoted exact paths and date path patterns inside boolean expressions', () => {
    expect(
      evaluateQuery(
        '"tasks/archive.md" OR ("old tasks/" AND NOT #keep)',
        'tasks/archive.md',
        [],
        fm(),
      ),
    ).toBe(true);
    expect(evaluateQuery('"archive/{{YYYY}}.md"', 'archive/2025.md', [], fm())).toBe(true);
    expect(evaluateQuery('"archive/{{YYYY}}.md"', 'archive/misc.md', [], fm())).toBe(false);
    expect(evaluateQuery('"archive/{{[FY]YYYY}}.md"', 'Archive/FY2026.md', [], fm())).toBe(true);
    expect(evaluateQuery('"archive/{{DATE:[FY]YYYY}}.md"', 'ARCHIVE/fy2026.md', [], fm())).toBe(
      true,
    );
  });

  it('unescapes quoted paths and reports malformed source expressions', () => {
    expect(evaluateQuery('"old \\"tasks\\".md"', 'old "tasks".md', [], fm())).toBe(true);
    expect(validateQuerySyntax('("archive.md" OR #done) AND NOT status=active')).toEqual({
      type: 'valid',
    });
    expect(validateQuerySyntax('("archive.md" OR #done')).toMatchObject({ type: 'invalid' });
    expect(validateQuerySyntax('"archive.md" trailing')).toMatchObject({ type: 'invalid' });
  });

  it.each([
    '"private/{{YYYY-MMMM}}.md"',
    '"private/{{YYYY-MM-DD}.md"',
    '"../private.md"',
    '#keep AND ("private/{{YYYY-MMMM}}.md" OR #other)',
    'NOT "../private.md"',
  ])('rejects invalid quoted path patterns before they can change exclusions: %s', (query) => {
    expect(validateQuerySyntax(query)).toMatchObject({ type: 'invalid' });
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
