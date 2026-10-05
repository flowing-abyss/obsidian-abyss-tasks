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

export type PlannedKanbanInsertion = Extract<ProjectKanbanDropPlan, { allowed: true }>['insertion'];

interface IndexedKanbanGroup {
  readonly firstKey: string;
  headerKey?: string;
  readonly cards: Map<string, string>;
}

/** Projection-time keys keep repeated landing lookups independent of column population. */
export class KanbanRowIndex {
  readonly #groups = new Map<string, IndexedKanbanGroup>();
  readonly #lastKey: string | undefined;

  constructor(rows: readonly KanbanViewportRow[]) {
    this.#lastKey = rows[rows.length - 1]?.key;
    for (const row of rows) {
      let group = this.#groups.get(row.groupKey);
      if (group === undefined) {
        group = { firstKey: row.key, cards: new Map() };
        this.#groups.set(row.groupKey, group);
      }
      if (row.kind === 'group' && group.headerKey === undefined) group.headerKey = row.key;
      if (row.kind === 'card' && row.projectPath !== undefined && !group.cards.has(row.projectPath))
        group.cards.set(row.projectPath, row.key);
    }
  }

  insertionTop(
    viewport: RowViewport,
    insertion: PlannedKanbanInsertion,
    proposedPath: string,
  ): number | undefined {
    if (insertion.kind === 'none') return undefined;
    const group = this.#groups.get(insertion.groupKey);
    const key = group?.cards.get(insertionPath(insertion, proposedPath));
    if (key !== undefined) {
      const bounds = viewport.rowBounds(key);
      return insertion.kind === 'after' ? bounds?.bottom : bounds?.top;
    }
    return this.#groupBoundary(viewport, group, insertion);
  }

  #groupBoundary(
    viewport: RowViewport,
    group: IndexedKanbanGroup | undefined,
    insertion: PlannedKanbanInsertion,
  ): number | undefined {
    if (group?.headerKey !== undefined && group.cards.size === 0)
      return viewport.rowBounds(group.headerKey)?.bottom;
    return insertion.kind === 'empty'
      ? this.#newGroupTop(viewport, insertion.beforeGroupKey)
      : undefined;
  }

  #newGroupTop(viewport: RowViewport, beforeGroupKey: string | undefined): number | undefined {
    const before = beforeGroupKey === undefined ? undefined : this.#groups.get(beforeGroupKey);
    if (before !== undefined) return viewport.rowBounds(before.headerKey ?? before.firstKey)?.top;
    return this.#lastKey === undefined ? 0 : viewport.rowBounds(this.#lastKey)?.bottom;
  }
}
function insertionPath(insertion: PlannedKanbanInsertion, proposedPath: string): string {
  if (insertion.kind === 'before') return insertion.beforePath;
  if (insertion.kind === 'after') return insertion.afterPath;
  return proposedPath;
}
