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
function questionFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  if (expected.status !== 'question' && evidence.question !== null)
    failures.push('unexpected-clarification');
  if (expected.status === 'question' && evidence.question === null)
    failures.push('missing-clarification');
  if (
    expected.questionIncludes !== undefined &&
    evidence.question?.includes(expected.questionIncludes) !== true
  )
    failures.push('clarification-subject');
  return failures;
}
function statusFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  const failures: string[] = [];
  if (evidence.status !== expected.status)
    failures.push(`status:${evidence.status}:expected:${expected.status}`);
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
function writeFailures(expected: TurnExpectation, evidence: TurnEvidence): string[] {
  if (expected.rejectedWrite !== undefined) return rejectedWriteFailures(expected, evidence);
  if (expected.status !== 'saved' && expected.partialSave !== true)
    return expected.allowWrites !== true &&
      (!equal(evidence.before, evidence.after) || evidence.journal.length > 0)
      ? ['unconsented-write']
      : [];
  if (evidence.journal.some((entry) => entry.state !== 'settled' || entry.effects !== 'committed'))
    return ['unsettled-or-uncommitted-effects'];
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
  const failures: string[] = [];
  if (expected.researchCalls !== undefined && evidence.research?.length !== expected.researchCalls)
    failures.push('research-invocations');
  if (
    expected.researchSource !== undefined &&
    !researchSourceMatches(evidence, expected.researchSource)
  )
    failures.push('research-source');
  if (expected.researchPage !== undefined && !researchPageMatches(evidence, expected.researchPage))
    failures.push('research-page');
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
