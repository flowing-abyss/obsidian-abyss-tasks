import { Component, MarkdownRenderer, Menu, type App, type MenuItem } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { moment } from '../src/obsidianMoment';
import { ListViewControls } from '../src/panels/center/ListViewControls';
import {
  TaskCardRenderer,
  type TaskCardInteractionContext,
} from '../src/panels/center/TaskCardRenderer';
import type { TaskListNavigationRequest } from '../src/panels/center/TaskListNavigation';
import { StatisticsEvidence } from '../src/panels/statistics/StatisticsEvidence';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { prepareStatisticsDataset, StatisticsSession } from '../src/statistics';
import { selectTaskNodes } from '../src/task-lists/TaskListSelector';
import type { TaskOccurrencePresentation } from '../src/task-lists/taskOccurrencePresentation';
import {
  localDate,
  taskNodeAddress,
  type TaskDependencyProjection,
  type TaskNodeRef,
  type TaskOccurrenceCompletion,
  type TaskSnapshot,
} from '../src/tasks';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import type { TaskSelectionNode } from '../src/ui/taskSelection';
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  task,
  taskComment,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import { request, work } from './helpers/statisticsFixtures';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
useRealMoment();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.empty();
});
function renderer(useListControls = false) {
  const toggleTask = vi.fn(
    async (_task: TaskSnapshot, _completion?: TaskOccurrenceCompletion) => {},
  );
  const openStatusMenu = vi.fn();
  const deleteTask = vi.fn(async (_task: TaskSnapshot) => {});
  let context: TaskCardInteractionContext | undefined;
  const unbound = vi.fn();
  const editTaskLink = vi.fn();
  const dependenciesFor = vi.fn<() => TaskDependencyProjection | undefined>(() => undefined);
  const showTaskInList = vi.fn<
    (target: TaskNodeRef, request: TaskListNavigationRequest) => Promise<void>
  >(async () => {});
  const openLinkText = vi.fn().mockResolvedValue(undefined);
  const trigger = vi.fn();
  const hostComponent = new Component();
  hostComponent.load();
  const registry = testStatusRegistry();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const state = new AppState();
  const controls = new ListViewControls({
    state,
    settings,
    statusRegistry: registry,
    interactionOwnership: noInteractionOwnership,
    saveViewState: async () => {},
    host: { root: () => document.body, formatDate: String },
  });
  const listControls = {
    addPropertyFilter: vi.fn((filter: Parameters<ListViewControls['addPropertyFilter']>[0]) => {
      if (useListControls) controls.addPropertyFilter(filter);
    }),
  };
  const subject = new TaskCardRenderer({
    app: { workspace: { openLinkText, trigger } } as unknown as App,
    state,
    settings,
    statusRegistry: registry,
    commands: { toggleTask, deleteTask, patchTaskTags: vi.fn(), editTaskLink },
    listControls,
    trackingEnabled: true,
    host: {
      currentDate: () => localDate(moment().format('YYYY-MM-DD')),
      component: () => hostComponent,
      showTaskInList,
      dependenciesFor,
      dependenciesForNode: () => undefined,
      mountInteractions: (_card, _task, _key, next) => {
        context = next;
        next?.component.register(unbound);
      },
      openChildContextMenu: () => {},
      openStatusMenu,
      formatDate: String,
      getDateClass: () => '',
      getTagColor: () => undefined,
    },
  });
  return {
    subject,
    openStatusMenu,
    showTaskInList,
    state,
    listControls,
    hostComponent,
    openLinkText,
    trigger,
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
it.each([
  { description: 'Summary\nDetails', displayed: 'Summary …' },
  { description: 'Summary\n  ', displayed: 'Summary' },
  { description: 'Summary', displayed: 'Summary' },
  { description: 'Summary\n  \nDetails', displayed: 'Summary …' },
])(
  'shows the first description line with its continuation state: $description',
  async ({ description, displayed }) => {
    const h = renderer();
    const flags = { selected: false, showDelete: false };
    const mount = h.subject.mount(document.body, task({ description }), [], flags);
    await mount.settled;
    expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe(displayed);
    mount.destroy();
  },
);

it('adds and removes the continuation cue when only later description lines change', async () => {
  const h = renderer();
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, task({ description: 'Summary' }), [], flags);
  const description = expectDefined(mount.element.querySelector('.abyss-task-desc'));
  for (const [value, displayed] of [
    ['Summary\nDetails', 'Summary …'],
    ['Summary\n  ', 'Summary'],
    ['Summary\nMore details', 'Summary …'],
    ['Summary', 'Summary'],
  ] as const) {
    mount.update(task({ description: value }), [], flags);
    await mount.settled;
    expect(mount.element.querySelector('.abyss-task-desc')).toBe(description);
    expect(description.textContent).toBe(displayed);
  }
  mount.destroy();
});

it('keeps the continuation cue visible when the canonical description starts with an empty line', async () => {
  const source = await createCanonicalSearchHarness(
    { 'empty-first.md': '- [ ] Root\n  - > \n  - > Details' },
    structuredClone(DEFAULT_SETTINGS),
  );
  const h = renderer();
  try {
    const root = expectDefined(source.index.list()[0]);
    expect(root.description).toBe('\nDetails');
    const mount = h.subject.mount(document.body, root, [], { selected: false, showDelete: false });
    await mount.settled;
    const description = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-task-desc'));
    expect(description.hidden).toBe(false);
    expect(description.textContent).toBe(' …');
    mount.destroy();
  } finally {
    source.close();
    h.hostComponent.unload();
  }
});

it('derives the continuation cue from the projected nested task description', async () => {
  const source = await createCanonicalSearchHarness(
    {
      'tree.md':
        '- [ ] Root\n  - > Root summary\n  - [ ] Child\n    - > Child summary\n    - > Child details',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const h = renderer();
  try {
    const projection = expectDefined(
      source.index.listNodes().find(({ node }) => node.title === 'Child'),
    );
    expect(projection.node.description).toBe('Child summary\nChild details');
    const mount = h.subject.mount(document.body, projection.root, [], {
      selected: false,
      showDelete: false,
      projection,
    });
    await mount.settled;
    expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe('Child summary …');
    mount.destroy();
  } finally {
    source.close();
    h.hostComponent.unload();
  }
});

it('adds the cue after Markdown and highlighting without changing description provenance', async () => {
  const { prepareSearchQuery } = await import('../src/tasks');
  const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
  const renderedSources: string[] = [];
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    renderedSources.push(source);
    holder.createEl('p').createEl('strong', { text: 'Summary' });
  });
  const h = renderer();
  const original = task({ description: '**Summary**\nDetails' });
  const mount = h.subject.mount(document.body, original, [], {
    selected: false,
    showDelete: false,
    highlight: {
      query: prepareSearchQuery('summary', fallbackSearchWords),
      segment: fallbackSearchWords,
    },
  });
  await mount.settled;
  const description = expectDefined(mount.element.querySelector('.abyss-task-desc'));
  expect(description.textContent).toBe('Summary …');
  expect(description.querySelector('strong mark')?.textContent).toBe('Summary');
  expect(renderedSources).toEqual(['**Summary**']);
  expect(original.description).toBe('**Summary**\nDetails');
  mount.destroy();
});

it('settles delayed description cues into only the current card generation', async () => {
  const old = deferred<void>();
  const next = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation((_app, source, holder) => {
    const wait = source === '**Old**' ? old : next;
    return wait.promise.then(() => {
      holder.createEl('strong', { text: source === '**Old**' ? 'Old' : 'New' });
    });
  });
  const h = renderer();
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(
    document.body,
    task({ description: '**Old**\nOld details' }),
    [],
    flags,
  );
  const previous = mount.settled;
  mount.update(task({ description: '**New**\nNew details' }), [], flags);
  expect(await previous).toEqual({ type: 'cancelled' });
  next.resolve();
  expect(await mount.settled).toEqual({ type: 'ready' });
  expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe('New …');
  old.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe('New …');
  mount.destroy();
});

it('does not add a pending description cue after its card is destroyed', async () => {
  const held = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _source, holder) => {
    await held.promise;
    holder.createEl('strong', { text: 'Old' });
  });
  const h = renderer();
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(
    document.body,
    task({ description: '**Old**\nDetails' }),
    [],
    flags,
  );
  const oldDescription = expectDefined(mount.element.querySelector('.abyss-task-desc'));
  const pending = mount.settled;
  mount.destroy();
  expect(await pending).toEqual({ type: 'cancelled' });
  const current = h.subject.mount(document.body, task({ description: 'New\nDetails' }), [], flags);
  await current.settled;
  held.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(oldDescription.textContent).toBe('');
  expect(current.element.querySelector('.abyss-task-desc')?.textContent).toBe('New …');
  current.destroy();
});

