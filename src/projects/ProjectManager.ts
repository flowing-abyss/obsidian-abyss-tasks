import {
  getAllTags,
  getFrontMatterInfo,
  normalizePath,
  parseFrontMatterTags,
  parseYaml,
  stringifyYaml,
  TFile,
  TFolder,
  type App,
} from 'obsidian';
import { sameNoteFileStamp } from '../markdown/noteFileStamp';
import { parseMarkdownFrontmatter } from '../markdown/readFrontmatter';
import { readVaultText } from '../markdown/readVaultText';
import {
  CreatedNoteTemplateError,
  ExecutableTemplateError,
  StaleStaticNoteError,
  StaticNoteFailure,
  type NoteTemplateService,
} from '../notes/NoteTemplateService';
import { UnsupportedTemplaterError } from '../notes/TemplaterAdapter';
import { evaluateQuery } from '../query/evaluateQuery';
import type { CalendarSettings, ProjectStatus } from '../settings/types';
import { normalizeTag, transformMarkdownTags } from '../tags/markdownTagRename';
import type {
  ProjectSourceReadApi,
  TaskApplicationApi,
  TaskCommandResult,
  TaskReadResult,
  TaskRef,
} from '../tasks';
import {
  ObsidianProjectProperties,
  type ProjectPropertyCatalog,
} from './ObsidianProjectProperties';
import type {
  ProjectAssignments,
  ProjectCreation,
  ProjectIntegrationReads,
  ProjectIntegrationWrites,
  ProjectReadSummary,
  ProjectWriteReason,
  ProjectWriteResult,
} from './projectApi';
import {
  defaultProjectCreationStatus,
  ProjectCreationError,
  type ProjectCreateOptions,
} from './projectCreation';
import { parseProjectDate, validDate, validDatetime } from './projectDateValue';
import { isProjectEditValidationError, ProjectEditValidationError } from './projectEditError';
import {
  createOwnedInferredPropertyClear,
  isOwnedInferredPropertyClear,
  normalizeProjectCellAssignment,
  type AppliedProjectCellChange,
  type OwnedInferredPropertyClear,
  type ProjectCellChange,
  type ProjectEditResult,
} from './projectEdits';
import {
  isAvailableProjectField,
  type ProjectField,
  type ProjectPropertyType,
} from './projectFields';
import { catalog, fieldCompatible, statusChoices, statusFor } from './projectMetadataPolicy';
import { resolveConfiguredProjectField } from './projectPropertyDefinitions';
import { sameProjectPropertyName } from './projectPropertyNames';
import { projectTaskInsertion } from './projectTaskInsertion';
import { resolveStatus } from './status';

export interface ExpectedProjectStatus {
  readonly statusId: string | null;
  readonly rawStatus: string | null;
}

interface NormalizedPropertyValue {
  clear: boolean;
  value: unknown;
}

/** The shared note provisioner used for project template creation. */
export interface ProjectNoteCreator {
  createNoteFromTemplate(filePath: string, templatePath: string, title: string): Promise<TFile>;
  createStaticNote?: NoteTemplateService['createStaticNote'];
}

interface WriteContext {
  readonly reads: ProjectIntegrationReads;
  readonly sources: ProjectSourceReadApi;
}
class ProjectGuardFailure extends Error {
  constructor(readonly reason: ProjectWriteReason) {
    super(reason);
  }
}
function checked<T>(result: TaskReadResult<T>): T {
  if (result.type === 'error') throw new ProjectGuardFailure(result.reason);
  return result.value;
}
function failureReason(cause: unknown): ProjectWriteReason {
  if (cause instanceof ProjectGuardFailure) return cause.reason;
  if (cause instanceof ExecutableTemplateError || cause instanceof UnsupportedTemplaterError)
    return 'unsupported';
  if (cause instanceof StaleStaticNoteError) return 'stale';
  return isProjectEditValidationError(cause) ? 'invalid' : 'io';
}
function invalidAssignment(): never {
  throw new ProjectGuardFailure('invalid');
}
function staleProject(): never {
  throw new ProjectGuardFailure('stale');
}

interface PhysicalAssignment {
  readonly change: { readonly field: ProjectField };
  readonly property: string;
  readonly sourceKey: string;
  readonly value: unknown;
  readonly valueExists: boolean;
}

function projectAssignments(
  settings: CalendarSettings['projects'],
  input: ProjectAssignments,
  parsed: ParsedProjectSource,
): PhysicalAssignment[] {
  const fields = catalog(settings);
  const assignments: PhysicalAssignment[] = [];
  const bind = (id: string, value: unknown, status: boolean): void => {
    const field = fields.find((item) => sameProjectPropertyName(item.id, id));
    if (field?.type == null || (field.type === 'status') !== status) invalidAssignment();
    const property = field.property;
    if (
      property === undefined ||
      assignments.some((item) => sameProjectPropertyName(item.property, property))
    )
      invalidAssignment();
    const current = uniqueFrontmatterProperty(parsed.frontmatter, property);
    validateProjectAssignment({ settings, parsed }, field, current, value);
    assignments.push({
      change: { field },
      property,
      sourceKey: current?.key ?? property,
      value,
      valueExists: value !== null,
    });
  };
  if (input.statusId !== undefined) {
    const literal =
      input.statusId === null
        ? null
        : statusChoices(settings).find((status) => status.id === input.statusId)?.name;
    if (literal === undefined) invalidAssignment();
    bind('status', literal, true);
  }
  for (const { fieldId, value } of input.fields ?? []) bind(fieldId, value, false);
  return assignments;
}

function validateProjectAssignment(
  context: { settings: CalendarSettings['projects']; parsed: ParsedProjectSource },
  field: ProjectField,
  current: { value: unknown } | undefined,
  value: unknown,
): void {
  if (field.type === 'status') {
    if (statusFor(context.settings, context.parsed.frontmatter).state === 'unsupported')
      invalidAssignment();
    return;
  }
  if (current !== undefined && !fieldCompatible(field, current.value)) invalidAssignment();
  if (value !== null && !fieldCompatible(field, value)) invalidAssignment();
}

async function reconcileProject(
  ctx: WriteContext,
  path: string,
  file: TFile,
  content: string,
): Promise<ProjectReadSummary | undefined> {
  try {
    if (!(await ctx.sources.reconcile(path, file, content))) return undefined;
    const accepted = checked(ctx.sources.get(path));
    if (accepted?.content !== content) return undefined;
    const proof = checked(ctx.reads.summary(path));
    return proof !== undefined && ctx.reads.matchesFile(proof, file) ? proof : undefined;
  } catch {
    return undefined;
  }
}

