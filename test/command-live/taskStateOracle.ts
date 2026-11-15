import type { TaskLinkExpectation } from './linkOracle';
import { normalizeLinkCarrier } from './linkOracle';
import { object as record } from './safety';
import { hasSourceAbsenceFacts, hasSourceDestination, hasSourceFacts } from './sourceOracle';

export interface ObservationExpectation {
  kind: 'task' | 'note' | 'project';
  path: string;
  line?: number;
  text?: string;
  subpath?: string;
  focused?: boolean;
}
export interface StatusPlanExpectation {
  path: string;
  line: number;
  symbol: string;
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
  pendingTaskStates?: ReadonlyArray<{ path: string; line: number; tree: unknown }>;
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
  structuralOrderRequired?: true;
  relocatedNodeTargets?: readonly string[];
  removedCommentTargets?: readonly string[];
  commentContinuity?: readonly CommentContinuity[];
  nodeContinuity?: ReadonlyArray<{ before: string; after: string }>;
}
export function authoredTaskState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(authoredTaskState);
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
      .map(([key, child]) => [key, authoredTaskState(child)]),
  );
}
export function equal(a: unknown, b: unknown): boolean {
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
      authoredTaskState(normalizeLinkCarrier(carrier['original'])),
      authoredTaskState(normalizeLinkCarrier(actual, carrier['notePath'])),
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
export function matches(expected: unknown, actual: unknown): boolean {
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
export function matchesPendingTaskState(expected: unknown, actual: unknown): boolean {
  return matches(expected, actual);
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
