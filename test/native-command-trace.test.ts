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

function replaceGenerate(model: ReturnType<typeof fixture>['model'], generate: SdkGenerate): void {
  Object.defineProperty(model, 'doGenerate', { value: generate });
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
  it('attributes bounded read inputs to deduplicated incoming structured tool results', async () => {
    const { app, root, plugin, model } = fixture();
    let generation = 0;
    const taskId = 'TASK_PRIVATE_CANARY';
    const query = 'QUERY_PRIVATE_CANARY';
    const rawCallId = 'CALL_ID_PRIVATE_CANARY';
    const canary = 'MESSAGE_PRIVATE_CANARY';
    model.doGenerate = async function (this: typeof model, params: unknown) {
      expect(this).toBe(model);
      generation++;
      if (generation === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolName: 'find',
              toolCallId: rawCallId,
              input: JSON.stringify({
                query,
                side: 'private-side-enum',
                privateFilter: taskId,
                limit: 3,
              }),
            },
          ],
          finishReason: { unified: 'tool-calls' },
          usage: {},
        };
      }
      expect(params).toMatchObject({
        prompt: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'find',
                output: { type: 'error-text', value: `Invalid API argument. ${canary}` },
              },
            ],
          },
          {
            role: 'system',
            content: [
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'find',
                output: { type: 'error-text', value: canary },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'find',
                output: { type: 'error-text', value: canary },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'find',
                output: { type: 'error-text', value: { wrong: 'shape' } },
              },
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'find',
                output: { type: 'error-text', value: 'Invalid API argument.' },
              },
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'find',
                output: { type: 'error-text', value: `Invalid API argument. ${canary}` },
              },
              {
                type: 'tool-result',
                toolCallId: 'UNKNOWN_CALL_ID_CANARY',
                toolName: 'UNDECLARED_TOOL_NAME_CANARY',
                output: { type: 'error-text', value: canary },
              },
            ],
          },
        ],
      });
      return {
        content: [{ type: 'text', text: 'private response' }],
        finishReason: { unified: 'stop' },
        usage: {},
      };
    } as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'find',
              output: { type: 'error-text', value: `Invalid API argument. ${canary}` },
            },
          ],
        },
        {
          role: 'system',
          content: [
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'find',
              output: { type: 'error-text', value: canary },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'find',
              output: { type: 'error-text', value: canary },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'find',
              output: { type: 'error-text', value: { wrong: 'shape' } },
            },
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'find',
              output: { type: 'error-text', value: 'Invalid API argument.' },
            },
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'find',
              output: { type: 'error-text', value: `Invalid API argument. ${canary}` },
            },
            {
              type: 'tool-result',
              toolCallId: 'UNKNOWN_CALL_ID_CANARY',
              toolName: 'UNDECLARED_TOOL_NAME_CANARY',
              output: { type: 'error-text', value: canary },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as {
      generations: Array<Record<string, unknown>>;
    };
    expect(trace.generations[0]).toMatchObject({
      readInputs: [
        {
          sourceName: 'find',
          generationOrdinal: 1,
          callOrdinal: 1,
          representation: 'json-string',
          keys: ['query', 'side', 'limit'],
          unknownKeyCount: 1,
          query: { type: 'string', length: query.length },
          side: { type: 'string', enum: 'other', length: 'private-side-enum'.length },
          limit: { type: 'number', value: 3 },
        },
      ],
    });
    expect(trace.generations[1]?.['toolResults']).toEqual([
      {
        sourceName: 'find',
        generationOrdinal: 1,
        callOrdinal: 1,
        resultKind: 'error',
        errorClassification: 'invalid-api-argument',
        codeUnavailable: true,
        validationUnavailable: true,
      },
    ]);
    expect(trace.generations[1]).toMatchObject({
      toolResultsOmittedCount: 1,
      toolResultsTruncated: true,
      toolResultsFailureCount: 1,
      toolResultsUnattributedCount: 0,
    });
    const serialized = JSON.stringify(trace);
    for (const privateValue of [
      taskId,
      query,
      rawCallId,
      canary,
      'private-side-enum',
      'private response',
      'UNKNOWN_CALL_ID_CANARY',
      'UNDECLARED_TOOL_NAME_CANARY',
    ])
      expect(serialized).not.toContain(privateValue);
  });

  it('keeps only allowlisted structured code and validation path data and omits terminal outcomes', async () => {
    const { app, root, plugin, model } = fixture();
    let generation = 0;
    const rawCallId = 'STRUCTURED_CALL_ID_CANARY';
    const privatePath = 'PRIVATE_PATH_CANARY';
    const privatePrompt = 'PRIVATE_PROMPT_CANARY';
    const rawPath = [
      'read',
      'input',
      'target',
      2,
      privatePath,
      ...Array.from({ length: 9 }, () => privatePath),
    ];
    model.doGenerate = async function (this: typeof model, params: unknown) {
      expect(this).toBe(model);
      generation++;
      if (generation === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolName: 'inspect',
              toolCallId: rawCallId,
              input: {
                read: {
                  input: JSON.stringify({
                    kind: 'tree',
                    side: 'after',
                    target: 'HANDLE_PRIVATE_CANARY',
                    privateKey: privatePath,
                  }),
                },
              },
            },
          ],
          finishReason: { unified: 'tool-calls' },
          usage: {},
        };
      }
      expect(params).toMatchObject({
        prompt: [
          { role: 'system', content: privatePrompt },
          { role: 'user', content: privatePrompt },
          { role: 'assistant', content: privatePrompt },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: rawCallId,
                toolName: 'inspect',
                output: {
                  type: 'error-json',
                  value: {
                    code: 'INVALID_ARGUMENT',
                    validationPath: rawPath,
                    message: privatePath,
                    cause: { message: privatePrompt },
                  },
                },
              },
            ],
          },
        ],
      });
      return {
        content: [
          {
            type: 'tool-call',
            toolName: 'read',
            toolCallId: 'TERMINAL_CALL_ID_CANARY',
            input: '{malformed PRIVATE_INPUT_CANARY',
          },
          {
            type: 'tool-call',
            toolName: 'read',
            toolCallId: 'OVERSIZED_CALL_ID_CANARY',
            input: 'x'.repeat(16385),
          },
        ],
        finishReason: { unified: 'tool-calls' },
        usage: {},
      };
    } as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'inspect', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'read', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({
      tools,
      prompt: [
        { role: 'system', content: privatePrompt },
        { role: 'user', content: privatePrompt },
        { role: 'assistant', content: privatePrompt },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: rawCallId,
              toolName: 'inspect',
              output: {
                type: 'error-json',
                value: {
                  code: 'INVALID_ARGUMENT',
                  validationPath: rawPath,
                  message: privatePath,
                  cause: { message: privatePrompt },
                },
              },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as {
      generations: Array<Record<string, unknown>>;
    };
    expect(trace.generations[0]).toMatchObject({
      readInputs: [
        {
          sourceName: 'inspect',
          generationOrdinal: 1,
          callOrdinal: 1,
          read: {
            keys: ['input'],
            input: {
              representation: 'json-string',
              keys: ['kind', 'side', 'target'],
              unknownKeyCount: 1,
              target: { type: 'string', length: 'HANDLE_PRIVATE_CANARY'.length, issued: 'unknown' },
            },
          },
        },
      ],
    });
    expect(trace.generations[1]?.['toolResults']).toEqual([
      {
        sourceName: 'inspect',
        generationOrdinal: 1,
        callOrdinal: 1,
        resultKind: 'error',
        code: 'INVALID_ARGUMENT',
        codeUnavailable: false,
        validationPath: [
          { key: 'read' },
          { key: 'input' },
          { key: 'target' },
          { index: 2 },
          { key: 'unknown' },
          { key: 'unknown' },
          { key: 'unknown' },
          { key: 'unknown' },
          { key: 'unknown' },
          { key: 'unknown' },
          { key: 'unknown' },
          { key: 'unknown' },
        ],
        validationPathTruncated: true,
        validationPathOmittedCount: 2,
        validationPathOmittedCountTruncated: false,
        validationUnavailable: false,
      },
    ]);
    expect(trace.generations[1]?.['readInputs']).toEqual([
      {
        sourceName: 'read',
        generationOrdinal: 2,
        callOrdinal: 1,
        representation: 'invalid-json',
        inputParseFailed: true,
      },
      {
        sourceName: 'read',
        generationOrdinal: 2,
        callOrdinal: 2,
        representation: 'oversized-string',
        inputTruncated: true,
      },
    ]);
    expect(trace.generations[2]).toBeUndefined();
    const serialized = JSON.stringify(trace);
    for (const privateValue of [
      rawCallId,
      privatePath,
      privatePrompt,
      'HANDLE_PRIVATE_CANARY',
      'PRIVATE_INPUT_CANARY',
      'TERMINAL_CALL_ID_CANARY',
      'OVERSIZED_CALL_ID_CANARY',
    ])
      expect(serialized).not.toContain(privateValue);
  });

  it('marks incoming tool results omitted beyond the prompt observation cap', async () => {
    const { app, root, plugin, model } = fixture();
    let generation = 0;
    const rawCallId = 'TRUNCATED_RESULT_CALL_ID_CANARY';
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      generation++;
      if (generation === 1) {
        return {
          content: [
            { type: 'tool-call', toolName: 'read', toolCallId: rawCallId, input: { kind: 'tags' } },
          ],
          finishReason: { unified: 'tool-calls' },
          usage: {},
        };
      }
      return { content: [], finishReason: { unified: 'stop' }, usage: {} };
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'read', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    const cappedPrompt = [
      {
        role: 'tool',
        content: [
          ...Array.from({ length: 64 }, (_, index) => ({
            type: 'tool-approval-response' as const,
            approvalId: `PRIVATE_OMITTED_PROMPT_CANARY_${index}`,
            approved: true,
          })),
          {
            type: 'tool-result',
            toolCallId: rawCallId,
            toolName: 'read',
            output: { type: 'error-text', value: 'Invalid API argument.' },
          },
        ],
      },
    ];
    await wrapped.doGenerate({ tools, prompt: cappedPrompt });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[1]).toMatchObject({
      toolResultsOmittedCount: 1,
      toolResultsTruncated: true,
    });
    expect(trace.generations[1]?.['toolResults']).toBeUndefined();
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(rawCallId);
    expect(serialized).not.toContain('PRIVATE_OMITTED_PROMPT_CANARY');
  });

  it('bounds nested, shared, and cyclic read input shapes and marks references unissued', async () => {
    const { app, root, plugin, model } = fixture();
    const shared = { target: 'PRIVATE_SHARED_HANDLE', expectedRevision: 'PRIVATE_REVISION' };
    const dateNode: Record<string, unknown> = { field: 'due', from: 'PRIVATE_DATE_FROM' };
    dateNode['dates'] = [dateNode];
    let deepBranch: Record<string, unknown> = shared;
    for (let index = 0; index < 8; index++) deepBranch = { selector: deepBranch };
    const cyclic: Record<string, unknown> = {
      kind: 'tasks',
      selector: deepBranch,
      linkFor: deepBranch,
      target: 'PRIVATE_ROOT_HANDLE',
      dates: [dateNode],
    };
    cyclic['input'] = cyclic;
    for (let index = 0; index < 40; index++)
      cyclic[`PRIVATE_UNKNOWN_KEY_${index}`] = `PRIVATE_UNKNOWN_VALUE_${index}`;
    const makeWideTree = (depth: number): Record<string, unknown> => ({
      kind: 'tasks',
      dates:
        depth === 0
          ? []
          : Array.from({ length: 6 }, () => ({
              field: 'due',
              dates: makeWideTree(depth - 1)['dates'],
            })),
    });
    const result = {
      content: [
        {
          type: 'tool-call',
          toolName: 'inspect',
          toolCallId: 'CYCLE_INPUT_ID_CANARY',
          input: cyclic,
        },
        {
          type: 'tool-call',
          toolName: 'read',
          toolCallId: 'NODE_BUDGET_ID_CANARY',
          input: makeWideTree(4),
        },
      ],
      finishReason: { unified: 'tool-calls' },
      usage: {},
    };
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      return result;
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'inspect', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'read', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await expect(wrapped.doGenerate({ tools, prompt: [] })).resolves.toBe(result);
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    const inputs = trace.generations[0]?.['readInputs'] as Array<Record<string, unknown>>;
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs)).toContain('repeated-reference');
    expect(JSON.stringify(inputs)).toContain('depth-limit');
    expect(JSON.stringify(inputs)).toContain('node-limit');
    expect(JSON.stringify(inputs)).toContain('"issued":"unknown"');
    expect(JSON.stringify(inputs)).toContain('keyScanTruncated');
    expect(JSON.stringify(inputs)).toContain('omittedKeyCountAtLeast');
    expect(trace.generations[0]).toMatchObject({ readInputsTruncated: true });
    const serialized = JSON.stringify(trace);
    for (const privateValue of [
      'PRIVATE_SHARED_HANDLE',
      'PRIVATE_REVISION',
      'PRIVATE_DATE_FROM',
      'PRIVATE_ROOT_HANDLE',
      'CYCLE_INPUT_ID_CANARY',
      'NODE_BUDGET_ID_CANARY',
      'PRIVATE_UNKNOWN_KEY_',
      'PRIVATE_UNKNOWN_VALUE_',
    ])
      expect(serialized).not.toContain(privateValue);
  });

  it('registers read calls beyond the shape cap and retains mixed-batch ordinals', async () => {
    const { app, root, plugin, model } = fixture();
    let generation = 0;
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      generation++;
      if (generation === 1) {
        return {
          content: [
            { type: 'tool-call', toolName: 'research', toolCallId: 'OTHER_TOOL_ID', input: {} },
            ...Array.from({ length: 9 }, (_, index) => ({
              type: 'tool-call',
              toolName: 'find',
              toolCallId: `READ_CAP_ID_${index + 1}`,
              input: { query: `PRIVATE_QUERY_${index + 1}` },
            })),
          ],
          finishReason: { unified: 'tool-calls' },
          usage: {},
        };
      }
      return { content: [], finishReason: { unified: 'stop' }, usage: {} };
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'research', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'READ_CAP_ID_9',
              toolName: 'find',
              output: { type: 'json', value: { private: 'PRIVATE_RESULT' } },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]).toMatchObject({
      readInputOmittedCount: 1,
      readInputsTruncated: true,
    });
    const retainedReadInputs = trace.generations[0]?.['readInputs'] as Array<
      Record<string, unknown>
    >;
    expect(retainedReadInputs.some((input) => input['callOrdinal'] === 2)).toBe(true);
    expect(retainedReadInputs.some((input) => input['callOrdinal'] === 9)).toBe(true);
    expect(retainedReadInputs).toHaveLength(8);
    expect(trace.generations[1]?.['toolResults']).toEqual([
      {
        sourceName: 'find',
        generationOrdinal: 1,
        callOrdinal: 10,
        resultKind: 'result',
        codeUnavailable: true,
        validationUnavailable: true,
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_QUERY_');
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_RESULT');
  });

  it('keeps generation ordinals stable for overlapping calls and out-of-order host results', async () => {
    const { app, root, plugin, model } = fixture();
    let providerCalls = 0;
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => (enterFirst = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      providerCalls++;
      if (providerCalls === 1) {
        enterFirst();
        await firstGate;
        return {
          content: [
            { type: 'tool-call', toolName: 'research', toolCallId: 'FIRST_OTHER_ID', input: {} },
            {
              type: 'tool-call',
              toolName: 'find',
              toolCallId: 'FIRST_READ_ID',
              input: { query: 'PRIVATE_FIRST_QUERY' },
            },
          ],
          finishReason: { unified: 'tool-calls' },
          usage: {},
        };
      }
      if (providerCalls === 2) {
        return {
          content: [
            { type: 'tool-call', toolName: 'research', toolCallId: 'SECOND_OTHER_ID', input: {} },
            {
              type: 'tool-call',
              toolName: 'inspect',
              toolCallId: 'SECOND_READ_ID',
              input: { kind: 'tree' },
            },
          ],
          finishReason: { unified: 'tool-calls' },
          usage: {},
        };
      }
      return { content: [], finishReason: { unified: 'stop' }, usage: {} };
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'research', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'inspect', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    const firstCall = wrapped.doGenerate({ tools, prompt: [] });
    await firstEntered;
    await wrapped.doGenerate({ tools, prompt: [] });
    releaseFirst();
    await firstCall;
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'SECOND_READ_ID',
              toolName: 'inspect',
              output: { type: 'error-text', value: 'second' },
            },
            {
              type: 'tool-result',
              toolCallId: 'FIRST_READ_ID',
              toolName: 'find',
              output: { type: 'error-text', value: 'first' },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    const generationOne = trace.generations.find((entry) => entry['index'] === 1);
    const generationTwo = trace.generations.find((entry) => entry['index'] === 2);
    const generationThree = trace.generations.find((entry) => entry['index'] === 3);
    expect(generationOne?.['readInputs']).toMatchObject([
      { sourceName: 'find', generationOrdinal: 1, callOrdinal: 2 },
    ]);
    expect(generationTwo?.['readInputs']).toMatchObject([
      { sourceName: 'inspect', generationOrdinal: 2, callOrdinal: 2 },
    ]);
    expect(generationThree?.['toolResults']).toMatchObject([
      { sourceName: 'inspect', generationOrdinal: 2, callOrdinal: 2 },
      { sourceName: 'find', generationOrdinal: 1, callOrdinal: 2 },
    ]);
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_FIRST_QUERY');
    expect(JSON.stringify(trace)).not.toContain('FIRST_READ_ID');
    expect(JSON.stringify(trace)).not.toContain('SECOND_READ_ID');
  });

  it('keeps source registration after input observation fails and deduplicates only accepted host envelopes', async () => {
    const { app, root, plugin, model } = fixture();
    const callId = 'RECOVERABLE_CALL_ID_CANARY';
    let providerCalls = 0;
    const result = {
      content: [
        Object.defineProperties(
          { type: 'tool-call', toolName: 'find', toolCallId: callId },
          {
            input: {
              get() {
                throw new Error('PRIVATE_INPUT_GETTER_ERROR');
              },
            },
          },
        ),
      ],
      finishReason: { unified: 'tool-calls' },
      usage: {},
    };
    model.doGenerate = async function (this: typeof model) {
      expect(this).toBe(model);
      providerCalls++;
      return providerCalls === 1 ? result : returned;
    } as unknown as typeof model.doGenerate;
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await expect(wrapped.doGenerate({ tools, prompt: [] })).resolves.toBe(result);
    const outputValue = Object.defineProperty({}, 'type', {
      get() {
        throw new Error('PRIVATE_OUTPUT_GETTER_ERROR');
      },
    });
    const returned = {
      content: [],
      finishReason: { unified: 'stop' },
      usage: {},
    };
    const params = {
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: callId, toolName: 'find', output: outputValue },
            {
              type: 'tool-result',
              toolCallId: callId,
              toolName: 'find',
              output: { type: 'error-text', value: 'Invalid API argument.' },
            },
          ],
        },
      ],
    };
    await expect(wrapped.doGenerate(params)).resolves.toBe(returned);
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]).toMatchObject({
      readInputFailureCount: 1,
      readInputOmittedCount: 1,
      readCallRegistrationOmittedCount: 0,
    });
    expect(trace.generations[1]?.['toolResults']).toEqual([
      {
        sourceName: 'find',
        generationOrdinal: 1,
        callOrdinal: 1,
        resultKind: 'error',
        errorClassification: 'invalid-api-argument',
        codeUnavailable: true,
        validationUnavailable: true,
      },
    ]);
    expect(trace.generations[1]).toMatchObject({
      toolResultsFailureCount: 1,
      toolResultsOmittedCount: 1,
      toolResultsTruncated: true,
    });
    expect(JSON.stringify(trace)).not.toContain(callId);
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_INPUT_GETTER_ERROR');
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_OUTPUT_GETTER_ERROR');
  });

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

  it('classifies find and interpret controls without retaining values or ID text', async () => {
    const { app, root, plugin, model } = fixture();
    const enumCanary = 'UNKNOWN_ENUM_SECRET_CANARY';
    const idCanary = 'PRIVATE_TASK_ID_CANARY';
    let generation = 0;
    replaceGenerate(model, async () => {
      generation++;
      const content: SdkGenerationResult['content'] = [
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-change-call',
          input: JSON.stringify({
            purpose: 'change',
            showExact: true,
            taskId: idCanary,
            retryOf: 'PRIVATE_FIND_EVIDENCE_CANARY',
            query: 'PRIVATE_QUERY_CANARY',
            path: 'PRIVATE_PATH_CANARY',
          }),
        },
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-omitted-call',
          input: '{}',
        },
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-invalid-call',
          input: JSON.stringify({
            purpose: enumCanary,
            showExact: 'PRIVATE_BOOLEAN_CANARY',
            taskId: { value: idCanary },
            retryOf: 42,
          }),
        },
        {
          type: 'tool-call',
          toolName: 'assess_research',
          toolCallId: 'assess-enabled-call',
          input: JSON.stringify({
            authorized: true,
            requiresTaskPreparation: false,
            reason: 'PRIVATE_REASON_CANARY',
          }),
        },
        {
          type: 'tool-call',
          toolName: 'assess_research',
          toolCallId: 'assess-denied-call',
          input: JSON.stringify({ authorized: false }),
        },
        {
          type: 'tool-call',
          toolName: 'assess_research',
          toolCallId: 'assess-invalid-call',
          input: JSON.stringify({
            authorized: enumCanary,
            requiresTaskPreparation: 'PRIVATE_REQUIRES_PREPARATION_CANARY',
            reason: 'PRIVATE_REASON_CANARY',
          }),
        },
        {
          type: 'tool-call',
          toolName: 'assess_research',
          toolCallId: 'assess-omitted-call',
          input: '{}',
        },
        {
          type: 'tool-call',
          toolName: 'interpret',
          toolCallId: 'interpret-plan-call',
          input: JSON.stringify({ intent: 'plan', approval: 'PRIVATE_APPROVAL_CANARY' }),
        },
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-command-input-cap-call',
          input: JSON.stringify({ purpose: 'show-only' }),
        },
        {
          type: 'tool-call',
          toolName: 'interpret',
          toolCallId: 'interpret-invalid-call',
          input: JSON.stringify({ intent: enumCanary }),
        },
        {
          type: 'tool-call',
          toolName: 'interpret',
          toolCallId: 'interpret-omitted-call',
          input: '{}',
        },
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-show-exact-false-call',
          input: JSON.stringify({ showExact: false }),
        },
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-malformed-call',
          input: `{${enumCanary}`,
        },
        {
          type: 'tool-call',
          toolName: 'find',
          toolCallId: 'find-oversized-call',
          input: 'x'.repeat(16385),
        },
      ];
      return {
        content: generation === 1 ? content.slice(0, 9) : content.slice(9),
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    });
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const tools = [
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'interpret', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'assess_research', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    const wrapped = plugin.providerConnections.model({ fixture: true });
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({ tools, prompt: [] });

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]?.['commandInputs']).toMatchObject([
      {
        sourceName: 'find',
        generationOrdinal: 1,
        callOrdinal: 1,
        purpose: { status: 'allowed', value: 'change' },
        showExact: { status: 'valid', value: true },
        taskId: { status: 'present', shape: { type: 'string', length: idCanary.length } },
        retryOf: {
          status: 'present',
          shape: { type: 'string', length: 'PRIVATE_FIND_EVIDENCE_CANARY'.length },
          issued: 'unknown',
        },
      },
      {
        sourceName: 'find',
        callOrdinal: 2,
        purpose: { status: 'omitted' },
        showExact: { status: 'omitted' },
        taskId: { status: 'omitted' },
        retryOf: { status: 'omitted' },
      },
      {
        sourceName: 'find',
        callOrdinal: 3,
        purpose: { status: 'invalid', shape: { type: 'string', length: enumCanary.length } },
        showExact: {
          status: 'invalid',
          shape: { type: 'string', length: 'PRIVATE_BOOLEAN_CANARY'.length },
        },
        taskId: { status: 'invalid', shape: { type: 'object' } },
        retryOf: { status: 'invalid', shape: { type: 'number' }, issued: 'unknown' },
      },
      {
        sourceName: 'assess_research',
        callOrdinal: 4,
        authorized: { status: 'valid', value: true },
        requiresTaskPreparation: { status: 'valid', value: false },
      },
      {
        sourceName: 'assess_research',
        callOrdinal: 5,
        authorized: { status: 'valid', value: false },
        requiresTaskPreparation: { status: 'omitted' },
      },
      {
        sourceName: 'assess_research',
        callOrdinal: 6,
        authorized: { status: 'invalid', shape: { type: 'string', length: enumCanary.length } },
        requiresTaskPreparation: {
          status: 'invalid',
          shape: { type: 'string', length: 'PRIVATE_REQUIRES_PREPARATION_CANARY'.length },
        },
      },
      {
        sourceName: 'assess_research',
        callOrdinal: 7,
        authorized: { status: 'omitted' },
        requiresTaskPreparation: { status: 'omitted' },
      },
      {
        sourceName: 'interpret',
        callOrdinal: 8,
        intent: { status: 'allowed', value: 'plan' },
      },
    ]);
    expect(trace.generations[0]).toMatchObject({
      commandInputOmittedCount: 1,
      commandInputsTruncated: true,
    });
    expect(trace.generations[1]?.['commandInputs']).toMatchObject([
      {
        sourceName: 'interpret',
        generationOrdinal: 2,
        callOrdinal: 1,
        intent: { status: 'invalid', shape: { type: 'string', length: enumCanary.length } },
      },
      {
        sourceName: 'interpret',
        generationOrdinal: 2,
        callOrdinal: 2,
        intent: { status: 'omitted' },
      },
      {
        sourceName: 'find',
        generationOrdinal: 2,
        callOrdinal: 3,
        showExact: { status: 'valid', value: false },
      },
      {
        sourceName: 'find',
        generationOrdinal: 2,
        callOrdinal: 4,
        representation: 'invalid-json',
        fieldsUnavailable: true,
      },
      {
        sourceName: 'find',
        generationOrdinal: 2,
        callOrdinal: 5,
        representation: 'oversized-string',
        fieldsUnavailable: true,
      },
    ]);
    const serialized = JSON.stringify(trace);
    for (const canary of [
      enumCanary,
      idCanary,
      'PRIVATE_REQUIRES_PREPARATION_CANARY',
      'PRIVATE_FIND_EVIDENCE_CANARY',
      'PRIVATE_BOOLEAN_CANARY',
      'PRIVATE_APPROVAL_CANARY',
      'PRIVATE_REASON_CANARY',
      'PRIVATE_QUERY_CANARY',
      'PRIVATE_PATH_CANARY',
    ])
      expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('find-change-call');
  });

  it('attributes finish outcomes to accepted calls and keeps unknown results explicit', async () => {
    const { app, root, plugin, model } = fixture();
    const canary = 'PRIVATE_FINISH_DIAGNOSTIC_CANARY';
    let generation = 0;
    replaceGenerate(model, async () => {
      generation++;
      if (generation === 1)
        return {
          content: [
            {
              type: 'tool-call',
              toolName: 'finish',
              toolCallId: 'finish-rejected-call',
              input: JSON.stringify({ state: 'ready', message: canary }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        };
      if (generation === 2)
        return {
          content: [
            {
              type: 'tool-call',
              toolName: 'finish',
              toolCallId: 'finish-success-call',
              input: JSON.stringify({ state: 'ready' }),
            },
            {
              type: 'tool-call',
              toolName: 'finish',
              toolCallId: 'finish-unknown-code-call',
              input: JSON.stringify({ state: 'ready' }),
            },
            {
              type: 'tool-call',
              toolName: 'finish',
              toolCallId: 'finish-unavailable-result-call',
              input: JSON.stringify({ state: 'ready' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        };
      return {
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    });
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'finish', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    const rejectedResult = {
      type: 'tool-result',
      toolCallId: 'finish-rejected-call',
      toolName: 'finish',
      output: {
        type: 'error-json',
        value: {
          code: 'PENDING_TASK_CHANGE',
          validationPath: ['finish', 'state', canary],
          message: canary,
          unknownPrivateField: canary,
        },
      },
    };
    await wrapped.doGenerate({
      tools,
      prompt: [{ role: 'tool', content: [rejectedResult, rejectedResult] }],
    });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'finish-success-call',
              toolName: 'interpret',
              output: { type: 'json', value: { finished: true } },
            },
            {
              type: 'tool-result',
              toolCallId: 'finish-success-call',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true, result: 'prepared' } },
            },
            {
              type: 'tool-result',
              toolCallId: 'finish-unknown-code-call',
              toolName: 'finish',
              output: {
                type: 'error-json',
                value: {
                  code: 'UNKNOWN_FINISH_SECRET_CODE',
                  validationPath: ['finish', canary],
                  message: canary,
                  privateFieldName: canary,
                  cause: { code: canary, privateMessage: canary },
                },
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'finish-unavailable-result-call',
              toolName: 'finish',
              output: { type: 'unsupported-private-output', value: canary },
            },
            {
              type: 'tool-result',
              toolCallId: 'unattributed-finish-call',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'finish-success-call',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
          ],
        },
      ],
    });

    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[1]?.['toolResults']).toMatchObject([
      {
        sourceName: 'finish',
        generationOrdinal: 1,
        callOrdinal: 1,
        finishOutcome: 'rejected',
        code: 'PENDING_TASK_CHANGE',
        validationPath: [{ key: 'finish' }, { key: 'state' }, { key: 'unknown' }],
      },
    ]);
    expect(trace.generations[2]?.['toolResults']).toMatchObject([
      {
        sourceName: 'finish',
        generationOrdinal: 2,
        callOrdinal: 1,
        finishOutcome: 'accepted',
      },
      {
        sourceName: 'finish',
        generationOrdinal: 2,
        callOrdinal: 2,
        resultKind: 'error',
        finishOutcome: 'rejected',
        codeUnavailable: true,
        validationPath: [{ key: 'finish' }, { key: 'unknown' }],
      },
      {
        sourceName: 'finish',
        generationOrdinal: 2,
        callOrdinal: 3,
        resultKind: 'unknown',
        finishOutcome: 'unknown',
        resultUnavailable: true,
      },
    ]);
    expect(trace.generations[2]).toMatchObject({
      toolResultsUnattributedCount: 1,
      toolResultsFailureCount: 1,
    });
    expect(JSON.stringify(trace)).not.toContain(canary);
    expect(JSON.stringify(trace)).not.toContain('finish-rejected-call');
    expect(JSON.stringify(trace)).not.toContain('finish-success-call');
    expect(JSON.stringify(trace)).not.toContain('unattributed-finish-call');
  });

  it('registers the ninth finish call independently of the eight retained input shapes', async () => {
    const { app, root, plugin, model } = fixture();
    const missingInput = {
      type: 'tool-call' as const,
      toolName: 'finish',
      toolCallId: 'missing-input-call',
      input: '{}',
    };
    Reflect.deleteProperty(missingInput, 'input');
    const mixedCalls: SdkGenerationResult['content'] = [
      {
        type: 'tool-call',
        toolName: 'find',
        toolCallId: 'non-finish-call',
        input: '{}',
      },
      missingInput,
      ...Array.from({ length: 8 }, (_, index) => ({
        type: 'tool-call' as const,
        toolName: 'finish',
        toolCallId: `finish-call-${index + 3}`,
        input: '{}',
      })),
    ];
    let generation = 0;
    replaceGenerate(model, async () => {
      generation++;
      return {
        content: generation === 1 ? mixedCalls : [],
        finishReason: { unified: generation === 1 ? 'tool-calls' : 'stop', raw: 'fixture' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    });
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'finish', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'finish-call-10',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    const finishInputs = trace.generations[0]?.['finishInputs'] as Array<Record<string, unknown>>;
    expect(finishInputs).toHaveLength(8);
    expect(finishInputs[0]).toMatchObject({ representation: 'missing', inputParseFailed: true });
    expect(trace.generations[0]).toMatchObject({
      finishInputOmittedCount: 1,
      finishInputsTruncated: true,
    });
    expect(trace.generations[1]?.['toolResults']).toMatchObject([
      {
        sourceName: 'finish',
        generationOrdinal: 1,
        callOrdinal: 10,
        finishOutcome: 'accepted',
      },
    ]);
  });

  it('records a throwing finish input and still registers later finish calls', async () => {
    const { app, root, plugin, model } = fixture();
    const throwingInput = {
      type: 'tool-call' as const,
      toolName: 'finish',
      toolCallId: 'throwing-finish-input-call',
      input: '{}',
    };
    Object.defineProperty(throwingInput, 'input', {
      get() {
        throw new Error('PRIVATE_THROWING_INPUT_CANARY');
      },
    });
    let generation = 0;
    replaceGenerate(model, async () => {
      generation++;
      return {
        content:
          generation === 1
            ? [
                throwingInput,
                {
                  type: 'tool-call',
                  toolName: 'finish',
                  toolCallId: 'after-throwing-finish-input-call',
                  input: '{}',
                },
              ]
            : [],
        finishReason: { unified: generation === 1 ? 'tool-calls' : 'stop', raw: 'fixture' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    });
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'finish', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'after-throwing-finish-input-call',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[0]).toMatchObject({
      finishInputFailureCount: 1,
      finishInputsTruncated: true,
    });
    expect(trace.generations[1]?.['toolResults']).toMatchObject([
      { sourceName: 'finish', generationOrdinal: 1, callOrdinal: 2, finishOutcome: 'accepted' },
    ]);
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_THROWING_INPUT_CANARY');
  });

  it('reports invalid and full-registry finish registration without inferring attribution', async () => {
    const { app, root, plugin, model } = fixture();
    const firstCalls: SdkGenerationResult['content'] = Array.from({ length: 64 }, (_, index) => ({
      type: 'tool-call' as const,
      toolName: 'find',
      toolCallId: `registered-find-${index}`,
      input: '{}',
    }));
    const secondCalls: SdkGenerationResult['content'] = Array.from({ length: 64 }, (_, index) => ({
      type: 'tool-call' as const,
      toolName: 'find',
      toolCallId: `registered-find-${index + 64}`,
      input: '{}',
    }));
    const overflowCalls: SdkGenerationResult['content'] = [
      { type: 'tool-call', toolName: 'finish', toolCallId: '', input: '{}' },
      { type: 'tool-call', toolName: 'finish', toolCallId: 'over-cap-finish', input: '{}' },
    ];
    let generation = 0;
    replaceGenerate(model, async () => {
      generation++;
      let content: SdkGenerationResult['content'] = overflowCalls;
      if (generation === 1) content = firstCalls;
      else if (generation === 2) content = secondCalls;
      return {
        content,
        finishReason: { unified: generation === 1 ? 'tool-calls' : 'stop', raw: 'fixture' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    });
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'finish', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'find', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({ tools, prompt: [] });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: '',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
            {
              type: 'tool-result',
              toolCallId: 'over-cap-finish',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
          ],
        },
      ],
    });
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: '',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
            {
              type: 'tool-result',
              toolCallId: 'over-cap-finish',
              toolName: 'finish',
              output: { type: 'json', value: { finished: true } },
            },
          ],
        },
      ],
    });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[2]).toMatchObject({
      finishCallRegistrationOmittedCount: 2,
      finishInputOmittedCount: 0,
      finishInputsTruncated: true,
    });
    expect(trace.generations[3]).toMatchObject({
      toolResultsUnattributedCount: 1,
      toolResultsFailureCount: 1,
    });
    expect(trace.generations[3]?.['toolResults']).toBeUndefined();
  });

  it('retains valid finish outcomes after malformed result envelopes and deduplicates accepted results', async () => {
    const { app, root, plugin, model } = fixture();
    let generation = 0;
    replaceGenerate(model, async () => {
      generation++;
      return {
        content:
          generation === 1
            ? [
                {
                  type: 'tool-call',
                  toolName: 'finish',
                  toolCallId: 'malformed-then-accepted-call',
                  input: '{}',
                },
                {
                  type: 'tool-call',
                  toolName: 'finish',
                  toolCallId: 'malformed-then-rejected-call',
                  input: '{}',
                },
              ]
            : [],
        finishReason: { unified: generation === 1 ? 'tool-calls' : 'stop', raw: 'fixture' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    });
    await evaluate(buildNativeTraceInstallEval(pageUrl, expectedModelId, traceKey), app, root);
    const wrapped = plugin.providerConnections.model({ fixture: true });
    const tools = [
      { type: 'function' as const, name: 'finish', inputSchema: { type: 'object' } },
    ] satisfies NonNullable<SdkTools>;
    await wrapped.doGenerate({ tools, prompt: [] });
    const malformedAccepted = {
      type: 'tool-result' as const,
      toolCallId: 'malformed-then-accepted-call',
      toolName: 'finish',
      output: { type: 'json' as const, value: {} },
    };
    Object.defineProperty(malformedAccepted.output, 'type', {
      get() {
        return 'unsupported-private-output';
      },
    });
    const malformedRejected = {
      type: 'tool-result' as const,
      toolCallId: 'malformed-then-rejected-call',
      toolName: 'finish',
      output: { type: 'json' as const, value: {} },
    };
    Object.defineProperty(malformedRejected.output, 'type', {
      get() {
        return 'unsupported-private-output';
      },
    });
    const accepted = {
      type: 'tool-result' as const,
      toolCallId: 'malformed-then-accepted-call',
      toolName: 'finish',
      output: { type: 'json' as const, value: { finished: true } },
    };
    const rejected = {
      type: 'tool-result' as const,
      toolCallId: 'malformed-then-rejected-call',
      toolName: 'finish',
      output: {
        type: 'error-json' as const,
        value: { code: 'PENDING_TASK_CHANGE', validationPath: ['finish', 'state'] },
      },
    };
    await wrapped.doGenerate({
      tools,
      prompt: [
        {
          role: 'tool',
          content: [malformedAccepted, accepted, accepted, malformedRejected, rejected],
        },
      ],
    });
    await wrapped.doGenerate({ tools, prompt: [{ role: 'tool', content: [accepted, rejected] }] });
    const trace = JSON.parse(
      String(await evaluate(buildNativeTraceReadEval(traceKey), app, root)),
    ) as { generations: Array<Record<string, unknown>> };
    expect(trace.generations[1]?.['toolResults']).toMatchObject([
      { callOrdinal: 1, resultKind: 'unknown', finishOutcome: 'unknown' },
      { callOrdinal: 1, resultKind: 'result', finishOutcome: 'accepted' },
      { callOrdinal: 2, resultKind: 'unknown', finishOutcome: 'unknown' },
      { callOrdinal: 2, resultKind: 'error', finishOutcome: 'rejected' },
    ]);
    expect(trace.generations[2]?.['toolResults']).toBeUndefined();
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_MALFORMED_OUTPUT_CANARY');
  });
});
