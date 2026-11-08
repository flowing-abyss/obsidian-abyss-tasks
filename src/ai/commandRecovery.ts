import { z } from 'zod';
import type {
  ContentPlanV1,
  MutationReceiptV1,
  NoteMutationReceiptV1,
  NotePlanV1,
  ProjectDtoV1,
  ProjectMutationReceiptV1,
  ProjectSchemaV1,
  TaskContentReceiptV1,
  TaskTreeV1,
} from '../../api';
import { notePrepareSchema, noteReadRequestSchema, prepareSchema } from './commandSchemas';
import type {
  CommandChange,
  CommandJournalEntry,
  CommandNoteRead,
  CommandSessionSnapshot,
} from './commandTypes';

const text = z.string();
const handle = text.min(1);
const count = z.number().int().nonnegative();
const finite = z.number();
const reference = z.object({ target: handle, revision: handle });
const observation = {
  providerEpoch: handle,
  generation: count,
  scopeRevision: count,
  semanticsRevision: count,
};
const effects = z.enum(['unchanged', 'committed', 'partial', 'unknown']);
const storageEffect = z.enum(['unchanged', 'committed', 'unknown']);
const recovery = z.enum(['none', 'reread', 'retry-same-request', 'reconcile']);
const warnings = z.array(z.object({ code: text, message: text }));
const snapshots = z.enum(['complete', 'unavailable', 'redacted']);
const source = z.object({ path: text, line: count });
const taskShape = {
  ...reference.shape,
  title: text,
  markdownTitle: text,
  status: z.enum(['open', 'in-progress', 'done', 'cancelled']),
  statusSymbol: text.length(1),
  priority: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  dates: z.object({
    created: text.exactOptional(),
    start: text.exactOptional(),
    scheduled: text.exactOptional(),
    due: text.exactOptional(),
    completion: text.exactOptional(),
    cancelled: text.exactOptional(),
  }),
  time: text.exactOptional(),
  durationMinutes: finite.nonnegative().exactOptional(),
  tags: z.array(text),
  recurrence: text.exactOptional(),
  onCompletion: z.enum(['keep', 'delete']),
  onCompletionExplicit: z.boolean(),
  authoredId: text.exactOptional(),
  parentTarget: handle.exactOptional(),
};
const task = z.object({ ...taskShape, source });
const tracked = z.object({
  closedMs: finite,
  runningCount: count,
  runningMsAtObservation: finite,
  lastRecordedWorkAtMs: finite.exactOptional(),
  brokenEntryCount: count,
});
const tree: z.ZodType<TaskTreeV1> = z.lazy(() =>
  z.object({
    ...taskShape,
    source: source.exactOptional(),
    description: text.exactOptional(),
    children: z.array(tree),
    comments: z.array(
      z.object({
        target: handle,
        parentTarget: handle,
        text,
        timestamp: z
          .discriminatedUnion('precision', [
            z.object({ precision: z.literal('day'), value: text }),
            z.object({ precision: z.literal('instant'), atom: text, epochMs: finite }),
          ])
          .exactOptional(),
      }),
    ),
    activity: z.object({ observedAtMs: finite, own: tracked, subtree: tracked }),
    timeEntries: z.array(
      z.object({
        target: handle,
        parentTarget: handle,
        state: z.enum(['running', 'closed', 'broken']),
        startMs: finite.exactOptional(),
        endMs: finite.exactOptional(),
        note: text.exactOptional(),
        issue: z.enum(['invalid-start', 'invalid-end', 'end-before-start']).exactOptional(),
      }),
    ),
    entries: z.array(
      z.object({ kind: z.enum(['child', 'comment', 'time-entry']), target: handle }),
    ),
    timeEntryCount: count,
    childCount: count,
    commentCount: count,
    complete: z.boolean(),
    truncated: z.boolean(),
  }),
);
const treePage = z.object({
  ...observation,
  revision: count,
  tree,
  complete: z.boolean(),
  truncated: z.boolean(),
  nextCursor: handle.exactOptional(),
});
const insertion = z.union([
  z.object({ type: z.enum(['append', 'prepend']) }),
  z.object({
    type: z.literal('section'),
    heading: text,
    position: z.enum(['top', 'bottom']).exactOptional(),
  }),
]);
const contentPlan: z.ZodType<ContentPlanV1> = z
  .object({
    ...observation,
    ...reference.shape,
    kind: z.enum(['edit', 'create', 'hierarchy']),
    affected: z.object({ before: z.array(tree), after: z.array(tree) }).exactOptional(),
    expiresAt: finite,
    before: tree.nullable(),
    after: tree.nullable(),
    destination: z
      .object({
        type: z.enum(['configured-default', 'note', 'project']),
        path: text,
        insertion,
        projectTarget: handle.exactOptional(),
        projectRevision: handle.exactOptional(),
      })
      .exactOptional(),
    copies: z
      .array(
        z.object({
          type: z.enum(['comment', 'subtree']),
          source: handle,
          sourceRoot: reference,
          state: z.enum(['retained', 'unavailable']),
          tasks: z.array(z.object({ sourceTarget: handle, destinationTarget: handle })),
          comments: z.array(
            z.object({
              sourceTarget: handle,
              destinationTarget: handle,
              destinationParent: handle,
            }),
          ),
        }),
      )
      .exactOptional(),
    mergePreservation: z
      .object({
        planRevision: handle,
        sourceRoot: reference,
        state: z.enum(['covered', 'held']),
        entries: z.array(
          z.object({
            kind: z.enum(['header', 'description', 'comment', 'subtree', 'residual', 'constraint']),
            field: text,
            state: z.enum(['retained', 'held']),
            reason: text.exactOptional(),
          }),
        ),
      })
      .exactOptional(),
  })
  .superRefine((plan, context) => {
    if (plan.kind === 'hierarchy' && plan.affected === undefined)
      context.addIssue({ code: 'custom', message: 'Hierarchy plans require affected roots.' });
  });
