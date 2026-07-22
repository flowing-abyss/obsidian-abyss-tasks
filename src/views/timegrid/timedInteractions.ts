import type { TaskSnapshot } from '../../tasks';
import {
  resolveBoundaryTarget,
  resolveTimedDragTarget,
  resolveTimedDurationTarget,
  type DragDateColumn,
  type SpanBoundaryTarget,
  type TimedDragColumn,
  type TimedDragTarget,
  type TimedDurationTarget,
} from './dragGeometry';
import { MIN_BLOCK_HEIGHT_PX, minutesToPixels } from './layout';

export type TimedBoundaryTarget =
  | SpanBoundaryTarget
  | {
      readonly boundary: 'create-span';
      readonly date: SpanBoundaryTarget['date'];
      readonly dayDelta: number;
    };

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
  readonly durationHandle: HTMLElement;
  readonly boundaryHandles: readonly {
    readonly element: HTMLElement;
    readonly boundary: 'start' | 'due' | 'create-span';
  }[];
  readonly task: TaskSnapshot;
  readonly segmentDate: string;
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly owner: TimedInteractionOwner;
  readonly onMove: (task: TaskSnapshot, target: TimedDragTarget) => void;
  readonly onDuration: (task: TaskSnapshot, target: TimedDurationTarget) => void;
  readonly onBoundary: (task: TaskSnapshot, target: TimedBoundaryTarget) => void;
}

interface MeasuredColumn {
  readonly date: string;
  readonly day: HTMLElement;
  readonly hour: HTMLElement;
  readonly allDay?: HTMLElement;
  readonly drag: TimedDragColumn;
  readonly boundary: DragDateColumn;
}

