import { describe, expect, it, vi } from 'vitest';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import {
  projectActionBoardColumns,
  type BoardColumn,
  type BoardMutation,
} from '../src/panels/projects/boardProjection';
import type { ProjectAction } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { flushMicrotasks, freshContainer, task } from './helpers';

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
  it('keeps the dependency projection attached to Project actions through board columns', () => {
    const current = task({ title: 'Blocked project task' });
    const action: ProjectAction = {
      task: current,
      projectPath: 'Projects/A.md',
      dependency: {
        type: 'blocked',
        prerequisites: [{ filePath: 'Projects/A.md', line: 0, revision: 'prep' }],
      },
      owner: { type: 'project', path: 'Projects/A.md' },
    };

    const columns = projectActionBoardColumns(DEFAULT_SETTINGS.taskStatuses, [action]);

    expect(columns.flatMap(({ items }) => items)).toEqual([action]);
    expect(columns.flatMap(({ items }) => items)[0]?.dependency).toEqual(action.dependency);
  });

  it('includes inherited Work Note inline Actions in Project task columns', () => {
    const direct: ProjectAction = {
      task: task({ title: 'Direct action', statusSymbol: ' ' }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/A.md' },
    };
    const inherited: ProjectAction = {
      task: task({
        title: 'Work Note action',
        statusSymbol: '/',
        source: { filePath: 'Work Notes/Research.md', line: 4 },
      }),
      projectPath: 'Projects/A.md',
      dependency: { type: 'allowed' },
      owner: { type: 'work-note', path: 'Work Notes/Research.md' },
    };

    const columns = projectActionBoardColumns(DEFAULT_SETTINGS.taskStatuses, [direct, inherited]);

    expect(columns.flatMap(({ items }) => items)).toEqual([direct, inherited]);
  });

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

  it('makes both filtered terminal bookends simultaneous narrow drag zones without displacing active content', () => {
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
    const dropped = el.querySelector<HTMLElement>('[data-board-column="dropped"]')!;
    const active = el.querySelector<HTMLElement>('[data-board-column="active"]')!;
    const published = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    const card = el.querySelector<HTMLElement>('[data-board-item="a"]')!;

    card.dispatchEvent(new Event('dragstart', { bubbles: true }));

    expect(dropped.dataset['boardTerminalDragZone']).toBe('left');
    expect(published.dataset['boardTerminalDragZone']).toBe('right');
    expect(active.classList.contains('is-active')).toBe(true);
    expect(
      el.querySelectorAll('[data-board-column-tab="dropped"], [data-board-column-tab="published"]'),
    ).toHaveLength(0);

    card.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(dropped.dataset['boardTerminalDragZone']).toBeUndefined();
    expect(published.dataset['boardTerminalDragZone']).toBeUndefined();
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
