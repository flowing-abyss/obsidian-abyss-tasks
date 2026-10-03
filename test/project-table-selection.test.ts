// @vitest-environment node
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

  it('wraps Tab across row boundaries in both directions', () => {
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(cells[2]), cells, false);
    expect(selection.tab(cells, false)).toEqual(cells[3]);
    expect(selection.tab(cells, true)).toEqual(cells[2]);

    selection.select(expectDefined(cells[3]), cells, false);
    expect(selection.tab(cells, true)).toEqual(cells[2]);
  });

  it('selects a repeated-occurrence range by visible row and column identity', () => {
    const repeated = [
      cell('a@g1', 'Projects/A.md', 'g1', 'name'),
      cell('a@g1', 'Projects/A.md', 'g1', 'status'),
      cell('b@g1', 'Projects/B.md', 'g1', 'name'),
      cell('b@g1', 'Projects/B.md', 'g1', 'status'),
      cell('a@g2', 'Projects/A.md', 'g2', 'name'),
      cell('a@g2', 'Projects/A.md', 'g2', 'status'),
    ];
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(repeated[1]), repeated, false);
    selection.select(expectDefined(repeated[4]), repeated, true);

    expect(selection.selected(repeated)).toEqual([
      repeated[0],
      repeated[1],
      repeated[2],
      repeated[3],
      repeated[4],
      repeated[5],
    ]);
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
  it('keeps matching Area membership across interleaved status occurrences and releases it for ranges', () => {
    const interleaved = [
      cell('a@active', 'Projects/A.md', 'area:A', 'name'),
      cell('a@active', 'Projects/A.md', 'area:A', 'start'),
      cell('b@active', 'Projects/B.md', 'area:B', 'name'),
      cell('b@active', 'Projects/B.md', 'area:B', 'start'),
      cell('a@done', 'Projects/A.md', 'area:A', 'name'),
      cell('a@done', 'Projects/A.md', 'area:A', 'start'),
      cell('b@done', 'Projects/B.md', 'area:B', 'name'),
      cell('b@done', 'Projects/B.md', 'area:B', 'start'),
    ];
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(interleaved[1]), interleaved, false);
    selection.selectCurrentGroup(interleaved);
    expect(selection.anchor).toEqual(interleaved[0]);
    expect(selection.focus).toEqual(interleaved[5]);
    expect(selection.selected(interleaved)).toEqual([
      interleaved[0],
      interleaved[1],
      interleaved[4],
      interleaved[5],
    ]);
    selection.move('up', interleaved, true);
    expect(selection.selected(interleaved)).toEqual(interleaved.slice(0, 4));
    selection.selectCurrentGroup(interleaved);
    selection.select(expectDefined(interleaved[4]), interleaved, true);
    expect(selection.selected(interleaved)).toEqual([interleaved[2], interleaved[4]]);
    selection.selectCurrentGroup(interleaved);
    selection.reconcile(
      interleaved.map((c) => (c.occurrenceId === 'a@done' ? { ...c, groupKey: 'area:B' } : c)),
    );
    expect(selection.selected(interleaved)).toEqual([]);
  });

  it('skips a missing same-field cell without wrapping or changing fields at the edge', () => {
    const sparse = [
      cell('a', 'A.md', 'g', 'name'),
      cell('a', 'A.md', 'g', 'start'),
      cell('b', 'B.md', 'g', 'name'),
      cell('c', 'C.md', 'g', 'name'),
      cell('c', 'C.md', 'g', 'start'),
    ];
    const selection = new ProjectTableSelection();
    selection.select(expectDefined(sparse[1]), sparse, false);
    expect(selection.move('down', sparse, false)).toEqual(sparse[4]);
    expect(selection.move('down', sparse, false)).toBeUndefined();
    expect(selection.focus).toEqual(sparse[4]);
    expect(selection.move('up', sparse, false)).toEqual(sparse[1]);
  });
});
