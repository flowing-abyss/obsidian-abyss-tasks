import type { RevisionPrecondition, TaskRepositoryResult } from '../application/TaskRepository';
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
