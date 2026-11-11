import type { WriteDecision, WriteReview } from '../../src/ai/commandWriteAuthorization';

/** Deterministic command tests script an approved write explicitly; live cases use the provider. */
export async function scriptedWriteReview(request: WriteReview): Promise<WriteDecision> {
  let effect: WriteDecision['effect'] = 'save-reviewed';
  if (request.proposedMode === 'save-then-plan') effect = 'save-first';
  if (request.proposedMode === 'immediate' && request.proposedScope === 'all')
    effect = 'save-after-edits';
  return {
    effect,
    scope: request.proposedScope,
    scopeMatches: true,
    authorization: request.saveInstruction,
  };
}
