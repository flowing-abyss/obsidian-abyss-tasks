import { Component, type Menu, type MenuItem } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskApplicationApi } from '../src/tasks';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { buildStatusSubmenu, showStatusMenuAt } from '../src/ui/statusMenu';
import {
  createAppWithFiles,
  expectDefined,
  queryApiForTasks,
  task,
  testStatusRegistry,
} from './helpers';

function fakeMenuWithIconSlots(iconSlots: HTMLElement[]): Menu {
  return {
    addItem(callback: (item: MenuItem) => unknown) {
      const dom = createDiv();
      iconSlots.push(dom.createDiv({ cls: 'menu-item-icon' }));
      const item = {
        dom,
        setTitle: () => item,
        setSection: () => item,
        setChecked: () => item,
        onClick: () => item,
      };
      callback(item as unknown as MenuItem);
      return this;
    },
  } as unknown as Menu;
}

describe('status and priority consumer delegation', () => {
  it('moves focus into the status menu when it opens', () => {
    const handle = showStatusMenuAt(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
    });
    const popover = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-status-popover'),
    );
    const firstFlag = expectDefined(
      popover.querySelector<HTMLButtonElement>('.abyss-status-popover-flag'),
    );

    expect(activeDocument.activeElement).toBe(firstFlag);
    expect(popover.contains(activeDocument.activeElement)).toBe(true);

    handle.close();
  });

  it('keeps status-menu dismissal owned by its mounted document', () => {
    vi.useFakeTimers();
    const originalActiveDocument = activeDocument;
    const ownerDocument = document.implementation.createHTMLDocument('status owner');
    const replacementDocument = document.implementation.createHTMLDocument('active replacement');
    const ownerAdd = vi.spyOn(ownerDocument, 'addEventListener');
    const ownerRemove = vi.spyOn(ownerDocument, 'removeEventListener');
    const replacementAdd = vi.spyOn(replacementDocument, 'addEventListener');

    try {
      vi.stubGlobal('activeDocument', ownerDocument);
      showStatusMenuAt(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
        task: task(),
        registry: testStatusRegistry(),
        onPickStatus: () => {},
        onPickPriority: () => {},
      });
      const popover = expectDefined(
        ownerDocument.querySelector<HTMLElement>('.abyss-status-popover'),
      );
      vi.stubGlobal('activeDocument', replacementDocument);
      vi.runOnlyPendingTimers();

      const keyRegistration = ownerAdd.mock.calls.find(([type]) => type === 'keydown');
      expect(keyRegistration).toBeDefined();
      expect(replacementAdd.mock.calls.some(([type]) => type === 'keydown')).toBe(false);

      ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(popover.isConnected).toBe(false);
      expect(ownerRemove).toHaveBeenCalledWith('keydown', expectDefined(keyRegistration)[1], true);
    } finally {
      ownerDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
        element.remove();
      });
      vi.stubGlobal('activeDocument', originalActiveDocument);
      ownerAdd.mockRestore();
      ownerRemove.mockRestore();
      replacementAdd.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('replaces an open status menu without leaking its deferred listeners', () => {
    vi.useFakeTimers();
    const add = vi.spyOn(activeDocument, 'addEventListener');
    const remove = vi.spyOn(activeDocument, 'removeEventListener');
    const opts = {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
    };

    try {
      showStatusMenuAt(new MouseEvent('contextmenu'), opts);
      vi.runOnlyPendingTimers();
      const firstKeyRegistration = expectDefined(
        add.mock.calls.find(([type]) => type === 'keydown'),
      );

      showStatusMenuAt(new MouseEvent('contextmenu'), opts);

      expect(activeDocument.querySelectorAll('.abyss-status-popover')).toHaveLength(1);
      expect(remove).toHaveBeenCalledWith('keydown', firstKeyRegistration[1], true);
    } finally {
      activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
        element.remove();
      });
      add.mockRestore();
      remove.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('owns Escape, closes only the status menu, and restores its trigger focus', () => {
    vi.useFakeTimers();
    const trigger = activeDocument.body.createEl('button', { text: 'Status' });
    const parentKeydown = vi.fn();
    activeDocument.body.addEventListener('keydown', parentKeydown);
    trigger.addEventListener('contextmenu', (event) => {
      showStatusMenuAt(event, {
        task: task(),
        registry: testStatusRegistry(),
        onPickStatus: () => {},
        onPickPriority: () => {},
      });
    });

    try {
      trigger.focus();
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      vi.runOnlyPendingTimers();
      const firstFlag = expectDefined(
        activeDocument.querySelector<HTMLButtonElement>('.abyss-status-popover-flag'),
      );
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });

      firstFlag.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(parentKeydown).not.toHaveBeenCalled();
      expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
      expect(activeDocument.activeElement).toBe(trigger);
    } finally {
      activeDocument.body.removeEventListener('keydown', parentKeydown);
      activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
        element.remove();
      });
      trigger.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('closes the body-mounted status menu when its consumer component unloads', () => {
    vi.useFakeTimers();
    const owner = new Component();
    owner.load();
    const remove = vi.spyOn(activeDocument, 'removeEventListener');
    const options = {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
      owner,
    } as Parameters<typeof showStatusMenuAt>[1];

    try {
      showStatusMenuAt(new MouseEvent('contextmenu'), options);
      vi.runOnlyPendingTimers();
      expect(activeDocument.querySelector('.abyss-status-popover')).not.toBeNull();

      owner.unload();

      expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
      expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true);
      expect(remove.mock.calls.some(([type]) => type === 'mousedown')).toBe(true);
    } finally {
      owner.unload();
      activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
        element.remove();
      });
      remove.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('detaches each closed menu lifetime from its long-lived owner', () => {
    const owner = new Component();
    owner.load();
    const addChild = vi.spyOn(owner, 'addChild');
    const removeChild = vi.spyOn(owner, 'removeChild');
    const options = {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
      owner,
    };

    try {
      for (let index = 0; index < 3; index += 1) {
        showStatusMenuAt(new MouseEvent('contextmenu'), options).close();
      }

      expect(addChild).toHaveBeenCalledTimes(3);
      expect(removeChild).toHaveBeenCalledTimes(3);
      expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
    } finally {
      owner.unload();
      activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
        element.remove();
      });
      addChild.mockRestore();
      removeChild.mockRestore();
    }
  });

  it('reports the current priority as an exclusive native keyboard-operable menu choice', () => {
    const onPickPriority = vi.fn();
    const onClose = vi.fn();
    const handle = showStatusMenuAt(new MouseEvent('contextmenu'), {
      task: task({ priority: 'B' }),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority,
      onClose,
    });
    const current = expectDefined(
      handle.element.querySelector<HTMLButtonElement>(
        ".abyss-status-popover-flag[data-abyss-priority='B']",
      ),
    );
    const other = expectDefined(
      handle.element.querySelector<HTMLButtonElement>(
        ".abyss-status-popover-flag[data-abyss-priority='D']",
      ),
    );

    expect(current.tagName).toBe('BUTTON');
    expect(current.tabIndex).toBe(0);
    expect(current.parentElement?.getAttribute('role')).toBe('group');
    expect(current.parentElement?.getAttribute('aria-label')).toBe('Priority');
    expect(current.getAttribute('role')).toBe('menuitemradio');
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(other.getAttribute('aria-checked')).toBe('false');
    expect(current.hasAttribute('aria-pressed')).toBe(false);
    other.click();
    expect(onPickPriority).toHaveBeenCalledWith('D');
    expect(onClose).toHaveBeenCalledOnce();
    expect(handle.element.isConnected).toBe(false);
    handle.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('checkbox status menus exclude repeat editing', () => {
    const onPickStatus = vi.fn();
    const opts = {
      task: task({ recurrence: 'every week' }),
      registry: testStatusRegistry(),
      onPickStatus,
      onPickPriority: () => {},
    };

    showStatusMenuAt(new MouseEvent('contextmenu'), opts);
    const row = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-status-popover-row'),
    );
    expect(row.getAttribute('role')).toBe('menuitemradio');
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.tabIndex).toBe(0);
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onPickStatus).toHaveBeenCalledOnce();

    showStatusMenuAt(new MouseEvent('contextmenu'), opts);
    expect(activeDocument.querySelector('.abyss-status-popover-edit-repeat')).toBeNull();

    activeDocument.querySelectorAll('.abyss-status-popover').forEach((element) => {
      element.remove();
    });
  });

  it('builds native-menu status icons as inert previews', () => {
    const iconSlots: HTMLElement[] = [];
    buildStatusSubmenu(fakeMenuWithIconSlots(iconSlots), task(), testStatusRegistry(), () => {});

    const marker = expectDefined(
      expectDefined(iconSlots[0]).querySelector<HTMLElement>('.abyss-status-marker'),
    );
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    marker.dispatchEvent(click);

    expect(marker.hasAttribute('role')).toBe(false);
    expect(marker.hasAttribute('tabindex')).toBe(false);
    expect(click.defaultPrevented).toBe(false);
  });

  it('lets the popover row own clicks on its inert status preview', () => {
    const onPickStatus = vi.fn();
    showStatusMenuAt(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus,
      onPickPriority: () => {},
    });
    const marker = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-status-popover-row .abyss-status-marker'),
    );

    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(marker.hasAttribute('role')).toBe(false);
    expect(marker.hasAttribute('tabindex')).toBe(false);
    expect(onPickStatus).toHaveBeenCalledOnce();
  });

  it('expresses toggle, selected symbol, and typed priority through final commands', async () => {
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-status' }],
    });
    const tasks: TaskApplicationApi = { queries: queryApiForTasks(() => []), execute };
    const ref = { filePath: 'tasks.md', line: 0, revision: 'block:task' };

    await tasks.execute({ type: 'toggle-completion', target: { type: 'task', ref } });
    await tasks.execute({ type: 'set-status', target: { type: 'task', ref }, symbol: '/' });
    await tasks.execute({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { priority: { type: 'set', value: 'F' } },
    });

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { type: 'toggle-completion', target: { type: 'task', ref } },
      { type: 'set-status', target: { type: 'task', ref }, symbol: '/' },
      {
        type: 'patch',
        target: { type: 'task', ref },
        patch: { priority: { type: 'set', value: 'F' } },
      },
    ]);
  });

  it('RightPanel forwards nested toggle, selected symbol, and priority without formatting Markdown', async () => {
    const app = await createAppWithFiles({ 'tasks.md': '- [ ] root\n  - [ ] child' });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const tasks: TaskApplicationApi = { queries: queryApiForTasks(() => []), execute };
    const panel = new RightPanel(
      new AppState(),
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const ref = {
      parent: {
        type: 'task' as const,
        ref: { filePath: 'tasks.md', line: 0, revision: 'block:root' },
      },
      relativeLine: 1,
      originalBlock: '  - [ ] child',
    };
    const child = {
      filePath: 'tasks.md',
      line: 1,
      rawText: '  - [ ] child',
      text: 'child',
      markdownText: 'child',
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      ref,
    };
    const invoke = async (method: string, ...args: unknown[]) => {
      const fn = expectDefined(
        (panel as unknown as Record<string, (...values: unknown[]) => Promise<void>>)[method],
      );
      await fn.call(panel, ...args);
    };

    await invoke('toggleSubTask', child);
    await invoke('setStatus', child, '/');
    await invoke('updatePriority', child, 'A');

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { type: 'toggle-completion', target: { type: 'subtask', ref } },
      { type: 'set-status', target: { type: 'subtask', ref }, symbol: '/' },
      {
        type: 'patch',
        target: { type: 'subtask', ref },
        patch: { priority: { type: 'set', value: 'A' } },
      },
    ]);
  });

  it('keeps the composition-root StatusCatalog live when settings are rebuilt', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      taskStatuses: DEFAULT_SETTINGS.taskStatuses.map((status) => ({ ...status })),
    };
    const catalog = new StatusCatalog(toStatusRules(settings.taskStatuses));
    settings.taskStatuses.push({
      id: 'waiting',
      symbol: 'w',
      name: 'Waiting',
      type: 'in-progress',
      icon: '',
      core: false,
    });

    catalog.replace(toStatusRules(settings.taskStatuses));

    expect(catalog.ruleForSymbol('w')).toMatchObject({ id: 'waiting', type: 'in-progress' });
  });
});
