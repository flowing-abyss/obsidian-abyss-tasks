import { normalizePath, parseYaml, stringifyYaml, TFile, type App } from 'obsidian';
import type { ProjectStatus } from '../../settings/types';
import { markdownSemanticLiteralRanges } from '../../tags/markdownTagRename';
import type { ProjectRangePatch } from '../ProjectCommandService';
import { parseProjectDate, parseProjectRange } from '../projectDates';
import { auditWorkNotes, computeWorkNotePresetFingerprint, isAuditAccepted } from './compatibility';
import type {
  WorkNoteAuditSource,
  WorkNoteCommandResult,
  WorkNoteCompatibilityPreset,
  WorkNoteCreateRequest,
  WorkNoteKindMarker,
  WorkNoteObservedFields,
  WorkNoteRangeObservation,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from './types';
import type { WorkNoteIndex } from './WorkNoteIndex';

type PresetProvider = WorkNoteCompatibilityPreset | (() => WorkNoteCompatibilityPreset);
type ProjectStatusProvider = () => readonly ProjectStatus[];

interface PreparedCreation {
  readonly preset: WorkNoteCompatibilityPreset;
  readonly presetFingerprint: string;
  readonly title: string;
  readonly kind: 'ordinary' | 'milestone';
  readonly marker: WorkNoteKindMarker;
  readonly rawStatus: string;
  readonly project: TFile;
  readonly projectPath: string;
  readonly path: string;
  readonly templatePath?: string;
  readonly template: TFile | null;
}

interface CompatibilityExpectation {
  readonly presetRevision: number;
  readonly presetFingerprint: string;
}

class AbortWorkNoteCommand extends Error {
  constructor(readonly result: WorkNoteCommandResult) {
    super('Work Note command transaction aborted');
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

function frontmatterTags(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const raw = frontmatter['tags'];
  let entries: readonly unknown[] = [];
  if (Array.isArray(raw)) entries = raw as readonly unknown[];
  else if (raw !== undefined && raw !== null) entries = [raw];
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(/[ ,]+/u))
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
}

function cleanTitle(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|]/gu, '-');
}

