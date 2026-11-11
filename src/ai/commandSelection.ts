import type { ContentPlanV1, TasksApiV1 } from '../../api';
import { commandMessage } from './commandMessages';
import { canonicalCommandPlan, commandRead } from './commandReads';
import {
  CommandFailure,
  required,
  type CommandChange,
  type CommandJournalEntry,
  type CommandProposal,
  type CommandSaveScope,
} from './commandTypes';

export interface CommandSelectedWrite {
  readonly proposal: CommandProposal;
  readonly remainder: readonly CommandChange[];
  readonly partitions: ReadonlyMap<string, string>;
}
function dependency(): never {
  throw new CommandFailure(
    'SELECTION_DEPENDENCY',
    commandMessage('These changes depend on other pending work. Include that work in this save?'),
  );
}
function path(change: CommandChange): string | undefined {
  switch (change.kind) {
    case 'task':
    case 'cleanup':
    case 'link':
      return taskPath(change.plan);
    case 'note':
      return change.plan.path;
    case 'project':
      return change.before.path;
    case 'project-move':
      return change.before.source?.path;
    case 'project-create':
    case 'status':
      return undefined;
  }
}
function taskPath(plan: ContentPlanV1): string | undefined {
  return plan.destination?.path ?? plan.before?.source?.path;
}
function staleScope(): never {
  throw new CommandFailure(
    'STALE_SCOPE',
    commandMessage(
      'The selected changes no longer match this proposal. Review the current version.',
    ),
  );
}
function relatedToPlan(change: CommandChange, plan: string): boolean {
  if (change.kind === 'link' || change.kind === 'cleanup') return change.plan.target === plan;
  return change.kind === 'status' && change.plan === plan;
}
function checkFields(
  change: CommandChange,
  selection: Extract<CommandSaveScope['changes'][number], { kind: 'task-fields' }>,
  proposal: CommandProposal,
): void {
  if (
    change.kind !== 'task' ||
    change.plan.target !== selection.plan ||
    change.plan.revision !== selection.expectedPlanRevision
  )
    staleScope();
  if (change.plan.kind !== 'edit')
    throw new CommandFailure(
      'SELECTION_DEPENDENCY',
      commandMessage(
        'This task needs its unsaved parent. Save the parent too, or keep both pending?',
      ),
    );
  if (proposal.changes.some((other) => relatedToPlan(other, selection.plan))) dependency();
}
function dependencies(change: CommandChange): readonly string[] {
  if (change.kind === 'link') return [change.plan.target, change.notePlan];
  if (change.kind === 'cleanup') return [change.destinationPlan];
  if (change.kind === 'status' && change.plan !== undefined) return [change.plan];
  return [];
}
function checkDependencies(
  proposal: CommandProposal,
  selected: Pick<ReadonlySet<number>, 'has'>,
): void {
  proposal.changes.forEach((change, index) => {
    for (const plan of dependencies(change)) {
      const owner = proposal.changes.findIndex(
        (other) => (other.kind === 'task' || other.kind === 'note') && other.plan.target === plan,
      );
      if (selected.has(index) !== selected.has(owner)) dependency();
    }
  });
}
function checkIndependent(
  selected: readonly CommandChange[],
  remaining: readonly CommandChange[],
): void {
  if (
    (selected.some((change) => change.kind === 'status') &&
      remaining.some((change) => change.kind === 'task')) ||
    (selected.some((change) => change.kind === 'task') &&
      remaining.some((change) => change.kind === 'status'))
  )
    dependency();
  for (const change of selected) {
    const changedPath = path(change);
    if (changedPath === undefined) continue;
    if (
      remaining.some(
        (other) => changedPath === path(other) && (change.kind !== 'task' || other.kind !== 'task'),
      )
    )
      dependency();
  }
}
type FieldSelection = Extract<CommandSaveScope['changes'][number], { kind: 'task-fields' }>;
type GroupedSelections = Map<number, 'whole' | FieldSelection[]>;

function groupSelection(
  proposal: CommandProposal,
  groups: GroupedSelections,
  item: CommandSaveScope['changes'][number],
): void {
  const change = proposal.changes[item.index];
  if (!Number.isInteger(item.index) || change === undefined) staleScope();
  const previous = groups.get(item.index);
  if (item.kind === 'change') {
    if (previous !== undefined) staleScope();
    groups.set(item.index, 'whole');
    return;
  }
  checkFields(change, item, proposal);
  if (
    previous === 'whole' ||
    previous?.some((selection) => selection.target === item.target) === true
  )
    staleScope();
  const selections = previous ?? [];
  selections.push(item);
  groups.set(item.index, selections);
}

