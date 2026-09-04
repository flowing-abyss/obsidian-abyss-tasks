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
  const match = matches[0];
  return matches.length === 1 && match !== undefined ? parsedDate(match.date) : undefined;
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
      value.task.line < 0 ||
      grabbedDate == null
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
  if (target == null) return undefined;
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
  const root = source.closest<HTMLElement>('.abyss-tg-root, .abyss-mg-grid');
  if (root == null) return [];
  const selector = root.classList.contains('abyss-tg-root')
    ? '.abyss-tg-allday-cell[data-tg-date]'
    : '.abyss-mg-cell[data-mg-date]';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).flatMap((element) => {
    const dateValue = element.dataset['tgDate'] ?? element.dataset['mgDate'];
    const date = parsedDate(dateValue);
    const row = element.closest<HTMLElement>('.abyss-tg-allday-days, .abyss-mg-row');
    const layer = row?.querySelector<HTMLElement>(
      ':scope > .abyss-tg-span-layer, :scope > .abyss-mg-span-layer',
    );
    if (date == null || row == null || layer == null) return [];
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
  if (typeof element.setPointerCapture !== 'function') return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Window listeners remain authoritative when the host cannot capture.
  }
}

function release(element: HTMLElement, pointerId: number): void {
  if (typeof element.releasePointerCapture !== 'function') return;
  try {
    element.releasePointerCapture(pointerId);
  } catch {
    // Capture may already have been released by the host.
  }
}

interface SpanPreviewOptions {
  readonly className: string;
  readonly target: object;
  readonly task: TaskSnapshot;
  readonly phase: 'ghost' | 'terminal';
  readonly subtitle: string;
}

function createPreview(source: HTMLElement, options: SpanPreviewOptions): HTMLElement {
  const preview = source.ownerDocument.adoptNode(createFragment().createDiv());
  preview.className = options.className;
  preview.dataset['target'] = JSON.stringify(options.target);
  populateCalendarPreview(preview, source, {
    title: options.task.title,
    subtitle: options.subtitle,
    density: 'regular',
    phase: options.phase,
  });
  return preview;
}

export interface SpanInteractionBinding {
  readonly source: HTMLElement;
  readonly task: TaskSnapshot;
  readonly segmentStart: string;
  readonly segmentEnd: string;
  readonly owner: SpanInteractionOwner;
  readonly previewLayoutFor?:
    ((task: TaskSnapshot, planning: TaskSnapshot['planning']) => VisibleSpanLayout) | undefined;
  readonly boundaryHandles: ReadonlyArray<{
    readonly element: HTMLElement;
    readonly boundary: 'start' | 'due' | 'create-span';
  }>;
  readonly onMove: (task: TaskSnapshot, target: SpanMoveTarget) => void;
  readonly onBoundary: (task: TaskSnapshot, target: InteractiveSpanBoundaryTarget) => void;
  readonly enableMove?: boolean | undefined;
}

const POINTER_DRAG_THRESHOLD_PX = 3;

type SpanInteractionKind = 'move' | 'start' | 'due' | 'create-span';
type SpanInteractionTarget = Readonly<SpanMoveTarget | InteractiveSpanBoundaryTarget>;

interface SpanPreviewRangeOptions {
  readonly source: HTMLElement;
  readonly task: TaskSnapshot;
  readonly columns: readonly MeasuredSpanColumn[];
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly className: string;
  readonly target: object;
  readonly layout: VisibleSpanLayout | undefined;
}

function previewGridRow(options: SpanPreviewRangeOptions, column: MeasuredSpanColumn): string {
  const rowStart = rowColumns(column, options.columns)[0]?.date;
  if (options.layout == null || rowStart == null) return options.source.style.gridRow;
  const identity = taskLayoutIdentity(options.task);
  const row = options.layout.rows.find((candidate) => candidate.startDate === rowStart);
  const segment = row?.segments.find(
    (candidate) => candidate.identity === identity && candidate.date === column.date,
  );
  return segment == null ? options.source.style.gridRow : String(segment.lane + 1);
}

