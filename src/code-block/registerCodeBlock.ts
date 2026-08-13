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
    // eslint-disable-next-line sonarjs/super-linear-regex
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

export function resolveConfig(settings: CalendarSettings, params: CodeBlockParams): ResolvedConfig {
  const platformConfig = Platform.isMobile ? settings.mobile : settings.desktop;
  const merged = { ...DEFAULT_VIEW_CONFIG, ...platformConfig };
  // Apply code block overrides
  if (params.view !== undefined) merged.defaultView = params.view;
  if (params.firstDayOfWeek !== undefined) {
    const fw = Math.min(6, Math.max(0, params.firstDayOfWeek));
    merged.firstDayOfWeek = fw as ResolvedConfig['firstDayOfWeek'];
  }
  if (params.upcomingDays !== undefined) merged.upcomingDays = params.upcomingDays;
  if (params.dailyNoteFolder !== undefined) merged.dailyNoteFolder = params.dailyNoteFolder;
  if (params.dailyNoteFormat !== undefined) merged.dailyNoteFormat = params.dailyNoteFormat;
  if (params.style !== undefined) merged.style = params.style;
  if (params.globalTaskFilter !== undefined) merged.globalTaskFilter = params.globalTaskFilter;
  if (params.startPosition !== undefined) merged.startPosition = params.startPosition;
  if (params.tag !== undefined) merged.tag = params.tag;
  if (params.folder !== undefined) merged.folder = params.folder;
  return {
    ...merged,
    isMobile: Platform.isMobile,
    sourceNoteDisplay: settings.sourceNoteDisplay,
    customFilePath: settings.customFilePath,
  };
}

export function registerCodeBlock(
  plugin: Plugin,
  settings: CalendarSettings,
  queries: TaskQueryApi,
  tasks: TaskApplicationApi,
  statusRegistry: StatusRegistry,
): void {
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
        id: 'tasksCalendar' + tid,
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
    child.onunload = () => renderer.destroy();
    ctx.addChild(child);

    renderer.mount();
  });
}
