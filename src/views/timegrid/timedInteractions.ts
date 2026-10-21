import { formatDurationFromMinutes } from '../../parser/TaskParser';
import {
  clampDurationToDay,
  localTime,
  durationMinutes as validatedDurationMinutes,
  type TaskSnapshot,
} from '../../tasks';
import { calendarOccurrenceForRender, calendarTaskWithPlanning } from '../calendarOccurrences';
import { settleCalendarInteraction } from '../settleCalendarInteraction';
import { populateCalendarPreview } from './calendarPreview';
import {
  resolveBoundaryTarget,
  resolveTimedDragTarget,
  resolveTimedVerticalResizeTarget,
  type DragDateColumn,
  type SpanBoundaryTarget,
  type TimedDragColumn,
  type TimedDragTarget,
  type TimedVerticalResizeTarget,
} from './dragGeometry';
import {
  MIN_BLOCK_HEIGHT_PX,
  minutesToPixels,
  minutesToTimeString,
  type PositionedBlock,
} from './layout';
import { timedEditPlanning } from './timedEditPlanning';

export type TimedBoundaryTarget =
  | SpanBoundaryTarget
  | {
      readonly boundary: 'create-span';
      readonly date: SpanBoundaryTarget['date'];
      readonly dayDelta: number;
    };

type TimedPreviewTarget =
  Readonly<TimedDragTarget> | Readonly<TimedVerticalResizeTarget> | Readonly<TimedBoundaryTarget>;

const DROP_ACCEPTANCE_PX = 12;

function samePreviewTarget(left: TimedPreviewTarget, right: TimedPreviewTarget): boolean {
  if ('destination' in left && 'destination' in right)
    return [
      left.destination === right.destination,
      left.date === right.date,
      left.startMinutes === right.startMinutes,
      left.dayDelta === right.dayDelta,
    ].every(Boolean);
  if ('edge' in left && 'edge' in right)
    return [
      left.edge === right.edge,
      left.startMinutes === right.startMinutes,
      left.durationMinutes === right.durationMinutes,
      left.endMinutes === right.endMinutes,
    ].every(Boolean);
  if ('boundary' in left && 'boundary' in right)
    return [
      left.boundary === right.boundary,
      left.date === right.date,
      left.dayDelta === right.dayDelta,
    ].every(Boolean);
  return false;
}

export interface TimedInteractionOwner {
  begin(dispose: () => void): void;
  end(dispose: () => void): void;
  disposeActive(): void;
}

export function createTimedInteractionOwner(): TimedInteractionOwner {
  let active: (() => void) | undefined;
  return {
    begin(dispose) {
      active?.();
      active = dispose;
    },
    end(dispose) {
      if (active === dispose) active = undefined;
    },
    disposeActive() {
      const dispose = active;
      active = undefined;
      dispose?.();
    },
  };
}

export interface TimedInteractionBinding {
  readonly source: HTMLElement;
  readonly startHandle: HTMLElement;
  readonly durationHandle: HTMLElement;
  readonly boundaryHandles: ReadonlyArray<{
    readonly element: HTMLElement;
    readonly boundary: 'start' | 'due' | 'create-span';
  }>;
  readonly task: TaskSnapshot;
  readonly segmentDate: string;
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly owner: TimedInteractionOwner;
  readonly previewPositionFor?:
    | ((
        task: TaskSnapshot,
        planning: TaskSnapshot['planning'],
        date: string,
      ) => PositionedBlock | undefined)
    | undefined;
  readonly onMove: (task: TaskSnapshot, target: TimedDragTarget) => void | Promise<void>;
  readonly onDuration: (
    task: TaskSnapshot,
    target: TimedVerticalResizeTarget,
  ) => void | Promise<void>;
  readonly onBoundary: (task: TaskSnapshot, target: TimedBoundaryTarget) => void | Promise<void>;
}

interface MeasuredColumn {
  readonly date: string;
  readonly day: HTMLElement;
  readonly hour: HTMLElement;
  readonly allDay?: HTMLElement | undefined;
  readonly drag: TimedDragColumn;
  readonly boundary: DragDateColumn;
}

