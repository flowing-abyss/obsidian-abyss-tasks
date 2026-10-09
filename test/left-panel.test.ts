import type * as ObsidianModule from 'obsidian';
import { Menu, Notice, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AppState } from '../src/app/AppState';
import { LeftPanel } from '../src/panels/LeftPanel';
import type { StatisticsNavigationPort } from '../src/panels/statistics/StatisticsNavigation';
import { ProjectCreationError, type ProjectCreateOptions } from '../src/projects/projectCreation';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import type { ProjectStats } from '../src/projects/types';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import type { StatisticsViewId } from '../src/statistics';
import { RenameTagModal } from '../src/tags/RenameTagModal';
import { TagManager } from '../src/tags/TagManager';
import { discoveredPrefixGroupId, discoveredTagGroupId } from '../src/tags/effectiveTagGroups';
import * as taskTagCatalog from '../src/tags/taskTagCatalog';
import { selectTaskNodes } from '../src/task-lists/TaskListSelector';
import type { TaskApplicationApi, TaskSnapshot } from '../src/tasks';
import { localDate } from '../src/tasks';
import { TagGroupAppearanceModal } from '../src/ui/TagGroupAppearanceModal';
import {
  createAppWithFiles,
  dispatchImeKey,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  makeStubStore,
  methodOf,
  objectMatching,
  subtask,
  task,
  useRealMoment,
} from './helpers';
import { makeLeftPanelForTest } from './support/panelHarness';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

function firstNoticeText(): string {
  const message = vi.mocked(Notice).mock.calls[0]?.[0];
  if (typeof message === 'string') return message;
  return message?.textContent ?? '';
}

function noticeTexts(): string[] {
  return vi
    .mocked(Notice)
    .mock.calls.map(([message]) => (typeof message === 'string' ? message : message.textContent));
}

const STATUS_VALIDATION = 'Choose a project Status property in settings before changing statuses.';

interface NativeMenuItem {
  readonly title__: string;
  readonly submenu: Menu | null;
  readonly onClick__: ((event: MouseEvent | KeyboardEvent) => void) | null;
}

function nativeMenuItems(menu: Menu | null | undefined): NativeMenuItem[] {
  return (expectDefined(menu) as unknown as { menuItems__: NativeMenuItem[] }).menuItems__;
}

function nativeMenuItem(menu: Menu | null | undefined, title: string): NativeMenuItem {
  return expectDefined(nativeMenuItems(menu).find(({ title__ }) => title__ === title));
}

function clickNativeItem(item: NativeMenuItem | undefined): void {
  expectDefined(expectDefined(item).onClick__)(new MouseEvent('click'));
}

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

useRealMoment();

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(Notice).mockClear();
  activeDocument.querySelectorAll('.modal-container').forEach((element) => {
    element.remove();
  });
});

interface CapturedMenuItem {
  readonly title: string;
  readonly click: () => unknown;
}

function captureMenu(): CapturedMenuItem[] {
  const items: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    build: (item: MenuItem) => unknown,
  ) {
    let title = '';
    let click = (): unknown => undefined;
    const item = {
      setTitle(value: string) {
        title = value;
        return this;
      },
      setIcon() {
        return this;
      },
      onClick(value: () => unknown) {
        click = value;
        return this;
      },
    } as unknown as MenuItem;
    build(item);
    items.push({
      get title() {
        return title;
      },
      click: () => click(),
    });
    return this;
  });
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    return this;
  });
  return items;
}

function openContextMenu(element: Element): void {
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function renderOpenedModalsInDocument(): void {
  vi.spyOn(TagGroupAppearanceModal.prototype, 'open').mockImplementation(function (
    this: TagGroupAppearanceModal,
  ) {
    this.containerEl.addClass('modal-container');
    activeDocument.body.appendChild(this.containerEl);
    this.onOpen();
  });
  vi.spyOn(RenameTagModal.prototype, 'open').mockImplementation(function (this: RenameTagModal) {
    this.containerEl.addClass('modal-container');
    activeDocument.body.appendChild(this.containerEl);
    this.onOpen();
  });
}

function makePanel(
  tasks: TaskSnapshot[] = [],
  settings: Partial<CalendarSettings> = {},
  pinnedTags: string[] = [],
  archivedTags: string[] = [],
) {
  const state = new AppState();
  const store = makeStubStore(tasks);
  const merged: CalendarSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    pinnedTags,
    archivedTags,
  };
  const save = vi.fn().mockResolvedValue(undefined);
  const tm = new TagManager(null as never, merged, save, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const queries = (store as unknown as { taskQueries: TaskApplicationApi['queries'] }).taskQueries;
  const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'io-error',
    cause: 'test',
    contentState: 'unchanged',
  });
  const panel = makeLeftPanelForTest(state, store, merged, tm, null as never, save, null, null, {
    queries,
    execute,
  });
  const el = freshContainer();
  panel.mount(el);
  return { panel, state, el, tm, execute, merged, save };
}

