import type { LanguageModelMiddleware } from 'ai';
import { Platform } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
  buildNativeTraceInstallEval,
  buildNativeTraceReadEval,
  buildNativeTraceRestoreEval,
} from '../tooling/native-command-trace.mjs';

const pageUrl = 'https://example.test/project';
const expectedModelId = 'gpt-6-luna';
const traceKey = '__abyssNativeTraceTest__';
const contexts = new WeakMap<object, unknown>();
type SdkTools = Parameters<
  NonNullable<LanguageModelMiddleware['wrapGenerate']>
>[0]['params']['tools'];
type SdkGenerate = Parameters<
  NonNullable<LanguageModelMiddleware['wrapGenerate']>
>[0]['doGenerate'];
type SdkGenerationResult = Awaited<ReturnType<SdkGenerate>>;
type SdkFunctionTool = Extract<NonNullable<SdkTools>[number], { type: 'function' }>;
const sdkContentTypeValues = [
  'text',
  'reasoning',
  'custom',
  'reasoning-file',
  'file',
  'tool-approval-request',
  'source',
  'tool-call',
  'tool-result',
] satisfies Array<SdkGenerationResult['content'][number]['type']>;
const sdkFinishReasonValues = [
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'interrupted',
  'other',
] satisfies Array<SdkGenerationResult['finishReason']['unified']>;

async function evaluate(code: string, app: unknown, root: object): Promise<unknown> {
  if (!Platform.isDesktop) throw new Error('native-trace-serialization-test-requires-desktop');
  const vm = await import('node:vm');
  let context = contexts.get(root);
  if (context === undefined) {
    context = vm.createContext({
      app,
      window: root,
      URL,
      performance,
      crypto: window.crypto,
      TextEncoder,
    });
    contexts.set(root, context);
  }
  return vm.runInContext(code, context as object);
}

function fixture() {
  const calls = { model: 0, search: 0, readPage: 0 };
  const model = {
    specificationVersion: 'v4',
    provider: 'fixture',
    modelId: 'gpt-6-luna',
    supportedUrls: {},
    async doGenerate(_params: unknown) {
      expect(this).toBe(model);
      return {
        content: [
          { type: 'text', text: 'private model text' },
          {
            type: 'tool-call',
            toolName: 'research',
            toolCallId: 'secret-id',
            input: { query: 'private' },
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 7, noCache: 6, cacheRead: 1, cacheWrite: 0 },
          outputTokens: { total: 2, text: 1, reasoning: 1 },
        },
      };
    },
  };
  const plugin = {
    providerConnections: {
      model(selection: unknown) {
        calls.model++;
        expect(this).toBe(plugin.providerConnections);
        expect(selection).toEqual({ fixture: true });
        return model;
      },
    },
    commandResearch: {
      async search(query: string) {
        calls.search++;
        expect(this).toBe(plugin.commandResearch);
        expect(query).toBe('private search query');
        return { query, summary: 'private summary', sources: [], truncated: false };
      },
      async readPage(url: string) {
        calls.readPage++;
        expect(this).toBe(plugin.commandResearch);
        return {
          query: url,
          summary: '',
          page: {
            kind: 'page-content',
            requestedUrl: url,
            finalUrl: null,
            limitations: ['provider-extracted', 'freshness-unverified'],
          },
          sources: [
            {
              url,
              title: 'Page title',
              snippet: null,
              content: 'x'.repeat(8100),
              evidence: 'provider-excerpt',
            },
          ],
          truncated: false,
        };
      },
    },
  };
  return {
    app: { plugins: { plugins: { 'abyss-tasks': plugin } } },
    root: {},
    plugin,
    model,
    calls,
  };
}

