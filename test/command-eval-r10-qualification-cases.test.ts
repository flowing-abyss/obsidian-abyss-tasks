import { expect, it } from 'vitest';
import { selectCases, unqualifiedTurns } from './command-live/corpus';
import { evaluateTurn } from './command-live/oracles';
import { expectDefined } from './helpers';

const ids = ['r10-fresh-sparse-line-en', 'r10-fresh-earlier-draft-ru'];
const cases = selectCases(ids.join(','));

function previewEvidence(expected: (typeof cases)[number]['turns'][number]['expect']) {
  const files = expected.files ?? {};
  return {
    status: expected.status,
    question: expected.questionIncludes ?? null,
    trees: structuredClone(expected.trees ?? []),
    publicTrees: structuredClone(expected.publicTrees ?? []),
    ...(expected.taskSources === undefined
      ? {}
      : {
          taskSources: expected.taskSources.map((source) => ({ ...source, basisValid: true })),
        }),
    ...(expected.proposalKinds === undefined ? {} : { proposalKinds: expected.proposalKinds }),
    before: { ...files },
    after: { ...files },
    journal: [],
    admissions: [],
    complete: true,
    writeCount: expected.writeCount ?? 0,
  };
}

it('registers exactly the two new held-out command-live cases with complete save contracts', () => {
  expect(cases.map((test) => test.id)).toEqual(ids);
  expect(cases.every((test) => test.split === 'held-out' && test.scripted === undefined)).toBe(
    true,
  );
  expect(cases.every((test) => unqualifiedTurns(test).length === 0)).toBe(true);
});

it('binds the sparse-line English clarification to its canonical owner and complete save', () => {
  const sparse = expectDefined(cases.find((test) => test.id === 'r10-fresh-sparse-line-en'));
  const question = expectDefined(sparse.turns[0]);
  const clarification = expectDefined(sparse.turns[1]);
  const saved = expectDefined(sparse.turns[2]);
  expect(sparse.turns.map((turn) => turn.expect.status)).toEqual(['question', 'ready', 'saved']);
  expect(question.expect.trees?.map((item) => (item as { source: unknown }).source)).toEqual([
    { path: 'records/Mechanical room.md', line: 2 },
    { path: 'records/Mechanical room.md', line: 6 },
  ]);
  expect(clarification.text).toContain('physical line 7');
  expect(clarification.expect.taskSources).toEqual([
    { path: 'records/Mechanical room.md', line: 6, kind: 'edit' },
  ]);
  expect(saved.expect).toMatchObject({
    status: 'saved',
    proposalKinds: [],
    createdFiles: [],
    writeCount: 1,
  });
  expect(saved.expect.files?.['notes/Log index.md']).toBe(
    '# Index\r\nRetain this line exactly.\r\n',
  );
});

it('binds the earlier Russian pending root and complete two-task save', () => {
  const earlier = expectDefined(cases.find((test) => test.id === 'r10-fresh-earlier-draft-ru'));
  const first = expectDefined(earlier.turns[0]);
  const refinement = expectDefined(earlier.turns[1]);
  const saved = expectDefined(earlier.turns[2]);
  expect(earlier.turns.map((turn) => turn.expect.status)).toEqual(['ready', 'ready', 'saved']);
  expect(first.expect.proposalKinds).toEqual(['task', 'task']);
  expect(refinement.expect.trees).toHaveLength(2);
  expect(saved.expect).toMatchObject({
    status: 'saved',
    proposalKinds: [],
    createdFiles: [],
    writeCount: 2,
    retainPreviousTasks: true,
  });
  expect(saved.expect.publicTrees?.map((item) => (item as { source: unknown }).source)).toEqual([
    { path: 'a.md', line: 1 },
    { path: 'a.md', line: 4 },
  ]);
  expect(saved.expect.files?.['control.md']).toContain('\r\n');
});

it('accepts the line-seven owner and rejects the other same-title owner coordinate', () => {
  const sparse = expectDefined(cases.find((test) => test.id === 'r10-fresh-sparse-line-en'));
  const preview = expectDefined(sparse.turns[1]).expect;
  expect(evaluateTurn(preview, previewEvidence(preview))).toEqual([]);

  const wrongOwner = previewEvidence(preview);
  wrongOwner.taskSources = [
    { path: 'records/Mechanical room.md', line: 2, kind: 'edit', basisValid: true },
  ];
  expect(evaluateTurn(preview, wrongOwner)).toContain('task-source-basis');
});

it('accepts both refined pending roots and rejects duplicate or unrefined results', () => {
  const earlier = expectDefined(cases.find((test) => test.id === 'r10-fresh-earlier-draft-ru'));
  const refine = expectDefined(earlier.turns[1]).expect;
  const correct = previewEvidence(refine);
  expect(evaluateTurn(refine, correct)).toEqual([]);

  const duplicateRoot = previewEvidence(refine);
  const expectedRoots = expectDefined(refine.trees);
  const firstRoot = expectDefined(expectedRoots[0]);
  duplicateRoot.trees = [structuredClone(firstRoot), structuredClone(firstRoot)];
  expect(evaluateTurn(refine, duplicateRoot)).toContain('tree-postcondition');

  const staleDate = previewEvidence(refine);
  const first = staleDate.trees[0] as { dates: { due: string } };
  first.dates.due = '2027-02-14';
  expect(evaluateTurn(refine, staleDate)).toContain('tree-postcondition');
});