describe('LeftPanel smart lists', () => {
  it("collects this render's observed tags once on mount and refresh", () => {
    const collect = vi.spyOn(taskTagCatalog, 'collectTaskNodeTags');
    const h = makePanel([task({ tags: ['#work'] })], {}, ['#work']);
    try {
      expect(collect).toHaveBeenCalledTimes(1);
      const before = h.el.textContent;
      collect.mockClear();
      h.panel.refresh();
      expect(collect).toHaveBeenCalledTimes(1);
      expect(h.el.textContent).toBe(before);
    } finally {
      h.panel.destroy();
    }
  });
  it('does not add a redundant Lists heading above the smart-list rows', () => {
    const { el } = makePanel();
    expect(el.textContent).not.toContain('Lists');
    expect(el.querySelector('.abyss-left-divider')).toBeNull();
  });

  it('renders Inbox/Today/Upcoming rows', () => {
    const { el } = makePanel();
    const labels = Array.from(el.querySelectorAll('.abyss-left-item .abyss-left-label')).map(
      (l) => l.textContent,
    );
    expect(labels).toContain('Inbox');
    expect(labels).toContain('Today');
    expect(labels).toContain('Upcoming');
  });

  it('countInbox tag mode counts open tasks with inboxTag', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#inbox'],
        source: { line: 0, originalMarkdown: '- [ ] t #inbox', originalBlock: '- [ ] t #inbox' },
      }),
      task({
        status: 'open',
        tags: ['#inbox'],
        source: { line: 1, originalMarkdown: '- [ ] t2 #inbox', originalBlock: '- [ ] t2 #inbox' },
      }),
      task({
        status: 'done',
        tags: ['#inbox'],
        source: {
          line: 2,
          originalMarkdown: '- [x] done #inbox',
          originalBlock: '- [x] done #inbox',
        },
      }),
    ];
    const { el } = makePanel(tasks, {
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    });
    const inboxRow = expectDefined(el.querySelector('.abyss-left-item'));
    expect(inboxRow.querySelector('.abyss-left-count')?.textContent).toBe('2');
  });

  it('countInbox untagged mode counts open tasks with no #tag', () => {
    const tasks = [
      task({
        status: 'open',
        source: { originalMarkdown: '- [ ] no tag', originalBlock: '- [ ] no tag' },
      }),
      task({
        status: 'open',
        tags: ['#work'],
        source: { originalMarkdown: '- [ ] #work tagged', originalBlock: '- [ ] #work tagged' },
      }),
      task({
        status: 'done',
        source: { originalMarkdown: '- [x] done no tag', originalBlock: '- [x] done no tag' },
      }),
    ];
    const { el } = makePanel(tasks, {
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    const inboxRow = expectDefined(el.querySelector('.abyss-left-item'));
    expect(inboxRow.querySelector('.abyss-left-count')?.textContent).toBe('1');
  });

  it('countToday splits unique active today and overdue roots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12));
    const todayTasks = Array.from({ length: 10 }, (_, line) =>
      task({
        source: { line },
        planning: line < 5 ? { due: '2026-10-03' } : { scheduled: '2026-10-03' },
      }),
    );
    todayTasks.push(
      task({ source: { line: 14 }, status: 'in-progress', planning: { due: '2026-10-03' } }),
      task({ source: { line: 17 }, status: 'in-progress', planning: { scheduled: '2026-10-03' } }),
    );
    const overdueTasks = [
      task({ source: { line: 10 }, planning: { due: '2026-10-02' } }),
      task({
        source: { line: 11 },
        planning: { due: '2026-10-02', scheduled: '2026-10-03' },
      }),
      task({ source: { line: 18 }, status: 'in-progress', planning: { due: '2026-10-02' } }),
      task({
        source: { line: 19 },
        status: 'in-progress',
        planning: { due: '2026-10-02', scheduled: '2026-10-03' },
      }),
    ];
    const excluded = [
      task({ source: { line: 12 }, status: 'done', planning: { due: '2026-10-03' } }),
      task({ source: { line: 13 }, status: 'cancelled', planning: { due: '2026-10-02' } }),
      task({ source: { line: 20 }, status: 'done', planning: { due: '2026-10-02' } }),
      task({ source: { line: 21 }, status: 'cancelled', planning: { scheduled: '2026-10-03' } }),
      task({ source: { line: 15 }, planning: { scheduled: '2026-10-02' } }),
      task({ source: { line: 16 } }),
    ];
    try {
      for (const [candidates, badge, explanation] of [
        [
          [
            ...todayTasks,
            ...overdueTasks,
            ...excluded,
            task({
              source: { line: 11 },
              ref: { revision: 'another-detached-snapshot' },
              planning: { due: '2026-10-02', scheduled: '2026-10-03' },
            }),
            task({
              source: { line: 19 },
              ref: { revision: 'detached-in-progress-snapshot' },
              status: 'in-progress',
              planning: { due: '2026-10-02', scheduled: '2026-10-03' },
            }),
          ],
          '12+4',
          '12 today, 4 overdue',
        ],
        [todayTasks, '12', '12 today, 0 overdue'],
        [overdueTasks, '0+4', '0 today, 4 overdue'],
      ] as const) {
        const { el, panel, state, execute, save } = makePanel([...candidates]);
        try {
          const todayRow = expectDefined(el.querySelectorAll('.abyss-left-item')[1]);
          const count = expectDefined(todayRow.querySelector('.abyss-left-count'));
          expect(count.textContent).toBe(badge);
          expect(count.getAttribute('aria-label')).toBe(explanation);
          state.set('centerFilter', 'no visible match');
          state.set('centerListViewState', {
            ...state.get('centerListViewState'),
            groupBy: 'status',
            statusGroups: ['done'],
            filters: [{ type: 'tag', value: '#hidden' }],
          });
          panel.refresh();
          const refreshedRow = expectDefined(el.querySelectorAll('.abyss-left-item')[1]);
          expect(refreshedRow.querySelector('.abyss-left-count')?.textContent).toBe(badge);
          expect(refreshedRow.querySelector('.abyss-left-count')?.getAttribute('aria-label')).toBe(
            explanation,
          );
          expect(execute).not.toHaveBeenCalled();
          expect(save).not.toHaveBeenCalled();
        } finally {
          panel.destroy();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits the Today badge when both today and overdue counts are zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12));
    try {
      const { panel, el } = makePanel([]);
      try {
        const todayRow = expectDefined(el.querySelectorAll('.abyss-left-item')[1]);
        expect(todayRow.querySelector('.abyss-left-count')).toBeNull();
      } finally {
        panel.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('countUpcoming matches due ?? scheduled > today', () => {
    const tasks = [
      task({ source: { line: 0 }, status: 'open', planning: { due: '2099-12-31' } }),
      task({ source: { line: 1 }, status: 'open', planning: { scheduled: '2099-01-01' } }),
      task({ source: { line: 2 }, status: 'open', presentation: {} }),
      task({ source: { line: 3 }, status: 'open', planning: { due: '2020-01-01' } }),
      task({ source: { line: 4 }, status: 'done', planning: { due: '2099-12-31' } }),
    ];
    const { el } = makePanel(tasks);
    const rows = el.querySelectorAll('.abyss-left-item');
    const upcomingRow = expectDefined(rows[2]);
    expect(upcomingRow.querySelector('.abyss-left-count')?.textContent).toBe('2');
  });

  it('count badge absent when count is 0', () => {
    const { el } = makePanel([], {
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    });
    const inboxRow = expectDefined(el.querySelector('.abyss-left-item'));
    expect(inboxRow.querySelector('.abyss-left-count')).toBeNull();
  });

  it('is-active class on currently-selected smart list', () => {
    const state = new AppState();
    state.set('selectedList', 'today');
    const store = makeStubStore([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, DEFAULT_SETTINGS, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    const active = el.querySelector('.abyss-left-item.is-active .abyss-left-label');
    expect(active?.textContent).toBe('Today');
  });

  it('click Inbox sets selectedList and mode', () => {
    const { el, state } = makePanel();
    (el.querySelector('.abyss-left-item') as HTMLElement).click();
    expect(state.get('selectedList')).toBe('inbox');
    expect(state.get('mode')).toBe('tasks');
  });

  it('click Today sets selectedList and mode', () => {
    const { el, state } = makePanel();
    (el.querySelectorAll('.abyss-left-item')[1] as HTMLElement).click();
    expect(state.get('selectedList')).toBe('today');
    expect(state.get('mode')).toBe('tasks');
  });

  it('click Upcoming sets selectedList and mode', () => {
    const { el, state } = makePanel();
    (el.querySelectorAll('.abyss-left-item')[2] as HTMLElement).click();
    expect(state.get('selectedList')).toBe('upcoming');
    expect(state.get('mode')).toBe('tasks');
  });
});

describe('LeftPanel tag groups (prefix mode)', () => {
  it('always renders the Tags section (with the + affordance), groups only when present', () => {
    // Empty groups: the Tags section still shows so the "+" is discoverable, but no group rows.
    const { el } = makePanel([], { tagGroups: [] });
    expect(el.querySelector('.abyss-left-section--tags')).not.toBeNull();
    expect(el.querySelector('.abyss-left-section--tags .abyss-left-add')).not.toBeNull();
    expect(el.querySelector('.abyss-tag-group-header')).toBeNull();
    // With a group: the group renders.
    const { el: el2 } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    expect(el2.querySelector('.abyss-tag-group-header')).not.toBeNull();
  });

  it('group header renders name', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    expect(el.querySelector('.abyss-tag-group-header .abyss-left-label')?.textContent).toBe('Work');
  });

  it('group count includes root prefix and subtags (open tasks only)', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#work'],
        source: {
          line: 0,
          originalMarkdown: '- [ ] #work task',
          originalBlock: '- [ ] #work task',
        },
      }),
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: {
          line: 1,
          originalMarkdown: '- [ ] #work/dev task',
          originalBlock: '- [ ] #work/dev task',
        },
      }),
      task({
        status: 'done',
        tags: ['#work'],
        source: {
          line: 2,
          originalMarkdown: '- [x] #work done',
          originalBlock: '- [x] #work done',
        },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    expect(el.querySelector('.abyss-tag-group-header .abyss-left-count')?.textContent).toBe('2');
  });

  it('group header is-active when selectedList is group', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'group', groupId: 'g1' });
    const store = makeStubStore([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    };
    const tm = new TagManager(null as never, settings, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, settings, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-tag-group-header')?.classList.contains('is-active')).toBe(true);
  });

  it('click group header sets selectedList and mode', () => {
    const { el, state } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    (el.querySelector('.abyss-tag-group-header') as HTMLElement).click();
    expect(state.get('selectedList')).toEqual({ type: 'group', groupId: 'g1' });
    expect(state.get('mode')).toBe('tasks');
  });

  it('chevron click expands collapsed group', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    const chevron = el.querySelector('.abyss-group-arrow') as HTMLElement;
    expect(el.querySelector('.abyss-tag-group-children')).toBeNull();
    chevron.click();
    expect(el.querySelector('.abyss-tag-group-children')).not.toBeNull();
  });

  it('chevron click collapses expanded group', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'tag', tag: '#work/dev' });
    const store = makeStubStore([
      task({
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev task', originalBlock: '- [ ] #work/dev task' },
      }),
    ]);
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, settings, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, settings, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    // auto-expanded due to active child
    expect(el.querySelector('.abyss-tag-group-children')).not.toBeNull();
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    expect(el.querySelector('.abyss-tag-group-children')).toBeNull();
  });

  it('auto-expand when child tag is active (unless explicitly collapsed)', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'tag', tag: '#work/dev' });
    const store = makeStubStore([
      task({
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev task', originalBlock: '- [ ] #work/dev task' },
      }),
    ]);
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, settings, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, settings, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-tag-group-children')).not.toBeNull();
  });

  it('explicit collapse prevents auto-expand even with active child', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'tag', tag: '#work/dev' });
    const store = makeStubStore([
      task({
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev task', originalBlock: '- [ ] #work/dev task' },
      }),
    ]);
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, settings, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, settings, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    // Collapse explicitly
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    // Re-render by triggering state change
    state.set('selectedList', { type: 'tag', tag: '#work/dev' });
    expect(el.querySelector('.abyss-tag-group-children')).toBeNull();
  });

  it('expanded group renders child tags with label stripping', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev task', originalBlock: '- [ ] #work/dev task' },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    const childLabel = el.querySelector('.abyss-tag-child .abyss-left-label')?.textContent;
    expect(childLabel).toBe('dev');
  });

  it('child tag count badge shows open task count', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: {
          line: 0,
          originalMarkdown: '- [ ] #work/dev a',
          originalBlock: '- [ ] #work/dev a',
        },
      }),
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: {
          line: 1,
          originalMarkdown: '- [ ] #work/dev b',
          originalBlock: '- [ ] #work/dev b',
        },
      }),
      task({
        status: 'done',
        tags: ['#work/dev'],
        source: {
          line: 2,
          originalMarkdown: '- [x] #work/dev done',
          originalBlock: '- [x] #work/dev done',
        },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    expect(el.querySelector('.abyss-tag-child .abyss-left-count')?.textContent).toBe('2');
  });

  it('child tag is-active when selectedList is that tag', () => {
    const state = new AppState();
    state.set('selectedList', { type: 'tag', tag: '#work/dev' });
    const store = makeStubStore([
      task({
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev task', originalBlock: '- [ ] #work/dev task' },
      }),
    ]);
    const settings: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, settings, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, settings, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.querySelector('.abyss-tag-child.is-active .abyss-left-label')?.textContent).toBe(
      'dev',
    );
  });

  it('click child tag sets selectedList and mode with stopPropagation', () => {
    const { el, state } = makePanel(
      [
        task({
          tags: ['#work/dev'],
          source: {
            originalMarkdown: '- [ ] #work/dev task',
            originalBlock: '- [ ] #work/dev task',
          },
        }),
      ],
      {
        tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
      },
    );
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    const child = el.querySelector('.abyss-tag-child') as HTMLElement;
    child.click();
    expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#work/dev' });
    expect(state.get('mode')).toBe('tasks');
  });

  it('resolveGroupTags prefix mode: finds subtags, excludes root, sorted', () => {
    const tasks = [
      task({
        tags: ['#work/dev', '#work/alpha'],
        source: {
          originalMarkdown: '- [ ] #work/dev and #work/alpha task',
          originalBlock: '- [ ] #work/dev and #work/alpha task',
        },
      }),
      task({
        tags: ['#work'],
        source: { originalMarkdown: '- [ ] #work task', originalBlock: '- [ ] #work task' },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    const childLabels = Array.from(el.querySelectorAll('.abyss-tag-child .abyss-left-label')).map(
      (l) => l.textContent,
    );
    // sorted localeCompare: #work/alpha < #work/dev
    expect(childLabels).toEqual(['alpha', 'dev']);
  });

  it('resolveGroupTags prefix mode: #work does not match #workplace', () => {
    const tasks = [
      task({
        tags: ['#workplace'],
        source: {
          originalMarkdown: '- [ ] #workplace task',
          originalBlock: '- [ ] #workplace task',
        },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    expect(el.querySelectorAll('.abyss-tag-child')).toHaveLength(0);
  });

  it('group count does not treat #workplace as the exact #work tag', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#workplace'],
        source: {
          originalMarkdown: '- [ ] #workplace task',
          originalBlock: '- [ ] #workplace task',
        },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    expect(el.querySelector('.abyss-tag-group-header .abyss-left-count')).toBeNull();
  });

  it('group color renders as dot', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#ff0000' }],
    });
    const dot = el.querySelector('.abyss-group-dot');
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.background).toBe('rgb(255, 0, 0)');
  });
});

describe('LeftPanel tag groups (manual mode)', () => {
  it('manual group renders children from group.tags', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Manual', mode: 'manual', tags: ['#foo', '#bar'] }],
    });
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    const labels = Array.from(el.querySelectorAll('.abyss-tag-child .abyss-left-label')).map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(['#foo', '#bar']);
  });

  it('manual group count counts open tasks matching any tag in group.tags', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#foo'],
        source: { line: 0, originalMarkdown: '- [ ] #foo task', originalBlock: '- [ ] #foo task' },
      }),
      task({
        status: 'open',
        tags: ['#bar'],
        source: { line: 1, originalMarkdown: '- [ ] #bar task', originalBlock: '- [ ] #bar task' },
      }),
      task({
        status: 'done',
        tags: ['#foo'],
        source: { line: 2, originalMarkdown: '- [x] #foo done', originalBlock: '- [x] #foo done' },
      }),
    ];
    const { el } = makePanel(tasks, {
      tagGroups: [{ id: 'g1', name: 'Manual', mode: 'manual', tags: ['#foo', '#bar'] }],
    });
    expect(el.querySelector('.abyss-tag-group-header .abyss-left-count')?.textContent).toBe('2');
  });

  it('manual group no prefix stripping (labels are full tags)', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Manual', mode: 'manual', tags: ['#work/dev', '#work/ops'] }],
    });
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    expect(el.querySelector('.abyss-tag-child .abyss-left-label')?.textContent).toBe('#work/dev');
  });

  it('single-tag manual group renders flat (leaf: color dot + group name, no #, no chevron)', () => {
    const { el, state } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'next', mode: 'manual', color: '#ff0000', tags: ['#next'] }],
    });
    expect(el.querySelector('.abyss-group-arrow')).toBeNull();
    const leaf = el.querySelector('.abyss-tag-leaf');
    expect(leaf).toBeTruthy();
    // Consistent with group rows: name without '#', plus a color dot.
    expect(expectDefined(leaf).querySelector('.abyss-left-label')?.textContent).toBe('next');
    expect(expectDefined(leaf).querySelector('.abyss-group-dot')).toBeTruthy();
    (leaf as HTMLElement).click();
    expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#next' });
  });
});

