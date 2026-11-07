import type {
  ApplyTaskContentV1,
  ContentCommitTaskContinuityV1,
  EffectStateV1,
  RecoveryV1,
  TaskContentMutationResultV1,
  TaskContentReceiptV1,
} from '../../api';
import {
  taskNodeSourceLine,
  taskTreeNodes,
  type TaskCommandResult,
  type TaskNodeRef,
  type TaskSnapshot,
} from '../tasks';
import type { TaskApiContext } from './TaskApiProvider';
import type { TaskIdentityReservation } from './TaskIdentityRegistry';
import { readNodeFor } from './taskTreeApi';
import { freezeValue } from './values';
type Correspondence = ContentCommitTaskContinuityV1['correspondence'];
type Complete = Extract<Correspondence, { state: 'complete' }>;
export interface ContentReceiptBasis {
  readonly target: string;
  readonly revision: string;
  readonly originalTarget?: string | undefined;
  readonly after: TaskSnapshot | null;
}
export interface ContentCommitEvidence {
  readonly result: TaskCommandResult;
  readonly coverage: ReadonlyMap<string, TaskNodeRef>;
  readonly reservation: TaskIdentityReservation;
  readonly destinationEffects?: 'unchanged' | 'committed' | 'unknown';
}
export function unknownContentReceipt(
  epoch: string,
  basis: ContentReceiptBasis,
  input: ApplyTaskContentV1,
  acceptedAt: number,
): TaskContentReceiptV1 {
  return {
    providerEpoch: epoch,
    requestId: input.requestId,
    acceptedAt,
    expiresAt: input.expiresAt,
    plan: basis.target,
    planRevision: basis.revision,
    outcome: 'failed',
    effects: 'unknown',
    recovery: 'reconcile',
    snapshots: 'unavailable',
    contentContinuity: {
      plan: basis.target,
      planRevision: basis.revision,
      correspondence: { state: 'unavailable' },
    },
    warnings: [],
  };
}
function effects(e: ContentCommitEvidence): EffectStateV1 {
  if (e.result.type === 'ok') return e.result.changed ? 'committed' : 'unchanged';
  if (e.result.type === 'io-error' && e.result.contentState === 'unknown') return 'unknown';
  if (e.destinationEffects === 'committed') return 'partial';
  return e.destinationEffects === 'unknown' ? 'unknown' : 'unchanged';
}
function pairs(
  context: TaskApiContext,
  roots: { accepted: TaskSnapshot; after: TaskSnapshot },
  coverage: ReadonlyMap<string, TaskNodeRef>,
  semantics: number,
): Complete['tasks'] | undefined {
  const nodes = new Map(
    [...taskTreeNodes(roots.accepted)].map((n) => [
      taskNodeSourceLine(n.target) - roots.accepted.ref.line,
      n,
    ]),
  );
  const result: Array<Complete['tasks'][number]> = [];
  for (const [preparedTarget, ref] of coverage) {
    const node = nodes.get(taskNodeSourceLine(ref) - roots.after.ref.line);
    if (node === undefined) return undefined;
    const projected = context.identities.project(readNodeFor(context, node), semantics);
    if (!projected.ok) return undefined;
    result.push({
      preparedTarget,
      committedTarget: projected.value.target,
      committedRevision: projected.value.revision,
    });
  }
  return result;
}
function inserted(
  context: TaskApiContext,
  roots: { accepted: TaskSnapshot; after: TaskSnapshot },
  e: ContentCommitEvidence,
): Correspondence {
  const { accepted, after } = roots,
    address = {
      filePath: accepted.ref.filePath,
      rootRevision: accepted.ref.revision,
      rootLine: accepted.ref.line,
      nodeOffset: 0,
    };
  const read = context.reads.node(address);
  if (read.type !== 'ok' || !context.reads.canDisclose(address)) return { state: 'unavailable' };
  // Equal full canonical blocks prove every relative physical node, including equal-title siblings.
  if (
    accepted.source.originalBlock !== after.source.originalBlock ||
    read.value.value.root.source.originalBlock !== after.source.originalBlock
  )
    return { state: 'unavailable' };
  const claimed = context.identities.claimNext(e.reservation, {
    state: 'retained',
    origin: address,
    current: address,
  });
  const root = context.identities.project(read.value, read.observation.semanticsRevision);
  if (!root.ok || root.value.target !== claimed.target) return { state: 'unavailable' };
  const tasks = pairs(context, roots, e.coverage, read.observation.semanticsRevision);
  if (tasks === undefined) return { state: 'unavailable' };
  return {
    state: 'complete',
    coverage: 'issued-plan-tasks',
    root: { target: root.value.target, revision: root.value.revision },
    tasks,
  };
}
function correspondence(
  context: TaskApiContext,
  basis: ContentReceiptBasis,
  e: ContentCommitEvidence,
): Correspondence {
  if (e.result.type !== 'ok') return { state: 'unavailable' };
  if (e.result.outcome.type === 'deleted' && basis.after === null)
    return { state: 'complete', coverage: 'issued-plan-tasks', root: null, tasks: [] };
  if (e.result.outcome.type !== 'task' || basis.after === null) return { state: 'unavailable' };
  return inserted(context, { accepted: e.result.outcome.task, after: basis.after }, e);
}
function recovery(effect: EffectStateV1, map: Correspondence): RecoveryV1 {
  if (effect === 'unknown' || effect === 'partial') return 'reconcile';
  return map.state === 'complete' ? 'none' : 'reread';
}
function original(
  context: TaskApiContext,
  target?: string,
): Pick<TaskContentReceiptV1, 'original'> {
  if (target === undefined) return {};
  const found = context.identities.lookup(target);
  return { original: { target, state: found.ok ? found.value.state : 'unproven' } };
}
export function contentReceipt(
  context: TaskApiContext,
  base: TaskContentReceiptV1,
  basis: ContentReceiptBasis,
  e: ContentCommitEvidence,
): TaskContentReceiptV1 {
  const map = correspondence(context, basis, e),
    effect = effects(e);
  let outcome: TaskContentReceiptV1['outcome'] = 'failed';
  if (e.result.type === 'ok') outcome = e.result.changed ? 'changed' : 'noop';
  const task = map.state === 'complete' ? map.root : null;
  return {
    ...base,
    outcome,
    effects: effect,
    recovery: recovery(effect, map),
    snapshots: map.state === 'complete' ? 'complete' : 'unavailable',
    ...(task === null ? {} : { task }),
    ...original(context, basis.originalTarget),
    ...(e.destinationEffects === undefined ? {} : { destinationEffects: e.destinationEffects }),
    contentContinuity: { plan: basis.target, planRevision: basis.revision, correspondence: map },
  };
}

