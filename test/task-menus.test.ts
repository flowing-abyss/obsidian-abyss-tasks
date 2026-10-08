import { addIcon, Menu, Notice, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate } from '../src/tasks';
import { taskTreeNodes } from '../src/tasks/domain/taskSearchProjection';
import { localDate as occupiedFixtureDate } from '../src/tasks/domain/validation';
import * as commandFeedback from '../src/ui/taskCommandResult';
import { TrackingTicker } from '../src/ui/timeTracking/TrackingTicker';
import { createTrackingActions } from '../src/ui/timeTracking/trackingActions';
import { taskSnapshotForCalendarOccurrence } from '../src/views/calendarOccurrences';
import { expectDefined, fixedToday, methodOf, task, taskQueryApi } from './helpers';
import { hierarchyHarness } from './support/taskHierarchyHarness';
import { useTaskPanelViewport } from './support/taskPanelViewport';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useTaskPanelViewport();

fixedToday('2026-10-02');

afterEach(() => {
  vi.restoreAllMocks();
  activeDocument.body.empty();
});

interface RecordedItem {
  readonly title__: string;
  readonly section: string;
  readonly checked: boolean | null;
  readonly disabled: boolean;
  readonly submenu: Menu | null;
}

function items(menu: Menu): readonly RecordedItem[] {
  return (menu as unknown as { menuItems__: RecordedItem[] }).menuItems__;
}

function sequence(menu: Menu): ReadonlyArray<readonly [string, string]> {
  // Obsidian establishes each section at its first item, then groups by section. Pin the
  // registration sequence, including sections, so extraction cannot reorder those bands.
  return items(menu).map((item) => [item.title__, item.section]);
}

function mockMenuDom(): void {
  const originalAddItem = methodOf(Menu.prototype, 'addItem');
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, callback) {
    return originalAddItem.call(this, (item) => {
      (item as unknown as { dom: HTMLElement }).dom = createDiv();
      callback(item);
    });
  });
}

function fixture() {
  mockMenuDom();
  const first = task({
    title: 'First',
    tags: ['#one', '#both'],
    planning: { due: '2026-10-02' },
    source: { filePath: 'tasks.md', line: 0 },
    ref: { filePath: 'tasks.md', line: 0 },
  });
  const second = task({
    title: 'Second',
    tags: ['#both'],
    planning: { due: '2026-10-02' },
    source: { filePath: 'tasks.md', line: 1 },
    ref: { filePath: 'tasks.md', line: 1 },
  });
  const snapshots = [first, second];
  const queries = taskQueryApi({
    list: () => snapshots,
    listNodes: () =>
      snapshots.map((root) => ({
        root,
        path: [],
        node: root,
        target: { type: 'task', ref: root.ref },
      })),
  });
  const state = new AppState();
  state.set('selectedList', { type: 'project', path: 'tasks.md' });
  const panel = new CenterPanel({
    state,
    app: {} as App,
    settings: { ...DEFAULT_SETTINGS, pinnedTags: ['#one', '#both', '#absent'] },
    queries,
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    timeTracking: {
      ticker: new TrackingTicker({ queries, now: () => Date.now(), win: window }),
      actions: createTrackingActions(
        {
          queries,
          execute: async () => ({ type: 'invalid', issues: [{ code: 'invalid-target' }] }),
        },
        () => {},
      ),
      context: () => ({ nowMs: Date.now(), offsetAt: () => 0 }),
    },
  });
  const el = activeDocument.body.createDiv();
  panel.mount(el);
  const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
  return { panel, card, first, second };
}

function singleMenu(
  panel: CenterPanel,
  card: HTMLElement,
  snapshot: ReturnType<typeof task>,
): Menu {
  return panel['taskMenus_abyssPrivate'].createTaskContextMenu(card, snapshot);
}

function bulkMenu(panel: CenterPanel, card: HTMLElement): Menu {
  const cards = [
    ...expectDefined(card.closest('.abyss-task-list-surface')).querySelectorAll<HTMLElement>(
      '.abyss-task-card',
    ),
  ];
  for (const selected of [...cards].reverse())
    selected.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  const shown = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (
    this: Menu,
  ) {
    return this;
  });
  panel['taskMenus_abyssPrivate'].showBulkContextMenu(
    new MouseEvent('contextmenu'),
    card,
    panel['taskMenuTargets_abyssPrivate'](),
  );
  return expectDefined(shown.mock.instances[0]) as Menu;
}

