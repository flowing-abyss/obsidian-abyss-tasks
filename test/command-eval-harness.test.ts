import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import type { TaskTreeV1 } from '../api';
import { submittedMessage } from './command-live/controls';
import { selectCases } from './command-live/corpus';
import { RequestBudget } from './command-live/safety';
import { runScriptedCase as runCase } from './command-live/scriptedCase';
import { expectDefined } from './helpers';
function response(name: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'call',
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

function qualificationSelection(
  prompt: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'],
  select: boolean,
) {
  const part = prompt
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .find((part) => part.type === 'tool-result' && part.toolName === 'find');
  if (part?.type !== 'tool-result' || part.output.type !== 'json') throw Error('Missing discovery');
  const value = part.output.value as {
    items: Array<{ target: string; revision: string }>;
    evidence: string;
  };
  const node = expectDefined(value.items[0]);
  return select
    ? response('finish', {
        state: 'ready',
        message: 'Selected.',
        selection: [{ kind: 'task', target: node.target, revision: node.revision }],
      })
    : response('finish', {
        state: 'question',
        message: 'Which task?',
        blockingIssue: { kind: 'ambiguous', evidence: value.evidence },
      });
}
function qualificationTitles(id: string): string[] {
  if (id === 'Q6-capture') return ['Проверить фильтр'];
  return id === 'Q6-twins'
    ? ['Позвонить мастеру', 'Позвонить мастеру']
    : ['Купить кабель', 'Проверить насос'];
}
it.each(['Q6-context', 'Q6-capture', 'Q6-ambiguous', 'Q6-twins', 'Q6-independent'])(
  'executes the held-out %s oracle with canonical scripted tools and no network',
  async (id) => {
    const item = expectDefined(selectCases(id)[0]);
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        step++;
        if (id === 'Q6-context' || id === 'Q6-ambiguous') {
          if (step === 1) return response('find', { query: 'Проверить фильтр' });
          return qualificationSelection(prompt, id === 'Q6-context');
        }
        const titles = qualificationTitles(id);
        if (step <= titles.length)
          return response('create_task', { tree: { markdownTitle: titles[step - 1] } });
        if (step === titles.length + 1)
          return response('finish', { state: 'ready', message: 'Prepared.' });
        if (id === 'Q6-independent' && step === titles.length + 2) {
          const current = visibleSession(prompt) as { proposal: { revision: number } };
          return response('interpret', {
            intent: 'confirm',
            approval: submittedMessage(prompt),
            scope: {
              proposalRevision: current.proposal.revision,
              changes: [{ kind: 'change', index: 0 }],
            },
          });
        }
        return response('interpret', { intent: 'confirm', approval: submittedMessage(prompt) });
      },
    });
    const report = await runCase(
      item,
      {
        options: { provider: 'openrouter', model: 'synthetic', allowPaid: false, maxRequests: 1 },
        budget: new RequestBudget(1),
        key: 'synthetic',
        fetch: async () => {
          throw Error('No network');
        },
      },
      async () => {},
      model,
    );
    expect(
      report.outcome,
      JSON.stringify(
        report.turns.map((turn) => ({
          failures: turn.failures,
          status: turn.status,
          trees: turn.trees,
          writes: turn.writeCount,
        })),
      ),
    ).toBe('passed');
    expect(report.physicalRequests).toBe(0);
    expect(report.turns).toHaveLength(item.turns.length);
  },
);
it('runs the canonical real agent preview/save pipeline without network and retains admission before write', async () => {
  const script = [
    response('expand', {
      capabilities: ['read', 'task', 'status', 'note', 'project', 'link', 'cleanup', 'research'],
    }),
    response('task', {
      input: {
        kind: 'create',
        destination: { type: 'configured-default' },
        tree: {
          markdownTitle: 'Root',
          initial: {
            scheduled: { type: 'set', value: '2026-11-11' },
            time: { type: 'set', value: '10:00' },
            recurrence: { type: 'set', value: 'every week on Wednesday' },
          },
        },
      },
    }),
    response('finish', { state: 'ready', message: 'Ready.' }),
    response('interpret', { intent: 'confirm', approval: 'Save this task.', research: false }),
  ];
  const model = new MockLanguageModelV4({ doGenerate: async () => expectDefined(script.shift()) });
  const trees = [
    {
      markdownTitle: 'Root',
      dates: { scheduled: '2026-11-11' },
      time: '10:00',
      recurrence: 'every week on Wednesday',
      children: [],
      comments: [],
    },
  ];
  const flushed: string[] = [];
  const report = await runCase(
    {
      id: 'canonical_control',
      family: 'controls',
      split: 'development',
      files: { 'a.md': '# Inbox\n', 'control.md': 'exact\r\n' },
      turns: [
        {
          text: 'Draft Root for tomorrow at 10, every Wednesday.',
          expect: { status: 'ready', trees },
        },
        { text: 'Save this task.', expect: { status: 'saved', trees } },
      ],
    },
    {
      options: {
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it:free',
        allowPaid: false,
        maxRequests: 1,
      },
      budget: new RequestBudget(1),
      key: 'synthetic-not-a-key',
      fetch: async () => {
        throw new Error('No network allowed in offline controls');
      },
    },
    async (value) => {
      flushed.push(JSON.stringify(value));
    },
    model,
  );
  expect(
    report.outcome,
    JSON.stringify(
      report.turns.map((turn) => ({
        failures: turn.failures,
        status: turn.snapshot.status,
        journal: turn.snapshot.journal,
      })),
    ),
  ).toBe('passed');
  expect(report.physicalRequests).toBe(0);
  expect(report.turns[1]?.after['a.md']).toContain('⏳ 2026-11-11');
  const admission = report.trace.find(
    (event) => event.kind === 'durable-journal' && JSON.stringify(event.data).includes('admitted'),
  );
  const write = report.trace.find((event) => event.kind === 'write-dispatch');
  expect(expectDefined(admission).sequence).toBeLessThan(expectDefined(write).sequence);
  expect(flushed.length).toBeGreaterThanOrEqual(3);
});

