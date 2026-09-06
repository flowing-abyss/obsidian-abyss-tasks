import type { TaskCommand } from './commands';
import type {
  SubtaskRef,
  SubtaskSnapshot,
  TaskMutationTarget,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from './types';

type RootlessCommand = Extract<
  TaskCommand,
  { type: 'create' | 'add-dependency' | 'remove-dependency' | 'restore-dependency' }
>;
export type RootedTaskCommand = Exclude<TaskCommand, RootlessCommand>;

function isRootless(command: TaskCommand): command is RootlessCommand {
  return (
    command.type === 'create' ||
    command.type === 'add-dependency' ||
    command.type === 'remove-dependency' ||
    command.type === 'restore-dependency'
  );
}

export function taskNodeRootRef(target: TaskMutationTarget): TaskRef {
  let node = target;
  while (node.type !== 'task') node = node.ref.parent;
  return node.ref;
}

export function taskNodeChain(target: TaskNodeRef): readonly SubtaskRef[] {
  const chain: SubtaskRef[] = [];
  let node = target;
  while (node.type === 'subtask') {
    chain.unshift(node.ref);
    node = node.ref.parent;
  }
  return chain;
}

/** Source-path lookup only; the caller supplies root authority and any required uniqueness proof. */
export function taskNodeAtSourcePath(
  root: TaskSnapshot,
  target: TaskNodeRef,
): TaskSnapshot | SubtaskSnapshot | undefined {
  let current: TaskSnapshot | SubtaskSnapshot = root;
  for (const ref of taskNodeChain(target)) {
    const child: SubtaskSnapshot | undefined = current.subtasks.find(
      (candidate) =>
        candidate.ref.relativeLine === ref.relativeLine &&
        candidate.ref.originalBlock === ref.originalBlock,
    );
    if (child === undefined) return undefined;
    current = child;
  }
  return current;
}

export function rebaseTaskNode<T extends TaskMutationTarget>(target: T, root: TaskRef): T {
  return (
    target.type === 'task'
      ? { type: 'task', ref: root }
      : {
          ...target,
          ref: { ...target.ref, parent: rebaseTaskNode(target.ref.parent, root) },
        }
  ) as T;
}

/** A comment or deleted subtask remains the mutation target, even though its root owns the write. */
export function taskCommandMutationTarget(command: RootedTaskCommand): TaskMutationTarget;
export function taskCommandMutationTarget(command: TaskCommand): TaskMutationTarget | undefined;
export function taskCommandMutationTarget(command: TaskCommand): TaskMutationTarget | undefined {
  if (isRootless(command)) return undefined;
  if ('ref' in command) return { type: 'task', ref: command.ref };
  if ('current' in command) return command.current;
  if ('parent' in command) return command.parent;
  if ('subtask' in command) return { type: 'subtask', ref: command.subtask };
  if ('comment' in command) return { type: 'comment', ref: command.comment };
  if ('target' in command)
    return command.type === 'edit-link' ? linkTarget(command.target) : command.target;
  return unreachable(command);
}

function linkTarget(
  target: Extract<TaskCommand, { type: 'edit-link' }>['target'],
): TaskMutationTarget {
  return target.type === 'comment' ? target : target.target;
}

export function taskCommandRootRef(command: RootedTaskCommand): TaskRef;
export function taskCommandRootRef(command: TaskCommand): TaskRef | undefined;
export function taskCommandRootRef(command: TaskCommand): TaskRef | undefined {
  const target = taskCommandMutationTarget(command);
  return target === undefined ? undefined : taskNodeRootRef(target);
}

/** Rebases references only; callers must separately prove whether a retry is permitted. */
export function rebaseTaskCommand<T extends RootedTaskCommand>(command: T, root: TaskRef): T {
  return rebaseRootedCommand(command, root) as T;
}

function rebaseRootedCommand(command: RootedTaskCommand, root: TaskRef): RootedTaskCommand {
  if ('ref' in command) return { ...command, ref: root };
  if ('current' in command) return { ...command, current: rebaseTaskNode(command.current, root) };
  if ('parent' in command) return { ...command, parent: rebaseTaskNode(command.parent, root) };
  if ('subtask' in command) {
    const subtask = rebaseTaskNode({ type: 'subtask', ref: command.subtask }, root).ref;
    return command.type === 'reorder-subtask'
      ? {
          ...command,
          subtask,
          target: rebaseTaskNode({ type: 'subtask', ref: command.target }, root).ref,
        }
      : { ...command, subtask };
  }
  if ('comment' in command)
    return {
      ...command,
      comment: rebaseTaskNode({ type: 'comment', ref: command.comment }, root).ref,
    };
  if ('target' in command) return rebaseTargetCommand(command, root);
  return unreachable(command);
}

function rebaseTargetCommand(
  command: Exclude<Extract<RootedTaskCommand, { target: unknown }>, { type: 'reorder-subtask' }>,
  root: TaskRef,
): RootedTaskCommand {
  if (command.type === 'edit-link') {
    const target = command.target;
    return {
      ...command,
      target:
        target.type === 'comment'
          ? rebaseTaskNode(target, root)
          : { ...target, target: rebaseTaskNode(target.target, root) },
    };
  }
  return { ...command, target: rebaseTaskNode(command.target, root) } as RootedTaskCommand;
}

function unreachable(_command: never): never {
  throw new Error('Task edit command has no root reference');
}