describe('native command trace installer', () => {
  it('captures bounded finish input shape and schema fingerprint without retaining private values', async () => {
    const { app, root, plugin, model } = fixture();
    const privateCanaries = [
      'MESSAGE_CANARY',
      'DETAIL_CANARY',
      'EVIDENCE_CANARY',
      'KEY_CANARY',
    ] as const;
    model.doGenerate = async function (this: typeof model, params: unknown) {
      expect(this).toBe(model);
      const tools = (params as { tools: NonNullable<SdkTools> }).tools;
      const finish = tools.find((tool) => tool.type === 'function' && tool.name === 'finish');
      expect(finish?.type === 'function' ? finish.inputSchema : undefined).toBeDefined();
      const finishInput = {
        state: 'question',
        message: privateCanaries[0],
        coverage: 'unrecognized-private-coverage',
        presentation: 'cumulative',
        reveal: {
          target: 'PRIVATE_REVEAL_TARGET',
          revision: 'PRIVATE_REVEAL_REVISION',
          privateRevealField: privateCanaries[3],
        },
        blockingIssue: {
          kind: 'missing-information',
          detail: privateCanaries[1],
          evidence: privateCanaries[2],
        },
        selection: [
          {
            kind: 'task',
            target: 'PRIVATE_TARGET_CANARY',
            plan: 'PRIVATE_PLAN_CANARY',
            expectedPlanRevision: 'PRIVATE_EXPECTED_PLAN_REVISION',
            revision: 'private-revision',
            privateSelectionField: privateCanaries[3],
          },
          { kind: 'unrecognized-private-kind', target: 'private-other-target' },
        ],
        unexpectedPrivateKey: privateCanaries[3],
      };
      return {
        content: [
          {
            type: 'tool-call',
            toolName: 'finish',
            toolCallId: 'private-tool-call-id',
            input: JSON.stringify(finishInput),
          },
          {
            type: 'tool-call',
            toolName: 'finish',
            input: finishInput,
          },
          {
            type: 'tool-call',
            toolName: 'finish',
            input: {
              state: 'question',
              message: 'M'.repeat(241),
              blockingIssue: ['bad-shape-private-value'],
            },
          },
          {
            type: 'tool-call',
            toolName: 'finish',
            input: {
              state: 'PRIVATE_STATE_CANARY',
              blockingIssue: {
                kind: 'PRIVATE_BLOCKER_KIND_CANARY',
                detail: 7,
                evidence: false,
                privateBlockerField: 'private-blocker-value',
              },
            },
          },
          {
            type: 'tool-call',
            toolName: 'research',
            input: { query: privateCanaries[0] },
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    } as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const schema = {
      type: 'object',
      properties: { state: { enum: ['ready', 'question'] } },
    } satisfies SdkFunctionTool['inputSchema'];
    const tools = [
      {
        type: 'function' as const,
        name: 'finish',
        inputSchema: schema,
      } satisfies NonNullable<SdkTools>[number],
    ];
    await wrapped.doGenerate({
      tools,
      prompt: [{ role: 'user', content: privateCanaries[2] }],
    });

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]).toMatchObject({
      finishInputs: [
        {
          representation: 'json-string',
          keys: [
            'state',
            'message',
            'coverage',
            'presentation',
            'reveal',
            'blockingIssue',
            'selection',
          ],
          unknownKeyCount: 1,
          state: { type: 'string', enum: 'question', length: 'question'.length },
          message: { type: 'string', length: privateCanaries[0].length },
          coverage: {
            type: 'string',
            enum: 'other',
            length: 'unrecognized-private-coverage'.length,
          },
          presentation: { type: 'string', enum: 'cumulative', length: 'cumulative'.length },
          reveal: {
            keys: ['target', 'revision'],
            unknownKeyCount: 1,
            target: { type: 'string', length: 'PRIVATE_REVEAL_TARGET'.length },
            revision: { type: 'string', length: 'PRIVATE_REVEAL_REVISION'.length },
          },
          blockingIssue: {
            keys: ['kind', 'detail', 'evidence'],
            unknownKeyCount: 0,
            kind: {
              type: 'string',
              enum: 'missing-information',
              length: 'missing-information'.length,
            },
            detail: { type: 'string', length: privateCanaries[1].length },
            evidence: { type: 'string', length: privateCanaries[2].length },
          },
          selection: {
            count: 2,
            entries: [
              {
                keys: ['kind', 'target', 'plan', 'expectedPlanRevision', 'revision'],
                unknownKeyCount: 1,
                kind: { type: 'string', enum: 'task', length: 'task'.length },
                target: { type: 'string', length: 'PRIVATE_TARGET_CANARY'.length },
                plan: { type: 'string', length: 'PRIVATE_PLAN_CANARY'.length },
                expectedPlanRevision: {
                  type: 'string',
                  length: 'PRIVATE_EXPECTED_PLAN_REVISION'.length,
                },
                revision: { type: 'string', length: 'private-revision'.length },
              },
              {
                keys: ['kind', 'target'],
                unknownKeyCount: 0,
                kind: {
                  type: 'string',
                  enum: 'other',
                  length: 'unrecognized-private-kind'.length,
                },
                target: { type: 'string', length: 'private-other-target'.length },
              },
            ],
          },
        },
        {
          representation: 'object',
          keys: [
            'state',
            'message',
            'coverage',
            'presentation',
            'reveal',
            'blockingIssue',
            'selection',
          ],
          unknownKeyCount: 1,
          state: { type: 'string', enum: 'question', length: 'question'.length },
          message: { type: 'string', length: privateCanaries[0].length },
          blockingIssue: {
            keys: ['kind', 'detail', 'evidence'],
            unknownKeyCount: 0,
            kind: {
              type: 'string',
              enum: 'missing-information',
              length: 'missing-information'.length,
            },
            detail: { type: 'string', length: privateCanaries[1].length },
            evidence: { type: 'string', length: privateCanaries[2].length },
          },
          selection: {
            count: 2,
            entries: [
              {
                keys: ['kind', 'target', 'plan', 'expectedPlanRevision', 'revision'],
                unknownKeyCount: 1,
                kind: { type: 'string', enum: 'task', length: 'task'.length },
                target: { type: 'string', length: 'PRIVATE_TARGET_CANARY'.length },
                plan: { type: 'string', length: 'PRIVATE_PLAN_CANARY'.length },
                expectedPlanRevision: {
                  type: 'string',
                  length: 'PRIVATE_EXPECTED_PLAN_REVISION'.length,
                },
                revision: { type: 'string', length: 'private-revision'.length },
              },
              {
                keys: ['kind', 'target'],
                unknownKeyCount: 0,
                kind: { type: 'string', length: 'unrecognized-private-kind'.length },
                target: { type: 'string', length: 'private-other-target'.length },
              },
            ],
          },
        },
        {
          representation: 'object',
          keys: ['state', 'message', 'blockingIssue'],
          unknownKeyCount: 0,
          state: { type: 'string', enum: 'question', length: 'question'.length },
          message: { type: 'string', length: 241 },
          blockingIssue: { type: 'array', length: 1 },
        },
        {
          representation: 'object',
          keys: ['state', 'blockingIssue'],
          unknownKeyCount: 0,
          state: { type: 'string', enum: 'other', length: 'PRIVATE_STATE_CANARY'.length },
          blockingIssue: {
            keys: ['kind', 'detail', 'evidence'],
            unknownKeyCount: 1,
            kind: {
              type: 'string',
              enum: 'other',
              length: 'PRIVATE_BLOCKER_KIND_CANARY'.length,
            },
            detail: { type: 'number' },
            evidence: { type: 'boolean' },
          },
        },
      ],
    });
    expect(trace.generations[0]?.['finishSchemaSha256']).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(trace);
    for (const canary of privateCanaries) expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('unexpectedPrivateKey');
    expect(serialized).not.toContain('private-tool-call-id');
    expect(serialized).not.toContain('privateRevealField');
    expect(serialized).not.toContain('privateSelectionField');
    expect(serialized).not.toContain('PRIVATE_TARGET_CANARY');
    expect(serialized).not.toContain('PRIVATE_PLAN_CANARY');
    expect(serialized).not.toContain('PRIVATE_EXPECTED_PLAN_REVISION');
    expect(serialized).not.toContain('private-revision');
    expect(serialized).not.toContain('unrecognized-private-kind');
    expect(serialized).not.toContain('unrecognized-private-coverage');
    expect(serialized).not.toContain('PRIVATE_REVEAL_TARGET');
    expect(serialized).not.toContain('PRIVATE_REVEAL_REVISION');
    expect(serialized).not.toContain('bad-shape-private-value');
    expect(serialized).not.toContain('PRIVATE_STATE_CANARY');
    expect(serialized).not.toContain('PRIVATE_BLOCKER_KIND_CANARY');
    expect(serialized).not.toContain('privateBlockerField');
    expect(serialized).not.toContain('private-blocker-value');
    expect(serialized).not.toContain('M'.repeat(100));
  });

  it('bounds malformed finish inputs and keeps schema fingerprints across JSON transport', async () => {
    const { app, root, plugin, model } = fixture();
    let generation = 0;
    const privateCanary = 'PRIVATE_INVALID_JSON_CANARY';
    model.doGenerate = async function (this: typeof model, params: unknown) {
      expect(this).toBe(model);
      const tools = (params as { tools: NonNullable<SdkTools> }).tools;
      const finish = tools.find((tool) => tool.type === 'function' && tool.name === 'finish');
      expect(finish?.type === 'function' ? finish.inputSchema : undefined).toBeDefined();
      generation++;
      let input: string;
      if (generation === 1) input = `{broken${privateCanary}`;
      else if (generation === 2) input = 'x'.repeat(16385);
      else input = 'é'.repeat(8193);
      return {
        content: [
          {
            type: 'tool-call',
            toolName: 'finish',
            input,
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      };
    } as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const modelWithTrace = plugin.providerConnections.model({ fixture: true });
    const params = {
      tools: [
        {
          type: 'function' as const,
          name: 'finish',
          inputSchema: {
            type: 'object',
            properties: { state: { enum: ['ready', 'question'] } },
          } satisfies SdkFunctionTool['inputSchema'],
        } satisfies NonNullable<SdkTools>[number],
      ],
    };
    await modelWithTrace.doGenerate(params);
    await modelWithTrace.doGenerate(JSON.parse(JSON.stringify(params)));
    await modelWithTrace.doGenerate(JSON.parse(JSON.stringify(params)));

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]?.['finishInputs']).toEqual([{ representation: 'invalid-json' }]);
    expect(trace.generations[1]?.['finishInputs']).toEqual([
      { representation: 'oversized-string' },
    ]);
    expect(trace.generations[2]?.['finishInputs']).toEqual([
      { representation: 'oversized-string' },
    ]);
    expect(trace.generations[0]?.['finishSchemaSha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(trace.generations[1]?.['finishSchemaSha256']).toBe(
      trace.generations[0]?.['finishSchemaSha256'],
    );
    expect(trace.generations[2]?.['finishSchemaSha256']).toBe(
      trace.generations[0]?.['finishSchemaSha256'],
    );
    expect(JSON.stringify(trace)).not.toContain(privateCanary);
    expect(JSON.stringify(trace)).not.toContain('x'.repeat(100));
    expect(JSON.stringify(trace)).not.toContain('é'.repeat(100));
  });

  it('fails open when schema observation throws and preserves provider error identity', async () => {
    const { app, root, plugin, model } = fixture();
    const providerError = new Error('provider failure');
    let calls = 0;
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      calls++;
      throw providerError;
    };
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const modelWithTrace = plugin.providerConnections.model({ fixture: true });
    const params = Object.defineProperty({}, 'tools', {
      get() {
        throw new Error('schema observation failure');
      },
    });

    await expect(modelWithTrace.doGenerate(params)).rejects.toBe(providerError);
    expect(calls).toBe(1);
  });

  it('fails open when finish input observation throws and preserves the exact provider result', async () => {
    const { app, root, plugin, model } = fixture();
    let getterReads = 0;
    const result = {
      content: [
        Object.defineProperties(
          { type: 'tool-call', toolName: 'finish' },
          {
            input: {
              get() {
                getterReads++;
                throw new Error('finish input observation failure');
              },
            },
          },
        ),
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    };
    let calls = 0;
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      calls++;
      return result;
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const modelWithTrace = plugin.providerConnections.model({ fixture: true });

    await expect(
      modelWithTrace.doGenerate({
        tools: [
          {
            type: 'function',
            name: 'finish',
            inputSchema: { type: 'object' },
          } satisfies NonNullable<SdkTools>[number],
        ],
      }),
    ).resolves.toBe(result);
    expect(getterReads).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  it('counts declared tool calls omitted by the recorded-name cap', async () => {
    const { app, root, plugin, model } = fixture();
    const result = {
      content: Array.from({ length: 17 }, () => ({
        type: 'tool-call',
        toolName: 'research',
        input: '{}',
      })),
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    };
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      return result;
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });

    await expect(
      wrapped.doGenerate({
        tools: [
          {
            type: 'function',
            name: 'research',
            inputSchema: { type: 'object' },
          } satisfies NonNullable<SdkTools>[number],
        ],
      }),
    ).resolves.toBe(result);

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]).toMatchObject({
      toolNames: Array.from({ length: 16 }, () => 'research'),
      toolNameOmittedCount: 1,
      contentOmittedCount: 0,
    });
    expect(result.content).toHaveLength(17);
  });

  it('bounds SDK metadata and keeps only tool names declared in the current SDK call', async () => {
    const { app, root, plugin, model } = fixture();
    const maliciousToolName = 'UNTRUSTED_TOOL_NAME_CANARY'.padEnd(34_000, 'x');
    const contentTypeCanary = 'UNTRUSTED_CONTENT_TYPE_CANARY';
    const finishCanary = 'UNTRUSTED_FINISH_REASON_CANARY';
    const content = [
      ...sdkContentTypeValues.map((type) => ({ type })),
      { type: 'text', text: 'private' },
      { type: 'tool-call', toolName: 'research', input: '{}' },
      { type: 'tool-call', toolName: maliciousToolName, input: '{}' },
      { type: contentTypeCanary },
      ...Array.from({ length: 100 }, () => ({ type: 'reasoning' })),
    ];
    const result = {
      content,
      finishReason: { unified: finishCanary, raw: finishCanary },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    };
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      return result;
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      {
        type: 'function' as const,
        name: 'research',
        inputSchema: { type: 'object' },
      } satisfies NonNullable<SdkTools>[number],
      {
        type: 'function' as const,
        name: 'finish',
        inputSchema: { type: 'object' },
      } satisfies NonNullable<SdkTools>[number],
    ];

    await expect(wrapped.doGenerate({ tools })).resolves.toBe(result);

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    const generation = trace.generations[0];
    expect(generation).toMatchObject({
      finishReason: 'other',
      contentTypes: sdkContentTypeValues,
      toolNames: ['research'],
      contentCount: content.length,
      contentOmittedCount: content.length - 64,
      contentTypeUnknownCount: 1,
      toolNameUnknownCount: 1,
    });
    expect((generation?.['contentTypes'] as unknown[]).length).toBeLessThanOrEqual(16);
    expect((generation?.['toolNames'] as unknown[]).length).toBeLessThanOrEqual(16);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(maliciousToolName);
    expect(serialized).not.toContain(contentTypeCanary);
    expect(serialized).not.toContain(finishCanary);
    expect(result.content).toHaveLength(content.length);
    expect(result.finishReason.unified).toBe(finishCanary);
    expect(sdkFinishReasonValues).toEqual([
      'stop',
      'length',
      'content-filter',
      'tool-calls',
      'error',
      'interrupted',
      'other',
    ]);
  });

  it('wraps live seams without calling them and records only bounded generation metadata', async () => {
    const { app, root, plugin, model, calls } = fixture();
    const installed = (await evaluate(
      buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey),
      app,
      root,
    )) as {
      installed: boolean;
      preflight: Record<string, boolean>;
    };

    expect(installed.installed).toBe(true);
    expect(installed.preflight).toEqual({
      pluginPresent: true,
      modelSeam: true,
      searchSeam: true,
      readPageSeam: true,
      sentinelAbsent: true,
      expectedModelIdProvided: true,
      captureUrlsValid: true,
    });
    expect(calls).toEqual({ model: 0, search: 0, readPage: 0 });
    expect(plugin.providerConnections.model({ fixture: true })).toBe(model);

    const wrapped = plugin.providerConnections.model({ fixture: true });
    const result = await wrapped.doGenerate({
      prompt: ['never persist'],
      tools: [
        { type: 'function', name: 'research', inputSchema: { type: 'object' } },
      ] satisfies NonNullable<SdkTools>,
    });
    expect(result.finishReason.unified).toBe('tool-calls');

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as {
      generations: Array<Record<string, unknown>>;
      research: Array<Record<string, unknown>>;
      sdkInvocations: number;
    };
    expect(trace.sdkInvocations).toBe(1);
    expect(trace.generations[0]).toMatchObject({
      modelId: 'gpt-6-luna',
      finishReason: 'tool-calls',
      usage: { inputTokens: 7, outputTokens: 2 },
      contentTypes: ['text', 'tool-call'],
      toolNames: ['research'],
    });
    expect(JSON.stringify(trace)).not.toContain('private model text');
    expect(JSON.stringify(trace)).not.toContain('private');
    expect(JSON.stringify(trace)).not.toContain('tool_calls');
    expect(model.modelId).toBe('gpt-6-luna');
    expect(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey)).toContain(
      'window, app',
    );
    expect(buildNativeTraceReadEval(traceKey)).toContain(traceKey);
    expect(buildNativeTraceRestoreEval(traceKey)).toContain('window');
  });

  it('records only exact-URL page evidence, hashes metadata for other URLs, and caps adapter calls', async () => {
    const { app, root, plugin } = fixture();
    await evaluate(
      buildNativeTraceInstallEval(
        [pageUrl, 'https://example.test/another'],
        expectedModelId,
        traceKey,
      ),
      app,
      root,
    );
    await plugin.commandResearch.search('private search query');
    const exact = await plugin.commandResearch.readPage(pageUrl);
    expect(exact.sources[0]?.content).toHaveLength(8100);
    await expect(plugin.commandResearch.search('over-budget')).rejects.toThrow(
      'native-trace-budget-research',
    );
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as {
      researchCalls: number;
      budgetRejections: Array<Record<string, unknown>>;
      research: Array<Record<string, unknown>>;
    };
    expect(trace.researchCalls).toBe(2);
    expect(trace.budgetRejections).toEqual([{ kind: 'research', limit: 2 }]);
    expect(trace.research[0]).toMatchObject({ kind: 'search', status: 'ok' });
    expect(trace.research[1]).toMatchObject({
      kind: 'readPage',
      requestedUrl: pageUrl,
      pageKind: 'page-content',
      finalUrl: null,
      limitations: ['provider-extracted', 'freshness-unverified'],
      sourceUrl: pageUrl,
      evidence: 'provider-excerpt',
      pageTitle: 'Page title',
      contentLength: 8100,
      content: 'x'.repeat(8000),
    });
    expect(JSON.stringify(trace)).not.toContain('private search query');
    expect(JSON.stringify(trace)).not.toContain('private summary');
    expect(JSON.stringify(trace)).not.toContain('https://other.test/private');
    const unsupported = fixture();
    await evaluate(
      buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey),
      unsupported.app,
      unsupported.root,
    );
    await unsupported.plugin.commandResearch.readPage('https://other.test/private');
    expect(unsupported.calls.readPage).toBe(1);
    const unsupportedTrace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), unsupported.app, unsupported.root)),
    ) as {
      research: Array<Record<string, unknown>>;
    };
    expect(unsupportedTrace.research[0]).toMatchObject({
      requestedUrlMetadata: { length: 'https://other.test/private'.length },
    });
    expect(JSON.stringify(unsupportedTrace)).not.toContain('https://other.test/private');
    expect(JSON.stringify(unsupportedTrace)).not.toContain('x'.repeat(100));
  });

  it('rejects capture URLs with credentials, query, fragment, or excessive length', async () => {
    const invalidCaptureLists: Array<string | string[]> = [
      'https://user:secret@example.test/page',
      'https://example.test/page?token=secret',
      'https://example.test/page#private',
      `https://example.test/${'x'.repeat(2000)}`,
      [],
      Array.from({ length: 9 }, (_, index) => `https://example.test/${index}`),
    ];
    for (const invalidUrl of invalidCaptureLists) {
      const { app, root, calls } = fixture();
      const result = (await evaluate(
        buildNativeTraceInstallEval(invalidUrl, expectedModelId, traceKey),
        app,
        root,
      )) as { installed: boolean; preflight: Record<string, boolean> };
      expect(result.installed).toBe(false);
      expect(result.preflight['captureUrlsValid']).toBe(false);
      expect(calls).toEqual({ model: 0, search: 0, readPage: 0 });
    }
  });

  it('keeps absent usage unknown and normalizes errors without retaining messages', async () => {
    const safeCodes = [
      'timeout',
      'plan-revoke',
      'compatible-unavailable',
      'missing-key',
      'secret-storage',
      'authentication',
      'billing',
      'query-too-long',
    ];
    const errorCases = [
      ...safeCodes.map((code) => ({ code, expectedCode: code })),
      { code: 'secret-bearing-code', expectedCode: 'unknown' },
    ];
    for (const { code, expectedCode } of errorCases) {
      const { app, root, plugin } = fixture();
      plugin.providerConnections.model({ fixture: true }).doGenerate = async () => {
        throw Object.assign(new Error('secret-bearing provider message'), { code });
      };
      await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
      const model = plugin.providerConnections.model({ fixture: true });
      await expect(model.doGenerate({})).rejects.toMatchObject({ code });
      const trace = JSON.parse(
        String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
      ) as {
        generations: Array<Record<string, unknown>>;
      };
      expect(trace.generations[0]).toMatchObject({ errorCode: expectedCode });
      expect(trace.generations[0]).not.toHaveProperty('usage');
      expect(JSON.stringify(trace)).not.toContain('secret-bearing');
    }
  });

  it('enforces twelve actual generations and restores only its own wrappers idempotently', async () => {
    const { app, root, plugin, model } = fixture();
    let factoryCalls = 0;
    let replacementCalls = 0;
    const secondModel = {
      ...model,
      async doGenerate(_params: unknown) {
        expect(this).toBe(secondModel);
        return {
          content: [{ type: 'text', text: 'second model result' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        };
      },
    };
    plugin.providerConnections.model = function (selection: unknown) {
      expect(this).toBe(plugin.providerConnections);
      expect(selection).toEqual({ fixture: true });
      factoryCalls++;
      return factoryCalls % 2 === 0 ? secondModel : model;
    };
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = Object.getOwnPropertyDescriptor(plugin.providerConnections, 'model')?.value as (
      selection: unknown,
    ) => { doGenerate: (params: unknown) => Promise<unknown> };
    for (let index = 0; index < 12; index++) {
      await plugin.providerConnections.model({ fixture: true }).doGenerate({});
    }
    await expect(
      wrapped.call(plugin.providerConnections, { fixture: true }).doGenerate({}),
    ).rejects.toThrow('native-trace-budget-generation');
    const traceBeforeRestore = (await evaluate(
      `window[${JSON.stringify(traceKey)}].trace`,
      app,
      root,
    )) as { sdkInvocations: number };
    secondModel.doGenerate = async () => {
      replacementCalls++;
      return {
        content: [{ type: 'text', text: 'replacement result' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      };
    };
    const replacement = () => ({ modelId: 'other-actor' });
    plugin.providerConnections.model =
      replacement as unknown as typeof plugin.providerConnections.model;
    expect(await evaluate(buildNativeTraceRestoreEval(traceKey), app, root)).toMatchObject({
      restored: true,
    });
    expect(Object.getOwnPropertyDescriptor(plugin.providerConnections, 'model')?.value).toBe(
      replacement,
    );
    await model.doGenerate({});
    await secondModel.doGenerate({});
    expect(traceBeforeRestore.sdkInvocations).toBe(12);
    expect(replacementCalls).toBe(1);
    expect(await evaluate(buildNativeTraceRestoreEval(traceKey), app, root)).toMatchObject({
      restored: false,
    });
  });

  it('rejects a different returned model before any generation dispatch', async () => {
    const { app, root, plugin, model } = fixture();
    model.modelId = 'gpt-6-other';
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    expect(() => plugin.providerConnections.model({ fixture: true })).toThrow(
      'native-trace-model-mismatch',
    );
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { sdkInvocations: number; guardRejections: Array<Record<string, unknown>> };
    expect(trace.sdkInvocations).toBe(0);
    expect(trace.guardRejections).toEqual([{ kind: 'model-id-mismatch' }]);
  });
});
