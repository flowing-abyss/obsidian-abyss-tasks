import { WorkspaceLeaf, type App } from 'obsidian';
import { expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { CenterPanel } from '../src/panels/CenterPanel';
import { TaskListStatusPublication } from '../src/panels/task-list/TaskListStatusPublication';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import { PanelView } from '../src/views/PanelView';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';

useRealMoment();

async function mountList(markdown = '- [ ] needle', kanban = false) {
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
  if (kanban) {
    expectDefined(root.querySelector<HTMLButtonElement>('[aria-label="Kanban view"]')).click();
    await searchUiCompleted(root);
  }
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
  child = false,
) {
  const root = expectDefined(h.index.list()[0]);
  h.state.set('taskStack', child ? [root, expectDefined(root.subtasks[0])] : [root]);
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

it.each(['left', 'right'] as const)(
  'transfers a deferred menu publication to the next marker before its first %s activation',
  async (button) => {
    const h = await mountList('- [ ] needle first\n- [ ] needle second');
    try {
      const markerFor = (title: string) => {
        const card = expectDefined(
          [...h.root.querySelectorAll<HTMLElement>('.abyss-task-card')].find((node) =>
            node.textContent.includes(title),
          ),
        );
        return expectDefined(card.querySelector<HTMLElement>('.abyss-status-marker'));
      };
      const first = markerFor('needle first');
      const second = markerFor('needle second');
      const execute = vi.spyOn(h.tasks, 'execute');
      first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
      first.focus();
      first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2 }));
      const priorMenu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      await h.app.vault.create('other.md', '- [ ] unrelated');
      h.index.installCommittedContent('other.md', '- [ ] unrelated');
      await h.search.prepare(new AbortController().signal);
      await flushMicrotasks();
      expect(priorMenu.isConnected).toBe(true);
      expect(second.isConnected).toBe(true);

      const nativeButton = button === 'left' ? 0 : 2;
      second.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: nativeButton }),
      );
      second.focus();
      second.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: nativeButton }));
      expect(second.isConnected).toBe(true);
      if (button === 'left') second.click();
      else {
        second.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
        const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
        expectDefined(menu.querySelector<HTMLElement>('[data-abyss-priority="A"]')).click();
      }
      await vi.waitFor(() => {
        const task = expectDefined(h.index.list().find((node) => node.title === 'needle second'));
        expect(button === 'left' ? task.status : task.priority).toBe(
          button === 'left' ? 'done' : 'A',
        );
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(h.index.list().find((node) => node.title === 'needle first')?.status).toBe('open');
      await searchUiCompleted(h.root);
      expect(second.isConnected).toBe(false);
      expect(priorMenu.isConnected).toBe(false);
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
      await searchUiCompleted(h.root);
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

function nextSourcePublication(h: Awaited<ReturnType<typeof mountList>>): Promise<void> {
  return new Promise((resolve) => {
    const off = h.index.subscribe((event) => {
      if (event.type !== 'changed' || !event.files.includes('tasks.md')) return;
      off();
      resolve();
    });
  });
}

async function matchingMetadataEcho(h: Awaited<ReturnType<typeof mountList>>): Promise<void> {
  const file = expectDefined(h.app.vault.getFileByPath('tasks.md'));
  const content = await h.read();
  await new Promise<void>((resolve) => {
    const off = h.index.subscribeReconciled((files) => {
      if (!files.includes(file.path)) return;
      off();
      resolve();
    });
    h.app.metadataCache.trigger(
      'changed',
      file,
      content,
      h.app.metadataCache.getFileCache(file) ?? {},
    );
  });
}

const echoedEdits = [
  { kind: 'title', child: false },
  { kind: 'desc', child: false },
  { kind: 'title', child: true },
  { kind: 'desc', child: true },
] as const;

function holdInspectorSave(h: Awaited<ReturnType<typeof mountList>>, fail = false) {
  const commit = deferred<void>(),
    started = deferred<void>(),
    deliver = deferred<void>();
  const echoed = deferred<void>(),
    settled = deferred<void>();
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (...args) => {
    started.resolve();
    await commit.promise;
    if (fail) throw new Error('fixture save failure');
    return process(...args);
  });
  const center = (h.view as unknown as { center_abyssPrivate: CenterPanel }).center_abyssPrivate;
  const mutation = center.onInspectorMutation.bind(center);
  vi.spyOn(center, 'onInspectorMutation').mockImplementation((event) => {
    mutation(event);
    if (event.phase === 'settled') settled.resolve();
  });
  const raw = h.tasks.execute.bind(h.tasks);
  const published = nextSourcePublication(h);
  const execute = vi.spyOn(h.tasks, 'execute').mockImplementation(async (...args) => {
    const result = await raw(...args);
    const command = args[0];
    if (
      command.type === 'set-description' ||
      (command.type === 'patch' && command.patch.markdownTitle !== undefined)
    ) {
      if (result.type === 'ok') {
        await published;
        await matchingMetadataEcho(h);
      }
      echoed.resolve();
      await deliver.promise;
    }
    return result;
  });
  return {
    commit,
    started,
    deliver,
    echoed,
    settled,
    execute,
    release() {
      commit.resolve();
      deliver.resolve();
    },
  };
}

it.each(echoedEdits)(
  'submits the proven successor after metadata echo: $kind, child=$child',
  async ({ kind, child }) => {
    const h = await mountList(
      '- [ ] needle\n  root description\n  - [ ] needle child\n    child description',
    );
    try {
      const before = expectDefined(h.index.list()[0]);
      await dirtyEditor(h, kind, child);
      const published = nextSourcePublication(h);
      const marker = child
        ? expectDefined(
            h.root.querySelector<HTMLElement>('.abyss-subtask-row .abyss-status-marker'),
          )
        : h.marker();
      const execute = vi.spyOn(h.tasks, 'execute');
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      marker.focus();
      await published;
      await matchingMetadataEcho(h);
      const successor = expectDefined(h.index.list()[0]);
      expect(h.index.resolve(before.ref).type).toBe('visual');
      expect(h.index.resolve(successor.ref).type).toBe('exact');
      expect(marker.isConnected).toBe(true);
      marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      marker.click();
      await vi.waitFor(() => {
        expect(child ? h.index.list()[0]?.subtasks[0]?.status : h.index.list()[0]?.status).toBe(
          'done',
        );
      });
      const commands = execute.mock.calls.filter(
        ([command]) => command.type === 'toggle-completion',
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]?.[0]).toMatchObject(
        child
          ? { target: { type: 'subtask', ref: { parent: { ref: successor.ref } } } }
          : { target: { type: 'task', ref: successor.ref } },
      );
    } finally {
      await h.close();
    }
  },
);

