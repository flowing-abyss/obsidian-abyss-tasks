import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { ProjectManager } from '../src/projects/ProjectManager';
import { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { expectDefined, useRealMoment } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
async function mount() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), groupBy: 'priority' } };
  const h = await createCanonicalSearchHarness(
    {
      'Projects/A.md':
        '- [ ] Alpha 🛫 2026-10-24 📅 2026-10-28\n  - [ ] Child\n- [/] Beta\n- [x] Completed',
      'Projects/B.md': '- [ ] Other project',
      'outside.md': '- [ ] Outside',
    },
    settings,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  const state = new AppState();
  state.set('selectedList', 'inbox');
  state.set('centerFilter', 'Outside');
  state.set('mode', 'projects');
  const projects = new ProjectStore(h.app, h.tasks.queries, settings);
  projects.initialize();
  const manager = new ProjectManager(
    h.app,
    settings,
    {
      createNoteFromTemplate: async () => {
        throw new Error('Unexpected template');
      },
    },
    h.tasks,
  );
  const root = document.body.createDiv({ cls: 'abyss-panel-view' });
  prepareTaskPanelViewport(root);
  const panel = new CenterPanel({
    state,
    app: h.app,
    settings,
    queries: h.index,
    tasks: h.tasks,
    captureApplication: h.tasks,
    search: h.search,
    statusRegistry: h.statusRegistry,
    projectStore: projects,
    projectManager: manager,
  });
  panel.mount(root);
  const open = (path: string) => {
    state.set('projectsPanel', { view: 'dashboard', path });
  };
  const choose = async (view: 'List' | 'Kanban' | 'Timeline') => {
    expectDefined(
      root.querySelector<HTMLButtonElement>(`.abyss-project-tasks [aria-label="${view} view"]`),
    ).click();
    if (view !== 'List') await searchUiCompleted(root);
  };
  return {
    ...h,
    root,
    panel,
    state,
    settings,
    open,
    choose,
    dispose: () => {
      panel.destroy();
      projects.destroy();
      root.remove();
      h.close();
    },
  };
}
it('shares all three task views inside the actual project dashboard without leaking Tasks context', async () => {
  const h = await mount();
  try {
    expect(h.root.querySelector('.abyss-projects-table-session')).not.toBeNull();
    h.open('Projects/A.md');
    const title = expectDefined(h.root.querySelector('.abyss-project-dashboard-title'));
    expect(title.textContent).toBe('A');
    expect(h.root.querySelector('.abyss-project-tasks')?.textContent).toContain('Alpha');
    await h.choose('Kanban');
    expect(h.root.querySelector('.abyss-project-dashboard-title')).toBe(title);
    expect(h.root.querySelector('.abyss-task-kanban')).not.toBeNull();
    expect(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')].map(
        (e) => e.dataset['filePath'],
      ),
    ).toEqual(['Projects/A.md', 'Projects/A.md', 'Projects/A.md']);
    await h.choose('Timeline');
    expect(h.root.querySelectorAll('.abyss-task-timeline-row')).toHaveLength(3);
    const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-center-search'));
    input.value = 'Alpha';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await searchUiCompleted(h.root);
    expect(h.root.querySelectorAll('.abyss-task-timeline-row')).toHaveLength(1);
    expect(h.state.get('selectedList')).toBe('inbox');
    expect(h.state.get('centerFilter')).toBe('Outside');
    expect(h.settings.listViewStates?.['project:Projects/A.md']?.view).toBe('timeline');
    h.root.querySelector<HTMLButtonElement>('.abyss-project-back')?.click();
    expect(h.root.querySelector('.abyss-task-timeline')).toBeNull();
    h.open('Projects/B.md');
    expect(h.root.querySelector('.abyss-project-tasks')?.textContent).toContain('Other project');
    expect(h.root.querySelector('.abyss-project-tasks')?.textContent).not.toContain('Alpha');
    h.open('Projects/A.md');
    await searchUiCompleted(h.root);
    expect(h.root.querySelector('.abyss-task-timeline')).not.toBeNull();
    expect(h.root.querySelector<HTMLInputElement>('.abyss-center-search')?.value).toBe('Alpha');
    await h.choose('List');
    await searchUiCompleted(h.root);
    expect(h.root.querySelector('.abyss-task-kanban')).toBeNull();
    expect(h.root.querySelector('.abyss-task-timeline')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('creates in a project Kanban column and cancels an unfinished capture on leaving the dashboard', async () => {
  const h = await mount();
  try {
    h.open('Projects/A.md');
    await h.choose('Kanban');
    const status = expectDefined(h.statusRegistry.all().find((s) => s.type === 'in-progress'));
    const column = expectDefined(
      h.root.querySelector<HTMLElement>(`[data-column-key="status:${status.id}"]`),
    );
    expectDefined(
      column.querySelector<HTMLButtonElement>('.abyss-task-kanban-column-create'),
    ).click();
    await vi.waitFor(() => {
      expect(column.querySelector('.abyss-capture-input')).not.toBeNull();
    });
    const input = expectDefined(column.querySelector<HTMLTextAreaElement>('.abyss-capture-input'));
    input.value = 'Created in A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(
        h.index.list({ filePath: 'Projects/A.md' }).some((t) => t.title === 'Created in A'),
      ).toBe(true);
    });
    expect(
      h.index.list({ filePath: 'Projects/A.md' }).find((t) => t.title === 'Created in A')
        ?.statusSymbol,
    ).toBe(status.symbol);
    expect(h.index.list({ filePath: 'outside.md' })).toHaveLength(1);
    await searchUiCompleted(h.root);
    if (h.root.querySelector('.abyss-capture-input') === null) {
      expectDefined(
        h.root.querySelector<HTMLButtonElement>(
          `[data-column-key="status:${status.id}"] .abyss-task-kanban-column-create`,
        ),
      ).click();
    }
    await vi.waitFor(() => {
      expect(h.root.querySelector('.abyss-capture-input')).not.toBeNull();
    });
    const activeInput = expectDefined(
      h.root.querySelector<HTMLTextAreaElement>('.abyss-capture-input'),
    );
    activeInput.value = 'Abandoned';
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    h.root.querySelector<HTMLButtonElement>('.abyss-project-back')?.click();
    expect(h.root.querySelector('.abyss-capture-input')).toBeNull();
    expect(h.index.list({ filePath: 'Projects/A.md' }).some((t) => t.title === 'Abandoned')).toBe(
      false,
    );
  } finally {
    h.dispose();
  }
});

