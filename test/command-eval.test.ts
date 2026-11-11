import { expect, it } from 'vitest';
import { evaluateTurn } from './command-live/oracles';
import { RequestBudget, guardRoute, validateOptions } from './command-live/safety';
import { expectDefined } from './helpers';

const expected = {
  status: 'ready' as const,
  trees: [
    {
      markdownTitle: 'Gym',
      dates: { scheduled: '2026-11-11' },
      time: '10:00',
      recurrence: 'every week on Wednesday',
      children: [{ markdownTitle: 'Bag' }],
      comments: [{ text: 'keep' }],
    },
  ],
};
const evidence = () => ({
  status: 'ready',
  question: null,
  trees: structuredClone(expected.trees),
  before: { 'control.md': 'control\r\n' },
  after: { 'control.md': 'control\r\n' },
  journal: [],
  admissions: [],
  complete: true,
});
it('rejects literal semantic, preservation and receipt negative controls', () => {
  expect(evaluateTurn(expected, evidence())).toEqual([]);
  const mutations = [
    (e: ReturnType<typeof evidence>) => {
      expectDefined(e.trees[0]).dates.scheduled = '2026-11-12';
    },
    (e: ReturnType<typeof evidence>) => {
      expectDefined(e.trees[0]).time = '11:00';
    },
    (e: ReturnType<typeof evidence>) => {
      expectDefined(e.trees[0]).recurrence = 'every week on Friday';
    },
    (e: ReturnType<typeof evidence>) => {
      expectDefined(e.trees[0]).children = [];
    },
    (e: ReturnType<typeof evidence>) => {
      expectDefined(e.trees[0]).comments = [];
    },
    (e: ReturnType<typeof evidence>) => {
      e.after['control.md'] = 'control\n';
    },
    (e: ReturnType<typeof evidence>) => {
      e.complete = false;
    },
  ];
  for (const mutate of mutations) {
    const e = evidence();
    mutate(e);
    expect(evaluateTurn(expected, e).length).toBeGreaterThan(0);
  }
  expect(
    evaluateTurn({ ...expected, status: 'saved' }, { ...evidence(), status: 'saved' }),
  ).toContain('saved-without-committed-receipt');
});
it('blocks nonzero catalog prices, model fallback and physical requests beyond the cap', () => {
  expect(() =>
    validateOptions({ provider: 'openai', model: 'paid', maxRequests: 1, allowPaid: false }),
  ).toThrow();
  const options = validateOptions({
    provider: 'openrouter',
    model: 'google/gemma-4-31b-it:free',
    maxRequests: 1,
    allowPaid: false,
  });
  expect(() => guardRoute(options, { model: options.model, models: ['paid'] })).toThrow();
  expect(() => guardRoute(options, { model: 'paid' })).toThrow();
  expect(guardRoute(options, { model: options.model })['provider']).toMatchObject({
    require_parameters: true,
    allow_fallbacks: false,
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
  const budget = new RequestBudget(1);
  budget.dispatch();
  expect(() => {
    budget.dispatch();
  }).toThrow('request-budget');
  expect(budget.used).toBe(1);
});
it('rejects erased unrequested metadata and changed retained comment timestamp', () => {
  const e = evidence();
  const before = {
    markdownTitle: 'Original',
    description: 'Keep URL https://example.org',
    tags: ['work'],
    dates: { due: '2026-11-20' },
    children: [],
    comments: [
      {
        target: 'comment-1',
        text: 'Original',
        timestamp: { precision: 'day', value: '2026-11-01' },
      },
    ],
  };
  const after = { ...before, markdownTitle: 'Renamed' };
  const base = { ...e, preservation: [{ before, after, requested: { markdownTitle: 'Renamed' } }] };
  expect(evaluateTurn(expected, base)).toEqual([]);
  expect(
    evaluateTurn(expected, {
      ...base,
      preservation: [
        {
          before,
          after: { ...after, description: undefined },
          requested: { markdownTitle: 'Renamed' },
        },
      ],
    }),
  ).toContain('preservation:description');
  expect(
    evaluateTurn(expected, {
      ...base,
      preservation: [
        {
          before,
          after: {
            ...after,
            comments: [
              {
                target: 'comment-1',
                text: 'Edited',
                timestamp: { precision: 'day', value: '2026-11-02' },
              },
            ],
          },
          requested: { markdownTitle: 'Renamed', comments: [{ text: 'Edited' }] },
        },
      ],
    }),
  ).toContain('preservation:comment-timestamp');
});
it('paces physical starts across cases and rejects nonzero catalog prices', async () => {
  const { RequestPacer, assertFreeCatalog } = await import('./command-live/safety');
  let time = 0;
  const waits: number[] = [];
  const pacer = new RequestPacer(
    3100,
    () => time,
    async (ms) => {
      waits.push(ms);
      time += ms;
    },
  );
  await pacer.wait();
  await pacer.wait();
  await pacer.wait();
  expect(waits).toEqual([3100, 3100]);
  const catalog = (prompt: string) => ({
    data: [
      {
        id: 'free',
        pricing: { prompt, completion: '0', request: '0' },
        supported_parameters: ['tools', 'tool_choice'],
      },
    ],
  });
  expect(() => {
    assertFreeCatalog('free', catalog('0'));
  }).not.toThrow();
  expect(() => {
    assertFreeCatalog('free', catalog('0.0001'));
  }).toThrow('free-catalog-rejected');
});
it('requires literal evidence of the requested note section and project plan', () => {
  const base = evidence();
  const expectation = {
    ...expected,
    observations: [
      { kind: 'note' as const, path: 'Vera.md', text: 'Call 555-0100.', subpath: 'Phone' },
    ],
    projectChanges: [
      {
        kind: 'project',
        path: 'projects/Launch.md',
        fields: [{ fieldId: 'start', value: '2026-11-11' }],
      },
    ],
  };
  expect(evaluateTurn(expectation, { ...base, observations: [], projectChanges: [] })).toContain(
    'missing-observation:Vera.md',
  );
  expect(
    evaluateTurn(expectation, {
      ...base,
      observations: [
        {
          kind: 'note' as const,
          path: 'Vera.md',
          text: 'Call 555-0100.',
          subpath: 'Phone',
          complete: true,
          focused: false,
        },
      ],
      projectChanges: [
        {
          kind: 'project',
          path: 'projects/Launch.md',
          fields: [{ fieldId: 'start', value: '2026-11-11' }],
        },
      ],
    }),
  ).toEqual([]);
});
it('allows authored gym subject variants but rejects invented priority, dates and a different subject', async () => {
  const { reproductions } = await import('./command-live/corpus');
  const expectation = expectDefined(
    expectDefined(reproductions.find((test) => test.id === 'gym_short')).turns[0],
  ).expect;
  const want = expectDefined(expectation.trees?.[0]) as Record<string, unknown>;
  const actual = { ...want, markdownTitle: 'Тренировка в зале' };
  expect(evaluateTurn(expectation, { ...evidence(), trees: [actual] })).toEqual([]);
  for (const delta of [
    { markdownTitle: 'Гимназия' },
    { priority: 'C' },
    { dates: { scheduled: '2026-11-11', due: '2026-11-11' } },
    { dates: { scheduled: '2026-11-11', start: '2026-11-11' } },
  ])
    expect(
      evaluateTurn(expectation, { ...evidence(), trees: [{ ...actual, ...delta }] }),
    ).toContain('tree-postcondition');
});