function measureColumn(
  column: Pick<MeasuredColumn, 'date' | 'day' | 'hour' | 'allDay'>,
): MeasuredColumn {
  const dayRect = column.day.getBoundingClientRect();
  const hourRect = column.hour.getBoundingClientRect();
  const allDayRect = column.allDay?.getBoundingClientRect();
  const drag: TimedDragColumn = {
    date: column.date as TimedDragColumn['date'],
    left: dayRect.left,
    right: dayRect.right,
    timeGridTop: hourRect.top,
    timeGridBottom: hourRect.bottom,
    ...(allDayRect != null && allDayRect.bottom > allDayRect.top
      ? { allDayTop: allDayRect.top, allDayBottom: allDayRect.bottom }
      : {}),
  };
  return {
    ...column,
    drag,
    boundary: { date: drag.date, left: drag.left, right: drag.right },
  };
}

function measuredColumns(source: HTMLElement): MeasuredColumn[] {
  const root = source.closest<HTMLElement>('.abyss-tg-root');
  if (root == null) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>('.abyss-tg-day-column[data-tg-date]'),
  ).flatMap((day) => {
    const date = day.dataset['tgDate'];
    const hour = day.querySelector<HTMLElement>('.abyss-tg-hour-column');
    if (date === undefined || date.length === 0 || hour === null) return [];
    const allDay = root.querySelector<HTMLElement>(`.abyss-tg-allday-cell[data-tg-date="${date}"]`);
    return [measureColumn({ date, day, hour, allDay: allDay ?? undefined })];
  });
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze({ ...value });
}

interface PreviewElementOptions {
  readonly existing: HTMLElement | undefined;
  readonly source: HTMLElement;
  readonly target: object;
  readonly className: 'abyss-tg-drag-preview' | 'abyss-tg-boundary-preview';
  readonly content: {
    readonly title: string;
    readonly timeLabel: string;
    readonly recurrence?: string;
    readonly phase: 'ghost' | 'terminal';
  };
  readonly copyLaneGeometry?: boolean;
}

function nonEmptyText(value: string | null | undefined): value is string {
  return value != null && value.length > 0;
}

function previewElement(options: PreviewElementOptions): HTMLElement {
  const { existing, source, target, className, content } = options;
  const preview =
    existing ?? source.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  const countLabel = source.querySelector<HTMLElement>('.abyss-tg-block-badges')?.textContent;
  preview.className = className;
  preview.dataset['target'] = JSON.stringify(target);
  if (options.copyLaneGeometry ?? true) {
    preview.style.left = source.style.left;
    preview.style.width = source.style.width;
  }
  populateCalendarPreview(preview, source, {
    title: content.title,
    timed: {
      timeLabel: content.timeLabel,
      title: content.title,
      ...(content.recurrence !== undefined &&
        content.recurrence.length > 0 && { recurrence: content.recurrence }),
      actionable:
        content.phase === 'terminal' && source.querySelector('.abyss-status-marker') !== null,
      ...(nonEmptyText(countLabel) && { countLabel }),
    },
    density: 'regular',
    phase: content.phase,
  });
  return preview;
}

function prospectivePlanning(
  task: TaskSnapshot,
  target: TimedPreviewTarget,
): TaskSnapshot['planning'] | undefined {
  if ('destination' in target) return timedEditPlanning(task, { type: 'move', target });
  if ('durationMinutes' in target) return timedEditPlanning(task, { type: 'resize', target });
  return timedEditPlanning(task, { type: 'boundary', target });
}

function applyPreviewPacking(
  preview: HTMLElement,
  binding: TimedInteractionBinding,
  target: TimedPreviewTarget,
  date: string,
): void {
  const planning = prospectivePlanning(binding.task, target);
  if (planning === undefined || binding.previewPositionFor === undefined) return;
  const source = calendarTaskWithPlanning(
    binding.task,
    planning,
    'boundary' in target ? 'create-span' : undefined,
  );
  const positioned = binding.previewPositionFor(source, planning, date);
  if (positioned === undefined) return;
  const width = 100 / positioned.columns;
  preview.style.left = `${positioned.column * width}%`;
  preview.style.width = `${width}%`;
}

