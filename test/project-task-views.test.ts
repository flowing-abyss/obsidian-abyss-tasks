import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { ProjectManager } from '../src/projects/ProjectManager';
import { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
async function mount(projectHeader = '') {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), groupBy: 'priority' } };
  const h = await createCanonicalSearchHarness(
    {
      'Projects/A.md': `${projectHeader}- [ ] Alpha 🛫 2026-10-24 📅 2026-10-28\n  - [ ] Child\n- [/] Beta\n- [x] Completed`,
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

it('edits the project interval in its task Timeline without changing task dates', async () => {
  const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\nowner: Team\n---\n');
  try {
    h.open('Projects/A.md');
    await h.choose('Timeline');
    const boundaries = expectDefined(h.root.querySelector('.abyss-project-timeline-boundaries'));
    expect(
      h.root.querySelector('.abyss-task-timeline-heading .abyss-project-timeline-row'),
    ).toBeNull();
    const bar = expectDefined(boundaries.querySelector<HTMLElement>('[data-timeline-part="end"]'));
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute('aria-label')).toBe('End: 2026-10-31');
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('end: 2026-11-01');
    });
    await vi.waitFor(() => {
      expect(bar.getAttribute('aria-label')).toContain('2026-11-01');
    });
    const content = await h.app.vault.read(file);
    expect(content).toContain('start: 2026-10-20');
    expect(content).toContain('owner: Team');
    expect(content).toContain('Alpha 🛫 2026-10-24 📅 2026-10-28');
    const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-center-search'));
    input.value = 'No matching task';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await searchUiCompleted(h.root);
    expect(h.root.querySelector('.abyss-project-timeline-boundaries')).not.toBeNull();
    expect(h.root.querySelector('.abyss-project-dashboard-range')).toBeNull();
    expect(h.root.querySelectorAll('.abyss-task-card')).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

it('accumulates dashboard project keyboard edits while native metadata echoes lag', async () => {
  const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\n---\n');
  try {
    h.open('Projects/A.md');
    await h.choose('Timeline');
    const bar = expectDefined(
      h.root.querySelector<HTMLElement>(
        '.abyss-project-timeline-boundaries [data-timeline-part="end"]',
      ),
    );
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    const readCache = h.app.metadataCache.getFileCache.bind(h.app.metadataCache);
    const staleCache = structuredClone(readCache(file));
    const cacheRead = vi
      .spyOn(h.app.metadataCache, 'getFileCache')
      .mockImplementation((f) => (f.path === file.path ? staleCache : readCache(f)));
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('end: 2026-11-01');
    });
    expect(bar.getAttribute('aria-label')).toContain('2026-11-01');
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('end: 2026-11-02');
    });
    cacheRead.mockRestore();
    await h.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter['end'] = '2026-11-05';
    });
    await vi.waitFor(() => {
      expect(bar.getAttribute('aria-label')).toContain('2026-11-05');
    });
  } finally {
    h.dispose();
  }
});
it('undoes a project date edit from the dashboard range itself', async () => {
  const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\n---\n');
  try {
    h.open('Projects/A.md');
    await h.choose('Timeline');
    const bar = expectDefined(
      h.root.querySelector<HTMLElement>(
        '.abyss-project-timeline-boundaries [data-timeline-part="end"]',
      ),
    );
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    bar.focus();
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('end: 2026-11-01');
    });
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('end: 2026-10-31');
    });
    bar.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('end: 2026-11-01');
    });
  } finally {
    h.dispose();
  }
});
it('uses a clickable title and toggled Plus, and places status between filters and views', async () => {
  const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\nowner: Team\n---\n');
  try {
    const openFile = vi.fn().mockResolvedValue(undefined);
    const getLeaf = vi.spyOn(h.app.workspace, 'getLeaf').mockReturnValue({ openFile } as never);
    h.open('Projects/A.md');
    expectDefined(h.root.querySelector<HTMLElement>('.abyss-project-dashboard-title')).click();
    expect(getLeaf).toHaveBeenCalledWith('tab');
    expect(h.root.querySelector('.abyss-project-open-btn')).toBeNull();
    const controls = expectDefined(h.root.querySelector('.abyss-center-controls'));
    const filters = expectDefined(controls.querySelector('.abyss-task-collection-filters'));
    const status = expectDefined(controls.querySelector('.abyss-status-pill'));
    expect(filters.nextElementSibling).toBe(status);
    const plus = expectDefined(
      h.root.querySelector<HTMLElement>('[aria-label="Project properties"]'),
    );
    plus.click();
    expect(h.root.querySelector('.abyss-project-dashboard-properties')).not.toBeNull();
    plus.click();
    expect(h.root.querySelector('.abyss-project-dashboard-properties')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('edits a dashboard date through the existing guarded project editor and retains the task viewport', async () => {
  const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\n---\n');
  try {
    h.open('Projects/A.md');
    const scroll = h.root.querySelector('.abyss-center-scroll');
    expectDefined(h.root.querySelector<HTMLElement>('[data-project-field="start"]')).click();
    const input = expectDefined(
      h.root.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
    );
    expect(document.activeElement).toBe(input);
    input.value = '2026-10-22';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const file = h.app.vault.getFileByPath('Projects/A.md');
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(expectDefined(file ?? undefined))).toContain(
        'start: 2026-10-22',
      );
    });
    expect(h.root.querySelector('.abyss-center-scroll')).toBe(scroll);
  } finally {
    h.dispose();
  }
});
it.each(['Back', 'mode'] as const)(
  'retains an invalid property draft before %s navigation, then resumes after correction',
  async (navigation) => {
    const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\n---\n');
    try {
      h.open('Projects/A.md');
      expectDefined(h.root.querySelector<HTMLElement>('[data-project-field="start"]')).click();
      const input = expectDefined(
        h.root.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
      );
      const validity = { badInput: true, valid: false };
      Object.defineProperty(input, 'validity', { get: () => validity });
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (navigation === 'Back')
        expectDefined(h.root.querySelector<HTMLElement>('.abyss-project-back')).click();
      else
        h.panel.finishProjectTableEditorBefore(() => {
          h.state.set('mode', 'tasks');
        });
      await flushMicrotasks();
      expect(h.state.get('mode')).toBe('projects');
      expect(h.state.get('projectsPanel')).toEqual({ view: 'dashboard', path: 'Projects/A.md' });
      expect(input.isConnected).toBe(true);
      validity.badInput = false;
      validity.valid = true;
      input.value = '2026-10-22';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => {
        if (navigation === 'Back') expect(h.state.get('projectsPanel')).toEqual({ view: 'table' });
        else expect(h.state.get('mode')).toBe('tasks');
      });
    } finally {
      h.dispose();
    }
  },
);
it.each([false, true])(
  'returns keyboard focus from a property editor on Tab (reverse %s)',
  async (reverse) => {
    const h = await mount('---\nstart: 2026-10-20\nend: 2026-10-31\n---\n');
    try {
      h.open('Projects/A.md');
      expectDefined(h.root.querySelector<HTMLElement>('[data-project-field="start"]')).click();
      const input = expectDefined(
        h.root.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: reverse,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(
          h.root.querySelector(
            reverse ? '.abyss-project-dashboard-title' : '[data-project-field="end"]',
          ),
        );
      });
    } finally {
      h.dispose();
    }
  },
);
it.each(['Escape', 'Back'] as const)(
  'keeps an unconfigured property dismissible via %s without blocking navigation',
  async (action) => {
    const h = await mount('---\nowner: Team\n---\n');
    try {
      h.open('Projects/A.md');
      expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
      expectDefined(
        h.root.querySelector<HTMLElement>('[data-project-field="property:owner"]'),
      ).click();
      const editor = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-project-dashboard-editor'),
      );
      expect(editor.contains(document.activeElement)).toBe(true);
      if (action === 'Escape')
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      else expectDefined(h.root.querySelector<HTMLElement>('.abyss-project-back')).click();
      await vi.waitFor(() => {
        expect(editor.isConnected).toBe(false);
        if (action === 'Back') expect(h.state.get('projectsPanel')).toEqual({ view: 'table' });
      });
    } finally {
      h.dispose();
    }
  },
);
