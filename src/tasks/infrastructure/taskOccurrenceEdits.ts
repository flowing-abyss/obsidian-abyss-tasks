import { recurrenceOwnedSubtree } from '../domain/recurrenceIteration';
import type { TaskOccurrenceAddress, TaskOccurrenceWitness } from '../domain/taskOccurrence';
import type { RootRevisionOverride } from '../domain/taskReconciliation';
import type { TaskRef } from '../domain/types';
import type { TaskNodeLineMapping } from './markdown/TaskBlockEditor';

function address(ref: TaskRef, offset: number): TaskOccurrenceAddress {
  return {
    filePath: ref.filePath,
    rootRevision: ref.revision,
    rootLine: ref.line,
    nodeOffset: offset,
  };
}

/** Only editor-proven physical line transforms may supply this map. */
export function editedOccurrenceWitnesses(
  before: TaskRef,
  after: TaskRef,
  map: readonly TaskNodeLineMapping[],
): readonly TaskOccurrenceWitness[] {
  return map.map((value) =>
    value.afterOffset === undefined
      ? { kind: 'removed', before: address(before, value.beforeOffset) }
      : {
          kind: 'continued',
          before: address(before, value.beforeOffset),
          after: address(after, value.afterOffset),
        },
  );
}

export function removedSubtreeNodeMap(
  source: string,
  selectedOffset: number,
): readonly TaskNodeLineMapping[] {
  const ownership = recurrenceOwnedSubtree(source, selectedOffset);
  if (ownership === undefined) return [];
  return (recurrenceOwnedSubtree(source, 0)?.taskLines ?? []).map((beforeOffset) => {
    if (beforeOffset < ownership.fromLine) return { beforeOffset, afterOffset: beforeOffset };
    if (beforeOffset > ownership.toLine)
      return {
        beforeOffset,
        afterOffset: beforeOffset - (ownership.toLine - ownership.fromLine + 1),
      };
    return { beforeOffset };
  });
}

interface RecurrenceWitnessInput {
  readonly before: TaskRef;
  readonly source: string;
  readonly selectedOffset: number;
  readonly roots: readonly RootRevisionOverride[];
  readonly active: { readonly rootLine: number; readonly targetRelativeLine: number };
  readonly completed: { readonly rootLine: number; readonly targetRelativeLine: number };
  readonly deletesCompleted: boolean;
}

/** Coordinates come from the actual subtree replacement; roots already have minted revisions. */
export function recurrenceOccurrenceWitnesses(
  input: RecurrenceWitnessInput,
): readonly TaskOccurrenceWitness[] {
  const ownership = recurrenceOwnedSubtree(input.source, input.selectedOffset);
  const activeRoot = input.roots.find((root) => root.line === input.active.rootLine);
  const completedRoot = input.roots.find((root) => root.line === input.completed.rootLine);
  if (
    ownership === undefined ||
    activeRoot === undefined ||
    (!input.deletesCompleted && completedRoot === undefined)
  )
    return [];
  const activeSubtree = recurrenceOwnedSubtree(activeRoot.source, input.active.targetRelativeLine);
  if (activeSubtree === undefined) return [];
  const rootRef = (root: RootRevisionOverride): TaskRef => ({
    filePath: input.before.filePath,
    line: root.line,
    revision: root.revision,
  });
  const context: RecurrencePredecessorContext = {
    from: ownership.fromLine,
    to: ownership.toLine,
    active: rootRef(activeRoot),
    completed: completedRoot === undefined ? undefined : rootRef(completedRoot),
    delta: activeRoot.source.split(/\r?\n/u).length - input.source.split(/\r?\n/u).length,
  };
  const witnesses = (recurrenceOwnedSubtree(input.source, 0)?.taskLines ?? []).flatMap((offset) =>
    recurrencePredecessor(input, offset, context),
  );
  for (const offset of activeSubtree.taskLines)
    witnesses.push({
      kind: 'created',
      reason: 'recurrence',
      after: address(rootRef(activeRoot), offset),
    });
  return witnesses;
}

interface RecurrencePredecessorContext {
  readonly from: number;
  readonly to: number;
  readonly delta: number;
  readonly active: TaskRef;
  readonly completed: TaskRef | undefined;
}

function recurrencePredecessor(
  input: RecurrenceWitnessInput,
  offset: number,
  context: RecurrencePredecessorContext,
): readonly TaskOccurrenceWitness[] {
  const before = address(input.before, offset);
  if (offset < context.from || offset > context.to)
    return [
      {
        kind: 'continued',
        before,
        after: address(context.active, offset > context.to ? offset + context.delta : offset),
      },
    ];
  if (input.deletesCompleted) return [{ kind: 'removed', before }];
  if (context.completed === undefined) return [];
  return [
    {
      kind: 'continued',
      before,
      after: address(context.completed, input.completed.targetRelativeLine + offset - context.from),
    },
  ];
}
