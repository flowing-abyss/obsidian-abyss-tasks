import { Platform } from 'obsidian';
import type { ContentPlanV1, ContentSourceCopyV1, TaskTreeV1 } from '../../api';
import { commandPlanViews } from '../../src/ai/commandSchemas';
import type { CommandSessionSnapshot } from '../../src/ai/commandTypes';
import { normalizeLinkCarrier } from './linkOracle';
import { object } from './safety';
import type { CommentContinuity, PreservationPair, TurnExpectation } from './taskStateOracle';
import {
  authoredTaskState,
  equal,
  matchesPendingTaskState,
  requestedTree,
} from './taskStateOracle';
const createHash = Platform.isDesktop ? (await import('node:crypto')).createHash : undefined;
const record = object;
export interface PendingTaskStateResolution {
  failures: string[];
  requestedByTarget: ReadonlyMap<string, unknown>;
  owners: readonly ResolvedPendingOwner[];
}
export interface ResolvedPendingOwner {
  persisted: TaskTreeV1;
  prior?: TaskTreeV1;
  effective: TaskTreeV1;
  requested: unknown;
}
type PendingTaskStateDeclaration = NonNullable<TurnExpectation['pendingTaskStates']>[number];
type PendingOwner = { persisted: TaskTreeV1; declaration: PendingTaskStateDeclaration };
type PendingEdit = { before: TaskTreeV1; after: TaskTreeV1; hasChanges?: boolean };
type ExistingPendingPlan = Extract<
  CommandSessionSnapshot['proposal']['changes'][number],
  { kind: 'task' }
>['plan'] & { kind: 'edit'; before: TaskTreeV1; after: TaskTreeV1 };
export type PendingTaskStateOptions = {
  writeCount: number;
  hostProviderEpoch?: string;
  ownerStore?: unknown;
};
function pendingRootComplete(tree: TaskTreeV1): boolean {
  const targets = new Set<string>();
  const commentTargets = new Set<string>();
  const timeTargets = new Set<string>();
  return visitPendingRoot(tree, undefined, { targets, commentTargets, timeTargets });
}
type PendingTargetSets = {
  targets: Set<string>;
  commentTargets: Set<string>;
  timeTargets: Set<string>;
};
function visitPendingRoot(
  node: TaskTreeV1,
  parentTarget: string | undefined,
  seen: PendingTargetSets,
): boolean {
  if (!pendingNodeHeaderComplete(node, parentTarget, seen.targets)) return false;
  seen.targets.add(node.target);
  if (!pendingCommentOwnersComplete(node, seen.commentTargets)) return false;
  if (!pendingTimeEntryOwnersComplete(node, seen.timeTargets)) return false;
  return (
    pendingEntriesCoverNode(node) &&
    node.children.every((child) => visitPendingRoot(child, node.target, seen))
  );
}
function pendingNodeHeaderComplete(
  node: TaskTreeV1,
  parentTarget: string | undefined,
  targets: ReadonlySet<string>,
): boolean {
  const target = object(node)['target'];
  return (
    pendingNodeCollectionsComplete(node) &&
    typeof target === 'string' &&
    target.length > 0 &&
    node.parentTarget === parentTarget &&
    !targets.has(target)
  );
}
function pendingNodeCollectionsComplete(node: TaskTreeV1): boolean {
  const value = object(node);
  const children = value['children'];
  const comments = value['comments'];
  const timeEntries = value['timeEntries'];
  const entries = value['entries'];
  return (
    value['complete'] === true &&
    value['truncated'] === false &&
    Array.isArray(children) &&
    Array.isArray(comments) &&
    Array.isArray(timeEntries) &&
    Array.isArray(entries) &&
    validPendingCount(value['childCount'], children.length) &&
    validPendingCount(value['commentCount'], comments.length) &&
    validPendingCount(value['timeEntryCount'], timeEntries.length)
  );
}
function pendingCommentOwnersComplete(node: TaskTreeV1, seen: Set<string>): boolean {
  for (const comment of node.comments) {
    const value = object(comment);
    const target = value['target'];
    if (
      typeof target !== 'string' ||
      target.length === 0 ||
      value['parentTarget'] !== node.target ||
      seen.has(target)
    )
      return false;
    seen.add(target);
  }
  return true;
}
function pendingTimeEntryOwnersComplete(node: TaskTreeV1, seen: Set<string>): boolean {
  for (const entry of node.timeEntries) {
    const value = object(entry);
    const target = value['target'];
    if (
      typeof target !== 'string' ||
      target.length === 0 ||
      value['parentTarget'] !== node.target ||
      seen.has(target)
    )
      return false;
    seen.add(target);
  }
  return true;
}
function validPendingCount(value: unknown, length: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && value === length;
}
function pendingEntriesCoverNode(node: TaskTreeV1): boolean {
  const collections = pendingEntryCollections(node);
  if (collections === undefined) return false;
  const seen = new Set<string>();
  const offsets = { child: 0, comment: 0, 'time-entry': 0 };
  for (const raw of node.entries as readonly unknown[]) {
    const entry = object(raw);
    const kind = entry['kind'];
    const targets =
      kind === 'child' || kind === 'comment' || kind === 'time-entry'
        ? collections[kind]
        : undefined;
    if (targets === undefined || typeof entry['target'] !== 'string') return false;
    if (
      !pendingEntryMatchesCollection({
        kind: kind as 'child' | 'comment' | 'time-entry',
        target: entry['target'],
        targets,
        offsets,
        seen,
      })
    )
      return false;
  }
  return pendingCollectionCountsMatch(collections, offsets);
}
function pendingEntryCollections(node: TaskTreeV1):
  | {
      child: string[];
      comment: string[];
      'time-entry': string[];
    }
  | undefined {
  const childTargets = pendingCollectionTargets(node.children);
  const commentTargets = pendingCollectionTargets(node.comments);
  const timeTargets = pendingCollectionTargets(node.timeEntries);
  if (childTargets === undefined || commentTargets === undefined || timeTargets === undefined)
    return undefined;
  return {
    child: childTargets,
    comment: commentTargets,
    'time-entry': timeTargets,
  };
}
function pendingCollectionCountsMatch(
  collections: {
    child: readonly string[];
    comment: readonly string[];
    'time-entry': readonly string[];
  },
  offsets: { child: number; comment: number; 'time-entry': number },
): boolean {
  return (
    offsets.child === collections.child.length &&
    offsets.comment === collections.comment.length &&
    offsets['time-entry'] === collections['time-entry'].length
  );
}
function pendingCollectionTargets(values: readonly unknown[]): string[] | undefined {
  const targets = values.map((value) => object(value)['target']);
  return targets.every((target): target is string => typeof target === 'string')
    ? targets
    : undefined;
}
function pendingEntryMatchesCollection(input: {
  kind: 'child' | 'comment' | 'time-entry';
  target: string;
  targets: readonly string[];
  offsets: { child: number; comment: number; 'time-entry': number };
  seen: Set<string>;
}): boolean {
  const { kind, target, targets, offsets, seen } = input;
  const key = `${kind}:${target}`;
  if (target !== targets[offsets[kind]] || seen.has(key)) return false;
  offsets[kind] += 1;
  seen.add(key);
  return true;
}
function pendingSameAuthoredTree(left: unknown, right: unknown): boolean {
  return equal(authoredTaskState(left), authoredTaskState(right));
}
function pendingDirectEntryOrder(value: unknown): string[] | undefined {
  const tree = record(value);
  const entries = Array.isArray(tree['entries']) ? tree['entries'] : [];
  const indexByTarget = (key: 'children' | 'comments' | 'timeEntries') =>
    new Map(
      (Array.isArray(tree[key]) ? tree[key] : []).flatMap((item, index) => {
        const target = record(item)['target'];
        return typeof target === 'string' ? [[target, index] as const] : [];
      }),
    );
  const indexes = {
    child: indexByTarget('children'),
    comment: indexByTarget('comments'),
    'time-entry': indexByTarget('timeEntries'),
  };
  const order: string[] = [];
  for (const value of entries) {
    const entry = record(value);
    const kind = entry['kind'];
    if (kind !== 'child' && kind !== 'comment' && kind !== 'time-entry') return undefined;
    const target = entry['target'];
    const index = typeof target === 'string' ? indexes[kind].get(target) : undefined;
    if (index === undefined) return undefined;
    order.push(`${kind}:${index}`);
  }
  return order;
}
function pendingSameDirectEntryOrder(before: unknown, after: unknown): boolean {
  const left = pendingDirectEntryOrder(before);
  const right = pendingDirectEntryOrder(after);
  return left !== undefined && right !== undefined && equal(left, right);
}
function validPendingDeclaration(value: unknown): value is PendingTaskStateDeclaration {
  const item = record(value);
  return (
    typeof item['path'] === 'string' &&
    Number.isSafeInteger(item['line']) &&
    (item['line'] as number) >= 0 &&
    typeof item['tree'] === 'object' &&
    item['tree'] !== null
  );
}
function pendingContractFailures(
  expected: TurnExpectation,
  history: { snapshot: CommandSessionSnapshot; previous: CommandSessionSnapshot },
  options: PendingTaskStateOptions,
): string[] {
  return expected.status === 'ready' &&
    expected.allowWrites !== true &&
    expected.partialSave !== true &&
    expected.publicTrees !== undefined &&
    expected.writeCount === 0 &&
    options.writeCount === 0 &&
    hasPendingHostEpoch(options) &&
    history.snapshot.status.kind === 'ready' &&
    noNewPendingAdmissions(history.snapshot, history.previous)
    ? []
    : ['pending-task-state-contract'];
}
function hasPendingHostEpoch(options: PendingTaskStateOptions): boolean {
  return typeof options.hostProviderEpoch === 'string' && options.hostProviderEpoch.length > 0;
}
function noNewPendingAdmissions(
  snapshot: CommandSessionSnapshot,
  previous: CommandSessionSnapshot,
): boolean {
  const prior = new Set(previous.journal.map((entry) => entry.id));
  return snapshot.journal.every((entry) => prior.has(entry.id) || entry.state !== 'admitted');
}
function resolveDeclaredOwners(
  declarations: readonly PendingTaskStateDeclaration[],
  publicReadback: readonly TaskTreeV1[],
): { owners: Map<string, PendingOwner>; failures: string[] } {
  const owners = new Map<string, PendingOwner>();
  const failures: string[] = [];
  const seenSources = new Set<string>();
  for (const declaration of declarations) {
    const sourceKey = `${declaration.path}\u0000${declaration.line}`;
    if (seenSources.has(sourceKey)) {
      failures.push('pending-task-state-contract');
      continue;
    }
    seenSources.add(sourceKey);
    const matches = publicReadback.filter(
      (tree) =>
        tree.parentTarget === undefined &&
        tree.source?.path === declaration.path &&
        tree.source.line === declaration.line,
    );
    const owner = matches[0];
    if (matches.length !== 1 || owner === undefined || !pendingRootComplete(owner)) {
      failures.push('pending-task-state-owner');
      continue;
    }
    if (owners.has(owner.target)) {
      failures.push('pending-task-state-owner');
      continue;
    }
    owners.set(owner.target, { persisted: owner, declaration });
  }
  return { owners, failures };
}
function validCurrentPendingEdit(
  change: CommandSessionSnapshot['proposal']['changes'][number],
  owners: ReadonlyMap<string, PendingOwner>,
  hostProviderEpoch: string | undefined,
): { target: string; edit: PendingEdit } | undefined {
  const plan = existingPendingPlan(change);
  if (plan === undefined) return undefined;
  const before = plan.before;
  const owner = owners.get(before.target)?.persisted;
  if (owner === undefined || !pendingBeforeMatchesOwner(before, owner)) return undefined;
  if (!pendingPlanAfterMatchesOwner(plan, owner, hostProviderEpoch)) return undefined;
  return {
    target: before.target,
    edit: {
      before,
      after: plan.after,
      ...(typeof plan.hasChanges === 'boolean' ? { hasChanges: plan.hasChanges } : {}),
    },
  };
}
function existingPendingPlan(
  change: CommandSessionSnapshot['proposal']['changes'][number],
): ExistingPendingPlan | undefined {
  return change.kind === 'task' &&
    change.plan.kind === 'edit' &&
    change.plan.before !== null &&
    change.plan.after !== null
    ? (change.plan as ExistingPendingPlan)
    : undefined;
}
function pendingPlanAfterMatchesOwner(
  plan: ExistingPendingPlan,
  owner: TaskTreeV1,
  hostProviderEpoch: string | undefined,
): boolean {
  return (
    plan.after.target === owner.target &&
    plan.providerEpoch === hostProviderEpoch &&
    pendingRootComplete(plan.after)
  );
}
function pendingBeforeMatchesOwner(before: TaskTreeV1, owner: TaskTreeV1): boolean {
  return (
    pendingRootComplete(before) &&
    pendingRootComplete(owner) &&
    pendingOwnerBasisMatches(before, owner) &&
    pendingSameAuthoredTree(before, owner)
  );
}
function pendingOwnerBasisMatches(before: TaskTreeV1, owner: TaskTreeV1): boolean {
  return (
    before.target === owner.target &&
    before.revision === owner.revision &&
    before.source?.path === owner.source?.path &&
    before.source?.line === owner.source?.line
  );
}
function currentPendingEdits(
  snapshot: CommandSessionSnapshot,
  owners: ReadonlyMap<string, PendingOwner>,
  hostProviderEpoch: string | undefined,
): { edits: Map<string, PendingEdit[]>; failures: string[] } {
  const edits = new Map<string, PendingEdit[]>();
  const failures: string[] = [];
  for (const change of snapshot.proposal.changes) {
    const result = validCurrentPendingEdit(change, owners, hostProviderEpoch);
    if (result === undefined) {
      failures.push('pending-task-state-owner');
      continue;
    }
    edits.set(result.target, [...(edits.get(result.target) ?? []), result.edit]);
  }
  return { edits, failures };
}
function previousPendingStates(
  snapshot: CommandSessionSnapshot,
  owners: ReadonlyMap<string, PendingOwner>,
  hostProviderEpoch: string | undefined,
): { priors: ReadonlyMap<string, TaskTreeV1>; failures: string[] } {
  const failures: string[] = [];
  const priors = new Map<string, TaskTreeV1>();
  const seenOwners = new Set<string>();
  for (const change of snapshot.proposal.changes) {
    const plan = existingPendingPlan(change);
    if (plan === undefined) {
      failures.push('pending-task-state-contract');
      continue;
    }
    const before = plan.before;
    const owner = owners.get(before.target)?.persisted;
    if (
      owner === undefined ||
      !pendingBeforeMatchesOwner(before, owner) ||
      !pendingPlanAfterMatchesOwner(plan, owner, hostProviderEpoch)
    ) {
      failures.push('pending-task-state-owner');
      continue;
    }
    if (seenOwners.has(owner.target)) {
      failures.push('pending-task-state-owner');
      continue;
    }
    seenOwners.add(owner.target);
    priors.set(owner.target, plan.after);
  }
  return { priors, failures };
}
function pendingOwnerFailures(
  owners: ReadonlyMap<string, PendingOwner>,
  edits: ReadonlyMap<string, readonly PendingEdit[]>,
): string[] {
  const failures: string[] = [];
  for (const [target, entry] of owners) {
    failures.push(...pendingOwnerStateFailures(entry, edits.get(target) ?? []));
  }
  return failures;
}
function pendingOwnerStateFailures(entry: PendingOwner, plans: readonly PendingEdit[]): string[] {
  if (plans.length > 1) return ['pending-task-state-owner'];
  const plan = plans[0];
  const effective = plan?.after ?? entry.persisted;
  const failures = matchesPendingTaskState(entry.declaration.tree, effective)
    ? []
    : ['pending-task-state-value'];
  failures.push(...pendingNoopFailures(plan, entry.persisted));
  return failures;
}
function pendingNoopFailures(plan: PendingEdit | undefined, owner: TaskTreeV1): string[] {
  return plan?.hasChanges === false &&
    (!pendingSameAuthoredTree(plan.before, owner) ||
      !pendingSameAuthoredTree(plan.after, owner) ||
      !pendingSameDirectEntryOrder(plan.before, owner) ||
      !pendingSameDirectEntryOrder(plan.before, plan.after))
    ? ['pending-task-state-noop']
    : [];
}
function pendingReceiptFailures(
  snapshot: CommandSessionSnapshot,
  previous: CommandSessionSnapshot,
  owners: ReadonlyMap<string, PendingOwner>,
  ownerStoreValue: unknown,
): string[] {
  const relevantReceipts = relevantPendingReceipts(previous, owners);
  if (relevantReceipts.length === 0) return [];
  const ownerStore = record(ownerStoreValue);
  const sessionsValue = ownerStore['sessions'];
  const activeSessionId = ownerStore['activeSessionId'];
  if (
    !Array.isArray(sessionsValue) ||
    !(activeSessionId === null || typeof activeSessionId === 'string')
  )
    return ['pending-task-state-receipt'];
  const sessions: readonly unknown[] = sessionsValue;
  const previousSessionId = record(previous)['id'];
  const storedJournal = sessions.flatMap((sessionValue): unknown[] => {
    const snapshot = record(sessionValue)['snapshot'];
    if (record(snapshot)['id'] !== previousSessionId) return [];
    const journal = record(snapshot)['journal'];
    return Array.isArray(journal) ? journal : [];
  });
  const activeJournal =
    ownerStore['activeSessionId'] === previousSessionId ? snapshot.journal : undefined;
  const missing = relevantReceipts.some(
    (expected) =>
      !hasExactSettledReceipt(storedJournal, expected) ||
      (activeJournal !== undefined && !hasExactSettledReceipt(activeJournal, expected)),
  );
  return missing ? ['pending-task-state-receipt'] : [];
}
function relevantPendingReceipts(
  previous: CommandSessionSnapshot,
  owners: ReadonlyMap<string, PendingOwner>,
): CommandSessionSnapshot['journal'] {
  return previous.journal.filter((entry) => {
    if (entry.state !== 'settled' || entry.change.kind !== 'task') return false;
    const before = entry.change.plan.before;
    return before !== null && owners.has(before.target);
  });
}
function hasExactSettledReceipt(
  journal: readonly unknown[],
  expected: CommandSessionSnapshot['journal'][number],
): boolean {
  const matches = journal.filter((value) => record(value)['id'] === expected.id);
  if (matches.length !== 1) return false;
  const actual = record(matches[0]);
  return (
    actual['state'] === 'settled' &&
    actual['effects'] === expected.effects &&
    equal(actual['receipt'], expected.receipt)
  );
}
/** Rebuild the opt-in state assertion from canonical snapshots and the current public inventory. */
export function resolvePendingTaskStates(
  expected: TurnExpectation,
  history: { snapshot: CommandSessionSnapshot; previous: CommandSessionSnapshot },
  publicReadback: readonly TaskTreeV1[],
  options: PendingTaskStateOptions,
): PendingTaskStateResolution {
  const rawDeclarations: readonly unknown[] = expected.pendingTaskStates ?? [];
  if (rawDeclarations.length === 0)
    return {
      failures: expected.pendingTaskStates === undefined ? [] : ['pending-task-state-contract'],
      requestedByTarget: new Map(),
      owners: [],
    };
  const declarations = rawDeclarations.filter(validPendingDeclaration);
  if (declarations.length !== rawDeclarations.length)
    return { failures: ['pending-task-state-contract'], requestedByTarget: new Map(), owners: [] };
  const declared = resolveDeclaredOwners(declarations, publicReadback);
  const current = currentPendingEdits(history.snapshot, declared.owners, options.hostProviderEpoch);
  const previous = previousPendingStates(
    history.previous,
    declared.owners,
    options.hostProviderEpoch,
  );
  const resolvedOwners = [...declared.owners].map(([target, entry]): ResolvedPendingOwner => {
    const plan = (current.edits.get(target) ?? [])[0];
    const prior = previous.priors.get(target);
    return {
      persisted: entry.persisted,
      ...(prior === undefined ? {} : { prior }),
      effective: plan?.after ?? entry.persisted,
      requested: entry.declaration.tree,
    };
  });
  const requestedByTarget = new Map(
    [...declared.owners].map(([target, entry]) => [target, entry.declaration.tree]),
  );
  return {
    failures: [
      ...new Set([
        ...pendingContractFailures(expected, history, options),
        ...declared.failures,
        ...current.failures,
        ...previous.failures,
        ...pendingOwnerFailures(declared.owners, current.edits),
        ...pendingReceiptFailures(
          history.snapshot,
          history.previous,
          declared.owners,
          options.ownerStore,
        ),
      ]),
    ],
    requestedByTarget,
    owners: resolvedOwners,
  };
}