it('keeps every added tag available as a filter, including tags from the same prefix', () => {
  const h = renderer();
  const original = task({ tags: ['#work/one', '#work/two'] });
  const flags = { selected: false, showDelete: true, rowKey: 'same' };
  const mount = h.subject.mount(document.body, original, [], flags);
  mount.update(
    task({ tags: ['#work/one', '#work/two', '#work/three', '#work/four', '#personal'] }),
    [],
    flags,
  );
  const tags = [...mount.element.querySelectorAll<HTMLElement>('.abyss-task-tag')];
  expect(tags.map((element) => element.textContent)).toEqual([
    '#work/one',
    '#work/two',
    '#work/three',
    '#work/four',
    '#personal',
  ]);
  expectDefined(tags[2]).click();
  expectDefined(tags[4]).click();
  expect(h.listControls.addPropertyFilter.mock.calls).toEqual([
    [{ type: 'tag', value: '#work/three' }],
    [{ type: 'tag', value: '#personal' }],
  ]);
  mount.destroy();
});

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
    for (const [index, label] of (_markdown === '[[A]] [[B]]'
      ? ['A', 'B']
      : ['B', 'A']
    ).entries()) {
      if (index > 0) holder.appendText(' ');
      holder.createEl('a', { text: label, attr: { href: label, tabindex: '0' } });
    }
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
  const outside = document.body.createEl('button');
  outside.focus();
  await vi.runAllTimersAsync();
  expect(link.isConnected).toBe(false);
  h.editTaskLink.mockClear();
  const oldMenu = new MouseEvent('contextmenu', { cancelable: true });
  link.dispatchEvent(oldMenu);
  expect.soft(oldMenu.defaultPrevented).toBe(false);
  const currentLink = expectDefined(mount.element.querySelector<HTMLAnchorElement>('a[href="A"]'));
  currentLink.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
  expectDefined(click)(new MouseEvent('click'));
  expect(h.editTaskLink).toHaveBeenCalledExactlyOnceWith(
    next,
    1,
    expect.objectContaining({ raw: '[[A]]' }),
  );
  mount.destroy();
  const deadMenu = new MouseEvent('contextmenu', { cancelable: true });
  currentLink.dispatchEvent(deadMenu);
  expect.soft(deadMenu.defaultPrevented).toBe(false);
});

it('cancels a pending focused generation when Markdown cleanup emits focusout during destroy', async () => {
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
  await mount.settled;
  expectDefined(mount.element.querySelector('a')).focus();
  mount.update(task({ markdownTitle: '[[B]]' }), [], flags);
  const receipt = mount.settled;
  mount.destroy();
  expect(await receipt).toEqual({ type: 'cancelled' });
  expect(render).toHaveBeenCalledTimes(2);
});

it('refreshes unrelated content while keeping the identical Delete control focused', () => {
  const h = renderer();
  h.subject.beginRender(120000);
  const flags = { selected: false, showDelete: true };
  const mount = h.subject.mount(document.body, task({ title: 'Before' }), [], flags);
  const control = expectDefined(
    mount.element.querySelector<HTMLButtonElement>('.abyss-task-delete-btn'),
  );
  control.focus();
  mount.update(
    task({
      title: 'After',
      description: 'New description',
      recurrence: 'every day',
      comments: [taskComment({ text: 'Comment' })],
      timeEntries: [{ relativeLine: 2, originalMarkdown: 'running', state: 'running', startMs: 0 }],
    }),
    [],
    flags,
  );
  expect(document.activeElement).toBe(control);
  expect(control.isConnected).toBe(true);
  expect(mount.element.querySelector('.abyss-task-title')?.textContent).toBe('After');
  expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe('New description');
  expect(mount.element.querySelector('.abyss-recurrence-badge')).not.toBeNull();
  expect(mount.element.querySelector('.abyss-task-time-badge')?.textContent).toBe('2m');
  expect(
    mount.element.querySelector('.abyss-task-time-badge')?.classList.contains('is-tracking'),
  ).toBe(true);
  expect(mount.element.querySelector('.abyss-task-title-row')?.textContent).toContain('1');
  mount.destroy();
});

it('reconciles all timer transitions while the original Markdown link keeps focus', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _text, holder) => {
    holder.createEl('a', { text: 'A', attr: { href: 'A', tabindex: '0' } });
  });
  const h = renderer();
  h.subject.beginRender(180000);
  const flags = { selected: false, showDelete: true };
  const make = (timeEntries: TaskSnapshot['timeEntries']) =>
    task({ markdownTitle: '[[A]]', timeEntries });
  const mount = h.subject.mount(document.body, make([]), [], flags);
  await mount.settled;
  const link = expectDefined(mount.element.querySelector('a'));
  link.focus();
  mount.update(
    make([{ relativeLine: 1, originalMarkdown: 'running', state: 'running', startMs: 0 }]),
    [],
    flags,
  );
  expect(mount.element.querySelector('.abyss-task-time-badge')?.textContent).toBe('3m');
  expect(
    mount.element.querySelector('.abyss-task-time-badge')?.classList.contains('is-tracking'),
  ).toBe(true);
  mount.update(
    make([
      { relativeLine: 1, originalMarkdown: 'closed', state: 'closed', startMs: 0, endMs: 60000 },
    ]),
    [],
    flags,
  );
  expect(mount.element.querySelector('.abyss-task-time-badge')?.textContent).toBe('1m');
  expect(
    mount.element.querySelector('.abyss-task-time-badge')?.classList.contains('is-tracking'),
  ).toBe(false);
  mount.update(
    make([
      { relativeLine: 1, originalMarkdown: 'closed', state: 'closed', startMs: 0, endMs: 120000 },
    ]),
    [],
    flags,
  );
  expect(mount.element.querySelector('.abyss-task-time-badge')?.textContent).toBe('2m');
  mount.update(make([]), [], flags);
  expect(mount.element.querySelector('.abyss-task-time-badge')).toBeNull();
  expect(document.activeElement).toBe(link);
  expect(link.isConnected).toBe(true);
  mount.destroy();
});

