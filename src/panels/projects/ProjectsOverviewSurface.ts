import type { Component } from 'obsidian';
import type { OwnedInferredPropertyClear } from '../../projects/projectEdits';
import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import type { StatusGroup } from '../../projects/status';
import type { Project } from '../../projects/types';
import type { ProjectOverviewCell, ProjectOverviewCells } from './projectOverviewCells';
import type { ProjectTableSelectableCell } from './projectTableSelection';

/** What a render reports: the toolbar's status chips and the footer's project count. */
interface ProjectOverviewRenderSummary {
  readonly availableStatusGroups: readonly StatusGroup[];
  readonly uniqueVisibleCount: number;
}

/**
 * The controller's part of a surface render: `publish` updates the toolbar and the count, and
 * `settleSelection` reconciles the view's selection with `cells().identities`, then patches it.
 */
export interface ProjectOverviewRenderHooks {
  publish(summary: ProjectOverviewRenderSummary): void;
  settleSelection(): void;
}

/** Where a cell editor opens: the element it stays inside and the header it stays below. */
export interface ProjectOverviewEditorFrame {
  readonly boundary: HTMLElement;
  readonly stickyHeader?: HTMLElement;
}

/** A mounted cell as the controller reads it; Timeline identities carry no group key. */
interface ProjectOverviewSurfaceCell {
  readonly element: HTMLElement;
  readonly identity: { readonly occurrenceId: string; readonly columnId: string };
}

/**
 * One projects overview view as the controller drives it. `cells()` lists every selectable cell
 * in display order, and `renderedCells()` the mounted ones, a subset of `cells()` in the same
 * order; `revealCell` mounts a listed cell before the controller focuses it.
 */
export interface ProjectsOverviewSurface<TCell extends ProjectOverviewSurfaceCell> {
  readonly scroll: HTMLElement;
  show(): void;
  hide(): void;
  render(projects: readonly Project[], search: string, hooks: ProjectOverviewRenderHooks): void;
  cells(): ProjectOverviewCells;
  renderedCells(): readonly TCell[];
  revealCell(identity: ProjectTableSelectableCell): void;
  scrollCellIntoView(cell: TCell, purpose?: 'cell' | 'created-project'): void;
  editorFrame(cell: TCell | undefined): ProjectOverviewEditorFrame;
  revealProject(path: string): void;
  occurrenceElement(cell: TCell): HTMLElement;
  syncSelectedProjectPath(path: string | undefined): void;
  captureViewportBeforeHide(): void;
  destroy(): void;
}

/** A mounted cell: the logical cell it renders, which each render updates, and its element. */
export interface RenderedCellContext extends ProjectOverviewCell {
  identity: ProjectTableSelectableCell;
  project: Project;
  field: ProjectFieldCatalogItem;
  ownedClear: OwnedInferredPropertyClear | undefined;
  readonly element: HTMLElement;
  readonly markdown?: Component;
  contentSignature: string;
}

/** The scroll areas a cell reveal scrolls: sideways, down, and the header that covers the top. */
export interface UsableViewport {
  readonly horizontal: HTMLElement;
  readonly vertical: HTMLElement;
  readonly header?: HTMLElement;
}

export function nearestViewportDelta(
  start: number,
  end: number,
  viewportStart: number,
  viewportEnd: number,
): number {
  if (start < viewportStart) return start - viewportStart;
  if (end > viewportEnd) return end - viewportEnd;
  return 0;
}

/** Scrolls each area the least that shows `cell`, keeping it below the header when there is one. */
export function scrollIntoUsableViewport(cell: HTMLElement, viewport: UsableViewport): void {
  const { horizontal, vertical, header } = viewport;
  const horizontalViewport = horizontal.getBoundingClientRect();
  const verticalViewport = vertical.getBoundingClientRect();
  const target = cell.getBoundingClientRect();
  const usableTop = Math.max(
    verticalViewport.top,
    header?.getBoundingClientRect().bottom ?? verticalViewport.top,
  );
  horizontal.scrollLeft = Math.max(
    0,
    horizontal.scrollLeft +
      nearestViewportDelta(
        target.left,
        target.right,
        horizontalViewport.left,
        horizontalViewport.right,
      ),
  );
  vertical.scrollTop = Math.max(
    0,
    vertical.scrollTop +
      nearestViewportDelta(target.top, target.bottom, usableTop, verticalViewport.bottom),
  );
}

/** The cell whose element is the event target or holds it. */
export function cellContaining<TCell extends { readonly element: HTMLElement }>(
  cells: readonly TCell[],
  target: EventTarget | null,
): TCell | undefined {
  if (!(target instanceof Node)) return undefined;
  return cells.find(({ element }) => element === target || element.contains(target));
}
