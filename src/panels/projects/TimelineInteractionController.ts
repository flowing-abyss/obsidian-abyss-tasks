import { moveProjectDateByCivilDays } from '../../projects/projectDates';
import type { ProjectDateValue } from '../../projects/types';
import {
  DEFAULT_TIMELINE_IDENTITY_WIDTH,
  TIMELINE_IDENTITY_WIDTH_MAX,
  TIMELINE_IDENTITY_WIDTH_MIN,
  clampTimelineIdentityWidth,
  isTimelineScale,
  type PortfolioTimelineScale,
  type TaskTimelineScale,
  type TimelineScale,
  type TimelineScope,
  type WorkNoteTimelineScale,
} from './timelinePreferences';

export interface TimelinePoint {
  readonly x: number;
  readonly y: number;
}

export interface TimelineRect {
  readonly left: number;
  readonly right: number;
}

export interface TimelineGeometrySnapshot {
  readonly pixelsPerDay: number;
  readonly scrollLeft: number;
  readonly maxScrollLeft: number;
  readonly scrollBounds?: TimelineRect;
}

export interface TimelineRangeCarrier {
  readonly start: ProjectDateValue;
  readonly end: ProjectDateValue;
}

export interface TimelinePointCarrier {
  readonly at: ProjectDateValue;
}

export type TimelineOwnedPointRole = 'start' | 'end' | 'scheduled' | 'due' | 'milestone';
export type TimelineOwnedRole = 'range' | TimelineOwnedPointRole | 'identity-column';

export type TimelineInteractionTarget<ItemId extends string> =
  | {
      readonly kind: 'range-move' | 'start-edge' | 'end-edge';
      readonly itemId: ItemId;
      readonly carrier: TimelineRangeCarrier;
    }
  | {
      readonly kind: 'point-move' | 'milestone-move';
      readonly itemId: ItemId;
      readonly role: TimelineOwnedPointRole;
      readonly carrier: TimelinePointCarrier;
    }
  | { readonly kind: 'identity-column'; readonly width: number };

export type TimelineTargetKind = TimelineInteractionTarget<string>['kind'];
export type TimelineIdentityPreset = 'compact' | 'default' | 'wide';

export type TimelinePreviewGeometry =
  | { readonly kind: 'range'; readonly start: string; readonly end: string }
  | { readonly kind: 'point' | 'milestone'; readonly at: string };

export type TimelineValidity =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'reversed' | 'out-of-range' };

export type TimelineCommitIntent<ItemId extends string> =
  | {
      readonly type: 'date-change';
      readonly itemId: ItemId;
      readonly target: Exclude<TimelineTargetKind, 'identity-column'>;
      readonly ownedRole: Exclude<TimelineOwnedRole, 'identity-column'>;
      readonly original: TimelineRangeCarrier | TimelinePointCarrier;
      readonly draft: TimelineRangeCarrier | TimelinePointCarrier;
      readonly dayDelta: number;
      readonly interactionEpoch: number;
      readonly originalWidth?: never;
      readonly draftWidth?: never;
    }
  | {
      readonly type: 'identity-width-change';
      readonly originalWidth: number;
      readonly draftWidth: number;
      readonly interactionEpoch: number;
      readonly original?: never;
      readonly draft?: never;
    };

export type TimelineCommitResult =
  | { readonly type: 'success' }
  | { readonly type: 'conflict' | 'failure'; readonly reason?: string };

export type TimelineSemanticIntent<ItemId extends string> =
  | {
      readonly type: 'open-date-editor';
      readonly itemId: ItemId;
      readonly ownedRole: Exclude<TimelineOwnedRole, 'identity-column'>;
      readonly carrier: ProjectDateValue | TimelineRangeCarrier;
      readonly preset?: never;
      readonly width?: never;
    }
  | {
      readonly type: 'identity-width-preset';
      readonly preset: TimelineIdentityPreset;
      readonly width: number;
      readonly itemId?: never;
      readonly ownedRole?: never;
      readonly carrier?: never;
    };