it.each(echoedEdits)(
  'waits for the owned save before successor submission: $kind, child=$child',
  async ({ kind, child }) => {
    const h = await mountList(
      '- [ ] needle\n  root description\n  - [ ] needle child\n    child description',
    );
    const { commit, started, deliver, echoed, execute } = holdInspectorSave(h);
    try {
      const before = expectDefined(h.index.list()[0]);
      await dirtyEditor(h, kind, child);
      const marker = child
        ? expectDefined(
            h.root.querySelector<HTMLElement>('.abyss-subtask-row .abyss-status-marker'),
          )
        : h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      marker.focus();
      await started.promise;
      marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      marker.click();
      expect(execute).toHaveBeenCalledTimes(1);
      commit.resolve();
      await echoed.promise;
      expect(h.index.resolve(before.ref).type).toBe('visual');
      expect(marker.isConnected).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      deliver.resolve();
      await vi.waitFor(() => {
        expect(child ? h.index.list()[0]?.subtasks[0]?.status : h.index.list()[0]?.status).toBe(
          'done',
        );
      });
      expect(
        execute.mock.calls.filter(([command]) => command.type === 'toggle-completion'),
      ).toHaveLength(1);
    } finally {
      commit.resolve();
      deliver.resolve();
      await h.close();
    }
  },
);

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

