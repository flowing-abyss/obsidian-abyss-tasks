import { MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { ProjectManager } from '../src/projects/ProjectManager';
import { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());
async function mount(projectHeader = '', configure?: (settings: CalendarSettings) => void) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  configure?.(settings);
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
  const footerVisibility = vi.fn<(visible: boolean) => void>();
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
    onTaskFooterVisibilityChange: footerVisibility,
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
    projects,
    open,
    choose,
    footerVisibility,
    dispose: () => {
      panel.destroy();
      projects.destroy();
      root.remove();
      h.close();
    },
  };
}
it('publishes footer visibility across dashboard capture, view changes and navigation', async () => {
  const h = await mount();
  const visible = () => h.footerVisibility.mock.lastCall?.[0] ?? false;
  try {
    expect(visible()).toBe(false);
    h.open('Projects/A.md');
    expect(visible()).toBe(true);
    for (const view of ['List', 'Kanban', 'Timeline'] as const) {
      await h.choose(view);
      expect(visible()).toBe(true);
      expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')).click();
      await flushMicrotasks();
      expect(visible()).toBe(false);
      const input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-capture-input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(visible()).toBe(true);
    }
    expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-project-back')).click();
    expect(visible()).toBe(false);
    h.open('Projects/A.md');
    expect(visible()).toBe(true);
    h.state.set('mode', 'calendar');
    expect(visible()).toBe(false);
    h.state.set('mode', 'projects');
    h.open('Projects/A.md');
    expect(visible()).toBe(true);
  } finally {
    h.dispose();
  }
  expect(visible()).toBe(false);
});
it('shows only configured dashboard properties with table values and guarded edits, including absent fields', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, _markdown, holder) => {
    holder.createEl('a', {
      cls: 'internal-link',
      text: 'Alex',
      attr: { href: '#', 'data-href': 'People/Owner' },
    });
  });
  const h = await mount(
    '---\nowner: "[[People/Owner|Alex]]"\nlabels: [design, review]\napproved: false\naliases: [Other]\nicon: star\ncreated: 2026-10-01\nstale: Saved column\n---\n',
    (settings) => {
      settings.projects.propertyDefinitions = {
        'property:owner': { type: 'text' },
        'property:labels': {
          type: 'list',
          presets: [{ value: 'design', displayName: 'Design team', display: 'badge' }],
        },
        'property:approved': { type: 'checkbox' },
        'property:budget': { type: 'number' },
      };
      settings.projects.table.columns.push({ id: 'property:stale', visible: true });
    },
  );
  try {
    h.open('Projects/A.md');
    const plus = expectDefined(
      h.root.querySelector<HTMLElement>('[aria-label="Project properties"]'),
    );
    plus.click();
    expect(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-project-dashboard-property')].map(
        (row) => row.dataset['projectField'],
      ),
    ).toEqual([
      'start',
      'end',
      'description',
      'property:owner',
      'property:labels',
      'property:approved',
      'property:budget',
    ]);
    const property = (name: string) =>
      expectDefined(
        h.root.querySelector<HTMLElement>(
          `.abyss-project-dashboard-properties [data-project-field="property:${name}"]`,
        ),
      );
    await vi.waitFor(() => {
      expect(property('owner').querySelector('a.internal-link')?.textContent).toBe('Alex');
    });
    const ownerLink = expectDefined(property('owner').querySelector<HTMLAnchorElement>('a'));
    ownerLink.focus();
    h.panel.refresh('projects');
    await flushMicrotasks();
    expect(document.activeElement).toBe(ownerLink);
    expect(property('owner').querySelector('a')).toBe(ownerLink);
    expect(property('labels').querySelector('.is-badge')?.textContent).toBe('Design team');
    const input = expectDefined(
      property('approved').querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    input.focus();
    input.click();
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md') ?? undefined);
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('approved: true');
    });
    expect(document.activeElement).toBe(property('approved').querySelector('input'));
    expect(h.root.querySelector('.abyss-project-dashboard-editor')).toBeNull();
    property('labels').querySelector<HTMLButtonElement>('[aria-label="Remove design"]')?.click();
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).not.toContain('design');
    });
    expect(h.root.querySelector('.abyss-project-dashboard-editor')).toBeNull();
    property('budget').click();
    const budget = expectDefined(
      h.root.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
    );
    budget.value = '120000';
    budget.dispatchEvent(new Event('input', { bubbles: true }));
    budget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain('budget: 120000');
    });
    expect(property('budget').textContent).toContain('120000');
  } finally {
    h.dispose();
  }
});
it('retains the properties menu and focused picker through repeated saves and layered Escape', async () => {
  const h = await mount('---\npriority: high\nbudget: 12\n---\n', (settings) => {
    settings.projects.propertyDefinitions = {
      'property:priority': { type: 'text', presets: [{ value: 'high' }, { value: 'low' }] },
      'property:budget': { type: 'number' },
    };
  });
  try {
    h.open('Projects/A.md');
    const plus = expectDefined(
      h.root.querySelector<HTMLElement>('[aria-label="Project properties"]'),
    );
    plus.click();
    const menu = expectDefined(h.root.querySelector('.abyss-project-dashboard-properties'));
    const label = () =>
      expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Edit priority"]'));
    label().click();
    const editor = expectDefined(h.root.querySelector('.abyss-project-dashboard-editor'));
    const search = expectDefined(editor.querySelector<HTMLInputElement>('input'));
    expect(menu.isConnected).toBe(true);
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    for (const [value, expected] of [
      ['low', 'low'],
      ['low', undefined],
      ['high', 'high'],
    ] as const) {
      const option = expectDefined(editor.querySelector<HTMLElement>(`[data-value="${value}"]`));
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.focus();
      expect(document.activeElement).toBe(option);
      option.click();
      await vi.waitFor(() => {
        expect(h.app.metadataCache.getFileCache(file)?.frontmatter?.['priority']).toBe(expected);
      });
      expect(menu.isConnected).toBe(true);
      expect(editor.isConnected).toBe(true);
      expect(document.activeElement).toBe(search);
    }
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(editor.isConnected).toBe(false);
    });
    expect(menu.isConnected).toBe(true);
    expect(document.activeElement).toBe(label());
    label().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(plus);
  } finally {
    h.dispose();
  }
});
it('settles a property draft before switching fields and keeps the properties menu open', async () => {
  const h = await mount('---\nowner: Team\n---\n', (settings) => {
    settings.projects.propertyDefinitions = {
      'property:budget': { type: 'number' },
      'property:owner': { type: 'text' },
    };
  });
  try {
    h.open('Projects/A.md');
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Edit budget"]')).click();
    const input = expectDefined(
      h.root.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
    );
    input.value = '24';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const other = expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Edit owner"]'));
    other.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    other.focus();
    other.click();
    await vi.waitFor(() => {
      expect(
        h.root.querySelector('.abyss-project-dashboard-editor input')?.getAttribute('aria-label'),
      ).toBe('Search owner');
    });
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    expect(await h.app.vault.read(file)).toContain('budget: 24');
    expect(h.root.querySelector('.abyss-project-dashboard-properties')?.textContent).toContain(
      '24',
    );
    expect(document.activeElement).toBe(
      h.root.querySelector('.abyss-project-dashboard-editor input'),
    );
  } finally {
    h.dispose();
  }
});
it.each(['invalid', 'rejected'] as const)(
  'retains the properties menu and anchor after an outside click with an %s save',
  async (failure) => {
    const h = await mount('', (settings) => {
      settings.projects.propertyDefinitions = { 'property:budget': { type: 'number' } };
    });
    const outside = document.body.createEl('button');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.open('Projects/A.md');
      expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
      const menu = expectDefined(h.root.querySelector('.abyss-project-dashboard-properties'));
      expectDefined(menu.querySelector<HTMLElement>('[aria-label="Edit budget"]')).click();
      const input = expectDefined(
        h.root.querySelector<HTMLInputElement>('.abyss-project-editor-input'),
      );
      const validity = { badInput: failure === 'invalid', valid: failure !== 'invalid' };
      Object.defineProperty(input, 'validity', { get: () => validity });
      const write =
        failure === 'rejected'
          ? vi.spyOn(h.app.vault, 'process').mockRejectedValue(new Error('write denied'))
          : undefined;
      input.value = '42';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      outside.focus();
      await vi.waitFor(() => {
        expect(
          expectDefined(h.root.querySelector('.abyss-project-editor-error')).textContent,
        ).not.toBe('');
      });
      await flushMicrotasks();
      expect(menu.isConnected).toBe(true);
      expect(menu.querySelector('[aria-label="Edit budget"]')?.isConnected).toBe(true);
      expect(input.isConnected).toBe(true);
      validity.badInput = false;
      validity.valid = true;
      write?.mockRestore();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => {
        expect(menu.isConnected).toBe(false);
      });
      expect(input.isConnected).toBe(false);
      expect(
        await h.app.vault.read(expectDefined(h.app.vault.getFileByPath('Projects/A.md'))),
      ).toContain('budget: 42');
    } finally {
      outside.remove();
      h.dispose();
    }
  },
);
it('updates menu values while editing and preserves the first inline remove click after a picker save', async () => {
  const h = await mount('---\nlabels: [one]\n---\n', (settings) => {
    settings.projects.propertyDefinitions = {
      'property:labels': { type: 'list', presets: [{ value: 'one' }, { value: 'two' }] },
    };
  });
  try {
    h.open('Projects/A.md');
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    const row = expectDefined(
      h.root.querySelector<HTMLElement>('[data-project-field="property:labels"]'),
    );
    row.querySelector('button')?.click();
    const editor = expectDefined(h.root.querySelector('.abyss-project-dashboard-editor'));
    expectDefined(editor.querySelector<HTMLElement>('[data-value="two"]')).click();
    await vi.waitFor(() => {
      expect(row.querySelector('[aria-label="Remove two"]')).not.toBeNull();
    });
    expect(editor.isConnected).toBe(true);
    const remove = expectDefined(row.querySelector<HTMLElement>('[aria-label="Remove one"]'));
    remove.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    remove.focus();
    remove.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    remove.click();
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    await vi.waitFor(() => {
      expect(h.app.metadataCache.getFileCache(file)?.frontmatter?.['labels']).toEqual(['two']);
    });
    expect(await h.app.vault.read(file)).toContain('two');
    expect(row.querySelector('[aria-label="Remove one"]')).toBeNull();
    expect(row.isConnected).toBe(true);
  } finally {
    h.dispose();
  }
});
it('refreshes configured dashboard properties without changing note metadata or following stale columns', async () => {
  const h = await mount(
    '---\nowner: Team\nstart: 2026-10-20\nend: 2026-10-31\n---\n',
    (settings) => {
      settings.projects.propertyDefinitions = { 'property:owner': { type: 'text' } };
      settings.projects.table.columns.push({ id: 'property:owner', visible: true });
    },
  );
  try {
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    const original = await h.app.vault.read(file);
    h.open('Projects/A.md');
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    const popover = expectDefined(h.root.querySelector('.abyss-project-dashboard-properties'));
    const fields = () =>
      [...popover.querySelectorAll<HTMLElement>('.abyss-project-dashboard-property')].map(
        (row) => row.dataset['projectField'],
      );
    expect(fields()).toEqual(['start', 'end', 'description', 'property:owner']);
    h.settings.projects.propertyDefinitions['property:budget'] = { type: 'number' };
    h.panel.refresh('projects');
    expect(fields()).toEqual(['start', 'end', 'description', 'property:owner', 'property:budget']);
    delete h.settings.projects.propertyDefinitions['property:owner'];
    h.settings.projects.startProperty = '';
    h.settings.projects.endProperty = '';
    h.panel.refresh('projects');
    expect(h.root.querySelector('.abyss-project-dashboard-properties')).toBe(popover);
    expect(fields()).toEqual(['description', 'property:budget']);
    expect(h.root.querySelector('.abyss-project-dashboard-dates')?.childElementCount).toBe(0);
    expect(await h.app.vault.read(file)).toBe(original);
  } finally {
    h.dispose();
  }
});
it('keeps growing property menus inside their owner and releases sizing when closed', async () => {
  const h = await mount();
  const observers: RecordingResizeObserver[] = [];
  class RecordingResizeObserver {
    readonly targets = new Set<Element>();
    readonly disconnect = vi.fn(() => {
      this.targets.clear();
    });
    constructor(readonly notify: () => void) {
      observers.push(this);
    }
    observe(target: Element): void {
      this.targets.add(target);
    }
  }
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  try {
    h.open('Projects/A.md');
    const plus = expectDefined(
      h.root.querySelector<HTMLElement>('[aria-label="Project properties"]'),
    );
    plus.click();
    const menu = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-project-dashboard-properties'),
    );
    const owner = expectDefined(menu.parentElement);
    let width = 180;
    vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));
    vi.spyOn(plus, 'getBoundingClientRect').mockReturnValue(new DOMRect(340, 40, 24, 24));
    const measure = vi
      .spyOn(menu, 'getBoundingClientRect')
      .mockImplementation(() => new DOMRect(0, 0, width, 200));
    window.dispatchEvent(new Event('resize'));
    expect(menu.style.getPropertyValue('--abyss-pop-left')).toBe('212px');
    const observer = expectDefined(observers.find((candidate) => candidate.targets.has(menu)));
    const label = expectDefined(menu.querySelector<HTMLElement>('button'));
    label.focus();
    width = 320;
    observer.notify();
    expect(menu.style.getPropertyValue('--abyss-pop-left')).toBe('72px');
    expect(document.activeElement).toBe(label);
    width = 180;
    observer.notify();
    expect(menu.style.getPropertyValue('--abyss-pop-left')).toBe('212px');
    plus.click();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    measure.mockClear();
    observer.notify();
    expect(measure).not.toHaveBeenCalled();
    plus.click();
    const reopened = expectDefined(
      h.root.querySelector<HTMLElement>('.abyss-project-dashboard-properties'),
    );
    const next = expectDefined(observers.find((candidate) => candidate.targets.has(reopened)));
    h.state.set('mode', 'calendar');
    expect(next.disconnect).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
    vi.unstubAllGlobals();
  }
});
it.each([
  { property: 'approved', renamed: 'Approved', control: 'input', expected: 'Approved: true' },
  {
    property: 'labels',
    renamed: 'Labels',
    control: '[aria-label="Remove design"]',
    expected: 'Labels:\n  - review',
  },
])('refreshes the source authority of a retained $property control', async (scenario) => {
  const h = await mount('---\napproved: false\nlabels: [design, review]\n---\n', (settings) => {
    settings.projects.propertyDefinitions = {
      'property:approved': { type: 'checkbox' },
      'property:labels': { type: 'list' },
    };
  });
  try {
    h.open('Projects/A.md');
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    const selector = `[data-project-field="property:${scenario.property}"] ${scenario.control}`;
    const before = expectDefined(h.root.querySelector<HTMLElement>(selector));
    const file = expectDefined(h.app.vault.getFileByPath('Projects/A.md'));
    await h.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter[scenario.renamed] = frontmatter[scenario.property];
      delete frontmatter[scenario.property];
    });
    await vi.waitFor(() => {
      expect(h.projects.get('Projects/A.md')?.frontmatter).toHaveProperty(scenario.renamed);
    });
    h.panel.refresh('projects');
    const after = expectDefined(h.root.querySelector<HTMLElement>(selector));
    expect(after).toBe(before);
    after.click();
    await vi.waitFor(async () => {
      expect(await h.app.vault.read(file)).toContain(scenario.expected);
    });
  } finally {
    h.dispose();
  }
});
it.each(['synchronous', 'after close'] as const)(
  'contains a property Markdown failure %s',
  async (timing) => {
    const pending = deferred<void>();
    const error = new Error('renderer unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(() => {
      if (timing === 'synchronous') throw error;
      return pending.promise.then(() => {
        throw error;
      });
    });
    const h = await mount('---\nowner: "[[People/Owner]]"\n---\n', (settings) => {
      settings.projects.propertyDefinitions = { 'property:owner': { type: 'text' } };
    });
    try {
      h.open('Projects/A.md');
      const plus = expectDefined(
        h.root.querySelector<HTMLElement>('[aria-label="Project properties"]'),
      );
      plus.click();
      if (timing === 'synchronous') {
        expect(h.root.querySelector('.abyss-project-dashboard-properties')?.textContent).toContain(
          'Close and reopen to retry',
        );
        expect(log).toHaveBeenCalledOnce();
      } else {
        plus.click();
        pending.resolve();
        await flushMicrotasks();
        expect(log).not.toHaveBeenCalled();
        expect(h.root.querySelector('.abyss-project-dashboard-properties')).toBeNull();
      }
    } finally {
      h.dispose();
    }
  },
);

