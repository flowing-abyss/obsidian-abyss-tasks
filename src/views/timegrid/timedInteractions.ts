import { formatDurationFromMinutes } from '../../parser/TaskParser';
import {
  localTime,
  shiftLocalDate,
  durationMinutes as validatedDurationMinutes,
  type TaskSnapshot,
} from '../../tasks';
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

export type TimedBoundaryTarget =
  | SpanBoundaryTarget
  | {
      readonly boundary: 'create-span';
      readonly date: SpanBoundaryTarget['date'];
      readonly dayDelta: number;
    };

type TimedPreviewTarget =
  Readonly<TimedDragTarget> | Readonly<TimedVerticalResizeTarget> | Readonly<TimedBoundaryTarget>;

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
  readonly onMove: (task: TaskSnapshot, target: TimedDragTarget) => void;
  readonly onDuration: (task: TaskSnapshot, target: TimedVerticalResizeTarget) => void;
  readonly onBoundary: (task: TaskSnapshot, target: TimedBoundaryTarget) => void;
}

interface MeasuredColumn {
  readonly date: string;
  readonly day: HTMLElement;
  readonly hour: HTMLElement;
  readonly allDay?: HTMLElement | undefined;
  readonly drag: TimedDragColumn;
  readonly boundary: DragDateColumn;
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
    const dayRect = day.getBoundingClientRect();
    const hourRect = hour.getBoundingClientRect();
    const allDay = root.querySelector<HTMLElement>(`.abyss-tg-allday-cell[data-tg-date="${date}"]`);
    const allDayRect = allDay?.getBoundingClientRect();
    const drag: TimedDragColumn = {
      date: date as TimedDragColumn['date'],
      left: dayRect.left,
      right: dayRect.right,
      timeGridTop: hourRect.top,
      timeGridBottom: hourRect.bottom,
      ...(allDayRect != null && allDayRect.bottom > allDayRect.top
        ? { allDayTop: allDayRect.top, allDayBottom: allDayRect.bottom }
        : {}),
    };
    return [
      {
        date,
        day,
        hour,
        allDay: allDay ?? undefined,
        drag,
        boundary: { date: drag.date, left: drag.left, right: drag.right },
      },
    ];
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

function shiftedStartAndDue(
  planning: TaskSnapshot['planning'],
  days: number,
): TaskSnapshot['planning'] | undefined {
  if (planning.start == null || planning.due == null) return undefined;
  const start = shiftLocalDate(planning.start, days);
  const due = shiftLocalDate(planning.due, days);
  return start != null && due != null ? { ...planning, start, due } : undefined;
}

function shiftedScheduled(
  planning: TaskSnapshot['planning'],
  days: number,
): TaskSnapshot['planning'] | undefined {
  if (planning.scheduled == null) return undefined;
  const scheduled = shiftLocalDate(planning.scheduled, days);
  return scheduled != null ? { ...planning, scheduled } : undefined;
}

function shiftedDue(
  planning: TaskSnapshot['planning'],
  days: number,
): TaskSnapshot['planning'] | undefined {
  if (planning.due == null) return undefined;
  const due = shiftLocalDate(planning.due, days);
  return due != null ? { ...planning, due } : undefined;
}

function shiftedPlanning(task: TaskSnapshot, days: number): TaskSnapshot['planning'] | undefined {
  const planning = task.planning;
  if (planning.start != null && planning.due != null) return shiftedStartAndDue(planning, days);
  if (planning.scheduled != null) return shiftedScheduled(planning, days);
  if (planning.due != null) return shiftedDue(planning, days);
  return undefined;
}

function withoutTimedPlanning(planning: TaskSnapshot['planning']): TaskSnapshot['planning'] {
  const result = { ...planning };
  delete result.time;
  delete result.duration;
  return result;
}

function prospectivePlanning(
  task: TaskSnapshot,
  target: TimedPreviewTarget,
): TaskSnapshot['planning'] | undefined {
  if ('destination' in target) {
    const shifted = shiftedPlanning(task, target.dayDelta);
    if (shifted == null) return undefined;
    return target.destination === 'time-grid'
      ? { ...shifted, time: localTime(minutesToTimeString(target.startMinutes)) }
      : withoutTimedPlanning(shifted);
  }
  if ('durationMinutes' in target) {
    return {
      ...task.planning,
      time: localTime(minutesToTimeString(target.startMinutes)),
      duration: validatedDurationMinutes(target.durationMinutes),
    };
  }
  if (target.boundary === 'start') return { ...task.planning, start: target.date };
  if (target.boundary === 'due') return { ...task.planning, due: target.date };
  const anchor = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
  return anchor != null ? { ...task.planning, start: anchor, due: target.date } : undefined;
}

function applyPreviewPacking(
  preview: HTMLElement,
  binding: TimedInteractionBinding,
  target: TimedPreviewTarget,
  date: string,
): void {
  const planning = prospectivePlanning(binding.task, target);
  if (planning === undefined || binding.previewPositionFor === undefined) return;
  const positioned = binding.previewPositionFor(binding.task, planning, date);
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
  const planning = prospectivePlanning(binding.task, target);
  return planning?.due == null || String(planning.due) === date ? 'terminal' : 'ghost';
}

function timedPreviewText(startMinutes: number, durationMinutes: number): string {
  return `${minutesToTimeString(startMinutes)}–${minutesToTimeString(
    startMinutes + durationMinutes,
  )} (${formatDurationFromMinutes(durationMinutes)})`;
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
}

class TimedPreviewRenderer {
  private preview: HTMLElement | undefined;

