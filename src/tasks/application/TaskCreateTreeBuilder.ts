import type { TaskNodeRef, TaskSnapshot } from '../domain/types';
import { sameTaskNodeRef } from '../domain/types';
import { invalidTaskTarget } from '../domain/validation';
import type { TaskCreateTreeNode } from './TaskCreatePreparationApi';
import type { PreparedTaskEditCommand } from './TaskEditPreparationApi';
import type { TaskDraft, TaskEditCommand, TaskPreparedCreateRoot } from './TaskRepository';

type TreeCommand = PreparedTaskEditCommand | Extract<TaskEditCommand, { type: 'set-status' }>;
interface TreeBuilderPorts {
  draft(node: TaskCreateTreeNode, root: TaskSnapshot): TaskDraft | undefined;
  normalize(command: TreeCommand, root: TaskSnapshot): TaskEditCommand | undefined;
}
function nodes(root: TaskSnapshot): TaskNodeRef[] {
  const result: TaskNodeRef[] = [{ type: 'task', ref: root.ref }];
  const visit = (children: TaskSnapshot['subtasks']): void => {
    for (const child of children) {
      result.push({ type: 'subtask', ref: child.ref });
      visit(child.subtasks);
    }
  };
  visit(root.subtasks);
  return result;
}

/** Tracks every seed owner only through the canonical editor's physical correspondence. */
class TreeBuilder {
  private readonly owners = new Map<TaskCreateTreeNode, TaskNodeRef>();
  constructor(
    private prepared: TaskPreparedCreateRoot,
    private readonly ports: TreeBuilderPorts,
  ) {}

  build(tree: TaskCreateTreeNode): TaskPreparedCreateRoot {
    if (this.prepared.type === 'ready') {
      this.owners.set(tree, { type: 'task', ref: this.prepared.after.ref });
      this.visit(tree);
    }
    return this.prepared;
  }

  private invalid(): false {
    this.prepared = { type: 'invalid', result: invalidTaskTarget('tree') };
    return false;
  }

  private accept(next: TaskPreparedCreateRoot): boolean {
    this.prepared = next;
    if (next.type !== 'ready') return false;
    const correspondence = next.continuations;
    for (const [seed, ref] of this.owners) {
      const after = correspondence.find((entry) => sameTaskNodeRef(entry.before, ref))?.after;
      if (after === undefined) return this.invalid();
      this.owners.set(seed, after);
    }
    return true;
  }

  private append(command: TreeCommand): boolean {
    if (this.prepared.type !== 'ready') return false;
    const normalized = this.ports.normalize(command, this.prepared.after);
    return normalized === undefined
      ? this.invalid()
      : this.accept(this.prepared.append(normalized));
  }

  private visit(node: TaskCreateTreeNode): void {
    const target = this.owners.get(node);
    if (target === undefined || this.prepared.type !== 'ready') return;
    if (
      node.description !== undefined &&
      !this.append({ type: 'set-description', target, text: node.description })
    )
      return;
    if (!this.comments(node)) return;
    for (const child of node.children ?? []) {
      if (!this.addChild(node, child)) return;
      this.visit(child);
    }
  }

  private comments(node: TaskCreateTreeNode): boolean {
    for (const comment of node.comments ?? []) {
      const parent = this.owners.get(node);
      if (parent === undefined || !this.append({ type: 'add-comment', parent, text: comment.text }))
        return false;
    }
    return true;
  }

  private addChild(parentSeed: TaskCreateTreeNode, child: TaskCreateTreeNode): boolean {
    const parent = this.owners.get(parentSeed);
    if (parent === undefined || this.prepared.type !== 'ready') return false;
    const draft = this.ports.draft(child, this.prepared.after);
    if (draft?.today === undefined) return this.invalid();
    const added = this.prepared.append({
      type: 'add-subtask',
      parent,
      text: draft.markdownBody,
      today: draft.today,
      addCreatedDate: draft.addCreatedDate ?? false,
    });
    if (!this.accept(added) || added.type !== 'ready') return false;
    return this.initializeChild(child, draft, added);
  }

  private initializeChild(
    child: TaskCreateTreeNode,
    draft: TaskDraft,
    added: Extract<TaskPreparedCreateRoot, { type: 'ready' }>,
  ): boolean {
    const fresh = nodes(added.after).filter(
      (ref) =>
        !added.continuations.some(
          (entry) => entry.after !== undefined && sameTaskNodeRef(entry.after, ref),
        ),
    );
    if (fresh.length !== 1 || fresh[0]?.type !== 'subtask') return this.invalid();
    this.owners.set(child, fresh[0]);
    const patch = { ...draft.initial };
    delete patch.status;
    return (
      this.append({ type: 'patch', target: fresh[0], patch }) && this.initializeStatus(child, draft)
    );
  }

  private initializeStatus(child: TaskCreateTreeNode, draft: TaskDraft): boolean {
    const status = draft.initial?.status;
    if (status === undefined) return true;
    const target = this.owners.get(child);
    if (target === undefined || draft.today === undefined) return this.invalid();
    return this.append({
      type: 'set-status',
      target,
      symbol: status.symbol,
      stamp: draft.today,
      addCompletionDate: draft.addCompletionDate ?? false,
    });
  }
}

export function buildPreparedCreateTree(
  initial: TaskPreparedCreateRoot,
  tree: TaskCreateTreeNode,
  ports: TreeBuilderPorts,
): TaskPreparedCreateRoot {
  return new TreeBuilder(initial, ports).build(tree);
}
