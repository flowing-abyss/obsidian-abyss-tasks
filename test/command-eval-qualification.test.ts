import { expect, it } from 'vitest';
import { evaluateTurn, type TurnEvidence, type TurnExpectation } from './command-live/oracles';
import { hasSourceDestination } from './command-live/sourceOracle';
import { expectDefined } from './helpers';
const base = (): TurnEvidence => ({
  status: 'ready',
  question: null,
  trees: [],
  before: { 'control.md': 'exact\r\n' },
  after: { 'control.md': 'exact\r\n' },
  journal: [],
  admissions: [],
  complete: true,
});
it('rejects missing/extra focus and proposals and a mismatched status source basis', () => {
  const expectTurn: TurnExpectation = {
    status: 'ready',
    focus: [{ kind: 'task', path: 'a.md', line: 2 }],
    proposalKinds: ['status'],
    statusPlans: [{ path: 'a.md', line: 2, symbol: 'x' }],
    publicTrees: [{ markdownTitle: 'Same', recurrence: 'every week on Wednesday' }],
  };
  const good: TurnEvidence = {
    ...base(),
    focus: [{ kind: 'task', path: 'a.md', line: 2 }],
    proposalKinds: ['status'],
    statusPlans: [{ path: 'a.md', line: 2, symbol: 'x', basisValid: true }],
    publicTrees: [{ markdownTitle: 'Same', recurrence: 'every week on Wednesday' }],
  };
  expect(evaluateTurn(expectTurn, good)).toEqual([]);
  for (const damage of [
    { focus: [] },
    { focus: [...(good.focus ?? []), { kind: 'task' as const, path: 'a.md', line: 1 }] },
    { proposalKinds: [] },
    { proposalKinds: ['status', 'task'] },
    { statusPlans: [{ path: 'a.md', line: 2, symbol: 'x', basisValid: false }] },
    { statusPlans: [{ path: 'a.md', line: 1, symbol: 'x', basisValid: true }] },
    { publicTrees: [] },
  ])
    expect(evaluateTurn(expectTurn, { ...good, ...damage }).length).toBeGreaterThan(0);
});
it('requires a fresh research result and a language-independent structured fact with exact source and note path', () => {
  const expected: TurnExpectation = {
    status: 'ready',
    researchCalls: 1,
    researchSource: 'https://example.org/evidence',
    trees: [
      { durationMinutes: 45, comments: [{ text: { sourceText: 'https://example.org/evidence' } }] },
    ],
    proposalKinds: ['task', 'note'],
    noteFacts: [
      { path: 'Evidence.md', line: 'durationMinutes: 45', source: 'https://example.org/evidence' },
    ],
  };
  for (const prose of ['Вывод: вариант A. ', 'Finding: option A. ']) {
    const good: TurnEvidence = {
      ...base(),
      research: [{ invocation: 2, query: 'A', sources: ['https://example.org/evidence'] }],
      trees: [
        { durationMinutes: 45, comments: [{ text: `${prose}https://example.org/evidence` }] },
      ],
      proposalKinds: ['task', 'note'],
      notePlans: [
        {
          path: 'Evidence.md',
          text: `${prose}\ndurationMinutes: 45\nhttps://example.org/evidence`,
        },
      ],
    };
    expect(evaluateTurn(expected, good)).toEqual([]);
    for (const damage of [
      { research: [] },
      { research: [{ invocation: 1, query: 'A', sources: ['https://wrong.test'] }] },
      { trees: [{ durationMinutes: 145, comments: [{ text: prose }] }] },
      {
        notePlans: [
          { path: 'Other.md', text: 'durationMinutes: 45\nhttps://example.org/evidence' },
        ],
      },
      {
        notePlans: [
          { path: 'Evidence.md', text: 'durationMinutes: 145\nhttps://example.org/evidence' },
        ],
      },
      { proposalKinds: ['task', 'note', 'note'] },
    ])
      expect(evaluateTurn(expected, { ...good, ...damage }).length).toBeGreaterThan(0);
  }
});
it.each([false, true])(
  'preserves nested dated comments and tracked history across renewed capabilities=%s',
  (renewed) => {
    const before = {
      target: 'root',
      children: [
        {
          target: 'child',
          comments: [
            { target: 'old', parentTarget: 'child', text: 'Read', timestamp: '2026-11-10T10:00' },
          ],
          timeEntries: [{ start: '2026-11-10T09:00', end: '2026-11-10T09:45' }],
        },
      ],
    };
    const after = structuredClone(before);
    expectDefined(expectDefined(after.children[0]).comments[0]).text = 'Study';
    if (renewed) expectDefined(expectDefined(after.children[0]).comments[0]).target = 'new';
    const pair = {
      before,
      after,
      requested: { children: [{ comments: [{ text: 'Study' }] }] },
      commentContinuity: renewed
        ? [{ before: 'old', after: 'new', ownerBefore: 'child', ownerAfter: 'child' }]
        : [],
    };
    expect(evaluateTurn({ status: 'ready' }, { ...base(), preservation: [pair] })).toEqual([]);
    const bad = structuredClone(pair);
    expectDefined(expectDefined(bad.after.children[0]).comments[0]).timestamp = '2026-11-11T10:00';
    expect(evaluateTurn({ status: 'ready' }, { ...base(), preservation: [bad] })).toContain(
      'preservation:comment-timestamp',
    );
    const time = structuredClone(pair);
    expectDefined(expectDefined(time.after.children[0]).timeEntries[0]).end = '2026-11-10T10:45';
    expect(evaluateTurn({ status: 'ready' }, { ...base(), preservation: [time] })).toContain(
      'preservation:timeEntries',
    );
    if (renewed)
      expect(
        evaluateTurn(
          { status: 'ready' },
          { ...base(), preservation: [{ ...pair, commentContinuity: [] }] },
        ),
      ).toContain('preservation:comment-correspondence');
  },
);