function projectionState(value: TaskTreeV1): unknown {
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'activity') continue;
    projected[key] = Array.isArray(child) ? projectedItems(child) : child;
  }
  return projected;
}
function projectedItems(items: readonly unknown[]): unknown[] {
  return items.map((item) =>
    typeof object(item)['target'] === 'string' ? projectionState(item as TaskTreeV1) : item,
  );
}
function pendingRootProjectionEqual(left: TaskTreeV1 | null, right: TaskTreeV1 | null): boolean {
  if (left === null || right === null) return left === right;
  if (!pendingRootComplete(left) || !pendingRootComplete(right)) return false;
  return equal(projectionState(left), projectionState(right));
}
function pendingViewKey(pair: { before: TaskTreeV1 | null; after: TaskTreeV1 | null }): string {
  return `${pair.before?.target ?? ''}\\u0000${pair.after?.target ?? ''}`;
}
function pendingSnapshotProjectionFailures(snapshot: CommandSessionSnapshot): string[] {
  const canonical = snapshot.proposal.changes.flatMap((change) =>
    change.kind === 'task' ? commandPlanViews(change.plan) : [],
  );
  if (canonical.length !== snapshot.trees.length) return ['pending-task-state-projection'];
  const remaining = [...snapshot.trees];
  for (const pair of canonical) {
    const matches = remaining.filter((item) => pendingViewKey(item) === pendingViewKey(pair));
    const match = matches[0];
    if (
      matches.length !== 1 ||
      match === undefined ||
      !pendingRootProjectionEqual(pair.before, match.before) ||
      !pendingRootProjectionEqual(pair.after, match.after)
    )
      return ['pending-task-state-projection'];
    remaining.splice(remaining.indexOf(match), 1);
  }
  return remaining.length === 0 ? [] : ['pending-task-state-projection'];
}
function pendingOutputProjectionFailures(
  snapshot: CommandSessionSnapshot,
  trees: readonly TaskTreeV1[],
  publicReadback: readonly TaskTreeV1[],
): string[] {
  const canonical =
    snapshot.proposal.changes.length > 0
      ? snapshot.trees.flatMap((pair) => (pair.after === null ? [] : [pair.after]))
      : [...publicReadback];
  if (canonical.length !== trees.length) return ['pending-task-state-projection'];
  const remaining = [...trees];
  for (const root of canonical) {
    const matches = remaining.filter((tree) => tree.target === root.target);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined || !pendingRootProjectionEqual(root, match))
      return ['pending-task-state-projection'];
    remaining.splice(remaining.indexOf(match), 1);
  }
  return remaining.length === 0 ? [] : ['pending-task-state-projection'];
}
function pendingProjectionFailures(
  history: TurnSnapshots,
  trees: readonly TaskTreeV1[],
  publicReadback: readonly TaskTreeV1[],
  owners: readonly ResolvedPendingOwner[],
): string[] {
  const failures = [
    ...pendingSnapshotProjectionFailures(history.previous),
    ...pendingSnapshotProjectionFailures(history.snapshot),
    ...pendingOutputProjectionFailures(history.snapshot, trees, publicReadback),
  ];
  for (const owner of owners) {
    const matches = publicReadback.filter((tree) => tree.target === owner.persisted.target);
    if (matches.length !== 1 || !pendingRootProjectionEqual(owner.persisted, matches[0] ?? null))
      failures.push('pending-task-state-projection');
  }
  return [...new Set(failures)];
}
function pendingEntryOrderFailures(pair: PreservationPair): string[] {
  const failures: string[] = [];
  if (
    !pendingRootComplete(pair.before as TaskTreeV1) ||
    !pendingRootComplete(pair.after as TaskTreeV1)
  )
    return ['preservation:entry-order'];
  comparePendingEntryOrder({
    before: pair.before as TaskTreeV1,
    after: pair.after as TaskTreeV1,
    requested: pair.requested,
    pair,
    nodeMappings: new Map((pair.nodeContinuity ?? []).map((entry) => [entry.before, entry.after])),
    failures,
  });
  return [...new Set(failures)];
}
function comparePendingEntryOrder(input: {
  before: TaskTreeV1;
  after: TaskTreeV1;
  requested: unknown;
  pair: PreservationPair;
  nodeMappings: ReadonlyMap<string, string>;
  failures: string[];
}): void {
  const { before, after, requested, pair, nodeMappings, failures } = input;
  const surviving = new Set<string>();
  const expectedSequence = before.entries.flatMap((entry) => {
    const target = retainedEntryTarget({ entry, before, after, pair, nodeMappings, failures });
    if (target === undefined) return [];
    const value = `${entry.kind}:${target}`;
    surviving.add(value);
    return [value];
  });
  const requestedNode = object(requested);
  if (
    !('entries' in requestedNode) &&
    !pendingEntrySequenceMatches(after, expectedSequence, surviving)
  )
    failures.push('preservation:entry-order');
  comparePendingChildEntryOrder({
    before,
    after,
    requested: requestedNode,
    pair,
    nodeMappings,
    failures,
  });
}
function retainedEntryTarget(input: {
  entry: TaskTreeV1['entries'][number];
  before: TaskTreeV1;
  after: TaskTreeV1;
  pair: PreservationPair;
  nodeMappings: ReadonlyMap<string, string>;
  failures: string[];
}): string | undefined {
  const { entry, before, after, pair, nodeMappings, failures } = input;
  if (entry.kind === 'child')
    return retainedChildEntryTarget({ target: entry.target, after, pair, nodeMappings, failures });
  if (entry.kind === 'comment')
    return retainedCommentEntryTarget({ target: entry.target, before, after, pair, failures });
  return retainedTimeEntryTarget({ target: entry.target, before, after, failures });
}
function retainedChildEntryTarget(input: {
  target: string;
  after: TaskTreeV1;
  pair: PreservationPair;
  nodeMappings: ReadonlyMap<string, string>;
  failures: string[];
}): string | undefined {
  const { target, after, pair, nodeMappings, failures } = input;
  if (
    (pair.removedNodeTargets ?? []).includes(target) ||
    (pair.relocatedNodeTargets ?? []).includes(target)
  )
    return undefined;
  const mapped = nodeMappings.get(target) ?? target;
  if (after.children.some((child) => child.target === mapped)) return mapped;
  failures.push('preservation:entry-order');
  return undefined;
}
function retainedCommentEntryTarget(input: {
  target: string;
  before: TaskTreeV1;
  after: TaskTreeV1;
  pair: PreservationPair;
  failures: string[];
}): string | undefined {
  const { target, before, after, pair, failures } = input;
  const proof = (pair.commentContinuity ?? []).find(
    (item) =>
      item.before === target &&
      item.ownerBefore === before.target &&
      item.ownerAfter === after.target,
  );
  const mapped = proof?.after ?? target;
  if (after.comments.some((comment) => comment.target === mapped)) return mapped;
  if ((pair.removedCommentTargets ?? []).includes(target)) return undefined;
  failures.push('preservation:entry-order');
  return undefined;
}
function retainedTimeEntryTarget(input: {
  target: string;
  before: TaskTreeV1;
  after: TaskTreeV1;
  failures: string[];
}): string | undefined {
  const { target, before, after, failures } = input;
  const index = before.timeEntries.findIndex((entry) => entry.target === target);
  const previous = before.timeEntries[index];
  const current = after.timeEntries[index];
  if (
    index < 0 ||
    previous === undefined ||
    current === undefined ||
    !equal(authoredTaskState(previous), authoredTaskState(current))
  ) {
    failures.push('preservation:entry-order');
    return undefined;
  }
  return current.target;
}
function pendingEntrySequenceMatches(
  after: TaskTreeV1,
  expected: readonly string[],
  surviving: ReadonlySet<string>,
): boolean {
  const actual = after.entries.flatMap((entry) => {
    const value = `${entry.kind}:${entry.target}`;
    return surviving.has(value) ? [value] : [];
  });
  return equal(expected, actual);
}
function comparePendingChildEntryOrder(input: {
  before: TaskTreeV1;
  after: TaskTreeV1;
  requested: Record<string, unknown>;
  pair: PreservationPair;
  nodeMappings: ReadonlyMap<string, string>;
  failures: string[];
}): void {
  const { before, after, requested, pair, nodeMappings, failures } = input;
  const requestedChildren = Array.isArray(requested['children']) ? requested['children'] : [];
  for (const oldChild of before.children) {
    if (
      (pair.removedNodeTargets ?? []).includes(oldChild.target) ||
      (pair.relocatedNodeTargets ?? []).includes(oldChild.target)
    )
      continue;
    const target = nodeMappings.get(oldChild.target) ?? oldChild.target;
    const nextChild = after.children.find((child) => child.target === target);
    if (nextChild === undefined) continue;
    comparePendingEntryOrder({
      before: oldChild,
      after: nextChild,
      requested: requestedChildren[after.children.indexOf(nextChild)],
      pair,
      nodeMappings,
      failures,
    });
  }
}

