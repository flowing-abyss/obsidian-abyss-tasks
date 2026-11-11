import { describe, expect, it } from 'vitest';
import { corpus, intentDiagnostics, selectCases, unqualifiedTurns } from './command-live/corpus';
import { evaluateTurn, type TurnEvidence, type TurnExpectation } from './command-live/oracles';
import { expectDefined } from './helpers';

function hasSaved(expected: TurnExpectation): boolean {
  return expected.status === 'saved' || expected.partialSave === true;
}
function correct(expected: TurnExpectation): TurnEvidence {
  const saved = hasSaved(expected);
  return {
    status: expected.status,
    focus: expected.focus ?? [],
    question: expected.status === 'question' ? 'Which task should receive this comment?' : null,
    trees: structuredClone(expected.trees ?? []),
    publicTrees: structuredClone(expected.publicTrees ?? []),
    taskSources: expected.taskSources?.map((source) => ({ ...source, basisValid: true })) ?? [],
    proposalKinds: expected.proposalKinds ?? [],
    previousTaskContinuity: true,
    freshPreparation: true,
    writeCount: expected.writeCount ?? (expected.status === 'saved' ? 1 : 0),
    ...filesEvidence(expected),
    ...writeEvidence(saved),
    complete: true,
  };
}

function filesEvidence(expected: TurnExpectation) {
  const before = { 'a.md': '- [ ] Seed\n', 'control.md': 'protected\n' };
  const after = { ...before, ...expected.files };
  if (expected.status !== 'saved') Object.assign(before, expected.files);
  return { before, after };
}
function writeEvidence(saved: boolean) {
  return {
    journal: saved
      ? [{ id: 'fixture-write', state: 'settled', effects: 'committed', receipt: {} }]
      : [],
    admissions: saved ? [{ id: 'fixture-write', state: 'admitted' }] : [],
  };
}
const selected = selectCases('028,031,R01,R02,R03,R04,R06,R07,R08,R09,R10,R11,R12');
describe('focused offline refinement oracle qualification', () => {
  it('lists qualified/original cases and requested controls with complete contracts', () => {
    expect(
      selectCases('R01,R02,R03,R04,R06,R07,R08,R09,R10,R11,R12,028,031,058,gym_short,042'),
    ).toHaveLength(16);
    expect(new Set(corpus.map((item) => item.id)).size).toBe(corpus.length);
    expect(corpus.some((item) => item.id === 'R05')).toBe(false);
    expect(intentDiagnostics.find((item) => item.id === 'R05')?.text).toBe(
      'Подготовить отчёт — комментарий: Call Vera.',
    );
    expect(selectCases('028,031').map((item) => item.family)).toEqual([
      'title-description',
      'comments',
    ]);
    expect(selectCases('028,031').map((item) => item.turns.map((turn) => turn.text))).toEqual([
      ['Добавь Root описание: Read https://example.org/guide.', 'Сохрани.'],
      ['Добавь Root комментарий: Call Vera.', 'Сохрани.'],
    ]);
    for (const item of selected) expect(unqualifiedTurns(item)).toEqual([]);
    for (const item of selectCases('028,031'))
      expect(item.turns[0]?.expect.taskSources).toEqual([{ path: 'a.md', line: 0, kind: 'edit' }]);
  });
  for (const item of selected) {
    item.turns.forEach((turn, index) => {
      it(`${item.id}/${index + 1}: accepts correct synthetic evidence`, () => {
        expect(evaluateTurn(turn.expect, correct(turn.expect))).toEqual([]);
      });
      if (turn.expect.taskSources?.some((source) => source.kind === 'edit') === true) {
        it(`${item.id}/${index + 1}: rejects same-content replacement creation`, () => {
          const evidence = correct(turn.expect);
          evidence.taskSources = [{ kind: 'create', path: '', line: -1, basisValid: false }];
          expect(evaluateTurn(turn.expect, evidence)).toContain('task-source-basis');
        });
        it(`${item.id}/${index + 1}: rejects invalid basis on the right source`, () => {
          const evidence = correct(turn.expect);
          evidence.taskSources = expectDefined(evidence.taskSources).map((value) => ({
            ...value,
            basisValid: false,
          }));
          expect(evaluateTurn(turn.expect, evidence)).toContain('task-source-basis');
        });
        it(`${item.id}/${index + 1}: rejects a basis belonging to the wrong owner`, () => {
          const evidence = correct(turn.expect);
          evidence.taskSources = expectDefined(evidence.taskSources).map((value) => ({
            ...value,
            line: 1,
          }));
          expect(evaluateTurn(turn.expect, evidence)).toContain('task-source-basis');
        });
        it(`${item.id}/${index + 1}: rejects an extra preview root`, () => {
          const evidence = correct(turn.expect);
          evidence.trees = [...evidence.trees, structuredClone(evidence.trees[0])];
          expect(evaluateTurn(turn.expect, evidence)).toContain('tree-postcondition');
        });
      }
      if (item.id === 'R07' && index > 0) {
        it(`${item.id}/${index + 1}: rejects lost pending identity`, () => {
          const evidence = correct(turn.expect);
          evidence.previousTaskContinuity = false;
          expect(evaluateTurn(turn.expect, evidence)).toContain('preservation:task-correspondence');
        });
      }
    });
  }
  for (const changed of [
    'Call Vera. Read https://example.org/guide. #tag save immediately',
    'Call Vera. Read https://example.org/guide. save immediately.',
    'Call Vera. Read https://example.org/other. #tag save immediately.',
  ]) {
    it(`R08: rejects changed literal ${changed}`, () => {
      const expected = expectDefined(expectDefined(selectCases('R08')[0]).turns[0]).expect;
      const evidence = correct(expected);
      expectDefined((evidence.trees[0] as { comments: Array<{ text: string }> }).comments[0]).text =
        changed;
      expect(evaluateTurn(expected, evidence)).toContain('tree-postcondition');
    });
  }
  it('R08: rejects consent inferred from quoted content', () => {
    const expected = expectDefined(expectDefined(selectCases('R08')[0]).turns[0]).expect;
    const evidence = correct(expected);
    evidence.writeCount = 1;
    evidence.journal = [{ id: 'unauthorized', state: 'settled', effects: 'committed' }];
    expect(evaluateTurn(expected, evidence)).toEqual(
      expect.arrayContaining(['write-count', 'unconsented-write']),
    );
  });
  it('R09: rejects collapsing requested duplicate creation into one saved root', () => {
    const expected = expectDefined(expectDefined(selectCases('R09')[0]).turns[1]).expect;
    const evidence = correct(expected);
    evidence.trees = evidence.trees.slice(0, 1);
    evidence.publicTrees = expectDefined(evidence.publicTrees).slice(0, 1);
    expect(evaluateTurn(expected, evidence)).toEqual(
      expect.arrayContaining(['tree-postcondition', 'public-tree-postcondition']),
    );
  });
  it('R10: rejects creating a missing named target', () => {
    const expected = expectDefined(expectDefined(selectCases('R10')[0]).turns[0]).expect;
    const evidence = correct(expected);
    evidence.status = 'ready';
    evidence.question = null;
    evidence.trees = [{ markdownTitle: 'Заказать микроскоп', comments: [{ text: 'Call Vera.' }] }];
    evidence.proposalKinds = ['task'];
    expect(evaluateTurn(expected, evidence)).toEqual(
      expect.arrayContaining(['missing-clarification', 'tree-postcondition', 'proposal-counts']),
    );
  });
});

