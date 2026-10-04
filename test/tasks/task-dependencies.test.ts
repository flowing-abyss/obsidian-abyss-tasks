// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import {
  assembleTaskDependencyGraph,
  assembleTaskDependencyGraphSteps,
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

describe.each(['defensive', 'synchronous', 'cooperative'] as const)(
  'task dependency graph (%s)',
  (driver) => {
    function graph(tasks: readonly TaskSnapshot[]) {
      const catalog = canonicalStatusCatalog();
      const nodes = enumerateTaskNodes(tasks);
      const status = (symbol: string) => catalog.statusForSymbol(symbol);
      if (driver === 'defensive') return buildTaskDependencyGraph(nodes, status);
      if (driver === 'synchronous') return assembleTaskDependencyGraph(nodes, status);
      const cursor = assembleTaskDependencyGraphSteps(nodes, status);
      let step = cursor.next();
      while (step.done !== true) step = cursor.next();
      return step.value;
    }

    it('same structural address with multiple revisions preserves standalone exact behavior', () => {
      const blocker = root('blocker');
      const original = task({
        dependsOn: ['blocker'],
        source: { filePath: 'same.md' },
        ref: { revision: 'old' },
      });
      const revised = task({
        dependsOn: [],
        source: { filePath: 'same.md' },
        ref: { revision: 'new' },
      });
      const model = graph([blocker, original, revised]);
      expect(model.dependencies(target(original)).activeBlockedByCount).toBe(1);
      expect(model.dependencies(target(revised)).activeBlockedByCount).toBe(0);
      expect(model.eligibility(target(blocker), target(original))).toEqual({
        type: 'rejected',
        reason: 'duplicate',
      });
      expect(model.eligibility(target(blocker), target(revised))).toEqual({ type: 'allowed' });
    });

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
        result
          .dependencies({ type: 'subtask', ref: c.ref })
          .blocks.map((row) => row.task.node.title),
      ).toEqual(['b']);
      expect(
        result
          .dependencies({ type: 'subtask', ref: d.ref })
          .blocks.map((row) => row.task.node.title),
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
      expect(result.dependencies(target(a)).blockedBy.map((row) => row.dependencyId)).toEqual([
        'b',
      ]);
      expect(result.dependencies(target(a)).blocks.map((row) => row.task.node.title)).toEqual([
        'c',
      ]);
      expect(result.eligibility(target(a), target(outsider))).toEqual({ type: 'allowed' });
    });

    it('rejects self, duplicate, inverse and transitive cycles while allowing an acyclic pair', () => {
      const a = root('a');
      const b = root('b', ['a']);
      const c = root('c', ['b']);
      const d = root('d');
      const result = graph([a, b, c, d]);
      expect(result.eligibility(target(a), target(a))).toEqual({
        type: 'rejected',
        reason: 'self',
      });
      expect(result.eligibility(target(a), target(b))).toEqual({
        type: 'rejected',
        reason: 'duplicate',
      });
      expect(result.eligibility(target(b), target(a))).toEqual({
        type: 'rejected',
        reason: 'inverse',
      });
      expect(result.eligibility(target(c), target(a))).toEqual({
        type: 'rejected',
        reason: 'cycle',
      });
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
      const result = buildTaskDependencyGraph(nodes, () => 'open');
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
  },
);

describe('resumable dependency assembly', () => {
  it('checkpoints node registration, every prerequisite ID and ambiguous expansion, preserving wrapper multiplicity and order', () => {
    const a = root('a');
    const b = root('b', ['a', 'a', 'missing']);
    const nodes = enumerateTaskNodes([a, b]);
    const first = expectDefined(nodes[0]);
    const second = expectDefined(nodes[1]);
    const alias = { ...first };
    const input = [first, first, alias, second, second];
    const cursor = assembleTaskDependencyGraphSteps(input, () => 'open');
    let count = 0;
    let step = cursor.next();
    while (step.done !== true) {
      count++;
      step = cursor.next();
    }
    // 5 registrations + 5 dependent visits + 6 declared IDs + 6 expanded candidates.
    expect(count).toBe(22);
    const model = step.value;
    const relation = model.dependencies(second.target).blockedBy[0];
    expect(relation).toMatchObject({ type: 'ambiguous', candidates: [first, first, alias] });
    expect(model.dependencies(first.target).blocks.map((row) => row.task)).toEqual([
      second,
      second,
    ]);
    const sync = assembleTaskDependencyGraph(input, () => 'open');
    for (const left of input) {
      expect(model.dependencies(left.target)).toEqual(sync.dependencies(left.target));
      for (const right of input)
        expect(model.eligibility(left.target, right.target)).toEqual(
          sync.eligibility(left.target, right.target),
        );
    }
    const without = assembleTaskDependencyGraphSteps(input, () => 'open', {
      blocker: first.target,
      dependent: second.target,
    });
    let result = without.next();
    while (result.done !== true) result = without.next();
    expect(result.value.dependencies(first.target).blocks).toEqual([]);
    expect(result.value.eligibility(first.target, second.target)).toEqual({
      type: 'rejected',
      reason: 'ambiguous',
    });
  });
  it('does not eagerly consume a huge node iterable or prerequisite list before its checkpoint', () => {
    const node = expectDefined(enumerateTaskNodes([root('a')])[0]);
    let visited = 0;
    function* input() {
      for (let i = 0; i < 10000; i++) {
        visited++;
        yield node;
      }
    }
    const cursor = assembleTaskDependencyGraphSteps(input(), () => 'open');
    for (let i = 0; i < 128; i++) expect(cursor.next().done).toBe(false);
    expect(visited).toBe(128);
  });
});

describe('dense expanded edge checkpoints', () => {
  it('one dependent with many declared IDs and ambiguous candidates remains interruptible inside both lists', () => {
    const blocker = expectDefined(enumerateTaskNodes([root('shared')])[0]);
    const dependent = expectDefined(
      enumerateTaskNodes([
        root('dependent', [
          'shared',
          ...Array.from({ length: 1000 }, (_, i) => `missing${i}`),
          'shared',
        ]),
      ])[0],
    );
    const nodes = [...Array.from({ length: 1000 }, () => ({ ...blocker })), dependent];
    const cursor = assembleTaskDependencyGraphSteps(nodes, () => 'open');
    let checkpoints = 0,
      step = cursor.next();
    while (step.done !== true) {
      checkpoints++;
      step = cursor.next();
    }
    // 1001 registrations +1001 dependent visits +1002 declared IDs +1000 candidates.
    expect(checkpoints).toBe(4004);
    expect(step.value.dependencies(dependent.target).blockedBy).toHaveLength(1001);
    const first = expectDefined(step.value.dependencies(dependent.target).blockedBy[0]);
    expect(first.type).toBe('ambiguous');
    if (first.type !== 'ambiguous') throw new Error('expected ambiguity');
    expect(first.candidates).toHaveLength(1000);
    expect(first.candidates[0]).toBe(nodes[0]);
    expect(first.candidates[999]).toBe(nodes[999]);
  });
});
