import type { TaskDtoV1 } from '../../api';
import type { TaskReadNode } from '../tasks';
import { freezeValue } from './values';

/** Copy the external allowlist; inward root revisions and authored blocks stay inward. */
export function toTaskDto(
  node: TaskReadNode,
  identity: { target: string; revision: string; parentTarget?: string },
): TaskDtoV1 {
  const value = node.value.node;
  return freezeValue({
    target: identity.target,
    revision: identity.revision,
    title: value.title,
    markdownTitle: value.markdownTitle,
    status: node.status,
    statusSymbol: value.statusSymbol,
    priority: value.priority,
    dates: { ...node.dates },
    ...(node.time === undefined ? {} : { time: node.time }),
    ...(node.durationMinutes === undefined ? {} : { durationMinutes: node.durationMinutes }),
    tags: [...value.tags],
    ...(value.recurrence === undefined ? {} : { recurrence: value.recurrence }),
    onCompletion: value.onCompletion,
    onCompletionExplicit: value.onCompletionExplicit,
    ...(value.dependencyId === undefined ? {} : { authoredId: value.dependencyId }),
    source: { path: node.address.filePath, line: node.line },
    ...(identity.parentTarget === undefined ? {} : { parentTarget: identity.parentTarget }),
  });
}