const notePlan: z.ZodType<NotePlanV1> = z.object({
  ...observation,
  ...reference.shape,
  kind: z.enum(['edit', 'create']),
  expiresAt: finite,
  path: text,
  before: z.object({ text, complete: z.literal(true) }).nullable(),
  after: z.object({ text, complete: z.literal(true) }),
  note: reference.exactOptional(),
  section: handle.exactOptional(),
  sections: z
    .array(
      z.object({
        section: handle,
        before: z.object({ text, complete: z.literal(true) }),
        after: z.object({ text, complete: z.literal(true) }),
      }),
    )
    .max(20)
    .exactOptional(),
});
const noteSummary = z.object({
  ...reference.shape,
  path: text,
  name: text,
  aliases: z.array(text),
});
const notePage: z.ZodType<CommandNoteRead> = z.object({
  ...observation,
  revision: count,
  note: noteSummary,
  selection: z.enum(['note', 'heading', 'block', 'section']),
  continued: z.boolean().exactOptional(),
  request: noteReadRequestSchema.exactOptional(),
  resolvedSubpath: text.exactOptional(),
  segments: z.array(
    z.object({
      section: z.object({
        target: handle,
        kind: z.enum(['prose', 'heading', 'block', 'frontmatter', 'task', 'other']),
        label: text.exactOptional(),
        canReplace: z.boolean(),
        canAppend: z.boolean(),
      }),
      text,
      continuesPrevious: z.boolean(),
      continuesNext: z.boolean(),
    }),
  ),
  complete: z.boolean(),
  truncated: z.boolean(),
  nextCursor: handle.exactOptional(),
  markdownLink: text.exactOptional(),
});
const projectValue = z.union([text, finite, z.boolean(), z.array(z.union([text, finite]))]);
const project: z.ZodType<ProjectDtoV1> = z.object({
  ...reference.shape,
  path: text,
  name: text,
  status: z.discriminatedUnion('state', [
    z.object({ state: z.literal('absent') }),
    z.object({ state: z.literal('configured'), id: text }),
    z.object({ state: z.literal('unrecognized'), value: text }),
    z.object({ state: z.literal('unsupported') }),
  ]),
  stats: z.object({
    total: count,
    done: count,
    cancelled: count,
    inProgress: count,
    tracked: z.object({ closedMs: finite, openStartsMs: z.array(finite) }),
  }),
  tags: z.array(text),
  fields: z.array(
    z.union([
      z.object({ fieldId: handle, state: z.enum(['absent', 'unsupported']) }),
      z.object({ fieldId: handle, state: z.literal('value'), value: projectValue }),
    ]),
  ),
});
const fieldType = z.enum(['text', 'number', 'checkbox', 'list', 'tags', 'date', 'datetime']);
const projectSchema: z.ZodType<ProjectSchemaV1> = z.object({
  ...observation,
  revision: count,
  statuses: z.array(z.object({ id: text, name: text, displayName: text.exactOptional() })),
  defaultStatusId: text.exactOptional(),
  fields: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        id: text,
        label: text,
        kind: z.literal('field'),
        type: fieldType,
        writable: z.boolean(),
        suggestions: z
          .array(z.object({ value: projectValue, displayName: text.exactOptional() }))
          .exactOptional(),
      }),
      z.object({
        id: text,
        label: text,
        kind: z.literal('derived'),
        type: z.enum(['name', 'progress', 'tracking']),
        writable: z.literal(false),
      }),
      z.object({
        id: text,
        label: text,
        kind: z.literal('status'),
        type: z.literal('status'),
        writable: z.boolean(),
      }),
      z.object({
        id: text,
        label: text,
        kind: z.literal('unavailable'),
        type: z.union([fieldType, z.literal('status')]),
        writable: z.literal(false),
      }),
    ]),
  ),
});
const change: z.ZodType<CommandChange> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), plan: contentPlan }),
  z.object({
    kind: z.literal('project-create'),
    id: handle,
    name: text,
    schema: projectSchema,
    fields: z.array(z.object({ fieldId: handle, value: projectValue.nullable() })).exactOptional(),
    statusId: text.nullable().exactOptional(),
  }),
  z.object({ kind: z.literal('project-move'), before: tree, destination: project }),
  z.object({ kind: z.literal('note'), plan: notePlan }),
  z.object({
    kind: z.literal('project'),
    before: project,
    fields: z.array(z.object({ fieldId: handle, value: projectValue.nullable() })).exactOptional(),
    statusId: text.nullable().exactOptional(),
  }),
  z.object({
    kind: z.literal('status'),
    target: handle,
    revision: handle,
    symbol: text.length(1),
    plan: handle.exactOptional(),
    nuance: text,
  }),
  z.object({
    kind: z.literal('link'),
    plan: contentPlan,
    notePlan: handle,
    target: handle,
    field: z.enum(['description', 'markdownTitle', 'comment']),
    comment: handle.exactOptional(),
    template: text,
    placeholder: text,
    sourcePath: text,
    alias: text,
  }),
  z.object({
    kind: z.literal('cleanup'),
    plan: contentPlan,
    destinationPlan: handle,
    destinationRevision: handle,
  }),
]);
const receiptBase = {
  providerEpoch: handle,
  requestId: handle,
  acceptedAt: finite,
  expiresAt: finite,
  outcome: z.enum(['changed', 'noop', 'failed']),
  effects,
  recovery,
};
const original = z.object({ target: handle, state: z.enum(['retained', 'removed', 'unproven']) });
const statusReceipt: z.ZodType<MutationReceiptV1> = z.object({
  ...receiptBase,
  original: original.extend({ task: task.exactOptional() }),
  next: z.object({ target: handle, task: task.exactOptional() }).exactOptional(),
  snapshots,
  warnings,
});
const contentReceipt: z.ZodType<TaskContentReceiptV1> = z.object({
  ...receiptBase,
  plan: handle,
  planRevision: handle,
  original: original.exactOptional(),
  task: reference.exactOptional(),
  destinationEffects: storageEffect.exactOptional(),
  snapshots,
  warnings,
  contentContinuity: z.object({
    plan: handle,
    planRevision: handle,
    correspondence: z.discriminatedUnion('state', [
      z.object({
        state: z.literal('complete'),
        coverage: z.literal('issued-plan-tasks'),
        root: reference.nullable(),
        tasks: z.array(
          z.object({ preparedTarget: handle, committedTarget: handle, committedRevision: handle }),
        ),
        commentCoverage: z.literal('issued-plan-comments').exactOptional(),
        comments: z
          .array(
            z.object({
              preparedTarget: handle,
              committedTarget: handle,
              committedParent: handle,
              committedRevision: handle,
            }),
          )
          .exactOptional(),
      }),
      z.object({ state: z.enum(['unavailable', 'redacted']) }),
    ]),
  }),
});
const noteReceipt: z.ZodType<NoteMutationReceiptV1> = z.object({
  ...receiptBase,
  plan: handle,
  planRevision: handle,
  noteEffects: storageEffect,
  destinationEffects: storageEffect,
  note: reference.exactOptional(),
  section: handle.exactOptional(),
  warnings,
});
const projectReceipt: z.ZodType<ProjectMutationReceiptV1> = z.object({
  ...receiptBase,
  project: reference.exactOptional(),
  task: reference.exactOptional(),
  destinationCopy: storageEffect.exactOptional(),
  sourceRemoval: storageEffect.exactOptional(),
});
/** Receipt shape follows the admitted domain operation, never a permissive union fallback. */
function receiptFor(kind: CommandChange['kind']): z.ZodType<HistoricalCommandReceipt> {
  switch (kind) {
    case 'task':
    case 'cleanup':
      return contentReceipt;
    case 'note':
      return noteReceipt;
    case 'status':
      return statusReceipt;
    case 'project':
    case 'project-create':
    case 'project-move':
      return projectReceipt;
    case 'link':
      return z.never();
  }
}
function rejectOtherReceiptFamily(kind: CommandChange['kind'], value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  let family: CommandChange['kind'] = 'project';
  if ('contentContinuity' in value) family = 'task';
  else if ('noteEffects' in value) family = 'note';
  else if ('original' in value) family = 'status';
  const expected = kind === 'cleanup' ? 'task' : kind;
  const projected = ['project-create', 'project-move'].includes(expected) ? 'project' : expected;
  if (family !== projected) throw new Error('Receipt family mismatch.');
}
const journalEntry = z
  .object({
    id: handle,
    proposalRevision: count,
    origin: z.enum(['proposal', 'direct']).exactOptional(),
    change,
    request: z.object({ requestId: handle, expiresAt: finite }),
    state: z.enum(['admitted', 'settled']),
    effects: effects.exactOptional(),
    receipt: z.unknown().exactOptional(),
    error: text.exactOptional(),
  })
  .transform((entry) => {
    if (entry.origin === 'direct' && entry.change.kind !== 'status')
      throw new Error('Only status changes have a direct journal origin.');
    const { receipt, ...basis } = entry;
    if (receipt === undefined) return basis;
    rejectOtherReceiptFamily(entry.change.kind, receipt);
    return { ...basis, receipt: receiptFor(entry.change.kind).parse(receipt) };
  });
