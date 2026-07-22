import { describe, expect, it, vi } from 'vitest';
import type { LocalDate, TaskSnapshot } from '../src/tasks';
import { localDate } from '../src/tasks';
import {
  calendarDatesForPlanning,
  calendarRangeForPlanning,
  TaskDateIndex,
} from '../src/tasks/infrastructure/TaskDateIndex';
import { task, useRealMoment } from './helpers';

useRealMoment();

describe('TaskDateIndex', () => {
  const createIndex = () =>
    new TaskDateIndex<TaskSnapshot>(
      (value) => calendarDatesForPlanning(value.planning),
      (value) => calendarRangeForPlanning(value.planning),
    );

  it('indexes a due-only task under its due date', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({ planning: { due: '2026-07-10' }, source: { filePath: 'a.md' } }),
    ]);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(1);
    expect(idx.get(localDate('2026-07-11'))).toHaveLength(0);
  });

  it('a scheduled+due-distinct task is queryable at BOTH dates (body on scheduled, deadline marker on due)', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({
        planning: { due: '2026-07-10', scheduled: '2026-07-05' },
        source: { filePath: 'a.md' },
      }),
    ]);
    expect(idx.get(localDate('2026-07-05'))).toHaveLength(1);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(1);
  });

  it('a start+due span indexes under every day in the range inclusive', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({ planning: { start: '2026-07-01', due: '2026-07-03' }, source: { filePath: 'a.md' } }),
    ]);
    expect(idx.get(localDate('2026-07-01'))).toHaveLength(1);
    expect(idx.get(localDate('2026-07-02'))).toHaveLength(1);
    expect(idx.get(localDate('2026-07-03'))).toHaveLength(1);
    expect(idx.get(localDate('2026-07-04'))).toHaveLength(0);
  });

  it('a task with no relevant date is not indexed anywhere', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [task({ source: { filePath: 'a.md' } })]);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(0);
  });

  it("updateFile replaces a file's prior entries (moves task off old date)", () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({
        planning: { start: '2026-07-08', due: '2026-07-10' },
        source: { filePath: 'a.md' },
      }),
    ]);
    idx.updateFile('a.md', [
      task({ planning: { due: '2026-07-11' }, source: { filePath: 'a.md' } }),
    ]);
    expect(idx.get(localDate('2026-07-09'))).toHaveLength(0);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(0);
    expect(idx.get(localDate('2026-07-11'))).toHaveLength(1);
  });

  it("updateFile with an empty array clears the file's entries (no ghost tasks)", () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({ planning: { due: '2026-07-10' }, source: { filePath: 'a.md' } }),
    ]);
    idx.updateFile('a.md', []);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(0);
  });

  it("removeFile clears all of that file's entries", () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({
        planning: { start: '2026-07-08', due: '2026-07-10' },
        source: { filePath: 'a.md' },
      }),
    ]);
    idx.removeFile('a.md');
    expect(idx.get(localDate('2026-07-09'))).toHaveLength(0);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(0);
  });

  it('two files contributing to the same date both appear, and removing one leaves the other', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({ planning: { due: '2026-07-10' }, source: { filePath: 'a.md' } }),
    ]);
    idx.updateFile('b.md', [
      task({ planning: { due: '2026-07-10' }, source: { filePath: 'b.md' } }),
    ]);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(2);
    idx.removeFile('a.md');
    const remaining = idx.get(localDate('2026-07-10'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.source.filePath).toBe('b.md');
  });

  it('a malformed start > due does not spin forever (guarded)', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({ planning: { start: '2027-01-01', due: '2026-01-01' }, source: { filePath: 'a.md' } }),
    ]);
    // start after due: loop guard means it terminates; exact bucket assignment is not asserted,
    // only that this call returns and doesn't hang.
    expect(() => idx.get(localDate('2026-01-01'))).not.toThrow();
  });

  it('represents the full valid date domain as one range without enumerating its dates', () => {
    const planning = {
      start: localDate('0000-01-01'),
      due: localDate('9999-12-31'),
    };
    expect(calendarDatesForPlanning(planning)).toEqual([]);
    expect(calendarRangeForPlanning(planning)).toEqual(planning);

    const idx = createIndex();
    const extreme = task({ planning, source: { filePath: 'extreme.md' } });
    idx.updateFile('extreme.md', [extreme]);
    expect(idx.get(localDate('5000-06-15'))).toEqual([extreme]);
  });

  it('deduplicates a task present in both an explicit bucket and a containing range', () => {
    const date = localDate('2026-07-10');
    const indexed = task({ planning: { due: date }, source: { filePath: 'a.md' } });
    const idx = new TaskDateIndex<TaskSnapshot>(
      () => [date],
      () => ({ start: date, due: date }),
    );
    idx.updateFile('a.md', [indexed]);
    expect(idx.get(date)).toEqual([indexed]);
  });

  it('prunes disjoint ranges instead of scanning the vault-wide range set', () => {
    const idx = createIndex();
    const ranges = Array.from({ length: 1_023 }, (_, line) => {
      const date = localDate(`${String(1000 + line).padStart(4, '0')}-01-01`);
      return task({
        title: `range-${line}`,
        planning: { start: date, due: date },
        source: { filePath: 'ranges.md', line },
      });
    });
    idx.updateFile('ranges.md', ranges);

    const collectSpy = vi.spyOn(
      idx as unknown as {
        collectRangeMatches(node: unknown, date: LocalDate, matches: unknown[]): void;
      },
      'collectRangeMatches',
    );
    expect(idx.get(localDate('1511-01-01'))).toEqual([ranges[511]]);
    expect(collectSpy.mock.calls.length).toBeLessThanOrEqual(20);
    collectSpy.mockRestore();
  });

  it('keeps a warmed sparse overlap query near O(log R + k)', () => {
    type Entry = { readonly id: number; readonly start: LocalDate; readonly due: LocalDate };
    const total = 65_535;
    const overlapStride = 257;
    const epoch = Date.UTC(1800, 0, 1);
    const dateAt = (id: number): LocalDate =>
      new Date(epoch + id * 86_400_000).toISOString().slice(0, 10) as LocalDate;
    const query = dateAt(total - 1);
    const entries = Array.from({ length: total }, (_, id): Entry => {
      const start = dateAt(id);
      const overlaps = id % overlapStride === 0;
      return { id, start, due: overlaps ? query : start };
    });
    // 65,535 ranges with one overlap every 257 starts is deliberately adversarial for an
    // augmented start-only BST: max-due pruning repeatedly revisits non-output paths. A centered
    // interval tree visits only a logarithmic search path plus the 256 emitted overlaps.
    const expected = entries.filter((entry) => entry.start <= query && query <= entry.due);
    expect(expected).toHaveLength(256);

    const idx = new TaskDateIndex<Entry>(
      () => [],
      (entry) => entry,
    );
    idx.updateFile('ranges.md', entries);
    // Warm the lazily rebuilt tree before measuring query work.
    expect(idx.get(query)).toEqual(expected);

    const collectSpy = vi.spyOn(
      idx as unknown as {
        collectRangeMatches(node: unknown, date: LocalDate, matches: unknown[]): void;
      },
      'collectRangeMatches',
    );
    expect(idx.get(query)).toEqual(expected);
    expect(collectSpy.mock.calls.length).toBeLessThanOrEqual(280);
    collectSpy.mockRestore();

    const singleMatchSpy = vi.spyOn(
      idx as unknown as {
        collectRangeMatches(node: unknown, date: LocalDate, matches: unknown[]): void;
      },
      'collectRangeMatches',
    );
    expect(idx.get(dateAt(0))).toEqual([entries[0]]);
    expect(singleMatchSpy.mock.calls.length).toBeLessThanOrEqual(32);
    singleMatchSpy.mockRestore();
  });

  it('returns nested and overlapping ranges once, and rebuilds after update/remove', () => {
    type Entry = { readonly id: string; readonly start: LocalDate; readonly due: LocalDate };
    const idx = new TaskDateIndex<Entry>(
      () => [],
      (entry) => entry,
    );
    const outer: Entry = {
      id: 'outer',
      start: localDate('2026-01-01'),
      due: localDate('2026-12-31'),
    };
    const nested: Entry = {
      id: 'nested',
      start: localDate('2026-06-01'),
      due: localDate('2026-06-30'),
    };
    const overlap: Entry = {
      id: 'overlap',
      start: localDate('2026-06-15'),
      due: localDate('2026-07-15'),
    };
    idx.updateFile('a.md', [outer, nested]);
    idx.updateFile('b.md', [overlap]);
    expect(new Set(idx.get(localDate('2026-06-20')))).toEqual(new Set([outer, nested, overlap]));

    const moved: Entry = {
      id: 'moved',
      start: localDate('2027-01-01'),
      due: localDate('2027-01-02'),
    };
    idx.updateFile('a.md', [moved]);
    expect(idx.get(localDate('2026-06-20'))).toEqual([overlap]);
    idx.removeFile('b.md');
    expect(idx.get(localDate('2026-06-20'))).toEqual([]);
    expect(idx.get(localDate('2027-01-01'))).toEqual([moved]);
  });

  it('does not sort matches again after the interval tree has emitted them in order', () => {
    const idx = createIndex();
    const ranges = [
      task({
        title: 'later-start',
        planning: { start: '2026-07-05', due: '2026-07-20' },
        source: { filePath: 'ranges.md', line: 0 },
      }),
      task({
        title: 'earlier-start',
        planning: { start: '2026-07-01', due: '2026-07-15' },
        source: { filePath: 'ranges.md', line: 1 },
      }),
    ];
    idx.updateFile('ranges.md', ranges);

    type Match = { readonly task: TaskSnapshot };
    type Collect = (node: unknown, date: LocalDate, matches: Match[]) => void;
    const internals = idx as unknown as { collectRangeMatches: Collect };
    const originalCollect = internals.collectRangeMatches.bind(idx);
    let armed = false;
    const collectSpy = vi
      .spyOn(internals, 'collectRangeMatches')
      .mockImplementation((node, date, matches) => {
        if (!armed) {
          armed = true;
          Object.defineProperty(matches, 'sort', {
            value: () => {
              throw new Error('per-query sort is not allowed');
            },
          });
        }
        originalCollect(node, date, matches);
      });

    // Query is right of this node's center, so the centered tree emits its due-descending scan.
    // Consumer-facing order is applied by TaskIndex, not by this low-level overlap index.
    expect(idx.get(localDate('2026-07-10')).map((value) => value.title)).toEqual([
      'later-start',
      'earlier-start',
    ]);
    collectSpy.mockRestore();
  });

  it('clear() empties the whole index', () => {
    const idx = createIndex();
    idx.updateFile('a.md', [
      task({
        planning: { start: '2026-07-08', due: '2026-07-10' },
        source: { filePath: 'a.md' },
      }),
    ]);
    idx.clear();
    expect(idx.get(localDate('2026-07-09'))).toHaveLength(0);
    expect(idx.get(localDate('2026-07-10'))).toHaveLength(0);
  });
});
