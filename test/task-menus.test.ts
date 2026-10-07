import { Menu, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { localDate } from '../src/tasks';
import { taskTreeNodes } from '../src/tasks/domain/taskSearchProjection';
import { TrackingTicker } from '../src/ui/timeTracking/TrackingTicker';
import { createTrackingActions } from '../src/ui/timeTracking/trackingActions';
import { expectDefined, fixedToday, methodOf, task, taskQueryApi } from './helpers';
import { hierarchyHarness } from './support/taskHierarchyHarness';
import { useTaskPanelViewport } from './support/taskPanelViewport';

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
    ...expectDefined(card.parentElement).querySelectorAll<HTMLElement>('.abyss-task-card'),
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

it('offers Promote for a child, disables root transfer and continuation status, and targets its timer', async () => {
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
    expect(items(menu).find((item) => item.title__.startsWith('Status'))?.disabled).toBe(true);
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

it.each(['date', 'recurrence'] as const)(
  'retains the child authority through the %s surface callback',
  async (kind) => {
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
      const menu = panel['taskMenus_abyssPrivate'].createTaskContextMenu(card, child);
      const item = expectDefined(
        items(menu).find(
          (item) => item.title__ === (kind === 'date' ? 'Set date…' : 'Edit repeat…'),
        ),
      );
      (item as unknown as { onClick__: () => void }).onClick__();
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
  },
);