it('replays canonical create, append recurrence and contextual confirmation through real APIs', async () => {
  const { canonicalControl } = await import('./command-live/corpus');
  const { canonicalModel } = await import('./command-live/controls');
  const report = await runCase(
    canonicalControl,
    {
      options: {
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it:free',
        allowPaid: false,
        maxRequests: 1,
      },
      budget: new RequestBudget(1),
      key: 'synthetic-not-a-key',
      fetch: async () => {
        throw new Error('offline');
      },
    },
    async () => {},
    canonicalModel(),
  );
  expect(
    report.outcome,
    JSON.stringify(
      report.turns.map((turn) => ({ failures: turn.failures, status: turn.snapshot.status })),
    ),
  ).toBe('passed');
});
it('accepts canonical English recurrence and rejects raw Russian recurrence without writing', async () => {
  const { publicApiHarness } = await import('./support/publicApiHarness');
  const h = await publicApiHarness({ 'a.md': '# Inbox\n' }, { provision: true });
  try {
    const api = h.client('recurrence-control');
    const prepare = expectDefined(api.tasks.prepare);
    const canonical = await prepare({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: {
        markdownTitle: 'Root',
        initial: { recurrence: { type: 'set', value: 'every week on Wednesday' } },
      },
    });
    expect(canonical.ok).toBe(true);
    const russian = await prepare({
      kind: 'create',
      destination: { type: 'configured-default' },
      tree: {
        markdownTitle: 'Root',
        initial: { recurrence: { type: 'set', value: 'каждую среду' } },
      },
    });
    expect(russian.ok).toBe(false);
    expect(await h.read('a.md')).toBe('# Inbox\n');
  } finally {
    h.dispose();
  }
});
it('refuses to score a status-only ready case and flushes incomplete evidence without dispatch', async () => {
  const flushed: string[] = [];
  const report = await runCase(
    {
      id: 'weak-oracle',
      family: 'controls',
      split: 'development',
      files: { 'a.md': '' },
      turns: [{ text: 'Find Vera', expect: { status: 'ready' } }],
    },
    {
      options: {
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it:free',
        allowPaid: false,
        maxRequests: 1,
      },
      budget: new RequestBudget(1),
      key: 'synthetic-not-a-key',
      fetch: async () => {
        throw new Error('offline');
      },
    },
    async (value) => {
      flushed.push(JSON.stringify(value));
    },
  );
  expect(report.outcome).toBe('incomplete');
  expect(report.failure).toBe('oracle-unqualified:turns-1');
  expect(report.physicalRequests).toBe(0);
  expect(JSON.parse(expectDefined(flushed[0]))).toMatchObject({
    phase: 'case-start',
    turns: [],
    physicalRequests: 0,
  });
  expect(JSON.parse(expectDefined(flushed[flushed.length - 1]))).toMatchObject({
    phase: 'finished',
    outcome: 'incomplete',
    failure: 'oracle-unqualified:turns-1',
  });
});

