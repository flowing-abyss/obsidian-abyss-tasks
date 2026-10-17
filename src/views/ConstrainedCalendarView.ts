import { moment } from '../obsidianMoment';
import type { ResolvedConfig } from '../settings/types';
import type { LocalDate, TaskSnapshot } from '../tasks';
import { runAsyncAction } from '../ui/runAsyncAction';
import { renderAddTaskTrigger } from '../ui/taskCapture/renderAddTaskTrigger';
import type { TaskTextRender } from '../ui/taskRenderScope';
import { BaseView } from './BaseView';
import type { MonthGridViewCallbacks } from './MonthGridView';
import {
  buildCalendarDayModel,
  type CalendarDayEntry,
  type CalendarDaySummary,
} from './calendarDayModel';
import { calendarOccurrenceLookup } from './timegrid/renderTaskMeta';

export interface CalendarAgendaRowMount {
  readonly element: HTMLElement;
  readonly settled: TaskTextRender['settled'];
  destroy(): void;
}
interface CalendarAgendaRowActions {
  onActivate(): void;
  onForecastContextMenu(event: MouseEvent, element: HTMLElement): void;
}
export type MountCalendarAgendaEntry = (
  container: HTMLElement,
  entry: CalendarDayEntry,
  date: LocalDate,
  actions: CalendarAgendaRowActions,
) => CalendarAgendaRowMount;

export interface ConstrainedCalendarViewCallbacks extends Omit<
  MonthGridViewCallbacks,
  'onDayClick' | 'onWeekClick' | 'onDrop' | 'onNativeDragStart' | 'onSpanMove' | 'onSpanBoundary'
> {
  readonly mountAgendaEntry: MountCalendarAgendaEntry;
  readonly view: 'month' | 'week';
  readonly dates: readonly LocalDate[];
  readonly selectedDate: () => LocalDate;
  readonly onSelectDate: (date: LocalDate) => void;
}

/** A bounded date index and the selected day's ordinary calendar items. */
export class ConstrainedCalendarView extends BaseView {
  private container: HTMLElement | null = null;
  private agenda: HTMLElement | null = null;
  private readonly buttons = new Map<LocalDate, HTMLButtonElement>();
  private model: ReadonlyMap<LocalDate, CalendarDaySummary> = new Map();
  private readonly agendaMounts: CalendarAgendaRowMount[] = [];
  private agendaScroll: {
    readonly list: HTMLElement;
    readonly target: number;
    readonly isUnchanged: () => boolean;
    readonly cancel: () => void;
  } | null = null;

  constructor(private readonly callbacks: ConstrainedCalendarViewCallbacks) {
    super();
  }

  render(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    this.destroy();
    this.container = container;
    container.empty();
    const root = container.createDiv({
      cls: `abyss-calendar-compact abyss-calendar-compact--${this.callbacks.view}`,
    });
    const grid = root.createDiv({ cls: 'abyss-calendar-dates' });
    for (const date of this.callbacks.dates.slice(0, 7)) {
      grid.createSpan({
        cls: 'abyss-calendar-weekday',
        text: moment(date).format('ddd'),
        attr: { 'aria-hidden': 'true' },
      });
    }
    const today = moment().format('YYYY-MM-DD');
    for (const date of this.callbacks.dates) {
      const button = grid.createEl('button', {
        cls: 'abyss-calendar-date',
        attr: { type: 'button', 'data-calendar-date': date },
      });
      button.toggleClass(
        'is-outside-month',
        this.callbacks.view === 'month' && !date.startsWith(config.startPosition),
      );
      if (date === today) button.setAttribute('aria-current', 'date');
      button.createSpan({ cls: 'abyss-calendar-date-number', text: moment(date).format('D') });
      button.createSpan({ cls: 'abyss-calendar-marks', attr: { 'aria-hidden': 'true' } });
      button.addEventListener('click', () => {
        this.callbacks.onSelectDate(date);
      });
      this.buttons.set(date, button);
    }
    this.agenda = root.createDiv({ cls: 'abyss-calendar-agenda' });
    this.patch(container, tasks, config);
  }

  override patch(container: HTMLElement, tasks: TaskSnapshot[], config: ResolvedConfig): void {
    if (container !== this.container) {
      this.render(container, tasks, config);
      return;
    }
    const occurrenceFor = calendarOccurrenceLookup(tasks);
    this.model = buildCalendarDayModel(
      tasks.map((task) => ({ task, occurrence: occurrenceFor(task) })),
      this.callbacks.dates,
    );
    for (const summary of this.model.values()) this.updateDateButton(summary);
    this.selectDate(this.callbacks.selectedDate());
  }

