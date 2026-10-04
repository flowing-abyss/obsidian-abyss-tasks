import { Component, MarkdownRenderer, Menu, type App, type MenuItem } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  TaskCardRenderer,
  type TaskCardInteractionContext,
} from '../src/panels/center/TaskCardRenderer';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { taskNodeAddress, type TaskDependencyProjection, type TaskSnapshot } from '../src/tasks';
import { expectDefined, task, testStatusRegistry, useRealMoment } from './helpers';
useRealMoment();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.empty();
});
function renderer() {
  const toggleTask = vi.fn(async (_task: TaskSnapshot) => {});
  const deleteTask = vi.fn(async (_task: TaskSnapshot) => {});
  let context: TaskCardInteractionContext | undefined;
  const unbound = vi.fn();
  const editTaskLink = vi.fn();
  const dependenciesFor = vi.fn<() => TaskDependencyProjection | undefined>(() => undefined);
  const registry = testStatusRegistry();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const subject = new TaskCardRenderer({
    app: {} as App,
    state: new AppState(),
    settings,
    statusRegistry: registry,
    commands: { toggleTask, deleteTask, patchTaskTags: vi.fn(), editTaskLink },
    listControls: { addPropertyFilter: vi.fn() },
    trackingEnabled: true,
    host: {
      component: () => new Component(),
      dependenciesFor,
      mountInteractions: (_card, _task, _key, next) => {
        context = next;
        next?.component.register(unbound);
      },
      openStatusMenu: vi.fn(),
      formatDate: String,
      getDateClass: () => '',
      getTagColor: () => undefined,
    },
  });
  return {
    subject,
    toggleTask,
    deleteTask,
    unbound,
    dependenciesFor,
    editTaskLink,
    settings,
    registry,
    context: () => context,
  };
}
it('owns Markdown and interactions per mount and updates ordinary event authority', () => {
  const owners: Component[] = [];
  const unloaded = vi.fn();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
    async (...args: Parameters<typeof MarkdownRenderer.render>) => {
      const owner = args[4];
      owners.push(owner);
      owner.register(unloaded);
    },
  );
  const h = renderer();
  const original = task({ markdownTitle: '**before**' });
  const mount = h.subject.mount(document.body, original, [], {
    selected: false,
    showDelete: true,
    rowKey: 'same',
  });
  const oldControl = expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]'));
  oldControl.click();
  const captured = h.toggleTask.mock.calls[0]?.[0];
  const next = task({ title: 'after', markdownTitle: '**after**' });
  mount.update(next, [], { selected: true, showDelete: true, rowKey: 'same' });
  mount.element.querySelector<HTMLElement>('[role=checkbox]')?.click();
  mount.element.querySelector<HTMLElement>('.abyss-task-delete-btn')?.click();
  expect(h.toggleTask.mock.calls[1]?.[0]).toBe(next);
  expect(h.deleteTask.mock.calls[0]?.[0]).toBe(next);
  expect(captured).toBe(original);
  expect(h.context()?.currentTask()).toBe(next);
  expect(mount.element.hasClass('is-selected')).toBe(true);
  expect(unloaded).toHaveBeenCalledTimes(1);
  mount.destroy();
  mount.destroy();
  expect(unloaded).toHaveBeenCalledTimes(2);
  expect(h.unbound).toHaveBeenCalledTimes(1);
  expect(owners).toHaveLength(2);
  expect(mount.element.isConnected).toBe(false);
});

it('retains focused controls until blur, dispatches their latest snapshot, and refuses another source', () => {
  const h = renderer();
  const original = task();
  const flags = { selected: false, showDelete: true, rowKey: 'same' };
  const mount = h.subject.mount(document.body, original, [], flags);
  const control = expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]'));
  control.focus();
  const next = task({ title: 'updated', statusSymbol: 'x', status: 'done' });
  mount.update(next, [], flags);
  expect(control.isConnected).toBe(true);
  expect(document.activeElement).toBe(control);
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(control.getAttribute('data-status-type')).toBe('done');
  expect(mount.element.querySelector('.abyss-task-title')?.textContent).toBe('updated');
  control.click();
  expect(h.toggleTask.mock.calls[0]?.[0]).toBe(next);
  expect(() => {
    mount.update(task({ source: { filePath: 'other.md' } }), [], flags);
  }).toThrow('different source');
  control.blur();
  expect(control.isConnected).toBe(true);
  mount.destroy();
});

