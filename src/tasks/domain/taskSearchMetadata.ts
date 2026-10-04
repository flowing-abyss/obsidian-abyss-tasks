import type { TaskNodeSnapshot } from './taskDependencies';
import { formatDurationMinutes } from './valueObjects';

/** Same scalar retrieval values for documents and detached-field evidence. */
export function taskSearchMetadata(
  node: TaskNodeSnapshot['node'],
): ReadonlyArray<readonly [string, string]> {
  const values: Array<readonly [string, string | undefined]> = [
    ['priority', node.priority],
    ...(['created', 'start', 'scheduled', 'due', 'completion', 'cancelled', 'time'] as const).map(
      (key) => [key, node.planning[key]] as const,
    ),
    ['recurrence', node.recurrence],
    ['dependencyId', node.dependencyId],
    ...node.dependsOn.map((value) => ['dependsOn', value] as const),
  ];
  if ('source' in node && node.planning.duration !== undefined) {
    values.push(
      ['duration', String(node.planning.duration)],
      ['duration', formatDurationMinutes(node.planning.duration)],
    );
  }
  return values.flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const]));
}