  constructor(
    private readonly binding: TimedInteractionBinding,
    private readonly geometry: TimedSessionGeometry,
  ) {}

  clear(): void {
    this.preview?.remove();
    this.preview = undefined;
  }

  render(kind: TimedInteractionKind, target: TimedPreviewTarget): void {
    if (kind === 'move') {
      this.renderMove(target as Readonly<TimedDragTarget>);
      return;
    }
    if (kind === 'duration' || kind === 'start-time') {
      this.renderDuration(target as Readonly<TimedVerticalResizeTarget>);
      return;
    }
    this.renderBoundary(target as Readonly<TimedBoundaryTarget>);
  }

  private renderMove(target: Readonly<TimedDragTarget>): void {
    const column = this.geometry.columns.find((candidate) => candidate.date === target.date);
    const host = target.destination === 'all-day' ? column?.allDay : column?.hour;
    if (host == null) return;
    const timeLabel =
      target.destination === 'time-grid'
        ? timedPreviewText(target.startMinutes, this.binding.durationMinutes)
        : 'All day';
    const preview = this.replace({
      target,
      className: 'abyss-tg-drag-preview',
      content: previewContent(
        this.binding,
        timeLabel,
        previewPhase(this.binding, target, target.date),
      ),
      copyLaneGeometry: target.destination === 'time-grid',
    });
    if (target.destination === 'time-grid') this.applyTimedMoveGeometry(preview, target);
    else clearAllDayPreviewGeometry(preview);
    if (preview.parentElement !== host) host.appendChild(preview);
  }

  private applyTimedMoveGeometry(preview: HTMLElement, target: Readonly<TimedDragTarget>): void {
    preview.classList.remove('is-all-day');
    applyPreviewPacking(preview, this.binding, target, target.date);
    preview.style.top = `${minutesToPixels(target.startMinutes)}px`;
    preview.style.height = `${this.geometry.sourceRect.height}px`;
  }

  private renderDuration(target: Readonly<TimedVerticalResizeTarget>): void {
    const preview = this.replace({
      target,
      className: 'abyss-tg-drag-preview',
      content: previewContent(
        this.binding,
        timedPreviewText(target.startMinutes, target.durationMinutes),
        previewPhase(this.binding, target, this.binding.segmentDate),
      ),
    });
    applyPreviewPacking(preview, this.binding, target, this.binding.segmentDate);
    preview.style.top = `${minutesToPixels(target.startMinutes)}px`;
    preview.style.height = `${Math.max(
      minutesToPixels(target.durationMinutes),
      minimumPreviewHeight(this.binding.source),
    )}px`;
    const host = this.geometry.originColumn.hour;
    if (preview.parentElement !== host) host.appendChild(preview);
  }

  private renderBoundary(target: Readonly<TimedBoundaryTarget>): void {
    const column = this.geometry.columns.find((candidate) => candidate.date === target.date);
    if (column == null) return;
    const preview = this.replace({
      target,
      className: 'abyss-tg-boundary-preview',
      content: previewContent(
        this.binding,
        timedPreviewText(this.binding.startMinutes, this.binding.durationMinutes),
        previewPhase(this.binding, target, target.date),
      ),
    });
    applyPreviewPacking(preview, this.binding, target, target.date);
    preview.style.top = this.binding.source.style.top;
    preview.style.height = `${this.geometry.sourceRect.height}px`;
    if (preview.parentElement !== column.hour) column.hour.appendChild(preview);
  }

  private replace(options: Omit<PreviewElementOptions, 'existing' | 'source'>): HTMLElement {
    this.preview = previewElement({
      ...options,
      existing: this.preview,
      source: this.binding.source,
    });
    return this.preview;
  }
}

class TimedTargetResolver {
  constructor(
    private readonly binding: TimedInteractionBinding,
    private readonly startEvent: PointerEvent,
    private readonly geometry: TimedSessionGeometry,
  ) {}

  resolve(kind: TimedInteractionKind, pointer: PointerEvent): TimedPreviewTarget | undefined {
    if (kind === 'move') return this.resolveMove(pointer);
    if (kind === 'duration' || kind === 'start-time') {
      return this.resolveVertical(kind, pointer);
    }
    return this.resolveBoundary(kind, pointer);
  }