it.each([
  { region: 'title', focused: false },
  { region: 'desc', focused: false },
  { region: 'title', focused: true },
  { region: 'desc', focused: true },
])(
  'retires held $region link handlers on content replacement and destroy (focused=$focused)',
  async ({ region, focused }) => {
    vi.useFakeTimers();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      const destination = markdown.includes('New') ? 'New' : 'Old';
      holder.createEl('a', {
        cls: 'internal-link',
        text: destination,
        attr: { 'data-href': destination, href: destination },
      });
    });
    const h = renderer();
    const flags = { selected: false, showDelete: false };
    const mount = h.subject.mount(
      document.body,
      task({ markdownTitle: '[[Old]]', description: '[[Old]]' }),
      [],
      flags,
    );
    await vi.runAllTimersAsync();
    const link = () =>
      expectDefined(mount.element.querySelector<HTMLAnchorElement>(`.abyss-task-${region} a`));
    const old = link();
    if (focused) old.focus();
    mount.update(task({ markdownTitle: '[[New]]', description: '[[New]]' }), [], flags);
    await vi.runAllTimersAsync();
    if (focused) {
      expect(document.activeElement).toBe(old);
      expect(link()).toBe(old);
      old.dispatchEvent(new MouseEvent('click', { cancelable: true }));
      old.dispatchEvent(new MouseEvent('mouseover'));
      await Promise.resolve();
      expect(h.openLinkText).toHaveBeenCalledExactlyOnceWith('Old', 'f.md', false);
      expect(h.trigger).toHaveBeenCalledOnce();
      document.body.createEl('button').focus();
      await vi.runAllTimersAsync();
      h.openLinkText.mockClear();
      h.trigger.mockClear();
    }
    expect(old.isConnected).toBe(false);
    for (const type of ['click', 'mouseover', 'contextmenu']) {
      const event = new MouseEvent(type, { cancelable: true });
      old.dispatchEvent(event);
      expect.soft(event.defaultPrevented).toBe(false);
    }
    await Promise.resolve();
    expect.soft(h.openLinkText).not.toHaveBeenCalled();
    expect.soft(h.trigger).not.toHaveBeenCalled();
    h.openLinkText.mockClear();
    h.trigger.mockClear();
    const current = link();
    current.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    current.dispatchEvent(new MouseEvent('mouseover'));
    await Promise.resolve();
    expect(h.openLinkText).toHaveBeenCalledExactlyOnceWith('New', 'f.md', false);
    expect(h.trigger).toHaveBeenCalledOnce();
    mount.destroy();
    h.openLinkText.mockClear();
    h.trigger.mockClear();
    for (const type of ['click', 'mouseover', 'contextmenu']) {
      const event = new MouseEvent(type, { cancelable: true });
      current.dispatchEvent(event);
      expect.soft(event.defaultPrevented).toBe(false);
    }
    await Promise.resolve();
    expect.soft(h.openLinkText).not.toHaveBeenCalled();
    expect.soft(h.trigger).not.toHaveBeenCalled();
  },
);

it('does not acquire long-lived host link callbacks for eager card renders', async () => {
  vi.useFakeTimers();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
    holder.createEl('a', { cls: 'internal-link', text: 'Old', attr: { 'data-href': 'Old' } });
  });
  const h = renderer();
  const callbacks = vi.spyOn(h.hostComponent, 'registerDomEvent');
  for (let cycle = 0; cycle < 20; cycle++) {
    document.body.empty();
    h.subject.render(
      document.body,
      task({ markdownTitle: '[[Old]]', description: '[[Old]]' }),
      [],
      { selected: false, showDelete: false },
    );
    await vi.runAllTimersAsync();
  }
  expect(callbacks).not.toHaveBeenCalled();
  h.hostComponent.unload();
});

it.each([
  { description: 'Description stabilityprobe', displayed: 'Description stabilityprobe' },
  {
    description: 'Description summary\n  - > Later description',
    displayed: 'Description summary …',
  },
])(
  'cold-mounts plain Filter text without moving fields through the panel: $displayed',
  async ({ description, displayed }) => {
    const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
    const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
    const h = renderer();
    const canonical = await createCanonicalSearchHarness(
      {
        'a.md': `- [ ] STABILITYPROBE Root item\n  - > ${description}`,
      },
      h.settings,
    );
    const root = expectDefined(canonical.index.list()[0]);
    const panel = document.body.createDiv({ cls: 'abyss-panel-view' });
    const cards = panel.createDiv();
    const query = prepareSearchQuery('STABILITYPROBE Root', fallbackSearchWords);
    const observer = new MutationObserver(() => {});
    observer.observe(panel, { childList: true });
    const render = vi.spyOn(MarkdownRenderer, 'render');
    const mount = h.subject.mount(
      cards,
      root,
      [],
      { selected: false, showDelete: false },
      {
        mode: 'filter',
        query,
        segment: fallbackSearchWords,
        context: taskSearchContext(
          root,
          { epoch: 'test', rootId: 1, version: 1, childLines: [] },
          query,
          fallbackSearchWords,
        ),
        onActivate: vi.fn(),
      },
    );
    try {
      expect(observer.takeRecords()).toHaveLength(0);
      expect(mount.element.querySelector('.abyss-task-title')?.textContent).toBe(root.title);
      expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe(displayed);
      expect(await mount.settled).toEqual({ type: 'ready' });
      expect(observer.takeRecords()).toHaveLength(0);
      expect(render).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
      mount.destroy();
      canonical.close();
      h.hostComponent.unload();
    }
  },
);

it('mounts into the attached holder and receipts track only the current Markdown generation', async () => {
  const old = deferred<void>();
  const next = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation((_app, markdown, holder) => {
    holder.createSpan({ text: markdown });
    return markdown === '**old**'
      ? old.promise.then(() => {
          throw new Error('obsolete Markdown');
        })
      : next.promise;
  });
  const h = renderer();
  const holder = document.body.createDiv();
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mountInto(holder, task({ markdownTitle: '**old**' }), [], flags);
  expect(mount.element).toBe(holder);
  expect(holder.querySelector('.abyss-task-card')).toBeNull();
  const previous = mount.settled;
  mount.update(task({ markdownTitle: '**new**' }), [], flags);
  expect(await previous).toEqual({ type: 'cancelled' });
  const current = mount.settled;
  old.resolve();
  next.resolve();
  expect(await current).toEqual({ type: 'ready' });
  expect(holder.textContent).toContain('**new**');
  mount.destroy();
});

it('keeps the desired receipt pending until focused replacement commits', async () => {
  const h = renderer();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
    holder.createEl('a', { text: markdown, attr: { href: 'A', tabindex: '0' } });
  });
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, task({ markdownTitle: '[[A]]' }), [], flags);
  expect(await mount.settled).toEqual({ type: 'ready' });
  const link = expectDefined(mount.element.querySelector('a'));
  link.focus();
  mount.update(task({ markdownTitle: '[[B]]' }), [], flags);
  let ready = false;
  const receipt = mount.settled.then((outcome) => {
    ready = true;
    return outcome;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(link.isConnected).toBe(true);
  expect(link.textContent).toBe('[[A]]');
  link.blur();
  expect(await receipt).toEqual({ type: 'ready' });
  expect(link.isConnected).toBe(false);
  mount.destroy();
});

it('detaches a cancelled pending Markdown holder before the host can mutate it late', async () => {
  const held = deferred<void>();
  let textHolder: HTMLElement | undefined;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation((_app, _markdown, holder) => {
    textHolder = holder;
    return held.promise;
  });
  const h = renderer();
  const mount = h.subject.mount(document.body, task({ markdownTitle: '**pending**' }), [], {
    selected: false,
    showDelete: false,
  });
  const receipt = mount.settled;
  mount.update(task({ markdownTitle: 'Replacement' }), [], { selected: false, showDelete: false });
  expect(await receipt).toEqual({ type: 'cancelled' });
  expect(textHolder?.isConnected).toBe(false);
  textHolder?.createSpan({ text: 'late host output' });
  held.resolve();
  expect(await mount.settled).toEqual({ type: 'ready' });
  expect(mount.element.textContent).not.toContain('late host output');
  mount.destroy();
});

