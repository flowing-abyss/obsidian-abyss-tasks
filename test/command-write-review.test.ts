import { MockLanguageModelV4 } from 'ai/test';
import { expect, it } from 'vitest';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';
import {
  authorizeCommandWrite,
  reviewCommandWrite,
  type WriteReview,
} from '../src/ai/commandWriteAuthorization';
import { commandScopeCoversWholeProposal } from '../src/ai/commandWriteSubjects';

const message = 'Сохрани оба комментария.';

function response(input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'assess-write',
        toolName: 'assess_write',
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

function reviewRequest(extraDescription: boolean): WriteReview {
  return {
    userMessage: message,
    proposedMode: 'confirm',
    proposedScope: 'all',
    fieldsOnly: false,
    selections: [],
    displayed: [
      {
        kind: 'edit',
        owner: { title: 'Изучить Cairn', path: 'projects/Launch.md' },
        prepared: [
          ...(extraDescription
            ? [{ field: 'description', previous: 'Original', prepared: 'Updated description' }]
            : []),
          {
            field: 'comments',
            removed: [],
            added: [{ text: 'Purpose and storage.' }, { text: 'Features and limits.' }],
          },
        ],
      },
    ],
    pendingQuestion: null,
    pendingTransition: false,
    saveInstruction: message,
  };
}

async function captureReview(request: WriteReview, decision: unknown) {
  let requestText = '';
  const model = new MockLanguageModelV4({
    doGenerate: async (input) => {
      requestText = JSON.stringify(input);
      return response(decision);
    },
  });
  const result = await reviewCommandWrite(model, request, new AbortController().signal);
  return { requestText, result };
}

it('sends the exact current assent and complete comment-only proposal to the reviewer', async () => {
  const decision = {
    effect: 'save-reviewed',
    scope: 'all',
    scopeMatches: true,
    authorization: message,
  };
  const { requestText, result } = await captureReview(reviewRequest(false), decision);

  expect(requestText).toContain(message);
  expect(requestText).toContain('\\"field\\":\\"comments\\"');
  expect(requestText).toContain('Purpose and storage.');
  expect(requestText).toContain('Features and limits.');
  expect(requestText).toContain(
    'If any unmentioned changed field, owner or pending change remains',
  );
  expect(result).toEqual(decision);
});

it('sends an extra prepared field alongside the comments so the reviewer can refuse it', async () => {
  const decision = {
    effect: 'preview',
    scope: 'none',
    scopeMatches: false,
    authorization: '',
  };
  const { requestText, result } = await captureReview(reviewRequest(true), decision);

  expect(requestText).toContain(message);
  expect(requestText).toContain('\\"field\\":\\"description\\"');
  expect(requestText).toContain('Updated description');
  expect(requestText).toContain('\\"field\\":\\"comments\\"');
  expect(result).toEqual(decision);
});

it('does not grant a save when the reviewer refuses an unmentioned pending owner', async () => {
  const basis = {
    id: 'session',
    input: message,
    focus: [],
    context: '',
    trees: [],
    entities: { tasks: [], projects: [], notes: [] },
    exchanges: [],
    activeQuestion: null,
    status: { kind: 'ready', message: '' },
    proposal: {
      revision: 1,
      operations: 1,
      changes: [
        {
          kind: 'project-create',
          id: 'pending-project',
          name: 'Unmentioned project',
          schema: {
            providerEpoch: 'epoch',
            revision: 1,
            generation: 1,
            scopeRevision: 0,
            semanticsRevision: 1,
            statuses: [],
            fields: [],
          },
        },
      ],
    },
    journal: [],
    actual: [],
    blocked: false,
  } satisfies CommandSessionSnapshot;

  await expect(
    authorizeCommandWrite(
      { intent: 'confirm', approval: message } as Parameters<typeof authorizeCommandWrite>[0],
      {
        userMessage: message,
        basis,
        review: async (request) => {
          expect(request.displayed).toEqual([
            {
              index: 0,
              kind: 'project-create',
              owner: { project: 'Unmentioned project' },
              prepared: { fields: undefined, status: undefined },
            },
          ]);
          return {
            effect: 'preview',
            scope: 'none',
            scopeMatches: false,
            authorization: '',
          };
        },
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toMatchObject({ code: 'WRITE_DENIED' });
});

it('rejects immediate reviewed-save when the canonical displayed proposal is empty', async () => {
  const basis = {
    id: 'session',
    input: message,
    focus: [],
    context: '',
    trees: [],
    entities: { tasks: [], projects: [], notes: [] },
    exchanges: [],
    activeQuestion: null,
    status: { kind: 'ready', message: '' },
    proposal: { revision: 1, operations: 0, changes: [] },
    journal: [],
    actual: [],
    blocked: false,
  } satisfies CommandSessionSnapshot;

  await expect(
    authorizeCommandWrite(
      {
        intent: 'immediate',
        approval: message,
        saveInstruction: message,
      } as Parameters<typeof authorizeCommandWrite>[0],
      {
        userMessage: message,
        basis,
        review: async (request) => {
          expect(request.displayed).toEqual([]);
          return {
            effect: 'save-reviewed',
            scope: 'all',
            scopeMatches: true,
            authorization: message,
          };
        },
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
});

it.each([
  [
    'duplicate index',
    2,
    [
      { kind: 'change', index: 0 },
      { kind: 'change', index: 0 },
    ],
  ],
  ['partial owner selection', 2, [{ kind: 'change', index: 0 }]],
] as const)('does not treat a %s as complete scope coverage', async (_case, count, changes) => {
  const projectChange = (index: number) => ({
    kind: 'project-create' as const,
    id: `pending-project-${index}`,
    name: `Project ${index}`,
    schema: {
      providerEpoch: 'epoch',
      revision: 1,
      generation: 1,
      scopeRevision: 0,
      semanticsRevision: 1,
      statuses: [],
      fields: [],
    },
  });
  const basis = {
    id: 'session',
    input: message,
    focus: [],
    context: '',
    trees: [],
    entities: { tasks: [], projects: [], notes: [] },
    exchanges: [],
    activeQuestion: null,
    status: { kind: 'ready', message: '' },
    proposal: {
      revision: 1,
      operations: count,
      changes: Array.from({ length: count }, (_, index) => projectChange(index)),
    },
    journal: [],
    actual: [],
    blocked: false,
  } satisfies CommandSessionSnapshot;

  await expect(
    authorizeCommandWrite(
      {
        intent: 'confirm',
        research: false,
        approval: message,
        scope: { proposalRevision: 1, changes },
      } as unknown as Parameters<typeof authorizeCommandWrite>[0],
      {
        userMessage: message,
        basis,
        review: async () => ({
          effect: 'save-reviewed',
          scope: 'all',
          scopeMatches: true,
          authorization: message,
        }),
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toMatchObject({ code: 'WRITE_NOT_AUTHORIZED' });
});

it.each([
  [
    'field-only scope',
    [
      {
        kind: 'task-fields' as const,
        index: 0,
        plan: 'plan',
        expectedPlanRevision: '1',
        target: 'task',
        fields: ['due' as const],
      },
      {
        kind: 'task-fields' as const,
        index: 1,
        plan: 'plan',
        expectedPlanRevision: '1',
        target: 'task-2',
        fields: ['due' as const],
      },
    ],
  ],
  [
    'mixed field and whole-change scope',
    [
      {
        kind: 'task-fields' as const,
        index: 0,
        plan: 'plan',
        expectedPlanRevision: '1',
        target: 'task',
        fields: ['due' as const],
      },
      { kind: 'change' as const, index: 1 },
    ],
  ],
] as const)('never proves a %s as complete whole-change coverage', (_case, changes) => {
  const basis = {
    proposal: { revision: 1, changes: [{}, {}] },
  } as unknown as CommandSessionSnapshot;
  expect(commandScopeCoversWholeProposal(basis, { proposalRevision: 1, changes })).toBe(false);
});

it.each(['stale revision', 'out-of-range owner'] as const)(
  'rejects complete-scope equivalence with a %s',
  async (invalid) => {
    const basis = {
      id: 'session',
      input: message,
      focus: [],
      context: '',
      trees: [],
      entities: { tasks: [], projects: [], notes: [] },
      exchanges: [],
      activeQuestion: null,
      status: { kind: 'ready', message: '' },
      proposal: {
        revision: 1,
        operations: 1,
        changes: [
          {
            kind: 'project-create' as const,
            id: 'pending-project',
            name: 'Pending project',
            schema: {
              providerEpoch: 'epoch',
              revision: 1,
              generation: 1,
              scopeRevision: 0,
              semanticsRevision: 1,
              statuses: [],
              fields: [],
            },
          },
        ],
      },
      journal: [],
      actual: [],
      blocked: false,
    } satisfies CommandSessionSnapshot;
    const scope = {
      proposalRevision: invalid === 'stale revision' ? 0 : 1,
      changes: [{ kind: 'change' as const, index: invalid === 'out-of-range owner' ? 1 : 0 }],
    };
    await expect(
      authorizeCommandWrite(
        { intent: 'confirm', research: false, approval: message, scope } as unknown as Parameters<
          typeof authorizeCommandWrite
        >[0],
        {
          userMessage: message,
          basis,
          review: async () => ({
            effect: 'save-reviewed',
            scope: 'all',
            scopeMatches: true,
            authorization: message,
          }),
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'WRITE_SCOPE' });
  },
);
