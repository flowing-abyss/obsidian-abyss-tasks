import { getAllTags, normalizePath, TFile, type App } from 'obsidian';
import type { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import type { CalendarSettings } from '../settings/types';
import type { TaskApplicationApi, TaskCommandResult, TaskRef } from '../tasks';
import { ProjectCommandService, type ProjectPropertyCommandResult } from './ProjectCommandService';
import { resolveProjectLifecycle } from './lifecycle';

/**
 * Creates project notes and writes their status markers. Status is stored
 * either as a frontmatter property or as a tag, depending on each status's
 * `match.kind`; changing a status clears the markers of sibling defined
 * statuses so a note carries at most one plugin-managed status.
 */
export class ProjectManager {
  constructor(
    private app: App,
    private settings: CalendarSettings,
    private resolver: DailyNoteResolver,
    private tasks: TaskApplicationApi,
    private commands: ProjectCommandService = new ProjectCommandService(
      app,
      () => settings.projects.statuses,
    ),
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

  async setStatus(path: string, statusId: string): Promise<ProjectPropertyCommandResult> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    const observed = {
      path,
      ...resolveProjectLifecycle(this.settings.projects.statuses, tags, frontmatter),
    };
    return this.commands.setStatus(observed, statusId);
  }

  async create(name: string): Promise<TFile | null> {
    const folder = this.settings.projects.createFolder.trim();
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (!clean) return null;
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch {
        /* already exists — benign race */
      }
    }
    const base = folder ? `${folder}/${clean}` : clean;
    let path = normalizePath(`${base}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${base} ${n}.md`);
      n++;
    }
    const file = await this.resolver.createNoteFromTemplate(
      path,
      this.settings.projects.templatePath,
      clean,
    );
    const defaultId =
      this.settings.projects.defaultStatusId || this.settings.projects.statuses[0]?.id;
    if (defaultId) await this.setStatus(file.path, defaultId);
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }
}