it('refreshes only root Search metadata and leaves descendant headers and recurrence filtering intact', async () => {
  const { createCanonicalSearchHarness } = await import('./support/taskSearchHarness');
  const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
  const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
  const h = renderer();
  const canonical = await createCanonicalSearchHarness(
    { 'a.md': '- [ ] root 🆔 needle-root 🔁 every day\n  - [ ] child 🆔 needle-child' },
    h.settings,
  );
  try {
    const root = expectDefined(canonical.index.list()[0]);
    const query = prepareSearchQuery('needle', fallbackSearchWords);
    const search = {
      mode: 'search' as const,
      context: taskSearchContext(
        root,
        { epoch: 'test', rootId: 1, version: 1, childLines: [] },
        query,
        fallbackSearchWords,
      ),
      query,
      segment: fallbackSearchWords,
      onActivate: () => {},
    };
    const flags = { selected: false, showDelete: false };
    const mount = h.subject.mount(document.body, root, [], flags, search);
    await mount.settled;
    mount.update(root, [], flags, search);
    await mount.settled;
    expect(mount.element.querySelectorAll('.abyss-task-meta-right')).toHaveLength(2);
    expect(
      mount.element.querySelector('.abyss-subtask-row > .abyss-task-meta-right')?.textContent,
    ).toBe('needle-child');
    expect(
      mount.element.querySelector(':scope > .abyss-task-card-main-row > .abyss-task-meta-right')
        ?.textContent,
    ).toContain('needle-root');
    expect(mount.element.querySelectorAll('.abyss-task-source-note')).toHaveLength(1);
    expect(mount.element.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(0);
    mount.destroy();
  } finally {
    canonical.close();
    h.hostComponent.unload();
  }
});

it.each(['mount', 'render'] as const)(
  'places %s search descendants outside the root body and retains base evidence',
  async (entry) => {
    const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
    const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
      holder.setText(text);
    });
    const h = renderer();
    const canonical = await createCanonicalSearchHarness(
      {
        'a.md':
          '- [ ] needle root #needle-root\n  - > needle base description\n  - [ ] needle child #needle-child\n    - > needle child description\n    - [ ] needle grandchild #needle-grandchild',
      },
      h.settings,
    );
    try {
      const root = expectDefined(canonical.index.list()[0]);
      const query = prepareSearchQuery('needle', fallbackSearchWords);
      const search = {
        mode: 'search' as const,
        context: taskSearchContext(
          root,
          { epoch: 'test', rootId: 1, version: 1, childLines: [] },
          query,
          fallbackSearchWords,
        ),
        query,
        segment: fallbackSearchWords,
        onActivate: () => {},
      };
      const flags = { selected: false, showDelete: false, search };
      const mount = entry === 'mount' ? h.subject.mount(document.body, root, [], flags) : undefined;
      const card = mount?.element ?? h.subject.render(document.body, root, [], flags);
      await mount?.settled;
      const rootMain = expectDefined(card.querySelector(':scope > .abyss-task-card-main-row'));
      expect(rootMain.querySelector('.abyss-subtask-row')).toBeNull();
      expect(rootMain.querySelector('.abyss-task-desc')?.textContent).toBe(
        'needle base description',
      );
      expect(card.querySelectorAll('.abyss-subtask-row')).toHaveLength(2);
      expect(card.querySelectorAll('.abyss-task-meta-right')).toHaveLength(3);
      if (mount !== undefined) {
        mount.update(root, [], flags);
        expect(await mount.settled).toEqual({ type: 'ready' });
        expect(card.querySelectorAll('.abyss-subtask-row')).toHaveLength(2);
        mount.update(root, [], { selected: false, showDelete: false });
        expect(await mount.settled).toEqual({ type: 'ready' });
        expect(card.querySelector('.abyss-search-context')).toBeNull();
        expect(rootMain.querySelector('.abyss-task-body > .abyss-task-desc')?.textContent).toBe(
          'needle base description',
        );
        mount.destroy();
      }
    } finally {
      canonical.close();
      h.hostComponent.unload();
    }
  },
);

it.each([
  { entry: 'mount', mode: 'search' },
  { entry: 'mount', mode: 'filter' },
  { entry: 'render', mode: 'search' },
  { entry: 'render', mode: 'filter' },
] as const)(
  'omits empty $entry $mode context and restores populated context across query changes',
  async ({ entry, mode }) => {
    const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
    const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
    const h = renderer();
    const canonical = await createCanonicalSearchHarness(
      {
        'a.md':
          '- [ ] rootneedle\n  - > rootneedle description\n  - 2026-10-04: commentneedle\n  - [ ] childneedle',
      },
      h.settings,
    );
    try {
      const root = expectDefined(canonical.index.list()[0]);
      const searchFor = (text: string) => {
        const query = prepareSearchQuery(text, fallbackSearchWords);
        return {
          mode,
          context: taskSearchContext(
            root,
            { epoch: 'test', rootId: 1, version: 1, childLines: [] },
            query,
            fallbackSearchWords,
          ),
          query,
          segment: fallbackSearchWords,
          onActivate: () => {},
        };
      };
      const flags = { selected: false, showDelete: false };
      const container = document.body.createDiv();
      const mount =
        entry === 'mount'
          ? h.subject.mount(container, root, [], flags, searchFor('rootneedle'))
          : undefined;
      const renderQuery = async (query: string) => {
        if (mount !== undefined) {
          mount.update(root, [], flags, searchFor(query));
          await mount.settled;
          return mount.element;
        }
        container.empty();
        return h.subject.render(container, root, [], { ...flags, search: searchFor(query) });
      };
      let retainedHost: Element | undefined;
      for (const [query, children, comments] of [
        ['rootneedle', 0, 0],
        ['childneedle', 1, 0],
        ['rootneedle', 0, 0],
        ['commentneedle', 0, 1],
        ['rootneedle', 0, 0],
        ['childneedle', 1, 0],
      ] as const) {
        const card = await renderQuery(query);
        const host = card.querySelector(':scope > .abyss-search-contexts');
        if (query === 'rootneedle') {
          expect(host).toBeNull();
          expect(card.children).toHaveLength(1);
          expect(card.querySelector('.abyss-task-body .abyss-task-desc')?.textContent).toBe(
            'rootneedle description',
          );
          if (retainedHost !== undefined) expect(retainedHost.isConnected).toBe(false);
        } else {
          const context = expectDefined(host);
          expect(context.querySelectorAll('.abyss-subtask-row')).toHaveLength(children);
          expect(context.querySelectorAll('.abyss-comment-row')).toHaveLength(comments);
          if (mount !== undefined) {
            retainedHost ??= context;
            expect(context).toBe(retainedHost);
          }
        }
      }
      mount?.destroy();
    } finally {
      canonical.close();
      h.hostComponent.unload();
    }
  },
);

it.each(['base', 'child'] as const)(
  'retains focused %s search evidence across source refresh until focus leaves both hosts',
  async (region) => {
    const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
    const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
      holder.createEl('a', { text, attr: { href: 'Needle', tabindex: '0' } });
    });
    const h = renderer();
    const canonical = await createCanonicalSearchHarness(
      { 'a.md': '- [ ] root\n  - > [[Needle]] base\n  - [ ] child\n    - > [[Needle]] child' },
      h.settings,
    );
    try {
      const root = expectDefined(canonical.index.list()[0]);
      const query = prepareSearchQuery('needle', fallbackSearchWords);
      const searchFor = (root: TaskSnapshot) => ({
        mode: 'search' as const,
        context: taskSearchContext(
          root,
          { epoch: 'test', rootId: 1, version: 1, childLines: [] },
          query,
          fallbackSearchWords,
        ),
        query,
        segment: fallbackSearchWords,
        onActivate: () => {},
      });
      const flags = { selected: false, showDelete: false };
      const mount = h.subject.mount(document.body, root, [], flags, searchFor(root));
      expect(await mount.settled).toEqual({ type: 'ready' });
      const baseLink = expectDefined(
        mount.element.querySelector<HTMLElement>(
          ':scope > .abyss-task-card-main-row .abyss-task-desc a',
        ),
      );
      const childLink = expectDefined(
        mount.element.querySelector<HTMLElement>('.abyss-subtask-row .abyss-task-desc a'),
      );
      const focused = region === 'base' ? baseLink : childLink;
      focused.focus();
      const refreshed = { ...root, description: 'New needle base' };
      mount.update(refreshed, [], flags, searchFor(refreshed));
      let ready = false;
      const receipt = mount.settled.then((outcome) => {
        ready = true;
        return outcome;
      });
      await Promise.resolve();
      await Promise.resolve();
      if (region === 'base') expect(ready).toBe(false);
      expect(focused.isConnected).toBe(true);
      expect(document.activeElement).toBe(focused);
      if (region === 'child') expect(childLink.isConnected).toBe(true);
      document.body.createEl('button').focus();
      expect(await receipt).toEqual({ type: 'ready' });
      expect(focused.isConnected).toBe(region === 'child');
      expect(
        mount.element.querySelector(':scope > .abyss-task-card-main-row .abyss-task-desc')
          ?.textContent,
      ).toBe('New needle base');
      expect(mount.element.querySelectorAll('.abyss-subtask-row')).toHaveLength(1);
      expect(mount.element.querySelectorAll('.abyss-task-meta-right')).toHaveLength(2);
      mount.destroy();
    } finally {
      canonical.close();
      h.hostComponent.unload();
    }
  },
);

