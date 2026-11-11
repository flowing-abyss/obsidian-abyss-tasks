import type { TaskTreeV1 } from '../../api';
import { commandPlanViews } from './commandSchemas';
import type { CommandSessionSnapshot } from './commandTypes';

function plannedTargets(snapshot: CommandSessionSnapshot): Set<string> {
  const planned = new Set<string>();
  const collect = (node: TaskTreeV1 | null): void => {
    if (node === null) return;
    planned.add(node.target);
    node.children.forEach(collect);
  };
  for (const change of snapshot.proposal.changes) {
    if (change.kind !== 'task') continue;
    for (const view of commandPlanViews(change.plan)) {
      collect(view.before);
      collect(view.after);
    }
  }
  return planned;
}
type PlanBasis = { plan: string; expectedPlanRevision: string };
type EditBasis =
  { kind: 'edit'; target: string; expectedRevision: string } | ({ kind: 'append' } & PlanBasis);
interface TaskReference {
  kind: 'task';
  target: string;
  revision: string;
  markdownTitle: string;
  parentTarget?: string;
  siblingOrdinal?: number;
  editBasis: EditBasis;
}
function editReference(node: TaskTreeV1, basis: PlanBasis | undefined): EditBasis {
  return basis === undefined
    ? { kind: 'edit', target: node.target, expectedRevision: node.revision }
    : { kind: 'append', ...basis };
}
function taskReference(
  node: TaskTreeV1,
  basis: { plan: string; expectedPlanRevision: string } | undefined,
  ordinal: number | undefined,
): TaskReference {
  return {
    kind: 'task',
    target: node.target,
    revision: node.revision,
    markdownTitle: node.markdownTitle.slice(0, 500),
    ...(node.parentTarget === undefined ? {} : { parentTarget: node.parentTarget }),
    ...(ordinal === undefined ? {} : { siblingOrdinal: ordinal }),
    editBasis: editReference(node, basis),
  };
}
function lastFieldChange(
  snapshot: CommandSessionSnapshot,
  tasks: ReadonlyMap<string, TaskReference>,
): Record<string, unknown> {
  const history = snapshot.preparations ?? [];
  const last = history[history.length - 1];
  if (
    last?.kind !== 'task' ||
    last.input.kind !== 'append' ||
    last.input.operation.type !== 'patch'
  )
    return {};
  const { operation, plan } = last.input;
  const row = tasks.get(operation.target);
  if (row === undefined || !('plan' in row.editBasis) || row.editBasis.plan !== plan) return {};
  return {
    lastPreparedFieldChange: {
      kind: 'task',
      target: row.target,
      markdownTitle: row.markdownTitle,
      ...(row.siblingOrdinal === undefined ? {} : { siblingOrdinal: row.siblingOrdinal }),
      fields: Object.keys(operation.patch),
    },
  };
}
/** Exact issued references, not aliases or an identity resolver. Never match model text by title. */
export function commandReferences(snapshot: CommandSessionSnapshot): unknown {
  const planned = plannedTargets(snapshot);
  const tasks = new Map<string, TaskReference>(),
    comments = new Map<string, unknown>(),
    revisions = new Map<string, string>();
  const visit = (
    node: TaskTreeV1,
    basis?: { plan: string; expectedPlanRevision: string },
    ordinal?: number,
  ): void => {
    if (basis === undefined && planned.has(node.target)) return;
    if (tasks.size >= 80 && !tasks.has(node.target)) return;
    const revision = revisions.get(node.target);
    if (revision !== undefined && revision !== node.revision) return;
    revisions.set(node.target, node.revision);
    tasks.set(node.target, taskReference(node, basis, ordinal));
    for (const comment of node.comments) {
      if (comments.size >= 80 && !comments.has(comment.target)) break;
      comments.set(comment.target, {
        kind: 'comment',
        target: comment.target,
        ownerTarget: node.target,
        text: comment.text.slice(0, 500),
        rewriteOperation: { type: 'update-comment', target: comment.target },
        editBasis: editReference(node, basis),
      });
    }
    node.children.forEach((child, index) => {
      visit(child, basis, index + 1);
    });
  };
  for (const change of snapshot.proposal.changes) {
    if (change.kind !== 'task') continue;
    for (const view of commandPlanViews(change.plan))
      if (view.after !== null)
        visit(view.after, { plan: change.plan.target, expectedPlanRevision: change.plan.revision });
  }
  for (const page of [...snapshot.entities.tasks].reverse()) visit(page.tree);
  for (const tree of snapshot.actual) visit(tree);
  return {
    taskReferences: [...tasks.values()],
    ...lastFieldChange(snapshot, tasks),
    commentReferences: [...comments.values()],
    projectReferences: snapshot.entities.projects.map((project) => ({
      kind: 'project',
      target: project.target,
      revision: project.revision,
      name: project.name,
      path: project.path,
    })),
    noteReferences: snapshot.entities.notes.map((page) => ({
      kind: 'note',
      target: page.note.target,
      revision: page.note.revision,
      path: page.note.path,
    })),
    bounded: true,
  };
}
