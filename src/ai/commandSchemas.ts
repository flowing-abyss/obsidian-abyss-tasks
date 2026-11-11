import { z } from 'zod';
import type {
  ContentPlanV1,
  MutationResultV1,
  NoteMutationResultV1,
  NotePlanV1,
  ProjectMutationResultV1,
  TaskContentMutationResultV1,
  TaskCreateTreeV1,
  TaskTreeV1,
} from '../../api';
import { inlineCodeRanges } from '../markdown/inlineCode';
import { buildLinkRaw, parseSourceReferences } from '../markdown/links';
import {
  CommandFailure,
  type CommandChange,
  type CommandJournalEntry,
  type CommandNoteRead,
  type CommandPreparation,
  type CommandProposal,
  type CommandSessionSnapshot,
} from './commandTypes';
export const creationGrammar =
  '`{"tree":{"markdownTitle":"Read","initial":{"scheduled":{"type":"set","value":"2027-03-18"},"time":{"type":"set","value":"09:30"}}}}`';
export const finishGrammar =
  '`{"state":"ready"}` or `{"state":"question","message":"Which date?","blockingIssue":{"kind":"missing-information","detail":"Date unspecified"}}`';
const handle = z.string().min(1).max(512);
const text = z.string().max(16000);
const activityTitle = text
  .min(1)
  .describe(
    'Keep explicit titles; otherwise concise user-language activity. Schedule in metadata; invent no facts.',
  );
const field = (value: z.ZodType): z.ZodType =>
  z.union([
    z.strictObject({ type: z.literal('set'), value }),
    z.strictObject({ type: z.literal('clear') }),
  ]);
const patchSchema = z.strictObject({
  markdownTitle: field(text).optional(),
  priority: field(z.enum(['A', 'B', 'C', 'D', 'E', 'F'])).optional(),
  due: field(z.string()).optional().describe('Deadline, not merely a planned work date.'),
  scheduled: field(z.string()).optional().describe('Planned work date.'),
  start: field(z.string()).optional().describe('Not-before date.'),
  time: field(z.string()).optional(),
  durationMinutes: field(z.number().nonnegative()).optional(),
  recurrence: field(
    z
      .string()
      .describe(
        'English recurrence: "every week on Wednesday", "every 3 days", "every weekday"; "when done" only completion-relative. No localized weekday/time/count/until; keep separate date/time.',
      ),
  ).optional(),
  onCompletion: field(z.enum(['keep', 'delete'])).optional(),
  tags: z
    .strictObject({
      add: z.array(z.string()).max(50).optional(),
      remove: z.array(z.string()).max(50).optional(),
    })
    .optional(),
});
const initial = patchSchema
  .omit({ markdownTitle: true })
  .extend({ statusSymbol: z.string().length(1).optional() });