describe('LeftPanel effective tag groups', () => {
  it('renders standalone and nested task tags without copying them into settings', () => {
    const { el, merged } = makePanel([
      task({ tags: ['#home'] }),
      task({
        source: { filePath: 'tasks.md', line: 1 },
        tags: ['#work/client', '#work/client/urgent'],
      }),
    ]);

    expect(
      Array.from(el.querySelectorAll('.abyss-left-section--tags .abyss-left-label')).map(
        (label) => label.textContent,
      ),
    ).toEqual(['home', 'work']);
    expect(merged.tagGroups).toEqual([]);
  });

  it('counts a subtask-only tag as one node and opens its exact tag destination', () => {
    const root = task({
      title: 'Root',
      subtasks: [subtask({ tags: ['#work/subtask'] })],
    });
    const { el, state } = makePanel([root]);
    const group = expectDefined(el.querySelector<HTMLElement>('.abyss-tag-group'));

    expect(group.querySelector('.abyss-left-count')?.textContent).toBe('1');
    expectDefined(group.querySelector<HTMLElement>('.abyss-group-arrow')).click();
    const child = expectDefined(el.querySelector<HTMLElement>('.abyss-tag-child'));
    expect(child.querySelector('.abyss-left-count')?.textContent).toBe('1');
    child.click();
    expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#work/subtask' });
  });

  it.each([
    ['before promotion', false, false],
    ['after appearance promotion', true, false],
    ['after promoted prefix rename', true, true],
  ])(
    'keeps full prefix counts but hides explicitly claimed child rows %s',
    (_label, promoted, renamed) => {
      const prefix = renamed ? 'focus' : 'work';
      const automatic = promoted
        ? [
            {
              id: discoveredPrefixGroupId('work'),
              name: 'Focused work',
              mode: 'prefix' as const,
              prefix,
              color: '#ff0000',
            },
          ]
        : [];
      const { el } = makePanel(
        [
          task({ source: { line: 0 }, title: 'Exact', tags: [`#${prefix}`] }),
          task({ source: { line: 1 }, title: 'Claimed child', tags: [`#${prefix}/client`] }),
          task({ source: { line: 2 }, title: 'Free child', tags: [`#${prefix}/other`] }),
        ],
        {
          tagGroups: [
            { id: 'nested', name: 'Client', mode: 'prefix', prefix: `${prefix}/client` },
            { id: 'exact', name: 'Work root', mode: 'manual', tags: [`#${prefix}`] },
            ...automatic,
          ],
        },
      );
      const expectedName = promoted ? 'Focused work' : 'work';
      const group = expectDefined(
        Array.from(el.querySelectorAll<HTMLElement>('.abyss-tag-group')).find(
          (candidate) =>
            candidate.querySelector('.abyss-tag-group-header .abyss-left-label')?.textContent ===
            expectedName,
        ),
      );

      expect(group.querySelector('.abyss-tag-group-header .abyss-left-count')?.textContent).toBe(
        '3',
      );
      expectDefined(group.querySelector<HTMLElement>('.abyss-group-arrow')).click();
      const expanded = expectDefined(
        Array.from(el.querySelectorAll<HTMLElement>('.abyss-tag-group')).find(
          (candidate) =>
            candidate.querySelector('.abyss-tag-group-header .abyss-left-label')?.textContent ===
            expectedName,
        ),
      );
      expect(
        Array.from(expanded.querySelectorAll('.abyss-tag-child .abyss-left-label')).map(
          (label) => label.textContent,
        ),
      ).toEqual(['other']);
    },
  );
});

describe('LeftPanel top-level tag group menus', () => {
  it('prefix header menu separates appearance from an explicit across-vault prefix rename', () => {
    const items = captureMenu();
    const { el, state } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    const header = expectDefined(el.querySelector('.abyss-tag-group-header'));
    const selectedBefore = state.get('selectedList');

    openContextMenu(header);

    expect(items.map((item) => item.title)).toEqual([
      'Rename display name…',
      'Change color…',
      'Rename prefix across vault…',
      'Archive',
    ]);
    expect(state.get('selectedList')).toEqual(selectedBefore);
    expect(state.get('draggingTag')).toBeNull();
    expect(el.querySelector('.abyss-tag-group-children')).toBeNull();
  });

  it('multi-manual header identifies every member instead of guessing a rename scope', () => {
    const items = captureMenu();
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Delivery', mode: 'manual', tags: ['#client', '#client/ops'] }],
    });

    openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));

    expect(items.map((item) => item.title)).toEqual([
      'Rename display name…',
      'Change color…',
      'Rename #client across vault…',
      'Rename #client/ops across vault…',
      'Archive',
    ]);
  });

  it('flattened one-tag group keeps group appearance actions and an identified exact rename', () => {
    const items = captureMenu();
    const { el, state } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Next', mode: 'manual', tags: ['#next'] }],
    });
    const leaf = expectDefined(el.querySelector('.abyss-tag-leaf'));
    const selectedBefore = state.get('selectedList');

    openContextMenu(leaf);

    expect(items.map((item) => item.title)).toEqual([
      'Rename display name…',
      'Change color…',
      'Rename #next across vault…',
      'Pin',
      'Archive',
    ]);
    expect(state.get('selectedList')).toEqual(selectedBefore);
    expect(state.get('draggingTag')).toBeNull();
  });

  it('appearance modal updates only group settings and supports resetting color', async () => {
    renderOpenedModalsInDocument();
    const items = captureMenu();
    const { el, merged, save, tm } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#ff0000' }],
    });
    const renameExact = vi.spyOn(tm, 'renameTagExact');
    const renamePrefix = vi.spyOn(tm, 'renameTagPrefix');

    openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));
    expectDefined(items.find((item) => item.title === 'Rename display name…')).click();
    const nameInput = expectDefined(
      activeDocument.querySelector<HTMLInputElement>(
        '.abyss-tag-group-appearance-modal input[type="text"]',
      ),
    );
    nameInput.value = 'Focused work';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-tag-group-appearance-modal .mod-cta'),
    ).click();
    await flushMicrotasks();

    expect(merged.tagGroups[0]?.name).toBe('Focused work');
    expect(merged.tagGroups[0]?.color).toBe('#ff0000');

    items.splice(0);
    openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));
    expectDefined(items.find((item) => item.title === 'Change color…')).click();
    const reset = expectDefined(
      Array.from(
        activeDocument.querySelectorAll<HTMLButtonElement>(
          '.abyss-tag-group-appearance-modal button',
        ),
      ).find((button) => button.textContent === 'Reset'),
    );
    reset.click();
    expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-tag-group-appearance-modal .mod-cta'),
    ).click();
    await flushMicrotasks();

    expect(merged.tagGroups[0]?.color).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
    expect(renameExact).not.toHaveBeenCalled();
    expect(renamePrefix).not.toHaveBeenCalled();
  });

  it('rolls back appearance and reports a rejected settings save', async () => {
    renderOpenedModalsInDocument();
    const items = captureMenu();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#ff0000' }],
    });
    const failure = new Error('settings storage unavailable');
    save.mockRejectedValueOnce(failure);

    openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));
    expectDefined(items.find((item) => item.title === 'Rename display name…')).click();
    const nameInput = expectDefined(
      activeDocument.querySelector<HTMLInputElement>(
        '.abyss-tag-group-appearance-modal input[type="text"]',
      ),
    );
    nameInput.value = 'Focused work';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    expectDefined(
      activeDocument.querySelector<HTMLButtonElement>('.abyss-tag-group-appearance-modal .mod-cta'),
    ).click();
    await flushMicrotasks();

    expect(merged.tagGroups[0]?.name).toBe('Work');
    expect(merged.tagGroups[0]?.color).toBe('#ff0000');
    expect(Notice).toHaveBeenCalledOnce();
    expect(firstNoticeText()).toBe('Could not update tag group. Your changes were rolled back.');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not update tag group',
      failure,
    );
  });

  it('does not let an older rejected appearance save overwrite a newer saved appearance', async () => {
    renderOpenedModalsInDocument();
    const items = captureMenu();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#ff0000' }],
    });
    const group = expectDefined(merged.tagGroups[0]);
    let rejectFirst!: (error: Error) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    save
      .mockImplementationOnce(() => {
        markFirstStarted();
        return firstSave;
      })
      .mockResolvedValueOnce(undefined);
    const applyAppearance = (name: string, color?: string): void => {
      items.splice(0);
      openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));
      expectDefined(items.find((item) => item.title === 'Rename display name…')).click();
      const input = expectDefined(
        activeDocument.querySelector<HTMLInputElement>(
          '.abyss-tag-group-appearance-modal input[type="text"]',
        ),
      );
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (color !== undefined) {
        const picker = expectDefined(
          activeDocument.querySelector<HTMLInputElement>(
            '.abyss-tag-group-appearance-modal input[type="color"]',
          ),
        );
        picker.value = color;
        picker.dispatchEvent(new Event('input', { bubbles: true }));
      }
      expectDefined(
        activeDocument.querySelector<HTMLButtonElement>(
          '.abyss-tag-group-appearance-modal .mod-cta',
        ),
      ).click();
    };
    const failure = new Error('older save rejected');

    applyAppearance('First edit');
    await firstStarted;
    applyAppearance('Newer edit', '#00ff00');
    await flushMicrotasks();
    rejectFirst(failure);
    await flushMicrotasks();

    expect(group.name).toBe('Newer edit');
    expect(group.color).toBe('#00ff00');
    expect(save).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledOnce();
    expect(firstNoticeText()).toContain('Newer changes were kept');
    expect(firstNoticeText()).not.toContain('rolled back');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not update tag group',
      failure,
    );
  });

  it('reports a failed reorder once and renders the rolled-back order', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel([task({ tags: ['#a'] }), task({ tags: ['#b'] })]);
    const failure = new Error('settings storage unavailable');
    save.mockRejectedValueOnce(failure);
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.abyss-tag-leaf'));
    const before = rows.map((row) => row.querySelector('.abyss-left-label')?.textContent);
    const values = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => {
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? '',
      get types() {
        return [...values.keys()];
      },
    };
    const start = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: dataTransfer });
    expectDefined(rows[1]).dispatchEvent(start);
    expect(dataTransfer.getData('application/x-abyss-taggroup')).toBe(discoveredTagGroupId('#b'));
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    expectDefined(rows[0]).dispatchEvent(drop);
    await flushMicrotasks();
    expect(
      Array.from(el.querySelectorAll('.abyss-tag-leaf .abyss-left-label')).map(
        (label) => label.textContent,
      ),
    ).toEqual(before);

    expect(merged.tagGroups).toEqual([]);
    expect(Notice).toHaveBeenCalledOnce();
    expect(firstNoticeText()).toContain('rolled back');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not reorder tag groups',
      failure,
    );
  });

  it('reports a failed archive truthfully when a newer settings edit is preserved', async () => {
    const items = captureMenu();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectArchive!: (error: Error) => void;
    let markArchiveStarted!: () => void;
    const archiveStarted = new Promise<void>((resolve) => {
      markArchiveStarted = resolve;
    });
    const archiveSave = new Promise<void>((_resolve, reject) => {
      rejectArchive = reject;
    });
    const { el, merged, save, tm } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    save
      .mockImplementationOnce(() => {
        markArchiveStarted();
        return archiveSave;
      })
      .mockResolvedValueOnce(undefined);
    const failure = new Error('older archive save rejected');

    openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));
    expectDefined(items.find((item) => item.title === 'Archive')).click();
    await archiveStarted;
    await tm.pinTag('#newer');
    rejectArchive(failure);
    await flushMicrotasks();

    expect(merged.tagGroups[0]?.archived).toBe(true);
    expect(merged.pinnedTags).toEqual(['#newer']);
    expect(Notice).toHaveBeenCalledOnce();
    expect(firstNoticeText()).toContain('Newer changes were kept');
    expect(firstNoticeText()).not.toContain('rolled back');
    expect(el.textContent).not.toContain('Work');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not archive tag group',
      failure,
    );
  });

  it('prefix vault rename confirmation shows both scopes and reports the changed-file count', async () => {
    renderOpenedModalsInDocument();
    const items = captureMenu();
    const { el, tm } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    vi.spyOn(tm, 'renameTagPrefix').mockResolvedValue({
      type: 'ok',
      changedFiles: ['a.md', 'b.md'],
    });

    openContextMenu(expectDefined(el.querySelector('.abyss-tag-group-header')));
    expectDefined(items.find((item) => item.title === 'Rename prefix across vault…')).click();
    const modal = expectDefined(
      activeDocument.querySelector<HTMLElement>('.abyss-rename-tag-modal'),
    );
    const input = expectDefined(modal.querySelector<HTMLInputElement>('input'));
    input.value = '#focus';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(modal.textContent).toContain('#work');
    expect(modal.textContent).toContain('#focus');
    expect(modal.textContent).toContain('subtags');
    expect(modal.textContent).toContain('across the vault');

    expectDefined(
      Array.from(modal.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Rename across vault',
      ),
    ).click();
    await flushMicrotasks();

    expect(methodOf(tm, 'renameTagPrefix')).toHaveBeenCalledWith('#work', '#focus');
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Notice).mock.calls[0]?.[0]).toContain('2 files');
  });

  it('partial vault rename reports both changed and failed counts as a warning', async () => {
    renderOpenedModalsInDocument();
    const { tm } = makePanel();
    vi.spyOn(tm, 'renameTagExact').mockResolvedValue({
      type: 'partial',
      changedFiles: ['a.md', 'c.md'],
      failedFiles: ['b.md'],
    });
    const onRenamed = vi.fn();
    const modal = new RenameTagModal(null as never, tm, '#work', onRenamed);
    modal.open();
    const input = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    input.value = '#focus';
    expectDefined(
      Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Rename across vault',
      ),
    ).click();
    await flushMicrotasks();

    expect(onRenamed).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(firstNoticeText()).toContain('Warning');
    expect(firstNoticeText()).toContain('2 files');
    expect(firstNoticeText()).toContain('1 file');
  });

  it('settings persistence failure warns without claiming rename success', async () => {
    renderOpenedModalsInDocument();
    const { tm } = makePanel();
    vi.spyOn(tm, 'renameTagExact').mockResolvedValue({
      type: 'settings-error',
      changedFiles: ['a.md'],
      failedFiles: [],
    });
    const onRenamed = vi.fn();
    const modal = new RenameTagModal(null as never, tm, '#work', onRenamed);
    modal.open();
    const input = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    input.value = '#focus';
    expectDefined(
      Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Rename across vault',
      ),
    ).click();
    await flushMicrotasks();

    expect(onRenamed).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledOnce();
    const notice = firstNoticeText();
    expect(notice).toContain('tag/view preferences were not fully saved');
    expect(notice).not.toContain('Tag renamed across');
  });

  it('invalid vault rename shows validation and keeps the modal open for correction', async () => {
    renderOpenedModalsInDocument();
    const { tm } = makePanel();
    vi.spyOn(tm, 'renameTagExact').mockResolvedValue({
      type: 'invalid',
      reason: 'invalid-tag',
    });
    const onRenamed = vi.fn();
    const modal = new RenameTagModal(null as never, tm, '#work', onRenamed);
    modal.open();
    const input = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    input.value = '#work/';
    expectDefined(
      Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Rename across vault',
      ),
    ).click();
    await flushMicrotasks();

    expect(onRenamed).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(firstNoticeText()).toContain('trailing slash');
    expect(modal.contentEl.querySelector('input')).not.toBeNull();
  });

  it('disables rename controls while pending and ignores duplicate submission', async () => {
    renderOpenedModalsInDocument();
    const { tm } = makePanel();
    let resolveRename!: (result: {
      readonly type: 'invalid';
      readonly reason: 'invalid-tag';
    }) => void;
    const pending = new Promise<{ readonly type: 'invalid'; readonly reason: 'invalid-tag' }>(
      (resolve) => {
        resolveRename = resolve;
      },
    );
    vi.spyOn(tm, 'renameTagExact').mockReturnValue(pending);
    const modal = new RenameTagModal(null as never, tm, '#work', vi.fn());
    modal.open();
    const input = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
    const buttons = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button'));
    const renameButton = expectDefined(
      buttons.find((button) => button.textContent === 'Rename across vault'),
    );

    renameButton.click();
    renameButton.click();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(input.disabled).toBe(true);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(methodOf(tm, 'renameTagExact')).toHaveBeenCalledOnce();

    resolveRename({ type: 'invalid', reason: 'invalid-tag' });
    await flushMicrotasks();

    expect(input.disabled).toBe(false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(modal.contentEl.querySelector('input')).not.toBeNull();
  });

  it.each(['composing', 'legacy'] as const)(
    'leaves IME-owned Enter and Escape in the tag rename field to the IME (%s)',
    async (ime) => {
      renderOpenedModalsInDocument();
      const { tm } = makePanel();
      const rename = vi
        .spyOn(tm, 'renameTagExact')
        .mockResolvedValue({ type: 'invalid', reason: 'invalid-tag' });
      const modal = new RenameTagModal(null as never, tm, '#work', vi.fn());
      modal.open();
      const close = vi.spyOn(modal, 'close');
      const input = expectDefined(modal.contentEl.querySelector<HTMLInputElement>('input'));
      input.value = '#focus';

      dispatchImeKey(input, 'Enter', ime);
      dispatchImeKey(input, 'Escape', ime);
      await flushMicrotasks();

      // A guard on Enter alone still lets an IME Escape close the modal.
      expect(rename).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    },
  );

  it('child and pinned tag menus use explicit across-vault wording', () => {
    const items = captureMenu();
    const tasks = [
      task({
        tags: ['#work/dev'],
        source: {
          originalMarkdown: '- [ ] #work/dev task',
          originalBlock: '- [ ] #work/dev task',
        },
      }),
    ];
    const { el } = makePanel(
      tasks,
      { tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }] },
      ['#pinned'],
    );

    openContextMenu(expectDefined(el.querySelector('.abyss-pinned-tag')));
    expect(items.map((item) => item.title)).toContain('Rename tag across vault…');

    items.splice(0);
    (el.querySelector('.abyss-group-arrow') as HTMLElement).click();
    openContextMenu(expectDefined(el.querySelector('.abyss-tag-child')));
    expect(items.map((item) => item.title)).toContain('Rename tag across vault…');
  });
});

