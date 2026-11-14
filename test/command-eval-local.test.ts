import { Platform } from 'obsidian';
import { expect, it } from 'vitest';
import { parseArgs } from '../tooling/command-eval.mjs';
import { selectCases } from './command-live/corpus';
import { liveRequest, runCase } from './command-live/harness';
import { readFreeCatalog } from './command-live/providerBoundary';
import { object, RequestBudget, validateOptions, type EvalOptions } from './command-live/safety';
import { expectDefined, useRealMoment } from './helpers';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

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

it('gives omitted output paths distinct run IDs while preserving explicit options', () => {
  const first = parseArgs([]);
  const second = parseArgs([]);
  expect(first.out).not.toBe(second.out);
  expect(first.out).toMatch(/^docs\/research\/command-mode-round6\/runs\//);
  expect(
    parseArgs([
      '--provider',
      'local',
      '--model',
      options.model,
      '--base-url',
      base,
      '--out',
      'custom-run',
    ]),
  ).toMatchObject({
    provider: 'local',
    model: options.model,
    localBaseURL: base,
    out: 'custom-run',
  });
});

it(
  'reserves only fresh run directories without modifying existing outputs',
  async () => {
    if (!Platform.isDesktop) throw Error('Output reservation controls require desktop');
    const [
      { mkdir, mkdtemp, readFile, rm, writeFile },
      { tmpdir },
      { join, resolve },
      { randomUUID },
      { spawnSync },
      { pathToFileURL },
    ] = await Promise.all([
      import('node:fs/promises'),
      import('node:os'),
      import('node:path'),
      import('node:crypto'),
      import('node:child_process'),
      import('node:url'),
    ]);
    const { reserveOutputDirectory } = await import('../tooling/command-eval.mjs');
    const root = await mkdtemp(join(tmpdir(), 'command-eval-out-'));
    try {
      const existing = join(root, 'existing');
      await mkdir(existing);
      const manifest = join(existing, 'manifest.json');
      await writeFile(manifest, '{"fixture":"keep bytes"}\n');
      const original = await readFile(manifest);
      await expect(reserveOutputDirectory(existing)).rejects.toThrow(
        'Output directory already exists; choose a fresh --out directory.',
      );
      expect(await readFile(manifest)).toEqual(original);

      const nested = join(root, 'nested', 'fresh-run');
      await expect(reserveOutputDirectory(nested)).resolves.toBe(resolve(nested));
      await expect(readFile(manifest)).resolves.toEqual(original);

      const fromOtherCwd = `docs/research/command-mode-round6/runs/cwd-${randomUUID()}`;
      const launcherUrl = pathToFileURL(join(process.cwd(), 'tooling/command-eval.mjs')).href;
      const reservation = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { reserveOutputDirectory } = await import(${JSON.stringify(launcherUrl)}); process.stdout.write(await reserveOutputDirectory(${JSON.stringify(fromOtherCwd)}));`,
        ],
        { cwd: root, encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS },
      );
      try {
        expect(reservation.status, reservation.stderr).toBe(0);
        expect(reservation.stdout).toBe(resolve(fromOtherCwd));
      } finally {
        await rm(resolve(fromOtherCwd), { recursive: true, force: true });
      }

      const shared = join(root, 'concurrent');
      const results = await Promise.allSettled([
        reserveOutputDirectory(shared),
        reserveOutputDirectory(shared),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  CHILD_PROCESS_TIMEOUT_MS,
);

it(
  'keeps CLI list mode read-only even when an output path is supplied',
  async () => {
    if (!Platform.isDesktop) throw Error('CLI output controls require desktop');
    const [{ spawnSync }, { existsSync }, { resolve }] = await Promise.all([
      import('node:child_process'),
      import('node:fs'),
      import('node:path'),
    ]);
    const output = 'docs/research/command-mode-round6/list-must-not-exist';
    const result = spawnSync(
      process.execPath,
      ['tooling/command-eval.mjs', '--list', '--out', output],
      { encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS, stdio: 'ignore' },
    );
    expect(result.status).toBe(0);
    expect(existsSync(resolve(output))).toBe(false);
  },
  CHILD_PROCESS_TIMEOUT_MS,
);

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