interface PreparedProjectCellChange {
  readonly change: ProjectCellChange;
  readonly property: string;
  readonly value: unknown;
  readonly valueExists: boolean;
  readonly expectedValue: unknown;
  readonly expectedExists: boolean;
  readonly sourceKey: string;
  readonly inferredCustomProperty: boolean;
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
}

type RequestedProjectCellChange = Omit<
  PreparedProjectCellChange,
  'expectedValue' | 'expectedExists' | 'sourceKey'
>;

interface PreparedProjectFileEdits {
  readonly file: TFile;
  readonly path: string;
  readonly changes: PreparedProjectCellChange[];
}

interface EditableConfiguredProperty {
  readonly property: string;
  readonly inferredCustomProperty: boolean;
  readonly ownedClear: OwnedInferredPropertyClear | undefined;
}

interface CaseInsensitiveVaultLookup {
  getAbstractFileByPathInsensitive?(
    path: string,
  ): ReturnType<App['vault']['getAbstractFileByPath']>;
}

function abstractFileByPathInsensitive(
  app: App,
  path: string,
): ReturnType<App['vault']['getAbstractFileByPath']> {
  const vault = app.vault as App['vault'] & CaseInsensitiveVaultLookup;
  return vault.getAbstractFileByPathInsensitive?.(path) ?? vault.getAbstractFileByPath(path);
}

function cleanProjectName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/gu, '-');
}

function isInvalidProjectDateRange(start: unknown, end: unknown): boolean {
  const parsedStart = parseProjectDate(start);
  const parsedEnd = parseProjectDate(end);
  return (
    parsedStart !== undefined &&
    parsedEnd !== undefined &&
    parsedStart.value.getTime() > parsedEnd.value.getTime()
  );
}

function bothDateOnly(start: unknown, end: unknown): boolean {
  return typeof start === 'string' && typeof end === 'string' && validDate(start) && validDate(end);
}

type PropertyValidator = (value: unknown, label: string) => void;

function validateText(value: unknown, label: string): void {
  if (typeof value !== 'string') {
    throw new ProjectEditValidationError(`${label} must be a string.`);
  }
}

function validateList(value: unknown, label: string): void {
  const invalid =
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== 'string' && !(typeof entry === 'number' && Number.isFinite(entry)),
    );
  if (invalid) {
    throw new ProjectEditValidationError(`${label} list entries must be text or numbers.`);
  }
}

function validateNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectEditValidationError(`${label} must be a finite number.`);
  }
}

function validateCheckbox(value: unknown, label: string): void {
  if (typeof value !== 'boolean') {
    throw new ProjectEditValidationError(`${label} must be a boolean.`);
  }
}

function validateDate(value: unknown, label: string): void {
  if (typeof value !== 'string' || !validDate(value)) {
    throw new ProjectEditValidationError(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
}

function validateDatetime(value: unknown, label: string): void {
  if (typeof value !== 'string' || !validDatetime(value)) {
    throw new ProjectEditValidationError(`${label} must be a valid local date and time.`);
  }
}

function validateTags(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ProjectEditValidationError(`${label} tags must be an array of strings.`);
  }
}

const PROPERTY_VALIDATORS: Record<ProjectPropertyType, PropertyValidator> = {
  text: validateText,
  list: validateList,
  number: validateNumber,
  checkbox: validateCheckbox,
  date: validateDate,
  datetime: validateDatetime,
  tags: validateTags,
};

function isPropertyType(type: ProjectField['type']): type is ProjectPropertyType {
  return type in PROPERTY_VALIDATORS;
}

function absentEditSourceKey(
  change: ProjectCellChange,
  property: string,
  ownedClear: OwnedInferredPropertyClear | undefined,
): string {
  if (change.expectedExists === false && ownedClear !== undefined) {
    return ownedClear.sourceKey;
  }
  if (
    change.restoreSourceValue === true &&
    change.expectedExists === false &&
    change.sourceKey !== undefined &&
    sameProjectPropertyName(change.sourceKey, property)
  ) {
    return change.sourceKey;
  }
  return property;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in rightRecord && valuesEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
}

const INLINE_TAG_CANDIDATE = /#\S+/gu;

interface ParsedProjectSource {
  readonly frontmatter: Record<string, unknown>;
  readonly prefix: string;
  readonly delimiter: string;
  readonly lineEnding?: string;
  body: string;
}

function projectFrontmatterSubject(path: string | undefined): string {
  return path === undefined ? 'Project frontmatter' : `Project frontmatter in ${path}`;
}

function parseProjectSource(source: string, path?: string): ParsedProjectSource {
  const info = getFrontMatterInfo(source);
  if (!info.exists) return { frontmatter: {}, prefix: '---\n', delimiter: '\n---\n', body: source };
  let parsed: unknown;
  try {
    parsed = parseYaml(info.frontmatter);
  } catch {
    throw new ProjectEditValidationError(`${projectFrontmatterSubject(path)} is not valid YAML.`);
  }
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new ProjectEditValidationError(
      `${projectFrontmatterSubject(path)} must be a YAML object.`,
    );
  }
  return {
    frontmatter: (parsed ?? {}) as Record<string, unknown>,
    prefix: source.slice(0, info.from),
    delimiter: source.slice(info.to, info.contentStart),
    body: source.slice(info.contentStart),
  };
}

/** Edits the same mapping the source reader validated, retaining the note's encoding and body. */
function parseIntegrationProjectSource(source: string): ParsedProjectSource {
  const parsed = parseMarkdownFrontmatter(source);
  if (parsed.type === 'invalid' || (parsed.type === 'valid' && !parsed.verified))
    throw new ProjectGuardFailure('incomplete');
  const firstNewline = source.indexOf('\n');
  const lineEnding = source[firstNewline - 1] === '\r' ? '\r\n' : '\n';
  if (parsed.type === 'none') {
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    return {
      frontmatter: {},
      prefix: `${bom}---${lineEnding}`,
      delimiter: `${lineEnding}---${lineEnding}`,
      body: source.slice(bom.length),
      lineEnding,
    };
  }
  const { range } = parsed;
  return {
    frontmatter: parsed.value ?? {},
    prefix: source.slice(0, range.yamlFrom),
    delimiter: lineEnding + source.slice(range.yamlTo, range.bodyFrom),
    body: source.slice(range.bodyFrom),
    lineEnding,
  };
}

