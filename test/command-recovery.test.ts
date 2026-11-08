import { expect, it } from 'vitest';
import { isCompletedCommandSession, projectCommandSnapshot } from '../src/ai/commandRecovery';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';
import { expectDefined } from './helpers';
import { publicApiHarness } from './support/publicApiHarness';

export function emptySnapshot(id = 'session'): CommandSessionSnapshot {
  return {
    id,
    input: '',
    focus: [],
    context: '',
    trees: [],
    entities: { tasks: [], projects: [], notes: [] },
    exchanges: [],
    activeQuestion: null,
    status: { kind: 'ready', message: '' },
    proposal: { revision: 0, operations: 0, changes: [] },
    journal: [],
    actual: [],
    blocked: false,
  };
}

it('projects exact canonical trees, proposals, receipt evidence and long exchanges', async () => {
  const h = await publicApiHarness({ 'a.md': '- [ ] Existing\n' });
  try {
    const api = h.client();
    const prepared = await expectDefined(api.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
      tree: {
        markdownTitle: 'Parent',
        description: 'Full intent',
        children: [{ markdownTitle: 'Child' }],
      },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const result = await expectDefined(api.tasks.create)({
      plan: prepared.value.target,
      expectedPlanRevision: prepared.value.revision,
      requestId: 'receipt-1',
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    });
    if (!result.ok) throw new Error(result.error.code);
    const change = { kind: 'task', plan: prepared.value } as const;
    const snapshot: CommandSessionSnapshot = {
      ...emptySnapshot(),
      submissionBasis: { sessionId: 'session', proposalRevision: 1 },
      input: 'Keep all constraints',
      context: 'Task context',
      focus: [{ kind: 'task', target: 'draft', plan: prepared.value.target }],
      trees: [{ before: prepared.value.before, after: prepared.value.after }],
      exchanges: Array.from({ length: 35 }, (_, n) => ({
        role: 'user',
        text: `Command ${n} ${'я'.repeat(5000)}`,
      })),
      proposal: { revision: 1, operations: 2, changes: [change] },
      journal: [
        {
          id: 'entry',
          proposalRevision: 1,
          change,
          request: { requestId: 'receipt-1', expiresAt: Date.UTC(2026, 7, 1, 12) + 60000 },
          state: 'settled',
          effects: 'committed',
          receipt: result.receipt,
        },
      ],
    };
    expect(projectCommandSnapshot(snapshot)).toEqual(snapshot);
    const injected = {
      ...snapshot,
      provider: { apiKey: 'secret' },
      reasoning: 'private',
      audio: 'binary',
      proposal: {
        ...snapshot.proposal,
        changes: [{ ...change, plan: { ...change.plan, apiKey: 'secret' } }],
      },
      journal: [
        {
          ...snapshot.journal[0],
          receipt: { ...result.receipt, reasoning: 'private', provider: { key: 'secret' } },
        },
      ],
    };
    expect(projectCommandSnapshot(injected)).toEqual(snapshot);
  } finally {
    h.dispose();
  }
});

it('refuses malformed required domain values and cyclic or deep values', () => {
  expect(() => projectCommandSnapshot({ ...emptySnapshot(), blocked: 'no' })).toThrow();
  expect(() =>
    projectCommandSnapshot({
      ...emptySnapshot(),
      proposal: { revision: 0, operations: 0, changes: [{ kind: 'task', plan: {} }] },
    }),
  ).toThrow();
  const cyclic: Record<string, unknown> = {};
  cyclic['cycle'] = cyclic;
  expect(() => projectCommandSnapshot({ ...emptySnapshot(), provider: cyclic })).toThrow();
  let deep: unknown = 'end';
  for (let i = 0; i < 150; i++) deep = { deep };
  expect(() => projectCommandSnapshot({ ...emptySnapshot(), provider: deep })).toThrow();
});

it('retains every project/note/status DTO field and chooses receipt schemas by operation kind', () => {
  const observation = {
    providerEpoch: 'epoch',
    generation: 1,
    scopeRevision: 2,
    semanticsRevision: 3,
  };
  const project = {
    target: 'project',
    revision: 'revision',
    path: 'Project.md',
    name: 'Project',
    status: { state: 'absent' },
    stats: {
      total: 2,
      done: 1,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 10, openStartsMs: [20] },
    },
    tags: ['tag'],
    fields: [
      { fieldId: 'budget', state: 'value', value: [1, 'two'] },
      { fieldId: 'other', state: 'absent' },
    ],
  } as const;
  const note = {
    ...observation,
    revision: 4,
    note: { target: 'note', revision: 'nr', path: 'Note.md', name: 'Note', aliases: ['Alias'] },
    selection: 'heading',
    resolvedSubpath: 'Heading',
    segments: [
      {
        section: {
          target: 'section',
          kind: 'heading',
          label: 'Heading',
          canReplace: true,
          canAppend: true,
        },
        text: 'Original text',
        continuesPrevious: false,
        continuesNext: true,
      },
    ],
    complete: false,
    truncated: true,
    nextCursor: 'cursor',
    markdownLink: '[[Note#Heading]]',
  } as const;
  const plan = {
    ...observation,
    target: 'np',
    revision: 'npr',
    kind: 'edit',
    expiresAt: 100,
    path: 'Note.md',
    before: { text: 'Original', complete: true },
    after: { text: 'Original + new', complete: true },
    note: { target: 'note', revision: 'nr' },
    section: 'section',
  } as const;
  const changes = [
    {
      kind: 'project',
      before: project,
      fields: [{ fieldId: 'budget', value: null }],
      statusId: null,
    },
    { kind: 'note', plan },
    {
      kind: 'status',
      target: 'task',
      revision: 'tr',
      symbol: 'x',
      nuance: 'Complete just this task',
    },
  ] as const;
  const base = {
    providerEpoch: 'epoch',
    requestId: 'request',
    acceptedAt: 10,
    expiresAt: 100,
    outcome: 'changed',
    effects: 'committed',
    recovery: 'none',
  } as const;
  const receipts = [
    {
      ...base,
      project: { target: 'project', revision: 'pr' },
      task: { target: 'task', revision: 'tr' },
      destinationCopy: 'committed',
      sourceRemoval: 'unchanged',
    },
    {
      ...base,
      plan: 'np',
      planRevision: 'npr',
      noteEffects: 'committed',
      destinationEffects: 'committed',
      note: { target: 'note', revision: 'nr2' },
      warnings: [{ code: 'code', message: 'message' }],
    },
    {
      ...base,
      original: { target: 'task', state: 'retained' },
      next: { target: 'next' },
      snapshots: 'unavailable',
      warnings: [],
    },
  ] as const;
  const value: CommandSessionSnapshot = {
    ...emptySnapshot(),
    entities: { tasks: [], projects: [project], notes: [note] },
    proposal: { revision: 1, operations: 3, changes },
    journal: changes.map((change, i) => ({
      id: `entry-${i}`,
      proposalRevision: 1,
      change,
      request: { requestId: 'request', expiresAt: 100 },
      state: 'settled',
      effects: 'committed',
      receipt: receipts[i],
      error: 'kept code',
    })),
  };
  expect(projectCommandSnapshot(value)).toEqual(value);
  const wrongReceipt = { ...value, journal: [{ ...value.journal[0], receipt: receipts[1] }] };
  // A note receipt cannot be accepted as an apparently valid bare project receipt.
  expect(() => projectCommandSnapshot(wrongReceipt)).toThrow();
});

