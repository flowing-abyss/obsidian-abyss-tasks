import { normalizeLinkCarrier, taskLinkFailures, type TaskLinkExpectation } from './linkOracle';
import { hasSourceAbsenceFacts, hasSourceDestination, hasSourceFacts } from './sourceOracle';
export interface ObservationExpectation {
  kind: 'task' | 'note' | 'project';
  path: string;
  line?: number;
  text?: string;
  subpath?: string;
  focused?: boolean;
}
export interface ObservationEvidence extends ObservationExpectation {
  complete: boolean;
}
export interface StatusPlanExpectation {
  path: string;
  line: number;
  symbol: string;
}
export interface ResearchEvidence {
  action?: string;
  invocation: number;
  query: string;
  sources: readonly string[];
}
export interface CommentContinuity {
  before: string;
  after: string;
  ownerBefore: string;
  ownerAfter: string;
}
export interface TurnExpectation {
  status: 'ready' | 'saved' | 'question' | 'error';
  statusAlternatives?: ReadonlyArray<'ready' | 'question' | 'error'>;
  preservedConflict?: true;
  questionIncludes?: string;
  inboxMembers?: readonly boolean[];
  addedNodes?: ReadonlyArray<readonly number[]>;
  removedNodes?: ReadonlyArray<readonly number[]>;
  focus?: readonly ObservationExpectation[];
  proposalKinds?: readonly string[];
  taskSources?: ReadonlyArray<{ path: string; line: number; kind: string }>;
  taskPlanKinds?: readonly string[];
  statusPlans?: readonly StatusPlanExpectation[];
  publicTrees?: readonly unknown[];
  retainPreviousTasks?: boolean;
  freshPreparation?: boolean;
  researchCalls?: number;
  researchCallLimit?: number;
  researchSource?: string;
  researchPage?: string;
  noteFacts?: ReadonlyArray<{ path: string; line: string; source: string }>;

