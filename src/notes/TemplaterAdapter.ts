import type { App, TFile } from 'obsidian';

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