export type TimelineAnnouncement<ItemId extends string> =
  | {
      readonly type: 'pickup';
      readonly target: TimelineTargetKind;
      readonly itemId?: ItemId;
      readonly ownedRole: TimelineOwnedRole;
    }
  | {
      readonly type: 'destination';
      readonly target: Exclude<TimelineTargetKind, 'identity-column'>;
      readonly dayDelta: number;
      readonly carrier: TimelineRangeCarrier | TimelinePointCarrier;
      readonly validity: TimelineValidity;
    }
  | {
      readonly type: 'destination';
      readonly target: 'identity-column';
      readonly width: number;
      readonly boundary: 'min' | 'max' | 'none';
    }
  | { readonly type: 'commit-pending' }
  | { readonly type: 'success' }
  | { readonly type: 'cancel'; readonly reason?: string }
  | { readonly type: 'conflict' | 'failure'; readonly reason?: string };

export interface TimelineProjection<ItemId extends string> {
  readonly activeTarget?: TimelineTargetKind;
  readonly itemId?: ItemId;
  readonly originalCarrier?: TimelineRangeCarrier | TimelinePointCarrier;
  readonly draftCarrier?: TimelineRangeCarrier | TimelinePointCarrier;
  readonly originalWidth?: number;
  readonly draftWidth?: number;
  readonly dayDelta?: number;
  readonly validity?: TimelineValidity;
  readonly pending: boolean;
  readonly previewGeometry?: TimelinePreviewGeometry;
  readonly accessibility: {
    readonly grabbed: boolean;
    readonly ownedRole?: TimelineOwnedRole;
    readonly editorAvailable: boolean;
  };
}

export interface TimelineInteractionPorts<ItemId extends string> {
  readonly geometry: { snapshot(): TimelineGeometrySnapshot };
  readonly commit: (intent: TimelineCommitIntent<ItemId>) => Promise<TimelineCommitResult>;
  readonly publish: (projection: TimelineProjection<ItemId>) => void;
  readonly announce: (announcement: TimelineAnnouncement<ItemId>) => void;
  readonly emit: (intent: TimelineSemanticIntent<ItemId>) => void;
  readonly capturePointer?: (pointerId: number) => void;
  readonly releasePointer?: (pointerId: number) => void;
  readonly requestAutoscroll?: (request: {
    readonly direction: -1 | 0 | 1;
    readonly speed: number;
  }) => void;
  readonly restoreFocus?: (itemId: ItemId | undefined, role: TimelineOwnedRole) => void;
}

export interface TimelineInteractionOptions {
  readonly movementThreshold?: number;
  readonly edgeZone?: number;
  readonly maxAutoscrollSpeed?: number;
  readonly identityKeyboardStep?: number;
  readonly identityKeyboardLargeStep?: number;
}

interface ActiveInteraction<ItemId extends string> {
  readonly epoch: number;
  readonly mode: 'pointer' | 'keyboard';
  readonly target: TimelineInteractionTarget<ItemId>;
  readonly pointerId?: number;
  readonly pressPoint?: TimelinePoint;
  readonly initialScrollLeft: number;
  picked: boolean;
  pending: boolean;
  pointerCaptured: boolean;
  dayDelta: number;
  draftCarrier?: TimelineRangeCarrier | TimelinePointCarrier;
  draftWidth?: number;
  validity: TimelineValidity;
  lastDestinationAnnouncement?: string;
}

const DEFAULT_MOVEMENT_THRESHOLD = 6;
const DEFAULT_EDGE_ZONE = 40;
const DEFAULT_MAX_AUTOSCROLL_SPEED = 20;
const DEFAULT_IDENTITY_KEYBOARD_STEP = 8;
const DEFAULT_IDENTITY_KEYBOARD_LARGE_STEP = 32;

const KEYBOARD_UNIT_DAYS = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
} as const;

