import { TFile, type App } from 'obsidian';
import type { ProjectStatus } from '../settings/types';
import type { Clock } from '../tasks/domain/clock';
import {
  formatNewCommentTimestamp,
  parseCommentTimestampBody,
} from '../tasks/domain/commentTimestamp';
import {
  canonicalLifecycleTags,
  frontmatterTagValues,
  inspectProjectLifecycleFrontmatter,
  projectBoardMutationEnabled,
  toProjectPropertyString,
  type ProjectLifecycleObservation,
} from './lifecycle';
import { parseProjectDate, parseProjectRange } from './projectDates';
import type {
  Project,
  ProjectComment,
  ProjectDateValue,
  ProjectMetadataObservation,
  ProjectPriority,
  ProjectRange,
} from './types';

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

export interface ProjectFieldObservation {
  readonly path: string;
  readonly value: unknown;
}

export interface ProjectMetadataCommandObservation extends ProjectMetadataObservation {
  readonly path: string;
}

export type ProjectMetadataCommandResult =
  | {
      readonly type: 'ok';
      readonly priority?: ProjectPriority | null;
      readonly description?: string | null;
      readonly comment?: ProjectComment;
    }
  | { readonly type: 'unchanged' }
  | { readonly type: 'conflict'; readonly current: unknown }
  | { readonly type: 'unsupported'; readonly field: 'comments' | 'description' }
  | { readonly type: 'invalid'; readonly field: 'priority' | 'description' | 'comments' | 'path' }
  | { readonly type: 'io-error' };

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

