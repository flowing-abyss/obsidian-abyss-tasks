import { Platform } from 'obsidian';
import type {
  ProjectCommandService,
  ProjectRangeCommandResult,
  ProjectRangePatch,
} from '../../projects/ProjectCommandService';
import { projectHealthProjection } from '../../projects/ProjectHealthProjection';
import { parseProjectDate, projectDateOnLocalDate } from '../../projects/projectDates';
import type {
  Project,
  ProjectAction,
  ProjectDateValue,
  ProjectWorkspaceSnapshot,
} from '../../projects/types';
import type { MilestoneCommandAdapter } from '../../projects/work-notes/MilestoneCommandAdapter';
import type { WorkNoteCommandService } from '../../projects/work-notes/WorkNoteCommandService';
import type { WorkNoteCommandResult, WorkNoteSnapshot } from '../../projects/work-notes/types';
import { taskReconciliationKey, type TaskCommandResult, type TaskSnapshot } from '../../tasks';
import { inspectorSelectionKey } from '../../ui/inspector/InspectorSelection';
import {
  optimisticOverlayStoreFor,
  type OptimisticOverlayStore,
} from '../../ui/interaction/OptimisticOverlayStore';
import { BoundedWindow } from './BoundedWindow';
import type { ProjectTaskCollectionSession } from './ProjectTaskCollectionSession';
import {
  logicalViewportFirst,
  type LogicalViewportSession,
  type TimelinePresentationSession,
} from './ProjectWorkspaceSession';
import {
  TimelineInteractionController,
  type TimelineAnnouncement,
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
import type {
  PortfolioTimelineValue,
  TimelineItem,
  TimelinePointRole,
  TimelineProjection,
} from './timelineProjection';
import {
  portfolioTimelineEntries,
  projectTimelineEntry,
  taskTimelineEntry,
  workNoteTimelineEntry,
} from './timelineProjection';

const TIMELINE_ROW_EXTENT = 72;
const TIMELINE_AGENDA_ROW_EXTENT = 144;
const TIMELINE_FALLBACK_VISIBLE_ROWS = 12;
const TIMELINE_OVERSCAN = 5;
const TIMELINE_DIAGNOSTIC_ROW_EXTENT = 32;
const TIMELINE_AGENDA_DIAGNOSTIC_ROW_EXTENT = 88;
const TIMELINE_DIAGNOSTIC_VISIBLE_ROWS = 7;
const TIMELINE_AXIS_LABEL_LIMIT = 8;
const TIMELINE_AXIS_LABEL_MIN_GAP = 48;
const TIMELINE_AXIS_LABEL_EDGE_INSET = 24;
const TIMELINE_AXIS_LABEL_COLLISION_GAP = 6;
/** Hard DOM ceiling for the live horizontal civil-date marker window at every scope and scale. */
export const TIMELINE_MARKER_DOM_CAP = 120;

export type TimelineEntry<T> = TimelineProjection<T>;

interface TimelineMutationResult {
  readonly type: string;
}

interface TimelineRepairProposal {
  readonly preview: string;
}

export interface TimelineViewOptions<T> {
  readonly entries: readonly TimelineEntry<T>[];
  /** Complete application publication; presentation entries may be filtered or project-local. */
  readonly canonicalPublicationEntries?: readonly TimelineEntry<T>[];
  readonly onSetDate?: (
    entry: TimelineEntry<T>,
    role: TimelinePointRole,
    date: string,
    initiator: HTMLElement,
  ) => Promise<TimelineMutationResult> | TimelineMutationResult;
  readonly onSetRange?: (
    entry: TimelineEntry<T>,
    start: string,
    end: string,
    initiator: HTMLElement,
  ) => Promise<TimelineMutationResult> | TimelineMutationResult;
  readonly canSetDate?: (entry: TimelineEntry<T>, role: TimelinePointRole) => boolean;
  readonly canSetRange?: (entry: TimelineEntry<T>) => boolean;
  readonly repairProposal?: (entry: TimelineEntry<T>) => TimelineRepairProposal | undefined;
  readonly onConfirmRepair?: (
    entry: TimelineEntry<T>,
    initiator: HTMLElement,
  ) => Promise<TimelineMutationResult> | TimelineMutationResult;
  readonly dateWindow?: { readonly from: string; readonly to: string };
  readonly session?: LogicalViewportSession | TimelinePresentationSession<TimelineScope>;
  readonly focusedItemKey?: () => string | null;
  readonly shouldRestoreItemFocus?: () => boolean;
  readonly onItemFocus?: (entry: TimelineEntry<T>) => void;
  readonly onItemBlur?: () => void;
  readonly onRowsRendered?: () => void;
  readonly isNarrow?: boolean;
  readonly renderIdentity?: (host: HTMLElement, entry: TimelineEntry<T>) => void;
  readonly scope?: TimelineScope;
  readonly scale?: TimelineScale<TimelineScope>;
  readonly identityWidth?: number;
  readonly today?: string;
  readonly coarsePointer?: boolean;
  readonly undatedRole?: TimelinePointRole | ((entry: TimelineEntry<T>) => TimelinePointRole);
  readonly onPresentationChange?: (presentation: {
    readonly scale: TimelineScale<TimelineScope>;
    readonly identityWidth: number;
  }) => void | Promise<void>;
  /** Application-owned date projection retained while the canonical source catches up. */
  readonly optimisticOverlay?: {
    readonly store: OptimisticOverlayStore<
      TimelineEntry<T>,
      Readonly<Partial<Record<TimelinePointRole, string>>>
    >;
    readonly keyOf: (entry: TimelineEntry<T>) => string;
    readonly revision: (entry: TimelineEntry<T>) => string;
    readonly publicationSequence?: number;
    readonly continuity?: (observed: TimelineEntry<T>, published: TimelineEntry<T>) => boolean;
  };
}

export interface TimelineViewHandle {
  reflow?(): void;
  destroy(): void;
}

let nextTimelineOverlayOwnerId = 0;

/** Container-query bridge for production hosts; keeps responsive mode out of global viewport CSS. */
export function renderContainerResponsiveTimeline(
  container: HTMLElement,
  render: (isNarrow: boolean) => TimelineViewHandle,
): TimelineViewHandle {
  const narrow = (): boolean =>
    Platform.isMobile || (container.clientWidth > 0 && container.clientWidth <= 672);
  let isNarrow = narrow();
  let child = render(isNarrow);
  let destroyed = false;
  const ResizeObserverCtor = container.ownerDocument.defaultView?.ResizeObserver;
  const observer = ResizeObserverCtor
    ? new ResizeObserverCtor(() => {
        if (destroyed) return;
        const next = narrow();
        if (next === isNarrow) {
          child.reflow?.();
          return;
        }
        isNarrow = next;
        child.destroy();
        child = render(isNarrow);
      })
    : null;
  observer?.observe(container);
  return {
    reflow: () => child.reflow?.(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      child.destroy();
    },
  };
}

export interface ProjectsTimelineOptions {
  readonly projects: readonly Project[];
  readonly snapshots?: readonly ProjectWorkspaceSnapshot[];
  readonly canonicalProjects?: readonly Project[];
  readonly canonicalSnapshots?: readonly ProjectWorkspaceSnapshot[];
  readonly commands: ProjectCommandService;
  readonly milestoneCommands?: WorkNoteCommandService;
  readonly milestoneAdapter?: Pick<MilestoneCommandAdapter, 'observeDates' | 'setDates'>;
  readonly session?: LogicalViewportSession;
  readonly isNarrow?: boolean;
  readonly onMutation?: (project: Project, result: ProjectRangeCommandResult) => void;
  readonly onMilestoneMutation?: (note: WorkNoteSnapshot, result: WorkNoteCommandResult) => void;
  readonly openProject?: (path: string) => void;
  readonly onSelectMilestone?: (note: WorkNoteSnapshot, origin: HTMLElement) => void;
  readonly today?: string;
  readonly scale?: PortfolioTimelineScale;
  readonly identityWidth?: number;
  readonly onPresentationChange?: (presentation: {
    readonly scale: PortfolioTimelineScale;
    readonly identityWidth: number;
  }) => void | Promise<void>;
  readonly overlayScope?: object;
  readonly publicationSequence?: number;
  readonly pathSuccessor?: (observedPath: string, publishedPath: string) => boolean;
}

export interface WorkNotesTimelineOptions {
  readonly notes: readonly WorkNoteSnapshot[];
  readonly canonicalNotes?: readonly WorkNoteSnapshot[];
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
  readonly overlayScope?: object;
  readonly publicationSequence?: number;
  readonly pathSuccessor?: (observedPath: string, publishedPath: string) => boolean;
  readonly today?: string;
  readonly milestoneAdapter?: Pick<MilestoneCommandAdapter, 'observeDates' | 'setDates'>;
}

export interface TasksTimelineOptions {
  readonly actions: readonly ProjectAction[];
  readonly canonicalActions?: readonly ProjectAction[];
  readonly session?: LogicalViewportSession;
  readonly collectionSession?: ProjectTaskCollectionSession;
  readonly isNarrow?: boolean;
  readonly renderTask?: (host: HTMLElement, action: ProjectAction) => void;
  readonly onSetDate: (
    task: TaskSnapshot,
    role: Exclude<TimelinePointRole, 'milestone'>,
    date: string,
  ) => Promise<TaskCommandResult> | TaskCommandResult;
  readonly onSetRange: (
    task: TaskSnapshot,
    start: string,
    end: string,
  ) => Promise<TaskCommandResult> | TaskCommandResult;
  readonly scale?: TaskTimelineScale;
  readonly identityWidth?: number;
  readonly onPresentationChange?: (presentation: {
    readonly scale: TaskTimelineScale;
    readonly identityWidth: number;
  }) => void | Promise<void>;
  readonly overlayScope?: object;
  readonly publicationSequence?: number;
  readonly taskSuccessor?: (observed: TaskSnapshot, published: TaskSnapshot) => boolean;
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

function cappedTimelineDates(
  dates: readonly string[],
  cap: number,
  pinned: readonly (string | undefined)[] = [],
): readonly string[] {
  if (dates.length <= cap) return dates;
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const selected = new Set<string>();
  const add = (date: string | undefined): void => {
    if (date && selected.size < cap && date >= first && date <= last) selected.add(date);
  };
  add(first);
  add(last);
  for (const date of pinned) add(date);
  const remaining = Math.max(0, cap - selected.size);
  for (let index = 0; index < remaining; index += 1) {
    const sampleIndex =
      remaining === 1
        ? Math.floor((dates.length - 1) / 2)
        : Math.round(((dates.length - 1) * index) / (remaining - 1));
    add(dates[sampleIndex]);
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
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

function paddedDateWindow(window: { readonly from: string; readonly to: string }): {
  readonly from: string;
  readonly to: string;
} {
  return {
    from: shiftCivilDate(window.from, -1) ?? window.from,
    to: shiftCivilDate(window.to, 1) ?? window.to,
  };
}

function pointRoles(item: TimelineItem): readonly TimelinePointRole[] {
  if (item.kind === 'range') return ['start', 'end'];
  if (item.kind === 'point') return [item.role];
  return [];
}

/** Dated timeline rows use their visible civil start; stable ties preserve collection ordering. */
function orderedDatedEntries<T>(entries: readonly TimelineEntry<T>[]): readonly TimelineEntry<T>[] {
  const startMs = (entry: TimelineEntry<T>): number => {
    if (entry.item.kind === 'range') return entry.item.startMs;
    return entry.item.kind === 'point' ? entry.item.atMs : Number.POSITIVE_INFINITY;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      return startMs(left.entry) - startMs(right.entry) || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function successful(result: TimelineMutationResult): boolean {
  return result.type === 'ok' || result.type === 'unchanged';
}

function stableTimelineFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTimelineFingerprint).join(',')}]`;
  if (value instanceof Map) {
    return stableTimelineFingerprint(
      [...value.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
  }
  if (value instanceof Set) {
    return stableTimelineFingerprint(
      [...value].sort((left, right) => String(left).localeCompare(String(right))),
    );
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableTimelineFingerprint(field)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function applyTimelineDatePatch<T>(
  entry: TimelineEntry<T>,
  patch: Readonly<Partial<Record<TimelinePointRole, string>>>,
): TimelineEntry<T> {
  const dateByRole = { ...entry.dateByRole, ...patch };
  const item = (() => {
    if (entry.item.kind === 'range') {
      const start = dateByRole.start && parseProjectDate(dateByRole.start);
      const end = dateByRole.end && parseProjectDate(dateByRole.end);
      return start && end
        ? { ...entry.item, startMs: start.instantMs, endMs: end.instantMs }
        : entry.item;
    }
    if (entry.item.kind === 'point') {
      const at = dateByRole[entry.item.role];
      const parsed = at && parseProjectDate(at);
      return parsed ? { ...entry.item, atMs: parsed.instantMs } : entry.item;
    }
    return entry.item;
  })();
  return { ...entry, item, dateByRole };
}

function timelineOptimisticOverlay<T>(
  scope: object | undefined,
  name: string,
  publicationSequence?: number,
  keyOf: (entry: TimelineEntry<T>) => string = (entry) => entry.item.key,
  continuity?: (observed: TimelineEntry<T>, published: TimelineEntry<T>) => boolean,
): TimelineViewOptions<T>['optimisticOverlay'] | undefined {
  if (!scope) return undefined;
  const store = optimisticOverlayStoreFor<
    TimelineEntry<T>,
    Readonly<Partial<Record<TimelinePointRole, string>>>
  >(scope, `timeline:${name}`, {
    keyOf,
    apply: applyTimelineDatePatch,
    matches: (entry, patch) =>
      Object.entries(patch).every(
        ([role, value]) => entry.dateByRole[role as TimelinePointRole] === value,
      ),
    isSuccess: successful,
    timeoutMs: 15_000,
  });
  return {
    store,
    keyOf,
    revision: stableTimelineFingerprint,
    publicationSequence,
    ...(continuity && { continuity }),
  };
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

function timelineRowFocusTarget(
  row: HTMLElement,
  identity: HTMLElement,
  isAgenda: boolean,
): HTMLElement {
  const focusTarget =
    (isAgenda
      ? row.querySelector<HTMLElement>('.abyss-timeline-date-picker:not(:disabled)')
      : row.querySelector<HTMLElement>('[data-timeline-primary]:not(:disabled)')) ??
    identity.querySelector<HTMLElement>('button, a[href], [role="button"]');
  if (focusTarget) return focusTarget;
  row.tabIndex = -1;
  return row;
}

function timelineAnnouncementText(announcement: TimelineAnnouncement<string>): string {
  if (announcement.type === 'pickup') {
    let label = `${announcement.ownedRole} date`;
    if (announcement.ownedRole === 'range') label = 'range';
    else if (announcement.ownedRole === 'identity-column') label = 'identity width';
    return `Picked up ${label}.`;
  }
  if (announcement.type === 'destination') {
    if (announcement.target === 'identity-column') {
      const boundary = announcement.boundary === 'none' ? '' : `, ${announcement.boundary}imum`;
      return `Identity width ${String(announcement.width)} pixels${boundary}.`;
    }
    if (!announcement.validity.valid) {
      return `Invalid destination: ${announcement.validity.reason}.`;
    }
    const destination =
      'at' in announcement.carrier
        ? announcement.carrier.at.raw
        : `${announcement.carrier.start.raw} – ${announcement.carrier.end.raw}`;
    return `Destination: ${destination}.`;
  }
  if (announcement.type === 'commit-pending') return 'Saving timeline change.';
  if (announcement.type === 'success') return 'Timeline change saved.';
  if (announcement.type === 'cancel') {
    return announcement.reason
      ? `Timeline edit cancelled: ${announcement.reason}.`
      : 'Timeline edit cancelled.';
  }
  return announcement.reason
    ? `Timeline date was not changed: ${announcement.reason}.`
    : 'Timeline date was not changed.';
}

function coarseTimelineTarget(
  item: TimelineItem,
  actionName: string,
): 'range-move' | 'start-edge' | 'end-edge' | 'point-move' | 'milestone-move' | undefined {
  if (actionName.startsWith('range-')) return 'range-move';
  if (actionName.startsWith('start-')) return 'start-edge';
  if (actionName.startsWith('end-')) return 'end-edge';
  if (item.kind !== 'point') return undefined;
  return item.role === 'milestone' ? 'milestone-move' : 'point-move';
}

interface TimelineAxisLabel {
  readonly date: string;
  readonly x: number;
  readonly align: 'start' | 'center' | 'end';
}

function timelineAxisLabelAlignment(index: number, count: number): TimelineAxisLabel['align'] {
  if (index === 0) return 'start';
  if (index === count - 1) return 'end';
  return 'center';
}

function spacedTimelineAxisLabels(
  dates: readonly string[],
  viewport: TimelineViewport,
  plotWidth: number,
  pinned: readonly (string | undefined)[],
): readonly TimelineAxisLabel[] {
  const candidates = cappedTimelineDates(dates, TIMELINE_AXIS_LABEL_LIMIT, pinned);
  if (candidates.length === 0) return [];
  const edgeInset = Math.min(TIMELINE_AXIS_LABEL_EDGE_INSET, plotWidth / 2);
  const available = Math.max(0, plotWidth - 2 * edgeInset);
  const gap =
    candidates.length === 1
      ? 0
      : Math.min(TIMELINE_AXIS_LABEL_MIN_GAP, available / (candidates.length - 1));
  const positions = candidates.map((date) =>
    Math.max(edgeInset, Math.min(plotWidth - edgeInset, civilDateToX(viewport, date))),
  );
  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index]!, positions[index - 1]! + gap);
  }
  positions[positions.length - 1] = Math.min(
    positions[positions.length - 1]!,
    plotWidth - edgeInset,
  );
  for (let index = positions.length - 2; index >= 0; index -= 1) {
    positions[index] = Math.min(positions[index]!, positions[index + 1]! - gap);
  }
  return candidates.map((date, index) => ({
    date,
    x: positions[index]!,
    align: timelineAxisLabelAlignment(index, candidates.length),
  }));
}

function cullOverlappingTimelineAxisLabels(host: HTMLElement): void {
  const labels = Array.from(host.querySelectorAll<HTMLElement>('[data-timeline-axis-label-date]'));
  if (labels.length < 2) return;
  const rects = labels.map((label) => label.getBoundingClientRect());
  if (rects.some(({ width }) => width <= 0)) return;
  const lastIndex = labels.length - 1;
  const lastRect = rects[lastIndex]!;
  let previousRect = rects[0]!;
  for (let index = 1; index < lastIndex; index += 1) {
    const rect = rects[index]!;
    const clearsPrevious = rect.left >= previousRect.right + TIMELINE_AXIS_LABEL_COLLISION_GAP;
    const clearsLast = rect.right + TIMELINE_AXIS_LABEL_COLLISION_GAP <= lastRect.left;
    if (clearsPrevious && clearsLast) {
      previousRect = rect;
    } else {
      labels[index]!.remove();
    }
  }
  if (lastRect.left < previousRect.right + TIMELINE_AXIS_LABEL_COLLISION_GAP) {
    labels[lastIndex]!.remove();
  }
}

function coarseTimelineRole(item: TimelineItem, actionName: string): TimelinePointRole {
  if (actionName.startsWith('start-')) return 'start';
  if (actionName.startsWith('end-')) return 'end';
  return item.kind === 'point' ? item.role : 'start';
}

function bindTimelineRepair<T>(
  confirm: HTMLButtonElement,
  entry: TimelineEntry<T>,
  repair: (entry: TimelineEntry<T>, initiator: HTMLElement) => Promise<boolean>,
): void {
  confirm.addEventListener('click', () => void repair(entry, confirm));
}

function timelineSettlementMessage(
  reason: 'published' | 'conflict' | 'io' | 'timeout' | 'competing-publication',
): string {
  if (reason === 'published') return 'Timeline dates updated.';
  if (reason === 'timeout')
    return 'Timeline date update timed out. The observed dates were restored.';
  if (reason === 'io')
    return 'Timeline dates could not be updated. The observed dates were restored.';
  return 'Timeline dates changed elsewhere. Your move was not applied.';
}

/** Semantically neutral bounded Timeline shell shared by Project, Work Note, and Task adapters. */
export function renderTimeline<T>(
  container: HTMLElement,
  options: TimelineViewOptions<T>,
): TimelineViewHandle {
  const overlay = options.optimisticOverlay;
  if (!overlay) return renderTimelineMount(container, options);

  const ownerId = `timeline:${options.scope ?? 'workNotes'}:${String(++nextTimelineOverlayOwnerId)}`;
  let child: TimelineViewHandle | undefined;
  let destroyed = false;
  const render = (
    settlement?: Parameters<Parameters<typeof overlay.store.subscribe>[0]>[0],
  ): void => {
    child?.destroy();
    if (destroyed) return;
    child = renderTimelineMount(container, options, ownerId, () =>
      queueMicrotask(() => !destroyed && render()),
    );
    if (!settlement) return;
    const feedback = container.querySelector<HTMLElement>('[data-timeline-feedback]');
    if (!feedback) return;
    feedback.dataset['resultType'] = settlement.reason;
    feedback.setText(timelineSettlementMessage(settlement.reason));
  };
  const unsubscribe = overlay.store.subscribe(
    (settlement) => queueMicrotask(() => !destroyed && render(settlement)),
    { id: ownerId },
  );
  render();
  return {
    reflow: () => child?.reflow?.(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      child?.destroy();
    },
  };
}

function renderTimelineMount<T>(
  container: HTMLElement,
  options: TimelineViewOptions<T>,
  overlayOwnerId?: string,
  onOverlayChanged?: () => void,
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
  const scaleControl = toolbar.createDiv({
    cls: 'abyss-timeline-scale-control',
    attr: { role: 'group', 'aria-label': 'Timeline scale' },
  });
  const scaleOptions = ['day', 'week', 'month', 'quarter', 'year'] as const;
  const scaleButtons = new Map<TimelineScale<TimelineScope>, HTMLButtonElement>();
  for (const candidate of scaleOptions) {
    const button = scaleControl.createEl('button', {
      cls: 'abyss-timeline-scale-action abyss-timeline-touch-target',
      text: candidate.charAt(0).toUpperCase() + candidate.slice(1),
      attr: {
        type: 'button',
        'data-timeline-scale': '',
        'data-scale': candidate,
        'aria-pressed': String(candidate === scale),
      },
    });
    scaleButtons.set(candidate, button);
  }
  const today = options.today ?? localToday();
  const optimisticOverlay = options.optimisticOverlay;
  if (optimisticOverlay) {
    const canonicalPublications = (options.canonicalPublicationEntries ?? options.entries).map(
      (entry) => ({
        key: optimisticOverlay.keyOf(entry),
        snapshot: entry,
        revision: optimisticOverlay.revision(entry),
      }),
    );
    if (options.canonicalPublicationEntries) {
      optimisticOverlay.store.observeCanonicalBatch(
        canonicalPublications,
        optimisticOverlay.publicationSequence,
        optimisticOverlay.continuity,
      );
    } else {
      for (const publication of canonicalPublications) {
        optimisticOverlay.store.observePublication(
          publication.key,
          publication.snapshot,
          publication.revision,
          optimisticOverlay.publicationSequence,
          optimisticOverlay.continuity,
        );
      }
    }
  }
  const entries = options.entries.map(
    (entry) =>
      options.optimisticOverlay?.store.read(options.optimisticOverlay.keyOf(entry)) ?? entry,
  );
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
  const dated = orderedDatedEntries(
    entries.filter((entry) => entry.item.kind === 'range' || entry.item.kind === 'point'),
  );
  const undated = entries.filter((entry) => entry.item.kind === 'undated');
  const invalid = entries.filter((entry) => entry.item.kind === 'invalid');
  if (dated.length === 0) toolbar.remove();
  const contentWindow = (() => {
    const content = options.dateWindow ?? inferredDateWindow(dated);
    return content ? paddedDateWindow(content) : undefined;
  })();
  let requiredPresentationDate = civilDate(session?.focalDate ?? undefined);
  let window = contentWindow;
  let dates = window ? continuousDates(window.from, window.to) : [];
  if (session) session.focusedInteraction = null;
  let destroyed = false;
  const cleanups: Array<() => void> = [];
  let controller: TimelineInteractionController<string> | undefined;
  let initiatingElement: HTMLElement = root;
  let autoscrollFrame: number | null = null;
  let autoscrollDirection: -1 | 0 | 1 = 0;
  let autoscrollSpeed = 0;
  let reflowTimeline: (() => void) | undefined;
  const scheduleEntryByInput = new WeakMap<HTMLInputElement, TimelineEntry<T>>();
  const canSetDate = (entry: TimelineEntry<T>, role: TimelinePointRole): boolean =>
    options.onSetDate !== undefined && options.canSetDate?.(entry, role) !== false;
  const canSetRange = (entry: TimelineEntry<T>): boolean =>
    options.onSetRange !== undefined && options.canSetRange?.(entry) !== false;

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

  const commitRange = async (
    entry: TimelineEntry<T>,
    start: string,
    end: string,
    initiator: HTMLElement,
  ): Promise<boolean> => {
    if (!options.onSetRange) return false;
    try {
      const result = await Promise.resolve(options.onSetRange(entry, start, end, initiator));
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

  const confirmRepair = async (
    entry: TimelineEntry<T>,
    initiator: HTMLElement,
  ): Promise<boolean> => {
    if (!options.onConfirmRepair) return false;
    try {
      const result = await Promise.resolve(options.onConfirmRepair(entry, initiator));
      if (successful(result)) {
        feedback.empty();
        delete feedback.dataset['resultType'];
        return true;
      }
      feedback.dataset['resultType'] = result.type;
      feedback.setText('Timeline repair was not applied.');
    } catch {
      feedback.dataset['resultType'] = 'io-error';
      feedback.setText('Timeline repair could not be applied.');
    }
    if (initiator.isConnected) initiator.focus({ preventScroll: true });
    return false;
  };

  const onScheduleChange = (event: Event): void => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.value) return;
    const entry = scheduleEntryByInput.get(event.target);
    if (!entry) return;
    const role =
      typeof options.undatedRole === 'function'
        ? options.undatedRole(entry)
        : (options.undatedRole ?? 'scheduled');
    if (canSetDate(entry, role)) void commit(entry, role, event.target.value, event.target);
  };
  root.addEventListener('change', onScheduleChange);
  cleanups.push(() => root.removeEventListener('change', onScheduleChange));

  if (dated.length > 0) {
    const datedSection = root.createDiv({ cls: 'abyss-timeline-dated' });
    const scroll = datedSection.createDiv({ cls: 'abyss-timeline-scroll' });
    const canvas = scroll.createDiv({ cls: 'abyss-timeline-canvas' });
    const axis = canvas.createDiv({
      cls: 'abyss-timeline-axis',
    });
    const axisIdentity = axis.createDiv({ cls: 'abyss-timeline-axis-identity' });
    const resizeHandle = axisIdentity.createEl('button', {
      cls: 'abyss-timeline-identity-resize abyss-timeline-touch-target',
      attr: {
        type: 'button',
        'data-timeline-identity-resize': '',
        'data-timeline-target': 'identity-column',
        'aria-label': 'Resize timeline identity column',
        title: 'Resize timeline identity column',
      },
    });
    const axisPlot = axis.createDiv({
      cls: 'abyss-timeline-axis-plot',
      attr: { 'aria-hidden': 'true' },
    });
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
    const rowExtent = isAgenda ? TIMELINE_AGENDA_ROW_EXTENT : TIMELINE_ROW_EXTENT;
    const verticalViewport = (seedFirst?: number): { first: number; visible: number } => ({
      first: seedFirst ?? Math.floor(Math.max(0, scroll.scrollTop) / rowExtent),
      visible:
        scroll.clientHeight > 0
          ? Math.ceil(scroll.clientHeight / rowExtent)
          : TIMELINE_FALLBACK_VISIBLE_ROWS,
    });

    let midpoint = dates[Math.floor((dates.length - 1) / 2)] ?? today;
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
          ...(!isAgenda ? { tabindex: '-1' } : {}),
        },
      });
      picker.disabled = !canSetDate(entry, role);
      return picker;
    };

    const renderCoarseMenu = (controls: HTMLElement, entry: TimelineEntry<T>): void => {
      if (!coarsePointer) return;
      const menu = controls.createEl('details', { cls: 'abyss-timeline-coarse-menu' });
      menu.createEl('summary', {
        cls: 'abyss-timeline-touch-target',
        text: '•••',
        attr: { 'aria-label': `Timeline actions for ${entry.label}` },
      });
      const coarseActions =
        entry.item.kind === 'range'
          ? ([
              ['range-previous', 'Move range earlier'],
              ['range-next', 'Move range later'],
              ['start-previous', 'Move start earlier'],
              ['start-next', 'Move start later'],
              ['end-previous', 'Move end earlier'],
              ['end-next', 'Move end later'],
            ] as const)
          : ([
              ['move-previous', 'Move earlier'],
              ['move-next', 'Move later'],
            ] as const);
      for (const [action, label] of coarseActions) {
        const button = menu.createEl('button', {
          cls: 'abyss-timeline-touch-target',
          text: label,
          attr: { type: 'button', 'data-timeline-coarse-action': action },
        });
        if (action.startsWith('range-')) button.disabled = !canSetRange(entry);
        else {
          const role = coarseTimelineRole(entry.item, action);
          button.disabled = !canSetDate(entry, role);
        }
      }
    };

    const renderInteraction = (
      plot: HTMLElement,
      controls: HTMLElement,
      entry: TimelineEntry<T>,
    ): void => {
      const geometry = geometryForEntry(entry);
      if (!geometry || !geometry.visible) return;
      if (!isAgenda && entry.item.kind === 'range' && geometry.kind === 'range') {
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
        move.disabled = !canSetRange(entry);
        move.setAttribute('aria-disabled', String(move.disabled));
        if (!move.disabled) registerTarget(move, targetFor(entry, 'range-move'));
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
          edge.disabled = !canSetDate(entry, role);
          if (!edge.disabled) registerTarget(edge, targetFor(entry, kind));
        }
      } else if (!isAgenda && entry.item.kind === 'point' && geometry.kind !== 'range') {
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
        point.disabled = !canSetDate(entry, entry.item.role);
        if (!point.disabled) registerTarget(point, targetFor(entry, targetKind));
      }

      const roles = pointRoles(entry.item);
      for (const role of roles) addPicker(controls, entry, role);
      renderCoarseMenu(controls, entry);
    };

    const repositionRenderedEntries = (): void => {
      for (const row of rows.querySelectorAll<HTMLElement>(
        '.abyss-timeline-row[data-timeline-key]',
      )) {
        const entry = entryByKey.get(row.dataset['timelineKey'] ?? '');
        if (!entry) continue;
        const geometry = geometryForEntry(entry);
        if (!geometry || !geometry.visible) continue;
        if (entry.item.kind === 'range' && geometry.kind === 'range') {
          const range = row.querySelector<HTMLElement>('[data-timeline-range]');
          if (!range) continue;
          range.style.insetInlineStart = `${String(geometry.left)}px`;
          range.style.inlineSize = `${String(geometry.width)}px`;
          continue;
        }
        if (entry.item.kind === 'point' && geometry.kind !== 'range') {
          const point = row.querySelector<HTMLElement>('[data-timeline-primary]');
          if (!point) continue;
          point.style.insetInlineStart = `${String(geometry.centerX)}px`;
          point.style.inlineSize = `${String(geometry.size)}px`;
          point.style.blockSize = `${String(geometry.size)}px`;
        }
      }
    };

    let renderWindow = (restoreFocus = false, seedFirst?: number): void => {
      if (destroyed) return;
      const result = bounded.render(rows, {
        ...verticalViewport(seedFirst),
        itemExtent: rowExtent,
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
          return timelineRowFocusTarget(row, identity, isAgenda);
        },
      });
      if (restoreFocus || seedFirst !== undefined) {
        scroll.scrollTop = result.first * rowExtent;
      }
      options.onRowsRendered?.();
    };

    const visiblePlotWidth = (): number => {
      const measured = scroll.clientWidth - identityWidth;
      return Math.max(1, measured > 0 ? measured : Math.min(plotWidth, 480));
    };

    const renderAxisWindow = (): void => {
      if (isAgenda) return;
      const visibleWidth = visiblePlotWidth();
      const visibleStart = Math.max(0, scroll.scrollLeft - identityWidth);
      const overscan = visibleWidth;
      const fromDate = timelineDateAtX(viewport, Math.max(0, visibleStart - overscan));
      const toDate = timelineDateAtX(
        viewport,
        Math.min(plotWidth, visibleStart + visibleWidth + overscan),
      );
      const from = window && fromDate < window.from ? window.from : fromDate;
      const to = window && toDate > window.to ? window.to : toDate;
      const activeDate = timelineDateAtX(
        viewport,
        Math.max(0, Math.min(plotWidth, visibleStart + visibleWidth / 2)),
      );
      const markerDates = cappedTimelineDates(continuousDates(from, to), TIMELINE_MARKER_DOM_CAP, [
        activeDate,
        session?.focalDate ?? undefined,
      ]);
      axisCoordinates.empty();
      axisLabels.empty();
      for (const date of markerDates) {
        const marker = axisCoordinates.createSpan({
          attr: { 'data-timeline-date-coordinate': date },
        });
        marker.style.insetInlineStart = `${String(civilDateToX(viewport, date))}px`;
      }
      for (const { date, x, align } of spacedTimelineAxisLabels(markerDates, viewport, plotWidth, [
        activeDate,
        session?.focalDate ?? undefined,
      ])) {
        const label = axisLabels.createSpan({
          text: date.slice(5),
          attr: {
            'data-timeline-axis-label-date': date,
            'data-timeline-axis-label-align': align,
          },
        });
        label.style.insetInlineStart = `${String(x)}px`;
      }
      cullOverlappingTimelineAxisLabels(axisLabels);
    };

    const centerOn = (date: string): void => {
      const visibleWidth = visiblePlotWidth();
      const desired = identityWidth + civilDateToX(viewport, date) - visibleWidth / 2;
      scroll.scrollLeft = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, desired));
      renderAxisWindow();
      if (session) session.scrollLeft = scroll.scrollLeft;
    };

    const refreshGeometry = (preserveFocal = true): void => {
      window = contentWindow;
      const requiredDate = civilDate(session?.focalDate ?? undefined) ?? requiredPresentationDate;
      if (requiredDate) {
        const requiredWindow = paddedDateWindow({ from: requiredDate, to: requiredDate });
        window = window
          ? {
              from: window.from < requiredWindow.from ? window.from : requiredWindow.from,
              to: window.to > requiredWindow.to ? window.to : requiredWindow.to,
            }
          : requiredWindow;
      }
      dates = window ? continuousDates(window.from, window.to) : [];
      midpoint = dates[Math.floor((dates.length - 1) / 2)] ?? today;
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
      const availablePlotWidth = Math.max(0, scroll.clientWidth - identityWidth);
      const requiredDateCount = Math.ceil(availablePlotWidth / probe.pixelsPerDay);
      if (window && dates.length < requiredDateCount) {
        const missing = requiredDateCount - dates.length;
        const before = Math.floor(missing / 2);
        const after = missing - before;
        const from = shiftCivilDate(window.from, -before) ?? window.from;
        const to = shiftCivilDate(window.to, after) ?? window.to;
        window = { from, to };
        dates = continuousDates(from, to);
        midpoint = dates[Math.floor((dates.length - 1) / 2)] ?? midpoint;
      }
      plotWidth = Math.max(1, availablePlotWidth, dates.length * probe.pixelsPerDay);
      viewport = buildViewport();
      canvas.style.inlineSize = `calc(var(--abyss-timeline-identity-width) + ${String(plotWidth)}px)`;
      canvas.style.setProperty('--abyss-timeline-plot-width', `${String(plotWidth)}px`);
      renderAxisWindow();
      canvas.querySelector('[data-timeline-today-line]')?.remove();
      if (!isAgenda && dates.includes(today)) {
        const todayLine = canvas.createDiv({
          cls: 'abyss-timeline-today-line',
          attr: { 'data-timeline-today-line': '', 'aria-hidden': 'true' },
        });
        todayLine.style.insetInlineStart = `calc(var(--abyss-timeline-identity-width) + ${String(civilDateToX(viewport, today))}px)`;
      }
      renderWindow(false);
      repositionRenderedEntries();
      const focal = session?.focalDate ?? requiredPresentationDate ?? midpoint;
      if (preserveFocal && civilDate(focal)) centerOn(focal);
    };

    reflowTimeline = () => refreshGeometry(true);

    registerTarget(resizeHandle, { kind: 'identity-column', width: identityWidth });

    const notifyPresentationChange = (): void => {
      void options.onPresentationChange?.({ scale, identityWidth });
    };

    const applyIdentityWidth = (width: number, notify = false): void => {
      identityWidth = clampTimelineIdentityWidth(width);
      root.style.setProperty('--abyss-timeline-identity-width', `${String(identityWidth)}px`);
      if (session) session.identityWidth = identityWidth;
      registerTarget(resizeHandle, { kind: 'identity-column', width: identityWidth });
      if (notify) {
        refreshGeometry(true);
        notifyPresentationChange();
      } else {
        renderAxisWindow();
      }
    };

    const previewIdentityWidth = (width: number): void => {
      root.style.setProperty(
        '--abyss-timeline-identity-width',
        `${String(clampTimelineIdentityWidth(width))}px`,
      );
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
        if (projection.activeTarget === 'identity-column' && projection.draftWidth !== undefined) {
          previewIdentityWidth(projection.draftWidth);
          if (session) {
            session.focusedInteraction = {
              itemKey: 'identity-column',
              role: 'identity-column',
            };
          }
        } else {
          previewIdentityWidth(identityWidth);
          if (session) session.focusedInteraction = null;
        }
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
        attr: { 'data-timeline-preview': '' },
      });
      if (geometry.kind === 'range') {
        preview.style.insetInlineStart = `${String(geometry.left)}px`;
        preview.style.inlineSize = `${String(geometry.width)}px`;
        preview.dataset['timelinePreviewStart'] =
          previewGeometry.kind === 'range' ? previewGeometry.start : '';
        preview.dataset['timelinePreviewEnd'] =
          previewGeometry.kind === 'range' ? previewGeometry.end : '';
        preview.title = `${preview.dataset['timelinePreviewStart']} – ${preview.dataset['timelinePreviewEnd']}`;
      } else {
        preview.style.insetInlineStart = `${String(geometry.centerX)}px`;
        preview.style.inlineSize = `${String(geometry.size)}px`;
        if (previewGeometry.kind !== 'range') {
          preview.dataset['timelinePreviewAt'] = previewGeometry.at;
          preview.title = previewGeometry.at;
        }
      }
      preview.createSpan({ cls: 'abyss-timeline-preview-label', text: preview.title });
    };

    const applyDateIntent = async (
      intent: Extract<TimelineCommitIntent<string>, { type: 'date-change' }>,
    ): Promise<boolean> => {
      const entry = entryByKey.get(intent.itemId);
      if (!entry) return false;
      const overlayKey = options.optimisticOverlay?.keyOf(entry);
      if (overlayKey && options.optimisticOverlay?.store.active(overlayKey)) {
        feedback.dataset['resultType'] = 'pending';
        feedback.setText('A timeline date update is already pending.');
        return false;
      }
      let patch: Readonly<Partial<Record<TimelinePointRole, string>>>;
      if ('start' in intent.draft) {
        if (intent.target === 'start-edge') patch = { start: intent.draft.start.raw };
        else if (intent.target === 'end-edge') patch = { end: intent.draft.end.raw };
        else patch = { start: intent.draft.start.raw, end: intent.draft.end.raw };
      } else {
        patch = { [intent.ownedRole as TimelinePointRole]: intent.draft.at.raw };
      }
      const transaction = options.optimisticOverlay?.store.begin(
        entry,
        options.optimisticOverlay.revision(entry),
        patch,
        { id: overlayOwnerId ?? `timeline:${scope}` },
      );
      if (transaction) onOverlayChanged?.();
      let changed: boolean;
      if ('start' in intent.draft) {
        if (intent.target === 'start-edge') {
          changed = await commit(entry, 'start', intent.draft.start.raw, initiatingElement);
        } else if (intent.target === 'end-edge') {
          changed = await commit(entry, 'end', intent.draft.end.raw, initiatingElement);
        } else {
          changed = await commitRange(
            entry,
            intent.draft.start.raw,
            intent.draft.end.raw,
            initiatingElement,
          );
        }
      } else {
        changed = await commit(
          entry,
          intent.ownedRole as TimelinePointRole,
          intent.draft.at.raw,
          initiatingElement,
        );
      }
      if (transaction)
        options.optimisticOverlay?.store.observeCommandResult(
          options.optimisticOverlay.keyOf(entry),
          { type: changed ? 'ok' : (feedback.dataset['resultType'] ?? 'failure') },
          transaction.id,
          transaction.token,
        );
      return changed;
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
        const message = timelineAnnouncementText(announcement);
        if (feedback.textContent !== message) feedback.setText(message);
        if (announcement.type === 'conflict' || announcement.type === 'failure') {
          feedback.dataset['resultType'] = announcement.type;
        } else {
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
        if (isAgenda) {
          if (
            row &&
            initiatingElement.isConnected &&
            initiatingElement.closest<HTMLElement>('.abyss-timeline-row') === row
          ) {
            initiatingElement.focus({ preventScroll: true });
            return;
          }
          const pickerRole = role === 'range' ? 'start' : role;
          const visibleTarget =
            row?.querySelector<HTMLElement>(
              `[data-timeline-date-picker="${pickerRole}"]:not(:disabled)`,
            ) ?? row?.querySelector<HTMLElement>('.abyss-timeline-identity button, summary');
          visibleTarget?.focus({ preventScroll: true });
          return;
        }
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
        enabled:
          target.kind === 'range-move'
            ? options.onSetRange !== undefined
            : options.onSetDate !== undefined || target.kind === 'identity-column',
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
        enabled:
          target?.kind === 'range-move'
            ? options.onSetRange !== undefined
            : options.onSetDate !== undefined || target?.kind === 'identity-column',
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
      if (entry && role && canSetDate(entry, role)) void commit(entry, role, picker.value, picker);
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
      const entry = entryByKey.get(row?.dataset['timelineKey'] ?? '');
      const actionName = action.dataset['timelineCoarseAction'] ?? '';
      const targetName = entry && coarseTimelineTarget(entry.item, actionName);
      const target = entry && targetName ? targetFor(entry, targetName) : undefined;
      if (!target) return;
      initiatingElement = action;
      const key = actionName.endsWith('previous') ? 'ArrowLeft' : 'ArrowRight';
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
      const visibleWidth = visiblePlotWidth();
      const plotX = Math.max(0, scroll.scrollLeft - identityWidth + visibleWidth / 2);
      session.focalDate = timelineDateAtX(viewport, plotX);
    };
    let renderedScrollTop = scroll.scrollTop;
    const onScroll = (): void => {
      rememberViewport();
      renderAxisWindow();
      if (scroll.scrollTop === renderedScrollTop) return;
      renderedScrollTop = scroll.scrollTop;
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
    if (isAgenda) scroll.scrollLeft = 0;
    else if (session?.scrollLeft !== undefined) scroll.scrollLeft = session.scrollLeft;
    else centerOn(session?.focalDate ?? midpoint);
    if (isAgenda) axis.remove();
    rememberViewport();
    renderedScrollTop = scroll.scrollTop;

    const onScaleChange = (event: MouseEvent): void => {
      const control =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLButtonElement>('[data-timeline-scale]')
          : null;
      const next = control?.dataset['scale'];
      if (!isTimelineScale(scope, next)) return;
      const changed = next !== scale;
      scale = next;
      if (session) session.scale = scale;
      for (const [candidate, button] of scaleButtons) {
        button.setAttribute('aria-pressed', String(candidate === scale));
      }
      refreshGeometry(true);
      if (changed) notifyPresentationChange();
    };
    const onToday = (): void => {
      requiredPresentationDate = today;
      if (session) session.focalDate = today;
      if (!contentWindow || today < contentWindow.from || today > contentWindow.to) {
        refreshGeometry(false);
      }
      centerOn(today);
    };
    scaleControl.addEventListener('click', onScaleChange);
    todayButton.addEventListener('click', onToday);
    cleanups.push(() => {
      scaleControl.removeEventListener('click', onScaleChange);
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
    const diagnosticRowExtent = isAgenda
      ? TIMELINE_AGENDA_DIAGNOSTIC_ROW_EXTENT
      : TIMELINE_DIAGNOSTIC_ROW_EXTENT;
    const focusedKey = options.focusedItemKey?.() ?? options.session?.focusedKey;
    if (focusedKey && keys.includes(focusedKey)) bounded.focus(focusedKey);
    const viewport = (): { first: number; visible: number } => ({
      first: Math.floor(Math.max(0, scroll.scrollTop) / diagnosticRowExtent),
      visible:
        scroll.clientHeight > 0
          ? Math.ceil(scroll.clientHeight / diagnosticRowExtent)
          : TIMELINE_DIAGNOSTIC_VISIBLE_ROWS,
    });
    if (focusedKey && keys.includes(focusedKey)) {
      scroll.scrollTop = bounded.viewportForFocus(viewport()) * diagnosticRowExtent;
    }
    const renderWindow = (restoreFocus = false): void => {
      bounded.render(rows, {
        ...viewport(),
        itemExtent: diagnosticRowExtent,
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
            row.createSpan({
              cls: 'abyss-timeline-diagnostic-reason',
              text: timelineDiagnosticReason(entry.item.reason),
              attr: { 'data-timeline-diagnostic-code': entry.item.reason },
            });
            const proposal = options.repairProposal?.(entry);
            if (proposal && options.onConfirmRepair) {
              row.createSpan({
                cls: 'abyss-timeline-repair-preview',
                text: proposal.preview,
                attr: { 'data-timeline-repair-preview': '' },
              });
              const confirm = row.createEl('button', {
                cls: 'abyss-timeline-repair-confirm abyss-timeline-touch-target',
                text: 'Apply repair',
                attr: {
                  type: 'button',
                  'data-timeline-repair-confirm': '',
                  'aria-label': `Apply timeline repair for ${entry.label}`,
                },
              });
              bindTimelineRepair(confirm, entry, confirmRepair);
            }
          } else if (
            canSetDate(
              entry,
              typeof options.undatedRole === 'function'
                ? options.undatedRole(entry)
                : (options.undatedRole ?? 'scheduled'),
            )
          ) {
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
          return timelineRowFocusTarget(row, identity, isAgenda);
        },
      });
      options.onRowsRendered?.();
    };
    const onScroll = (): void => renderWindow(false);
    scroll.addEventListener('scroll', onScroll);
    cleanups.push(() => scroll.removeEventListener('scroll', onScroll));
    renderWindow(focusedKey !== undefined && focusedKey !== null && keys.includes(focusedKey));
  };
  renderDiagnosticSection(undated, 'abyss-timeline-undated', 'Planning');
  renderDiagnosticSection(invalid, 'abyss-timeline-invalid', 'Invalid');

  return {
    reflow: () => reflowTimeline?.(),
    destroy: () => {
      destroyed = true;
      controller?.destroy();
      if (session) session.focusedInteraction = null;
      if (autoscrollFrame !== null && ownerWindow)
        ownerWindow.cancelAnimationFrame(autoscrollFrame);
      for (const cleanup of cleanups.splice(0)) cleanup();
      container.empty();
    },
  };
}

function timelineDiagnosticReason(reason: string): string {
  if (reason === 'invalid-start') return 'Start date is invalid';
  if (reason === 'invalid-end') return 'End date is invalid';
  if (reason === 'invalid-due') return 'Due date is invalid';
  if (reason === 'invalid-scheduled') return 'Scheduled date is invalid';
  if (reason === 'milestone-range') return 'Milestones use one date';
  if (reason === 'reversed') return 'Start date is after end date';
  return 'Timeline dates need attention';
}

function movedProjectDate(current: ProjectDateValue | undefined, date: string) {
  return current ? projectDateOnLocalDate(current, date.slice(0, 10)) : parseProjectDate(date);
}

interface ProjectRepair extends TimelineRepairProposal {
  readonly patch: ProjectRangePatch;
}

function projectRepair(project: Project, today: string): ProjectRepair | undefined {
  const issue = project.range.issue;
  if (!issue) return undefined;
  let patch: ProjectRangePatch;
  if (issue === 'reversed' && project.range.start && project.range.end) {
    patch = { start: project.range.end, end: project.range.start };
  } else if (issue === 'invalid-start') {
    const start = project.range.end ?? parseProjectDate(today);
    if (!start) return undefined;
    patch = { start };
  } else if (issue === 'invalid-end') {
    const end = project.range.start ?? parseProjectDate(today);
    if (!end) return undefined;
    patch = { end };
  } else {
    return undefined;
  }
  const start = patch.start === undefined ? project.range.start : (patch.start ?? undefined);
  const end = patch.end === undefined ? project.range.end : (patch.end ?? undefined);
  return {
    patch,
    preview: start && end ? `${start.raw} – ${end.raw}` : (start?.raw ?? end?.raw ?? today),
  };
}

function localToday(): string {
  const now = new Date();
  return [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Project projection/command adapter for the shared Timeline shell. */
export function renderProjectsTimeline(
  container: HTMLElement,
  options: ProjectsTimelineOptions,
): TimelineViewHandle {
  const entries: readonly TimelineEntry<PortfolioTimelineValue>[] = options.snapshots
    ? portfolioTimelineEntries(options.snapshots)
    : options.projects.map((project) => ({
        ...projectTimelineEntry(project),
        value: { kind: 'project' as const, project },
      }));
  const canonicalEntries: readonly TimelineEntry<PortfolioTimelineValue>[] | undefined =
    options.canonicalSnapshots
      ? portfolioTimelineEntries(options.canonicalSnapshots)
      : options.canonicalProjects?.map((project) => ({
          ...projectTimelineEntry(project),
          value: { kind: 'project' as const, project },
        }));
  const projectObservations = new Map(
    entries.flatMap((entry) =>
      entry.value.kind === 'project'
        ? [[entry.item.key, options.commands.observeRange(entry.value.project)] as const]
        : [],
    ),
  );
  const milestoneObservations = new Map(
    entries.flatMap((entry) => {
      if (entry.value.kind !== 'milestone') return [];
      const observation =
        options.milestoneAdapter?.observeDates(entry.value.note) ??
        options.milestoneCommands?.observeRange(entry.value.note);
      return observation ? [[entry.item.key, observation] as const] : [];
    }),
  );
  const today = options.today ?? localToday();
  const repairs = new Map(
    entries.flatMap((entry) => {
      if (entry.value.kind !== 'project') return [];
      const repair = projectRepair(entry.value.project, today);
      return repair ? [[entry.item.key, repair] as const] : [];
    }),
  );

  return renderTimeline<PortfolioTimelineValue>(container, {
    entries,
    ...(canonicalEntries && { canonicalPublicationEntries: canonicalEntries }),
    optimisticOverlay: timelineOptimisticOverlay(
      options.overlayScope,
      'portfolio',
      options.publicationSequence,
      (entry) => entry.item.key,
      options.pathSuccessor
        ? (observed, published) => {
            if (observed.value.kind !== published.value.kind) return false;
            const observedPath =
              observed.value.kind === 'project'
                ? observed.value.project.path
                : observed.value.note.path;
            const publishedPath =
              published.value.kind === 'project'
                ? published.value.project.path
                : published.value.note.path;
            return options.pathSuccessor!(observedPath, publishedPath);
          }
        : undefined,
    ),
    scope: 'portfolio',
    undatedRole: (entry) => (entry.value.kind === 'milestone' ? 'milestone' : 'start'),
    today,
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
    ...(options.openProject || options.onSelectMilestone
      ? {
          renderIdentity: (host, entry) => {
            if (entry.value.kind === 'milestone') {
              const milestone = entry.value;
              host.addClass('abyss-project-milestone-timeline-identity');
              const button = host.createEl('button', {
                cls: 'abyss-timeline-title abyss-work-note-identity',
                text: entry.label,
                attr: {
                  type: 'button',
                  'data-project-milestone-identity-control': '',
                  'aria-label': `Milestone details ${entry.label}`,
                },
              });
              button.dataset['inspectorOriginKey'] = inspectorSelectionKey({
                type: 'work-note',
                path: milestone.note.path,
                projectPath: milestone.projectPath,
              });
              button.addEventListener('click', () =>
                options.onSelectMilestone?.(milestone.note, button),
              );
              host.createSpan({
                cls: 'abyss-timeline-detail abyss-project-milestone-owner',
                text: `Milestone · ${milestone.projectName}`,
              });
              return;
            }
            const { project, snapshot } = entry.value;
            host.addClass('abyss-project-timeline-identity');
            const button = host.createEl('button', {
              cls: 'abyss-timeline-title abyss-project-identity-control',
              text: entry.label,
              attr: {
                type: 'button',
                'data-project-identity-control': '',
                'aria-label': `Open project ${entry.label}`,
              },
            });
            button.addEventListener('click', () => options.openProject?.(project.path));
            if (project.priority && project.priority !== 'D') {
              host.createSpan({
                cls: 'abyss-project-priority',
                text: project.priority,
                attr: {
                  'data-priority': project.priority,
                  'aria-label': `Priority ${project.priority}`,
                },
              });
            }
            const severity = snapshot
              ? projectHealthProjection(snapshot, { today }).severity
              : 'unknown';
            host.createSpan({
              cls: `abyss-project-health abyss-project-health--${severity}`,
              attr: {
                role: 'img',
                title: `Project health: ${severity}`,
                'aria-label': `Project health: ${severity}`,
              },
            });
          },
        }
      : {}),
    canSetDate: (entry, role) =>
      entry.value.kind === 'project'
        ? role === 'start' || role === 'end'
        : (options.milestoneAdapter !== undefined || options.milestoneCommands !== undefined) &&
          (role === 'milestone' || role === 'start' || role === 'end'),
    canSetRange: (entry) =>
      entry.value.kind === 'project' ||
      (entry.item.kind === 'range' &&
        (options.milestoneAdapter !== undefined || options.milestoneCommands !== undefined)),
    onSetDate: async (entry, role, date) => {
      if (entry.value.kind === 'project') {
        if (role !== 'start' && role !== 'end') {
          return { type: 'invalid', issue: 'invalid-start' };
        }
        const value = movedProjectDate(entry.value.project.range[role], date);
        if (!value) return { type: 'invalid', issue: `invalid-${role}` };
        const observation = projectObservations.get(entry.item.key);
        if (!observation) return { type: 'invalid', issue: 'path' };
        const result = await options.commands.setRange(observation, { [role]: value });
        options.onMutation?.(entry.value.project, result);
        return result;
      }
      const observation = milestoneObservations.get(entry.item.key);
      if (!observation || (role !== 'milestone' && role !== 'start' && role !== 'end')) {
        return { type: 'invalid', field: 'path' };
      }
      let field: 'start' | 'end' = 'start';
      if (role === 'end' || (role === 'milestone' && observation.end && !observation.start)) {
        field = 'end';
      }
      const current = observation[field];
      const value = movedProjectDate(current, date);
      if (!value) return { type: 'invalid', field };
      const result = options.milestoneAdapter
        ? await options.milestoneAdapter.setDates(entry.value.note, { [field]: value })
        : await options.milestoneCommands!.setRange(observation.observed, { [field]: value });
      options.onMilestoneMutation?.(entry.value.note, result);
      return result;
    },
    onSetRange: async (entry, start, end) => {
      if (entry.value.kind === 'project') {
        const nextStart = movedProjectDate(entry.value.project.range.start, start);
        const nextEnd = movedProjectDate(entry.value.project.range.end, end);
        if (!nextStart) return { type: 'invalid', issue: 'invalid-start' };
        if (!nextEnd) return { type: 'invalid', issue: 'invalid-end' };
        const observation = projectObservations.get(entry.item.key);
        if (!observation) return { type: 'invalid', issue: 'path' };
        const result = await options.commands.setRange(observation, {
          start: nextStart,
          end: nextEnd,
        });
        options.onMutation?.(entry.value.project, result);
        return result;
      }
      const observation = milestoneObservations.get(entry.item.key);
      if (!observation) return { type: 'invalid', field: 'path' };
      const nextStart = movedProjectDate(observation.start, start);
      const nextEnd = movedProjectDate(observation.end, end);
      if (!nextStart) return { type: 'invalid', field: 'start' };
      if (!nextEnd) return { type: 'invalid', field: 'end' };
      const patch = { start: nextStart, end: nextEnd };
      const result = options.milestoneAdapter
        ? await options.milestoneAdapter.setDates(entry.value.note, patch)
        : await options.milestoneCommands!.setRange(observation.observed, patch);
      options.onMilestoneMutation?.(entry.value.note, result);
      return result;
    },
    repairProposal: (entry) => repairs.get(entry.item.key),
    onConfirmRepair: async (entry) => {
      if (entry.value.kind !== 'project') return { type: 'invalid', issue: 'path' };
      const repair = repairs.get(entry.item.key);
      const observation = projectObservations.get(entry.item.key);
      if (!repair || !observation) return { type: 'invalid', issue: 'path' };
      const result = await options.commands.setRange(observation, repair.patch);
      options.onMutation?.(entry.value.project, result);
      return result;
    },
  });
}

/** Guarded Work Note projection/command adapter for the shared Timeline shell. */
export function renderWorkNotesTimeline(
  container: HTMLElement,
  options: WorkNotesTimelineOptions,
): TimelineViewHandle {
  const prepared = options.notes.map((note) => {
    let observation = null;
    if (options.commandsEnabled !== false) {
      observation =
        note.kind === 'milestone' && options.milestoneAdapter
          ? options.milestoneAdapter.observeDates(note)
          : options.commands.observeRange(note);
    }
    return { entry: workNoteTimelineEntry(note), observation };
  });
  const canonicalEntries = options.canonicalNotes?.map(workNoteTimelineEntry);
  const observations = new Map(
    prepared.map(({ entry, observation }) => [entry.item.key, observation] as const),
  );
  const onSetDate = async (
    entry: TimelineEntry<WorkNoteSnapshot>,
    role: TimelinePointRole,
    date: string,
  ): Promise<WorkNoteCommandResult> => {
    const observation = observations.get(entry.item.key);
    if (!observation) return { type: 'invalid', field: 'path' };
    let field = role;
    if (role === 'milestone') {
      field = observation.end && !observation.start ? 'end' : 'start';
    }
    if (field !== 'start' && field !== 'end') return { type: 'invalid', field };
    const current = observation[field];
    const value = movedProjectDate(current, date);
    if (!value) return { type: 'invalid', field };
    const result =
      entry.value.kind === 'milestone' && options.milestoneAdapter
        ? await options.milestoneAdapter.setDates(entry.value, { [field]: value })
        : await options.commands.setRange(observation.observed, { [field]: value });
    options.onMutation?.(entry.value, result);
    return result;
  };
  const onSetRange = async (
    entry: TimelineEntry<WorkNoteSnapshot>,
    start: string,
    end: string,
  ): Promise<WorkNoteCommandResult> => {
    const observation = observations.get(entry.item.key);
    if (!observation) return { type: 'invalid', field: 'path' };
    const nextStart = observation.start && movedProjectDate(observation.start, start);
    const nextEnd = observation.end && movedProjectDate(observation.end, end);
    if (!nextStart) return { type: 'invalid', field: 'start' };
    if (!nextEnd) return { type: 'invalid', field: 'end' };
    const patch = { start: nextStart, end: nextEnd };
    const result =
      entry.value.kind === 'milestone' && options.milestoneAdapter
        ? await options.milestoneAdapter.setDates(entry.value, patch)
        : await options.commands.setRange(observation.observed, patch);
    options.onMutation?.(entry.value, result);
    return result;
  };
  return renderTimeline<WorkNoteSnapshot>(container, {
    entries: prepared.map(({ entry }) => entry),
    ...(canonicalEntries && { canonicalPublicationEntries: canonicalEntries }),
    optimisticOverlay: timelineOptimisticOverlay(
      options.overlayScope,
      'work-notes',
      options.publicationSequence,
      (entry) => entry.item.key,
      options.pathSuccessor
        ? (observed, published) => options.pathSuccessor!(observed.value.path, published.value.path)
        : undefined,
    ),
    scope: 'workNotes',
    undatedRole: (entry) => (entry.value.kind === 'milestone' ? 'milestone' : 'start'),
    ...(options.today && { today: options.today }),
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
    ...(options.commandsEnabled === false ? {} : { onSetDate, onSetRange }),
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
  const canonicalActions = options.canonicalActions ?? options.actions;
  const canonicalEntries = options.canonicalActions?.map((action) => ({
    ...taskTimelineEntry(action.task),
    value: action,
  }));
  const taskIdCounts = new Map<string, number>();
  for (const { task } of canonicalActions) {
    const id = task.dependency?.id;
    if (id) taskIdCounts.set(id, (taskIdCounts.get(id) ?? 0) + 1);
  }
  const stableTaskTimelineKey = (entry: TimelineEntry<ProjectAction>): string => {
    const task = entry.value.task;
    const id = task.dependency?.id;
    if (id && taskIdCounts.get(id) === 1) return `id:${id}`;
    return `source:${task.ref.filePath}:${String(task.ref.line)}`;
  };
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
  const entryByKey = new Map(entries.map((entry) => [entry.item.key, entry] as const));
  const keyByRef = new Map(
    entries.map((entry) => [taskReconciliationKey(entry.value.task.ref), entry.item.key] as const),
  );
  const actionByRef = new Map(
    options.actions.map((action) => [taskReconciliationKey(action.task.ref), action] as const),
  );
  const initiallyFocusedRef = collection?.shouldRestoreFocus() ? collection.focusedRef() : null;
  let emphasizedRefKey = initiallyFocusedRef ? taskReconciliationKey(initiallyFocusedRef) : null;
  const dependencyCorridor = (entry: TimelineEntry<ProjectAction>): ReadonlySet<string> => {
    const corridor = new Set<string>();
    const visited = new Set<string>();
    const visit = (action: ProjectAction): void => {
      const actionKey = taskReconciliationKey(action.task.ref);
      if (visited.has(actionKey)) return;
      visited.add(actionKey);
      if (action.dependency.type !== 'blocked') return;
      for (const prerequisite of action.dependency.prerequisites) {
        const prerequisiteRefKey = taskReconciliationKey(prerequisite);
        const prerequisiteKey = keyByRef.get(prerequisiteRefKey);
        if (prerequisiteKey) corridor.add(prerequisiteKey);
        const prerequisiteAction = actionByRef.get(prerequisiteRefKey);
        if (prerequisiteAction) visit(prerequisiteAction);
      }
    };
    visit(entry.value);
    return corridor;
  };
  const applyDependencyEmphasis = (): void => {
    for (const row of container.querySelectorAll<HTMLElement>(
      '.abyss-timeline-row[data-timeline-key], .abyss-timeline-diagnostic-row[data-timeline-key]',
    )) {
      delete row.dataset['taskDependencyEmphasis'];
      row.removeAttribute('aria-current');
      row.removeAttribute('aria-description');
    }
    if (!emphasizedRefKey) return;
    const action = actionByRef.get(emphasizedRefKey);
    const emphasizedKey = keyByRef.get(emphasizedRefKey);
    if (!action || !emphasizedKey) return;
    const entry = entryByKey.get(emphasizedKey);
    if (!entry) return;
    const corridor = dependencyCorridor(entry);
    if (corridor.size === 0) return;
    const prerequisiteCount = corridor.size;
    const prerequisiteNoun = prerequisiteCount === 1 ? 'prerequisite' : 'prerequisites';
    for (const row of container.querySelectorAll<HTMLElement>(
      '.abyss-timeline-row[data-timeline-key], .abyss-timeline-diagnostic-row[data-timeline-key]',
    )) {
      const key = row.dataset['timelineKey'];
      if (key === emphasizedKey) {
        row.dataset['taskDependencyEmphasis'] = 'subject';
        row.setAttribute('aria-current', 'true');
        row.setAttribute(
          'aria-description',
          `Focused blocked task. Blocked by ${String(prerequisiteCount)} ${prerequisiteNoun}.`,
        );
      } else if (key && corridor.has(key)) {
        row.dataset['taskDependencyEmphasis'] = 'prerequisite';
        row.setAttribute(
          'aria-description',
          `Prerequisite for focused blocked task ${action.task.title}.`,
        );
      }
    }
  };
  const handle = renderTimeline(container, {
    entries,
    ...(canonicalEntries && { canonicalPublicationEntries: canonicalEntries }),
    optimisticOverlay: timelineOptimisticOverlay(
      options.overlayScope,
      'tasks',
      options.publicationSequence,
      stableTaskTimelineKey,
      options.taskSuccessor
        ? (observed, published) => options.taskSuccessor!(observed.value.task, published.value.task)
        : undefined,
    ),
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
          scale: presentation.scale,
          identityWidth: presentation.identityWidth,
        }),
    }),
    ...(options.session ? { session: options.session } : {}),
    ...(collection
      ? {
          focusedItemKey,
          shouldRestoreItemFocus: () => collection.shouldRestoreFocus(),
        }
      : {}),
    onItemFocus: (entry: TimelineEntry<ProjectAction>) => {
      emphasizedRefKey = taskReconciliationKey(entry.value.task.ref);
      collection?.focusOnly(entry.value.task.ref);
      applyDependencyEmphasis();
    },
    onItemBlur: () => {
      collection?.intentionalBlur();
      emphasizedRefKey = null;
      applyDependencyEmphasis();
    },
    onRowsRendered: applyDependencyEmphasis,
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
    onSetRange: (entry, start, end) => options.onSetRange(entry.value.task, start, end),
  });
  applyDependencyEmphasis();
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const row = target?.closest<HTMLElement>(
      '.abyss-timeline-row[data-timeline-key], .abyss-timeline-diagnostic-row[data-timeline-key]',
    );
    if (!row) return;
    const entry = entryByKey.get(row.dataset['timelineKey'] ?? '');
    if (!entry) return;
    emphasizedRefKey = taskReconciliationKey(entry.value.task.ref);
    applyDependencyEmphasis();
  };
  const onFocusOut = (): void => {
    queueMicrotask(() => {
      if (container.contains(container.ownerDocument.activeElement)) return;
      emphasizedRefKey = null;
      applyDependencyEmphasis();
    });
  };
  container.addEventListener('focusin', onFocusIn);
  container.addEventListener('focusout', onFocusOut);
  return {
    reflow: () => {
      handle.reflow?.();
      applyDependencyEmphasis();
    },
    destroy: () => {
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      handle.destroy();
    },
  };
}
