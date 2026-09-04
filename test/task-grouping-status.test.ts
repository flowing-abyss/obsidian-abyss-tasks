import { describe, expect, it } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskSnapshot } from '../src/tasks';
import {
  compareByStatus,
  filterTasksByStatusGroups,
  groupTasksByStatus,
} from '../src/views/taskGrouping';
import { expectDefined, task as taskFixture } from './helpers';

const reg = new StatusRegistry(buildDefaultTaskStatuses());
const task = (statusSymbol: string): TaskSnapshot => taskFixture({ statusSymbol });

describe('group/sort by status', () => {
  it('groups by status name in settings order', () => {
    const groups = groupTasksByStatus([task('x'), task('/'), task(' ')], reg);
    expect(groups.map((g) => g.label)).toEqual(['To-do', 'In progress', 'Done']);
  });

  it('puts unknown-status tasks in an "Other" group last', () => {
    const groups = groupTasksByStatus([task('@'), task(' ')], reg);
    expect(expectDefined(groups[groups.length - 1]).label).toBe('Other');
  });

  it('compareByStatus ranks by registry order', () => {
    expect(compareByStatus(task(' '), task('x'), reg)).toBeLessThan(0);
    expect(compareByStatus(task('@'), task(' '), reg)).toBeGreaterThan(0);
  });
});

describe('filterTasksByStatusGroups', () => {
  const tasks = [task(' '), task('/'), task('x'), task('-')];

  it('returns all tasks when statusGroups is undefined', () => {
    expect(filterTasksByStatusGroups(tasks, undefined, reg)).toHaveLength(4);
  });

  it('returns all tasks when statusGroups is empty', () => {
    expect(filterTasksByStatusGroups(tasks, [], reg)).toHaveLength(4);
  });

  it('returns all tasks when all 4 groups are selected', () => {
    const all = filterTasksByStatusGroups(tasks, ['todo', 'in-progress', 'done', 'cancelled'], reg);
    expect(all).toHaveLength(4);
  });

  it('filters to a single group', () => {
    const result = filterTasksByStatusGroups(tasks, ['done'], reg);
    expect(result.map((t) => t.statusSymbol)).toEqual(['x']);
  });

  it('filters to a real subset of groups', () => {
    const result = filterTasksByStatusGroups(tasks, ['todo', 'cancelled'], reg);
    expect(result.map((t) => t.statusSymbol)).toEqual([' ', '-']);
  });

  it('treats an unknown status symbol as "todo"', () => {
    const result = filterTasksByStatusGroups([task('@')], ['todo'], reg);
    expect(result).toHaveLength(1);
  });
});
