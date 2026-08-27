import { describe, expect, it, vi } from 'vitest';
import { DependencyIndex } from '../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../src/projects/dependencies/DependencyPolicy';
import type { TaskSnapshot } from '../src/tasks/domain/types';

function task(
  line: number,
  dependency: Partial<NonNullable<TaskSnapshot['dependency']>> = {},
  status: TaskSnapshot['status'] = 'open',
): TaskSnapshot {
  const originalMarkdown = `- [ ] Task ${line}`;
  return {
    ref: { filePath: 'Tasks.md', line, revision: `r-${line}` },
    title: `Task ${line}`,
    markdownTitle: `Task ${line}`,
    status,
    statusSymbol: status === 'done' ? 'x' : ' ',
    priority: 'D',
    planning: {},
    tags: [],
    onCompletion: 'keep',
    onCompletionExplicit: false,
    subtasks: [],
    comments: [],
    dependency: { dependsOn: [], ...dependency },
    source: { filePath: 'Tasks.md', line, originalMarkdown, originalBlock: originalMarkdown },
    presentation: { linkCount: 0 },
  };
}

describe('DependencyIndex', () => {
  it('projects ready work when every prerequisite is complete', () => {
    const index = new DependencyIndex();
    const prerequisite = task(1, { id: 'prep' }, 'done');
    const dependent = task(2, { id: 'ship', dependsOn: ['prep'] });

    index.replace([prerequisite, dependent]);

    expect(index.get(dependent.ref)).toMatchObject({ type: 'ready', ref: dependent.ref });
  });

  it('retains ambiguous candidates and diagnoses missing, self, and cyclic dependencies', () => {
    const index = new DependencyIndex();
    const duplicateA = task(1, { id: 'same' });
    const duplicateB = task(2, { id: 'same' });
    const ambiguous = task(3, { id: 'uses-same', dependsOn: ['same'] });
    const missing = task(4, { id: 'missing', dependsOn: ['gone'] });
    const self = task(5, { id: 'self', dependsOn: ['self'] });
    const cycleA = task(6, { id: 'a', dependsOn: ['b'] });
    const cycleB = task(7, { id: 'b', dependsOn: ['a'] }, 'cancelled');

    index.replace([duplicateA, duplicateB, ambiguous, missing, self, cycleA, cycleB]);

    expect(index.get(ambiguous.ref)).toMatchObject({
      type: 'invalid',
      diagnostics: [
        expect.objectContaining({
          type: 'duplicate-id',
          id: 'same',
          candidates: [duplicateA.ref, duplicateB.ref],
        }),
      ],
    });
    expect(index.get(missing.ref)).toMatchObject({
      type: 'invalid',
      diagnostics: [expect.objectContaining({ type: 'missing-prerequisite', id: 'gone' })],
    });
    expect(index.get(self.ref)).toMatchObject({
      type: 'invalid',
      diagnostics: [expect.objectContaining({ type: 'self-edge', id: 'self' })],
    });
    expect(index.get(cycleA.ref)).toMatchObject({
      type: 'invalid',
      diagnostics: [expect.objectContaining({ type: 'cycle' })],
    });
    expect(index.get(cycleB.ref)).toMatchObject({
      type: 'invalid',
      diagnostics: [expect.objectContaining({ type: 'cycle' })],
    });
  });

  it('projects every direct relation for inspection without asking UI to resolve IDs', () => {
    const index = new DependencyIndex();
    const resolved = task(1, { id: 'ready' });
    const duplicateA = task(2, { id: 'duplicate' });
    const duplicateB = task(3, { id: 'duplicate' });
    const dependent = task(4, {
      id: 'ship',
      dependsOn: ['ready', 'missing', 'duplicate'],
    });
    index.replace([resolved, duplicateA, duplicateB, dependent]);

    expect(new DependencyPolicy(index).inspect(dependent)).toEqual({
      decision: expect.objectContaining({ type: 'invalid' }),
      relations: [
        {
          id: 'ready',
          resolution: { type: 'resolved', prerequisite: resolved.ref, complete: false },
        },
        { id: 'missing', resolution: { type: 'missing' } },
        {
          id: 'duplicate',
          resolution: { type: 'duplicate', candidates: [duplicateA.ref, duplicateB.ref] },
        },
      ],
    });
  });

  it('retains raw carrier IDs when inspection is unresolved so every relation remains clearable', () => {
    const unresolved = task(7, { dependsOn: ['first', 'second'] });
    const policy = new DependencyPolicy(new DependencyIndex());

    expect(policy.inspect(unresolved)).toEqual({
      decision: { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] },
      relations: [
        { id: 'first', resolution: { type: 'missing' } },
        { id: 'second', resolution: { type: 'missing' } },
      ],
    });
  });

  it('returns defensive inspection copies including resolved completion state', () => {
    const completed = task(8, { id: 'done' }, 'done');
    const duplicateA = task(9, { id: 'same' });
    const duplicateB = task(10, { id: 'same' });
    const dependent = task(11, { dependsOn: ['done', 'same'] });
    const index = new DependencyIndex();
    const policy = new DependencyPolicy(index);
    index.replace([completed, duplicateA, duplicateB, dependent]);
    const first = policy.inspect(dependent);
    const resolved = first.relations[0]!.resolution;
    const duplicate = first.relations[1]!.resolution;
    if (resolved.type !== 'resolved' || duplicate.type !== 'duplicate') throw new Error('fixture');
    (resolved.prerequisite as { filePath: string }).filePath = 'mutated.md';
    (duplicate.candidates[0] as { line: number }).line = 999;

    expect(policy.inspect(dependent).relations).toEqual([
      {
        id: 'done',
        resolution: { type: 'resolved', prerequisite: completed.ref, complete: true },
      },
      {
        id: 'same',
        resolution: { type: 'duplicate', candidates: [duplicateA.ref, duplicateB.ref] },
      },
    ]);
  });

  it('publishes the changed task and reverse dependent when prerequisite completion changes', () => {
    const index = new DependencyIndex();
    const prerequisite = task(1, { id: 'prep' });
    const dependent = task(2, { id: 'ship', dependsOn: ['prep'] });
    const published: TaskSnapshot['ref'][][] = [];
    index.subscribe((refs) => published.push([...refs]));
    index.replace([prerequisite, dependent]);
    published.length = 0;

    index.replace([task(1, { id: 'prep' }, 'done'), dependent]);

    expect(published).toEqual([[prerequisite.ref, dependent.ref]]);
  });

  it('isolates listener failures so every subscriber observes a committed projection', () => {
    const index = new DependencyIndex();
    const observed = vi.fn();
    index.subscribe(() => {
      throw new Error('listener failed');
    });
    index.subscribe(observed);

    expect(() => index.replace([task(1, { id: 'prep' })])).not.toThrow();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith([task(1, { id: 'prep' }).ref]);
  });

  it.each([
    ['b', 'c'],
    ['c', 'b'],
  ])('marks every member of an SCC regardless of a dependency ordering', (first, second) => {
    const index = new DependencyIndex();
    const a = task(1, { id: 'a', dependsOn: [first, second] });
    const b = task(2, { id: 'b', dependsOn: ['a'] });
    const c = task(3, { id: 'c', dependsOn: ['b'] });

    index.replace([a, b, c]);

    for (const candidate of [a, b, c]) {
      expect(index.get(candidate.ref)).toMatchObject({
        type: 'invalid',
        diagnostics: [expect.objectContaining({ type: 'cycle', ids: ['a', 'b', 'c'] })],
      });
    }
  });

  it('invalidates an old ref and announces its stable-ID successor', () => {
    const index = new DependencyIndex();
    const oldTask = task(1, { id: 'stable' });
    const nextTask = {
      ...task(9, { id: 'stable' }),
      ref: { filePath: 'Renamed.md', line: 9, revision: 'r-next' },
      source: {
        filePath: 'Renamed.md',
        line: 9,
        originalMarkdown: '- [ ] Renamed',
        originalBlock: '- [ ] Renamed',
      },
    } satisfies TaskSnapshot;
    const published: TaskSnapshot['ref'][][] = [];
    index.subscribe((refs) => published.push([...refs]));
    index.replace([oldTask]);
    published.length = 0;

    index.replace([nextTask]);

    expect(published).toEqual([[nextTask.ref, oldTask.ref]]);
    expect(index.get(oldTask.ref)).toBeUndefined();
    expect(index.get(nextTask.ref)).toMatchObject({ type: 'ready', ref: nextTask.ref });
  });
});