function previewPhase(
  binding: TimedInteractionBinding,
  target: TimedPreviewTarget,
  date: string,
): 'ghost' | 'terminal' {
  const occurrence = calendarOccurrenceForRender(binding.task);
  if (
    'destination' in target &&
    occurrence.kind === 'materialized' &&
    occurrence.occupied.kind === 'point'
  )
    return 'terminal';
  const planning = prospectivePlanning(binding.task, target);
  return planning?.due == null || String(planning.due) === date ? 'terminal' : 'ghost';
}

function timedPreviewText(startMinutes: number, durationMinutes: number): string {
  return `${minutesToTimeString(startMinutes)}–${minutesToTimeString(
    startMinutes + durationMinutes,
  )} (${formatDurationFromMinutes(durationMinutes)})`;
}

/** Match the final time-only command candidate while retaining the source snapshot. */
function movedDuration(binding: TimedInteractionBinding, startMinutes: number): number {
  return clampDurationToDay(
    localTime(minutesToTimeString(startMinutes)),
    binding.task.planning.duration ?? validatedDurationMinutes(60),
  );
}

function applyTimedPreviewHeight(preview: HTMLElement, startMinutes: number, height: number): void {
  const boundedHeight = Math.min(height, minutesToPixels(1440 - startMinutes));
  preview.style.top = `${minutesToPixels(startMinutes)}px`;
  preview.style.height = `${boundedHeight}px`;
  const shell = preview.querySelector<HTMLElement>('.abyss-calendar-preview-shell');
  if (shell != null)
    shell.classList.toggle('is-height-constrained', boundedHeight < MIN_BLOCK_HEIGHT_PX);
}

function minimumPreviewHeight(source: HTMLElement): number {
  const inlineMinimum = Number.parseFloat(source.style.minHeight);
  return Number.isFinite(inlineMinimum) ? inlineMinimum : MIN_BLOCK_HEIGHT_PX;
}

function capture(element: HTMLElement, pointerId: number): void {
  if (typeof element.setPointerCapture !== 'function') return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The pointer may already have ended. Window listeners still own cleanup.
  }
}

function release(element: HTMLElement, pointerId: number): void {
  if (typeof element.releasePointerCapture !== 'function') return;
  try {
    element.releasePointerCapture(pointerId);
  } catch {
    // Capture may have been released implicitly by the host.
  }
}

type TimedInteractionKind = 'move' | 'start-time' | 'duration' | 'start' | 'due' | 'create-span';

interface TimedSessionGeometry {
  readonly columns: readonly MeasuredColumn[];
  readonly originColumn: MeasuredColumn;
  readonly sourceRect: DOMRect;
  readonly pixelsPerMinute: number;
  readonly renderedHeightMinutes: number;
  readonly grabOffsetMinutes: number;
}

interface TimedSessionInput {
  readonly binding: TimedInteractionBinding;
  readonly ownerWindow: Window;
  readonly startEvent: PointerEvent;
  readonly kind: TimedInteractionKind;
  readonly capturedElement: HTMLElement;
  readonly geometry: TimedSessionGeometry;
}

function previewContent(
  binding: TimedInteractionBinding,
  timeLabel: string,
  phase: 'ghost' | 'terminal',
): PreviewElementOptions['content'] {
  const content: {
    title: string;
    timeLabel: string;
    phase: 'ghost' | 'terminal';
    recurrence?: string;
  } = { title: binding.task.title, timeLabel, phase };
  if (nonEmptyText(binding.task.recurrence)) content.recurrence = binding.task.recurrence;
  return content;
}