it('preserves populated tree metadata, entry order, copy witnesses, links and cleanup bases', () => {
  const tree = {
    target: 'task',
    revision: 'revision',
    title: 'Task',
    markdownTitle: '**Task**',
    status: 'open',
    statusSymbol: ' ',
    priority: 'A',
    dates: {
      created: '2026-01-01',
      start: '2026-02-01',
      scheduled: '2026-02-02',
      due: '2026-02-03',
      completion: '2026-02-04',
      cancelled: '2026-02-05',
    },
    time: '09:30',
    durationMinutes: 45,
    tags: ['tag'],
    recurrence: 'every day',
    onCompletion: 'keep',
    onCompletionExplicit: true,
    authoredId: 'authored',
    source: { path: 'a.md', line: 2 },
    parentTarget: 'parent',
    description: 'Description',
    children: [],
    comments: [
      {
        target: 'comment1',
        parentTarget: 'task',
        text: 'Day',
        timestamp: { precision: 'day', value: '2026-02-01' },
      },
      {
        target: 'comment2',
        parentTarget: 'task',
        text: 'Instant',
        timestamp: { precision: 'instant', atom: '2026-02-01T12:00:00Z', epochMs: 10 },
      },
    ],
    activity: {
      observedAtMs: 20,
      own: {
        closedMs: 10,
        runningCount: 1,
        runningMsAtObservation: 5,
        lastRecordedWorkAtMs: 15,
        brokenEntryCount: 1,
      },
      subtree: { closedMs: 10, runningCount: 1, runningMsAtObservation: 5, brokenEntryCount: 1 },
    },
    timeEntries: [
      {
        target: 'tracking',
        parentTarget: 'task',
        state: 'broken',
        startMs: 10,
        endMs: 5,
        note: 'Evidence',
        issue: 'end-before-start',
      },
    ],
    entries: [
      { kind: 'comment', target: 'comment1' },
      { kind: 'time-entry', target: 'tracking' },
      { kind: 'comment', target: 'comment2' },
    ],
    timeEntryCount: 1,
    childCount: 0,
    commentCount: 2,
    complete: true,
    truncated: false,
  } as const;
  const plan = {
    providerEpoch: 'epoch',
    generation: 1,
    scopeRevision: 2,
    semanticsRevision: 3,
    target: 'plan',
    revision: 'plan-revision',
    kind: 'edit',
    expiresAt: 100,
    before: tree,
    after: tree,
    destination: {
      type: 'project',
      path: 'Project.md',
      insertion: { type: 'section', heading: 'Tasks', position: 'bottom' },
      projectTarget: 'project',
      projectRevision: 'pr',
    },
    copies: [
      {
        type: 'subtree',
        source: 'source',
        sourceRoot: { target: 'source-root', revision: 'sr' },
        state: 'retained',
        tasks: [{ sourceTarget: 'source', destinationTarget: 'task' }],
        comments: [
          { sourceTarget: 'sc', destinationTarget: 'comment1', destinationParent: 'task' },
        ],
      },
    ],
    mergePreservation: {
      planRevision: 'plan-revision',
      sourceRoot: { target: 'source-root', revision: 'sr' },
      state: 'covered',
      entries: [
        {
          kind: 'constraint',
          field: 'description',
          state: 'held',
          reason: 'Review source evidence',
        },
      ],
    },
  } as const;
  const value: CommandSessionSnapshot = {
    ...emptySnapshot(),
    trees: [{ before: tree, after: tree }],
    actual: [tree],
    entities: {
      tasks: [
        {
          providerEpoch: 'epoch',
          generation: 1,
          scopeRevision: 2,
          semanticsRevision: 3,
          revision: 4,
          tree,
          complete: true,
          truncated: false,
          nextCursor: 'cursor',
        },
      ],
      projects: [],
      notes: [],
    },
    proposal: {
      revision: 1,
      operations: 3,
      changes: [
        { kind: 'task', plan },
        {
          kind: 'link',
          plan,
          notePlan: 'note-plan',
          target: 'task',
          field: 'description',
          template: 'Link {{link}}',
          placeholder: '[[Note]]',
          sourcePath: 'Project.md',
          alias: 'Alias',
        },
        { kind: 'cleanup', plan, destinationPlan: 'destination', destinationRevision: 'dr' },
      ],
    },
  };
  expect(projectCommandSnapshot(value)).toEqual(value);
  expect(() =>
    projectCommandSnapshot({ ...value, actual: [{ ...tree, activity: undefined }] }),
  ).toThrow();
  expect(() =>
    projectCommandSnapshot({
      ...value,
      actual: [{ ...tree, entries: [{ kind: 'provider', target: 'secret' }] }],
    }),
  ).toThrow();
});

