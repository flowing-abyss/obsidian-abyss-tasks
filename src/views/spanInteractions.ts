import {
  daysBetweenLocalDates,
  localDate,
  shiftLocalDate,
  type LocalDate,
  type TaskSnapshot,
} from '../tasks';
import type { VisibleSpanLayout } from './spanLayout';
import { populateCalendarPreview } from './timegrid/calendarPreview';
import { resolveBoundaryTarget, type SpanBoundaryTarget } from './timegrid/dragGeometry';
import { taskLayoutIdentity } from './timegrid/layout';

export interface SpanDateColumn {
  readonly date: string;
  readonly left: number;
  readonly right: number;
}

export interface SpanMovePayload {
  readonly version: 1;
  readonly task: { readonly filePath: string; readonly line: number };
  readonly grabbedDate: LocalDate;
}

export interface SpanMoveTarget {
  readonly grabbedDate: LocalDate;
  readonly targetDate: LocalDate;
  readonly days: number;
}

export type InteractiveSpanBoundaryTarget =
  | SpanBoundaryTarget
  | {
      readonly boundary: 'create-span';
      readonly date: LocalDate;
      readonly dayDelta: number;
    };

function semanticTargetKey(
  kind: 'move' | 'start' | 'due' | 'create-span',
  target: Readonly<SpanMoveTarget | InteractiveSpanBoundaryTarget>,
): string {
  if (kind === 'move') {
    const move = target as SpanMoveTarget;
    return `${kind}:${move.grabbedDate}:${move.targetDate}:${move.days}`;
  }
  const boundary = target as InteractiveSpanBoundaryTarget;
  return `${kind}:${boundary.boundary}:${boundary.date}:${boundary.dayDelta}`;
}

export interface SpanInteractionOwner {
  begin(dispose: () => void): void;
  end(dispose: () => void): void;
  disposeActive(): void;
}

export function createSpanInteractionOwner(): SpanInteractionOwner {
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

function parsedDate(value: unknown): LocalDate | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return localDate(value);
  } catch {
    return undefined;
  }
}

function validColumn(column: SpanDateColumn): boolean {
  return (
    parsedDate(column.date) !== undefined &&
    Number.isFinite(column.left) &&
    Number.isFinite(column.right) &&
    column.left < column.right
  );
}

export function resolveGrabbedDate(
  clientX: number,
  columns: readonly SpanDateColumn[],
): LocalDate | undefined {
  if (
    !Number.isFinite(clientX) ||
    columns.length === 0 ||
    columns.some((column) => !validColumn(column))
  ) {
    return undefined;
  }
  const matches = columns.filter(
    (column, index) =>
      clientX >= column.left &&
      (clientX < column.right || (index === columns.length - 1 && clientX === column.right)),
  );
  return matches.length === 1 ? parsedDate(matches[0]!.date) : undefined;
}

export function serializeSpanMovePayload(task: TaskSnapshot, grabbedDate: string): string {
  const date = localDate(grabbedDate);
  return JSON.stringify({
    version: 1,
    task: { filePath: task.source.filePath, line: task.source.line },
    grabbedDate: date,
  } satisfies SpanMovePayload);
}

export function parseSpanMovePayload(serialized: string): SpanMovePayload | undefined {
  try {
    const value = JSON.parse(serialized) as Partial<SpanMovePayload>;
    const grabbedDate = parsedDate(value.grabbedDate);
    if (
      value.version !== 1 ||
      typeof value.task?.filePath !== 'string' ||
      value.task.filePath.length === 0 ||
      !Number.isSafeInteger(value.task.line) ||
      (value.task.line ?? -1) < 0 ||
      !grabbedDate
    )
      return undefined;
    return Object.freeze({
      version: 1,
      task: Object.freeze({ filePath: value.task.filePath, line: value.task.line }),
      grabbedDate,
    });
  } catch {
    return undefined;
  }
}

export function resolveSpanMoveTarget(
  payload: SpanMovePayload,
  targetDate: string,
): Readonly<SpanMoveTarget> | undefined {
  const target = parsedDate(targetDate);
  if (!target) return undefined;
  const days = daysBetweenLocalDates(payload.grabbedDate, target);
  return days === 0
    ? undefined
    : Object.freeze({ grabbedDate: payload.grabbedDate, targetDate: target, days });
}

interface MeasuredSpanColumn {
  readonly element: HTMLElement;
  readonly date: LocalDate;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly row: HTMLElement;
  readonly layer: HTMLElement;
}