function clearAllDayPreviewGeometry(preview: HTMLElement): void {
  preview.classList.add('is-all-day');
  preview.style.removeProperty('left');
  preview.style.removeProperty('width');
  preview.style.removeProperty('top');
  preview.style.removeProperty('height');
  preview
    .querySelector<HTMLElement>('.abyss-calendar-preview-shell')
    ?.classList.remove('is-height-constrained');
}

class TimedPreviewRenderer {
  private preview_abyssPrivate: HTMLElement | undefined;

  constructor(
    private readonly binding_abyssPrivate: TimedInteractionBinding,
    private readonly geometry_abyssPrivate: TimedSessionGeometry,
  ) {}

  clear(): void {
    this.preview_abyssPrivate?.remove();
    this.preview_abyssPrivate = undefined;
  }

  render(kind: TimedInteractionKind, target: TimedPreviewTarget): void {
    if (kind === 'move') {
      this.renderMove_abyssPrivate(target as Readonly<TimedDragTarget>);
      return;
    }
    if (kind === 'duration' || kind === 'start-time') {
      this.renderDuration_abyssPrivate(target as Readonly<TimedVerticalResizeTarget>);
      return;
    }
    this.renderBoundary_abyssPrivate(target as Readonly<TimedBoundaryTarget>);
  }

  private renderMove_abyssPrivate(target: Readonly<TimedDragTarget>): void {
    const column = this.geometry_abyssPrivate.columns.find(
      (candidate) => candidate.date === target.date,
    );
    const host = target.destination === 'all-day' ? column?.allDay : column?.hour;
    if (host == null) return;
    const timeLabel =
      target.destination === 'time-grid'
        ? timedPreviewText(
            target.startMinutes,
            movedDuration(this.binding_abyssPrivate, target.startMinutes),
          )
        : 'All day';
    const preview = this.replace_abyssPrivate({
      target,
      className: 'abyss-tg-drag-preview',
      content: previewContent(
        this.binding_abyssPrivate,
        timeLabel,
        previewPhase(this.binding_abyssPrivate, target, target.date),
      ),
      copyLaneGeometry: target.destination === 'time-grid',
    });
    if (target.destination === 'time-grid')
      this.applyTimedMoveGeometry_abyssPrivate(preview, target);
    else clearAllDayPreviewGeometry(preview);
    if (preview.parentElement !== host) host.appendChild(preview);
  }

  private applyTimedMoveGeometry_abyssPrivate(
    preview: HTMLElement,
    target: Readonly<TimedDragTarget>,
  ): void {
    preview.classList.remove('is-all-day');
    applyPreviewPacking(preview, this.binding_abyssPrivate, target, target.date);
    applyTimedPreviewHeight(
      preview,
      target.startMinutes,
      Math.max(
        minutesToPixels(movedDuration(this.binding_abyssPrivate, target.startMinutes)),
        this.geometry_abyssPrivate.sourceRect.height,
      ),
    );
  }

  private renderDuration_abyssPrivate(target: Readonly<TimedVerticalResizeTarget>): void {
    const preview = this.replace_abyssPrivate({
      target,
      className: 'abyss-tg-drag-preview',
      content: previewContent(
        this.binding_abyssPrivate,
        timedPreviewText(target.startMinutes, target.durationMinutes),
        previewPhase(this.binding_abyssPrivate, target, this.binding_abyssPrivate.segmentDate),
      ),
    });
    applyPreviewPacking(
      preview,
      this.binding_abyssPrivate,
      target,
      this.binding_abyssPrivate.segmentDate,
    );
    applyTimedPreviewHeight(
      preview,
      target.startMinutes,
      Math.max(
        minutesToPixels(target.durationMinutes),
        minimumPreviewHeight(this.binding_abyssPrivate.source),
      ),
    );
    const host = this.geometry_abyssPrivate.originColumn.hour;
    if (preview.parentElement !== host) host.appendChild(preview);
  }