  private resolveMove(pointer: PointerEvent): TimedPreviewTarget | undefined {
    const target = resolveTimedDragTarget(
      {
        date: this.binding.segmentDate as TimedDragColumn['date'],
        startMinutes: this.binding.startMinutes,
        durationMinutes: this.binding.durationMinutes,
        renderedHeightMinutes: this.geometry.renderedHeightMinutes,
        grabOffsetMinutes: this.geometry.grabOffsetMinutes,
      },
      pointer,
      this.geometry.columns.map((column) => column.drag),
    );
    return target == null ? undefined : frozen(target);
  }

  private resolveVertical(
    kind: 'duration' | 'start-time',
    pointer: PointerEvent,
  ): TimedPreviewTarget | undefined {
    let target: TimedVerticalResizeTarget;
    try {
      target = resolveTimedVerticalResizeTarget(
        {
          edge: kind === 'start-time' ? 'start' : 'end',
          startMinutes: this.binding.startMinutes,
          durationMinutes: this.binding.durationMinutes,
          grabClientY: this.startEvent.clientY,
          pixelsPerMinute: this.geometry.pixelsPerMinute,
        },
        pointer,
      );
    } catch {
      return undefined;
    }
    return this.isOriginalVerticalTarget(target) ? undefined : frozen(target);
  }

  private isOriginalVerticalTarget(target: TimedVerticalResizeTarget): boolean {
    return (
      target.startMinutes === this.binding.startMinutes &&
      target.durationMinutes === this.binding.durationMinutes
    );
  }

  private resolveBoundary(
    kind: 'start' | 'due' | 'create-span',
    pointer: PointerEvent,
  ): TimedPreviewTarget | undefined {
    const planning = this.binding.task.planning;
    const start = planning.start ?? planning.scheduled ?? planning.due;
    const due = planning.due ?? planning.scheduled ?? planning.start;
    if (start == null || due == null) return undefined;
    const target = resolveBoundaryTarget(
      { boundary: kind === 'start' ? 'start' : 'due', start, due },
      pointer,
      this.geometry.columns.map((column) => column.boundary),
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
  private readonly resolver: TimedTargetResolver;
  private readonly renderer: TimedPreviewRenderer;
  private latest: TimedPreviewTarget | undefined;
  private disposed = false;

  constructor(private readonly input: TimedSessionInput) {
    this.resolver = new TimedTargetResolver(input.binding, input.startEvent, input.geometry);
    this.renderer = new TimedPreviewRenderer(input.binding, input.geometry);
  }

  start(): void {
    const { binding, capturedElement, kind, ownerWindow, startEvent } = this.input;
    binding.owner.begin(this.dispose);
    binding.source.classList.toggle('is-picked-up', kind === 'move');
    if (kind !== 'move') capturedElement.dataset['activeResize'] = 'true';
    capture(capturedElement, startEvent.pointerId);
    ownerWindow.addEventListener('pointermove', this.onPointerMove);
    ownerWindow.addEventListener('pointerup', this.onPointerUp);
    ownerWindow.addEventListener('pointercancel', this.onCancel);
    ownerWindow.addEventListener('blur', this.onCancel);
    capturedElement.addEventListener('lostpointercapture', this.onCancel);
  }

  private readonly onPointerMove = (pointer: PointerEvent): void => {
    pointer.preventDefault();
    this.update(pointer);
  };

  private readonly onPointerUp = (pointer: PointerEvent): void => {
    if (pointer.pointerId !== this.input.startEvent.pointerId) return;
    this.update(pointer);
    const committed = this.latest;
    this.dispose();
    if (committed != null) this.commit(committed);
  };

  private readonly onCancel = (): void => {
    this.dispose();
  };

  private update(pointer: PointerEvent): void {
    if (this.disposed || pointer.pointerId !== this.input.startEvent.pointerId) return;
    const target = this.resolver.resolve(this.input.kind, pointer);
    this.latest = target;
    if (target == null) {
      this.renderer.clear();
      return;
    }
    this.renderer.render(this.input.kind, target);
  }

  private commit(target: TimedPreviewTarget): void {
    const { binding, kind } = this.input;
    if (kind === 'move') {
      binding.onMove(binding.task, target as TimedDragTarget);
      return;
    }
    if (kind === 'duration' || kind === 'start-time') {
      binding.onDuration(binding.task, target as TimedVerticalResizeTarget);
      return;
    }
    binding.onBoundary(binding.task, target as TimedBoundaryTarget);
  }

  private readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    const { binding, capturedElement, ownerWindow, startEvent } = this.input;
    this.renderer.clear();
    binding.source.classList.remove('is-picked-up');
    delete binding.source.dataset['activeResize'];
    delete capturedElement.dataset['activeResize'];
    ownerWindow.removeEventListener('pointermove', this.onPointerMove);
    ownerWindow.removeEventListener('pointerup', this.onPointerUp);
    ownerWindow.removeEventListener('pointercancel', this.onCancel);
    ownerWindow.removeEventListener('blur', this.onCancel);
    capturedElement.removeEventListener('lostpointercapture', this.onCancel);
    release(capturedElement, startEvent.pointerId);
    binding.owner.end(this.dispose);
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
  if (event.button !== 0 || isBlockedMoveTarget(event, kind)) return;
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
