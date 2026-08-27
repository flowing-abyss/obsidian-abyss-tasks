import { Platform } from 'obsidian';
import type {
  ProjectCommandService,
  ProjectRangeCommandResult,
} from '../../projects/ProjectCommandService';
import { parseProjectDate, projectDateOnLocalDate } from '../../projects/projectDates';
import type { Project, ProjectAction, ProjectDateValue } from '../../projects/types';
import type { WorkNoteCommandService } from '../../projects/work-notes/WorkNoteCommandService';
import type { WorkNoteCommandResult, WorkNoteSnapshot } from '../../projects/work-notes/types';
import type { TaskCommandResult, TaskSnapshot } from '../../tasks';
import { BoundedWindow } from './BoundedWindow';
import { logicalViewportFirst, type LogicalViewportSession } from './ProjectWorkspaceSession';
import type { TimelineItem, TimelinePointRole, TimelineProjection } from './timelineProjection';
import {
  projectTimelineEntry,
  taskTimelineEntry,
  workNoteTimelineEntry,
} from './timelineProjection';

const TIMELINE_ROW_EXTENT = 72;
const TIMELINE_FALLBACK_VISIBLE_ROWS = 12;
const TIMELINE_OVERSCAN = 5;
const TIMELINE_DIAGNOSTIC_ROW_EXTENT = 32;
const TIMELINE_DIAGNOSTIC_VISIBLE_ROWS = 7;

export type TimelineEntry<T> = TimelineProjection<T>;

interface TimelineMutationResult {
  readonly type: string;
}

export interface TimelineViewOptions<T> {
  readonly entries: readonly TimelineEntry<T>[];
  readonly onSetDate?: (
    entry: TimelineEntry<T>,
    role: TimelinePointRole,
    date: string,
    initiator: HTMLElement,
  ) => Promise<TimelineMutationResult> | TimelineMutationResult;
  readonly dateWindow?: { readonly from: string; readonly to: string };
  readonly session?: LogicalViewportSession;
  readonly isNarrow?: boolean;
  readonly renderIdentity?: (host: HTMLElement, entry: TimelineEntry<T>) => void;
}

export interface TimelineViewHandle {
  destroy(): void;
}

export interface ProjectsTimelineOptions {
  readonly projects: readonly Project[];
  readonly commands: ProjectCommandService;
  readonly session?: LogicalViewportSession;
  readonly isNarrow?: boolean;
  readonly onMutation?: (project: Project, result: ProjectRangeCommandResult) => void;
}

export interface WorkNotesTimelineOptions {
  readonly notes: readonly WorkNoteSnapshot[];
  readonly commands: WorkNoteCommandService;
  readonly commandsEnabled?: boolean;
  readonly session?: LogicalViewportSession;
  readonly isNarrow?: boolean;
  readonly onMutation?: (note: WorkNoteSnapshot, result: WorkNoteCommandResult) => void;
}

export interface TasksTimelineOptions {
  readonly actions: readonly ProjectAction[];
  readonly session?: LogicalViewportSession;
  readonly isNarrow?: boolean;
  readonly renderTask?: (host: HTMLElement, task: TaskSnapshot) => void;
  readonly onSetDate: (
    task: TaskSnapshot,
    role: Exclude<TimelinePointRole, 'milestone'>,
    date: string,
  ) => Promise<TaskCommandResult> | TaskCommandResult;
}

interface DragIntent<T> {
  readonly entry: TimelineEntry<T>;
  readonly role: TimelinePointRole;
  readonly initiator: HTMLElement;
}

function civilDate(raw: string | undefined): string | undefined {
  const candidate = raw?.slice(0, 10);
  return candidate && /^\d{4}-\d{2}-\d{2}$/u.test(candidate) ? candidate : undefined;
}

