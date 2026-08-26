export interface ProjectDateValue {
  readonly raw: string;
  readonly precision: 'date' | 'datetime';
  readonly instantMs: number;
  readonly offsetMinutes?: number;
}

export interface ProjectRange {
  readonly start?: ProjectDateValue;
  readonly end?: ProjectDateValue;
  readonly issue?: 'invalid-start' | 'invalid-end' | 'reversed';
}

export interface TaskRollup {
  readonly total: number;
  readonly done: number;
  readonly cancelled: number;
  readonly inProgress: number;
  readonly open: number;
  readonly progress: number | null;
}

export type ProjectStats = TaskRollup;

export interface Project {
  path: string;
  name: string;
  frontmatter: Record<string, unknown>;
  tags: string[]; // '#'-prefixed, lower-cased
  statusId: string | null;
  rawStatus: string | null;
  range: ProjectRange;
  stats: ProjectStats;
}
