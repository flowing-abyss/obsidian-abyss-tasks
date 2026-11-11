import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { asSchema, generateText, jsonSchema, tool } from 'ai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { modelToolSchema } from '../src/ai/commandModelSchema';
import {
  controlSchema,
  createTaskSchema,
  finishSchema,
  intentSchema,
  notePrepareSchema,
  projectStageSchema,
  readSchema,
  taskArgumentsSchema,
} from '../src/ai/commandSchemas';

it('keeps interpretation independent of task preparation and rejects bundled work', async () => {
  const schema = modelToolSchema(intentSchema);
  expect(JSON.stringify(await schema.jsonSchema)).not.toContain('"work"');
  expect(JSON.stringify(await schema.jsonSchema)).not.toContain('"capabilities"');
  expect(await schema.validate?.({ intent: 'plan', research: false })).toHaveProperty(
    'success',
    true,
  );
  expect(await schema.validate?.({ intent: 'plan', research: false, work: {} })).toHaveProperty(
    'success',
    false,
  );
});

it('preserves branch operands, nested operations and canonical validation', async () => {
  const schema = modelToolSchema(taskArgumentsSchema);
  const advertised = await schema.jsonSchema;
  expect(advertised).toHaveProperty('properties.input.type', 'object');
  expect(advertised).toHaveProperty('properties.input.oneOf', expect.any(Array));
  const serialized = JSON.stringify(advertised);
  expect(serialized).toContain('"required":["kind","destination","tree"]');
  expect(serialized).toContain('"required":["type","target","markdownTitle"]');
  expect(serialized).toContain('"enum":["add-child"]');
  expect(await schema.validate?.({ input: { kind: 'create' } })).toHaveProperty('success', false);
  expect(
    await schema.validate?.({
      input: {
        kind: 'create',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: 'Parent', children: [{ markdownTitle: 'Child' }] },
      },
    }),
  ).toHaveProperty('success', true);
  expect(
    await schema.validate?.({
      input: {
        kind: 'append',
        plan: 'p',
        expectedPlanRevision: 'r',
        operation: { type: 'add-child', target: 't', patch: {} },
      },
    }),
  ).toHaveProperty('success', false);
});
it('keeps overlapping alternatives as anyOf and exposes exclusive required fields', async () => {
  const overlapping = z.union([
    z.object({ value: z.string() }),
    z.object({ value: z.string().min(1) }),
  ]);
  expect(await modelToolSchema(overlapping).jsonSchema).toHaveProperty('anyOf');
  const schema = z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.string() })]);
  expect(await modelToolSchema(schema).jsonSchema).toHaveProperty('oneOf');
  expect(await asSchema(schema).validate?.({ a: 'x', b: 'y' })).toHaveProperty('success', false);
});
it('preserves the conjunction when a custom schema already has both union keywords', async () => {
  const anyOf = [
    {
      type: 'object' as const,
      required: ['a'],
      properties: { a: { type: 'string' as const } },
      additionalProperties: false,
    },
    {
      type: 'object' as const,
      required: ['b'],
      properties: { b: { type: 'string' as const } },
      additionalProperties: false,
    },
  ];
  const oneOf = [{ required: ['a'] }, { required: ['c'] }];
  const advertised = await modelToolSchema(jsonSchema({ anyOf, oneOf })).jsonSchema;
  expect(advertised.anyOf).toEqual(anyOf);
  expect(advertised.oneOf).toEqual(oneOf);
});
it('does not broaden a conflicting const/enum', async () => {
  const literal = await modelToolSchema(jsonSchema({ const: 'a', enum: ['b'] })).jsonSchema;
  expect(literal.enum).toEqual(['b']);
});
it('does not treat pattern-covered fields as exclusive', async () => {
  const overlapping = await modelToolSchema(
    jsonSchema({
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        {
          type: 'object',
          patternProperties: { '^a$': { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
      ],
    }),
  ).jsonSchema;
  expect(overlapping).toHaveProperty('anyOf');
  expect(overlapping).not.toHaveProperty('oneOf');
});
it('advertises projects and note selectors without fields from other read branches', async () => {
  const schema = await modelToolSchema(readSchema).jsonSchema;
  expect(schema).toHaveProperty('oneOf');
  const branches = schema.oneOf ?? [];
  expect(branches).toEqual(
    containsItems([
      partialShape({
        properties: partialShape({
          kind: partialShape({ enum: ['projects'] }),
        }),
        additionalProperties: false,
      }),
      partialShape({ required: containsItems(['kind', 'selector']) }),
    ]),
  );
});

function partialShape(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value) as unknown;
}
function containsItems(value: readonly unknown[]): unknown {
  return expect.arrayContaining([...value]) as unknown;
}

it.each(['#/properties/value~1~0/anyOf/0', '#%2Fproperties%2Fvalue~1~0%2FanyOf%2F0'])(
  'keeps references into exclusive alternatives valid: %s',
  async (pointer) => {
    const schema = modelToolSchema(
      jsonSchema({
        type: 'object',
        properties: {
          'value/~': {
            anyOf: [
              {
                type: 'object',
                properties: { a: { type: 'string' } },
                required: ['a'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { b: { type: 'string' } },
                required: ['b'],
                additionalProperties: false,
              },
            ],
          },
          copy: { $ref: pointer },
        },
      }),
    );
    const advertised = await schema.jsonSchema;
    const ref = advertised.properties?.['copy'];
    if (typeof ref !== 'object') throw new Error('Missing copy schema');
    expect(resolvePointer(advertised, ref.$ref ?? '')).toMatchObject({ required: ['a'] });
  },
);

it('projects schema positions without changing literal defaults or examples', async () => {
  const literal = { const: 'authored', definitions: { anyOf: [{ $ref: '#/literal' }] } };
  const advertised = await modelToolSchema(
    jsonSchema({
      type: 'object',
      default: literal,
      examples: [literal],
    }),
  ).jsonSchema;
  expect(advertised.default).toEqual(literal);
  expect(advertised.examples).toEqual([literal]);
});

it('treats keyword-shaped property names as map keys', async () => {
  const value = { type: 'string' as const, const: 'fixed' };
  const advertised = await modelToolSchema(
    jsonSchema({
      type: 'object',
      properties: Object.fromEntries(
        ['definitions', '$defs', 'anyOf', 'oneOf', 'const', '$ref'].map((name) => [name, value]),
      ),
    }),
  ).jsonSchema;
  for (const name of ['definitions', '$defs', 'anyOf', 'oneOf', 'const', '$ref']) {
    expect(advertised.properties?.[name]).toEqual({ ...value, enum: ['fixed'] });
  }
});

it('sends modern recursive task definitions through the pinned OpenRouter adapter with canonical validation intact', async () => {
  const schema = modelToolSchema(taskArgumentsSchema, 'task');
  let payload: unknown;
  const model = createOpenRouter({
    apiKey: 'synthetic-test-key',
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      payload = JSON.parse(init.body) as unknown;
      return new Response(
        JSON.stringify({
          id: 'synthetic',
          model: 'synthetic',
          object: 'chat.completion',
          created: 0,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  }).chat('synthetic');
  await generateText({
    model,
    prompt: 'Prepare a task',
    tools: { task: tool({ inputSchema: schema }) },
    maxRetries: 0,
  });
  expect(payload).toHaveProperty(
    'tools.0.function.parameters.$schema',
    'https://json-schema.org/draft/2020-12/schema',
  );
  const advertised = await schema.jsonSchema;
  expect(payload).toHaveProperty('tools.0.function.parameters', advertised);
  expect(advertised).not.toHaveProperty('definitions');
  expect(advertised).toHaveProperty('$defs');
  const refs = localReferences(advertised);
  expect(refs.length).toBeGreaterThan(1);
  for (const ref of refs) expect(resolvePointer(advertised, ref)).toBeDefined();
  expect(refs.some((ref, index) => refs.indexOf(ref) !== index)).toBe(true);
  let tree: { markdownTitle: string; children?: unknown[] } = { markdownTitle: 'Leaf' };
  for (let depth = 0; depth < 12; depth++)
    tree = { markdownTitle: `Level ${depth}`, children: [tree] };
  expect(
    await schema.validate?.({
      input: { kind: 'create', destination: { type: 'configured-default' }, tree },
    }),
  ).toHaveProperty('success', true);
  expect(
    await schema.validate?.({
      input: {
        kind: 'create',
        destination: { type: 'configured-default' },
        tree: { markdownTitle: '' },
      },
    }),
  ).toHaveProperty('success', false);
});

it('keeps Zod defaults and refinements at the execution boundary', async () => {
  const schema = modelToolSchema(
    z.object({ value: z.string().default('kept') }).refine((input) => input.value !== 'reject'),
  );
  expect(await schema.validate?.({})).toEqual({ success: true, value: { value: 'kept' } });
  expect(await schema.validate?.({ value: 'reject' })).toHaveProperty('success', false);
});

function resolvePointer(root: unknown, ref: string): unknown {
  const fragment = decodeURIComponent(ref.slice(1));
  if (fragment === '') return root;
  if (!ref.startsWith('#') || !fragment.startsWith('/'))
    throw new Error(`Not a local pointer: ${ref}`);
  return fragment
    .slice(1)
    .split('/')
    .reduce<unknown>((value, token) => {
      if (value === null || typeof value !== 'object') return undefined;
      return Reflect.get(value, token.replaceAll('~1', '/').replaceAll('~0', '~')) as unknown;
    }, root);
}
function localReferences(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]: [string, unknown]) =>
    key === '$ref' && typeof child === 'string' && child.startsWith('#')
      ? [child]
      : localReferences(child),
  );
}

it('exposes only applicable strict control fields and pending transition branches', async () => {
  const initial = modelToolSchema(controlSchema(false));
  for (const input of [
    { intent: 'plan', voiceMode: 'manual' },
    { intent: 'plan', scope: {} },
    { intent: 'confirm', research: true },
    { intent: 'voice-mode', disposition: 'keep' },
    { intent: 'resolve-transition', transitionDisposition: 'cancel' },
    { intent: 'plan', transitionDisposition: 'keep' },
  ])
    expect(await initial.validate?.(input)).toHaveProperty('success', false);
  expect(await initial.validate?.({ intent: 'voice-mode', voiceMode: 'manual' })).toHaveProperty(
    'success',
    true,
  );
  expect(
    await modelToolSchema(controlSchema(true)).validate?.({
      intent: 'resolve-transition',
      transitionDisposition: 'cancel',
    }),
  ).toHaveProperty('success', true);
});

it.each([
  [
    'finish',
    finishSchema,
    {
      wrapper: undefined,
      names: ['state', 'message', 'selection', 'blockingIssue'],
      required: ['state'],
    },
  ],
  [
    'interpret',
    controlSchema(false),
    { wrapper: undefined, names: ['intent', 'scope', 'voiceMode'], required: ['intent'] },
  ],
  [
    'project',
    projectStageSchema,
    { wrapper: undefined, names: ['kind', 'name', 'fields'], required: [] },
  ],
  [
    'task',
    taskArgumentsSchema,
    { wrapper: 'input', names: ['kind', 'tree', 'operation'], required: ['kind'] },
  ],
  [
    'read',
    z.strictObject({ input: readSchema }),
    { wrapper: 'input', names: ['kind', 'query', 'target'], required: ['kind'] },
  ],
  [
    'note',
    z.strictObject({ input: notePrepareSchema }),
    { wrapper: 'input', names: ['kind', 'title', 'operation'], required: ['kind'] },
  ],
] as const)(
  'exposes owned %s argument names without replacing its union',
  async (name, input, expected) => {
    const original = await modelToolSchema<unknown>(input).jsonSchema;
    const visible = await modelToolSchema<unknown>(input, name).jsonSchema;
    const baseline =
      expected.wrapper === undefined ? original : original.properties?.[expected.wrapper];
    const shown = expected.wrapper === undefined ? visible : visible.properties?.[expected.wrapper];
    if (typeof baseline !== 'object' || typeof shown !== 'object')
      throw new Error('Missing schema');
    expect(Object.keys(shown.properties ?? {})).toEqual(
      expect.arrayContaining([...expected.names]),
    );
    expect(shown.required ?? []).toEqual([...expected.required]);
    expect(shown.anyOf).toEqual(baseline.anyOf);
    expect(shown.oneOf).toEqual(baseline.oneOf);
  },
);
it('advertises actual finish and control discriminator enums', async () => {
  expect((await modelToolSchema(finishSchema, 'finish').jsonSchema).properties?.['state']).toEqual({
    type: 'string',
    enum: ['ready', 'question'],
  });
  expect(
    (await modelToolSchema(controlSchema(false), 'interpret').jsonSchema).properties?.['intent'],
  ).toHaveProperty('enum', expect.arrayContaining(['confirm', 'immediate']));
});
it('shows one creation-tree level while retaining recursive definition and canonical rejection', async () => {
  const original = await modelToolSchema(createTaskSchema).jsonSchema;
  const schema = modelToolSchema(createTaskSchema, 'create_task');
  const shown = await schema.jsonSchema;
  const tree = shown.properties?.['tree'];
  if (typeof tree !== 'object') throw new Error('Missing tree');
  expect(tree.$ref).toBe((original.properties?.['tree'] as { $ref: string }).$ref);
  expect(tree.type).toBe('object');
  expect(tree.required).toEqual(['markdownTitle']);
  expect(tree.properties?.['initial']).toHaveProperty('properties.scheduled');
  expect(tree.properties?.['initial']).toHaveProperty('properties.time');
  expect(tree.properties?.['children']).toHaveProperty('items.$ref', tree.$ref);
  expect(shown.$defs).toEqual(original.$defs);
  for (const ref of localReferences(shown)) expect(resolvePointer(shown, ref)).toBeDefined();
  expect(
    await schema.validate?.({
      tree: {
        markdownTitle: 'Read',
        initial: {
          scheduled: { type: 'set', value: '2027-03-18' },
          time: { type: 'set', value: '09:30' },
        },
        children: [{ markdownTitle: 'Child', children: [{ markdownTitle: 'Leaf' }] }],
      },
    }),
  ).toHaveProperty('success', true);
  expect(
    await schema.validate?.({ tree: { markdownTitle: 'Read', scheduled: '2027-03-18' } }),
  ).toHaveProperty('success', false);
});
it('keeps malformed finish and mixed controls invalid despite visible mirrors', async () => {
  const finish = modelToolSchema(finishSchema, 'finish');
  for (const input of [
    {},
    { ready: { message: 'Ready.' } },
    { message: 'Ready.' },
    { state: 'ready', message: 'Ready.', blockingIssue: { kind: 'conflict', detail: 'Conflict' } },
    { state: 'ready', message: 'Ready.', selection: [{ kind: 'task', target: 't' }] },
  ])
    expect(await finish.validate?.(input)).toHaveProperty('success', false);
  expect(await finish.validate?.({ state: 'ready', message: 'Ready.' })).toHaveProperty(
    'success',
    true,
  );
  expect(
    await modelToolSchema(controlSchema(false), 'interpret').validate?.({
      intent: 'confirm',
      approval: 'Save it.',
    }),
  ).toHaveProperty('success', true);
  expect(
    await modelToolSchema(controlSchema(false), 'interpret').validate?.({
      intent: 'confirm',
      research: true,
    }),
  ).toHaveProperty('success', false);
});
it('leaves custom SDK and open-branch schemas outside the property-mirror scope', async () => {
  const custom = jsonSchema({
    anyOf: [
      {
        type: 'object',
        properties: { state: { const: 'ready' } },
        required: ['state'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { state: { const: 'question' } },
        required: ['state'],
        additionalProperties: false,
      },
    ],
    $defs: {
      tree: { type: 'object', properties: { children: { items: { $ref: '#/$defs/tree' } } } },
    },
    properties: { tree: { $ref: '#/$defs/tree' } },
  });
  for (const name of ['finish', 'create_task'])
    expect(await modelToolSchema(custom, name).jsonSchema).toEqual(
      await modelToolSchema(custom).jsonSchema,
    );
  const open = z.union([
    z.looseObject({ state: z.literal('ready') }),
    z.strictObject({ state: z.literal('question'), detail: z.string() }),
  ]);
  expect(await modelToolSchema(open, 'finish').jsonSchema).not.toHaveProperty('properties');
});

it.each(['$id', '$anchor', '$dynamicAnchor'])(
  'does not duplicate Zod metadata that defines a %s resource',
  async (key) => {
    const input = z.union([
      z.strictObject({ kind: z.literal('a'), value: z.string().meta({ [key]: 'local-resource' }) }),
      z.strictObject({ kind: z.literal('b'), other: z.string() }),
    ]);
    expect(await modelToolSchema(input, 'finish').jsonSchema).toEqual(
      await modelToolSchema(input).jsonSchema,
    );
  },
);
it('admits every numeric discriminator branch in redundant presentation', async () => {
  const schema = z.union([
    z.strictObject({ kind: z.literal(1) }),
    z.strictObject({ kind: z.literal(2) }),
  ]);
  const visible = await modelToolSchema(schema, 'project').jsonSchema;
  expect(visible.properties?.['kind']).toEqual({ enum: [1, 2] });
});