const seed: z.ZodType<TaskCreateTreeV1> = z.lazy(() =>
  z.strictObject({
    markdownTitle: activityTitle,
    initial: initial.optional(),
    description: text.optional(),
    comments: z.array(z.strictObject({ text })).max(50).optional(),
    children: z.array(seed).max(50).optional(),
  }),
) as z.ZodType<TaskCreateTreeV1>;
const insertion = z.union([
  z.strictObject({ type: z.enum(['append', 'prepend']) }),
  z.strictObject({
    type: z.literal('section'),
    heading: z.string().min(1),
    position: z.enum(['top', 'bottom']).optional(),
  }),
]);
const destination = z.union([
  z.strictObject({ type: z.literal('configured-default') }),
  z.strictObject({
    type: z.literal('note'),
    path: z.string().min(1),
    insertion,
    provision: z.literal('if-missing').optional(),
  }),
  z.strictObject({ type: z.literal('project'), target: handle, expectedRevision: handle }),
]);
const operationVariants = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('reorder'),
    target: handle,
    relativeTo: handle,
    placement: z.enum(['before', 'after']),
  }),
  z.strictObject({ type: z.literal('patch'), target: handle, patch: patchSchema }),
  z.strictObject({ type: z.literal('description'), target: handle, text: text.nullable() }),
  z.strictObject({ type: z.literal('add-child'), target: handle, markdownTitle: activityTitle }),
  z.strictObject({ type: z.literal('remove'), target: handle }),
  z.strictObject({ type: z.literal('add-comment'), target: handle, text }),
  z.strictObject({ type: z.literal('update-comment'), target: handle, text }),
  z.strictObject({ type: z.literal('remove-comment'), target: handle }),
  z.strictObject({
    type: z.literal('set-initial-status'),
    target: handle,
    symbol: z.string().length(1),
  }),
  z.strictObject({ type: z.literal('copy-comment'), source: handle, target: handle }),
  z.strictObject({
    type: z.literal('copy-subtree'),
    source: handle,
    expectedSourceRevision: handle,
    target: handle,
  }),
  z.strictObject({
    type: z.literal('assess-merge'),
    source: handle,
    expectedSourceRevision: handle,
    target: handle,
  }),
]);
const operationSchema = modelSchema(operationVariants);
export const prepareSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hierarchy'),
    operation: z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('reparent'),
        source: handle,
        expectedSourceRevision: handle,
        parent: handle,
        expectedParentRevision: handle,
      }),
      z.strictObject({
        type: z.literal('promote'),
        source: handle,
        expectedSourceRevision: handle,
      }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('create'),
    intent: z.literal('inbox').optional(),
    destination,
    tree: seed,
  }),
  z.strictObject({
    kind: z.literal('edit'),
    target: handle,
    expectedRevision: handle,
    operation: operationSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('append'),
    plan: handle,
    expectedPlanRevision: handle,
    operation: operationSchema,
  }),
  z.strictObject({ kind: z.literal('refresh'), plan: handle, expectedPlanRevision: handle }),
]);
const taskOperationTypes = new Set<unknown>([
  ...operationVariants.options.map((option) => option.shape.type.value),
  ...prepareSchema.options[0].shape.operation.options.map((option) => option.shape.type.value),
]);
/** Unknown discriminator spellings identify no executable operation for repair bookkeeping. */
export function isTaskOperationType(value: unknown): boolean {
  return taskOperationTypes.has(value);
}
const batchOptions = operationVariants.options.filter(
  (option) => !['update-comment', 'remove-comment'].includes(option.shape.type.value),
) as [
  (typeof operationVariants.options)[number],
  ...Array<(typeof operationVariants.options)[number]>,
];
const batchOperationSchema = z.discriminatedUnion('type', batchOptions);
export const batchSchema = z.strictObject({
  kind: z.literal('batch'),
  plan: handle,
  expectedPlanRevision: handle,
  operations: z.array(modelSchema(batchOperationSchema)).min(1).max(20),
});
const taskToolSchema = z.discriminatedUnion('kind', [...prepareSchema.options, batchSchema]);
export const taskArgumentsSchema = z.strictObject({
  input: modelSchema(taskToolSchema).describe(
    'Object, never encoded JSON. Use each target’s own editBasis: saved edit or exact pending append/batch.',
  ),
  removeAnnotations: z.array(z.string()).max(50).optional(),
});
const saveScopeSchema = z.strictObject({
  proposalRevision: z.number().int().nonnegative(),
  changes: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('change'), index: z.number().int().nonnegative() }),
        z.strictObject({
          kind: z.literal('task-fields'),
          index: z.number().int().nonnegative(),
          plan: handle,
          expectedPlanRevision: handle,
          target: handle,
          fields: z
            .array(
              z.enum([
                'markdownTitle',
                'priority',
                'due',
                'scheduled',
                'start',
                'time',
                'durationMinutes',
                'recurrence',
                'onCompletion',
                'tags',
                'description',
              ]),
            )
            .min(1)
            .max(11),
        }),
      ]),
    )
    .min(1)
    .max(50),
});
export const capabilitySchema = z.enum([
  'find',
  'inspect',
  'create_task',
  'change_task',
  'task',
  'read',
  'status',
  'note',
  'project',
  'link',
  'cleanup',
  'research',
]);
const completePreview = z
  .boolean()
  .optional()
  .describe('Set true when this single preview covers the whole request. Does not save.');
export const createTaskSchema = prepareSchema.options[1].omit({ kind: true }).extend({
  destination: destination.optional(),
  retryOf: handle.optional(),
  complete: completePreview,
});
// Flat model-facing metadata compiles to the existing application patch. Omitted fields stay untouched.
const scalarValue = z.string().nullable().optional();
const setMetadata = z.strictObject({
  type: z.literal('set'),
  scheduled: scalarValue,
  due: scalarValue,
  start: scalarValue,
  time: scalarValue,
  durationMinutes: z.number().nonnegative().nullable().optional(),
  recurrence: scalarValue,
  priority: z.enum(['A', 'B', 'C', 'D', 'E', 'F']).nullable().optional(),
});
export const changeTaskSchema = z.strictObject({
  complete: completePreview,
  edit: handle,
  operation: z.discriminatedUnion('type', [
    setMetadata,
    operationVariants.options[1].omit({ target: true }),
    operationVariants.options[2].omit({ target: true }),
    operationVariants.options[3].omit({ target: true }),
    operationVariants.options[4].omit({ target: true }),
    operationVariants.options[5].omit({ target: true }),
    operationVariants.options[6].omit({ target: true }),
    operationVariants.options[7].omit({ target: true }),
  ]),
  removeAnnotations: z.array(z.string()).max(50).optional(),
});
export function flatPatchKeys(operation: Record<string, unknown>): string[] {
  return Object.keys(operation).filter((key) => key !== 'type');
}
type TaskChange = z.infer<typeof changeTaskSchema>['operation'];
export function taskChangeOperation(operation: TaskChange): Exclude<TaskChange, { type: 'set' }> {
  if (operation.type !== 'set') return operation;
  const fields = flatPatchKeys(operation);
  if (fields.length === 0)
    throw new CommandFailure('INVALID_PATCH', 'Specify at least one metadata field.');
  return {
    type: 'patch' as const,
    patch: Object.fromEntries(
      fields.map((key) => {
        const value: unknown = Reflect.get(operation, key);
        return [key, value === null ? { type: 'clear' } : { type: 'set', value }];
      }),
    ),
  };
}
const researchControl = { research: z.boolean().default(false) };
const localControl = { research: z.literal(false).default(false) };
export const transitionDispositionSchema = z.enum(['save', 'keep', 'discard', 'cancel']);
const writeApproval = z
  .string()
  .min(1)
  .describe(
    'The entire current userMessage verbatim. Only a user request that grants this write can be used.',
  );
