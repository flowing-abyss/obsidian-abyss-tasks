import type { StatisticsViewId, StatisticsViewModel } from '../../statistics';
import { openAnchoredPopover, type AnchoredPopover } from '../../ui/anchoredPopover';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';

const HELP: Record<StatisticsViewId, readonly string[]> = {
  rhythm: [
    'Created tasks rise above zero. Completed and cancelled tasks fall below it. Each column covers one interval.',
    'Below, see the current status of new tasks and the age of open tasks. Tasks and subtasks count separately, using saved dates.',
  ],
  completion: [
    'Calendar days from creation to completion for non-recurring tasks completed in this period. Both dates must be available.',
    'Half finished within the median. 90% finished within the other value. This is elapsed time, not hours of work.',
  ],
  deadlines: [
    'Tasks due in this period, split by whether they finished on time, finished late or remain open.',
    'Below, see how early or late tasks completed in this period were. Both charts use the due dates saved now.',
  ],
  cohorts: [
    'Each row groups tasks created in one week. Cells show the share completed within each number of days after creation.',
    'Open and cancelled tasks stay in the total. Recurring tasks are excluded. Three dots mean more time must pass; a question mark means completion times are unknown.',
    'Select a cell to inspect the whole group, including unfinished tasks.',
  ],
  allocation: [
    'Recorded time by project, tag or priority, clipped to the selected period. Tasks with several tags appear under each tag.',
    'Below, see how much time went to a small share of tasks. The task total includes tasks with no recorded time.',
  ],
  timeline: [
    'Recorded sessions across a week. Busy weeks use hourly totals; overlapping recordings add together.',
    'Empty space means no time was recorded. Clock labels follow local time; durations use actual elapsed time, including clock changes.',
  ],
  sessions: [
    'Full lengths of finished sessions that started in this period. Running sessions are excluded.',
    'Task changes count different tasks recorded within five minutes of each other. Gaps over five minutes, overlaps and recordings outside your filters break the sequence. This does not measure interruptions.',
  ],
  patterns: [
    'Recorded minutes divided by elapsed calendar hours in each weekday and hour, including hours with no recording.',
    'Overlapping sessions add together. Stronger color means more recorded time, not greater productivity.',
  ],
  movement: [
    'Tasks created, completed and cancelled in each project, added up from zero for this period. Projects share one scale.',
    'Below, see whether completed tasks were new or older work. This uses current project membership and status. Missing dates are excluded.',
  ],
  aging: [
    'Current open tasks by days since creation and all time recorded directly on them. Older tasks sit farther right; more recorded time puts them higher.',
    'Marks can contain several tasks. Color or outlines show overdue tasks. Age does not tell you when a task was last worked on.',
  ],
  dependencies: [
    'Which unfinished tasks others are waiting for. Select one to follow its dependent tasks.',
    'Counts can overlap. Prerequisites outside your filters stay visible as context. This uses current links between live tasks; missing or duplicate IDs cannot be resolved.',
  ],
};

/** Short help for the accepted view, owned by the panel's existing popover lifetime. */
export class StatisticsDetails {
  private popover_abyssPrivate: AnchoredPopover | undefined;
  constructor(private readonly ownership_abyssPrivate?: InteractionOwnershipPort) {}
  open(owner: HTMLElement, anchor: HTMLElement, model: StatisticsViewModel): void {
    if (this.popover_abyssPrivate !== undefined) {
      this.close();
      return;
    }
    const popover = openAnchoredPopover({
      owner,
      anchor,
      boundary: owner,
      preferred: 'below-end',
      cls: 'abyss-statistics-details',
      ownership: this.ownership_abyssPrivate,
      attr: { role: 'dialog', 'aria-label': `About ${model.title}` },
      onClose: (restore) => {
        this.popover_abyssPrivate = undefined;
        if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
      },
    });
    this.popover_abyssPrivate = popover;
    const element = popover.element;
    element.createEl('h3', { text: `About ${model.title}` });
    for (const paragraph of HELP[model.view]) element.createEl('p', { text: paragraph });
    popover.reposition();
  }
  close(): void {
    this.popover_abyssPrivate?.close();
  }
}