it.each([false, true])(
  'changes and clears highlight on a reused card and retains link behavior (focused=%s)',
  async (focused) => {
    const { prepareSearchQuery } = await import('../src/tasks');
    const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
    const h = renderer();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _source, holder) => {
      holder.createEl('a', {
        cls: 'internal-link',
        text: 'Budget',
        attr: { 'data-href': 'Budget', href: 'Budget' },
      });
      holder.appendText(' ledger');
    });
    const root = task({ markdownTitle: '[[Budget]] ledger', title: 'Budget ledger' });
    const flags = { selected: false, showDelete: false };
    const highlight = (query: string) => ({
      query: prepareSearchQuery(query, fallbackSearchWords),
      segment: fallbackSearchWords,
    });
    const mount = h.subject.mount(document.body, root, [], {
      ...flags,
      highlight: highlight('budget'),
    });
    try {
      await mount.settled;
      expect(mount.element.querySelector('a mark')?.textContent).toBe('Budget');
      const anchor = expectDefined(mount.element.querySelector('a'));
      anchor.click();
      await Promise.resolve();
      expect(h.openLinkText).toHaveBeenCalled();
      if (focused) anchor.focus();
      mount.update(root, [], { ...flags, highlight: highlight('ledger') });
      if (focused) {
        expect(mount.element.querySelector('a')).toBe(anchor);
        expect(anchor.querySelector('mark')).toBeNull();
        document.body.createEl('button').focus();
      }
      await mount.settled;
      expect(mount.element.querySelector('a mark')).toBeNull();
      expect(mount.element.querySelector('mark')?.textContent).toBe('ledger');
      mount.update(root, [], flags);
      await mount.settled;
      expect(mount.element.querySelector('mark')).toBeNull();
      expect(mount.element.querySelector('.abyss-task-title')?.textContent).toBe('Budget ledger');
    } finally {
      mount.destroy();
      h.hostComponent.unload();
    }
  },
);

it.each(['due', 'scheduled'] as const)(
  'keeps Today time visible and filterable for %s membership',
  (field) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 13, 12));
    const h = renderer();
    h.state.set('selectedList', 'today');
    h.settings.sourceNoteDisplay = 'never';
    const candidate = task({
      planning: {
        due: field === 'due' ? '2026-07-13' : '2026-07-20',
        ...(field === 'scheduled' ? { scheduled: '2026-07-13' } : {}),
        time: '09:00',
      },
    });
    const mount = h.subject.mount(document.body, candidate, [], {
      selected: false,
      showDelete: false,
    });
    const meta = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-task-meta-right'));
    expect(meta.textContent).toBe('09:00');
    expectDefined(meta.querySelector<HTMLElement>('.abyss-task-date')).click();
    expect(h.listControls.addPropertyFilter).toHaveBeenCalledWith({ type: 'time', value: '09:00' });
    mount.destroy();
  },
);

it('keeps dependency decoration inside the title on initial and retained rendering', () => {
  const h = renderer();
  h.dependenciesFor.mockReturnValue({
    blockedBy: [],
    blocks: [],
    activeBlockedByCount: 1,
    activeBlocksCount: 0,
  });
  const original = task({ description: 'Body' });
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, original, [], flags);
  const titleRow = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-task-title-row'));
  expect(mount.element.querySelector('.abyss-dep-indicator')?.parentElement).toBe(titleRow);
  expect(
    mount.element
      .querySelector('.abyss-task-body')
      ?.previousElementSibling?.matches('.abyss-status-control'),
  ).toBe(true);
  mount.update(task({ description: 'Body', status: 'done', statusSymbol: 'x' }), [], flags);
  expect(mount.element.querySelectorAll('.abyss-dep-indicator')).toHaveLength(1);
  expect(mount.element.querySelector('.abyss-dep-indicator')?.parentElement).toBe(titleRow);
  expect(mount.element.querySelector('.abyss-dep-indicator')?.hasAttribute('title')).toBe(false);
  mount.destroy();
  const legacy = h.subject.render(document.body, original, [], flags);
  expect(
    legacy.querySelector('.abyss-dep-indicator')?.parentElement?.matches('.abyss-task-title-row'),
  ).toBe(true);
});