describe('LeftPanel lifecycle', () => {
  it('mount subscribes to selectedList changes', () => {
    const state = new AppState();
    const store = makeStubStore([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, DEFAULT_SETTINGS, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    state.set('selectedList', 'inbox');
    // re-rendered: inbox should be active
    expect(el.querySelector('.abyss-left-item.is-active .abyss-left-label')?.textContent).toBe(
      'Inbox',
    );
  });

  it('mount subscribes to mode changes', () => {
    const state = new AppState();
    const store = makeStubStore([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, DEFAULT_SETTINGS, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.children.length).toBeGreaterThan(0);
    state.set('mode', 'search');
    // search mode: render returns early, el emptied
    expect(el.children).toHaveLength(0);
  });

  it('refresh re-renders', () => {
    const { el, panel } = makePanel([]);
    (el.querySelector('.abyss-left-item') as HTMLElement).click();
    panel.refresh();
    // still has content after refresh
    expect(el.querySelector('.abyss-left-section-header')).not.toBeNull();
  });

  it('destroy removes listeners and empties el', () => {
    const state = new AppState();
    const store = makeStubStore([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, DEFAULT_SETTINGS, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    panel.destroy();
    expect(el.children).toHaveLength(0);
    state.set('mode', 'search');
    // no re-render after destroy
    expect(el.children).toHaveLength(0);
  });

  it('search mode hides panel (no children)', () => {
    const state = new AppState();
    state.set('mode', 'search');
    const store = makeStubStore([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const panel = makeLeftPanelForTest(state, store, DEFAULT_SETTINGS, tm, null as never);
    const el = freshContainer();
    panel.mount(el);
    expect(el.children).toHaveLength(0);
  });
});

describe('LeftPanel Pinned section', () => {
  it('renders Pinned section when pinnedTags is non-empty', () => {
    const { el } = makePanel([], {}, ['#task/next']);
    const headers = Array.from(el.querySelectorAll('.abyss-left-section-header')).map(
      (h) => h.textContent,
    );
    expect(headers).toContain('Pinned');
  });

  it('does not render Pinned section when pinnedTags is empty', () => {
    const { el } = makePanel();
    const headers = Array.from(el.querySelectorAll('.abyss-left-section-header')).map(
      (h) => h.textContent,
    );
    expect(headers).not.toContain('Pinned');
  });

  it('shows full tag name in Pinned section', () => {
    const { el } = makePanel([], {}, ['#task/next_action']);
    const items = el.querySelectorAll('.abyss-pinned-tag .abyss-left-label');
    expect(items[0]?.textContent).toBe('#task/next_action');
  });

  it('clicking pinned tag sets selectedList to that tag', () => {
    const { el, state } = makePanel([], {}, ['#task/next']);
    const item = el.querySelector('.abyss-pinned-tag') as HTMLElement;
    item.click();
    const sel = state.get('selectedList');
    expect(typeof sel === 'object' && sel.type === 'tag' && sel.tag).toBe('#task/next');
  });
});

describe('LeftPanel Pin and Unpin failures', () => {
  const WORK_GROUP: Partial<CalendarSettings> = {
    tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
  };
  const SAVE_FAILURE = 'settings storage unavailable';

  function workTasks(): TaskSnapshot[] {
    return [task({ tags: ['#work/dev'] })];
  }

  function pinnedLabels(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll('.abyss-pinned-tag .abyss-left-label')).map(
      (label) => label.textContent,
    );
  }

  function openChildMenu(el: HTMLElement): void {
    expectDefined(el.querySelector<HTMLElement>('.abyss-group-arrow')).click();
    openContextMenu(expectDefined(el.querySelector('.abyss-tag-child')));
  }

  function clickItem(items: readonly CapturedMenuItem[], title: string): void {
    expectDefined(items.find((item) => item.title === title)).click();
  }

  /** Holds the next settings save open until the row rejects it. */
  function pendingSave(save: Mock): {
    readonly started: Promise<void>;
    readonly reject: (error: Error) => void;
  } {
    let rejectSave!: (error: Error) => void;
    let markSaveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    save.mockImplementationOnce(() => {
      markSaveStarted();
      return new Promise<void>((_resolve, fail) => {
        rejectSave = fail;
      });
    });
    return {
      started,
      reject: (error) => {
        rejectSave(error);
      },
    };
  }

  it('reports a failed child Pin and keeps the rolled-back list', async () => {
    const items = captureMenu();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel(workTasks(), WORK_GROUP);
    const failure = new Error(SAVE_FAILURE);
    save.mockRejectedValueOnce(failure);

    openChildMenu(el);
    clickItem(items, 'Pin');
    await flushMicrotasks();

    expect(noticeTexts()).toEqual(['Could not pin tag. Your changes were rolled back.']);
    expect(merged.pinnedTags).toEqual([]);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not pin tag', failure);
  });

  it('reports a failed pinned-section Unpin and keeps the pinned row', async () => {
    const items = captureMenu();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel([], {}, ['#pinned']);
    const failure = new Error(SAVE_FAILURE);
    save.mockRejectedValueOnce(failure);

    openContextMenu(expectDefined(el.querySelector('.abyss-pinned-tag')));
    clickItem(items, 'Unpin');
    await flushMicrotasks();

    expect(noticeTexts()).toEqual(['Could not unpin tag. Your changes were rolled back.']);
    expect(merged.pinnedTags).toEqual(['#pinned']);
    expect(pinnedLabels(el)).toEqual(['#pinned']);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not unpin tag', failure);
  });

  it('reports a failed Pin from a flattened one-tag group', async () => {
    const items = captureMenu();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Next', mode: 'manual', tags: ['#next'] }],
    });
    const failure = new Error(SAVE_FAILURE);
    save.mockRejectedValueOnce(failure);

    openContextMenu(expectDefined(el.querySelector('.abyss-tag-leaf')));
    clickItem(items, 'Pin');
    await flushMicrotasks();

    expect(noticeTexts()).toEqual(['Could not pin tag. Your changes were rolled back.']);
    expect(merged.pinnedTags).toEqual([]);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not pin tag', failure);
  });

  it('redraws after a rollback that a refresh drew as pinned', async () => {
    const items = captureMenu();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, panel, merged, save } = makePanel(workTasks(), WORK_GROUP);
    const failure = new Error(SAVE_FAILURE);
    const pending = pendingSave(save);

    openChildMenu(el);
    clickItem(items, 'Pin');
    await pending.started;
    panel.refresh();
    const drawn = pinnedLabels(el);
    pending.reject(failure);
    await flushMicrotasks();

    expect(drawn).toEqual(['#work/dev']);
    expect(merged.pinnedTags).toEqual([]);
    expect(pinnedLabels(el)).toEqual([]);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not pin tag', failure);
  });

  it('words a Pin that a newer unrelated save kept', async () => {
    const items = captureMenu();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, tm, merged, save } = makePanel(workTasks(), WORK_GROUP);
    const pending = pendingSave(save);
    const failure = new Error(SAVE_FAILURE);

    openChildMenu(el);
    clickItem(items, 'Pin');
    await pending.started;
    await tm.archiveTag('#other');
    pending.reject(failure);
    await flushMicrotasks();

    expect(noticeTexts()).toEqual([
      'An earlier request to pin tag was not saved. Newer changes were kept.',
    ]);
    expect(merged.pinnedTags).toEqual(['#work/dev']);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not pin tag', failure);
  });

  it('words a Pin that an Unpin of the same tag superseded', async () => {
    const items = captureMenu();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, merged, save } = makePanel(workTasks(), WORK_GROUP);
    const pending = pendingSave(save);
    const failure = new Error(SAVE_FAILURE);

    openChildMenu(el);
    clickItem(items, 'Pin');
    await pending.started;
    items.splice(0);
    openContextMenu(expectDefined(el.querySelector('.abyss-tag-child')));
    clickItem(items, 'Unpin');
    await flushMicrotasks();
    pending.reject(failure);
    await flushMicrotasks();

    expect(noticeTexts()).toEqual([
      'An earlier request to pin tag was not saved. Newer changes were kept.',
    ]);
    expect(pinnedLabels(el)).toEqual([]);
    expect(merged.pinnedTags).toEqual([]);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not pin tag', failure);
  });

  it('pins without a Notice and redraws once', async () => {
    const items = captureMenu();
    const { el, panel, merged } = makePanel(workTasks(), WORK_GROUP);
    openChildMenu(el);
    const render = vi.spyOn(
      panel as unknown as { render_abyssPrivate(): void },
      'render_abyssPrivate',
    );

    clickItem(items, 'Pin');
    await flushMicrotasks();

    expect(Notice).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
    expect(merged.pinnedTags).toEqual(['#work/dev']);
  });
});

describe('LeftPanel archived tags are hidden', () => {
  it('does not render archived tags in Tags section', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] t #work/dev', originalBlock: '- [ ] t #work/dev' },
      }),
    ];
    const settings: Partial<CalendarSettings> = {
      tagGroups: [{ id: 'g1', name: 'work', mode: 'prefix', prefix: 'work' }],
    };
    const { el } = makePanel(tasks, settings, [], ['#work/dev']);
    const childLabels = Array.from(el.querySelectorAll('.abyss-tag-child .abyss-left-label')).map(
      (l) => l.textContent,
    );
    expect(childLabels).not.toContain('dev');
  });
});