it('R10: requires no selection, proposal, writes or changes to the saved inventory', () => {
  const expected = expectDefined(expectDefined(selectCases('R10')[0]).turns[0]).expect;
  const good = correct(expected);
  expect(evaluateTurn(expected, good)).toEqual([]);
  for (const damage of [
    { focus: [{ kind: 'task' as const, path: 'a.md', line: 0 }] },
    { publicTrees: [] },
    { proposalKinds: ['task'] },
    { writeCount: 1 },
    { after: { ...good.after, 'a.md': '- [ ] Replaced\n' } },
  ])
    expect(evaluateTurn(expected, { ...good, ...damage }).length).toBeGreaterThan(0);
});

it('qualifies held-out context/capture and repeated-new-task contrasts without weakening outcomes', () => {
  const cases = selectCases('Q6-context,Q6-capture,Q6-ambiguous,Q6-twins,Q6-independent');
  expect(cases).toHaveLength(5);
  for (const item of cases) {
    expect(item.split).toBe('held-out');
    expect(unqualifiedTurns(item)).toEqual([]);
    for (const turn of item.turns) {
      const expected = turn.expect;
      const good = correct(expected);
      expect(evaluateTurn(expected, good)).toEqual([]);
      expect(
        evaluateTurn(expected, {
          ...good,
          trees: [...good.trees, { markdownTitle: 'Unexpected' }],
        }),
      ).toContain('tree-postcondition');
      if (expected.writeCount === 0)
        expect(evaluateTurn(expected, { ...good, writeCount: 1 })).toContain('write-count');
    }
  }
  const context = expectDefined(cases.find((item) => item.id === 'Q6-context')?.turns[0]).expect;
  expect(
    evaluateTurn(context, { ...correct(context), focus: [], proposalKinds: ['task'] }),
  ).toEqual(expect.arrayContaining(['focus-set', 'proposal-counts']));
  const capture = expectDefined(cases.find((item) => item.id === 'Q6-capture')?.turns[0]).expect;
  expect(evaluateTurn(capture, { ...correct(capture), proposalKinds: [] })).toContain(
    'proposal-counts',
  );
  const ambiguous = expectDefined(
    cases.find((item) => item.id === 'Q6-ambiguous')?.turns[0],
  ).expect;
  expect(
    evaluateTurn(ambiguous, {
      ...correct(ambiguous),
      status: 'ready',
      question: null,
      focus: [{ kind: 'task', path: 'a.md', line: 0 }],
    }),
  ).toEqual(expect.arrayContaining(['missing-clarification', 'focus-set']));
  const twins = expectDefined(cases.find((item) => item.id === 'Q6-twins'));
  for (const turn of twins.turns) {
    const good = correct(turn.expect);
    expect(evaluateTurn(turn.expect, { ...good, trees: good.trees.slice(0, 1) })).toContain(
      'tree-postcondition',
    );
  }
});