function measuredColumns(source: HTMLElement): MeasuredSpanColumn[] {
  const root = source.closest<HTMLElement>('.tc-tg-root, .tc-mg-grid');
  if (!root) return [];
  const selector = root.classList.contains('tc-tg-root')
    ? '.tc-tg-allday-cell[data-tg-date]'
    : '.tc-mg-cell[data-mg-date]';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).flatMap((element) => {
    const dateValue = element.dataset['tgDate'] ?? element.dataset['mgDate'];
    const date = parsedDate(dateValue);
    const row = element.closest<HTMLElement>('.tc-tg-allday-days, .tc-mg-row');
    const layer = row?.querySelector<HTMLElement>(
      ':scope > .tc-tg-span-layer, :scope > .tc-mg-span-layer',
    );
    if (!date || !row || !layer) return [];
    const rect = element.getBoundingClientRect();
    return [
      {
        element,
        date,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        row,
        layer,
      },
    ];
  });
}

function columnAtPoint(
  pointer: Pick<PointerEvent, 'clientX' | 'clientY'>,
  columns: readonly MeasuredSpanColumn[],
  allowXFallback = true,
): MeasuredSpanColumn | undefined {
  const byRect = columns.filter(
    (column) =>
      pointer.clientX >= column.left &&
      pointer.clientX <= column.right &&
      pointer.clientY >= column.top &&
      pointer.clientY <= column.bottom,
  );
  if (byRect.length === 1) return byRect[0];
  if (!allowXFallback) return undefined;
  const byX = columns.filter(
    (column) => pointer.clientX >= column.left && pointer.clientX <= column.right,
  );
  return byX.length === 1 ? byX[0] : undefined;
}

function rowColumns(
  column: MeasuredSpanColumn,
  columns: readonly MeasuredSpanColumn[],
): MeasuredSpanColumn[] {
  return columns
    .filter((candidate) => candidate.row === column.row)
    .sort((left, right) => left.left - right.left);
}

function capture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Window listeners remain authoritative when the host cannot capture.
  }
}

function release(element: HTMLElement, pointerId: number): void {
  try {
    element.releasePointerCapture?.(pointerId);
  } catch {
    // Capture may already have been released by the host.
  }
}

function createPreview(
  source: HTMLElement,
  className: string,
  target: object,
  task: TaskSnapshot,
  phase: 'ghost' | 'terminal',
  subtitle: string,
): HTMLElement {
  const preview = source.ownerDocument.createElement('div');
  preview.className = className;
  preview.dataset['target'] = JSON.stringify(target);
  populateCalendarPreview(preview, source, {
    title: task.title,
    subtitle,
    density: 'regular',
    phase,
  });
  return preview;
}

export interface SpanInteractionBinding {
  readonly source: HTMLElement;
  readonly task: TaskSnapshot;
  readonly segmentStart: string;
  readonly segmentEnd: string;
  readonly owner: SpanInteractionOwner;
  readonly previewLayoutFor?: (
    task: TaskSnapshot,
    planning: TaskSnapshot['planning'],
  ) => VisibleSpanLayout;
  readonly boundaryHandles: readonly {
    readonly element: HTMLElement;
    readonly boundary: 'start' | 'due' | 'create-span';
  }[];
  readonly onMove: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  readonly onBoundary: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
  readonly enableMove?: boolean;
}

const POINTER_DRAG_THRESHOLD_PX = 3;