function preflight(proposal: CommandProposal, scope: CommandSaveScope): GroupedSelections {
  if (scope.proposalRevision !== proposal.revision || scope.changes.length === 0) staleScope();
  const selected: GroupedSelections = new Map();
  for (const item of scope.changes) groupSelection(proposal, selected, item);
  checkDependencies(proposal, selected);
  checkIndependent(
    proposal.changes.filter((_, index) => selected.has(index)),
    proposal.changes.filter((_, index) => !selected.has(index)),
  );
  return selected;
}
export async function selectCommandWrite(
  api: TasksApiV1,
  proposal: CommandProposal,
  scope: CommandSaveScope,
  context: { readonly signal: AbortSignal; readonly now: () => number },
): Promise<CommandSelectedWrite> {
  const { signal, now } = context;
  const groups = preflight(proposal, scope);
  const changes: CommandChange[] = [],
    partitions = new Map<string, string>();
  const remainder = proposal.changes.filter((_, index) => groups.get(index) !== 'whole');
  for (const [index, selections] of groups) {
    const change = required(proposal.changes[index]);
    if (selections === 'whole') {
      changes.push(change);
      continue;
    }
    const selection = required(selections[0]);
    const timing = { now, deadline: now() + 5000 };
    const page = await commandRead(
      api,
      () =>
        required(api.tasks.prepare)({
          kind: 'select-fields',
          plan: selection.plan,
          expectedPlanRevision: selection.expectedPlanRevision,
          selections: selections.map(({ target, fields }) => ({ target, fields })),
        }),
      signal,
      timing,
    );
    const plan = await canonicalCommandPlan(api, page, signal, timing);
    changes.push({ kind: 'task', plan });
    partitions.set(selection.plan, plan.target);
  }
  return { proposal: { ...proposal, changes, operations: changes.length }, remainder, partitions };
}
export async function rebaseCommandRemainder(
  api: TasksApiV1,
  selected: CommandSelectedWrite,
  journal: readonly CommandJournalEntry[],
  now: () => number,
): Promise<readonly CommandChange[]> {
  const result: CommandChange[] = [];
  for (const change of selected.remainder) {
    if (change.kind !== 'task') {
      result.push(change);
      continue;
    }
    const selectedPlan = selected.partitions.get(change.plan.target);
    const receipt = remainderReceipt(change.plan, selectedPlan, journal);
    if (selectedPlan !== undefined && receipt === undefined)
      throw new CommandFailure(
        'SELECTION_READBACK',
        commandMessage(
          'The selected write settled, but its remaining preview needs review. Do not repeat the write.',
        ),
      );
    const timing = { now, deadline: now() + 5000 },
      signal = new AbortController().signal;
    const page = await commandRead(
      api,
      () =>
        required(api.tasks.prepare)({
          kind: 'refresh',
          plan: change.plan.target,
          expectedPlanRevision: change.plan.revision,
          ...(receipt === undefined ? {} : { afterRequestId: receipt.request.requestId }),
        }),
      signal,
      timing,
    );
    const plan = await canonicalCommandPlan(api, page, signal, timing);
    if (plan.hasChanges !== false) result.push({ kind: 'task', plan });
  }
  return result;
}

function remainderReceipt(
  plan: ContentPlanV1,
  selectedPlan: string | undefined,
  journal: readonly CommandJournalEntry[],
): CommandJournalEntry | undefined {
  const settled = [...journal]
    .reverse()
    .filter((entry) => entry.state === 'settled' && entry.effects === 'committed');
  if (selectedPlan !== undefined)
    return settled.find(
      (entry) => entry.change.kind === 'task' && entry.change.plan.target === selectedPlan,
    );
  if (plan.kind !== 'create') return undefined;
  // Candidate proof only: the facade checks the receipt's sealed basis and current native anchor.
  return settled.find(
    (entry) =>
      entry.change.kind === 'task' &&
      entry.change.plan.kind === 'create' &&
      taskPath(entry.change.plan) === taskPath(plan),
  );
}