function semanticInlineTags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(INLINE_TAG_CANDIDATE)) {
    const tag = normalizedTagCandidate(match[0]);
    if (tag !== null && transformMarkdownTags(body, tag, '#abyss-status-probe', 'exact') !== body) {
      tags.add(tag);
    }
  }
  return [...tags];
}

function normalizedTagCandidate(raw: string): string | null {
  let candidate = raw;
  while (candidate.length > 1) {
    const normalized = normalizeTag(candidate);
    if (normalized !== null) return normalized;
    candidate = candidate.slice(0, -1);
  }
  return null;
}

function sourceStatus(
  parsed: ParsedProjectSource,
  projects: CalendarSettings['projects'],
): ExpectedProjectStatus {
  return resolveStatus(projects, parsed.frontmatter);
}

function sameStatus(left: ExpectedProjectStatus, right: ExpectedProjectStatus): boolean {
  return left.statusId === right.statusId && left.rawStatus === right.rawStatus;
}

function matchingFrontmatterProperties(
  frontmatter: Readonly<Record<string, unknown>>,
  property: string,
): Array<{ key: string; value: unknown }> {
  return Object.keys(frontmatter)
    .filter((key) => sameProjectPropertyName(key, property))
    .map((key) => ({ key, value: frontmatter[key] }));
}

function uniqueFrontmatterProperty(
  frontmatter: Readonly<Record<string, unknown>>,
  property: string,
): { key: string; value: unknown } | undefined {
  const matches = matchingFrontmatterProperties(frontmatter, property);
  if (matches.length > 1) {
    throw new ProjectEditValidationError(
      `Project has ambiguous ${property} properties that differ only by case.`,
    );
  }
  return matches[0];
}

function resultingProjectMetadata(
  frontmatter: Readonly<Record<string, unknown>>,
  changes: readonly PhysicalAssignment[],
): Record<string, unknown> {
  const resulting = { ...frontmatter };
  for (const change of changes) {
    const current = uniqueFrontmatterProperty(resulting, change.property);
    const key = current?.key ?? change.sourceKey;
    if (change.valueExists) resulting[key] = change.value;
    else delete resulting[key];
  }
  return resulting;
}

function projectTags(parsed: ParsedProjectSource): string[] {
  return [
    ...(parseFrontMatterTags(parsed.frontmatter) ?? []),
    ...semanticInlineTags(parsed.body),
  ].map((tag) => tag.toLowerCase());
}

function isProject(
  path: string,
  parsed: ParsedProjectSource,
  projects: CalendarSettings['projects'],
): boolean {
  return evaluateQuery(projects.membershipQuery, path, projectTags(parsed), parsed.frontmatter);
}

function isCachedProject(
  path: string,
  cache: ReturnType<App['metadataCache']['getFileCache']>,
  projects: CalendarSettings['projects'],
): boolean {
  const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const tags = (cache === null ? [] : (getAllTags(cache) ?? [])).map((tag) => tag.toLowerCase());
  return evaluateQuery(projects.membershipQuery, path, tags, frontmatter);
}

function parseStatusRenameCandidate(
  source: string,
  file: TFile,
  cache: ReturnType<App['metadataCache']['getFileCache']>,
  projects: CalendarSettings['projects'],
): ParsedProjectSource | null {
  try {
    return parseProjectSource(source, file.path);
  } catch (error) {
    if (!isProjectEditValidationError(error)) throw error;
    if (!isCachedProject(file.path, cache, projects)) return null;
    throw error;
  }
}

interface StatusRenameWrite {
  readonly file: TFile;
  readonly path: string;
}

interface StatusRenameContext {
  readonly definition: ProjectStatus;
  readonly expectedName: string;
  readonly property: string;
  readonly targetName: string;
}

class ProjectStatusRenameError extends Error {
  constructor(
    message: string,
    readonly unresolvedPaths: readonly string[],
  ) {
    super(message);
    this.name = 'ProjectStatusRenameError';
  }
}

const metadataOperations = new WeakMap<App, Promise<void>>();

