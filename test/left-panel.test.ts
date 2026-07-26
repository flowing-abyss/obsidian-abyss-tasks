import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskSnapshot } from '../src/tasks';
import {
  freshContainer,
  makeLeftPanelForTest,
  makeStubStore,
  task,
  useRealMoment,
} from './helpers';

useRealMoment();

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
  const panel = makeLeftPanelForTest(
    state,
    store,
    merged,
    tm,
    null as never,
    undefined,
    null,
    null,
    { queries, execute },
  );
  const el = freshContainer();
  panel.mount(el);
  return { panel, state, el, tm, execute };
}

function today(): string {
  return (window as unknown as { moment: (inp?: unknown) => { format(f: string): string } })
    .moment()
    .format('YYYY-MM-DD');
}

describe('LeftPanel smart lists', () => {
  it('renders Lists section header', () => {
    const { el } = makePanel();
    expect(el.querySelector('.tc-left-section-header')?.textContent).toBe('Lists');
  });

  it('renders Inbox/Today/Upcoming rows', () => {
    const { el } = makePanel();
    const labels = Array.from(el.querySelectorAll('.tc-left-item .tc-left-label')).map(
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
    const inboxRow = el.querySelector('.tc-left-item')!;
    expect(inboxRow.querySelector('.tc-left-count')?.textContent).toBe('2');
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
    const inboxRow = el.querySelector('.tc-left-item')!;
    expect(inboxRow.querySelector('.tc-left-count')?.textContent).toBe('1');
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
    const rows = el.querySelectorAll('.tc-left-item');
    const todayRow = rows[1]!;
    expect(todayRow.querySelector('.tc-left-count')?.textContent).toBe('2');
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
    const rows = el.querySelectorAll('.tc-left-item');
    const upcomingRow = rows[2]!;
    expect(upcomingRow.querySelector('.tc-left-count')?.textContent).toBe('2');
  });

  it('count badge absent when count is 0', () => {
    const { el } = makePanel([], {
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    });
    const inboxRow = el.querySelector('.tc-left-item')!;
    expect(inboxRow.querySelector('.tc-left-count')).toBeNull();
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
    const active = el.querySelector('.tc-left-item.is-active .tc-left-label');
    expect(active?.textContent).toBe('Today');
  });

  it('click Inbox sets selectedList and mode', () => {
    const { el, state } = makePanel();
    (el.querySelector('.tc-left-item') as HTMLElement).click();
    expect(state.get('selectedList')).toBe('inbox');
    expect(state.get('mode')).toBe('tasks');
  });

  it('click Today sets selectedList and mode', () => {
    const { el, state } = makePanel();
    (el.querySelectorAll('.tc-left-item')[1] as HTMLElement).click();
    expect(state.get('selectedList')).toBe('today');
    expect(state.get('mode')).toBe('tasks');
  });

  it('click Upcoming sets selectedList and mode', () => {
    const { el, state } = makePanel();
    (el.querySelectorAll('.tc-left-item')[2] as HTMLElement).click();
    expect(state.get('selectedList')).toBe('upcoming');
    expect(state.get('mode')).toBe('tasks');
  });
});

describe('LeftPanel tag groups (prefix mode)', () => {
  it('always renders the Tags section (with the + affordance), groups only when present', () => {
    // Empty groups: the Tags section still shows so the "+" is discoverable, but no group rows.
    const { el } = makePanel([], { tagGroups: [] });
    expect(el.querySelector('.tc-left-section--tags')).not.toBeNull();
    expect(el.querySelector('.tc-left-section--tags .tc-left-add')).not.toBeNull();
    expect(el.querySelector('.tc-tag-group-header')).toBeNull();
    // With a group: the group renders.
    const { el: el2 } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    expect(el2.querySelector('.tc-tag-group-header')).not.toBeNull();
  });

  it('group header renders name', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    expect(el.querySelector('.tc-tag-group-header .tc-left-label')?.textContent).toBe('Work');
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
    expect(el.querySelector('.tc-tag-group-header .tc-left-count')?.textContent).toBe('2');
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
    expect(el.querySelector('.tc-tag-group-header')?.classList.contains('is-active')).toBe(true);
  });

  it('click group header sets selectedList and mode', () => {
    const { el, state } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    (el.querySelector('.tc-tag-group-header') as HTMLElement).click();
    expect(state.get('selectedList')).toEqual({ type: 'group', groupId: 'g1' });
    expect(state.get('mode')).toBe('tasks');
  });

  it('chevron click expands collapsed group', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }],
    });
    const chevron = el.querySelector('.tc-group-arrow') as HTMLElement;
    expect(el.querySelector('.tc-tag-group-children')).toBeNull();
    chevron.click();
    expect(el.querySelector('.tc-tag-group-children')).not.toBeNull();
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
    expect(el.querySelector('.tc-tag-group-children')).not.toBeNull();
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    expect(el.querySelector('.tc-tag-group-children')).toBeNull();
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
    expect(el.querySelector('.tc-tag-group-children')).not.toBeNull();
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
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    // Re-render by triggering state change
    state.set('selectedList', { type: 'tag', tag: '#work/dev' });
    expect(el.querySelector('.tc-tag-group-children')).toBeNull();
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
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    const childLabel = el.querySelector('.tc-tag-child .tc-left-label')?.textContent;
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
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    expect(el.querySelector('.tc-tag-child .tc-left-count')?.textContent).toBe('2');
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
    expect(el.querySelector('.tc-tag-child.is-active .tc-left-label')?.textContent).toBe('dev');
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
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    const child = el.querySelector('.tc-tag-child') as HTMLElement;
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
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    const childLabels = Array.from(el.querySelectorAll('.tc-tag-child .tc-left-label')).map(
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
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    expect(el.querySelectorAll('.tc-tag-child')).toHaveLength(0);
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
    expect(el.querySelector('.tc-tag-group-header .tc-left-count')).toBeNull();
  });

  it('group color renders as dot', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#ff0000' }],
    });
    const dot = el.querySelector('.tc-group-dot');
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.background).toBe('rgb(255, 0, 0)');
  });
});

