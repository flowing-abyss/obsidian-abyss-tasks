import { normalizePath, TFile, type App } from 'obsidian';
import type { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import type { CalendarSettings, ProjectStatus } from '../settings/types';
import type { TaskApplicationApi, TaskCommandResult, TaskRef } from '../tasks';

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
    if (!(file instanceof TFile)) return;
    const statuses = this.settings.projects.statuses;
    const target = statuses.find((s) => s.id === statusId);
    if (target == null) return;

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