describe('task menu registration contract', () => {
  it('keeps single-task sections and checked presets/tags in their complete registered order', () => {
    const { panel, card, first } = fixture();
    try {
      const menu = singleMenu(panel, card, first);
      expect(sequence(menu)).toEqual([
        ['Today', 'today'],
        ['Tomorrow', 'today'],
        ['Start tracking', 'tracking'],
        ['#one', 'tags'],
        ['#both', 'tags'],
        ['#absent', 'tags'],
        ['Set date…', 'edit'],
        ['Set tag…', 'edit'],
        ['Edit repeat…', 'edit'],
        ['Priority', 'priority'],
        ['Status', 'priority'],
        ['Filter by this priority', 'priority'],
        ['Filter by this status', 'priority'],
        ['Open in note', 'open'],
        ['Archive', 'danger'],
        ['Delete', 'danger'],
      ]);
      expect(
        items(menu)
          .slice(0, 6)
          .map((item) => item.checked),
      ).toEqual([true, false, null, true, true, false]);
      expect((menu as unknown as { items: unknown[] }).items).toHaveLength(16); // no extra explicit separators
      const priority = expectDefined(
        items(menu).find((item) => item.title__ === 'Priority')?.submenu,
      );
      expect(
        items(priority)
          .filter((item) => item.checked === true)
          .map((item) => item.title__),
      ).toEqual(['None']);
    } finally {
      panel.destroy();
    }
  });

  it('keeps the bulk header and groups without a tracking or single-task-only band', () => {
    const { panel, card } = fixture();
    try {
      const menu = bulkMenu(panel, card);
      expect(sequence(menu)).toEqual([
        ['2 tasks selected', 'header'],
        ['Today', 'today'],
        ['Tomorrow', 'today'],
        ['Set date…', 'actions'],
        ['~ #one  (1/2)', 'tags'],
        ['✓ #both  (2/2)', 'tags'],
        ['#absent  (0/2)', 'tags'],
        ['Priority', 'priority'],
        ['Status', 'priority'],
        ['Set tag…', 'actions'],
        ['Archive all', 'danger'],
        ['Delete all', 'danger'],
      ]);
      expect(items(menu)[0]?.disabled).toBe(true);
      expect(
        items(menu)
          .slice(1, 3)
          .map((item) => item.checked),
      ).toEqual([true, false]);
      expect((menu as unknown as { items: unknown[] }).items).toHaveLength(12);
    } finally {
      panel.destroy();
    }
  });
});

it('offers Promote for a child, disables root transfer and routes continuation status to details, and targets its timer', async () => {
  vi.useRealTimers();
  const h = await hierarchyHarness();
  const child = expectDefined([...taskTreeNodes(h.source)][1]);
  const { panel, card } = fixture();
  try {
    const menu = panel['taskMenus_abyssPrivate'].createTaskContextMenu(card, child, {
      kind: 'continuation',
      due: localDate('2026-10-09'),
    });
    expect(items(menu).find((item) => item.title__.startsWith('Archive'))?.disabled).toBe(true);
    expect(items(menu).find((item) => item.title__ === 'Status in task details…')).toMatchObject({
      disabled: false,
      submenu: null,
    });
    expect(items(menu).find((item) => item.title__ === 'Make independent task')?.disabled).toBe(
      false,
    );
    const start = vi
      .spyOn(expectDefined(panel['timeTracking_abyssPrivate']).actions, 'start')
      .mockResolvedValue(undefined);
    const click = (
      items(menu).find((item) => item.title__ === 'Start tracking') as unknown as {
        onClick__: () => void;
      }
    ).onClick__;
    click();
    expect(start).toHaveBeenCalledExactlyOnceWith(child.target);
  } finally {
    panel.destroy();
    h.index.destroy();
  }
});

