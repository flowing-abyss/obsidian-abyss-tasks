import type { TaskSnapshot } from '../../tasks';
import type { CalendarEditQueue } from '../../ui/calendarEditQueue';
import { presentTaskCommandResult } from '../../ui/taskCommandResult';
import {
  calendarOccurrenceForRender,
  type CalendarPlanningOverride,
} from '../../views/calendarOccurrences';
import {
  timedEditCommand,
  timedEditPlanning,
  type TimedCalendarEdit,
} from '../../views/timegrid/timedEditPlanning';

/** Keeps speculative planning separate from the immutable command source. */
export class CalendarPointerEdits {
  private readonly pending_abyssPrivate = new Set<CalendarPlanningOverride>();

  constructor(private readonly queue_abyssPrivate: CalendarEditQueue) {}

  pending(): readonly CalendarPlanningOverride[] {
    return [...this.pending_abyssPrivate];
  }
  retire(): void {
    this.pending_abyssPrivate.clear();
  }

  submit(
    task: TaskSnapshot,
    edit: TimedCalendarEdit,
    publish: (phase: 'submitted' | 'settled') => void,
  ): Promise<void> {
    const planning = timedEditPlanning(task, edit);
    if (planning === undefined) return Promise.resolve();
    const occurrence = calendarOccurrenceForRender(task);
    const source = occurrence.source;
    const entry = {
      source,
      planning:
        occurrence.kind === 'forecast'
          ? {
              ...source.node.planning,
              ...(planning.time !== undefined && { time: planning.time }),
              ...(planning.duration !== undefined && { duration: planning.duration }),
            }
          : planning,
    };
    this.pending_abyssPrivate.add(entry);
    const completion = this.queue_abyssPrivate.execute(task, (current) => {
      return timedEditCommand(current, edit, task);
    });
    publish('submitted');
    return completion
      .then((receipt) => {
        if (receipt !== undefined) presentTaskCommandResult(receipt.result);
      })
      .finally(() => {
        this.pending_abyssPrivate.delete(entry);
        publish('settled');
      });
  }
}
