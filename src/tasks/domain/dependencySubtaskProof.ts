import type { CreateDependencySubtaskCommand } from './commands';
import { parseTaskLineSourceModel, type TaskLineSourceModel } from './taskLineSourceModel';
import type { SubtaskSnapshot, TaskSnapshot } from './types';

function submittedContent(model: TaskLineSourceModel, omitCreated: boolean): string {
  return JSON.stringify(
    model.spans
      .filter(
        (span) =>
          ![
            'prefix',
            'separator',
            'task-id',
            'depends-on',
            ...(omitCreated ? ['created'] : []),
          ].includes(span.kind),
      )
      .map((span) => [span.kind, model.original.slice(span.from, span.to).trim()]),
  );
}

/** Evidence for the one direct child appended by this command, including its submitted source. */
export function dependencySubtaskChild(
  before: TaskSnapshot | SubtaskSnapshot,
  after: TaskSnapshot | SubtaskSnapshot,
  command: Pick<CreateDependencySubtaskCommand, 'direction' | 'text'>,
): SubtaskSnapshot | undefined {
  const child = after.subtasks[before.subtasks.length];
  if (
    child === undefined ||
    after.subtasks.length !== before.subtasks.length + 1 ||
    child.subtasks.length > 0 ||
    child.comments.length > 0 ||
    child.description !== undefined
  )
    return undefined;
  return matchesSubmittedChild(child, command.text) &&
    matchesCreatedEdge(before, after, child, command.direction)
    ? child
    : undefined;
}

function matchesSubmittedChild(child: SubtaskSnapshot, text: string): boolean {
  const input = parseTaskLineSourceModel(`- [ ] ${text}`);
  const actual = parseTaskLineSourceModel(child.ref.originalBlock);
  return (
    input !== null &&
    actual?.statusSymbol === ' ' &&
    !/[\r\n🆔⛔]/u.test(text) &&
    submittedContent(input, false) ===
      submittedContent(actual, input.planning.created === undefined)
  );
}

function matchesCreatedEdge(
  before: TaskSnapshot | SubtaskSnapshot,
  after: TaskSnapshot | SubtaskSnapshot,
  child: SubtaskSnapshot,
  direction: CreateDependencySubtaskCommand['direction'],
): boolean {
  if (direction === 'blocks')
    return (
      after.dependencyId !== undefined &&
      (before.dependencyId === undefined || before.dependencyId === after.dependencyId) &&
      child.dependencyId === undefined &&
      JSON.stringify([child.dependsOn, after.dependsOn]) ===
        JSON.stringify([[after.dependencyId], before.dependsOn])
    );
  return (
    child.dependencyId !== undefined &&
    after.dependencyId === before.dependencyId &&
    JSON.stringify([child.dependsOn, after.dependsOn]) ===
      JSON.stringify([[], [...before.dependsOn, child.dependencyId]])
  );
}