describe('LeftPanel tag groups (manual mode)', () => {
  it('manual group renders children from group.tags', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Manual', mode: 'manual', tags: ['#foo', '#bar'] }],
    });
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    const labels = Array.from(el.querySelectorAll('.tc-tag-child .tc-left-label')).map(
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
    expect(el.querySelector('.tc-tag-group-header .tc-left-count')?.textContent).toBe('2');
  });

  it('manual group no prefix stripping (labels are full tags)', () => {
    const { el } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'Manual', mode: 'manual', tags: ['#work/dev', '#work/ops'] }],
    });
    (el.querySelector('.tc-group-arrow') as HTMLElement).click();
    expect(el.querySelector('.tc-tag-child .tc-left-label')?.textContent).toBe('#work/dev');
  });

  it('single-tag manual group renders flat (leaf: color dot + group name, no #, no chevron)', () => {
    const { el, state } = makePanel([], {
      tagGroups: [{ id: 'g1', name: 'next', mode: 'manual', color: '#ff0000', tags: ['#next'] }],
    });
    expect(el.querySelector('.tc-group-arrow')).toBeNull();
    const leaf = el.querySelector('.tc-tag-leaf');
    expect(leaf).toBeTruthy();
    // Consistent with group rows: name without '#', plus a color dot.
    expect(leaf!.querySelector('.tc-left-label')?.textContent).toBe('next');
    expect(leaf!.querySelector('.tc-group-dot')).toBeTruthy();
    (leaf as HTMLElement).click();
    expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#next' });
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
    expect(el.querySelector('.tc-left-item.is-active .tc-left-label')?.textContent).toBe('Inbox');
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
    (el.querySelector('.tc-left-item') as HTMLElement).click();
    panel.refresh();
    // still has content after refresh
    expect(el.querySelector('.tc-left-section-header')).not.toBeNull();
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
    const headers = Array.from(el.querySelectorAll('.tc-left-section-header')).map(
      (h) => h.textContent,
    );
    expect(headers).toContain('Pinned');
  });

  it('does not render Pinned section when pinnedTags is empty', () => {
    const { el } = makePanel();
    const headers = Array.from(el.querySelectorAll('.tc-left-section-header')).map(
      (h) => h.textContent,
    );
    expect(headers).not.toContain('Pinned');
  });

  it('shows full tag name in Pinned section', () => {
    const { el } = makePanel([], {}, ['#task/next_action']);
    const items = el.querySelectorAll('.tc-pinned-tag .tc-left-label');
    expect(items[0]?.textContent).toBe('#task/next_action');
  });

  it('clicking pinned tag sets selectedList to that tag', () => {
    const { el, state } = makePanel([], {}, ['#task/next']);
    const item = el.querySelector('.tc-pinned-tag') as HTMLElement;
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
    const childLabels = Array.from(el.querySelectorAll('.tc-tag-child .tc-left-label')).map(
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
    const inboxCount = el.querySelector('.tc-left-item .tc-left-count')?.textContent;
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
    const inboxCount = el.querySelector('.tc-left-item .tc-left-count')?.textContent;

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
    const inboxCount = el.querySelector('.tc-left-item .tc-left-count')?.textContent;
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
    const inboxCount = el.querySelector('.tc-left-item .tc-left-count')?.textContent;
    expect(inboxCount).toBe('2');
  });
});