  private renderBoundary_abyssPrivate(target: Readonly<TimedBoundaryTarget>): void {
    const column = this.geometry_abyssPrivate.columns.find(
      (candidate) => candidate.date === target.date,
    );
    if (column == null) return;
    const preview = this.replace_abyssPrivate({
      target,
      className: 'abyss-tg-boundary-preview',
      content: previewContent(
        this.binding_abyssPrivate,
        timedPreviewText(
          this.binding_abyssPrivate.startMinutes,
          this.binding_abyssPrivate.durationMinutes,
        ),
        previewPhase(this.binding_abyssPrivate, target, target.date),
      ),
    });
    applyPreviewPacking(preview, this.binding_abyssPrivate, target, target.date);
    applyTimedPreviewHeight(
      preview,
      this.binding_abyssPrivate.startMinutes,
      this.geometry_abyssPrivate.sourceRect.height,
    );
    if (preview.parentElement !== column.hour) column.hour.appendChild(preview);
  }

  private replace_abyssPrivate(
    options: Omit<PreviewElementOptions, 'existing' | 'source'>,
  ): HTMLElement {
    this.preview_abyssPrivate = previewElement({
      ...options,
      existing: this.preview_abyssPrivate,
      source: this.binding_abyssPrivate.source,
    });
    return this.preview_abyssPrivate;
  }
}

class TimedTargetResolver {
  constructor(
    private readonly binding_abyssPrivate: TimedInteractionBinding,
    private readonly startEvent_abyssPrivate: PointerEvent,
    private readonly geometry_abyssPrivate: TimedSessionGeometry,
  ) {}

  resolve(
    kind: TimedInteractionKind,
    pointer: PointerEvent,
    columns: readonly MeasuredColumn[],
    previous?: TimedPreviewTarget,
  ): TimedPreviewTarget | undefined {
    if (kind === 'move')
      return this.resolveMove_abyssPrivate(
        pointer,
        columns,
        previous !== undefined && 'destination' in previous ? previous : undefined,
      );
    if (kind === 'duration' || kind === 'start-time') {
      return this.resolveVertical_abyssPrivate(
        kind,
        pointer,
        columns,
        previous !== undefined && 'edge' in previous ? previous : undefined,
      );
    }
    return this.resolveBoundary_abyssPrivate(
      kind,
      pointer,
      columns,
      previous !== undefined && 'boundary' in previous ? previous : undefined,
    );
  }

  private resolveMove_abyssPrivate(
    pointer: PointerEvent,
    columns: readonly MeasuredColumn[],
    previous?: TimedDragTarget,
  ): TimedPreviewTarget | undefined {
    const forecast =
      calendarOccurrenceForRender(this.binding_abyssPrivate.task).kind === 'forecast';
    const date = this.binding_abyssPrivate.segmentDate as TimedDragColumn['date'];
    const target = resolveTimedDragTarget(
      {
        date,
        startMinutes: this.binding_abyssPrivate.startMinutes,
        durationMinutes: this.binding_abyssPrivate.durationMinutes,
        renderedHeightMinutes: this.geometry_abyssPrivate.renderedHeightMinutes,
        grabOffsetMinutes: this.geometry_abyssPrivate.grabOffsetMinutes,
      },
      pointer,
      // Keep forecast previews on their segment while preserving the real drop bounds.
      columns.map(({ drag }) => (forecast ? { ...drag, date } : drag)),
      previous,
    );
    return target == null || (forecast && target.destination === 'all-day')
      ? undefined
      : frozen(target);
  }

