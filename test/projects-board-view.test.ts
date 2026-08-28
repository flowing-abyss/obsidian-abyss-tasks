import { Menu, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectActionBoardColumns,
  type BoardColumn,
  type BoardMutation,
} from '../src/panels/projects/boardProjection';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import type { WorkNoteBoardSession } from '../src/panels/projects/ProjectWorkspaceSession';
import type { ProjectAction } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, flushMicrotasks, freshContainer, task } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  activeDocument
    .querySelectorAll('[data-board-roving-test]')
    .forEach((element) => element.remove());
});

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
  it('exposes one roving selected tab/tabpanel and reaches both terminal bookends by keyboard', () => {
    const el = freshContainer();
    el.dataset['boardRovingTest'] = '';
    activeDocument.body.appendChild(el);
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [{ id: 'a', name: 'A' }]),
        column('published', 'terminal-right'),
      ],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });

    const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map(({ dataset }) => dataset['boardColumnTab'])).toEqual([
      'dropped',
      'active',
      'published',
    ]);
    expect(tabs.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(el.querySelectorAll('[role="tabpanel"][data-selected-column="true"]')).toHaveLength(1);
    for (const tab of tabs) {
      const key = tab.dataset['boardColumnTab']!;
      const panel = el.querySelector<HTMLElement>(`[role="tabpanel"][data-board-column="${key}"]`)!;
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const published = el.querySelector<HTMLButtonElement>('[data-board-column-tab="published"]')!;
    expect(activeDocument.activeElement).toBe(published);
    expect(published.getAttribute('aria-selected')).toBe('true');
    published.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(activeDocument.activeElement?.getAttribute('data-board-column-tab')).toBe('dropped');
    for (const [key, name] of [
      ['dropped', '0 items in dropped'],
      ['active', '1 item in active'],
      ['published', '0 items in published'],
    ] as const) {
      expect(
        el
          .querySelector(`[data-board-column="${key}"] .abyss-board-column-count`)
          ?.getAttribute('aria-label'),
      ).toBe(name);
    }
  });

  it('offers the same status menu through an explicit compact touch affordance', async () => {
    const item = { id: 'a', name: 'A' };
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    const menuItems: Array<{
      title: string;
      icon: string;
      checked: boolean;
      disabled: boolean;
      activate: () => void;
    }> = [];
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
      let title = '';
      let icon = '';
      let checked = false;
      let disabled = false;
      let activate = (): void => undefined;
      const menuItem = {
        setTitle(value: string) {
          title = value;
          return this;
        },
        setIcon(value: string) {
          icon = value;
          return this;
        },
        setChecked(value: boolean) {
          checked = value;
          return this;
        },
        setDisabled(value: boolean) {
          disabled = value;
          return this;
        },
        onClick(callback: () => void) {
          activate = callback;
          menuItems.push({
            get title() {
              return title;
            },
            get icon() {
              return icon;
            },
            get checked() {
              return checked;
            },
            get disabled() {
              return disabled;
            },
            activate: () => activate(),
          });
          return this;
        },
      } as unknown as MenuItem;
      build(menuItem);
      return this;
    });
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: {
        move,
        menuItems: () => [
          {
            columnKey: 'published',
            label: 'Published',
            icon: 'send',
            checked: false,
            disabled: false,
          },
          {
            columnKey: 'active',
            label: 'Active',
            icon: 'circle',
            checked: true,
            disabled: true,
          },
        ],
      },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });

    const affordance = el.querySelector<HTMLButtonElement>('[data-board-status-menu="a"]')!;
    expect(affordance).toBeInstanceOf(HTMLButtonElement);
    expect(affordance.getAttribute('aria-label')).toBe('Change status');
    expect(affordance.getAttribute('title')).toBe('Change status');
    affordance.click();
    expect(show).toHaveBeenCalledOnce();
    expect(
      menuItems.map(({ title, icon, checked, disabled }) => ({ title, icon, checked, disabled })),
    ).toEqual([
      { title: 'Published', icon: 'send', checked: false, disabled: false },
      { title: 'Active', icon: 'circle', checked: true, disabled: true },
    ]);
    const clickModel = menuItems.map(({ title, icon, checked, disabled }) => ({
      title,
      icon,
      checked,
      disabled,
    }));
    menuItems.length = 0;
    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(
      menuItems.map(({ title, icon, checked, disabled }) => ({ title, icon, checked, disabled })),
    ).toEqual(clickModel);
    menuItems[0]!.activate();
    await flushMicrotasks();
    expect(move).toHaveBeenCalledWith(item, 'published');
  });

  it.each(['outside control', 'Board tab'] as const)(
    'does not resurrect a card when an async move settles after focus moved to %s',
    async (destination) => {
      const pending = deferred<{
        type: 'ok';
        previousStatusId: null;
        nextStatusId: string;
      }>();
      const session: WorkNoteBoardSession = {
        selectedColumnKey: null,
        focusedKey: null,
        restoreFocus: false,
        columns: {},
      };
      const root = freshContainer();
      const outside = activeDocument.body.createEl('button');
      activeDocument.body.appendChild(root);
      renderBoard(root, {
        columns: [
          column('active', 'regular', [{ id: 'a', name: 'A' }]),
          column('published', 'terminal-right'),
        ],
        mutation: { move: () => pending.promise, menuItems: () => [] },
        itemKey: ({ id }) => id,
        renderItem: (host, current) => host.createEl('button', { text: current.name }),
        session,
      });
      const card = root.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
      card.focus();
      expect(activeDocument.activeElement).toBe(card);
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      root
        .querySelector<HTMLElement>('[data-board-column="published"]')!
        .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      const target =
        destination === 'Board tab'
          ? root.querySelector<HTMLButtonElement>('[data-board-column-tab="published"]')!
          : outside;
      target.focus();
      await flushMicrotasks();
      pending.resolve({ type: 'ok', previousStatusId: null, nextStatusId: 'published' });
      await flushMicrotasks();

      const replacementTarget =
        destination === 'Board tab'
          ? root.querySelector<HTMLButtonElement>('[data-board-column-tab="published"]')
          : outside;
      expect(activeDocument.activeElement).toBe(replacementTarget);
      root.remove();
      outside.remove();
    },
  );

  it('revokes Board-owned focus after intentional blur and never resurrects the old card', async () => {
    const session: WorkNoteBoardSession = {
      selectedColumnKey: null,
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    };
    const el = freshContainer();
    const outside = activeDocument.createElement('button');
    activeDocument.body.append(el, outside);
    const options = {
      columns: [column('active', 'regular', [{ id: 'a', name: 'A' }])],
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }: Item) => id,
      renderItem: (host: HTMLElement, current: Item) => host.createDiv({ text: current.name }),
      session,
    };
    const handle = renderBoard(el, options);
    const cardControl = el.querySelector<HTMLElement>('[data-board-item-focus="a"]')!;
    cardControl.focus();
    expect(activeDocument.activeElement).toBe(cardControl);
    outside.focus();
    await flushMicrotasks();

    expect(session.restoreFocus).toBe(false);
    handle.destroy();
    renderBoard(el, options);
    expect(activeDocument.activeElement).toBe(outside);
    el.remove();
    outside.remove();
  });

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

  it('does not label filtered terminal drop zones with tabs that are not rendered', () => {
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('dropped', 'terminal-left'),
        column('active', 'regular', [{ id: 'a', name: 'A' }]),
        column('published', 'terminal-right'),
      ],
      visibleColumnKeys: new Set(['active']),
      mutation: { move: vi.fn(), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
    });

    for (const panel of el.querySelectorAll<HTMLElement>('[data-terminal-filtered="true"]')) {
      const labelledBy = panel.getAttribute('aria-labelledby');
      expect(labelledBy === null || el.querySelector(`#${labelledBy}`) !== null).toBe(true);
    }
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
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();

    expect(undo).toHaveBeenCalledWith(item, 'published', {
      type: 'ok',
      previousStatusId: 'active',
    });
    expect(el.textContent).toContain('A');
  });

  it('does not start a second board mutation while the current Undo is in flight', async () => {
    const first = { id: 'a', name: 'A' };
    const second = { id: 'b', name: 'B' };
    const move = vi.fn().mockResolvedValue({ type: 'ok', previousStatusId: 'active' });
    const pendingUndo = deferred<{
      type: 'ok';
      previousStatusId: string;
      nextStatusId: string;
    }>();
    const undo = vi.fn(() => pendingUndo.promise);
    const el = freshContainer();
    renderBoard(el, {
      columns: [
        column('active', 'regular', [first, second]),
        column('published', 'terminal-right'),
      ],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => {
        const card = host.createDiv();
        card.createEl('button', {
          text: current.name,
          attr: { type: 'button', 'data-project-identity-control': '' },
        });
        card.createEl('button', {
          text: 'Open',
          attr: { type: 'button', 'aria-label': `Open ${current.name}` },
        });
        return card;
      },
      undo,
    });
    const stableStructure = {
      columns: el.querySelectorAll('[data-board-column]').length,
      cards: el.querySelectorAll('[data-board-item][draggable]').length,
    };

    const published = el.querySelector<HTMLElement>('[data-board-column="published"]')!;
    el.querySelector<HTMLElement>('[data-board-item="a"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    published.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    const undoTrigger = el.querySelector<HTMLButtonElement>('[data-board-undo]')!;
    undoTrigger.click();
    await flushMicrotasks();

    const busyRegion = el.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(busyRegion).not.toBeNull();
    expect(busyRegion?.textContent).toContain('Undo');
    expect({
      columns: el.querySelectorAll('[data-board-column]').length,
      cards: el.querySelectorAll('[data-board-item][draggable]').length,
    }).toEqual(stableStructure);
    expect(undoTrigger.disabled || undoTrigger.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-board-status-menu')).every(
        (control) => control.disabled || control.getAttribute('aria-disabled') === 'true',
      ),
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('[data-board-item][draggable]')).every(
        (surface) => surface.closest('[aria-disabled="true"]') === null,
      ),
    ).toBe(true);
    expect(
      Array.from(
        el.querySelectorAll<HTMLButtonElement>(
          '[data-project-identity-control], [aria-label^="Open "]',
        ),
      ).every((control) => !control.disabled && control.getAttribute('aria-disabled') !== 'true'),
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('[data-board-item][draggable]')).every(
        (surface) => surface.getAttribute('draggable') === 'false',
      ),
    ).toBe(true);

    const blockedCard = el.querySelector<HTMLElement>('[data-board-item="b"][draggable]')!;
    blockedCard.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(el.querySelector('.abyss-board-columns')?.classList.contains('is-drag-active')).toBe(
      false,
    );
    expect(el.querySelector('[data-board-terminal-drag-zone]')).toBeNull();
    published.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(move).toHaveBeenCalledOnce();

    pendingUndo.resolve({ type: 'ok', previousStatusId: 'active', nextStatusId: 'published' });
    await flushMicrotasks();
    expect(el.querySelector('[aria-busy="true"]')).toBeNull();
    const settledUndo = el.querySelector<HTMLButtonElement>('[data-board-undo]');
    expect(
      settledUndo === null ||
        (!settledUndo.disabled && settledUndo.getAttribute('aria-disabled') !== 'true'),
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-board-status-menu')).some(
        (control) => !control.disabled && control.getAttribute('aria-disabled') !== 'true',
      ),
    ).toBe(true);

    el.querySelector<HTMLElement>('[data-board-item="b"]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="published"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(move).toHaveBeenCalledTimes(2);
  });

  it.each([
    { context: 'a visible destination card', visible: 'all' as const, selected: 'published' },
    { context: 'a filtered terminal destination', visible: 'active' as const, selected: 'active' },
    {
      context: 'a responsive non-active destination',
      visible: 'all' as const,
      selected: 'active',
    },
  ])('focuses the stable busy toolbar for $context', async ({ visible, selected }) => {
    const item = { id: 'a', name: 'A' };
    const pendingUndo = deferred<{ type: 'ok'; previousStatusId: string; nextStatusId: string }>();
    const el = freshContainer();
    activeDocument.body.appendChild(el);
    const session: WorkNoteBoardSession = {
      selectedColumnKey: selected,
      focusedKey: null,
      restoreFocus: false,
      columns: {},
    };
    const handle = renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: {
        move: vi.fn().mockResolvedValue({
          type: 'ok',
          previousStatusId: 'active',
          nextStatusId: 'published',
        }),
        menuItems: () => [],
      },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => {
        const card = host.createDiv();
        card.createEl('button', {
          text: current.name,
          attr: { type: 'button', 'data-project-identity-control': '' },
        });
        return card;
      },
      undo: () => pendingUndo.promise,
      session,
      ...(visible === 'active' ? { visibleColumnKeys: new Set(['active']) } : {}),
    });
    try {
      el.querySelector<HTMLElement>('[data-board-item="a"][draggable]')!.dispatchEvent(
        new Event('dragstart', { bubbles: true }),
      );
      el.querySelector<HTMLElement>('[data-board-column="published"]')!.dispatchEvent(
        new Event('drop', { bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      const undo = el.querySelector<HTMLButtonElement>('[data-board-undo]')!;
      undo.focus();
      undo.click();
      await flushMicrotasks();

      const toolbar = el.querySelector<HTMLElement>('.abyss-board-toolbar')!;
      expect(toolbar.isConnected).toBe(true);
      expect(toolbar.tabIndex).toBe(-1);
      expect(activeDocument.activeElement).toBe(toolbar);
      expect(toolbar.querySelector<HTMLElement>('[role="status"]')?.textContent).toBe(
        'Undoing status change…',
      );
      const currentUndo = toolbar.querySelector<HTMLButtonElement>('[data-board-undo]')!;
      expect(currentUndo.getAttribute('aria-label') ?? currentUndo.textContent).toBe('Undo');
    } finally {
      pendingUndo.resolve({
        type: 'ok',
        previousStatusId: 'active',
        nextStatusId: 'published',
      });
      await flushMicrotasks();
      handle.destroy();
      el.remove();
    }
  });

  it('keeps one compact toolbar host before and after Undo becomes available', async () => {
    const item = { id: 'a', name: 'A' };
    const el = freshContainer();
    renderBoard(el, {
      columns: [column('active', 'regular', [item]), column('published', 'terminal-right')],
      mutation: { move: vi.fn().mockResolvedValue({ type: 'ok' }), menuItems: () => [] },
      itemKey: ({ id }) => id,
      renderItem: (host, current) => host.createDiv({ text: current.name }),
      undo: vi.fn().mockResolvedValue({ type: 'ok' }),
    });
    const initialToolbar = el.querySelector<HTMLElement>('.abyss-board-toolbar')!;
    expect(el.querySelectorAll('.abyss-board-toolbar')).toHaveLength(1);
    const reservedBlockSize = getComputedStyle(initialToolbar).blockSize;

    el.querySelector<HTMLElement>('[data-board-item="a"][draggable]')!.dispatchEvent(
      new Event('dragstart', { bubbles: true }),
    );
    el.querySelector<HTMLElement>('[data-board-column="published"]')!.dispatchEvent(
      new Event('drop', { bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    const currentToolbar = el.querySelector<HTMLElement>('.abyss-board-toolbar')!;
    expect(el.querySelectorAll('.abyss-board-toolbar')).toHaveLength(1);
    expect(currentToolbar.querySelector('[data-board-undo]')).not.toBeNull();
    expect(getComputedStyle(currentToolbar).blockSize).toBe(reservedBlockSize);
    expect(
      currentToolbar.compareDocumentPosition(el.querySelector('.abyss-board-columns')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
