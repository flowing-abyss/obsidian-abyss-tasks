import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool, wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { expect, it, vi } from 'vitest';
import { commandEditTools, modelToolSchema } from '../src/ai/commandModelSchema';
import { CommandReferenceBook } from '../src/ai/CommandReferenceBook';
import { changeTaskSchema } from '../src/ai/commandSchemas';
import { expectDefined } from './helpers';

type Params = Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['params'];
type Tools = NonNullable<Params['tools']>;
type IssuedRows = {
  taskReferences: Array<{ edit: string; target: string }>;
  commentReferences: Array<{ edit: string; target: string; ownerTarget: string }>;
};

async function modelTools(): Promise<Tools> {
  return [
    { type: 'function', name: 'find', inputSchema: { type: 'object' } },
    {
      type: 'function',
      name: 'change_task',
      inputSchema: await modelToolSchema(changeTaskSchema, 'change_task').jsonSchema,
    },
  ];
}

function field(tools: Params['tools']) {
  const tool = tools?.find((candidate) => candidate.name === 'change_task');
  const edit = tool?.type === 'function' ? tool.inputSchema.properties?.['edit'] : undefined;
  if (typeof edit !== 'object') throw new Error('Missing edit field');
  return edit;
}

function catalog(revision: string, targets = ['native-root', 'native-child']) {
  const editBasis = { kind: 'append', plan: 'native-plan', expectedPlanRevision: revision };
  return {
    taskReferences: targets.map((target) => ({
      kind: 'task',
      target,
      markdownTitle: 'Same private title',
      editBasis,
    })),
    commentReferences: [
      {
        kind: 'comment',
        target: 'native-comment',
        ownerTarget: 'native-child',
        text: 'Private comment body',
        editBasis,
      },
    ],
  };
}

it('advertises each exact issued edit with its subject and the comment owner on the provider schema', async () => {
  const book = new CommandReferenceBook('edit');
  const current = catalog('revision-one');
  const refs = book.project(current) as IssuedRows;
  const tools = await modelTools();
  const projected = commandEditTools(tools, book, () => current);
  const shown = field(projected);
  const [root, child] = refs.taskReferences.map((row) => row.edit);
  const comment = expectDefined(refs.commentReferences[0]);
  expect(shown.enum).toEqual([root, child, comment.edit]);
  for (const row of refs.taskReferences)
    expect(shown.description).toContain(`${row.edit} (task ${row.target})`);
  expect(shown.description).toContain(
    `${comment.edit} (comment ${comment.target} on ${comment.ownerTarget})`,
  );
  expect(shown.description).not.toMatch(/native-|private title|comment body|revision-one/iu);
  expect(projected?.[0]).toBe(tools[0]);
  expect(field(tools).enum).toBeUndefined();
  expect(book.edit(comment.edit, 'update-comment', current).target).toBe('native-comment');
  expect(() => book.edit(comment.edit, 'patch', current)).toThrow();
  expect(() => book.edit(expectDefined(refs.taskReferences[0]).target, 'patch', current)).toThrow();
});

it('rechecks immutable bases between generations and emits fresh handles only after the new row was issued', async () => {
  const book = new CommandReferenceBook('edit');
  const tools = await modelTools();
  const old = catalog('before');
  const current = catalog('after');
  const previous = book.project(old) as IssuedRows;
  const original = commandEditTools(tools, book, () => old);
  expect(commandEditTools(tools, book, () => current)).toBe(tools);
  const refreshed = book.project(current) as IssuedRows;
  const shown = commandEditTools(tools, book, () => current);
  expect(field(shown).enum).toEqual(
    [...refreshed.taskReferences, ...refreshed.commentReferences].map((row) => row.edit),
  );
  expect(field(original).enum).toEqual(
    [...previous.taskReferences, ...previous.commentReferences].map((row) => row.edit),
  );
  for (const row of previous.taskReferences)
    expect(() => book.edit(row.edit, 'patch', current)).toThrow();
  const otherOwner = catalog('after');
  expectDefined(otherOwner.commentReferences[0]).ownerTarget = 'native-root';
  expect(commandEditTools(tools, book, () => otherOwner)).toBe(tools);
  expect(() =>
    book.edit(expectDefined(refreshed.commentReferences[0]).edit, 'remove-comment', otherOwner),
  ).toThrow();
  expect(commandEditTools(tools, new CommandReferenceBook('later'), () => current)).toBe(tools);
});

it('leaves open schemas for discovery, incomplete, empty or oversized catalogs and skips inactive tools', async () => {
  const book = new CommandReferenceBook('edit');
  const tools = await modelTools();
  const current = catalog('now', ['native-root']);
  book.project({ ...expectDefined(current.taskReferences[0]), editBasis: undefined });
  expect(commandEditTools(tools, book, () => current)).toBe(tools);
  book.project(current);
  expect(commandEditTools(tools, book, () => ({ ...current, truncated: true }))).toBe(tools);
  expect(commandEditTools(tools, book, () => ({ taskReferences: [], commentReferences: [] }))).toBe(
    tools,
  );
  expect(commandEditTools(tools, book, () => ({ taskReferences: {} }))).toBe(tools);
  expect(commandEditTools(tools, book, () => catalog('now'))).toBe(tools);
  const many = catalog(
    'large',
    Array.from({ length: 20 }, (_, index) => `native-${index}`),
  );
  book.project(many);
  expect(commandEditTools(tools, book, () => many)).toBe(tools);
  const unused = vi.fn(() => {
    throw new Error('Unused snapshot');
  });
  expect(commandEditTools(undefined, book, unused)).toBeUndefined();
  expect(commandEditTools(tools, undefined, unused)).toBe(tools);
  const inactive = tools.slice(0, 1);
  expect(commandEditTools(inactive, book, unused)).toBe(inactive);
  expect(unused).not.toHaveBeenCalled();
});

it('sends the issued edit selection in one compatible chat request through SDK middleware', async () => {
  const book = new CommandReferenceBook('edit');
  const current = catalog('observed');
  const issued = book.project(current) as IssuedRows;
  const requests: unknown[] = [];
  const model = createOpenAI({
    name: 'openai-compatible',
    apiKey: 'fixture',
    fetch: async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected compatible JSON request');
      requests.push(JSON.parse(init.body) as unknown);
      return Response.json({
        id: 'fixture',
        model: 'fixture',
        created: 0,
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' },
        ],
      });
    },
  }).chat('fixture');
  await generateText({
    model: wrapLanguageModel({
      model,
      middleware: {
        wrapGenerate: ({ model: underlying, params }) => {
          const tools = commandEditTools(params.tools, book, () => current);
          return underlying.doGenerate({ ...params, ...(tools === undefined ? {} : { tools }) });
        },
      },
    }),
    prompt: 'Change the existing task.',
    tools: { change_task: tool({ inputSchema: modelToolSchema(changeTaskSchema, 'change_task') }) },
    maxRetries: 0,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toHaveProperty(
    'tools.0.function.parameters.properties.edit.enum',
    [...issued.taskReferences, ...issued.commentReferences].map((row) => row.edit),
  );
});