describe('LeftPanel inbox logic (new inbox object)', () => {
  it('countInbox tag mode uses a normalized inbox.tag', () => {
    const tasks = [
      task({
        status: 'open',
        tags: ['#task/inbox'],
        source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
      }),
      task({
        status: 'open',
        tags: ['#other'],
        source: { originalMarkdown: '- [ ] t2 #other', originalBlock: '- [ ] t2 #other' },
      }),
    ];
    const { el } = makePanel(tasks, {
      inbox: { mode: 'tag', tag: '##task/inbox', removeTagOnAssign: true },
    });
    const inboxCount = el.querySelector('.abyss-left-item .abyss-left-count')?.textContent;
    expect(inboxCount).toBe('1');
  });

  it('does not count an inline-code tag lookalike as an inbox task', () => {
    const inlineOnly = Object.assign(
      task({
        status: 'open',
        source: {
          originalMarkdown: '- [ ] t `#task/inbox`',
          originalBlock: '- [ ] t `#task/inbox`',
        },
      }),
      {
        tags: [],
      },
    );
    const { el } = makePanel([inlineOnly], {
      inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
    });
    const inboxRow = expectDefined(el.querySelector('.abyss-left-item'));
    const inboxCount = inboxRow.querySelector('.abyss-left-count')?.textContent;

    expect(inboxCount).toBeUndefined();
  });

  it('countInbox untagged mode counts tasks without any tag', () => {
    const tasks = [
      task({
        status: 'open',
        source: { originalMarkdown: '- [ ] no tag', originalBlock: '- [ ] no tag' },
      }),
      task({
        status: 'open',
        tags: ['#work'],
        source: { originalMarkdown: '- [ ] has tag #work', originalBlock: '- [ ] has tag #work' },
      }),
    ];
    const { el } = makePanel(tasks, {
      inbox: { mode: 'untagged', tag: '#task/inbox', removeTagOnAssign: true },
    });
    const inboxCount = el.querySelector('.abyss-left-item .abyss-left-count')?.textContent;
    expect(inboxCount).toBe('1');
  });

  it('countInbox both mode counts union', () => {
    const tasks = [
      task({
        status: 'open',
        source: { originalMarkdown: '- [ ] no tag', originalBlock: '- [ ] no tag', line: 0 },
      }),
      task({
        status: 'open',
        tags: ['#task/inbox'],
        source: {
          originalMarkdown: '- [ ] has inbox #task/inbox',
          originalBlock: '- [ ] has inbox #task/inbox',
          line: 1,
        },
      }),
      task({
        status: 'open',
        tags: ['#work'],
        source: {
          originalMarkdown: '- [ ] has other #work',
          originalBlock: '- [ ] has other #work',
          line: 2,
        },
      }),
    ];
    const { el } = makePanel(tasks, {
      inbox: { mode: 'both', tag: '#task/inbox', removeTagOnAssign: true },
    });
    const inboxCount = el.querySelector('.abyss-left-item .abyss-left-count')?.textContent;
    expect(inboxCount).toBe('2');
  });
});

describe('LeftPanel drop zones', () => {
  it.each(['inspector-root', 'inspector-subtask', 'inspector-relation'] as const)(
    'does not assign a parent tag for a %s drag',
    (kind) => {
      const root = task({ title: 'Root' });
      const child = subtask({ title: 'Child', ref: { parent: { type: 'task', ref: root.ref } } });
      Object.assign(root, { subtasks: [child] });
      const { el, state, execute } = makePanel([root], {}, ['#task/next']);
      const nested = kind !== 'inspector-root';
      state.set('draggingTaskNode', {
        ...(kind === 'inspector-relation'
          ? ({
              source: 'inspector-relation',
              relation: {
                blocker: { type: 'task', ref: root.ref },
                dependent: { type: 'subtask', ref: child.ref },
                dependencyId: 'root',
                direction: 'blocks',
              },
            } as const)
          : { source: 'inspector-subtask' }),
        task: {
          root,
          path: nested ? [child] : [],
          node: nested ? child : root,
          target: nested ? { type: 'subtask', ref: child.ref } : { type: 'task', ref: root.ref },
        },
      });
      const pinned = expectDefined(el.querySelector<HTMLElement>('.abyss-pinned-tag'));
      for (const type of ['dragover', 'drop']) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true });
        pinned.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(pinned.classList.contains('abyss-drop-target')).toBe(false);
      }
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('assigns a center child tag to the exact child, never its parent', () => {
    const root = task({ title: 'Root' });
    const child = subtask({ title: 'Child', ref: { parent: { type: 'task', ref: root.ref } } });
    Object.assign(root, { subtasks: [child] });
    const { el, state, execute } = makePanel([root], {}, ['#task/next']);
    state.set('draggingTaskNode', {
      source: 'center-card',
      task: {
        root,
        node: child,
        path: [child],
        target: { type: 'subtask', ref: child.ref },
      },
    });
    expectDefined(el.querySelector<HTMLElement>('.abyss-pinned-tag')).dispatchEvent(
      new MouseEvent('drop', { bubbles: true, cancelable: true }),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      type: 'patch',
      target: { type: 'subtask', ref: child.ref },
      patch: { tags: { add: ['#task/next'] } },
    });
  });

  it('adds abyss-drop-target class on dragover when a center root is dragged', () => {
    const t = task({
      status: 'open',
      source: { originalMarkdown: '- [ ] t', originalBlock: '- [ ] t' },
    });
    const { el, state } = makePanel([], {}, ['#task/next']);
    state.set('draggingTaskNode', {
      source: 'center-card',
      task: { root: t, path: [], node: t, target: { type: 'task', ref: t.ref } },
    });
    const pinned = el.querySelector('.abyss-pinned-tag') as HTMLElement;
    const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    pinned.dispatchEvent(ev);
    expect(pinned.classList.contains('abyss-drop-target')).toBe(true);
  });

  it('does not add abyss-drop-target without a task-node drag', () => {
    const { el } = makePanel([], {}, ['#task/next']);
    const pinned = el.querySelector('.abyss-pinned-tag') as HTMLElement;
    const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    pinned.dispatchEvent(ev);
    expect(pinned.classList.contains('abyss-drop-target')).toBe(false);
  });

  it('assigns a dropped inbox task through one combined API patch', () => {
    const t = Object.assign(
      task({
        status: 'open',
        tags: ['#task/inbox'],
        source: { originalMarkdown: '- [ ] t #task/inbox', originalBlock: '- [ ] t #task/inbox' },
      }),
      {
        ref: { filePath: 'f.md', line: 0, revision: 'test-ref' },
      },
    );
    const { el, state, execute } = makePanel(
      [t],
      { inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true } },
      ['#task/next'],
    );
    state.set('draggingTaskNode', {
      source: 'center-card',
      task: { root: t, path: [], node: t, target: { type: 'task', ref: t.ref } },
    });
    const pinned = el.querySelector('.abyss-pinned-tag') as HTMLElement;

    pinned.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: objectMatching<TaskSnapshot['ref']>({ filePath: t.ref.filePath, line: t.ref.line }),
      },
      patch: { tags: { add: ['#task/next'] } },
    });
  });
});