const saveInstruction = z
  .string()
  .min(1)
  .describe(
    'The exact clause in that userMessage expressly authorizing the write. A date, change request, or approval of the other fields does not grant saving.',
  );
const transitionWrite = {
  approval: writeApproval.optional(),
  saveInstruction: saveInstruction.optional(),
};
const planControl = z.strictObject({ intent: z.literal('plan'), ...researchControl });
const sharedControls = [
  z.strictObject({
    intent: z.literal('confirm'),
    ...localControl,
    approval: writeApproval,
    scope: saveScopeSchema.optional(),
  }),
  z.strictObject({
    intent: z.literal('immediate'),
    ...researchControl,
    approval: writeApproval,
    saveInstruction,
    scope: saveScopeSchema.optional(),
  }),
  z.strictObject({
    intent: z.literal('save-then-plan'),
    ...researchControl,
    approval: writeApproval,
    saveInstruction,
  }),
  z.strictObject({ intent: z.literal('review'), ...researchControl }),
  z.strictObject({
    intent: z.literal('new-session'),
    ...localControl,
    disposition: z.enum(['keep', 'discard']).optional(),
  }),
  z.strictObject({ intent: z.literal('acknowledge-uncertainty'), ...localControl }),
  z.strictObject({
    intent: z.literal('voice-mode'),
    ...localControl,
    voiceMode: z.enum(['manual', 'continuous']).optional(),
  }),
] as const;
const ordinaryControlSchema = z.union([planControl, ...sharedControls]);
export const intentSchema = z.union([
  planControl.extend({
    ...transitionWrite,
    transitionDisposition: transitionDispositionSchema.optional(),
  }),
  ...sharedControls,
  z.strictObject({
    intent: z.literal('resolve-transition'),
    ...localControl,
    ...transitionWrite,
    transitionDisposition: transitionDispositionSchema.optional(),
  }),
]);
type RecoveryState = Pick<
  CommandSessionSnapshot,
  'recovery' | 'blocked' | 'uncertaintyAcknowledged'
>;
export function recoveryControlAvailable(intent: string, state: RecoveryState): boolean {
  if (intent === 'acknowledge-uncertainty')
    return state.blocked && state.uncertaintyAcknowledged !== true;
  if (intent === 'review')
    return !state.blocked && (state.recovery === 'historical' || state.recovery === 'reviewing');
  return true;
}
/** Transition and recovery choices follow the current native session state. */
export function controlSchema(
  pending: boolean,
  recovery?: RecoveryState,
): z.ZodType<z.output<typeof intentSchema>, z.input<typeof intentSchema>> {
  const schema = pending ? intentSchema : ordinaryControlSchema;
  if (recovery === undefined) return schema;
  const options = schema.options.filter((branch) =>
    recoveryControlAvailable(branch.shape.intent.value, recovery),
  );
  return z.union(options);
}
const selection = z
  .array(
    z.union([
      z.strictObject({ kind: z.literal('task'), target: handle, revision: handle }),
      z.strictObject({
        kind: z.literal('task'),
        target: handle,
        plan: handle,
        expectedPlanRevision: handle,
      }),
      z.strictObject({ kind: z.enum(['project', 'note']), target: handle, revision: handle }),
    ]),
  )
  .max(5)
  .optional();
const finishMessage = z
  .string()
  .min(1)
  .describe(
    'Brief grounded user-language reply. Questions: question state. Unprepared work is never created/saved.',
  );
