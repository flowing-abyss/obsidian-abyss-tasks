import { describe, expect, it } from 'vitest';
import {
  ProjectTableSelection,
  type ProjectTableSelectableCell,
} from '../src/panels/projects/projectTableSelection';
import { expectDefined } from './helpers';

function cell(
  occurrenceId: string,
  projectPath: string,
  groupKey: string,
  columnId: string,
): ProjectTableSelectableCell {
  return { occurrenceId, projectPath, groupKey, columnId };
}

const cells = [
  cell('a', 'Projects/A.md', 'g1', 'name'),
  cell('a', 'Projects/A.md', 'g1', 'status'),
  cell('a', 'Projects/A.md', 'g1', 'end'),
  cell('b', 'Projects/B.md', 'g1', 'name'),
  cell('b', 'Projects/B.md', 'g1', 'status'),
  cell('b', 'Projects/B.md', 'g1', 'end'),
  cell('c', 'Projects/C.md', 'g2', 'name'),
  cell('c', 'Projects/C.md', 'g2', 'status'),
  cell('c', 'Projects/C.md', 'g2', 'end'),
];

describe('ProjectTableSelection', () => {
  it('moves the focus with arrows and extends a rectangular range with Shift', () => {
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(cells[1]), cells, false);

    expect(selection.move('right', cells, false)).toEqual(cells[2]);
    expect(selection.move('down', cells, true)).toEqual(cells[5]);
    expect(selection.selected(cells)).toEqual([cells[2], cells[5]]);
  });

  it('extends from the original anchor on Shift-click', () => {
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(cells[0]), cells, false);
    selection.select(expectDefined(cells[5]), cells, true);

    expect(selection.selected(cells)).toEqual(cells.slice(0, 6));
  });

  it('uses Tab order and keeps repeated project occurrences distinct', () => {
    const repeated = [
      cell('a@g1', 'Projects/A.md', 'g1', 'name'),
      cell('a@g1', 'Projects/A.md', 'g1', 'status'),
      cell('a@g2', 'Projects/A.md', 'g2', 'name'),
      cell('a@g2', 'Projects/A.md', 'g2', 'status'),
    ];
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(repeated[1]), repeated, false);

    expect(selection.tab(repeated, false)).toEqual(repeated[2]);
    expect(selection.tab(repeated, true)).toEqual(repeated[1]);
  });

  it('selects only the current group and clears or reconciles stale identities', () => {
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(cells[4]), cells, false);
    selection.selectCurrentGroup(cells);
    expect(selection.selected(cells)).toEqual(cells.slice(0, 6));

    selection.reconcile(cells.slice(6));
    expect(selection.focus).toBeUndefined();
    expect(selection.selected(cells)).toEqual([]);

    selection.select(expectDefined(cells[7]), cells, false);
    selection.clear();
    expect(selection.focus).toBeUndefined();
  });
});