function renderSpanRangePreview(options: SpanPreviewRangeOptions): HTMLElement[] {
  const previews: HTMLElement[] = [];
  for (const row of new Set(options.columns.map((column) => column.row))) {
    const candidates = options.columns.filter((column) => column.row === row);
    const visible = candidates.filter(
      (column) => column.date >= options.from && column.date <= options.to,
    );
    for (const column of visible) {
      const index = candidates.indexOf(column);
      const preview = createPreview(options.source, {
        className: options.className,
        target: options.target,
        task: options.task,
        phase: column.date === options.to ? 'terminal' : 'ghost',
        subtitle: `${options.from}–${options.to}`,
      });
      preview.style.gridColumn = `${index + 1} / ${index + 2}`;
      preview.style.gridRow = previewGridRow(options, column);
      column.layer.appendChild(preview);
      previews.push(preview);
    }
  }
  return previews;
}

interface SpanDragSessionOptions {
  readonly binding: SpanInteractionBinding;
  readonly event: PointerEvent;
  readonly kind: SpanInteractionKind;
  readonly ownerWindow: Window;
  readonly columns: readonly MeasuredSpanColumn[];
  readonly sourceRowColumns: readonly MeasuredSpanColumn[];
  readonly grabbedDate: LocalDate | undefined;
  readonly isMonth: boolean;
}

interface SpanBoundaryRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly planning: TaskSnapshot['planning'];
}

function firstDefinedDate(...values: ReadonlyArray<LocalDate | undefined>): LocalDate | undefined {
  return values.find((value) => value !== undefined);
}

function spanBoundaryRange(
  binding: SpanInteractionBinding,
  target: InteractiveSpanBoundaryTarget,
): SpanBoundaryRange | undefined {
  const planning = binding.task.planning;
  const actualStart = firstDefinedDate(
    planning.start,
    planning.scheduled,
    planning.due,
    parsedDate(binding.segmentStart),
  );
  const actualDue = firstDefinedDate(
    planning.due,
    planning.scheduled,
    planning.start,
    parsedDate(binding.segmentEnd),
  );
  if (actualStart == null || actualDue == null) return undefined;
  const from = target.boundary === 'start' ? target.date : actualStart;
  const to = target.boundary === 'start' ? actualDue : target.date;
  return { from, to, planning: { ...planning, start: from, due: to } };
}

class SpanDragSession {
  private readonly binding: SpanInteractionBinding;
  private readonly kind: SpanInteractionKind;
  private readonly ownerWindow: Window;
  private readonly columns: readonly MeasuredSpanColumn[];
  private readonly sourceRowColumns: readonly MeasuredSpanColumn[];
  private readonly grabbedDate: LocalDate | undefined;
  private readonly isMonth: boolean;
  private readonly pointerId: number;
  private readonly pointerOrigin: Readonly<{ x: number; y: number }>;
  private readonly capturedElement: HTMLElement;
  private readonly originalDraggable: string | null;
  private previews: HTMLElement[] = [];
  private latest: SpanInteractionTarget | undefined;
  private renderedTargetKey: string | undefined;
  private dragStarted = false;
  private disposed = false;

  constructor(options: SpanDragSessionOptions) {
    this.binding = options.binding;
    this.kind = options.kind;
    this.ownerWindow = options.ownerWindow;
    this.columns = options.columns;
    this.sourceRowColumns = options.sourceRowColumns;
    this.grabbedDate = options.grabbedDate;
    this.isMonth = options.isMonth;
    this.pointerId = options.event.pointerId;
    this.pointerOrigin = { x: options.event.clientX, y: options.event.clientY };
    this.capturedElement = options.event.currentTarget as HTMLElement;
    this.originalDraggable = options.binding.source.getAttribute('draggable');
  }

  start(): void {
    const { owner, source } = this.binding;
    owner.begin(this.dispose);
    source.classList.toggle('is-picked-up', this.kind === 'move');
    if (this.kind !== 'move') {
      this.capturedElement.dataset['activeResize'] = 'true';
      source.setAttribute('draggable', 'false');
    }
    capture(this.capturedElement, this.pointerId);
    this.ownerWindow.addEventListener('pointermove', this.onPointerMove);
    this.ownerWindow.addEventListener('pointerup', this.onPointerUp);
    this.ownerWindow.addEventListener('pointercancel', this.onCancel);
    this.ownerWindow.addEventListener('blur', this.onCancel);
    this.capturedElement.addEventListener('lostpointercapture', this.onCancel);
  }

