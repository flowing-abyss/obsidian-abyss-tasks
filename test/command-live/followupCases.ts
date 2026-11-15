import type { EvalCase } from './corpus';
import { noPendingTitleCancelCase } from './followupCancellationCase';
import { eastmereCleanupExpansionCase } from './followupExpansionCase';
import { proposedFocusGuidanceCases } from './followupFocusCases';

/** Prospective inputs registered after the frozen round-six corpus. */
export const followupCases: readonly EvalCase[] = [
  ...proposedFocusGuidanceCases,
  noPendingTitleCancelCase,
  eastmereCleanupExpansionCase,
];
