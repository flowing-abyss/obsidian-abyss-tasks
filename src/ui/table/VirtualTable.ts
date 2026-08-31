import { BoundedWindow } from '../../panels/projects/BoundedWindow';

interface VirtualTableColumn {
  readonly id: string;
  readonly label: string;
  readonly width?: number;
}

interface VirtualTableGroup<Row> {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly Row[];
  readonly collapsed: boolean;
}

export interface VirtualTableOptions<Row> {
  readonly columns: readonly VirtualTableColumn[];
  readonly rows: readonly Row[];
  readonly groups?: readonly VirtualTableGroup<Row>[];
  readonly key: (row: Row) => string;
  readonly renderRow: (row: Row, parent: HTMLElement, index: number) => HTMLElement;
  readonly label: string;
  readonly rowExtent?: number;
  readonly onColumnResize?: (columnId: string, width: number) => void;
  readonly onGroupToggle?: (groupKey: string, collapsed: boolean) => void;
}
export interface VirtualTableHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

type TableEntry<Row> =
  | { readonly type: 'group'; readonly group: VirtualTableGroup<Row> }
  | { readonly type: 'row'; readonly row: Row; readonly rowIndex: number };

const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 640;
const DEFAULT_PRIMARY_WIDTH = 240;
const DEFAULT_COLUMN_WIDTH = 120;
const KEYBOARD_RESIZE_STEP = 8;

function clampWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
}

function tableEntries<Row>(options: VirtualTableOptions<Row>): readonly TableEntry<Row>[] {
  if (!options.groups) {
    return options.rows.map((row, rowIndex) => ({ type: 'row', row, rowIndex }));
  }
  const rowIndex = new Map(options.rows.map((row, index) => [options.key(row), index]));
  return options.groups.flatMap((group) => [
    { type: 'group' as const, group },
    ...(group.collapsed
      ? []
      : group.rows.map((row) => ({
          type: 'row' as const,
          row,
          rowIndex: rowIndex.get(options.key(row)) ?? 0,
        }))),
  ]);
}

/** One accessible bounded table shell shared by project and task collection adapters. */
export function renderVirtualTable<Row>(
  parent: HTMLElement,
  options: VirtualTableOptions<Row>,
): VirtualTableHandle {
  const root = parent.createDiv({
    cls: 'abyss-virtual-table',
    attr: { role: 'table', 'aria-label': options.label },
  });
  const widths = new Map(
    options.columns.map((column, index) => [
      column.id,
      clampWidth(column.width ?? (index === 0 ? DEFAULT_PRIMARY_WIDTH : DEFAULT_COLUMN_WIDTH)),
    ]),
  );
  const updateTracks = (): void => {
    root.style.setProperty(
      '--abyss-table-columns',
      options.columns
        .map(({ id }) => `${String(widths.get(id) ?? DEFAULT_COLUMN_WIDTH)}px`)
        .join(' '),
    );
  };
  updateTracks();

  const scroll = root.createDiv({ cls: 'abyss-virtual-table-scroll' });
  const header = scroll.createDiv({ cls: 'abyss-virtual-table-header', attr: { role: 'row' } });
  const activePointerCleanups = new Set<() => void>();
  const commitWidth = (column: VirtualTableColumn, width: number): void => {
    const next = clampWidth(width);
    widths.set(column.id, next);
    updateTracks();
    options.onColumnResize?.(column.id, next);
  };
  for (const column of options.columns) {
    const cell = header.createDiv({
      cls: 'abyss-virtual-table-cell abyss-virtual-table-header-cell',
      attr: { role: 'columnheader', 'data-table-column': column.id },
    });
    cell.createSpan({ cls: 'abyss-virtual-table-header-label', text: column.label });
    if (!options.onColumnResize) continue;
    const handle = cell.createEl('button', {
      cls: 'abyss-virtual-table-resize',
      attr: {
        type: 'button',
        'data-table-resize': column.id,
        'aria-label': `Resize ${column.label} column`,
        title: `Resize ${column.label} column`,
      },
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      commitWidth(
        column,
        (widths.get(column.id) ?? DEFAULT_COLUMN_WIDTH) + direction * KEYBOARD_RESIZE_STEP,
      );
    });
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const document = handle.ownerDocument;
      const startX = event.clientX;
      const startWidth = widths.get(column.id) ?? DEFAULT_COLUMN_WIDTH;
      let nextWidth = startWidth;
      const move = (moveEvent: PointerEvent): void => {
        nextWidth = clampWidth(startWidth + moveEvent.clientX - startX);
        widths.set(column.id, nextWidth);
        updateTracks();
      };
      const cleanup = (): void => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel);
        activePointerCleanups.delete(cleanup);
      };
      const up = (): void => {
        cleanup();
        commitWidth(column, nextWidth);
      };
      const cancel = (): void => {
        cleanup();
        widths.set(column.id, startWidth);
        updateTracks();
      };
      activePointerCleanups.add(cleanup);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel);
    });
  }

  const body = scroll.createDiv({
    cls: 'abyss-virtual-table-body',
    attr: { role: 'rowgroup', tabindex: '-1' },
  });
  const entries = tableEntries(options);
  const keys = entries.map((entry) =>
    entry.type === 'group' ? `group:${entry.group.key}` : `row:${options.key(entry.row)}`,
  );
  const bounded = new BoundedWindow(keys, 8);
  const extent = options.rowExtent ?? 32;
  const render = (): void => {
    const visible = Math.max(1, Math.ceil((scroll.clientHeight || 320) / extent));
    bounded.render(body, {
      first: Math.floor(scroll.scrollTop / extent),
      visible,
      itemExtent: extent,
      render: (_host, _key, index) => {
        const entry = entries[index]!;
        if (entry.type === 'row') return options.renderRow(entry.row, body, entry.rowIndex);
        const group = body.createDiv({
          cls: 'abyss-virtual-table-group-row',
          attr: { role: 'row', 'data-table-group': entry.group.key },
        });
        const cell = group.createDiv({
          cls: 'abyss-virtual-table-cell abyss-virtual-table-group-cell',
          attr: { role: 'cell' },
        });
        const toggle = cell.createEl('button', {
          text: entry.group.label,
          attr: {
            type: 'button',
            'aria-expanded': String(!entry.group.collapsed),
            'aria-label': `${entry.group.collapsed ? 'Expand' : 'Collapse'} ${entry.group.label}`,
          },
        });
        toggle.addEventListener('click', () =>
          options.onGroupToggle?.(entry.group.key, !entry.group.collapsed),
        );
        return group;
      },
    });
  };
  scroll.addEventListener('scroll', render, { passive: true });
  render();
  return {
    element: root,
    destroy: () => {
      for (const cleanup of [...activePointerCleanups]) cleanup();
      root.remove();
    },
  };
}