class AbortProjectMetadataCommand extends Error {
  constructor(readonly result: ProjectMetadataCommandResult) {
    super('Project metadata command transaction aborted');
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

function isProjectPriority(value: string): value is ProjectPriority {
  return /^[A-F]$/u.test(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAppendableCommentList(value: unknown): value is readonly string[] {
  return value === undefined || isStringList(value);
}

function projectedComment(raw: string): ProjectComment {
  const parsed = parseCommentTimestampBody(raw);
  if (parsed.kind === 'timestamp') {
    return { kind: 'timestamp', raw, timestamp: parsed.timestamp, text: parsed.text };
  }
  return parsed.kind === 'undated'
    ? { kind: 'undated', raw, text: parsed.text }
    : { kind: 'malformed', raw };
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
    private readonly clock?: Clock,
  ) {}

  observeMetadata(
    project: Pick<Project, 'path' | 'frontmatter' | 'observed'>,
  ): ProjectMetadataCommandObservation {
    const observed = project.observed ?? {
      priority: project.frontmatter['priority'],
      description: project.frontmatter['description'],
      comments: project.frontmatter['comments'],
      start: project.frontmatter['start'],
      end: project.frontmatter['end'],
    };
    return { path: project.path, ...observed };
  }

  observeComments(
    project: Pick<Project, 'path' | 'frontmatter' | 'observed'>,
  ): ProjectFieldObservation {
    return {
      path: project.path,
      value: project.observed?.comments ?? project.frontmatter['comments'],
    };
  }

  observeRange(project: Pick<Project, 'path' | 'frontmatter'>): ProjectRangeObservation {
    return {
      path: project.path,
      start: project.frontmatter['start'],
      end: project.frontmatter['end'],
    };
  }

  async setRange(
    observed: ProjectRangeObservation,
    patch: ProjectRangePatch,
  ): Promise<ProjectRangeCommandResult> {
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', issue: 'path' };
    const patchIssue = this.invalidRangePatchIssue(patch);
    if (patchIssue) return { type: 'invalid', issue: patchIssue };
    const plannedRange = parseProjectRange(
      patch.start === undefined ? observed.start : (patch.start?.raw ?? undefined),
      patch.end === undefined ? observed.end : (patch.end?.raw ?? undefined),
    );
    if (plannedRange.issue) return { type: 'invalid', issue: plannedRange.issue };

    try {
      let nextRange: ProjectRange | undefined;
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          if (patch.start !== undefined && !sameRawValue(frontmatter['start'], observed.start)) {
            throw new AbortProjectRangeCommand({
              type: 'conflict',
              current: parseProjectRange(frontmatter['start'], frontmatter['end']),
            });
          }
          if (patch.end !== undefined && !sameRawValue(frontmatter['end'], observed.end)) {
            throw new AbortProjectRangeCommand({
              type: 'conflict',
              current: parseProjectRange(frontmatter['start'], frontmatter['end']),
            });
          }
          const nextStart =
            patch.start === undefined ? frontmatter['start'] : (patch.start?.raw ?? undefined);
          const nextEnd =
            patch.end === undefined ? frontmatter['end'] : (patch.end?.raw ?? undefined);
          nextRange = parseProjectRange(nextStart, nextEnd);
          if (nextRange.issue) {
            throw new AbortProjectRangeCommand({ type: 'invalid', issue: nextRange.issue });
          }
          if (patch.start === null) delete frontmatter['start'];
          else if (patch.start !== undefined) frontmatter['start'] = patch.start.raw;
          if (patch.end === null) delete frontmatter['end'];
          else if (patch.end !== undefined) frontmatter['end'] = patch.end.raw;
        },
      );
      return { type: 'ok', range: nextRange! };
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

  async setPriority(
    observed: ProjectFieldObservation,
    priority: ProjectPriority | null,
  ): Promise<ProjectMetadataCommandResult> {
    if (priority !== null && !isProjectPriority(priority))
      return { type: 'invalid', field: 'priority' };
    return this.setScalar(observed, 'priority', priority, (value) => ({
      type: 'ok',
      priority: value as ProjectPriority | null,
    }));
  }

  async setDescription(
    observed: ProjectFieldObservation,
    description: string | null,
  ): Promise<ProjectMetadataCommandResult> {
    if (observed.value !== undefined && typeof observed.value !== 'string') {
      return { type: 'unsupported', field: 'description' };
    }
    if (description !== null && description.includes('\r'))
      return { type: 'invalid', field: 'description' };
    return this.setScalar(observed, 'description', description, (value) => ({
      type: 'ok',
      description: value,
    }));
  }

  async appendComment(
    observed: ProjectFieldObservation,
    body: string,
  ): Promise<ProjectMetadataCommandResult> {
    if (!isAppendableCommentList(observed.value)) return { type: 'unsupported', field: 'comments' };
    const normalizedBody = body.replace(/\r\n/gu, '\n');
    if (normalizedBody.includes('\r') || !this.clock) return { type: 'invalid', field: 'comments' };
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };
    const raw = `${formatNewCommentTimestamp(this.clock.read())}: ${normalizedBody}`;
    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          const current = frontmatter['comments'];
          if (!isAppendableCommentList(current)) {
            throw new AbortProjectMetadataCommand({ type: 'unsupported', field: 'comments' });
          }
          if (!sameRawValue(current, observed.value)) {
            throw new AbortProjectMetadataCommand({ type: 'conflict', current });
          }
          frontmatter['comments'] = [...(current ?? []), raw];
        },
      );
      return { type: 'ok', comment: projectedComment(raw) };
    } catch (error) {
      if (error instanceof AbortProjectMetadataCommand) return error.result;
      return { type: 'io-error' };
    }
  }

  private async setScalar(
    observed: ProjectFieldObservation,
    field: 'priority' | 'description',
    value: string | null,
    success: (
      value: string | null,
    ) => Extract<ProjectMetadataCommandResult, { readonly type: 'ok' }>,
  ): Promise<ProjectMetadataCommandResult> {
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };
    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          const current = frontmatter[field];
          if (!sameRawValue(current, observed.value)) {
            throw new AbortProjectMetadataCommand({ type: 'conflict', current });
          }
          if (sameRawValue(current, value))
            throw new AbortProjectMetadataCommand({ type: 'unchanged' });
          if (value === null) delete frontmatter[field];
          else frontmatter[field] = value;
        },
      );
      return success(value);
    } catch (error) {
      if (error instanceof AbortProjectMetadataCommand) return error.result;
      return { type: 'io-error' };
    }
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