function nodes(tree: TaskTreeV1): TaskTreeV1[] {
  return [tree, ...tree.children.flatMap(nodes)];
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function taskInputsOfTurn(snapshot: CommandSessionSnapshot, previous: CommandSessionSnapshot) {
  return (snapshot.preparations ?? [])
    .slice(previous.preparations?.length ?? 0)
    .flatMap((entry) => (entry.kind === 'task' ? [object(entry.input)] : []));
}
function operations(snapshot: CommandSessionSnapshot, previous: CommandSessionSnapshot) {
  return taskInputsOfTurn(snapshot, previous).flatMap((input) =>
    'operation' in input ? [object(input['operation'])] : list(input['operations']).map(object),
  );
}
function availablePlans({ snapshot, previous, stagedPlans = [] }: TurnSnapshots): ContentPlanV1[] {
  return [
    ...stagedPlans,
    ...[...snapshot.proposal.changes, ...previous.proposal.changes].flatMap((change) =>
      change.kind === 'task' ? [change.plan] : [],
    ),
  ];
}
function completeOwnComments(owner: TaskTreeV1): boolean {
  const handles = owner.comments.map((comment) => comment.target);
  const entries = owner.entries
    .filter((entry) => entry.kind === 'comment')
    .map((entry) => entry.target);
  return (
    owner.complete &&
    !owner.truncated &&
    owner.commentCount === handles.length &&
    new Set(handles).size === handles.length &&
    owner.comments.every((comment) => comment.parentTarget === owner.target) &&
    JSON.stringify(entries) === JSON.stringify(handles)
  );
}
function sameOwnComments(source: TaskTreeV1, before: TaskTreeV1): boolean {
  const values = (owner: TaskTreeV1) =>
    owner.comments.map((comment) => [comment.text, comment.timestamp ?? null]);
  return (
    completeOwnComments(source) &&
    completeOwnComments(before) &&
    JSON.stringify(values(source)) === JSON.stringify(values(before))
  );
}
export interface SelectedPlanObservation {
  source: string;
  sourceRevision: string;
  selected: string;
  selectedRevision: string;
}
export interface NativePlanBasisObservation {
  sequence: number;
  inputSequence: number;
  input: {
    plan: string;
    expectedPlanRevision: string;
    operationIdentity: string;
    operationType: string;
  };
  result: {
    planTarget: string;
    planRevision: string;
    providerEpoch: string;
    rootTarget: string;
    rootRevision: string;
    taskMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>;
    rootComplete: boolean;
    rootTruncated: boolean;
    membershipComplete: boolean;
  };
}
export interface TurnSnapshots {
  snapshot: CommandSessionSnapshot;
  previous: CommandSessionSnapshot;
  stagedPlans?: readonly ContentPlanV1[];
  selectedPlans?: readonly SelectedPlanObservation[];
  selectedPlanSources?: readonly ContentPlanV1[];
  nativePlanBasis?: readonly NativePlanBasisObservation[];
}
export function nativeOperationIdentity(operation: unknown): string {
  if (createHash === undefined) throw new Error('Native operation identity requires desktop');
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}
function nativePlanBasisFromTrace(
  events: ReadonlyArray<{ kind: string; data?: unknown; sequence?: number }>,
): NativePlanBasisObservation[] {
  return events.flatMap((event) => {
    const parsed = nativePlanBasisEvent(event, events);
    return parsed === undefined ? [] : [parsed];
  });
}
type TraceEvent = { kind: string; data?: unknown; sequence?: number };
function nativePlanBasisEvent(
  event: TraceEvent,
  events: readonly TraceEvent[],
): NativePlanBasisObservation | undefined {
  if (event.kind !== 'observed-plan-preparation' || !Number.isSafeInteger(event.sequence))
    return undefined;
  const input = object(object(event.data)['input']);
  const result = object(object(event.data)['result']);
  const membership = observedTaskMembers(result['taskMembership']);
  const inputEvent = matchingPreparationInput(events, event, input);
  if (inputEvent === undefined || !validNativeBasisPayload(input, result, membership))
    return undefined;
  return {
    sequence: event.sequence ?? 0,
    inputSequence: inputEvent.sequence ?? 0,
    input: {
      plan: String(input['plan']),
      expectedPlanRevision: String(input['expectedPlanRevision']),
      operationIdentity: String(input['operationIdentity']),
      operationType: String(input['operationType']),
    },
    result: {
      planTarget: String(result['planTarget']),
      planRevision: String(result['planRevision']),
      providerEpoch: String(result['providerEpoch']),
      rootTarget: String(result['rootTarget']),
      rootRevision: String(result['rootRevision']),
      taskMembership: membership,
      rootComplete: result['rootComplete'],
      rootTruncated: result['rootTruncated'],
      membershipComplete: result['membershipComplete'],
    },
  };
}
function validNativeBasisPayload(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  membership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
): result is Record<string, unknown> & {
  rootComplete: boolean;
  rootTruncated: boolean;
  membershipComplete: boolean;
} {
  return (
    hasNativeBasisStrings(input, result) &&
    Array.isArray(result['taskMembership']) &&
    typeof result['rootComplete'] === 'boolean' &&
    typeof result['rootTruncated'] === 'boolean' &&
    typeof result['membershipComplete'] === 'boolean' &&
    membership.length === list(result['taskMembership']).length
  );
}
function observedTaskMembers(
  value: unknown,
): Array<{ target: string; parentTarget: string | null }> {
  return list(value).flatMap((raw) => {
    const item = object(raw),
      target = item['target'],
      parentTarget = item['parentTarget'];
    return typeof target === 'string' && (parentTarget === null || typeof parentTarget === 'string')
      ? [{ target, parentTarget }]
      : [];
  });
}
function matchingPreparationInput(
  events: readonly TraceEvent[],
  resultEvent: TraceEvent,
  input: Record<string, unknown>,
): TraceEvent | undefined {
  const matches = events.filter((candidate) => {
    if (
      candidate.kind !== 'native-plan-preparation-input' ||
      !Number.isSafeInteger(candidate.sequence)
    )
      return false;
    const consumed = object(candidate.data);
    return (
      (candidate.sequence ?? 0) < (resultEvent.sequence ?? 0) &&
      consumed['plan'] === input['plan'] &&
      consumed['expectedPlanRevision'] === input['expectedPlanRevision'] &&
      consumed['operationIdentity'] === input['operationIdentity']
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
function hasNativeBasisStrings(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): boolean {
  return [
    input['plan'],
    input['expectedPlanRevision'],
    input['operationIdentity'],
    input['operationType'],
    result['planTarget'],
    result['planRevision'],
    result['providerEpoch'],
    result['rootTarget'],
    result['rootRevision'],
  ].every((value) => typeof value === 'string');
}
/** Rebuild staged plans and compact basis observations for one retained turn. */
export function retainedPlanEvidenceFromTrace(
  trace: ReadonlyArray<{ kind: string; data?: unknown; sequence?: number }>,
  oneBasedTurn: number,
): Pick<
  TurnSnapshots,
  'stagedPlans' | 'selectedPlans' | 'selectedPlanSources' | 'nativePlanBasis'
> {
  const start = trace.findIndex((event) => {
    const data = object(event.data);
    return event.kind === 'case-phase' && data['phase'] === 'turn' && data['turn'] === oneBasedTurn;
  });
  if (start < 0)
    return { stagedPlans: [], selectedPlans: [], selectedPlanSources: [], nativePlanBasis: [] };
  let caseStart = start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const event = trace[index];
    if (event?.kind === 'case-phase' && object(event.data)['phase'] === 'case-start') {
      caseStart = index;
      break;
    }
  }
  const end = trace.findIndex((event, index) => {
    if (index <= start || event.kind !== 'case-phase') return false;
    const phase = object(event.data)['phase'];
    return phase === 'turn' || phase === 'cleanup';
  });
  const events = trace.slice(start, end < 0 ? trace.length : end);
  const stagedPlans = events.flatMap((event) => {
    if (event.kind !== 'snapshot') return [];
    return list(object(object(event.data)['proposal'])['changes'])
      .map(object)
      .flatMap((change) => {
        const plan = change['plan'];
        return change['kind'] === 'task' && typeof plan === 'object' && plan !== null
          ? [plan as ContentPlanV1]
          : [];
      });
  });
  const continuityEvents = [...trace.slice(caseStart, start), ...events];
  const selectedPlans = continuityEvents.flatMap((event) =>
    event.kind === 'selected-task-fields'
      ? [object(event.data) as unknown as SelectedPlanObservation]
      : [],
  );
  const selectedPlanSources = continuityEvents.flatMap((event) => {
    if (event.kind !== 'snapshot') return [];
    return list(object(object(event.data)['proposal'])['changes']).flatMap((raw) => {
      const change = object(raw);
      const plan = change['plan'];
      return change['kind'] === 'task' && typeof plan === 'object' && plan !== null
        ? [plan as ContentPlanV1]
        : [];
    });
  });
  return {
    stagedPlans,
    selectedPlans,
    selectedPlanSources,
    nativePlanBasis: nativePlanBasisFromTrace(events),
  };
}
/** Rebase only an exact issued handle from the accepted edit's immutable source revision. */
function groundedCommentOperations(
  before: TaskTreeV1,
  { snapshot, previous, stagedPlans = [] }: TurnSnapshots,
  ops: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const inputs = taskInputsOfTurn(snapshot, previous);
  const observed = [...snapshot.entities.tasks, ...previous.entities.tasks].flatMap((page) =>
    nodes(page.tree),
  );
  const translated: Array<Record<string, unknown>> = [];
  for (const op of ops) {
    if (!['remove-comment', 'update-comment'].includes(String(op['type']))) {
      translated.push(op);
      continue;
    }
    const input = inputs.find((entry) => entry['operation'] === op);
    let target: string | undefined;
    if (isSourceCommentEdit(input, before))
      target = rebasedCommentTarget(before, observed, op['target']);
    else if (input?.['kind'] === 'append')
      target = originalAppendComment(before, input, op['target'], {
        stagedPlans,
        preceding: translated,
      });
    translated.push(target === undefined ? op : { ...op, target });
  }
  return translated;
}
function isSourceCommentEdit(
  input: Record<string, unknown> | undefined,
  before: TaskTreeV1,
): boolean {
  return (
    input?.['kind'] === 'edit' &&
    nodes(before).some(
      (node) => node.target === input['target'] && node.revision === input['expectedRevision'],
    )
  );
}
/** The prior accepted edit may have issued new handles for every comment in this tree. */
function originalAppendComment(
  before: TaskTreeV1,
  input: Record<string, unknown>,
  target: unknown,
  {
    stagedPlans,
    preceding,
  }: { stagedPlans: readonly ContentPlanV1[]; preceding: ReadonlyArray<Record<string, unknown>> },
): string | undefined {
  const basis = stagedPlans.find(
    (plan) =>
      plan.target === input['plan'] &&
      plan.revision === input['expectedPlanRevision'] &&
      plan.after?.target === before.target,
  )?.after;
  if (basis == null) return undefined;
  const owner = nodes(basis).find((row) =>
    row.comments.some((comment) => comment.target === target),
  );
  const original = nodes(before).find((row) => row.target === owner?.target);
  if (
    owner === undefined ||
    original === undefined ||
    !completeOwnComments(original) ||
    !completeOwnComments(owner)
  )
    return undefined;
  return commentProof({ before: original, after: owner, ops: preceding, mappings: [] }).find(
    (proof) =>
      proof.ownerBefore === original.target &&
      proof.ownerAfter === owner.target &&
      proof.after === target,
  )?.before;
}
function rebasedCommentTarget(
  before: TaskTreeV1,
  observed: readonly TaskTreeV1[],
  target: unknown,
): string | undefined {
  for (const owner of nodes(before)) {
    const candidates = observed.filter(
      (node) => node.target === owner.target && node.revision === owner.revision,
    );
    if (candidates.length === 0 || !candidates.every((source) => sameOwnComments(source, owner)))
      continue;
    const indices = candidates.flatMap((source) =>
      source.comments.flatMap((comment, index) => (comment.target === target ? [index] : [])),
    );
    if (indices.length === 0 || new Set(indices).size !== 1) continue;
    return owner.comments[indices[0] ?? -1]?.target;
  }
  return undefined;
}
/** A successful native select-fields preparation can mint a different plan and comment handles. */
function selectedCommentSource(
  previous: CommandSessionSnapshot,
  plan: ContentPlanV1,
  selected: readonly SelectedPlanObservation[],
  sourcePlans: readonly ContentPlanV1[] = [],
): TaskTreeV1 | undefined {
  const matches = selected.filter(
    (item) => item.selected === plan.target && item.selectedRevision === plan.revision,
  );
  if (matches.length !== 1 || plan.kind !== 'edit' || plan.before === null) return undefined;
  const selectedPlan = matches[0];
  if (selectedPlan === undefined) return undefined;
  const source = [
    ...previous.proposal.changes.flatMap((item) => (item.kind === 'task' ? [item.plan] : [])),
    ...sourcePlans,
  ].find(
    (candidate) =>
      candidate.target === selectedPlan.source &&
      candidate.revision === selectedPlan.sourceRevision &&
      candidate.kind === 'edit',
  );
  if (!selectedSourceMatchesOwner(source, plan)) return undefined;
  if (source?.kind !== 'edit') return undefined;
  return source.after ?? undefined;
}
function selectedSourceMatchesOwner(
  source: ContentPlanV1 | undefined,
  selected: ContentPlanV1,
): boolean {
  return (
    source?.kind === 'edit' &&
    source.before !== null &&
    selected.kind === 'edit' &&
    selected.before !== null &&
    source.before.target === selected.before.target &&
    source.before.revision === selected.before.revision
  );
}
function selectedReceiptComments(
  before: TaskTreeV1,
  after: TaskTreeV1,
  correspondence: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (correspondence['commentCoverage'] !== 'issued-plan-comments') return [];
  const tasks = list(correspondence['tasks']).map(object),
    comments = list(correspondence['comments']).map(object);
  return nodes(before).flatMap((owner) => {
    const prepared = nodes(after).find((item) => item.target === owner.target);
    if (prepared === undefined || !sameOwnComments(owner, prepared)) return [];
    const task = tasks.find((item) => item['preparedTarget'] === prepared.target);
    if (task === undefined) return [];
    return owner.comments.flatMap((original, index) => {
      const comment = prepared.comments[index];
      const proof = comments.find(
        (item) =>
          item['preparedTarget'] === comment?.target &&
          item['committedParent'] === task['committedTarget'] &&
          item['committedRevision'] === task['committedRevision'],
      );
      return proof === undefined ? [] : [{ ...proof, preparedTarget: original.target }];
    });
  });
}
function reboundReceiptComments(
  comments: ReadonlyArray<Record<string, unknown>>,
  source: TaskTreeV1,
  previous: CommandSessionSnapshot,
): Array<Record<string, unknown>> {
  return comments.flatMap((proof) => {
    const sourceOwner = nodes(source).find((owner) =>
      owner.comments.some((comment) => comment.target === proof['preparedTarget']),
    );
    if (sourceOwner === undefined) return [];
    const sourceIndex = sourceOwner.comments.findIndex(
      (comment) => comment.target === proof['preparedTarget'],
    );
    return previous.proposal.changes.flatMap((change) =>
      reboundReceiptForChange(proof, sourceOwner, sourceIndex, change),
    );
  });
}
function reboundReceiptForChange(
  proof: Record<string, unknown>,
  sourceOwner: TaskTreeV1,
  sourceIndex: number,
  change: CommandSessionSnapshot['proposal']['changes'][number],
): Array<Record<string, unknown>> {
  if (change.kind !== 'task' || change.plan.kind !== 'edit' || change.plan.before === null)
    return [];
  const savedOwner = nodes(change.plan.before).find(
    (owner) =>
      owner.target === proof['committedParent'] && owner.revision === proof['committedRevision'],
  );
  if (!receiptOwnerMatches(savedOwner, sourceOwner)) return [];
  const effectiveOwner =
    change.plan.after === null
      ? undefined
      : nodes(change.plan.after).find((owner) => owner.target === proof['committedParent']);
  const currentComment = effectiveOwner?.comments[sourceIndex];
  return effectiveOwner !== undefined &&
    currentComment !== undefined &&
    sameOwnComments(sourceOwner, effectiveOwner)
    ? [{ ...proof, preparedTarget: currentComment.target }]
    : [];
}
function receiptOwnerMatches(
  owner: TaskTreeV1 | undefined,
  source: TaskTreeV1,
): owner is TaskTreeV1 {
  return owner !== undefined && sameOwnComments(source, owner);
}
function receiptMappings({
  snapshot,
  previous,
  selectedPlans = [],
  selectedPlanSources = [],
}: TurnSnapshots) {
  return [
    ...previous.journal,
    ...snapshot.journal.filter((entry) => !previous.journal.some((old) => old.id === entry.id)),
  ].flatMap((entry) => receiptMapping(entry, previous, selectedPlans, selectedPlanSources));
}
function receiptMapping(
  entry: CommandSessionSnapshot['journal'][number],
  previous: CommandSessionSnapshot,
  selectedPlans: readonly SelectedPlanObservation[],
  selectedPlanSources: readonly ContentPlanV1[],
): Array<Record<string, unknown>> {
  const continuity = object(object(entry.receipt)['contentContinuity']);
  const correspondence = object(continuity['correspondence']);
  if (correspondence['state'] !== 'complete') return [];
  const change = entry.change;
  if (change.kind !== 'task' || change.plan.after === null) return [correspondence];
  const old = previous.proposal.changes.find(
    (candidate) => candidate.kind === 'task' && candidate.plan.target === change.plan.target,
  );
  if (old?.kind === 'task' && old.plan.after !== null)
    return receiptWithComments(
      correspondence,
      continuedReceiptComments(old.plan.after, change.plan.after, correspondence, previous),
    );
  return selectedReceiptMapping(entry, change.plan, {
    continuity,
    correspondence,
    previous,
    selectedPlans,
    selectedPlanSources,
  });
}
interface SelectedReceiptContext {
  continuity: Record<string, unknown>;
  correspondence: Record<string, unknown>;
  previous: CommandSessionSnapshot;
  selectedPlans: readonly SelectedPlanObservation[];
  selectedPlanSources: readonly ContentPlanV1[];
}
function selectedReceiptMapping(
  entry: CommandSessionSnapshot['journal'][number],
  plan: ContentPlanV1,
  context: SelectedReceiptContext,
): Array<Record<string, unknown>> {
  const { continuity, correspondence, previous, selectedPlans, selectedPlanSources } = context;
  if (
    plan.kind !== 'edit' ||
    plan.before === null ||
    plan.after === null ||
    continuity['plan'] !== plan.target ||
    continuity['planRevision'] !== plan.revision
  )
    return receiptWithComments(correspondence, []);
  const source = selectedCommentSource(previous, plan, selectedPlans, selectedPlanSources);
  if (source === undefined) return receiptWithComments(correspondence, []);
  let comments = selectedReceiptComments(source, plan.after, correspondence);
  if (previous.journal.some((item) => item.id === entry.id))
    comments = reboundReceiptComments(comments, source, previous);
  return receiptWithComments(correspondence, comments);
}
function receiptWithComments(
  correspondence: Record<string, unknown>,
  comments: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [{ ...correspondence, comments: [...list(correspondence['comments']), ...comments] }];
}
function continuedReceiptComments(
  before: TaskTreeV1,
  prepared: TaskTreeV1,
  correspondence: Record<string, unknown>,
  previous: CommandSessionSnapshot,
) {
  return nodes(before).flatMap((owner) => {
    const next = nodes(prepared).find((node) => node.target === owner.target);
    if (next?.comments.length !== owner.comments.length) return [];
    return owner.comments.flatMap((comment, index) => {
      const current = next.comments[index];
      if (current?.parentTarget !== owner.target) return [];
      const link = previous.proposal.changes.find(
        (c) => c.kind === 'link' && c.target === owner.target && c.comment === comment.target,
      );
      const note =
        link?.kind === 'link'
          ? previous.proposal.changes.find(
              (c) => c.kind === 'note' && c.plan.target === link.notePlan,
            )
          : undefined;
      const path = note?.kind === 'note' ? note.plan.path : undefined;
      if (normalizeLinkCarrier(comment.text, path) !== normalizeLinkCarrier(current.text, path))
        return [];
      const receipt = list(correspondence['comments'])
        .map(object)
        .find((item) => item['preparedTarget'] === current.target);
      return receipt === undefined ? [] : [{ ...receipt, preparedTarget: comment.target }];
    });
  });
}
function commentProof({
  before,
  after,
  ops,
  mappings,
  removedTargets = [],
  sourceRoot,
}: {
  before: TaskTreeV1;
  after: TaskTreeV1;
  ops: ReadonlyArray<Record<string, unknown>>;
  mappings: ReadonlyArray<Record<string, unknown>>;
  removedTargets?: readonly string[];
  sourceRoot?: TaskTreeV1;
}): CommentContinuity[] {
  const output: CommentContinuity[] = [];
  const safe = commentOperationsSafe(ops, removedTargets);
  for (const oldOwner of nodes(before)) {
    if (
      removedTargets.some((target) => {
        const removed = nodes(before).find((node) => node.target === target);
        return (
          removed !== undefined && nodes(removed).some((node) => node.target === oldOwner.target)
        );
      })
    )
      continue;
    const mappedOwner = mappings
      .flatMap((m) => list(m['tasks']).map(object))
      .find((m) => m['preparedTarget'] === oldOwner.target)?.['committedTarget'];
    const owner = nodes(after).find((n) => n.target === (mappedOwner ?? oldOwner.target));
    if (owner === undefined || !completeOwnComments(owner) || !completeOwnComments(oldOwner))
      continue;
    const retained = oldOwner.comments.filter(
      (comment) =>
        !ops.some((op) => op['type'] === 'remove-comment' && op['target'] === comment.target),
    );
    const additions = ops.filter(
      (op) =>
        ['add-comment', 'copy-comment'].includes(String(op['type'])) &&
        op['target'] === oldOwner.target,
    ).length;
    if (owner.comments.length !== retained.length + additions) continue;
    retained.forEach((comment, index) => {
      const next = owner.comments[index];
      if (next?.parentTarget !== owner.target || comment.parentTarget !== oldOwner.target) return;
      const receipt = mappings
        .flatMap((m) => list(m['comments']).map(object))
        .find(
          (m) => m['preparedTarget'] === comment.target && m['committedParent'] === owner.target,
        );
      const update = [...ops]
        .reverse()
        .find((op) => op['type'] === 'update-comment' && op['target'] === comment.target);
      const contentProved = next.text === (update?.['text'] ?? comment.text);
      if (receipt !== undefined || (safe && contentProved))
        output.push({
          before: comment.target,
          after: next.target,
          ownerBefore: oldOwner.target,
          ownerAfter: owner.target,
        });
    });
  }
  if (sourceRoot !== undefined)
    output.push(...sourceRootCommentProof(before, after, mappings, sourceRoot));
  return uniqueCommentContinuity(output);
}
function commentOperationsSafe(
  ops: ReadonlyArray<Record<string, unknown>>,
  removedTargets: readonly string[],
): boolean {
  const accepted = new Set([
    'patch',
    'description',
    'set-initial-status',
    'add-child',
    'update-comment',
    'add-comment',
    'remove-comment',
    'copy-comment',
  ]);
  return (
    ops.length > 0 &&
    ops.every(
      (op) =>
        (op['type'] === 'remove' && removedTargets.includes(String(op['target']))) ||
        accepted.has(String(op['type'])),
    )
  );
}
function uniqueCommentContinuity(values: readonly CommentContinuity[]): CommentContinuity[] {
  const seen: CommentContinuity[] = [];
  return values.filter((item) => {
    if (
      seen.some(
        (candidate) =>
          candidate.before === item.before &&
          candidate.after === item.after &&
          candidate.ownerBefore === item.ownerBefore &&
          candidate.ownerAfter === item.ownerAfter,
      )
    )
      return false;
    seen.push(item);
    return true;
  });
}
function sourceRootCommentProof(
  before: TaskTreeV1,
  after: TaskTreeV1,
  mappings: ReadonlyArray<Record<string, unknown>>,
  sourceRoot: TaskTreeV1,
): CommentContinuity[] {
  return nodes(before).flatMap((oldOwner) => {
    const sourceOwner = nodes(sourceRoot).find((node) => node.target === oldOwner.target);
    const mappedOwner = mappings
      .flatMap((mapping) => list(mapping['tasks']).map(object))
      .find((mapping) => mapping['preparedTarget'] === oldOwner.target)?.['committedTarget'];
    const currentOwner = nodes(after).find(
      (node) => node.target === (mappedOwner ?? oldOwner.target),
    );
    return sourceOwner === undefined || currentOwner === undefined
      ? []
      : sourceOwnerCommentContinuity(sourceOwner, oldOwner, currentOwner);
  });
}
function sourceOwnerCommentContinuity(
  source: TaskTreeV1,
  prior: TaskTreeV1,
  current: TaskTreeV1,
): CommentContinuity[] {
  if (!sameOwnComments(source, prior) || !sameOwnComments(source, current)) return [];
  return source.comments.flatMap((comment, index) => {
    const previous = prior.comments[index];
    const restored = current.comments[index];
    if (
      previous === undefined ||
      restored === undefined ||
      comment.parentTarget !== source.target ||
      previous.parentTarget !== prior.target ||
      restored.parentTarget !== current.target
    )
      return [];
    return [
      {
        before: previous.target,
        after: restored.target,
        ownerBefore: prior.target,
        ownerAfter: current.target,
      },
    ];
  });
}
function nodeAt(trees: readonly TaskTreeV1[], path: readonly number[]): TaskTreeV1 | undefined {
  let values = trees,
    value: TaskTreeV1 | undefined;
  for (const index of path) {
    value = values[index];
    values = value?.children ?? [];
  }
  return value;
}
interface StructuralPermissionInput {
  expected: TurnExpectation;
  snapshot: CommandSessionSnapshot;
  previous: CommandSessionSnapshot;
  before: readonly TaskTreeV1[];
  after: readonly TaskTreeV1[];
  ops: ReadonlyArray<Record<string, unknown>>;
  inputs: ReadonlyArray<Record<string, unknown>>;
  stagedPlans: readonly ContentPlanV1[];
  nativePlanBasis: readonly NativePlanBasisObservation[];
}
function acceptedStructuralOperation(
  context: StructuralPermissionInput,
  operation: Record<string, unknown>,
  parentTarget: string,
  sourceRoot: TaskTreeV1,
): boolean {
  const input = context.inputs.find((candidate) => candidate['operation'] === operation);
  if (input === undefined || !operationTargetsParent(operation, parentTarget, sourceRoot))
    return false;
  if (input['kind'] === 'edit') {
    const issuedNode = nodes(sourceRoot).find(
      (node) => node.target === input['target'] && node.revision === input['expectedRevision'],
    );
    return (
      issuedNode !== undefined &&
      [sourceRoot.target, parentTarget, operation['target']].includes(issuedNode.target)
    );
  }
  if (input['kind'] !== 'append') return false;
  const bases = context.stagedPlans.filter(
    (plan) =>
      plan.target === input['plan'] &&
      plan.revision === input['expectedPlanRevision'] &&
      plan.after?.target === sourceRoot.target,
  );
  if (
    bases.length > 0 &&
    bases.every(
      (plan) =>
        plan.after !== null && nodes(plan.after).some((node) => node.target === parentTarget),
    )
  )
    return true;
  return observedBatchAppendBasis({ context, input, operation, parentTarget, sourceRoot });
}
interface ObservedAppendRequest {
  context: StructuralPermissionInput;
  input: Record<string, unknown>;
  operation: Record<string, unknown>;
  parentTarget: string;
  sourceRoot: TaskTreeV1;
}
function observedBatchAppendBasis(request: ObservedAppendRequest): boolean {
  const chainInput = createObservedAppendChainInput(request);
  return chainInput !== undefined && followsObservedAppendChain(chainInput);
}
function createObservedAppendChainInput(
  request: ObservedAppendRequest,
): ObservedAppendChainInput | undefined {
  const { context, input, operation, sourceRoot } = request;
  const planTarget = input['plan'];
  if (!eligibleObservedAppendRequest(request, planTarget)) return undefined;
  if (typeof planTarget !== 'string') return undefined;
  const evidence = collectObservedAppendEvidence(context, planTarget);
  if (evidence === undefined) return undefined;
  const { finalPlan, available, appendInputs, observedInputs } = evidence;
  const base = observedAppendBase(available, observedInputs, planTarget, sourceRoot);
  if (base === undefined || finalPlan.after?.target !== sourceRoot.target) return undefined;
  if (typeof base.providerEpoch !== 'string' || base.after === null) return undefined;
  return {
    context,
    finalPlan,
    sourceRoot,
    available,
    appendInputs,
    observedInputs,
    base,
    baseTree: base.after,
    providerEpoch: base.providerEpoch,
    input,
    operation,
  };
}
function collectObservedAppendEvidence(
  context: StructuralPermissionInput,
  planTarget: string,
):
  | {
      finalPlan: ContentPlanV1;
      available: ContentPlanV1[];
      appendInputs: Array<Record<string, unknown>>;
      observedInputs: ObservedAppendInput[];
    }
  | undefined {
  const finalPlans = context.snapshot.proposal.changes.filter(
    (change) => change.kind === 'task' && change.plan.target === planTarget,
  );
  if (finalPlans.length !== 1 || finalPlans[0]?.kind !== 'task') return undefined;
  const appendInputs = context.inputs.filter(
    (candidate) => candidate['kind'] === 'append' && candidate['plan'] === planTarget,
  );
  const observedInputs = observedAppendInputs(context, planTarget, appendInputs);
  if (observedInputs.length !== appendInputs.length || observedInputs.length === 0)
    return undefined;
  return {
    finalPlan: finalPlans[0].plan,
    available: availablePlans(context),
    appendInputs,
    observedInputs,
  };
}
function eligibleObservedAppendRequest(
  request: ObservedAppendRequest,
  planTarget: unknown,
): boolean {
  return (
    typeof planTarget === 'string' &&
    typeof request.input['expectedPlanRevision'] === 'string' &&
    (request.operation['type'] === 'add-child' || request.operation['type'] === 'remove') &&
    operationTargetsParent(request.operation, request.parentTarget, request.sourceRoot)
  );
}
type ObservedAppendInput = {
  input: Record<string, unknown>;
  operation: Record<string, unknown>;
  observation: NativePlanBasisObservation;
};
function observedAppendInputs(
  context: StructuralPermissionInput,
  planTarget: string,
  appendInputs: ReadonlyArray<Record<string, unknown>>,
): ObservedAppendInput[] {
  return appendInputs.flatMap((candidate) => {
    const op = object(candidate['operation']);
    const matches = context.nativePlanBasis.filter(
      (observation) =>
        observation.input.plan === planTarget &&
        observation.input.expectedPlanRevision === candidate['expectedPlanRevision'] &&
        observation.input.operationIdentity === nativeOperationIdentity(op) &&
        observation.input.operationType === op['type'],
    );
    return matches.length === 1 && matches[0] !== undefined
      ? [{ input: candidate, operation: op, observation: matches[0] }]
      : [];
  });
}
function observedAppendBase(
  available: readonly ContentPlanV1[],
  observedInputs: readonly ObservedAppendInput[],
  planTarget: string,
  sourceRoot: TaskTreeV1,
): ContentPlanV1 | undefined {
  const firstRevision = observedInputs[0]?.input['expectedPlanRevision'];
  const basePlans = available.filter(
    (plan) =>
      plan.target === planTarget &&
      plan.revision === firstRevision &&
      plan.after?.target === sourceRoot.target,
  );
  const base = basePlans[0];
  if (base === undefined || base.after === null || basePlans.length === 0) return undefined;
  const baseAfter = base.after;
  const basisSignature = JSON.stringify(
    nodes(baseAfter).map((node) => [node.target, node.parentTarget]),
  );
  return basePlans.every(
    (plan) =>
      plan.after !== null &&
      plan.after.target === baseAfter.target &&
      plan.after.revision === baseAfter.revision &&
      JSON.stringify(nodes(plan.after).map((node) => [node.target, node.parentTarget])) ===
        basisSignature,
  )
    ? base
    : undefined;
}
interface ObservedAppendChainInput {
  context: StructuralPermissionInput;
  finalPlan: ContentPlanV1;
  sourceRoot: TaskTreeV1;
  available: readonly ContentPlanV1[];
  appendInputs: ReadonlyArray<Record<string, unknown>>;
  observedInputs: readonly ObservedAppendInput[];
  base: ContentPlanV1;
  baseTree: TaskTreeV1;
  providerEpoch: string;
  input: Record<string, unknown>;
  operation: Record<string, unknown>;
}
function followsObservedAppendChain(chainInput: ObservedAppendChainInput): boolean {
  const { finalPlan, appendInputs, base, baseTree, input, operation } = chainInput;
  const chain: ObservedAppendInput[] = [];
  const visited = new Set<string>();
  let revision = base.revision,
    priorSequence = 0,
    consumedMembership: ReadonlyArray<{ target: string; parentTarget: string | null }> = nodes(
      baseTree,
    ).map((node) => ({ target: node.target, parentTarget: node.parentTarget ?? null }));
  while (revision !== finalPlan.revision && chain.length < appendInputs.length) {
    if (visited.has(revision)) return false;
    visited.add(revision);
    const progress = nextObservedAppendLink(chainInput, {
      revision,
      priorSequence,
      consumedMembership,
      chainLength: chain.length,
    });
    if (progress === undefined) return false;
    chain.push(progress.link);
    revision = progress.link.observation.result.planRevision;
    priorSequence = progress.link.observation.sequence;
    consumedMembership = progress.membership;
  }
  if (
    revision !== finalPlan.revision ||
    finalPlan.after === null ||
    chain.length === 0 ||
    !chain.some((candidate) => candidate.input === input && candidate.operation === operation)
  )
    return false;
  const finalLink = chain[chain.length - 1];
  return finalLink !== undefined && nativeObservationMatchesFinal(finalLink, finalPlan);
}
interface ObservedAppendProgress {
  revision: string;
  priorSequence: number;
  consumedMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>;
  chainLength: number;
}
function nextObservedAppendLink(
  chainInput: ObservedAppendChainInput,
  progress: ObservedAppendProgress,
):
  | {
      link: ObservedAppendInput;
      membership: ObservedAppendInput['observation']['result']['taskMembership'];
    }
  | undefined {
  const { observedInputs, finalPlan, sourceRoot, providerEpoch, available, context } = chainInput;
  const nextInputs = observedInputs.filter(
    (candidate) => candidate.input['expectedPlanRevision'] === progress.revision,
  );
  const next = nextInputs[0];
  if (nextInputs.length !== 1 || next === undefined) return undefined;
  const effectiveMembership = nativeObservationMembership(next.observation, finalPlan);
  const parentTarget = operationParentTarget(
    next.operation,
    progress.consumedMembership,
    sourceRoot.target,
  );
  if (
    effectiveMembership === undefined ||
    parentTarget === undefined ||
    (progress.chainLength > 0 && next.observation.inputSequence <= progress.priorSequence) ||
    next.observation.sequence <= next.observation.inputSequence ||
    !validNativePlanObservation({
      observation: next.observation,
      input: next.input,
      operation: next.operation,
      sourceRoot,
      consumedMembership: progress.consumedMembership,
      effectiveMembership,
      parentTarget,
      providerEpoch,
      after: context.after,
      before: context.before,
      plans: available,
    })
  )
    return undefined;
  return { link: next, membership: effectiveMembership };
}
function nativeObservationMatchesFinal(
  link: ObservedAppendInput,
  finalPlan: ContentPlanV1,
): boolean {
  if (finalPlan.after === null) return false;
  const { result } = link.observation;
  const finalMembership = nativeObservationMembership(link.observation, finalPlan);
  if (finalMembership === undefined) return false;
  return (
    result.planTarget === finalPlan.target &&
    result.planRevision === finalPlan.revision &&
    result.providerEpoch === finalPlan.providerEpoch &&
    result.rootTarget === finalPlan.after.target &&
    result.rootRevision === finalPlan.after.revision &&
    sameMembership(
      finalMembership,
      nodes(finalPlan.after).map((node) => ({
        target: node.target,
        parentTarget: node.parentTarget ?? null,
      })),
    )
  );
}
function nativeObservationMembership(
  observation: NativePlanBasisObservation,
  finalPlan: ContentPlanV1,
): ReadonlyArray<{ target: string; parentTarget: string | null }> | undefined {
  const result = observation.result;
  if (result.rootComplete && !result.rootTruncated && result.membershipComplete)
    return result.taskMembership;
  const root = finalPlan.after;
  if (root === null || !isExactFinalObservation(observation, finalPlan, root)) return undefined;
  if (!validRawNativeMembership(result.taskMembership, result.rootTarget)) return undefined;
  const completeTree = nodes(root),
    completeMembership = completeTree.map((node) => ({
      target: node.target,
      parentTarget: node.parentTarget ?? null,
    }));
  if (!isCompleteFinalMembership(root, completeTree, completeMembership)) return undefined;
  if (!isConsistentMembershipSubset(completeMembership, result.taskMembership)) return undefined;
  return completeMembership;
}
function validRawNativeMembership(
  membership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  rootTarget: string,
): boolean {
  if (membership.length === 0 || membership.length > 256) return false;
  const members = new Map(membership.map((member) => [member.target, member.parentTarget]));
  if (members.size !== membership.length || members.get(rootTarget) !== null) return false;
  return [...members].every(
    ([target, parent]) =>
      target === rootTarget ||
      (parent !== null &&
        members.has(parent) &&
        memberIsRooted(parent, members, rootTarget, membership.length)),
  );
}
function isExactFinalObservation(
  observation: NativePlanBasisObservation,
  finalPlan: ContentPlanV1,
  root: TaskTreeV1,
): boolean {
  const result = observation.result;
  return (
    observation.input.plan === finalPlan.target &&
    result.planTarget === finalPlan.target &&
    result.planRevision === finalPlan.revision &&
    result.providerEpoch === finalPlan.providerEpoch &&
    result.rootTarget === root.target &&
    result.rootRevision === root.revision
  );
}
function isCompleteFinalMembership(
  root: TaskTreeV1,
  tree: readonly TaskTreeV1[],
  membership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
): boolean {
  const targets = new Set(membership.map((member) => member.target));
  return (
    tree.length > 0 &&
    tree.length <= 256 &&
    targets.size === tree.length &&
    root.parentTarget === undefined &&
    tree.every((node) => node.complete && !node.truncated) &&
    membership.every(
      (member) =>
        member.target === root.target ||
        (member.parentTarget !== null && targets.has(member.parentTarget)),
    )
  );
}
function isConsistentMembershipSubset(
  completeMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  observedMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
): boolean {
  const targets = new Map(completeMembership.map((member) => [member.target, member.parentTarget]));
  return observedMembership.every(
    (member) => targets.get(member.target) === member.parentTarget && targets.has(member.target),
  );
}
function sameMembership(
  left: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  right: ReadonlyArray<{ target: string; parentTarget: string | null }>,
): boolean {
  return (
    left.length === right.length && left.every((member, index) => sameMember(member, right[index]))
  );
}
function sameMember(
  left: { target: string; parentTarget: string | null },
  right: { target: string; parentTarget: string | null } | undefined,
): boolean {
  return right?.target === left.target && right.parentTarget === left.parentTarget;
}
function operationParentTarget(
  operation: Record<string, unknown>,
  consumed: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  rootTarget: string,
): string | undefined {
  if (operation['type'] === 'add-child')
    return typeof operation['target'] === 'string' ? operation['target'] : undefined;
  if (operation['type'] === 'remove') {
    const target = operation['target'];
    return typeof target === 'string'
      ? (consumed.find((member) => member.target === target)?.parentTarget ?? undefined)
      : undefined;
  }
  return rootTarget;
}
interface NativePlanValidationInput {
  observation: NativePlanBasisObservation;
  input: Record<string, unknown>;
  operation: Record<string, unknown>;
  sourceRoot: TaskTreeV1;
  consumedMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>;
  effectiveMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>;
  parentTarget: string;
  providerEpoch: string;
  after: readonly TaskTreeV1[];
  before: readonly TaskTreeV1[];
  plans: readonly ContentPlanV1[];
}
function validNativePlanObservation(validation: NativePlanValidationInput): boolean {
  const {
    observation,
    input,
    sourceRoot,
    consumedMembership,
    effectiveMembership,
    parentTarget,
    providerEpoch,
  } = validation;
  const result = observation.result,
    membership = effectiveMembership;
  if (
    result.planTarget !== input['plan'] ||
    result.planRevision.length === 0 ||
    result.providerEpoch !== providerEpoch ||
    result.rootTarget !== sourceRoot.target ||
    result.rootRevision.length === 0 ||
    membership.length > 256 ||
    !validRootedMembership(sourceRoot, membership, consumedMembership, parentTarget)
  )
    return false;
  return validNativeMembershipTransition(validation);
}
function validRootedMembership(
  sourceRoot: TaskTreeV1,
  membership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  consumedMembership: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  parentTarget: string,
): boolean {
  const members = new Map(membership.map((item) => [item.target, item.parentTarget]));
  const consumed = new Map(consumedMembership.map((item) => [item.target, item.parentTarget]));
  if (
    members.size !== membership.length ||
    !members.has(sourceRoot.target) ||
    !members.has(parentTarget) ||
    !consumed.has(parentTarget) ||
    consumed.get(sourceRoot.target) !== null
  )
    return false;
  return [...members].every(
    ([target, parent]) =>
      target === sourceRoot.target ||
      memberIsRooted(parent, members, sourceRoot.target, membership.length),
  );
}
function memberIsRooted(
  parent: string | null,
  members: ReadonlyMap<string, string | null>,
  rootTarget: string,
  limit: number,
): boolean {
  if (parent === null || !members.has(parent)) return false;
  let ancestor: string | null | undefined = parent;
  let hops = 0;
  while (ancestor !== rootTarget && ancestor !== null && ancestor !== undefined && hops <= limit) {
    ancestor = members.get(ancestor);
    hops++;
  }
  return ancestor === rootTarget;
}
function validNativeMembershipTransition(validation: NativePlanValidationInput): boolean {
  const { operation, consumedMembership, effectiveMembership, parentTarget } = validation;
  const members = new Map(effectiveMembership.map((item) => [item.target, item.parentTarget]));
  const consumed = new Map(consumedMembership.map((item) => [item.target, item.parentTarget]));
  if (operation['type'] === 'add-child' && operation['target'] !== parentTarget) return false;
  const removed = operation['type'] === 'remove' ? String(operation['target']) : undefined;
  if (removed !== undefined && consumed.get(removed) !== parentTarget) return false;
  const removedSubtree =
    removed === undefined ? new Set<string>() : consumedSubtree(removed, consumed);
  if (!preservesConsumedMembers(consumed, members, removedSubtree)) return false;
  const newMembers = effectiveMembership.filter((member) => !consumed.has(member.target));
  return validNativeOperationEffect(validation, newMembers);
}
function preservesConsumedMembers(
  consumed: ReadonlyMap<string, string | null>,
  members: ReadonlyMap<string, string | null>,
  removedSubtree: ReadonlySet<string>,
): boolean {
  return [...consumed].every(([target, parent]) =>
    removedSubtree.has(target) ? !members.has(target) : members.get(target) === parent,
  );
}
function validNativeOperationEffect(
  validation: NativePlanValidationInput,
  newMembers: ReadonlyArray<{ target: string; parentTarget: string | null }>,
): boolean {
  const { operation, sourceRoot, parentTarget } = validation;
  if (operation['type'] === 'add-child') {
    if (operation['target'] !== parentTarget || newMembers.length !== 1) return false;
    const added = newMembers[0];
    if (added === undefined || !validAddedTask(added, validation)) return false;
  } else if (operation['type'] === 'remove') {
    if (newMembers.length !== 0 || operation['target'] === sourceRoot.target) return false;
  } else {
    return validCopiedAppend(newMembers, validation);
  }
  return true;
}
function validCopiedAppend(
  newMembers: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  validation: NativePlanValidationInput,
): boolean {
  return (
    newMembers.length === 0 ||
    copyMembershipsProved(
      newMembers,
      validation.observation.result,
      validation.plans,
      validation.before,
    )
  );
}
function consumedSubtree(
  rootTarget: string,
  consumed: ReadonlyMap<string, string | null>,
): Set<string> {
  const subtree = new Set([rootTarget]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [target, parent] of consumed) {
      if (parent !== null && subtree.has(parent) && !subtree.has(target)) {
        subtree.add(target);
        changed = true;
      }
    }
  }
  return subtree;
}
function validAddedTask(
  added: { target: string; parentTarget: string | null },
  validation: NativePlanValidationInput,
): boolean {
  const { operation, parentTarget, after } = validation;
  if (added.parentTarget !== parentTarget) return false;
  const finalNodes = after.flatMap(nodes).filter((node) => node.target === added.target);
  const finalNode = finalNodes[0];
  return (
    finalNodes.length === 1 &&
    finalNode !== undefined &&
    finalNode.markdownTitle === operation['markdownTitle'] &&
    finalNode.parentTarget === parentTarget &&
    finalNode.complete
  );
}
function copyMembershipsProved(
  additions: ReadonlyArray<{ target: string; parentTarget: string | null }>,
  result: NativePlanBasisObservation['result'],
  plans: readonly ContentPlanV1[],
  before: readonly TaskTreeV1[],
): boolean {
  const matchingPlans = plans.filter(
    (plan) => plan.target === result.planTarget && plan.revision === result.planRevision,
  );
  if (matchingPlans.length === 0) return false;
  const destinationTargets = new Set(
    matchingPlans.flatMap((plan) =>
      (plan.copies ?? [])
        .filter((copy) => copy.type === 'subtree' && copy.state === 'retained')
        .flatMap((copy) => copy.tasks.map((task) => task.destinationTarget)),
    ),
  );
  const sourceTargets = new Set(before.flatMap(nodes).map((node) => node.target));
  return additions.every(
    (member) =>
      destinationTargets.has(member.target) &&
      !sourceTargets.has(member.target) &&
      typeof member.parentTarget === 'string' &&
      result.taskMembership.some((candidate) => candidate.target === member.parentTarget),
  );
}
function operationTargetsParent(
  operation: Record<string, unknown>,
  parentTarget: string,
  sourceRoot: TaskTreeV1,
): boolean {
  if (operation['type'] === 'add-child') return operation['target'] === parentTarget;
  if (operation['type'] !== 'remove') return false;
  return nodes(sourceRoot).some(
    (node) => node.target === operation['target'] && node.parentTarget === parentTarget,
  );
}
function expectedChildAdditions(input: StructuralPermissionInput): string[] {
  const { expected, before, after, ops } = input;
  return (expected.addedNodes ?? []).flatMap((path) => {
    const node = nodeAt(after, path),
      parent = nodeAt(after, path.slice(0, -1));
    if (node === undefined || parent === undefined) return [];
    const sourceRoot = before.find((root) =>
      nodes(root).some((child) => child.target === parent.target),
    );
    return sourceRoot !== undefined &&
      ops.some(
        (op) =>
          op['type'] === 'add-child' &&
          op['target'] === parent.target &&
          op['markdownTitle'] === node.markdownTitle &&
          acceptedStructuralOperation(input, op, parent.target, sourceRoot),
      )
      ? [node.target]
      : [];
  });
}
function expectedChildRemovals(input: StructuralPermissionInput): string[] {
  const { expected, before, ops } = input;
  return (expected.removedNodes ?? []).flatMap((path) => {
    const node = nodeAt(before, path),
      parent = nodeAt(before, path.slice(0, -1));
    if (node === undefined || parent === undefined) return [];
    const sourceRoot = before.find((root) =>
      nodes(root).some((part) => part.target === parent.target),
    );
    return sourceRoot !== undefined &&
      ops.some(
        (op) =>
          op['type'] === 'remove' &&
          op['target'] === node.target &&
          acceptedStructuralOperation(input, op, parent.target, sourceRoot),
      )
      ? [node.target]
      : [];
  });
}
function decompositionAddedTargets(input: StructuralPermissionInput): string[] {
  const { expected, before, after, ops } = input;
  if (expected.decomposition === undefined || expected.trees?.length !== 1) return [];
  const rootTitle = object(expected.trees[0])['markdownTitle'];
  const roots = before.filter(
    (root) => root.markdownTitle === rootTitle && after.some((next) => next.target === root.target),
  );
  if (roots.length !== 1) return [];
  const root = roots[0];
  if (root === undefined) return [];
  const currentRoot = after.find((item) => item.target === root.target);
  if (currentRoot === undefined) return [];
  const previousTargets = new Set(before.flatMap(nodes).map((node) => node.target));
  const targetCounts = new Map<string, number>();
  for (const node of after.flatMap(nodes))
    targetCounts.set(node.target, (targetCounts.get(node.target) ?? 0) + 1);
  const additions = new Set<string>();
  const visitNewChildren = (parent: TaskTreeV1) => {
    for (const child of parent.children) {
      if (previousTargets.has(child.target)) continue;
      const accepted =
        child.parentTarget === parent.target &&
        child.complete &&
        targetCounts.get(child.target) === 1 &&
        ops.some(
          (op) =>
            op['type'] === 'add-child' &&
            op['target'] === parent.target &&
            op['markdownTitle'] === child.markdownTitle &&
            acceptedStructuralOperation(input, op, parent.target, root),
        );
      if (!accepted) continue;
      additions.add(child.target);
      visitNewChildren(child);
    }
  };
  visitNewChildren(currentRoot);
  return [...additions];
}
function relocationTargets(
  before: readonly TaskTreeV1[],
  after: readonly TaskTreeV1[],
  ops: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const relocation = ops
    .filter((op) => ['reparent', 'promote'].includes(String(op['type'])))
    .map((op) => op['source']);
  return before
    .flatMap(nodes)
    .filter(
      (node) =>
        relocation.includes(node.target) &&
        after.flatMap(nodes).some((current) => current.target === node.target),
    )
    .flatMap((node) => nodes(node).map((value) => value.target));
}
function structuralPermissions(input: StructuralPermissionInput) {
  const addedNodeTargets = expectedChildAdditions(input);
  const removedNodeTargets = expectedChildRemovals(input);
  addedNodeTargets.push(...decompositionAddedTargets(input));
  const relocatedNodeTargets = relocationTargets(input.before, input.after, input.ops);
  return { addedNodeTargets, removedNodeTargets, relocatedNodeTargets };
}
function copiedComments(
  before: TaskTreeV1,
  after: TaskTreeV1,
  copy: ContentSourceCopyV1,
): CommentContinuity[] {
  return nodes(before).flatMap((owner) => {
    const mapped = copy.tasks.find((task) => task.sourceTarget === owner.target)?.destinationTarget;
    const next = nodes(after).find((node) => node.target === mapped);
    if (next === undefined || !next.complete || next.comments.length !== owner.comments.length)
      return [];
    return owner.comments.flatMap((comment, index) => {
      const current = next.comments[index];
      if (
        current?.text !== comment.text ||
        !copy.comments.some(
          (proof) =>
            proof.destinationTarget === current.target && proof.destinationParent === next.target,
        )
      )
        return [];
      return [
        {
          before: comment.target,
          after: current.target,
          ownerBefore: owner.target,
          ownerAfter: next.target,
        },
      ];
    });
  });
}
function copiedPairs(
  snapshot: CommandSessionSnapshot,
  previous: CommandSessionSnapshot,
  trees: readonly TaskTreeV1[],
  ops: ReadonlyArray<Record<string, unknown>>,
): PreservationPair[] {
  const sources = [
    ...snapshot.entities.tasks.map((page) => page.tree),
    ...previous.trees.flatMap((pair) => (pair.after === null ? [] : [pair.after])),
  ].flatMap(nodes);
  return snapshot.proposal.changes.flatMap((change) => {
    if (change.kind !== 'task') return [];
    return (change.plan.copies ?? []).flatMap((copy) => {
      if (
        copy.type !== 'subtree' ||
        copy.state !== 'retained' ||
        !ops.some((op) => op['type'] === 'copy-subtree' && op['source'] === copy.source)
      )
        return [];
      const before = sources.find(
        (node) =>
          node.target === copy.sourceRoot.target &&
          node.revision === copy.sourceRoot.revision &&
          node.complete,
      );
      const destination = copy.tasks.find(
        (task) => task.sourceTarget === copy.sourceRoot.target,
      )?.destinationTarget;
      const after = trees.flatMap(nodes).find((node) => node.target === destination);
      if (before === undefined || after === undefined) return [];
      const nodeContinuity = copy.tasks.map((task) => ({
        before: task.sourceTarget,
        after: task.destinationTarget,
      }));
      const commentContinuity = copiedComments(before, after, copy);
      return [{ before, after, requested: {}, nodeContinuity, commentContinuity }];
    });
  });
}
function structuralOrderFlag(
  expected: TurnExpectation,
  permissions: ReturnType<typeof structuralPermissions>,
): { structuralOrderRequired: true } | Record<string, never> {
  return permissions.removedNodeTargets.length > 0 ||
    (expected.decomposition !== undefined && permissions.addedNodeTargets.length > 0)
    ? { structuralOrderRequired: true }
    : {};
}
interface PreservationAppendContext {
  pairs: PreservationPair[];
  trees: readonly TaskTreeV1[];
  expected: TurnExpectation;
  permissions: ReturnType<typeof structuralPermissions>;
  history: TurnSnapshots;
  ops: ReadonlyArray<Record<string, unknown>>;
  mappings: ReadonlyArray<Record<string, unknown>>;
  pendingRequestedByTarget: ReadonlyMap<string, unknown>;
}
function appendPreservationPair(
  context: PreservationAppendContext,
  before: TaskTreeV1,
  after: TaskTreeV1,
): void {
  const { pairs, trees, pendingRequestedByTarget } = context;
  const index = trees.flatMap(nodes).findIndex((tree) => tree.target === after.target);
  if (index < 0) return;
  const requested =
    pendingRequestedByTarget.get(before.target) ?? requestedTree(context.expected, after);
  pairs.push(makePreservationPair(context, { before, after, requested }));
}
function makePreservationPair(
  context: PreservationAppendContext,
  pair: {
    before: TaskTreeV1;
    after: TaskTreeV1;
    requested: unknown;
    sourceRoot?: TaskTreeV1;
  },
): PreservationPair {
  const { before, after, requested, sourceRoot } = pair;
  const { expected, permissions, history, ops, mappings } = context;
  const pairOps = groundedCommentOperations(before, history, ops);
  return {
    before,
    after,
    ...permissions,
    ...structuralOrderFlag(expected, permissions),
    requested,
    commentContinuity: commentProof({
      before,
      after,
      ops: pairOps,
      mappings,
      removedTargets: permissions.removedNodeTargets,
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
    }),
    removedCommentTargets: pairOps.flatMap((op) =>
      op['type'] === 'remove-comment' && typeof op['target'] === 'string' ? [op['target']] : [],
    ),
    nodeContinuity: mappings
      .flatMap((m) => list(m['tasks']).map(object))
      .flatMap((m) =>
        typeof m['preparedTarget'] === 'string' && typeof m['committedTarget'] === 'string'
          ? [{ before: m['preparedTarget'], after: m['committedTarget'] }]
          : [],
      ),
  };
}
function appendExistingAndRelocatedPairs(
  context: PreservationAppendContext,
  previousTrees: readonly TaskTreeV1[],
  sourceTrees: readonly TaskTreeV1[],
): void {
  const { trees, permissions, mappings } = context;
  for (const old of previousTrees) {
    const mapped = mappings
      .flatMap((mapping) => list(mapping['tasks']).map(object))
      .find((mapping) => mapping['preparedTarget'] === old.target)?.['committedTarget'];
    const after = trees.find((tree) => tree.target === (mapped ?? old.target));
    if (after !== undefined) appendPreservationPair(context, old, after);
  }
  for (const target of permissions.relocatedNodeTargets) {
    const before = [...sourceTrees, ...previousTrees]
      .flatMap(nodes)
      .find((node) => node.target === target);
    const after = trees.flatMap(nodes).find((node) => node.target === target);
    if (before !== undefined && after !== undefined) appendPreservationPair(context, before, after);
  }
}
function planSourceTrees(snapshot: CommandSessionSnapshot): TaskTreeV1[] {
  return snapshot.proposal.changes.flatMap((change) =>
    change.kind === 'task'
      ? commandPlanViews(change.plan).flatMap((pair) => (pair.before === null ? [] : [pair.before]))
      : [],
  );
}
function previousTaskTrees(snapshot: CommandSessionSnapshot): TaskTreeV1[] {
  return snapshot.trees.flatMap((pair) => (pair.after === null ? [] : [pair.after]));
}
export interface PreservationEvidenceOptions extends PendingTaskStateOptions {
  publicReadback?: readonly TaskTreeV1[];
}
export interface TurnPreservationEvidence {
  preservation: PreservationPair[];
  pendingTaskStateFailures?: readonly string[];
}
/** Build shared owner-bound pairs and pending-state diagnostics from canonical turn facts. */
export function buildTurnPreservation(
  history: TurnSnapshots,
  trees: readonly TaskTreeV1[],
  expected: TurnExpectation,
  options: PreservationEvidenceOptions = { writeCount: 0 },
): TurnPreservationEvidence {
  const { snapshot, previous } = history;
  const ops = operations(snapshot, previous),
    mappings = receiptMappings(history);
  const knownPlans = availablePlans(history);
  const copies = copiedPairs(snapshot, previous, trees, ops);
  const pairs: PreservationPair[] = [...copies];
  const previousTrees = previousTaskTrees(previous);
  const sourceTrees = planSourceTrees(snapshot);
  const permissions = structuralPermissions({
    expected,
    snapshot,
    previous,
    before: previousTrees.length > 0 ? previousTrees : sourceTrees,
    after: trees,
    ops,
    inputs: taskInputsOfTurn(snapshot, previous),
    stagedPlans: knownPlans,
    nativePlanBasis: history.nativePlanBasis ?? [],
  });
  permissions.addedNodeTargets.push(
    ...copies.flatMap((pair) =>
      typeof object(pair.after)['target'] === 'string'
        ? [
            String(object(pair.after)['target']),
            ...(pair.nodeContinuity ?? []).map((link) => link.after),
          ]
        : [],
    ),
  );
  const pendingStates =
    expected.pendingTaskStates === undefined
      ? { failures: [], requestedByTarget: new Map<string, unknown>(), owners: [] }
      : resolvePendingTaskStates(expected, history, options.publicReadback ?? [], options);
  const appendContext = {
    pairs,
    trees,
    expected,
    permissions,
    history,
    ops,
    mappings,
    pendingRequestedByTarget: pendingStates.requestedByTarget,
  };
  for (const pair of newPlanPairs(snapshot, previous))
    appendPreservationPair(appendContext, pair.before, pair.after);
  appendExistingAndRelocatedPairs(appendContext, previousTrees, sourceTrees);
  if (expected.pendingTaskStates !== undefined) {
    const pendingTargets = new Set(pendingStates.owners.map((owner) => owner.persisted.target));
    const requiredPairs = pendingStates.owners.map((owner) =>
      makePreservationPair(appendContext, {
        before: owner.prior ?? owner.persisted,
        after: owner.effective,
        requested: owner.requested,
        sourceRoot: owner.persisted,
      }),
    );
    const ordinaryPairs = pairs.filter(
      (pair) => !pendingTargets.has(String(object(pair.before)['target'])),
    );
    const pendingTaskStateFailures = [
      ...pendingStates.failures,
      ...pendingProjectionFailures(
        history,
        trees,
        options.publicReadback ?? [],
        pendingStates.owners,
      ),
      ...requiredPairs.flatMap(pendingEntryOrderFailures),
    ];
    return {
      preservation: [...ordinaryPairs, ...requiredPairs],
      pendingTaskStateFailures: [...new Set(pendingTaskStateFailures)],
    };
  }
  return { preservation: pairs };
}
/** Compatibility wrapper for callers that only need the canonical preservation pairs. */
export function preservationEvidence(
  history: TurnSnapshots,
  trees: readonly TaskTreeV1[],
  expected: TurnExpectation,
  options: PreservationEvidenceOptions = { writeCount: 0 },
): PreservationPair[] {
  return buildTurnPreservation(history, trees, expected, options).preservation;
}

function newPlanPairs(
  snapshot: CommandSessionSnapshot,
  previous: CommandSessionSnapshot,
): Array<{ before: TaskTreeV1; after: TaskTreeV1 }> {
  return snapshot.proposal.changes.flatMap((change) => {
    if (
      change.kind !== 'task' ||
      previous.proposal.changes.some(
        (old) => old.kind === 'task' && old.plan.target === change.plan.target,
      )
    )
      return [];
    return commandPlanViews(change.plan).flatMap((pair) =>
      pair.before !== null && pair.after !== null
        ? [{ before: pair.before, after: pair.after }]
        : [],
    );
  });
}