function shiftCivilDate(raw: string, days: number): string | undefined {
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function datesBetween(from: string, to: string): readonly string[] {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
  const spanDays = Math.round((toMs - fromMs) / 86_400_000);
  const slots = Math.min(42, spanDays + 1);
  const dates = new Set<string>();
  for (let index = 0; index < slots; index += 1) {
    const offset = slots === 1 ? 0 : Math.round((spanDays * index) / (slots - 1));
    const date = shiftCivilDate(from, offset);
    if (date) dates.add(date);
  }
  return [...dates];
}

function datePosition(date: string, from: string, to: string): number | undefined {
  const dateMs = Date.parse(`${date}T00:00:00.000Z`);
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (![dateMs, fromMs, toMs].every(Number.isFinite) || dateMs < fromMs || dateMs > toMs) {
    return undefined;
  }
  if (fromMs === toMs) return 50;
  return ((dateMs - fromMs) / (toMs - fromMs)) * 100;
}

function inferredDateWindow<T>(
  entries: readonly TimelineEntry<T>[],
): { readonly from: string; readonly to: string } | undefined {
  const dates = entries.flatMap(({ dateByRole }) =>
    Object.values(dateByRole).flatMap((raw) => {
      const date = civilDate(raw);
      return date ? [date] : [];
    }),
  );
  if (dates.length === 0) return undefined;
  dates.sort((left, right) => left.localeCompare(right));
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}

function pointRoles(item: TimelineItem): readonly TimelinePointRole[] {
  if (item.kind === 'range') return ['start', 'end'];
  if (item.kind === 'point') return [item.role];
  return [];
}

function roleLabel(role: TimelinePointRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function successful(result: TimelineMutationResult): boolean {
  return result.type === 'ok' || result.type === 'unchanged';
}

function renderEntryIdentity<T>(
  host: HTMLElement,
  entry: TimelineEntry<T>,
  renderIdentity: TimelineViewOptions<T>['renderIdentity'],
): void {
  if (renderIdentity) {
    renderIdentity(host, entry);
    return;
  }
  host.createSpan({ cls: 'abyss-timeline-title', text: entry.label });
  if (entry.detail) host.createSpan({ cls: 'abyss-timeline-detail', text: entry.detail });
}

/** Semantically neutral bounded Timeline shell shared by Project, Work Note, and Task adapters. */
export function renderTimeline<T>(
  container: HTMLElement,
  options: TimelineViewOptions<T>,
): TimelineViewHandle {
  container.addClass('abyss-timeline-host');
  const isAgenda = options.isNarrow === true || Platform.isMobile;
  const root = container.createDiv({
    cls: `abyss-timeline${isAgenda ? ' is-agenda' : ''}`,
  });
  const feedback = root.createDiv({
    cls: 'abyss-timeline-feedback',
    attr: {
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      'data-timeline-feedback': '',
    },
  });
  const dated = options.entries.filter(
    (entry) => entry.item.kind === 'range' || entry.item.kind === 'point',
  );
  const undated = options.entries.filter((entry) => entry.item.kind === 'undated');
  const invalid = options.entries.filter((entry) => entry.item.kind === 'invalid');
  const window = options.dateWindow ?? inferredDateWindow(dated);
  const dates = window ? datesBetween(window.from, window.to) : [];
  let dragging: DragIntent<T> | null = null;
  let destroyed = false;
  const cleanups: Array<() => void> = [];

  const commit = (
    entry: TimelineEntry<T>,
    role: TimelinePointRole,
    date: string,
    initiator: HTMLElement,
  ): void => {
    if (!options.onSetDate) return;
    const command = (): Promise<TimelineMutationResult> =>
      Promise.resolve(options.onSetDate!(entry, role, date, initiator));
    void command()
      .then((result) => {
        if (successful(result)) {
          feedback.empty();
          delete feedback.dataset['resultType'];
          return;
        }
        feedback.dataset['resultType'] = result.type;
        feedback.setText('Timeline date was not changed.');
        if (initiator.isConnected) initiator.focus({ preventScroll: true });
      })
      .catch(() => {
        feedback.dataset['resultType'] = 'io-error';
        feedback.setText('Timeline date could not be changed.');
        if (initiator.isConnected) initiator.focus({ preventScroll: true });
      });
  };

  if (dated.length > 0) {
    const datedSection = root.createDiv({ cls: 'abyss-timeline-dated' });
    if (!isAgenda) {
      const axis = datedSection.createDiv({
        cls: 'abyss-timeline-axis',
        attr: { 'aria-hidden': 'true' },
      });
      axis.createDiv({ cls: 'abyss-timeline-axis-label' });
      const axisDates = axis.createDiv({ cls: 'abyss-timeline-axis-dates' });
      axisDates.style.setProperty('--abyss-timeline-days', String(Math.max(1, dates.length)));
      for (const date of dates) axisDates.createSpan({ text: date.slice(5) });
    }
    const scroll = datedSection.createDiv({ cls: 'abyss-timeline-scroll' });
    const rows = scroll.createDiv({
      cls: 'abyss-timeline-rows',
      attr: { tabindex: '-1', 'aria-label': 'Timeline items' },
    });
    const bounded = new BoundedWindow(
      dated.map(({ item }) => item.key),
      TIMELINE_OVERSCAN,
    );
    const session = options.session;
    if (session?.focusedKey) bounded.focus(session.focusedKey);
    const initialFirst = logicalViewportFirst(
      session,
      dated.map(({ item }) => item.key),
    );
    const viewport = (seedFirst?: number): { first: number; visible: number } => ({
      first: seedFirst ?? Math.floor(Math.max(0, scroll.scrollTop) / TIMELINE_ROW_EXTENT),
      visible:
        scroll.clientHeight > 0
          ? Math.ceil(scroll.clientHeight / TIMELINE_ROW_EXTENT)
          : TIMELINE_FALLBACK_VISIBLE_ROWS,
    });

    const renderWindow = (restoreFocus = false, seedFirst?: number): void => {
      if (destroyed) return;
      const result = bounded.render(rows, {
        ...viewport(seedFirst),
        itemExtent: TIMELINE_ROW_EXTENT,
        restoreFocus,
        render: (host, _key, logicalIndex) => {
          const entry = dated[logicalIndex]!;
          const row = host.createDiv({
            cls: `abyss-timeline-row${isAgenda ? ' abyss-timeline-agenda-row' : ''}`,
            attr: {
              role: 'group',
              tabindex: '0',
              'data-timeline-key': entry.item.key,
              'aria-label': entry.label,
            },
          });
          const identity = row.createDiv({ cls: 'abyss-timeline-identity' });
          renderEntryIdentity(identity, entry, options.renderIdentity);
          const roles = pointRoles(entry.item);
          if (isAgenda) {
            const dateText = roles
              .map((role) => `${roleLabel(role)} ${civilDate(entry.dateByRole[role]) ?? 'Undated'}`)
              .join(' – ');
            identity.createSpan({ cls: 'abyss-timeline-agenda-date', text: dateText });
          }
          const plot = row.createDiv({ cls: 'abyss-timeline-plot' });
          if (!isAgenda) {
            plot.style.setProperty('--abyss-timeline-days', String(Math.max(1, dates.length)));
            for (const date of dates) {
              const cell = plot.createDiv({
                cls: 'abyss-timeline-drop-cell',
                attr: { 'data-timeline-drop-date': date, 'aria-hidden': 'true' },
              });
              const onDragOver = (event: DragEvent): void => {
                if (!dragging) return;
                event.preventDefault();
              };
              const onDrop = (event: Event): void => {
                if (!dragging) return;
                event.preventDefault();
                const intent = dragging;
                dragging = null;
                commit(intent.entry, intent.role, date, intent.initiator);
              };
              cell.addEventListener('dragover', onDragOver);
              cell.addEventListener('drop', onDrop);
              cleanups.push(() => {
                cell.removeEventListener('dragover', onDragOver);
                cell.removeEventListener('drop', onDrop);
              });
            }
            if (entry.item.kind === 'range') {
              const start = civilDate(entry.dateByRole.start);
              const end = civilDate(entry.dateByRole.end);
              const startPosition =
                start && window ? datePosition(start, window.from, window.to) : undefined;
              const endPosition =
                end && window ? datePosition(end, window.from, window.to) : undefined;
              if (
                startPosition !== undefined &&
                endPosition !== undefined &&
                endPosition >= startPosition
              ) {
                const bar = plot.createDiv({
                  cls: 'abyss-timeline-range',
                  attr: { 'data-timeline-range': '', 'aria-hidden': 'true' },
                });
                bar.style.insetInlineStart = `${String(startPosition)}%`;
                bar.style.inlineSize = `${String(Math.max(1, endPosition - startPosition))}%`;
              }
            } else if (entry.item.kind === 'point') {
              const pointDate = civilDate(entry.dateByRole[entry.item.role]);
              const pointPosition =
                pointDate && window ? datePosition(pointDate, window.from, window.to) : undefined;
              if (pointPosition !== undefined) {
                const point = plot.createDiv({
                  cls: 'abyss-timeline-point',
                  attr: {
                    'data-timeline-point': entry.item.role,
                    'aria-hidden': 'true',
                  },
                });
                point.style.insetInlineStart = `${String(pointPosition)}%`;
              }
            }
          }
          const controls = row.createDiv({ cls: 'abyss-timeline-date-controls' });
          for (const role of roles) {
            const handle = controls.createEl('button', {
              cls: 'abyss-timeline-date-handle',
              text: roleLabel(role),
              attr: {
                type: 'button',
                draggable: 'true',
                'data-timeline-role': role,
                'aria-label': `Move ${entry.label} ${role} date`,
                title: `Move ${role} date`,
              },
            });
            const current = civilDate(entry.dateByRole[role]);
            const onKeydown = (event: KeyboardEvent): void => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              if (!current) return;
              const next = shiftCivilDate(current, event.key === 'ArrowLeft' ? -1 : 1);
              if (!next) return;
              event.preventDefault();
              commit(entry, role, next, handle);
            };
            const onDragStart = (): void => {
              dragging = { entry, role, initiator: handle };
            };
            handle.addEventListener('keydown', onKeydown);
            handle.addEventListener('dragstart', onDragStart);
            const picker = controls.createEl('input', {
              cls: 'abyss-timeline-date-picker',
              attr: {
                type: 'date',
                'data-timeline-date-picker': role,
                'aria-label': `Choose ${entry.label} ${role} date`,
                ...(current ? { value: current } : {}),
              },
            });
            picker.disabled = options.onSetDate === undefined;
            handle.disabled = options.onSetDate === undefined;
            const onChange = (): void => {
              if (picker.value) commit(entry, role, picker.value, picker);
            };
            picker.addEventListener('change', onChange);
            cleanups.push(() => {
              handle.removeEventListener('keydown', onKeydown);
              handle.removeEventListener('dragstart', onDragStart);
              picker.removeEventListener('change', onChange);
            });
          }
          row.addEventListener('focusin', () => {
            bounded.focus(entry.item.key);
            if (session) {
              session.focusedKey = entry.item.key;
              session.restoreFocus = true;
            }
          });
          return row;
        },
      });
      if (restoreFocus || seedFirst !== undefined) {
        scroll.scrollTop = result.first * TIMELINE_ROW_EXTENT;
      }
    };
    const rememberViewport = (): void => {
      if (!session) return;
      session.firstIndex = viewport().first;
      session.firstKey = dated[session.firstIndex]?.item.key ?? null;
    };
    const onScroll = (): void => {
      rememberViewport();
      renderWindow(false);
    };
    scroll.addEventListener('scroll', onScroll);
    cleanups.push(() => scroll.removeEventListener('scroll', onScroll));
    renderWindow(session?.restoreFocus === true, initialFirst);
    rememberViewport();
  }

  const renderDiagnosticSection = (
    entries: readonly TimelineEntry<T>[],
    className: string,
    heading: string,
  ): void => {
    if (entries.length === 0) return;
    const section = root.createDiv({ cls: className });
    section.createEl('h4', { text: heading });
    const scroll = section.createDiv({
      cls: 'abyss-timeline-diagnostic-scroll',
      attr: { tabindex: '0', 'aria-label': heading },
    });
    const rows = scroll.createDiv({ cls: 'abyss-timeline-diagnostic-rows' });
    const bounded = new BoundedWindow(
      entries.map(({ item }) => item.key),
      TIMELINE_OVERSCAN,
    );
    const renderWindow = (): void => {
      bounded.render(rows, {
        first: Math.floor(Math.max(0, scroll.scrollTop) / TIMELINE_DIAGNOSTIC_ROW_EXTENT),
        visible:
          scroll.clientHeight > 0
            ? Math.ceil(scroll.clientHeight / TIMELINE_DIAGNOSTIC_ROW_EXTENT)
            : TIMELINE_DIAGNOSTIC_VISIBLE_ROWS,
        itemExtent: TIMELINE_DIAGNOSTIC_ROW_EXTENT,
        render: (host, _key, logicalIndex) => {
          const entry = entries[logicalIndex]!;
          const row = host.createDiv({ cls: 'abyss-timeline-diagnostic-row' });
          row.createSpan({ text: entry.label });
          if (entry.item.kind === 'invalid') {
            row.createSpan({ cls: 'abyss-timeline-diagnostic-reason', text: entry.item.reason });
          }
          return row;
        },
      });
    };
    scroll.addEventListener('scroll', renderWindow);
    cleanups.push(() => scroll.removeEventListener('scroll', renderWindow));
    renderWindow();
  };
  renderDiagnosticSection(undated, 'abyss-timeline-undated', 'Undated');
  renderDiagnosticSection(invalid, 'abyss-timeline-invalid', 'Invalid dates');

  return {
    destroy: () => {
      destroyed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      container.empty();
    },
  };
}

function movedProjectDate(current: ProjectDateValue | undefined, date: string) {
  return current ? projectDateOnLocalDate(current, date) : parseProjectDate(date);
}

/** Project projection/command adapter for the shared Timeline shell. */
export function renderProjectsTimeline(
  container: HTMLElement,
  options: ProjectsTimelineOptions,
): TimelineViewHandle {
  return renderTimeline(container, {
    entries: options.projects.map(projectTimelineEntry),
    ...(options.session && { session: options.session }),
    ...(options.isNarrow !== undefined && { isNarrow: options.isNarrow }),
    onSetDate: async (entry, role, date) => {
      if (role !== 'start' && role !== 'end') return { type: 'invalid', issue: 'invalid-start' };
      const value = movedProjectDate(entry.value.range[role], date);
      if (!value) return { type: 'invalid', issue: `invalid-${role}` };
      const result = await options.commands.setRange(options.commands.observeRange(entry.value), {
        [role]: value,
      });
      options.onMutation?.(entry.value, result);
      return result;
    },
  });
}

/** Guarded Work Note projection/command adapter for the shared Timeline shell. */
export function renderWorkNotesTimeline(
  container: HTMLElement,
  options: WorkNotesTimelineOptions,
): TimelineViewHandle {
  const prepared = options.notes.map((note) => ({
    entry: workNoteTimelineEntry(note),
    observation: options.commandsEnabled === false ? null : options.commands.observeRange(note),
  }));
  const observations = new Map(
    prepared.map(({ entry, observation }) => [entry.item.key, observation] as const),
  );
  const onSetDate = async (
    entry: TimelineEntry<WorkNoteSnapshot>,
    role: TimelinePointRole,
    date: string,
  ): Promise<WorkNoteCommandResult> => {
    const field = role === 'milestone' ? 'end' : role;
    if (field !== 'start' && field !== 'end') return { type: 'invalid', field };
    const observation = observations.get(entry.item.key);
    if (!observation) return { type: 'invalid', field: 'path' };
    const current = role === 'milestone' ? observation.updated : observation[field];
    const value = movedProjectDate(current, date);
    if (!value) return { type: 'invalid', field };
    const result = await options.commands.setRange(observation.observed, { [field]: value });
    options.onMutation?.(entry.value, result);
    return result;
  };
  return renderTimeline(container, {
    entries: prepared.map(({ entry }) => entry),
    ...(options.session && { session: options.session }),
    ...(options.isNarrow !== undefined && { isNarrow: options.isNarrow }),
    ...(options.commandsEnabled === false ? {} : { onSetDate }),
  });
}

/** Task projection/application-command adapter for the shared Timeline shell. */
export function renderTasksTimeline(
  container: HTMLElement,
  options: TasksTimelineOptions,
): TimelineViewHandle {
  return renderTimeline(container, {
    entries: options.actions.map(({ task }) => taskTimelineEntry(task)),
    ...(options.session && { session: options.session }),
    ...(options.isNarrow !== undefined && { isNarrow: options.isNarrow }),
    ...(options.renderTask
      ? {
          renderIdentity: (host: HTMLElement, entry: TimelineEntry<TaskSnapshot>) =>
            options.renderTask?.(host, entry.value),
        }
      : {}),
    onSetDate: (entry, role, date) => {
      if (role === 'milestone') throw new Error('Task Timeline milestone mutation unavailable');
      return options.onSetDate(entry.value, role, date);
    },
  });
}