export const finishSchema = z.union([
  z.strictObject({
    state: z.literal('ready'),
    message: finishMessage.max(160).optional(),
    coverage: z
      .literal('page')
      .optional()
      .describe('Only explicitly requested partial pages; otherwise complete discovery.'),
    selection,
    presentation: z
      .enum(['cumulative'])
      .optional()
      .describe('Only user-requested all unsaved changes: show cumulative diff in existing tree.'),
    reveal: z
      .strictObject({ target: handle, revision: handle })
      .optional()
      .describe(
        'Explicit request only: open one saved task in native inspector. Selection does not reveal. Host verifies target/navigation before completion; never drafts.',
      ),
  }),
  z.strictObject({
    state: z.literal('question'),
    message: finishMessage.max(240),
    selection,
    blockingIssue: z.strictObject({
      kind: z.enum(['missing-information', 'conflict']),
      detail: z.string().min(1).max(240),
    }),
  }),
  z.strictObject({
    state: z.literal('question'),
    message: z
      .string()
      .max(240)
      .optional()
      .describe('Host renders discovery questions from evidence; omit text.'),
    blockingIssue: z.strictObject({
      kind: z.enum(['not-found', 'ambiguous', 'incomplete', 'unsupported']),
      evidence: handle,
    }),
  }),
]);
const noteSelector = z.union([
  z.strictObject({ target: handle, expectedRevision: handle.exactOptional() }),
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({ section: handle }),
  z.strictObject({
    link: z.strictObject({
      from: handle,
      expectedFromRevision: handle,
      wikiLink: z.string().min(1).max(8192),
    }),
  }),
]);
export const noteReadRequestSchema = z.strictObject({
  selector: noteSelector,
  limitCharacters: z.number().int().min(2).max(12000).exactOptional(),
  linkFor: z
    .strictObject({
      from: handle,
      expectedFromRevision: handle,
      alias: z.string().max(500).exactOptional(),
    })
    .exactOptional(),
});
export const readSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tasks'),
    query: z.string().max(2000),
    cursor: handle.optional(),
    path: z
      .string()
      .optional()
      .describe(
        'Actual vault file path only. For a child of a named task, search the parent title and use its tree; a task title is not a path.',
      ),
    folder: z.string().optional(),
    inbox: z.boolean().optional(),
    statuses: z
      .array(z.enum(['open', 'in-progress', 'done', 'cancelled']))
      .min(1)
      .max(4)
      .optional(),
    tagsAll: z.array(z.string().min(1)).min(1).max(50).optional(),
    dates: z
      .array(
        z.strictObject({
          field: z.enum(['created', 'start', 'scheduled', 'due', 'completion', 'cancelled']),
          from: z.string().optional(),
          to: z.string().optional(),
        }),
      )
      .max(6)
      .optional(),
    fields: z.enum(['title', 'body', 'all']).optional(),
    matchScope: z.enum(['node', 'subtree']).optional(),
  }),
  z.strictObject({
    kind: z.literal('tree'),
    target: handle.describe('Task node, never plan/project/note/section.'),
    expectedRevision: handle.optional().describe('For a saved search result, use its revision.'),
    side: z.enum(['before', 'after']).optional(),
    plan: handle.optional().describe('For a pending task, copy its editBasis.plan.'),
    expectedPlanRevision: handle
      .optional()
      .describe('Copy the same editBasis.expectedPlanRevision.'),
    cursor: handle.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  z.strictObject({
    kind: z.literal('tags'),
    prefix: z.string().optional(),
    cursor: handle.optional(),
  }),
  z.strictObject({ kind: z.literal('statuses') }),
  z.strictObject({ kind: z.literal('projects'), cursor: handle.optional() }),
  z.strictObject({ kind: z.literal('project'), target: handle }),
  z.strictObject({ kind: z.literal('project-schema') }),
  z.strictObject({
    kind: z.literal('notes'),
    query: z.string().max(2000),
    fields: z.enum(['name', 'body', 'all']).optional(),
    path: z.string().optional(),
    folder: z.string().optional(),
    cursor: handle.optional(),
  }),
  z.strictObject({
    kind: z.literal('note'),
    ...noteReadRequestSchema.shape,
    cursor: handle.optional(),
  }),
]);
export const notePrepareSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('refine'),
    plan: handle,
    expectedPlanRevision: handle,
    operation: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('append'), section: handle, text }),
      z.strictObject({ type: z.literal('replace-section'), section: handle, text }),
      z.strictObject({ type: z.literal('replace-body'), text }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('create'),
    path: z
      .string()
      .min(1)
      .optional()
      .describe('Explicit requested vault path only; omit for Obsidian new-note defaults.'),
    destination: z
      .strictObject({
        type: z.literal('obsidian-default'),
        fileName: z.string().min(1),
        fromPath: z.string().exactOptional(),
      })
      .optional(),
    templateExecution: z
      .strictObject({ type: z.enum(['static', 'configured-templater', 'explicit-templater']) })
      .optional(),
    collision: z
      .enum(['reject', 'suffix'])
      .default('suffix')
      .describe('suffix avoids collisions; reject needs exact requested path.'),
    title: text,
    text,
    template: handle.optional(),
    expectedTemplateRevision: handle.optional(),
  }),
  z.strictObject({
    kind: z.literal('edit'),
    target: handle,
    expectedRevision: handle,
    operation: z.strictObject({
      type: z.enum(['append', 'replace-section']),
      section: handle,
      text,
    }),
  }),
]);
const assignment = z.strictObject({
  fieldId: handle,
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .nullable(),
});
const projectFields = {
  fields: z.array(assignment).min(1).max(50).optional(),
  statusId: z.string().nullable().optional(),
};
export const projectStageSchema = z.union([
  z.strictObject({
    kind: z.literal('update').optional(),
    target: handle,
    expectedRevision: handle,
    ...projectFields,
  }),
  z.strictObject({
    kind: z.literal('create'),
    name: z.string().trim().min(1).max(1000),
    ...projectFields,
  }),
  z.strictObject({
    kind: z.literal('refine-create'),
    proposal: handle,
    name: z.string().trim().min(1).max(1000).optional(),
    ...projectFields,
  }),
  z.strictObject({
    kind: z.literal('move-task'),
    target: handle,
    expectedRevision: handle,
    taskTarget: handle,
    expectedTaskRevision: handle,
  }),
]);
export const statusStageSchema = z.strictObject({
  target: handle,
  revision: handle,
  symbol: z.string().length(1),
  plan: handle.optional(),
});
export const researchSchema = z.strictObject({ query: z.string().trim().min(1).max(2000) });
export const researchResultSchema = z
  .strictObject({
    outcome: z.literal('empty').optional(),
    query: z.string().max(2000),
    summary: z.string().max(12000),
    sources: z
      .array(
        z.strictObject({
          url: z
            .url()
            .refine((v) => new URL(v).protocol === 'https:' || new URL(v).protocol === 'http:'),
          title: z.string().nullable(),
          snippet: z.string().nullable(),
          content: z.string().nullable(),
          evidence: z.enum(['citation', 'retrieved-url', 'provider-excerpt']),
        }),
      )
      .max(5),
    truncated: z.boolean(),
  })
  .refine((r) =>
    r.outcome === 'empty'
      ? r.sources.length === 0 && r.summary === '' && !r.truncated
      : r.sources.length > 0,
  )
  .refine((r) => JSON.stringify(r).length <= 12000);