it('moves an exact multi-selection inside the dashboard and edits dates through the shared command', async () => {
  const h = await mount();
  try {
    h.open('Projects/A.md');
    await h.choose('Kanban');
    const cards = [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')].filter((e) =>
      ['Alpha', 'Beta'].includes(e.querySelector('.abyss-task-title')?.textContent ?? ''),
    );
    expect(cards).toHaveLength(2);
    for (const card of cards)
      card.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    expect(h.root.querySelectorAll('.abyss-task-card.abyss-multi-selected')).toHaveLength(2);
    expectDefined(cards[0]).dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    const done = h.statusRegistry.defaultDone();
    expectDefined(
      h.root.querySelector<HTMLElement>(`[data-column-key="status:${done.id}"]`),
    ).dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(h.index.list({ filePath: 'Projects/A.md' }).every((t) => t.status === 'done')).toBe(
        true,
      );
    });
    await searchUiCompleted(h.root);
    expect(h.root.querySelector('.is-search-revealed')).toBeNull();
    await h.choose('Timeline');
    const row = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-timeline-row')].find(
        (e) => e.querySelector('.abyss-task-title')?.textContent === 'Alpha',
      ),
    );
    expectDefined(
      row.querySelector<HTMLElement>('.abyss-project-timeline-track > .abyss-project-timeline-bar'),
    ).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => {
      expect(
        h.index.list({ filePath: 'Projects/A.md' }).find((t) => t.title === 'Alpha')?.planning,
      ).toMatchObject({ start: '2026-10-25', due: '2026-10-29' });
    });
    expect(h.index.list({ filePath: 'Projects/B.md' })[0]?.title).toBe('Other project');
    await searchUiCompleted(h.root);
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    await h.app.vault.modify(file, '- [ ] Replacement 🛫 2026-10-25 📅 2026-10-26');
    h.index.installCommittedContent(file.path, '- [ ] Replacement 🛫 2026-10-25 📅 2026-10-26');
    await h.search.prepare(new AbortController().signal);
    await searchUiCompleted(h.root);
    expect(h.root.querySelector('.abyss-project-dashboard-title')?.textContent).toBe('A');
    expect(h.root.querySelector('.abyss-task-title')?.textContent).toBe('Replacement');
    expect(h.root.querySelectorAll('.abyss-task-card.abyss-multi-selected')).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

