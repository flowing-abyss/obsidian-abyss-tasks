import type { TrackedTotal } from '../tasks';

export interface ProjectStats {
  total: number;
  done: number;
  cancelled: number;
  inProgress: number;
  /** Time the note's own entries record, kept as closed time plus the starts still running. */
  readonly tracked: TrackedTotal;
}

export interface Project {
  path: string;
  name: string;
  frontmatter: Record<string, unknown>;
  tags: string[]; // '#'-prefixed, lower-cased
  statusId: string | null;
  rawStatus: string | null;
  stats: ProjectStats;
}
