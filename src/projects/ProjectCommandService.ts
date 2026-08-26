import { TFile, type App } from 'obsidian';
import type { ProjectStatus } from '../settings/types';
import {
  canonicalLifecycleTags,
  frontmatterTagValues,
  inspectProjectLifecycleFrontmatter,
  projectBoardMutationEnabled,
  toProjectPropertyString,
  type ProjectLifecycleObservation,
} from './lifecycle';
import { parseProjectDate, parseProjectRange } from './projectDates';
import type { ProjectDateValue, ProjectRange } from './types';

export type ProjectPropertyCommandResult =
  | { type: 'ok'; previousStatusId: string | null; nextStatusId: string }
  | { type: 'unchanged' }
  | { type: 'conflict'; currentStatusId: string | null }
  | { type: 'invalid'; field: 'status' | 'path' }
  | { type: 'io-error' };

export interface ProjectRangeObservation {
  readonly path: string;
  readonly start: unknown;
  readonly end: unknown;
}

export interface ProjectRangePatch {
  readonly start?: ProjectDateValue | null;
  readonly end?: ProjectDateValue | null;
}

export type ProjectRangeCommandResult =
  | { type: 'ok'; range: ProjectRange }
  | { type: 'conflict'; current: ProjectRange }
  | { type: 'invalid'; issue: NonNullable<ProjectRange['issue']> | 'path' }
  | { type: 'io-error' };

class AbortProjectCommand extends Error {
  constructor(readonly result: ProjectPropertyCommandResult) {
    super('Project command transaction aborted');
  }
}

class AbortProjectRangeCommand extends Error {
  constructor(readonly result: ProjectRangeCommandResult) {
    super('Project range command transaction aborted');
  }
}

function sameRawValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasOwnedCanonicalMarker(observed: ProjectLifecycleObservation): boolean {
  if (observed.ownedField.kind === 'frontmatter-tags') {
    return observed.ownedField.canonicalLifecycleTags.length > 0;
  }
  return toProjectPropertyString(observed.ownedField.rawValue) !== '';
}

function matchesObservedField(
  statuses: readonly ProjectStatus[],
  observed: ProjectLifecycleObservation,
  frontmatter: Readonly<Record<string, unknown>>,
): boolean {
  if (observed.ownedField.kind === 'property') {
    return sameRawValue(frontmatter[observed.ownedField.property], observed.ownedField.rawValue);
  }
  return sameStrings(
    canonicalLifecycleTags(statuses, frontmatter),
    observed.ownedField.canonicalLifecycleTags,
  );
}