it('renders own child metadata and retains parent controls until their owner unloads', async () => {
  const source = await createCanonicalSearchHarness(
    {
      'tree.md':
        '- [ ] Grandparent #one-off\n  - [ ] Parent #private\n    - [/] Same #inbox 📅 2026-10-08\n  - [ ] Same #inbox 📅 2026-10-08',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const h = renderer();
  try {
    h.state.set('selectedList', 'inbox');
    const projection = expectDefined(
      source.index.listNodes().find((task) => task.path.length === 2),
    );
    const flags = { selected: false, showDelete: true, projection };
    const mount = h.subject.mount(document.body, projection.root, [], flags);
    expect(mount.element.querySelector('.abyss-task-title')?.textContent).toBe('Same');
    expect(mount.element.querySelector('.abyss-task-tag')?.textContent).toBe('#inbox');
    expect(mount.element.querySelector('.abyss-task-date')?.textContent).toContain('2026-10-08');
    expect(
      mount.element.querySelector('.abyss-status-marker')?.getAttribute('data-status-type'),
    ).toBe('in-progress');
    expect(mount.element.dataset['line']).toBe('2');
    expect(mount.element.className).toBe('abyss-task-card');
    expectDefined(mount.element.querySelector<HTMLElement>('.abyss-status-marker')).click();
    expect(h.toggleTask).toHaveBeenCalledWith(projection.node, undefined);
    const button = expectDefined(
      mount.element.querySelector<HTMLButtonElement>('.abyss-task-parent-btn'),
    );
    expect(button.getAttribute('aria-label')).toContain('Parent');
    expect(button.closest('.abyss-task-count-badge')).toBeNull();
    button.click();
    const request = h.showTaskInList.mock.calls[0]?.[1];
    expect(request?.signal.aborted).toBe(false);
    mount.update(projection.root, [], flags);
    expect(request?.signal.aborted).toBe(false);
    expect(mount.element.querySelector('.abyss-task-parent-btn')).toBe(button);
    expect(h.showTaskInList).toHaveBeenCalledTimes(1);
    const replacement = expectDefined(
      mount.element.querySelector<HTMLButtonElement>('.abyss-task-parent-btn'),
    );
    replacement.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    const next = h.showTaskInList.mock.calls[1]?.[1];
    const sibling = expectDefined(
      source.index.listNodes().find((task) => task.path.length === 1 && task.node.title === 'Same'),
    );
    expect(() => {
      mount.update(sibling.root, [], { ...flags, projection: sibling });
    }).toThrow('different source');
    mount.destroy();
    expect(next?.signal.aborted).toBe(true);
  } finally {
    source.close();
    h.hostComponent.unload();
  }
});

it('ticks root and child badges using their own subtree totals', async () => {
  const source = await createCanonicalSearchHarness(
    {
      'tree.md':
        '- [ ] Root\n  - 2026-10-04T10:00:00+07:00 → 2026-10-04T10:05:00+07:00\n  - [ ] Child\n    - 2026-10-04T10:05:00+07:00 →',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const h = renderer();
  const mounts = [];
  try {
    h.subject.beginRender(Date.parse('2026-10-04T10:10:00+07:00'));
    for (const projection of source.index.listNodes())
      mounts.push(
        h.subject.mount(document.body, projection.root, [], {
          selected: false,
          showDelete: false,
          projection,
        }),
      );
    expect(
      mounts.map((m) => m.element.querySelector('.abyss-task-time-badge span')?.textContent),
    ).toEqual(['10m', '5m']);
    h.subject.paintTracking({
      nowMs: Date.parse('2026-10-04T10:11:00+07:00'),
      active: source.index.activeEntries(),
    });
    expect(
      mounts.map((m) => m.element.querySelector('.abyss-task-time-badge span')?.textContent),
    ).toEqual(['11m', '6m']);
  } finally {
    mounts.forEach((m) => {
      m.destroy();
    });
    source.close();
    h.hostComponent.unload();
  }
});

it.each([
  ['first', '2026-10-07', 'continuation'],
  ['middle', '2026-10-08', 'continuation'],
  ['terminal future', '2026-10-09', 'allowed'],
  ['overdue', '2026-10-09', 'allowed'],
] as const)(
  'preserves full range metadata and status identity on the %s row',
  (_name, date, kind) => {
    const h = renderer();
    const original = task({
      statusSymbol: '/',
      status: 'in-progress',
      priority: 'A',
      planning: { start: '2026-10-07', due: '2026-10-09' },
    });
    const occurrence: TaskOccurrencePresentation = {
      kind: 'daily',
      displayDate: localDate(date),
      interval: { start: localDate('2026-10-07'), due: localDate('2026-10-09') },
      completion: kind === 'allowed' ? { kind } : { kind, due: localDate('2026-10-09') },
    };
    const mount = h.subject.mount(document.body, original, [], {
      selected: false,
      showDelete: false,
      occurrence,
    });
    const marker = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-status-marker'));
    const control = expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]'));
    expect(marker.dataset['statusType']).toBe('in-progress');
    expect(marker.dataset['priority']).toBe('A');
    expect(control.getAttribute('aria-label')).toContain('Task status: In progress');
    expect(mount.element.querySelector('.abyss-task-date')?.textContent).toContain(
      '2026-10-07–2026-10-09',
    );
    expect(mount.element.querySelector('.abyss-date-icon svg')).not.toBeNull();
    expect(marker.hasClass('abyss-status-marker--continuation')).toBe(kind === 'continuation');
    control.click();
    if (kind === 'continuation') {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.getAttribute('aria-label')).toContain(
        'Complete from the row for 2026-10-09, or in the task details.',
      );
      for (const key of [' ', 'Enter'])
        control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      expect(h.toggleTask).not.toHaveBeenCalled();
    } else expect(h.toggleTask).toHaveBeenCalledExactlyOnceWith(original, occurrence.completion);
    control.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(h.openStatusMenu).toHaveBeenCalledWith(
      expect.any(MouseEvent),
      original,
      occurrence.completion,
    );
    mount.destroy();
  },
);

it('retains range metadata in Today and updates both independent blocking explanations', () => {
  const h = renderer();
  h.state.set('selectedList', 'today');
  h.dependenciesFor.mockReturnValue({
    blockedBy: [],
    blocks: [],
    activeBlockedByCount: 1,
    activeBlocksCount: 0,
  });
  const original = task({ planning: { start: '2026-10-07', due: '2026-10-09' } });
  const flags = {
    selected: false,
    showDelete: false,
    occurrence: {
      kind: 'today' as const,
      displayDate: localDate('2026-10-08'),
      interval: { start: localDate('2026-10-07'), due: localDate('2026-10-09') },
      completion: { kind: 'continuation' as const, due: localDate('2026-10-09') },
    },
  };
  const mount = h.subject.mount(document.body, original, [], flags);
  const control = expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]'));
  expect(control.getAttribute('aria-label')).toContain('Complete prerequisite tasks');
  expect(control.getAttribute('aria-label')).toContain('Complete from the row for');
  expect(
    mount.element.querySelector('.abyss-status-marker--blocked.abyss-status-marker--continuation'),
  ).not.toBeNull();
  control.focus();
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(h.toggleTask).not.toHaveBeenCalled();
  mount.update(original, [], {
    ...flags,
    occurrence: { ...flags.occurrence, completion: { kind: 'allowed' } },
  });
  expect(document.activeElement).toBe(control);
  expect(control.getAttribute('aria-label')).not.toContain('Complete from the row for');
  expect(control.getAttribute('aria-label')).toContain('Complete prerequisite tasks');
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(h.toggleTask).toHaveBeenCalledOnce();
  mount.destroy();
});

it.each([
  ['equal', '2026-10-09', '2026-10-09', true],
  ['inverted', '2026-10-10', '2026-10-09', false],
] as const)(
  'keeps %s endpoint actions ordinary and only valid interval metadata',
  (_name, start, due, valid) => {
    const h = renderer();
    h.state.set('selectedList', 'upcoming');
    const original = task({ planning: { start, due } });
    const occurrence: TaskOccurrencePresentation = {
      kind: 'daily',
      displayDate: localDate(due),
      completion: { kind: 'allowed' },
      ...(valid ? { interval: { start: localDate(start), due: localDate(due) } } : {}),
    };
    const mount = h.subject.mount(document.body, original, [], {
      selected: false,
      showDelete: false,
      occurrence,
    });
    expect(mount.element.querySelector('.abyss-task-date')?.textContent).toBe(
      valid ? '2026-10-09–2026-10-09' : '2026-10-09',
    );
    expect(mount.element.querySelector('.abyss-status-marker--continuation')).toBeNull();
    expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]')).click();
    expect(h.toggleTask).toHaveBeenCalledExactlyOnceWith(original, { kind: 'allowed' });
    mount.destroy();
  },
);

it.each([undefined, { kind: 'node' as const, completion: { kind: 'allowed' as const } }])(
  'keeps full valid ranges and allowed markers on ordinary nondate cards (%j)',
  (occurrence) => {
    const h = renderer();
    const original = task({ planning: { start: '2026-10-07', due: '2026-10-09' } });
    h.state.set('selectedList', 'inbox');
    const mount = h.subject.mount(document.body, original, [], {
      selected: false,
      showDelete: false,
      ...(occurrence === undefined ? {} : { occurrence }),
    });
    expect(mount.element.querySelector('.abyss-task-date')?.textContent).toBe(
      '2026-10-07–2026-10-09',
    );
    expect(mount.element.querySelector('[aria-disabled=true]')).toBeNull();
    expectDefined(mount.element.querySelector<HTMLElement>('[role=checkbox]')).click();
    expect(h.toggleTask).toHaveBeenCalledExactlyOnceWith(original, occurrence?.completion);
    mount.destroy();
  },
);

it('renders the contributed point date for an inverted range without an interval glyph', () => {
  const h = renderer();
  h.state.set('selectedList', 'upcoming');
  const original = task({ planning: { start: '2026-10-10', due: '2026-10-09' } });
  const mount = h.subject.mount(document.body, original, [], {
    selected: false,
    showDelete: false,
    occurrence: {
      kind: 'daily',
      displayDate: localDate('2026-10-10'),
      completion: { kind: 'allowed' },
    },
  });
  expect(mount.element.querySelector('.abyss-task-date')?.textContent).toBe('2026-10-10');
  expect(mount.element.querySelector('.abyss-status-marker--continuation')).toBeNull();
  mount.destroy();
});

it('disposes inclusion and exclusion tag listeners on metadata refresh and mount retirement', () => {
  const h = renderer();
  const mount = h.subject.mount(document.body, task({ tags: ['#Work'] }), [], {
    selected: false,
    showDelete: false,
  });
  const oldTag = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-task-tag'));
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  oldTag.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(h.listControls.addPropertyFilter).toHaveBeenCalledWith({
    type: 'tag-exclude',
    value: '#Work',
  });
  oldTag.click();
  expect(h.listControls.addPropertyFilter).toHaveBeenLastCalledWith({
    type: 'tag',
    value: '#Work',
  });
  mount.update(task({ tags: ['#Work/deep'] }), [], { selected: false, showDelete: false });
  h.listControls.addPropertyFilter.mockClear();
  oldTag.click();
  oldTag.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
  expect(h.listControls.addPropertyFilter).not.toHaveBeenCalled();
  const tag = expectDefined(mount.element.querySelector<HTMLElement>('.abyss-task-tag'));
  tag.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(h.listControls.addPropertyFilter).toHaveBeenCalledWith({
    type: 'tag-exclude',
    value: '#Work/deep',
  });
  mount.destroy();
  h.listControls.addPropertyFilter.mockClear();
  tag.click();
  tag.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
  expect(h.listControls.addPropertyFilter).not.toHaveBeenCalled();
  h.hostComponent.unload();
});