export function attachSpanInteractions(binding: SpanInteractionBinding): void {
  const { source, task, owner } = binding;
  const ownerDocument = source.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return;

  const startSession = (
    event: PointerEvent,
    kind: 'move' | 'start' | 'due' | 'create-span',
  ): void => {
    if (event.button !== 0) return;
    if (
      kind === 'move' &&
      (event.target as Element).closest('.tc-status-marker, a, [data-boundary]')
    )
      return;
    event.preventDefault();
    event.stopPropagation();

    owner.disposeActive();
    const columns = measuredColumns(source);
    const sourceColumn = columns.find((column) => column.date === parsedDate(binding.segmentStart));
    if (!sourceColumn) return;
    const sourceRowColumns = rowColumns(sourceColumn, columns);
    const isMonth = source.closest('.tc-mg-grid') !== null;
    const grabbedDate =
      kind === 'move'
        ? resolveGrabbedDate(
            event.clientX,
            sourceRowColumns.map(({ date, left, right }) => ({ date, left, right })),
          )
        : undefined;
    if (kind === 'move' && !grabbedDate) return;

    if (kind === 'move') source.focus();
    const pointerId = event.pointerId;
    const pointerOrigin = { x: event.clientX, y: event.clientY };
    const capturedElement = event.currentTarget as HTMLElement;
    const originalDraggable = source.getAttribute('draggable');
    let previews: HTMLElement[] = [];
    let latest: Readonly<SpanMoveTarget | InteractiveSpanBoundaryTarget> | undefined;
    let renderedTargetKey: string | undefined;
    let dragStarted = false;
    let disposed = false;

    const clearPreview = (): void => {
      for (const preview of previews) preview.remove();
      previews = [];
      renderedTargetKey = undefined;
    };

    const previewRow = (
      column: MeasuredSpanColumn,
      layout: VisibleSpanLayout | undefined,
    ): string => {
      const rowStart = rowColumns(column, columns)[0]?.date;
      if (!layout || !rowStart) return source.style.gridRow;
      const identity = taskLayoutIdentity(task);
      const segment = layout.rows
        .find((row) => row.startDate === rowStart)
        ?.segments.find(
          (candidate) => candidate.identity === identity && candidate.date === column.date,
        );
      return segment ? String(segment.lane + 1) : source.style.gridRow;
    };

    const renderMovePreview = (target: SpanMoveTarget): void => {
      clearPreview();
      const actualStart = task.planning.start ?? localDate(binding.segmentStart);
      const actualDue = task.planning.due ?? localDate(binding.segmentEnd);
      const shiftedStart = shiftLocalDate(actualStart, target.days);
      const shiftedEnd = shiftLocalDate(actualDue, target.days);
      if (!shiftedStart || !shiftedEnd) return;
      const planning = { ...task.planning, start: shiftedStart, due: shiftedEnd };
      const layout = binding.previewLayoutFor?.(task, planning);
      const rows = new Set(columns.map((column) => column.row));
      for (const row of rows) {
        const candidates = columns.filter((column) => column.row === row);
        const visible = candidates.filter(
          (column) => column.date >= shiftedStart && column.date <= shiftedEnd,
        );
        if (visible.length === 0) continue;
        for (const column of visible) {
          const index = candidates.indexOf(column);
          const preview = createPreview(
            source,
            'tc-span-move-preview',
            target,
            task,
            column.date === shiftedEnd ? 'terminal' : 'ghost',
            `${shiftedStart}–${shiftedEnd}`,
          );
          preview.style.gridColumn = `${index + 1} / ${index + 2}`;
          preview.style.gridRow = previewRow(column, layout);
          column.layer.appendChild(preview);
          previews.push(preview);
        }
      }
    };

    const renderBoundaryPreview = (target: InteractiveSpanBoundaryTarget): void => {
      clearPreview();
      const actualStart =
        task.planning.start ??
        task.planning.scheduled ??
        task.planning.due ??
        parsedDate(binding.segmentStart);
      const actualDue =
        task.planning.due ??
        task.planning.scheduled ??
        task.planning.start ??
        parsedDate(binding.segmentEnd);
      if (!actualStart || !actualDue) return;
      const prospectiveStart = target.boundary === 'start' ? target.date : actualStart;
      const prospectiveDue = target.boundary === 'start' ? actualDue : target.date;
      const planning = {
        ...task.planning,
        start: prospectiveStart,
        due: prospectiveDue,
      };
      const layout = binding.previewLayoutFor?.(task, planning);
      const previewColumns = isMonth ? columns : sourceRowColumns;
      const rows = new Set(previewColumns.map((column) => column.row));
      for (const row of rows) {
        const candidates = previewColumns.filter((column) => column.row === row);
        const visible = candidates.filter(
          (column) => column.date >= prospectiveStart && column.date <= prospectiveDue,
        );
        if (visible.length === 0) continue;
        for (const column of visible) {
          const index = candidates.indexOf(column);
          const preview = createPreview(
            source,
            'tc-span-boundary-preview',
            target,
            task,
            column.date === prospectiveDue ? 'terminal' : 'ghost',
            `${prospectiveStart}–${prospectiveDue}`,
          );
          preview.style.gridColumn = `${index + 1} / ${index + 2}`;
          preview.style.gridRow = previewRow(column, layout);
          column.layer.appendChild(preview);
          previews.push(preview);
        }
      }
    };

    const resolve = (pointer: PointerEvent): typeof latest => {
      const targetColumns = kind === 'move' || isMonth ? columns : sourceRowColumns;
      const column = columnAtPoint(pointer, targetColumns, !isMonth);
      if (!column) return undefined;
      if (kind === 'move') {
        const payload: SpanMovePayload = {
          version: 1,
          task: { filePath: task.source.filePath, line: task.source.line },
          grabbedDate: grabbedDate!,
        };
        return resolveSpanMoveTarget(payload, column.date);
      }
      const start = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
      const due = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
      if (!start || !due) return undefined;
      const target = resolveBoundaryTarget(
        { boundary: kind === 'start' ? 'start' : 'due', start, due },
        pointer,
        [{ date: column.date, left: column.left, right: column.right }],
      );
      if (!target) return undefined;
      return Object.freeze(
        kind === 'create-span' ? { ...target, boundary: 'create-span' as const } : target,
      );
    };

    const update = (pointer: PointerEvent): void => {
      if (disposed || pointer.pointerId !== pointerId) return;
      latest = resolve(pointer);
      if (!latest) {
        if (renderedTargetKey !== undefined) clearPreview();
        return;
      }
      const targetKey = semanticTargetKey(kind, latest);
      if (targetKey === renderedTargetKey) return;
      if (kind === 'move') renderMovePreview(latest as SpanMoveTarget);
      else renderBoundaryPreview(latest as InteractiveSpanBoundaryTarget);
      renderedTargetKey = targetKey;
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      clearPreview();
      source.classList.remove('is-picked-up');
      delete source.dataset['activeResize'];
      if (kind !== 'move') {
        if (originalDraggable === null) source.removeAttribute('draggable');
        else source.setAttribute('draggable', originalDraggable);
      }
      ownerWindow.removeEventListener('pointermove', onPointerMove);
      ownerWindow.removeEventListener('pointerup', onPointerUp);
      ownerWindow.removeEventListener('pointercancel', onCancel);
      ownerWindow.removeEventListener('blur', onCancel);
      capturedElement.removeEventListener('lostpointercapture', onCancel);
      release(capturedElement, pointerId);
      owner.end(dispose);
    };
    const onPointerMove = (pointer: PointerEvent): void => {
      pointer.preventDefault();
      if (!dragStarted) {
        const x = pointer.clientX - pointerOrigin.x;
        const y = pointer.clientY - pointerOrigin.y;
        if (Math.hypot(x, y) < POINTER_DRAG_THRESHOLD_PX) return;
        dragStarted = true;
      }
      update(pointer);
    };
    const onPointerUp = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== pointerId) return;
      if (!dragStarted) {
        const x = pointer.clientX - pointerOrigin.x;
        const y = pointer.clientY - pointerOrigin.y;
        dragStarted = Math.hypot(x, y) >= POINTER_DRAG_THRESHOLD_PX;
      }
      if (dragStarted) update(pointer);
      const target = latest;
      dispose();
      if (!target) return;
      if (kind === 'move') binding.onMove(task, target as SpanMoveTarget);
      else binding.onBoundary(task, target as InteractiveSpanBoundaryTarget);
    };
    const onCancel = (): void => dispose();

    owner.begin(dispose);
    source.classList.toggle('is-picked-up', kind === 'move');
    if (kind === 'start') source.dataset['activeResize'] = 'start-date';
    else if (kind !== 'move') source.dataset['activeResize'] = 'due-date';
    if (kind !== 'move') source.setAttribute('draggable', 'false');
    capture(capturedElement, pointerId);
    ownerWindow.addEventListener('pointermove', onPointerMove);
    ownerWindow.addEventListener('pointerup', onPointerUp);
    ownerWindow.addEventListener('pointercancel', onCancel);
    ownerWindow.addEventListener('blur', onCancel);
    capturedElement.addEventListener('lostpointercapture', onCancel);
  };

  if (binding.enableMove !== false) {
    source.addEventListener('pointerdown', (event) => startSession(event, 'move'));
  }
  for (const handle of binding.boundaryHandles) {
    handle.element.dataset['resizeEdge'] = handle.boundary === 'start' ? 'start-date' : 'due-date';
    handle.element.setAttribute('draggable', 'false');
    handle.element.addEventListener('pointerdown', (event) => startSession(event, handle.boundary));
  }
}
