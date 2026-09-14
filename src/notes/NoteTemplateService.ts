import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { TemplaterAdapter, type TemplaterSession } from './TemplaterAdapter';

interface FailedPreparation {
  readonly content: string;
  readonly templatePath: string;
  readonly title: string;
}

const inFlightByApp = new WeakMap<App, Map<string, Promise<TFile>>>();
const failedByApp = new WeakMap<App, Map<string, FailedPreparation>>();

export class InvalidNotePathError extends Error {
  constructor(readonly filePath: string) {
    super(`Invalid note path: ${filePath}`);
    this.name = 'InvalidNotePathError';
  }
}

export class MissingNoteTemplateError extends Error {
  constructor(readonly templatePath: string) {
    super(`Could not find the selected note template: ${templatePath}`);
    this.name = 'MissingNoteTemplateError';
  }
}

/** Signals that note creation succeeded but applying its Templater template did not. */
export class CreatedNoteTemplateError extends Error {
  readonly createdPath: string;
  readonly cause: unknown;

  constructor(createdPath: string, cause: unknown) {
    super(`Could not apply the template to ${createdPath}.`);
    this.name = 'CreatedNoteTemplateError';
    this.createdPath = createdPath;
    this.cause = cause;
  }
}

function mapFor<T>(owner: WeakMap<App, Map<string, T>>, app: App): Map<string, T> {
  const existing = owner.get(app);
  if (existing !== undefined) return existing;
  const created = new Map<string, T>();
  owner.set(app, created);
  return created;
}

function notePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (
    trimmed.length === 0 ||
    trimmed.endsWith('/') ||
    /^(?:\/|\\|[A-Za-z]:[\\/])/u.test(trimmed) ||
    trimmed.includes('\\') ||
    trimmed
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new InvalidNotePathError(filePath);
  }
  const normalized = normalizePath(trimmed);
  if (!normalized.toLowerCase().endsWith('.md')) throw new InvalidNotePathError(filePath);
  return normalized;
}

export class NoteTemplateService {
  private readonly templater: TemplaterAdapter | undefined;

  constructor(private readonly app: App) {
    this.templater = TemplaterAdapter.fromApp(app);
  }

  ensureNote(filePath: string, templatePath: string, title: string): Promise<TFile> {
    const path = notePath(filePath);
    const inFlight = mapFor(inFlightByApp, this.app);
    const active = inFlight.get(path);
    if (active !== undefined) return active;
    const operation = this.ensureNoteUnshared(path, templatePath.trim(), title);
    inFlight.set(path, operation);
    void operation.then(
      () => {
        if (inFlight.get(path) === operation) inFlight.delete(path);
      },
      () => {
        if (inFlight.get(path) === operation) inFlight.delete(path);
      },
    );
    return operation;
  }

  async createNoteFromTemplate(
    filePath: string,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    const path = notePath(filePath);
    if (this.app.vault.getAbstractFileByPath(path) !== null) {
      throw new Error(`A note already exists at ${path}.`);
    }
    const template = this.resolveTemplate(templatePath.trim());
    await this.ensureFolders(path);
    return await this.createPreparedNote(path, template, templatePath.trim(), title);
  }

  private async ensureNoteUnshared(
    path: string,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    const failed = mapFor(failedByApp, this.app);
    const priorFailure = failed.get(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile && priorFailure === undefined) return existing;
    if (existing instanceof TFile && priorFailure !== undefined) {
      return await this.retryFailedNote(existing, priorFailure, templatePath, title);
    }
    if (existing !== null) throw new InvalidNotePathError(path);
    const template = this.resolveTemplate(templatePath);
    await this.ensureFolders(path);
    return await this.createPreparedNote(path, template, templatePath, title);
  }

  private async retryFailedNote(
    file: TFile,
    priorFailure: FailedPreparation,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    const failed = mapFor(failedByApp, this.app);
    const content = await this.app.vault.cachedRead(file);
    if (content !== priorFailure.content) {
      failed.delete(file.path);
      return file;
    }
    const requestedTemplate = templatePath.length > 0 ? templatePath : priorFailure.templatePath;
    const requestedTitle = title.length > 0 ? title : priorFailure.title;
    return await this.retryTemplate(
      file,
      this.resolveTemplate(requestedTemplate),
      requestedTemplate,
      requestedTitle,
    );
  }

  private resolveTemplate(templatePath: string): TFile | undefined {
    if (templatePath.length === 0) return undefined;
    const template = this.app.metadataCache.getFirstLinkpathDest(templatePath, '');
    if (!(template instanceof TFile)) throw new MissingNoteTemplateError(templatePath);
    return template;
  }

  private async ensureFolders(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf('/');
    if (slash < 0) return;
    const segments = filePath.slice(0, slash).split('/');
    let current = '';
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      await this.ensureFolder(current, filePath);
    }
  }

  private async ensureFolder(path: string, filePath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    if (existing !== null) throw new InvalidNotePathError(filePath);
    try {
      await this.app.vault.createFolder(path);
    } catch (cause) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw cause;
    }
  }

  private async createPreparedNote(
    path: string,
    template: TFile | undefined,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    if (template === undefined) return await this.app.vault.create(path, '');
    const session = this.templater?.begin(path);
    let file: TFile | undefined;
    try {
      file = await this.app.vault.create(path, '');
      await this.applyTemplate(file, template, title, session);
      mapFor(failedByApp, this.app).delete(path);
      return file;
    } catch (cause) {
      if (file !== undefined) {
        const content = await this.app.vault.cachedRead(file).catch(() => '');
        mapFor(failedByApp, this.app).set(path, { content, templatePath, title });
        throw new CreatedNoteTemplateError(path, cause);
      }
      throw cause;
    } finally {
      await session?.finish();
    }
  }

  private async retryTemplate(
    file: TFile,
    template: TFile | undefined,
    templatePath: string,
    title: string,
  ): Promise<TFile> {
    if (template === undefined) {
      mapFor(failedByApp, this.app).delete(file.path);
      return file;
    }
    const session = this.templater?.begin(file.path);
    try {
      await this.applyTemplate(file, template, title, session);
      mapFor(failedByApp, this.app).delete(file.path);
      return file;
    } catch (cause) {
      const content = await this.app.vault.cachedRead(file).catch(() => '');
      mapFor(failedByApp, this.app).set(file.path, { content, templatePath, title });
      throw new CreatedNoteTemplateError(file.path, cause);
    } finally {
      await session?.finish();
    }
  }

  private async applyTemplate(
    file: TFile,
    template: TFile,
    title: string,
    session: TemplaterSession | undefined,
  ): Promise<void> {
    let content: string;
    if (session !== undefined) {
      content = await session.render(template, file);
    } else {
      const raw = await this.app.vault.cachedRead(template);
      const now = window.moment();
      content = raw
        .replace(/\{\{\s*date\s*\}\}/giu, now.format('YYYY-MM-DD'))
        .replace(/\{\{\s*time\s*\}\}/giu, now.format('HH:mm'))
        .replace(/\{\{\s*title\s*\}\}/giu, title);
    }
    await this.app.vault.modify(file, content);
  }
}