  trees?: readonly unknown[];
  files?: Readonly<Record<string, string>>;
  contains?: Readonly<Record<string, readonly string[]>>;
  absent?: Readonly<Record<string, readonly string[]>>;
  allowWrites?: boolean;
  partialSave?: true;
  rejectedWrite?: { error: string };
  createdFiles?: readonly string[];
  writeCount?: number;
  observations?: readonly ObservationExpectation[];
  projectChanges?: readonly unknown[];
  notePlans?: ReadonlyArray<{ path: string; text: string }>;
  taskLinks?: readonly TaskLinkExpectation[];
  decomposition?: {
    minChildren: number;
    maxChildren: number;
    maxDepth: number;
    noInventedSchedule: boolean;
  };
}
export interface PreservationPair {
  before: unknown;
  after: unknown;
  requested: unknown;
  addedNodeTargets?: readonly string[];
  removedNodeTargets?: readonly string[];
  relocatedNodeTargets?: readonly string[];
  removedCommentTargets?: readonly string[];
  commentContinuity?: readonly CommentContinuity[];
  nodeContinuity?: ReadonlyArray<{ before: string; after: string }>;
}
export interface TurnEvidence {
  status: string;
  inboxMembers?: readonly boolean[];
  focus?: readonly ObservationExpectation[];
  proposalKinds?: readonly string[];
  taskSources?: ReadonlyArray<{ path: string; line: number; kind: string; basisValid: boolean }>;
  statusPlans?: ReadonlyArray<StatusPlanExpectation & { basisValid: boolean }>;
  publicTrees?: readonly unknown[];
  previousTaskContinuity?: boolean;
  freshPreparation?: boolean;
  research?: readonly ResearchEvidence[];
  preservationFailures?: readonly string[];
  question: string | null;
  trees: readonly unknown[];
  before: Readonly<Record<string, string>>;
  after: Readonly<Record<string, string>>;
  journal: ReadonlyArray<{
    id?: string;
    state?: string;
    effects?: string;
    receipt?: unknown;
    error?: string;
  }>;
  admissions: ReadonlyArray<{ id?: string; state?: string }>;
  complete: boolean;
  writeCount?: number;
  preservation?: readonly PreservationPair[];
  observations?: readonly ObservationEvidence[];
  projectChanges?: readonly unknown[];
  notePlans?: ReadonlyArray<{ path: string; text: string }>;
  hostProviderEpoch?: string;
  writeObservations?: {
    input: {
      sessionId: string;
      proposalRevision: number;
      providerEpoch: string;
      proposalChanges: readonly unknown[];
      journal: readonly unknown[];
    };
    final: { sessionId: string; blocked: boolean; recovery?: unknown; journal: readonly unknown[] };
    snapshots: ReadonlyArray<{
      sequence: number;
      kind: 'snapshot' | 'durable-journal';
      sessionId: string;
      journal: readonly unknown[];
    }>;
    dispatches: ReadonlyArray<{ sequence: number; method: string; input: unknown }>;
    results: ReadonlyArray<{ sequence: number; result: unknown }>;
  };
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (typeof a === 'object' && a !== null)
    return (
      typeof b === 'object' &&
      b !== null &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.entries(a).every(([key, value]) => equal(value, record(b)[key]))
    );
  return a === b;
}
function fieldMatcher(expected: unknown, actual: unknown): boolean | undefined {
  const carrier = record(record(expected)['linkCarrier']);
  if (typeof carrier['notePath'] === 'string')
    return equal(
      authored(normalizeLinkCarrier(carrier['original'])),
      authored(normalizeLinkCarrier(actual, carrier['notePath'])),
    );
  const source = record(expected)['sourceText'];
  if (typeof source === 'string') return sourceMatches(expected, actual, source);
  const includes = record(expected)['includes'];
  if (typeof includes === 'string') return typeof actual === 'string' && actual.includes(includes);
  const alternatives = record(expected)['oneOf'];
  return Array.isArray(alternatives) ? alternatives.includes(actual) : undefined;
}
function sourceMatches(expected: unknown, actual: unknown, source: string): boolean {
  const maxLength = record(expected)['maxLength'];
  return (
    typeof actual === 'string' &&
    actual.trim().length > source.length &&
    (typeof maxLength !== 'number' || actual.length <= maxLength) &&
    hasSourceDestination(actual, source) &&
    hasSourceFacts(
      actual,
      (record(expected)['facts'] ?? []) as ReadonlyArray<readonly string[]>,
      (record(expected)['excludes'] ?? []) as readonly string[],
    ) &&
    hasSourceAbsenceFacts(
      actual,
      (record(expected)['absenceFacts'] ?? []) as ReadonlyArray<ReadonlyArray<readonly string[]>>,
    )
  );
}
function matches(expected: unknown, actual: unknown): boolean {
  const special = fieldMatcher(expected, actual);
  if (special !== undefined) return special;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matches(item, actual[i]))
    );
  return objectMatches(expected, actual);
}
function objectMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'object' && expected !== null)
    return (
      typeof actual === 'object' &&
      actual !== null &&
      Object.entries(expected).every(([key, value]) =>
        key === 'dates'
          ? dateMatches(value, record(actual)[key])
          : matches(value, record(actual)[key]),
      )
    );
  return expected === actual;
}
function dateMatches(expected: unknown, actual: unknown): boolean {
  const nonempty = (value: unknown) =>
    Object.fromEntries(Object.entries(record(value)).filter(([, date]) => date !== undefined));
  return equal(nonempty(expected), nonempty(actual));
}
const protectedFields = [
  'markdownTitle',
  'statusSymbol',
  'priority',
  'dates',
  'time',
  'durationMinutes',
  'tags',
  'recurrence',
  'onCompletion',
  'onCompletionExplicit',
  'authoredId',
  'description',
  'comments',
  'children',
  'timeEntries',
];
function authored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(authored);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'target',
            'revision',
            'parentTarget',
            'source',
            'activity',
            'entries',
            'timeEntryCount',
            'childCount',
            'commentCount',
            'complete',
            'truncated',
          ].includes(key),
      )
      .map(([key, child]) => [key, authored(child)]),
  );
}
function preserve(pair: PreservationPair): string[] {
  const before = record(pair.before),
    after = record(pair.after),
    requested = record(pair.requested);
  const fields = protectedFields.flatMap((key) => {
    const carrier = record(record(requested[key])['linkCarrier']);
    if (typeof carrier['notePath'] === 'string')
      return equal(
        authored(normalizeLinkCarrier(before[key])),
        authored(normalizeLinkCarrier(after[key], carrier['notePath'])),
      )
        ? []
        : [`preservation:${key}`];
    if (key in requested) {
      if (key === 'dates')
        return Object.entries(record(before[key]))
          .filter(
            ([date]) =>
              !(date in record(requested[key])) &&
              record(after[key])[date] !== record(before[key])[date],
          )
          .map(([date]) => `preservation:dates.${date}`);
      return [];
    }
    return equal(authored(before[key]), authored(after[key])) ? [] : [`preservation:${key}`];
  });
  const descendants = preserveChildren(pair);
  return [
    ...fields,
    ...retainedComments(
      before,
      after,
      pair.commentContinuity ?? [],
      pair.removedCommentTargets ?? [],
    ),
    ...descendants,
  ];
}
function preserveChildren(pair: PreservationPair): string[] {
  const before = record(pair.before),
    after = record(pair.after),
    requested = record(pair.requested);
  const oldChildren = Array.isArray(before['children']) ? before['children'] : [];
  const children = Array.isArray(after['children']) ? after['children'] : [];
  const expectedChildren = Array.isArray(requested['children']) ? requested['children'] : [];
  const currentTarget = (old: unknown) =>
    pair.nodeContinuity?.find((link) => link.before === record(old)['target'])?.after ??
    record(old)['target'];
  const failures = oldChildren.flatMap((old) => {
    const index = children.findIndex(
      (child) =>
        record(child)['target'] !== undefined && record(child)['target'] === currentTarget(old),
    );
    if (index < 0)
      return [...(pair.removedNodeTargets ?? []), ...(pair.relocatedNodeTargets ?? [])].includes(
        String(record(old)['target']),
      )
        ? []
        : ['preservation:task-correspondence'];
    return preserve({
      ...pair,
      before: old,
      after: children[index],
      requested: expectedChildren[index] ?? {},
    });
  });
  for (const child of children) {
    if (
      oldChildren.some(
        (old) => currentTarget(old) !== undefined && currentTarget(old) === record(child)['target'],
      )
    )
      continue;
    if (
      ![...(pair.addedNodeTargets ?? []), ...(pair.relocatedNodeTargets ?? [])].includes(
        String(record(child)['target']),
      )
    )
      failures.push('preservation:task-correspondence');
  }
  return failures;
}
function retainedComments(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  continuity: readonly CommentContinuity[],
  removed: readonly string[],
): string[] {
  if (!Array.isArray(before['comments']) || !Array.isArray(after['comments'])) return [];
  const current = after['comments'].map(record);
  return before['comments'].map(record).flatMap((comment) => {
    const proof = continuity.find(
      (item) =>
        item.before === comment['target'] &&
        item.ownerBefore === before['target'] &&
        item.ownerAfter === after['target'],
    );
    const same = current.find((item) => item['target'] === (proof?.after ?? comment['target']));
    if (same === undefined)
      return removed.includes(String(comment['target']))
        ? []
        : ['preservation:comment-correspondence'];
    return !equal(same['timestamp'], comment['timestamp'])
      ? ['preservation:comment-timestamp']
      : [];
  });
}
function rootsMatch(expected: readonly unknown[], actual: readonly unknown[]): boolean {
  if (expected.length !== actual.length) return false;
  const assigned = new Map<number, number>();
  const assign = (wanted: number, visited: Set<number>): boolean =>
    actual.some((tree, index) => {
      if (visited.has(index) || !matches(expected[wanted], tree)) return false;
      visited.add(index);
      const previous = assigned.get(index);
      if (previous !== undefined && !assign(previous, visited)) return false;
      assigned.set(index, wanted);
      return true;
    });
  return expected.every((_tree, index) => assign(index, new Set()));
}
export function requestedTree(expected: TurnExpectation, tree: unknown): unknown {
  const matched = expected.trees?.find((want) => matches(want, tree));
  if (matched !== undefined) return matched;
  const candidates = (expected.trees ?? []).filter((want) => {
    const wanted = record(want),
      actual = record(tree);
    if (!Array.isArray(wanted['comments']) || !Array.isArray(actual['comments'])) return false;
    const withoutComments = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'comments'));
    const wantedWithoutComments = withoutComments(wanted),
      actualWithoutComments = withoutComments(actual);
    return matches(wantedWithoutComments, actualWithoutComments);
  });
  return candidates.length === 1 ? candidates[0] : {};
}
type StatusContract = { valid: boolean; allowed: ReadonlySet<string> };
function statusContract(expected: TurnExpectation): StatusContract {
  const alternatives = expected.statusAlternatives;
  const valid =
    alternatives === undefined ||
    (expected.status !== 'saved' &&
      expected.partialSave !== true &&
      alternatives.length <= 2 &&
      new Set(alternatives).size === alternatives.length &&
      alternatives.every(
        (status) => status !== expected.status && ['ready', 'question', 'error'].includes(status),
      ));
  return { valid, allowed: new Set([expected.status, ...(valid ? (alternatives ?? []) : [])]) };
}
function invalidPreservedConflictContract(
  expected: TurnExpectation,
  allowed: ReadonlySet<string>,
): boolean {
  return (
    expected.preservedConflict === true &&
    (expected.files === undefined ||
      expected.publicTrees === undefined ||
      expected.allowWrites === true ||
      expected.partialSave === true ||
      expected.rejectedWrite !== undefined ||
      expected.writeCount !== undefined ||
      [...allowed].some((status) => !['ready', 'question', 'error'].includes(status)))
  );
}
function questionFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const contract = statusContract(expected);
  const realizedStatus = contract.allowed.has(evidence.status) ? evidence.status : expected.status;
  const questionStatus = realizedStatus === 'question';
  return [
    ...(questionStatus || evidence.question === null ? [] : ['unexpected-clarification']),
    ...(!questionStatus || (evidence.question !== null && evidence.question.trim() !== '')
      ? []
      : ['missing-clarification']),
    ...questionSubjectFailure(expected, realizedStatus, evidence.question),
  ];
}
function questionSubjectFailure(
  expected: TurnExpectation,
  status: string,
  question: string | null,
): string[] {
  return expected.questionIncludes === undefined ||
    status !== 'question' ||
    question?.includes(expected.questionIncludes) === true
    ? []
    : ['clarification-subject'];
}
function statusFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  const contract = statusContract(expected);
  if (!contract.valid) failures.push('invalid-status-alternatives');
  if (!contract.allowed.has(evidence.status))
    failures.push(`status:${evidence.status}:expected:${expected.status}`);
  if (invalidPreservedConflictContract(expected, contract.allowed))
    failures.push('invalid-preserved-conflict-contract');
  failures.push(...questionFailures(expected, evidence));
  if (!evidence.complete) failures.push('incomplete-tree');
  if (expected.trees !== undefined && !rootsMatch(expected.trees, evidence.trees))
    failures.push('tree-postcondition');
  return failures;
}
function partialSaveScopeMatches(expected: TurnExpectation, evidence: TurnEvidence): boolean {
  if (
    expected.status !== 'ready' ||
    expected.writeCount === undefined ||
    expected.writeCount < 1 ||
    [expected.files, expected.trees, expected.publicTrees, expected.proposalKinds].some(
      (value) => value === undefined,
    ) ||
    evidence.journal.length !== expected.writeCount
  )
    return false;
  const allowedFiles = expected.files ?? {};
  return Object.keys({ ...evidence.before, ...evidence.after }).every(
    (path) => path in allowedFiles || evidence.before[path] === evidence.after[path],
  );
}
function rejectedWriteFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  if (
    expected.rejectedWrite === undefined ||
    expected.status !== 'error' ||
    expected.writeCount !== 1 ||
    evidence.writeCount !== 1 ||
    expected.files === undefined ||
    !equal(evidence.before, evidence.after) ||
    evidence.journal.length !== 1
  )
    return ['rejected-write-evidence'];
  return evidence.journal.every(
    (entry) =>
      entry.state === 'settled' &&
      entry.effects === 'unchanged' &&
      entry.error === expected.rejectedWrite?.error &&
      entry.receipt === undefined &&
      typeof entry.id === 'string' &&
      evidence.admissions.some(
        (admitted) => admitted.id === entry.id && admitted.state === 'admitted',
      ),
  )
    ? []
    : ['rejected-write-evidence'];
}
type ObservedJournalEntry = {
  sequence: number;
  kind: 'snapshot' | 'durable-journal';
  sessionId: string;
  entry: Record<string, unknown>;
};
function observedJournal(
  observations: NonNullable<TurnEvidence['writeObservations']>,
): ObservedJournalEntry[] {
  return observations.snapshots.flatMap((snapshot) =>
    snapshot.journal.map((entry) => ({
      sequence: snapshot.sequence,
      kind: snapshot.kind,
      sessionId: snapshot.sessionId,
      entry: record(entry),
    })),
  );
}
function logicalJournalKey(sessionId: string, id: unknown): string | undefined {
  return typeof id === 'string' && id.length > 0 ? `${sessionId}\0${id}` : undefined;
}
function stableJournalFields(entry: Record<string, unknown>): unknown {
  return {
    id: entry['id'],
    proposalRevision: entry['proposalRevision'],
    origin: entry['origin'],
    change: entry['change'],
    request: entry['request'],
  };
}
type JournalHistoryBaseline = {
  entries: Map<string, Record<string, unknown>>;
  requests: Set<string>;
};
function journalHistoryBaseline(
  observations: NonNullable<TurnEvidence['writeObservations']>,
): JournalHistoryBaseline | undefined {
  const entries = new Map<string, Record<string, unknown>>();
  const requests = new Set<string>();
  for (const raw of observations.input.journal) {
    const entry = record(raw),
      id = entry['id'],
      requestId = record(entry['request'])['requestId'];
    if (typeof id !== 'string' || id.length === 0 || entries.has(id)) return undefined;
    entries.set(id, entry);
    if (typeof requestId === 'string') requests.add(requestId);
  }
  return { entries, requests };
}
function newJournalHistory(
  sessionId: string,
  baseline: ReadonlyMap<string, Record<string, unknown>>,
  events: readonly ObservedJournalEntry[],
): Map<string, ObservedJournalEntry[]> | undefined {
  const copies = new Map<string, ObservedJournalEntry[]>();
  for (const event of events) {
    const id = event.entry['id'];
    if (typeof id !== 'string' || id.length === 0 || event.sessionId !== sessionId)
      return undefined;
    const prior = baseline.get(id);
    if (prior !== undefined) {
      if (!equal(prior, event.entry)) return undefined;
      continue;
    }
    const found = copies.get(id) ?? [];
    found.push(event);
    copies.set(id, found);
  }
  return copies;
}
function finalJournalMatches(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  baseline: ReadonlyMap<string, Record<string, unknown>>,
  current: ReadonlyMap<string, readonly ObservedJournalEntry[]>,
): Map<string, Record<string, unknown>> | undefined {
  const final = new Map<string, Record<string, unknown>>();
  for (const raw of observations.final.journal) {
    const entry = record(raw);
    const id = entry['id'];
    if (typeof id !== 'string' || final.has(id)) return undefined;
    final.set(id, entry);
  }
  if (
    !finalJournalStateValid(observations, {
      finalSize: final.size,
      finalLength: observations.final.journal.length,
      priorEntries: baseline.size,
      currentEntries: current.size,
    })
  )
    return undefined;
  for (const [id, prior] of baseline) if (!equal(prior, final.get(id))) return undefined;
  for (const [id, copies] of current) {
    const ordered = [...copies].sort((a, b) => a.sequence - b.sequence);
    const last = ordered[ordered.length - 1];
    if (last === undefined || !equal(last.entry, final.get(id))) return undefined;
  }
  return final;
}
function finalJournalStateValid(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  counts: { finalSize: number; finalLength: number; priorEntries: number; currentEntries: number },
): boolean {
  return (
    observations.final.sessionId === observations.input.sessionId &&
    !observations.final.blocked &&
    knownRecoveryState(observations.final.recovery) &&
    observations.final.recovery !== 'uncertain' &&
    counts.finalSize === counts.finalLength &&
    counts.finalSize === counts.priorEntries + counts.currentEntries
  );
}
function knownRecoveryState(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && ['live', 'historical', 'reviewing', 'uncertain'].includes(value))
  );
}
function journalCopiesValid(
  copies: readonly ObservedJournalEntry[],
  inputRequests: ReadonlySet<string>,
): boolean {
  const ordered = [...copies].sort((a, b) => a.sequence - b.sequence);
  const first = ordered[0];
  if (first === undefined) return false;
  let settled: Record<string, unknown> | undefined;
  let previousSequence = -1;
  for (const copy of ordered) {
    const entry = copy.entry;
    if (!journalCopyIdentityValid(copy, first, previousSequence)) return false;
    previousSequence = copy.sequence;
    if (entry['state'] === 'admitted') {
      if (!admittedJournalCopyValid(entry, settled)) return false;
    } else if (entry['state'] === 'settled') {
      if (!settledJournalCopyValid(entry, settled)) return false;
      settled = entry;
    } else return false;
  }
  const requestId = record(first.entry['request'])['requestId'];
  return typeof requestId !== 'string' || !inputRequests.has(requestId);
}
function journalCopyIdentityValid(
  copy: ObservedJournalEntry,
  first: ObservedJournalEntry,
  previousSequence: number,
): boolean {
  return (
    copy.sequence > previousSequence &&
    equal(stableJournalFields(first.entry), stableJournalFields(copy.entry))
  );
}
function admittedJournalCopyValid(
  entry: Record<string, unknown>,
  settled: Record<string, unknown> | undefined,
): boolean {
  return (
    settled === undefined &&
    entry['effects'] === undefined &&
    entry['error'] === undefined &&
    entry['receipt'] === undefined
  );
}
function settledJournalCopyValid(
  entry: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): boolean {
  return (
    ['unchanged', 'committed', 'partial', 'unknown'].includes(String(entry['effects'])) &&
    (previous === undefined || equal(previous, entry))
  );
}
function invalidJournalHistory(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  events: readonly ObservedJournalEntry[],
): boolean {
  const baseline = journalHistoryBaseline(observations);
  if (baseline === undefined) return true;
  const current = newJournalHistory(observations.input.sessionId, baseline.entries, events);
  if (current === undefined) return true;
  if (finalJournalMatches(observations, baseline.entries, current) === undefined) return true;
  return [...current.values()].some((copies) => !journalCopiesValid(copies, baseline.requests));
}
function freshConflictEvents(observations: NonNullable<TurnEvidence['writeObservations']>): {
  events: ObservedJournalEntry[];
  failure?: string;
} {
  const baseline = new Map<string, Record<string, unknown>>();
  for (const entry of observations.input.journal) {
    const raw = record(entry),
      key = logicalJournalKey(observations.input.sessionId, raw['id']);
    if (key === undefined) return { events: [], failure: 'preserved-conflict-admission' };
    baseline.set(key, raw);
  }
  const newEvents: ObservedJournalEntry[] = [];
  for (const event of observedJournal(observations)) {
    const key = logicalJournalKey(event.sessionId, event.entry['id']);
    if (key === undefined) return { events: [], failure: 'preserved-conflict-admission' };
    const old = baseline.get(key);
    if (old !== undefined) {
      if (!equal(old, event.entry)) return { events: [], failure: 'preserved-conflict-settlement' };
    } else newEvents.push(event);
  }
  return { events: newEvents };
}
function groupedConflictEvents(newEvents: readonly ObservedJournalEntry[]): {
  copies: ObservedJournalEntry[];
  failure?: string;
} {
  const byKey = new Map<string, ObservedJournalEntry[]>();
  for (const event of newEvents) {
    const key = logicalJournalKey(event.sessionId, event.entry['id']);
    if (key === undefined) return { copies: [], failure: 'preserved-conflict-admission' };
    const copies = byKey.get(key) ?? [];
    if (
      copies.some(
        (copy) => !equal(stableJournalFields(copy.entry), stableJournalFields(event.entry)),
      )
    )
      return { copies: [], failure: 'preserved-conflict-admission' };
    copies.push(event);
    byKey.set(key, copies);
  }
  if (byKey.size !== 1) return { copies: [], failure: 'preserved-conflict-admission' };
  return { copies: [...(byKey.values().next().value as ObservedJournalEntry[])] };
}
function hasNoConflictActivity(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  newEvents: readonly ObservedJournalEntry[],
): boolean {
  return (
    observations.dispatches.length === 0 &&
    observations.results.length === 0 &&
    newEvents.length === 0
  );
}
function validConflictNativeResult(result: unknown): boolean {
  const raw = record(result),
    error = record(raw['error']);
  return (
    raw['ok'] === false &&
    raw['effects'] === 'unchanged' &&
    ['none', 'reread'].includes(String(raw['recovery'])) &&
    raw['receipt'] === undefined &&
    typeof error['code'] === 'string'
  );
}
function conflictDispatchValid(
  dispatch: NonNullable<ReturnType<typeof conflictResult>['dispatch']>,
  result: NonNullable<ReturnType<typeof conflictResult>['result']>,
  writeCount: number | undefined,
): boolean {
  return (
    dispatch.method === 'tasks.apply' && result.sequence > dispatch.sequence && writeCount === 1
  );
}
function conflictResult(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  newEvents: readonly ObservedJournalEntry[],
  evidence: TurnEvidence,
): {
  dispatch?: (typeof observations.dispatches)[number];
  result?: (typeof observations.results)[number];
  failure?: string;
} {
  if (hasNoConflictActivity(observations, newEvents)) return {};
  if (
    observations.dispatches.length !== 1 ||
    observations.results.length !== 1 ||
    newEvents.length === 0
  )
    return { failure: 'preserved-conflict-dispatch' };
  const dispatch = observations.dispatches[0],
    result = observations.results[0];
  if (
    dispatch === undefined ||
    result === undefined ||
    !conflictDispatchValid(dispatch, result, evidence.writeCount)
  )
    return { failure: 'preserved-conflict-dispatch' };
  if (!validConflictNativeResult(result.result))
    return { failure: 'preserved-conflict-settlement' };
  return { dispatch, result };
}
function conflictRequestMatches(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  input: Record<string, unknown>,
  entry: Record<string, unknown>,
): boolean {
  const request = record(entry['request']);
  return (
    request['requestId'] === input['requestId'] &&
    input['requestId'] !== '' &&
    request['expiresAt'] === input['expiresAt'] &&
    entry['proposalRevision'] === observations.input.proposalRevision
  );
}
function reviewedTaskPlanMatches(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  input: Record<string, unknown>,
  change: Record<string, unknown>,
): boolean {
  const plan = record(change['plan']),
    before = record(plan['before']);
  return (
    observations.input.proposalChanges.some((candidate) => equal(candidate, change)) &&
    input['plan'] === plan['target'] &&
    input['expectedPlanRevision'] === plan['revision'] &&
    change['kind'] === 'task' &&
    plan['kind'] === 'edit' &&
    plan['before'] !== null &&
    typeof before['target'] === 'string' &&
    typeof record(before['source'])['path'] === 'string'
  );
}
function conflictScopeFailure(
  observations: NonNullable<TurnEvidence['writeObservations']>,
  dispatch: NonNullable<ReturnType<typeof conflictResult>['dispatch']>,
  entry: Record<string, unknown>,
): boolean {
  const input = record(dispatch.input),
    change = record(entry['change']);
  return (
    !conflictRequestMatches(observations, input, entry) ||
    !reviewedTaskPlanMatches(observations, input, change)
  );
}
interface ConflictSettlementInput {
  observations: NonNullable<TurnEvidence['writeObservations']>;
  copies: readonly ObservedJournalEntry[];
  dispatch: NonNullable<ReturnType<typeof conflictResult>['dispatch']>;
  result: NonNullable<ReturnType<typeof conflictResult>['result']>;
  requestId: unknown;
}
function conflictSettlementFailure(input: ConflictSettlementInput): boolean {
  const { observations, copies, dispatch, result, requestId } = input;
  const admitted = copies.filter(
    (copy) => copy.kind === 'durable-journal' && copy.entry['state'] === 'admitted',
  );
  const settled = copies.filter(
    (copy) => copy.kind === 'durable-journal' && copy.entry['state'] === 'settled',
  );
  const settledCopies = copies.filter((copy) => copy.entry['state'] === 'settled');
  const entry = settled[settled.length - 1]?.entry;
  const admission = admitted[0];
  const nativeError = record(record(result.result)['error'])['code'];
  if (
    entry === undefined ||
    admission === undefined ||
    invalidConflictJournalSettlement({
      entry,
      admission,
      settled,
      settledCopies,
      dispatch,
      result,
      nativeError,
    })
  )
    return true;
  return !conflictFinalMatches({ observations, copies, entry, nativeError, requestId });
}
function invalidConflictJournalSettlement(input: {
  entry: Record<string, unknown>;
  admission: ObservedJournalEntry;
  settled: readonly ObservedJournalEntry[];
  settledCopies: readonly ObservedJournalEntry[];
  dispatch: NonNullable<ReturnType<typeof conflictResult>['dispatch']>;
  result: NonNullable<ReturnType<typeof conflictResult>['result']>;
  nativeError: unknown;
}): boolean {
  const { entry, admission, settled, settledCopies, dispatch, result, nativeError } = input;
  return (
    admission.sequence >= dispatch.sequence ||
    entry['effects'] !== 'unchanged' ||
    entry['error'] !== nativeError ||
    entry['receipt'] !== undefined ||
    settled.length === 0 ||
    settledCopies.some((copy) => copy.sequence <= result.sequence)
  );
}
function conflictFinalMatches(input: {
  observations: SaveObservations;
  copies: readonly ObservedJournalEntry[];
  entry: Record<string, unknown>;
  nativeError: unknown;
  requestId: unknown;
}): boolean {
  const { observations, copies, entry, nativeError, requestId } = input;
  const finalMatch = observations.final.journal.some((raw) => {
    const finalEntry = record(raw);
    return (
      finalEntry['id'] === entry['id'] &&
      finalEntry['state'] === 'settled' &&
      finalEntry['effects'] === 'unchanged' &&
      finalEntry['error'] === nativeError &&
      finalEntry['receipt'] === undefined &&
      equal(stableJournalFields(finalEntry), stableJournalFields(entry))
    );
  });
  return (
    finalMatch &&
    !copies.some(
      (copy) =>
        copy.entry['request'] !== undefined &&
        record(copy.entry['request'])['requestId'] !== requestId,
    )
  );
}
function conflictContinuationFailure(
  observations: NonNullable<TurnEvidence['writeObservations']>,
): boolean {
  return (
    observations.final.sessionId !== observations.input.sessionId ||
    observations.final.blocked ||
    !knownRecoveryState(observations.final.recovery) ||
    observations.final.recovery === 'uncertain'
  );
}
function preservedConflictFailures(evidence: TurnEvidence): string[] {
  const observations = evidence.writeObservations;
  if (observations === undefined || !equal(evidence.before, evidence.after))
    return ['preserved-conflict-files'];
  const fresh = freshConflictEvents(observations);
  if (fresh.failure !== undefined) return [fresh.failure];
  if (invalidJournalHistory(observations, observedJournal(observations)))
    return ['preserved-conflict-settlement'];
  if (conflictContinuationFailure(observations)) return ['preserved-conflict-settlement'];
  const branch = conflictResult(observations, fresh.events, evidence);
  if (branch.failure !== undefined) return [branch.failure];
  if (branch.dispatch === undefined || branch.result === undefined) return [];
  return dispatchedConflictFailures(observations, fresh.events, branch.dispatch, branch.result);
}
function dispatchedConflictFailures(
  observations: SaveObservations,
  events: readonly ObservedJournalEntry[],
  dispatch: NonNullable<ReturnType<typeof conflictResult>['dispatch']>,
  result: NonNullable<ReturnType<typeof conflictResult>['result']>,
): string[] {
  const copies = groupedConflictEvents(events);
  if (copies.failure !== undefined) return [copies.failure];
  const entry = copies.copies.find((copy) => copy.entry['state'] === 'settled')?.entry;
  const requestId = record(dispatch.input)['requestId'];
  if (entry === undefined) return ['preserved-conflict-settlement'];
  if (conflictScopeFailure(observations, dispatch, entry)) return ['preserved-conflict-scope'];
  if (
    conflictSettlementFailure({ observations, copies: copies.copies, dispatch, result, requestId })
  )
    return ['preserved-conflict-settlement'];
  return [];
}
type SaveObservations = NonNullable<TurnEvidence['writeObservations']>;
interface SuccessfulSaveEntry {
  id: string;
  entry: Record<string, unknown>;
  requestId: string;
  request: Record<string, unknown>;
  plan: Record<string, unknown>;
  dispatch: NonNullable<ReturnType<typeof findSaveDispatch>['dispatch']>;
  result: NonNullable<ReturnType<typeof findSaveDispatch>['result']>;
  receipt: Record<string, unknown>;
}
function currentSaveEntries(
  observations: SaveObservations,
  writes: readonly ObservedJournalEntry[],
): { entries: Map<string, Record<string, unknown>>; failure?: string } {
  if (invalidJournalHistory(observations, writes))
    return { entries: new Map(), failure: 'unchanged-save-settlement' };
  const prior = new Map(observations.input.journal.map((raw) => [record(raw)['id'], record(raw)]));
  const entries = new Map<string, Record<string, unknown>>();
  for (const event of writes) {
    const id = event.entry['id'];
    if (
      event.sessionId !== observations.input.sessionId ||
      typeof id !== 'string' ||
      id.length === 0
    )
      return { entries, failure: 'unchanged-save-admission' };
    const old = prior.get(id);
    if (old !== undefined) {
      if (!equal(old, event.entry)) return { entries, failure: 'unchanged-save-admission' };
      continue;
    }
    const previous = entries.get(id);
    if (
      previous !== undefined &&
      !equal(stableJournalFields(previous), stableJournalFields(event.entry))
    )
      return { entries, failure: 'unchanged-save-admission' };
    entries.set(id, event.entry);
  }
  return { entries };
}
function findSaveDispatch(observations: SaveObservations, requestId: string) {
  const matchingDispatches = observations.dispatches.filter(
    (event) => record(event.input)['requestId'] === requestId,
  );
  const dispatch = matchingDispatches.length === 1 ? matchingDispatches[0] : undefined;
  const result =
    dispatch === undefined
      ? undefined
      : (() => {
          const matchingResults = observations.results.filter((event) => {
            const native = record(event.result),
              receipt = record(native['receipt']);
            return (
              event.sequence > dispatch.sequence &&
              native['ok'] === true &&
              receipt['requestId'] === requestId
            );
          });
          return matchingResults.length === 1 ? matchingResults[0] : undefined;
        })();
  return { dispatch, result };
}
function admittedSaveContextFailure(context: {
  observations: SaveObservations;
  entry: Record<string, unknown>;
  request: Record<string, unknown>;
  plan: Record<string, unknown>;
  input: Record<string, unknown>;
  receipt: Record<string, unknown>;
}): boolean {
  const { observations, entry, request, plan, input, receipt } = context;
  const change = entry['change'];
  return (
    entry['origin'] !== 'proposal' ||
    entry['proposalRevision'] !== observations.input.proposalRevision ||
    !observations.input.proposalChanges.some((candidate) => equal(candidate, change)) ||
    !saveDispatchRequestMatches(request, plan, input) ||
    !saveReceiptMatches({ observations, request, plan, receipt, entry })
  );
}
function saveDispatchRequestMatches(
  request: Record<string, unknown>,
  plan: Record<string, unknown>,
  input: Record<string, unknown>,
): boolean {
  return (
    input['plan'] === plan['target'] &&
    input['expectedPlanRevision'] === plan['revision'] &&
    input['expiresAt'] === request['expiresAt']
  );
}
function saveReceiptMatches(context: {
  observations: SaveObservations;
  request: Record<string, unknown>;
  plan: Record<string, unknown>;
  receipt: Record<string, unknown>;
  entry: Record<string, unknown>;
}): boolean {
  const { observations, request, plan, receipt, entry } = context;
  return (
    receipt['requestId'] === request['requestId'] &&
    receipt['expiresAt'] === request['expiresAt'] &&
    receipt['plan'] === plan['target'] &&
    receipt['planRevision'] === plan['revision'] &&
    plan['providerEpoch'] === observations.input.providerEpoch &&
    receipt['providerEpoch'] === observations.input.providerEpoch &&
    equal(receipt, entry['receipt'])
  );
}
function supportedSavePlan(
  entry: Record<string, unknown>,
  usedRequests: ReadonlySet<string>,
): boolean {
  const requestId = record(entry['request'])['requestId'];
  const change = record(entry['change']),
    plan = record(change['plan']);
  return (
    typeof requestId === 'string' &&
    requestId.length > 0 &&
    !usedRequests.has(requestId) &&
    entry['origin'] === 'proposal' &&
    change['kind'] === 'task' &&
    plan['kind'] === 'edit'
  );
}
function findSuccessfulSaveEntry(
  observations: SaveObservations,
  id: string,
  entry: Record<string, unknown>,
  usedRequests: Set<string>,
): { value?: SuccessfulSaveEntry; failure?: string } {
  const request = record(entry['request']),
    change = record(entry['change']),
    plan = record(change['plan']);
  const requestId = request['requestId'];
  if (!supportedSavePlan(entry, usedRequests)) return { failure: 'unchanged-save-scope' };
  if (typeof requestId !== 'string') return { failure: 'unchanged-save-scope' };
  const pair = findSaveDispatch(observations, requestId);
  if (
    pair.dispatch === undefined ||
    pair.result === undefined ||
    pair.dispatch.method !== 'tasks.apply'
  )
    return { failure: 'unchanged-save-dispatch' };
  const input = record(pair.dispatch.input),
    native = record(pair.result.result),
    receipt = record(native['receipt']);
  if (
    native['ok'] !== true ||
    admittedSaveContextFailure({ observations, entry, request, plan, input, receipt })
  )
    return { failure: 'unchanged-save-admission' };
  usedRequests.add(requestId);
  return {
    value: {
      id,
      entry,
      requestId,
      request,
      plan,
      dispatch: pair.dispatch,
      result: pair.result,
      receipt,
    },
  };
}
function saveDurabilityFailure(
  observations: SaveObservations,
  writes: readonly ObservedJournalEntry[],
  context: SuccessfulSaveEntry,
): boolean {
  const { id, entry, dispatch, result } = context;
  const sameEntry = (event: ObservedJournalEntry) =>
    event.sessionId === observations.input.sessionId && event.entry['id'] === id;
  const copies = writes.filter(sameEntry);
  const admission = copies.find(
    (event) => event.kind === 'durable-journal' && event.entry['state'] === 'admitted',
  );
  const settlement = copies.find(
    (event) => event.kind === 'durable-journal' && event.entry['state'] === 'settled',
  );
  const finalMatch = observations.final.journal.some((raw) => {
    const finalEntry = record(raw);
    return (
      finalEntry['id'] === id &&
      finalEntry['state'] === 'settled' &&
      finalEntry['effects'] === entry['effects'] &&
      equal(stableJournalFields(finalEntry), stableJournalFields(entry)) &&
      equal(finalEntry['receipt'], entry['receipt'])
    );
  });
  return (
    admission === undefined ||
    settlement === undefined ||
    admission.sequence >= dispatch.sequence ||
    settlement.sequence <= result.sequence ||
    copies.some((copy) => copy.entry['state'] === 'settled' && copy.sequence <= result.sequence) ||
    entry['state'] !== 'settled' ||
    entry['error'] !== undefined ||
    !['committed', 'unchanged'].includes(String(entry['effects'])) ||
    !finalMatch
  );
}
function unchangedPlanFailure(plan: Record<string, unknown>): boolean {
  const before = plan['before'],
    after = plan['after'],
    sourcePath = record(record(before)['source'])['path'];
  return (
    before === null ||
    after === null ||
    record(before)['target'] !== record(after)['target'] ||
    typeof sourcePath !== 'string' ||
    sourcePath === '' ||
    !completeTaskTree(before) ||
    !completeTaskTree(after) ||
    !equal(authored(before), authored(after))
  );
}
function unchangedReceiptLineageFailure(
  evidence: TurnEvidence,
  context: SuccessfulSaveEntry,
): boolean {
  const { plan, receipt } = context;
  const continuity = record(receipt['contentContinuity']),
    correspondence = record(continuity['correspondence']);
  const task = record(receipt['task']);
  return (
    !noopReceiptStateValid(receipt, correspondence) ||
    !receiptPlanLineageValid(plan, continuity, correspondence, task) ||
    !completeTaskCorrespondence({
      evidence,
      plan,
      correspondence,
      task,
      original: context.receipt['original'],
    })
  );
}
function noopReceiptStateValid(
  receipt: Record<string, unknown>,
  correspondence: Record<string, unknown>,
): boolean {
  return (
    receipt['outcome'] === 'noop' &&
    receipt['effects'] === 'unchanged' &&
    receipt['recovery'] === 'none' &&
    receipt['snapshots'] === 'complete' &&
    correspondence['state'] === 'complete' &&
    correspondence['coverage'] === 'issued-plan-tasks'
  );
}
function receiptPlanLineageValid(
  plan: Record<string, unknown>,
  continuity: Record<string, unknown>,
  correspondence: Record<string, unknown>,
  task: Record<string, unknown>,
): boolean {
  const root = record(correspondence['root']);
  return (
    continuity['plan'] === plan['target'] &&
    continuity['planRevision'] === plan['revision'] &&
    root['target'] === task['target'] &&
    root['revision'] === task['revision'] &&
    record(plan['before'])['target'] === task['target'] &&
    record(plan['before'])['target'] === record(plan['after'])['target']
  );
}
function taskNodes(value: unknown): Array<Record<string, unknown>> {
  const current = record(value);
  return [
    current,
    ...(Array.isArray(current['children']) ? current['children'].flatMap(taskNodes) : []),
  ];
}
function completeTaskTree(value: unknown): boolean {
  const current = record(value);
  return (
    current['complete'] === true &&
    current['truncated'] === false &&
    Array.isArray(current['children']) &&
    current['children'].every(completeTaskTree)
  );
}
function completeTaskCorrespondence(input: {
  evidence: TurnEvidence;
  plan: Record<string, unknown>;
  correspondence: Record<string, unknown>;
  task: Record<string, unknown>;
  original: unknown;
}): boolean {
  const { evidence, plan, correspondence, task, original } = input;
  const after = plan['after'];
  if (after === null || !completeTaskTree(after)) return false;
  const expectedNodes = taskNodes(after);
  const mappings = correspondence['tasks'];
  if (!Array.isArray(mappings) || mappings.length !== expectedNodes.length) return false;
  const publicNodes = (evidence.publicTrees ?? []).flatMap(taskNodes);
  const byPrepared = new Map<string, Record<string, unknown>>();
  for (const raw of mappings) {
    const mapping = record(raw),
      preparedTarget = mapping['preparedTarget'];
    if (typeof preparedTarget !== 'string' || byPrepared.has(preparedTarget)) return false;
    byPrepared.set(preparedTarget, mapping);
  }
  return (
    retainedTaskRootMatches(plan, task, original) &&
    expectedNodes.every((node) => taskCorrespondenceMatches(node, byPrepared, publicNodes))
  );
}
function retainedTaskRootMatches(
  plan: Record<string, unknown>,
  task: Record<string, unknown>,
  original: unknown,
): boolean {
  const target = record(plan['before'])['target'];
  return (
    record(original)['state'] === 'retained' &&
    record(original)['target'] === target &&
    task['target'] === target
  );
}
function taskCorrespondenceMatches(
  node: Record<string, unknown>,
  mappings: ReadonlyMap<string, Record<string, unknown>>,
  publicNodes: ReadonlyArray<Record<string, unknown>>,
): boolean {
  const target = node['target'];
  if (typeof target !== 'string') return false;
  const mapping = mappings.get(target),
    revision = mapping?.['committedRevision'];
  return (
    mapping?.['committedTarget'] === target &&
    typeof revision === 'string' &&
    revision.length > 0 &&
    publicNodes.some((current) => current['target'] === target && current['revision'] === revision)
  );
}
function unchangedReceiptOwnerFailure(context: SuccessfulSaveEntry): boolean {
  const before = record(context.plan['before']),
    task = record(context.receipt['task']);
  return (
    task['target'] !== before['target'] ||
    record(context.receipt['original'])['state'] !== 'retained' ||
    record(context.receipt['original'])['target'] !== before['target'] ||
    (context.receipt['destinationEffects'] !== undefined &&
      context.receipt['destinationEffects'] !== 'unchanged')
  );
}
function unchangedReadbackFailure(evidence: TurnEvidence, context: SuccessfulSaveEntry): boolean {
  const before = record(context.plan['before']),
    after = context.plan['after'];
  const task = record(context.receipt['task']),
    sourcePath = record(before['source'])['path'];
  return (
    evidence.complete !== true ||
    evidence.publicTrees?.some((tree) => !completeTaskTree(tree)) === true ||
    evidence.publicTrees?.some(
      (tree) =>
        record(tree)['target'] === task['target'] &&
        record(tree)['revision'] === task['revision'] &&
        record(tree)['complete'] === true &&
        record(tree)['truncated'] === false &&
        record(record(tree)['source'])['path'] === sourcePath &&
        equal(authored(tree), authored(after)),
    ) !== true
  );
}
function successfulSaveEntryFailure(
  evidence: TurnEvidence,
  observations: SaveObservations,
  writes: readonly ObservedJournalEntry[],
  context: SuccessfulSaveEntry,
): string | undefined {
  if (saveDurabilityFailure(observations, writes, context)) return 'unchanged-save-settlement';
  return context.entry['effects'] === 'unchanged'
    ? unchangedSaveEntryFailure(evidence, context)
    : committedSaveEntryFailure(context.receipt);
}
function unchangedSaveEntryFailure(
  evidence: TurnEvidence,
  context: SuccessfulSaveEntry,
): string | undefined {
  if (unchangedPlanFailure(context.plan)) return 'unchanged-save-content';
  if (unchangedReceiptLineageFailure(evidence, context) || unchangedReceiptOwnerFailure(context))
    return 'unchanged-save-receipt';
  return unchangedReadbackFailure(evidence, context) ? 'unchanged-save-readback' : undefined;
}
function committedSaveEntryFailure(receipt: Record<string, unknown>): string | undefined {
  const effect = receipt['destinationEffects'];
  return receipt['effects'] === 'committed' &&
    receipt['recovery'] === 'none' &&
    receipt['snapshots'] === 'complete' &&
    (effect === undefined || effect === 'unchanged' || effect === 'committed')
    ? undefined
    : 'unchanged-save-settlement';
}
function successfulSaveEntriesFailure(
  evidence: TurnEvidence,
  observations: SaveObservations,
  writes: readonly ObservedJournalEntry[],
  entries: ReadonlyMap<string, Record<string, unknown>>,
): string[] {
  const usedRequests = new Set<string>();
  const usedDispatches = new Set<number>();
  const usedResults = new Set<number>();
  for (const [id, entry] of entries) {
    const found = findSuccessfulSaveEntry(observations, id, entry, usedRequests);
    if (found.failure !== undefined) return [found.failure];
    if (found.value === undefined) return ['unchanged-save-scope'];
    const failure = successfulSaveEntryFailure(evidence, observations, writes, found.value);
    if (failure !== undefined) return [failure];
    if (
      usedDispatches.has(found.value.dispatch.sequence) ||
      usedResults.has(found.value.result.sequence)
    )
      return ['unchanged-save-dispatch'];
    usedDispatches.add(found.value.dispatch.sequence);
    usedResults.add(found.value.result.sequence);
  }
  return usedDispatches.size === observations.dispatches.length &&
    usedResults.size === observations.results.length
    ? []
    : ['unchanged-save-dispatch'];
}
function successfulUnchangedSaveFailures(evidence: TurnEvidence): string[] {
  const observations = evidence.writeObservations;
  if (observations === undefined) return ['unchanged-save-evidence'];
  const writes = observedJournal(observations);
  const current = currentSaveEntries(observations, writes);
  if (current.failure !== undefined) return [current.failure];
  const { dispatches, results } = observations;
  if (
    invalidSaveActivityCount(
      current.entries.size,
      dispatches.length,
      results.length,
      evidence.writeCount,
    )
  )
    return ['unchanged-save-dispatch'];
  return successfulSaveEntriesFailure(evidence, observations, writes, current.entries);
}
function invalidSaveActivityCount(
  entries: number,
  dispatches: number,
  results: number,
  writeCount?: number,
): boolean {
  return (
    entries === 0 || dispatches !== entries || results !== dispatches || writeCount !== dispatches
  );
}
function ordinaryNoWriteFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  return expected.allowWrites !== true &&
    (!equal(evidence.before, evidence.after) || evidence.journal.length > 0)
    ? ['unconsented-write']
    : [];
}
function completedWriteFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  if (
    evidence.journal.some(
      (entry) =>
        entry.state !== 'settled' ||
        (expected.status === 'saved'
          ? !['committed', 'unchanged'].includes(String(entry.effects))
          : entry.effects !== 'committed'),
    )
  )
    return ['unsettled-or-uncommitted-effects'];
  if (
    expected.status === 'saved' &&
    evidence.journal.some((entry) => entry.effects === 'unchanged')
  )
    return successfulUnchangedSaveFailures(evidence);
  const settled = evidence.journal.filter(
    (entry) =>
      entry.state === 'settled' && entry.effects === 'committed' && entry.receipt !== undefined,
  );
  if (settled.length === 0) return ['saved-without-committed-receipt'];
  return settled.some(
    (entry) =>
      !evidence.admissions.some(
        (admitted) => admitted.id === entry.id && admitted.state === 'admitted',
      ),
  )
    ? ['write-without-durable-admission']
    : [];
}
function writeFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  if (expected.preservedConflict === true) return preservedConflictFailures(evidence);
  if (expected.rejectedWrite !== undefined) return rejectedWriteFailures(expected, evidence);
  if (expected.status !== 'saved' && expected.partialSave !== true)
    return ordinaryNoWriteFailures(expected, evidence);
  return completedWriteFailures(expected, evidence);
}
function fileFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  if (evidence.before['control.md'] !== evidence.after['control.md'])
    failures.push('control-bytes');
  for (const [path, content] of Object.entries(expected.files ?? {}))
    if (evidence.after[path] !== content) failures.push(`file:${path}`);
  if (
    expected.createdFiles !== undefined &&
    !equal(
      [...expected.createdFiles].sort((a, b) => a.localeCompare(b)),
      Object.keys(evidence.after)
        .filter((path) => !(path in evidence.before))
        .sort((a, b) => a.localeCompare(b)),
    )
  )
    failures.push('created-files');
  return [...failures, ...termFailures(expected, evidence)];
}
function termFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const check = (entries: Readonly<Record<string, readonly string[]>>, present: boolean) =>
    Object.entries(entries).flatMap(([path, terms]) =>
      terms
        .filter((term) => (evidence.after[path]?.includes(term) === true) !== present)
        .map((term) => `${present ? 'missing' : 'unexpected'}:${path}:${term}`),
    );
  return [...check(expected.contains ?? {}, true), ...check(expected.absent ?? {}, false)];
}
function observationFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const reads = (expected.observations ?? [])
    .filter(
      (want) => !(evidence.observations ?? []).some((actual) => observationMatches(want, actual)),
    )
    .map((want) => `missing-observation:${want.path}`);
  const projects = (expected.projectChanges ?? [])
    .filter((want) => !(evidence.projectChanges ?? []).some((actual) => matches(want, actual)))
    .map(() => 'project-postcondition');
  const notes = (expected.notePlans ?? [])
    .filter(
      (want) =>
        !(evidence.notePlans ?? []).some(
          (actual) => actual.path === want.path && actual.text.includes(want.text),
        ),
    )
    .map((want) => `note-plan:${want.path}`);
  return [...reads, ...projects, ...notes];
}
function observationMatches(want: ObservationExpectation, actual: ObservationEvidence): boolean {
  const { text, ...identity } = want;
  return (
    actual.complete &&
    matches(identity, actual) &&
    (text === undefined || actual.text?.includes(text) === true)
  );
}
function focusFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  if (expected.focus === undefined) return [];
  const actual = evidence.focus ?? [];
  return expected.focus.length === actual.length &&
    expected.focus.every((want) => actual.some((item) => matches(want, item)))
    ? []
    : ['focus-set'];
}
function proposalFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  const sort = (items: readonly string[]) => [...items].sort((a, b) => a.localeCompare(b));
  if (
    expected.taskPlanKinds !== undefined &&
    !equal(
      sort(expected.taskPlanKinds),
      sort((evidence.taskSources ?? []).map((source) => source.kind)),
    )
  )
    failures.push('task-plan-kinds');
  if (
    expected.proposalKinds !== undefined &&
    !equal(sort(expected.proposalKinds), sort(evidence.proposalKinds ?? []))
  )
    failures.push('proposal-counts');
  if (
    expected.publicTrees !== undefined &&
    !rootsMatch(expected.publicTrees, evidence.publicTrees ?? [])
  )
    failures.push('public-tree-postcondition');
  return failures;
}
function continuationFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  if (expected.freshPreparation === true && evidence.freshPreparation !== true)
    failures.push('fresh-preparation');
  if (expected.retainPreviousTasks === true && evidence.previousTaskContinuity !== true)
    failures.push('preservation:task-correspondence');
  return failures;
}
function basisFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];

  if (
    expected.statusPlans !== undefined &&
    (!matches(expected.statusPlans, evidence.statusPlans) ||
      evidence.statusPlans?.some((item) => !item.basisValid) === true)
  )
    failures.push('status-plan-basis');
  if (
    expected.taskSources !== undefined &&
    (!rootsMatch(expected.taskSources, evidence.taskSources ?? []) ||
      evidence.taskSources?.some((item) => !item.basisValid) === true)
  )
    failures.push('task-source-basis');
  return failures;
}
function noteFactText(
  expected: TurnExpectation,
  evidence: TurnEvidence,
  path: string,
): string | undefined {
  if (expected.status === 'saved') return evidence.after[path];
  const plans = evidence.notePlans?.filter((plan) => plan.path === path) ?? [];
  return plans.length === 1 ? plans[0]?.text : undefined;
}
function researchSourceMatches(evidence: TurnEvidence, source: string): boolean {
  return (
    (evidence.research?.length ?? 0) > 0 &&
    evidence.research?.every((item) => item.sources.includes(source)) === true
  );
}
function researchPageMatches(evidence: TurnEvidence, url: string): boolean {
  return (
    evidence.research?.some(
      (item) => item.action === 'read-page' && item.query === url && item.sources.includes(url),
    ) === true
  );
}
function researchFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures = researchCallLimitFailures(expected, evidence.research?.length ?? 0);
  if (
    expected.researchSource !== undefined &&
    !researchSourceMatches(evidence, expected.researchSource)
  )
    failures.push('research-source');
  if (expected.researchPage !== undefined && !researchPageMatches(evidence, expected.researchPage))
    failures.push('research-page');
  return failures;
}
function researchCallLimitFailures(expected: TurnExpectation, calls: number): string[] {
  const failures: string[] = [];
  if (expected.researchCalls !== undefined && calls !== expected.researchCalls)
    failures.push('research-invocations');
  if (expected.researchCallLimit !== undefined && calls > expected.researchCallLimit)
    failures.push('research-call-limit');
  return failures;
}
function noteFactFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  for (const fact of expected.noteFacts ?? []) {
    const text = noteFactText(expected, evidence, fact.path);
    if (
      text === undefined ||
      !text.split(/\r?\n/).includes(fact.line) ||
      !hasSourceDestination(text, fact.source)
    )
      failures.push(`note-fact:${fact.path}`);
  }
  return failures;
}
function hasSchedule(value: Record<string, unknown>): boolean {
  return (
    Object.values(record(value['dates'])).some((date) => date !== undefined) ||
    value['time'] != null ||
    value['recurrence'] != null
  );
}
/** Structural checks leave the usefulness of an open plan for human review. */
function decompositionFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const constraint = expected.decomposition;
  if (constraint === undefined) return [];
  if (evidence.trees.length !== 1) return ['decomposition:root-count'];
  const failures = new Set<string>();
  const children = record(evidence.trees[0])['children'];
  if (
    !Array.isArray(children) ||
    children.length < constraint.minChildren ||
    children.length > constraint.maxChildren
  )
    failures.add('decomposition:child-count');
  const visit = (node: unknown, depth: number) => {
    const value = record(node);
    if (typeof value['markdownTitle'] !== 'string' || value['markdownTitle'].trim().length === 0)
      failures.add('decomposition:empty-title');
    if (depth > constraint.maxDepth) failures.add('decomposition:depth');
    if (constraint.noInventedSchedule && hasSchedule(value))
      failures.add('decomposition:invented-schedule');
    const descendants = Array.isArray(value['children']) ? value['children'] : [];
    const titles = descendants.map((child) => {
      const title = record(child)['markdownTitle'];
      return typeof title === 'string' ? title.trim().toLowerCase() : '';
    });
    if (new Set(titles).size !== titles.length) failures.add('decomposition:duplicate-title');
    for (const child of descendants) visit(child, depth + 1);
  };
  visit(evidence.trees[0], 0);
  return [...failures];
}
export function evaluateTurn(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  return [
    ...statusFailures(expected, evidence),
    ...(expected.inboxMembers !== undefined && !equal(expected.inboxMembers, evidence.inboxMembers)
      ? ['inbox-membership']
      : []),
    ...focusFailures(expected, evidence),
    ...proposalFailures(expected, evidence),
    ...continuationFailures(expected, evidence),
    ...basisFailures(expected, evidence),
    ...researchFailures(expected, evidence),
    ...decompositionFailures(expected, evidence),
    ...noteFactFailures(expected, evidence),
    ...(evidence.preservationFailures ?? []),
    ...(expected.writeCount !== undefined && expected.writeCount !== evidence.writeCount
      ? ['write-count']
      : []),
    ...(expected.partialSave === true && !partialSaveScopeMatches(expected, evidence)
      ? ['partial-save-scope']
      : []),
    ...writeFailures(expected, evidence),
    ...fileFailures(expected, evidence),
    ...observationFailures(expected, evidence),
    ...taskLinkFailures(expected.taskLinks ?? [], evidence.trees),
    ...(evidence.preservation ?? []).flatMap(preserve),
  ];
}