it.each(['cancel', 'blur', 'dispose', 'navigation', 'external'] as const)(
  'releases an accepted action waiting on a proved save after %s',
  async (reason) => {
    const h = await mountList();
    const gate = holdInspectorSave(h);
    const run = vi.spyOn(TaskListStatusPublication.prototype, 'run');
    let inspectorSettled = false;
    const inspectorSettlement = gate.settled.promise.then(() => {
      inspectorSettled = true;
    });
    try {
      await dirtyEditor(h);
      const marker = h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      marker.focus();
      await gate.started.promise;
      marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      marker.click();
      const accepted = run.mock.results[0];
      if (accepted?.type !== 'return') throw new Error('Expected an accepted status action');
      let actionSettled = false;
      const actionSettlement = accepted.value.then(() => {
        actionSettled = true;
      });
      gate.commit.resolve();
      await gate.echoed.promise;
      expect(gate.execute).toHaveBeenCalledTimes(1);
      if (reason === 'cancel') window.dispatchEvent(new Event('pointercancel'));
      else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else if (reason === 'dispose') await h.view.onClose();
      else if (reason === 'navigation') h.state.set('selectedList', 'today');
      else {
        const file = expectDefined(h.app.vault.getFileByPath('tasks.md'));
        await h.app.vault.modify(file, '- [ ] needle external');
        h.index.installCommittedContent(file.path, '- [ ] needle external');
      }
      await vi.waitFor(() => {
        expect(actionSettled).toBe(true);
      });
      await actionSettlement;
      expect(inspectorSettled).toBe(false);
      gate.deliver.resolve();
      await inspectorSettlement;
      if (reason !== 'dispose') await searchUiCompleted(h.root);
      expect(
        gate.execute.mock.calls.filter(([command]) => command.type === 'toggle-completion'),
      ).toHaveLength(0);
      expect(h.index.list()[0]?.status).toBe('open');
    } finally {
      gate.release();
      await h.close();
    }
  },
);

it('uses the unchanged exact target once after a pending inspector save fails', async () => {
  const h = await mountList();
  const gate = holdInspectorSave(h, true);
  try {
    await dirtyEditor(h);
    const marker = h.marker();
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    marker.focus();
    await gate.started.promise;
    marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    marker.click();
    expect(gate.execute).toHaveBeenCalledTimes(1);
    gate.commit.resolve();
    await gate.echoed.promise;
    expect(gate.execute).toHaveBeenCalledTimes(1);
    gate.deliver.resolve();
    await gate.settled.promise;
    await vi.waitFor(() => {
      expect(h.index.list()[0]).toMatchObject({ title: 'needle', status: 'done' });
    });
    expect(
      gate.execute.mock.calls.filter(([command]) => command.type === 'toggle-completion'),
    ).toHaveLength(1);
  } finally {
    gate.release();
    await h.close();
  }
});

it.each(['status', 'priority'] as const)(
  'applies one %s menu action to the proved successor after a pending save and echo',
  async (pick) => {
    const h = await mountList();
    const gate = holdInspectorSave(h);
    try {
      await dirtyEditor(h);
      const marker = h.marker();
      marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      marker.focus();
      await gate.started.promise;
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      marker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));
      const menu = expectDefined(document.querySelector<HTMLElement>('.abyss-status-popover'));
      const button =
        pick === 'priority'
          ? expectDefined(menu.querySelector<HTMLElement>('[data-abyss-priority="A"]'))
          : expectDefined(
              [...menu.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find(
                (row) => row.querySelector('.abyss-status-popover-name')?.textContent === 'Done',
              ),
            );
      button.click();
      expect(gate.execute).toHaveBeenCalledTimes(1);
      gate.commit.resolve();
      await gate.echoed.promise;
      gate.deliver.resolve();
      await gate.settled.promise;
      await vi.waitFor(() => {
        expect(pick === 'priority' ? h.index.list()[0]?.priority : h.index.list()[0]?.status).toBe(
          pick === 'priority' ? 'A' : 'done',
        );
      });
      expect(h.index.list()[0]?.title).toBe('needle edited');
      expect(gate.execute.mock.calls).toHaveLength(2);
    } finally {
      gate.release();
      await h.close();
    }
  },
);

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