describe('LeftPanel collapsible sections, projects, and tags +', () => {
  function openInlineAdd(el: HTMLElement, section: 'tags' | 'projects'): HTMLInputElement {
    expectDefined(
      el.querySelector<HTMLElement>(`.abyss-left-section--${section} .abyss-left-add`),
    ).click();
    // Scoped to the section: while one create is pending, another section can hold its own input.
    const input = expectDefined(
      el.querySelector<HTMLInputElement>(`.abyss-left-section--${section} .abyss-left-add-input`),
    );
    // The panel focuses a new input on the next task; under fake timers run it now, or a later
    // timer advance would pull focus back into the input.
    if (vi.isFakeTimers()) vi.advanceTimersByTime(0);
    input.focus();
    return input;
  }

  function keydown(target: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  function tagLabels(el: HTMLElement): Array<string | null> {
    return Array.from(
      el.querySelectorAll('.abyss-left-section--tags .abyss-left-label'),
      (label) => label.textContent,
    );
  }

  function simulateBlurDuringEmpty(el: HTMLElement, input: HTMLInputElement): void {
    // jsdom fires nothing when a focused element is removed; Chromium blurs it.
    const empty = el.empty.bind(el);
    vi.spyOn(el, 'empty').mockImplementation(() => {
      if (input.ownerDocument.activeElement === input) input.dispatchEvent(new FocusEvent('blur'));
      empty();
    });
  }

  function makeFull(opts: {
    tasks?: TaskSnapshot[];
    settings?: Partial<CalendarSettings>;
    projects?: Array<{ path: string; name: string; stats?: ProjectStats }>;
    create?: (name: string, options?: ProjectCreateOptions) => Promise<unknown>;
    setStatus?: (path: string, statusId: string) => Promise<void>;
    app?: unknown;
    attached?: boolean;
  }) {
    const state = new AppState();
    const store = makeStubStore(opts.tasks ?? []);
    const taskList = vi.spyOn(
      (store as unknown as { taskQueries: TaskApplicationApi['queries'] }).taskQueries,
      'listNodes',
    );
    const merged: CalendarSettings = {
      ...DEFAULT_SETTINGS,
      sectionCollapse: { ...DEFAULT_SETTINGS.sectionCollapse },
      ...opts.settings,
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const saveViewState = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, merged, save, {
      check: () => 'ready',
      apply: async (_change, applyLive) => {
        applyLive();
      },
    });
    const fullProjects = (opts.projects ?? []).map((p) => ({
      frontmatter: {},
      tags: [],
      statusId: null,
      rawStatus: null,
      stats: p.stats ?? {
        total: 0,
        done: 0,
        cancelled: 0,
        inProgress: 0,
        tracked: { closedMs: 0, openStartsMs: [] },
      },
      ...p,
    }));
    const refreshStore = vi.fn();
    let activeProjects = fullProjects;
    const projectStore = {
      activeForLeftPanel: () => activeProjects,
      refresh: refreshStore,
      onUpdate: () => () => {},
    } as never;
    const create = vi.fn(opts.create ?? (() => Promise.resolve(null)));
    const setStatus = vi.fn(opts.setStatus ?? (() => Promise.resolve()));
    const projectManager = { create, setStatus } as never;
    const panel = makeLeftPanelForTest(
      state,
      store,
      merged,
      tm,
      (opts.app ?? null) as never,
      save,
      projectStore,
      projectManager,
      undefined,
      saveViewState,
    );
    const el = freshContainer();
    if (opts.attached === true) {
      el.tabIndex = -1;
      activeDocument.body.append(el);
    }
    panel.mount(el);
    const setActiveProjects = (next: typeof fullProjects): void => {
      activeProjects = next;
    };
    return {
      panel,
      state,
      el,
      tm,
      save,
      saveViewState,
      merged,
      taskList,
      create,
      setStatus,
      refreshStore,
      setActiveProjects,
    };
  }

  it('renders once for a batched navigation commit and once for a standalone relevant change', () => {
    const { state, el, taskList } = makeFull({
      tasks: [task({ tags: ['#work'] })],
      settings: { pinnedTags: ['#work'] },
    });
    taskList.mockClear();

    state.batch(() => {
      state.set('selectedList', { type: 'tag', tag: '#work' });
      state.set('mode', 'calendar');
      state.set('centerListViewState', {
        groupBy: 'tag',
        sortBy: { field: 'title', dir: 'asc' },
        filters: [],
      });
    });

    expect(taskList).toHaveBeenCalledOnce();
    const activePinned = expectDefined(
      el.querySelector<HTMLElement>('.abyss-pinned-tag.is-active'),
    );
    expect(activePinned.querySelector('.abyss-left-count')?.textContent).toBe('1');

    taskList.mockClear();
    state.set('selectedList', 'upcoming');

    expect(taskList).toHaveBeenCalledOnce();
    expect(el.querySelector('.abyss-pinned-tag.is-active')).toBeNull();
    expect(el.querySelector('.abyss-left-item.is-active .abyss-left-label')?.textContent).toBe(
      'Upcoming',
    );
  });

  it('renders a chevron span (SVG icon, not a text glyph) on the Tags header', () => {
    const { el } = makeFull({
      settings: { tagGroups: [{ id: 'g', name: 'W', mode: 'manual', tags: ['#w'] }] },
    });
    const chevron = el.querySelector('.abyss-left-section--tags .abyss-left-section-chevron');
    expect(chevron).toBeTruthy();
    expect(chevron?.textContent).toBe('');
  });

  it('keeps Pinned, Projects, and Tags hierarchy without decorative divider elements', () => {
    const { el } = makeFull({
      settings: { pinnedTags: ['#focus'] },
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    const headings = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-left-section-title'),
      (element) => element.textContent,
    );

    expect(headings).toEqual(['Pinned', 'Projects', 'Tags']);
    expect(el.querySelector('.abyss-left-divider')).toBeNull();
  });

  it('persists section collapse through saved view state', () => {
    const { el, save, saveViewState, merged } = makeFull({});
    const header = el.querySelector(
      '.abyss-left-section--tags .abyss-left-section-header',
    ) as HTMLElement;
    header.click();
    expect(merged.sectionCollapse.tags).toBe(true);
    expect(saveViewState).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it('renders active projects capped at 10 with a show-more affordance', () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({
      path: `Projects/P${i}.md`,
      name: `P${i}`,
    }));
    const { el } = makeFull({ projects });
    expect(el.querySelectorAll('.abyss-project-item')).toHaveLength(10);
    expect(el.querySelector('.abyss-left-showmore')).toBeTruthy();
  });

  it('project badge counts active (total − done − cancelled = open + in-progress)', () => {
    // 4 tasks: 1 open + 1 in-progress + 1 done + 1 cancelled → active = 2.
    const projects = [
      {
        path: 'Projects/A.md',
        name: 'A',
        stats: {
          total: 4,
          done: 1,
          cancelled: 1,
          inProgress: 1,
          tracked: { closedMs: 0, openStartsMs: [] },
        },
      },
    ];
    const { el } = makeFull({ projects });
    expect(el.querySelector('.abyss-project-item .abyss-left-count')?.textContent).toBe('2');
  });

  it('clicking a project selects it without leaving tasks mode', () => {
    const { el, state } = makeFull({ projects: [{ path: 'Projects/A.md', name: 'A' }] });
    (el.querySelector('.abyss-project-item') as HTMLElement).click();
    expect(state.get('selectedList')).toEqual({ type: 'project', path: 'Projects/A.md' });
    expect(state.get('mode')).toBe('tasks');
  });

  it('does not render the Projects section when there are no active projects', () => {
    const { el } = makeFull({ projects: [] });
    expect(el.querySelector('.abyss-left-section--projects')).toBeNull();
  });

  it('refreshes only the Projects section without querying all tasks', () => {
    const { panel, el, taskList } = makeFull({
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    const tagsBefore = expectDefined(el.querySelector('.abyss-left-section--tags'));
    taskList.mockClear();

    panel.refreshProjectSettings();

    expect(taskList).not.toHaveBeenCalled();
    expect(el.querySelector('.abyss-left-section--tags')).toBe(tagsBefore);
    expect(el.querySelector('.abyss-project-item')).not.toBeNull();
  });

  it('tags + opens an input that creates a manual group', () => {
    const { el, tm } = makeFull({});
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    (el.querySelector('.abyss-left-section--tags .abyss-left-add') as HTMLElement).click();
    const input = el.querySelector('.abyss-left-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'Focus';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(spy).toHaveBeenCalledWith('Focus');
  });

  it('tags + creates only ONE group (Enter then blur must not double-fire)', () => {
    const { el, tm } = makeFull({});
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    (el.querySelector('.abyss-left-section--tags .abyss-left-add') as HTMLElement).click();
    const input = el.querySelector('.abyss-left-add-input') as HTMLInputElement;
    input.value = 'next';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    input.dispatchEvent(new FocusEvent('blur'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drag-reorders tag groups on the left panel and persists the order', () => {
    const { el, merged, save } = makeFull({
      settings: {
        tagGroups: [
          { id: 'g1', name: 'A', mode: 'manual', tags: ['#a', '#x'] },
          { id: 'g2', name: 'B', mode: 'manual', tags: ['#b', '#y'] },
        ],
      },
    });
    const headers = el.querySelectorAll('.abyss-tag-group-header');
    expect(headers).toHaveLength(2);
    // Drop group g1 onto g2's header → g1 moves to g2's slot.
    const dt = {
      getData: (t: string) => (t === 'application/x-abyss-taggroup' ? 'g1' : ''),
      types: ['application/x-abyss-taggroup'],
      setData: () => {},
    };
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dt });
    expectDefined(headers[1]).dispatchEvent(drop);
    expect(merged.tagGroups.map((g) => g.id)).toEqual(['g2', 'g1']);
    expect(save).toHaveBeenCalled();
  });

  it('tags + input is placed directly under the header (not at the bottom)', () => {
    const { el } = makeFull({
      settings: {
        tagGroups: [
          { id: 'a', name: 'A', mode: 'manual', tags: ['#a', '#b'] },
          { id: 'c', name: 'C', mode: 'manual', tags: ['#c', '#d'] },
        ],
      },
    });
    (el.querySelector('.abyss-left-section--tags .abyss-left-add') as HTMLElement).click();
    const body = el.querySelector(
      '.abyss-left-section--tags .abyss-left-section-body',
    ) as HTMLElement;
    expect(body.firstElementChild?.classList.contains('abyss-left-add-input')).toBe(true);
  });

  it('consumes Escape in the inline add and moves focus to the left panel', () => {
    const { el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    const bubbled = vi.fn();
    activeDocument.addEventListener('keydown', bubbled);
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Draft';
      const escape = keydown(input, 'Escape');

      // A handler that only re-renders leaves the event unprevented and lets PanelView see it.
      expect(escape.defaultPrevented).toBe(true);
      expect(bubbled).not.toHaveBeenCalled();
      expect(input.isConnected).toBe(false);
      expect(activeDocument.activeElement).toBe(el);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      activeDocument.removeEventListener('keydown', bubbled);
      el.remove();
    }
  });

  it('moves focus to the left panel after Enter creates a tag group or cancels an empty name', async () => {
    const { el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Focus';
      keydown(input, 'Enter');
      await flushMicrotasks();
      expect(spy).toHaveBeenCalledExactlyOnceWith('Focus');
      expect(activeDocument.activeElement).toBe(el);

      const empty = openInlineAdd(el, 'tags');
      keydown(empty, 'Enter');
      expect(empty.isConnected).toBe(false);
      expect(activeDocument.activeElement).toBe(el);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      el.remove();
    }
  });

  it.each(['composing', 'legacy'] as const)(
    'leaves an IME-owned Enter and Escape to the IME (%s)',
    (ime) => {
      const { el, tm } = makeFull({ attached: true });
      const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
      try {
        const input = openInlineAdd(el, 'tags');
        input.value = 'かな';
        const enter = dispatchImeKey(input, 'Enter', ime);
        const escape = dispatchImeKey(input, 'Escape', ime);

        // A handler that checks only `isComposing` fails the legacy keyCode 229 case.
        expect(spy).not.toHaveBeenCalled();
        expect(input.isConnected).toBe(true);
        expect(enter.defaultPrevented).toBe(false);
        expect(escape.defaultPrevented).toBe(false);
      } finally {
        el.remove();
      }
    },
  );

  it('keeps focus where the user put it when the blur commit runs', async () => {
    vi.useFakeTimers();
    const { el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    const outside = activeDocument.body.createEl('button');
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Later';
      outside.focus();
      // The async advance also settles the commit, whose focus handling runs after `onCommit`.
      await vi.advanceTimersByTimeAsync(150);

      // A commit that always focuses the panel would steal focus from the outside button.
      expect(spy).toHaveBeenCalledExactlyOnceWith('Later');
      expect(activeDocument.activeElement).toBe(outside);
    } finally {
      vi.useRealTimers();
      outside.remove();
      el.remove();
    }
  });

  it('keeps a failed tag group name editable, says why, and retries on Enter', async () => {
    const { el, tm } = makeFull({ attached: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Settings could not be saved.');
    const spy = vi
      .spyOn(tm, 'createManualGroup')
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Focus';
      keydown(input, 'Enter');
      await flushMicrotasks();

      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Could not add the tag group. Settings could not be saved.',
      );
      expect(log).toHaveBeenCalledOnce();
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe('Focus');
      expect(activeDocument.activeElement).toBe(input);

      keydown(input, 'Enter');
      await flushMicrotasks();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(input.isConnected).toBe(false);
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('ends the session instead of retrying when a create fails after focus left', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Disk full.');
    let reject!: (error: Error) => void;
    const { el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const outside = activeDocument.body.createEl('button');
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Focus';
      keydown(input, 'Enter');
      outside.focus();
      reject(failure);
      await vi.advanceTimersByTimeAsync(150);

      // Resetting `committed` while focus is elsewhere would let the blur check retry on its own.
      expect(spy).toHaveBeenCalledOnce();
      expect(Notice).toHaveBeenCalledExactlyOnceWith('Could not add the tag group. Disk full.');
      expect(el.querySelector('.abyss-left-add-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(outside);
    } finally {
      vi.useRealTimers();
      outside.remove();
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('ends a partial project create without a retry and names the created note', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new ProjectCreationError('Could not set the status for Projects/New.md.', {
      createdPath: 'Projects/New.md',
      phase: 'status',
      statusId: 'active',
      cause: new Error('Status property is missing.'),
    });
    const { el, create, refreshStore } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      create: () => Promise.reject(failure),
    });
    try {
      const input = openInlineAdd(el, 'projects');
      input.value = 'New';
      keydown(input, 'Enter');
      await flushMicrotasks();
      keydown(input, 'Enter');
      await flushMicrotasks();

      expect(create).toHaveBeenCalledOnce();
      expect(refreshStore).toHaveBeenCalledOnce();
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Created Projects/New.md, but could not set its status. Status property is missing.',
      );
      expect(el.querySelector('.abyss-left-add-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(el);
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('names the created note when it cannot be opened and never creates it twice', async () => {
    const file = { path: 'Projects/New.md' };
    const failure = new Error('Leaf is gone.');
    const openFile = vi.fn(() => Promise.reject(failure));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { el, create, refreshStore } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      create: () => Promise.resolve(file),
      app: { workspace: { getLeaf: () => ({ openFile }) } },
    });
    try {
      const input = openInlineAdd(el, 'projects');
      input.value = 'New';
      keydown(input, 'Enter');
      await flushMicrotasks();
      keydown(input, 'Enter');
      await flushMicrotasks();

      // Letting the open failure reach the session turns it into a failed create and a retry.
      expect(create).toHaveBeenCalledExactlyOnceWith('New');
      expect(openFile).toHaveBeenCalledExactlyOnceWith(file);
      expect(refreshStore).toHaveBeenCalledOnce();
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Created Projects/New.md, but could not open it. Leaf is gone.',
      );
      expect(el.querySelector('.abyss-left-add-input')).toBeNull();
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not open the created project',
      {
        path: 'Projects/New.md',
        error: failure,
      },
    );
  });

  it('keeps a destroyed panel empty when its create settles', async () => {
    let settle!: () => void;
    const { panel, el } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      create: () =>
        new Promise((resolve) => {
          settle = () => {
            resolve(null);
          };
        }),
    });
    try {
      const input = openInlineAdd(el, 'projects');
      input.value = 'New';
      keydown(input, 'Enter');
      panel.destroy();
      settle();
      await flushMicrotasks();

      // A settle that re-renders every session it finishes would rebuild the destroyed panel.
      expect(el.childElementCount).toBe(0);
    } finally {
      el.remove();
    }
  });

  it('keeps a destroyed panel empty when a create settles after another inline add opened', async () => {
    let settle!: () => void;
    const { panel, el } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      create: () =>
        new Promise((resolve) => {
          settle = () => {
            resolve(null);
          };
        }),
    });
    try {
      const name = openInlineAdd(el, 'projects');
      name.value = 'New';
      keydown(name, 'Enter');
      openInlineAdd(el, 'tags');
      panel.destroy();
      settle();
      await flushMicrotasks();

      // Ending only the recorded session would let the earlier project create rebuild the panel.
      expect(el.childElementCount).toBe(0);
    } finally {
      el.remove();
    }
  });

  it('never commits a blurred tag name after destroy when another inline add took focus', () => {
    vi.useFakeTimers();
    const { panel, el, tm } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    try {
      const tag = openInlineAdd(el, 'tags');
      tag.value = 'Draft';
      const name = openInlineAdd(el, 'projects');
      expect(activeDocument.activeElement).toBe(name);

      panel.destroy();
      vi.advanceTimersByTime(150);

      // Ending only the recorded session would let the blurred tag name commit after teardown.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      el.remove();
    }
  });

  it('removes a rolled-back tag group when its save fails after an Escape', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Settings could not be saved.');
    const { el, save } = makeFull({ attached: true });
    let rejectSave!: (error: Error) => void;
    save.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        rejectSave = fail;
      }),
    );
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Focus';
      keydown(input, 'Enter');
      keydown(input, 'Escape');
      expect(tagLabels(el)).toContain('Focus');

      rejectSave(failure);
      await flushMicrotasks();

      // Ending the session at Escape leaves the rolled-back group on screen.
      expect(tagLabels(el)).not.toContain('Focus');
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Could not add the tag group. Settings could not be saved.',
      );
      expect(activeDocument.activeElement).toBe(el);
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('removes a rolled-back tag group a refresh drew and keeps the input for a retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Settings could not be saved.');
    const { panel, el, tm, save, taskList } = makeFull({ attached: true });
    const create = vi.spyOn(tm, 'createManualGroup');
    let rejectSave!: (error: Error) => void;
    save.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        rejectSave = fail;
      }),
    );
    try {
      const input = openInlineAdd(el, 'tags');
      // Run the input's own focus task now, so only the failure's render can refocus it later.
      await flushMicrotasks();
      input.value = 'Focus';
      keydown(input, 'Enter');
      panel.refresh();
      expect(tagLabels(el)).toContain('Focus');
      taskList.mockClear();

      rejectSave(failure);
      await flushMicrotasks();

      // A retry branch that returns without rendering leaves the rolled-back group on screen.
      expect(tagLabels(el)).not.toContain('Focus');
      // Each render reads the task list once; the retry renders exactly once.
      expect(taskList).toHaveBeenCalledOnce();
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Could not add the tag group. Settings could not be saved.',
      );
      expect(el.querySelector('.abyss-left-section--tags .abyss-left-add-input')).toBe(input);
      expect(input.value).toBe('Focus');
      expect(activeDocument.activeElement).toBe(input);

      keydown(input, 'Enter');
      await flushMicrotasks();
      expect(create.mock.calls).toEqual([['Focus'], ['Focus']]);
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('keeps a failed tag group input for a retry without a render when none ran', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Settings could not be saved.');
    const { el, tm, save, taskList } = makeFull({ attached: true });
    const create = vi.spyOn(tm, 'createManualGroup');
    let rejectSave!: (error: Error) => void;
    save.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        rejectSave = fail;
      }),
    );
    try {
      const input = openInlineAdd(el, 'tags');
      // Run the input's own focus task now, so only a render can refocus it later.
      await flushMicrotasks();
      input.value = 'Focus';
      input.setSelectionRange(1, 3);
      keydown(input, 'Enter');
      taskList.mockClear();

      rejectSave(failure);
      await flushMicrotasks();

      // A retry that renders every time costs a full panel pass for each failed Enter.
      expect(taskList).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Could not add the tag group. Settings could not be saved.',
      );
      expect(el.querySelector('.abyss-left-section--tags .abyss-left-add-input')).toBe(input);
      expect(input.value).toBe('Focus');
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
      expect(activeDocument.activeElement).toBe(input);
      expect(tagLabels(el)).not.toContain('Focus');

      keydown(input, 'Enter');
      await flushMicrotasks();
      expect(create.mock.calls).toEqual([['Focus'], ['Focus']]);
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('ends a failed tag group add that a newer settings save kept', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('older save rejected');
    const { el, tm, save, merged } = makeFull({ attached: true });
    const create = vi.spyOn(tm, 'createManualGroup');
    let rejectSave!: (error: Error) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    save.mockImplementationOnce(() => {
      markSaveStarted();
      return new Promise<void>((_resolve, fail) => {
        rejectSave = fail;
      });
    });
    try {
      const input = openInlineAdd(el, 'tags');
      await flushMicrotasks();
      input.value = 'Focus';
      keydown(input, 'Enter');
      await saveStarted;
      await tm.pinTag('#newer');
      rejectSave(failure);
      await flushMicrotasks();
      keydown(input, 'Enter');
      await flushMicrotasks();

      // A failure that retries whenever the input holds focus adds the kept group a second time.
      expect(merged.tagGroups.filter((group) => group.tags?.includes('#focus') === true)).toEqual([
        { id: 'group-focus', name: 'Focus', mode: 'manual', tags: ['#focus'] },
      ]);
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'An earlier request to add tag group was not saved. Newer changes were kept.',
      );
      expect(input.isConnected).toBe(false);
      expect(create).toHaveBeenCalledOnce();
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('ends a failed tag group add whose input a second inline add replaced as the record', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Settings could not be saved.');
    const { el, tm, save } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    const create = vi.spyOn(tm, 'createManualGroup');
    let rejectSave!: (error: Error) => void;
    save.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        rejectSave = fail;
      }),
    );
    try {
      const tag = openInlineAdd(el, 'tags');
      tag.value = 'Focus';
      keydown(tag, 'Enter');
      openInlineAdd(el, 'projects');
      tag.focus();
      simulateBlurDuringEmpty(el, tag);

      rejectSave(failure);
      // Every 150 ms blur check runs, including one that a later render's blur starts.
      await vi.runAllTimersAsync();

      // Without the record check the failed session stays open while a render drops its input,
      // and its blur check creates the group again.
      expect(create).toHaveBeenCalledOnce();
      expect(Notice).toHaveBeenCalledExactlyOnceWith(
        'Could not add the tag group. Settings could not be saved.',
      );
      expect(tag.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('ignores a held Enter after a failed tag group add', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Settings could not be saved.');
    const { el, tm } = makeFull({ attached: true });
    const create = vi
      .spyOn(tm, 'createManualGroup')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue();
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Focus';
      keydown(input, 'Enter');
      expect(create).toHaveBeenCalledOnce();
      await flushMicrotasks();
      expect(activeDocument.activeElement).toBe(input);

      const held = new KeyboardEvent('keydown', {
        key: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(held);
      await flushMicrotasks();

      // A handler that ignores `event.repeat` loops create, failure, and Notice while Enter is held.
      expect(create).toHaveBeenCalledOnce();
      expect(held.defaultPrevented).toBe(true);
      expect(input.isConnected).toBe(true);
      expect(Notice).toHaveBeenCalledOnce();
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('keeps a destroyed panel empty when a create dismissed with Escape fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Disk full.');
    let reject!: (error: Error) => void;
    const { panel, el, tm } = makeFull({ attached: true });
    vi.spyOn(tm, 'createManualGroup').mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Focus';
      keydown(input, 'Enter');
      keydown(input, 'Escape');
      panel.destroy();
      reject(failure);
      await flushMicrotasks();

      // Dropping a dismissed session from the live set would let its failure rebuild the panel.
      expect(el.childElementCount).toBe(0);
      expect(Notice).toHaveBeenCalledExactlyOnceWith('Could not add the tag group. Disk full.');
    } finally {
      el.remove();
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not finish the inline add',
      failure,
    );
  });

  it('keeps a second inline add open when the first create settles', async () => {
    let settle!: () => void;
    const { el } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      create: () =>
        new Promise((resolve) => {
          settle = () => {
            resolve(null);
          };
        }),
    });
    try {
      const name = openInlineAdd(el, 'projects');
      name.value = 'New';
      keydown(name, 'Enter');
      const tag = openInlineAdd(el, 'tags');
      tag.value = 'Draft';
      settle();
      await flushMicrotasks();

      // Ending a session by clearing the panel's record unconditionally would drop this input.
      expect(el.querySelector('.abyss-left-section--tags .abyss-left-add-input')).toBe(tag);
      expect(tag.value).toBe('Draft');
      expect(activeDocument.activeElement).toBe(tag);
    } finally {
      el.remove();
    }
  });

  it('keeps the typed name, caret, and focus across a refresh without committing it', () => {
    vi.useFakeTimers();
    const { panel, el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Partial name';
      input.setSelectionRange(3, 7);
      simulateBlurDuringEmpty(el, input);

      panel.refresh();
      vi.advanceTimersByTime(150);

      expect(el.querySelector('.abyss-left-add-input')).toBe(input);
      expect(input.value).toBe('Partial name');
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
      expect(activeDocument.activeElement).toBe(input);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      el.remove();
    }
  });

  it('keeps a project name input across a project settings refresh', () => {
    const { panel, el } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    try {
      const input = openInlineAdd(el, 'projects');
      input.value = 'Draft';

      panel.refreshProjectSettings();

      const section = expectDefined(el.querySelector('.abyss-left-section--projects'));
      expect(section.querySelector('.abyss-left-add-input')).toBe(input);
      expect(activeDocument.activeElement).toBe(input);
    } finally {
      el.remove();
    }
  });

  it('still creates a blurred name when a header click collapses its section', () => {
    vi.useFakeTimers();
    const { el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Blurred';
      el.focus();
      expectDefined(
        el.querySelector<HTMLElement>('.abyss-left-section--tags .abyss-left-section-header'),
      ).click();
      vi.advanceTimersByTime(150);

      // A render that discards every session it cannot place would drop this blur commit.
      expect(spy).toHaveBeenCalledExactlyOnceWith('Blurred');
    } finally {
      vi.useRealTimers();
      el.remove();
    }
  });

  it('ends a focused session without committing when its section disappears', () => {
    vi.useFakeTimers();
    const { panel, el, create, setActiveProjects } = makeFull({
      attached: true,
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    try {
      const input = openInlineAdd(el, 'projects');
      input.value = 'Partial';
      simulateBlurDuringEmpty(el, input);
      setActiveProjects([]);

      panel.refresh();
      vi.advanceTimersByTime(150);

      expect(el.querySelector('.abyss-left-section--projects')).toBeNull();
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      el.remove();
    }
  });

  it('never commits a typed name after destroy', () => {
    vi.useFakeTimers();
    const { panel, el, tm } = makeFull({ attached: true });
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    try {
      const input = openInlineAdd(el, 'tags');
      input.value = 'Partial';
      simulateBlurDuringEmpty(el, input);

      panel.destroy();
      vi.advanceTimersByTime(150);

      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      el.remove();
    }
  });

  function openProjectMenu(el: HTMLElement): Menu {
    const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    openContextMenu(expectDefined(el.querySelector('.abyss-project-item')));
    return expectDefined(show.mock.instances[0]) as Menu;
  }

  function chooseStatus(menu: Menu, index: number): void {
    clickNativeItem(nativeMenuItems(nativeMenuItem(menu, 'Change status').submenu)[index]);
  }

  it('shows the validation message when a sidebar status change is refused', async () => {
    const consoleError = vi.spyOn(console, 'error');
    const { el } = makeFull({
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      setStatus: () => Promise.reject(new ProjectEditValidationError(STATUS_VALIDATION)),
    });

    chooseStatus(openProjectMenu(el), 1);
    await flushMicrotasks();

    expect(noticeTexts()).toEqual([STATUS_VALIDATION]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports a failed sidebar status write once with its cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('disk full');
    const { el, setStatus } = makeFull({
      projects: [{ path: 'Projects/A.md', name: 'A' }],
      setStatus: () => Promise.reject(cause),
    });
    const statusId = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]).id;

    chooseStatus(openProjectMenu(el), 1);
    await flushMicrotasks();

    expect(setStatus).toHaveBeenCalledExactlyOnceWith('Projects/A.md', statusId);
    expect(noticeTexts()).toEqual(['Could not change the project status. disk full']);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[abyss-tasks] Could not change the project status',
      { path: 'Projects/A.md', statusId, cause },
    );
  });

  it('refreshes and redraws after a sidebar status change without a Notice', async () => {
    const { el, panel, refreshStore } = makeFull({
      projects: [{ path: 'Projects/A.md', name: 'A' }],
    });
    const menu = openProjectMenu(el);
    const render = vi.spyOn(
      panel as unknown as { render_abyssPrivate(): void },
      'render_abyssPrivate',
    );

    chooseStatus(menu, 1);
    await flushMicrotasks();

    expect(refreshStore).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(Notice).not.toHaveBeenCalled();
  });

  it('reports a failed Open note from the sidebar project menu', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('leaf closed');
    const app = await createAppWithFiles({ 'Projects/A.md': '' });
    vi.spyOn(app.workspace, 'getLeaf').mockReturnValue({
      openFile: vi.fn().mockRejectedValue(failure),
    } as never);
    const { el } = makeFull({ projects: [{ path: 'Projects/A.md', name: 'A' }], app });

    clickNativeItem(nativeMenuItem(openProjectMenu(el), 'Open note'));
    await flushMicrotasks();

    expect(noticeTexts()).toEqual(['Could not open Projects/A.md. leaf closed']);
    expect(log).toHaveBeenCalledExactlyOnceWith('[abyss-tasks] Could not open the project note', {
      path: 'Projects/A.md',
      error: failure,
    });
  });
});

