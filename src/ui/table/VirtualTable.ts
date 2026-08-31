import { BoundedWindow } from '../../panels/projects/BoundedWindow';

interface VirtualTableColumn {
  readonly id: string;
  readonly label: string;
  readonly width?: number;
}
export interface VirtualTableOptions<Row> {
  readonly columns: readonly VirtualTableColumn[];
  readonly rows: readonly Row[];
  readonly key: (row: Row) => string;
  readonly renderRow: (row: Row, parent: HTMLElement, index: number) => HTMLElement;
  readonly label: string;
  readonly rowExtent?: number;
}
export interface VirtualTableHandle {
  readonly element: HTMLElement;
  destroy(): void;
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
  const header = root.createDiv({ cls: 'abyss-virtual-table-header', attr: { role: 'row' } });
  for (const column of options.columns)
    header.createDiv({
      cls: 'abyss-virtual-table-cell abyss-virtual-table-header-cell',
      text: column.label,
      attr: {
        role: 'columnheader',
        'data-table-column': column.id,
        ...(column.width ? { style: `width:${column.width}px` } : {}),
      },
    });
  const scroll = root.createDiv({ cls: 'abyss-virtual-table-scroll' });
  const body = scroll.createDiv({ cls: 'abyss-virtual-table-body', attr: { role: 'rowgroup' } });
  const keys = options.rows.map(options.key);
  const bounded = new BoundedWindow(keys, 8);
  const extent = options.rowExtent ?? 32;
  const render = (): void => {
    const visible = Math.max(1, Math.ceil((scroll.clientHeight || 320) / extent));
    bounded.render(body, {
      first: Math.floor(scroll.scrollTop / extent),
      visible,
      itemExtent: extent,
      render: (_host, _key, index) => options.renderRow(options.rows[index]!, body, index),
    });
  };
  scroll.addEventListener('scroll', render, { passive: true });
  render();
  return { element: root, destroy: () => root.remove() };
}