it('keeps exact roots and children after clicking their rendered interval endpoints', async () => {
  const h = renderer(true);
  const source = await createCanonicalSearchHarness(
    {
      'dates.md': [
        '- [ ] Same #keep 🛫 2026-10-09 📅 2026-10-11',
        '- [ ] Same #keep 📅 2026-10-14',
        '  - [ ] Same #keep 🛫 2026-10-09 📅 2026-10-13',
        '  - [ ] Same 🛫 2026-10-09 📅 2026-10-13',
      ].join('\n'),
    },
    h.settings,
  );
  const nodes = source.index.listNodes();
  const selection = { type: 'tag' as const, tag: '#keep' };
  h.state.set('selectedList', selection);
  try {
    for (const [index, endpoint, date] of [
      [0, 0, '2026-10-09'],
      [0, 1, '2026-10-11'],
      [2, 0, '2026-10-09'],
      [2, 1, '2026-10-13'],
    ] as const) {
      h.state.set('centerListViewState', {
        groupBy: 'none',
        sortBy: { field: 'date', dir: 'asc' },
        filters: [],
      });
      const projection = expectDefined(nodes[index]);
      const mount = h.subject.mount(document.body, projection.root, [], {
        selected: false,
        showDelete: false,
        projection,
      });
      try {
        expectDefined(
          mount.element.querySelectorAll<HTMLElement>('.abyss-task-date-part')[endpoint],
        ).click();
        const viewState = h.state.get('centerListViewState');
        expect(viewState.filters).toEqual([{ type: 'date', value: date }]);
        const selected = selectTaskNodes({
          tasks: nodes,
          selection,
          viewState,
          settings: h.settings,
          today: localDate('2026-10-09'),
          nowMs: 0,
        });
        expect(selected).toContain(projection);
        expect(selected).not.toContain(nodes[1]);
        expect(selected).not.toContain(nodes[3]);
      } finally {
        mount.destroy();
      }
    }
  } finally {
    source.close();
    h.hostComponent.unload();
  }
});

