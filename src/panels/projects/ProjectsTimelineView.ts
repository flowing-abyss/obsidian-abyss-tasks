import { Platform } from 'obsidian';
import type {
  ProjectCommandService,
  ProjectRangeCommandResult,
} from '../../projects/ProjectCommandService';
import { parseProjectDate, projectDateOnLocalDate } from '../../projects/projectDates';
import type { Project, ProjectAction, ProjectDateValue } from '../../projects/types';
import type { WorkNoteCommandService } from '../../projects/work-notes/WorkNoteCommandService';
import type { WorkNoteCommandResult, WorkNoteSnapshot } from '../../projects/work-notes/types';
import { taskReconciliationKey, type TaskCommandResult, type TaskSnapshot } from '../../tasks';
import { inspectorSelectionKey } from '../../ui/inspector/InspectorSelection';
import { BoundedWindow } from './BoundedWindow';
import type { ProjectTaskCollectionSession } from './ProjectTaskCollectionSession';
import {
  logicalViewportFirst,
  type LogicalViewportSession,
  type TimelinePresentationSession,
} from './ProjectWorkspaceSession';
import {
  TimelineInteractionController,
  type TimelineCommitIntent,
  type TimelineProjection as TimelineInteractionProjection,
  type TimelineInteractionTarget,
} from './TimelineInteractionController';
import {
  civilDateToX,
  createTimelineViewport,
  geometryForTimelineItem,
  timelineDateAtX,
  type TimelineViewport,
} from './TimelineViewport';
import {
  clampTimelineIdentityWidth,
  defaultTimelineScale,
  isTimelineScale,
  type PortfolioTimelineScale,
  type TaskTimelineScale,
  type TimelineScale,
  type TimelineScope,
  type WorkNoteTimelineScale,
} from './timelinePreferences';
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
  readonly session?: LogicalViewportSession | TimelinePresentationSession<TimelineScope>;
  readonly focusedItemKey?: () => string | null;
  readonly shouldRestoreItemFocus?: () => boolean;
  readonly onItemFocus?: (entry: TimelineEntry<T>) => void;
  readonly onItemBlur?: () => void;
  readonly isNarrow?: boolean;
  readonly renderIdentity?: (host: HTMLElement, entry: TimelineEntry<T>) => void;
  readonly scope?: TimelineScope;
  readonly scale?: TimelineScale<TimelineScope>;
  readonly identityWidth?: number;
  readonly today?: string;
  readonly coarsePointer?: boolean;
  readonly undatedRole?: TimelinePointRole;
  readonly onPresentationChange?: (presentation: {
    readonly scale: TimelineScale<TimelineScope>;
    readonly identityWidth: number;
  }) => void | Promise<void>;
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
  readonly openProject?: (path: string) => void;
  readonly scale?: PortfolioTimelineScale;
  readonly identityWidth?: number;
  readonly onPresentationChange?: (presentation: {
    readonly scale: PortfolioTimelineScale;
    readonly identityWidth: number;
  }) => void | Promise<void>;
}

export interface WorkNotesTimelineOptions {
  readonly notes: readonly WorkNoteSnapshot[];
  readonly commands: WorkNoteCommandService;
  readonly commandsEnabled?: boolean;
  readonly session?: LogicalViewportSession;
  readonly isNarrow?: boolean;
  readonly onMutation?: (note: WorkNoteSnapshot, result: WorkNoteCommandResult) => void;
  readonly openNote?: (path: string) => void;
  readonly onSelect?: (note: WorkNoteSnapshot, origin: HTMLElement) => void;
  readonly scale?: WorkNoteTimelineScale;
  readonly identityWidth?: number;
  readonly onPresentationChange?: (presentation: {
    readonly scale: WorkNoteTimelineScale;
    readonly identityWidth: number;
  }) => void | Promise<void>;
}

export interface TasksTimelineOptions {
  readonly actions: readonly ProjectAction[];
  readonly session?: LogicalViewportSession;
  readonly collectionSession?: ProjectTaskCollectionSession;
  readonly isNarrow?: boolean;
  readonly renderTask?: (host: HTMLElement, action: ProjectAction) => void;
  readonly onSetDate: (
    task: TaskSnapshot,
    role: Exclude<TimelinePointRole, 'milestone'>,
    date: string,
  ) => Promise<TaskCommandResult> | TaskCommandResult;
  readonly scale?: TaskTimelineScale;
  readonly identityWidth?: number;
  readonly onPresentationChange?: (presentation: {
    readonly scale: TaskTimelineScale;
    readonly identityWidth: number;
  }) => void | Promise<void>;
}

type TimelineSessionState = LogicalViewportSession &
  Partial<TimelinePresentationSession<TimelineScope>>;

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

function continuousDates(from: string, to: string): readonly string[] {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
  const spanDays = Math.round((toMs - fromMs) / 86_400_000);
  return Array.from({ length: spanDays + 1 }, (_, index) => shiftCivilDate(from, index)!).filter(
    Boolean,
  );
}