async function coordinateMetadataOperation<T>(app: App, operation: () => Promise<T>): Promise<T> {
  const previous = metadataOperations.get(app) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  metadataOperations.set(
    app,
    previous.catch(() => {}).then(() => current),
  );
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

export function joinSerializedFrontmatter(yaml: string, delimiter: string): string {
  if (yaml.endsWith('\n')) return yaml + delimiter.replace(/^\r?\n/u, '');
  if (/^\r?\n/u.test(delimiter)) return yaml + delimiter;
  const lineEnding = delimiter.includes('\r\n') ? '\r\n' : '\n';
  return yaml + lineEnding + delimiter;
}

function serializeProjectSource(parsed: ParsedProjectSource): string {
  const serialized = stringifyYaml(parsed.frontmatter);
  const yaml = parsed.lineEnding === '\r\n' ? serialized.replace(/\r?\n/gu, '\r\n') : serialized;
  return `${parsed.prefix}${joinSerializedFrontmatter(yaml, parsed.delimiter)}${parsed.body}`;
}

/** Creates project notes and owns guarded writes to configured project metadata. */
export class ProjectManager {
  private readonly app: App;
  private readonly settings: CalendarSettings;
  private readonly noteCreator: ProjectNoteCreator;
  private readonly tasks: TaskApplicationApi;
  private readonly projectProperties: ProjectPropertyCatalog;

  constructor(
    ...args: [
      App,
      CalendarSettings,
      ProjectNoteCreator,
      TaskApplicationApi,
      ProjectPropertyCatalog?,
    ]
  ) {
    const [app, settings, noteCreator, tasks, projectProperties] = args;
    this.app = app;
    this.settings = settings;
    this.noteCreator = noteCreator;
    this.tasks = tasks;
    this.projectProperties = projectProperties ?? new ObsidianProjectProperties(app);
  }

  async applyEdits(changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> {
    return coordinateMetadataOperation(this.app, () => this.applyEditsGuarded(changes, true));
  }

  integrationWrites(
    reads: ProjectIntegrationReads,
    sources: ProjectSourceReadApi,
  ): ProjectIntegrationWrites {
    const ctx = { reads, sources };
    return {
      update: (proof, input) =>
        coordinateMetadataOperation(this.app, () =>
          this.updateIntegrationProject(ctx, proof, input),
        ),
      create: (input) => {
        const semantics = reads.semantics();
        return coordinateMetadataOperation(this.app, () =>
          this.createIntegrationProject(ctx, semantics, input),
        );
      },
    };
  }

  private applyProjectAssignments(input: ProjectAssignments, source: string): string {
    const parsed = parseIntegrationProjectSource(source);
    const edits = projectAssignments(this.settings.projects, input, parsed);
    this.validateCombinedDateRange(parsed.frontmatter, edits, true);
    let changed = false;
    for (const edit of edits) {
      const exists = Object.prototype.hasOwnProperty.call(parsed.frontmatter, edit.sourceKey);
      if (
        exists === edit.valueExists &&
        (!exists || valuesEqual(parsed.frontmatter[edit.sourceKey], edit.value))
      )
        continue;
      changed = true;
      if (edit.valueExists) parsed.frontmatter[edit.sourceKey] = edit.value;
      else delete parsed.frontmatter[edit.sourceKey];
    }
    return changed ? serializeProjectSource(parsed) : source;
  }

  private async updateIntegrationProject(
    ctx: WriteContext,
    proof: ProjectReadSummary,
    input: ProjectAssignments,
  ): Promise<ProjectWriteResult> {
    const { path } = proof;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile))
      return { outcome: 'failed', effects: 'unchanged', reason: 'stale' };
    let original: string | undefined;
    let offered: string | undefined;
    try {
      if (!ctx.reads.matchesFile(proof, file)) staleProject();
      const accepted = checked(ctx.sources.get(path));
      if (accepted === undefined) staleProject();
      original = accepted.content;
      const preflight = this.applyProjectAssignments(input, original);
      checked(ctx.reads.guard(proof, original, preflight));
      await this.app.vault.process(file, (live) => {
        if (!ctx.reads.matchesFile(proof, file)) staleProject();
        checked(ctx.reads.guard(proof, live, live));
        const next = this.applyProjectAssignments(input, live);
        checked(ctx.reads.guard(proof, live, next));
        offered = next;
        return next;
      });
    } catch (cause) {
      if (offered === undefined || offered === original)
        return { outcome: 'failed', effects: 'unchanged', reason: failureReason(cause) };
      return this.rejectedProjectUpdate(ctx, file, { path, original, offered });
    }
    if (offered === undefined) return { outcome: 'failed', effects: 'unknown', reason: 'io' };
    const project = await reconcileProject(ctx, path, file, offered);
    const reference = project === undefined ? {} : { project };
    return offered === original
      ? { outcome: 'noop', effects: 'unchanged', ...reference }
      : { outcome: 'changed', effects: 'committed', ...reference };
  }

  private async rejectedProjectUpdate(
    ctx: WriteContext,
    file: TFile,
    evidence: { path: string; original: string | undefined; offered: string },
  ): Promise<ProjectWriteResult> {
    const { path, original, offered } = evidence;
    try {
      const stamp = { ...file.stat };
      const live = await readVaultText(this.app.vault, file);
      if (
        sameNoteFileStamp(stamp, file.stat) &&
        this.app.vault.getAbstractFileByPath(path) === file
      ) {
        if (live === original) return { outcome: 'failed', effects: 'unchanged', reason: 'io' };
        if (live === offered) {
          const project = await reconcileProject(ctx, path, file, offered);
          return {
            outcome: 'failed',
            effects: 'committed',
            reason: 'io',
            ...(project === undefined ? {} : { project }),
          };
        }
      }
    } catch {
      /* An unacknowledged write cannot be attributed without a current file. */
    }
    return { outcome: 'failed', effects: 'unknown', reason: 'io' };
  }

  private async createIntegrationProject(
    ctx: WriteContext,
    semantics: object,
    input: ProjectCreation,
  ): Promise<ProjectWriteResult> {
    let path = '';
    try {
      if (semantics !== ctx.reads.semantics()) staleProject();
      const { projects } = this.settings;
      const clean = cleanProjectName(input.name);
      if (clean.length === 0) invalidAssignment();
      path = this.integrationCreatePath(clean);
      const statusId =
        input.statusId === undefined ? defaultProjectCreationStatus(projects) : input.statusId;
      let scopeRevision: number | undefined;
      if (this.noteCreator.createStaticNote === undefined)
        throw new ProjectGuardFailure('unsupported');
      const owned = await this.noteCreator.createStaticNote({
        path,
        title: clean,
        templatePath: projects.templatePath.trim(),
        capture: (file) => this.captureStaticTemplate(ctx.sources, file),
        prepare: (body) =>
          this.applyProjectAssignments(
            { ...input, ...(statusId === undefined ? {} : { statusId }) },
            body ?? `${projects.taskInsertionSection}\n`,
          ),
        check: (content) => {
          if (ctx.reads.semantics() !== semantics || this.integrationCreatePath(clean) !== path)
            staleProject();
          const staged = ctx.reads.prospective(path, content);
          if (staged.type === 'error') throw new ProjectGuardFailure(staged.reason);
          scopeRevision ??= staged.observation.scopeRevision;
          if (scopeRevision !== staged.observation.scopeRevision) staleProject();
        },
      });
      const project = await reconcileProject(ctx, path, owned.file, owned.content);
      return project === undefined
        ? { outcome: 'failed', effects: 'committed', reason: 'unavailable' }
        : { outcome: 'changed', effects: 'committed', project };
    } catch (cause) {
      return this.failedIntegrationCreate(ctx, path, cause);
    }
  }

  private integrationCreatePath(clean: string): string {
    const folder = this.settings.projects.createFolder.trim();
    const existing = folder.length === 0 ? null : abstractFileByPathInsensitive(this.app, folder);
    return this.uniqueProjectPath(existing instanceof TFolder ? existing.path : folder, clean);
  }

  private async failedIntegrationCreate(
    ctx: WriteContext,
    path: string,
    cause: unknown,
  ): Promise<ProjectWriteResult> {
    if (!(cause instanceof StaticNoteFailure))
      return { outcome: 'failed', effects: 'unchanged', reason: failureReason(cause) };
    const project =
      cause.owned === undefined
        ? undefined
        : await reconcileProject(ctx, path, cause.owned.file, cause.owned.content);
    return {
      outcome: 'failed',
      effects: cause.effects,
      reason: failureReason(cause.cause),
      ...(project === undefined ? {} : { project }),
    };
  }

  private captureStaticTemplate(
    sources: ProjectSourceReadApi,
    file: TFile,
  ): { content: string; current(): boolean } {
    const source = checked(sources.get(file.path));
    if (source === undefined || !sources.matchesFile(source, file))
      throw new ProjectGuardFailure('unavailable');
    return { content: source.content, current: () => sources.matchesFile(source, file) };
  }

  private async applyEditsGuarded(
    changes: readonly ProjectCellChange[],
    checkExpected: boolean,
    collectFailures = true,
  ): Promise<ProjectEditResult> {
    if (changes.length === 0) return { applied: [], failed: [] };
    const preparedFiles = await this.preflightEdits(changes, checkExpected);
    const applied: AppliedProjectCellChange[] = [];
    const failed: Array<{ path: string; message: string }> = [];

    for (const preparedFile of preparedFiles) {
      try {
        const fileReceipts: AppliedProjectCellChange[] = [];
        await this.app.vault.process(preparedFile.file, (source) => {
          const parsed = parseProjectSource(source);
          const refreshed = preparedFile.changes.map((prepared) =>
            this.refreshPreparedEdit(parsed.frontmatter, prepared),
          );
          this.validateCombinedDateRange(parsed.frontmatter, refreshed);
          for (const prepared of refreshed) {
            const current = uniqueFrontmatterProperty(parsed.frontmatter, prepared.property);
            const ownedClear =
              !prepared.valueExists &&
              current !== undefined &&
              prepared.inferredCustomProperty &&
              isPropertyType(prepared.change.field.type)
                ? createOwnedInferredPropertyClear({
                    path: prepared.change.path,
                    fieldId: prepared.change.field.id,
                    sourceProperty: prepared.property,
                    sourceKey: prepared.sourceKey,
                    type: prepared.change.field.type,
                  })
                : undefined;
            fileReceipts.push({
              path: prepared.change.path,
              field: { ...prepared.change.field },
              value: prepared.value,
              expectedValue: prepared.expectedValue,
              previousValue: current?.value,
              sourceProperty: prepared.property,
              sourceKey: prepared.sourceKey,
              previousExists: current !== undefined,
              appliedExists: prepared.valueExists,
              ...(ownedClear === undefined ? {} : { ownedClear }),
            });
            if (prepared.valueExists) parsed.frontmatter[prepared.sourceKey] = prepared.value;
            else delete parsed.frontmatter[prepared.sourceKey];
          }
          return serializeProjectSource(parsed);
        });
        applied.push(...fileReceipts);
      } catch (error) {
        if (!collectFailures) throw error;
        failed.push({
          path: preparedFile.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { applied, failed };
  }

  private refreshPreparedEdit(
    frontmatter: Readonly<Record<string, unknown>>,
    prepared: PreparedProjectCellChange,
  ): PreparedProjectCellChange {
    const currentConfigured = this.editableConfiguredProperty(prepared.change);
    if (currentConfigured.property !== prepared.property) {
      throw new ProjectEditValidationError(
        `${prepared.change.field.label} source property changed. Reload the project and try again.`,
      );
    }
    const current = uniqueFrontmatterProperty(frontmatter, currentConfigured.property);
    const currentSourceKey =
      current?.key ??
      absentEditSourceKey(
        prepared.change,
        currentConfigured.property,
        currentConfigured.ownedClear,
      );
    if (currentSourceKey !== prepared.sourceKey) {
      throw new ProjectEditValidationError(
        `${prepared.change.field.label} source key changed. Reload the project and try again.`,
      );
    }
    if (
      (current !== undefined) !== prepared.expectedExists ||
      !valuesEqual(current?.value, prepared.expectedValue)
    ) {
      throw new ProjectEditValidationError(
        `${prepared.change.field.label} changed externally. Reload the project and try your edit again.`,
      );
    }
    return {
      ...prepared,
      inferredCustomProperty: currentConfigured.inferredCustomProperty,
      ownedClear: currentConfigured.ownedClear,
    };
  }

  private async preflightEdits(
    changes: readonly ProjectCellChange[],
    checkExpected: boolean,
  ): Promise<PreparedProjectFileEdits[]> {
    const byPath = this.groupEditRequests(changes);
    const preparedFiles: PreparedProjectFileEdits[] = [];
    for (const [path, entries] of byPath) {
      preparedFiles.push(await this.preflightFile(path, entries, checkExpected));
    }
    return preparedFiles;
  }

  private groupEditRequests(
    changes: readonly ProjectCellChange[],
  ): Map<string, RequestedProjectCellChange[]> {
    const byPath = new Map<string, RequestedProjectCellChange[]>();
    for (const change of changes) {
      if (change.path.length === 0) {
        throw new ProjectEditValidationError('Project path cannot be empty.');
      }
      if (change.sourceProperty !== undefined && this.curatedSourceBindingChanged(change.field)) {
        throw new ProjectEditValidationError(
          `${change.field.label} source property changed. Reload the project and try again.`,
        );
      }
      const configured = this.editableConfiguredProperty(change);
      if (change.sourceProperty !== undefined && change.sourceProperty !== configured.property) {
        throw new ProjectEditValidationError(
          `${change.field.label} source property changed. Reload the project and try again.`,
        );
      }
      const normalized = this.normalizeCellValue(change);
      const entries = byPath.get(change.path) ?? [];
      entries.push({
        change,
        property: configured.property,
        value: normalized.value,
        valueExists: !normalized.clear,
        inferredCustomProperty: configured.inferredCustomProperty,
        ownedClear: configured.ownedClear,
      });
      byPath.set(change.path, entries);
    }
    return byPath;
  }

  private assertReadCurrent(
    file: TFile,
    path: string,
    stamp: { readonly mtime: number; readonly size: number },
  ): void {
    if (this.app.vault.getAbstractFileByPath(path) !== file || !sameNoteFileStamp(stamp, file.stat))
      throw new ProjectEditValidationError(
        'Project source changed during reading. Reload it and try again.',
      );
  }

  private async preflightFile(
    path: string,
    entries: readonly RequestedProjectCellChange[],
    checkExpected: boolean,
  ): Promise<PreparedProjectFileEdits> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new ProjectEditValidationError(`Project file not found: ${path}`);
    }
    const stamp = { ...file.stat };
    const parsed = parseProjectSource(await readVaultText(this.app.vault, file));
    this.assertReadCurrent(file, path, stamp);
    const deduplicated = new Map<string, PreparedProjectCellChange>();
    for (const entry of entries) {
      const prepared = this.prepareCurrentEdit(parsed.frontmatter, entry, checkExpected);
      this.addPreparedEdit(path, deduplicated, prepared);
    }
    const prepared = [...deduplicated.values()];
    this.validateCombinedDateRange(parsed.frontmatter, prepared);
    return { file, path, changes: prepared };
  }

  private prepareCurrentEdit(
    frontmatter: Readonly<Record<string, unknown>>,
    entry: RequestedProjectCellChange,
    checkExpected: boolean,
  ): PreparedProjectCellChange {
    const current = uniqueFrontmatterProperty(frontmatter, entry.property);
    const sourceKey =
      current?.key ?? absentEditSourceKey(entry.change, entry.property, entry.ownedClear);
    const exists = current !== undefined;
    this.assertSourceKey(entry.change, sourceKey);
    this.assertExpectedValue(entry.change, current?.value, exists, checkExpected);
    return {
      ...entry,
      expectedValue: current?.value,
      expectedExists: exists,
      sourceKey,
    };
  }

  private assertSourceKey(change: ProjectCellChange, sourceKey: string): void {
    if (change.sourceKey === undefined || change.sourceKey === sourceKey) return;
    throw new ProjectEditValidationError(
      `${change.field.label} source key changed. Reload the project and try again.`,
    );
  }

  private assertExpectedValue(
    change: ProjectCellChange,
    currentValue: unknown,
    currentExists: boolean,
    checkExpected: boolean,
  ): void {
    if (change.expectedExists !== undefined && change.expectedExists !== currentExists) {
      throw this.changedExternally(change.field);
    }
    if (checkExpected && !valuesEqual(currentValue, change.expectedValue)) {
      throw this.changedExternally(change.field);
    }
  }

  private addPreparedEdit(
    path: string,
    deduplicated: Map<string, PreparedProjectCellChange>,
    prepared: PreparedProjectCellChange,
  ): void {
    const key = `${path}\u0000${prepared.sourceKey.toLocaleLowerCase()}`;
    const duplicate = deduplicated.get(key);
    if (duplicate === undefined) {
      deduplicated.set(key, prepared);
      return;
    }
    if (!this.samePreparedEdit(duplicate, prepared)) {
      throw new ProjectEditValidationError(
        `Project cell ${prepared.change.field.label} has contradictory edits.`,
      );
    }
  }

  private changedExternally(field: ProjectField): ProjectEditValidationError {
    return new ProjectEditValidationError(
      `${field.label} changed externally. Reload the project and try your edit again.`,
    );
  }

  private curatedSourceBindingChanged(field: ProjectField): boolean {
    if (field.property === undefined) return true;
    if (field.type === 'status') {
      return !sameProjectPropertyName(field.property, this.settings.projects.statusProperty.trim());
    }
    if (field.id === 'start') {
      return !sameProjectPropertyName(field.property, this.settings.projects.startProperty);
    }
    if (field.id === 'end') {
      return !sameProjectPropertyName(field.property, this.settings.projects.endProperty);
    }
    if (field.id === 'description') {
      return !sameProjectPropertyName(field.property, 'description');
    }
    return false;
  }

  private samePreparedEdit(
    left: PreparedProjectCellChange,
    right: PreparedProjectCellChange,
  ): boolean {
    return (
      sameProjectPropertyName(left.property, right.property) &&
      left.sourceKey === right.sourceKey &&
      left.valueExists === right.valueExists &&
      left.expectedExists === right.expectedExists &&
      valuesEqual(left.value, right.value) &&
      valuesEqual(left.expectedValue, right.expectedValue)
    );
  }

  private editableConfiguredProperty(change: ProjectCellChange): EditableConfiguredProperty {
    const { field } = change;
    const configured = resolveConfiguredProjectField(this.settings.projects, field.id);
    if (
      configured === undefined ||
      !isAvailableProjectField(configured) ||
      configured.property === undefined ||
      configured.id !== field.id ||
      configured.type !== field.type ||
      field.property === undefined ||
      !sameProjectPropertyName(configured.property, field.property)
    ) {
      throw new ProjectEditValidationError(
        `${field.label} no longer matches its configured project field. Reload the project and try again.`,
      );
    }
    const property = configured.property;
    const ownedClear = this.validatedOwnedClear(change, property);
    const native = this.projectProperties.inspect(property);
    return {
      property,
      inferredCustomProperty:
        field.id.startsWith('property:') &&
        native.kind === 'available' &&
        native.assignment.kind === 'none',
      ownedClear,
    };
  }

  private validatedOwnedClear(
    change: ProjectCellChange,
    property: string,
  ): OwnedInferredPropertyClear | undefined {
    const owned = change.ownedClear;
    if (owned === undefined) return undefined;
    const matches =
      isOwnedInferredPropertyClear(owned) &&
      [
        change.expectedExists === false,
        owned.path === change.path && owned.fieldId === change.field.id,
        owned.sourceProperty === property,
        sameProjectPropertyName(owned.sourceKey, property),
        owned.type === change.field.type,
        change.sourceProperty === undefined || change.sourceProperty === owned.sourceProperty,
        change.sourceKey === undefined || change.sourceKey === owned.sourceKey,
      ].every(Boolean);
    if (matches && isOwnedInferredPropertyClear(owned)) return owned;
    throw new ProjectEditValidationError(
      `${change.field.label} owned clear receipt does not match this project cell. Reload the project and try again.`,
    );
  }

  private normalizeCellValue(change: ProjectCellChange): NormalizedPropertyValue {
    const assignment = normalizeProjectCellAssignment(change);
    if (change.restoreSourceValue === true || !assignment.exists) {
      return { clear: !assignment.exists, value: assignment.value };
    }
    if (
      (change.field.id === 'start' || change.field.id === 'end') &&
      parseProjectDate(assignment.value) !== undefined
    ) {
      return { clear: false, value: assignment.value };
    }
    if (change.field.type === 'status') {
      if (typeof assignment.value !== 'string' || assignment.value.length === 0) {
        throw new ProjectEditValidationError('Status must be a nonempty string.');
      }
    } else {
      if (!isPropertyType(change.field.type)) {
        throw new ProjectEditValidationError(
          `${change.field.label} is not an editable project property.`,
        );
      }
      PROPERTY_VALIDATORS[change.field.type](assignment.value, change.field.label);
    }
    return { clear: false, value: assignment.value };
  }

  private validateCombinedDateRange(
    frontmatter: Readonly<Record<string, unknown>>,
    changes: readonly PhysicalAssignment[],
    strict = false,
  ): void {
    const resulting = resultingProjectMetadata(frontmatter, changes);
    const start = uniqueFrontmatterProperty(resulting, this.settings.projects.startProperty)?.value;
    const end = uniqueFrontmatterProperty(resulting, this.settings.projects.endProperty)?.value;
    const editsEndpoint = changes.some(
      ({ change }) => change.field.id === 'start' || change.field.id === 'end',
    );
    if (!(strict || editsEndpoint || bothDateOnly(start, end))) return;
    if (!isInvalidProjectDateRange(start, end)) return;
    throw new ProjectEditValidationError(this.dateRangeMessage(changes));
  }

  private dateRangeMessage(changes: readonly PhysicalAssignment[]): string {
    const changedStart = changes.some(({ change }) => change.field.id === 'start');
    const changedEnd = changes.some(({ change }) => change.field.id === 'end');
    return changedEnd && !changedStart
      ? 'End date must be on or after start date.'
      : 'Start date must be on or before end date.';
  }

  /**
   * Move a task into a project by physically relocating its markdown block into
   * the project note (membership == file location). No-op when the task already
   * lives in that note. Honors the plugin's task-insertion setting. The command runs
   * on the caller's task API when it passes one, else on the manager's own.
   */
  async moveTaskToProject(
    ref: TaskRef,
    projectPath: string,
    tasks: TaskApplicationApi = this.tasks,
  ): Promise<TaskCommandResult> {
    const insertion = projectTaskInsertion(this.settings.projects, 'move');
    return tasks.execute({
      type: 'move',
      ref,
      destination: { filePath: projectPath, insertion },
    });
  }

  async setStatus(
    path: string,
    statusId: string,
    expectedStatus?: ExpectedProjectStatus,
    capturedTarget?: { readonly name: string | undefined },
  ): Promise<ProjectEditResult> {
    const targetName =
      capturedTarget === undefined
        ? this.settings.projects.statuses.find(({ id }) => id === statusId)?.name
        : capturedTarget.name;
    return coordinateMetadataOperation(this.app, () =>
      this.setStatusGuarded(path, statusId, targetName, expectedStatus),
    );
  }

  private async setStatusGuarded(
    path: string,
    statusId: string,
    targetName: string | undefined,
    expectedStatus?: ExpectedProjectStatus,
  ): Promise<ProjectEditResult> {
    const statuses = this.settings.projects.statuses;
    const target = statuses.find((s) => s.id === statusId);
    if (target == null) {
      throw new ProjectEditValidationError(`Unknown project status: ${statusId}`);
    }
    if (targetName !== target.name) {
      throw new ProjectEditValidationError('Project status changed in settings. Choose it again.');
    }
    const property = this.settings.projects.statusProperty.trim();
    if (property.length === 0) {
      throw new ProjectEditValidationError(
        'Choose a project Status property in settings before changing statuses.',
      );
    }
    const field: ProjectField = { id: 'status', property, label: 'Status', type: 'status' };
    let expectedValue: unknown;
    let checkExpected = false;
    if (expectedStatus !== undefined) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        throw new ProjectEditValidationError(`Project file not found: ${path}`);
      }
      const stamp = { ...file.stat };
      const parsed = parseProjectSource(await readVaultText(this.app.vault, file));
      this.assertReadCurrent(file, path, stamp);
      if (!sameStatus(sourceStatus(parsed, this.settings.projects), expectedStatus)) {
        throw new ProjectEditValidationError(
          'Status changed externally. Reload the project and try your edit again.',
        );
      }
      expectedValue = uniqueFrontmatterProperty(parsed.frontmatter, property)?.value;
      checkExpected = true;
    }
    return this.applyEditsGuarded(
      [{ path, field, value: target.name, expectedValue }],
      checkExpected,
      false,
    );
  }

  async renameStatusDefinition(
    id: string,
    name: string,
    expectedName: string,
    persistSettings: () => Promise<void>,
  ): Promise<void> {
    await coordinateMetadataOperation(this.app, () =>
      this.renameStatusDefinitionGuarded(id, name, expectedName, persistSettings),
    );
  }

  private async renameStatusDefinitionGuarded(
    id: string,
    name: string,
    expectedName: string,
    persistSettings: () => Promise<void>,
  ): Promise<void> {
    const context = this.validateStatusRename(id, name, expectedName);
    if (context.targetName === expectedName) return;
    this.assertConfiguredStatusProperty(context.property);
    const candidates = await this.collectStatusRenameCandidates(context);
    const writes: StatusRenameWrite[] = [];
    let definitionChanged = false;
    try {
      for (const file of candidates) {
        if (await this.writeStatusRename(file, context)) writes.push({ file, path: file.path });
      }
      context.definition.name = context.targetName;
      definitionChanged = true;
      await persistSettings();
    } catch (cause) {
      const unresolvedPaths = await this.recoverStatusRename(
        writes,
        context,
        definitionChanged,
        persistSettings,
      );
      const reason = cause instanceof Error ? cause.message : String(cause);
      const recovery =
        unresolvedPaths.length === 0
          ? 'All owned changes were recovered.'
          : `Recovery remains unresolved for: ${unresolvedPaths.join(', ')}.`;
      throw new ProjectStatusRenameError(`${reason}. ${recovery}`, unresolvedPaths);
    }
  }

  private validateStatusRename(
    id: string,
    name: string,
    expectedName: string,
  ): StatusRenameContext {
    const projects = this.settings.projects;
    const targetName = name.trim();
    if (targetName.length === 0) {
      throw new ProjectEditValidationError('Project status name cannot be empty.');
    }
    const property = projects.statusProperty.trim();
    if (property.length === 0) {
      throw new ProjectEditValidationError(
        'Choose a project Status property in settings before renaming statuses.',
      );
    }
    const definition = projects.statuses.find((status) => status.id === id);
    if (definition?.name !== expectedName) {
      throw new ProjectEditValidationError(
        'Project status definition changed externally. Reload settings and try again.',
      );
    }
    if (projects.statuses.some((status) => status.id !== id && status.name === targetName)) {
      throw new ProjectEditValidationError(`A project status named ${targetName} already exists.`);
    }
    return { definition, expectedName, property, targetName };
  }

  private async collectStatusRenameCandidates(context: StatusRenameContext): Promise<TFile[]> {
    const projects = this.settings.projects;
    const candidates: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const path = file.path,
        stamp = { ...file.stat };
      const source = await readVaultText(this.app.vault, file);
      this.assertReadCurrent(file, path, stamp);
      const parsed = parseStatusRenameCandidate(
        source,
        file,
        this.app.metadataCache.getFileCache(file),
        projects,
      );
      if (parsed === null) continue;
      if (!isProject(file.path, parsed, projects)) continue;
      const current = uniqueFrontmatterProperty(parsed.frontmatter, context.property);
      if (current !== undefined && String(current.value) === context.expectedName) {
        candidates.push(file);
      }
    }
    return candidates;
  }

  private async writeStatusRename(file: TFile, context: StatusRenameContext): Promise<boolean> {
    let changed: boolean | undefined;
    await this.app.vault.process(file, (source) => {
      this.assertConfiguredStatusProperty(context.property);
      const parsed = parseProjectSource(source, file.path);
      if (!isProject(file.path, parsed, this.settings.projects)) return source;
      const current = uniqueFrontmatterProperty(parsed.frontmatter, context.property);
      if (current === undefined || String(current.value) !== context.expectedName) return source;
      parsed.frontmatter[current.key] = context.targetName;
      changed = true;
      return serializeProjectSource(parsed);
    });
    return changed === true;
  }

  private async recoverStatusRename(
    writes: readonly StatusRenameWrite[],
    context: StatusRenameContext,
    definitionChanged: boolean,
    persistSettings: () => Promise<void>,
  ): Promise<string[]> {
    if (definitionChanged && context.definition.name === context.targetName) {
      context.definition.name = context.expectedName;
    }
    const unresolvedPaths = await this.compensateStatusRename(writes, context);
    if (!definitionChanged) return unresolvedPaths;
    try {
      await persistSettings();
    } catch {
      unresolvedPaths.push('plugin settings');
    }
    return unresolvedPaths;
  }

  private async compensateStatusRename(
    writes: readonly StatusRenameWrite[],
    context: StatusRenameContext,
  ): Promise<string[]> {
    const unresolvedPaths: string[] = [];
    for (const write of [...writes].reverse()) {
      try {
        if (!(await this.restoreStatusRename(write.file, context)))
          unresolvedPaths.push(write.path);
      } catch {
        unresolvedPaths.push(write.path);
      }
    }
    return unresolvedPaths;
  }

  private async restoreStatusRename(file: TFile, context: StatusRenameContext): Promise<boolean> {
    let restored: boolean | undefined;
    await this.app.vault.process(file, (source) => {
      const parsed = parseProjectSource(source);
      const current = uniqueFrontmatterProperty(parsed.frontmatter, context.property);
      if (current === undefined || String(current.value) !== context.targetName) return source;
      parsed.frontmatter[current.key] = context.expectedName;
      restored = true;
      return serializeProjectSource(parsed);
    });
    return restored === true;
  }

  async setProperty(
    path: string,
    field: ProjectField,
    value: unknown,
    expectedValue: unknown,
  ): Promise<void> {
    await coordinateMetadataOperation(this.app, async () => {
      await this.applyEditsGuarded([{ path, field, value, expectedValue }], true, false);
    });
  }

  private assertConfiguredStatusProperty(property: string): void {
    this.editableConfiguredProperty({
      path: '',
      field: { id: 'status', property, label: 'Status', type: 'status' },
      value: undefined,
      expectedValue: undefined,
    });
  }

  async create(name: string, options: ProjectCreateOptions = {}): Promise<TFile | null> {
    const folder = this.settings.projects.createFolder.trim();
    const clean = cleanProjectName(name);
    if (clean.length === 0) return null;
    const targetStatusId = options.statusId ?? defaultProjectCreationStatus(this.settings.projects);
    this.validateCreationStatus(targetStatusId);
    const resolvedFolder = await this.ensureFolder(folder);
    const path = this.uniqueProjectPath(resolvedFolder, clean);
    const file = await this.createProjectFile(path, clean);
    await this.applyCreationStatus(file, targetStatusId);
    return file;
  }

  private validateCreationStatus(targetStatusId: string | undefined): void {
    if (targetStatusId !== undefined && targetStatusId.length > 0) {
      if (!this.settings.projects.statuses.some(({ id }) => id === targetStatusId)) {
        throw new ProjectEditValidationError(`Unknown project status: ${targetStatusId}`);
      }
      const property = this.settings.projects.statusProperty.trim();
      if (property.length === 0) {
        throw new ProjectEditValidationError(
          'Choose a project Status property in settings before creating a project with a status.',
        );
      }
      this.assertConfiguredStatusProperty(property);
    }
  }

  private async createProjectFile(path: string, cleanName: string): Promise<TFile> {
    let file: TFile | undefined;
    try {
      file = await this.noteCreator.createNoteFromTemplate(
        path,
        this.settings.projects.templatePath,
        cleanName,
      );
      if (this.settings.projects.templatePath.trim().length === 0) {
        await this.app.vault.process(file, (source) =>
          source.length === 0 ? `${this.settings.projects.taskInsertionSection}\n` : source,
        );
      }
      return file;
    } catch (cause) {
      if (cause instanceof CreatedNoteTemplateError) {
        throw new ProjectCreationError(cause.message, {
          createdPath: cause.createdPath,
          phase: 'template',
          cause: cause.cause,
        });
      }
      if (file !== undefined) {
        throw new ProjectCreationError(`Could not prepare ${file.path}.`, {
          createdPath: file.path,
          phase: 'template',
          cause,
        });
      }
      throw cause;
    }
  }

  private async applyCreationStatus(file: TFile, statusId: string | undefined): Promise<void> {
    if (statusId === undefined || statusId.length === 0) return;
    try {
      await this.setStatus(file.path, statusId);
    } catch (cause) {
      throw new ProjectCreationError(`Could not set the status for ${file.path}.`, {
        createdPath: file.path,
        phase: 'status',
        statusId,
        cause,
      });
    }
  }

  private async ensureFolder(folder: string): Promise<string> {
    if (folder.length === 0) return folder;
    const existing = abstractFileByPathInsensitive(this.app, folder);
    if (existing instanceof TFolder) return existing.path;
    if (existing !== null) return folder;
    try {
      return (await this.app.vault.createFolder(folder)).path;
    } catch (cause) {
      // Another writer may have created the folder after the existence check.
      const concurrent = abstractFileByPathInsensitive(this.app, folder);
      if (!(concurrent instanceof TFolder)) throw cause;
      return concurrent.path;
    }
  }

  private uniqueProjectPath(folder: string, cleanName: string): string {
    const base = folder.length > 0 ? `${folder}/${cleanName}` : cleanName;
    let path = normalizePath(`${base}.md`);
    let suffix = 2;
    while (abstractFileByPathInsensitive(this.app, path) != null) {
      path = normalizePath(`${base} ${suffix}.md`);
      suffix++;
    }
    return path;
  }
}
