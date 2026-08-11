import { describe, expect, it } from 'vitest';
import {
  reconcileNested,
  reconcileRoot,
  type ProvenRootRevisionOverride,
  type RebaseEvidence,
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
      type: 'uncertain',
      ref: previous.ref,
    });
  });

  it.each(['byte-identical-relocation', 'authority-transition', 'anchored-range'] as const)(
    'returns closed-set evidence %s',
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
      } else if (evidence === 'anchored-range') {
        const before = root(1, 'Before');
        const after = root(8, 'After');
        previousRoots = [before, previous, after];
        current = root(5, 'Externally edited', 'revision:edited');
        return expect(
          reconcileRoot(previous, [root(1, 'Before'), current, root(8, 'After')], {
            previousRoots,
          }),
        ).toMatchObject({ type: 'rebased', evidence });
      }

      expect(
        reconcileRoot(previous, [current], { previousRoots, authorityTransitions }),
      ).toMatchObject({ type: 'rebased', evidence });
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
    ).toEqual({ type: 'uncertain', ref: observed.ref });
  });
});