const IDENTITY_PRESET_WIDTHS = {
  compact: TIMELINE_IDENTITY_WIDTH_MIN,
  default: DEFAULT_TIMELINE_IDENTITY_WIDTH,
  wide: TIMELINE_IDENTITY_WIDTH_MAX,
} as const satisfies Readonly<Record<TimelineIdentityPreset, number>>;

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyPoint(point: TimelinePoint): TimelinePoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function copyDate(value: ProjectDateValue): ProjectDateValue {
  return Object.freeze({
    raw: value.raw,
    precision: value.precision,
    instantMs: value.instantMs,
    ...(value.offsetMinutes !== undefined && { offsetMinutes: value.offsetMinutes }),
  });
}

function copyCarrier(
  carrier: TimelineRangeCarrier | TimelinePointCarrier,
): TimelineRangeCarrier | TimelinePointCarrier {
  return 'at' in carrier
    ? Object.freeze({ at: copyDate(carrier.at) })
    : Object.freeze({ start: copyDate(carrier.start), end: copyDate(carrier.end) });
}

function copyEditorCarrier(
  carrier: ProjectDateValue | TimelineRangeCarrier,
): ProjectDateValue | TimelineRangeCarrier {
  return 'raw' in carrier ? copyDate(carrier) : (copyCarrier(carrier) as TimelineRangeCarrier);
}

function copyTarget<ItemId extends string>(
  target: TimelineInteractionTarget<ItemId>,
): TimelineInteractionTarget<ItemId> {
  if (target.kind === 'identity-column') {
    return Object.freeze({ kind: target.kind, width: clampTimelineIdentityWidth(target.width) });
  }
  if (target.kind === 'point-move' || target.kind === 'milestone-move') {
    return Object.freeze({
      kind: target.kind,
      itemId: target.itemId,
      role: target.role,
      carrier: copyCarrier(target.carrier) as TimelinePointCarrier,
    });
  }
  return Object.freeze({
    kind: target.kind,
    itemId: target.itemId,
    carrier: copyCarrier(target.carrier) as TimelineRangeCarrier,
  });
}

function ownedRole<ItemId extends string>(
  target: TimelineInteractionTarget<ItemId>,
): TimelineOwnedRole {
  switch (target.kind) {
    case 'range-move':
      return 'range';
    case 'start-edge':
      return 'start';
    case 'end-edge':
      return 'end';
    case 'point-move':
    case 'milestone-move':
      return target.role;
    case 'identity-column':
      return 'identity-column';
  }
}

function targetItemId<ItemId extends string>(
  target: TimelineInteractionTarget<ItemId>,
): ItemId | undefined {
  return target.kind === 'identity-column' ? undefined : target.itemId;
}

function boundaryForWidth(width: number): 'min' | 'max' | 'none' {
  if (width <= TIMELINE_IDENTITY_WIDTH_MIN) return 'min';
  if (width >= TIMELINE_IDENTITY_WIDTH_MAX) return 'max';
  return 'none';
}

function snappedWholeDays(pixels: number, pixelsPerDay: number): number {
  if (!Number.isFinite(pixelsPerDay) || pixelsPerDay <= 0) return 0;
  const magnitude = Math.floor(Math.abs(pixels / pixelsPerDay) + 0.5);
  return pixels < 0 ? -magnitude : magnitude;
}

function shiftedDate(value: ProjectDateValue, delta: number): ProjectDateValue | undefined {
  const shifted = moveProjectDateByCivilDays(value, delta);
  return shifted ? copyDate(shifted) : undefined;
}

function validityForRange(carrier: TimelineRangeCarrier): TimelineValidity {
  return carrier.start.instantMs > carrier.end.instantMs
    ? Object.freeze({ valid: false, reason: 'reversed' as const })
    : Object.freeze({ valid: true });
}

function freezeValidity(validity: TimelineValidity): TimelineValidity {
  return validity.valid
    ? Object.freeze({ valid: true })
    : Object.freeze({ valid: false, reason: validity.reason });
}

function freezeSemanticIntent<ItemId extends string>(
  intent: TimelineSemanticIntent<ItemId>,
): TimelineSemanticIntent<ItemId> {
  if (intent.type === 'identity-width-preset') return Object.freeze(intent);
  return Object.freeze({
    ...intent,
    carrier: copyEditorCarrier(intent.carrier),
  });
}