const focus = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task'),
    target: handle,
    revision: handle.exactOptional(),
    plan: handle.exactOptional(),
    expectedPlanRevision: handle.exactOptional(),
  }),
  z.object({ kind: z.enum(['project', 'note']), target: handle, revision: handle.exactOptional() }),
]);
const proposal = z.object({ revision: count, operations: count, changes: z.array(change) });
const preparation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), input: prepareSchema }),
  z.object({ kind: z.literal('note'), input: notePrepareSchema }),
]);
const snapshot: z.ZodType<HistoricalCommandSnapshot> = z.object({
  voiceMode: z.enum(['manual', 'continuous']).exactOptional(),
  uncertaintyAcknowledged: z.boolean().exactOptional(),
  recovery: z.enum(['live', 'historical', 'reviewing', 'uncertain']).exactOptional(),
  preparations: z.array(preparation).exactOptional(),
  recoveryEvidence: z
    .object({ proposal, focus: z.array(focus), preparations: z.array(preparation) })
    .exactOptional(),
  pendingTransition: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('focus'),
        target: z.array(focus),
        previousQuestion: text.nullable().exactOptional(),
      }),
      z.object({
        kind: z.literal('new-session'),
        previousQuestion: text.nullable().exactOptional(),
      }),
    ])
    .nullable()
    .exactOptional(),
  submissionBasis: z.object({ sessionId: handle, proposalRevision: count }).exactOptional(),
  id: handle,
  input: text,
  context: text,
  focus: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('task'),
        target: handle,
        revision: handle.exactOptional(),
        plan: handle.exactOptional(),
        expectedPlanRevision: handle.exactOptional(),
      }),
      z.object({
        kind: z.enum(['project', 'note']),
        target: handle,
        revision: handle.exactOptional(),
      }),
    ]),
  ),
  trees: z.array(z.object({ before: tree.nullable(), after: tree.nullable() })),
  entities: z.object({
    tasks: z.array(treePage),
    projects: z.array(project),
    notes: z.array(notePage),
  }),
  exchanges: z.array(z.object({ role: z.enum(['user', 'agent']), text })),
  activeQuestion: text.nullable(),
  status: z.object({
    kind: z.enum(['thinking', 'searching', 'ready', 'question', 'writing', 'saved', 'error']),
    message: text,
  }),
  proposal,
  journal: z.array(journalEntry),
  actual: z.array(tree),
  blocked: z.boolean(),
});