it('completes native Wednesday recurrence with the fixture placement and lifecycle settings', async () => {
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step++;
      if (step === 1)
        return response('expand', {
          capabilities: [
            'read',
            'task',
            'status',
            'note',
            'project',
            'link',
            'cleanup',
            'research',
          ],
        });
      if (step === 2) return response('read', { input: { kind: 'tasks', query: 'Root' } });
      if (step === 3) {
        const output = prompt
          .flatMap((m) => (m.role === 'tool' ? m.content : []))
          .find((p) => p.type === 'tool-result' && p.toolName === 'read');
        if (output?.type !== 'tool-result' || output.output.type !== 'json')
          throw new Error('read');
        const value = output.output.value as { items: Array<{ target: string; revision: string }> };
        const node = expectDefined(value.items[0]);
        return response('status', { target: node.target, revision: node.revision, symbol: 'x' });
      }
      if (step === 4) return response('finish', { state: 'ready', message: 'Ready.' });
      if (step === 5)
        return response('interpret', {
          intent: 'confirm',
          approval: submittedMessage(prompt),
          research: false,
        });
      throw new Error('extra generation');
    },
  });
  const source = '- [ ] Root ⏳ 2026-11-11 🔁 every week on Wednesday\n';
  const wanted =
    '- [x] Root ⏳ 2026-11-11 🔁 every week on Wednesday\n- [ ] Root ⏳ 2026-11-18 🔁 every week on Wednesday\n';
  const { actions } = await import('./command-live/corpus');
  const report = await runCase(
    expectDefined(actions.find((test) => test.id === '050')),
    {
      options: {
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it:free',
        allowPaid: false,
        maxRequests: 1,
      },
      budget: new RequestBudget(1),
      key: 'synthetic',
      fetch: async () => {
        throw new Error('offline');
      },
    },
    async () => {},
    model,
  );
  expect(
    report.outcome,
    JSON.stringify(
      report.turns.map((t) => ({
        status: t.snapshot.status,
        failures: t.failures,
        after: t.after,
      })),
    ),
  ).toBe('passed');
  expect(report.turns[0]?.publicReadback.filter((t) => t.source?.path === 'a.md')).toMatchObject([
    {
      statusSymbol: ' ',
      dates: { scheduled: '2026-11-11' },
      recurrence: 'every week on Wednesday',
    },
  ]);
  expect(report.turns[1]?.publicReadback.filter((t) => t.source?.path === 'a.md')).toMatchObject([
    {
      statusSymbol: 'x',
      dates: { scheduled: '2026-11-11' },
      recurrence: 'every week on Wednesday',
    },
    {
      statusSymbol: ' ',
      dates: { scheduled: '2026-11-18' },
      recurrence: 'every week on Wednesday',
    },
  ]);
  expect(report.physicalRequests).toBe(0);
  expect(report.turns[0]?.after['a.md']).toBe(source);
  expect(report.turns[1]?.after['a.md']).toBe(wanted);
});

