import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { parseLinks } from '../src/markdown/links';
import { CenterPanel } from '../src/panels/CenterPanel';
import type { InspectorSections } from '../src/panels/right/InspectorSections';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi } from '../src/tasks';
import type { TaskRef, TaskSnapshot } from '../src/tasks/domain/types';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { taskNodeRef } from '../src/ui/taskSelection';
import {
  createAppWithFiles,
  editSettingControl,
  expectDefined,
  task,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import {
  inspectorCleanups,
  inspectorHarness,
  subscribeInspectorReconciliation,
} from './support/inspectorHarness';
import {
  captureLinkModals,
  captureMenus,
  clickSave,
  mockReadingView,
  modalInputs,
  rightClick,
  settleRender,
} from './support/linkEditHarness';
import { taskCommandsOf } from './support/panelHarness';

useRealMoment();

function call<T>(owner: object, method: string, ...args: unknown[]): T {
  const name = method === 'updateTaskTitle' ? method : `${method}_abyssPrivate`;
  const fn = expectDefined((owner as Record<string, (...values: unknown[]) => T>)[name]);
  return fn.call(owner, ...args);
}

function taskApi(ref: TaskRef) {
  const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'not-found',
    target: { type: 'task', ref },
  });
  return {
    execute,
    tasks: {
      queries: taskQueryApi(),
      execute,
    },
  };
}

function saveImmediately(replacement: string) {
  return vi.spyOn(LinkEditModal.prototype, 'open').mockImplementation(function (
    this: LinkEditModal,
  ) {
    (this as unknown as { onSave_abyssPrivate: (raw: string) => void }).onSave_abyssPrivate(
      replacement,
    );
  });
}