export function checkedOutput(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const json = z.json().parse(value);
  if (JSON.stringify(json).length > 65536)
    throw new CommandFailure(
      'OUTPUT_LIMIT',
      'This result is too large. Read a smaller page or section.',
    );
  return json;
}
/** Supported literal inline fields only; canonical task codecs retain ownership of all task syntax. */
function authoredAnnotations(before: string): string[] {
  const excluded = [
    ...inlineCodeRanges(before),
    ...parseSourceReferences(before).map((t) => ({ from: t.index, to: t.index + t.raw.length })),
  ];
  const literals: string[] = [];
  let start = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '[') start = i;
    else if (before[i] === '\n' || before[i] === '\r') start = -1;
    else if (before[i] === ']' && start >= 0) {
      const literal = before.slice(start, i + 1);
      if (literal.includes('::') && !excluded.some((r) => start >= r.from && start < r.to))
        literals.push(literal);
      start = -1;
    }
  }
  return literals;
}
export function preserveAuthoredAnnotations(
  before: string,
  after: string,
  remove: readonly string[] = [],
): string {
  const literals = authoredAnnotations(before);
  if (remove.some((item) => !literals.includes(item)))
    throw new CommandFailure('ANNOTATION', 'The annotation selected for removal is not present.');
  const retained = authoredAnnotations(after);
  const missing = literals.filter((item) => !remove.includes(item) && !retained.includes(item));
  return missing.length === 0 ? after : `${after.trimEnd()} ${missing.join(' ')}`;
}

const effects = z.enum(['unchanged', 'committed', 'partial', 'unknown']);
const reference = z.object({ target: z.string().min(1), revision: z.string().min(1) });
const receiptBase = z.object({
  providerEpoch: z.string(),
  requestId: z.string().min(1),
  acceptedAt: z.number(),
  expiresAt: z.number(),
  outcome: z.enum(['changed', 'noop', 'failed']),
  effects,
  recovery: z.enum(['none', 'reread', 'retry-same-request', 'reconcile']),
});
const correspondence = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('complete'),
      coverage: z.literal('issued-plan-tasks'),
      root: reference.nullable(),
      tasks: z.array(
        z.object({
          preparedTarget: z.string(),
          committedTarget: z.string(),
          committedRevision: z.string(),
        }),
      ),
    })
    .loose(),
  z.object({ state: z.enum(['unavailable', 'redacted']) }),
]);
const contentReceipt = receiptBase
  .extend({
    plan: z.string(),
    planRevision: z.string(),
    contentContinuity: z.object({ plan: z.string(), planRevision: z.string(), correspondence }),
  })
  .loose();
const statusReceipt = receiptBase
  .extend({
    original: z
      .object({ target: z.string(), state: z.enum(['retained', 'removed', 'unproven']) })
      .loose(),
    next: z.object({ target: z.string() }).loose().optional(),
  })
  .loose();
