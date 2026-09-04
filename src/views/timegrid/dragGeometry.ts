import { daysBetweenLocalDates, localDate, type LocalDate } from '../../tasks';

const MINUTES_PER_DAY = 24 * 60;
const SNAP_MINUTES = 15;
const LAST_SNAP_MINUTE = MINUTES_PER_DAY - SNAP_MINUTES;
const MINUTE_EPSILON = 1e-7;

export interface TimedDragOrigin {
  readonly date: LocalDate;
  readonly startMinutes: number;
  readonly durationMinutes: number;
  /** Actual rendered height normalized to grid minutes; may exceed duration for CSS min-height. */
  readonly renderedHeightMinutes?: number;
  readonly grabOffsetMinutes: number;
}

export interface TimedDragPointer {
  readonly clientX: number;
  readonly clientY: number;
}

export interface DragDateColumn {
  readonly date: LocalDate;
  readonly left: number;
  readonly right: number;
}

export interface TimedDragColumn extends DragDateColumn {
  readonly allDayTop?: number;
  readonly allDayBottom?: number;
  readonly timeGridTop: number;
  readonly timeGridBottom: number;
}

export interface TimedDragTarget {
  readonly date: LocalDate;
  readonly startMinutes: number;
  readonly dayDelta: number;
  readonly destination: 'time-grid' | 'all-day';
}

export interface TimedDurationPointer {
  readonly clientY: number;
}

export interface TimedVerticalResizeOrigin {
  readonly edge: 'start' | 'end';
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly grabClientY: number;
  readonly pixelsPerMinute: number;
}

export interface TimedVerticalResizeTarget {
  readonly edge: 'start' | 'end';
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly endMinutes: number;
}

export interface SpanBoundaryOrigin {
  readonly boundary: 'start' | 'due';
  readonly start: LocalDate;
  readonly due: LocalDate;
}

export interface SpanBoundaryTarget {
  readonly boundary: 'start' | 'due';
  readonly date: LocalDate;
  readonly dayDelta: number;
}

function validDate(value: string): value is LocalDate {
  try {
    localDate(value);
    return true;
  } catch {
    return false;
  }
}

function validDateColumn(column: DragDateColumn): boolean {
  return (
    validDate(column.date) &&
    Number.isFinite(column.left) &&
    Number.isFinite(column.right) &&
    column.left < column.right
  );
}

function validTimedColumn(column: TimedDragColumn): boolean {
  return validDateColumn(column) && validAllDayRange(column) && validTimeGridRange(column);
}

function validAllDayRange(column: TimedDragColumn): boolean {
  const allDayAbsent = column.allDayTop === undefined && column.allDayBottom === undefined;
  const allDayValid =
    column.allDayTop !== undefined &&
    column.allDayBottom !== undefined &&
    Number.isFinite(column.allDayTop) &&
    Number.isFinite(column.allDayBottom) &&
    column.allDayTop < column.allDayBottom;
  return allDayAbsent || allDayValid;
}

function validTimeGridRange(column: TimedDragColumn): boolean {
  return (
    Number.isFinite(column.timeGridTop) &&
    Number.isFinite(column.timeGridBottom) &&
    column.timeGridTop < column.timeGridBottom
  );
}

