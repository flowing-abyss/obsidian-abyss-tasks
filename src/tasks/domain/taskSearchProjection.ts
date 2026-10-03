import { tagComparisonKey } from '../../markdown/tagSyntax';
import type { TaskNodeSnapshot } from './taskDependencies';
import {
  TaskSearchError,
  type TaskOrganizationRecord,
  type TaskSearchAddress,
} from './taskSearchTypes';
import { subtreeTotal } from './timeTracking';
import type { SubtaskSnapshot, TaskSnapshot, TaskStatus } from './types';

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
  yield { root, path: [], node: root, target: { type: 'task', ref: root.ref } };
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

export function taskOrganizationRecord(
  root: TaskSnapshot,
  address: TaskSearchAddress,
  status: TaskStatus,
): TaskOrganizationRecord {
  return {
    address: { ...address, childLines: [...address.childLines] },
    title: root.title,
    markdownTitle: root.markdownTitle,
    source: { filePath: root.source.filePath, line: root.source.line },
    status,
    statusSymbol: root.statusSymbol,
    priority: root.priority,
    planning: { ...root.planning },
    tags: [...root.tags],
    treeTags: observedTaskTags([...taskTreeNodes(root)].flatMap(({ node }) => node.tags)),
    tracked: subtreeTotal(root),
  };
}