const noteReceipt = receiptBase
  .extend({
    plan: z.string(),
    planRevision: z.string(),
    completion: z.enum(['complete', 'incomplete']).optional(),
    phase: z.enum(['provision', 'template', 'content', 'readback']).optional(),
    templateEffects: z.enum(['unchanged', 'committed', 'unknown']).optional(),
    contentEffects: z.enum(['unchanged', 'committed', 'unknown']).optional(),
    noteEffects: z.enum(['unchanged', 'committed', 'unknown']),
    destinationEffects: z.enum(['unchanged', 'committed', 'unknown']),
    note: reference.optional(),
    section: z.string().min(1).optional(),
  })
  .loose();
const projectReceipt = receiptBase.extend({ project: reference.optional() }).loose();
const resultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    receipt: z.union([contentReceipt, statusReceipt, noteReceipt, projectReceipt]),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), category: z.string() }),
    effects,
    recovery: z.enum(['none', 'reread', 'retry-same-request', 'reconcile']),
    receipt: z.union([contentReceipt, statusReceipt, noteReceipt, projectReceipt]).optional(),
  }),
]);
export function checkedWriteResult(
  value: unknown,
): MutationResultV1 | NoteMutationResultV1 | ProjectMutationResultV1 | TaskContentMutationResultV1 {
  checkedOutput(value);
  const parsed = resultSchema.parse(value);
  const receipt = parsed.receipt;
  if (receipt !== undefined) {
    if ('contentContinuity' in receipt) contentReceipt.parse(receipt);
    else if ('original' in receipt) statusReceipt.parse(receipt);
    else if ('noteEffects' in receipt) noteReceipt.parse(receipt);
    else projectReceipt.parse(receipt);
  }
  return value as
    MutationResultV1 | NoteMutationResultV1 | ProjectMutationResultV1 | TaskContentMutationResultV1;
}
/** A saved display needs the accepted note and exact post-write selection, not just its path. */
export function isCommandNoteReadback(
  entry: CommandJournalEntry,
  page: CommandNoteRead,
  scope: 'selection' | 'current' = 'selection',
): boolean {
  if (entry.change.kind !== 'note' || entry.state !== 'settled' || entry.effects !== 'committed')
    return false;
  const parsed = noteReceipt.safeParse(entry.receipt);
  if (!parsed.success) return false;
  const receipt = parsed.data,
    plan = entry.change.plan;
  if (!noteReceiptMatches(entry, plan, receipt)) return false;
  if (!acceptedNoteVersion(receipt, plan, page)) return false;
  if (scope === 'current') return true;
  return changedNoteRead(receipt, page) || completeNoteRead(plan, page);
}
function acceptedNoteVersion(
  receipt: z.infer<typeof noteReceipt>,
  plan: NotePlanV1,
  page: CommandNoteRead,
): boolean {
  const note = receipt.note;
  return (
    note?.target === page.note.target &&
    note.revision === page.note.revision &&
    receipt.providerEpoch === page.providerEpoch &&
    page.note.path === plan.path
  );
}
function noteReceiptMatches(
  entry: CommandJournalEntry,
  plan: NotePlanV1,
  receipt: z.infer<typeof noteReceipt>,
): boolean {
  return (
    receipt.completion !== 'incomplete' &&
    receipt.plan === plan.target &&
    receipt.planRevision === plan.revision &&
    receipt.providerEpoch === plan.providerEpoch &&
    receipt.requestId === entry.request.requestId
  );
}
function changedNoteRead(receipt: z.infer<typeof noteReceipt>, page: CommandNoteRead): boolean {
  const selector = page.request?.selector;
  return (
    receipt.section !== undefined &&
    page.selection === 'section' &&
    selector !== undefined &&
    'section' in selector &&
    selector.section === receipt.section
  );
}
function completeNoteRead(plan: NotePlanV1, page: CommandNoteRead): boolean {
  const selector = page.request?.selector;
  if (page.selection !== 'note' || selector === undefined) return false;
  if (plan.kind === 'edit' && (!page.complete || page.truncated || page.continued === true))
    return false;
  return fullNoteSelector(selector, page);
}
function fullNoteSelector(
  selector: z.infer<typeof noteReadRequestSchema>['selector'],
  page: CommandNoteRead,
): boolean {
  return 'path' in selector
    ? selector.path === page.note.path
    : 'target' in selector &&
        selector.target === page.note.target &&
        selector.expectedRevision === page.note.revision;
}
/** Native refresh owns identity. This comparison refuses any changed reviewed value or order. */
export function sameReviewedContent(before: ContentPlanV1, after: ContentPlanV1): boolean {
  const values = (plan: ContentPlanV1): string =>
    JSON.stringify([plan.before, plan.after, plan.destination], (key, value: unknown) => {
      if (key === 'source' && typeof value === 'object' && value !== null && 'path' in value)
        return { path: value.path };
      if (
        [
          'target',
          'revision',
          'parentTarget',
          'projectRevision',
          'observedAtMs',
          'runningMsAtObservation',
        ].includes(key)
      )
        return undefined;
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value;
    });
  return values(before) === values(after);
}