it('returns to the same Tasks project with the saved dashboard view and a fresh Tasks shell', async () => {
  const h = await mount();
  try {
    const navigation = h.panel['navigation_abyssPrivate'];
    navigation.openList({ type: 'project', path: 'Projects/A.md' });
    navigation.openProjects();
    h.open('Projects/A.md');
    await h.choose('Timeline');
    navigation.openTasks();
    await searchUiCompleted(h.root);
    expect(h.state.get('centerListViewState').view).toBe('timeline');
    expect(h.settings.listViewStates?.['project:Projects/A.md']?.view).toBe('timeline');
    expect(h.root.querySelector('.abyss-project-dashboard-session')).toBeNull();
    expect(h.root.querySelector('.abyss-task-timeline')).not.toBeNull();
    expect(h.root.querySelector('.abyss-center-header')?.parentElement).toBe(h.root);
  } finally {
    h.dispose();
  }
});

it.each(['overview', 'project', 'layout'] as const)(
  'retires the native Kanban drag before navigating to %s',
  async (destination) => {
    const h = await mount();
    try {
      h.open('Projects/A.md');
      await h.choose('Kanban');
      if (destination === 'layout') {
        h.panel['navigation_abyssPrivate'].openList({ type: 'project', path: 'Projects/A.md' });
        await searchUiCompleted(h.root);
      }
      const board = expectDefined(h.root.querySelector('.abyss-task-kanban'));
      expectDefined(board.querySelector('.abyss-task-card')).dispatchEvent(
        new MouseEvent('dragstart', { bubbles: true }),
      );
      expect(h.state.get('draggingTaskNode')).not.toBeNull();
      expect(() => {
        if (destination === 'overview') h.state.set('projectsPanel', { view: 'table' });
        else if (destination === 'project') h.open('Projects/B.md');
        else
          h.state.set('centerListViewState', {
            ...h.state.get('centerListViewState'),
            view: 'list',
          });
      }).not.toThrow();
      expect(h.state.get('draggingTaskNode')).toBeNull();
      if (destination !== 'layout') expect(board.isConnected).toBe(false);
      expect(h.root.querySelector('.abyss-task-kanban')).toBeNull();
      expect(
        h.index.list({ filePath: 'Projects/A.md' }).find((t) => t.title === 'Alpha')?.statusSymbol,
      ).toBe(' ');
      if (destination === 'project')
        expect(h.root.querySelector('.abyss-project-dashboard-title')?.textContent).toBe('B');
    } finally {
      h.dispose();
    }
  },
);

it('keeps project context beside the shared controls and styles completed task titles', async () => {
  const h = await mount();
  try {
    h.settings.listViewStates = {
      ...h.settings.listViewStates,
      'project:Projects/A.md': {
        ...getListViewDefaults('project:Projects/A.md'),
        statusGroups: ['todo', 'in-progress', 'done', 'cancelled'],
      },
    };
    h.open('Projects/A.md');
    const header = expectDefined(h.root.querySelector('.abyss-center-header'));
    expect(header.querySelector('.abyss-project-back')?.getAttribute('aria-label')).toBe(
      'Back to projects',
    );
    expect(header.querySelector('.abyss-project-back')?.textContent).toBe('');
    const title = expectDefined(header.querySelector('.abyss-project-dashboard-title'));
    expect(header.querySelector('.abyss-progress-label')?.textContent).toBe('1/3');
    expect(header.querySelector('.abyss-status-pill')).not.toBeNull();
    expect(header.querySelector('[aria-label="Timeline view"]')).not.toBeNull();
    const completed = expectDefined(
      [...h.root.querySelectorAll('.abyss-task-title')].find((e) => e.textContent === 'Completed'),
    );
    expect(completed.classList.contains('is-done')).toBe(true);
    await h.choose('Kanban');
    expect(h.root.querySelector('.abyss-center-header')?.contains(title)).toBe(true);
    await h.choose('Timeline');
    expect(h.root.querySelector('.abyss-center-header')?.contains(title)).toBe(true);
  } finally {
    h.dispose();
  }
});
