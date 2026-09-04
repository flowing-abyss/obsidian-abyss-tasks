import type { ListSelection } from '../../app/AppState';
import { DEFAULT_SETTINGS } from '../../settings/defaults';
import type { CalendarSettings } from '../../settings/types';
import type {
  CreateTaskCommandInitial,
  LocalDate,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskCreateSession,
} from '../../tasks';
import { localDate, shiftLocalDate } from '../../tasks';

export type CaptureContext =
  | { readonly type: 'list'; readonly selection: ListSelection }
  | { readonly type: 'project-dashboard'; readonly path: string }
  | { readonly type: 'default'; readonly source: 'projects' | 'calendar' | 'search' };

export interface CaptureTarget {
  readonly label: string;
  readonly context: CaptureContext;
  readonly session: TaskCreateSession;
  readonly markdownPrefix: string;
  readonly markdownSuffixes: readonly string[];
  readonly initial?: CreateTaskCommandInitial;
}

function destinationUnavailableResult(): TaskCommandResult {
  return {
    type: 'invalid',
    issues: [{ code: 'destination-unavailable', field: 'destination' }],
  };
}

function unavailableSession(): TaskCreateSession {
  return {
    type: 'unavailable',
    execute: async () => destinationUnavailableResult(),
  };
}

function cloneContext(context: CaptureContext): CaptureContext {
  if (context.type === 'project-dashboard') return { ...context };
  if (context.type === 'default') return { ...context };
  return {
    type: 'list',
    selection: typeof context.selection === 'string' ? context.selection : { ...context.selection },
  };
}

function normalizedTag(value: string): string {
  const tag = value.trim();
  return tag.length === 0 || tag.startsWith('#') ? tag : `#${tag}`;
}

export class CaptureTargetResolver {
  constructor(
    private readonly application: TaskCaptureApplicationApi,
    private readonly settings: CalendarSettings = DEFAULT_SETTINGS,
    private readonly today: () => LocalDate = () => localDate(window.moment().format('YYYY-MM-DD')),
  ) {}

  async resolve(context: CaptureContext): Promise<CaptureTarget> {
    const frozenContext = cloneContext(context);
    if (frozenContext.type === 'project-dashboard') {
      return await this.projectTarget(frozenContext, frozenContext.path);
    }
    if (frozenContext.type === 'default') {
      return await this.defaultTarget(frozenContext);
    }
    return await this.listTarget(frozenContext);
  }

  private async defaultTarget(
    context: Extract<CaptureContext, { type: 'default' }>,
  ): Promise<CaptureTarget> {
    const markdownPrefix = this.settings.taskPrefix.trim();
    const calendarToday = context.source === 'calendar' ? this.today() : undefined;
    const session = await this.application.planCreate({ type: 'configured-default' });
    if (calendarToday === undefined) {
      return {
        label: 'Default destination',
        context,
        session,
        markdownPrefix,
        markdownSuffixes: [],
      };
    }
    return {
      label: 'Today · today',
      context,
      session,
      markdownPrefix,
      markdownSuffixes: [],
      initial: { due: { type: 'set', value: calendarToday } },
    };
  }

  private async listTarget(
    context: Extract<CaptureContext, { type: 'list' }>,
  ): Promise<CaptureTarget> {
    const { selection } = context;
    if (selection === 'inbox') {
      return await this.inboxTarget(context);
    }
    if (selection === 'today' || selection === 'upcoming') {
      return await this.datedListTarget(context, selection);
    }
    if (selection.type === 'tag') {
      return await this.tagTarget(context, normalizedTag(selection.tag));
    }
    if (selection.type === 'project') {
      return await this.projectTarget(context, selection.path);
    }
    return await this.tagGroupTarget(context, selection.groupId);
  }

  private async inboxTarget(
    context: Extract<CaptureContext, { type: 'list' }>,
  ): Promise<CaptureTarget> {
    const tag =
      this.settings.inbox.mode === 'untagged' ? '' : normalizedTag(this.settings.inbox.tag);
    return {
      label: tag.length > 0 ? `Inbox · ${tag}` : 'Inbox · untagged',
      context,
      session: await this.application.planCreate({ type: 'configured-default' }),
      markdownPrefix: '',
      markdownSuffixes: tag.length > 0 ? [tag] : [],
    };
  }

  private async datedListTarget(
    context: Extract<CaptureContext, { type: 'list' }>,
    selection: 'today' | 'upcoming',
  ): Promise<CaptureTarget> {
    const today = this.today();
    const upcoming = selection === 'upcoming';
    const due = upcoming ? (shiftLocalDate(today, 1) ?? today) : today;
    return {
      label: upcoming ? 'Upcoming · tomorrow' : 'Today · today',
      context,
      session: await this.application.planCreate({ type: 'configured-default' }),
      markdownPrefix: this.settings.taskPrefix.trim(),
      markdownSuffixes: [],
      initial: { due: { type: 'set', value: due } },
    };
  }

  private async tagTarget(
    context: Extract<CaptureContext, { type: 'list' }>,
    tag: string,
  ): Promise<CaptureTarget> {
    return {
      label: tag,
      context,
      session: await this.application.planCreate({ type: 'configured-default' }),
      markdownPrefix: '',
      markdownSuffixes: tag.length > 0 ? [tag] : [],
    };
  }

  private async tagGroupTarget(
    context: Extract<CaptureContext, { type: 'list' }>,
    groupId: string,
  ): Promise<CaptureTarget> {
    const group = this.settings.tagGroups.find((candidate) => candidate.id === groupId);
    const groupName = group?.name ?? 'Group';
    const tag =
      group?.mode === 'prefix'
        ? normalizedTag(group.prefix ?? '')
        : normalizedTag(group?.tags?.[0] ?? '');
    if (tag.length === 0) {
      return {
        label: `${groupName} · unavailable`,
        context,
        session: unavailableSession(),
        markdownPrefix: '',
        markdownSuffixes: [],
      };
    }
    return {
      label: `${groupName} · ${tag}`,
      context,
      session: await this.application.planCreate({ type: 'configured-default' }),
      markdownPrefix: '',
      markdownSuffixes: [tag],
    };
  }

  private async projectTarget(context: CaptureContext, path: string): Promise<CaptureTarget> {
    const insertion =
      this.settings.projects.taskInsertionMode === 'section' &&
      this.settings.projects.taskInsertionSection.trim().length > 0
        ? {
            type: 'section' as const,
            heading: this.settings.projects.taskInsertionSection,
          }
        : { type: 'append' as const };
    return {
      label: path,
      context,
      session: await this.application.planCreate({
        type: 'explicit',
        destination: { filePath: path, insertion },
      }),
      markdownPrefix: '',
      markdownSuffixes: [],
    };
  }
}

export function commandBodyForCapture(target: CaptureTarget, draft: string): string {
  return [target.markdownPrefix, draft.trim(), ...target.markdownSuffixes]
    .filter((part) => part.length > 0)
    .join(' ');
}
