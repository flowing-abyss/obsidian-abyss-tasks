import type { Menu, MenuItem } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskApplicationApi } from '../src/tasks';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { buildStatusSubmenu, showStatusMenuAt } from '../src/ui/statusMenu';
import { createAppWithFiles, queryApiForTasks, task, testStatusRegistry } from './helpers';

function fakeMenuWithIconSlots(iconSlots: HTMLElement[]): Menu {
  return {
    addItem(callback: (item: MenuItem) => unknown) {
      const dom = document.createElement('div');
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
  it('builds native-menu status icons as inert previews', () => {
    const iconSlots: HTMLElement[] = [];
    buildStatusSubmenu(fakeMenuWithIconSlots(iconSlots), task(), testStatusRegistry(), () => {});

    const marker = iconSlots[0]!.querySelector<HTMLElement>('.tc-status-marker')!;
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
    const marker = activeDocument.querySelector<HTMLElement>(
      '.tc-status-popover-row .tc-status-marker',
    )!;

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
      const fn = (panel as unknown as Record<string, (...values: unknown[]) => Promise<void>>)[
        method
      ]!;
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