it('preserves unknown content-destination effects as unresolved despite a committed aggregate', () => {
  const value: CommandSessionSnapshot = {
    ...emptySnapshot(),
    journal: [
      {
        id: 'entry',
        proposalRevision: 1,
        state: 'settled',
        effects: 'committed',
        request: { requestId: 'request', expiresAt: 100 },
        change: {
          kind: 'task',
          plan: {
            providerEpoch: 'epoch',
            generation: 1,
            scopeRevision: 1,
            semanticsRevision: 1,
            target: 'plan',
            revision: 'revision',
            kind: 'edit',
            expiresAt: 100,
            before: null,
            after: null,
          },
        },
        receipt: {
          providerEpoch: 'epoch',
          requestId: 'request',
          acceptedAt: 10,
          expiresAt: 100,
          plan: 'plan',
          planRevision: 'revision',
          outcome: 'changed',
          effects: 'committed',
          recovery: 'none',
          destinationEffects: 'unknown',
          snapshots: 'unavailable',
          warnings: [],
          contentContinuity: {
            plan: 'plan',
            planRevision: 'revision',
            correspondence: { state: 'unavailable' },
          },
        },
      },
    ],
  };
  const projected = projectCommandSnapshot(value);
  expect(projected).toEqual(value);
  expect(isCompletedCommandSession(projected)).toBe(false);
});
