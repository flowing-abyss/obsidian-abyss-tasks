import type { ListSelection } from '../../app/AppState';
import { DEFAULT_SETTINGS } from '../../settings/defaults';
import type { CalendarSettings } from '../../settings/types';
import type {
  CreateTaskCommandInitial,
  LocalDate,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskCreateSession,
  TaskPriority,
} from '../../tasks';
import { localDate, shiftLocalDate } from '../../tasks';

export interface ProjectCaptureContext {
  readonly type: 'project-workspace';
  readonly projectPath: string;
  readonly destinationPath: string;
  readonly statusSymbol?: string;
  readonly priority?: TaskPriority;
}

export type CaptureContext =
  | { readonly type: 'list'; readonly selection: ListSelection }
  | ProjectCaptureContext
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
    execute: () => Promise.resolve(destinationUnavailableResult()),
  };
}

function cloneContext(context: CaptureContext): CaptureContext {
  if (context.type === 'project-workspace') return { ...context };
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
    const defaultPrefix = this.settings.taskPrefix.trim();
    if (frozenContext.type === 'project-workspace') {
      return await this.projectTarget(frozenContext, frozenContext.destinationPath);
    }
    if (frozenContext.type === 'default') {
      if (frozenContext.source === 'calendar') {
        const today = this.today();
        return {
          label: 'Today · today',
          context: frozenContext,
          session: await this.application.planCreate({ type: 'configured-default' }),
          markdownPrefix: defaultPrefix,
          markdownSuffixes: [],
          initial: { due: { type: 'set', value: today } },
        };
      }
      return {
        label: 'Default destination',
        context: frozenContext,
        session: await this.application.planCreate({ type: 'configured-default' }),
        markdownPrefix: defaultPrefix,
        markdownSuffixes: [],
      };
    }

    const selection = frozenContext.selection;
    if (selection === 'inbox') {
      const tag =
        this.settings.inbox.mode === 'untagged' ? '' : normalizedTag(this.settings.inbox.tag);
      return {
        label: tag ? `Inbox · ${tag}` : 'Inbox · untagged',
        context: frozenContext,
        session: await this.application.planCreate({ type: 'configured-default' }),
        markdownPrefix: '',
        markdownSuffixes: tag ? [tag] : [],
      };
    }
    if (selection === 'today' || selection === 'upcoming') {
      const today = this.today();
      const upcoming = selection === 'upcoming';
      const due = upcoming ? shiftLocalDate(today, 1)! : today;
      return {
        label: upcoming ? 'Upcoming · tomorrow' : 'Today · today',
        context: frozenContext,
        session: await this.application.planCreate({ type: 'configured-default' }),
        markdownPrefix: defaultPrefix,
        markdownSuffixes: [],
        initial: { due: { type: 'set', value: due } },
      };
    }
    if (selection.type === 'tag') {
      const tag = normalizedTag(selection.tag);
      return {
        label: tag,
        context: frozenContext,
        session: await this.application.planCreate({ type: 'configured-default' }),
        markdownPrefix: '',
        markdownSuffixes: tag ? [tag] : [],
      };
    }
    if (selection.type === 'project') {
      return await this.projectTarget(frozenContext, selection.path);
    }

    const group = this.settings.tagGroups.find((candidate) => candidate.id === selection.groupId);
    const groupName = group?.name ?? 'Group';
    const tag =
      group?.mode === 'prefix'
        ? normalizedTag(group.prefix ?? '')
        : normalizedTag(group?.tags?.[0] ?? '');
    if (!tag) {
      return {
        label: `${groupName} · unavailable`,
        context: frozenContext,
        session: unavailableSession(),
        markdownPrefix: '',
        markdownSuffixes: [],
      };
    }
    return {
      label: `${groupName} · ${tag}`,
      context: frozenContext,
      session: await this.application.planCreate({ type: 'configured-default' }),
      markdownPrefix: '',
      markdownSuffixes: [tag],
    };
  }

  private async projectTarget(
    context: CaptureContext,
    destinationPath: string,
  ): Promise<CaptureTarget> {
    const insertion =
      this.settings.projects.taskInsertionMode === 'section' &&
      this.settings.projects.taskInsertionSection.trim().length > 0
        ? {
            type: 'section' as const,
            heading: this.settings.projects.taskInsertionSection,
          }
        : { type: 'append' as const };
    return {
      label: destinationPath,
      context,
      session: await this.application.planCreate({
        type: 'explicit',
        destination: { filePath: destinationPath, insertion },
      }),
      markdownPrefix: '',
      markdownSuffixes: [],
      ...(context.type === 'project-workspace' &&
        (context.statusSymbol !== undefined || context.priority !== undefined) && {
          initial: {
            ...(context.statusSymbol !== undefined && { statusSymbol: context.statusSymbol }),
            ...(context.priority !== undefined && {
              priority: { type: 'set' as const, value: context.priority },
            }),
          },
        }),
    };
  }
}

export function commandBodyForCapture(target: CaptureTarget, draft: string): string {
  return [target.markdownPrefix, draft.trim(), ...target.markdownSuffixes]
    .filter((part) => part.length > 0)
    .join(' ');
}