it.each(
  (['hydrated', 'bare', 'calendar'] as const).flatMap((form) =>
    (['date', 'recurrence', 'source', 'unavailable-source', 'unavailable-recurrence'] as const).map(
      (kind) => ({ form, kind }),
    ),
  ),
)('retains $form child authority through the $kind surface callback', async ({ form, kind }) => {
  vi.useRealTimers();
  mockMenuDom();
  const h = await hierarchyHarness({
    'source.md': '- [ ] Parent\n  - [ ] Child 📅 2026-10-09\n',
    'target.md': '- [ ] Other\n',
  });
  const child = expectDefined([...taskTreeNodes(h.source)][1]);
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const panel = new CenterPanel({
    app: h.app,
    state,
    settings: structuredClone(DEFAULT_SETTINGS),
    queries: h.index,
    tasks: h.service,
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
  });
  const el = activeDocument.body.createDiv();
  panel.mount(el);
  const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
  const execute = vi.spyOn(h.service, 'execute');
  try {
    let subject = form === 'bare' ? child.node : child;
    if (form === 'calendar')
      subject = taskSnapshotForCalendarOccurrence({
        kind: 'materialized',
        occupied: { kind: 'point', date: occupiedFixtureDate('2026-10-09'), roles: ['due'] },
        key: 'child',
        source: child,
        planning: child.node.planning,
        recurring: true,
      });
    const menu = panel['taskMenus_abyssPrivate'].createTaskContextMenu(card, subject);
    const unavailable = kind.startsWith('unavailable');
    const sourceAction = kind.endsWith('source');
    const feedback = vi.spyOn(commandFeedback, 'presentTaskCommandResult');
    const leaf = {
      openFile: vi.fn().mockResolvedValue(undefined),
      view: { editor: { setCursor: vi.fn() } },
    };
    const getLeaf = vi.spyOn(h.app.workspace, 'getLeaf').mockReturnValue(leaf as never);
    if (unavailable)
      h.index.installCommittedContent('source.md', '- [ ] Replacement\n  - [ ] Child\n');
    let title = kind === 'date' ? 'Set date…' : 'Edit repeat…';
    if (sourceAction) title = 'Open in note';
    const item = expectDefined(items(menu).find((item) => item.title__ === title));
    (item as unknown as { onClick__: () => void }).onClick__();
    if (unavailable) {
      expect(feedback).toHaveBeenCalledWith({ type: 'not-found', target: child.target });
      expect(getLeaf).not.toHaveBeenCalled();
      expect(activeDocument.querySelector('.abyss-recurrence-save')).toBeNull();
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    if (sourceAction) {
      await vi.waitFor(() => {
        expect(leaf.view.editor.setCursor).toHaveBeenCalledWith({ line: 1, ch: 0 });
      });
      expect(leaf.openFile).toHaveBeenCalledExactlyOnceWith(h.file('source.md'));
      expect(execute).not.toHaveBeenCalled();
      expect(await h.read('source.md')).toBe('- [ ] Parent\n  - [ ] Child 📅 2026-10-09\n');
      return;
    }
    if (kind === 'date') {
      const input = expectDefined(
        activeDocument.querySelector<HTMLInputElement>('input[type="date"]'),
      );
      input.value = '2026-10-10';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      expectDefined(
        activeDocument.querySelector<HTMLElement>('[data-recurrence-preset="weekly"]'),
      ).click();
      expectDefined(
        activeDocument.querySelector<HTMLButtonElement>('.abyss-recurrence-save'),
      ).click();
    }
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ type: 'patch', target: child.target });
    await vi.waitFor(async () => {
      expect(await h.read('source.md')).toBe(
        kind === 'date'
          ? '- [ ] Parent\n  - [ ] Child 📅 2026-10-10\n'
          : '- [ ] Parent\n  - [ ] Child 🔁 every week on Friday 📅 2026-10-09\n',
      );
    });
  } finally {
    panel.destroy();
    h.index.destroy();
  }
});

it.each(['quick', 'context'] as const)(
  'routes passive %s status editing to exact child details with no command',
  async (route) => {
    vi.useRealTimers();
    mockMenuDom();
    const h = await hierarchyHarness({
      'source.md': '- [ ] Parent\n  - [/] Child 🛫 2026-10-07 📅 2026-10-09\n',
      'target.md': '- [ ] Other\n',
    });
    const child = expectDefined([...taskTreeNodes(h.source)][1]);
    const state = new AppState();
    const panel = new CenterPanel({
      app: h.app,
      state,
      settings: structuredClone(DEFAULT_SETTINGS),
      queries: h.index,
      tasks: h.service,
      statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    });
    const el = activeDocument.body.createDiv();
    panel.mount(el);
    const card = expectDefined(el.querySelector<HTMLElement>('.abyss-task-card'));
    const execute = vi.spyOn(h.service, 'execute');
    const completion = { kind: 'continuation' as const, due: localDate('2026-10-09') };
    try {
      if (route === 'quick')
        panel['openStatusMenu_abyssPrivate'](new MouseEvent('contextmenu'), child.node, completion);
      else {
        const menu = panel['taskMenus_abyssPrivate'].createTaskContextMenu(card, child, completion);
        const item = expectDefined(
          items(menu).find((item) => item.title__ === 'Status in task details…'),
        );
        expect(item.disabled).toBe(false);
        expect(item.submenu).toBeNull();
        (item as unknown as { onClick__: () => void }).onClick__();
      }
      expect(activeDocument.querySelector('.abyss-status-popover')).toBeNull();
      expect(state.get('taskStack').map((node) => node.title)).toEqual(['Parent', 'Child']);
      expect(execute).not.toHaveBeenCalled();
      // Inspector's ordinary node capability remains allowed before the due date.
      await panel['taskCommands_abyssPrivate'].toggleTask(child.node);
      expect(execute).toHaveBeenCalledExactlyOnceWith({
        type: 'toggle-completion',
        target: child.target,
      });
      expect(await h.read('source.md')).toContain('  - [x] Child');
    } finally {
      panel.destroy();
      h.index.destroy();
    }
  },
);

