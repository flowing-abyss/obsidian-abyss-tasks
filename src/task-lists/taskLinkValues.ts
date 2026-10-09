import { drainCollectionSteps, type CollectionSteps } from '../collectionSteps';
import { parseLinks } from '../markdown/links';
import { markdownLinkTargetParts } from '../markdown/linkTarget';
import { noteNameOfPath } from '../markdown/noteName';
import type { TaskSnapshot } from '../tasks';

export interface TaskLinkValue {
  readonly key: string;
  readonly label: string;
  readonly target: string;
}
export type TaskLinkResolver = (target: string, sourcePath: string) => string | undefined;
export type TaskLinkValues = ReadonlyMap<string, readonly TaskLinkValue[]>;

type LinkTask = Pick<TaskSnapshot, 'markdownTitle'> & {
  readonly source: Pick<TaskSnapshot['source'], 'filePath' | 'line'>;
};

/** Authored outgoing wiki notes only; the host supplies resolution, without a vault scan. */
export function outgoingTaskLinkValues(
  task: LinkTask,
  resolve: TaskLinkResolver,
): readonly TaskLinkValue[] {
  return drainCollectionSteps(outgoingTaskLinkValuesSteps(task, resolve));
}
export function* outgoingTaskLinkValuesSteps(
  task: LinkTask,
  resolve: TaskLinkResolver,
): CollectionSteps<readonly TaskLinkValue[]> {
  let links = parseLinks(task.markdownTitle);
  const values = new Map<string, TaskLinkValue>();
  let output: TaskLinkValue[] = [];
  try {
    yield 'atom';
    for (const link of links) {
      if (link.type !== 'wiki') {
        yield 'cheap';
        continue;
      }
      const { resolverTarget } = markdownLinkTargetParts(link);
      yield 'atom';
      const resolved = resolve(resolverTarget, task.source.filePath);
      yield 'atom';
      const target = resolved ?? resolverTarget;
      const key =
        resolved === undefined
          ? JSON.stringify(['unresolved', task.source.filePath, resolverTarget])
          : `note:${resolved}`;
      yield 'atom';
      if (!values.has(key)) {
        const label = noteNameOfPath(target);
        yield 'atom';
        values.set(key, { key, label, target });
      }
      yield 'cheap';
    }
    for (const value of values.values()) {
      output.push(value);
      yield 'cheap';
    }
    return output;
  } finally {
    links = [];
    values.clear();
    output = [];
  }
}
export function* collectTaskLinkValuesSteps(
  tasks: readonly LinkTask[],
  resolve: TaskLinkResolver,
): CollectionSteps<TaskLinkValues> {
  let values = new Map<string, readonly TaskLinkValue[]>();
  try {
    for (const task of tasks) {
      const links = yield* outgoingTaskLinkValuesSteps(task, resolve);
      if (links === undefined) throw new Error('Link collection ended without a result');
      values.set(`${task.source.filePath}:${task.source.line}`, links);
      yield 'cheap';
    }
    return values;
  } finally {
    values = new Map();
  }
}
