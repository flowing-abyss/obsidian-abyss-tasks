import type { AppState, TaskNodeDragPayload } from '../../app/AppState';
import type { TaskSnapshot } from '../../tasks';
import { startTaskNodeDrag } from '../../ui/taskNodeDrag';
import { calendarNativeDragPayload } from '../../views/calendarNativeDrag';

/** Retains rendered planning only while its exact AppState drag authority remains registered. */
export class CalendarNativeDragContext {
  private active_abyssPrivate:
    { readonly task: TaskSnapshot; readonly payload: TaskNodeDragPayload } | undefined;

  constructor(
    private readonly state_abyssPrivate: AppState,
    private readonly container_abyssPrivate: HTMLElement,
  ) {}

  start(task: TaskSnapshot, source: HTMLElement): string | undefined {
    const payload = calendarNativeDragPayload(task);
    if (payload?.source !== 'center-card' || payload.calendar === undefined) return undefined;
    startTaskNodeDrag(this.state_abyssPrivate, this.container_abyssPrivate, source, {
      payload,
      onEnd: () => {
        this.active_abyssPrivate = undefined;
        source.removeClass('is-dragging');
      },
    });
    const registered = this.state_abyssPrivate.get('draggingTaskNode');
    if (registered === null) return undefined;
    this.active_abyssPrivate = { task, payload: registered };
    return payload.calendar.nativePayload;
  }

  capture(serialized: string): TaskSnapshot | undefined {
    const active = this.active_abyssPrivate;
    if (active === undefined) return undefined;
    if (active.payload !== this.state_abyssPrivate.get('draggingTaskNode')) return undefined;
    const payload = active.payload;
    return payload.source === 'center-card' && payload.calendar?.nativePayload === serialized
      ? active.task
      : undefined;
  }
}