function normalizedTag(tag: string): string {
  return tag.replace(/^#/u, '').toLowerCase();
}

function isManagedTag(tag: string, managedTags: ReadonlySet<string>): boolean {
  const normalized = normalizedTag(tag);
  return [...managedTags].some(
    (configured) => normalized === configured || normalized.startsWith(`${configured}/`),
  );
}

function applyStatus(
  frontmatter: Record<string, unknown>,
  statuses: readonly ProjectStatus[],
  target: ProjectStatus | null,
  observed: ProjectLifecycleObservation,
): void {
  for (const status of statuses) {
    if (status.match.kind !== 'property') continue;
    if (toProjectPropertyString(frontmatter[status.match.property]) === status.match.value) {
      delete frontmatter[status.match.property];
    }
  }

  const managedTags = new Set(
    statuses
      .filter((status) => status.match.kind === 'tag')
      .map((status) => normalizedTag((status.match as { tag: string }).tag)),
  );
  const tags = frontmatterTagValues(frontmatter['tags']).filter(
    (tag) => !isManagedTag(tag, managedTags),
  );

  if (observed.ownedField.kind === 'property') {
    delete frontmatter[observed.ownedField.property];
  }

  if (target?.match.kind === 'property') {
    frontmatter[target.match.property] = target.match.value;
  } else if (target?.match.kind === 'tag') {
    tags.push(target.match.tag.replace(/^#/u, ''));
  }

  if (tags.length > 0) frontmatter['tags'] = tags;
  else delete frontmatter['tags'];
}

export class ProjectCommandService {
  constructor(
    private readonly app: App,
    private readonly statuses: () => readonly ProjectStatus[],
  ) {}

  async setRange(
    observed: ProjectRangeObservation,
    patch: ProjectRangePatch,
  ): Promise<ProjectRangeCommandResult> {
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', issue: 'path' };
    const patchIssue = this.invalidRangePatchIssue(patch);
    if (patchIssue) return { type: 'invalid', issue: patchIssue };

    const nextStart = patch.start === undefined ? observed.start : (patch.start?.raw ?? undefined);
    const nextEnd = patch.end === undefined ? observed.end : (patch.end?.raw ?? undefined);
    const nextRange = parseProjectRange(nextStart, nextEnd);
    if (nextRange.issue) return { type: 'invalid', issue: nextRange.issue };

    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          if (
            !sameRawValue(frontmatter['start'], observed.start) ||
            !sameRawValue(frontmatter['end'], observed.end)
          ) {
            throw new AbortProjectRangeCommand({
              type: 'conflict',
              current: parseProjectRange(frontmatter['start'], frontmatter['end']),
            });
          }
          if (patch.start === null) delete frontmatter['start'];
          else if (patch.start !== undefined) frontmatter['start'] = patch.start.raw;
          if (patch.end === null) delete frontmatter['end'];
          else if (patch.end !== undefined) frontmatter['end'] = patch.end.raw;
        },
      );
      return { type: 'ok', range: nextRange };
    } catch (error) {
      if (error instanceof AbortProjectRangeCommand) return error.result;
      return { type: 'io-error' };
    }
  }

  private invalidRangePatchIssue(
    patch: ProjectRangePatch,
  ): 'invalid-start' | 'invalid-end' | undefined {
    if (!this.validDatePatchValue(patch.start)) return 'invalid-start';
    if (!this.validDatePatchValue(patch.end)) return 'invalid-end';
    return undefined;
  }

  private validDatePatchValue(value: ProjectDateValue | null | undefined): boolean {
    if (value === undefined || value === null) return true;
    const parsed = parseProjectDate(value.raw);
    return (
      parsed !== undefined &&
      parsed.precision === value.precision &&
      parsed.instantMs === value.instantMs &&
      parsed.offsetMinutes === value.offsetMinutes
    );
  }

  setStatus(
    observed: ProjectLifecycleObservation,
    statusId: string,
  ): Promise<ProjectPropertyCommandResult> {
    const statuses = this.statuses();
    const target = statuses.find((status) => status.id === statusId);
    if (!target || !projectBoardMutationEnabled(statuses)) {
      return Promise.resolve({ type: 'invalid', field: 'status' });
    }
    return this.changeStatus(observed, target, {
      type: 'ok',
      previousStatusId: observed.statusId,
      nextStatusId: statusId,
    });
  }

  undoStatus(
    observedNext: ProjectLifecycleObservation,
    previousStatusId: string | null,
  ): Promise<ProjectPropertyCommandResult> {
    const statuses = this.statuses();
    const target =
      previousStatusId === null
        ? null
        : (statuses.find((status) => status.id === previousStatusId) ?? undefined);
    if (target === undefined || !projectBoardMutationEnabled(statuses)) {
      return Promise.resolve({ type: 'invalid', field: 'status' });
    }
    if (observedNext.statusId === null) {
      return Promise.resolve({ type: 'invalid', field: 'status' });
    }
    return this.changeStatus(observedNext, target, {
      type: 'ok',
      previousStatusId,
      nextStatusId: observedNext.statusId,
    });
  }

  private async changeStatus(
    observed: ProjectLifecycleObservation,
    target: ProjectStatus | null,
    success: Extract<ProjectPropertyCommandResult, { type: 'ok' }>,
  ): Promise<ProjectPropertyCommandResult> {
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };
    const statuses = this.statuses();

    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          const current = inspectProjectLifecycleFrontmatter(statuses, frontmatter);
          const currentLifecycle = current.lifecycle;
          const observedWasLegacyBodyTag =
            observed.statusId !== null && !hasOwnedCanonicalMarker(observed);
          const lifecycleChanged = observedWasLegacyBodyTag
            ? currentLifecycle.statusId !== null || currentLifecycle.rawStatus !== null
            : currentLifecycle.statusId !== observed.statusId ||
              currentLifecycle.rawStatus !== observed.rawStatus;
          if (
            current.ambiguous ||
            !matchesObservedField(statuses, observed, frontmatter) ||
            lifecycleChanged
          ) {
            throw new AbortProjectCommand({
              type: 'conflict',
              currentStatusId: currentLifecycle.statusId,
            });
          }
          if (target !== null && target.id === currentLifecycle.statusId) {
            throw new AbortProjectCommand({ type: 'unchanged' });
          }
          applyStatus(frontmatter, statuses, target, observed);
        },
      );
      return success;
    } catch (error) {
      if (error instanceof AbortProjectCommand) return error.result;
      return { type: 'io-error' };
    }
  }
}