export type HistoricalCommandReceipt =
  MutationReceiptV1 | TaskContentReceiptV1 | NoteMutationReceiptV1 | ProjectMutationReceiptV1;
export interface HistoricalCommandJournalEntry extends Omit<CommandJournalEntry, 'receipt'> {
  readonly receipt?: HistoricalCommandReceipt;
}
export interface HistoricalCommandSnapshot extends Omit<
  CommandSessionSnapshot,
  'journal' | 'reveal' | 'presentation'
> {
  readonly journal: readonly HistoricalCommandJournalEntry[];
}

/** Historical tokens are evidence only. This wrapper is never a restored live session. */
export interface HistoricalCommandSession {
  readonly handles: 'historical';
  readonly updatedAt: number;
  readonly snapshot: HistoricalCommandSnapshot;
}
export interface CommandHistoryEnvelope {
  readonly version: 1;
  readonly activeSessionId: string | null;
  readonly sessions: readonly HistoricalCommandSession[];
}
const envelope: z.ZodType<CommandHistoryEnvelope> = z
  .object({
    version: z.literal(1),
    activeSessionId: handle.nullable(),
    sessions: z.array(z.object({ handles: z.literal('historical'), updatedAt: finite, snapshot })),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.sessions.map((record) => record.snapshot.id));
    if (
      ids.size !== value.sessions.length ||
      (value.activeSessionId !== null && !ids.has(value.activeSessionId))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid session references.' });
  });