  private resolveVertical_abyssPrivate(
    kind: 'duration' | 'start-time',
    pointer: PointerEvent,
    columns: readonly MeasuredColumn[],
    previous?: TimedVerticalResizeTarget,
  ): TimedPreviewTarget | undefined {
    const origin = columns.find((column) => column.date === this.binding_abyssPrivate.segmentDate);
    if (origin === undefined) return undefined;
    const pixelsPerMinute = (origin.drag.timeGridBottom - origin.drag.timeGridTop) / (24 * 60);
    const grabMinutes =
      (this.startEvent_abyssPrivate.clientY -
        this.geometry_abyssPrivate.originColumn.drag.timeGridTop) /
      this.geometry_abyssPrivate.pixelsPerMinute;
    let target: TimedVerticalResizeTarget;
    try {
      target = resolveTimedVerticalResizeTarget(
        {
          edge: kind === 'start-time' ? 'start' : 'end',
          startMinutes: this.binding_abyssPrivate.startMinutes,
          durationMinutes: this.binding_abyssPrivate.durationMinutes,
          grabClientY: origin.drag.timeGridTop + grabMinutes * pixelsPerMinute,
          pixelsPerMinute,
        },
        pointer,
        previous,
      );
    } catch {
      return undefined;
    }
    return this.isOriginalVerticalTarget_abyssPrivate(target) ? undefined : frozen(target);
  }

  private isOriginalVerticalTarget_abyssPrivate(target: TimedVerticalResizeTarget): boolean {
    return (
      target.startMinutes === this.binding_abyssPrivate.startMinutes &&
      target.durationMinutes === this.binding_abyssPrivate.durationMinutes
    );
  }

  private resolveBoundary_abyssPrivate(
    kind: 'start' | 'due' | 'create-span',
    pointer: PointerEvent,
    columns: readonly MeasuredColumn[],
    previous?: TimedBoundaryTarget,
  ): TimedPreviewTarget | undefined {
    const planning = this.binding_abyssPrivate.task.planning;
    const start = planning.start ?? planning.scheduled ?? planning.due;
    const due = planning.due ?? planning.scheduled ?? planning.start;
    if (start == null || due == null) return undefined;
    const target = resolveBoundaryTarget(
      { boundary: kind === 'start' ? 'start' : 'due', start, due },
      pointer,
      columns.map((column) => column.boundary),
      previous,
    );
    if (target == null) return undefined;
    if (kind !== 'create-span') return frozen(target);
    return frozen({
      boundary: 'create-span' as const,
      date: target.date,
      dayDelta: target.dayDelta,
    });
  }
}

class TimedInteractionSession {
  private readonly resolver_abyssPrivate: TimedTargetResolver;
  private readonly renderer_abyssPrivate: TimedPreviewRenderer;
  private latest_abyssPrivate: TimedPreviewTarget | undefined;
  private disposed_abyssPrivate = false;
  private pointerReleased_abyssPrivate = false;
  private lastPointer_abyssPrivate: PointerEvent;
  private acceptedPointer_abyssPrivate: PointerEvent | undefined;

  constructor(private readonly input: TimedSessionInput) {
    this.lastPointer_abyssPrivate = input.startEvent;
    this.resolver_abyssPrivate = new TimedTargetResolver(
      input.binding,
      input.startEvent,
      input.geometry,
    );
    this.renderer_abyssPrivate = new TimedPreviewRenderer(input.binding, input.geometry);
  }

  start(): void {
    const { binding, capturedElement, kind, ownerWindow, startEvent } = this.input;
    binding.owner.begin(this.dispose_abyssPrivate);
    binding.source.classList.toggle('is-picked-up', kind === 'move');
    if (kind !== 'move') capturedElement.dataset['activeResize'] = 'true';
    capture(capturedElement, startEvent.pointerId);
    ownerWindow.addEventListener('pointermove', this.onPointerMove_abyssPrivate);
    ownerWindow.addEventListener('pointerup', this.onPointerUp_abyssPrivate);
    ownerWindow.addEventListener('pointercancel', this.onCancel_abyssPrivate);
    ownerWindow.addEventListener('blur', this.onCancel_abyssPrivate);
    ownerWindow.addEventListener('keydown', this.onKeyDown_abyssPrivate, true);
    ownerWindow.addEventListener('scroll', this.onScroll_abyssPrivate, true);
    capturedElement.addEventListener('lostpointercapture', this.onCancel_abyssPrivate);
  }

  private readonly onPointerMove_abyssPrivate = (pointer: PointerEvent): void => {
    if (pointer.pointerId !== this.input.startEvent.pointerId) return;
    pointer.preventDefault();
    this.update_abyssPrivate(pointer);
  };