function measuredColumns(source: HTMLElement): MeasuredColumn[] {
  const root = source.closest<HTMLElement>('.tc-tg-root');
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('.tc-tg-day-column[data-tg-date]')).flatMap(
    (day) => {
      const date = day.dataset['tgDate'];
      const hour = day.querySelector<HTMLElement>('.tc-tg-hour-column');
      if (!date || !hour) return [];
      const dayRect = day.getBoundingClientRect();
      const hourRect = hour.getBoundingClientRect();
      const allDay = root.querySelector<HTMLElement>(`.tc-tg-allday-cell[data-tg-date="${date}"]`);
      const allDayRect = allDay?.getBoundingClientRect();
      const drag: TimedDragColumn = {
        date: date as TimedDragColumn['date'],
        left: dayRect.left,
        right: dayRect.right,
        timeGridTop: hourRect.top,
        timeGridBottom: hourRect.bottom,
        ...(allDayRect && allDayRect.bottom > allDayRect.top
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
    },
  );
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze({ ...value });
}

function previewElement(
  source: HTMLElement,
  target: object,
  className: 'tc-tg-drag-preview' | 'tc-tg-boundary-preview',
  copyLaneGeometry = true,
): HTMLElement {
  const preview = source.ownerDocument.createElement('div');
  preview.className = className;
  preview.dataset['target'] = JSON.stringify(target);
  if (copyLaneGeometry) {
    preview.style.left = source.style.left;
    preview.style.width = source.style.width;
  }
  const tagColor = source.style.getPropertyValue('--tc-tag-color');
  if (tagColor) preview.style.setProperty('--tc-tag-color', tagColor);
  return preview;
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

export function attachTimedInteractions(binding: TimedInteractionBinding): void {
  const {
    source,
    durationHandle,
    boundaryHandles,
    task,
    segmentDate,
    startMinutes,
    durationMinutes,
    owner,
  } = binding;
  const ownerDocument = source.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return;

  const startSession = (
    event: PointerEvent,
    kind: 'move' | 'duration' | 'start' | 'due' | 'create-span',
  ): void => {
    if (event.button !== 0) return;
    if (
      kind === 'move' &&
      (event.target as HTMLElement).closest(
        '.tc-status-marker, a, .tc-tg-resize-handle, .tc-tg-span-edge',
      )
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (kind === 'move') source.focus();

    const columns = measuredColumns(source);
    const originColumn = columns.find((column) => column.date === segmentDate);
    if (!originColumn) return;
    const pointerId = event.pointerId;
    const capturedElement = event.currentTarget as HTMLElement;
    const sourceRect = source.getBoundingClientRect();
    const pixelsPerMinute =
      (originColumn.drag.timeGridBottom - originColumn.drag.timeGridTop) / (24 * 60);
    const grabOffsetMinutes = Math.min(
      durationMinutes,
      Math.max(0, (event.clientY - sourceRect.top) / pixelsPerMinute),
    );
    let preview: HTMLElement | undefined;
    let latest:
      | Readonly<TimedDragTarget>
      | Readonly<TimedDurationTarget>
      | Readonly<TimedBoundaryTarget>
      | undefined;
    let disposed = false;

    const clearPreview = (): void => {
      preview?.remove();
      preview = undefined;
    };

    const renderMovePreview = (target: Readonly<TimedDragTarget>): void => {
      clearPreview();
      const column = columns.find((candidate) => candidate.date === target.date);
      const host = target.destination === 'all-day' ? column?.allDay : column?.hour;
      if (!host) return;
      preview = previewElement(
        source,
        target,
        'tc-tg-drag-preview',
        target.destination === 'time-grid',
      );
      if (target.destination === 'time-grid') {
        preview.style.top = `${minutesToPixels(target.startMinutes)}px`;
        preview.style.height = `${sourceRect.height}px`;
      } else {
        preview.classList.add('is-all-day');
      }
      host.appendChild(preview);
    };

    const renderDurationPreview = (target: Readonly<TimedDurationTarget>): void => {
      clearPreview();
      preview = previewElement(source, target, 'tc-tg-drag-preview');
      preview.style.top = source.style.top;
      preview.style.height = `${Math.max(
        minutesToPixels(target.durationMinutes),
        minimumPreviewHeight(source),
      )}px`;
      originColumn.hour.appendChild(preview);
    };

    const renderBoundaryPreview = (target: Readonly<TimedBoundaryTarget>): void => {
      clearPreview();
      const column = columns.find((candidate) => candidate.date === target.date);
      if (!column) return;
      preview = previewElement(source, target, 'tc-tg-boundary-preview');
      preview.style.top = source.style.top;
      preview.style.height = `${sourceRect.height}px`;
      column.hour.appendChild(preview);
    };

    const resolve = (pointer: PointerEvent): typeof latest => {
      if (kind === 'move') {
        const target = resolveTimedDragTarget(
          {
            date: segmentDate as TimedDragColumn['date'],
            startMinutes,
            durationMinutes,
            grabOffsetMinutes,
          },
          pointer,
          columns.map((column) => column.drag),
        );
        return target ? frozen(target) : undefined;
      }
      if (kind === 'duration') {
        const target = resolveTimedDurationTarget(
          {
            startMinutes,
            durationMinutes,
            grabClientY: event.clientY,
            pixelsPerMinute,
          },
          pointer,
        );
        return target ? frozen(target) : undefined;
      }
      const start = task.planning.start ?? task.planning.scheduled ?? task.planning.due;
      const due = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
      if (!start || !due) return undefined;
      const geometryBoundary = kind === 'start' ? 'start' : 'due';
      const target = resolveBoundaryTarget(
        {
          boundary: geometryBoundary,
          start,
          due,
        },
        pointer,
        columns.map((column) => column.boundary),
      );
      if (!target) return undefined;
      return kind === 'create-span'
        ? frozen({ boundary: 'create-span' as const, date: target.date, dayDelta: target.dayDelta })
        : frozen(target);
    };

    const update = (pointer: PointerEvent): void => {
      if (disposed || pointer.pointerId !== pointerId) return;
      const target = resolve(pointer);
      latest = target;
      if (!target) {
        clearPreview();
        return;
      }
      if (kind === 'move') renderMovePreview(target as Readonly<TimedDragTarget>);
      else if (kind === 'duration') {
        renderDurationPreview(target as Readonly<TimedDurationTarget>);
      } else {
        renderBoundaryPreview(target as Readonly<TimedBoundaryTarget>);
      }
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      clearPreview();
      source.classList.remove('is-picked-up');
      source.classList.remove('is-edge-resizing');
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
      const committed = latest;
      dispose();
      if (!committed) return;
      if (kind === 'move') binding.onMove(task, committed as TimedDragTarget);
      else if (kind === 'duration') {
        binding.onDuration(task, committed as TimedDurationTarget);
      } else {
        binding.onBoundary(task, committed as TimedBoundaryTarget);
      }
    };
    const onCancel = (): void => dispose();

    owner.begin(dispose);
    source.classList.toggle('is-picked-up', kind === 'move');
    source.classList.toggle('is-edge-resizing', kind !== 'move' && kind !== 'duration');
    capture(capturedElement, pointerId);
    ownerWindow.addEventListener('pointermove', onPointerMove);
    ownerWindow.addEventListener('pointerup', onPointerUp);
    ownerWindow.addEventListener('pointercancel', onCancel);
    ownerWindow.addEventListener('blur', onCancel);
    capturedElement.addEventListener('lostpointercapture', onCancel);
  };

  source.addEventListener('pointerdown', (event) => startSession(event, 'move'));
  durationHandle.addEventListener('pointerdown', (event) => startSession(event, 'duration'));
  for (const handle of boundaryHandles) {
    handle.element.addEventListener('pointerdown', (event) => startSession(event, handle.boundary));
  }
}