describe('task link rewrite delegation', () => {
  it.each(['description', 'comment'] as const)(
    'keeps retained %s link targets fresh while preserving already-open editor authority',
    async (field) => {
      for (const openBefore of [false, true]) {
        mockReadingView();
        const menus = captureMenus();
        const modals = captureLinkModals();
        const h = await inspectorHarness(
          '- [ ] Root\n  - [ ] Branch\n    - [ ] Owner\n      - > [[Old]]\n      - [[Old]]\n      - [ ] Existing\n  - 2026-10-06T09:00:00+07:00 → 2026-10-06T09:20:00+07:00',
          'Owner',
        );
        const off = subscribeInspectorReconciliation(h);
        try {
          await settleRender();
          const selector =
            field === 'description' ? '.abyss-right-desc-view' : '.abyss-comment-text';
          const link = expectDefined(h.el.querySelector(`${selector} a`));
          const textTarget = () =>
            field === 'description'
              ? { type: 'description' as const, target: taskNodeRef(h.node('Owner').node) }
              : {
                  type: 'comment' as const,
                  ref: expectDefined(h.node('Owner').node.comments[0]).ref,
                };
          const original = textTarget();
          const header = expectDefined(h.el.querySelector('.abyss-right-header'));
          const row = expectDefined(h.el.querySelector('.abyss-subtask-row'));
          const open = () => {
            rightClick(link);
            expectDefined(menus[menus.length - 1]).pick('Edit link…');
          };
          if (openBefore) open();
          await call<Promise<boolean>>(h.panel, 'addSubTask', h.node('Owner').node, 'Added');
          expect(link.isConnected).toBe(true);
          if (!openBefore) open();
          const target = openBefore ? original : textTarget();
          const execute = vi.spyOn(h.api, 'execute');
          const modal = modals.last();
          editSettingControl(modalInputs(modal).target, 'Changed');
          clickSave(modal);
          await vi.waitFor(() => {
            expect(execute).toHaveBeenCalledWith({
              type: 'edit-link',
              target,
              occurrence: 0,
              replacement: '[[Changed]]',
            });
          });
          if (!openBefore) {
            await vi.waitFor(() => {
              expect(h.el.querySelector(selector)?.textContent).toBe('Changed');
            });
            expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
              'Root',
              'Branch',
              'Owner',
            ]);
            expect(header.isConnected).toBe(true);
            expect(row.isConnected).toBe(true);
          } else {
            await settleRender();
            expect(h.el.querySelector(selector)?.textContent).toBe('Old');
          }
        } finally {
          off();
          for (const cleanup of inspectorCleanups.splice(0)) cleanup();
        }
        vi.restoreAllMocks();
      }
    },
  );

  it('refreshes an edited ancestor breadcrumb before a second alias-only link edit', async () => {
    mockReadingView();
    const menus = captureMenus();
    const modals = captureLinkModals();
    const h = await inspectorHarness(
      '- [ ] Root [[Old]]\n  - [ ] Branch [[Unchanged]]\n    - [ ] Owner\n      - > Selected description\n      - [ ] Existing',
      'Owner',
    );
    const off = subscribeInspectorReconciliation(h);
    try {
      await settleRender();
      const crumbs = h.el.querySelectorAll('.abyss-breadcrumb-item');
      const rootCrumb = expectDefined(crumbs[0]);
      const branchLink = expectDefined(expectDefined(crumbs[1]).querySelector('a'));
      const originalLink = expectDefined(rootCrumb.querySelector('a'));
      const header = expectDefined(h.el.querySelector('.abyss-right-header'));
      const description = expectDefined(h.el.querySelector('.abyss-right-desc-view'));
      const open = (link: Element) => {
        rightClick(link);
        expectDefined(menus[menus.length - 1]).pick('Edit link…');
        return modals.last();
      };
      const first = open(originalLink);
      editSettingControl(modalInputs(first).target, 'New');
      clickSave(first);
      await vi.waitFor(async () => {
        expect(await h.read()).toContain('Root [[New]]');
      });
      await settleRender();
      expect(rootCrumb.querySelector('a')?.textContent).toBe('New');
      expect(header.isConnected).toBe(true);
      expect(description.isConnected).toBe(true);
      expect(branchLink.isConnected).toBe(true);
      const menuCount = menus.length;
      rightClick(originalLink);
      expect(menus).toHaveLength(menuCount);
      const second = open(expectDefined(rootCrumb.querySelector('a')));
      expect(modalInputs(second).target.value).toBe('New');
      editSettingControl(modalInputs(second).display, 'Alias');
      clickSave(second);
      await vi.waitFor(async () => {
        expect(await h.read()).toContain('Root [[New|Alias]]');
      });
      await settleRender();
      expect(rootCrumb.querySelector('a')?.textContent).toBe('Alias');
      expect(rootCrumb.querySelector('a')?.getAttribute('data-href')).toBe('New');
      expect(h.state.get('taskStack').map((node) => node.markdownTitle)).toEqual([
        'Root [[New|Alias]]',
        'Branch [[Unchanged]]',
        'Owner',
      ]);
      expect(header.isConnected).toBe(true);
      expect(description.isConnected).toBe(true);
      expect(branchLink.isConnected).toBe(true);
    } finally {
      off();
      for (const cleanup of inspectorCleanups.splice(0)) cleanup();
    }
  });

  it('owns a link editor once per open and releases it idempotently on close', async () => {
    const app = await createAppWithFiles({});
    const release = vi.fn();
    const interactionOwnership = { acquire: vi.fn(() => ({ release })) };
    const modal = new LinkEditModal(
      app,
      {
        raw: '[Old](https://example.com)',
        type: 'md',
        target: 'https://example.com',
        display: 'Old',
        index: 0,
      },
      vi.fn(),
      '',
      interactionOwnership,
    );

    modal.onOpen();
    expect(interactionOwnership.acquire).toHaveBeenCalledOnce();
    expect(interactionOwnership.acquire).toHaveBeenCalledWith({ blocksShortcuts: true });
    modal.onClose();
    modal.onClose();
    expect(release).toHaveBeenCalledOnce();
  });

  it('routes a RightPanel title link edit through the typed target', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] [[Old]]\n' });
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const { tasks, execute } = taskApi(ref);
    const panel = new RightPanel({
      state: new AppState(),
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      tasks,
    });
    const current = Object.assign(
      task({ markdownTitle: '[[Old]]', source: { filePath: 't.md' } }),
      { ref },
    );
    saveImmediately('[[Changed]]');

    (
      panel as unknown as { sections_abyssPrivate: InspectorSections }
    ).sections_abyssPrivate.editLink(current, 0, {
      raw: '[[Old]]',
      type: 'wiki',
      target: 'Old',
      display: 'Old',
      index: 0,
    });
    await Promise.resolve();

    expect(execute).toHaveBeenCalledWith({
      type: 'edit-link',
      target: { type: 'title', target: { type: 'task', ref } },
      occurrence: 0,
      replacement: '[[Changed]]',
    });
  });

  it('routes a CenterPanel card title link edit through the same API', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] [[Old]]\n' });
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const { tasks, execute } = taskApi(ref);
    const state = new AppState();
    const panel = new CenterPanel({
      state,
      app,
      settings: DEFAULT_SETTINGS,
      queries: tasks.queries,
      statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      projectStore: null,
      projectManager: null,
      tasks,
    });
    const current = Object.assign(
      task({ markdownTitle: '[[Old]]', source: { filePath: 't.md' } }),
      { ref },
    );
    saveImmediately('[[Changed]]');

    taskCommandsOf(panel).editTaskLink(current, 0, {
      raw: '[[Old]]',
      type: 'wiki',
      target: 'Old',
      display: 'Old',
      index: 0,
    });
    await Promise.resolve();

    expect(execute).toHaveBeenCalledWith({
      type: 'edit-link',
      target: { type: 'title', target: { type: 'task', ref } },
      occurrence: 0,
      replacement: '[[Changed]]',
    });
  });

  it('routes description and revisioned comment link edits through their exact targets', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] root\n' });
    const ref: TaskRef = { filePath: 't.md', line: 0, revision: 'root' };
    const commentRef = {
      parent: { type: 'task' as const, ref },
      relativeLine: 1,
      originalMarkdown: '  - 2026-07-14: [[Old]]',
    };
    const { tasks, execute } = taskApi(ref);
    const state = new AppState();
    state.set('taskStack', [
      task({
        ref,
        title: 'root',
        source: { filePath: 't.md' },
        description: '[[First]] [[Old]]',
        comments: [{ ref: commentRef, text: '[[Old]]' }],
      }),
    ]);
    mockReadingView();
    const menus = captureMenus();
    const modals = captureLinkModals();
    const panel = new RightPanel({
      state,
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      tasks,
    });
    const container = activeDocument.body.createDiv();
    panel.mount(container);
    await settleRender();
    try {
      const links = [
        expectDefined(container.querySelectorAll('.abyss-right-desc-view a')[1]),
        expectDefined(container.querySelector('.abyss-comment-text a')),
      ];
      for (const link of links) {
        rightClick(link);
        expectDefined(menus[menus.length - 1]).pick('Edit link…');
        const modal = modals.last();
        editSettingControl(modalInputs(modal).target, 'Changed');
        clickSave(modal);
        await settleRender();
      }
    } finally {
      panel.destroy();
      container.remove();
    }

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        type: 'edit-link',
        target: { type: 'description', target: { type: 'task', ref } },
        occurrence: 1,
        replacement: '[[Changed]]',
      },
      {
        type: 'edit-link',
        target: { type: 'comment', ref: commentRef },
        occurrence: 0,
        replacement: '[[Changed]]',
      },
    ]);
  });

  it('converges the selected stack and acknowledgement callback on the returned fresh revision', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] Old\n' });
    const staleRef: TaskRef = { filePath: 't.md', line: 0, revision: 'stale' };
    const freshRef: TaskRef = { ...staleRef, revision: 'fresh' };
    const fresh: TaskSnapshot = {
      ref: freshRef,
      title: 'New',
      markdownTitle: 'New',
      status: 'open',
      statusSymbol: ' ',
      priority: 'D',
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      dependsOn: [],
      subtasks: [],
      comments: [],
      timeEntries: [],
      source: {
        filePath: 't.md',
        line: 0,
        originalMarkdown: '- [ ] New',
        originalBlock: '- [ ] New',
      },
      presentation: { linkCount: 0 },
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: fresh },
    });
    const tasks: TaskApplicationApi = { ...taskApi(staleRef).tasks, execute };
    const state = new AppState();
    state.set('taskStack', [
      Object.assign(task({ title: 'Old', source: { filePath: 't.md' } }), { ref: staleRef }),
    ]);
    const acknowledged = vi.fn();
    const panel = new RightPanel({
      state,
      app,
      statusRegistry: testStatusRegistry(),
      settings: DEFAULT_SETTINGS,
      onSuccessfulMutation: acknowledged,
      tasks,
    });

    await call<Promise<void>>(
      panel,
      'updateTaskTitle',
      expectDefined(state.get('taskStack')[0]),
      'New',
    );

    expect(state.get('taskStack')[0]).toMatchObject({ ref: freshRef, markdownTitle: 'New' });
    expect(acknowledged).toHaveBeenCalledWith(freshRef);
  });
});

