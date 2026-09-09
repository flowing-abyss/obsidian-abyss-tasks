export interface ProjectTableSelectableCell {
  readonly occurrenceId: string;
  readonly projectPath: string;
  readonly groupKey: string;
  readonly columnId: string;
}

export type ProjectTableSelectionDirection = 'up' | 'down' | 'left' | 'right';

interface CellPosition {
  readonly row: number;
  readonly column: number;
}

function sameCell(left: ProjectTableSelectableCell, right: ProjectTableSelectableCell): boolean {
  return left.occurrenceId === right.occurrenceId && left.columnId === right.columnId;
}

function rows(cells: readonly ProjectTableSelectableCell[]): string[] {
  return [...new Set(cells.map(({ occurrenceId }) => occurrenceId))];
}

function columns(cells: readonly ProjectTableSelectableCell[]): string[] {
  return [...new Set(cells.map(({ columnId }) => columnId))];
}

function positionOf(
  cell: ProjectTableSelectableCell,
  cells: readonly ProjectTableSelectableCell[],
): CellPosition | undefined {
  const row = rows(cells).indexOf(cell.occurrenceId);
  const column = columns(cells).indexOf(cell.columnId);
  return row < 0 || column < 0 ? undefined : { row, column };
}

function atPosition(
  position: CellPosition,
  cells: readonly ProjectTableSelectableCell[],
): ProjectTableSelectableCell | undefined {
  const occurrenceId = rows(cells)[position.row];
  const columnId = columns(cells)[position.column];
  if (occurrenceId === undefined || columnId === undefined) return undefined;
  return cells.find((cell) => cell.occurrenceId === occurrenceId && cell.columnId === columnId);
}

function moveAxis(position: number, direction: -1 | 0 | 1, count: number): number {
  return Math.max(0, Math.min(count - 1, position + direction));
}

function axisDirection(
  direction: ProjectTableSelectionDirection,
  negative: ProjectTableSelectionDirection,
  positive: ProjectTableSelectionDirection,
): -1 | 0 | 1 {
  if (direction === negative) return -1;
  if (direction === positive) return 1;
  return 0;
}

export class ProjectTableSelection {
  #anchor: ProjectTableSelectableCell | undefined;
  #focus: ProjectTableSelectableCell | undefined;

  get anchor(): ProjectTableSelectableCell | undefined {
    return this.#anchor;
  }

  get focus(): ProjectTableSelectableCell | undefined {
    return this.#focus;
  }

  select(
    cell: ProjectTableSelectableCell,
    cells: readonly ProjectTableSelectableCell[],
    extend: boolean,
  ): void {
    if (!cells.some((candidate) => sameCell(candidate, cell))) return;
    if (!extend || this.#anchor === undefined) this.#anchor = cell;
    this.#focus = cell;
  }

  move(
    direction: ProjectTableSelectionDirection,
    cells: readonly ProjectTableSelectableCell[],
    extend: boolean,
  ): ProjectTableSelectableCell | undefined {
    if (cells.length === 0) return undefined;
    const current = this.#focus ?? cells[0];
    if (current === undefined) return undefined;
    const position = positionOf(current, cells) ?? { row: 0, column: 0 };
    const rowCount = rows(cells).length;
    const columnCount = columns(cells).length;
    const rowDirection = axisDirection(direction, 'up', 'down');
    const columnDirection = axisDirection(direction, 'left', 'right');
    const next = {
      row: moveAxis(position.row, rowDirection, rowCount),
      column: moveAxis(position.column, columnDirection, columnCount),
    };
    const target = atPosition(next, cells);
    if (target !== undefined) this.select(target, cells, extend);
    return target;
  }

  tab(
    cells: readonly ProjectTableSelectableCell[],
    backwards: boolean,
  ): ProjectTableSelectableCell | undefined {
    if (cells.length === 0) return undefined;
    const focus = this.#focus;
    const currentIndex =
      focus === undefined ? -1 : cells.findIndex((cell) => sameCell(cell, focus));
    const delta = backwards ? -1 : 1;
    const fallback = backwards ? cells.length - 1 : 0;
    const index =
      currentIndex < 0 ? fallback : (currentIndex + delta + cells.length) % cells.length;
    const target = cells[index];
    if (target !== undefined) this.select(target, cells, false);
    return target;
  }

  selectCurrentGroup(cells: readonly ProjectTableSelectableCell[]): void {
    const focus = this.#focus;
    if (focus === undefined) return;
    const groupCells = cells.filter(({ groupKey }) => groupKey === focus.groupKey);
    const first = groupCells[0];
    const last = groupCells[groupCells.length - 1];
    if (first === undefined || last === undefined) return;
    this.#anchor = first;
    this.#focus = last;
  }

  selected(cells: readonly ProjectTableSelectableCell[]): ProjectTableSelectableCell[] {
    const anchor = this.#anchor;
    const focus = this.#focus;
    if (anchor === undefined || focus === undefined) return [];
    const from = positionOf(anchor, cells);
    const to = positionOf(focus, cells);
    if (from === undefined || to === undefined) return [];
    const top = Math.min(from.row, to.row);
    const bottom = Math.max(from.row, to.row);
    const left = Math.min(from.column, to.column);
    const right = Math.max(from.column, to.column);
    return cells.filter((cell) => {
      const position = positionOf(cell, cells);
      return (
        position !== undefined &&
        position.row >= top &&
        position.row <= bottom &&
        position.column >= left &&
        position.column <= right
      );
    });
  }

  reconcile(cells: readonly ProjectTableSelectableCell[]): void {
    const anchor = this.#anchor;
    const focus = this.#focus;
    if (
      anchor === undefined ||
      focus === undefined ||
      !cells.some((cell) => sameCell(cell, anchor)) ||
      !cells.some((cell) => sameCell(cell, focus))
    ) {
      this.clear();
    }
  }

  clear(): void {
    this.#anchor = undefined;
    this.#focus = undefined;
  }
}