const treeOutput: z.ZodType = z.lazy(() =>
  z.looseObject({
    target: z.string().min(1),
    revision: z.string().min(1),
    title: z.string(),
    markdownTitle: z.string(),
    status: z.enum(['open', 'in-progress', 'done', 'cancelled']),
    statusSymbol: z.string().length(1),
    children: z.array(treeOutput),
    comments: z.array(z.looseObject({ target: z.string(), text: z.string() })),
    entries: z.array(z.json()),
    complete: z.boolean(),
    truncated: z.boolean(),
  }),
);
const planOutput = z.looseObject({
  providerEpoch: z.string(),
  target: z.string().min(1),
  revision: z.string().min(1),
  kind: z.enum(['create', 'edit', 'hierarchy']),
  affected: z.object({ before: z.array(treeOutput), after: z.array(treeOutput) }).optional(),
  expiresAt: z.number(),
  before: treeOutput.nullable(),
  after: treeOutput.nullable(),
});
export function validatePlanOutput(plan: ContentPlanV1): void {
  z.json().parse(plan);
  planOutput.parse(plan);
  if (plan.kind === 'hierarchy' && plan.affected === undefined)
    throw new CommandFailure('INCOMPLETE_PLAN', 'The hierarchy preview lacks its affected roots.');
}

/** Keep full canonical trees in the surface; model context uses explicitly paged summaries. */
export function planToolOutput(
  plan: ContentPlanV1,
  currentOperation = true,
): ReturnType<typeof checkedOutput> {
  const feedback = currentOperation
    ? {
        preparation:
          'Preview accepted; this operation has not saved source content. If the request is complete, finish; otherwise refine through its issued edit alias. Create again only for another requested task.',
      }
    : {};
  const selection =
    plan.after === null
      ? {}
      : {
          selection: {
            kind: 'task',
            target: plan.after.target,
            plan: plan.target,
            expectedPlanRevision: plan.revision,
          },
        };
  if (JSON.stringify({ ...feedback, ...plan, ...selection }).length <= 65536)
    return checkedOutput({ ...feedback, ...plan, ...selection });
  const page = (tree: TaskTreeV1 | null): unknown =>
    tree === null
      ? null
      : {
          ...tree,
          children: [],
          comments: [],
          timeEntries: [],
          entries: [],
          complete: false,
          truncated: true,
        };
  return checkedOutput({
    ...feedback,
    ...plan,
    ...selection,
    before: page(plan.before),
    after: page(plan.after),
    ...(plan.affected === undefined
      ? {}
      : {
          affected: {
            before: plan.affected.before.map(page),
            after: plan.affected.after.map(page),
          },
        }),
    contextTruncated: true,
    readHint:
      'Use read tree with this plan/revision and returned cursors to expand the canonical tree.',
  });
}

/** Keep canonical union branches intact for validation and provider projection. */
export function modelSchema<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema;
}

type CommandLink = Extract<CommandChange, { kind: 'link' }>;
function linkedNode(tree: TaskTreeV1 | null, target: string): TaskTreeV1 | undefined {
  if (tree === null) return undefined;
  if (tree.target === target) return tree;
  for (const child of tree.children) {
    const found = linkedNode(child, target);
    if (found !== undefined) return found;
  }
  return undefined;
}
function sameLinkPlan(link: CommandLink, plan: ContentPlanV1): boolean {
  return (
    plan.target === link.plan.target &&
    plan.providerEpoch === link.plan.providerEpoch &&
    plan.before?.target === link.plan.before?.target
  );
}
function linkedText(link: CommandLink, plan: ContentPlanV1): string {
  const node = linkedNode(plan.after, link.target);
  const text = commandLinkText(link, node);
  if (
    node === undefined ||
    typeof text !== 'string' ||
    !sameLinkPlan(link, plan) ||
    linkSourcePath(plan, node) !== link.sourcePath
  )
    throw new CommandFailure(
      'LINK_DEPENDENCY',
      'The linked task destination or identity changed. Review the note link before saving.',
    );
  return text;
}
/** Only carry the already reviewed fixed link through a proven same-plan refinement. */
export function reconcileCommandLink(
  link: CommandLink,
  plan: ContentPlanV1,
  preparations: ReadonlyArray<Extract<CommandPreparation, { kind: 'task' }>> = [],
): CommandLink {
  validateCommandLink(link, link.plan);
  const continued =
    link.field === 'comment' && link.plan.revision !== plan.revision
      ? continueLinkedComment(link, plan, preparations)
      : link;
  const text = linkedText(continued, plan);
  if (text.split(link.placeholder).length !== 2 || text.includes('{{link}}'))
    throw new CommandFailure(
      'LINK_DEPENDENCY',
      'The linked field changed. Review its note link before preparing this refinement.',
    );
  return { ...continued, plan, template: text.replace(link.placeholder, '{{link}}') };
}
function validateCommandLink(link: CommandLink, plan: ContentPlanV1): void {
  if (
    link.plan.revision !== plan.revision ||
    link.placeholder.length === 0 ||
    link.template.split('{{link}}').length !== 2 ||
    linkedText(link, plan) !== link.template.replace('{{link}}', link.placeholder)
  )
    throw new CommandFailure(
      'LINK_DEPENDENCY',
      'The note link no longer matches the reviewed task. Review it before saving.',
    );
}
/** Deterministic proposal dependency checks run before the first effect is admitted. */
export function validateCommandLinks(proposal: CommandProposal, now: number): void {
  for (const link of proposal.changes) {
    if (link.kind !== 'link') continue;
    const task = proposal.changes.find(
      (change) => change.kind === 'task' && change.plan.target === link.plan.target,
    );
    const note = proposal.changes.find(
      (change) => change.kind === 'note' && change.plan.target === link.notePlan,
    );
    if (
      task?.kind !== 'task' ||
      note?.kind !== 'note' ||
      task.plan.expiresAt <= now ||
      note.plan.expiresAt <= now ||
      link.placeholder !== buildLinkRaw('wiki', note.plan.path, link.alias, '|')
    )
      throw new CommandFailure(
        'LINK_DEPENDENCY',
        'The linked note and task previews need renewed review before saving.',
      );
    validateCommandLink(link, task.plan);
  }
}

