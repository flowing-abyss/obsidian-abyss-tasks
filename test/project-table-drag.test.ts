import { describe, expect, it } from 'vitest';
import { planProjectGroupDrop } from '../src/panels/projects/projectTableDrag';
import type { ProjectField } from '../src/projects/projectFields';
import { projectTableGroupLinkIdentity } from '../src/projects/projectTableModel';

const status: ProjectField = { id: 'status', property: 'status', label: 'Status', type: 'status' };
const date: ProjectField = { id: 'end', property: 'end', label: 'End', type: 'date' };
const list: ProjectField = {
  id: 'property:Owners',
  property: 'Owners',
  label: 'Owners',
  type: 'list',
};

describe('planProjectGroupDrop', () => {
  it('moves scalar status and date values and clears them in No value', () => {
    expect(
      planProjectGroupDrop({
        field: status,
        currentValue: 'Active',
        source: { key: 'id:a', value: 'a' },
        target: { key: 'id:d', value: 'd' },
        statuses: [
          { id: 'a', name: 'Active' },
          { id: 'd', name: 'Done' },
        ],
      }),
    ).toBe('Done');
    expect(
      planProjectGroupDrop({
        field: date,
        currentValue: '2026-09-01',
        source: { key: 'value:2026-09-01', value: '2026-09-01' },
        target: { key: 'empty', value: null },
        statuses: [],
      }),
    ).toBeUndefined();
  });

  it('preserves unrelated list items for A to B and removes duplicates when B already exists', () => {
    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: ['A', 'C'],
        source: { key: 'value:a', value: 'A' },
        target: { key: 'value:b', value: 'B' },
        statuses: [],
      }),
    ).toEqual(['B', 'C']);
    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: ['A', 'B', 'C'],
        source: { key: 'value:a', value: 'A' },
        target: { key: 'value:b', value: 'B' },
        statuses: [],
      }),
    ).toEqual(['B', 'C']);
  });

  it('treats a drop back into the source group as a no-op', () => {
    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: ['A', 'A', 'C'],
        source: { key: 'value:a', value: 'A' },
        target: { key: 'value:a', value: 'A' },
        statuses: [],
      }),
    ).toEqual(['A', 'A', 'C']);
  });

  it('adds the target when dragged from No value and clears the whole list when dropped there', () => {
    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: [],
        source: { key: 'empty', value: null },
        target: { key: 'value:b', value: 'B' },
        statuses: [],
      }),
    ).toEqual(['B']);
    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: ['A', 'C'],
        source: { key: 'value:a', value: 'A' },
        target: { key: 'empty', value: null },
        statuses: [],
      }),
    ).toEqual([]);
  });

  it('uses resolved link group identity and rewrites the incoming target for the destination note', () => {
    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: ['[[../People/A]]', '[[../People/C]]'],
        projectPath: 'Projects/Source.md',
        source: { key: 'link:people/a.md', value: '[[People/A]]', sourcePath: 'Elsewhere.md' },
        target: { key: 'link:people/b.md', value: '[[People/B|B]]', sourcePath: 'Index.md' },
        statuses: [],
        groupIdentity: (value, sourcePath) => {
          if (value.includes('/A')) return 'link:people/a.md';
          if (value.includes('/B')) return 'link:people/b.md';
          return typeof value === 'string' ? `value:${sourcePath}:${value}` : undefined;
        },
        rebase: (value, sourcePath, destinationPath) =>
          typeof value === 'string' ? `${value}@${sourcePath}->${destinationPath}` : value,
      }),
    ).toEqual(['[[People/B|B]]@Index.md->Projects/Source.md', '[[../People/C]]']);
  });

  it('deduplicates wiki, encoded Markdown, and heading links by normalized native target', () => {
    const identify = (value: string, sourcePath: string): string | undefined =>
      projectTableGroupLinkIdentity(value, sourcePath, (target) => {
        if (target === '../People/Anna Smith' || target === '../People/Anna Smith.md') {
          return 'People/Anna Smith.md';
        }
        if (target === '../People/Other') return 'People/Other.md';
        return undefined;
      });

    expect(
      planProjectGroupDrop({
        field: list,
        currentValue: [
          '[[../People/Anna Smith]]',
          '[Anna](../People/Anna%20Smith.md#Details)',
          '[[../People/Other]]',
        ],
        projectPath: 'Projects/Source.md',
        source: {
          key: 'link:people/other.md',
          value: '[[../People/Other]]',
          sourcePath: 'Projects/Source.md',
        },
        target: {
          key: 'link:people/anna smith.md',
          value: '[[../People/Anna Smith#Details|Anna]]',
          sourcePath: 'Projects/Source.md',
        },
        statuses: [],
        groupIdentity: identify,
        rebase: (value) => value,
      }),
    ).toEqual(['[[../People/Anna Smith]]']);
  });

  it('denies unknown status targets and unavailable or derived grouping fields', () => {
    expect(() =>
      planProjectGroupDrop({
        field: status,
        currentValue: 'Active',
        source: { key: 'id:a', value: 'a' },
        target: { key: 'raw:Blocked', value: null },
        statuses: [{ id: 'a', name: 'Active' }],
      }),
    ).toThrow('Unknown project statuses cannot be assigned');
    expect(() =>
      planProjectGroupDrop({
        field: { id: 'progress', label: 'Progress', type: 'progress' },
        currentValue: 50,
        source: { key: 'value:50', value: 50 },
        target: { key: 'value:75', value: 75 },
        statuses: [],
      }),
    ).toThrow('Progress cannot be changed by moving a group');
    expect(() =>
      planProjectGroupDrop({
        field: { id: 'property:Missing', property: 'Missing', label: 'Missing', type: null },
        currentValue: 'A',
        source: { key: 'value:a', value: 'A' },
        target: { key: 'value:b', value: 'B' },
        statuses: [],
      }),
    ).toThrow('Missing is read-only');
  });
});