it('isolates a property render failure without detaching an open editor anchor', async () => {
  const render = vi
    .spyOn(MarkdownRenderer, 'render')
    .mockImplementation(async (_app, text, holder) => {
      holder.setText(text);
    });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = await mount('---\nowner: "[[People/Owner]]"\npriority: high\n---\n', (settings) => {
    settings.projects.propertyDefinitions = {
      'property:owner': { type: 'text' },
      'property:priority': { type: 'text', presets: [{ value: 'high' }, { value: 'low' }] },
    };
  });
  try {
    h.open('Projects/A.md');
    expectDefined(h.root.querySelector<HTMLElement>('[aria-label="Project properties"]')).click();
    const menu = expectDefined(h.root.querySelector('.abyss-project-dashboard-properties'));
    expectDefined(menu.querySelector<HTMLElement>('[aria-label="Edit priority"]')).click();
    const anchor = expectDefined(
      menu.querySelector('[data-project-field="property:priority"] > div'),
    );
    const input = expectDefined(
      h.root.querySelector<HTMLInputElement>('.abyss-project-value-picker-search'),
    );
    render.mockImplementation(() => {
      throw new Error('renderer unavailable');
    });
    await h.app.fileManager.processFrontMatter(
      expectDefined(h.app.vault.getFileByPath('Projects/A.md')),
      (fm: Record<string, unknown>) => {
        fm['owner'] = '[[People/Other]]';
      },
    );
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalled();
    });
    expect(anchor.isConnected).toBe(true);
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(menu.textContent).toContain('Close and reopen to retry');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(input.isConnected).toBe(false);
    });
    expect(menu.isConnected).toBe(true);
  } finally {
    h.dispose();
  }
});

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
  'keeps a configured property with an ambiguous source dismissible via %s without blocking navigation',
  async (action) => {
    const h = await mount('---\nowner: Team\nOwner: Other team\n---\n', (settings) => {
      settings.projects.propertyDefinitions = { 'property:owner': { type: 'text' } };
    });
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