it.each([false, true])(
  'preserves keyboard bulk eligibility and skipped counts (terminal selected: %s)',
  async (terminal) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 6, 12));
    mockMenuDom();
    const h = await mountCanonicalSearchUi(
      { 'source.md': '- [ ] A 🛫 2026-10-07 📅 2026-10-09\n- [ ] B 🛫 2026-10-07 📅 2026-10-10\n' },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    const execute = vi.spyOn(h.tasks, 'execute');
    const notices = vi
      .spyOn(
        Notice.prototype as unknown as { constructor__(message: string): void },
        'constructor__',
      )
      .mockImplementation(() => {});
    try {
      h.state.set('selectedList', 'upcoming');
      h.state.set('centerListViewState', {
        ...h.state.get('centerListViewState'),
        groupBy: 'date',
      });
      await h.completed();
      const press = (key: string, shiftKey = false): void => {
        h.root.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
      };
      press('Home');
      if (terminal) for (let i = 0; i < 4; i++) press('ArrowDown');
      press('ArrowDown', true);
      const targets = h.panel['taskMenuTargets_abyssPrivate']();
      expect(targets.summaries).toHaveLength(2);
      expect(targets.summaries.map((task) => task.completion?.kind)).toEqual(
        terminal ? ['allowed', 'continuation'] : ['continuation', 'continuation'],
      );
      const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      const shown = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (
        this: Menu,
      ) {
        return this;
      });
      h.panel['taskMenus_abyssPrivate'].showBulkContextMenu(
        new MouseEvent('contextmenu'),
        card,
        targets,
      );
      const menu = expectDefined(shown.mock.instances[0]) as Menu;
      const status = expectDefined(items(menu).find((item) => item.title__ === 'Status'));
      expect(status.disabled).toBe(!terminal);
      // Even an already-delivered callback cannot bypass occurrence eligibility.
      const done = expectDefined(
        items(expectDefined(status.submenu)).find((item) => item.title__ === 'Done'),
      );
      (done as unknown as { onClick__: () => void }).onClick__();
      await vi.waitFor(() => {
        expect(notices.mock.calls.map(([message]) => message)).toContain(
          `${terminal ? 1 : 2} task${terminal ? '' : 's'} unchanged: complete from the due-date row or task details.`,
        );
      });
      if (terminal) {
        await vi.waitFor(() => {
          expect(execute).toHaveBeenCalledTimes(1);
        });
        expect(execute.mock.calls[0]?.[0]).toMatchObject({
          type: 'set-status',
          target: { type: 'task', ref: { filePath: 'source.md', line: 0 } },
          symbol: 'x',
        });
      } else expect(execute).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it.each([
  ['w', 'in-progress', 'Waiting', 'click'],
  ['x', 'done', 'Done', 'Enter'],
  ['-', 'cancelled', 'Cancelled', ' '],
] as const)(
  'keeps configured %s status on every daily child card and toggles only its terminal row',
  async (symbol, type, name, activation) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 6, 12));
    addIcon('hourglass', '<svg><path d="M6 3h12M6 21h12"/></svg>');
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.taskStatuses.push({
      id: 'waiting',
      symbol: 'w',
      name: 'Waiting',
      type: 'in-progress',
      icon: 'hourglass',
      core: false,
    });
    const h = await mountCanonicalSearchUi(
      { 'source.md': `- [ ] Parent\n  - [${symbol}] Child 🛫 2026-10-07 📅 2026-10-09 ⏫\n` },
      settings,
      'tasks',
    );
    const execute = vi.spyOn(h.tasks, 'execute');
    try {
      h.state.set('selectedList', 'upcoming');
      h.state.set('centerListViewState', {
        ...h.state.get('centerListViewState'),
        groupBy: 'date',
        statusGroups: ['todo', 'in-progress', 'done', 'cancelled'],
      });
      await h.completed();
      const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
      expect(cards).toHaveLength(3);
      const icons: string[] = [];
      const dates: string[] = [];
      for (const card of cards) {
        const marker = expectDefined(card.querySelector<HTMLElement>('.abyss-status-marker'));
        const control = expectDefined(card.querySelector<HTMLElement>('[role=checkbox]'));
        expect(marker.dataset['statusType']).toBe(type);
        expect(marker.dataset['priority']).toBe('B');
        expect(control.getAttribute('aria-checked')).toBe(String(type === 'done'));
        expect(control.getAttribute('aria-label')).toContain(`Task status: ${name}`);
        icons.push(marker.innerHTML);
        dates.push(card.querySelector('.abyss-task-date')?.textContent ?? '');
      }
      expect(new Set(icons).size).toBe(1);
      if (symbol === 'w') expect(icons[0]).toContain('<svg');
      expect(new Set(dates).size).toBe(1);
      expect(dates[0]).toContain('–');
      for (const card of cards.slice(0, 2)) {
        const control = expectDefined(card.querySelector<HTMLElement>('[role=checkbox]'));
        control.click();
        for (const key of [' ', 'Enter'])
          control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      expect(execute).not.toHaveBeenCalled();
      const target = expectDefined(
        h.index.listNodes().find(({ node }) => node.title === 'Child'),
      ).target;
      const control = expectDefined(cards[2]?.querySelector<HTMLElement>('[role=checkbox]'));
      if (activation === 'click') control.click();
      else control.dispatchEvent(new KeyboardEvent('keydown', { key: activation, bubbles: true }));
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledExactlyOnceWith({ type: 'toggle-completion', target });
      });
    } finally {
      h.dispose();
    }
  },
);

