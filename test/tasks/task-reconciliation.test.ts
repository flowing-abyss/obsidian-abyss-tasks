import { describe, expect, it } from 'vitest';
import {
  reconcileNested,
  reconcileRoot,
  reconcileRootTransitions,
  type ProvenRootRevisionOverride,
  type RebaseEvidence,
  type VisualEvidence,
} from '../../src/tasks/domain/taskReconciliation';
import { subtask, task } from '../helpers';

function root(line: number, title: string, revision = `revision:${title}`) {
  const originalBlock = `- [ ] ${title}`;
  return task({
    title,
    markdownTitle: title,
    ref: { filePath: 'tasks.md', line, revision },
    source: { filePath: 'tasks.md', line, originalMarkdown: originalBlock, originalBlock },
  });
}

describe('task reconciliation', () => {
  it('rejects a different task that moved onto the stale line', () => {
    const previous = root(4, 'Observed');
    const replacement = root(4, 'Different', 'revision:different');

    expect(reconcileRoot(previous, [replacement])).toEqual({
      type: 'visual',
      stale: previous.ref,
      current: replacement,
      evidence: 'same-line',
    });
  });

  it.each(['byte-identical-relocation', 'authority-transition'] as const)(
    'returns closed-set writable evidence %s',
    (evidence: RebaseEvidence) => {
      const previous = root(4, 'Observed');
      let current = root(9, 'Observed', previous.ref.revision);
      let previousRoots = [previous];
      let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];

      if (evidence === 'authority-transition') {
        current = root(4, 'Externally edited', 'revision:successor');
        authorityTransitions = [
          {
            previousRevision: previous.ref.revision,
            line: current.source.line,
            source: current.source.originalBlock,
            revision: current.ref.revision,
          },
        ];
      }

      expect(
        reconcileRoot(previous, [current], { previousRoots, authorityTransitions }),
      ).toMatchObject({ type: 'rebased', evidence });
    },
  );

  it.each(['same-line', 'anchored-range'] as const)(
    'returns non-writable visual evidence %s without retaining a stale snapshot',
    (evidence: VisualEvidence) => {
      const previous = root(4, 'Observed');
      const current = root(
        evidence === 'same-line' ? 4 : 5,
        'Externally edited',
        'revision:edited',
      );
      const before = root(1, 'Before');
      const after = root(8, 'After');
      const options =
        evidence === 'anchored-range' ? { previousRoots: [before, previous, after] } : undefined;
      const roots =
        evidence === 'anchored-range' ? [root(1, 'Before'), current, root(8, 'After')] : [current];

      expect(reconcileRoot(previous, roots, options)).toEqual({
        type: 'visual',
        stale: previous.ref,
        current,
        evidence,
      });
    },
  );

  it('treats duplicate direct-sibling source matches as ambiguous', () => {
    const parent = root(0, 'Parent');
    const previousChild = subtask({
      title: 'Child',
      ref: {
        parent: { type: 'task', ref: parent.ref },
        relativeLine: 1,
        originalBlock: '  - [ ] Child',
      },
    });
    const duplicate = (relativeLine: number) =>
      subtask({
        title: 'Child',
        ref: {
          parent: { type: 'task', ref: parent.ref },
          relativeLine,
          originalBlock: previousChild.ref.originalBlock,
        },
      });
    const currentParent = { ...parent, subtasks: [duplicate(1), duplicate(3)] };

    expect(reconcileNested(previousChild, currentParent).type).toBe('ambiguous');
  });

  it('does not treat an authority-created insertion as the previous destination root', () => {
    const destination = root(0, 'Destination', 'revision:destination');
    const inserted = root(0, 'Inserted', 'revision:inserted-successor');
    const movedDestination = root(1, 'Destination', destination.ref.revision);
    const authorityTransitions = [
      {
        previousRevision: 'revision:source-from-another-file',
        line: inserted.source.line,
        source: inserted.source.originalBlock,
        revision: inserted.ref.revision,
      },
    ];

    expect(
      reconcileRoot(destination, [inserted, movedDestination], {
        previousRoots: [destination],
        authorityTransitions,
      }),
    ).toMatchObject({
      type: 'rebased',
      current: { title: 'Destination', source: { line: 1 } },
      evidence: 'byte-identical-relocation',
    });
  });

  it('does not infer an anchored range from only one neighboring root', () => {
    const before = root(0, 'Before');
    const observed = root(1, 'Observed');
    const replacement = root(1, 'Replacement', 'revision:replacement');

    expect(
      reconcileRoot(observed, [before, replacement], {
        previousRoots: [before, observed],
      }),
    ).toEqual({
      type: 'visual',
      stale: observed.ref,
      current: replacement,
      evidence: 'same-line',
    });
  });

  it('indexes authority candidates once instead of rescanning every root per transition', () => {
    const size = 200;
    let reads = 0;
    const counted = <T>(values: readonly T[]): readonly T[] =>
      new Proxy(values, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    const previous = counted(
      Array.from({ length: size }, (_, index) => root(index, `previous ${index}`, `old:${index}`)),
    );
    const current = counted(
      Array.from({ length: size }, (_, index) => root(index, `current ${index}`, `new:${index}`)),
    );
    const authorities = Array.from({ length: size }, (_, index) => ({
      previousRevision: `old:${index}`,
      line: index,
      source: `- [ ] current ${index}`,
      revision: `new:${index}`,
    }));

    expect(reconcileRootTransitions(previous, current, authorities).writable).toHaveLength(size);
    expect(reads).toBeLessThan(size * 20);
  });
});