it('preserves the full retained P03 draft and owner-bound comment through explicit rewrite and receipt', async () => {
  const { pipelines } = await import('./command-live/corpus');
  const { object } = await import('./command-live/safety');
  const test = expectDefined(pipelines.find((c) => c.id === 'P03'));
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step++;
      if ([1, 4, 7, 10].includes(step))
        return response('expand', {
          capabilities: [
            'read',
            'task',
            'status',
            'note',
            'project',
            'link',
            'cleanup',
            'research',
          ],
        });
      if ([3, 6, 9, 12].includes(step))
        return response('finish', { state: 'ready', message: 'Ready.' });
      if (step === 13)
        return response('interpret', {
          intent: 'confirm',
          approval: submittedMessage(prompt),
          research: false,
        });
      if (step === 2)
        return response('task', {
          input: {
            kind: 'create',
            destination: { type: 'configured-default' },
            tree: { markdownTitle: 'Root' },
          },
        });
      const visible = visibleSession(prompt);
      const changes = object(visible['proposal'])['changes'] as unknown[];
      const change = object(changes[0]),
        plan = object(change['plan']),
        basis = object(change['planBasis']),
        root = object(plan['after']);
      if (step === 5)
        return response('task', {
          input: {
            kind: 'batch',
            ...basis,
            operations: ['Alpha', 'Beta', 'Gamma'].map((markdownTitle) => ({
              type: 'add-child',
              target: root['target'],
              markdownTitle,
            })),
          },
        });
      const beta = object((root['children'] as unknown[])[1]);
      const operation =
        step === 8
          ? { type: 'add-comment', target: beta['target'], text: 'Read https://example.org.' }
          : {
              type: 'update-comment',
              target: object((beta['comments'] as unknown[])[0])['target'],
              text: 'Study https://example.org.',
            };
      return response('task', { input: { kind: 'append', ...basis, operation } });
    },
  });
  const report = await runCase(
    test,
    {
      options: {
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it:free',
        allowPaid: false,
        maxRequests: 1,
      },
      budget: new RequestBudget(1),
      key: 'synthetic',
      fetch: async () => {
        throw new Error('offline');
      },
    },
    async () => {},
    model,
  );
  expect(
    report.outcome,
    JSON.stringify(report.turns.map((t) => ({ status: t.snapshot.status, failures: t.failures }))),
  ).toBe('passed');
  expect(
    report.turns[3]?.preservation?.some((pair) => (pair.commentContinuity?.length ?? 0) > 0),
  ).toBe(true);
  const { preservationEvidence } = await import('./command-live/preservation');
  const { evaluateTurn } = await import('./command-live/oracles');
  const damaged = structuredClone(expectDefined(report.turns[3]));
  const priorChild = expectDefined(
    expectDefined(damaged.inputSnapshot.trees[0]?.after).children[1],
  );
  Object.assign(priorChild, {
    timeEntries: [
      {
        target: 'tracked',
        parentTarget: priorChild.target,
        state: 'closed',
        startMs: 1000,
        endMs: 46000,
      },
    ],
  });
  const child = object((object(damaged.trees[0])['children'] as unknown[])[1]);
  child['target'] = 'replacement-child';
  child['timeEntries'] = [];
  child['comments'] = [
    {
      target: 'replacement-comment',
      parentTarget: 'replacement-child',
      text: 'Study https://example.org.',
      timestamp: { precision: 'day', value: '2026-11-11' },
    },
  ];
  const expected = expectDefined(test.turns[3]).expect;
  damaged.preservation = preservationEvidence(
    { snapshot: damaged.snapshot, previous: damaged.inputSnapshot },
    damaged.trees as TaskTreeV1[],
    expected,
  );
  expect(evaluateTurn(expected, damaged)).toContain('preservation:task-correspondence');
  expect(report.turns[4]?.after['a.md']).toBe(
    '- [ ] Root\n\t- [ ] Alpha\n\t- [ ] Beta\n\t\t- 2026-11-10T05:00:00+00:00: Study https://example.org.\n\t- [ ] Gamma',
  );
});

function visibleSession(
  prompt: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'],
): Record<string, unknown> {
  const user = prompt.find((m) => m.role === 'user');
  if (user?.role !== 'user') throw new Error('missing user');
  const text = user.content.find((p) => p.type === 'text');
  if (text?.type !== 'text') throw new Error('missing text');
  const value = JSON.parse(text.text) as { visibleSession: Record<string, unknown> };
  return value.visibleSession;
}

it('records effective per-case policy and verifies Inbox membership across preview and save', async () => {
  const script = [
    response('expand', {
      capabilities: ['read', 'task', 'status', 'note', 'project', 'link', 'cleanup', 'research'],
    }),
    response('task', {
      input: {
        kind: 'create',
        intent: 'inbox',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: 'Gym' },
      },
    }),
    response('finish', { state: 'ready', message: 'Ready.' }),
    response('interpret', { intent: 'confirm', approval: 'Save.', research: false }),
  ];
  const model = new MockLanguageModelV4({ doGenerate: async () => expectDefined(script.shift()) });
  const report = await runCase(
    {
      id: 'inbox-policy-control',
      family: 'controls',
      split: 'development',
      behavior: {
        taskPrefix: '#task/one-off',
        inbox: { mode: 'both', tag: '#task/inbox', removeTagOnAssign: true },
      },
      files: { 'a.md': '# Tasks\n', 'control.md': 'untouched\n' },
      turns: [
        {
          text: 'Create Gym in Inbox.',
          expect: {
            status: 'ready',
            trees: [{ markdownTitle: 'Gym', tags: ['#task/inbox'] }],
            inboxMembers: [true],
          },
        },
        {
          text: 'Save.',
          expect: {
            status: 'saved',
            trees: [{ markdownTitle: 'Gym', tags: ['#task/inbox'] }],
            inboxMembers: [true],
          },
        },
      ],
    },
    {
      options: { provider: 'openrouter', model: 'test', allowPaid: false, maxRequests: 1 },
      budget: new RequestBudget(1),
      key: 'synthetic',
      fetch: async () => {
        throw new Error('No network');
      },
    },
    async () => {},
    model,
  );
  expect(report.outcome, JSON.stringify(report)).toBe('passed');
  expect(report.behavior).toMatchObject({
    taskPrefix: '#task/one-off',
    inbox: { mode: 'both', tag: '#task/inbox' },
  });
  expect(report.turns.map((turn) => turn.inboxMembers)).toEqual([[true], [true]]);
});

