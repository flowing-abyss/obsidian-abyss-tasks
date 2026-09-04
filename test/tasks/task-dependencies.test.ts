import { describe, expect, it } from 'vitest';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import {
  buildTaskDependencyGraph,
  enumerateTaskNodes,
} from '../../src/tasks/domain/taskDependencies';
import type { TaskNodeRef, TaskSnapshot, TaskStatus } from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { canonicalStatusCatalog, expectDefined, subtask, task, taskComment } from '../helpers';

function root(id: string, dependsOn: readonly string[] = [], symbol = ' '): TaskSnapshot {
  return task({
    title: id,
    dependencyId: id,
    dependsOn,
    statusSymbol: symbol,
    source: { filePath: `${id}.md` },
  });
}

function target(node: TaskSnapshot): TaskNodeRef {
  return { type: 'task', ref: node.ref };
}

function graph(tasks: readonly TaskSnapshot[]) {
  const catalog = canonicalStatusCatalog();
  return buildTaskDependencyGraph(enumerateTaskNodes(tasks), (symbol) =>
    catalog.statusForSymbol(symbol),
  );
}

describe('task dependency graph', () => {
  it('enumerates roots and nested nodes in source order with complete structural paths', () => {
    const a = root('a');
    const child = subtask({ title: 'child', ref: { parent: target(a), relativeLine: 2 } });
    const leaf = subtask({
      title: 'leaf',
      ref: { parent: { type: 'subtask', ref: child.ref }, relativeLine: 1 },
    });
    const nodes = enumerateTaskNodes([
      root('z'),
      { ...a, subtasks: [{ ...child, subtasks: [leaf] }] },
    ]);
    expect(nodes.map(({ node, path }) => [node.title, path.map((item) => item.title)])).toEqual([
      ['a', []],
      ['child', ['child']],
      ['leaf', ['child', 'leaf']],
      ['z', []],
    ]);
    expect(nodes.map(({ target: ref }) => ref.type)).toEqual([
      'task',
      'subtask',
      'subtask',
      'task',
    ]);
    expect(nodes[2]?.path[1]).toBe(nodes[2]?.node);
  });

  it('projects all root and subtask endpoint combinations directly in declared and source order', () => {
    const a = root('a', ['d', 'b', 'd']);
    const b = root('b', ['c']);
    const c = subtask({
      title: 'c',
      dependencyId: 'c',
      dependsOn: ['d'],
      ref: { parent: target(a) },
    });
    const d = subtask({
      title: 'd',
      dependencyId: 'd',
      dependsOn: ['b'],
      ref: { parent: target(b) },
    });
    const nodes = enumerateTaskNodes([
      { ...b, subtasks: [d] },
      { ...a, subtasks: [c] },
    ]);
    const catalog = canonicalStatusCatalog();
    const result = buildTaskDependencyGraph(nodes, (symbol) => catalog.statusForSymbol(symbol));
    expect(result.dependencies(target(a)).blockedBy.map((row) => row.dependencyId)).toEqual([
      'd',
      'b',
    ]);
    expect(result.dependencies(target(b)).blocks.map((row) => row.task.node.title)).toEqual([
      'a',
      'd',
    ]);
    expect(
      result.dependencies({ type: 'subtask', ref: c.ref }).blocks.map((row) => row.task.node.title),
    ).toEqual(['b']);
    expect(
      result.dependencies({ type: 'subtask', ref: d.ref }).blocks.map((row) => row.task.node.title),
    ).toEqual(['a', 'c']);
    expect(result.dependencies(target(a)).activeBlockedByCount).toBe(2);
  });

  it.each([
    [' ', ' ', 1],
    ['/', ' ', 1],
    ['x', ' ', 0],
    ['-', ' ', 0],
    [' ', 'x', 0],
    [' ', '-', 0],
    [' ', '/', 1],
  ])(
    'requires active endpoints (%s blocker, %s dependent)',
    (blockerSymbol, dependentSymbol, count) => {
      const a = root('a', [], blockerSymbol);
      const b = root('b', ['a'], dependentSymbol);
      const result = graph([a, b]);
      expect(result.dependencies(target(b)).activeBlockedByCount).toBe(count);
      expect(result.dependencies(target(a)).activeBlocksCount).toBe(count);
      expect(result.dependencies(target(b)).blockedBy).toHaveLength(1);
      expect(result.dependencies(target(a)).blocks).toHaveLength(1);
    },
  );

  it('keeps missing IDs as unavailable non-blocking rows without inverse relations', () => {
    const a = root('a', ['missing', 'missing']);
    expect(graph([a]).dependencies(target(a))).toEqual({
      blockedBy: [{ type: 'unavailable', dependencyId: 'missing', reason: 'missing' }],
      blocks: [],
      activeBlockedByCount: 0,
      activeBlocksCount: 0,
    });
  });

  it('uses any active duplicate-ID match but computes each inverse edge from its own endpoint', () => {
    const a = root('a');
    const done = { ...root('done', [], 'x'), dependencyId: 'a' };
    const b = root('b', ['a', 'a']);
    const result = graph([done, b, a]);
    expect(result.dependencies(target(b)).blockedBy).toMatchObject([
      {
        type: 'ambiguous',
        dependencyId: 'a',
        state: 'active',
        candidates: [{ node: { title: 'a' } }, { node: { title: 'done' } }],
      },
    ]);
    expect(result.dependencies(target(b)).activeBlockedByCount).toBe(1);
    expect(result.dependencies(target(a)).activeBlocksCount).toBe(1);
    expect(result.dependencies(target(done)).activeBlocksCount).toBe(0);
    const satisfied = graph([{ ...a, statusSymbol: '-' }, done, b]);
    expect(satisfied.dependencies(target(b)).blockedBy[0]).toMatchObject({
      type: 'ambiguous',
      state: 'satisfied',
    });
    expect(satisfied.dependencies(target(b)).activeBlockedByCount).toBe(0);
  });

  it('reads the live classifier instead of parsed status for both directions', () => {
    const a = root('a', [], '?');
    const b = root('b', ['a']);
    let custom: TaskStatus = 'open';
    const result = buildTaskDependencyGraph(enumerateTaskNodes([a, b]), (symbol) =>
      symbol === '?' ? custom : 'open',
    );
    expect(result.dependencies(target(b)).activeBlockedByCount).toBe(1);
    custom = 'cancelled';
    expect(result.dependencies(target(b)).activeBlockedByCount).toBe(0);
    expect(result.dependencies(target(a)).activeBlocksCount).toBe(0);
  });

  it('retains manually authored cycles as direct rows and terminates cycle searches', () => {
    const a = root('a', ['b']);
    const b = root('b', ['c']);
    const c = root('c', ['a']);
    const outsider = root('outsider');
    const result = graph([a, b, c, outsider]);
    expect(result.dependencies(target(a)).blockedBy.map((row) => row.dependencyId)).toEqual(['b']);
    expect(result.dependencies(target(a)).blocks.map((row) => row.task.node.title)).toEqual(['c']);
    expect(result.eligibility(target(a), target(outsider))).toEqual({ type: 'allowed' });
  });

  it('rejects self, duplicate, inverse and transitive cycles while allowing an acyclic pair', () => {
    const a = root('a');
    const b = root('b', ['a']);
    const c = root('c', ['b']);
    const d = root('d');
    const result = graph([a, b, c, d]);
    expect(result.eligibility(target(a), target(a))).toEqual({ type: 'rejected', reason: 'self' });
    expect(result.eligibility(target(a), target(b))).toEqual({
      type: 'rejected',
      reason: 'duplicate',
    });
    expect(result.eligibility(target(b), target(a))).toEqual({
      type: 'rejected',
      reason: 'inverse',
    });
    expect(result.eligibility(target(c), target(a))).toEqual({ type: 'rejected', reason: 'cycle' });
    expect(result.eligibility(target(c), target(d))).toEqual({ type: 'allowed' });
  });

  it('rejects ambiguous IDs, stale revisions and unavailable nodes, but permits ID allocation', () => {
    const a = root('a');
    const b = root('b');
    const duplicate = { ...root('duplicate'), dependencyId: 'a' };
    const noId = task({ source: { filePath: 'no-id.md' } });
    const result = graph([a, b, duplicate, noId]);
    expect(result.eligibility(target(a), target(b))).toEqual({
      type: 'rejected',
      reason: 'ambiguous',
    });
    expect(
      result.eligibility({ type: 'task', ref: { ...b.ref, revision: 'stale' } }, target(a)),
    ).toEqual({ type: 'rejected', reason: 'stale' });
    expect(
      result.eligibility(target(b), { type: 'task', ref: { ...a.ref, revision: 'stale' } }),
    ).toEqual({ type: 'rejected', reason: 'stale' });
    expect(result.eligibility(target(root('missing')), target(b))).toEqual({
      type: 'rejected',
      reason: 'unavailable',
    });
    expect(result.eligibility(target(b), target(root('forecast')))).toEqual({
      type: 'rejected',
      reason: 'unavailable',
    });
    expect(result.eligibility(target(noId), target(b))).toEqual({ type: 'allowed' });
  });

  it('rejects a stale nested block and an absent nested endpoint', () => {
    const a = root('a');
    const child = subtask({ title: 'child', ref: { parent: target(a) } });
    const b = root('b');
    const result = graph([{ ...a, subtasks: [child] }, b]);
    expect(
      result.eligibility(
        { type: 'subtask', ref: { ...child.ref, originalBlock: 'stale' } },
        target(b),
      ),
    ).toEqual({ type: 'rejected', reason: 'stale' });
    expect(
      result.eligibility({ type: 'subtask', ref: { ...child.ref, relativeLine: 99 } }, target(b)),
    ).toEqual({ type: 'rejected', reason: 'unavailable' });
  });

  it('detaches enumeration and graph projections from callers and source snapshots', () => {
    const a = root('a');
    const b = root('b', ['a']);
    const nodes = enumerateTaskNodes([a, b]);
    const result = graph([a, b]);
    const first = expectDefined(nodes[0]);
    expect(Reflect.set(first.root.ref, 'filePath', 'corrupt.md')).toBe(false);
    expect(Reflect.set(nodes, 'length', 0)).toBe(false);
    const relation = expectDefined(result.dependencies(target(b)).blockedBy[0]);
    expect(Reflect.set(relation, 'state', 'satisfied')).toBe(false);
    (b.dependsOn as string[]).push('missing');
    expect(result.dependencies(target(b)).blockedBy).toHaveLength(1);
    expect(a.ref.filePath).toBe('a.md');
  });

  it.each(['root', 'nested'] as const)(
    'detaches %s comment timestamps before freezing dependency snapshots',
    (location) => {
      const a = root('a');
      const child = subtask({ title: 'child', ref: { parent: target(a) } });
      const parent: TaskNodeRef =
        location === 'root' ? target(a) : { type: 'subtask', ref: child.ref };
      const comments = [
        taskComment({
          ref: { parent },
          timestamp: { precision: 'day', value: localDate('2026-09-05'), raw: '2026-09-05' },
        }),
        taskComment({
          ref: { parent, relativeLine: 2 },
          timestamp: {
            precision: 'instant',
            atom: atomDateTime('2026-09-05T00:00:00Z'),
            epochMs: 1788566400000,
            raw: '2026-09-05T00:00:00Z',
          },
        }),
      ];
      const source =
        location === 'root' ? { ...a, comments } : { ...a, subtasks: [{ ...child, comments }] };
      const nodes = enumerateTaskNodes([source]);
      const output = expectDefined(
        nodes.find((item) => item.node.title === (location === 'root' ? 'a' : 'child')),
      ).node.comments;

      for (const [index, comment] of comments.entries()) {
        const original = expectDefined(comment.timestamp);
        const cloned = expectDefined(output[index]?.timestamp);
        expect(Object.isFrozen(original)).toBe(false);
        expect(cloned).not.toBe(original);
        expect(Object.isFrozen(cloned)).toBe(true);
        expect(cloned).toEqual(original);
        expect(Reflect.set(original, 'raw', 'changed')).toBe(true);
      }
      expect(output.map((comment) => comment.timestamp?.raw)).toEqual([
        '2026-09-05',
        '2026-09-05T00:00:00Z',
      ]);
    },
  );
});