describe('configured promoted group customization identity', () => {
  it('uses only the configured exact key for a discovered-looking ID', () => {
    const id = 'discovered:tag:%23Work';
    const ownKey = `group:${id}`,
      aliasKey = 'group:discovered:tag:%23work';
    const custom = {
      groupBy: 'priority' as const,
      sortBy: { field: 'date' as const, dir: 'asc' as const },
      filters: [],
    };
    const groups = [
      { id, name: 'Promoted Work', mode: 'manual' as const, tags: ['#Work', '#Other'] },
    ];
    const missing = makePanel([], { tagGroups: groups, listViewStates: { [aliasKey]: custom } });
    expect(missing.el.querySelector('.abyss-left-custom-dot')).toBeNull();
    missing.panel.destroy();
    const present = makePanel([], {
      tagGroups: groups,
      listViewStates: { [aliasKey]: custom, [ownKey]: custom },
    });
    expect(present.el.querySelector('.abyss-left-custom-dot')).not.toBeNull();
    expect(present.merged.listViewStates?.[aliasKey]).toEqual(custom);
    present.panel.destroy();
  });
});

it('keeps a case-alias discovered prefix selection visibly active', () => {
  const { panel, el, state } = makePanel([task({ tags: ['#Work/子'] })], { tagGroups: [] });
  state.set('selectedList', { type: 'group', groupId: 'discovered:prefix:Work' });
  expect(el.querySelector('.abyss-tag-group-header.is-active .abyss-left-label')?.textContent).toBe(
    'Work',
  );
  panel.destroy();
});

