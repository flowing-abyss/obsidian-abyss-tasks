import type { ContentPlanV1, TaskCommentV1, TaskTreeV1 } from '../../../api';
import type { CommandPreparation, CommandSessionSnapshot } from '../../ai/commandTypes';
import type { TaskDisplayField } from '../taskTreeDisplay';
type PreparedOperation = Extract<
  Extract<CommandPreparation, { kind: 'task' }>['input'],
  { kind: 'append' }
>['operation'];
interface CommentField {
  readonly comment: TaskCommentV1;
  readonly key: string;
  readonly accepted: boolean;
  readonly original?: string | undefined;
  readonly previousMarkdown?: string | undefined;
  readonly change?: TaskDisplayField['change'];
}
interface RemovedComment {
  readonly field: CommentField;
  readonly index: number;
}
export interface CommandNodeFields {
  readonly tree: TaskTreeV1;
  readonly comments: readonly CommentField[];
  readonly removed: readonly RemovedComment[];
  readonly planRevision?: string;
  readonly iteration: number;
  readonly comparison?: TaskTreeV1 | undefined;
  readonly added: boolean;
}
function sequence(comments: readonly TaskCommentV1[]): string {
  return JSON.stringify(comments.map((comment) => [comment.text, comment.timestamp]));
}
function operation(
  state: CommandSessionSnapshot,
  plan: ContentPlanV1 | undefined,
  previous: CommandNodeFields | undefined,
): PreparedOperation | undefined {
  const preparation = state.preparations?.[state.preparations.length - 1];
  if (preparation?.kind !== 'task' || plan === undefined || previous === undefined)
    return undefined;
  const input = preparation.input;
  if (input.kind === 'edit') return matchesInitialEdit(input, plan) ? input.operation : undefined;
  if (input.kind === 'append')
    return matchesAppend(input, plan, previous) ? input.operation : undefined;
  return undefined;
}
function matchesInitialEdit(
  input: Extract<CommandPreparation, { kind: 'task' }>['input'] & { kind: 'edit' },
  plan: ContentPlanV1,
): boolean {
  return input.target === plan.before?.target && input.expectedRevision === plan.before.revision;
}

function matchesAppend(
  input: Extract<CommandPreparation, { kind: 'task' }>['input'] & { kind: 'append' },
  plan: ContentPlanV1,
  previous: CommandNodeFields,
): boolean {
  return input.plan === plan.target && input.expectedPlanRevision === previous.planRevision;
}
function matchingEdit(
  previous: CommandNodeFields,
  tree: TaskTreeV1,
  edit: PreparedOperation,
): number | undefined {
  if (edit.type !== 'update-comment' && edit.type !== 'remove-comment') return undefined;
  const index = previous.tree.comments.findIndex((comment) => comment.target === edit.target);
  if (index < 0) return undefined;
  const expected = [...previous.tree.comments];
  if (edit.type === 'remove-comment') expected.splice(index, 1);
  else {
    const old = expected[index];
    if (old === undefined) return undefined;
    expected[index] = { ...old, text: edit.text };
  }
  return sequence(expected) === sequence(tree.comments) ? index : undefined;
}
function appendedComment(
  previous: CommandNodeFields,
  tree: TaskTreeV1,
  edit: PreparedOperation,
): boolean {
  return (
    edit.type === 'add-comment' &&
    edit.target === tree.target &&
    tree.comments.length === previous.comments.length + 1 &&
    sequence(tree.comments.slice(0, -1)) === sequence(previous.tree.comments)
  );
}
function continueComments(
  previous: CommandNodeFields,
  tree: TaskTreeV1,
  edit: PreparedOperation | undefined,
  committed: boolean,
): readonly CommentField[] | undefined {
  if (!tree.complete || !previous.tree.complete) return undefined;
  if (
    sequence(previous.tree.comments) === sequence(tree.comments) &&
    (committed || edit !== undefined)
  )
    return previous.comments;
  if (edit === undefined) return undefined;
  if (appendedComment(previous, tree, edit)) return previous.comments;
  const index = matchingEdit(previous, tree, edit);
  if (index === undefined) return undefined;
  const result = [...previous.comments];
  if (edit.type === 'remove-comment') result.splice(index, 1);
  return result;
}
interface FieldInput {
  readonly key: string;
  readonly tree: TaskTreeV1;
  readonly before: TaskTreeV1 | undefined;
  readonly previous: CommandNodeFields | undefined;
  readonly state: CommandSessionSnapshot;
  readonly plan: ContentPlanV1 | undefined;
  readonly committed: boolean;
}
export function commandNodeFields(input: FieldInput): CommandNodeFields {
  const { tree, before, state, plan, committed } = input;
  const previous = initialFields(input) ?? input.previous;
  const resolved = { ...input, previous };
  const edit = operation(state, plan, previous);
  const continuation =
    previous === undefined ? undefined : continueComments(previous, tree, edit, committed);
  const accepted = before !== undefined && sequence(before.comments) === sequence(tree.comments);
  const changedIndex =
    previous === undefined || edit === undefined ? undefined : matchingEdit(previous, tree, edit);
  const context: FieldContext = { input: resolved, edit, continuation, accepted, changedIndex };
  const comments = tree.comments.map((comment, index) => buildComment(comment, index, context));
  const removed = removedComments(context);
  return {
    tree,
    comments,
    removed,
    iteration: iteration(state),
    added: before === undefined && plan !== undefined && (previous === undefined || previous.added),
    comparison: comparison(resolved),
    ...(plan === undefined ? {} : { planRevision: plan.revision }),
  };
}

