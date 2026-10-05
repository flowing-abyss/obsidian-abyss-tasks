import type { RowViewport, RowViewportRow } from '../virtualization/rowViewport';
import type { ProjectKanbanDropPlan } from './projectKanbanDrop';

export interface KanbanViewportRow extends RowViewportRow {
  readonly kind: 'group' | 'card';
  readonly groupKey: string;
  readonly projectPath?: string;
}
export interface KanbanInsertion {
  readonly groupKey: string;
  readonly beforePath?: string;
  readonly top: number;
}
export function kanbanInsertion(
  rows: readonly KanbanViewportRow[],
  viewport: RowViewport,
  contentY: number,
  sourcePath: string,
): KanbanInsertion | undefined {
  if (!Number.isFinite(contentY) || rows.length === 0) return undefined;
  const last = rows[rows.length - 1];
  if (last === undefined) return undefined;
  const bounds = viewport.rowAt(Math.max(0, contentY)) ?? viewport.rowBounds(last.key);
  if (bounds === undefined) return undefined;
  const row = rows[bounds.index];
  if (row === undefined) return undefined;
  const after = row.kind === 'group' || contentY >= (bounds.top + bounds.bottom) / 2;
  return neighborInsertion(rows, viewport, {
    groupKey: row.groupKey,
    start: bounds.index + (after ? 1 : 0),
    top: after ? bounds.bottom : bounds.top,
    sourcePath,
  });
}

function neighborInsertion(
  rows: readonly KanbanViewportRow[],
  viewport: RowViewport,
  insertion: { groupKey: string; start: number; top: number; sourcePath: string },
): KanbanInsertion {
  const { groupKey, start, top: initialTop, sourcePath } = insertion;
  let top = initialTop;
  for (let index = start; index < rows.length; index++) {
    const candidate = rows[index];
    if (candidate?.groupKey !== groupKey) break;
    const bounds = viewport.rowBounds(candidate.key);
    if (candidate.projectPath !== undefined && candidate.projectPath !== sourcePath) {
      return { groupKey, beforePath: candidate.projectPath, top: bounds?.top ?? top };
    }
    top = bounds?.bottom ?? top;
  }
  return { groupKey, top };
}

type PlannedInsertion = Extract<ProjectKanbanDropPlan, { allowed: true }>['insertion'];

function insertionPath(insertion: PlannedInsertion, proposedPath: string): string {
  if (insertion.kind === 'before') return insertion.beforePath;
  if (insertion.kind === 'after') return insertion.afterPath;
  return proposedPath;
}
function newGroupInsertionTop(
  rows: readonly KanbanViewportRow[],
  viewport: RowViewport,
  beforeGroupKey: string | undefined,
): number | undefined {
  const before = rows.find((row) => row.kind === 'group' && row.groupKey === beforeGroupKey);
  if (before !== undefined) return viewport.rowBounds(before.key)?.top;
  const last = rows[rows.length - 1];
  return last === undefined ? 0 : viewport.rowBounds(last.key)?.bottom;
}

/** Resolve the planner's landing over all rows, including neighbors outside the native window. */
export function kanbanPlanInsertionTop(
  rows: readonly KanbanViewportRow[],
  viewport: RowViewport,
  insertion: PlannedInsertion,
  proposedPath: string,
): number | undefined {
  if (insertion.kind === 'none') return undefined;
  const groupRows = rows.filter((row) => row.groupKey === insertion.groupKey);
  const path = insertionPath(insertion, proposedPath);
  const card = groupRows.find((row) => row.kind === 'card' && row.projectPath === path);
  if (card !== undefined) {
    const bounds = viewport.rowBounds(card.key);
    return insertion.kind === 'after' ? bounds?.bottom : bounds?.top;
  }
  const header = groupRows.find((row) => row.kind === 'group');
  if (header !== undefined && !groupRows.some((row) => row.kind === 'card'))
    return viewport.rowBounds(header.key)?.bottom;
  return insertion.kind === 'empty'
    ? newGroupInsertionTop(rows, viewport, insertion.beforeGroupKey)
    : undefined;
}