it('requires concrete contracts for every authored action and retained pipeline', async () => {
  const { actions, pipelines, unqualifiedTurns } = await import('./command-live/corpus');
  expect(actions).toHaveLength(100);
  expect(pipelines).toHaveLength(12);
  expect(
    [...actions, ...pipelines].flatMap((test) =>
      unqualifiedTurns(test).map((turn) => `${test.id}:${turn}`),
    ),
  ).toEqual([]);
});

it('accepts independent root permutation while rejecting duplicates and child reordering', () => {
  const a = { markdownTitle: 'A', children: [{ markdownTitle: 'One' }, { markdownTitle: 'Two' }] };
  const b = { markdownTitle: 'B', children: [] };
  const expected: TurnExpectation = { status: 'ready', trees: [a, b] };
  expect(evaluateTurn(expected, { ...base(), trees: [b, a] })).toEqual([]);
  expect(evaluateTurn(expected, { ...base(), trees: [a, a] })).toContain('tree-postcondition');
  expect(
    evaluateTurn(expected, {
      ...base(),
      trees: [{ ...a, children: [...a.children].reverse() }, b],
    }),
  ).toContain('tree-postcondition');
});

it('rejects a replacement root despite identical authored text when continuation is required', () => {
  expect(
    evaluateTurn(
      { status: 'ready', trees: [{ markdownTitle: 'Root' }], retainPreviousTasks: true },
      { ...base(), trees: [{ markdownTitle: 'Root' }], previousTaskContinuity: false },
    ),
  ).toContain('preservation:task-correspondence');
});

it.each([
  '![picture](https://example.org/evidence)',
  '`https://example.org/evidence`',
  'https://example.org/evidence-wrong',
  'https://example.org/evidence/extra',
  'https://example.org/evidence?wrong=1',
  'https://example.org/evidence#wrong',
  'https://wrong.test/https://example.org/evidence',
  '[https://example.org/evidence](https://wrong.test)',
  '[https://example.org/evidence](https://example.org/evidence-wrong)',
])('rejects deceptive research source destinations: %s', (source) => {
  const expected: TurnExpectation = {
    status: 'ready',
    trees: [{ comments: [{ text: { sourceText: 'https://example.org/evidence' } }] }],
    noteFacts: [
      { path: 'Evidence.md', line: 'durationMinutes: 45', source: 'https://example.org/evidence' },
    ],
  };
  const failures = evaluateTurn(expected, {
    ...base(),
    trees: [{ comments: [{ text: `Вывод: ${source}` }] }],
    notePlans: [{ path: 'Evidence.md', text: `durationMinutes: 45\n${source}` }],
  });
  expect(failures).toContain('tree-postcondition');
  expect(failures).toContain('note-fact:Evidence.md');
});
it.each([
  'https://example.org/evidence',
  '<https://example.org/evidence>',
  '(https://example.org/evidence)',
  '[Источник](https://example.org/evidence)',
  '[Source](https://example.org/evidence "Evidence")',
])('accepts complete exact research destinations: %s', (source) => {
  expect(
    evaluateTurn(
      {
        status: 'ready',
        trees: [{ comments: [{ text: { sourceText: 'https://example.org/evidence' } }] }],
      },
      { ...base(), trees: [{ comments: [{ text: `Вывод: ${source}.` }] }] },
    ),
  ).toEqual([]);
});

it('preserves balanced parentheses that belong to exact bare destinations', () => {
  expect(
    hasSourceDestination('Finding (https://example.org/a_(b)).', 'https://example.org/a_(b)'),
  ).toBe(true);
  expect(hasSourceDestination('https://example.org/a_(b)-wrong', 'https://example.org/a_(b)')).toBe(
    false,
  );
});
