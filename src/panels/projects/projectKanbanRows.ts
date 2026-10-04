import type { RowViewport, RowViewportRow } from '../virtualization/rowViewport';

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
