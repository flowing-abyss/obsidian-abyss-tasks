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
function editReference(
  node: TaskTreeV1,
  basis: { plan: string; expectedPlanRevision: string } | undefined,
): unknown {
  return basis === undefined
    ? { kind: 'edit', target: node.target, expectedRevision: node.revision }
    : { kind: 'append', ...basis };
}
/** Exact issued references, not aliases or an identity resolver. Never match model text by title. */
export function commandReferences(snapshot: CommandSessionSnapshot): unknown {
  const planned = plannedTargets(snapshot);
  const tasks = new Map<string, unknown>(),
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
    tasks.set(node.target, {
      kind: 'task',
      target: node.target,
      revision: node.revision,
      markdownTitle: node.markdownTitle.slice(0, 500),
      parentTarget: node.parentTarget,
      siblingOrdinal: ordinal,
      editBasis: editReference(node, basis),
    });
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