  private readonly onScroll_abyssPrivate = (event: Event): void => {
    const target = event.target as Partial<Pick<Node, 'contains'>> | null;
    if (target?.contains?.(this.input.binding.source) === true)
      this.update_abyssPrivate(this.lastPointer_abyssPrivate, undefined, false);
  };

  private readonly onPointerUp_abyssPrivate = (pointer: PointerEvent): void => {
    if (pointer.pointerId !== this.input.startEvent.pointerId) return;
    this.update_abyssPrivate(pointer);
    const committed = this.latest_abyssPrivate;
    this.releasePointer_abyssPrivate();
    if (committed == null) this.dispose_abyssPrivate();
    else
      settleCalendarInteraction(
        () => this.commit_abyssPrivate(committed),
        this.dispose_abyssPrivate,
      );
  };

  private readonly onCancel_abyssPrivate = (event: Event): void => {
    if ('pointerId' in event && event.pointerId !== this.input.startEvent.pointerId) return;
    this.dispose_abyssPrivate();
  };

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.dispose_abyssPrivate();
  };

  private update_abyssPrivate(
    pointer: PointerEvent,
    columns: readonly MeasuredColumn[] = this.input.geometry.columns.map(measureColumn),
    preferCurrent = true,
  ): void {
    if (this.disposed_abyssPrivate || pointer.pointerId !== this.input.startEvent.pointerId) return;
    this.lastPointer_abyssPrivate = pointer;
    const previous = preferCurrent ? this.latest_abyssPrivate : undefined;
    const resolved = this.resolver_abyssPrivate.resolve(
      this.input.kind,
      pointer,
      columns,
      previous,
    );
    const target = resolved ?? this.nearbyPreview_abyssPrivate(pointer, columns, previous);
    // A tolerated miss must not advance the anchor and walk acceptance out of bounds.
    if (resolved !== undefined) this.acceptedPointer_abyssPrivate = pointer;
    else if (target === undefined) this.acceptedPointer_abyssPrivate = undefined;
    this.latest_abyssPrivate = target;
    if (target == null) {
      this.renderer_abyssPrivate.clear();
      return;
    }
    this.renderer_abyssPrivate.render(this.input.kind, target);
  }

  private nearbyPreview_abyssPrivate(
    pointer: PointerEvent,
    columns: readonly MeasuredColumn[],
    previous: TimedPreviewTarget | undefined,
  ): TimedPreviewTarget | undefined {
    const anchor = this.acceptedPointer_abyssPrivate;
    if (anchor === undefined || previous === undefined) return undefined;
    const { kind } = this.input;
    const nearX = Math.abs(pointer.clientX - anchor.clientX) <= DROP_ACCEPTANCE_PX;
    const nearY = Math.abs(pointer.clientY - anchor.clientY) <= DROP_ACCEPTANCE_PX;
    let nearby = nearX;
    if (kind === 'move') nearby = nearX && nearY;
    else if (kind === 'duration' || kind === 'start-time') nearby = nearY;
    if (!nearby) return undefined;
    // Current geometry must still prove the shown target; a stale preview grants no fallback.
    const current = this.resolver_abyssPrivate.resolve(kind, anchor, columns, previous);
    return current !== undefined && samePreviewTarget(previous, current) ? previous : undefined;
  }

  private commit_abyssPrivate(target: TimedPreviewTarget): void | Promise<void> {
    const { binding, kind } = this.input;
    if (kind === 'move') {
      return binding.onMove(binding.task, target as TimedDragTarget);
    }
    if (kind === 'duration' || kind === 'start-time') {
      return binding.onDuration(binding.task, target as TimedVerticalResizeTarget);
    }
    return binding.onBoundary(binding.task, target as TimedBoundaryTarget);
  }

  private releasePointer_abyssPrivate(): void {
    if (this.pointerReleased_abyssPrivate) return;
    this.pointerReleased_abyssPrivate = true;
    const { capturedElement, ownerWindow, startEvent } = this.input;
    ownerWindow.removeEventListener('pointermove', this.onPointerMove_abyssPrivate);
    ownerWindow.removeEventListener('pointerup', this.onPointerUp_abyssPrivate);
    ownerWindow.removeEventListener('pointercancel', this.onCancel_abyssPrivate);
    ownerWindow.removeEventListener('blur', this.onCancel_abyssPrivate);
    ownerWindow.removeEventListener('keydown', this.onKeyDown_abyssPrivate, true);
    ownerWindow.removeEventListener('scroll', this.onScroll_abyssPrivate, true);
    capturedElement.removeEventListener('lostpointercapture', this.onCancel_abyssPrivate);
    release(capturedElement, startEvent.pointerId);
  }

  private readonly dispose_abyssPrivate = (): void => {
    if (this.disposed_abyssPrivate) return;
    this.disposed_abyssPrivate = true;
    const { binding, capturedElement } = this.input;
    this.releasePointer_abyssPrivate();
    this.renderer_abyssPrivate.clear();
    binding.source.classList.remove('is-picked-up');
    delete binding.source.dataset['activeResize'];
    delete capturedElement.dataset['activeResize'];
    binding.owner.end(this.dispose_abyssPrivate);
  };
}