function frontmatterFromMarkdown(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match?.[1]) return {};
  const parsed: unknown = parseYaml(match[1]);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function inlineMarkdownTags(markdown: string): string[] {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '');
  const excluded = markdownSemanticLiteralRanges(body);
  const tags = new Set<string>();
  let rangeIndex = 0;
  for (const match of body.matchAll(/(^|[\s([{>"'])#([\p{L}\p{N}_/-]+)/gu)) {
    const tagFrom = (match.index ?? 0) + (match[1]?.length ?? 0);
    while (excluded[rangeIndex] && excluded[rangeIndex]!.to <= tagFrom) rangeIndex += 1;
    const range = excluded[rangeIndex];
    if (range && range.from <= tagFrom && tagFrom < range.to) continue;
    if (match[2]) tags.add(`#${match[2]}`);
  }
  return [...tags];
}

function replaceFrontmatter(
  markdown: string,
  frontmatter: Readonly<Record<string, unknown>>,
): string {
  const yaml = stringifyYaml(frontmatter);
  const replacement = `---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---`;
  const existing = /^---\r?\n[\s\S]*?\r?\n---/u;
  if (existing.test(markdown)) return markdown.replace(existing, replacement);
  return `${replacement}\n${markdown}`;
}

function markerProperty(marker: WorkNoteKindMarker): string | undefined {
  return marker.kind === 'property' ? marker.property : undefined;
}

function markerMatches(
  frontmatter: Readonly<Record<string, unknown>>,
  marker: WorkNoteKindMarker,
): boolean {
  if (marker.kind === 'property') return frontmatter[marker.property] === marker.value;
  return frontmatterTags(frontmatter)
    .map((tag) => tag.toLowerCase())
    .includes((marker.value.startsWith('#') ? marker.value : `#${marker.value}`).toLowerCase());
}

function addMarker(frontmatter: Record<string, unknown>, marker: WorkNoteKindMarker): void {
  if (marker.kind === 'property') {
    frontmatter[marker.property] = marker.value;
    return;
  }
  const raw = frontmatter['tags'];
  let values: unknown[] = [];
  if (Array.isArray(raw)) values = (raw as unknown[]).slice();
  else if (raw !== undefined && raw !== null) values = [raw];
  const value = marker.value.replace(/^#/u, '');
  const normalized = new Set(
    values
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.replace(/^#/u, '').toLowerCase()),
  );
  if (!normalized.has(value.toLowerCase())) values.push(value);
  frontmatter['tags'] = values;
}

function observedRaw(
  observed: WorkNoteObservedFields,
  preset: WorkNoteCompatibilityPreset,
  field: keyof WorkNoteCompatibilityPreset['fields'],
): unknown {
  const property = preset.fields[field];
  return Object.prototype.hasOwnProperty.call(observed.fields, property)
    ? observed.fields[property]
    : observed.fields[field];
}

export class WorkNoteCommandService {
  constructor(
    private readonly app: App,
    private readonly presetProvider: PresetProvider,
    private readonly index: WorkNoteIndex,
    private readonly projectStatusProvider: ProjectStatusProvider = () => [],
  ) {}

  private preset(): WorkNoteCompatibilityPreset {
    return typeof this.presetProvider === 'function' ? this.presetProvider() : this.presetProvider;
  }

  capabilities(): { readonly update: boolean; readonly create: boolean } {
    const preset = this.preset();
    if (!isAuditAccepted(preset)) return { update: false, create: false };
    return {
      update: preset.acceptedAudit?.capabilities.update === true,
      create: preset.acceptedAudit?.capabilities.create === true,
    };
  }

  statuses(): readonly WorkNoteStatusDefinition[] {
    const mapping = this.preset().rawStatusByStatusId;
    const presented: WorkNoteStatusDefinition[] = [];
    const included = new Set<string>();
    for (const status of this.projectStatusProvider()) {
      if (!Object.prototype.hasOwnProperty.call(mapping, status.id)) continue;
      presented.push({ id: status.id, label: status.label });
      included.add(status.id);
    }
    for (const [id, label] of Object.entries(mapping)) {
      if (!included.has(id)) presented.push({ id, label });
    }
    return presented;
  }

  observe(snapshot: WorkNoteSnapshot): WorkNoteObservedFields | null {
    const file = this.app.vault.getAbstractFileByPath(snapshot.path);
    if (!(file instanceof TFile)) return null;
    const preset = this.preset();
    const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<
      string,
      unknown
    >;
    const properties = new Set<string>([
      preset.fields.project,
      preset.fields.status,
      preset.fields.start,
      preset.fields.end,
      preset.fields.updated,
      preset.fields.milestone,
      preset.fields.blockedBy,
      preset.fields.related,
    ]);
    const marker = preset.creation?.kindMarkers[snapshot.kind];
    if (marker?.kind === 'property') properties.add(marker.property);
    const fields = Object.fromEntries(
      [...properties]
        .filter((property) => Object.prototype.hasOwnProperty.call(frontmatter, property))
        .map((property) => [property, frontmatter[property]]),
    );
    if (Object.prototype.hasOwnProperty.call(frontmatter, 'tags'))
      fields['tags'] = frontmatter['tags'];
    return {
      path: snapshot.path,
      presetRevision: snapshot.presetRevision,
      presetFingerprint: snapshot.presetFingerprint,
      projectPath: snapshot.projectPath,
      kind: snapshot.kind,
      fields,
    };
  }

  observeRange(snapshot: WorkNoteSnapshot): WorkNoteRangeObservation | null {
    const observed = this.observe(snapshot);
    if (!observed) return null;
    const preset = this.preset();
    const parsed = (semantic: 'start' | 'end' | 'updated') => {
      const raw = observedRaw(observed, preset, semantic);
      return typeof raw === 'string' ? parseProjectDate(raw) : undefined;
    };
    const start = parsed('start');
    const end = parsed('end');
    const updated = parsed('updated');
    return {
      observed,
      ...(start && { start }),
      ...(end && { end }),
      ...(updated && { updated }),
    };
  }

  private compatibility(
    capability: 'update' | 'create',
    expected?: CompatibilityExpectation,
  ): WorkNoteCommandResult | undefined {
    const preset = this.preset();
    if (!preset.enabled) return { type: 'compatibility-conflict', reason: 'preset-disabled' };
    if (!isAuditAccepted(preset)) {
      return { type: 'compatibility-conflict', reason: 'audit-not-accepted' };
    }
    if (expected && expected.presetRevision !== preset.revision) {
      return { type: 'compatibility-conflict', reason: 'preset-revision-changed' };
    }
    if (expected && expected.presetFingerprint !== computeWorkNotePresetFingerprint(preset)) {
      return { type: 'compatibility-conflict', reason: 'preset-fingerprint-changed' };
    }
    if (preset.acceptedAudit?.capabilities[capability] !== true) {
      return { type: 'compatibility-conflict', reason: `${capability}-not-accepted` };
    }
    return undefined;
  }

  private sourceFor(
    path: string,
    frontmatter: Readonly<Record<string, unknown>>,
    inlineTags: readonly string[] = [],
  ): WorkNoteAuditSource {
    const latestFrontmatterTags = frontmatterTags(frontmatter);
    const tags = [...new Set([...inlineTags, ...latestFrontmatterTags])];
    return {
      files: () => [{ path, tags, frontmatter }],
      allPaths: () => this.app.vault.getMarkdownFiles().map(({ path: candidate }) => candidate),
      resolveLink: (linkpath, sourcePath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null,
      fileExists: (candidate) => this.app.vault.getAbstractFileByPath(candidate) instanceof TFile,
    };
  }

  private latestSnapshot(
    observed: WorkNoteObservedFields,
    preset: WorkNoteCompatibilityPreset,
    frontmatter: Readonly<Record<string, unknown>>,
    inlineTags: readonly string[] = [],
  ): WorkNoteSnapshot | undefined {
    return auditWorkNotes(this.sourceFor(observed.path, frontmatter, inlineTags), preset)
      .snapshots[0];
  }

  private async latestSnapshotFromFile(
    file: TFile,
    observed: WorkNoteObservedFields,
    preset: WorkNoteCompatibilityPreset,
  ): Promise<WorkNoteSnapshot | undefined> {
    const markdown = await this.app.vault.cachedRead(file);
    return this.latestSnapshot(
      observed,
      preset,
      frontmatterFromMarkdown(markdown),
      inlineMarkdownTags(markdown),
    );
  }

  private observedShapeChanged(
    observed: WorkNoteObservedFields,
    preset: WorkNoteCompatibilityPreset,
    frontmatter: Readonly<Record<string, unknown>>,
  ): string | undefined {
    for (const semantic of ['project', 'status'] as const) {
      const expected = observedRaw(observed, preset, semantic);
      if (!sameRawValue(frontmatter[preset.fields[semantic]], expected)) return semantic;
    }
    const marker = preset.creation?.kindMarkers[observed.kind];
    const property = marker ? markerProperty(marker) : undefined;
    if (property && Object.prototype.hasOwnProperty.call(observed.fields, property)) {
      if (!sameRawValue(frontmatter[property], observed.fields[property])) return 'kind';
    }
    if (Object.prototype.hasOwnProperty.call(observed.fields, 'tags')) {
      if (!sameRawValue(frontmatter['tags'], observed.fields['tags'])) return 'kind';
    }
    return undefined;
  }

  async setStatus(
    observed: WorkNoteObservedFields,
    statusId: string,
  ): Promise<WorkNoteCommandResult> {
    const expectation = {
      presetRevision: observed.presetRevision,
      presetFingerprint: observed.presetFingerprint,
    };
    const blocked = this.compatibility('update', expectation);
    if (blocked) return blocked;
    const preset = this.preset();
    const rawStatus = preset.rawStatusByStatusId[statusId];
    if (typeof rawStatus !== 'string' || rawStatus.trim().length === 0) {
      return { type: 'invalid', field: 'status' };
    }
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };

    const audit = await this.index.audit();
    const latest = await this.latestSnapshotFromFile(file, observed, preset);
    if (!audit.capabilities.update || !latest) {
      return { type: 'compatibility-conflict', reason: 'latest-audit-rejected' };
    }
    if (latest.kind !== observed.kind || latest.projectPath !== observed.projectPath) {
      return { type: 'compatibility-conflict', reason: 'eligibility-changed' };
    }

    try {
      await this.app.vault.process(file, (markdown) => {
        const transactionBlocked = this.compatibility('update', expectation);
        if (transactionBlocked) throw new AbortWorkNoteCommand(transactionBlocked);
        const transactionPreset = this.preset();
        const targetRaw = transactionPreset.rawStatusByStatusId[statusId];
        if (typeof targetRaw !== 'string' || targetRaw.trim().length === 0) {
          throw new AbortWorkNoteCommand({ type: 'invalid', field: 'status' });
        }
        const frontmatter = frontmatterFromMarkdown(markdown);
        const shapeConflict = this.observedShapeChanged(observed, transactionPreset, frontmatter);
        if (shapeConflict) {
          throw new AbortWorkNoteCommand({ type: 'conflict', field: shapeConflict });
        }
        const snapshot = this.latestSnapshot(
          observed,
          transactionPreset,
          frontmatter,
          inlineMarkdownTags(markdown),
        );
        if (
          !snapshot ||
          snapshot.kind !== observed.kind ||
          snapshot.projectPath !== observed.projectPath ||
          !snapshot.writableStatusShape
        ) {
          throw new AbortWorkNoteCommand({
            type: 'compatibility-conflict',
            reason: 'eligibility-changed',
          });
        }
        if (frontmatter[transactionPreset.fields.status] === targetRaw) {
          throw new AbortWorkNoteCommand({ type: 'unchanged', path: observed.path });
        }
        frontmatter[transactionPreset.fields.status] = targetRaw;
        return replaceFrontmatter(markdown, frontmatter);
      });
      this.index.refresh();
      return { type: 'ok', path: observed.path };
    } catch (error) {
      if (error instanceof AbortWorkNoteCommand) return error.result;
      return { type: 'io-error' };
    }
  }

  async setRange(
    observed: WorkNoteObservedFields,
    patch: ProjectRangePatch,
  ): Promise<WorkNoteCommandResult> {
    const expectation = {
      presetRevision: observed.presetRevision,
      presetFingerprint: observed.presetFingerprint,
    };
    const blocked = this.compatibility('update', expectation);
    if (blocked) return blocked;
    const invalidPatch = this.invalidRangePatchField(patch);
    if (invalidPatch) return { type: 'invalid', field: invalidPatch };
    const preset = this.preset();
    const observedStart = observedRaw(observed, preset, 'start');
    const observedEnd = observedRaw(observed, preset, 'end');
    const nextStart = patch.start === undefined ? observedStart : (patch.start?.raw ?? undefined);
    const nextEnd = patch.end === undefined ? observedEnd : (patch.end?.raw ?? undefined);
    const nextRange = parseProjectRange(nextStart, nextEnd);
    if (nextRange.issue) return { type: 'invalid', field: nextRange.issue };
    const file = this.app.vault.getAbstractFileByPath(observed.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };

    const audit = await this.index.audit();
    const latest = await this.latestSnapshotFromFile(file, observed, preset);
    if (!audit.capabilities.update || !latest) {
      return { type: 'compatibility-conflict', reason: 'latest-audit-rejected' };
    }
    if (latest.kind !== observed.kind || latest.projectPath !== observed.projectPath) {
      return { type: 'compatibility-conflict', reason: 'eligibility-changed' };
    }

    try {
      await this.app.vault.process(file, (markdown) => {
        const transactionBlocked = this.compatibility('update', expectation);
        if (transactionBlocked) throw new AbortWorkNoteCommand(transactionBlocked);
        const transactionPreset = this.preset();
        const frontmatter = frontmatterFromMarkdown(markdown);
        const shapeConflict = this.observedShapeChanged(observed, transactionPreset, frontmatter);
        if (shapeConflict) {
          throw new AbortWorkNoteCommand({ type: 'conflict', field: shapeConflict });
        }
        for (const semantic of ['start', 'end'] as const) {
          if (
            !sameRawValue(
              frontmatter[transactionPreset.fields[semantic]],
              observedRaw(observed, transactionPreset, semantic),
            )
          ) {
            throw new AbortWorkNoteCommand({ type: 'conflict', field: semantic });
          }
        }
        const snapshot = this.latestSnapshot(
          observed,
          transactionPreset,
          frontmatter,
          inlineMarkdownTags(markdown),
        );
        if (
          !snapshot ||
          snapshot.kind !== observed.kind ||
          snapshot.projectPath !== observed.projectPath
        ) {
          throw new AbortWorkNoteCommand({
            type: 'compatibility-conflict',
            reason: 'eligibility-changed',
          });
        }
        if (patch.start === null) delete frontmatter[transactionPreset.fields.start];
        else if (patch.start !== undefined) {
          frontmatter[transactionPreset.fields.start] = patch.start.raw;
        }
        if (patch.end === null) delete frontmatter[transactionPreset.fields.end];
        else if (patch.end !== undefined) {
          frontmatter[transactionPreset.fields.end] = patch.end.raw;
        }
        return replaceFrontmatter(markdown, frontmatter);
      });
      this.index.refresh();
      return { type: 'ok', path: observed.path };
    } catch (error) {
      if (error instanceof AbortWorkNoteCommand) return error.result;
      return { type: 'io-error' };
    }
  }

  async setTitle(snapshot: WorkNoteSnapshot, title: string): Promise<WorkNoteCommandResult> {
    const expectation = {
      presetRevision: snapshot.presetRevision,
      presetFingerprint: snapshot.presetFingerprint,
    };
    const blocked = this.compatibility('update', expectation);
    if (blocked) return blocked;
    const nextTitle = cleanTitle(title);
    if (!nextTitle) return { type: 'invalid', field: 'title' };
    const file = this.app.vault.getAbstractFileByPath(snapshot.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };
    const audit = await this.index.audit();
    const latest = audit.snapshots.find(({ path }) => path === snapshot.path);
    if (
      !audit.capabilities.update ||
      !latest ||
      latest.kind !== snapshot.kind ||
      latest.projectPath !== snapshot.projectPath
    ) {
      return { type: 'compatibility-conflict', reason: 'eligibility-changed' };
    }
    const folder = snapshot.path.includes('/')
      ? snapshot.path.slice(0, snapshot.path.lastIndexOf('/'))
      : '';
    const folderPrefix = folder ? `${folder}/` : '';
    const nextPath = normalizePath(`${folderPrefix}${nextTitle}.md`);
    if (nextPath === snapshot.path) return { type: 'unchanged', path: snapshot.path };
    if (this.app.vault.getAbstractFileByPath(nextPath)) return { type: 'invalid', field: 'title' };
    try {
      await this.app.fileManager.renameFile(file, nextPath);
      this.index.refresh();
      await this.index.flushPending();
      return { type: 'ok', path: nextPath };
    } catch {
      return { type: 'io-error' };
    }
  }

  private invalidRangePatchField(patch: ProjectRangePatch): string | undefined {
    for (const semantic of ['start', 'end'] as const) {
      const value = patch[semantic];
      if (value === undefined || value === null) continue;
      const parsed = parseProjectDate(value.raw);
      if (
        !parsed ||
        parsed.precision !== value.precision ||
        parsed.instantMs !== value.instantMs ||
        parsed.offsetMinutes !== value.offsetMinutes
      ) {
        return semantic;
      }
    }
    return undefined;
  }

  async create(request: WorkNoteCreateRequest): Promise<WorkNoteCommandResult> {
    const blocked = this.compatibility('create');
    if (blocked) return blocked;
    const prepared = this.prepareCreation(request, this.preset());
    if ('type' in prepared) return prepared;
    const audit = await this.index.audit();
    const latestBlocked = this.creationBlocked(prepared);
    if (latestBlocked) return latestBlocked;
    if (!audit.capabilities.create) {
      return { type: 'compatibility-conflict', reason: 'latest-audit-rejected' };
    }
    const templateBlocked = await this.creationTemplateBlocked(prepared);
    if (templateBlocked) return templateBlocked;
    const folderResult = await this.ensureCreationFolder(prepared);
    if (folderResult) return folderResult;
    return this.performCreation(prepared);
  }

  private prepareCreation(
    request: WorkNoteCreateRequest,
    preset: WorkNoteCompatibilityPreset,
  ): PreparedCreation | WorkNoteCommandResult {
    const creation = preset.creation;
    if (!creation) return { type: 'compatibility-conflict', reason: 'creation-unavailable' };
    const title = cleanTitle(request.title);
    if (!title) return { type: 'invalid', field: 'title' };
    const kind = request.kind ?? creation.defaultKind;
    const marker = creation.kindMarkers[kind];
    const rawStatus = preset.rawStatusByStatusId[creation.defaultStatusId];
    if (!marker || !rawStatus) return { type: 'invalid', field: 'creation' };
    const project = this.app.vault.getAbstractFileByPath(request.projectPath);
    if (!(project instanceof TFile)) return { type: 'invalid', field: 'project' };
    const path = normalizePath(`${creation.folder}/${title}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) return { type: 'conflict', field: 'path' };
    const templatePath = creation.templatePath;
    const template = templatePath
      ? this.app.metadataCache.getFirstLinkpathDest(templatePath, '')
      : null;
    if (templatePath && !(template instanceof TFile)) {
      return { type: 'compatibility-conflict', reason: 'missing-template' };
    }
    return {
      preset,
      presetFingerprint: computeWorkNotePresetFingerprint(preset),
      title,
      kind,
      marker,
      rawStatus,
      project,
      projectPath: request.projectPath,
      path,
      ...(templatePath ? { templatePath } : {}),
      template: template instanceof TFile ? template : null,
    };
  }

  private creationExpectation(plan: PreparedCreation): CompatibilityExpectation {
    return {
      presetRevision: plan.preset.revision,
      presetFingerprint: plan.presetFingerprint,
    };
  }

  private creationBlocked(plan: PreparedCreation): WorkNoteCommandResult | undefined {
    return this.compatibility('create', this.creationExpectation(plan));
  }

  private changedAfterCreate(plan: PreparedCreation): WorkNoteCommandResult {
    return { type: 'partial', path: plan.path, reason: 'preset-changed-after-create' };
  }

  private async creationTemplateBlocked(
    plan: PreparedCreation,
  ): Promise<WorkNoteCommandResult | undefined> {
    if (!plan.template) return undefined;
    let raw: string;
    try {
      raw = await this.app.vault.cachedRead(plan.template);
    } catch {
      return { type: 'compatibility-conflict', reason: 'missing-template' };
    }
    if (raw.includes('<%') && raw.includes('%>') && !this.templater()) {
      return { type: 'compatibility-conflict', reason: 'templater-unavailable' };
    }
    return undefined;
  }

  private async ensureCreationFolder(
    plan: PreparedCreation,
  ): Promise<WorkNoteCommandResult | undefined> {
    const folderPath = plan.path.slice(0, plan.path.lastIndexOf('/'));
    if (!folderPath || this.app.vault.getAbstractFileByPath(folderPath)) return undefined;
    const blocked = this.creationBlocked(plan);
    if (blocked) return blocked;
    try {
      await this.app.vault.createFolder(folderPath);
      return undefined;
    } catch {
      return this.app.vault.getAbstractFileByPath(folderPath) ? undefined : { type: 'io-error' };
    }
  }

  private async performCreation(plan: PreparedCreation): Promise<WorkNoteCommandResult> {
    const blocked = this.creationBlocked(plan);
    if (blocked) return blocked;
    let created = false;
    try {
      const templater = plan.templatePath ? this.templater() : null;
      const rawTemplate = plan.template ? await this.app.vault.cachedRead(plan.template) : '';
      if (rawTemplate.includes('<%') && rawTemplate.includes('%>') && !templater) {
        return { type: 'compatibility-conflict', reason: 'templater-unavailable' };
      }
      const initial =
        plan.template && !templater ? this.renderRawTemplate(rawTemplate, plan.title) : '';
      const createBlocked = this.creationBlocked(plan);
      if (createBlocked) return createBlocked;
      if (this.app.vault.getAbstractFileByPath(plan.path)) {
        return { type: 'conflict', field: 'path' };
      }
      const file = await this.app.vault.create(plan.path, initial);
      created = true;
      const materialized = await this.materializeCreation(file, plan);
      if (materialized) return materialized;
      const templateResult = await this.applyCreationTemplate(file, plan, templater);
      if (templateResult) return templateResult;
      if (this.creationBlocked(plan)) return this.changedAfterCreate(plan);
      const content = await this.app.vault.cachedRead(file);
      const frontmatter = frontmatterFromMarkdown(content);
      const verification = this.verifyCreated(
        plan.path,
        plan.projectPath,
        plan.kind,
        plan.rawStatus,
        plan.marker,
        frontmatter,
        plan.preset,
      );
      if (verification) return { type: 'partial', path: plan.path, reason: verification };
      this.index.refresh();
      return { type: 'ok', path: plan.path };
    } catch (error) {
      if (error instanceof AbortWorkNoteCommand) return error.result;
      if (!created && this.app.vault.getAbstractFileByPath(plan.path) instanceof TFile) {
        return { type: 'conflict', field: 'path' };
      }
      return this.app.vault.getAbstractFileByPath(plan.path) instanceof TFile
        ? { type: 'partial', path: plan.path, reason: 'unrecognized-output' }
        : { type: 'io-error' };
    }
  }

  private async materializeCreation(
    file: TFile,
    plan: PreparedCreation,
  ): Promise<WorkNoteCommandResult | undefined> {
    if (this.creationBlocked(plan)) return this.changedAfterCreate(plan);
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) =>
      this.writeCreationFields(frontmatter, plan),
    );
    return undefined;
  }

  private writeCreationFields(frontmatter: Record<string, unknown>, plan: PreparedCreation): void {
    if (this.creationBlocked(plan)) throw new AbortWorkNoteCommand(this.changedAfterCreate(plan));
    const projectLink = this.app.fileManager.generateMarkdownLink(plan.project, plan.path);
    const projectField = plan.preset.fields.project;
    const statusField = plan.preset.fields.status;
    const existingProject = frontmatter[projectField];
    const existingStatus = frontmatter[statusField];
    const markerAlreadyOwned = markerMatches(frontmatter, plan.marker);
    const reason = this.ownedReplacementReason(
      existingProject,
      projectLink,
      existingStatus,
      plan.rawStatus,
      markerAlreadyOwned,
      frontmatter,
      plan.marker,
    );
    if (reason) {
      throw new AbortWorkNoteCommand({ type: 'partial', path: plan.path, reason });
    }
    frontmatter[projectField] = projectLink;
    frontmatter[statusField] = plan.rawStatus;
    addMarker(frontmatter, plan.marker);
  }

  private ownedReplacementReason(
    existingProject: unknown,
    projectLink: string,
    existingStatus: unknown,
    rawStatus: string,
    markerAlreadyOwned: boolean,
    frontmatter: Readonly<Record<string, unknown>>,
    marker: WorkNoteKindMarker,
  ): string | undefined {
    if (existingProject !== undefined && existingProject !== projectLink) return 'project-replaced';
    if (existingStatus !== undefined && existingStatus !== rawStatus) return 'status-replaced';
    if (!markerAlreadyOwned && this.markerWasReplaced(frontmatter, marker)) {
      return 'kind-marker-replaced';
    }
    return undefined;
  }

  private async applyCreationTemplate(
    file: TFile,
    plan: PreparedCreation,
    templater: ReturnType<WorkNoteCommandService['templater']>,
  ): Promise<WorkNoteCommandResult | undefined> {
    if (!plan.template || !templater) return undefined;
    if (this.creationBlocked(plan)) return this.changedAfterCreate(plan);
    try {
      await templater.templater.write_template_to_file(plan.template, file);
      return undefined;
    } catch {
      return { type: 'partial', path: plan.path, reason: 'templater-failure' };
    }
  }

  private markerWasReplaced(
    frontmatter: Readonly<Record<string, unknown>>,
    marker: WorkNoteKindMarker,
  ): boolean {
    if (marker.kind === 'property') return frontmatter[marker.property] !== undefined;
    return false;
  }

  private verifyCreated(
    path: string,
    projectPath: string,
    kind: 'ordinary' | 'milestone',
    rawStatus: string,
    marker: WorkNoteKindMarker,
    frontmatter: Readonly<Record<string, unknown>>,
    preset: WorkNoteCompatibilityPreset,
  ): string | undefined {
    const snapshot = auditWorkNotes(this.sourceFor(path, frontmatter), preset).snapshots[0];
    if (!markerMatches(frontmatter, marker)) return 'membership-marker-replaced';
    if (!snapshot) return 'unrecognized-output';
    if (snapshot.kind !== kind) return 'kind-marker-replaced';
    if (snapshot.projectPath !== projectPath) return 'project-replaced';
    if (frontmatter[preset.fields.status] !== rawStatus || snapshot.rawStatus !== rawStatus) {
      return 'status-replaced';
    }
    return undefined;
  }

  private templater(): {
    templater: { write_template_to_file(template: TFile, file: TFile): Promise<void> };
  } | null {
    try {
      const plugin = (
        this.app as unknown as { plugins: { getPlugin(id: string): unknown } }
      ).plugins.getPlugin('templater-obsidian');
      if (
        plugin &&
        typeof plugin === 'object' &&
        'templater' in plugin &&
        typeof (plugin as { templater?: { write_template_to_file?: unknown } }).templater
          ?.write_template_to_file === 'function'
      ) {
        return plugin as {
          templater: { write_template_to_file(template: TFile, file: TFile): Promise<void> };
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private renderRawTemplate(raw: string, title: string): string {
    const moment = window.moment();
    return raw
      .replace(/\{\{\s*title\s*\}\}/giu, title)
      .replace(/\{\{\s*date\s*\}\}/giu, moment.format('YYYY-MM-DD'))
      .replace(/\{\{\s*time\s*\}\}/giu, moment.format('HH:mm'));
  }
}
