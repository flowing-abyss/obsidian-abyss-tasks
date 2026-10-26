import type {
  ProjectTimelineRange,
  ProjectTimelineWindow,
} from '../../projects/projectTimelineModel';

/** Contextual date boundaries decorate the existing axis and mounted task tracks. */
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