it('retains owned badges across legacy refresh, unregisters evictions, and remounts at the latest tick', () => {
  const h = renderer();
  const running = task({
    timeEntries: [{ relativeLine: 1, originalMarkdown: 'running', state: 'running', startMs: 0 }],
  });
  const active = [
    {
      filePath: running.source.filePath,
      root: running.ref,
      target: { type: 'task' as const, ref: running.ref },
      address: taskNodeAddress({ type: 'task', ref: running.ref }),
      rootAddress: taskNodeAddress({ type: 'task', ref: running.ref }),
      title: running.title,
      status: running.status,
      entry: expectDefined(running.timeEntries[0]),
    },
  ];
  const flags = { selected: false, showDelete: false };
  h.subject.beginRender(60000);
  const mount = h.subject.mount(document.body, running, [], flags);
  const badge = expectDefined(
    mount.element.querySelector<HTMLElement>('.abyss-task-time-badge span'),
  );
  h.subject.beginRender(120000);
  h.subject.paintTracking({ nowMs: 180000, active });
  expect(badge.textContent).toBe('3m');
  mount.destroy();
  document.body.append(badge);
  h.subject.paintTracking({ nowMs: 240000, active });
  expect(badge.textContent).toBe('3m');
  const remount = h.subject.mount(document.body, running, [], flags);
  expect(remount.element.querySelector('.abyss-task-time-badge span')?.textContent).toBe('4m');
  const updated = task({
    timeEntries: [
      { relativeLine: 1, originalMarkdown: 'running', state: 'running', startMs: 120000 },
    ],
  });
  const focused = expectDefined(remount.element.querySelector<HTMLElement>('[role=checkbox]'));
  focused.focus();
  remount.update(updated, [], flags);
  expect(focused.isConnected).toBe(true);
  h.subject.paintTracking({ nowMs: 300000, active });
  expect(remount.element.querySelector('.abyss-task-time-badge span')?.textContent).toBe('3m');
  remount.destroy();
});

it('refreshes dependency and registry semantics with identical snapshot and tag group references', () => {
  const h = renderer();
  h.settings.sourceNoteDisplay = 'never';
  const original = task();
  const groups: [] = [];
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, original, groups, flags);
  const control = expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]'));
  control.focus();
  h.dependenciesFor.mockReturnValue({
    blockedBy: [],
    blocks: [],
    activeBlockedByCount: 1,
    activeBlocksCount: 0,
  });
  mount.update(original, groups, flags);
  const wrapper = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-status-control'));
  expect(document.activeElement).toBe(wrapper);
  expect(wrapper.getAttribute('aria-disabled')).toBe('true');
  expect(control.isConnected).toBe(true);
  expect(control.getAttribute('aria-hidden')).toBe('true');
  h.registry.replace(
    buildDefaultTaskStatuses().map((status) => ({
      ...status,
      name: status.type === 'todo' ? 'Ready' : status.name,
    })),
  );
  mount.update(original, groups, flags);
  expect(wrapper.getAttribute('aria-label')).toContain('Task status: Ready');
  h.dependenciesFor.mockReturnValue(undefined);
  mount.update(original, groups, flags);
  expect(document.activeElement).toBe(control);
  expect(control.getAttribute('aria-label')).toBe('Task status: Ready');
  h.settings.sourceNoteDisplay = 'always';
  mount.update(original, groups, flags);
  expect(mount.element.querySelector('.abyss-task-source-note')).not.toBeNull();
  expect(document.activeElement).toBe(control);
  mount.destroy();
});

it('keeps focused rendered link occurrences bound to their rendered source when links reorder', async () => {
  vi.useFakeTimers();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
    holder.createEl('a', { text: 'A', attr: { href: 'A', tabindex: '0' } });
    holder.createEl('a', { text: 'B', attr: { href: 'B' } });
  });
  let click: ((event: MouseEvent) => unknown) | undefined;
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    build: (item: MenuItem) => unknown,
  ) {
    const item = {
      setTitle() {
        return this;
      },
      setIcon() {
        return this;
      },
      onClick(handler: (event: MouseEvent) => unknown) {
        click = handler;
        return this;
      },
    } as unknown as MenuItem;
    build(item);
    return this;
  });
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    return this;
  });
  const h = renderer();
  const original = task({ markdownTitle: '[[A]] [[B]]' });
  const next = task({ markdownTitle: '[[B]] [[A]]' });
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, original, [], flags);
  await vi.runAllTimersAsync();
  const link = expectDefined(mount.element.querySelector('a'));
  link.focus();
  mount.update(next, [], flags);
  expect(document.activeElement).toBe(link);
  expect(link.isConnected).toBe(true);
  link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expectDefined(click)(new MouseEvent('click'));
  expect(h.editTaskLink).toHaveBeenCalledWith(
    original,
    0,
    expect.objectContaining({ raw: '[[A]]' }),
  );
  mount.destroy();
});

it('does not rebuild a pending focused generation when Markdown cleanup emits focusout during destroy', () => {
  const render = vi
    .spyOn(MarkdownRenderer, 'render')
    .mockImplementation(async (...args: Parameters<typeof MarkdownRenderer.render>) => {
      const holder = args[2];
      const owner = args[4];
      const link = holder.createEl('a', { text: 'A', attr: { href: 'A', tabindex: '0' } });
      owner.register(() => {
        link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
    });
  const h = renderer();
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, task({ markdownTitle: '[[A]]' }), [], flags);
  expectDefined(mount.element.querySelector('a')).focus();
  mount.update(task({ markdownTitle: '[[B]]' }), [], flags);
  mount.destroy();
  expect(render).toHaveBeenCalledTimes(1);
});