  private clearPreview(): void {
    for (const preview of this.previews) preview.remove();
    this.previews = [];
    this.renderedTargetKey = undefined;
  }

  private renderMovePreview(target: SpanMoveTarget): boolean {
    this.clearPreview();
    const { binding, columns } = this;
    const actualStart = binding.task.planning.start ?? localDate(binding.segmentStart);
    const actualDue = binding.task.planning.due ?? localDate(binding.segmentEnd);
    const shiftedStart = shiftLocalDate(actualStart, target.days);
    const shiftedEnd = shiftLocalDate(actualDue, target.days);
    if (shiftedStart == null || shiftedEnd == null) return false;
    const planning = { ...binding.task.planning, start: shiftedStart, due: shiftedEnd };
    this.previews = renderSpanRangePreview({
      source: binding.source,
      task: binding.task,
      columns,
      from: shiftedStart,
      to: shiftedEnd,
      className: 'abyss-span-move-preview',
      target,
      layout: binding.previewLayoutFor?.(binding.task, planning),
    });
    return this.previews.length > 0;
  }

  private renderBoundaryPreview(target: InteractiveSpanBoundaryTarget): boolean {
    this.clearPreview();
    const { binding } = this;
    const range = spanBoundaryRange(binding, target);
    if (range == null) return false;
    this.previews = renderSpanRangePreview({
      source: binding.source,
      task: binding.task,
      columns: this.isMonth ? this.columns : this.sourceRowColumns,
      from: range.from,
      to: range.to,
      className: 'abyss-span-boundary-preview',
      target,
      layout: binding.previewLayoutFor?.(binding.task, range.planning),
    });
    return this.previews.length > 0;
  }

  private resolveMove(column: MeasuredSpanColumn): Readonly<SpanMoveTarget> | undefined {
    if (this.grabbedDate == null) return undefined;
    const { task } = this.binding;
    return resolveSpanMoveTarget(
      {
        version: 1,
        task: { filePath: task.source.filePath, line: task.source.line },
        grabbedDate: this.grabbedDate,
      },
      column.date,
    );
  }

  private resolveBoundary(
    column: MeasuredSpanColumn,
    pointer: PointerEvent,
  ): Readonly<InteractiveSpanBoundaryTarget> | undefined {
    const { planning } = this.binding.task;
    const start = planning.start ?? planning.scheduled ?? planning.due;
    const due = planning.due ?? planning.scheduled ?? planning.start;
    if (start == null || due == null) return undefined;
    const target = resolveBoundaryTarget(
      { boundary: this.kind === 'start' ? 'start' : 'due', start, due },
      pointer,
      [{ date: column.date, left: column.left, right: column.right }],
    );
    if (target == null) return undefined;
    return this.kind === 'create-span'
      ? Object.freeze({ ...target, boundary: 'create-span' as const })
      : Object.freeze(target);
  }

  private resolve(pointer: PointerEvent): SpanInteractionTarget | undefined {
    const targetColumns =
      this.kind === 'move' || this.isMonth ? this.columns : this.sourceRowColumns;
    const column = columnAtPoint(pointer, targetColumns, !this.isMonth);
    if (column == null) return undefined;
    return this.kind === 'move' ? this.resolveMove(column) : this.resolveBoundary(column, pointer);
  }

  private update(pointer: PointerEvent): void {
    if (this.disposed || pointer.pointerId !== this.pointerId) return;
    this.latest = this.resolve(pointer);
    if (this.latest == null) {
      if (this.renderedTargetKey !== undefined) this.clearPreview();
      return;
    }
    const targetKey = semanticTargetKey(this.kind, this.latest);
    if (targetKey === this.renderedTargetKey) return;
    const built =
      'grabbedDate' in this.latest
        ? this.renderMovePreview(this.latest)
        : this.renderBoundaryPreview(this.latest);
    if (built) this.renderedTargetKey = targetKey;
  }

