import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import { selectCases } from './command-live/corpus';
import { tree } from './command-live/fixtures';
import {
  evaluateTurn,
  requestedTree,
  type TurnEvidence,
  type TurnExpectation,
} from './command-live/oracles';
import { RequestBudget } from './command-live/safety';
import { runScriptedCase } from './command-live/scriptedCase';
import { semanticCases } from './command-live/semanticCases';
import { hasSourceDestination, hasSourceFacts } from './command-live/sourceOracle';
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
it('distinguishes the Atlas project note from its same-named folder decoy', () => {
  const candidate = expectDefined(
    semanticCases.find((test) => test.id === 'project-scope-task-en'),
  );
  const expected = expectDefined(candidate.turns[0]).expect;
  const files = candidate.files;
  const projectTree = tree('Review backup policy', {
    tags: ['#keep'],
    children: [tree('Verify the restore process')],
  });
  const folderTree = tree('Review backup policy', { children: [tree('Check archive notes')] });
  const correct: TurnEvidence = {
    ...base(),
    before: files,
    after: files,
    trees: [projectTree, folderTree],
    focus: [{ kind: 'task', path: 'projects/Atlas.md', line: 5 }],
    proposalKinds: [],
    writeCount: 0,
  };
  expect(evaluateTurn(expected, correct)).toEqual([]);

  const wrongFocus: TurnEvidence = {
    ...correct,
    focus: [{ kind: 'task', path: 'Atlas/Archive.md', line: 0 }],
  };
  const wrongFocusFailures = evaluateTurn(expected, wrongFocus);
  expect(wrongFocusFailures).toContain('focus-set');
  expect(wrongFocusFailures).not.toContain('tree-postcondition');
});
it('runs Atlas project scope through the real scripted command pipeline and vault inventory', async () => {
  const candidate = expectDefined(selectCases('project-scope-task-en')[0]);
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step++;
      if (step === 1) return commandResponse('interpret', { intent: 'plan' });
      if (step === 2)
        return commandResponse('expand', { capabilities: ['project', 'read', 'find', 'inspect'] });
      if (step === 3) return commandResponse('read', { input: { kind: 'projects' } });
      if (step === 4) {
        const project = expectDefined(latestJsonResult(prompt, 'read').items[0]);
        return commandResponse('read', {
          input: {
            kind: 'note',
            selector: { target: project.target, expectedRevision: project.revision },
          },
        });
      }
      if (step === 5)
        return commandResponse('find', {
          query: 'Review backup policy',
          path: 'projects/Atlas.md',
          showExact: true,
          purpose: 'show-only',
          matchScope: 'subtree',
        });
      const item = expectDefined(latestJsonResult(prompt, 'find').items[0]);
      return commandResponse('finish', {
        state: 'ready',
        selection: [{ kind: 'task', target: item.target, revision: item.revision }],
      });
    },
  });
  const report = await runScriptedCase(
    candidate,
    {
      options: { provider: 'openrouter', model: 'synthetic', allowPaid: false, maxRequests: 1 },
      budget: new RequestBudget(1),
      key: 'synthetic-not-a-key',
      fetch: async () => {
        throw new Error('No network');
      },
    },
    async () => {},
    model,
  );
  expect(report.outcome).toBe('passed');
  expect(report.physicalRequests).toBe(0);
  expect(report.turns[0]?.focus).toEqual([{ kind: 'task', path: 'projects/Atlas.md', line: 5 }]);
  expect(report.turns[0]?.trees).toHaveLength(2);
});
function commandResponse(name: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: `atlas-${name}`,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}
function latestJsonResult(
  prompt: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'],
  name: string,
): { items: Array<{ target: string; revision: string }> } {
  const result = prompt
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .find((part) => part.type === 'tool-result' && part.toolName === name);
  if (result?.type !== 'tool-result' || result.output.type !== 'json')
    throw new Error(`Missing ${name} result`);
  return result.output.value as { items: Array<{ target: string; revision: string }> };
}
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
  expect(actions).toHaveLength(104);
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

it('normalizes letter hyphens in source fact phrases without changing URL, numeric, or contradiction checks', () => {
  const facts = [['command line'], ['45']];
  for (const separator of ['-', '‐', '‑', '‒', '–', '—'])
    expect(hasSourceFacts(`offline command${separator}line manager for 45`, facts, [])).toBe(true);
  expect(hasSourceFacts('https://example.org/command-line-45', facts, [])).toBe(false);
  expect(hasSourceFacts('command-line manager for 145', facts, [])).toBe(false);
  expect(hasSourceFacts('offline command-line manager', [['offline']], ['not offline'])).toBe(true);
  expect(
    hasSourceFacts('offline command-line manager, but not offline', [['offline']], ['not offline']),
  ).toBe(false);
});

