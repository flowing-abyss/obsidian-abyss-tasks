import type { Component } from 'obsidian';
import { setIcon } from 'obsidian';
import type { TaskOccurrencePresentation } from '../task-lists/taskOccurrencePresentation';
import {
  formatDurationMinutes,
  taskOccupiedDates,
  type DurationMinutes,
  type LocalDate,
  type TaskPlanning,
} from '../tasks';
import { renderSourceNoteContent, renderTaskTagContent } from './taskMetadataContent';
export interface TaskDateDisplayOptions {
  readonly completePlanning?: boolean;
  readonly formatDate: (date: LocalDate) => string;
  readonly getDateClass: (date: LocalDate) => string;
  readonly onDate?: (date: LocalDate) => void;
  readonly onTime?: (time: string) => void;
}
export interface TaskMetadataDisplay {
  readonly planning: TaskPlanning;
  readonly tags: readonly string[];
  readonly sourcePath?: string;
}
export interface TaskMetadataDisplayOptions extends TaskDateDisplayOptions {
  readonly owner: Component;
  readonly suppressToday: boolean;
  readonly getTagColor: (tag: string) => string | undefined;
  readonly showSource: (path: string) => boolean;
  readonly onTag?: (tag: string, excluded: boolean) => void;
  readonly onSource?: (path: string) => void;
}
export interface TaskMetadataDisplayMount {
  readonly host: HTMLElement;
  readonly values: ReadonlyMap<string, HTMLElement>;
  update(value: TaskMetadataDisplay, options: TaskMetadataDisplayOptions): void;
  destroy(): void;
}
export function taskDisplayDates(
  planning: TaskPlanning,
  occurrence?: Pick<TaskOccurrencePresentation, 'displayDate' | 'interval' | 'dateRoles'>,
): {
  readonly date: LocalDate | undefined;
  readonly interval: TaskOccurrencePresentation['interval'];
} {
  const date = occurrence?.displayDate ?? planning.due ?? planning.scheduled ?? planning.start;
  if (occurrence?.interval !== undefined) return { date, interval: occurrence.interval };
  if (occurrence?.dateRoles !== undefined) return { date, interval: undefined };
  const occupied = taskOccupiedDates(planning);
  return { date, interval: occupied.kind === 'interval' ? occupied : undefined };
}
export function renderTaskDateMetadata(
  host: HTMLElement,
  task: { planning: TaskPlanning },
  dates: ReturnType<typeof taskDisplayDates>,
  options: TaskDateDisplayOptions & { readonly suppressToday: boolean },
): ReadonlyMap<string, HTMLElement> {
  if (options.completePlanning === true)
    return renderCompletePlanning(host, task.planning, options);
  const values = new Map<string, HTMLElement>();
  const { date, interval } = dates;
  const time = task.planning.time;
  const renderDate = (host: HTMLElement, value: LocalDate, showIcon = true): void => {
    const element = renderDateFilterPart(host, value, options, showIcon);
    for (const key of ['due', 'scheduled', 'start'] as const)
      if (task.planning[key] === value) values.set(`${key}:${value}`, element);
  };
  const renderTime = (host: HTMLElement, value: string, className: string): void => {
    values.set(`time:${value}`, renderTimeFilterPart(host, value, className, options));
  };
  if (interval !== undefined) {
    const dateElement = host.createSpan({ cls: 'abyss-task-date' });
    const icon = dateElement.createSpan({
      cls: 'abyss-date-icon',
      attr: { 'aria-hidden': 'true' },
    });
    const glyph = icon.createSvg('svg', {
      attr: {
        viewBox: '0 0 24 24',
        width: '16',
        height: '16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1',
        'aria-hidden': 'true',
      },
    });
    glyph.createSvg('path', { attr: { d: 'M4 6v12M4 12h16M20 6v12' } });
    renderDate(dateElement, interval.start, false);
    dateElement.createSpan({ text: '–' });
    renderDate(dateElement, interval.due, false);
    if (time != null) renderTime(dateElement, time, 'abyss-task-time-part');
    return values;
  }
  if (date != null && !options.suppressToday) {
    const dateElement = host.createSpan({
      cls: `abyss-task-date ${options.getDateClass(date)}`.trim(),
    });
    renderDate(dateElement, date);
    if (time != null) renderTime(dateElement, time, 'abyss-task-time-part');
    return values;
  }
  if (time != null) renderTime(host, time, 'abyss-task-date');
  return values;
}

export function taskTimeText(
  time: string | undefined,
  duration: DurationMinutes | undefined,
): string {
  const amount = duration === undefined ? '' : formatDurationMinutes(duration);
  return time === undefined ? amount : [time, amount].filter((part) => part !== '').join(' · ');
}
function renderCompletePlanning(
  host: HTMLElement,
  planning: TaskPlanning,
  options: TaskDateDisplayOptions,
): ReadonlyMap<string, HTMLElement> {
  const values = new Map<string, HTMLElement>();
  for (const role of ['start', 'scheduled', 'due'] as const) {
    const date = planning[role];
    if (date === undefined) continue;
    const chip = host.createSpan({ cls: 'abyss-task-date' });
    const part = renderDateFilterPart(chip, date, options);
    part.setAttribute('aria-label', `${role}: ${options.formatDate(date)}`);
    values.set(`${role}:${date}`, part);
  }
  renderCompleteTime(host, planning, options, values);
  return values;
}
function renderCompleteTime(
  host: HTMLElement,
  planning: TaskPlanning,
  options: TaskDateDisplayOptions,
  values: Map<string, HTMLElement>,
): void {
  if (taskTimeText(planning.time, planning.duration) === '') return;
  const chip = host.createSpan({ cls: 'abyss-task-date' });
  setIcon(chip.createSpan({ cls: 'abyss-date-icon' }), 'clock');
  if (planning.time !== undefined) {
    values.set(
      `time:${planning.time}`,
      renderTimeFilterPart(chip, planning.time, 'abyss-task-time-part', {
        ...options,
        showIcon: false,
      }),
    );
  }
  if (planning.duration !== undefined) {
    if (planning.time !== undefined)
      chip.createSpan({ text: ' · ', attr: { 'aria-hidden': 'true' } });
    const part = chip.createSpan({
      cls: 'abyss-task-time-part',
      text: taskTimeText(undefined, planning.duration),
    });
    part.setAttribute('aria-label', `Duration: ${String(planning.duration)} minutes`);
    values.set(`duration:${String(planning.duration)}`, part);
  }
}