  private updateDateButton(summary: CalendarDaySummary): void {
    const button = this.buttons.get(summary.date);
    if (button === undefined) return;
    const { date, count, dots, overflow } = summary;
    button.setAttribute(
      'aria-label',
      `${moment(date).format('dddd, LL')}, ${count} ${count === 1 ? 'task' : 'tasks'}`,
    );
    const marks = button.querySelector<HTMLElement>('.abyss-calendar-marks');
    if (marks === null) return;
    marks.empty();
    for (let index = 0; index < dots; index++) marks.createSpan({ cls: 'abyss-calendar-dot' });
    if (overflow) marks.createSpan({ cls: 'abyss-calendar-overflow', text: '+' });
  }

  selectDate(date: LocalDate): void {
    const summary = this.model.get(date);
    if (this.agenda === null || summary === undefined) return;
    const previous = this.agenda.dataset['calendarDate'];
    const scroll = previous === date ? this.agendaScrollOffset() : 0;
    this.callbacks.forecastMenuOwner?.dismiss();
    this.destroyAgendaRows();
    for (const [day, button] of this.buttons)
      button.setAttribute('aria-pressed', String(day === date));
    this.agenda.empty();
    this.agenda.dataset['calendarDate'] = date;
    const list = this.agenda.createDiv({ cls: 'abyss-calendar-agenda-list' });
    list.createEl('h3', {
      cls: 'abyss-calendar-agenda-heading',
      text: moment(date).format('dddd, LL'),
    });
    const entries = summary.entries;
    if (entries.length === 0)
      list.createEl('p', {
        cls: 'abyss-calendar-agenda-empty',
        text: 'No tasks for this day',
      });
    this.renderEntries(list, entries, date);
    const bottom = this.agenda.createDiv({ cls: 'abyss-add-task-bar' });
    renderAddTaskTrigger(bottom, () => {
      this.callbacks.onCreateAtDate(date);
    });
    if (scroll !== 0) {
      list.scrollTop = scroll;
      this.restoreAgendaScrollAfterSettlement(list, scroll);
    }
  }

  private agendaScrollOffset(): number {
    const list = this.agenda?.querySelector<HTMLElement>('.abyss-calendar-agenda-list');
    const pending = this.agendaScroll;
    if (pending !== null && pending.list === list && pending.isUnchanged()) return pending.target;
    return list?.scrollTop ?? 0;
  }

  private restoreAgendaScrollAfterSettlement(list: HTMLElement, target: number): void {
    const initial = list.scrollTop;
    let changed = false;
    const onScroll = (): void => {
      if (list.scrollTop !== initial) changed = true;
    };
    const mounts = this.agendaMounts.map((mount) => ({ mount, receipt: mount.settled }));
    const pending = {
      list,
      target,
      isUnchanged: () => !changed && list.scrollTop === initial,
      cancel: () => {
        list.removeEventListener('scroll', onScroll);
        if (this.agendaScroll === pending) this.agendaScroll = null;
      },
    };
    this.agendaScroll = pending;
    list.addEventListener('scroll', onScroll);
    runAsyncAction(
      Promise.all(mounts.map(({ receipt }) => receipt))
        .then((outcomes) => {
          if (
            this.agendaScroll === pending &&
            list.isConnected &&
            pending.isUnchanged() &&
            outcomes.every((outcome) => outcome.type === 'ready') &&
            mounts.every(
              ({ mount, receipt }) =>
                mount.settled === receipt && mount.element.parentElement === list,
            )
          )
            list.scrollTop = target;
        })
        .finally(pending.cancel),
      'Could not restore calendar agenda scroll',
    );
  }

  private renderEntries(
    container: HTMLElement,
    entries: readonly CalendarDayEntry[],
    date: LocalDate,
  ): void {
    try {
      for (const entry of entries) this.renderEntry(container, entry, date);
    } catch (error) {
      this.destroyAgendaRows();
      throw error;
    }
  }

  private destroyAgendaRows(): void {
    this.agendaScroll?.cancel();
    for (const mount of this.agendaMounts.splice(0)) mount.destroy();
  }

  private renderEntry(container: HTMLElement, entry: CalendarDayEntry, date: LocalDate): void {
    const { occurrence } = entry;
    this.agendaMounts.push(
      this.callbacks.mountAgendaEntry(container, entry, date, {
        onActivate: () => {
          if (occurrence.kind === 'forecast')
            this.callbacks.onForecastClick?.(occurrence.source, occurrence.referenceDate);
          else this.callbacks.onTaskClick(entry.task);
        },
        onForecastContextMenu: (event, element) => {
          if (occurrence.kind === 'forecast')
            this.callbacks.forecastMenuOwner?.open(element, event, occurrence, this.callbacks);
        },
      }),
    );
  }

  destroy(): void {
    this.callbacks.forecastMenuOwner?.dismiss();
    this.destroyAgendaRows();
    this.buttons.clear();
    this.model = new Map();
    this.container = null;
    this.agenda = null;
  }
}
