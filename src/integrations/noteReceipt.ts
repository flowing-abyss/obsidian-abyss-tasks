import type {
  CommitNoteV1,
  EffectStateV1,
  NoteMutationReceiptV1,
  NoteMutationResultV1,
  RecoveryV1,
} from '../../api';
import type { NoteCommitOutcome } from '../notes/noteApi';
import { apiError } from './values';

function effects(outcome: NoteCommitOutcome): EffectStateV1 {
  if (outcome.noteEffects === 'unknown' || outcome.destinationEffects === 'unknown')
    return 'unknown';
  if (outcome.noteEffects === 'committed') return 'committed';
  return outcome.destinationEffects === 'committed' ? 'partial' : 'unchanged';
}
function recovery(effect: EffectStateV1, code: string | undefined): RecoveryV1 {
  if (effect === 'unknown' || effect === 'partial') return 'reconcile';
  return code === undefined ? 'none' : 'reread';
}
export function noteReceipt(
  context: {
    epoch: string;
    acceptedAt: number;
    input: CommitNoteV1;
    note?: NoteMutationReceiptV1['note'];
  },
  outcome: NoteCommitOutcome,
): NoteMutationResultV1 & { readonly receipt: NoteMutationReceiptV1 } {
  const effect = effects(outcome),
    recover = recovery(effect, outcome.code);
  const success = outcome.noteEffects === 'committed' || outcome.noop === true;
  let result: NoteMutationReceiptV1['outcome'] = 'failed';
  if (success) result = outcome.noop === true ? 'noop' : 'changed';
  const receipt: NoteMutationReceiptV1 = {
    providerEpoch: context.epoch,
    requestId: context.input.requestId,
    acceptedAt: context.acceptedAt,
    expiresAt: context.input.expiresAt,
    plan: context.input.plan,
    planRevision: context.input.expectedPlanRevision,
    outcome: result,
    effects: effect,
    recovery: recover,
    noteEffects: outcome.noteEffects,
    destinationEffects: outcome.destinationEffects,
    ...(context.note === undefined ? {} : { note: context.note }),
    warnings: [],
  };
  if (success) return { ok: true, receipt };
  return {
    ok: false,
    error: apiError('unavailable', outcome.code ?? 'WRITE_FAILED', 'Note write did not complete.'),
    effects: effect,
    recovery: recover,
    receipt,
  };
}
