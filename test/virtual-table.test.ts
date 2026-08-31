import { describe, expect, it, vi } from 'vitest';
import { renderVirtualTable } from '../src/ui/table/VirtualTable';
import { freshContainer } from './helpers';

describe('VirtualTable', () => {
  it('keeps the sticky header and bounded body in one horizontal scroll grid', () => {
    const root = freshContainer();
    renderVirtualTable(root, {
      columns: [
        { id: 'client', label: 'Client', width: 180 },
        { id: 'project', label: 'Project', width: 90 },
        { id: 'unknown', label: 'Unknown', width: 140 },
      ],
      rows: Array.from({ length: 500 }, (_, index) => index),
      key: String,
      label: 'Configurable table',
      renderRow: (row, host) =>
        host.createDiv({
          cls: 'abyss-virtual-table-row',
          text: String(row),
          attr: { role: 'row' },
        }),
    });

    const table = root.querySelector<HTMLElement>('[role="table"]')!;
    const scroll = table.querySelector<HTMLElement>('.abyss-virtual-table-scroll')!;
    expect(scroll.querySelector('.abyss-virtual-table-header')).not.toBeNull();
    expect(scroll.querySelector('.abyss-virtual-table-body')).not.toBeNull();
    expect(table.style.getPropertyValue('--abyss-table-columns')).toBe('180px 90px 140px');
    expect(table.querySelectorAll('.abyss-virtual-table-row')).toHaveLength(18);
  });

  it('exposes named pointer and keyboard resize handles and commits the resulting width', () => {
    const root = freshContainer();
    const resize = vi.fn();
    renderVirtualTable(root, {
      columns: [{ id: 'project', label: 'Project', width: 180 }],
      rows: [],
      key: String,
      label: 'Resizable table',
      onColumnResize: resize,
      renderRow: (_row, host) => host.createDiv(),
    });
    const table = root.querySelector<HTMLElement>('[role="table"]')!;
    const handle = root.querySelector<HTMLButtonElement>('[data-table-resize="project"]')!;
    expect(handle.getAttribute('aria-label')).toBe('Resize Project column');

    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(resize).toHaveBeenLastCalledWith('project', 188);
    expect(table.style.getPropertyValue('--abyss-table-columns')).toBe('188px');

    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 20, bubbles: true }));
    activeDocument.dispatchEvent(new MouseEvent('pointermove', { clientX: 45, bubbles: true }));
    activeDocument.dispatchEvent(new MouseEvent('pointerup', { clientX: 45, bubbles: true }));
    expect(resize).toHaveBeenLastCalledWith('project', 213);
    expect(table.style.getPropertyValue('--abyss-table-columns')).toBe('213px');
  });
});
