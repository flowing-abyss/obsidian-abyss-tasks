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
      const previousRoots = [previous];
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

  it('distinguishes exact, missing, and uncertain root outcomes', () => {
    const observed = root(4, 'Observed');

    expect(reconcileRoot(observed, [observed])).toMatchObject({ type: 'exact', task: observed });
    expect(reconcileRoot(observed, [])).toEqual({ type: 'not-found', ref: observed.ref });
    expect(reconcileRoot(observed, [root(9, 'Different')])).toEqual({
      type: 'uncertain',
      ref: observed.ref,
    });
  });

  it('reports duplicate revision and source matches as explicit root candidates', () => {
    const observed = root(4, 'Observed');
    const duplicateRevision = [
      root(7, 'First', observed.ref.revision),
      root(8, 'Second', observed.ref.revision),
    ];
    const duplicateSource = [
      root(7, 'Observed', 'revision:first'),
      root(8, 'Observed', 'revision:second'),
    ];

    for (const candidates of [duplicateRevision, duplicateSource]) {
      const result = reconcileRoot(observed, candidates);
      expect(result).toMatchObject({ type: 'ambiguous' });
      if (result.type !== 'ambiguous') throw new Error('expected ambiguous resolution');
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toMatchObject({
        root: candidates[0],
        target: { type: 'task', ref: candidates[0]?.ref },
      });
    }
  });

  it('returns exact, relocated, and missing nested resolutions', () => {
    const parent = root(0, 'Parent');
    const observed = subtask({
      title: 'Child',
      ref: {
        parent: { type: 'task', ref: parent.ref },
        relativeLine: 1,
        originalBlock: '  - [ ] Child',
      },
    });
    const exact = { ...observed };
    const relocated = {
      ...observed,
      ref: { ...observed.ref, relativeLine: 3 },
    };

    expect(reconcileNested(observed, { ...parent, subtasks: [exact] })).toEqual({
      type: 'exact',
      task: exact,
    });
    expect(reconcileNested(observed, { ...parent, subtasks: [relocated] })).toEqual({
      type: 'rebased',
      previous: observed,
      current: relocated,
      evidence: 'byte-identical-relocation',
    });
    expect(reconcileNested(observed, { ...parent, subtasks: [] })).toEqual({
      type: 'not-found',
      ref: observed.ref,
    });
  });

  it('ignores duplicate and mismatched authority claims instead of pairing roots unsafely', () => {
    const previous = root(0, 'Previous', 'revision:old');
    const duplicatePrevious = root(1, 'Previous copy', 'revision:old');
    const current = root(2, 'Current', 'revision:new');
    const authority = {
      previousRevision: 'revision:old',
      line: current.source.line,
      source: current.source.originalBlock,
      revision: current.ref.revision,
    };

    expect(
      reconcileRootTransitions([previous, duplicatePrevious], [current], [authority]).writable,
    ).toHaveLength(0);
    expect(
      reconcileRootTransitions([previous], [current, { ...current }], [authority]).writable,
    ).toHaveLength(0);
    expect(
      reconcileRootTransitions(
        [previous],
        [current],
        [{ ...authority, previousRevision: 'revision:unknown' }],
      ).writable,
    ).toHaveLength(0);
  });

  it('indexes authority candidates once instead of rescanning every root per transition', () => {
    const size = 200;
    let reads = 0;
    const counted = <T>(values: readonly T[]): readonly T[] =>
      new Proxy(values, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) reads += 1;
          const value: unknown = Reflect.get(target, property, receiver);
          return value;
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
