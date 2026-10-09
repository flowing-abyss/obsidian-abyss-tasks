import { tagComparisonKey } from '../../markdown/tagSyntax';
import type { TaskNodeSnapshot } from './taskDependencies';
import {
  TaskSearchError,
  type TaskOrganizationRecord,
  type TaskSearchAddress,
} from './taskSearchTypes';
import { subtreeTotal } from './timeTracking';
import type { SubtaskSnapshot, TaskNodeRef, TaskSnapshot, TaskStatus } from './types';

export function taskSearchAddressKey(address: TaskSearchAddress): string {
  return JSON.stringify([address.epoch, address.version, address.rootId, address.childLines]);
}

export function rootTaskNodeSnapshot(root: TaskSnapshot): TaskNodeSnapshot {
  return { root, node: root, target: { type: 'task', ref: root.ref }, path: [] };
}

export function taskNodeSourceLine(target: TaskNodeRef): number {
  let line = 0;
  let current = target;
  while (current.type === 'subtask') {
    line += current.ref.relativeLine;
    current = current.ref.parent;
  }
  return line + current.ref.line;
}

/** The caller proves root authority; this walk never guesses or rebases a child. */
export function nodeAtSearchAddress(
  root: TaskSnapshot,
  address: TaskSearchAddress,
): TaskNodeSnapshot {
  const path: SubtaskSnapshot[] = [];
  let node: TaskSnapshot | SubtaskSnapshot = root;
  for (const line of address.childLines) {
    const matches: readonly SubtaskSnapshot[] = node.subtasks.filter(
      (child) => child.ref.relativeLine === line,
    );
    const child: SubtaskSnapshot | undefined = matches[0];
    if (matches.length !== 1 || child === undefined)
      throw new TaskSearchError('stale', 'Task changed');
    path.push(child);
    node = child;
  }
  const last = path[path.length - 1];
  return {
    root,
    path,
    node,
    target:
      last === undefined ? { type: 'task', ref: root.ref } : { type: 'subtask', ref: last.ref },
  };
}

/** A borrowed walk: no source/ref serialization, cloning or freezing. */
export function* taskTreeNodes(root: TaskSnapshot): Iterable<TaskNodeSnapshot> {
  yield rootTaskNodeSnapshot(root);
  function* children(
    parent: TaskSnapshot | SubtaskSnapshot,
    path: readonly SubtaskSnapshot[],
  ): Iterable<TaskNodeSnapshot> {
    for (const child of parent.subtasks) {
      const next = [...path, child];
      yield { root, path: next, node: child, target: { type: 'subtask', ref: child.ref } };
      yield* children(child, next);
    }
  }
  yield* children(root, []);
}

export function observedTaskTags(tags: Iterable<string>): readonly string[] {
  const representatives = new Map<string, string>();
  for (const tag of tags) {
    const key = tagComparisonKey(tag);
    const old = representatives.get(key);
    if (old === undefined || tag < old) representatives.set(key, tag);
  }
  return [...representatives.values()];
}

function* subtreeTags(node: TaskSnapshot | SubtaskSnapshot): Iterable<string> {
  yield* node.tags;
  for (const child of node.subtasks) yield* subtreeTags(child);
}

export function taskOrganizationRecord(
  task: TaskNodeSnapshot,
  address: TaskSearchAddress,
  status: TaskStatus,
): TaskOrganizationRecord {
  const { root, node, path } = task;
  return {
    address: { ...address, childLines: [...address.childLines] },
    depth: path.length,
    title: node.title,
    markdownTitle: node.markdownTitle,
    source: { filePath: root.source.filePath, line: taskNodeSourceLine(task.target) },
    status,
    statusSymbol: node.statusSymbol,
    priority: node.priority,
    planning: { ...node.planning },
    tags: [...node.tags],
    treeTags: observedTaskTags(subtreeTags(node)),
    tracked: subtreeTotal(node),
  };
}
