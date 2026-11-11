import type { ContentPlanV1, ContentSourceCopyV1, TaskTreeV1 } from '../../api';
import { commandPlanViews } from '../../src/ai/commandSchemas';
import type { CommandSessionSnapshot } from '../../src/ai/commandTypes';
import { normalizeLinkCarrier } from './linkOracle';
import {
  requestedTree,
  type CommentContinuity,
  type PreservationPair,
  type TurnExpectation,
} from './oracles';
import { object } from './safety';
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
interface TurnSnapshots {
  snapshot: CommandSessionSnapshot;
  previous: CommandSessionSnapshot;
  stagedPlans?: readonly ContentPlanV1[];
  selectedPlans?: readonly SelectedPlanObservation[];
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
  return commentProof(original, owner, preceding, []).find(
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
): TaskTreeV1 | undefined {
  const matches = selected.filter(
    (item) => item.selected === plan.target && item.selectedRevision === plan.revision,
  );
  if (matches.length !== 1 || plan.kind !== 'edit' || plan.before === null) return undefined;
  const source = previous.proposal.changes.find(
    (item) =>
      item.kind === 'task' &&
      item.plan.target === matches[0]?.source &&
      item.plan.revision === matches[0].sourceRevision,
  );
  if (
    source?.kind !== 'task' ||
    source.plan.before?.target !== plan.before.target ||
    source.plan.before.revision !== plan.before.revision
  )
    return undefined;
  return source.plan.after ?? undefined;
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
function receiptMappings({ snapshot, previous, selectedPlans = [] }: TurnSnapshots) {
  return snapshot.journal
    .filter((entry) => !previous.journal.some((old) => old.id === entry.id))
    .flatMap((entry) => {
      const continuity = object(object(entry.receipt)['contentContinuity']);
      const correspondence = object(continuity['correspondence']);
      if (correspondence['state'] !== 'complete') return [];
      const change = entry.change;
      if (change.kind !== 'task' || change.plan.after === null) return [correspondence];
      const old = previous.proposal.changes.find(
        (c) => c.kind === 'task' && c.plan.target === change.plan.target,
      );
      let comments: Array<Record<string, unknown>> = [];
      if (old?.kind === 'task' && old.plan.after !== null)
        comments = continuedReceiptComments(
          old.plan.after,
          change.plan.after,
          correspondence,
          previous,
        );
      else if (
        continuity['plan'] === change.plan.target &&
        continuity['planRevision'] === change.plan.revision
      ) {
        const source = selectedCommentSource(previous, change.plan, selectedPlans);
        if (source !== undefined)
          comments = selectedReceiptComments(source, change.plan.after, correspondence);
      }
      return [{ ...correspondence, comments: [...list(correspondence['comments']), ...comments] }];
    });
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
function commentProof(
  before: TaskTreeV1,
  after: TaskTreeV1,
  ops: ReadonlyArray<Record<string, unknown>>,
  mappings: ReadonlyArray<Record<string, unknown>>,
): CommentContinuity[] {
  const output: CommentContinuity[] = [];
  const safe =
    ops.length > 0 &&
    ops.every((op) =>
      [
        'patch',
        'description',
        'set-initial-status',
        'add-child',
        'update-comment',
        'add-comment',
        'remove-comment',
        'copy-comment',
      ].includes(String(op['type'])),
    );
  for (const oldOwner of nodes(before)) {
    const mappedOwner = mappings
      .flatMap((m) => list(m['tasks']).map(object))
      .find((m) => m['preparedTarget'] === oldOwner.target)?.['committedTarget'];
    const owner = nodes(after).find((n) => n.target === (mappedOwner ?? oldOwner.target));
    if (owner === undefined || !owner.complete || !oldOwner.complete) continue;
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
  return output;
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
function structuralPermissions(
  expected: TurnExpectation,
  before: readonly TaskTreeV1[],
  after: readonly TaskTreeV1[],
  ops: ReadonlyArray<Record<string, unknown>>,
) {
  const addedNodeTargets = (expected.addedNodes ?? []).flatMap((path) => {
    const node = nodeAt(after, path),
      parent = nodeAt(after, path.slice(0, -1));
    return node !== undefined &&
      parent !== undefined &&
      ops.some(
        (op) =>
          op['type'] === 'add-child' &&
          op['target'] === parent.target &&
          op['markdownTitle'] === node.markdownTitle,
      )
      ? [node.target]
      : [];
  });
  const removedNodeTargets = (expected.removedNodes ?? []).flatMap((path) => {
    const node = nodeAt(before, path);
    return node !== undefined &&
      ops.some((op) => op['type'] === 'remove' && op['target'] === node.target)
      ? [node.target]
      : [];
  });
  const relocation = ops
    .filter((op) => ['reparent', 'promote'].includes(String(op['type'])))
    .map((op) => op['source']);
  const relocatedNodeTargets = before
    .flatMap(nodes)
    .filter(
      (node) =>
        relocation.includes(node.target) &&
        after.flatMap(nodes).some((current) => current.target === node.target),
    )
    .flatMap((node) => nodes(node).map((value) => value.target));
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
/** Pair actual issued roots; authored expectation positions describe output structure only. */
export function preservationEvidence(
  history: TurnSnapshots,
  trees: readonly TaskTreeV1[],
  expected: TurnExpectation,
): PreservationPair[] {
  const { snapshot, previous } = history;
  const ops = operations(snapshot, previous),
    mappings = receiptMappings(history);
  const copies = copiedPairs(snapshot, previous, trees, ops);
  const pairs: PreservationPair[] = [...copies];
  const views = snapshot.proposal.changes.flatMap((change) =>
    change.kind === 'task' ? commandPlanViews(change.plan) : [],
  );
  const previousTrees = previous.trees.flatMap((pair) => (pair.after === null ? [] : [pair.after]));
  const sourceTrees = views.flatMap((pair) => (pair.before === null ? [] : [pair.before]));
  const permissions = structuralPermissions(
    expected,
    previousTrees.length > 0 ? previousTrees : sourceTrees,
    trees,
    ops,
  );
  permissions.addedNodeTargets.push(
    ...copies.flatMap((pair) =>
      typeof object(pair.after)['target'] === 'string'
        ? [String(object(pair.after)['target'])]
        : [],
    ),
  );

  const append = (before: TaskTreeV1, after: TaskTreeV1) => {
    const index = trees.flatMap(nodes).findIndex((tree) => tree.target === after.target);
    if (index < 0) return;
    const pairOps = groundedCommentOperations(before, history, ops);
    pairs.push({
      before,
      after,
      ...permissions,
      requested: requestedTree(expected, after),
      commentContinuity: commentProof(before, after, pairOps, mappings),
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
    });
  };
  for (const pair of newPlanPairs(snapshot, previous)) append(pair.before, pair.after);
  for (const old of previous.trees) {
    if (old.after === null) continue;
    const mapped = mappings
      .flatMap((m) => list(m['tasks']).map(object))
      .find((m) => m['preparedTarget'] === old.after?.target)?.['committedTarget'];
    const after = trees.find((tree) => tree.target === (mapped ?? old.after?.target));
    if (after !== undefined) append(old.after, after);
  }
  for (const target of permissions.relocatedNodeTargets) {
    const before = [...sourceTrees, ...previousTrees]
      .flatMap(nodes)
      .find((node) => node.target === target);
    const after = trees.flatMap(nodes).find((node) => node.target === target);
    if (before !== undefined && after !== undefined) append(before, after);
  }
  return pairs;
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
