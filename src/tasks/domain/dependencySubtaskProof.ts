import type { CreateDependencySubtaskCommand } from './commands';
import { parseTaskLineSourceModel, type TaskLineSourceModel } from './taskLineSourceModel';
import { applyTaskCreationTagPolicy, type TaskInboxTagPolicy } from './taskTags';
import type { SubtaskSnapshot, TaskSnapshot } from './types';

export interface TaskCreationProofPolicy {
  readonly taskPrefix: string;
  readonly inbox: TaskInboxTagPolicy;
  readonly addCreatedDate: boolean;
}

function submittedContent(
  model: TaskLineSourceModel,
  omitCreated: boolean,
  linked: boolean,
): string {
  return JSON.stringify(
    model.spans
      .filter(
        (span) =>
          ![
            'prefix',
            'separator',
            ...(linked ? ['task-id', 'depends-on'] : []),
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
  policy?: TaskCreationProofPolicy,
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
  return matchesSubmittedChild(child, command.text, policy, true) &&
    matchesCreatedEdge(before, after, child, command.direction)
    ? child
    : undefined;
}

export function matchesSubmittedChild(
  child: SubtaskSnapshot,
  text: string,
  policy?: TaskCreationProofPolicy,
  linked = false,
): boolean {
  const prepared =
    policy === undefined
      ? text
      : applyTaskCreationTagPolicy(policy.taskPrefix, text, policy.inbox).markdown;
  const input = parseTaskLineSourceModel(`- [ ] ${prepared}`);
  const actual = parseTaskLineSourceModel(child.ref.originalBlock);
  if (input === null || actual === null) return false;
  return (
    validSubmittedLine(input, actual, text, linked) &&
    submittedContent(input, false, linked) ===
      submittedContent(
        actual,
        input.planning.created === undefined && (policy?.addCreatedDate ?? true),
        linked,
      )
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

function validSubmittedLine(
  input: TaskLineSourceModel,
  actual: TaskLineSourceModel,
  text: string,
  linked: boolean,
): boolean {
  return (
    input.statusSymbol === ' ' &&
    actual.statusSymbol === ' ' &&
    !/[\r\n]/u.test(text) &&
    (!linked || !/[🆔⛔]/u.test(text))
  );
}