/** Hard safety bounds exceed the 4 MiB canonical capture and 2 MiB durable soft budget.
 * Count repeated aliases separately: serialized JSON duplicates them. Limit stack depth before Zod.
 */
function checkCommandStructure(value: unknown): void {
  const path = new Set<object>();
  let nodes = 0,
    characters = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 2000000 || depth > 96) throw new Error('History structure limit.');
    if (typeof item === 'string') {
      characters += item.length;
      if (characters > 16 * 1024 * 1024) throw new Error('History text limit.');
    }
    if (typeof item !== 'object' || item === null) return;
    if (path.has(item)) throw new Error('Cyclic history.');
    path.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    path.delete(item);
  }
  visit(value, 0);
}
/** Explicit field allowlist; extra runtime/provider fields are deliberately omitted. */
export function projectCommandSnapshot(value: unknown): HistoricalCommandSnapshot {
  checkCommandStructure(value);
  return snapshot.parse(value);
}
export function parseCommandHistory(value: unknown): CommandHistoryEnvelope {
  checkCommandStructure(value);
  return envelope.parse(value);
}
export function hasUnknownCommandResourceEffects(receipt: HistoricalCommandReceipt): boolean {
  return (
    ('noteEffects' in receipt && receipt.noteEffects === 'unknown') ||
    ('destinationEffects' in receipt && receipt.destinationEffects === 'unknown') ||
    ('destinationCopy' in receipt && receipt.destinationCopy === 'unknown') ||
    ('sourceRemoval' in receipt && receipt.sourceRemoval === 'unknown')
  );
}
function hasUnresolvedReceipt(entry: CommandJournalEntry): boolean {
  if (entry.receipt === undefined) return false;
  const parsed = receiptFor(entry.change.kind).safeParse(entry.receipt);
  return (
    !parsed.success ||
    parsed.data.effects === 'unknown' ||
    parsed.data.effects === 'partial' ||
    parsed.data.recovery !== 'none' ||
    hasUnknownCommandResourceEffects(parsed.data)
  );
}
/** A crash can precede blocked publication or the final proposal-clear snapshot. */
export function hasUnresolvedCommandWrites(value: CommandSessionSnapshot): boolean {
  if (value.blocked) return true;
  return value.journal.some((entry) => {
    if (
      entry.state === 'admitted' ||
      entry.effects === undefined ||
      entry.effects === 'unknown' ||
      entry.effects === 'partial'
    )
      return true;
    if (
      entry.effects === 'committed' &&
      entry.origin !== 'direct' &&
      entry.proposalRevision === value.proposal.revision &&
      value.proposal.changes.length > 0
    )
      return true;
    return hasUnresolvedReceipt(entry);
  });
}
/** Pending/uncertain evidence remains protected even when its session is inactive. */
export function isCompletedCommandSession(value: HistoricalCommandSnapshot): boolean {
  return (
    value.input.length === 0 &&
    value.activeQuestion === null &&
    value.pendingTransition == null &&
    value.recovery !== 'reviewing' &&
    value.recovery !== 'uncertain' &&
    value.proposal.changes.length === 0 &&
    !value.blocked &&
    !['thinking', 'searching', 'writing', 'question', 'error'].includes(value.status.kind) &&
    value.journal.every(
      (entry) =>
        entry.state === 'settled' &&
        (entry.effects === 'unchanged' || entry.effects === 'committed') &&
        (entry.receipt === undefined ||
          ((entry.receipt.effects === 'unchanged' || entry.receipt.effects === 'committed') &&
            entry.receipt.recovery === 'none' &&
            !hasUnknownCommandResourceEffects(entry.receipt))),
    )
  );
}