function continueLinkedComment(
  link: CommandLink,
  plan: ContentPlanV1,
  preparations: ReadonlyArray<Extract<CommandPreparation, { kind: 'task' }>>,
): CommandLink {
  const before = linkedNode(link.plan.after, link.target),
    after = linkedNode(plan.after, link.target);
  const index = linkedCommentIndex(link, before);
  const supported = commentSafePreparations(link, plan, preparations);
  const sequence = (node: TaskTreeV1): string =>
    JSON.stringify(node.comments.map((comment) => [comment.text, comment.timestamp]));
  const comment = after?.comments[index];
  if (
    !supported ||
    before?.complete !== true ||
    after?.complete !== true ||
    comment?.parentTarget !== link.target ||
    sequence(before) !== sequence(after)
  )
    throw new CommandFailure(
      'LINK_DEPENDENCY',
      'The linked comment changed. Review its exact owner and note link before saving.',
    );
  return { ...link, comment: comment.target };
}

function commandLinkText(link: CommandLink, node: TaskTreeV1 | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (link.field !== 'comment') return node[link.field];
  return node.comments.find(
    (comment) => comment.target === link.comment && comment.parentTarget === node.target,
  )?.text;
}
function linkSourcePath(plan: ContentPlanV1, node: TaskTreeV1): string | undefined {
  return plan.destination?.path ?? plan.before?.source?.path ?? node.source?.path;
}
function commentSafePreparations(
  link: CommandLink,
  plan: ContentPlanV1,
  preparations: ReadonlyArray<Extract<CommandPreparation, { kind: 'task' }>>,
): boolean {
  const first = preparations[0]?.input;
  return (
    first?.kind === 'append' &&
    first.expectedPlanRevision === link.plan.revision &&
    preparations.every(
      ({ input }) =>
        input.kind === 'append' &&
        input.plan === plan.target &&
        (['patch', 'description', 'set-initial-status', 'add-child'].includes(
          input.operation.type,
        ) ||
          (preparations.length === 1 && unrelatedCommentRemoval(link, input.operation))),
    )
  );
}
function unrelatedCommentRemoval(
  link: CommandLink,
  operation: z.infer<typeof operationVariants>,
): boolean {
  if (operation.type !== 'remove-comment' || link.plan.after === null) return false;
  const owners = removalOwners(link.plan.after, operation.target);
  return owners?.length === 1 && owners[0]?.target !== link.target;
}
function removalOwners(root: TaskTreeV1, target: string): TaskTreeV1[] | undefined {
  const pending = [root],
    owners: TaskTreeV1[] = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    const matches = node.comments.filter((comment) => comment.target === target);
    if (
      matches.some((comment) => comment.parentTarget !== node.target) ||
      (matches.length > 0 && !node.complete)
    )
      return undefined;
    owners.push(...matches.map(() => node));
    pending.push(...node.children);
  }
  return owners;
}

function linkedCommentIndex(link: CommandLink, tree: TaskTreeV1 | undefined): number {
  return (
    tree?.comments.findIndex(
      (comment) => comment.target === link.comment && comment.parentTarget === link.target,
    ) ?? -1
  );
}

/** Complete native root views, paired by issued identity rather than display title/order. */
export function commandPlanViews(
  plan: ContentPlanV1,
): ReadonlyArray<{ before: TaskTreeV1 | null; after: TaskTreeV1 | null }> {
  if (plan.affected === undefined) return [{ before: plan.before, after: plan.after }];
  const before = new Map(plan.affected.before.map((root) => [root.target, root]));
  const after = new Map(plan.affected.after.map((root) => [root.target, root]));
  return [...new Set([...before.keys(), ...after.keys()])].map((target) => ({
    before: before.get(target) ?? null,
    after: after.get(target) ?? null,
  }));
}