function freezeCommitIntent<ItemId extends string>(
  intent: TimelineCommitIntent<ItemId>,
): TimelineCommitIntent<ItemId> {
  if (intent.type === 'identity-width-change') return Object.freeze(intent);
  return Object.freeze({
    ...intent,
    original: copyCarrier(intent.original),
    draft: copyCarrier(intent.draft),
  });
}

export function timelineKeyboardUnitDays<S extends TimelineScope>(
  scope: S,
  scale: TimelineScale<S>,
): number {
  if (!isTimelineScale(scope, scale)) {
    throw new RangeError(`Scale ${String(scale)} is invalid for ${scope}`);
  }
  return KEYBOARD_UNIT_DAYS[scale];
}

/**
 * Renderer-agnostic timeline interaction state machine. It publishes semantic
 * projections and frozen intents, but owns no DOM, timers, or persistence.
 */
export class TimelineInteractionController<ItemId extends string> {
  private readonly movementThreshold: number;
  private readonly edgeZone: number;
  private readonly maxAutoscrollSpeed: number;
  private readonly identityKeyboardStep: number;
  private readonly identityKeyboardLargeStep: number;
  private active?: ActiveInteraction<ItemId>;
  private epoch = 0;
  private enabled = true;
  private destroyed = false;

  constructor(
    private readonly ports: TimelineInteractionPorts<ItemId>,
    options: TimelineInteractionOptions = {},
  ) {
    this.movementThreshold = Math.max(0, options.movementThreshold ?? DEFAULT_MOVEMENT_THRESHOLD);
    this.edgeZone = Math.max(1, options.edgeZone ?? DEFAULT_EDGE_ZONE);
    this.maxAutoscrollSpeed = Math.max(
      1,
      options.maxAutoscrollSpeed ?? DEFAULT_MAX_AUTOSCROLL_SPEED,
    );
    this.identityKeyboardStep = Math.max(
      1,
      Math.round(options.identityKeyboardStep ?? DEFAULT_IDENTITY_KEYBOARD_STEP),
    );
    this.identityKeyboardLargeStep = Math.max(
      this.identityKeyboardStep,
      Math.round(options.identityKeyboardLargeStep ?? DEFAULT_IDENTITY_KEYBOARD_LARGE_STEP),
    );
  }

  pointerDown(input: {
    readonly pointerId: number;
    readonly button: number;
    readonly isPrimary: boolean;
    readonly enabled: boolean;
    readonly point: TimelinePoint;
    readonly target: TimelineInteractionTarget<ItemId>;
  }): boolean {
    if (
      this.destroyed ||
      !this.enabled ||
      !input.enabled ||
      input.button !== 0 ||
      !input.isPrimary ||
      this.active
    ) {
      return false;
    }
    const geometry = this.snapshotGeometry();
    this.active = {
      epoch: ++this.epoch,
      mode: 'pointer',
      target: copyTarget(input.target),
      pointerId: input.pointerId,
      pressPoint: copyPoint(input.point),
      initialScrollLeft: geometry.scrollLeft,
      picked: false,
      pending: false,
      pointerCaptured: false,
      dayDelta: 0,
      validity: Object.freeze({ valid: true }),
    };
    return true;
  }

  pointerMove(input: { readonly pointerId: number; readonly point: TimelinePoint }): boolean {
    const active = this.active;
    if (
      !active ||
      active.mode !== 'pointer' ||
      active.pointerId !== input.pointerId ||
      active.pending
    ) {
      return false;
    }
    if (!active.picked) {
      const pressPoint = active.pressPoint!;
      if (
        Math.hypot(input.point.x - pressPoint.x, input.point.y - pressPoint.y) <
        this.movementThreshold
      ) {
        return true;
      }
      active.picked = true;
      if (this.ports.capturePointer) {
        this.ports.capturePointer(input.pointerId);
        active.pointerCaptured = true;
      }
      this.ports.announce({
        type: 'pickup',
        target: active.target.kind,
        itemId: targetItemId(active.target),
        ownedRole: ownedRole(active.target),
      });
    }
    const geometry = this.snapshotGeometry();
    this.updatePointerDraft(active, input.point, geometry);
    this.autoscroll(input.point, geometry);
    this.publish();
    return true;
  }