export interface RetainedTurn extends TurnEvidence {
  inputSnapshot: unknown;
  snapshot: unknown;
  publicReadback: readonly unknown[];
}
export interface RetainedTraceEvent {
  sequence: number;
  kind: string;
  data: unknown;
}
function phaseTurn(value: unknown): number | undefined {
  const turn = record(value)['turn'];
  return Number.isSafeInteger(turn) ? (turn as number) : undefined;
}
function retainedTurnTrace(
  trace: readonly RetainedTraceEvent[],
  turn: number,
): readonly RetainedTraceEvent[] | undefined {
  if (!Number.isSafeInteger(turn) || turn < 1 || trace.length === 0) return undefined;
  if (trace.some((event, index) => event.sequence !== index + 1)) return undefined;
  const starts = trace.flatMap((event, index) =>
    event.kind === 'case-phase' &&
    record(event.data)['phase'] === 'turn' &&
    phaseTurn(event.data) === turn
      ? [index]
      : [],
  );
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  if (start === undefined) return undefined;
  const ends = trace.flatMap((event, index) =>
    index > start &&
    event.kind === 'case-phase' &&
    record(event.data)['phase'] === 'evaluation' &&
    phaseTurn(event.data) === turn
      ? [index]
      : [],
  );
  if (ends.length !== 1) return undefined;
  const end = ends[0];
  if (end === undefined) return undefined;
  if (
    trace
      .slice(start + 1, end)
      .some(
        (event) =>
          event.kind === 'case-phase' &&
          record(event.data)['phase'] === 'turn' &&
          (phaseTurn(event.data) ?? 0) > turn,
      )
  )
    return undefined;
  return trace.slice(start + 1, end);
}
function retainedSnapshot(value: unknown): Record<string, unknown> | undefined {
  const snapshot = record(value),
    proposal = record(snapshot['proposal']);
  return typeof snapshot['id'] === 'string' &&
    Array.isArray(snapshot['journal']) &&
    Array.isArray(proposal['changes']) &&
    Number.isSafeInteger(proposal['revision'])
    ? snapshot
    : undefined;
}
function retainedJournalSummary(value: unknown): TurnEvidence['journal'][number] | undefined {
  const entry = record(value);
  if (typeof entry['id'] !== 'string' || typeof entry['state'] !== 'string') return undefined;
  return {
    id: entry['id'],
    state: entry['state'],
    ...(typeof entry['effects'] === 'string' ? { effects: entry['effects'] } : {}),
    ...(entry['receipt'] === undefined ? {} : { receipt: entry['receipt'] }),
    ...(typeof entry['error'] === 'string' ? { error: entry['error'] } : {}),
  };
}
function retainedPriorJournal(before: Record<string, unknown>): Map<string, unknown> | undefined {
  const prior = new Map<string, unknown>();
  for (const raw of before['journal'] as unknown[]) {
    const id = record(raw)['id'];
    if (typeof id !== 'string' || prior.has(id)) return undefined;
    prior.set(id, raw);
  }
  return prior;
}
function retainedFinalJournal(
  after: Record<string, unknown>,
  prior: ReadonlyMap<string, unknown>,
): { ids: Set<string>; current: TurnEvidence['journal'] } | undefined {
  const finalIds = new Set<string>();
  const current: Array<TurnEvidence['journal'][number]> = [];
  for (const raw of after['journal'] as unknown[]) {
    const entry = record(raw);
    const id = entry['id'];
    if (typeof id !== 'string' || finalIds.has(id)) return undefined;
    finalIds.add(id);
    const previous = prior.get(id);
    if (previous !== undefined) {
      if (!equal(previous, raw)) return undefined;
      continue;
    }
    const summary = retainedJournalSummary(raw);
    if (summary === undefined) return undefined;
    current.push(summary);
  }
  return { ids: finalIds, current };
}
function retainedCurrentJournal(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): TurnEvidence['journal'] | undefined {
  const prior = retainedPriorJournal(before);
  if (prior === undefined) return undefined;
  const final = retainedFinalJournal(after, prior);
  return final?.current;
}
function retainedSummaryMatches(
  turn: RetainedTurn,
  journal: TurnEvidence['journal'],
  dispatchCount: number,
): boolean {
  const reported = Array.isArray(turn.journal)
    ? turn.journal.map(retainedJournalSummary)
    : undefined;
  return (
    reported !== undefined &&
    reported.every((entry) => entry !== undefined) &&
    equal(reported, journal) &&
    turn.writeCount === dispatchCount
  );
}
type RetainedProjectionEvent =
  | { kind: 'snapshot'; value: NonNullable<TurnEvidence['writeObservations']>['snapshots'][number] }
  | {
      kind: 'dispatch';
      value: NonNullable<TurnEvidence['writeObservations']>['dispatches'][number];
    }
  | { kind: 'result'; value: NonNullable<TurnEvidence['writeObservations']>['results'][number] }
  | { kind: 'ignored' };