it('qualifies Inbox creation in an explicit note through public readback', async () => {
  const { selectCases } = await import('./command-live/corpus');
  const script = [
    response('expand', {
      capabilities: ['read', 'task', 'status', 'note', 'project', 'link', 'cleanup', 'research'],
    }),
    response('task', {
      input: {
        kind: 'create',
        intent: 'inbox',
        destination: { type: 'note', path: 'personal.md', insertion: { type: 'append' } },
        tree: { markdownTitle: 'Gym' },
      },
    }),
    response('finish', { state: 'ready', message: 'Ready.' }),
    response('interpret', {
      intent: 'confirm',
      approval: expectDefined(expectDefined(selectCases('I-note')[0]).turns[1]).text,
      research: false,
    }),
  ];
  const model = new MockLanguageModelV4({ doGenerate: async () => expectDefined(script.shift()) });
  const report = await runCase(
    expectDefined(selectCases('I-note')[0]),
    {
      options: { provider: 'openrouter', model: 'test', allowPaid: false, maxRequests: 1 },
      budget: new RequestBudget(1),
      key: 'synthetic',
      fetch: async () => {
        throw new Error('No network');
      },
    },
    async () => {},
    model,
  );
  expect(report.outcome, JSON.stringify(report.turns.map((turn) => turn.failures))).toBe('passed');
  expect(report.turns[1]?.after['a.md']).toBe('# Inbox\n');
  expect(report.turns[1]?.after['personal.md']).toContain('Gym');
  const { evaluateTurn } = await import('./command-live/oracles');
  const saved = expectDefined(report.turns[1]);
  const contract = expectDefined(expectDefined(selectCases('I-note')[0]).turns[1]).expect;
  expect(
    evaluateTurn(contract, { ...saved, after: { ...saved.after, 'a.md': '# Inbox\n- [ ] Gym\n' } }),
  ).toContain('file:a.md');
  expect(evaluateTurn(contract, { ...saved, publicTrees: [] })).toContain(
    'public-tree-postcondition',
  );
});

it('runs a project-profile query with real inline search and exact existing selection readback', async () => {
  const { focusMoveContrasts } = await import('./command-live/corpus');
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      if (++step === 1) return response('find', { query: 'Root' });
      const output = prompt
        .flatMap((m) => (m.role === 'tool' ? m.content : []))
        .find((p) => p.type === 'tool-result' && p.toolName === 'find');
      if (output?.type !== 'tool-result' || output.output.type !== 'json')
        throw new Error('Missing find result');
      const value = output.output.value as { items: Array<{ target: string; revision: string }> };
      const node = expectDefined(value.items[0]);
      return response('finish', {
        state: 'ready',
        message: 'Selected.',
        selection: [{ kind: 'task', target: node.target, revision: node.revision }],
      });
    },
  });
  const report = await runCase(
    expectDefined(focusMoveContrasts.find((test) => test.id === 'I-focus')),
    {
      options: { provider: 'openrouter', model: 'synthetic', allowPaid: false, maxRequests: 1 },
      budget: new RequestBudget(1),
      key: 'synthetic',
      fetch: async () => {
        throw new Error('No network');
      },
    },
    async () => {},
    model,
  );
  expect(
    report.outcome,
    JSON.stringify(
      report.turns.map((turn) => ({ failures: turn.failures, status: turn.snapshot.status })),
    ),
  ).toBe('passed');
  expect(report.limitations).toContain('headless-inline-search-backend');
  expect(report.turns[0]?.after['a.md']).toBe('- [ ] Root\n');
  expect(report.turns[0]?.snapshot.journal).toEqual([]);
  expect(report.turns[0]?.snapshot.proposal.changes).toEqual([]);
  expect(report.physicalRequests).toBe(0);
});
