import { Menu, setIcon } from 'obsidian';
import type { ProjectColumn, ProjectFieldCatalogItem } from '../../projects/projectFields';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';

export interface VisibleProjectColumn {
  readonly column: ProjectColumn;
  readonly field: ProjectFieldCatalogItem;
}

export interface ProjectTableColumnOptions {
  readonly columns: readonly VisibleProjectColumn[];
  readonly sort: { readonly field: string; readonly dir: 'asc' | 'desc' };
  readonly onSort: (field: string) => void;
  readonly onRename: (columnId: string, label: string) => void;
  readonly onMove: (
    columnId: string,
    targetColumnId: string,
    placement: 'before' | 'after',
  ) => void;
  readonly onResize: (resize: ProjectTableColumnResize) => void;
}

export interface ProjectTableColumnResize {
  readonly columnId: string;
  readonly width: number;
  readonly visibleWidths: ReadonlyArray<{ readonly columnId: string; readonly width: number }>;
}

export function projectTableColumnWidth(
  column: ProjectColumn,
  field: ProjectFieldCatalogItem,
): number {
  if (column.width !== undefined) return column.width;
  if (field.type === 'name') return 260;
  if (field.type === 'progress') return 190;
  if (field.type === 'checkbox') return 100;
  return 150;
}

function beginRename(
  th: HTMLTableCellElement,
  column: VisibleProjectColumn,
  onRename: ProjectTableColumnOptions['onRename'],
): void {
  const existing = th.querySelector<HTMLInputElement>('.abyss-project-column-rename');
  if (existing !== null) {
    existing.focus();
    return;
  }
  const button = th.querySelector<HTMLButtonElement>('.abyss-project-table-column-button');
  if (button === null) return;
  button.hidden = true;
  const input = th.createEl('input', {
    cls: 'abyss-project-column-rename',
    attr: {
      type: 'text',
      'aria-label': `Rename ${column.field.label} column`,
    },
  });
  input.value = column.column.label ?? column.field.label;
  let finished = false;
  const finish = (save: boolean): void => {
    if (finished || !input.isConnected) return;
    finished = true;
    const label = input.value;
    input.remove();
    button.hidden = false;
    if (save) onRename(column.column.id, label);
    else button.focus();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => {
    finish(true);
  });
  input.focus();
  input.select();
}

function bindResize(
  handle: HTMLElement,
  th: HTMLTableCellElement,
  columnId: string,
  onResize: ProjectTableColumnOptions['onResize'],
): () => void {
  let cleanup: (() => void) | undefined;
  const start = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    cleanup?.();
    const ownerDocument = handle.ownerDocument;
    const startX = event.clientX;
    const startWidth = initialColumnWidth(th);
    const visibleWidths = Array.from(
      th.parentElement?.querySelectorAll<HTMLElement>('[data-column-id]') ?? [],
      (header) => ({
        columnId: header.dataset['columnId'] ?? '',
        width: Math.round(initialColumnWidth(header)),
      }),
    ).filter(({ columnId }) => columnId !== '');
    let width = startWidth;
    const move = (moveEvent: PointerEvent): void => {
      width = Math.max(60, Math.round(startWidth + moveEvent.clientX - startX));
      th.style.width = `${width}px`;
    };
    const finish = (): void => {
      cleanup?.();
      cleanup = undefined;
      onResize({ columnId, width, visibleWidths });
    };
    cleanup = () => {
      ownerDocument.removeEventListener('pointermove', move);
      ownerDocument.removeEventListener('pointerup', finish);
      ownerDocument.removeEventListener('pointercancel', finish);
    };
    ownerDocument.addEventListener('pointermove', move);
    ownerDocument.addEventListener('pointerup', finish);
    ownerDocument.addEventListener('pointercancel', finish);
  };
  handle.addEventListener('pointerdown', start);
  return () => {
    handle.removeEventListener('pointerdown', start);
    cleanup?.();
  };
}

