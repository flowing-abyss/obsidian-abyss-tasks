import {
  getFrontMatterInfo,
  normalizePath,
  parseFrontMatterTags,
  parseYaml,
  stringifyYaml,
  TFile,
  type App,
} from 'obsidian';
import { evaluateQuery } from '../query/evaluateQuery';
import type { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import type { CalendarSettings, ProjectStatus } from '../settings/types';
import { normalizeTag, transformMarkdownTags } from '../tags/markdownTagRename';
import type { TaskApplicationApi, TaskCommandResult, TaskRef } from '../tasks';
import { ProjectEditValidationError } from './projectEditError';
import {
  findFrontmatterProperty,
  isReservedProjectProperty,
  type ProjectField,
  type ProjectPropertyType,
} from './projectFields';
import { resolveStatus } from './status';

export interface ExpectedProjectStatus {
  readonly statusId: string | null;
  readonly rawStatus: string | null;
}

interface NormalizedPropertyValue {
  clear: boolean;
  value: unknown;
}

function isClearValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function validDatetime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/u.exec(value);
  if (match === null || !validDate(match[1] ?? '')) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = match[4] === undefined ? 0 : Number(match[4]);
  return hours <= 23 && minutes <= 59 && seconds <= 59;
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

function normalizePropertyValue(field: ProjectField, value: unknown): NormalizedPropertyValue {
  if (isClearValue(value)) return { clear: true, value: undefined };
  if (!isPropertyType(field.type)) {
    throw new ProjectEditValidationError(`${field.label} is not an editable project property.`);
  }
  PROPERTY_VALIDATORS[field.type](value, field.label);
  return { clear: false, value };
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
  body: string;
}

function parseProjectSource(source: string): ParsedProjectSource {
  const info = getFrontMatterInfo(source);
  if (!info.exists) return { frontmatter: {}, prefix: '---\n', delimiter: '\n---\n', body: source };
  let parsed: unknown;
  try {
    parsed = parseYaml(info.frontmatter);
  } catch {
    throw new ProjectEditValidationError('Project frontmatter is not valid YAML.');
  }
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new ProjectEditValidationError('Project frontmatter must be a YAML object.');
  }
  return {
    frontmatter: (parsed ?? {}) as Record<string, unknown>,
    prefix: source.slice(0, info.from),
    delimiter: source.slice(info.to, info.contentStart),
    body: source.slice(info.contentStart),
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
    .filter((key) => key.localeCompare(property, undefined, { sensitivity: 'accent' }) === 0)
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
  const yaml = stringifyYaml(parsed.frontmatter);
  return `${parsed.prefix}${joinSerializedFrontmatter(yaml, parsed.delimiter)}${parsed.body}`;
}

/** Creates project notes and owns guarded writes to configured project metadata. */
export class ProjectManager {
  constructor(
    private readonly app: App,
    private readonly settings: CalendarSettings,
    private readonly resolver: DailyNoteResolver,
    private readonly tasks: TaskApplicationApi,
  ) {}

  /**
   * Move a task into a project by physically relocating its markdown block into
   * the project note (membership == file location). No-op when the task already
   * lives in that note. Honors the plugin's task-insertion setting.
   */
  async moveTaskToProject(ref: TaskRef, projectPath: string): Promise<TaskCommandResult> {
    const insertion =
      this.settings.projects.taskInsertionMode === 'section'
        ? {
            type: 'section' as const,
            heading: this.settings.projects.taskInsertionSection,
          }
        : { type: 'append' as const };
    return this.tasks.execute({
      type: 'move',
      ref,
      destination: { filePath: projectPath, insertion },
    });
  }

  async setStatus(
    path: string,
    statusId: string,
    expectedStatus?: ExpectedProjectStatus,
  ): Promise<void> {
    await coordinateMetadataOperation(this.app, () =>
      this.setStatusGuarded(path, statusId, expectedStatus),
    );
  }

  private async setStatusGuarded(
    path: string,
    statusId: string,
    expectedStatus?: ExpectedProjectStatus,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new ProjectEditValidationError(`Project file not found: ${path}`);
    }
    const statuses = this.settings.projects.statuses;
    const target = statuses.find((s) => s.id === statusId);
    if (target == null) {
      throw new ProjectEditValidationError(`Unknown project status: ${statusId}`);
    }
    const property = this.settings.projects.statusProperty.trim();
    if (property.length === 0) {
      throw new ProjectEditValidationError(
        'Choose a project Status property in settings before changing statuses.',
      );
    }

    await this.app.vault.process(file, (source) => {
      const parsed = parseProjectSource(source);
      if (
        expectedStatus !== undefined &&
        !sameStatus(sourceStatus(parsed, this.settings.projects), expectedStatus)
      ) {
        throw new ProjectEditValidationError(
          'Status changed externally. Reload the project and try your edit again.',
        );
      }
      const current = uniqueFrontmatterProperty(parsed.frontmatter, property);
      parsed.frontmatter[current?.key ?? property] = target.name;
      return serializeProjectSource(parsed);
    });
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
      const parsed = parseProjectSource(await this.app.vault.read(file));
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
      const parsed = parseProjectSource(source);
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
    const property = this.editableProperty(field);
    const normalized = normalizePropertyValue(field, value);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new ProjectEditValidationError(`Project file not found: ${path}`);
    }

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      const current = findFrontmatterProperty(frontmatter, property);
      if (!valuesEqual(current?.value, expectedValue)) {
        throw new ProjectEditValidationError(
          `${field.label} changed externally. Reload the project and try your edit again.`,
        );
      }
      if (!normalized.clear && field.id === 'start') {
        this.validateStartRange(normalized.value, frontmatter);
      }
      if (!normalized.clear && field.id === 'end') {
        this.validateEndRange(normalized.value, frontmatter);
      }
      const actualProperty = current?.key ?? property;
      if (normalized.clear) delete frontmatter[actualProperty];
      else frontmatter[actualProperty] = normalized.value;
    });
  }

  private editableProperty(field: ProjectField): string {
    if (field.property === undefined || !isPropertyType(field.type)) {
      throw new ProjectEditValidationError(`${field.label} is not an editable project property.`);
    }
    const isCustom = field.id.startsWith('property:');
    if (isCustom) return this.customProperty(field, field.property);
    if ((field.id !== 'start' && field.id !== 'end') || field.type !== 'date') {
      throw new ProjectEditValidationError(`${field.label} must use the curated date field.`);
    }
    const configured =
      field.id === 'start'
        ? this.settings.projects.startProperty
        : this.settings.projects.endProperty;
    if (field.property.localeCompare(configured, undefined, { sensitivity: 'accent' }) !== 0) {
      throw new ProjectEditValidationError(
        `${field.label} does not match its configured project property.`,
      );
    }
    return field.property;
  }

  private customProperty(field: ProjectField, property: string): string {
    if (field.id !== `property:${property}`) {
      throw new ProjectEditValidationError(
        `Project field ${field.id} does not match property ${property}.`,
      );
    }
    if (isReservedProjectProperty(this.settings.projects, property)) {
      throw new ProjectEditValidationError(
        `${property} is a semantic project property and must use its dedicated editor.`,
      );
    }
    return property;
  }

  private validateStartRange(value: unknown, frontmatter: Record<string, unknown>): void {
    const end = findFrontmatterProperty(frontmatter, this.settings.projects.endProperty)?.value;
    if (typeof value === 'string' && typeof end === 'string' && validDate(end) && value > end) {
      throw new ProjectEditValidationError('Start date must be on or before end date.');
    }
  }

  private validateEndRange(value: unknown, frontmatter: Record<string, unknown>): void {
    const start = findFrontmatterProperty(frontmatter, this.settings.projects.startProperty)?.value;
    if (
      typeof value === 'string' &&
      typeof start === 'string' &&
      validDate(start) &&
      value < start
    ) {
      throw new ProjectEditValidationError('End date must be on or after start date.');
    }
  }

  async create(name: string): Promise<TFile | null> {
    const folder = this.settings.projects.createFolder.trim();
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (clean.length === 0) return null;
    await this.ensureFolder(folder);
    const path = this.uniqueProjectPath(folder, clean);
    const file = await this.resolver.createNoteFromTemplate(
      path,
      this.settings.projects.templatePath,
      clean,
    );
    const configuredDefault = this.settings.projects.defaultStatusId;
    const defaultId =
      configuredDefault.length > 0 ? configuredDefault : this.settings.projects.statuses[0]?.id;
    if (defaultId !== undefined && defaultId.length > 0) {
      await this.setStatus(file.path, defaultId);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (folder.length === 0 || this.app.vault.getAbstractFileByPath(folder) != null) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Another writer may have created the folder after the existence check.
    }
  }

  private uniqueProjectPath(folder: string, cleanName: string): string {
    const base = folder.length > 0 ? `${folder}/${cleanName}` : cleanName;
    let path = normalizePath(`${base}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path) != null) {
      path = normalizePath(`${base} ${suffix}.md`);
      suffix++;
    }
    return path;
  }
}
