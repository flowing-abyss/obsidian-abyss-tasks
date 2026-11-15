import { expect, it } from 'vitest';
import type { TaskTreeV1 } from '../api';
import type { CommandSessionSnapshot } from '../src/ai/commandTypes';
import {
  evaluateTurn,
  regradeRetainedTurn,
  resolvePendingTaskStates,
  type RetainedTraceEvent,
  type RetainedTurn,
  type TurnEvidence,
  type TurnExpectation,
} from './command-live/oracles';
import { object } from './command-live/safety';

function task(target: string, due: string): TaskTreeV1 {
  return {
    target,
    revision: `${target}:r1`,
    title: `Task ${target}`,
    markdownTitle: `Task ${target}`,
    parentTarget: undefined,
    source: { path: `${target}.md`, line: 0 },
    dates: { due },
    tags: [],
    comments: [],
    children: [],
    entries: [],
    childCount: 0,
    commentCount: 0,
    timeEntries: [],
    timeEntryCount: 0,
    complete: true,
    truncated: false,
  } as unknown as TaskTreeV1;
}

function history(
  before: TaskTreeV1,
  after: TaskTreeV1,
  previousChanges: unknown[] = [],
): { snapshot: CommandSessionSnapshot; previous: CommandSessionSnapshot } {
  return {
    snapshot: {
      status: { kind: 'ready' },
      journal: [],
      proposal: {
        changes: [
          {
            kind: 'task',
            plan: {
              kind: 'edit',
              target: 'plan-1',
              revision: 'p1',
              providerEpoch: 'epoch',
              before,
              after,
            },
          },
        ],
      },
    } as unknown as CommandSessionSnapshot,
    previous: {
      journal: [],
      proposal: { changes: previousChanges },
    } as unknown as CommandSessionSnapshot,
  };
}
function ownerStore(current: ReturnType<typeof history>): unknown {
  return { activeSessionId: 'session', sessions: [{ snapshot: current.previous }] };
}

it('fails closed when an opted-in pending owner state has no canonical source evidence', () => {
  const expected = {
    status: 'ready',
    pendingTaskStates: [
      { path: 'notes/Field.md', line: 0, tree: { dates: { due: '2027-02-12' } } },
    ],
  } as TurnExpectation;
  const evidence = {
    status: 'ready',
    question: null,
    trees: [],
    before: {},
    after: {},
    journal: [],
    admissions: [],
    complete: true,
    writeCount: 0,
  } satisfies TurnEvidence;

  expect(evaluateTurn(expected, evidence)).toContain('pending-task-state-evidence');
});

it('rejects a newly admitted write even when the write dispatch count is zero', () => {
  const before = task('field', '2027-02-08');
  const after = { ...before, revision: 'field:r2', dates: { due: '2027-02-12' } };
  const current = history(before, after);
  (current.snapshot as unknown as { journal: unknown[] }).journal = [
    { id: 'new-admission', state: 'admitted' },
  ];
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, current, [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
      ownerStore: ownerStore(current),
    }).failures,
  ).toContain('pending-task-state-contract');
});

it('checks declared values against the source-bound persisted owner and canonical edit', () => {
  const before = task('field', '2027-02-08');
  const after = { ...before, revision: 'field:r2', dates: { due: '2027-02-12' } };
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;
  const current = history(before, after);
  const resolved = resolvePendingTaskStates(expected, current, [before], {
    writeCount: 0,
    hostProviderEpoch: 'epoch',
    ownerStore: ownerStore(current),
  });

  expect(resolved.failures).toEqual([]);
  expect(resolved.requestedByTarget.get('field')).toEqual({ dates: { due: '2027-02-12' } });
});

