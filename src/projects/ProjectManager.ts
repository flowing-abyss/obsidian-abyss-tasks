import { normalizePath, TFile, type App } from 'obsidian';
import type { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import type { CalendarSettings, ProjectStatus } from '../settings/types';
import type { TaskApplicationApi, TaskCommandResult, TaskRef } from '../tasks';
import {
  findFrontmatterProperty,
  type ProjectField,
  type ProjectPropertyType,
} from './projectFields';

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
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
}

function validateList(value: unknown, label: string): void {
  const invalid =
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== 'string' && !(typeof entry === 'number' && Number.isFinite(entry)),
    );
  if (invalid) throw new Error(`${label} list entries must be text or numbers.`);
}

function validateNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function validateCheckbox(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
}

function validateDate(value: unknown, label: string): void {
  if (typeof value !== 'string' || !validDate(value)) {
    throw new Error(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
}

function validateDatetime(value: unknown, label: string): void {
  if (typeof value !== 'string' || !validDatetime(value)) {
    throw new Error(`${label} must be a valid local date and time.`);
  }
}

function validateTags(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} tags must be an array of strings.`);
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
    throw new Error(`${field.label} is not an editable project property.`);
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

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  if (typeof raw === 'string') return [raw];
  return [];
}

/**
 * Creates project notes and writes their status markers. Status is stored
 * either as a frontmatter property or as a tag, depending on each status's
 * `match.kind`; changing a status clears the markers of sibling defined
 * statuses so a note carries at most one plugin-managed status.
 */
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

  async setStatus(path: string, statusId: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Project file not found: ${path}`);
    const statuses = this.settings.projects.statuses;
    const target = statuses.find((s) => s.id === statusId);
    if (target == null) throw new Error(`Unknown project status: ${statusId}`);

    const propStatuses = statuses.filter((s) => s.match.kind === 'property');
    const tagStatuses = statuses.filter((s) => s.match.kind === 'tag');

    // Property markers: clear every defined property-status whose value is set,
    // then apply the target if it is a property status. Unrelated keys untouched.
    if (propStatuses.length > 0 || target.match.kind === 'property') {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        for (const s of propStatuses) {
          const m = s.match as { property: string; value: string };
          const cur = fm[m.property];
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Frontmatter scalar values are compared using Obsidian's string semantics.
          const curStr = cur === null || cur === undefined ? '' : String(cur);
          if (curStr === m.value) delete fm[m.property];
        }
        if (target.match.kind === 'property') {
          fm[target.match.property] = target.match.value;
        }
      });
    }

    // Tag markers: strip sibling status tags, add the target tag if tag-kind.
    if (tagStatuses.length > 0 || target.match.kind === 'tag') {
      await this.applyTagMarkers(file, target, tagStatuses);
      // Status resolution also reads INLINE body tags (getAllTags), so an inline
      // marker would otherwise survive and keep matching the old status. Remove
      // inline occurrences of every defined status tag (they are plugin-managed).
      await this.stripInlineStatusTags(file, tagStatuses);
    }
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
    if (!(file instanceof TFile)) throw new Error(`Project file not found: ${path}`);

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      const current = findFrontmatterProperty(frontmatter, property);
      if (!valuesEqual(current?.value, expectedValue)) {
        throw new Error(
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
      throw new Error(`${field.label} is not an editable project property.`);
    }
    const isCustom = field.id.startsWith('property:');
    if (isCustom) return this.customProperty(field, field.property);
    if ((field.id !== 'start' && field.id !== 'end') || field.type !== 'date') {
      throw new Error(`${field.label} must use the curated date field.`);
    }
    return field.property;
  }

  private customProperty(field: ProjectField, property: string): string {
    if (field.id !== `property:${property}`) {
      throw new Error(`Project field ${field.id} does not match property ${property}.`);
    }
    if (this.semanticPropertyNames().has(property.toLocaleLowerCase())) {
      throw new Error(
        `${property} is a semantic project property and must use its dedicated editor.`,
      );
    }
    return property;
  }

  private semanticPropertyNames(): Set<string> {
    const names = new Set(['start', 'end']);
    for (const status of this.settings.projects.statuses) {
      if (status.match.kind === 'property') names.add(status.match.property.toLocaleLowerCase());
      else names.add('tags');
    }
    return names;
  }

  private validateStartRange(value: unknown, frontmatter: Record<string, unknown>): void {
    const end = findFrontmatterProperty(frontmatter, 'end')?.value;
    if (typeof value === 'string' && typeof end === 'string' && validDate(end) && value > end) {
      throw new Error('Start date must be on or before end date.');
    }
  }

  private validateEndRange(value: unknown, frontmatter: Record<string, unknown>): void {
    const start = findFrontmatterProperty(frontmatter, 'start')?.value;
    if (
      typeof value === 'string' &&
      typeof start === 'string' &&
      validDate(start) &&
      value < start
    ) {
      throw new Error('End date must be on or after start date.');
    }
  }

  private async stripInlineStatusTags(file: TFile, tagStatuses: ProjectStatus[]): Promise<void> {
    const tags = tagStatuses.map((s) => (s.match as { tag: string }).tag.replace(/^#/, ''));
    if (tags.length === 0) return;
    await this.app.vault.process(file, (content) => {
      let out = content;
      for (const tag of tags) {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        // Match an inline #tag (not inside a word/path), keep any leading space.
        const re = new RegExp(`(^|\\s)#${escaped}(?![\\w/-])`, 'gmu');
        out = out.replace(re, '$1');
      }
      return out;
    });
  }

  private async applyTagMarkers(
    file: TFile,
    target: ProjectStatus,
    tagStatuses: ProjectStatus[],
  ): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      let tags = toStringArray(fm['tags']);
      const strip = new Set(
        tagStatuses.map((s) => (s.match as { tag: string }).tag.replace(/^#/, '').toLowerCase()),
      );
      tags = tags.filter((t) => !strip.has(t.replace(/^#/, '').toLowerCase()));
      if (target.match.kind === 'tag') {
        const want = target.match.tag.replace(/^#/, '');
        if (!tags.some((t) => t.replace(/^#/, '').toLowerCase() === want.toLowerCase())) {
          tags.push(want);
        }
      }
      if (tags.length > 0) fm['tags'] = tags;
      else delete fm['tags'];
    });
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