function initialColumnWidth(th: HTMLElement): number {
  const measuredWidth = th.getBoundingClientRect().width;
  if (measuredWidth > 0) return measuredWidth;
  const savedWidth = Number(th.dataset['width']);
  return Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : 150;
}

function bindColumnDrag(
  th: HTMLTableCellElement,
  columnId: string,
  onMove: ProjectTableColumnOptions['onMove'],
  suppressSort: (value: boolean) => void,
): void {
  th.addEventListener('dragstart', (event) => {
    suppressSort(true);
    event.dataTransfer?.setData('text/abyss-project-column', columnId);
    th.addClass('is-dragging');
  });
  th.addEventListener('dragend', () => {
    th.removeClass('is-dragging');
    window.setTimeout(() => {
      suppressSort(false);
    }, 0);
  });
  th.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('text/abyss-project-column') === true) {
      event.preventDefault();
    }
  });
  th.addEventListener('drop', (event) => {
    const moved = event.dataTransfer?.getData('text/abyss-project-column');
    if (moved === undefined || moved === '' || moved === columnId) return;
    event.preventDefault();
    const bounds = th.getBoundingClientRect();
    const placement = event.clientX >= bounds.left + bounds.width / 2 ? 'after' : 'before';
    onMove(moved, columnId, placement);
  });
}

function renderHeaderColumn(
  row: HTMLTableRowElement,
  entry: VisibleProjectColumn,
  options: ProjectTableColumnOptions,
): () => void {
  const { column, field } = entry;
  let suppressSort = false;
  const width = projectTableColumnWidth(column, field);
  const th = row.createEl('th', {
    cls: `abyss-project-table-header-cell${field.type === 'name' ? ' is-sticky' : ''}`,
    attr: { scope: 'col', 'data-column-id': column.id, draggable: String(field.type !== 'name') },
  });
  th.dataset['width'] = String(width);
  const button = th.createEl('button', {
    cls: 'abyss-project-table-column-button',
    attr: { type: 'button', 'aria-label': `Sort by ${column.label ?? field.label}` },
  });
  button.createSpan({ text: column.label ?? field.label });
  if (options.sort.field === column.id) {
    const indicator = button.createSpan({ cls: 'abyss-project-table-sort-indicator' });
    setIcon(indicator, options.sort.dir === 'asc' ? 'arrow-up' : 'arrow-down');
  }
  button.addEventListener('click', () => {
    if (suppressSort) {
      suppressSort = false;
      return;
    }
    options.onSort(column.id);
  });
  th.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Rename column')
        .setIcon('pencil')
        .onClick(() => {
          beginRename(th, entry, options.onRename);
        }),
    );
    showMenuAtMouseEventWithFocus(menu, event);
  });
  if (field.type !== 'name') {
    bindColumnDrag(th, column.id, options.onMove, (value) => {
      suppressSort = value;
    });
  }
  const resize = th.createSpan({
    cls: 'abyss-project-column-resize',
    attr: { role: 'separator', 'aria-label': `Resize ${column.label ?? field.label} column` },
  });
  return bindResize(resize, th, column.id, options.onResize);
}

export function renderProjectTableColumns(
  table: HTMLTableElement,
  options: ProjectTableColumnOptions,
): () => void {
  const widths = options.columns.map(({ column, field }) => projectTableColumnWidth(column, field));
  if (options.columns.some(({ column }) => column.width !== undefined)) {
    const tableWidth = widths.reduce((total, width) => total + width, 0);
    table.style.width = `${tableWidth}px`;
    table.style.minWidth = `${tableWidth}px`;
  }
  const colgroup = table.createEl('colgroup');
  for (const [index, { column }] of options.columns.entries()) {
    const col = colgroup.createEl('col');
    col.dataset['columnId'] = column.id;
    col.style.width = `${widths[index] ?? 150}px`;
  }

  const row = table.createEl('thead').createEl('tr');
  const cleanups = options.columns.map((entry) => renderHeaderColumn(row, entry, options));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
