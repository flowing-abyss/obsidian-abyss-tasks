import { expect, it } from 'vitest';
import { parseArgs } from '../tooling/command-eval.mjs';
import { selectCases } from './command-live/corpus';
import { liveRequest } from './command-live/harness';
import { readFreeCatalog } from './command-live/providerBoundary';
import { object, RequestBudget, validateOptions, type EvalOptions } from './command-live/safety';
import { runScriptedCase as runCase } from './command-live/scriptedCase';
import { expectDefined, useRealMoment } from './helpers';

useRealMoment();
const base = 'http://127.0.0.1:12345/v1';
const options: EvalOptions = {
  provider: 'local',
  model: 'qwen3:4b-instruct',
  localBaseURL: base,
  maxRequests: 6,
  allowPaid: false,
};

it('requires explicit local model and base at the CLI and keeps the paid opt-in on cloud routes', () => {
  const local = ['--provider', 'local'];
  expect(() => parseArgs([...local, '--base-url', base])).toThrow();
  expect(() => parseArgs([...local, '--model', options.model])).toThrow();
  expect(() => parseArgs(['--provider', 'openai', '--model', 'paid'])).toThrow();
  expect(parseArgs([...local, '--model', options.model, '--base-url', base])).toMatchObject({
    provider: 'local',
    model: options.model,
    localBaseURL: base,
    allowPaid: false,
  });
});

it('requires an explicit numeric loopback API base and a named local model', () => {
  expect(validateOptions(options).localBaseURL).toBe(base);
  for (const localBaseURL of [
    '',
    'https://remote.test/v1',
    'http://127.0.0.1.example:12345/v1',
    'http://user@127.0.0.1:12345/v1',
    'http://127.0.0.1:12345/private',
    'http://127.0.0.1:12345/v1?key=value',
    'http://127.0.0.1:12345/v1#frag',
    'http://127.0.0.1:12345/private/../v1',
    'http://127.0.0.1:99999/v1',
  ])
    expect(() => validateOptions({ ...options, localBaseURL })).toThrow();
  expect(() => validateOptions({ ...options, allowPaid: true })).toThrow();
  expect(() => validateOptions({ ...options, model: 'qwen:cloud' })).toThrow();
  expect(() =>
    validateOptions({ ...options, provider: 'openrouter', model: 'test:free' }),
  ).toThrow();
});

it('skips the provider catalog and forbids redirects, credentials and other endpoints before local dispatch', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: typeof window.fetch = async (url, init) => {
    if (typeof url !== 'string') throw new Error('Expected URL string');
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return Response.json({});
  };
  const budget = new RequestBudget(2);
  const catalog = await readFreeCatalog(options, budget, fetch);
  expect(catalog).toMatchObject({ checked: false, reason: 'operator-configured-loopback' });
  expect(calls).toHaveLength(0);
  const native = liveRequest({ options, key: '', budget, fetch }, () => {});
  const request = {
    method: 'POST',
    url: `${base}/chat/completions`,
    body: JSON.stringify({ model: options.model }),
  };
  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    base,
    `${base}/chat/completions?x=1`,
    `${base}/audio/transcriptions`,
  ])
    await expect(native({ ...request, url })).rejects.toThrow();
  await expect(native({ ...request, method: 'GET' })).rejects.toThrow();
  await expect(native({ ...request, headers: { Authorization: 'unwanted' } })).rejects.toThrow();
  await expect(
    native({ ...request, body: JSON.stringify({ model: options.model, models: ['other'] }) }),
  ).rejects.toThrow();
  expect(budget.used).toBe(0);
  await native(request);
  expect(budget.used).toBe(1);
  expect(calls).toMatchObject([{ url: request.url, init: { method: 'POST', redirect: 'error' } }]);
  expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
});

it('runs the product compatible SDK over the metered loopback wire with local provenance', async () => {
  const source = expectDefined(selectCases('B01-en')[0]);
  const item = { ...source, turns: source.turns.slice(0, 1) };
  const requests: Array<{ url: string; body: unknown; authorization: boolean }> = [];
  const replies = [
    {
      name: 'create_task',
      arguments: JSON.stringify({
        tree: {
          markdownTitle: 'Orion',
          initial: {
            scheduled: { type: 'set', value: '2026-11-11' },
            time: { type: 'set', value: '10:00' },
          },
        },
      }),
    },
    { name: 'finish', arguments: JSON.stringify({ state: 'ready', message: 'Ready.' }) },
  ];
  const report = await runCase(
    item,
    {
      options,
      key: '',
      budget: new RequestBudget(6),
      fetch: async (input, init) => {
        if (typeof input !== 'string' || typeof init?.body !== 'string')
          throw new Error('Expected a JSON request');
        requests.push({
          url: input,
          body: JSON.parse(init.body) as unknown,
          authorization: new Headers(init.headers).has('authorization'),
        });
        const reply = expectDefined(replies[requests.length - 1]);
        return Response.json({
          id: `chatcmpl-${requests.length}`,
          object: 'chat.completion',
          model: options.model,
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ type: 'function', id: `t${requests.length}`, function: reply }],
              },
            },
          ],
          usage: { prompt_tokens: 23, completion_tokens: 4, total_tokens: 27 },
        });
      },
    },
    async () => {},
  );
  expect(report.outcome, JSON.stringify(report.turns.map((t) => t.failures))).toBe('passed');
  expect(report.modelSource).toBe('local-server');
  expect(report.physicalRequests).toBe(2);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request).toMatchObject({
      url: `${base}/chat/completions`,
      authorization: false,
      body: { model: options.model },
    });
    expect(Array.isArray(object(request.body)['tools'])).toBe(true);
  }
});