describe('link edit modal Save', () => {
  async function openModal(raw: string, onSave: (newRaw: string) => void): Promise<LinkEditModal> {
    const token = expectDefined(parseLinks(raw)[0]);
    const modal = new LinkEditModal(await createAppWithFiles({}), token, onSave);
    modal.onOpen();
    return modal;
  }

  function save(modal: LinkEditModal): void {
    expectDefined(
      Array.from(modal.contentEl.querySelectorAll<HTMLElement>('button')).find(
        (button) => button.textContent === 'Save',
      ),
    ).click();
  }

  // Rebuilding these unchanged links would rewrite `[[a|]]` as `[[a]]` and `[ a ]( b )` as
  // `[a](b)`.
  it.each([String.raw`[[Note\|Alias]]`, '[[a|]]', '[a](b)', '[ a ]( b )'])(
    'writes nothing when nothing changed in %s',
    async (raw) => {
      const onSave = vi.fn();
      const modal = await openModal(raw, onSave);
      const close = vi.spyOn(modal, 'close');

      save(modal);

      expect(onSave).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('rebuilds the link with the trimmed display when the display changes', async () => {
    const onSave = vi.fn();
    const modal = await openModal(String.raw`[[Note\|Alias]]`, onSave);
    const close = vi.spyOn(modal, 'close');
    const display = expectDefined(modal.contentEl.querySelectorAll('input')[1]);

    editSettingControl(display, ' Renamed ');
    save(modal);

    expect(onSave).toHaveBeenCalledExactlyOnceWith(String.raw`[[Note\|Renamed]]`);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rebuilds the link when the target changes', async () => {
    const onSave = vi.fn();
    const modal = await openModal('[a](b)', onSave);
    const close = vi.spyOn(modal, 'close');
    const target = expectDefined(modal.contentEl.querySelectorAll('input')[0]);

    editSettingControl(target, 'c');
    save(modal);

    expect(onSave).toHaveBeenCalledExactlyOnceWith('[a](c)');
    expect(close).toHaveBeenCalledOnce();
  });
});

it('refuses a link acquired only by truncating a multiline code literal', async () => {
  mockReadingView();
  const menus = captureMenus();
  const open = vi.spyOn(LinkEditModal.prototype, 'open');
  const h = await inspectorHarness('- [ ] Owner\n  - `[[Hidden]]\n    code` [[Actual]]', 'Owner');
  try {
    await settleRender();
    rightClick(expectDefined(h.el.querySelector('.abyss-comment-text a')));
    expectDefined(menus[menus.length - 1]).pick('Edit link…');
    expect(open).not.toHaveBeenCalled();
    expect(await h.read()).toBe('- [ ] Owner\n  - `[[Hidden]]\n    code` [[Actual]]');
  } finally {
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
  }
});

it('edits the second-line link from an expanded comment through its full source occurrence', async () => {
  mockReadingView();
  const menus = captureMenus();
  const modals = captureLinkModals();
  const h = await inspectorHarness('- [ ] Owner\n  - [[First]]\n    [[Second]]', 'Owner');
  try {
    expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-comment-disclosure')).click();
    await settleRender();
    const ref = expectDefined(h.node('Owner').node.comments[0]).ref;
    const execute = vi.spyOn(h.api, 'execute');
    rightClick(expectDefined(h.el.querySelectorAll('.abyss-comment-text a')[1]));
    expectDefined(menus[menus.length - 1]).pick('Edit link…');
    const modal = modals.last();
    editSettingControl(modalInputs(modal).target, 'Changed');
    clickSave(modal);
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledWith({
        type: 'edit-link',
        target: { type: 'comment', ref },
        occurrence: 1,
        replacement: '[[Changed]]',
      });
      expect(h.node('Owner').node.comments[0]?.text).toBe('[[First]]\n[[Changed]]');
    });
  } finally {
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
  }
});
