import type { ContentPlanV1, TaskCommentV1, TaskPatchV1, TaskTreeV1 } from '../../api';
import {
  CommandFailure,
  type CommandChange,
  type CommandSaveScope,
  type CommandSessionSnapshot,
} from './commandTypes';

type Field = keyof TaskPatchV1 | 'description';
const fields: readonly Field[] = [
  'markdownTitle',
  'description',
  'priority',
  'due',
  'scheduled',
  'start',
  'time',
  'durationMinutes',
  'recurrence',
  'onCompletion',
  'tags',
];
interface NodeOwner {
  readonly title: string;
  readonly position: number;
}
interface Located {
  readonly node: TaskTreeV1;
  readonly trail: readonly NodeOwner[];
}
function* ownedNodes(
  node: TaskTreeV1,
  parents: readonly NodeOwner[] = [],
  position = 1,
): Generator<Located> {
  const trail = [...parents, { title: node.markdownTitle, position }];
  yield { node, trail };
  for (const [index, child] of node.children.entries()) yield* ownedNodes(child, trail, index + 1);
}
function locate(tree: TaskTreeV1 | null, target: string): Located | undefined {
  if (tree === null) return undefined;
  for (const entry of ownedNodes(tree)) if (entry.node.target === target) return entry;
  return undefined;
}
function fieldValue(node: TaskTreeV1, field: Field): unknown {
  if (field === 'start' || field === 'scheduled' || field === 'due')
    return node.dates[field] ?? null;
  return node[field] ?? null;
}
function fieldChanges(before: TaskTreeV1, after: TaskTreeV1, wanted: readonly Field[]): object[] {
  return wanted.flatMap((field) => {
    const previous = fieldValue(before, field),
      prepared = fieldValue(after, field);
    return JSON.stringify(previous) === JSON.stringify(prepared)
      ? []
      : [{ field, previous, prepared }];
  });
}
function taskContents(node: TaskTreeV1): unknown {
  return [
    fields.map((field) => fieldValue(node, field)),
    node.dates,
    node.statusSymbol,
    node.onCompletionExplicit,
    node.authoredId,
    node.comments.map((comment) => [comment.text, comment.timestamp]),
    node.timeEntries.map((entry) => [
      entry.state,
      entry.startMs,
      entry.endMs,
      entry.note,
      entry.issue,
    ]),
    node.entries.map((entry) => entry.kind),
    node.children.map(taskContents),
  ];
}
function planContents(plan: ContentPlanV1): unknown {
  if (plan.affected !== undefined) return plan.affected.after.map(taskContents);
  return plan.after === null ? null : taskContents(plan.after);
}
function preparedValue(change: CommandChange): unknown {
  if (change.kind === 'note') return [change.kind, change.plan.path, change.plan.after.text];
  if (change.kind === 'task')
    return [change.kind, change.plan.destination?.path, planContents(change.plan)];
  return change;
}
function materialProposal(snapshot: CommandSessionSnapshot): string {
  const changes = snapshot.proposal.changes.filter(
    (change) =>
      change.kind !== 'task' || change.plan.kind !== 'edit' || change.plan.hasChanges !== false,
  );
  return JSON.stringify(changes.map(preparedValue));
}
/** Compare material published proposal contents, including removal of an earlier draft. Version tokens alone never prove a requested edit. */
export function hasFreshCommandWork(
  before: CommandSessionSnapshot,
  after: CommandSessionSnapshot,
): boolean {
  return materialProposal(before) !== materialProposal(after);
}
interface Subject {
  readonly kind: string;
  readonly owner?: object | undefined;
  readonly prepared?: unknown;
}
function sourceLocation(node: TaskTreeV1): { path: string | undefined; line: number | undefined } {
  return { path: node.source?.path, line: node.source?.line };
}
function rootOwner(plan: ContentPlanV1): object | undefined {
  const tree = plan.after ?? plan.before;
  const source = tree?.source ?? plan.before?.source;
  return tree === null
    ? undefined
    : {
        title: tree.markdownTitle,
        path: plan.destination?.path ?? source?.path,
        line: source?.line,
      };
}
function statusOwner(
  change: Extract<CommandChange, { kind: 'status' }>,
  snapshot: CommandSessionSnapshot,
): object | undefined {
  const plan = snapshot.proposal.changes.find(
    (item) => item.kind === 'task' && item.plan.target === change.plan,
  );
  if (plan?.kind === 'task') {
    const found = locate(plan.plan.after, change.target);
    if (found !== undefined)
      return {
        trail: found.trail,
        path: plan.plan.destination?.path ?? found.node.source?.path,
        line: found.node.source?.line,
      };
  }
  return savedStatusOwner(change, snapshot);
}
function savedStatusOwner(
  change: Extract<CommandChange, { kind: 'status' }>,
  snapshot: CommandSessionSnapshot,
): object | undefined {
  const roots = [...snapshot.entities.tasks.map((page) => page.tree), ...snapshot.actual];
  for (const root of roots) {
    const found = locate(root, change.target);
    if (found?.node.revision === change.revision)
      return { trail: found.trail, ...sourceLocation(found.node) };
  }
  return undefined;
}
function unmatchedComments(
  comments: readonly TaskCommentV1[],
  others: readonly TaskCommentV1[],
): object[] {
  const counts = new Map<string, number>();
  const key = (comment: TaskCommentV1): string => JSON.stringify([comment.text, comment.timestamp]);
  for (const comment of others) counts.set(key(comment), (counts.get(key(comment)) ?? 0) + 1);
  return comments.flatMap((comment) => {
    const id = key(comment),
      count = counts.get(id) ?? 0;
    if (count === 0) return [{ text: comment.text, timestamp: comment.timestamp }];
    counts.set(id, count - 1);
    return [];
  });
}
function commentChanges(before: TaskTreeV1, after: TaskTreeV1): object[] {
  if (before.comments.length !== after.comments.length)
    return [
      {
        field: 'comments',
        removed: unmatchedComments(before.comments, after.comments),
        added: unmatchedComments(after.comments, before.comments),
      },
    ];
  return after.comments.flatMap((comment, index) => {
    const previous = before.comments[index]?.text;
    if (previous === undefined || previous === comment.text) return [];
    return [{ field: 'commentText', position: index + 1, previous, prepared: comment.text }];
  });
}
function childrenReordered(before: TaskTreeV1, after: TaskTreeV1): boolean {
  const previous = new Set(before.children.map((child) => child.target));
  const current = new Set(after.children.map((child) => child.target));
  const retained = [...current].filter((target) => previous.has(target));
  return [...previous]
    .filter((target) => current.has(target))
    .some((target, index) => target !== retained[index]);
}
function editedNodeFields(before: Located, after: Located): object[] {
  const node = after.node;
  const prepared = [
    ...fieldChanges(before.node, node, fields),
    ...commentChanges(before.node, node),
  ];
  if (childrenReordered(before.node, node)) prepared.push({ field: 'childOrder', changed: true });
  if (before.node.parentTarget !== node.parentTarget)
    prepared.push({ operation: 'move-task', previousOwner: { trail: before.trail } });
  return prepared;
}
function treeFieldChanges(before: TaskTreeV1, after: TaskTreeV1): object[] {
  const beforeNodes = new Map(
    Array.from(ownedNodes(before), (entry) => [entry.node.target, entry]),
  );
  const result: object[] = [];
  for (const entry of ownedNodes(after)) {
    const { node, trail } = entry;
    const previous = beforeNodes.get(node.target);
    if (previous === undefined) {
      result.push({ operation: 'add-task', owner: { trail } });
      continue;
    }
    beforeNodes.delete(node.target);
    const prepared = editedNodeFields(previous, entry);
    if (prepared.length === 0) continue;
    if (node === after) result.push(...prepared);
    else result.push({ owner: { trail, ...sourceLocation(previous.node) }, prepared });
  }
  for (const { node, trail } of beforeNodes.values())
    result.push({ operation: 'remove-task', owner: { trail, ...sourceLocation(node) } });
  return result;
}
function taskSubject(plan: ContentPlanV1): Subject {
  const owner = rootOwner(plan);
  if (owner === undefined) return { kind: plan.kind };
  const prepared =
    plan.before !== null && plan.after !== null
      ? treeFieldChanges(plan.before, plan.after)
      : undefined;
  return { kind: plan.kind, owner, prepared };
}
function linkSubject(change: Extract<CommandChange, { kind: 'link' }>): Subject {
  const found = locate(change.plan.after, change.target);
  return {
    kind: change.kind,
    owner: found === undefined ? undefined : { trail: found.trail, path: change.sourcePath },
    prepared: { field: change.field },
  };
}
function describeChange(change: CommandChange, snapshot: CommandSessionSnapshot): Subject {
  switch (change.kind) {
    case 'task':
      return taskSubject(change.plan);
    case 'note':
      return { kind: change.kind, owner: { path: change.plan.path } };
    case 'status':
      return {
        kind: change.kind,
        owner: statusOwner(change, snapshot),
        prepared: { symbol: change.symbol },
      };
    case 'project-create':
      return {
        kind: change.kind,
        owner: { project: change.name },
        prepared: { fields: change.fields, status: change.statusId },
      };
    case 'project':
      return {
        kind: change.kind,
        owner: { project: change.before.name, path: change.before.path },
        prepared: { fields: change.fields, status: change.statusId },
      };
    case 'project-move':
      return {
        kind: change.kind,
        owner: { title: change.before.markdownTitle, ...sourceLocation(change.before) },
        prepared: { destination: change.destination.name, path: change.destination.path },
      };
    case 'link':
      return linkSubject(change);
    case 'cleanup':
      return { kind: change.kind, owner: rootOwner(change.plan) };
  }
}
function missingScope(): never {
  throw new CommandFailure(
    'WRITE_SCOPE',
    'The selected work has no verified owner or matching field change in this reviewed proposal. Keep the preview or select its exact current owner and fields.',
  );
}
type Part = CommandSaveScope['changes'][number];
function fieldSelection(
  part: Extract<Part, { kind: 'task-fields' }>,
  change: CommandChange,
): object {
  if (
    change.kind !== 'task' ||
    change.plan.target !== part.plan ||
    change.plan.revision !== part.expectedPlanRevision
  )
    return missingScope();
  const before = locate(change.plan.before, part.target),
    after = locate(change.plan.after, part.target);
  if (before === undefined || after === undefined) return missingScope();
  const prepared = fieldChanges(before.node, after.node, part.fields);
  if (prepared.length !== part.fields.length || prepared.length === 0) return missingScope();
  return {
    index: part.index,
    owner: {
      trail: after.trail,
      previousTrail: before.trail,
      ...sourceLocation(before.node),
    },
    fields: part.fields,
    prepared,
  };
}
export function commandWriteSubjects(
  snapshot: CommandSessionSnapshot,
  scope?: CommandSaveScope,
): {
  displayed: readonly unknown[];
  selections: readonly unknown[];
} {
  const displayed = snapshot.proposal.changes.map((change, index) => ({
    index,
    ...describeChange(change, snapshot),
  }));
  if (scope === undefined) return { displayed, selections: [] };
  if (scope.proposalRevision !== snapshot.proposal.revision || scope.changes.length === 0)
    return missingScope();
  const selections = scope.changes.map((part) => {
    const subject = displayed[part.index],
      change = snapshot.proposal.changes[part.index];
    if (subject?.owner === undefined || change === undefined) return missingScope();
    if (part.kind === 'task-fields') return fieldSelection(part, change);
    return { index: part.index, wholeChange: true, owner: subject.owner };
  });
  return { displayed, selections };
}