  async pointerUp(input: {
    readonly pointerId: number;
    readonly point: TimelinePoint;
  }): Promise<boolean> {
    const active = this.active;
    if (
      !active ||
      active.mode !== 'pointer' ||
      active.pointerId !== input.pointerId ||
      active.pending
    ) {
      return false;
    }
    if (!active.picked) {
      this.active = undefined;
      this.stopAutoscroll();
      return false;
    }
    const geometry = this.snapshotGeometry();
    this.updatePointerDraft(active, input.point, geometry);
    if (!active.validity.valid || !this.hasChanged(active)) {
      this.cancelActive(true, active.validity.valid ? undefined : active.validity.reason);
      return false;
    }
    return this.commitActive(active);
  }

  pointerCancel(pointerId: number): boolean {
    const active = this.active;
    if (!active || active.mode !== 'pointer' || active.pointerId !== pointerId) return false;
    this.cancelActive(true);
    return true;
  }

  lostPointerCapture(pointerId: number): boolean {
    const active = this.active;
    if (
      !active ||
      active.mode !== 'pointer' ||
      active.pointerId !== pointerId ||
      !active.pointerCaptured
    ) {
      return false;
    }
    this.cancelActive(false);
    return true;
  }

  async keyDown(input: {
    readonly key: string;
    readonly shiftKey?: boolean;
    readonly target?: TimelineInteractionTarget<ItemId>;
    readonly enabled?: boolean;
    readonly scope?: TimelineScope;
    readonly scale?: PortfolioTimelineScale | TaskTimelineScale | WorkNoteTimelineScale;
  }): Promise<boolean> {
    if (this.destroyed) return false;
    if (input.key === 'Escape' && this.active) {
      this.cancelActive(true);
      return true;
    }
    if (this.active?.mode === 'pointer') return false;
    if (!this.enabled) return false;
    if (!this.active && input.key === 'Enter') {
      if (!input.target || input.enabled !== true || input.target.kind === 'identity-column') {
        return false;
      }
      this.emitOpenEditor(input.target);
      return true;
    }
    if (input.key === 'Enter') {
      const active = this.active;
      if (!active || active.pending || !active.picked || !active.validity.valid) return false;
      if (!this.hasChanged(active)) return false;
      return this.commitActive(active);
    }
    if (input.key !== 'ArrowLeft' && input.key !== 'ArrowRight') return false;

    const arrowTarget = this.active?.target ?? input.target;
    let shiftDayStep: number | undefined;
    if (input.shiftKey && arrowTarget?.kind !== 'identity-column') {
      if (!input.scope || !input.scale || !isTimelineScale(input.scope, input.scale)) return false;
      shiftDayStep = timelineKeyboardUnitDays(input.scope, input.scale);
    }

    let active = this.active;
    if (!active) {
      if (!input.target || input.enabled !== true) return false;
      active = this.startKeyboard(input.target);
    }
    if (active.pending) return false;
    const direction = input.key === 'ArrowLeft' ? -1 : 1;
    if (active.target.kind === 'identity-column') {
      const step = input.shiftKey ? this.identityKeyboardLargeStep : this.identityKeyboardStep;
      this.updateIdentityDraft(
        active,
        (active.draftWidth ?? active.target.width) + direction * step,
      );
    } else {
      const step = shiftDayStep ?? 1;
      this.updateDateDraft(active, active.dayDelta + direction * step);
    }
    this.publish();
    return true;
  }

