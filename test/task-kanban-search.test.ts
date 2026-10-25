import { afterEach, expect, it, vi } from 'vitest';
import type { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { expectDefined, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

it('keeps compact search membership and exact descendant cards across layout changes', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.taskStatuses.push({
    id: 'important',
    symbol: '!',
    name: 'Important',
    type: 'todo',
    icon: '',
    core: false,
  });
  settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), view: 'kanban' } };
  const h = await mountCanonicalSearchUi(
    { 'tasks.md': '- [ ] parent\n  - [/] needle child\n- [x] needle done\n- [ ] unrelated' },
    settings,
    'tasks',
  );
  try {
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-kanban-column')).toHaveLength(
      settings.taskStatuses.length,
    );
    expect(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-kanban-column')].map(
        (el) => el.dataset['columnKey'],
      ),
    ).toEqual(
      new StatusRegistry(settings.taskStatuses)
        .grouped()
        .flatMap((g) => g.statuses)
        .map((s) => `status:${s.id}`),
    );
    h.query('needle');
    await h.completed();
    const titles = [...h.root.querySelectorAll('.abyss-task-card .abyss-task-title')].map(
      (el) => el.textContent,
    );
    expect(titles.join(' ')).toContain('needle');
    expect(titles.join(' ')).not.toContain('unrelated');
    expectDefined(
      h.root.querySelector<HTMLButtonElement>('button[aria-label="List view"]'),
    ).click();
    await h.completed();
    expect(h.root.querySelector<HTMLInputElement>('.abyss-center-search')?.value).toBe('needle');
    expect(h.root.querySelector('.abyss-task-kanban')).toBeNull();
  } finally {
    h.dispose();
  }
});

function selectedRows(h: Awaited<ReturnType<typeof mountCanonicalSearchUi>>): TaskRowSelection {
  return (h.panel as unknown as { rowSelection_abyssPrivate: TaskRowSelection })
    .rowSelection_abyssPrivate;
}

it.each([
  ['list', 'none'],
  ['kanban', 'none'],
  ['list', 'priority'],
  ['kanban', 'priority'],
  ['timeline', 'none'],
  ['timeline', 'priority'],
] as const)(
  'preserves selection, anchor and focus from unsearched %s with %s List grouping through a layout round trip',
  async (view, groupBy) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), view, groupBy } };
    const h = await mountCanonicalSearchUi(
      { 'tasks.md': '- [ ] one\n- [ ] two' },
      settings,
      'tasks',
    );
    try {
      if (view !== 'list') await h.completed();
      const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
      expect(cards).toHaveLength(2);
      for (const card of cards)
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      const selection = selectedRows(h);
      const anchor = selection.anchor;
      const focus = selection.focus;
      expect(selection.size).toBe(2);
      for (const next of ['Timeline', 'Kanban', 'List', 'Timeline']) {
        expectDefined(
          h.root.querySelector<HTMLButtonElement>(`[aria-label="${next} view"]`),
        ).click();
        if (next !== 'List') await h.completed();
        expect(selection.size).toBe(2);
        expect(selection.anchor).toBe(anchor);
        expect(selection.focus).toBe(focus);
        expect(h.root.querySelectorAll('.abyss-task-card.abyss-multi-selected')).toHaveLength(2);
      }
    } finally {
      h.dispose();
    }
  },
);

it.each(['list', 'kanban', 'timeline'] as const)(
  'does not transfer %s selection to an externally replaced task on a layout switch',
  async (view) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), view } };
    const h = await mountCanonicalSearchUi(
      { 'one.md': '- [ ] one', 'two.md': '- [ ] two' },
      settings,
      'tasks',
    );
    try {
      if (view !== 'list') await h.completed();
      for (const card of h.root.querySelectorAll<HTMLElement>('.abyss-task-card'))
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      expect(selectedRows(h).size).toBe(2);
      const file = expectDefined(h.app.vault.getFileByPath('one.md'));
      await h.app.vault.modify(file, '- [ ] replacement');
      h.index.installCommittedContent(file.path, '- [ ] replacement');
      await h.search.prepare(new AbortController().signal);
      if (view !== 'list') await h.completed();
      const next = view === 'list' ? 'Kanban' : 'List';
      expectDefined(h.root.querySelector<HTMLButtonElement>(`[aria-label="${next} view"]`)).click();
      if (next === 'Kanban') await h.completed();
      const selected = h.root.querySelectorAll('.abyss-task-card.abyss-multi-selected');
      expect(selected).toHaveLength(1);
      expect(selected[0]?.textContent).toContain('two');
      expect(selected[0]?.textContent).not.toContain('replacement');
    } finally {
      h.dispose();
    }
  },
);

it.each([false, true])(
  'moves the captured selection (%s) to a column and only reveals single drops',
  async (bulk) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), view: 'kanban' } };
    const h = await mountCanonicalSearchUi(
      { 'tasks.md': '- [ ] one\n- [ ] two\n- [ ] three' },
      settings,
      'tasks',
    );
    try {
      await h.completed();
      const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')];
      if (bulk)
        for (const card of cards.slice(0, 2))
          card.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      const first = expectDefined(h.index.listNodes({ filePath: 'tasks.md' })[0]);
      h.state.set('draggingTaskNode', { source: 'center-card', task: first });
      const status = expectDefined(settings.taskStatuses.find((s) => s.symbol === '/'));
      const column = expectDefined(
        h.root.querySelector<HTMLElement>(`[data-column-key="status:${status.id}"]`),
      );
      column.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(h.index.listNodes({ filePath: 'tasks.md' }).map((t) => t.node.statusSymbol)).toEqual(
          bulk ? ['/', '/', ' '] : ['/', ' ', ' '],
        );
      });
      await h.completed();
      if (bulk) expect(h.root.querySelector('.abyss-task-card.is-search-revealed')).toBeNull();
      else
        await vi.waitFor(() => {
          expect(
            column.querySelector('.abyss-task-card.is-search-revealed')?.textContent,
          ).toContain('one');
        });
    } finally {
      h.dispose();
    }
  },
);
