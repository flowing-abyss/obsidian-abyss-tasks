import type { ProjectTimelineAxisLayout } from '../../projects/projectTimelineAxis';
import type {
  ProjectTimelineRange,
  ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';

/** An owning surface may add one contextual range without joining the task population. */
export interface TimelineContextRow {
  range(): ProjectTimelineRange;
  update(window: ProjectTimelineWindow, axis: ProjectTimelineAxisLayout): void;
  cancel(): void;
  destroy(): void;
}
export interface TimelineContextRowLayout {
  readonly scroll: HTMLElement;
  window(): ProjectTimelineWindow;
  now(): Date;
  revealDay(day: string): void;
}