interface FieldContext {
  readonly input: FieldInput;
  readonly edit: PreparedOperation | undefined;
  readonly continuation: readonly CommentField[] | undefined;
  readonly accepted: boolean;
  readonly original?: string | undefined;
  readonly previousMarkdown?: string | undefined;
  readonly changedIndex: number | undefined;
}
function commentChange(
  index: number,
  retained: CommentField | undefined,
  context: FieldContext,
): TaskDisplayField['change'] {
  const { input } = context;
  if (input.plan === undefined) return undefined;
  if (input.state.presentation?.changes === 'cumulative') return cumulativeChange(retained);
  if (input.previous?.planRevision === input.plan.revision)
    return retainedIterationChange(input, retained);
  return newCommentChange(index, retained, context);
}
function newCommentChange(
  index: number,
  retained: CommentField | undefined,
  context: FieldContext,
): TaskDisplayField['change'] {
  const { edit, changedIndex, continuation, input } = context;
  if (edit?.type === 'update-comment' && changedIndex === index) return 'changed';
  if (edit?.type === 'add-comment' && continuation !== undefined && retained === undefined)
    return 'added';
  return initialAddition(input) ? 'added' : undefined;
}
function initialAddition(input: FieldInput): boolean {
  return input.previous === undefined && input.before === undefined && input.plan !== undefined;
}
function buildComment(comment: TaskCommentV1, index: number, context: FieldContext): CommentField {
  const exact = context.input.previous?.comments.find(
    (field) => field.comment.target === comment.target,
  );
  const retained = context.continuation?.[index] ?? exact;
  const change = commentChange(index, retained, context);
  return {
    comment,
    key: retained?.key ?? `${context.input.key}:comment:${comment.target}`,
    accepted: retained?.accepted ?? context.accepted,
    original: originalText(retained, comment, context.accepted),
    previousMarkdown: previousCommentText(retained, change, context),
    ...(change === undefined ? {} : { change }),
  };
}
function originalText(
  retained: CommentField | undefined,
  comment: TaskCommentV1,
  accepted: boolean,
): string | undefined {
  if (retained?.original !== undefined) return retained.original;
  return accepted ? comment.text : undefined;
}
function retainedIterationChange(
  input: FieldInput,
  retained: CommentField | undefined,
): TaskDisplayField['change'] {
  return input.previous?.iteration === iteration(input.state) ? retained?.change : undefined;
}
function removedComments(context: FieldContext): readonly RemovedComment[] {
  const { input, edit, changedIndex } = context;
  if (input.plan === undefined) return [];
  const removed = [...(input.previous?.removed ?? [])];
  if (edit?.type !== 'remove-comment' || changedIndex === undefined || input.previous === undefined)
    return removed;
  const field = input.previous.comments[changedIndex];
  const index = input.previous.tree.entries.findIndex((entry) => entry.target === edit.target);
  if (field?.accepted === true) removed.push({ field: { ...field, change: 'removed' }, index });
  return removed;
}
function iteration(state: CommandSessionSnapshot): number {
  return state.exchanges.filter((exchange) => exchange.role === 'user').length;
}
function initialFields(input: FieldInput): CommandNodeFields | undefined {
  const before = input.before;
  if (
    input.previous?.planRevision !== undefined ||
    before === undefined ||
    !before.complete ||
    !initialEdit(input)
  )
    return undefined;
  const source = input.state.entities.tasks
    .map((page) => page.tree)
    .find(
      (tree) =>
        tree.target === before.target &&
        tree.revision === before.revision &&
        tree.complete &&
        sequence(tree.comments) === sequence(before.comments),
    );
  if (source === undefined) return undefined;
  return {
    tree: source,
    comments: source.comments.map((comment, index) => ({
      comment,
      key: input.previous?.comments[index]?.key ?? `${input.key}:comment:${comment.target}`,
      accepted: true,
      original: comment.text,
    })),
    removed: [],
    added: false,
    iteration: iteration(input.state),
  };
}
function initialEdit(input: FieldInput): boolean {
  const preparation = input.state.preparations?.[input.state.preparations.length - 1];
  if (preparation?.kind !== 'task' || preparation.input.kind !== 'edit') return false;
  const request = preparation.input,
    root = input.plan?.before;
  return request.target === root?.target && request.expectedRevision === root.revision;
}
function comparison(input: FieldInput): TaskTreeV1 | undefined {
  if (input.state.presentation?.changes === 'cumulative') return input.before;
  if (input.previous?.planRevision === input.plan?.revision && input.previous !== undefined) {
    return input.previous.iteration === iteration(input.state)
      ? input.previous.comparison
      : input.previous.tree;
  }
  return input.previous?.tree ?? input.before;
}
function cumulativeChange(field: CommentField | undefined): TaskDisplayField['change'] {
  if (field === undefined) return undefined;
  if (!field.accepted) return 'added';
  return field.original !== undefined && field.original !== field.comment.text
    ? 'changed'
    : undefined;
}
function previousCommentText(
  field: CommentField | undefined,
  change: TaskDisplayField['change'],
  context: FieldContext,
): string | undefined {
  if (change !== 'changed') return undefined;
  if (context.input.state.presentation?.changes === 'cumulative') return field?.original;
  return context.input.previous?.planRevision === context.input.plan?.revision
    ? field?.previousMarkdown
    : field?.comment.text;
}
