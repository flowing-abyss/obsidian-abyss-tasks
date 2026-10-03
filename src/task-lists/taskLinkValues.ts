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

/** Authored outgoing wiki notes only; the host supplies resolution, without a vault scan. */
export function outgoingTaskLinkValues(
  task: Pick<TaskSnapshot, 'markdownTitle' | 'source'>,
  resolve: TaskLinkResolver,
): readonly TaskLinkValue[] {
  const values = new Map<string, TaskLinkValue>();
  for (const link of parseLinks(task.markdownTitle)) {
    if (link.type !== 'wiki') continue;
    const { resolverTarget } = markdownLinkTargetParts(link);
    const resolved = resolve(resolverTarget, task.source.filePath);
    const target = resolved ?? resolverTarget;
    const key =
      resolved === undefined
        ? JSON.stringify(['unresolved', task.source.filePath, resolverTarget])
        : `note:${resolved}`;
    if (!values.has(key)) values.set(key, { key, label: noteNameOfPath(target), target });
  }
  return [...values.values()];
}