it('preserves Today continuation across grouping while nondate destinations stay allowed', async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 8, 12));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.inbox = { mode: 'tag', tag: '#inbox', removeTagOnAssign: false };
  const h = await mountCanonicalSearchUi(
    { 'source.md': '- [ ] Parent #other\n  - [ ] Child #inbox 🛫 2026-10-07 📅 2026-10-09\n' },
    settings,
    'tasks',
  );
  const execute = vi.spyOn(h.tasks, 'execute');
  try {
    h.state.set('selectedList', 'today');
    for (const groupBy of ['none', 'priority', 'status'] as const) {
      h.state.set('centerListViewState', { ...h.state.get('centerListViewState'), groupBy });
      await vi.waitFor(() => {
        expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
        expect(h.root.querySelector('[role=checkbox]')?.getAttribute('aria-disabled')).toBe('true');
        expect(h.root.querySelector('.abyss-task-date')?.textContent).toContain('–');
      });
      h.root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }),
      );
      expect(h.panel['taskMenuTargets_abyssPrivate']().summaries[0]?.completion).toEqual({
        kind: 'continuation',
        due: localDate('2026-10-09'),
      });
      const control = expectDefined(h.root.querySelector<HTMLElement>('[role=checkbox]'));
      control.click();
      control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(execute).not.toHaveBeenCalled();
    }
    for (const selection of ['upcoming', 'inbox', { type: 'tag', tag: '#inbox' }] as const) {
      h.state.set('selectedList', selection);
      h.state.set('centerListViewState', {
        ...h.state.get('centerListViewState'),
        groupBy: 'none',
      });
      await vi.waitFor(() => {
        expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
        expect(h.root.querySelector('[role=checkbox]')?.hasAttribute('aria-disabled')).toBe(false);
        expect(h.root.querySelector('.abyss-task-date')?.textContent).toContain('–');
      });
    }
    h.state.set('selectedList', 'today');
    vi.setSystemTime(new Date(2026, 9, 10, 12));
    h.panel.refresh();
    await vi.waitFor(() => {
      expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
      expect(h.root.querySelector('[role=checkbox]')?.hasAttribute('aria-disabled')).toBe(false);
      expect(h.root.querySelector('.abyss-task-date')?.textContent).toContain('–');
    });
    const target = expectDefined(
      h.index.listNodes().find(({ node }) => node.title === 'Child'),
    ).target;
    expectDefined(h.root.querySelector<HTMLElement>('[role=checkbox]')).click();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledExactlyOnceWith({ type: 'toggle-completion', target });
    });
  } finally {
    h.dispose();
  }
});