it('rejects a removed undeclared previous pending owner even when declared owners match', () => {
  const before = task('field', '2027-02-08');
  const after = { ...before, revision: 'field:r2', dates: { due: '2027-02-12' } };
  const missing = task('other', '2027-02-16');
  const prior = {
    kind: 'task',
    plan: {
      kind: 'edit',
      target: 'prior-plan',
      revision: 'prior-p1',
      providerEpoch: 'epoch',
      before: missing,
      after: { ...missing, dates: { due: '2027-02-20' } },
    },
  };
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, history(before, after, [prior]), [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-owner');
});

it('accepts removal of the first pending plan when its complete declared owner is restored', () => {
  const studio = task('studio', '2027-02-08');
  const office = task('office', '2027-02-12');
  const officeAfter = { ...office, revision: 'office:r2', dates: { due: '2027-02-10' } };
  const priorStudio = {
    kind: 'task',
    plan: {
      kind: 'edit',
      target: 'studio-plan',
      revision: 'studio-p1',
      providerEpoch: 'epoch',
      before: studio,
      after: { ...studio, revision: 'studio:r2', dates: { due: '2027-02-10' } },
    },
  };
  const current = history(office, officeAfter, [priorStudio]);
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [studio, office],
    pendingTaskStates: [
      { path: 'studio.md', line: 0, tree: { dates: { due: '2027-02-08' } } },
      { path: 'office.md', line: 0, tree: { dates: { due: '2027-02-10' } } },
    ],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, current, [studio, office], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
      ownerStore: ownerStore(current),
    }).failures,
  ).toEqual([]);
});

it('rejects a silent third-owner removal while both declared owners still match', () => {
  const studio = task('studio', '2027-02-08');
  const office = task('office', '2027-02-12');
  const third = task('third', '2027-02-16');
  const officeAfter = { ...office, revision: 'office:r2', dates: { due: '2027-02-10' } };
  const prior = (owner: TaskTreeV1, due: string, plan: string) => ({
    kind: 'task',
    plan: {
      kind: 'edit',
      target: plan,
      revision: `${plan}:r1`,
      providerEpoch: 'epoch',
      before: owner,
      after: { ...owner, revision: `${owner.target}:r2`, dates: { due } },
    },
  });
  const current = history(office, officeAfter, [
    prior(studio, '2027-02-10', 'studio-plan'),
    prior(third, '2027-02-20', 'third-plan'),
  ]);
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [studio, office],
    pendingTaskStates: [
      { path: 'studio.md', line: 0, tree: { dates: { due: '2027-02-08' } } },
      { path: 'office.md', line: 0, tree: { dates: { due: '2027-02-10' } } },
    ],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, current, [studio, office], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
      ownerStore: ownerStore(current),
    }).failures,
  ).toContain('pending-task-state-owner');
});