it('counts all 22 active Inbox nodes in smart, exact and prefix navigation independent of center filters', async () => {
  const openTasks = Array.from({ length: 21 }, (_, i) => `- [ ] Open ${i} #type/inbox`).join('\n');
  const markdown = `${openTasks}\n- [/] Working #type/inbox\n`;
  const settings = {
    ...DEFAULT_SETTINGS,
    inbox: { ...DEFAULT_SETTINGS.inbox, mode: 'tag' as const, tag: '#type/inbox' },
  };
  const h = await createCanonicalSearchHarness({ 'counts.md': markdown }, settings);
  const { el, panel, state } = makePanel([...h.index.list()], settings, ['#type/inbox']);
  try {
    const badge = (selector: string) => el.querySelector(selector)?.textContent;
    expect(badge('.abyss-left-item .abyss-left-count')).toBe('22');
    expect(badge('.abyss-pinned-tag .abyss-left-count')).toBe('22');
    expect(badge('.abyss-tag-group-header .abyss-left-count')).toBe('22');
    const input = {
      tasks: h.index.listNodes(),
      settings,
      today: localDate('2026-10-08'),
      nowMs: 0,
      viewState: getListViewDefaults('inbox'),
    };
    for (const selection of [
      'inbox',
      { type: 'tag', tag: '#type/inbox' },
      { type: 'group', groupId: 'discovered:prefix:type' },
    ] as const) {
      expect(selectTaskNodes({ ...input, selection })).toHaveLength(22);
    }
    expect(selectTaskNodes({ ...input, selection: 'inbox', textQuery: 'Working' })).toHaveLength(1);
    state.set('centerFilter', 'Working');
    state.set('centerListViewState', { ...input.viewState, statusGroups: ['done'] });
    panel.refresh();
    expect(badge('.abyss-left-item .abyss-left-count')).toBe('22');
    expect(badge('.abyss-pinned-tag .abyss-left-count')).toBe('22');
    expect(badge('.abyss-tag-group-header .abyss-left-count')).toBe('22');
  } finally {
    panel.destroy();
    h.close();
  }
});

it('counts independently active canonical children, ranges and custom status symbols after exclusions', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 8, 12));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.inbox = { ...settings.inbox, mode: 'both', tag: '#inbox' };
  settings.tagGroups = [
    { id: 'inbox-group', name: 'Inbox group', mode: 'prefix', prefix: 'inbox' },
    { id: 'dormant-group', name: 'Dormant group', mode: 'manual', tags: ['#dormant'] },
  ];
  settings.taskStatuses = settings.taskStatuses.filter(
    ({ symbol }) => symbol !== '?' && symbol !== '!',
  );
  settings.taskStatuses.push(
    { id: 'custom-todo', symbol: '!', name: 'Custom todo', type: 'todo', icon: '', core: false },
    {
      id: 'custom-progress',
      symbol: '?',
      name: 'Custom progress',
      type: 'in-progress',
      icon: '',
      core: false,
    },
  );
  const h = await createCanonicalSearchHarness(
    {
      'nodes.md':
        '- [!] Parent #one-off\n  - [?] Child #INBOX 🛫 2026-10-07 📅 2026-10-09\n    - [ ] Deep untagged\n    - [ ] Deep tagged #inbox #INBOX/deep #archived\n  - [x] Done #inbox\n- [ ] Both #inbox\n  - [?] Both child #inbox 🛫 2026-10-08\n- [x] Completed parent\n  - [!] Independent #inbox 🛫 2026-10-10\n- [ ] Root untagged',
      'excluded.md': '- [!] Excluded #inbox\n  - [?] Excluded child #inbox 🛫 2026-10-08',
    },
    settings,
  );
  await h.index.refreshSourceExclusion(({ filePath }) => filePath === 'excluded.md');
  const { el, panel } = makePanel(
    [...h.index.list()],
    settings,
    ['#inbox', '#one-off', '#dormant', '#archived'],
    ['#archived'],
  );
  try {
    const badges = Array.from(el.querySelectorAll('.abyss-left-section > .abyss-left-item'))
      .slice(0, 3)
      .map((row) => row.querySelector('.abyss-left-count')?.textContent);
    expect(badges).toEqual(['6', '2', '2']);
    expect(
      Array.from(el.querySelectorAll('.abyss-pinned-tag .abyss-left-count')).map(
        (badge) => badge.textContent,
      ),
    ).toEqual(['5', '1']);
    expect(el.querySelectorAll('.abyss-pinned-tag')).toHaveLength(3);
    expect(el.querySelector('.abyss-tag-group-header .abyss-left-count')?.textContent).toBe('5');
    expect(el.textContent).toContain('Dormant group');
    expect(el.textContent).not.toContain('archived');
    const input = {
      tasks: h.index.listNodes(),
      settings,
      today: localDate('2026-10-08'),
      nowMs: 0,
      viewState: getListViewDefaults('inbox'),
    };
    expect(selectTaskNodes({ ...input, selection: 'inbox' })).toHaveLength(6);
    expect(selectTaskNodes({ ...input, selection: 'today' })).toHaveLength(2);
    expect(selectTaskNodes({ ...input, selection: 'upcoming' })).toHaveLength(2);
    expect(
      selectTaskNodes({
        ...input,
        selection: 'inbox',
        viewState: { ...input.viewState, statusGroups: ['done'] },
      }).map(({ node }) => node.title),
    ).toEqual(['Done', 'Completed parent']);
  } finally {
    panel.destroy();
    h.close();
    vi.useRealTimers();
  }
});

it('renders all Analysis rows from the owning port and preserves sidebar focus/scroll on active updates', () => {
  const state = new AppState();
  state.set('mode', 'statistics');
  const settings = structuredClone(DEFAULT_SETTINGS);
  const tasks = makeStubStore([]);
  const tags = new TagManager(null as never, settings, async () => {}, {
    check: () => 'ready',
    apply: async (_change, live) => {
      live();
    },
  });
  let view: StatisticsViewId = 'rhythm';
  const listeners = new Set<() => void>();
  const navigation: StatisticsNavigationPort = {
    snapshot: () => ({ view, scopeLabel: 'Entire vault' }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selectView: (next) => {
      view = next;
      listeners.forEach((listener) => {
        listener();
      });
    },
    openScope: () => {},
  };
  const close = vi.fn();
  const panel = new LeftPanel({
    state,
    settings,
    tagManager: tags,
    app: null as never,
    tasks,
    statisticsNavigation: navigation,
    onAnalysisNavigate: close,
  });
  const host = document.body.createDiv();
  try {
    panel.mount(host);
    const rows = host.querySelectorAll<HTMLButtonElement>('[data-statistics-view]');
    expect(rows).toHaveLength(11);
    expect([...rows].map((row) => row.textContent)).toEqual([
      'Rhythm',
      'Completion',
      'Deadlines',
      'Cohorts',
      'Allocation',
      'Timeline',
      'Sessions',
      'Patterns',
      'Movement',
      'Aging',
      'Dependencies',
    ]);
    expect(host.textContent).toContain('Analysis');
    host.scrollTop = 193;
    const allocation = expectDefined(
      host.querySelector<HTMLButtonElement>('[data-statistics-view="allocation"]'),
    );
    allocation.focus();
    allocation.click();
    expect(view).toBe('allocation');
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('Allocation');
    expect(host.scrollTop).toBe(193);
    expect(document.activeElement).toBe(host.querySelector('[data-statistics-view="allocation"]'));
    expect(close).toHaveBeenCalledTimes(1);
    expectDefined(
      host.querySelector<HTMLButtonElement>('[data-statistics-view="allocation"]'),
    ).click();
    expect(close).toHaveBeenCalledTimes(2);
    expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Scope"]')).click();
    expect(close).toHaveBeenCalledTimes(3);
    state.set('mode', 'tasks');
    expect(host.textContent).toContain('Inbox');
    expect(host.querySelector('[data-statistics-view]')).toBeNull();
    navigation.selectView('cohorts');
    expect(host.textContent).toContain('Inbox');
  } finally {
    panel.destroy();
    host.remove();
  }
  expect(listeners.size).toBe(0);
});
