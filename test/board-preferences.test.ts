import { describe, expect, it } from 'vitest';
import {
  buildBoardPreference,
  collapseBoardColumn,
  hideBoardColumn,
  migrateBoardPreference,
  moveBoardColumn,
  reconcileBoardPreference,
  reorderBoardColumn,
  resetBoardPreference,
  restoreBoardColumn,
  type BoardColumnRoles,
  type BoardViewPreference,
} from '../src/panels/projects/boardPreferences';

const roles: BoardColumnRoles<string> = {
  terminalLeftIds: ['dropped'],
  terminalRightIds: ['published'],
};

function preference(overrides: Partial<BoardViewPreference> = {}): BoardViewPreference {
  return {
    version: 1,
    columnOrder: ['dropped', 'todo', 'doing', 'published'],
    collapsedColumnIds: [],
    hiddenColumnIds: [],
    ...overrides,
  };
}

describe('board preference reconciliation', () => {
  it('dedupes stored order, retains dormant IDs, and appends newly configured IDs', () => {
    const result = reconcileBoardPreference(
      preference({ columnOrder: ['doing', 'legacy', 'doing', 'todo'] }),
      ['todo', 'doing', 'review'],
    );

    expect(result.columnOrder).toEqual(['doing', 'todo', 'review', 'legacy']);
  });

  it('keeps dormant collapsed and hidden IDs while hidden wins for active overlap', () => {
    const result = reconcileBoardPreference(
      preference({
        columnOrder: ['todo', 'legacy'],
        collapsedColumnIds: ['todo', 'legacy', 'todo'],
        hiddenColumnIds: ['todo', 'legacy-hidden', 'todo'],
      }),
      ['todo', 'doing'],
    );

    expect(result.collapsedColumnIds).toEqual(['legacy']);
    expect(result.hiddenColumnIds).toEqual(['todo', 'legacy-hidden']);
  });

  it('guards terminal bookends while preserving regular stored order', () => {
    const result = reconcileBoardPreference(
      preference({ columnOrder: ['published', 'doing', 'dropped', 'todo'] }),
      ['todo', 'dropped', 'doing', 'published'],
      roles,
    );

    expect(result.columnOrder).toEqual(['dropped', 'doing', 'todo', 'published']);
  });

  it('does not mutate any input arrays', () => {
    const input = preference({
      columnOrder: ['doing', 'todo'],
      collapsedColumnIds: ['doing'],
      hiddenColumnIds: ['legacy'],
    });
    const before = JSON.parse(JSON.stringify(input)) as BoardViewPreference;

    reconcileBoardPreference(input, ['todo', 'doing', 'review'], roles);

    expect(input).toEqual(before);
  });

  it('preserves unknown structural fields while normalizing known fields', () => {
    const result = migrateBoardPreference(
      {
        version: 1,
        columnOrder: ['doing'],
        collapsedColumnIds: [],
        hiddenColumnIds: [],
        futureOption: { density: 'compact' },
      },
      ['todo', 'doing'],
    );

    expect(result).toMatchObject({ futureOption: { density: 'compact' } });
  });

  it('migrates the legacy Project status language into the one canonical schema', () => {
    const result = migrateBoardPreference(
      {
        version: 1,
        statusIds: ['doing', 'todo'],
        dormantStatusIds: ['legacy'],
        futureOption: true,
      },
      ['todo', 'doing', 'review'],
    );

    expect(result).toEqual({
      version: 1,
      columnOrder: ['doing', 'todo', 'review', 'legacy'],
      collapsedColumnIds: [],
      hiddenColumnIds: [],
      futureOption: true,
    });
    expect(result).not.toHaveProperty('statusIds');
    expect(result).not.toHaveProperty('dormantStatusIds');
  });
});

describe('board preference operations', () => {
  it('reorders regular columns without crossing terminal bookends', () => {
    const input = preference();
    const configured = ['dropped', 'todo', 'doing', 'published'];

    expect(reorderBoardColumn(input, configured, 'doing', 0, roles).columnOrder).toEqual([
      'dropped',
      'doing',
      'todo',
      'published',
    ]);
    expect(reorderBoardColumn(input, configured, 'todo', 99, roles).columnOrder).toEqual([
      'dropped',
      'doing',
      'todo',
      'published',
    ]);
    expect(reorderBoardColumn(input, configured, 'dropped', 2, roles)).toBe(input);
  });

  it('moves regular columns left and right immutably and is stable at bounds', () => {
    const input = preference();
    const configured = ['dropped', 'todo', 'doing', 'published'];
    const moved = moveBoardColumn(input, configured, 'doing', 'left', roles);

    expect(moved.columnOrder).toEqual(['dropped', 'doing', 'todo', 'published']);
    expect(input.columnOrder).toEqual(['dropped', 'todo', 'doing', 'published']);
    expect(moveBoardColumn(input, configured, 'todo', 'left', roles)).toBe(input);
    expect(moveBoardColumn(input, configured, 'doing', 'right', roles)).toBe(input);
  });

  it('never treats dormant IDs as visible reorder positions', () => {
    const input = preference({
      columnOrder: ['dropped', 'todo', 'doing', 'published', 'legacy'],
    });
    const configured = ['dropped', 'todo', 'doing', 'published'];

    expect(moveBoardColumn(input, configured, 'doing', 'right', roles)).toBe(input);
    expect(reorderBoardColumn(input, configured, 'todo', 99, roles).columnOrder).toEqual([
      'dropped',
      'doing',
      'todo',
      'published',
      'legacy',
    ]);
    expect(moveBoardColumn(input, configured, 'legacy', 'left', roles)).toBe(input);
  });

  it('hide, collapse, and restore are mutually exclusive, immutable, and no-op stable', () => {
    const input = preference({ collapsedColumnIds: ['todo'] });
    const hidden = hideBoardColumn(input, 'todo');

    expect(hidden.collapsedColumnIds).toEqual([]);
    expect(hidden.hiddenColumnIds).toEqual(['todo']);
    expect(hideBoardColumn(hidden, 'todo')).toBe(hidden);

    const collapsed = collapseBoardColumn(hidden, 'todo');
    expect(collapsed.collapsedColumnIds).toEqual(['todo']);
    expect(collapsed.hiddenColumnIds).toEqual([]);

    const restored = restoreBoardColumn(collapsed, 'todo');
    expect(restored.collapsedColumnIds).toEqual([]);
    expect(restored.hiddenColumnIds).toEqual([]);
    expect(restoreBoardColumn(restored, 'todo')).toBe(restored);
  });

  it('reset restores canonical active order and clears only active visibility overrides', () => {
    const result = resetBoardPreference(
      preference({
        columnOrder: ['doing', 'legacy', 'todo'],
        collapsedColumnIds: ['todo', 'legacy-collapsed'],
        hiddenColumnIds: ['doing', 'legacy-hidden'],
      }),
      ['todo', 'doing', 'review'],
      roles,
    );

    expect(result).toMatchObject({
      columnOrder: ['todo', 'doing', 'review', 'legacy'],
      collapsedColumnIds: ['legacy-collapsed'],
      hiddenColumnIds: ['legacy-hidden'],
    });
  });

  it('builds a deduped canonical preference', () => {
    expect(buildBoardPreference(['todo', 'todo', 'doing'])).toEqual({
      version: 1,
      columnOrder: ['todo', 'doing'],
      collapsedColumnIds: [],
      hiddenColumnIds: [],
    });
  });
});
