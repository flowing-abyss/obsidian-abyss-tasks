import { firstVisibleWeekDate } from '../../domain/weekGridOffset';
import type { CalendarSettings, ResolvedConfig } from '../../settings/types';
import { localDate, type CalendarProjectionSources, type TaskQueryApi } from '../../tasks';
import {
  projectCalendarOccurrences,
  type CalendarOccurrence,
  type CalendarPlanningOverride,
  type CalendarProjectionIssue,
} from '../../views/calendarOccurrences';
import type { CalendarMoment } from './calendarDateNavigation';
import type { CalViewType } from './calendarViewType';
import { visibleCalendarDates } from './visibleCalendarDates';

export interface CalendarContent {
  readonly config: ResolvedConfig;
  readonly issues: readonly CalendarProjectionIssue[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly sources: CalendarProjectionSources;
  readonly submittedPlanning: readonly CalendarPlanningOverride[];
}

export interface CalendarContentInput {
  readonly queries: Pick<TaskQueryApi, 'forCalendarProjection'>;
  readonly settings: Pick<CalendarSettings, 'firstDayOfWeek' | 'recurrence'>;
  readonly view: CalViewType;
  readonly date: CalendarMoment;
  readonly pendingPlanning?: readonly CalendarPlanningOverride[];
  readonly mounted?: CalendarContent | undefined;
}

function calendarStartPosition(
  view: CalViewType,
  date: CalendarMoment,
  firstDayOfWeek: number,
): string {
  if (view === 'week') return firstVisibleWeekDate(date, firstDayOfWeek);
  if (view === 'today') return date.format('YYYY-MM-DD');
  return date.format('YYYY-MM');
}

function calendarConfig(
  view: CalViewType,
  date: CalendarMoment,
  firstDayOfWeek: ResolvedConfig['firstDayOfWeek'],
): ResolvedConfig {
  return { firstDayOfWeek, startPosition: calendarStartPosition(view, date, firstDayOfWeek) };
}

/** The view config plus the projected occurrences and issues for the dates the view will show. */
export function calendarContent(input: CalendarContentInput): CalendarContent {
  const { queries, settings, view, date } = input;
  const config = calendarConfig(view, date, settings.firstDayOfWeek);
  const visibleDates = visibleCalendarDates(view, date, config.firstDayOfWeek);
  const firstVisibleDate = visibleDates[0];
  const lastVisibleDate = visibleDates[visibleDates.length - 1];
  if (firstVisibleDate === undefined || lastVisibleDate === undefined) {
    return {
      config,
      issues: [],
      occurrences: [],
      sources: { materialized: [], recurringSources: [] },
      submittedPlanning: [],
    };
  }
  const projection =
    input.mounted?.sources ?? queries.forCalendarProjection(visibleDates.map(localDate));
  // One latest plan per captured node survives partial settlement until canonical publication.
  const submittedPlanning = [
    ...new Map(
      [...(input.mounted?.submittedPlanning ?? []), ...(input.pendingPlanning ?? [])].map(
        (entry) => [entry.source.node, entry],
      ),
    ).values(),
  ];
  const occurrences = projectCalendarOccurrences(
    projection,
    { from: localDate(firstVisibleDate), to: localDate(lastVisibleDate) },
    { removeScheduledDate: settings.recurrence.removeScheduledDate },
    submittedPlanning,
  );
  return {
    config,
    issues: occurrences.issues,
    occurrences: occurrences.occurrences,
    sources: projection,
    submittedPlanning,
  };
}
