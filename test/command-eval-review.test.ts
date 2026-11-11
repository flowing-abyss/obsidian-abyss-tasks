import { expect, it } from 'vitest';
import { actions } from './command-live/corpus';
import { liveRequest } from './command-live/harness';
import { evaluateTurn, type TurnEvidence } from './command-live/oracles';
import { RequestBudget, assertFreeCatalog, type EvalOptions } from './command-live/safety';
import { expectDefined } from './helpers';
const options: EvalOptions = {
  provider: 'openrouter',
  model: 'google/gemma-4-31b-it:free',
  allowPaid: false,
  maxRequests: 3,
};
const root = (title: string, fields: Record<string, unknown> = {}) => ({
  markdownTitle: title,
  priority: 'D',
  dates: {},
  tags: [],
  statusSymbol: ' ',
  onCompletion: 'keep',
  onCompletionExplicit: false,
  children: [],
  comments: [],
  ...fields,
});
const turn = (id: string, index: number) =>
  expectDefined(expectDefined(actions.find((test) => test.id === id)).turns[index]).expect;
function evidence(
  status: 'ready' | 'saved',
  trees: readonly unknown[],
  before: Record<string, string>,
  after = before,
): TurnEvidence {
  return {
    status,
    trees,
    question: null,
    before,
    after,
    complete: true,
    journal:
      status === 'saved'
        ? [{ id: 'write', state: 'settled', effects: 'committed', receipt: {} }]
        : [],
    admissions: [{ id: 'write', state: 'admitted' }],
  };
}
it('requires the exact linked note on its requested task owner at every ready and saved stage', () => {
  const before = { 'a.md': '- [ ] Root\n' };
  const withLink = root('Root', { description: '[[Evidence]]' });
  const preview = {
    ...evidence('ready', [withLink], before),
    notePlans: [{ path: 'Evidence.md', text: 'First' }],
  };
  expect(evaluateTurn(turn('084', 0), preview)).toEqual([]);
  expect(
    evaluateTurn(turn('084', 0), { ...preview, trees: [root('Root')] }).length,
  ).toBeGreaterThan(0);
  expect(
    evaluateTurn(turn('084', 1), {
      ...preview,
      notePlans: [{ path: 'Evidence.md', text: 'Second' }],
    }),
  ).toEqual([]);
  const after = { 'a.md': '- [ ] Root\n  - > [[Evidence]]\n', 'Evidence.md': 'Second' };
  expect(evaluateTurn(turn('084', 2), evidence('saved', [withLink], before, after))).toEqual([]);
  expect(
    evaluateTurn(
      turn('084', 2),
      evidence('saved', [root('Root')], before, { ...after, 'a.md': before['a.md'] }),
    ).length,
  ).toBeGreaterThan(0);
  const childBefore = { 'a.md': '- [ ] Root\n  - [ ] Child A\n  - [ ] Child B\n' };
  const correct = root('Root', {
    children: [root('Child A'), root('Child B', { comments: [{ text: '[[Evidence]]' }] })],
  });
  const wrong = root('Root', {
    children: [root('Child A', { comments: [{ text: '[[Evidence]]' }] }), root('Child B')],
  });
  const child = {
    ...evidence('ready', [correct], childBefore),
    notePlans: [{ path: 'Evidence.md', text: 'One finding' }],
  };
  expect(evaluateTurn(turn('083', 0), child)).toEqual([]);
  expect(evaluateTurn(turn('083', 0), { ...child, trees: [wrong] }).length).toBeGreaterThan(0);
  expect(
    evaluateTurn(turn('083', 0), {
      ...child,
      trees: [
        root('Root', {
          children: [
            root('Child A'),
            root('Child B', { comments: [{ text: '[[Evidence Wrong]]' }] }),
          ],
        }),
      ],
    }).length,
  ).toBeGreaterThan(0);
});
it('accepts source-preserving copies with separate preview and saved inventories and rejects moves', () => {
  const source = '- [ ] Root\n  - [ ] Child A\n  - [ ] Child B\n';
  const children = [root('Child A'), root('Child B')];
  const original = root('Root', { source: { path: 'a.md', line: 0 }, children });
  const copied = root('Root', { source: { path: 'b.md', line: 1 }, children });
  const before = { 'a.md': source, 'b.md': '# Copies\n' };
  expect(
    evaluateTurn(turn('045', 0), evidence('ready', [root('Root', { children })], before)),
  ).toEqual([]);
  const after = { ...before, 'b.md': `# Copies\n${source}` };
  expect(
    evaluateTurn(turn('045', 1), evidence('saved', [original, copied], before, after)),
  ).toEqual([]);
  expect(
    evaluateTurn(turn('045', 1), evidence('saved', [copied], before, { ...after, 'a.md': '' }))
      .length,
  ).toBeGreaterThan(0);
  const comments = [{ text: 'Source comment' }];
  const commentBefore = { 'a.md': '- [ ] Root\n  - Source comment\n- [ ] Other\n' };
  expect(
    evaluateTurn(turn('035', 0), {
      ...evidence('ready', [root('Other', { comments })], commentBefore),
      taskSources: [{ path: 'a.md', line: 2, kind: 'edit', basisValid: true }],
      proposalKinds: ['task'],
      freshPreparation: true,
      writeCount: 0,
    }),
  ).toEqual([]);
  expect(
    evaluateTurn(
      turn('035', 1),
      evidence(
        'saved',
        [
          root('Root', { source: { path: 'a.md', line: 0 }, comments }),
          root('Other', { source: { path: 'a.md', line: 2 }, comments }),
        ],
        commentBefore,
        { 'a.md': '- [ ] Root\n  - Source comment\n- [ ] Other\n  - Source comment\n' },
      ),
    ),
  ).toEqual([]);
});
it('accepts omitted optional request pricing but rejects explicit malformed/nonzero prices', () => {
  const catalog = (pricing: unknown) => ({
    data: [{ id: options.model, pricing, supported_parameters: ['tools', 'tool_choice'] }],
  });
  expect(() => {
    assertFreeCatalog(options.model, catalog({ prompt: '0', completion: '0' }));
  }).not.toThrow();
  for (const request of ['0.001', '', ' ', null, 0, false, '0x0', 'NaN'])
    expect(() => {
      assertFreeCatalog(options.model, catalog({ prompt: '0', completion: '0', request }));
    }).toThrow();
});
it('retains safe transport rejection evidence and counts the failed attempted dispatch', async () => {
  const trace: Array<{ kind: string; data: unknown }> = [];
  const budget = new RequestBudget(3);
  const request = liveRequest(
    {
      options,
      budget,
      key: 'DO_NOT_RECORD',
      fetch: async () => {
        throw new Error('DO_NOT_RECORD raw provider error');
      },
    },
    (kind, data) => {
      trace.push({ kind, data });
    },
  );
  await expect(
    request({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      body: JSON.stringify({ model: options.model }),
      headers: { Authorization: 'DO_NOT_RECORD' },
    }),
  ).rejects.toThrow();
  expect(budget.used).toBe(1);
  expect(trace).toContainEqual({ kind: 'http-dispatch', data: { request: 1 } });
  expect(trace).toContainEqual({
    kind: 'http-failure',
    data: { request: 1, phase: 'completion-fetch', code: 'transport-rejected' },
  });
  expect(JSON.stringify(trace)).not.toContain('DO_NOT_RECORD');
});
it('retains typed safe catalog diagnostics for rejected, HTTP, body and price failures', async () => {
  const { readFreeCatalog } = await import('./command-live/providerBoundary');
  const { EvalBoundaryFailure, diagnosticOutcome } = await import('./command-live/diagnostics');
  const attempts: Array<{ fetch: typeof window.fetch; diagnostic: unknown }> = [
    {
      fetch: async () => {
        throw new Error('PRIVATE body/key/header');
      },
      diagnostic: { phase: 'catalog-fetch', code: 'transport-rejected' },
    },
    {
      fetch: async () => new Response('PRIVATE response body', { status: 429 }),
      diagnostic: { phase: 'catalog-response', code: 'rate-limited', status: 429 },
    },
    {
      fetch: async () => new Response('PRIVATE invalid JSON'),
      diagnostic: { phase: 'catalog-body', code: 'invalid-json', status: 200 },
    },
    {
      fetch: async () =>
        Response.json({
          data: [
            {
              id: options.model,
              pricing: { prompt: '1', completion: '0' },
              supported_parameters: ['tools', 'tool_choice'],
            },
          ],
        }),
      diagnostic: { phase: 'catalog-validation', code: 'price-invalid' },
    },
  ];
  for (const attempt of attempts) {
    const budget = new RequestBudget(3);
    const failed = await readFreeCatalog(options, budget, attempt.fetch).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(EvalBoundaryFailure);
    expect((failed as InstanceType<typeof EvalBoundaryFailure>).diagnostic).toEqual(
      attempt.diagnostic,
    );
    expect(diagnosticOutcome((failed as InstanceType<typeof EvalBoundaryFailure>).diagnostic)).toBe(
      (failed as InstanceType<typeof EvalBoundaryFailure>).diagnostic.phase === 'catalog-validation'
        ? 'unavailable'
        : 'provider-failure',
    );
    expect(budget.used).toBe(1);
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
  }
});
it('counts rejected response-body dispatches as attempts with unknown usage and cost', async () => {
  const { summarizeCompletionRequests } = await import('./command-live/diagnostics');
  const events: Array<{ kind: string; data: unknown }> = [];
  const response = new Response('{}');
  response.arrayBuffer = async () => {
    throw new Error('PRIVATE response failure');
  };
  const budget = new RequestBudget(3);
  const request = liveRequest(
    { options, budget, key: 'unused', fetch: async () => response },
    (kind, data) => {
      events.push({ kind, data });
    },
  );
  await expect(
    request({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      body: JSON.stringify({ model: options.model }),
    }),
  ).rejects.toThrow();
  expect(events).toContainEqual({
    kind: 'http-failure',
    data: { request: 1, phase: 'completion-body', code: 'body-read-rejected', status: 200 },
  });
  expect(summarizeCompletionRequests(events)).toEqual({
    providerCompletionRequests: 1,
    knownTokens: 0,
    unknownUsageRequests: 1,
    knownCost: 0,
    unknownCostRequests: 1,
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
it('classifies real-agent transport rejection as provider failure rather than model failure', async () => {
  const { runCase } = await import('./command-live/harness');
  const { summarizeCompletionRequests } = await import('./command-live/diagnostics');
  const budget = new RequestBudget(20);
  const report = await runCase(
    {
      id: 'transport-reject',
      family: 'controls',
      split: 'development',
      files: { 'a.md': '' },
      turns: [{ text: 'Draft Root', expect: { status: 'ready', trees: [root('Root')] } }],
    },
    {
      options: { ...options, maxRequests: 20 },
      budget,
      key: 'synthetic',
      fetch: async () => {
        throw new Error('PRIVATE provider failure');
      },
    },
    async () => {},
  );
  expect(report.outcome).toBe('provider-failure');
  expect(report.physicalRequests).toBeGreaterThan(0);
  const totals = summarizeCompletionRequests(report.trace);
  expect(totals.providerCompletionRequests).toBe(report.physicalRequests);
  expect(totals.unknownUsageRequests).toBe(report.physicalRequests);
  expect(totals.unknownCostRequests).toBe(report.physicalRequests);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});
it('accepts authorized 084 carriers with real-shaped preservation pairs and rejects lost existing content', () => {
  const expected = turn('084', 0);
  const before = root('Root');
  const file = { 'a.md': '- [ ] Root\n' };
  const check = (prior: unknown, after: unknown, contract = expected) =>
    evaluateTurn(contract, {
      ...evidence('ready', [after], file),
      notePlans: [{ path: 'Evidence.md', text: 'First' }],
      preservation: [{ before: prior, after, requested: expectDefined(contract.trees?.[0]) }],
    });
  for (const after of [
    root('Root', { description: '[[Evidence]]' }),
    root('Root [[Evidence]]'),
    root('Root', { comments: [{ target: 'new-comment', text: '[[Evidence]]' }] }),
  ])
    expect(check(before, after)).toEqual([]);
  const originalComments = [
    {
      target: 'original-comment',
      text: 'Keep original',
      timestamp: { precision: 'day', value: '2026-11-01' },
    },
  ];
  const retained = {
    ...expected,
    trees: [
      {
        ...(expectDefined(expected.trees?.[0]) as Record<string, unknown>),
        description: {
          linkCarrier: { notePath: 'Evidence.md', original: 'Keep https://example.org' },
        },
        comments: { linkCarrier: { notePath: 'Evidence.md', original: originalComments } },
      },
    ],
  };
  expect(
    check(
      root('Root', { description: 'Keep https://example.org', comments: originalComments }),
      root('Root', {
        description: 'Keep https://example.org\n[[Evidence]]',
        comments: originalComments,
      }),
      retained,
    ),
  ).toEqual([]);
  expect(
    check(
      root('Root', { description: 'Keep https://example.org' }),
      root('Root', { description: '[[Evidence]]' }),
    ),
  ).toContain('preservation:description');
  expect(
    check(
      root('Root', { comments: [{ target: 'original-comment', text: 'Keep existing comment' }] }),
      root('Root', { comments: [{ target: 'new-comment', text: '[[Evidence]]' }] }),
    ),
  ).toContain('preservation:comments');
});

it.each([429, '429'])(
  'records only safe numeric HTTP-200 provider error codes (%s)',
  async (code) => {
    const trace: Array<{ kind: string; data: unknown }> = [];
    const request = liveRequest(
      {
        options,
        budget: new RequestBudget(3),
        key: 'PRIVATE',
        fetch: async () =>
          Response.json({
            error: { code, message: 'PRIVATE reasoning body', metadata: { headers: 'PRIVATE' } },
          }),
      },
      (kind, data) => {
        trace.push({ kind, data });
      },
    );
    await request({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      body: JSON.stringify({ model: options.model }),
    });
    const data = trace.find((event) => event.kind === 'http')?.data;
    expect(data).toMatchObject({ providerError: true, status: 200 });
    if (typeof code === 'number')
      expect(data).toHaveProperty('diagnostic', {
        phase: 'completion-response',
        code: 'rate-limited',
        status: 200,
        providerCode: 429,
      });
    else expect(data).not.toHaveProperty('diagnostic');
    expect(JSON.stringify(trace)).not.toContain('PRIVATE');
  },
);

it('rejects wrong Inbox membership even when the visible tree is otherwise correct', () => {
  const preview = { ...evidence('ready', [root('Gym')], { 'a.md': '' }), inboxMembers: [true] };
  const expected = { status: 'ready' as const, trees: [root('Gym')], inboxMembers: [true] };
  expect(evaluateTurn(expected, preview)).toEqual([]);
  expect(evaluateTurn(expected, { ...preview, inboxMembers: [false] })).toContain(
    'inbox-membership',
  );
});
