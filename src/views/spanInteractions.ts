import {
  daysBetweenLocalDates,
  localDate,
  shiftLocalDate,
  type LocalDate,
  type TaskSnapshot,
} from '../tasks';
import { resolveBoundaryTarget, type SpanBoundaryTarget } from './timegrid/dragGeometry';

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
): MeasuredSpanColumn | undefined {
  const byRect = columns.filter(
    (column) =>
      pointer.clientX >= column.left &&
      pointer.clientX <= column.right &&
      pointer.clientY >= column.top &&
      pointer.clientY <= column.bottom,
  );
  if (byRect.length === 1) return byRect[0];
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

function createPreview(source: HTMLElement, className: string, target: object): HTMLElement {
  const preview = source.ownerDocument.createElement('div');
  preview.className = className;
  preview.dataset['target'] = JSON.stringify(target);
  const color = source.style.getPropertyValue('--tc-tag-color');
  if (color) preview.style.setProperty('--tc-tag-color', color);
  return preview;
}

export interface SpanInteractionBinding {
  readonly source: HTMLElement;
  readonly task: TaskSnapshot;
  readonly segmentStart: string;
  readonly segmentEnd: string;
  readonly owner: SpanInteractionOwner;
  readonly boundaryHandles: readonly {
    readonly element: HTMLElement;
    readonly boundary: 'start' | 'due' | 'create-span';
  }[];
  readonly onMove: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  readonly onBoundary: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
}

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

    const columns = measuredColumns(source);
    const sourceColumn = columns.find((column) => column.date === parsedDate(binding.segmentStart));
    if (!sourceColumn) return;
    const sourceRowColumns = rowColumns(sourceColumn, columns);
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
    const capturedElement = event.currentTarget as HTMLElement;
    let previews: HTMLElement[] = [];
    let latest: Readonly<SpanMoveTarget | InteractiveSpanBoundaryTarget> | undefined;
    let disposed = false;

    const clearPreview = (): void => {
      for (const preview of previews) preview.remove();
      previews = [];
    };

    const renderMovePreview = (target: SpanMoveTarget): void => {
      clearPreview();
      const actualStart = task.planning.start ?? localDate(binding.segmentStart);
      const actualDue = task.planning.due ?? localDate(binding.segmentEnd);
      const shiftedStart = shiftLocalDate(actualStart, target.days);
      const shiftedEnd = shiftLocalDate(actualDue, target.days);
      if (!shiftedStart || !shiftedEnd) return;
      const rows = new Set(columns.map((column) => column.row));
      for (const row of rows) {
        const candidates = columns.filter((column) => column.row === row);
        const visible = candidates.filter(
          (column) => column.date >= shiftedStart && column.date <= shiftedEnd,
        );
        if (visible.length === 0) continue;
        const first = candidates.indexOf(visible[0]!);
        const last = candidates.indexOf(visible[visible.length - 1]!);
        const preview = createPreview(source, 'tc-span-move-preview', target);
        preview.style.gridColumn = `${first + 1} / ${last + 2}`;
        preview.style.gridRow = source.style.gridRow;
        visible[0]!.layer.appendChild(preview);
        previews.push(preview);
      }
    };

    const renderBoundaryPreview = (target: InteractiveSpanBoundaryTarget): void => {
      clearPreview();
      const column = columns.find((candidate) => candidate.date === target.date);
      if (!column) return;
      const candidates = columns.filter((candidate) => candidate.row === column.row);
      const fixedDate = target.boundary === 'start' ? binding.segmentEnd : binding.segmentStart;
      const fixedColumn = candidates.find((candidate) => candidate.date === fixedDate);
      if (!fixedColumn) return;
      const startIndex = Math.min(candidates.indexOf(column), candidates.indexOf(fixedColumn));
      const endIndex = Math.max(candidates.indexOf(column), candidates.indexOf(fixedColumn));
      const preview = createPreview(source, 'tc-span-boundary-preview', target);
      preview.style.gridColumn = `${startIndex + 1} / ${endIndex + 2}`;
      preview.style.gridRow = source.style.gridRow;
      column.layer.appendChild(preview);
      previews = [preview];
    };

    const resolve = (pointer: PointerEvent): typeof latest => {
      // A Month layer is scoped to one visual week.  Looking across every month cell
      // makes the hit ambiguous (and makes a gesture on one row accidentally target a
      // same-column cell in a different row); the source segment's row is the complete
      // set of legal destinations for this interaction.
      const column = columnAtPoint(pointer, kind === 'move' ? columns : sourceRowColumns);
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
        clearPreview();
        return;
      }
      if (kind === 'move') renderMovePreview(latest as SpanMoveTarget);
      else renderBoundaryPreview(latest as InteractiveSpanBoundaryTarget);
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      clearPreview();
      source.classList.remove('is-picked-up', 'is-edge-resizing');
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
      update(pointer);
    };
    const onPointerUp = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== pointerId) return;
      update(pointer);
      const target = latest;
      dispose();
      if (!target) return;
      if (kind === 'move') binding.onMove(task, target as SpanMoveTarget);
      else binding.onBoundary(task, target as InteractiveSpanBoundaryTarget);
    };
    const onCancel = (): void => dispose();

    owner.begin(dispose);
    source.classList.toggle('is-picked-up', kind === 'move');
    source.classList.toggle('is-edge-resizing', kind !== 'move');
    capture(capturedElement, pointerId);
    ownerWindow.addEventListener('pointermove', onPointerMove);
    ownerWindow.addEventListener('pointerup', onPointerUp);
    ownerWindow.addEventListener('pointercancel', onCancel);
    ownerWindow.addEventListener('blur', onCancel);
    capturedElement.addEventListener('lostpointercapture', onCancel);
  };

  source.addEventListener('pointerdown', (event) => startSession(event, 'move'));
  for (const handle of binding.boundaryHandles) {
    handle.element.addEventListener('pointerdown', (event) => startSession(event, handle.boundary));
  }
}
