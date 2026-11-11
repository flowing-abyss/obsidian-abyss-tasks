import type { RevisionPrecondition, TaskRepositoryResult } from '../application/TaskRepository';
import type {
  TaskStatusOccurrenceEffects,
  TaskStrictWriteContext,
} from '../application/TaskStatusMutationApi';
import type { TaskOccurrenceWitness } from '../domain/taskOccurrence';
import { taskNodeSourceLine, taskTreeNodes } from '../domain/taskSearchProjection';
import { sameTaskNodeRef, type TaskRef, type TaskSnapshot } from '../domain/types';
import type { TaskRootBlock } from './markdown/TaskBlockEditor';
import type { TaskLocator } from './markdown/TaskLocator';

type LocateResult = ReturnType<TaskLocator['locate']>;

interface PreparedRevisionContext {
  readonly prepared: RevisionPrecondition | undefined;
  readonly located: LocateResult;
  readonly authorityCurrent: TaskRef | undefined;
  readonly locateAuthorityCurrent: (ref: TaskRef) => LocateResult;
  readonly snapshot: (block: TaskRootBlock) => TaskSnapshot | undefined;
}

/** Writable identity evidence always precedes source-only location evidence. */
export function preparedRevisionResult(
  context: PreparedRevisionContext,
): TaskRepositoryResult | undefined {
  const { prepared, located, authorityCurrent } = context;
  if (prepared === undefined) return undefined;
  if (prepared.strictStatus !== undefined) return strictRevisionResult(context, prepared);
  if (
    authorityCurrent !== undefined &&
    authorityCurrent.revision !== prepared.baseRoot.ref.revision
  )
    return authorityResult(context, prepared, authorityCurrent);
  if (located.type === 'conflict') return { type: 'uncertain', target: prepared.baseTarget };
  if (located.type !== 'exact' || located.block.line === prepared.baseRoot.ref.line)
    return undefined;
  const current = context.snapshot(located.block);
  if (current === undefined) return { type: 'not-found', target: prepared.baseTarget };
  // Equal text at another address can be a sibling left behind by an intervening edit.
  // A byte-identical relocation must retain the consumed revision, not merely its source.
  if (current.ref.revision !== prepared.baseRoot.ref.revision)
    return { type: 'uncertain', target: prepared.baseTarget };
  return {
    type: 'rebased',
    previous: prepared.baseRoot,
    current,
    evidence: 'byte-identical-relocation',
  };
}

function strictRevisionResult(
  context: PreparedRevisionContext,
  prepared: RevisionPrecondition,
): TaskRepositoryResult | undefined {
  const { located, authorityCurrent } = context;
  if (
    located.type !== 'exact' ||
    located.block.line !== prepared.baseRoot.ref.line ||
    located.block.source !== prepared.baseRoot.source.originalBlock ||
    (authorityCurrent !== undefined && authorityCurrent.revision !== prepared.baseRoot.ref.revision)
  )
    return { type: 'strict-rejected', reason: 'revision-changed' };
  return undefined;
}

function authorityResult(
  context: PreparedRevisionContext,
  prepared: RevisionPrecondition,
  authorityCurrent: TaskRef,
): TaskRepositoryResult {
  const authoritative = context.locateAuthorityCurrent(authorityCurrent);
  const current =
    authoritative.type === 'exact' ? context.snapshot(authoritative.block) : undefined;
  if (
    current === undefined ||
    !sameTaskNodeRef({ type: 'task', ref: current.ref }, { type: 'task', ref: authorityCurrent })
  )
    return { type: 'uncertain', target: prepared.baseTarget };
  return {
    type: 'rebased',
    previous: prepared.baseRoot,
    current,
    evidence: 'authority-transition',
  };
}

/** Strict callers cannot consume visual, relocated, or rebased source evidence. */
export function strictStatusPrecondition(
  prepared: RevisionPrecondition,
  current: TaskStrictWriteContext,
  exact: boolean,
): TaskRepositoryResult | undefined {
  const guard = prepared.strictStatus;
  if (guard === undefined) return undefined;
  // The guard checks current policy before any source conflict can disclose a root.
  const reason = guard.check(current);
  if (reason !== undefined) return { type: 'strict-rejected', reason };
  if (prepared.baseTarget.type !== 'task' && prepared.baseTarget.type !== 'subtask')
    return { type: 'strict-rejected', reason: 'unsupported-precondition' };
  if (
    !exact ||
    !sameTaskNodeRef(prepared.baseTarget, current.target) ||
    current.root.source.originalBlock !== prepared.baseRoot.source.originalBlock ||
    !sameTaskNodeRef(
      { type: 'task', ref: current.root.ref },
      { type: 'task', ref: prepared.baseRoot.ref },
    ) ||
    ![...taskTreeNodes(current.root)].some((node) => sameTaskNodeRef(node.target, current.target))
  )
    return { type: 'strict-rejected', reason: 'revision-changed' };
  return undefined;
}

export function strictStatusEffects(
  current: TaskStrictWriteContext,
  witnesses: readonly TaskOccurrenceWitness[],
): TaskStatusOccurrenceEffects {
  const offset = taskNodeSourceLine(current.target) - current.root.ref.line;
  const witness = witnesses.find(
    (value) =>
      value.kind !== 'created' &&
      value.before.nodeOffset === offset &&
      value.before.rootRevision === current.root.ref.revision,
  );
  if (witness === undefined || witness.kind === 'created')
    throw new Error('Missing strict status witness');
  return {
    original: {
      before: witness.before,
      ...(witness.kind === 'continued' ? { after: witness.after } : {}),
    },
  };
}