describe('LeftPanel drop zones', () => {
  it('adds tc-drop-target class on dragover when draggingTask is set', () => {
    const t = task({
      status: 'open',
      source: { originalMarkdown: '- [ ] t', originalBlock: '- [ ] t' },
    });
    const { el, state } = makePanel([], {}, ['#task/next']);
    state.set('draggingTask', t);
    const pinned = el.querySelector('.tc-pinned-tag') as HTMLElement;
    const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    pinned.dispatchEvent(ev);
    expect(pinned.classList.contains('tc-drop-target')).toBe(true);
  });

  it('does not add tc-drop-target when no draggingTask', () => {
    const { el } = makePanel([], {}, ['#task/next']);
    const pinned = el.querySelector('.tc-pinned-tag') as HTMLElement;
    const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    pinned.dispatchEvent(ev);
    expect(pinned.classList.contains('tc-drop-target')).toBe(false);
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
    state.set('draggingTask', t);
    const pinned = el.querySelector('.tc-pinned-tag') as HTMLElement;

    pinned.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: {
        type: 'task',
        ref: expect.objectContaining({ filePath: t.ref.filePath, line: t.ref.line }),
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
    const chevron = el.querySelector('.tc-left-section--tags .tc-left-section-chevron');
    expect(chevron).toBeTruthy();
    expect(chevron?.textContent).toBe('');
  });

  it('persists section collapse via onSaveSettings', () => {
    const { el, save, merged } = makeFull({});
    const header = el.querySelector(
      '.tc-left-section--tags .tc-left-section-header',
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
    expect(el.querySelectorAll('.tc-project-item').length).toBe(10);
    expect(el.querySelector('.tc-left-showmore')).toBeTruthy();
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
    expect(el.querySelector('.tc-project-item .tc-left-count')?.textContent).toBe('2');
  });

  it('clicking a project selects it without leaving tasks mode', () => {
    const { el, state } = makeFull({ projects: [{ path: 'Projects/A.md', name: 'A' }] });
    (el.querySelector('.tc-project-item') as HTMLElement).click();
    expect(state.get('selectedList')).toEqual({ type: 'project', path: 'Projects/A.md' });
    expect(state.get('mode')).toBe('tasks');
  });

  it('does not render the Projects section when there are no active projects', () => {
    const { el } = makeFull({ projects: [] });
    expect(el.querySelector('.tc-left-section--projects')).toBeNull();
  });

  it('tags + opens an input that creates a manual group', () => {
    const { el, tm } = makeFull({});
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    (el.querySelector('.tc-left-section--tags .tc-left-add') as HTMLElement).click();
    const input = el.querySelector('.tc-left-add-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'Focus';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(spy).toHaveBeenCalledWith('Focus');
  });

  it('tags + creates only ONE group (Enter then blur must not double-fire)', () => {
    const { el, tm } = makeFull({});
    const spy = vi.spyOn(tm, 'createManualGroup').mockResolvedValue();
    (el.querySelector('.tc-left-section--tags .tc-left-add') as HTMLElement).click();
    const input = el.querySelector('.tc-left-add-input') as HTMLInputElement;
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
    const headers = el.querySelectorAll('.tc-tag-group-header');
    expect(headers.length).toBe(2);
    // Drop group g1 onto g2's header → g1 moves to g2's slot.
    const dt = {
      getData: (t: string) => (t === 'application/x-tc-taggroup' ? 'g1' : ''),
      types: ['application/x-tc-taggroup'],
      setData: () => {},
    };
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dt });
    headers[1]!.dispatchEvent(drop);
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
    (el.querySelector('.tc-left-section--tags .tc-left-add') as HTMLElement).click();
    const body = el.querySelector('.tc-left-section--tags .tc-left-section-body') as HTMLElement;
    expect(body.firstElementChild?.classList.contains('tc-left-add-input')).toBe(true);
  });
});
