import { scriptedWriteReview } from '../support/scriptedWriteReview';
import { runCase } from './harness';

export function runScriptedCase(
  ...[test, runtime, flush, model]: Parameters<typeof runCase>
): ReturnType<typeof runCase> {
  return runCase(test, { ...runtime, reviewWrite: scriptedWriteReview }, flush, model);
}
