import { z } from 'zod';
import type {
  ContentPlanV1,
  MutationResultV1,
  NoteMutationResultV1,
  ProjectMutationResultV1,
  TaskContentMutationResultV1,
  TaskCreateTreeV1,
  TaskTreeV1,
} from '../../api';
import { inlineCodeRanges } from '../markdown/inlineCode';
import { buildLinkRaw, parseSourceReferences } from '../markdown/links';
import { CommandFailure, type CommandChange, type CommandProposal } from './commandTypes';
const handle = z.string().min(1).max(512);
const text = z.string().max(16000);
const field = (value: z.ZodType): z.ZodType =>
  z.union([
    z.strictObject({ type: z.literal('set'), value }),
    z.strictObject({ type: z.literal('clear') }),
  ]);
export const patchSchema = z.strictObject({
  markdownTitle: field(text).optional(),
  priority: field(z.enum(['A', 'B', 'C', 'D', 'E', 'F'])).optional(),
  due: field(z.string())
    .optional()
    .describe(
      'Deadline date: work must be completed by this date. Planning work on a date alone is not a deadline.',
    ),
  scheduled: field(z.string())
    .optional()
    .describe('Planned work date: when the user intends to do this task.'),
  start: field(z.string())
    .optional()
    .describe('Not-before date: when work becomes available to begin.'),
  time: field(z.string()).optional(),
  durationMinutes: field(z.number().nonnegative()).optional(),
  recurrence: field(z.string()).optional(),
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
    markdownTitle: text.min(1),
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
export const operationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('patch'), target: handle, patch: patchSchema }),
  z.strictObject({ type: z.literal('description'), target: handle, text: text.nullable() }),
  z.strictObject({ type: z.literal('add-child'), target: handle, markdownTitle: text.min(1) }),
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
export const prepareSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), destination, tree: seed }),
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
const batchOptions = operationSchema.options.filter(
  (option) => !['update-comment', 'remove-comment'].includes(option.shape.type.value),
) as [(typeof operationSchema.options)[number], ...Array<(typeof operationSchema.options)[number]>];
const batchOperationSchema = z.discriminatedUnion('type', batchOptions);
export const batchSchema = z.strictObject({
  kind: z.literal('batch'),
  plan: handle,
  expectedPlanRevision: handle,
  operations: z.array(batchOperationSchema).min(1).max(20),
});
export const taskToolSchema = z.discriminatedUnion('kind', [...prepareSchema.options, batchSchema]);
export const intentSchema = z.strictObject({
  intent: z
    .enum(['plan', 'confirm', 'immediate', 'new-session'])
    .describe(
      'plan means creating, editing, finding or showing entities in the CURRENT conversation; use it for ordinary task work. confirm accepts the visible proposal. immediate explicitly requests saving now. new-session ONLY means an explicit request to leave this conversation and start a separate session; a new task or topic stays plan.',
    ),
  research: z.boolean(),
  disposition: z.enum(['keep', 'discard']).optional(),
});
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
export const finishSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), message: z.string().min(1).max(160), selection }),
  z.strictObject({
    state: z.literal('question'),
    message: z.string().min(1).max(240),
    selection,
    blockingIssue: z.strictObject({
      kind: z.enum(['missing-information', 'conflict']),
      detail: z.string().min(1).max(240),
    }),
  }),
]);
const noteSelector = z.union([
  z.strictObject({ target: handle, expectedRevision: handle.optional() }),
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
export const readSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tasks'),
    query: z.string().max(2000),
    cursor: handle.optional(),
    path: z.string().optional(),
    folder: z.string().optional(),
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
    target: handle,
    side: z.enum(['before', 'after']).optional(),
    plan: handle.optional(),
    expectedPlanRevision: handle.optional(),
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
    selector: noteSelector,
    cursor: handle.optional(),
    limitCharacters: z.number().int().min(2).max(12000).optional(),
    linkFor: z
      .strictObject({
        from: handle,
        expectedFromRevision: handle,
        alias: z.string().max(500).optional(),
      })
      .optional(),
  }),
]);
export const notePrepareSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    path: z.string().min(1),
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
export const projectStageSchema = z.strictObject({
  target: handle,
  expectedRevision: handle,
  fields: z.array(assignment).max(50).optional(),
  statusId: z.string().nullable().optional(),
});
export const statusStageSchema = z.strictObject({
  target: handle,
  revision: handle,
  symbol: z.string().length(1),
  plan: handle.optional(),
});
export const researchSchema = z.strictObject({ query: z.string().trim().min(1).max(2000) });
export const researchResultSchema = z
  .strictObject({
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
      .min(1)
      .max(5),
    truncated: z.boolean(),
  })
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
    noteEffects: z.enum(['unchanged', 'committed', 'unknown']),
    destinationEffects: z.enum(['unchanged', 'committed', 'unknown']),
    note: reference.optional(),
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
/** Native refresh owns identity. This comparison refuses any changed reviewed value or order. */
export function sameReviewedContent(before: ContentPlanV1, after: ContentPlanV1): boolean {
  const values = (plan: ContentPlanV1): string =>
    JSON.stringify([plan.before, plan.after, plan.destination], (key, value: unknown) => {
      if (key === 'source' && typeof value === 'object' && value !== null && 'path' in value)
        return { path: value.path };
      return [
        'target',
        'revision',
        'parentTarget',
        'projectRevision',
        'observedAtMs',
        'runningMsAtObservation',
      ].includes(key)
        ? undefined
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
  kind: z.enum(['create', 'edit']),
  expiresAt: z.number(),
  before: treeOutput.nullable(),
  after: treeOutput.nullable(),
});
export function validatePlanOutput(plan: ContentPlanV1): void {
  z.json().parse(plan);
  planOutput.parse(plan);
}

/** Keep full canonical trees in the surface; model context uses explicitly paged summaries. */
export function planToolOutput(plan: ContentPlanV1): ReturnType<typeof checkedOutput> {
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
  if (JSON.stringify({ ...plan, ...selection }).length <= 65536)
    return checkedOutput({ ...plan, ...selection });
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
    ...plan,
    ...selection,
    before: page(plan.before),
    after: page(plan.after),
    contextTruncated: true,
    readHint:
      'Use read tree with this plan/revision and returned cursors to expand the canonical tree.',
  });
}