it('rejects incorrect declared values, source owners, and forged no-op flags', () => {
  const before = task('field', '2027-02-08');
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;
  const wrongValue = { ...before, revision: 'field:r2', dates: { due: '2027-02-14' } };
  expect(
    resolvePendingTaskStates(expected, history(before, wrongValue), [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-value');

  const wrongSource = {
    ...expected,
    pendingTaskStates: [{ path: 'other.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;
  expect(
    resolvePendingTaskStates(wrongSource, history(before, before), [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-owner');

  const falseNoop = {
    kind: 'task',
    plan: {
      kind: 'edit',
      target: 'plan-1',
      revision: 'p1',
      providerEpoch: 'epoch',
      before,
      after: wrongValue,
      hasChanges: false,
    },
  };
  const forged = history(before, before);
  (forged.snapshot as unknown as { proposal: { changes: unknown[] } }).proposal.changes = [
    falseNoop,
  ];
  expect(
    resolvePendingTaskStates(expected, forged, [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-noop');
});

it('rebuilds retained pending state from the raw snapshot instead of serialized flags', () => {
  const before = task('field', '2027-02-08');
  const after = { ...before, revision: 'field:r2', dates: { due: '2027-02-12' } };
  const change = {
    kind: 'task',
    plan: { kind: 'edit', target: 'plan-1', revision: 'p1', providerEpoch: 'epoch', before, after },
  };
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;
  const retained = {
    status: 'ready',
    question: null,
    trees: [after],
    before: {},
    after: {},
    journal: [],
    admissions: [],
    complete: true,
    writeCount: 0,
    preservationFailures: [],
    inputSnapshot: {
      id: 'session',
      input: '',
      focus: [],
      context: '',
      journal: [],
      trees: [],
      entities: { tasks: [], projects: [], notes: [] },
      exchanges: [],
      activeQuestion: null,
      status: { kind: 'ready' },
      proposal: { revision: 1, changes: [] },
      actual: [],
      blocked: false,
    },
    snapshot: {
      id: 'session',
      blocked: false,
      journal: [],
      status: { kind: 'ready' },
      input: '',
      focus: [],
      context: '',
      trees: [{ before, after }],
      entities: { tasks: [], projects: [], notes: [] },
      exchanges: [],
      activeQuestion: null,
      proposal: { revision: 2, changes: [change] },
      actual: [],
    },
    publicReadback: [before],
    hostProviderEpoch: 'epoch',
  } as unknown as RetainedTurn;
  const trace: RetainedTraceEvent[] = [
    { sequence: 1, kind: 'case-phase', data: { phase: 'turn', turn: 1 } },
    { sequence: 2, kind: 'case-phase', data: { phase: 'evaluation', turn: 1 } },
    {
      sequence: 3,
      kind: 'owner-store',
      data: {
        activeSessionId: 'session',
        sessions: [{ snapshot: { id: 'session', journal: [] } }],
      },
    },
  ];

  expect(regradeRetainedTurn(expected, retained, trace, 1).failures).toEqual([]);
  const corrupted = structuredClone(retained);
  const raw = corrupted.snapshot as {
    proposal: { changes: Array<{ plan: { after: { dates: unknown } } }> };
  };
  const firstChange = raw.proposal.changes[0];
  if (firstChange === undefined) throw new Error('Missing retained task plan');
  firstChange.plan.after.dates = { due: '2027-02-14' };
  expect(regradeRetainedTurn(expected, corrupted, trace, 1).failures).toContain(
    'pending-task-state-value',
  );

  const planOnlyTags = structuredClone(retained);
  const planOnlySnapshot = object(planOnlyTags.snapshot);
  const planOnlyChanges = object(planOnlySnapshot['proposal'])['changes'] as unknown[];
  const planOnlyPlan = object(object(planOnlyChanges[0])['plan']);
  object(planOnlyPlan['after'])['tags'] = ['#unrequested'];
  planOnlyTags.preservation = [{ before: after, after, requested: {} }];
  expect(regradeRetainedTurn(expected, planOnlyTags, trace, 1).failures).not.toEqual([]);

  const consistentTags = structuredClone(retained);
  const consistentSnapshot = object(consistentTags.snapshot);
  const consistentProposal = object(consistentSnapshot['proposal']);
  const consistentChanges = consistentProposal['changes'] as unknown[];
  const consistentPlan = object(object(consistentChanges[0])['plan']);
  object(consistentPlan['after'])['tags'] = ['#unrequested'];
  object((consistentSnapshot['trees'] as unknown[])[0])['after'] = {
    ...after,
    tags: ['#unrequested'],
  };
  consistentTags.trees = [{ ...after, tags: ['#unrequested'] }];
  consistentTags.preservation = [
    { before, after: { ...after, tags: ['#unrequested'] }, requested: {} },
  ];
  expect(regradeRetainedTurn(expected, consistentTags, trace, 1).failures).not.toEqual([]);

  const displayOnly = structuredClone(retained);
  displayOnly.trees = [{ ...after, tags: ['#display-only'] }];
  displayOnly.preservation = [{ before: after, after, requested: {} }];
  expect(regradeRetainedTurn(expected, displayOnly, trace, 1).failures).not.toEqual([]);
});

it('rejects duplicate previous owner bindings instead of silently choosing the last plan', () => {
  const before = task('field', '2027-02-08');
  const first = {
    kind: 'task',
    plan: {
      kind: 'edit',
      target: 'prior-1',
      revision: 'p1',
      providerEpoch: 'epoch',
      before,
      after: { ...before, revision: 'field:r2', dates: { due: '2027-02-10' } },
    },
  };
  const second = {
    kind: 'task',
    plan: {
      kind: 'edit',
      target: 'prior-2',
      revision: 'p2',
      providerEpoch: 'epoch',
      before,
      after: { ...before, revision: 'field:r3', dates: { due: '2027-02-11' } },
    },
  };
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, history(before, before, [first, second]), [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-owner');
});

it('rejects incomplete before trees and descendants outside the owner tree', () => {
  const before = task('field', '2027-02-08');
  const child = { ...task('child', '2027-02-09'), parentTarget: 'field' };
  const after = {
    ...before,
    revision: 'field:r2',
    dates: { due: '2027-02-12' },
    children: [child],
  };
  const incompleteBefore = { ...before, complete: false };
  const change = {
    kind: 'task',
    plan: {
      kind: 'edit',
      target: 'plan-1',
      revision: 'p1',
      providerEpoch: 'epoch',
      before: incompleteBefore,
      after,
    },
  };
  const current = history(before, after);
  (current.snapshot as unknown as { proposal: { changes: unknown[] } }).proposal.changes = [change];
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, current, [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-owner');

  const malformedChild = { ...child, parentTarget: 'foreign-owner' };
  const malformedAfter = { ...after, children: [malformedChild] };
  const malformedCurrent = history(before, malformedAfter);
  expect(
    resolvePendingTaskStates(expected, malformedCurrent, [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-owner');
});

it('rejects direct entry reordering when a canonical plan claims to be a no-op', () => {
  const child = { ...task('child', '2027-02-09'), parentTarget: 'field' };
  const timeEntry = {
    target: 'time-1',
    parentTarget: 'field',
    state: 'closed' as const,
    startMs: 1,
    endMs: 2,
  };
  const before = {
    ...task('field', '2027-02-08'),
    children: [child],
    childCount: 1,
    timeEntries: [timeEntry],
    timeEntryCount: 1,
    entries: [
      { kind: 'time-entry', target: 'time-1' },
      { kind: 'child', target: 'child' },
    ] as const,
  };
  const after = {
    ...before,
    entries: [
      { kind: 'child', target: 'child' },
      { kind: 'time-entry', target: 'time-1' },
    ] as const,
  };
  const current = history(before, after);
  const firstChange = (
    current.snapshot as unknown as {
      proposal: { changes: Array<{ plan: object }> };
    }
  ).proposal.changes[0];
  if (firstChange === undefined) throw new Error('Missing current task plan');
  firstChange.plan = {
    kind: 'edit',
    target: 'plan-1',
    revision: 'p1',
    providerEpoch: 'epoch',
    before,
    after,
    hasChanges: false,
  };
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-08' } } }],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(expected, current, [before], {
      writeCount: 0,
      hostProviderEpoch: 'epoch',
    }).failures,
  ).toContain('pending-task-state-noop');
});

it.each([
  ['mismatched child count', (root: TaskTreeV1) => ({ ...root, childCount: 0 })],
  ['missing child entry', (root: TaskTreeV1) => ({ ...root, entries: [] })],
  [
    'duplicate child entry',
    (root: TaskTreeV1) =>
      ({
        ...root,
        entries: [
          { kind: 'child', target: 'child' },
          { kind: 'child', target: 'child' },
        ],
      }) as unknown as TaskTreeV1,
  ],
  [
    'child with a foreign parent',
    (root: TaskTreeV1) => ({
      ...root,
      children: root.children.map((child) => ({ ...child, parentTarget: 'foreign' })),
    }),
  ],
  [
    'comment with a foreign parent',
    (root: TaskTreeV1) => ({
      ...root,
      comments: [{ target: 'comment-1', parentTarget: 'foreign', text: 'Keep this' }],
      commentCount: 1,
      entries: [
        { kind: 'child', target: 'child' },
        { kind: 'comment', target: 'comment-1' },
      ],
    }),
  ],
  [
    'closed time entry with a foreign parent',
    (root: TaskTreeV1) => ({
      ...root,
      timeEntries: [
        {
          target: 'time-1',
          parentTarget: 'foreign',
          state: 'closed',
          startMs: 1,
          endMs: 2,
        },
      ],
      timeEntryCount: 1,
      entries: [
        { kind: 'child', target: 'child' },
        { kind: 'time-entry', target: 'time-1' },
      ],
    }),
  ],
] as const)('rejects incomplete canonical ownership: %s', (_label, mutate) => {
  const child = { ...task('child', '2027-02-09'), parentTarget: 'field' };
  const before = {
    ...task('field', '2027-02-08'),
    children: [child],
    childCount: 1,
    entries: [{ kind: 'child', target: 'child' }],
  } as unknown as TaskTreeV1;
  const malformed = mutate(before) as unknown as TaskTreeV1;
  const expected = {
    status: 'ready',
    writeCount: 0,
    publicTrees: [before],
    pendingTaskStates: [{ path: 'field.md', line: 0, tree: { dates: { due: '2027-02-12' } } }],
  } as TurnExpectation;

  expect(
    resolvePendingTaskStates(
      expected,
      history(malformed, { ...malformed, revision: 'field:r2', dates: { due: '2027-02-12' } }),
      [before],
      { writeCount: 0, hostProviderEpoch: 'epoch' },
    ).failures,
  ).toContain('pending-task-state-owner');
});