it('mounts Analysis children as native cards with exact status commands and parent context', async () => {
  const source = await createCanonicalSearchHarness(
    {
      'tree.md':
        '- [ ] Unmatched parent\n  - [/] First ➕ 2026-10-01\n  - [ ] Second ➕ 2026-10-01',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const h = renderer();
  const selected = vi.fn<(stack: TaskSelectionNode[]) => void>();
  const container = document.body.createDiv();
  const stop = source.index.subscribeStatistics(() => {});
  await source.index.whenStatisticsSettled();
  const snapshot = source.index.readStatistics();
  const model = expectDefined(
    await new StatisticsSession(
      expectDefined(await prepareStatisticsDataset(snapshot, [], work)),
    ).view(request(), work),
  );
  const evidence = new StatisticsEvidence(source.index, source.index, {
    renderNode: (host, projection, activate) =>
      h.subject.mount(host, projection.root, [], {
        projection,
        selected: false,
        showDelete: false,
        onActivate: activate,
        isCurrent: () => source.index.resolve(projection.root.ref).type === 'exact',
      }),
    select: selected,
    openSource: async () => {},
  });
  try {
    evidence.render(container, model, { id: 'created', label: 'Created' }, () => {});
    const cards = [...container.querySelectorAll<HTMLElement>('.abyss-task-card')];
    const firstCard = expectDefined(cards[0]),
      secondCard = expectDefined(cards[1]);
    expect(cards.map((card) => card.querySelector('.abyss-task-title')?.textContent)).toEqual([
      'First',
      'Second',
    ]);
    expect(firstCard.querySelector('.abyss-status-marker')?.getAttribute('data-status-type')).toBe(
      'in-progress',
    );
    expect(secondCard.querySelector('.abyss-status-marker')?.getAttribute('data-status-type')).toBe(
      'todo',
    );
    expect(container.textContent).not.toContain('Select matched subtask');
    const first = expectDefined(
      source.index.listNodes().find((node) => node.node.title === 'First'),
    );
    const status = expectDefined(firstCard.querySelector<HTMLElement>('.abyss-status-marker'));
    status.click();
    expect(h.toggleTask).toHaveBeenCalledWith(first.node, undefined);
    expectDefined(firstCard.querySelector<HTMLElement>('.abyss-task-parent-btn')).click();
    expect(h.showTaskInList.mock.calls[0]?.[0]).toEqual({ type: 'task', ref: first.root.ref });
    const oldActivation = h.context()?.onActivate;
    oldActivation?.(first.root);
    expect(selected.mock.calls[0]?.[0].map((node) => node.title)).toEqual([
      'Unmatched parent',
      'Second',
    ]);
    source.index.installCommittedContent(
      'tree.md',
      '- [ ] Replacement\n  - [/] First ➕ 2026-10-01\n  - [ ] Second ➕ 2026-10-01',
    );
    await source.index.whenStatisticsSettled();
    status.click();
    oldActivation?.(first.root);
    expect(h.toggleTask).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('changed or was removed');
    evidence.clear();
    expect(container.querySelectorAll('.abyss-task-card')).toHaveLength(0);
    expect(h.unbound).toHaveBeenCalledTimes(2);
  } finally {
    evidence.destroy();
    stop();
    source.close();
    h.hostComponent.unload();
    container.remove();
  }
});

it('commits changed tree fields together after the last focused replacement can publish', async () => {
  const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
  const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
  const { mockReadingView } = await import('./support/linkEditHarness');
  mockReadingView();
  const canonical = await createCanonicalSearchHarness(
    {
      'a.md':
        '- [ ] Root\n  - > [base needle](https://base.example)\n  - [ ] Child\n    - > [child needle](https://child.example)',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const h = renderer();
  const root = expectDefined(canonical.index.list()[0]);
  const query = prepareSearchQuery('needle', fallbackSearchWords);
  const search = (root: TaskSnapshot) => ({
    mode: 'search' as const,
    query,
    segment: fallbackSearchWords,
    context: taskSearchContext(
      root,
      { epoch: 'test', rootId: 1, version: 1, childLines: [] },
      query,
      fallbackSearchWords,
    ),
    onActivate: () => {},
  });
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(document.body, root, [], flags, search(root));
  try {
    await mount.settled;
    const base = expectDefined(
      mount.element.querySelector('.abyss-task-card-main-row .abyss-task-desc a'),
    );
    const child = expectDefined(
      mount.element.querySelector<HTMLAnchorElement>('.abyss-subtask-row .abyss-task-desc a'),
    );
    child.focus();
    const next = {
      ...root,
      description: 'New base needle',
      subtasks: [{ ...expectDefined(root.subtasks[0]), description: 'New child needle' }],
    };
    mount.update(next, [], flags, search(next));
    let complete = false;
    const receipt = mount.settled.then((outcome) => {
      complete = true;
      return outcome;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(base.isConnected).toBe(true);
    expect(child.isConnected).toBe(true);
    child.blur();
    expect(await receipt).toEqual({ type: 'ready' });
    expect(base.isConnected).toBe(false);
    expect(child.isConnected).toBe(false);
    expect(mount.element.textContent).toContain('New base needle');
    expect(mount.element.textContent).toContain('New child needle');
  } finally {
    mount.destroy();
    canonical.close();
    h.hostComponent.unload();
  }
});

it('keeps direct title and description unchanged until delayed rendering and focus both permit commit', async () => {
  const { mockReadingView } = await import('./support/linkEditHarness');
  mockReadingView();
  const h = renderer();
  const flags = { selected: false, showDelete: false };
  const mount = h.subject.mount(
    document.body,
    task({
      markdownTitle: '[old title](https://title.example)',
      description: '[old description](https://description.example)',
    }),
    [],
    flags,
  );
  const held = deferred<void>();
  try {
    await mount.settled;
    const title = expectDefined(mount.element.querySelector('.abyss-task-title a'));
    const description = expectDefined(
      mount.element.querySelector<HTMLAnchorElement>('.abyss-task-desc a'),
    );
    description.focus();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      if (markdown === '*new title*') await held.promise;
      holder.setText(markdown);
    });
    mount.update(
      task({ markdownTitle: '*new title*', description: '*new description*' }),
      [],
      flags,
    );
    let complete = false;
    const receipt = mount.settled.then((outcome) => {
      complete = true;
      return outcome;
    });
    held.resolve();
    await flushMicrotasks(30);
    expect(complete).toBe(false);
    expect(mount.element.querySelector('.abyss-task-title a')).toBe(title);
    expect(mount.element.querySelector('.abyss-task-desc a')).toBe(description);
    expect(document.activeElement).toBe(description);
    description.blur();
    expect(await receipt).toEqual({ type: 'ready' });
    expect(mount.element.querySelector('.abyss-task-title')?.textContent).toBe('*new title*');
    expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe('*new description*');
  } finally {
    held.resolve();
    mount.destroy();
    h.hostComponent.unload();
  }
});

it('does not report direct fields ready when synchronous owner cleanup revokes commit authority', async () => {
  let current = true;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
    async (...[_app, markdown, holder, _path, owner]) => {
      holder.setText(markdown);
      if (markdown === '*old title*')
        owner.register(() => {
          current = false;
        });
    },
  );
  const h = renderer();
  const flags = { selected: false, showDelete: false, isCurrent: () => current };
  const mount = h.subject.mount(
    document.body,
    task({ markdownTitle: '*old title*', description: '*old description*' }),
    [],
    flags,
  );
  try {
    expect(await mount.settled).toEqual({ type: 'ready' });
    mount.update(
      task({ markdownTitle: '*new title*', description: '*new description*' }),
      [],
      flags,
    );
    let complete = false;
    const receipt = mount.settled.then((outcome) => {
      complete = true;
      return outcome;
    });
    await flushMicrotasks(30);
    expect(current).toBe(false);
    expect(complete).toBe(false);
    expect(mount.element.querySelector('.abyss-task-desc')?.textContent).toBe('*old description*');
    mount.destroy();
    expect(await receipt).toEqual({ type: 'cancelled' });
  } finally {
    mount.destroy();
    h.hostComponent.unload();
  }
});

it('stops tree reconciliation when synchronous owner cleanup revokes a field commit', async () => {
  const { mountTaskSearchTree } = await import('../src/panels/center/TaskSearchTree');
  const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
  const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
  let current = true;
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
    async (...[_app, markdown, holder, _path, owner]) => {
      holder.setText(markdown);
      if (markdown === '*old title*')
        owner.register(() => {
          current = false;
        });
    },
  );
  const canonical = await createCanonicalSearchHarness(
    {
      'a.md':
        '- [ ] Root\n  - [ ] *old title*\n    - > *old title description*\n  - [ ] spare title',
    },
    structuredClone(DEFAULT_SETTINGS),
  );
  const root = expectDefined(canonical.index.list()[0]);
  const owner = new Component();
  owner.load();
  const host = document.body.createDiv();
  const base = document.body.createDiv();
  const query = prepareSearchQuery('title', fallbackSearchWords);
  const options = (root: TaskSnapshot) => ({
    app: {} as App,
    root,
    base: root,
    search: {
      mode: 'search' as const,
      query,
      segment: fallbackSearchWords,
      context: taskSearchContext(
        root,
        { epoch: 'test', rootId: 1, version: 1, childLines: [] },
        query,
        fallbackSearchWords,
      ),
      onActivate: () => {},
    },
    textOptions: { component: owner, isCurrent: () => current },
    track: () => {},
    editLink: () => {},
    onChildContextMenu: () => {},
    renderChildStatus: () => {},
    metadataKey: () => '',
    renderMetadata: () => {},
  });
  const tree = mountTaskSearchTree(host, base, options(root));
  try {
    expect(await tree.settled).toEqual({ type: 'ready' });
    const sibling = expectDefined(host.querySelectorAll('.abyss-subtask-label')[1]);
    const next = {
      ...root,
      subtasks: [
        {
          ...expectDefined(root.subtasks[0]),
          markdownTitle: '*new title*',
          description: '*new title description*',
        },
      ],
    };
    tree.update(options(next));
    let complete = false;
    const receipt = tree.settled.then((outcome) => {
      complete = true;
      return outcome;
    });
    await flushMicrotasks(30);
    expect(current).toBe(false);
    expect(complete).toBe(false);
    expect(sibling.isConnected).toBe(true);
    expect(host.querySelector('.abyss-task-desc')?.textContent).toBe('*old title description*');
    tree.destroy();
    expect(await receipt).toEqual({ type: 'cancelled' });
  } finally {
    tree.destroy();
    owner.unload();
    host.remove();
    base.remove();
    canonical.close();
  }
});

it.each([
  {
    field: 'comment',
    source: '- 2026-10-04: [bravo](https://example.com)',
    selector: '.abyss-comment-text',
  },
  {
    field: 'description',
    source: '- > [bravo](https://example.com)',
    selector: '.abyss-task-desc',
  },
])(
  'releases a cancelled new $field listener before its entry retires',
  async ({ source, selector }) => {
    const { taskSearchContext, prepareSearchQuery } = await import('../src/tasks');
    const { fallbackSearchWords } = await import('../src/tasks/domain/searchMatchPolicy');
    const h = renderer();
    const canonical = await createCanonicalSearchHarness(
      { 'a.md': `- [ ] Root\n  - [ ] branchlong\n    ${source}` },
      h.settings,
    );
    const root = expectDefined(canonical.index.list()[0]);
    const onActivate = vi.fn();
    const search = (raw: string) => {
      const query = prepareSearchQuery(raw, fallbackSearchWords);
      return {
        mode: 'search' as const,
        query,
        segment: fallbackSearchWords,
        context: taskSearchContext(
          root,
          { epoch: 'test', rootId: 1, version: 1, childLines: [] },
          query,
          fallbackSearchWords,
        ),
        onActivate,
      };
    };
    let hold: ReturnType<typeof deferred<void>> | undefined;
    const holders: HTMLElement[] = [];
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, holder) => {
      if (markdown.includes('bravo') && hold !== undefined) {
        holders.push(holder);
        await hold.promise;
      }
      holder.setText(markdown);
    });
    const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const flags = { selected: false, showDelete: false };
    const mount = h.subject.mount(document.body, root, [], flags, search('branchlong'));
    try {
      await mount.settled;
      const title = expectDefined(mount.element.querySelector('.abyss-subtask-label'));
      const retired: HTMLElement[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        hold = deferred<void>();
        registrations.mockClear();
        mount.update(root, [], flags, search('bra'));
        const pending = mount.settled;
        expect(holders).toHaveLength(cycle + 1);
        const fields = registrations.mock.calls.flatMap(([type], index) => {
          const element: unknown = registrations.mock.contexts[index];
          return type === 'click' && element instanceof HTMLElement && element.matches(selector)
            ? [element]
            : [];
        });
        const field = expectDefined(fields[0]);
        const registration = registrations.mock.calls.findIndex(
          ([type], index) => type === 'click' && registrations.mock.contexts[index] === field,
        );
        const listener = expectDefined(registrations.mock.calls[registration]?.[1]);
        const remove = vi.spyOn(field, 'removeEventListener');
        mount.update(root, [], flags, search('branchlong'));
        expect(await pending).toEqual({ type: 'cancelled' });
        expect(await mount.settled).toEqual({ type: 'ready' });
        expect(remove).toHaveBeenCalledWith('click', listener, undefined);
        hold.resolve();
        hold = undefined;
        await Promise.resolve();
        expect(mount.element.querySelector(selector)).toBeNull();
        expect(mount.element.querySelector('.abyss-subtask-label')).toBe(title);
        expect(holders.every((holder) => !holder.isConnected)).toBe(true);
        retired.push(field);
      }
      mount.update(root, [], flags, search('bra'));
      expect(await mount.settled).toEqual({ type: 'ready' });
      for (const field of retired) field.click();
      expect(onActivate).not.toHaveBeenCalled();
      expectDefined(mount.element.querySelector<HTMLElement>(selector)).click();
      expect(onActivate).toHaveBeenCalledTimes(1);
    } finally {
      hold?.resolve();
      mount.destroy();
      canonical.close();
      h.hostComponent.unload();
    }
  },
);