function isBlockedMoveTarget(event: PointerEvent, kind: TimedInteractionKind): boolean {
  if (kind !== 'move') return false;
  const target = event.target as Element | null;
  return (
    target?.closest('.abyss-status-marker, a, .abyss-tg-resize-handle, .abyss-tg-span-edge') != null
  );
}

function measureSession(
  binding: TimedInteractionBinding,
  event: PointerEvent,
): TimedSessionGeometry | undefined {
  const columns = measuredColumns(binding.source);
  const originColumn = columns.find((column) => column.date === binding.segmentDate);
  if (originColumn == null) return undefined;
  const sourceRect = binding.source.getBoundingClientRect();
  const pixelsPerMinute =
    (originColumn.drag.timeGridBottom - originColumn.drag.timeGridTop) / (24 * 60);
  const renderedHeightMinutes = sourceRect.height / pixelsPerMinute;
  const grabOffsetMinutes = Math.min(
    renderedHeightMinutes,
    Math.max(0, (event.clientY - sourceRect.top) / pixelsPerMinute),
  );
  return {
    columns,
    originColumn,
    sourceRect,
    pixelsPerMinute,
    renderedHeightMinutes,
    grabOffsetMinutes,
  };
}

function beginTimedSession(
  binding: TimedInteractionBinding,
  ownerWindow: Window,
  event: PointerEvent,
  kind: TimedInteractionKind,
): void {
  if (
    (kind === 'move' && event.pointerType === 'touch') ||
    event.button !== 0 ||
    isBlockedMoveTarget(event, kind)
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  const geometry = measureSession(binding, event);
  if (geometry === undefined) return;
  const capturedElement = event.currentTarget as HTMLElement;
  new TimedInteractionSession({
    binding,
    ownerWindow,
    startEvent: event,
    kind,
    capturedElement,
    geometry,
  }).start();
}

function attachPointerStart(
  element: HTMLElement,
  binding: TimedInteractionBinding,
  ownerWindow: Window,
  kind: TimedInteractionKind,
): void {
  element.addEventListener('pointerdown', (event) => {
    beginTimedSession(binding, ownerWindow, event, kind);
  });
}

export function attachTimedInteractions(binding: TimedInteractionBinding): void {
  const ownerWindow = binding.source.ownerDocument.defaultView;
  if (ownerWindow == null) return;
  attachPointerStart(binding.source, binding, ownerWindow, 'move');
  attachPointerStart(binding.startHandle, binding, ownerWindow, 'start-time');
  attachPointerStart(binding.durationHandle, binding, ownerWindow, 'duration');
  for (const handle of binding.boundaryHandles) {
    attachPointerStart(handle.element, binding, ownerWindow, handle.boundary);
  }
}
