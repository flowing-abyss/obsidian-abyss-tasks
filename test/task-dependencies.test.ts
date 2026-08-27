import { describe, expect, it } from 'vitest';
import { DependencyIndex } from '../src/projects/dependencies/DependencyIndex';
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
});