function columnAt<T extends DragDateColumn>(clientX: number, columns: readonly T[]): T | undefined {
  const matches = columns.filter(
    (column, index) =>
      clientX >= column.left &&
      (clientX < column.right || (index === columns.length - 1 && clientX === column.right)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveTimedDragTarget(
  origin: TimedDragOrigin,
  pointer: TimedDragPointer,
  columns: readonly TimedDragColumn[],
): TimedDragTarget | undefined {
  const renderedHeightMinutes = origin.renderedHeightMinutes ?? origin.durationMinutes;
  if (!validTimedDragInput(origin, pointer, columns, renderedHeightMinutes)) return undefined;

  const column = columnAt(pointer.clientX, columns);
  if (column == null) return undefined;
  const dayDelta = daysBetweenLocalDates(origin.date, column.date);
  return (
    resolveAllDayTarget(origin, pointer, column, dayDelta) ??
    resolveTimeGridTarget(origin, pointer, column, dayDelta)
  );
}

function resolveAllDayTarget(
  origin: TimedDragOrigin,
  pointer: TimedDragPointer,
  column: TimedDragColumn,
  dayDelta: number,
): TimedDragTarget | undefined {
  if (
    column.allDayTop !== undefined &&
    column.allDayBottom !== undefined &&
    pointer.clientY >= column.allDayTop &&
    pointer.clientY <= column.allDayBottom
  ) {
    return {
      date: column.date,
      startMinutes: origin.startMinutes,
      dayDelta,
      destination: 'all-day',
    };
  }
  return undefined;
}

function resolveTimeGridTarget(
  origin: TimedDragOrigin,
  pointer: TimedDragPointer,
  column: TimedDragColumn,
  dayDelta: number,
): TimedDragTarget | undefined {
  if (pointer.clientY < column.timeGridTop || pointer.clientY > column.timeGridBottom) {
    return undefined;
  }
  const pointerMinutes =
    ((pointer.clientY - column.timeGridTop) / (column.timeGridBottom - column.timeGridTop)) *
    MINUTES_PER_DAY;
  const rawStartMinutes = pointerMinutes - origin.grabOffsetMinutes;
  if (dayDelta === 0 && Math.abs(rawStartMinutes - origin.startMinutes) < MINUTE_EPSILON) {
    return undefined;
  }
  const snapped = Math.round(rawStartMinutes / SNAP_MINUTES) * SNAP_MINUTES;
  const startMinutes = Math.min(Math.max(snapped, 0), LAST_SNAP_MINUTE);
  if (dayDelta === 0 && startMinutes === origin.startMinutes) return undefined;
  return { date: column.date, startMinutes, dayDelta, destination: 'time-grid' };
}

function validTimedDragInput(
  origin: TimedDragOrigin,
  pointer: TimedDragPointer,
  columns: readonly TimedDragColumn[],
  renderedHeightMinutes: number,
): boolean {
  return (
    validTimedDragOrigin(origin, renderedHeightMinutes) &&
    Number.isFinite(pointer.clientX) &&
    Number.isFinite(pointer.clientY) &&
    columns.length > 0 &&
    columns.every(validTimedColumn)
  );
}

function validTimedDragOrigin(origin: TimedDragOrigin, renderedHeightMinutes: number): boolean {
  return [
    validDate(origin.date) && Number.isInteger(origin.startMinutes),
    origin.startMinutes >= 0,
    origin.startMinutes < MINUTES_PER_DAY,
    Number.isInteger(origin.durationMinutes),
    origin.durationMinutes > 0,
    origin.durationMinutes <= MINUTES_PER_DAY,
    Number.isFinite(renderedHeightMinutes),
    renderedHeightMinutes >= origin.durationMinutes,
    Number.isFinite(origin.grabOffsetMinutes),
    origin.grabOffsetMinutes >= 0,
    origin.grabOffsetMinutes <= renderedHeightMinutes,
  ].every((condition) => condition);
}

export function resolveTimedVerticalResizeTarget(
  origin: TimedVerticalResizeOrigin,
  pointer: TimedDurationPointer,
): TimedVerticalResizeTarget {
  const originEndMinutes = origin.startMinutes + origin.durationMinutes;
  if (!validVerticalResizeInput(origin, pointer, originEndMinutes)) {
    throw new RangeError('Invalid timed vertical resize geometry');
  }

  const deltaMinutes = (pointer.clientY - origin.grabClientY) / origin.pixelsPerMinute;
  const snappedDelta = Math.round(deltaMinutes / SNAP_MINUTES) * SNAP_MINUTES;
  if (snappedDelta === 0) {
    return {
      edge: origin.edge,
      startMinutes: origin.startMinutes,
      durationMinutes: origin.durationMinutes,
      endMinutes: originEndMinutes,
    };
  }
  if (origin.edge === 'start') {
    const startMinutes = Math.min(
      Math.max(origin.startMinutes + snappedDelta, 0),
      originEndMinutes - SNAP_MINUTES,
    );
    return {
      edge: 'start',
      startMinutes,
      durationMinutes: originEndMinutes - startMinutes,
      endMinutes: originEndMinutes,
    };
  }

  const endMinutes = Math.min(
    Math.max(originEndMinutes + snappedDelta, origin.startMinutes + SNAP_MINUTES),
    MINUTES_PER_DAY,
  );
  return {
    edge: 'end',
    startMinutes: origin.startMinutes,
    durationMinutes: endMinutes - origin.startMinutes,
    endMinutes,
  };
}

function validVerticalResizeInput(
  origin: TimedVerticalResizeOrigin,
  pointer: TimedDurationPointer,
  originEndMinutes: number,
): boolean {
  const runtimeEdge: unknown = origin.edge;
  return [
    (runtimeEdge === 'start' || runtimeEdge === 'end') && Number.isInteger(origin.startMinutes),
    origin.startMinutes >= 0,
    origin.startMinutes < MINUTES_PER_DAY,
    Number.isInteger(origin.durationMinutes),
    origin.durationMinutes > 0,
    originEndMinutes <= MINUTES_PER_DAY,
    Number.isFinite(origin.grabClientY),
    Number.isFinite(origin.pixelsPerMinute),
    origin.pixelsPerMinute > 0,
    Number.isFinite(pointer.clientY),
  ].every((condition) => condition);
}

export function resolveBoundaryTarget(
  origin: SpanBoundaryOrigin,
  pointer: Pick<TimedDragPointer, 'clientX'>,
  columns: readonly DragDateColumn[],
): SpanBoundaryTarget | undefined {
  if (!validBoundaryInput(origin, pointer, columns)) return undefined;

  const column = columnAt(pointer.clientX, columns);
  if (column == null) return undefined;
  const current = origin[origin.boundary];
  const date = clampBoundaryDate(origin, column.date);
  if (date === current) return undefined;
  return {
    boundary: origin.boundary,
    date,
    dayDelta: daysBetweenLocalDates(current, date),
  };
}

function validBoundaryInput(
  origin: SpanBoundaryOrigin,
  pointer: Pick<TimedDragPointer, 'clientX'>,
  columns: readonly DragDateColumn[],
): boolean {
  const runtimeBoundary: unknown = origin.boundary;
  return (
    (runtimeBoundary === 'start' || runtimeBoundary === 'due') &&
    validDate(origin.start) &&
    validDate(origin.due) &&
    origin.start <= origin.due &&
    Number.isFinite(pointer.clientX) &&
    columns.length > 0 &&
    columns.every(validDateColumn)
  );
}

function clampBoundaryDate(origin: SpanBoundaryOrigin, candidate: LocalDate): LocalDate {
  if (origin.boundary === 'start' && candidate > origin.due) return origin.due;
  if (origin.boundary === 'due' && candidate < origin.start) return origin.start;
  return candidate;
}