it('checks source-grounded cloud and team-editing absence claims across RU and EN phrasing', () => {
  const url = 'https://example.org/cloud-sync-team-editing';
  const expected: TurnExpectation = {
    status: 'ready',
    trees: [
      {
        comments: [
          {
            text: {
              sourceText: url,
              maxLength: 400,
              facts: [['Cairn']],
              absenceFacts: [
                [
                  ['облачн', 'синхронизац'],
                  ['синхронизац', 'облак'],
                  ['cloud', 'sync'],
                  ['cloud', 'synchronization'],
                ],
                [
                  ['совместн', 'командн', 'редактирован'],
                  ['совместн', 'редактирован'],
                  ['shared', 'team', 'edit'],
                  ['team', 'edit'],
                  ['collaborat'],
                ],
              ],
            },
          },
        ],
      },
    ],
  };
  const valid = [
    'Cairn. Облачной синхронизации и совместного командного редактирования нет.',
    'Cairn: нет облачной синхронизации и нет совместного командного редактирования.',
    'Cairn: совместного редактирования командой и синхронизации в облаке нет.',
    'Cairn. No cloud sync and no shared team editing.',
    'Cairn: cloud task synchronization is unavailable; shared team editing is unavailable.',
    'Cairn: cloud synchronization and team editing are unavailable.',
    'Cairn: no cloud synchronization; team editing is unsupported.',
    'Cairn: cloud sync is not provided and team editing is not included.',
    'Cairn: does not have cloud sync and does not include team editing.',
    'Cairn works without cloud sync and without team editing.',
    'Cairn: облачная синхронизация не доступна, а совместное командное редактирование не предусмотрено.',
    'Cairn: облачная синхронизация не поддерживается и совместное редактирование не поддерживается.',
  ];
  for (const claim of valid)
    expect(
      evaluateTurn(expected, {
        ...base(),
        trees: [{ comments: [{ text: `${claim} ${url}` }] }],
      }),
      claim,
    ).toEqual([]);

  const contrary = [
    'Cairn: cloud synchronization is supported, but team editing is unavailable.',
    'Cairn: cloud synchronization is supported but team editing is unavailable.',
    'Cairn: cloud sync is unavailable, but team editing is available.',
    'Cairn: no cloud sync is required, but team editing is unavailable.',
    'Cairn: no cloud sync is needed, but team editing is unavailable.',
    'Cairn: no need for cloud sync, but team editing is unavailable.',
    'Cairn: нет необходимости в облачной синхронизации, но совместное командное редактирование недоступно.',
    'Cairn: облачная синхронизация не требуется, а совместное командное редактирование недоступно.',
    'Cairn: облачная синхронизация поддерживается, но совместного командного редактирования нет.',
    'Cairn: облачной синхронизации нет, а совместное командное редактирование доступно.',
    'Cairn: облачной синхронизации нет а совместное командное редактирование доступно.',
    'Cairn offers not only cloud sync, but no team editing.',
    'Cairn: cloud sync is not unavailable; team editing is not unsupported.',
    'Cairn: облачной синхронизации не отсутствует; совместного командного редактирования не отсутствует.',
    `Cairn ${url}`,
  ];
  for (const claim of contrary)
    expect(
      evaluateTurn(expected, {
        ...base(),
        trees: [{ comments: [{ text: `${claim} ${url}` }] }],
      }),
      claim,
    ).toContain('tree-postcondition');
});

it('keeps expected comment changes classified as requested when their text fails its oracle', () => {
  const expected: TurnExpectation = {
    status: 'ready',
    trees: [{ markdownTitle: 'Task', tags: [], comments: [{ text: { includes: 'requested' } }] }],
  };
  const actual = {
    markdownTitle: 'Task',
    tags: [],
    comments: [{ text: 'wrong content' }],
  };
  const requested = requestedTree(expected, actual);
  const failures = evaluateTurn(expected, {
    ...base(),
    trees: [actual],
    preservation: [
      {
        before: { markdownTitle: 'Task', tags: [], comments: [] },
        after: actual,
        requested,
      },
    ],
  });
  expect(failures).toContain('tree-postcondition');
  expect(failures).not.toContain('preservation:comments');
});
