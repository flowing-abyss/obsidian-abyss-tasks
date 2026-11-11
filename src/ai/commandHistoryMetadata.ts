import type { TaskTreeV1 } from '../../api';
import type { HistoricalCommandSession, HistoricalCommandSnapshot } from './commandRecovery';
import type { CommandChange, CommandFocus } from './commandTypes';

function meaningful(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
function contains(tree: TaskTreeV1, target: string): boolean {
  return tree.target === target || tree.children.some((child) => contains(child, target));
}
function focusedTitle(state: HistoricalCommandSnapshot, focus: CommandFocus): string | undefined {
  if (focus.kind === 'project')
    return state.entities.projects.find((entry) => entry.target === focus.target)?.name;
  if (focus.kind === 'note')
    return state.entities.notes.find((entry) => entry.note.target === focus.target)?.note.path;
  const roots = [
    ...state.actual,
    ...state.trees.flatMap((tree) => (tree.after === null ? [] : [tree.after])),
    ...state.entities.tasks.map((page) => page.tree),
  ];
  const candidates = roots.filter((tree) => contains(tree, focus.target));
  return outermost(candidates)?.markdownTitle;
}
function outermost(candidates: readonly TaskTreeV1[]): TaskTreeV1 | undefined {
  return (
    candidates.find(
      (tree) =>
        !candidates.some((other) => other.target !== tree.target && contains(other, tree.target)),
    ) ?? candidates[0]
  );
}
function changedTitle(change: CommandChange): string | undefined {
  if (change.kind === 'task')
    return change.plan.after?.markdownTitle ?? change.plan.before?.markdownTitle;
  if (change.kind === 'project-create') return change.name;
  if (change.kind === 'project') return change.before.name;
  if (change.kind === 'note') return change.plan.path;
  return undefined;
}
function entityTitle(state: HistoricalCommandSnapshot): string | undefined {
  return [
    ...state.focus.map((focus) => focusedTitle(state, focus)),
    ...state.proposal.changes.map(changedTitle),
    ...state.actual.map((tree) => tree.markdownTitle),
  ].find(meaningful);
}
function fallbackTitle(state: HistoricalCommandSnapshot): string {
  return (
    [
      ...state.exchanges.filter((entry) => entry.role === 'user').map((entry) => entry.text),
      state.input,
    ].find(meaningful) ?? 'Untitled session'
  );
}
function previousEntityTitle(previous: HistoricalCommandSession | undefined): string | undefined {
  if (previous === undefined) return undefined;
  // Old files have no provenance flag: only retained entity evidence establishes it.
  return previous.titleIsEntity === true ? previous.title : entityTitle(previous.snapshot);
}
/** Session display metadata never grants identity or write authority. */
export function commandSessionMetadata(
  state: HistoricalCommandSnapshot,
  previous?: HistoricalCommandSession,
): Pick<HistoricalCommandSession, 'title' | 'titleIsEntity'> {
  const title = entityTitle(state) ?? previousEntityTitle(previous);
  return title === undefined ? { title: fallbackTitle(state) } : { title, titleIsEntity: true };
}
export function hasCommandHistoryContent(state: HistoricalCommandSnapshot): boolean {
  const evidence = [
    state.exchanges,
    state.proposal.changes,
    state.actual,
    state.journal,
    state.focus,
    state.entities.tasks,
    state.entities.projects,
    state.entities.notes,
  ];
  return (
    state.input.trim().length > 0 ||
    evidence.some((items) => items.length > 0) ||
    state.activeQuestion !== null ||
    state.blocked ||
    state.pendingTransition != null
  );
}
/** Restore/status/context bookkeeping does not count as new authored activity. */
export function commandActivity(state: HistoricalCommandSnapshot): string {
  const meaningful = { ...state, proposal: { ...state.proposal } };
  Reflect.deleteProperty(meaningful.proposal, 'revision');
  for (const key of ['recovery', 'status', 'context', 'blocked'])
    Reflect.deleteProperty(meaningful, key);
  return JSON.stringify(meaningful);
}
