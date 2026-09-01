import type { ProjectDateValue } from '../types';
import type { MilestoneRollup } from './rollups';
import type { WorkNoteSnapshot } from './types';

type MilestoneDateProjection =
  | { readonly type: 'point'; readonly value: ProjectDateValue }
  | {
      readonly type: 'range';
      readonly start: ProjectDateValue;
      readonly end: ProjectDateValue;
    };

type MilestonePlainState =
  | { readonly type: 'ready' }
  | { readonly type: 'undated'; readonly label: 'No date set' }
  | { readonly type: 'invalid'; readonly label: 'Date needs attention' };

export interface MilestoneProjection {
  readonly note: WorkNoteSnapshot;
  readonly path: string;
  readonly title: string;
  readonly projectPath: string;
  readonly statusId: string | null;
  readonly date?: MilestoneDateProjection;
  readonly state: MilestonePlainState;
  readonly progress: number | null;
  readonly active: number;
  readonly completed: number;
  readonly dropped: number;
  readonly group?: string;
}

export interface MilestoneSelection {
  readonly query?: string;
  readonly projectPaths?: readonly string[];
  readonly statusIds?: readonly string[];
  readonly groupBy?: 'none' | 'project' | 'status' | 'date-state';
  readonly sortBy?: 'title' | 'date' | 'status' | 'progress';
  readonly direction?: 'asc' | 'desc';
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/u, '');
}

export function buildMilestoneProjection(
  note: WorkNoteSnapshot,
  rollup?: MilestoneRollup,
): MilestoneProjection {
  const valid = note.range.issue === undefined;
  let date: MilestoneDateProjection | undefined;
  if (valid && note.range.start && note.range.end) {
    date = { type: 'range', start: note.range.start, end: note.range.end };
  } else if (valid && note.range.start) {
    date = { type: 'point', value: note.range.start };
  } else if (valid && note.range.end) {
    date = { type: 'point', value: note.range.end };
  }
  let state: MilestonePlainState = { type: 'undated', label: 'No date set' };
  if (!valid) state = { type: 'invalid', label: 'Date needs attention' };
  else if (date) state = { type: 'ready' };
  return {
    note,
    path: note.path,
    title: basename(note.path),
    projectPath: note.projectPath,
    statusId: note.statusId,
    ...(date && { date }),
    state,
    progress: rollup?.progress ?? null,
    active: rollup?.active ?? 0,
    completed: rollup?.completed ?? 0,
    dropped: rollup?.dropped ?? 0,
  };
}

function groupOf(
  projection: MilestoneProjection,
  groupBy: NonNullable<MilestoneSelection['groupBy']>,
): string | undefined {
  if (groupBy === 'project') return projection.projectPath;
  if (groupBy === 'status') return projection.statusId ?? 'No status';
  if (groupBy === 'date-state') return projection.state.type;
  return undefined;
}

function sortValue(
  projection: MilestoneProjection,
  sortBy: NonNullable<MilestoneSelection['sortBy']>,
): string {
  if (sortBy === 'date') {
    if (projection.date?.type === 'point') return projection.date.value.raw;
    return projection.date?.start.raw ?? '\uffff';
  }
  if (sortBy === 'status') return projection.statusId ?? '\uffff';
  if (sortBy === 'progress') return (projection.progress ?? -1).toFixed(6);
  return projection.title;
}

export function selectMilestoneProjections(
  projections: readonly MilestoneProjection[],
  selection: MilestoneSelection = {},
): readonly MilestoneProjection[] {
  const query = selection.query?.trim().toLocaleLowerCase();
  const projectPaths = new Set(selection.projectPaths ?? []);
  const statusIds = new Set(selection.statusIds ?? []);
  const groupBy = selection.groupBy ?? 'none';
  const sortBy = selection.sortBy ?? 'date';
  const direction = selection.direction === 'desc' ? -1 : 1;
  return projections
    .filter(
      (projection) =>
        (!query ||
          [projection.title, projection.path, projection.projectPath, projection.statusId].some(
            (value) => value?.toLocaleLowerCase().includes(query),
          )) &&
        (projectPaths.size === 0 || projectPaths.has(projection.projectPath)) &&
        (statusIds.size === 0 ||
          (projection.statusId !== null && statusIds.has(projection.statusId))),
    )
    .map((projection) => {
      const group = groupOf(projection, groupBy);
      return group === undefined ? projection : { ...projection, group };
    })
    .sort((left, right) => {
      const group = (left.group ?? '').localeCompare(right.group ?? '');
      if (group) return group;
      const leftValue = sortValue(left, sortBy);
      const rightValue = sortValue(right, sortBy);
      const sorted =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
      return (
        direction * sorted ||
        left.title.localeCompare(right.title) ||
        left.path.localeCompare(right.path)
      );
    });
}
