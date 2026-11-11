import { normalizePath, type App, type TFile } from 'obsidian';

interface TemplaterCore {
  readonly files_with_pending_templates: Set<string>;
  start_templater_task(path: string): void;
  end_templater_task(path: string): Promise<void>;
  create_running_config(template: TFile, target: TFile, runMode: number): unknown;
  read_and_parse_template(configuration: unknown): Promise<string>;
}

// Templater 2.20.6 checks this set 300 ms after a note is created.
const AUTO_CREATE_GUARD_MS = 350;

function waitForAutoCreateCheck(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, AUTO_CREATE_GUARD_MS));
}

export interface TemplaterSession {
  render(template: TFile, target: TFile): Promise<string>;
  finish(): Promise<void>;
}

export class UnsupportedTemplaterError extends Error {}

export interface TemplaterPreparation {
  readonly adapter: TemplaterAdapter | undefined;
  readonly templatePath: string | undefined;
  current(): boolean;
}
interface CreationSettings {
  trigger_on_file_creation: boolean;
  templates_folder: string;
  ignore_folders_on_creation: Array<{ folder: string }>;
  enable_folder_templates: boolean;
  folder_templates: Array<{ folder: string; template: string }>;
  enable_file_templates: boolean;
  file_templates: Array<{ regex: string; template: string }>;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
function strings(value: unknown, keys: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => {
      const row = object(entry);
      return row !== undefined && keys.every((key) => typeof row[key] === 'string');
    })
  );
}
function settings(value: unknown): CreationSettings {
  const r = object(value);
  if (
    r === undefined ||
    typeof r['trigger_on_file_creation'] !== 'boolean' ||
    typeof r['templates_folder'] !== 'string' ||
    typeof r['enable_folder_templates'] !== 'boolean' ||
    typeof r['enable_file_templates'] !== 'boolean' ||
    !strings(r['ignore_folders_on_creation'], ['folder']) ||
    !strings(r['folder_templates'], ['folder', 'template']) ||
    !strings(r['file_templates'], ['regex', 'template'])
  )
    throw new UnsupportedTemplaterError();
  return r as unknown as CreationSettings;
}
function ignoredCreation(policy: CreationSettings, path: string): boolean {
  const templates = normalizePath(policy.templates_folder);
  if (templates !== '/' && path.includes(templates)) return true;
  return policy.ignore_folders_on_creation.some(({ folder }) => {
    const ignored = normalizePath(folder);
    return ignored !== '' && path.startsWith(ignored);
  });
}
function folderTemplate(policy: CreationSettings, path: string): string | undefined {
  let folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/';
  for (;;) {
    const match = policy.folder_templates.find((entry) => entry.folder === folder);
    if (match !== undefined && match.template !== '') return match.template;
    if (folder === '/') return undefined;
    folder = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '/';
  }
}
function configuredTemplate(policy: CreationSettings, path: string): string | undefined {
  if (!policy.trigger_on_file_creation || ignoredCreation(policy, path)) return undefined;
  if (policy.enable_folder_templates) return folderTemplate(policy, path);
  if (policy.enable_file_templates) {
    const match = policy.file_templates.find(({ regex }) => new RegExp(regex).test(path));
    return match?.template === '' ? undefined : match?.template;
  }
  return undefined;
}

function templaterPlugin(app: App, requireSuppression: boolean): unknown {
  try {
    return (app as unknown as { plugins?: { getPlugin(id: string): unknown } }).plugins?.getPlugin(
      'templater-obsidian',
    );
  } catch {
    if (requireSuppression) throw new UnsupportedTemplaterError();
    return undefined;
  }
}

function templaterCore(app: App, requireSuppression: boolean): TemplaterCore | undefined {
  const plugin = templaterPlugin(app, requireSuppression);
  if (plugin == null) return undefined;
  const core = (plugin as { templater?: Partial<TemplaterCore> } | null)?.templater;
  if (
    !(core?.files_with_pending_templates instanceof Set) ||
    typeof core.start_templater_task !== 'function' ||
    typeof core.end_templater_task !== 'function' ||
    typeof core.create_running_config !== 'function' ||
    typeof core.read_and_parse_template !== 'function'
  ) {
    if (requireSuppression) throw new UnsupportedTemplaterError();
    return undefined;
  }
  return core as TemplaterCore;
}

export class TemplaterAdapter {
  private constructor(private readonly core: TemplaterCore) {}

  static fromApp(app: App, requireSuppression = false): TemplaterAdapter | undefined {
    const core = templaterCore(app, requireSuppression);
    return core === undefined ? undefined : new TemplaterAdapter(core);
  }

  /** Captures selection only; no pending task, parser, prompt, hook or file operation runs here. */
  static prepare(app: App, path: string, configured: boolean): TemplaterPreparation {
    const plugin = templaterPlugin(app, true);
    const core = templaterCore(app, true);
    if (plugin == null)
      return {
        adapter: undefined,
        templatePath: undefined,
        current: () => templaterPlugin(app, true) == null,
      };
    if (core === undefined) throw new UnsupportedTemplaterError();
    const raw = object(plugin)?.['settings'];
    const signature: string | undefined = raw === undefined ? undefined : JSON.stringify(raw);
    if (signature !== undefined && signature.length > 262144) throw new UnsupportedTemplaterError();
    const templatePath = configured ? configuredTemplate(settings(raw), path) : undefined;
    return {
      adapter: new TemplaterAdapter(core),
      templatePath,
      current: () =>
        templaterPlugin(app, true) === plugin &&
        templaterCore(app, true) === core &&
        JSON.stringify(object(plugin)?.['settings']) === signature,
    };
  }

  begin(path: string): TemplaterSession {
    this.core.start_templater_task(path);
    let finished = false;
    return {
      render: async (template, target) => {
        // Templater 2.20.6 RunMode.OverwriteFile is 2. Parsing directly makes failures observable;
        // write_template_to_file catches them and resolves successfully.
        const configuration = this.core.create_running_config(template, target, 2);
        return await this.core.read_and_parse_template(configuration);
      },
      finish: async () => {
        if (finished) return;
        finished = true;
        await waitForAutoCreateCheck();
        await this.core.end_templater_task(path);
      },
    };
  }
}
