import { WorkspaceLeaf, type App } from 'obsidian';
import { expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import { PanelView } from '../src/views/PanelView';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';

useRealMoment();

async function mountList(markdown = '- [ ] needle') {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const h = await createCanonicalSearchHarness({ 'tasks.md': markdown }, settings);
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(h.app);
  const tags = new TagManager(h.app, settings, async () => {}, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const view = new PanelView(
    leaf,
    settings,
    tags,
    h.index,
    h.tasks,
    h.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    h.search,
  );
  document.body.append(view.containerEl);
  prepareTaskPanelViewport(view.containerEl);
  await view.onOpen();
  const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
  state.set('selectedList', 'inbox');
  state.set('centerFilter', 'needle');
  const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
  await searchUiCompleted(root);
  return {
    ...h,
    view,
    state,
    root,
    marker: () => expectDefined(root.querySelector<HTMLElement>('.abyss-status-marker')),
    read: () => h.app.vault.read(expectDefined(h.app.vault.getFileByPath('tasks.md'))),
    async close() {
      await view.onClose();
      view.containerEl.remove();
      h.close();
    },
  };
}

it('keeps the pressed list marker and captured callback through an inspector title blur save', async () => {
  const h = await mountList();
  try {
    h.state.set('taskStack', [expectDefined(h.index.list()[0])]);
    expectDefined(h.view.contentEl.querySelector<HTMLElement>('.abyss-right-title-view')).click();
    await flushMicrotasks();
    const editor = expectDefined(
      h.view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    editor.value = 'needle edited';
    editor.focus();
    const marker = h.marker();
    const callback = marker.onclick;
    const execute = vi.spyOn(h.tasks, 'execute');
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    marker.focus();
    await vi.waitFor(() => {
      expect(h.index.list()[0]?.title).toBe('needle edited');
    });
    await h.search.prepare(new AbortController().signal);
    await flushMicrotasks();
    expect(marker.isConnected).toBe(true);
    expect(marker.onclick).toBe(callback);
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    marker.click();
    await vi.waitFor(() => {
      expect(h.index.list()[0]?.status).toBe('done');
    });
    expect(h.index.list()[0]?.title).toBe('needle edited');
    expect(await h.read()).toContain('- [x] needle edited');
    expect(
      execute.mock.calls.filter(([command]) => command.type === 'toggle-completion'),
    ).toHaveLength(1);
  } finally {
    await h.close();
  }
});

async function dirtyEditor(
  h: Awaited<ReturnType<typeof mountList>>,
  kind: 'title' | 'desc' = 'title',
) {
  h.state.set('taskStack', [expectDefined(h.index.list()[0])]);
  expectDefined(h.view.contentEl.querySelector<HTMLElement>(`.abyss-right-${kind}-view`)).click();
  await flushMicrotasks();
  const editor = expectDefined(
    h.view.contentEl.querySelector<HTMLTextAreaElement>(`.abyss-right-${kind}-edit`),
  );
  editor.value = kind === 'title' ? 'needle edited' : 'edited description';
  editor.focus();
  return editor;
}

async function settledSave(
  h: Awaited<ReturnType<typeof mountList>>,
  kind: 'title' | 'desc' = 'title',
) {
  await vi.waitFor(() => {
    expect(kind === 'title' ? h.index.list()[0]?.title : h.index.list()[0]?.description).toBe(
      kind === 'title' ? 'needle edited' : 'edited description',
    );
  });
  await h.search.prepare(new AbortController().signal);
  await flushMicrotasks();
}

it.each(['title', 'desc'] as const)(
  'keeps an exact child marker through a %s blur save',
  async (kind) => {
    const h = await mountList('- [ ] needle\n  old description\n  - [ ] needle child');
    try {
      await dirtyEditor(h, kind);
      const marker = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-subtask-row .abyss-status-marker'),
      );
      const callback = marker.onclick;
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      marker.focus();
      await settledSave(h, kind);
      expect(marker.isConnected).toBe(true);
      expect(marker.onclick).toBe(callback);
      marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      marker.click();
      await vi.waitFor(() => {
        expect(h.index.list()[0]?.subtasks[0]?.status).toBe('done');
      });
      expect(await h.read()).toContain('  - [x] needle child');
      expect(h.index.list()[0]?.status).toBe('open');
      expect(kind === 'title' ? h.index.list()[0]?.title : h.index.list()[0]?.description).toBe(
        kind === 'title' ? 'needle edited' : 'edited description',
      );
    } finally {
      await h.close();
    }
  },
);

it.each(['status', 'priority'] as const)(
  'retains an open %s menu through an owned save and submits once',
  async (pick) => {
    const h = await mountList();
    try {
      await dirtyEditor(h);
      const execute = vi.spyOn(h.tasks, 'execute');
      const marker = h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      marker.focus();
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      await settledSave(h);
      expect(marker.isConnected).toBe(true);
      expect(menu.isConnected).toBe(true);
      marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      expect(menu.isConnected).toBe(true);
      const button =
        pick === 'priority'
          ? expectDefined(menu.querySelector<HTMLElement>('[data-abyss-priority="A"]'))
          : expectDefined(
              [...menu.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find(
                (row) => row.querySelector('.abyss-status-popover-name')?.textContent === 'Done',
              ),
            );
      button.click();
      await vi.waitFor(() => {
        expect(pick === 'priority' ? h.index.list()[0]?.priority : h.index.list()[0]?.status).toBe(
          pick === 'priority' ? 'A' : 'done',
        );
      });
      expect(h.index.list()[0]?.title).toBe('needle edited');
      expect(
        execute.mock.calls.filter(([command]) =>
          pick === 'priority'
            ? command.type === 'patch' && command.patch.priority !== undefined
            : command.type === 'set-status',
        ),
      ).toHaveLength(1);
      await searchUiCompleted(h.root);
      expect(menu.isConnected).toBe(false);
    } finally {
      await h.close();
    }
  },
);

it('retains the command lease when native release precedes a pending inspector save', async () => {
  const h = await mountList();
  const saved = deferred<void>();
  const started = deferred<void>();
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (...args) => {
    started.resolve();
    await saved.promise;
    return process(...args);
  });
  try {
    await dirtyEditor(h);
    const marker = h.marker();
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    marker.focus();
    await started.promise;
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(marker.isConnected).toBe(true);
    marker.click();
    await flushMicrotasks();
    saved.resolve();
    await vi.waitFor(() => {
      expect(h.index.list()[0]).toMatchObject({ title: 'needle edited', status: 'done' });
    });
    await searchUiCompleted(h.root);
  } finally {
    saved.resolve();
    await h.close();
  }
});

it.each(['external', 'delete', 'ambiguous', 'external-after-owned'] as const)(
  'revokes held activation for %s replacement',
  async (change) => {
    const h = await mountList();
    try {
      if (change === 'external-after-owned') await dirtyEditor(h);
      const marker = h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      marker.focus();
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      if (change === 'external-after-owned') await settledSave(h);
      const replacement =
        change === 'ambiguous' ? '- [ ] needle\n- [ ] needle' : '- [ ] needle external 🔺';
      const source = change === 'delete' ? '' : replacement;
      const file = expectDefined(h.app.vault.getFileByPath('tasks.md'));
      await h.app.vault.modify(file, source);
      h.index.installCommittedContent(file.path, source);
      await h.search.prepare(new AbortController().signal);
      await searchUiCompleted(h.root);
      expect(marker.isConnected).toBe(false);
      expect(menu.isConnected).toBe(false);
      expect(h.index.list().every((task) => task.status === 'open')).toBe(true);
    } finally {
      await h.close();
    }
  },
);

it('keeps the unchanged pressed target usable through an unrelated publication', async () => {
  const h = await mountList();
  try {
    const marker = h.marker();
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await h.app.vault.create('other.md', '- [ ] unrelated');
    h.index.installCommittedContent('other.md', '- [ ] unrelated');
    await h.search.prepare(new AbortController().signal);
    await flushMicrotasks();
    expect(marker.isConnected).toBe(true);
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    marker.click();
    await vi.waitFor(() => {
      expect(h.index.list().find((task) => task.title === 'needle')?.status).toBe('done');
    });
    await searchUiCompleted(h.root);
  } finally {
    await h.close();
  }
});

it.each(['removed', 'ambiguous'] as const)(
  'revokes a child target made %s by an owned command',
  async (change) => {
    const created = window.moment().format('YYYY-MM-DD');
    const h = await mountList(`- [ ] needle\n  - [ ] needle child ➕ ${created}`);
    try {
      const root = expectDefined(h.index.list()[0]);
      const child = expectDefined(root.subtasks[0]);
      const marker = expectDefined(
        h.root.querySelector<HTMLElement>('.abyss-subtask-row .abyss-status-marker'),
      );
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      const result = await h.tasks.execute(
        change === 'removed'
          ? { type: 'delete-subtask', subtask: child.ref }
          : { type: 'add-subtask', parent: { type: 'task', ref: root.ref }, text: 'needle child' },
      );
      expect(result.type).toBe('ok');
      if (change === 'ambiguous')
        expect(h.index.list()[0]?.subtasks.map((node) => node.ref.originalBlock)).toEqual([
          child.ref.originalBlock,
          child.ref.originalBlock,
        ]);
      await h.search.prepare(new AbortController().signal);
      await flushMicrotasks();
      expect(marker.isConnected).toBe(false);
      expect(menu.isConnected).toBe(false);
    } finally {
      await h.close();
    }
  },
);

it('flushes after a failed inspector save without losing the status activation', async () => {
  const h = await mountList();
  try {
    vi.spyOn(h.app.vault, 'process').mockRejectedValueOnce(new Error('fixture save failure'));
    await dirtyEditor(h);
    const execute = vi.spyOn(h.tasks, 'execute');
    const marker = h.marker();
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    marker.focus();
    await vi.waitFor(() => {
      expect(execute.mock.settledResults[0]?.type).toBe('fulfilled');
    });
    expect(marker.isConnected).toBe(true);
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    marker.click();
    await vi.waitFor(() => {
      expect(h.index.list()[0]).toMatchObject({ title: 'needle', status: 'done' });
    });
    await searchUiCompleted(h.root);
  } finally {
    await h.close();
  }
});

it('keeps the original marker mounted until an accepted status command settles', async () => {
  const h = await mountList();
  const committed = deferred<void>();
  const started = deferred<void>();
  try {
    await dirtyEditor(h);
    const marker = h.marker();
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    marker.focus();
    await settledSave(h);
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (...args) => {
      started.resolve();
      await committed.promise;
      return process(...args);
    });
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    marker.click();
    await started.promise;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(marker.isConnected).toBe(true);
    committed.resolve();
    await vi.waitFor(() => {
      expect(h.index.list()[0]?.status).toBe('done');
    });
    await searchUiCompleted(h.root);
    expect(marker.isConnected).toBe(false);
  } finally {
    committed.resolve();
    await h.close();
  }
});

it.each(['semantics', 'source-loss'] as const)(
  'revokes an open held menu on %s',
  async (change) => {
    const h = await mountList();
    try {
      await dirtyEditor(h);
      const marker = h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      marker.focus();
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      await settledSave(h);
      if (change === 'semantics') {
        h.index.setStatusCatalog(h.statusCatalog);
        await h.search.prepare(new AbortController().signal);
        await searchUiCompleted(h.root);
      } else {
        h.search.dispose();
        await vi.waitFor(() => {
          expect(h.root.dataset['searchPhase']).toBe('error');
        });
      }
      expect(menu.isConnected).toBe(false);
      expect(marker.isConnected).toBe(false);
      expect(h.index.list()[0]?.status).toBe('open');
    } finally {
      await h.close();
    }
  },
);

it('preserves Search status activation through an owned description save', async () => {
  const h = await mountList('- [ ] needle\n  old description');
  try {
    h.state.set('mode', 'search');
    h.state.set('searchQuery', 'needle');
    await searchUiCompleted(h.root);
    await dirtyEditor(h, 'desc');
    const marker = h.marker();
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    marker.focus();
    await settledSave(h, 'desc');
    expect(marker.isConnected).toBe(true);
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    marker.click();
    await vi.waitFor(() => {
      expect(h.index.list()[0]).toMatchObject({
        status: 'done',
        description: 'edited description',
      });
    });
    expect(await h.read()).toContain('- [x] needle');
  } finally {
    await h.close();
  }
});

it.each(['cancel', 'window', 'query', 'navigation', 'mode', 'dispose'] as const)(
  'flushes a deferred publication on %s cancellation',
  async (cancel) => {
    const h = await mountList();
    try {
      await dirtyEditor(h);
      const marker = h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      marker.focus();
      await settledSave(h);
      expect(marker.isConnected).toBe(true);
      if (cancel === 'cancel') window.dispatchEvent(new Event('pointercancel'));
      else if (cancel === 'window') window.dispatchEvent(new Event('blur'));
      else if (cancel === 'query') h.state.set('centerFilter', 'edited');
      else if (cancel === 'navigation') h.state.set('selectedList', 'today');
      else if (cancel === 'mode') h.state.set('mode', 'calendar');
      else await h.view.onClose();
      if (cancel !== 'mode' && cancel !== 'dispose') await searchUiCompleted(h.root);
      expect(marker.isConnected).toBe(false);
      expect(h.index.list()[0]?.status).toBe('open');
    } finally {
      await h.close();
    }
  },
);