function disclosedTarget(context: TaskApiContext, target: string): boolean {
  try {
    const found = context.identities.lookup(target);
    return (
      found.ok && found.value.state === 'retained' && context.reads.canDisclose(found.value.address)
    );
  } catch {
    return false;
  }
}
function disclosedCorrespondence(context: TaskApiContext, map: Correspondence): boolean {
  if (map.state !== 'complete') return true;
  if (map.root !== null && !disclosedTarget(context, map.root.target)) return false;
  return map.tasks.every((pair) => disclosedTarget(context, pair.committedTarget));
}
function disclosedOriginal(
  context: TaskApiContext,
  original: TaskContentReceiptV1['original'],
  live: boolean,
): TaskContentReceiptV1['original'] {
  if (original === undefined || !live) return undefined;
  if (!disclosedTarget(context, original.target)) return undefined;
  return original;
}
function disclosedReceiptTask(
  context: TaskApiContext,
  task: TaskContentReceiptV1['task'],
  live: boolean,
): TaskContentReceiptV1['task'] {
  return task !== undefined && live && disclosedTarget(context, task.target) ? task : undefined;
}
function removedDisclosure(before: object | undefined, after: object | undefined): boolean {
  return before !== undefined && after === undefined;
}
function disclosureWarnings(
  receipt: TaskContentReceiptV1,
  redacted: boolean,
): TaskContentReceiptV1['warnings'] {
  const warnings = [...receipt.warnings];
  if (redacted && !warnings.some((value) => value.code === 'RESULT_SNAPSHOT_REDACTED'))
    warnings.push({
      code: 'RESULT_SNAPSHOT_REDACTED',
      message: 'Current content receipt disclosure is unavailable.',
    });
  return warnings;
}
function redactedContentReceipt(
  receipt: TaskContentReceiptV1,
  context: TaskApiContext,
  live: boolean,
): TaskContentReceiptV1 {
  const { task: originalTask, original: originalRole, ...rest } = receipt;
  const task = disclosedReceiptTask(context, originalTask, live),
    original = disclosedOriginal(context, originalRole, live);
  const mapAllowed =
    live && disclosedCorrespondence(context, receipt.contentContinuity.correspondence);
  const redacted =
    !mapAllowed ||
    removedDisclosure(originalTask, task) ||
    (originalRole?.state === 'retained' && removedDisclosure(originalRole, original));
  return {
    ...rest,
    ...(task === undefined ? {} : { task }),
    ...(original === undefined ? {} : { original }),
    snapshots: redacted ? 'redacted' : receipt.snapshots,
    contentContinuity: {
      ...receipt.contentContinuity,
      correspondence: mapAllowed ? receipt.contentContinuity.correspondence : { state: 'redacted' },
    },
    warnings: disclosureWarnings(receipt, redacted),
  };
}
/** Current delivery permissions never mutate the request owner's historical effect receipt. */
export function redactContentMutationResult(
  result: TaskContentMutationResultV1,
  context: TaskApiContext,
  live: boolean,
): TaskContentMutationResultV1 {
  const copied = structuredClone(result);
  if (copied.receipt === undefined) return freezeValue(copied);
  return freezeValue({ ...copied, receipt: redactedContentReceipt(copied.receipt, context, live) });
}
