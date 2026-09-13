import {
  projectCalendarDayFromOrdinal,
  projectCalendarDayOrdinal,
} from '../../projects/projectDateValue';
import type { ProjectCellChange, ProjectEditResult } from '../../projects/projectEdits';
import type { ProjectField } from '../../projects/projectFields';
import type {
  ProjectTimelineEditIntent,
  ProjectTimelineRelativeEditIntent,
} from '../../projects/projectTimelineEdits';
import { planProjectTimelineEdit } from '../../projects/projectTimelineEdits';
import {
  projectTimelineBarGeometry,
  type ProjectTimelineBarGeometry,
  type ProjectTimelineRange,
  type ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';

export interface ProjectTimelineEndpointEvidence extends Pick<
  ProjectCellChange,
  'expectedExists' | 'expectedValue' | 'sourceKey' | 'sourceProperty'
> {
  readonly field: ProjectField;
  readonly expectedExists: boolean;
  readonly sourceKey: string;
  readonly sourceProperty: string;
}

export interface FrozenProjectTimelineRangeSource {
  readonly occurrenceId: string;
  readonly path: string;
  readonly start: ProjectTimelineEndpointEvidence;
  readonly end: ProjectTimelineEndpointEvidence;
  readonly range: ProjectTimelineRange;
}

type ProjectTimelineEndpointBinding = Pick<
  ProjectTimelineEndpointEvidence,
  'field' | 'sourceKey' | 'sourceProperty'
>;

export interface FrozenProjectTimelineRangeBinding {
  readonly occurrenceId: string;
  readonly path: string;
  readonly start: ProjectTimelineEndpointBinding;
  readonly end: ProjectTimelineEndpointBinding;
}

export type ProjectTimelineRangeCapture =
  | { readonly kind: 'ready'; readonly source: FrozenProjectTimelineRangeSource }
  | { readonly kind: 'rejected'; readonly reason: string };

export type ProjectTimelineRangeEditRequest =
  | {
      readonly kind: 'pointer';
      readonly source: FrozenProjectTimelineRangeSource;
      readonly intent: ProjectTimelineEditIntent;
    }
  | {
      readonly kind: 'keyboard';
      readonly target: FrozenProjectTimelineRangeBinding;
      readonly intent: ProjectTimelineRelativeEditIntent;
    };

export interface ProjectTimelineRangeCommitter {
  readonly captureRangeSource: (occurrenceId: string) => ProjectTimelineRangeCapture;
  readonly commitRangeEdit: (
    request: ProjectTimelineRangeEditRequest,
  ) => Promise<ProjectEditResult>;
  readonly reportRangeFailure: (failure: unknown) => void;
}

export function freezeProjectTimelineRangeBinding(
  source: FrozenProjectTimelineRangeSource,
): FrozenProjectTimelineRangeBinding {
  const binding = (endpoint: ProjectTimelineEndpointEvidence): ProjectTimelineEndpointBinding => ({
    field: { ...endpoint.field },
    sourceKey: endpoint.sourceKey,
    sourceProperty: endpoint.sourceProperty,
  });
  return {
    occurrenceId: source.occurrenceId,
    path: source.path,
    start: binding(source.start),
    end: binding(source.end),
  };
}

function sameEndpointBinding(
  expected: ProjectTimelineEndpointBinding,
  actual: ProjectTimelineEndpointEvidence,
): boolean {
  return (
    expected.field.id === actual.field.id &&
    expected.field.type === actual.field.type &&
    expected.field.property === actual.field.property &&
    expected.sourceProperty === actual.sourceProperty &&
    expected.sourceKey === actual.sourceKey
  );
}

export function sameProjectTimelineRangeBinding(
  frozen: FrozenProjectTimelineRangeBinding,
  current: FrozenProjectTimelineRangeSource,
): boolean {
  return (
    frozen.path === current.path &&
    frozen.occurrenceId === current.occurrenceId &&
    sameEndpointBinding(frozen.start, current.start) &&
    sameEndpointBinding(frozen.end, current.end)
  );
}

export function sameProjectTimelineRangeSource(
  frozen: FrozenProjectTimelineRangeSource,
  current: FrozenProjectTimelineRangeSource,
): boolean {
  return (
    sameProjectTimelineRangeBinding(frozen, current) &&
    frozen.start.expectedExists === current.start.expectedExists &&
    Object.is(frozen.start.expectedValue, current.start.expectedValue) &&
    frozen.end.expectedExists === current.end.expectedExists &&
    Object.is(frozen.end.expectedValue, current.end.expectedValue)
  );
}

interface ProjectTimelinePointerInteractionContext extends ProjectTimelineRangeCommitter {
  readonly root: HTMLElement;
  readonly scroll: HTMLElement;
  readonly window: () => ProjectTimelineWindow;
  readonly finishEditor: () => Promise<boolean>;
  readonly selectRange: (occurrenceId: string, focus: HTMLElement) => void;
}

type TimelinePointerPart = 'track' | 'bar' | 'start' | 'end';

interface TimelinePointerTarget {
  readonly occurrenceId: string;
  readonly track: HTMLElement;
  readonly bar: HTMLElement | null;
  readonly focus: HTMLElement;
  readonly part: TimelinePointerPart;
}

interface ActivePointerGesture {
  readonly pointerId: number;
  readonly target: TimelinePointerTarget;
  readonly source: FrozenProjectTimelineRangeSource;
  readonly startClientX: number;
  readonly startDay: string;
  lastClientX: number;
  lastDay: string;
  prepared: boolean;
  released: boolean;
  moved: boolean;
  readonly barSnapshot?: {
    readonly className: string;
    readonly hidden: boolean;
    readonly left: string;
    readonly width: string;
    readonly oneDateCenter: string;
  };
}

interface PendingPointerPreview {
  readonly id: number;
  readonly target: TimelinePointerTarget;
  readonly source: FrozenProjectTimelineRangeSource;
  readonly range: ProjectTimelineRange;
  barSnapshot?: ActivePointerGesture['barSnapshot'];
}

const MOVEMENT_THRESHOLD_PX = 4;
const EDGE_SCROLL_ZONE_PX = 32;
const EDGE_SCROLL_STEP_PX = 12;
const NESTED_CONTROL_SELECTOR = 'button, input, select, textarea, a, [contenteditable="true"]';

function pointerPart(element: HTMLElement): TimelinePointerPart | undefined {
  const part = element.dataset['timelinePart'];
  return part === 'track' || part === 'bar' || part === 'start' || part === 'end'
    ? part
    : undefined;
}

function eventTimelineTarget(event: Event): HTMLElement | undefined {
  if (!(event.target instanceof HTMLElement)) return undefined;
  const nestedControl = event.target.closest(NESTED_CONTROL_SELECTOR);
  return nestedControl !== null && !nestedControl.hasAttribute('data-timeline-part')
    ? undefined
    : event.target;
}

function barSnapshot(bar: HTMLElement | null): ActivePointerGesture['barSnapshot'] {
  return bar === null
    ? undefined
    : {
        className: bar.className,
        hidden: bar.hidden,
        left: bar.style.left,
        width: bar.style.width,
        oneDateCenter: bar.style.getPropertyValue('--abyss-project-timeline-one-date-center'),
      };
}

function isOneDateRange(range: ProjectTimelineRange): boolean {
  return (
    range.kind === 'open-start' ||
    range.kind === 'open-end' ||
    (range.kind === 'closed' && range.startDay === range.endDay)
  );
}

/** Applies exact calendar geometry while allowing CSS to compact one-date presentation. */
export function applyProjectTimelineBarGeometry(
  bar: HTMLElement,
  range: ProjectTimelineRange,
  geometry: ProjectTimelineBarGeometry,
): void {
  bar.className = `abyss-project-timeline-bar is-${range.kind}`;
  bar.style.left = `${geometry.leftPercent}%`;
  bar.style.width = `${geometry.widthPercent}%`;
  const oneDate = isOneDateRange(range);
  bar.toggleClass('is-one-date', oneDate);
  if (oneDate) {
    bar.style.setProperty(
      '--abyss-project-timeline-one-date-center',
      `${geometry.leftPercent + geometry.widthPercent / 2}%`,
    );
  } else {
    bar.style.removeProperty('--abyss-project-timeline-one-date-center');
  }
}

function resizedDay(sourceDay: string, deltaDays: number): string | undefined {
  const sourceOrdinal = projectCalendarDayOrdinal(sourceDay);
  return sourceOrdinal === undefined
    ? undefined
    : projectCalendarDayFromOrdinal(sourceOrdinal + deltaDays);
}

function rangeResizeSource(
  range: ProjectTimelineRange,
  endpoint: 'start' | 'end',
  fallback: string,
): string {
  if (endpoint === 'start' && (range.kind === 'closed' || range.kind === 'open-end')) {
    return range.startDay;
  }
  if (endpoint === 'end' && (range.kind === 'closed' || range.kind === 'open-start')) {
    return range.endDay;
  }
  return fallback;
}

function targetsMissingEndpoint(active: ActivePointerGesture): boolean {
  const { part } = active.target;
  const { range } = active.source;
  if (part === 'start') return range.kind === 'open-start' || range.kind === 'unscheduled';
  return part === 'end' && (range.kind === 'open-end' || range.kind === 'unscheduled');
}

function trackIntent(active: ActivePointerGesture): ProjectTimelineEditIntent | undefined {
  const { range } = active.source;
  if (range.kind === 'unscheduled') {
    return active.moved
      ? { type: 'draw', startDay: active.startDay, endDay: active.lastDay }
      : { type: 'setStart', day: active.lastDay };
  }
  if (range.kind === 'open-end') return { type: 'setEnd', day: active.lastDay };
  if (range.kind === 'open-start') return { type: 'setStart', day: active.lastDay };
  return undefined;
}

function edgeDirection(clientX: number, bounds: DOMRect): -1 | 0 | 1 {
  if (clientX < bounds.left + EDGE_SCROLL_ZONE_PX) return -1;
  return clientX > bounds.right - EDGE_SCROLL_ZONE_PX ? 1 : 0;
}

function timelineRangeFromPlan(
  plan: Extract<ReturnType<typeof planProjectTimelineEdit>, { readonly kind: 'ready' }>,
): ProjectTimelineRange {
  if (plan.startDay !== undefined && plan.endDay !== undefined) {
    return { kind: 'closed', startDay: plan.startDay, endDay: plan.endDay };
  }
  if (plan.startDay !== undefined) return { kind: 'open-end', startDay: plan.startDay };
  if (plan.endDay !== undefined) return { kind: 'open-start', endDay: plan.endDay };
  return { kind: 'unscheduled' };
}

/** Owns Timeline pointer capture, preview, cancellation, hover, and edge scrolling. */
export class ProjectTimelinePointerInteraction {
  private active_abyssPrivate: ActivePointerGesture | undefined;
  private readonly pending_abyssPrivate = new Map<string, PendingPointerPreview>();
  private previewSequence_abyssPrivate = 0;
  private destroyed_abyssPrivate = false;
  private suppressClickOccurrence_abyssPrivate: string | undefined;
  private edgeDirection_abyssPrivate: -1 | 0 | 1 = 0;
  private edgeFrame_abyssPrivate: number | undefined;
  private readonly cursor_abyssPrivate: HTMLElement;
  private readonly tooltip_abyssPrivate: HTMLElement;
  private readonly ownerWindow_abyssPrivate: Window | undefined;

  constructor(private readonly context_abyssPrivate: ProjectTimelinePointerInteractionContext) {
    this.ownerWindow_abyssPrivate =
      context_abyssPrivate.root.ownerDocument.defaultView ?? undefined;
    this.cursor_abyssPrivate = context_abyssPrivate.root.createDiv({
      cls: 'abyss-project-timeline-cursor',
      attr: { 'aria-hidden': 'true' },
    });
    this.cursor_abyssPrivate.hidden = true;
    this.tooltip_abyssPrivate = context_abyssPrivate.root.createDiv({
      cls: 'abyss-project-timeline-tooltip',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.tooltip_abyssPrivate.hidden = true;
    context_abyssPrivate.root.addEventListener('pointerdown', this.pointerDown_abyssPrivate);
    context_abyssPrivate.root.addEventListener('pointermove', this.pointerMove_abyssPrivate);
    context_abyssPrivate.root.addEventListener('pointerup', this.pointerUp_abyssPrivate);
    context_abyssPrivate.root.addEventListener('pointercancel', this.cancelEvent_abyssPrivate);
    context_abyssPrivate.root.addEventListener('lostpointercapture', this.cancelEvent_abyssPrivate);
    context_abyssPrivate.root.addEventListener('pointerleave', this.pointerLeave_abyssPrivate);
    context_abyssPrivate.root.addEventListener('click', this.click_abyssPrivate, true);
    context_abyssPrivate.root.addEventListener('keydown', this.keydown_abyssPrivate, true);
    this.ownerWindow_abyssPrivate?.addEventListener('blur', this.blur_abyssPrivate);
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.cancelActive();
    const { root } = this.context_abyssPrivate;
    root.removeEventListener('pointerdown', this.pointerDown_abyssPrivate);
    root.removeEventListener('pointermove', this.pointerMove_abyssPrivate);
    root.removeEventListener('pointerup', this.pointerUp_abyssPrivate);
    root.removeEventListener('pointercancel', this.cancelEvent_abyssPrivate);
    root.removeEventListener('lostpointercapture', this.cancelEvent_abyssPrivate);
    root.removeEventListener('pointerleave', this.pointerLeave_abyssPrivate);
    root.removeEventListener('click', this.click_abyssPrivate, true);
    root.removeEventListener('keydown', this.keydown_abyssPrivate, true);
    this.ownerWindow_abyssPrivate?.removeEventListener('blur', this.blur_abyssPrivate);
    this.cursor_abyssPrivate.remove();
    this.tooltip_abyssPrivate.remove();
  }

  cancelActive(): void {
    this.cancelGesture_abyssPrivate(true);
    this.clearPendingPreviews_abyssPrivate(true);
  }

  reconcileAfterRender(): void {
    const active = this.active_abyssPrivate;
    if (active !== undefined) {
      const current = this.context_abyssPrivate.captureRangeSource(active.target.occurrenceId);
      if (
        !active.target.track.isConnected ||
        current.kind === 'rejected' ||
        !sameProjectTimelineRangeSource(active.source, current.source)
      ) {
        this.cancelGesture_abyssPrivate(false);
      } else if (active.prepared) {
        this.preview_abyssPrivate(active);
      }
    }
    for (const [occurrenceId, pending] of this.pending_abyssPrivate) {
      const current = this.context_abyssPrivate.captureRangeSource(occurrenceId);
      if (
        !pending.target.track.isConnected ||
        current.kind === 'rejected' ||
        !sameProjectTimelineRangeSource(pending.source, current.source)
      ) {
        this.pending_abyssPrivate.delete(occurrenceId);
        continue;
      }
      pending.barSnapshot = barSnapshot(pending.target.bar);
      this.applyPreview_abyssPrivate(pending.target.bar, pending.range);
    }
  }

  private cancelGesture_abyssPrivate(restorePreview: boolean): void {
    const active = this.active_abyssPrivate;
    this.active_abyssPrivate = undefined;
    this.stopEdgeScroll_abyssPrivate();
    this.hideOverlays_abyssPrivate();
    if (restorePreview && active?.barSnapshot !== undefined && active.target.bar !== null) {
      const { bar } = active.target;
      bar.className = active.barSnapshot.className;
      bar.hidden = active.barSnapshot.hidden;
      bar.style.left = active.barSnapshot.left;
      bar.style.width = active.barSnapshot.width;
      if (active.barSnapshot.oneDateCenter === '') {
        bar.style.removeProperty('--abyss-project-timeline-one-date-center');
      } else {
        bar.style.setProperty(
          '--abyss-project-timeline-one-date-center',
          active.barSnapshot.oneDateCenter,
        );
      }
    }
    if (active !== undefined) this.releasePointerCapture_abyssPrivate(active);
  }

  private clearPendingPreviews_abyssPrivate(restorePreview: boolean): void {
    for (const pending of this.pending_abyssPrivate.values()) {
      if (restorePreview) this.restorePendingPreview_abyssPrivate(pending);
    }
    this.pending_abyssPrivate.clear();
  }

  private cancelPendingOccurrence_abyssPrivate(occurrenceId: string): void {
    const pending = this.pending_abyssPrivate.get(occurrenceId);
    if (pending === undefined) return;
    this.pending_abyssPrivate.delete(occurrenceId);
    this.restorePendingPreview_abyssPrivate(pending);
  }

  private restorePendingPreview_abyssPrivate(pending: PendingPointerPreview): void {
    const snapshot = pending.barSnapshot;
    const bar = pending.target.bar;
    if (snapshot === undefined || bar?.isConnected !== true) return;
    bar.className = snapshot.className;
    bar.hidden = snapshot.hidden;
    bar.style.left = snapshot.left;
    bar.style.width = snapshot.width;
    if (snapshot.oneDateCenter === '') {
      bar.style.removeProperty('--abyss-project-timeline-one-date-center');
    } else {
      bar.style.setProperty('--abyss-project-timeline-one-date-center', snapshot.oneDateCenter);
    }
  }

  private releasePointerCapture_abyssPrivate(active: ActivePointerGesture): void {
    const { track } = active.target;
    if (
      typeof track.hasPointerCapture !== 'function' ||
      !track.hasPointerCapture(active.pointerId) ||
      typeof track.releasePointerCapture !== 'function'
    ) {
      return;
    }
    try {
      track.releasePointerCapture(active.pointerId);
    } catch (error) {
      if (!this.destroyed_abyssPrivate) this.context_abyssPrivate.reportRangeFailure(error);
    }
  }

  private target_abyssPrivate(event: Event): TimelinePointerTarget | undefined {
    const eventTarget = eventTimelineTarget(event);
    if (eventTarget === undefined) return undefined;
    const partElement = eventTarget.closest<HTMLElement>('[data-timeline-part]');
    if (partElement === null) return undefined;
    const part = pointerPart(partElement);
    if (part === undefined) return undefined;
    const track = partElement.closest<HTMLElement>('.abyss-project-timeline-track');
    const row = partElement.closest<HTMLElement>('[data-occurrence-id]');
    const occurrenceId = row?.dataset['occurrenceId'];
    if (track === null || occurrenceId === undefined) return undefined;
    const bar = track.querySelector<HTMLElement>(':scope > .abyss-project-timeline-bar');
    return {
      occurrenceId,
      track,
      bar,
      focus: part === 'track' ? track : (bar ?? track),
      part,
    };
  }

  private capturePointer_abyssPrivate(active: ActivePointerGesture): boolean {
    const { track } = active.target;
    if (typeof track.setPointerCapture !== 'function') return true;
    try {
      track.setPointerCapture(active.pointerId);
      return true;
    } catch (error) {
      this.cancelGesture_abyssPrivate(true);
      this.context_abyssPrivate.reportRangeFailure(error);
      return false;
    }
  }

  private dayAtClientX_abyssPrivate(track: HTMLElement, clientX: number): string | undefined {
    const bounds = track.getBoundingClientRect();
    const window = this.context_abyssPrivate.window();
    const first = projectCalendarDayOrdinal(window.startDay);
    if (bounds.width <= 0 || first === undefined || window.dayCount <= 0) return undefined;
    const fraction = Math.max(0, Math.min(0.999999999, (clientX - bounds.left) / bounds.width));
    return projectCalendarDayFromOrdinal(first + Math.floor(fraction * window.dayCount));
  }

  private readonly pointerDown_abyssPrivate = (event: PointerEvent): void => {
    if (this.destroyed_abyssPrivate || event.button !== 0 || !event.isPrimary) return;
    const target = this.target_abyssPrivate(event);
    if (target === undefined) return;
    const startDay = this.dayAtClientX_abyssPrivate(target.track, event.clientX);
    if (startDay === undefined) return;
    const captured = this.context_abyssPrivate.captureRangeSource(target.occurrenceId);
    if (captured.kind === 'rejected') {
      this.context_abyssPrivate.reportRangeFailure(captured.reason);
      return;
    }
    event.preventDefault();
    this.context_abyssPrivate.selectRange(target.occurrenceId, target.focus);
    this.cancelGesture_abyssPrivate(true);
    this.cancelPendingOccurrence_abyssPrivate(target.occurrenceId);
    const snapshot = barSnapshot(target.bar);
    const active: ActivePointerGesture = {
      pointerId: event.pointerId,
      target,
      source: captured.source,
      startClientX: event.clientX,
      startDay,
      lastClientX: event.clientX,
      lastDay: startDay,
      prepared: false,
      released: false,
      moved: false,
      ...(snapshot === undefined ? {} : { barSnapshot: snapshot }),
    };
    this.active_abyssPrivate = active;
    if (!this.capturePointer_abyssPrivate(active)) return;
    void this.context_abyssPrivate.finishEditor().then(
      (finished) => {
        if (!finished || this.active_abyssPrivate !== active || active.released) {
          if (this.active_abyssPrivate === active) this.cancelGesture_abyssPrivate(true);
          return;
        }
        active.prepared = true;
        if (this.shouldPreview_abyssPrivate(active)) this.preview_abyssPrivate(active);
      },
      (error: unknown) => {
        if (this.active_abyssPrivate === active) this.cancelGesture_abyssPrivate(true);
        this.context_abyssPrivate.reportRangeFailure(error);
      },
    );
  };

  private readonly pointerMove_abyssPrivate = (event: PointerEvent): void => {
    const active = this.active_abyssPrivate;
    if (active === undefined) {
      const target = this.target_abyssPrivate(event);
      if (target !== undefined) this.showCursor_abyssPrivate(target.track, event.clientX);
      return;
    }
    if (event.pointerId !== active.pointerId) return;
    const day = this.dayAtClientX_abyssPrivate(active.target.track, event.clientX);
    if (day === undefined) return;
    active.lastClientX = event.clientX;
    active.lastDay = day;
    active.moved ||= Math.abs(event.clientX - active.startClientX) >= MOVEMENT_THRESHOLD_PX;
    this.updateEdgeScroll_abyssPrivate(event.clientX);
    if (active.prepared && this.shouldPreview_abyssPrivate(active)) {
      this.preview_abyssPrivate(active);
    }
  };

  private readonly pointerUp_abyssPrivate = (event: PointerEvent): void => {
    const active = this.active_abyssPrivate;
    if (active?.pointerId !== event.pointerId) return;
    active.released = true;
    const submission = this.pointerSubmission_abyssPrivate(active);
    if (submission === undefined) {
      this.cancelGesture_abyssPrivate(true);
      return;
    }
    const { pending, request } = submission;
    this.retainPendingPreview_abyssPrivate(active, pending);
    void this.context_abyssPrivate.commitRangeEdit(request).then(
      (result) => {
        if (result.failed.length > 0) {
          this.settlePending_abyssPrivate(pending, true);
          this.context_abyssPrivate.reportRangeFailure(result);
        } else if (result.applied.length === 0) {
          this.settlePending_abyssPrivate(pending, true);
        }
      },
      (error: unknown) => {
        this.settlePending_abyssPrivate(pending, true);
        this.context_abyssPrivate.reportRangeFailure(error);
      },
    );
  };

  private pointerSubmission_abyssPrivate(active: ActivePointerGesture):
    | {
        readonly pending: PendingPointerPreview;
        readonly request: Extract<ProjectTimelineRangeEditRequest, { readonly kind: 'pointer' }>;
      }
    | undefined {
    if (!active.prepared || (!active.moved && active.target.part !== 'track')) return undefined;
    const intent = this.intent_abyssPrivate(active);
    if (intent === undefined) return undefined;
    const plan = planProjectTimelineEdit(active.source.range, intent);
    if (plan.kind !== 'ready') return undefined;
    const pending: PendingPointerPreview = {
      id: ++this.previewSequence_abyssPrivate,
      target: active.target,
      source: active.source,
      range: timelineRangeFromPlan(plan),
      ...(active.barSnapshot === undefined ? {} : { barSnapshot: active.barSnapshot }),
    };
    return {
      pending,
      request: { kind: 'pointer', source: active.source, intent },
    };
  }

  private retainPendingPreview_abyssPrivate(
    active: ActivePointerGesture,
    pending: PendingPointerPreview,
  ): void {
    this.active_abyssPrivate = undefined;
    this.stopEdgeScroll_abyssPrivate();
    this.hideOverlays_abyssPrivate();
    this.releasePointerCapture_abyssPrivate(active);
    this.pending_abyssPrivate.set(active.target.occurrenceId, pending);
    this.applyPreview_abyssPrivate(active.target.bar, pending.range);
    this.suppressClickOccurrence_abyssPrivate = active.target.occurrenceId;
  }

  private settlePending_abyssPrivate(
    pending: PendingPointerPreview,
    restorePreview: boolean,
  ): void {
    if (this.pending_abyssPrivate.get(pending.target.occurrenceId)?.id !== pending.id) return;
    this.pending_abyssPrivate.delete(pending.target.occurrenceId);
    if (restorePreview) this.restorePendingPreview_abyssPrivate(pending);
  }

  private intent_abyssPrivate(active: ActivePointerGesture): ProjectTimelineEditIntent | undefined {
    const first = projectCalendarDayOrdinal(active.startDay);
    const last = projectCalendarDayOrdinal(active.lastDay);
    if (first === undefined || last === undefined) return undefined;
    const deltaDays = last - first;
    if (active.target.part === 'bar') return { type: 'move', deltaDays };
    if (active.target.part === 'start') {
      const sourceDay = rangeResizeSource(active.source.range, 'start', active.startDay);
      const day = resizedDay(sourceDay, deltaDays);
      return day === undefined ? undefined : { type: 'resizeStart', day };
    }
    if (active.target.part === 'end') {
      const sourceDay = rangeResizeSource(active.source.range, 'end', active.startDay);
      const day = resizedDay(sourceDay, deltaDays);
      return day === undefined ? undefined : { type: 'resizeEnd', day };
    }
    return trackIntent(active);
  }

  private preview_abyssPrivate(active: ActivePointerGesture): void {
    const intent = this.intent_abyssPrivate(active);
    if (intent === undefined) return;
    const plan = planProjectTimelineEdit(active.source.range, intent);
    if (plan.kind === 'rejected') {
      this.tooltip_abyssPrivate.setText(plan.reason);
      this.showTooltip_abyssPrivate(active.lastClientX, active.target.track);
      return;
    }
    const previewRange = timelineRangeFromPlan(plan);
    this.applyPreview_abyssPrivate(active.target.bar, previewRange);
    this.showCursor_abyssPrivate(active.target.track, active.lastClientX);
    let activeEndpoint = active.lastDay;
    if (active.target.part === 'start') activeEndpoint = plan.startDay ?? active.lastDay;
    else if (active.target.part === 'end') activeEndpoint = plan.endDay ?? active.lastDay;
    this.tooltip_abyssPrivate.setText(activeEndpoint);
    this.showTooltip_abyssPrivate(active.lastClientX, active.target.track);
  }

  private shouldPreview_abyssPrivate(active: ActivePointerGesture): boolean {
    return active.moved || !targetsMissingEndpoint(active);
  }

  private applyPreview_abyssPrivate(bar: HTMLElement | null, range: ProjectTimelineRange): void {
    if (bar === null) return;
    const geometry = projectTimelineBarGeometry(range, this.context_abyssPrivate.window());
    if (geometry === undefined) return;
    bar.hidden = false;
    applyProjectTimelineBarGeometry(bar, range, geometry);
    bar.addClass('is-previewing');
  }

  private showCursor_abyssPrivate(track: HTMLElement, clientX: number): void {
    const day = this.dayAtClientX_abyssPrivate(track, clientX);
    if (day === undefined) return;
    const bounds = track.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    if (this.cursor_abyssPrivate.parentElement !== track) track.append(this.cursor_abyssPrivate);
    this.cursor_abyssPrivate.hidden = false;
    this.cursor_abyssPrivate.style.left = `${fraction * 100}%`;
    if (this.active_abyssPrivate === undefined) {
      this.tooltip_abyssPrivate.setText(day);
      this.showTooltip_abyssPrivate(clientX, track);
    }
  }

  private showTooltip_abyssPrivate(clientX: number, track: HTMLElement): void {
    this.tooltip_abyssPrivate.hidden = false;
    const ownerWindow = this.ownerWindow_abyssPrivate;
    const viewportWidth =
      ownerWindow?.innerWidth ?? track.ownerDocument.documentElement.clientWidth;
    const viewportHeight =
      ownerWindow?.innerHeight ?? track.ownerDocument.documentElement.clientHeight;
    const tooltipBounds = this.tooltip_abyssPrivate.getBoundingClientRect();
    const width = tooltipBounds.width > 0 ? tooltipBounds.width : 210;
    const height = tooltipBounds.height > 0 ? tooltipBounds.height : 26;
    const left = Math.max(8, Math.min(viewportWidth - width - 8, clientX + 12));
    const bounds = track.getBoundingClientRect();
    const above = bounds.top - height - 8;
    const top =
      above >= 8 ? above : Math.max(8, Math.min(viewportHeight - height - 8, bounds.bottom + 8));
    this.tooltip_abyssPrivate.style.left = `${left}px`;
    this.tooltip_abyssPrivate.style.top = `${top}px`;
  }

  private hideOverlays_abyssPrivate(): void {
    this.cursor_abyssPrivate.hidden = true;
    this.tooltip_abyssPrivate.hidden = true;
  }

  private readonly cancelEvent_abyssPrivate = (event: PointerEvent): void => {
    const active = this.active_abyssPrivate;
    if (active?.pointerId === event.pointerId) this.cancelActive();
  };

  private readonly pointerLeave_abyssPrivate = (): void => {
    if (this.active_abyssPrivate === undefined) this.hideOverlays_abyssPrivate();
  };

  private readonly click_abyssPrivate = (event: MouseEvent): void => {
    const suppressedOccurrence = this.suppressClickOccurrence_abyssPrivate;
    if (suppressedOccurrence === undefined) return;
    const target = this.target_abyssPrivate(event);
    this.suppressClickOccurrence_abyssPrivate = undefined;
    if (target?.occurrenceId !== suppressedOccurrence) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly keydown_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.active_abyssPrivate === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelActive();
  };

  private readonly blur_abyssPrivate = (): void => {
    this.cancelActive();
  };

  private updateEdgeScroll_abyssPrivate(clientX: number): void {
    const bounds = this.context_abyssPrivate.scroll.getBoundingClientRect();
    this.edgeDirection_abyssPrivate = edgeDirection(clientX, bounds);
    if (this.edgeDirection_abyssPrivate === 0) {
      this.stopEdgeScroll_abyssPrivate();
      return;
    }
    if (this.edgeFrame_abyssPrivate !== undefined || this.ownerWindow_abyssPrivate === undefined)
      return;
    this.edgeFrame_abyssPrivate = this.ownerWindow_abyssPrivate.requestAnimationFrame(
      this.edgeScrollFrame_abyssPrivate,
    );
  }

  private readonly edgeScrollFrame_abyssPrivate = (): void => {
    this.edgeFrame_abyssPrivate = undefined;
    const active = this.active_abyssPrivate;
    if (active === undefined || this.edgeDirection_abyssPrivate === 0) return;
    this.context_abyssPrivate.scroll.scrollLeft +=
      this.edgeDirection_abyssPrivate * EDGE_SCROLL_STEP_PX;
    const day = this.dayAtClientX_abyssPrivate(active.target.track, active.lastClientX);
    if (day !== undefined) active.lastDay = day;
    if (this.shouldPreview_abyssPrivate(active)) this.preview_abyssPrivate(active);
    this.edgeFrame_abyssPrivate = this.ownerWindow_abyssPrivate?.requestAnimationFrame(
      this.edgeScrollFrame_abyssPrivate,
    );
  };

  private stopEdgeScroll_abyssPrivate(): void {
    this.edgeDirection_abyssPrivate = 0;
    if (this.edgeFrame_abyssPrivate !== undefined) {
      this.ownerWindow_abyssPrivate?.cancelAnimationFrame(this.edgeFrame_abyssPrivate);
      this.edgeFrame_abyssPrivate = undefined;
    }
  }
}
