import type {
  ProjectTimelineRange,
  ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';

/** Decorates the shared date axis and mounted task tracks without adding a row. */
export interface TimelineContextOverlay {
  range(): ProjectTimelineRange;
  update(window: ProjectTimelineWindow): void;
  mountTrack(track: HTMLElement): () => void;
  cancel(): void;
  destroy(): void;
}
export interface TimelineContextOverlayLayout {
  readonly scroll: HTMLElement;
  window(): ProjectTimelineWindow;
  now(): Date;
  revealDay(day: string): void;
}