function retainedProjectionEvent(event: RetainedTraceEvent): RetainedProjectionEvent | undefined {
  if (event.kind === 'snapshot' || event.kind === 'durable-journal') {
    const snapshot = record(event.data);
    if (typeof snapshot['id'] !== 'string' || !Array.isArray(snapshot['journal'])) return undefined;
    return {
      kind: 'snapshot',
      value: {
        sequence: event.sequence,
        kind: event.kind,
        sessionId: snapshot['id'],
        journal: snapshot['journal'],
      },
    };
  }
  if (event.kind === 'write-dispatch') {
    const data = record(event.data);
    if (typeof data['method'] !== 'string' || data['input'] === undefined) return undefined;
    return {
      kind: 'dispatch',
      value: { sequence: event.sequence, method: data['method'], input: data['input'] },
    };
  }
  return event.kind === 'write-result'
    ? { kind: 'result', value: { sequence: event.sequence, result: event.data } }
    : { kind: 'ignored' };
}
function retainedObservations(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  trace: readonly RetainedTraceEvent[];
  providerEpoch: string;
}): NonNullable<TurnEvidence['writeObservations']> | undefined {
  const snapshots: Array<NonNullable<TurnEvidence['writeObservations']>['snapshots'][number]> = [];
  const dispatches: Array<NonNullable<TurnEvidence['writeObservations']>['dispatches'][number]> =
    [];
  const results: Array<NonNullable<TurnEvidence['writeObservations']>['results'][number]> = [];
  for (const event of input.trace) {
    const projected = retainedProjectionEvent(event);
    if (projected === undefined) return undefined;
    if (projected.kind === 'snapshot') snapshots.push(projected.value);
    else if (projected.kind === 'dispatch') dispatches.push(projected.value);
    else if (projected.kind === 'result') results.push(projected.value);
  }
  const beforeProposal = record(input.before['proposal']);
  return {
    input: {
      sessionId: String(input.before['id']),
      proposalRevision: Number(beforeProposal['revision']),
      providerEpoch: input.providerEpoch,
      proposalChanges: beforeProposal['changes'] as readonly unknown[],
      journal: input.before['journal'] as readonly unknown[],
    },
    final: {
      sessionId: String(input.after['id']),
      blocked: input.after['blocked'] === true,
      ...(input.after['recovery'] !== undefined ? { recovery: input.after['recovery'] } : {}),
      journal: input.after['journal'] as readonly unknown[],
    },
    snapshots,
    dispatches,
    results,
  };
}
interface RetainedTurnParts {
  events: readonly RetainedTraceEvent[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  currentJournal: TurnEvidence['journal'];
}
function retainedTurnParts(
  turn: RetainedTurn,
  trace: readonly RetainedTraceEvent[],
  oneBasedTurn: number,
): RetainedTurnParts | undefined {
  const events = retainedTurnTrace(trace, oneBasedTurn);
  const before = retainedSnapshot(turn.inputSnapshot);
  const after = retainedSnapshot(turn.snapshot);
  if (
    events === undefined ||
    before === undefined ||
    after === undefined ||
    typeof after['blocked'] !== 'boolean' ||
    !Array.isArray(turn.publicReadback)
  )
    return undefined;
  const currentJournal = retainedCurrentJournal(before, after);
  return currentJournal === undefined ? undefined : { events, before, after, currentJournal };
}
function retainedTurnEvidenceFromParts(
  expected: TurnExpectation,
  turn: RetainedTurn,
  parts: RetainedTurnParts,
): TurnEvidence {
  const { events, before, after, currentJournal } = parts;
  const evidence = { ...turn } as TurnEvidence;
  evidence.publicTrees = turn.publicReadback.filter(
    (tree) => record(record(tree)['source'])['path'] !== 'control.md',
  );
  delete evidence.writeObservations;
  const dispatchCount = events.filter((event) => event.kind === 'write-dispatch').length;
  if (!retainedSummaryMatches(turn, currentJournal, dispatchCount))
    evidence.preservationFailures = [
      ...(evidence.preservationFailures ?? []),
      'retained-write-summary',
    ];
  evidence.journal = currentJournal;
  evidence.writeCount = dispatchCount;
  if (needsRetainedWriteEvidence(expected, currentJournal)) {
    if (typeof turn.hostProviderEpoch !== 'string' || turn.hostProviderEpoch.length === 0)
      return evidence;
    const observations = retainedObservations({
      before,
      after,
      trace: events,
      providerEpoch: turn.hostProviderEpoch,
    });
    if (observations !== undefined) evidence.writeObservations = observations;
  }
  return evidence;
}
function retainedTurnEvidence(
  expected: TurnExpectation,
  turn: RetainedTurn,
  trace: readonly RetainedTraceEvent[],
  oneBasedTurn: number,
): TurnEvidence | undefined {
  const parts = retainedTurnParts(turn, trace, oneBasedTurn);
  return parts === undefined ? undefined : retainedTurnEvidenceFromParts(expected, turn, parts);
}
function needsRetainedWriteEvidence(
  expected: TurnExpectation,
  currentJournal: TurnEvidence['journal'],
): boolean {
  return (
    expected.preservedConflict === true ||
    (expected.status === 'saved' && currentJournal.some((entry) => entry.effects === 'unchanged'))
  );
}
/** Regrades a retained turn using its serialized snapshots and canonical trace. Turn numbers are one-based. */
export function regradeRetainedTurn(
  expected: TurnExpectation,
  turn: RetainedTurn,
  trace: readonly RetainedTraceEvent[],
  oneBasedTurn: number,
): { failures: string[]; evidence?: TurnEvidence } {
  const evidence = retainedTurnEvidence(expected, turn, trace, oneBasedTurn);
  return evidence === undefined
    ? { failures: ['retained-turn-evidence'] }
    : { failures: evaluateTurn(expected, evidence), evidence };
}