function presentationDates(dates: readonly string[]): readonly string[] {
  const maximumLabels = 8;
  if (dates.length <= maximumLabels) return dates;
  return Array.from(
    { length: maximumLabels },
    (_, index) => dates[Math.round(((dates.length - 1) * index) / (maximumLabels - 1))]!,
  );
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

function timelineIdentityAttributes(key: string): Record<string, string> {
  return { 'data-timeline-key': key };
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

function timelineRowFocusTarget(row: HTMLElement, identity: HTMLElement): HTMLElement {
  const focusTarget =
    row.querySelector<HTMLElement>('[data-timeline-primary]:not(:disabled)') ??
    row.querySelector<HTMLElement>('.abyss-timeline-date-picker:not(:disabled)') ??
    identity.querySelector<HTMLElement>('button, a[href], [role="button"]');
  if (focusTarget) return focusTarget;
  row.tabIndex = -1;
  return row;
}

/** Semantically neutral bounded Timeline shell shared by Project, Work Note, and Task adapters. */
export function renderTimeline<T>(
  container: HTMLElement,
  options: TimelineViewOptions<T>,
): TimelineViewHandle {
  container.addClass('abyss-timeline-host');
  const isAgenda = options.isNarrow === true || Platform.isMobile;
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const session: TimelineSessionState | undefined = options.session;
  const scope = options.scope ?? 'workNotes';
  const requestedScale = options.scale ?? session?.scale;
  let scale: TimelineScale<TimelineScope> = isTimelineScale(scope, requestedScale)
    ? requestedScale
    : defaultTimelineScale(scope);
  let identityWidth = clampTimelineIdentityWidth(options.identityWidth ?? session?.identityWidth);
  const root = container.createDiv({
    cls: `abyss-timeline${isAgenda ? ' is-agenda' : ''}`,
  });
  root.style.setProperty('--abyss-timeline-identity-width', `${String(identityWidth)}px`);
  const toolbar = root.createDiv({ cls: 'abyss-timeline-toolbar' });
  const scaleLabel = toolbar.createEl('label', { cls: 'abyss-timeline-scale-control' });
  scaleLabel.createSpan({ cls: 'abyss-visually-hidden', text: 'Timeline scale' });
  const scaleSelect = scaleLabel.createEl('select', {
    attr: { 'data-timeline-scale': '', 'aria-label': 'Timeline scale' },
  });
  const scaleOptions: Readonly<Record<TimelineScope, readonly TimelineScale<TimelineScope>[]>> = {
    portfolio: ['week', 'month', 'quarter', 'year'],
    tasks: ['day', 'week', 'month'],
    workNotes: ['day', 'week', 'month', 'quarter', 'year'],
  };
  for (const candidate of scaleOptions[scope]) {
    const option = scaleSelect.createEl('option', {
      text: candidate.charAt(0).toUpperCase() + candidate.slice(1),
      attr: { value: candidate },
    });
    option.selected = candidate === scale;
  }
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const todayButton = toolbar.createEl('button', {
    cls: 'abyss-timeline-today abyss-timeline-touch-target',
    text: 'Today',
    attr: { type: 'button', 'data-timeline-today': '' },
  });
  const coarsePointer =
    options.coarsePointer === true ||
    isAgenda ||
    ownerWindow?.matchMedia?.('(pointer: coarse)').matches === true;
  if (coarsePointer) {
    const identityMenu = toolbar.createEl('details', { cls: 'abyss-timeline-identity-menu' });
    identityMenu.createEl('summary', {
      cls: 'abyss-timeline-touch-target',
      text: 'Columns',
      attr: { 'aria-label': 'Timeline identity column width' },
    });
    for (const preset of ['compact', 'default', 'wide'] as const) {
      identityMenu.createEl('button', {
        cls: 'abyss-timeline-touch-target',
        text: preset.charAt(0).toUpperCase() + preset.slice(1),
        attr: { type: 'button', 'data-timeline-identity-preset': preset },
      });
    }
  }
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
  const dates = window ? continuousDates(window.from, window.to) : [];
  let destroyed = false;
  const cleanups: Array<() => void> = [];
  let controller: TimelineInteractionController<string> | undefined;
  let initiatingElement: HTMLElement = root;
  let autoscrollFrame: number | null = null;
  let autoscrollDirection: -1 | 0 | 1 = 0;
  let autoscrollSpeed = 0;
  const scheduleEntryByInput = new WeakMap<HTMLInputElement, TimelineEntry<T>>();

  const commit = async (
    entry: TimelineEntry<T>,
    role: TimelinePointRole,
    date: string,
    initiator: HTMLElement,
  ): Promise<boolean> => {
    if (!options.onSetDate) return false;
    try {
      const result = await Promise.resolve(options.onSetDate(entry, role, date, initiator));
      if (successful(result)) {
        feedback.empty();
        delete feedback.dataset['resultType'];
        return true;
      }
      feedback.dataset['resultType'] = result.type;
      feedback.setText('Timeline date was not changed.');
    } catch {
      feedback.dataset['resultType'] = 'io-error';
      feedback.setText('Timeline date could not be changed.');
    }
    if (initiator.isConnected) initiator.focus({ preventScroll: true });
    return false;
  };

  const onScheduleChange = (event: Event): void => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.value) return;
    const entry = scheduleEntryByInput.get(event.target);
    if (!entry) return;
    void commit(entry, options.undatedRole ?? 'scheduled', event.target.value, event.target);
  };
  root.addEventListener('change', onScheduleChange);
  cleanups.push(() => root.removeEventListener('change', onScheduleChange));

  if (dated.length > 0) {
    const datedSection = root.createDiv({ cls: 'abyss-timeline-dated' });
    const scroll = datedSection.createDiv({ cls: 'abyss-timeline-scroll' });
    const canvas = scroll.createDiv({ cls: 'abyss-timeline-canvas' });
    const axis = canvas.createDiv({
      cls: 'abyss-timeline-axis',
      attr: { 'aria-hidden': 'true' },
    });
    const axisIdentity = axis.createDiv({ cls: 'abyss-timeline-axis-identity' });
    const resizeHandle = axisIdentity.createEl('button', {
      cls: 'abyss-timeline-identity-resize abyss-timeline-touch-target',
      attr: {
        type: 'button',
        'data-timeline-identity-resize': '',
        'data-timeline-target': 'identity-column',
        'aria-label': 'Resize timeline identity column',
      },
    });
    const axisPlot = axis.createDiv({ cls: 'abyss-timeline-axis-plot' });
    const axisCoordinates = axisPlot.createDiv({ cls: 'abyss-timeline-axis-coordinates' });
    const axisLabels = axisPlot.createDiv({ cls: 'abyss-timeline-axis-dates' });
    const rows = canvas.createDiv({
      cls: 'abyss-timeline-rows',
      attr: { tabindex: '-1', role: 'list', 'aria-label': 'Timeline items' },
    });
    const targetByElement = new WeakMap<HTMLElement, TimelineInteractionTarget<string>>();
    const entryByKey = new Map(dated.map((entry) => [entry.item.key, entry] as const));
    const bounded = new BoundedWindow(
      dated.map(({ item }) => item.key),
      TIMELINE_OVERSCAN,
    );
    const focusedKey = options.focusedItemKey?.() ?? session?.focusedKey;
    if (focusedKey) bounded.focus(focusedKey);
    const initialFirst = logicalViewportFirst(
      session,
      dated.map(({ item }) => item.key),
    );
    const verticalViewport = (seedFirst?: number): { first: number; visible: number } => ({
      first: seedFirst ?? Math.floor(Math.max(0, scroll.scrollTop) / TIMELINE_ROW_EXTENT),
      visible:
        scroll.clientHeight > 0
          ? Math.ceil(scroll.clientHeight / TIMELINE_ROW_EXTENT)
          : TIMELINE_FALLBACK_VISIBLE_ROWS,
    });

    const midpoint = dates[Math.floor((dates.length - 1) / 2)] ?? today;
    let plotWidth = 1;
    let viewport: TimelineViewport = createTimelineViewport({
      scope: 'workNotes',
      scale: 'month',
      focalDate: midpoint,
      viewportWidth: plotWidth,
    });

    const buildViewport = (): TimelineViewport => {
      switch (scope) {
        case 'portfolio':
          return createTimelineViewport({
            scope,
            scale: isTimelineScale(scope, scale) ? scale : defaultTimelineScale(scope),
            focalDate: midpoint,
            viewportWidth: plotWidth,
          });
        // eslint-disable-next-line sonarjs/no-duplicated-branches -- Branches preserve scope↔scale correlation.
        case 'tasks':
          return createTimelineViewport({
            scope,
            scale: isTimelineScale(scope, scale) ? scale : defaultTimelineScale(scope),
            focalDate: midpoint,
            viewportWidth: plotWidth,
          });
        // eslint-disable-next-line sonarjs/no-duplicated-branches -- Branches preserve scope↔scale correlation.
        case 'workNotes':
          return createTimelineViewport({
            scope,
            scale: isTimelineScale(scope, scale) ? scale : defaultTimelineScale(scope),
            focalDate: midpoint,
            viewportWidth: plotWidth,
          });
      }
    };

    const targetFor = (
      entry: TimelineEntry<T>,
      kind: 'range-move' | 'start-edge' | 'end-edge' | 'point-move' | 'milestone-move',
    ): TimelineInteractionTarget<string> | undefined => {
      if (entry.item.kind === 'range') {
        const start = parseProjectDate(entry.dateByRole.start ?? '');
        const end = parseProjectDate(entry.dateByRole.end ?? '');
        if (
          !start ||
          !end ||
          (kind !== 'range-move' && kind !== 'start-edge' && kind !== 'end-edge')
        ) {
          return undefined;
        }
        return { kind, itemId: entry.item.key, carrier: { start, end } };
      }
      if (entry.item.kind !== 'point' || (kind !== 'point-move' && kind !== 'milestone-move')) {
        return undefined;
      }
      const at = parseProjectDate(entry.dateByRole[entry.item.role] ?? '');
      return at
        ? { kind, itemId: entry.item.key, role: entry.item.role, carrier: { at } }
        : undefined;
    };

    const registerTarget = (
      element: HTMLElement,
      target: TimelineInteractionTarget<string> | undefined,
    ): void => {
      if (target) targetByElement.set(element, target);
    };

    const geometryForEntry = (entry: TimelineEntry<T>) => {
      if (entry.item.kind === 'range') {
        const start = entry.dateByRole.start;
        const end = entry.dateByRole.end;
        return start && end
          ? geometryForTimelineItem(viewport, { kind: 'range', start, end })
          : undefined;
      }
      if (entry.item.kind !== 'point') return undefined;
      const at = entry.dateByRole[entry.item.role];
      return at
        ? geometryForTimelineItem(viewport, {
            kind: entry.item.role === 'milestone' ? 'milestone' : 'point',
            at,
          })
        : undefined;
    };

    const addPicker = (
      controls: HTMLElement,
      entry: TimelineEntry<T>,
      role: TimelinePointRole,
    ): HTMLInputElement => {
      const current = civilDate(entry.dateByRole[role]);
      const picker = controls.createEl('input', {
        cls: `abyss-timeline-date-picker${isAgenda ? ' abyss-timeline-touch-target' : ''}`,
        attr: {
          type: 'date',
          'data-timeline-key': entry.item.key,
          'data-timeline-date-picker': role,
          'aria-label': `Choose ${entry.label} ${role} date`,
          title: `Choose ${role} date`,
          ...(current ? { value: current } : {}),
        },
      });
      picker.disabled = options.onSetDate === undefined;
      return picker;
    };

    const renderInteraction = (
      plot: HTMLElement,
      controls: HTMLElement,
      entry: TimelineEntry<T>,
    ): void => {
      const geometry = geometryForEntry(entry);
      if (!geometry || !geometry.visible) return;
      if (entry.item.kind === 'range' && geometry.kind === 'range') {
        const wrapper = plot.createDiv({
          cls: 'abyss-timeline-range',
          attr: {
            'data-timeline-range': '',
            title: `${entry.dateByRole.start ?? ''} – ${entry.dateByRole.end ?? ''}`,
          },
        });
        wrapper.style.insetInlineStart = `${String(geometry.left)}px`;
        wrapper.style.inlineSize = `${String(geometry.width)}px`;
        const move = wrapper.createEl('button', {
          cls: `abyss-timeline-item-body${isAgenda ? ' abyss-timeline-touch-target' : ''}`,
          attr: {
            type: 'button',
            'data-timeline-primary': '',
            'data-timeline-key': entry.item.key,
            'data-timeline-target': 'range-move',
            'aria-label': `Move ${entry.label} range`,
            title: `${entry.dateByRole.start ?? ''} – ${entry.dateByRole.end ?? ''}`,
          },
        });
        registerTarget(move, targetFor(entry, 'range-move'));
        for (const [kind, role] of [
          ['start-edge', 'start'],
          ['end-edge', 'end'],
        ] as const) {
          const edge = wrapper.createEl('button', {
            cls: `abyss-timeline-edge-handle is-${role}${isAgenda ? ' abyss-timeline-touch-target' : ''}`,
            attr: {
              type: 'button',
              'data-timeline-key': entry.item.key,
              'data-timeline-target': kind,
              'data-timeline-role': role,
              'aria-label': `Resize ${entry.label} ${role} date`,
              title: `${entry.dateByRole.start ?? ''} – ${entry.dateByRole.end ?? ''}`,
            },
          });
          edge.disabled = options.onSetDate === undefined;
          registerTarget(edge, targetFor(entry, kind));
        }
      } else if (entry.item.kind === 'point' && geometry.kind !== 'range') {
        const targetKind = entry.item.role === 'milestone' ? 'milestone-move' : 'point-move';
        const point = plot.createEl('button', {
          cls: `abyss-timeline-point${geometry.kind === 'milestone' ? ' is-milestone' : ''}${isAgenda ? ' abyss-timeline-touch-target' : ''}`,
          attr: {
            type: 'button',
            'data-timeline-primary': '',
            'data-timeline-key': entry.item.key,
            'data-timeline-target': targetKind,
            'data-timeline-role': entry.item.role,
            ...(geometry.kind === 'milestone'
              ? { 'data-timeline-milestone': 'diamond' }
              : { 'data-timeline-point': entry.item.role }),
            'aria-label': `Move ${entry.label} ${entry.item.role} date`,
            title: entry.dateByRole[entry.item.role] ?? '',
          },
        });
        point.style.insetInlineStart = `${String(geometry.centerX)}px`;
        point.style.inlineSize = `${String(geometry.size)}px`;
        point.style.blockSize = `${String(geometry.size)}px`;
        point.disabled = options.onSetDate === undefined;
        registerTarget(point, targetFor(entry, targetKind));
      }

      const roles = pointRoles(entry.item);
      for (const role of roles) addPicker(controls, entry, role);
      if (coarsePointer) {
        const menu = controls.createEl('details', { cls: 'abyss-timeline-coarse-menu' });
        menu.createEl('summary', {
          cls: 'abyss-timeline-touch-target',
          text: '•••',
          attr: { 'aria-label': `Timeline actions for ${entry.label}` },
        });
        menu.createEl('button', {
          cls: 'abyss-timeline-touch-target',
          text: 'Move earlier',
          attr: { type: 'button', 'data-timeline-coarse-action': 'move-previous' },
        });
        menu.createEl('button', {
          cls: 'abyss-timeline-touch-target',
          text: 'Move later',
          attr: { type: 'button', 'data-timeline-coarse-action': 'move-next' },
        });
      }
    };

    let renderWindow = (restoreFocus = false, seedFirst?: number): void => {
      if (destroyed) return;
      const result = bounded.render(rows, {
        ...verticalViewport(seedFirst),
        itemExtent: TIMELINE_ROW_EXTENT,
        restoreFocus,
        render: (host, _key, logicalIndex) => {
          const entry = dated[logicalIndex]!;
          const row = host.createDiv({
            cls: `abyss-timeline-row${isAgenda ? ' abyss-timeline-agenda-row' : ''}`,
            attr: {
              role: 'listitem',
              'data-timeline-key': entry.item.key,
              'aria-label': entry.label,
            },
          });
          const identity = row.createDiv({
            cls: 'abyss-timeline-identity',
            attr: timelineIdentityAttributes(entry.item.key),
          });
          renderEntryIdentity(identity, entry, options.renderIdentity);
          const roles = pointRoles(entry.item);
          if (isAgenda) {
            const dateText = roles
              .map((role) => `${roleLabel(role)} ${civilDate(entry.dateByRole[role]) ?? 'Undated'}`)
              .join(' – ');
            identity.createSpan({ cls: 'abyss-timeline-agenda-date', text: dateText });
          }
          const plot = row.createDiv({ cls: 'abyss-timeline-plot' });
          const controls = row.createDiv({ cls: 'abyss-timeline-date-controls' });
          renderInteraction(plot, controls, entry);
          row.addEventListener('focusin', () => {
            bounded.focus(entry.item.key);
            options.onItemFocus?.(entry);
            if (session && !options.onItemFocus) {
              session.focusedKey = entry.item.key;
              session.restoreFocus = true;
            }
          });
          return timelineRowFocusTarget(row, identity);
        },
      });
      if (restoreFocus || seedFirst !== undefined) {
        scroll.scrollTop = result.first * TIMELINE_ROW_EXTENT;
      }
    };

    const centerOn = (date: string): void => {
      const visibleWidth = Math.max(
        1,
        scroll.clientWidth - identityWidth || Math.min(plotWidth, 480),
      );
      const desired = identityWidth + civilDateToX(viewport, date) - visibleWidth / 2;
      scroll.scrollLeft = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, desired));
      if (session) session.scrollLeft = scroll.scrollLeft;
    };

    const refreshGeometry = (preserveFocal = true): void => {
      const probe = (() => {
        switch (scope) {
          case 'portfolio':
            return createTimelineViewport({
              scope,
              scale: isTimelineScale(scope, scale) ? scale : 'quarter',
              focalDate: midpoint,
              viewportWidth: 1,
            });
          case 'tasks':
            return createTimelineViewport({
              scope,
              scale: isTimelineScale(scope, scale) ? scale : 'week',
              focalDate: midpoint,
              viewportWidth: 1,
            });
          case 'workNotes':
            return createTimelineViewport({
              scope,
              scale: isTimelineScale(scope, scale) ? scale : 'month',
              focalDate: midpoint,
              viewportWidth: 1,
            });
        }
      })();
      plotWidth = Math.max(1, dates.length * probe.pixelsPerDay);
      viewport = buildViewport();
      canvas.style.inlineSize = `calc(var(--abyss-timeline-identity-width) + ${String(plotWidth)}px)`;
      canvas.style.setProperty('--abyss-timeline-plot-width', `${String(plotWidth)}px`);
      axisCoordinates.empty();
      axisLabels.empty();
      for (const date of dates) {
        const marker = axisCoordinates.createSpan({
          attr: { 'data-timeline-date-coordinate': date },
        });
        marker.style.insetInlineStart = `${String(civilDateToX(viewport, date))}px`;
      }
      for (const date of presentationDates(dates)) {
        const label = axisLabels.createSpan({ text: date.slice(5) });
        label.style.insetInlineStart = `${String(civilDateToX(viewport, date))}px`;
      }
      canvas.querySelector('[data-timeline-today-line]')?.remove();
      if (dates.includes(today)) {
        const todayLine = canvas.createDiv({
          cls: 'abyss-timeline-today-line',
          attr: { 'data-timeline-today-line': '', 'aria-hidden': 'true' },
        });
        todayLine.style.insetInlineStart = `calc(var(--abyss-timeline-identity-width) + ${String(civilDateToX(viewport, today))}px)`;
      }
      renderWindow(false);
      const focal = session?.focalDate ?? midpoint;
      if (preserveFocal && civilDate(focal)) centerOn(focal);
    };

    registerTarget(resizeHandle, { kind: 'identity-column', width: identityWidth });

    const notifyPresentationChange = (): void => {
      void options.onPresentationChange?.({ scale, identityWidth });
    };

    const applyIdentityWidth = (width: number, notify = false): void => {
      identityWidth = clampTimelineIdentityWidth(width);
      root.style.setProperty('--abyss-timeline-identity-width', `${String(identityWidth)}px`);
      if (session) session.identityWidth = identityWidth;
      registerTarget(resizeHandle, { kind: 'identity-column', width: identityWidth });
      if (notify) notifyPresentationChange();
    };

    const projectionHost = (itemId: string): HTMLElement | undefined =>
      Array.from(rows.querySelectorAll<HTMLElement>('[data-timeline-key]'))
        .find(({ dataset }) => dataset['timelineKey'] === itemId)
        ?.closest<HTMLElement>('.abyss-timeline-row') ?? undefined;

    const publish = (projection: TimelineInteractionProjection<string>): void => {
      for (const active of rows.querySelectorAll('.is-timeline-active')) {
        active.removeClass('is-timeline-active');
      }
      for (const preview of rows.querySelectorAll('[data-timeline-preview]')) preview.remove();
      if (!projection.itemId) {
        if (projection.draftWidth !== undefined) applyIdentityWidth(projection.draftWidth);
        return;
      }
      const row = projectionHost(projection.itemId);
      row?.addClass('is-timeline-active');
      if (session && projection.accessibility.ownedRole) {
        session.focusedInteraction = {
          itemKey: projection.itemId,
          role: projection.accessibility.ownedRole,
        };
      }
      const previewGeometry = projection.previewGeometry;
      const plot = row?.querySelector<HTMLElement>('.abyss-timeline-plot');
      if (!plot || !previewGeometry) return;
      const geometry = geometryForTimelineItem(viewport, previewGeometry);
      const preview = plot.createDiv({
        cls: `abyss-timeline-preview is-${previewGeometry.kind}`,
        attr: { 'data-timeline-preview': '', 'aria-hidden': 'true' },
      });
      if (geometry.kind === 'range') {
        preview.style.insetInlineStart = `${String(geometry.left)}px`;
        preview.style.inlineSize = `${String(geometry.width)}px`;
      } else {
        preview.style.insetInlineStart = `${String(geometry.centerX)}px`;
        preview.style.inlineSize = `${String(geometry.size)}px`;
      }
    };

    const applyDateIntent = async (
      intent: Extract<TimelineCommitIntent<string>, { type: 'date-change' }>,
    ): Promise<boolean> => {
      const entry = entryByKey.get(intent.itemId);
      if (!entry) return false;
      if ('start' in intent.draft) {
        if (intent.target === 'start-edge') {
          return commit(entry, 'start', intent.draft.start.raw, initiatingElement);
        }
        if (intent.target === 'end-edge') {
          return commit(entry, 'end', intent.draft.end.raw, initiatingElement);
        }
        const startChanged = await commit(
          entry,
          'start',
          intent.draft.start.raw,
          initiatingElement,
        );
        if (!startChanged) return false;
        return commit(entry, 'end', intent.draft.end.raw, initiatingElement);
      }
      return commit(
        entry,
        intent.ownedRole as TimelinePointRole,
        intent.draft.at.raw,
        initiatingElement,
      );
    };

    const stopAutoscroll = (): void => {
      autoscrollDirection = 0;
      autoscrollSpeed = 0;
      if (autoscrollFrame !== null && ownerWindow)
        ownerWindow.cancelAnimationFrame(autoscrollFrame);
      autoscrollFrame = null;
    };

    const reducedMotion =
      ownerWindow?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const runAutoscroll = (): void => {
      if (destroyed || autoscrollDirection === 0) {
        stopAutoscroll();
        return;
      }
      scroll.scrollLeft += autoscrollDirection * autoscrollSpeed;
      if (ownerWindow) autoscrollFrame = ownerWindow.requestAnimationFrame(runAutoscroll);
    };

    controller = new TimelineInteractionController<string>({
      geometry: {
        snapshot: () => ({
          pixelsPerDay: viewport.pixelsPerDay,
          scrollLeft: scroll.scrollLeft,
          maxScrollLeft: Math.max(0, scroll.scrollWidth - scroll.clientWidth),
          scrollBounds: (() => {
            const rect = scroll.getBoundingClientRect();
            return { left: rect.left + identityWidth, right: rect.right };
          })(),
        }),
      },
      commit: async (intent) => {
        if (intent.type === 'identity-width-change') {
          applyIdentityWidth(intent.draftWidth, true);
          return { type: 'success' };
        }
        if (await applyDateIntent(intent)) return { type: 'success' };
        return feedback.dataset['resultType'] === 'conflict'
          ? { type: 'conflict' }
          : { type: 'failure' };
      },
      publish,
      announce: (announcement) => {
        if (announcement.type === 'conflict' || announcement.type === 'failure') {
          feedback.dataset['resultType'] = announcement.type;
          feedback.setText('Timeline date was not changed.');
        } else if (announcement.type === 'cancel') {
          feedback.setText(
            announcement.reason
              ? `Timeline edit cancelled: ${announcement.reason}`
              : 'Timeline edit cancelled.',
          );
        } else if (announcement.type === 'success') {
          feedback.empty();
          delete feedback.dataset['resultType'];
        }
      },
      emit: (intent) => {
        if (intent.type === 'identity-width-preset') {
          applyIdentityWidth(intent.width, true);
          return;
        }
        const row = projectionHost(intent.itemId);
        const role = intent.ownedRole === 'range' ? 'start' : intent.ownedRole;
        const picker = row?.querySelector<HTMLInputElement>(
          `[data-timeline-date-picker="${role}"]`,
        );
        picker?.focus({ preventScroll: true });
        picker?.showPicker?.();
      },
      capturePointer: (pointerId) => initiatingElement.setPointerCapture?.(pointerId),
      releasePointer: (pointerId) => {
        if (initiatingElement.hasPointerCapture?.(pointerId))
          initiatingElement.releasePointerCapture(pointerId);
      },
      requestAutoscroll: ({ direction, speed }) => {
        if (direction === 0) {
          stopAutoscroll();
          return;
        }
        autoscrollDirection = direction;
        autoscrollSpeed = speed;
        if (reducedMotion || !ownerWindow) {
          scroll.scrollLeft += direction * speed;
          return;
        }
        if (autoscrollFrame === null)
          autoscrollFrame = ownerWindow.requestAnimationFrame(runAutoscroll);
      },
      restoreFocus: (itemId, role) => {
        if (!itemId) return resizeHandle.focus({ preventScroll: true });
        const row = projectionHost(itemId);
        const selector =
          role === 'range'
            ? '[data-timeline-target="range-move"]'
            : `[data-timeline-role="${role}"], [data-timeline-target$="move"]`;
        row?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
      },
    });

    const interactionElement = (target: EventTarget | null): HTMLElement | undefined =>
      target instanceof HTMLElement
        ? (target.closest<HTMLElement>('[data-timeline-target]') ?? undefined)
        : undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const element = interactionElement(event.target);
      const target = element && targetByElement.get(element);
      if (!element || !target) return;
      initiatingElement = element;
      controller?.pointerDown({
        pointerId: event.pointerId,
        button: event.button,
        isPrimary: event.isPrimary,
        enabled: options.onSetDate !== undefined || target.kind === 'identity-column',
        point: { x: event.clientX, y: event.clientY },
        target,
      });
    };
    const onPointerMove = (event: PointerEvent): void => {
      controller?.pointerMove({
        pointerId: event.pointerId,
        point: { x: event.clientX, y: event.clientY },
      });
    };
    const onPointerUp = (event: PointerEvent): void => {
      void controller?.pointerUp({
        pointerId: event.pointerId,
        point: { x: event.clientX, y: event.clientY },
      });
    };
    const onPointerCancel = (event: PointerEvent): void => {
      controller?.pointerCancel(event.pointerId);
    };
    const onLostPointerCapture = (event: PointerEvent): void => {
      controller?.lostPointerCapture(event.pointerId);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const element = interactionElement(event.target);
      const target = element && targetByElement.get(element);
      if (!target && event.key !== 'Escape') return;
      if (element) initiatingElement = element;
      if (['ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key))
        event.preventDefault();
      void controller?.keyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        ...(target && { target }),
        enabled: options.onSetDate !== undefined || target?.kind === 'identity-column',
        scope,
        scale,
      });
    };
    const onChange = (event: Event): void => {
      const picker =
        event.target instanceof HTMLInputElement
          ? event.target.closest<HTMLInputElement>('[data-timeline-date-picker]')
          : null;
      if (!picker?.value) return;
      const entry = entryByKey.get(picker.dataset['timelineKey'] ?? '');
      const role = picker.dataset['timelineDatePicker'] as TimelinePointRole | undefined;
      if (entry && role) void commit(entry, role, picker.value, picker);
    };
    const onClick = (event: MouseEvent): void => {
      const element = event.target instanceof HTMLElement ? event.target : null;
      const preset = element?.closest<HTMLElement>('[data-timeline-identity-preset]')?.dataset[
        'timelineIdentityPreset'
      ];
      if (preset === 'compact' || preset === 'default' || preset === 'wide') {
        controller?.requestIdentityPreset(preset);
        return;
      }
      const action = element?.closest<HTMLElement>('[data-timeline-coarse-action]');
      if (!action) return;
      const row = action.closest<HTMLElement>('.abyss-timeline-row');
      const primary = row?.querySelector<HTMLElement>('[data-timeline-primary]');
      const target = primary && targetByElement.get(primary);
      if (!primary || !target) return;
      initiatingElement = primary;
      const key =
        action.dataset['timelineCoarseAction'] === 'move-previous' ? 'ArrowLeft' : 'ArrowRight';
      void controller
        ?.keyDown({ key, target, enabled: true, scope, scale })
        .then(() => controller?.keyDown({ key: 'Enter', target, enabled: true, scope, scale }));
    };
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('lostpointercapture', onLostPointerCapture);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('change', onChange);
    root.addEventListener('click', onClick);
    ownerDocument.addEventListener('pointermove', onPointerMove);
    ownerDocument.addEventListener('pointerup', onPointerUp);
    ownerDocument.addEventListener('pointercancel', onPointerCancel);
    cleanups.push(() => {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('lostpointercapture', onLostPointerCapture);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('change', onChange);
      root.removeEventListener('click', onClick);
      ownerDocument.removeEventListener('pointermove', onPointerMove);
      ownerDocument.removeEventListener('pointerup', onPointerUp);
      ownerDocument.removeEventListener('pointercancel', onPointerCancel);
    });

    const rememberViewport = (): void => {
      if (!session) return;
      session.firstIndex = verticalViewport().first;
      session.firstKey = dated[session.firstIndex]?.item.key ?? null;
      session.scrollLeft = scroll.scrollLeft;
      if (scroll.clientWidth <= 0) return;
      const visibleWidth = Math.max(
        1,
        scroll.clientWidth - identityWidth || Math.min(plotWidth, 480),
      );
      const plotX = Math.max(0, scroll.scrollLeft - identityWidth + visibleWidth / 2);
      session.focalDate = timelineDateAtX(viewport, plotX);
    };
    const onScroll = (): void => {
      rememberViewport();
      renderWindow(false);
    };
    scroll.addEventListener('scroll', onScroll);
    cleanups.push(() => scroll.removeEventListener('scroll', onScroll));
    const onFocusOut = (): void => {
      queueMicrotask(() => {
        if (!container.isConnected || container.contains(container.ownerDocument.activeElement)) {
          return;
        }
        options.onItemBlur?.();
      });
    };
    rows.addEventListener('focusout', onFocusOut);
    cleanups.push(() => rows.removeEventListener('focusout', onFocusOut));
    refreshGeometry(false);
    renderWindow(
      options.shouldRestoreItemFocus?.() ?? session?.restoreFocus === true,
      initialFirst,
    );
    if (session?.scrollLeft !== undefined) scroll.scrollLeft = session.scrollLeft;
    else centerOn(session?.focalDate ?? midpoint);
    if (isAgenda) axis.remove();
    rememberViewport();

    const onScaleChange = (): void => {
      if (!isTimelineScale(scope, scaleSelect.value)) return;
      scale = scaleSelect.value;
      if (session) session.scale = scale;
      refreshGeometry(true);
      notifyPresentationChange();
    };
    const onToday = (): void => {
      if (session) session.focalDate = today;
      centerOn(today);
    };
    scaleSelect.addEventListener('change', onScaleChange);
    todayButton.addEventListener('click', onToday);
    cleanups.push(() => {
      scaleSelect.removeEventListener('change', onScaleChange);
      todayButton.removeEventListener('click', onToday);
    });
  }

  const renderDiagnosticSection = (
    entries: readonly TimelineEntry<T>[],
    className: string,
    heading: string,
  ): void => {
    if (entries.length === 0) return;
    const section = root.createEl('details', {
      cls: `${className} abyss-timeline-tray`,
      attr: { 'data-timeline-tray': heading === 'Planning' ? 'planning' : 'invalid' },
    });
    if (heading === 'Planning' && dated.length === 0) section.open = true;
    section.createEl('summary', { text: `${heading} · ${String(entries.length)}` });
    const scroll = section.createDiv({
      cls: 'abyss-timeline-diagnostic-scroll',
      attr: { tabindex: '0', 'aria-label': heading },
    });
    const rows = scroll.createDiv({ cls: 'abyss-timeline-diagnostic-rows' });
    const bounded = new BoundedWindow(
      entries.map(({ item }) => item.key),
      TIMELINE_OVERSCAN,
    );
    const keys = entries.map(({ item }) => item.key);
    const focusedKey = options.focusedItemKey?.() ?? options.session?.focusedKey;
    if (focusedKey && keys.includes(focusedKey)) bounded.focus(focusedKey);
    const viewport = (): { first: number; visible: number } => ({
      first: Math.floor(Math.max(0, scroll.scrollTop) / TIMELINE_DIAGNOSTIC_ROW_EXTENT),
      visible:
        scroll.clientHeight > 0
          ? Math.ceil(scroll.clientHeight / TIMELINE_DIAGNOSTIC_ROW_EXTENT)
          : TIMELINE_DIAGNOSTIC_VISIBLE_ROWS,
    });
    if (focusedKey && keys.includes(focusedKey)) {
      scroll.scrollTop = bounded.viewportForFocus(viewport()) * TIMELINE_DIAGNOSTIC_ROW_EXTENT;
    }
    const renderWindow = (restoreFocus = false): void => {
      bounded.render(rows, {
        ...viewport(),
        itemExtent: TIMELINE_DIAGNOSTIC_ROW_EXTENT,
        restoreFocus,
        render: (host, _key, logicalIndex) => {
          const entry = entries[logicalIndex]!;
          const row = host.createDiv({
            cls: `abyss-timeline-diagnostic-row ${className}-row`,
            attr: timelineIdentityAttributes(entry.item.key),
          });
          const identity = row.createDiv({ cls: 'abyss-timeline-identity' });
          renderEntryIdentity(identity, entry, options.renderIdentity);
          if (entry.item.kind === 'invalid') {
            row.createSpan({ cls: 'abyss-timeline-diagnostic-reason', text: entry.item.reason });
          } else if (options.onSetDate) {
            const schedule = row.createEl('input', {
              cls: 'abyss-timeline-touch-target',
              attr: {
                type: 'date',
                'data-timeline-schedule': '',
                'aria-label': `Schedule ${entry.label}`,
              },
            });
            scheduleEntryByInput.set(schedule, entry);
          }
          // eslint-disable-next-line sonarjs/no-nested-functions -- The bounded diagnostic row owns its focus listener.
          row.addEventListener('focusin', () => {
            bounded.focus(entry.item.key);
            options.onItemFocus?.(entry);
            if (options.session) {
              options.session.focusedKey = entry.item.key;
              options.session.restoreFocus = true;
            }
          });
          return timelineRowFocusTarget(row, identity);
        },
      });
    };
    const onScroll = (): void => renderWindow(false);
    scroll.addEventListener('scroll', onScroll);
    cleanups.push(() => scroll.removeEventListener('scroll', onScroll));
    renderWindow(focusedKey !== undefined && focusedKey !== null && keys.includes(focusedKey));
  };
  renderDiagnosticSection(undated, 'abyss-timeline-undated', 'Planning');
  renderDiagnosticSection(invalid, 'abyss-timeline-invalid', 'Invalid');

  return {
    destroy: () => {
      destroyed = true;
      controller?.destroy();
      if (autoscrollFrame !== null && ownerWindow)
        ownerWindow.cancelAnimationFrame(autoscrollFrame);
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
  return renderTimeline<Project>(container, {
    entries: options.projects.map(projectTimelineEntry),
    scope: 'portfolio',
    undatedRole: 'start',
    ...(options.scale && { scale: options.scale }),
    ...(options.identityWidth !== undefined && { identityWidth: options.identityWidth }),
    ...(options.onPresentationChange && {
      onPresentationChange: (presentation: {
        readonly scale: TimelineScale<TimelineScope>;
        readonly identityWidth: number;
      }) =>
        options.onPresentationChange?.({
          scale: presentation.scale as PortfolioTimelineScale,
          identityWidth: presentation.identityWidth,
        }),
    }),
    ...(options.session && { session: options.session }),
    ...(options.isNarrow !== undefined && { isNarrow: options.isNarrow }),
    ...(options.openProject
      ? {
          renderIdentity: (host, entry) => {
            const button = host.createEl('button', {
              cls: 'abyss-timeline-title abyss-project-identity-control',
              text: entry.label,
              attr: {
                type: 'button',
                'data-project-identity-control': '',
                'aria-label': `Open project ${entry.label}`,
              },
            });
            button.addEventListener('click', () => options.openProject?.(entry.value.path));
            if (entry.detail) host.createSpan({ cls: 'abyss-timeline-detail', text: entry.detail });
          },
        }
      : {}),
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
  return renderTimeline<WorkNoteSnapshot>(container, {
    entries: prepared.map(({ entry }) => entry),
    scope: 'workNotes',
    undatedRole: 'start',
    ...(options.scale && { scale: options.scale }),
    ...(options.identityWidth !== undefined && { identityWidth: options.identityWidth }),
    ...(options.onPresentationChange && {
      onPresentationChange: (presentation: {
        readonly scale: TimelineScale<TimelineScope>;
        readonly identityWidth: number;
      }) =>
        options.onPresentationChange?.({
          scale: presentation.scale,
          identityWidth: presentation.identityWidth,
        }),
    }),
    ...(options.session && { session: options.session }),
    ...(options.isNarrow !== undefined && { isNarrow: options.isNarrow }),
    ...(options.openNote || options.onSelect
      ? {
          renderIdentity: (host, entry) => {
            const button = host.createEl('button', {
              cls: 'abyss-timeline-title abyss-work-note-identity',
              text: entry.label,
              attr: {
                type: 'button',
                'data-work-note-identity-control': '',
                'aria-label': `Work note details ${entry.label}`,
              },
            });
            button.dataset['inspectorOriginKey'] = inspectorSelectionKey({
              type: 'work-note',
              path: entry.value.path,
              projectPath: entry.value.projectPath,
            });
            button.addEventListener('click', () => {
              if (options.onSelect) options.onSelect(entry.value, button);
              else options.openNote?.(entry.value.path);
            });
            if (entry.detail) host.createSpan({ cls: 'abyss-timeline-detail', text: entry.detail });
          },
        }
      : {}),
    ...(options.commandsEnabled === false ? {} : { onSetDate }),
  });
}

/** Task projection/application-command adapter for the shared Timeline shell. */
export function renderTasksTimeline(
  container: HTMLElement,
  options: TasksTimelineOptions,
): TimelineViewHandle {
  const entries = options.actions.map((action) => ({
    ...taskTimelineEntry(action.task),
    value: action,
  }));
  const collection = options.collectionSession;
  const focusedItemKey = (): string | null => {
    const focused = collection?.focusedRef();
    if (!focused) return null;
    return (
      entries.find(
        ({ value }) => taskReconciliationKey(value.task.ref) === taskReconciliationKey(focused),
      )?.item.key ?? null
    );
  };
  return renderTimeline(container, {
    entries,
    scope: 'tasks',
    undatedRole: 'scheduled',
    ...(options.scale && { scale: options.scale }),
    ...(options.identityWidth !== undefined && { identityWidth: options.identityWidth }),
    ...(options.onPresentationChange && {
      onPresentationChange: (presentation: {
        readonly scale: TimelineScale<TimelineScope>;
        readonly identityWidth: number;
      }) =>
        options.onPresentationChange?.({
          scale: presentation.scale as TaskTimelineScale,
          identityWidth: presentation.identityWidth,
        }),
    }),
    ...(options.session ? { session: options.session } : {}),
    ...(collection
      ? {
          focusedItemKey,
          shouldRestoreItemFocus: () => collection.shouldRestoreFocus(),
          onItemFocus: (entry: TimelineEntry<ProjectAction>) =>
            collection.focusOnly(entry.value.task.ref),
          onItemBlur: () => collection.intentionalBlur(),
        }
      : {}),
    ...(options.isNarrow !== undefined && { isNarrow: options.isNarrow }),
    ...(options.renderTask
      ? {
          renderIdentity: (host: HTMLElement, entry: TimelineEntry<ProjectAction>) =>
            options.renderTask?.(host, entry.value),
        }
      : {}),
    onSetDate: (entry, role, date) => {
      if (role === 'milestone') throw new Error('Task Timeline milestone mutation unavailable');
      return options.onSetDate(entry.value.task, role, date);
    },
  });
}