/** Provider roots require explicit objects. The original union still validates every branch. */
export function modelSchema<T>(
  schema: z.ZodType<T> & { options: readonly z.ZodObject[] },
  hint = '',
): z.ZodType<T> {
  const shape: Record<string, z.ZodType> = {};
  const fields = unionFields(schema.options);
  for (const [key, variants] of fields) {
    const field = variants.length === 1 ? variants[0] : z.union(variants);
    if (field === undefined) continue;
    const required = schema.options.every(
      (branch) => objectShape(branch)[key]?.safeParse(undefined).success === false,
    );
    shape[key] = required ? field : field.optional();
  }
  return z.strictObject(shape).superRefine((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: hint === '' ? issue.message : `${issue.message} ${hint}`,
        });
  }) as z.ZodType<T>;
}
function unionFields(branches: readonly z.ZodObject[]): Map<string, z.ZodType[]> {
  const fields = new Map<string, z.ZodType[]>();
  for (const branch of branches) {
    for (const [key, field] of Object.entries(objectShape(branch))) {
      const variants = fields.get(key) ?? [];
      if (!variants.includes(field)) variants.push(field);
      fields.set(key, variants);
    }
  }
  return fields;
}

function objectShape(schema: z.ZodObject): Readonly<Record<string, z.ZodType>> {
  return schema.shape;
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
  const text = node?.[link.field];
  if (
    node === undefined ||
    typeof text !== 'string' ||
    !sameLinkPlan(link, plan) ||
    (plan.destination?.path ?? node.source?.path) !== link.sourcePath
  )
    throw new CommandFailure(
      'LINK_DEPENDENCY',
      'The linked task destination or identity changed. Review the note link before saving.',
    );
  return text;
}
/** Only carry the already reviewed fixed link through a proven same-plan refinement. */
export function reconcileCommandLink(link: CommandLink, plan: ContentPlanV1): CommandLink {
  validateCommandLink(link, link.plan);
  const text = linkedText(link, plan);
  if (text.split(link.placeholder).length !== 2 || text.includes('{{link}}'))
    throw new CommandFailure(
      'LINK_DEPENDENCY',
      'The linked field changed. Review its note link before preparing this refinement.',
    );
  return { ...link, plan, template: text.replace(link.placeholder, '{{link}}') };
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
