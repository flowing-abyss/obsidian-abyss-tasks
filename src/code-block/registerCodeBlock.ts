import { MarkdownRenderChild, Platform, type Plugin } from 'obsidian';
import { DEFAULT_VIEW_CONFIG } from '../settings/defaults';
import type { CalendarSettings, CodeBlockParams, ResolvedConfig } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { systemCommentTimeContext, type TaskApplicationApi, type TaskQueryApi } from '../tasks';
import { CalendarRenderer } from '../ui/CalendarRenderer';

// Note: if 'yaml' is not available as a dependency, use a simple key:value line parser
function parseCodeBlockYaml(source: string): CodeBlockParams {
  // Use JSON.parse-safe subset: only parse simple key: value lines
  const params: Record<string, unknown> = {};
  for (const line of source.split('\n')) {
    // eslint-disable-next-line sonarjs/super-linear-regex -- Input is one trimmed line and the compatibility grammar must preserve quoted values.
    const m = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (m?.[1] != null && m[2] != null) params[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  // Coerce numeric fields
  if (params['firstDayOfWeek'] !== undefined)
    params['firstDayOfWeek'] = parseInt(params['firstDayOfWeek'] as string);
  if (params['upcomingDays'] !== undefined)
    params['upcomingDays'] = parseInt(params['upcomingDays'] as string);
  return params;
}

function overrideOr<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  return value;
}

export function resolveConfig(settings: CalendarSettings, params: CodeBlockParams): ResolvedConfig {
  const platformConfig = Platform.isMobile ? settings.mobile : settings.desktop;
  const merged = { ...DEFAULT_VIEW_CONFIG, ...platformConfig };
  const firstDayOfWeek = Math.min(
    6,
    Math.max(0, overrideOr(params.firstDayOfWeek, merged.firstDayOfWeek)),
  ) as ResolvedConfig['firstDayOfWeek'];
  return {
    ...merged,
    defaultView: overrideOr(params.view, merged.defaultView),
    firstDayOfWeek,
    upcomingDays: overrideOr(params.upcomingDays, merged.upcomingDays),
    dailyNoteFolder: overrideOr(params.dailyNoteFolder, merged.dailyNoteFolder),
    dailyNoteFormat: overrideOr(params.dailyNoteFormat, merged.dailyNoteFormat),
    style: overrideOr(params.style, merged.style),
    globalTaskFilter: overrideOr(params.globalTaskFilter, merged.globalTaskFilter),
    startPosition: overrideOr(params.startPosition, merged.startPosition),
    tag: overrideOr(params.tag, merged.tag),
    folder: overrideOr(params.folder, merged.folder),
    isMobile: Platform.isMobile,
    sourceNoteDisplay: settings.sourceNoteDisplay,
    customFilePath: settings.customFilePath,
  };
}

export function registerCodeBlock(
  ...args: [
    plugin: Plugin,
    settings: CalendarSettings,
    queries: TaskQueryApi,
    tasks: TaskApplicationApi,
    statusRegistry: StatusRegistry,
  ]
): void {
  const [plugin, settings, queries, tasks, statusRegistry] = args;
  plugin.registerMarkdownCodeBlockProcessor('task-calendar', (source, el, ctx) => {
    let params: CodeBlockParams;
    try {
      params = parseCodeBlockYaml(source);
    } catch {
      const err = el.createDiv({ cls: 'callout' });
      err.createEl('p', { text: 'Task-calendar: invalid YAML in code block.' });
      return;
    }

    const config = resolveConfig(settings, params);
    const tid = String(Date.now());
    const rootEl = el.createDiv({
      cls: `tasksCalendar ${config.style}`,
      attr: {
        id: `tasksCalendar${tid}`,
        view: config.defaultView,
        style: 'position:relative;-webkit-user-select:none!important',
      },
    });

    const renderer = new CalendarRenderer(
      rootEl,
      config,
      plugin.app,
      queries,
      tasks,
      statusRegistry,
      settings.taskPrefix,
      settings.recurrence,
      systemCommentTimeContext,
    );

    // MarkdownRenderChild ensures cleanup when the block leaves the DOM
    const child = new MarkdownRenderChild(el);
    child.onunload = () => {
      renderer.destroy();
    };
    ctx.addChild(child);

    renderer.mount();
  });
}
