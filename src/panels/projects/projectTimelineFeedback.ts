import { Notice } from 'obsidian';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectEditResult } from '../../projects/projectEdits';

export function reportProjectTimelineRangeFailure(failure: unknown): void {
  const label = 'Could not update project Timeline dates';
  if (
    typeof failure === 'object' &&
    failure !== null &&
    'failed' in failure &&
    Array.isArray((failure as ProjectEditResult).failed)
  ) {
    const result = failure as ProjectEditResult;
    if (result.failed.length === 0) return;
    const first = result.failed[0];
    const detail = first === undefined ? '' : `: ${first.message}`;
    const message = `${result.applied.length} updated; ${result.failed.length} failed${detail}`;
    console.error(`[abyss-tasks] ${label}`, { result });
    new Notice(`${label}: ${message}`);
    return;
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  if (typeof failure === 'string' || isProjectEditValidationError(failure)) {
    new Notice(message);
    return;
  }
  console.error(`[abyss-tasks] ${label}`, { cause: failure });
  new Notice(`${label}: ${message}`);
}
