import { Component, setIcon } from 'obsidian';
import { moment } from '../obsidianMoment';
import type { ResolvedConfig } from '../settings/types';
import type { LocalDate, TaskSnapshot } from '../tasks';
import { BaseView } from './BaseView';
import type { MonthGridViewCallbacks } from './MonthGridView';
import {
  buildCalendarDayModel,
  type CalendarDayEntry,
  type CalendarDaySummary,
} from './calendarDayModel';
import { renderAllDayBody, type CalendarItemCallbacks } from './timegrid/renderAllDay';
import { calendarOccurrenceLookup } from './timegrid/renderTaskMeta';

export interface ConstrainedCalendarViewCallbacks extends Omit<
  MonthGridViewCallbacks,
  'onDayClick' | 'onWeekClick' | 'onDrop' | 'onNativeDragStart' | 'onSpanMove' | 'onSpanBoundary'
> {
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
  private md = new Component();
  private itemCallbacks: CalendarItemCallbacks | null = null;

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
    this.itemCallbacks = { ...this.callbacks, occurrenceFor, component: this.md };
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
    if (this.agenda === null || this.itemCallbacks === null || summary === undefined) return;
    this.callbacks.forecastMenuOwner?.dismiss();
    this.md.unload();
    this.md = new Component();
    this.md.load();
    const callbacks = { ...this.itemCallbacks, component: this.md };
    for (const [day, button] of this.buttons)
      button.setAttribute('aria-pressed', String(day === date));
    const previous = this.agenda.dataset['calendarDate'];
    const scroll = previous === date ? this.agenda.scrollTop : 0;
    this.agenda.empty();
    this.agenda.dataset['calendarDate'] = date;
    this.agenda.createEl('h3', {
      cls: 'abyss-calendar-agenda-heading',
      text: moment(date).format('dddd, LL'),
    });
    const add = this.agenda.createEl('button', {
      cls: 'abyss-calendar-agenda-add',
      text: 'Add task',
      attr: { type: 'button' },
    });
    add.addEventListener('click', () => {
      this.callbacks.onCreateAtDate(date);
    });
    const entries = summary.entries;
    if (entries.length === 0)
      this.agenda.createEl('p', {
        cls: 'abyss-calendar-agenda-empty',
        text: 'No tasks for this day',
      });
    for (const entry of entries) this.renderEntry(entry, callbacks);
    this.agenda.scrollTop = scroll;
  }

  private renderEntry(entry: CalendarDayEntry, callbacks: CalendarItemCallbacks): void {
    if (this.agenda === null) return;
    const { task, occurrence, completion } = entry;
    const row = renderAllDayBody({
      cellEl: this.agenda,
      cls: 'abyss-calendar-agenda-item',
      task,
      callbacks,
      tagGroups: this.callbacks.tagGroups ?? [],
      interactive: true,
      activateBody: true,
      nativeDraggable: false,
      completion,
      continuity: completion.kind === 'continuation' ? 'continuation' : 'single',
      spanRole: 'agenda',
    });
    const context = [
      task.planning.time,
      ...(completion.kind === 'continuation' ? [`Until ${completion.due}`] : []),
    ]
      .filter(Boolean)
      .join(' · ');
    if (context !== '') row.createSpan({ cls: 'abyss-calendar-agenda-context', text: context });
    const details = row.createEl('button', {
      cls: 'abyss-calendar-details',
      attr: { type: 'button', 'aria-label': `Details: ${task.title}` },
    });
    setIcon(details, 'chevron-right');
    details.addEventListener('click', (event) => {
      event.stopPropagation();
      if (occurrence.kind === 'forecast')
        callbacks.onForecastClick?.(occurrence.source, occurrence.referenceDate);
      else callbacks.onTaskClick(task);
    });
  }

  destroy(): void {
    this.callbacks.forecastMenuOwner?.dismiss();
    this.md.unload();
    this.buttons.clear();
    this.model = new Map();
    this.container = null;
    this.agenda = null;
    this.itemCallbacks = null;
  }
}