  private readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    const { owner, source } = this.binding;
    this.clearPreview();
    source.classList.remove('is-picked-up');
    delete source.dataset['activeResize'];
    delete this.capturedElement.dataset['activeResize'];
    if (this.kind !== 'move') {
      if (this.originalDraggable === null) source.removeAttribute('draggable');
      else source.setAttribute('draggable', this.originalDraggable);
    }
    this.ownerWindow.removeEventListener('pointermove', this.onPointerMove);
    this.ownerWindow.removeEventListener('pointerup', this.onPointerUp);
    this.ownerWindow.removeEventListener('pointercancel', this.onCancel);
    this.ownerWindow.removeEventListener('blur', this.onCancel);
    this.capturedElement.removeEventListener('lostpointercapture', this.onCancel);
    release(this.capturedElement, this.pointerId);
    owner.end(this.dispose);
  };

  private pointerMovedPastThreshold(pointer: PointerEvent): boolean {
    const x = pointer.clientX - this.pointerOrigin.x;
    const y = pointer.clientY - this.pointerOrigin.y;
    return Math.hypot(x, y) >= POINTER_DRAG_THRESHOLD_PX;
  }

  private readonly onPointerMove = (pointer: PointerEvent): void => {
    pointer.preventDefault();
    if (!this.dragStarted && !this.pointerMovedPastThreshold(pointer)) return;
    this.dragStarted = true;
    this.update(pointer);
  };

  private readonly onPointerUp = (pointer: PointerEvent): void => {
    if (pointer.pointerId !== this.pointerId) return;
    this.dragStarted ||= this.pointerMovedPastThreshold(pointer);
    if (this.dragStarted) this.update(pointer);
    const target = this.latest;
    this.dispose();
    if (target == null) return;
    if ('grabbedDate' in target) this.binding.onMove(this.binding.task, target);
    else this.binding.onBoundary(this.binding.task, target);
  };

  private readonly onCancel = (): void => {
    this.dispose();
  };
}

function eventStartsMoveFromControl(event: PointerEvent): boolean {
  return (event.target as Element).closest('.abyss-status-marker, a, [data-boundary]') != null;
}

function startSpanSession(
  binding: SpanInteractionBinding,
  ownerWindow: Window,
  event: PointerEvent,
  kind: SpanInteractionKind,
): void {
  if (event.button !== 0 || (kind === 'move' && eventStartsMoveFromControl(event))) return;
  event.preventDefault();
  event.stopPropagation();
  binding.owner.disposeActive();
  const columns = measuredColumns(binding.source);
  const sourceDate = parsedDate(binding.segmentStart);
  const sourceColumn = columns.find((column) => column.date === sourceDate);
  if (sourceColumn == null) return;
  const sourceRowColumns = rowColumns(sourceColumn, columns);
  const grabbedDate =
    kind === 'move'
      ? resolveGrabbedDate(
          event.clientX,
          sourceRowColumns.map(({ date, left, right }) => ({ date, left, right })),
        )
      : undefined;
  if (kind === 'move' && grabbedDate == null) return;
  new SpanDragSession({
    binding,
    event,
    kind,
    ownerWindow,
    columns,
    sourceRowColumns,
    grabbedDate,
    isMonth: binding.source.closest('.abyss-mg-grid') !== null,
  }).start();
}

export function attachSpanInteractions(binding: SpanInteractionBinding): void {
  const { source } = binding;
  const ownerWindow = source.ownerDocument.defaultView;
  if (ownerWindow == null) return;

  if (binding.enableMove !== false) {
    source.addEventListener('pointerdown', (event) => {
      startSpanSession(binding, ownerWindow, event, 'move');
    });
  }
  for (const handle of binding.boundaryHandles) {
    handle.element.dataset['resizeEdge'] = handle.boundary === 'start' ? 'start-date' : 'due-date';
    handle.element.setAttribute('draggable', 'false');
    handle.element.addEventListener('pointerdown', (event) => {
      startSpanSession(binding, ownerWindow, event, handle.boundary);
    });
  }
}