export function renderDateFilterPart(
  host: HTMLElement,
  date: LocalDate,
  options: TaskDateDisplayOptions,
  showIcon = true,
): HTMLElement {
  const part = host.createSpan({ cls: 'abyss-task-date-part abyss-cursor-pointer' });
  if (showIcon) {
    const icon = part.createSpan({ cls: 'abyss-date-icon' });
    setIcon(icon, 'calendar');
  }
  part.createSpan({ text: options.formatDate(date) });
  part.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onDate?.(date);
  });
  return part;
}

export function renderTimeFilterPart(
  host: HTMLElement,
  time: string,
  className: string,
  options: TaskDateDisplayOptions & { readonly showIcon?: boolean },
): HTMLElement {
  const part = host.createSpan({ cls: `${className} abyss-cursor-pointer` });
  if (options.showIcon !== false) setIcon(part.createSpan({ cls: 'abyss-date-icon' }), 'clock');
  part.createSpan({ text: time });
  part.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onTime?.(time);
  });
  return part;
}

class MetadataDisplay implements TaskMetadataDisplayMount {
  readonly host: HTMLElement;
  readonly values = new Map<string, HTMLElement>();
  private readonly dates: HTMLElement;
  private readonly source: HTMLElement;
  private readonly tags = new Map<string, HTMLElement>();
  private options: TaskMetadataDisplayOptions;
  private dateKey = '';
  private sourceKey = '';
  private dateValues: ReadonlyMap<string, HTMLElement> = new Map();
  constructor(
    parent: HTMLElement,
    value: TaskMetadataDisplay,
    options: TaskMetadataDisplayOptions,
  ) {
    this.host = parent.createDiv({ cls: 'abyss-task-meta-right' });
    this.dates = this.host.createSpan();
    this.source = this.host.createSpan();
    this.options = options;
    this.update(value, options);
  }
  update(next: TaskMetadataDisplay, options: TaskMetadataDisplayOptions): void {
    this.options = options;
    this.updateDates(next);
    this.values.clear();
    for (const [key, element] of this.dateValues) this.values.set(key, element);
    this.updateSource(next.sourcePath);
    this.updateTags(next.tags);
    this.host.hidden =
      this.dates.childElementCount === 0 &&
      this.source.childElementCount === 0 &&
      this.tags.size === 0;
  }
  private updateDates(next: TaskMetadataDisplay): void {
    const dates = taskDisplayDates(next.planning);
    const options = this.options;
    const key = JSON.stringify([
      next.planning,
      options.suppressToday,
      options.completePlanning,
      dates.date === undefined ? '' : options.formatDate(dates.date),
    ]);
    if (key === this.dateKey) return;
    this.dates.empty();
    this.dateKey = key;
    this.dateValues = renderTaskDateMetadata(this.dates, next, dates, {
      suppressToday: options.suppressToday,
      ...(options.completePlanning === undefined
        ? {}
        : { completePlanning: options.completePlanning }),
      formatDate: (date) => this.options.formatDate(date),
      getDateClass: (date) => this.options.getDateClass(date),
      onDate: (date) => {
        this.options.onDate?.(date);
      },
      onTime: (time) => {
        this.options.onTime?.(time);
      },
    });
  }
  private updateSource(sourcePath: string | undefined): void {
    const path = sourcePath !== undefined && this.options.showSource(sourcePath) ? sourcePath : '';
    if (path === this.sourceKey) return;
    this.source.empty();
    this.sourceKey = path;
    if (path === '') return;
    const chip = renderSourceNoteContent(this.source, path);
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      this.options.onSource?.(path);
    });
  }
  private updateTags(next: readonly string[]): void {
    for (const [tag, element] of this.tags) {
      if (next.includes(tag)) continue;
      element.remove();
      this.tags.delete(tag);
    }
    for (const tag of next) {
      let element = this.tags.get(tag);
      if (element === undefined) {
        element = renderTaskTagContent(this.host, tag, this.options.getTagColor(tag));
        this.tags.set(tag, element);
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          this.options.onTag?.(tag, event.altKey);
        });
      }
      this.values.set(`tag:${tag}`, element);
    }
  }
  destroy(): void {
    this.host.remove();
  }
}
export function mountTaskMetadataDisplay(
  parent: HTMLElement,
  value: TaskMetadataDisplay,
  options: TaskMetadataDisplayOptions,
): TaskMetadataDisplayMount {
  return new MetadataDisplay(parent, value, options);
}