it('keeps a Kanban drag source through inspector blur and applies only its proved successor', async () => {
  const h = await mountList('- [ ] needle ⏫', true);
  try {
    await dirtyEditor(h);
    const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    const execute = vi.spyOn(h.tasks, 'execute');
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    card.focus();
    await settledSave(h);
    expect(card.isConnected).toBe(true);
    card.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    // Native drag handoff suppresses the pointer stream without cancelling the drag.
    card.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    const doing = expectDefined(h.statusRegistry.bySymbol('/'));
    const column = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-kanban-column')].find(
        (el) => el.dataset['columnKey'] === `status:${doing.id}`,
      ),
    );
    column.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(h.index.list()[0]?.statusSymbol).toBe('/');
    });
    expect(await h.read()).toContain('- [/] needle edited ⏫');
    expect(execute.mock.calls.filter(([command]) => command.type === 'set-status')).toHaveLength(1);
    expect(h.state.get('draggingTaskNode')).toBeNull();
  } finally {
    await h.close();
  }
});

it.each([false, true])(
  'cancels a Kanban drag before replacement hydration held=%s',
  async (held) => {
    const h = await mountList('- [ ] needle', true);
    const hydration = deferred<void>();
    if (!held) hydration.resolve();
    try {
      const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
      card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      card.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
      expect(h.state.get('draggingTaskNode')).not.toBeNull();
      const resolve = h.index.resolveSearchHits.bind(h.index);
      vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
        await hydration.promise;
        return resolve(hits, signal);
      });
      const file = expectDefined(h.app.vault.getFileByPath('tasks.md'));
      await h.app.vault.modify(file, '- [ ] needle external');
      h.index.installCommittedContent(file.path, '- [ ] needle external');
      await h.search.prepare(new AbortController().signal);
      await vi.waitFor(() => {
        expect(h.state.get('draggingTaskNode')).toBeNull();
      });
      hydration.resolve();
      await searchUiCompleted(h.root);
      expect(await h.read()).toBe('- [ ] needle external');
    } finally {
      hydration.resolve();
      await h.close();
    }
  },
);

it('completes a recurring Kanban task through the ordinary recurrence transaction', async () => {
  const h = await mountList('- [ ] needle 🔁 every day 📅 2026-10-25', true);
  try {
    const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    card.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    const done = h.statusRegistry.defaultDone();
    const column = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-kanban-column')].find(
        (el) => el.dataset['columnKey'] === `status:${done.id}`,
      ),
    );
    column.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(h.index.list()).toHaveLength(2);
    });
    expect(
      h.index
        .list()
        .map((task) => task.status)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['done', 'open']);
    expect(await h.read()).toContain('📅 2026-10-26');
  } finally {
    await h.close();
  }
});

it('revokes a pending Kanban completion confirmation when its window loses focus', async () => {
  const h = await mountList('- [ ] needle 🔁 tomorrow 🏁 delete', true);
  try {
    const execute = vi.spyOn(h.tasks, 'execute');
    const card = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-card'));
    card.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
    const done = h.statusRegistry.defaultDone();
    const column = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-kanban-column')].find(
        (el) => el.dataset['columnKey'] === `status:${done.id}`,
      ),
    );
    column.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true }));
    const confirm = expectDefined(
      document.querySelector<HTMLButtonElement>('.abyss-recurrence-delete-confirm-button'),
    );
    window.dispatchEvent(new Event('blur'));
    confirm.click();
    await flushMicrotasks();
    expect(execute.mock.calls.filter(([command]) => command.type === 'set-status')).toHaveLength(0);
    expect(await h.read()).toBe('- [ ] needle 🔁 tomorrow 🏁 delete');
  } finally {
    await h.close();
  }
});