  requestIdentityPreset(preset: TimelineIdentityPreset): boolean {
    if (this.destroyed || !this.enabled || this.active) return false;
    const width = IDENTITY_PRESET_WIDTHS[preset];
    this.ports.emit(freezeSemanticIntent({ type: 'identity-width-preset', preset, width }));
    this.ports.announce({
      type: 'destination',
      target: 'identity-column',
      width,
      boundary: boundaryForWidth(width),
    });
    return true;
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled && this.active) this.cancelActive(true);
    else if (!enabled) this.stopAutoscroll();
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.active) this.cancelActive(true);
    else this.stopAutoscroll();
    this.destroyed = true;
    this.enabled = false;
    this.epoch += 1;
  }

  projection(): TimelineProjection<ItemId> {
    const active = this.active;
    if (!active?.picked) {
      return Object.freeze({
        pending: false,
        accessibility: Object.freeze({ grabbed: false, editorAvailable: false }),
      });
    }
    const role = ownedRole(active.target);
    const dateTarget = active.target.kind !== 'identity-column';
    const projection: TimelineProjection<ItemId> = {
      activeTarget: active.target.kind,
      ...(targetItemId(active.target) !== undefined && { itemId: targetItemId(active.target) }),
      ...(dateTarget && {
        originalCarrier: copyCarrier(active.target.carrier),
        draftCarrier: copyCarrier(active.draftCarrier ?? active.target.carrier),
        dayDelta: active.dayDelta,
        previewGeometry: this.previewGeometry(
          active.target,
          active.draftCarrier ?? active.target.carrier,
        ),
      }),
      ...(active.target.kind === 'identity-column' && {
        originalWidth: active.target.width,
        draftWidth: active.draftWidth ?? active.target.width,
      }),
      validity: freezeValidity(active.validity),
      pending: active.pending,
      accessibility: Object.freeze({
        grabbed: true,
        ownedRole: role,
        editorAvailable: dateTarget,
      }),
    };
    if (projection.previewGeometry) Object.freeze(projection.previewGeometry);
    return Object.freeze(projection);
  }

  private snapshotGeometry(): TimelineGeometrySnapshot {
    const snapshot = this.ports.geometry.snapshot();
    return {
      pixelsPerDay: snapshot.pixelsPerDay,
      scrollLeft: snapshot.scrollLeft,
      maxScrollLeft: snapshot.maxScrollLeft,
      ...(snapshot.scrollBounds && {
        scrollBounds: Object.freeze({
          left: snapshot.scrollBounds.left,
          right: snapshot.scrollBounds.right,
        }),
      }),
    };
  }

  private startKeyboard(target: TimelineInteractionTarget<ItemId>): ActiveInteraction<ItemId> {
    const copiedTarget = copyTarget(target);
    const active: ActiveInteraction<ItemId> = {
      epoch: ++this.epoch,
      mode: 'keyboard',
      target: copiedTarget,
      initialScrollLeft: this.snapshotGeometry().scrollLeft,
      picked: true,
      pending: false,
      pointerCaptured: false,
      dayDelta: 0,
      ...(copiedTarget.kind === 'identity-column'
        ? { draftWidth: copiedTarget.width }
        : { draftCarrier: copyCarrier(copiedTarget.carrier) }),
      validity: Object.freeze({ valid: true }),
    };
    this.active = active;
    this.ports.announce({
      type: 'pickup',
      target: active.target.kind,
      itemId: targetItemId(active.target),
      ownedRole: ownedRole(active.target),
    });
    return active;
  }

  private updatePointerDraft(
    active: ActiveInteraction<ItemId>,
    point: TimelinePoint,
    geometry: TimelineGeometrySnapshot,
  ): void {
    const pointerDelta = point.x - active.pressPoint!.x;
    if (active.target.kind === 'identity-column') {
      this.updateIdentityDraft(active, active.target.width + Math.round(pointerDelta));
      return;
    }
    const totalPixels = pointerDelta + geometry.scrollLeft - active.initialScrollLeft;
    this.updateDateDraft(active, snappedWholeDays(totalPixels, geometry.pixelsPerDay));
  }

  private updateDateDraft(active: ActiveInteraction<ItemId>, dayDelta: number): void {
    const target = active.target;
    if (target.kind === 'identity-column') return;
    active.dayDelta = dayDelta;
    let draft: TimelineRangeCarrier | TimelinePointCarrier | undefined;
    if (target.kind === 'range-move') {
      const start = shiftedDate(target.carrier.start, dayDelta);
      const end = shiftedDate(target.carrier.end, dayDelta);
      if (start && end) draft = Object.freeze({ start, end });
    } else if (target.kind === 'start-edge') {
      const start = shiftedDate(target.carrier.start, dayDelta);
      if (start) draft = Object.freeze({ start, end: copyDate(target.carrier.end) });
    } else if (target.kind === 'end-edge') {
      const end = shiftedDate(target.carrier.end, dayDelta);
      if (end) draft = Object.freeze({ start: copyDate(target.carrier.start), end });
    } else if ('role' in target) {
      const at = shiftedDate(target.carrier.at, dayDelta);
      if (at) draft = Object.freeze({ at });
    } else {
      return;
    }
    if (!draft) {
      active.draftCarrier = copyCarrier(target.carrier);
      active.validity = Object.freeze({ valid: false, reason: 'out-of-range' });
    } else {
      active.draftCarrier = draft;
      active.validity = 'start' in draft ? validityForRange(draft) : Object.freeze({ valid: true });
    }
    this.announceDestination(active);
  }

  private updateIdentityDraft(active: ActiveInteraction<ItemId>, width: number): void {
    const draftWidth = clampTimelineIdentityWidth(width);
    active.draftWidth = draftWidth;
    active.validity = Object.freeze({ valid: true });
    this.announceDestination(active);
  }

  private announceDestination(active: ActiveInteraction<ItemId>): void {
    if (active.target.kind === 'identity-column') {
      const width = active.draftWidth ?? active.target.width;
      const key = `identity:${String(width)}:${boundaryForWidth(width)}`;
      if (key === active.lastDestinationAnnouncement) return;
      active.lastDestinationAnnouncement = key;
      this.ports.announce({
        type: 'destination',
        target: 'identity-column',
        width,
        boundary: boundaryForWidth(width),
      });
      return;
    }
    const carrier = active.draftCarrier ?? active.target.carrier;
    const validityKey = active.validity.valid ? 'valid' : active.validity.reason;
    const key = `${active.target.kind}:${String(active.dayDelta)}:${validityKey}`;
    if (key === active.lastDestinationAnnouncement) return;
    active.lastDestinationAnnouncement = key;
    this.ports.announce({
      type: 'destination',
      target: active.target.kind,
      dayDelta: active.dayDelta,
      carrier: copyCarrier(carrier),
      validity: freezeValidity(active.validity),
    });
  }

  private previewGeometry(
    target: Exclude<TimelineInteractionTarget<ItemId>, { readonly kind: 'identity-column' }>,
    carrier: TimelineRangeCarrier | TimelinePointCarrier,
  ): TimelinePreviewGeometry {
    if ('at' in carrier) {
      return Object.freeze({
        kind: target.kind === 'milestone-move' ? 'milestone' : 'point',
        at: carrier.at.raw,
      });
    }
    {
      return Object.freeze({
        kind: 'range',
        start: carrier.start.raw,
        end: carrier.end.raw,
      });
    }
  }

  private emitOpenEditor(
    target: Exclude<TimelineInteractionTarget<ItemId>, { readonly kind: 'identity-column' }>,
  ): void {
    let role: Exclude<TimelineOwnedRole, 'identity-column'>;
    let carrier: ProjectDateValue | TimelineRangeCarrier;
    if (target.kind === 'range-move') {
      role = 'range';
      carrier = target.carrier;
    } else if (target.kind === 'start-edge') {
      role = 'start';
      carrier = target.carrier.start;
    } else if (target.kind === 'end-edge') {
      role = 'end';
      carrier = target.carrier.end;
    } else if ('role' in target) {
      role = target.role;
      carrier = target.carrier.at;
    } else {
      return;
    }
    this.ports.emit(
      freezeSemanticIntent({
        type: 'open-date-editor',
        itemId: target.itemId,
        ownedRole: role,
        carrier: copyEditorCarrier(carrier),
      }),
    );
  }

  private hasChanged(active: ActiveInteraction<ItemId>): boolean {
    return active.target.kind === 'identity-column'
      ? active.draftWidth !== undefined && active.draftWidth !== active.target.width
      : active.dayDelta !== 0;
  }

  private async commitActive(active: ActiveInteraction<ItemId>): Promise<boolean> {
    if (
      this.active !== active ||
      active.pending ||
      !active.validity.valid ||
      !this.hasChanged(active)
    ) {
      return false;
    }
    let intent: TimelineCommitIntent<ItemId>;
    if (active.target.kind === 'identity-column') {
      intent = freezeCommitIntent({
        type: 'identity-width-change',
        originalWidth: active.target.width,
        draftWidth: active.draftWidth!,
        interactionEpoch: active.epoch,
      });
    } else {
      intent = freezeCommitIntent({
        type: 'date-change',
        itemId: active.target.itemId,
        target: active.target.kind,
        ownedRole: ownedRole(active.target) as Exclude<TimelineOwnedRole, 'identity-column'>,
        original: active.target.carrier,
        draft: active.draftCarrier!,
        dayDelta: active.dayDelta,
        interactionEpoch: active.epoch,
      });
    }
    active.pending = true;
    this.releasePointer(active);
    this.stopAutoscroll();
    this.ports.announce({ type: 'commit-pending' });
    this.publish();

    let result: TimelineCommitResult;
    try {
      result = await this.ports.commit(intent);
    } catch (error) {
      result = { type: 'failure', reason: errorReason(error) };
    }
    if (this.active !== active || !active.pending || this.epoch !== active.epoch) return false;
    this.active = undefined;
    if (result.type === 'success') {
      this.ports.announce({ type: 'success' });
      this.restoreFocus(active);
    } else {
      this.ports.announce({ type: result.type, reason: result.reason });
      this.restoreFocus(active);
    }
    this.publish();
    return result.type === 'success';
  }

  private cancelActive(releasePointer: boolean, reason?: string): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.epoch += 1;
    if (releasePointer) this.releasePointer(active);
    this.stopAutoscroll();
    if (active.picked) {
      this.ports.announce({ type: 'cancel', ...(reason !== undefined && { reason }) });
      this.restoreFocus(active);
      this.publish();
    }
  }

  private releasePointer(active: ActiveInteraction<ItemId>): void {
    if (active.pointerId === undefined || !active.pointerCaptured) return;
    active.pointerCaptured = false;
    this.ports.releasePointer?.(active.pointerId);
  }

  private restoreFocus(active: ActiveInteraction<ItemId>): void {
    this.ports.restoreFocus?.(targetItemId(active.target), ownedRole(active.target));
  }

  private autoscroll(point: TimelinePoint, geometry: TimelineGeometrySnapshot): void {
    const bounds = geometry.scrollBounds;
    if (!bounds) {
      this.stopAutoscroll();
      return;
    }
    let direction: -1 | 0 | 1 = 0;
    let intensity = 0;
    if (point.x < bounds.left + this.edgeZone && geometry.scrollLeft > 0) {
      direction = -1;
      intensity = (bounds.left + this.edgeZone - point.x) / this.edgeZone;
    } else if (
      point.x > bounds.right - this.edgeZone &&
      geometry.scrollLeft < geometry.maxScrollLeft
    ) {
      direction = 1;
      intensity = (point.x - (bounds.right - this.edgeZone)) / this.edgeZone;
    }
    const speed =
      direction === 0
        ? 0
        : Math.min(
            this.maxAutoscrollSpeed,
            Math.max(1, Math.round(intensity * this.maxAutoscrollSpeed)),
          );
    this.ports.requestAutoscroll?.({ direction, speed });
  }

  private stopAutoscroll(): void {
    this.ports.requestAutoscroll?.({ direction: 0, speed: 0 });
  }

  private publish(): void {
    this.ports.publish(this.projection());
  }
}
