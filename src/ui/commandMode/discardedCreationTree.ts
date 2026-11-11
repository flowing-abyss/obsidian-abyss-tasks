import type { TaskCreateTreeV1, TaskFieldV1, TaskInitialV1, TaskTreeV1 } from '../../../api';
import { discardedHistoryPreview } from '../../ai/commandHistoryMetadata';
import type { CommandSessionSnapshot } from '../../ai/commandTypes';
import type { StatusRegistry } from '../../status/StatusRegistry';

const untracked = { closedMs: 0, runningCount: 0, runningMsAtObservation: 0, brokenEntryCount: 0 };

function recorded<T>(field: TaskFieldV1<T> | undefined): T | undefined {
  return field?.type === 'set' ? field.value : undefined;
}

function planning(
  initial: TaskInitialV1,
): Pick<TaskTreeV1, 'dates' | 'time' | 'durationMinutes' | 'recurrence'> {
  const start = recorded(initial.start),
    scheduled = recorded(initial.scheduled),
    due = recorded(initial.due);
  const time = recorded(initial.time),
    durationMinutes = recorded(initial.durationMinutes),
    recurrence = recorded(initial.recurrence);
  return {
    dates: {
      ...(start === undefined ? {} : { start }),
      ...(scheduled === undefined ? {} : { scheduled }),
      ...(due === undefined ? {} : { due }),
    },
    ...(time === undefined ? {} : { time }),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(recurrence === undefined ? {} : { recurrence }),
  };
}

function taskFields(
  initial: TaskInitialV1,
  registry: StatusRegistry,
): Pick<
  TaskTreeV1,
  'statusSymbol' | 'status' | 'priority' | 'tags' | 'onCompletion' | 'onCompletionExplicit'
> {
  const statusSymbol = initial.statusSymbol ?? ' ';
  const removed = new Set(initial.tags?.remove);
  return {
    statusSymbol,
    status: registry.typeForSymbol(statusSymbol),
    priority: recorded(initial.priority) ?? 'D',
    tags: (initial.tags?.add ?? []).filter((tag) => !removed.has(tag)),
    onCompletion: recorded(initial.onCompletion) ?? 'keep',
    onCompletionExplicit: initial.onCompletion?.type === 'set',
  };
}

/** Old discarded creates kept their structured input but lost the rendered plan.
 * These keys belong only to the renderer. No vault targets or current creation defaults are resolved. */
export function discardedCreationTree(
  state: CommandSessionSnapshot,
  registry: StatusRegistry,
): TaskTreeV1 | undefined {
  const evidence = discardedHistoryPreview(state);
  if (
    evidence?.proposal.changes.length !== 0 ||
    evidence.preparations.length !== 1 ||
    state.journal.length !== 0 ||
    state.actual.length !== 0
  )
    return;
  const entry = evidence.preparations[0];
  if (entry?.kind !== 'task' || entry.input.kind !== 'create') return;

  function display(seed: TaskCreateTreeV1, target: string): TaskTreeV1 {
    const initial = seed.initial ?? {};
    const children = (seed.children ?? []).map((child, index) =>
      display(child, `${target}/${index}`),
    );
    const comments = (seed.comments ?? []).map(({ text }, index) => ({
      target: `${target}/comment/${index}`,
      parentTarget: target,
      text,
    }));
    return {
      target,
      revision: 'discarded',
      title: seed.markdownTitle,
      markdownTitle: seed.markdownTitle,
      ...planning(initial),
      ...taskFields(initial, registry),
      ...(seed.description === undefined ? {} : { description: seed.description }),
      children,
      comments,
      entries: [
        ...comments.map((comment) => ({ kind: 'comment' as const, target: comment.target })),
        ...children.map((child) => ({ kind: 'child' as const, target: child.target })),
      ],
      activity: { observedAtMs: 0, own: untracked, subtree: untracked },
      timeEntries: [],
      timeEntryCount: 0,
      childCount: children.length,
      commentCount: comments.length,
      complete: true,
      truncated: false,
    };
  }
  return display(entry.input.tree, 'discarded/root');
}
