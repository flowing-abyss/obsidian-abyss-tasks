import { describe, expect, it, vi } from 'vitest';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import type { BoardColumn, BoardMutation } from '../src/panels/projects/boardProjection';
import { flushMicrotasks, freshContainer } from './helpers';

interface Item {
  readonly id: string;
  readonly name: string;
}

function column(
  key: string,
  role: BoardColumn<Item>['role'],
  items: readonly Item[] = [],
): BoardColumn<Item> {
  return { key, label: key, role, items };
}

describe('shared board view', () => {
  it('expands a filtered terminal target only while dragging', () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [item]),
        column('published', 'terminal-right'),
      ],
      visibleColumnKeys: new Set(['active']),
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const published = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;

    expect(published.classList.contains('is-collapsed')).toBe(true);
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(published.classList.contains('is-collapsed')).toBe(false);
    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(published.classList.contains('is-collapsed')).toBe(true);
  });

  it('keeps a terminal item visible when its filter is enabled and removes it only after a successful filtered write', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    const mutation: BoardMutation<Item> = { move, menuItems: () => [] };

    const visible = freshContainer();
    renderBoard(visible, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      visibleColumnKeys: new Set(['active', 'published']),
      mutation,
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const visibleTarget = visible.querySelector<HTMLElement>('[data-board-column="published"]')!;
    visible
      .querySelector<HTMLElement>('[data-board-item="a"]')!
      .dispatchEvent(new Event('dragstart', { bubbles: true }));
    visibleTarget.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    visibleTarget.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(visible.textContent).toContain('A');

    const filtered = freshContainer();
    renderBoard(filtered, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      visibleColumnKeys: new Set(['active']),
      mutation,
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const filteredTarget = filtered.querySelector<HTMLElement>('[data-board-column="published"]')!;
    filtered
      .querySelector<HTMLElement>('[data-board-item="a"]')!
      .dispatchEvent(new Event('dragstart', { bubbles: true }));
    filteredTarget.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    filteredTarget.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(filtered.textContent).not.toContain('A');
  });

  it('keeps logical keyboard order inside each bounded column', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `item-${String(index)}`,
      name: `Item ${String(index)}`,
    }));
    const el = freshContainer();
    activeDocument.body.append(el);
    renderBoard(el, {
      columns: [column('active', 'regular', items)],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });
    const first = el.querySelector<HTMLElement>('[data-board-item="item-0"]')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(activeDocument.activeElement?.getAttribute('data-board-item')).toBe('item-1');
    expect(el.querySelectorAll('[data-board-item]').length).toBeLessThan(items.length);
    el.remove();
  });

  it('offers a successful lifecycle move a conditional Undo action', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok', previousStatusId: 'active' });
    const undo = vi.fn().mockResolvedValue({ type: 'ok' });
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
      undo,
    });

    const source = el.querySelector<HTMLElement>('[data-board-item="a"]')!;
    const target = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    source.dispatchEvent(new Event('dragstart', { bubbles: true }));
    target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    el.querySelector<HTMLButtonElement>('[data-board-undo]')!.click();
    await flushMicrotasks();

    expect(undo).toHaveBeenCalledWith(item, 'published', {
      type: 'ok',
      previousStatusId: 'active',
    });
    expect(el.textContent).toContain('A');
  });
});
