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

const TYPE_ICONS: Readonly<Record<ProjectFieldCatalogItem['type'] & string, string>> = {
  text: 'text',
  list: 'list',
  number: 'binary',
  checkbox: 'check-square',
  date: 'calendar',
  datetime: 'calendar-clock',
  tags: 'tags',
  name: 'file-text',
  status: 'circle-dot',
  progress: 'percent',
};

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

interface BindResizeOptions {
  readonly handle: HTMLElement;
  readonly th: HTMLTableCellElement;
  readonly columnId: string;
  readonly onResize: ProjectTableColumnOptions['onResize'];
  readonly suppressSort: (value: boolean) => void;
}

function configuredColumnWidths(
  th: HTMLTableCellElement,
): ProjectTableColumnResize['visibleWidths'] {
  return Array.from(
    th.parentElement?.querySelectorAll<HTMLElement>('[data-column-id]') ?? [],
    (header) => {
      const configured = Number(header.dataset['configuredWidth']);
      return {
        columnId: header.dataset['columnId'] ?? '',
        width:
          Number.isFinite(configured) && configured > 0
            ? configured
            : Math.round(initialColumnWidth(header)),
      };
    },
  ).filter(({ columnId }) => columnId !== '');
}

function minimumResizeWidth(
  th: HTMLTableCellElement,
  columnId: string,
  neighbor: ProjectTableColumnResize['visibleWidths'][number] | undefined,
  startWidth: number,
): number {
  if (neighbor !== undefined || columnId !== 'name') return 60;
  const viewportWidth = th.closest<HTMLElement>('.abyss-project-table-scroll')?.clientWidth ?? 0;
  return Math.max(60, viewportWidth > 0 ? viewportWidth : startWidth);
}

function resizeWidths(
  widths: ProjectTableColumnResize['visibleWidths'],
  columnId: string,
  width: number,
  neighbor: { readonly columnId: string; readonly width: number } | undefined,
): ProjectTableColumnResize['visibleWidths'] {
  return widths.map((entry) => {
    if (entry.columnId === columnId) return { columnId, width };
    if (entry.columnId === neighbor?.columnId) {
      return { columnId: entry.columnId, width: neighbor.width };
    }
    return entry;
  });
}

function bindResize(options: BindResizeOptions): () => void {
  const { handle, th, columnId, onResize, suppressSort } = options;
  let cleanup: (() => void) | undefined;
  const start = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    suppressSort(true);
    cleanup?.();
    const ownerDocument = handle.ownerDocument;
    const startX = event.clientX;
    const startWidth = initialColumnWidth(th);
    const configuredWidths = configuredColumnWidths(th);
    const renderedWidths = configuredWidths.map(({ columnId, width }) => ({
      columnId,
      width:
        columnId === th.dataset['columnId']
          ? Math.round(startWidth)
          : renderedColumnWidth(th, columnId, width),
    }));
    const targetIndex = configuredWidths.findIndex((entry) => entry.columnId === columnId);
    const neighbor = columnId === 'name' ? configuredWidths[targetIndex + 1] : undefined;
    const minimumWidth = minimumResizeWidth(th, columnId, neighbor, startWidth);
    let width = startWidth;
    let previewWidths: ProjectTableColumnResize['visibleWidths'] = renderedWidths;
    let savedWidths: ProjectTableColumnResize['visibleWidths'] = configuredWidths;
    let changed = false;
    const move = (moveEvent: PointerEvent): void => {
      const requested = Math.round(startWidth + moveEvent.clientX - startX);
      width = Math.max(minimumWidth, requested);
      const neighborWidth =
        neighbor === undefined ? undefined : Math.max(60, neighbor.width - (width - startWidth));
      const resizedNeighbor =
        neighbor === undefined || neighborWidth === undefined
          ? undefined
          : { columnId: neighbor.columnId, width: neighborWidth };
      previewWidths = resizeWidths(renderedWidths, columnId, width, resizedNeighbor);
      savedWidths = resizeWidths(configuredWidths, columnId, width, resizedNeighbor);
      changed = previewWidths.some((entry, index) => entry.width !== renderedWidths[index]?.width);
      applyLiveColumnWidths(th, previewWidths);
    };
    const finish = (): void => {
      cleanup?.();
      cleanup = undefined;
      if (changed) onResize({ columnId, width, visibleWidths: savedWidths });
      window.setTimeout(() => {
        suppressSort(false);
      }, 0);
    };
    const cancel = (): void => {
      cleanup?.();
      cleanup = undefined;
      applyLiveColumnWidths(th, renderedWidths);
      window.setTimeout(() => {
        suppressSort(false);
      }, 0);
    };
    const cancelOnEscape = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    };
    cleanup = () => {
      ownerDocument.removeEventListener('pointermove', move);
      ownerDocument.removeEventListener('pointerup', finish);
      ownerDocument.removeEventListener('pointercancel', cancel);
      ownerDocument.removeEventListener('keydown', cancelOnEscape, true);
    };
    ownerDocument.addEventListener('pointermove', move);
    ownerDocument.addEventListener('pointerup', finish);
    ownerDocument.addEventListener('pointercancel', cancel);
    ownerDocument.addEventListener('keydown', cancelOnEscape, true);
  };
  handle.addEventListener('pointerdown', start);
  return () => {
    handle.removeEventListener('pointerdown', start);
    cleanup?.();
  };
}

function applyLiveColumnWidths(
  th: HTMLTableCellElement,
  visibleWidths: ProjectTableColumnResize['visibleWidths'],
): void {
  const table = th.closest<HTMLTableElement>('table');
  if (table === null) return;
  let total = 0;
  for (const visible of visibleWidths) {
    total += visible.width;
    const col = Array.from(table.querySelectorAll<HTMLElement>('col[data-column-id]')).find(
      (candidate) => candidate.dataset['columnId'] === visible.columnId,
    );
    if (col !== undefined) col.style.width = `${visible.width}px`;
  }
  table.style.width = `${total}px`;
  table.style.minWidth = `${total}px`;
}

function renderedColumnWidth(th: HTMLTableCellElement, columnId: string, fallback: number): number {
  const table = th.closest<HTMLTableElement>('table');
  const col = Array.from(table?.querySelectorAll<HTMLElement>('col[data-column-id]') ?? []).find(
    (candidate) => candidate.dataset['columnId'] === columnId,
  );
  const width = Number.parseFloat(col?.style.width ?? '');
  return Number.isFinite(width) && width > 0 ? Math.round(width) : fallback;
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
    cls: `abyss-project-table-header-cell is-align-${column.alignment ?? 'left'}${field.type === 'name' ? ' is-sticky' : ''}`,
    attr: { scope: 'col', 'data-column-id': column.id, draggable: String(field.type !== 'name') },
  });
  th.dataset['width'] = String(width);
  th.dataset['configuredWidth'] = String(width);
  const button = th.createEl('button', {
    cls: 'abyss-project-table-column-button',
    attr: { type: 'button', 'aria-label': `Sort by ${column.label ?? field.label}` },
  });
  const icon = button.createSpan({ cls: 'abyss-project-table-column-icon' });
  const iconId = field.type === null ? 'circle-help' : TYPE_ICONS[field.type];
  icon.dataset['icon'] = iconId;
  setIcon(icon, iconId);
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
  return bindResize({
    handle: resize,
    th,
    columnId: column.id,
    onResize: options.onResize,
    suppressSort: (value) => {
      suppressSort = value;
    },
  });
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
