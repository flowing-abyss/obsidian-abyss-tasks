import type * as ObsidianModule from 'obsidian';
import { Menu, Notice, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { RenameTagModal } from '../src/tags/RenameTagModal';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskSnapshot } from '../src/tasks';
import { TagGroupAppearanceModal } from '../src/ui/TagGroupAppearanceModal';
import {
  expectDefined,
  flushMicrotasks,
  freshContainer,
  makeLeftPanelForTest,
  makeStubStore,
  methodOf,
  objectMatching,
  subtask,
  task,
  useRealMoment,
} from './helpers';

function firstNoticeText(): string {
  const message = vi.mocked(Notice).mock.calls[0]?.[0];
  if (typeof message === 'string') return message;
  return message?.textContent ?? '';
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
  const tm = new TagManager(null as never, merged, save);
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

function today(): string {
  return (window as unknown as { moment: (inp?: unknown) => { format(f: string): string } })
    .moment()
    .format('YYYY-MM-DD');
}

describe('LeftPanel smart lists', () => {
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
        source: { originalMarkdown: '- [ ] t #inbox', originalBlock: '- [ ] t #inbox' },
      }),
      task({
        status: 'open',
        tags: ['#inbox'],
        source: { originalMarkdown: '- [ ] t2 #inbox', originalBlock: '- [ ] t2 #inbox' },
      }),
      task({
        status: 'done',
        tags: ['#inbox'],
        source: { originalMarkdown: '- [x] done #inbox', originalBlock: '- [x] done #inbox' },
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

  it('countToday matches only due/scheduled === today', () => {
    const t = today();
    const tasks = [
      task({ status: 'open', planning: { due: t } }),
      task({ status: 'open', planning: { scheduled: t } }),
      task({ status: 'open', presentation: { dailyNoteDate: t } }),
      task({ status: 'open', planning: { due: '2020-01-01' } }),
      task({ status: 'done', planning: { due: t } }),
    ];
    const { el } = makePanel(tasks);
    const rows = el.querySelectorAll('.abyss-left-item');
    const todayRow = expectDefined(rows[1]);
    expect(todayRow.querySelector('.abyss-left-count')?.textContent).toBe('2');
  });

  it('countUpcoming matches due ?? scheduled > today', () => {
    const tasks = [
      task({ status: 'open', planning: { due: '2099-12-31' } }),
      task({ status: 'open', planning: { scheduled: '2099-01-01' } }),
      task({ status: 'open', presentation: { dailyNoteDate: '2099-06-01' } }),
      task({ status: 'open', planning: { due: '2020-01-01' } }),
      task({ status: 'done', planning: { due: '2099-12-31' } }),
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
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save);
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
        source: { originalMarkdown: '- [ ] #work task', originalBlock: '- [ ] #work task' },
      }),
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev task', originalBlock: '- [ ] #work/dev task' },
      }),
      task({
        status: 'done',
        tags: ['#work'],
        source: { originalMarkdown: '- [x] #work done', originalBlock: '- [x] #work done' },
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
    const tm = new TagManager(null as never, settings, save);
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
    const tm = new TagManager(null as never, settings, save);
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
    const tm = new TagManager(null as never, settings, save);
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
    const tm = new TagManager(null as never, settings, save);
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
        source: { originalMarkdown: '- [ ] #work/dev a', originalBlock: '- [ ] #work/dev a' },
      }),
      task({
        status: 'open',
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [ ] #work/dev b', originalBlock: '- [ ] #work/dev b' },
      }),
      task({
        status: 'done',
        tags: ['#work/dev'],
        source: { originalMarkdown: '- [x] #work/dev done', originalBlock: '- [x] #work/dev done' },
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
    const tm = new TagManager(null as never, settings, save);
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
        source: { originalMarkdown: '- [ ] #foo task', originalBlock: '- [ ] #foo task' },
      }),
      task({
        status: 'open',
        tags: ['#bar'],
        source: { originalMarkdown: '- [ ] #bar task', originalBlock: '- [ ] #bar task' },
      }),
      task({
        status: 'done',
        tags: ['#foo'],
        source: { originalMarkdown: '- [x] #foo done', originalBlock: '- [x] #foo done' },
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
    const { el, merged, save } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#ff0000' }],
    });
    save.mockRejectedValueOnce(new Error('settings storage unavailable'));

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
    expect(firstNoticeText()).toContain('not saved');
    expect(firstNoticeText()).toContain('rolled back');
  });

  it('does not let an older rejected appearance save overwrite a newer saved appearance', async () => {
    const { panel, merged, save } = makePanel([], {
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
    const applyAppearance = (
      panel as unknown as {
        applyTagGroupAppearance_abyssPrivate(
          target: CalendarSettings['tagGroups'][number],
          result: { readonly name?: string; readonly color?: string | null },
        ): void;
      }
    ).applyTagGroupAppearance_abyssPrivate.bind(panel);

    applyAppearance(group, { name: 'First edit' });
    await firstStarted;
    applyAppearance(group, { name: 'Newer edit', color: '#00ff00' });
    await flushMicrotasks();
    rejectFirst(new Error('older save rejected'));
    await flushMicrotasks();

    expect(group.name).toBe('Newer edit');
    expect(group.color).toBe('#00ff00');
    expect(save).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledOnce();
    expect(firstNoticeText()).toContain('Newer changes were kept');
    expect(firstNoticeText()).not.toContain('rolled back');
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
    expect(notice).toContain('settings were not saved');
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
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save);
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
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save);
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
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save);
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
    const tm = new TagManager(null as never, DEFAULT_SETTINGS, save);
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
  it('countInbox tag mode uses inbox.tag', () => {
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
      inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
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
    const inboxCount = el.querySelector('.abyss-left-item .abyss-left-count')?.textContent;

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
  it.each(['inspector-root', 'inspector-subtask', 'center-subtask'] as const)(
    'does not assign a parent tag for a %s drag',
    (kind) => {
      const root = task({ title: 'Root' });
      const child = subtask({ title: 'Child', ref: { parent: { type: 'task', ref: root.ref } } });
      Object.assign(root, { subtasks: [child] });
      const { el, state, execute } = makePanel([root], {}, ['#task/next']);
      const nested = kind !== 'inspector-root';
      state.set('draggingTaskNode', {
        source: kind === 'center-subtask' ? 'center-card' : 'inspector-subtask',
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
      patch: { tags: { add: ['#task/next'], remove: ['#task/inbox'] } },
    });
  });
});

describe('LeftPanel collapsible sections, projects, and tags +', () => {
  function makeFull(opts: {
    tasks?: TaskSnapshot[];
    settings?: Partial<CalendarSettings>;
    projects?: Array<{
      path: string;
      name: string;
      stats?: { total: number; done: number; cancelled: number; inProgress: number };
    }>;
  }) {
    const state = new AppState();
    const store = makeStubStore(opts.tasks ?? []);
    const merged: CalendarSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
    const save = vi.fn().mockResolvedValue(undefined);
    const tm = new TagManager(null as never, merged, save);
    const fullProjects = (opts.projects ?? []).map((p) => ({
      frontmatter: {},
      tags: [],
      statusId: null,
      rawStatus: null,
      stats: p.stats ?? { total: 0, done: 0, cancelled: 0, inProgress: 0 },
      ...p,
    }));
    const projectStore = {
      activeForLeftPanel: () => fullProjects,
      refresh: vi.fn(),
      onUpdate: () => () => {},
    } as never;
    const projectManager = { create: vi.fn().mockResolvedValue(null) } as never;
    const panel = makeLeftPanelForTest(
      state,
      store,
      merged,
      tm,
      null as never,
      save,
      projectStore,
      projectManager,
    );
    const el = freshContainer();
    panel.mount(el);
    return { panel, state, el, tm, save, merged };
  }

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

  it('persists section collapse via onSaveSettings', () => {
    const { el, save, merged } = makeFull({});
    const header = el.querySelector(
      '.abyss-left-section--tags .abyss-left-section-header',
    ) as HTMLElement;
    header.click();
    expect(merged.sectionCollapse.tags).toBe(true);
    expect(save).toHaveBeenCalled();
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
        stats: { total: 4, done: 1, cancelled: 1, inProgress: 1 },
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
});
