import {
  MarkdownRenderer,
  Menu,
  MenuItem,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  type App,
} from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { type AppState, type ListSelection } from '../src/app/AppState';
import type { CenterPanel } from '../src/panels/CenterPanel';
import { ProjectManager } from '../src/projects/ProjectManager';
import type { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import { discoveredPrefixGroupId, resolveEffectiveTagGroups } from '../src/tags/effectiveTagGroups';
import { collectTaskNodeTags } from '../src/tags/taskTagCatalog';
import type {
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskCreateSession,
  TaskIndexEvent,
  TaskNodeRef,
  TaskQueryApi,
  TaskRef,
  TaskSnapshot,
} from '../src/tasks';
import type { CreationPresentationController } from '../src/ui/creation/CreationPresentationController';
import type { InteractionRegistry } from '../src/ui/interactionOwnership';
import { PanelShortcutRouter } from '../src/ui/panelShortcutRouter';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import type { QuickCaptureCoordinator } from '../src/ui/taskCapture/QuickCaptureCoordinator';
import { requestTaskCompletion } from '../src/ui/taskCommandResult';
import { renderedTaskNodeElements, taskPresentationKey } from '../src/ui/taskPresentationIdentity';
import { taskNodeLine, type TaskSelectionNode } from '../src/ui/taskSelection';
import type { CompactPaneAccess } from '../src/views/CompactPaneAccess';
import { MonthGridView } from '../src/views/MonthGridView';
import { PANEL_VIEW_TYPE, PanelView } from '../src/views/PanelView';
import type { PanelNavigator } from '../src/views/panelNavigation';
import { cssDeclarations, cssDeclarationText } from './cssHelpers';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  dispatchDnD,
  expectDefined,
  flushMicrotasks,
  loadPluginStyles,
  seedTaskCache,
  task,
  useRealMoment,
} from './helpers';
import { taskCommandsOf } from './support/panelHarness';
import { canonicalSearchForIndex, createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';

function workspaceState(app: App): { activeLeaf: WorkspaceLeaf | null } {
  return app.workspace;
}

function makeTagManager(app: App, settings: CalendarSettings = DEFAULT_SETTINGS): TagManager {
  const save = vi.fn().mockResolvedValue(undefined);
  return new TagManager(app, settings, save, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
}

useRealMoment();

type EventWindow = Window & Pick<typeof window, 'KeyboardEvent' | 'Event'>;

function panelCaptureTarget(execute: TaskCreateSession['execute']): CaptureTarget {
  return {
    label: 'Test destination',
    context: { type: 'list', selection: 'today' },
    session: {
      type: 'ready',
      destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
      execute,
    },
    markdownPrefix: '',
    markdownSuffixes: [],
  };
}

function successfulCaptureResult(): TaskCommandResult {
  return {
    type: 'ok',
    changed: true,
    outcome: {
      type: 'task',
      task: task({ title: 'Captured', source: { filePath: 'Capture.md', line: 0 } }),
    },
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function rectList(rectangles: readonly DOMRect[]): DOMRectList {
  const values = [...rectangles];
  return Object.assign(values, {
    item: (index: number) => values[index] ?? null,
  });
}

function setGeometry(
  element: Element,
  bounds: DOMRect,
  clientRects: readonly DOMRect[] = [bounds],
): void {
  const list = rectList(clientRects);
  Object.defineProperties(element, {
    getBoundingClientRect: { configurable: true, value: () => bounds },
    getClientRects: { configurable: true, value: () => list },
  });
}

function emitQueryEvent(queries: TaskQueryApi, event: TaskIndexEvent): void {
  const source = queries as unknown as {
    listeners_abyssPrivate: Array<(published: TaskIndexEvent) => void>;
  };
  for (const listener of [...source.listeners_abyssPrivate]) listener(event);
}

function setTaskStack(state: AppState, stack: TaskSelectionNode[]): void {
  state.set('taskStack', stack);
}

function computedStyleWithFontSize(
  style: CSSStyleDeclaration,
  fontSize: string,
): CSSStyleDeclaration {
  return new Proxy(style, {
    get: (target, property): unknown =>
      property === 'fontSize' ? fontSize : Reflect.get(target, property, target),
  });
}

describe('PanelView host styles', () => {
  it('clears the host padding and scrolling on its own content element only', async () => {
    const css = await loadPluginStyles();

    expect(
      cssDeclarationText(
        css,
        `.workspace-leaf-content[data-type='${PANEL_VIEW_TYPE}'] > .view-content.abyss-panel-view`,
      ),
    ).toBe(['padding: 0;', 'overflow: hidden;'].join('\n'));
    const panelProperties = cssDeclarations(css, '.abyss-panel-view').map(({ prop }) => prop);
    expect(panelProperties).not.toContain('padding');
    expect(panelProperties).not.toContain('overflow');
  });
});

describe('PanelView centre composition', () => {
  it('keeps the settings and view-state save callbacks distinct', async () => {
    const app = await createAppWithFiles({ 'tasks.md': '- [ ] Root\n' });
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await application.index.initialize();
    const onSaveSettings = async (): Promise<void> => {};
    const onSaveViewState = async (): Promise<void> => {};
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
    const view = new PanelView(
      leaf,
      DEFAULT_SETTINGS,
      makeTagManager(app),
      application.index,
      application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
      application.statusRegistry,
      onSaveSettings,
      undefined,
      onSaveViewState,
    );
    await view.onOpen();
    try {
      const internals = view as unknown as {
        readonly onSaveSettings_abyssPrivate: () => Promise<void>;
        readonly onSaveViewState_abyssPrivate: () => Promise<void>;
        readonly center_abyssPrivate: {
          readonly onSaveSettings_abyssPrivate: (() => Promise<void>) | undefined;
          readonly onSaveViewState_abyssPrivate: () => Promise<void>;
        };
      };
      expect(internals.onSaveSettings_abyssPrivate).toBe(onSaveSettings);
      expect(internals.onSaveViewState_abyssPrivate).toBe(onSaveViewState);
      expect(internals.center_abyssPrivate.onSaveSettings_abyssPrivate).toBe(
        internals.onSaveSettings_abyssPrivate,
      );
      expect(internals.center_abyssPrivate.onSaveViewState_abyssPrivate).toBe(
        internals.onSaveViewState_abyssPrivate,
      );
      expect(internals.center_abyssPrivate.onSaveSettings_abyssPrivate).not.toBe(
        internals.center_abyssPrivate.onSaveViewState_abyssPrivate,
      );
    } finally {
      await view.onClose();
      view.containerEl.remove();
      application.index.destroy();
    }
  });
});

describe('PanelView dependency command convergence', () => {
  it('converges a restored subtree through the committed parent root', async () => {
    const app = await createAppWithFiles({
      'tasks.md': '- [ ] Root\n  - [ ] Removed\n  - [ ] Next\n',
    });
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await application.index.initialize();
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
    const view = new PanelView(
      leaf,
      DEFAULT_SETTINGS,
      makeTagManager(app),
      application.index,
      application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
      application.statusRegistry,
    );
    await view.onOpen();
    try {
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        createSelectionTasks_abyssPrivate(): TaskApplicationApi;
        convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void;
      };
      const root = expectDefined(application.index.list()[0]);
      internals.state_abyssPrivate.set('taskStack', [root]);
      const tasks = internals.createSelectionTasks_abyssPrivate();
      const deleted = await tasks.execute({
        type: 'delete-subtask',
        subtask: expectDefined(root.subtasks[0]).ref,
      });
      if (deleted.type !== 'ok' || deleted.outcome.type !== 'task')
        throw new Error('delete failed');
      const recovery = expectDefined(deleted.outcome.subtaskRemovalRecovery);
      const converge = vi.spyOn(internals, 'convergeOwnCommand_abyssPrivate');
      const restored = await tasks.execute({ type: 'restore-subtask', ...recovery });
      expect(restored.type).toBe('ok');
      // A restore removes no root task, so the convergence gets no pre-command selection.
      expect(converge).toHaveBeenCalledExactlyOnceWith(
        deleted.outcome.task.ref,
        restored,
        undefined,
      );
      expect(
        internals.state_abyssPrivate.get('taskStack')[0]?.subtasks.map((child) => child.title),
      ).toEqual(['Removed', 'Next']);
    } finally {
      await view.onClose();
      view.containerEl.remove();
      application.index.destroy();
    }
  });

  it.each(['blocked-by', 'blocks', 'remove-raw', 'restore-raw'] as const)(
    'preserves the selected structural chain for %s through the index event',
    async (operation) => {
      const app = await createAppWithFiles({
        'dependencies.md':
          '\n- [ ] Selected\n  - [ ] Parent\n    - [ ] Child ⛔ missing\n- [ ] Other\n',
      });
      const application = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await application.index.initialize();
      const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      const view = new PanelView(
        leaf,
        DEFAULT_SETTINGS,
        makeTagManager(app),
        application.index,
        application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        application.statusRegistry,
      );
      await view.onOpen();
      try {
        const selected = expectDefined(
          application.index.listNodes().find(({ node }) => node.title === 'Child'),
        );
        const other = expectDefined(
          application.index.listNodes().find(({ node }) => node.title === 'Other'),
        );
        const internals = view as unknown as {
          state_abyssPrivate: AppState;
          createSelectionTasks_abyssPrivate(): TaskApplicationApi;
          convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void;
        };
        internals.state_abyssPrivate.set('taskStack', [other.root]);
        internals.state_abyssPrivate.openInspectorDependency(selected);
        const history = internals.state_abyssPrivate.get('inspectorBackStack');
        const converge = vi.spyOn(internals, 'convergeOwnCommand_abyssPrivate');
        const tasks = internals.createSelectionTasks_abyssPrivate();
        let result: TaskCommandResult;
        if (operation === 'remove-raw') {
          result = await tasks.execute({
            type: 'remove-dependency',
            dependent: selected.target,
            dependencyId: 'missing',
          });
        } else if (operation === 'restore-raw') {
          result = await tasks.execute({
            type: 'restore-dependency',
            dependent: selected.target,
            recovery: {
              dependencyId: 'restored',
              beforeIds: ['missing', 'restored'],
              afterIds: ['missing'],
            },
          });
        } else {
          result = await tasks.execute({
            type: 'add-dependency',
            blocker: operation === 'blocked-by' ? other.target : selected.target,
            dependent: operation === 'blocked-by' ? selected.target : other.target,
          });
        }
        expect(result).toMatchObject({ type: 'ok', outcome: { type: 'dependency' } });
        expect(converge).not.toHaveBeenCalled();
        await flushMicrotasks();
        const stack = internals.state_abyssPrivate.get('taskStack');
        expect(stack.map((node) => node.title)).toEqual(['Selected', 'Parent', 'Child']);
        const fresh = expectDefined(
          application.index.listNodes().find(({ node }) => node.title === 'Child'),
        );
        expect(stack).toEqual([fresh.root, ...fresh.path]);
        const liveOther = expectDefined(
          application.index.listNodes().find(({ node }) => node.title === 'Other'),
        );
        expect(history).toEqual([{ taskStack: [other.root] }]);
        expect(internals.state_abyssPrivate.get('inspectorBackStack')).toEqual([
          { taskStack: [liveOther.root] },
        ]);
        expect(internals.state_abyssPrivate.backInspectorDependency()).toBe(true);
        expect(internals.state_abyssPrivate.get('taskStack')).toEqual([liveOther.root]);
        expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
      } finally {
        await view.onClose();
        view.containerEl.remove();
        application.index.destroy();
      }
    },
  );
});

describe('PanelView inspector focus continuity', () => {
  it('returns focus to the rebuilt priority chip after the sidebar applies the index change', async () => {
    const app = await createAppWithFiles({ 'tasks.md': '\n- [ ] Current\n' });
    const application = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
    await application.index.initialize();
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
    const view = new PanelView(
      leaf,
      DEFAULT_SETTINGS,
      makeTagManager(app),
      application.index,
      application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
      application.statusRegistry,
    );
    await view.onOpen();
    activeDocument.body.appendChild(view.containerEl);
    try {
      const internals = view as unknown as { state_abyssPrivate: AppState };
      internals.state_abyssPrivate.set('taskStack', [expectDefined(application.index.list()[0])]);
      const chip = expectDefined(
        view.contentEl.querySelector<HTMLButtonElement>('.abyss-right .abyss-priority-chip'),
      );

      chip.focus();
      chip.click();
      const option = expectDefined(
        view.contentEl.querySelector<HTMLButtonElement>(
          '.abyss-right .abyss-priority-option[data-priority="A"]',
        ),
      );
      option.focus();
      option.click();
      await flushMicrotasks(20);

      const file = app.vault.getAbstractFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      expect(await app.vault.read(file)).toBe('\n- [ ] Current 🔺\n');
      const rebuilt = expectDefined(
        view.contentEl.querySelector<HTMLButtonElement>('.abyss-right .abyss-priority-chip'),
      );
      expect(rebuilt).not.toBe(chip);
      expect(activeDocument.activeElement).toBe(rebuilt);
    } finally {
      await view.onClose();
      view.containerEl.remove();
      application.index.destroy();
    }
  });
});

type TaskApplication = ReturnType<typeof configuredTaskApplication>;

interface RemovalPanel {
  readonly app: App;
  readonly application: TaskApplication;
  readonly view: PanelView;
  readonly state: AppState;
  /** Every task stack the panel published after it opened, as node titles. */
  readonly selections: string[][];
  /** Holds index updates from the panel until the returned release delivers them. */
  holdIndexEvents(): () => void;
  card(title: string): HTMLElement;
  projectRow(name: string): HTMLElement;
  select(title: string): void;
  read(path?: string): Promise<string>;
  close(): Promise<void>;
}

interface RemovalModalInternals {
  readonly center_abyssPrivate: {
    readonly taskModal_abyssPrivate: {
      open(task: TaskSnapshot): void;
      readonly innerState_abyssPrivate: AppState | null;
    };
  };
}

function todayNote(titles: readonly string[]): string {
  const today = window.moment().format('YYYY-MM-DD');
  const lines = titles.map((title) => `- [ ] ${title} 📅 ${today}`);
  return ['', ...lines, ''].join('\n');
}

async function settleRemoval(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await flushMicrotasks();
}

async function openRemovalPanel(
  files: Record<string, string> = { 'today.md': todayNote(['First', 'Second', 'Third']) },
  configure?: (settings: CalendarSettings) => void,
): Promise<RemovalPanel> {
  const app = await createAppWithFiles(files);
  const settings = structuredClone(DEFAULT_SETTINGS);
  configure?.(settings);
  const application = configuredTaskApplication(app, settings, { authority: true });
  await application.index.initialize();
  const held: Array<() => void> = [];
  let holding = false;
  const subscribe = application.index.subscribe.bind(application.index);
  vi.spyOn(application.index, 'subscribe').mockImplementation((listener) =>
    subscribe((event) => {
      if (!holding) {
        listener(event);
        return;
      }
      held.push(() => {
        listener(event);
      });
    }),
  );
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
  // As in main.ts, the plugin's project manager runs its commands on the raw task service.
  const projectManager = new ProjectManager(
    app,
    settings,
    {
      createNoteFromTemplate: () => Promise.reject(new Error('No project notes in this test')),
    },
    application.tasks,
  );
  const view = new PanelView(
    leaf,
    settings,
    makeTagManager(app, settings),
    application.index,
    application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
    application.statusRegistry,
    async () => {},
    undefined,
    async () => {},
    projectManager,
  );
  await view.onOpen();
  activeDocument.body.appendChild(view.containerEl);
  const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
  const selections: string[][] = [];
  state.on('taskStack', (stack) => {
    selections.push(stack.map((node) => node.title));
  });
  const card = (title: string): HTMLElement =>
    expectDefined(
      [...view.contentEl.querySelectorAll<HTMLElement>('.abyss-task-card')].find(
        (candidate) => candidate.querySelector('.abyss-task-title')?.textContent === title,
      ),
    );
  return {
    app,
    application,
    view,
    state,
    selections,
    holdIndexEvents: () => {
      holding = true;
      return () => {
        holding = false;
        for (const deliver of held.splice(0)) deliver();
      };
    },
    card,
    projectRow: (name) =>
      expectDefined(
        [...view.contentEl.querySelectorAll<HTMLElement>('.abyss-project-item')].find(
          (row) => row.querySelector('.abyss-left-label')?.textContent === name,
        ),
      ),
    select: (title) => {
      card(title).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
    read: async (path = 'today.md') => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`Missing ${path}`);
      return app.vault.read(file);
    },
    close: async () => {
      activeDocument.querySelector('.abyss-modal-backdrop')?.remove();
      await view.onClose();
      view.containerEl.remove();
      application.index.destroy();
    },
  };
}

function clickCardMenuItem(card: HTMLElement, title: string): void {
  // The card menus colour a few rows through the item's element, which the mock leaves unset.
  const itemDom = vi
    .spyOn(MenuItem.prototype as unknown as { constructor__(): void }, 'constructor__')
    .mockImplementation(function (this: { dom: HTMLElement }) {
      this.dom = createDiv();
    });
  const show = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = expectDefined(show.mock.instances[show.mock.instances.length - 1]) as {
    readonly menuItems__: ReadonlyArray<{
      readonly title__: string;
      readonly onClick__: ((event: MouseEvent) => void) | null;
    }>;
  };
  show.mockRestore();
  itemDom.mockRestore();
  const item = expectDefined(menu.menuItems__.find((candidate) => candidate.title__ === title));
  expectDefined(item.onClick__)(new MouseEvent('click'));
}

function clickInspectorAction(scope: HTMLElement, label: 'Delete task' | 'Archive'): void {
  expectDefined(
    scope.querySelector<HTMLElement>('.abyss-right-action-btn[aria-label="More actions"]'),
  ).click();
  expectDefined(
    [...scope.querySelectorAll<HTMLElement>('.abyss-task-context-menu .abyss-context-item')].find(
      (item) => item.textContent === label,
    ),
  ).click();
}

function sidebarInspector(panel: RemovalPanel): HTMLElement {
  return expectDefined(panel.view.contentEl.querySelector<HTMLElement>('.abyss-right'));
}

const panelRemovals: ReadonlyArray<readonly [string, (panel: RemovalPanel) => void]> = [
  [
    'the x on the selected card',
    (panel) => {
      expectDefined(
        panel.card('First').querySelector<HTMLElement>('.abyss-task-delete-btn'),
      ).click();
    },
  ],
  [
    'the bulk Delete',
    (panel) => {
      for (const title of ['First', 'Second']) {
        panel.card(title).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      }
      clickCardMenuItem(panel.card('First'), 'Delete all');
    },
  ],
  [
    'the list Archive',
    (panel) => {
      clickCardMenuItem(panel.card('First'), 'Archive');
    },
  ],
  [
    'the inspector Delete task',
    (panel) => {
      clickInspectorAction(sidebarInspector(panel), 'Delete task');
    },
  ],
  [
    'the inspector Archive',
    (panel) => {
      clickInspectorAction(sidebarInspector(panel), 'Archive');
    },
  ],
];

describe('PanelView own task removals', () => {
  const deletingFixture = (recurrence = false): string => {
    const due = recurrence ? '2031-02-10' : window.moment().format('YYYY-MM-DD');
    return `- [ ] First${recurrence ? ' 🔁 every day' : ''} 🏁 delete 📅 ${due}\n  - [ ] Child\n- [ ] Sentinel 📅 ${window.moment().format('YYYY-MM-DD')}\n`;
  };
  const wrappedTasks = (panel: RemovalPanel): TaskApplicationApi =>
    (
      panel.view as unknown as { createSelectionTasks_abyssPrivate(): TaskApplicationApi }
    ).createSelectionTasks_abyssPrivate();

  it.each([false, true])(
    'Delete completion empties the inspector with index held=%s',
    async (hold) => {
      const source = deletingFixture();
      const panel = await openRemovalPanel({ 'today.md': source });
      const expected = source.split('\n').slice(2).join('\n');
      let release: (() => void) | undefined;
      try {
        panel.select('First');
        panel.selections.length = 0;
        if (hold) release = panel.holdIndexEvents();
        expectDefined(
          sidebarInspector(panel).querySelector<HTMLElement>(
            '.abyss-right-header .abyss-status-marker',
          ),
        ).click();
        await settleRemoval();
        expect(await panel.read()).toBe(expected);
        expect(panel.state.get('taskStack')).toEqual([]);
        release?.();
        release = undefined;
        await settleRemoval();
        expect(panel.state.get('taskStack')).toEqual([]);
        expect(panel.selections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(sidebarInspector(panel).querySelector('.abyss-right-title')).toBeNull();
        expect(sidebarInspector(panel).querySelector('.abyss-right-header-actions')).toBeNull();
        expect(panel.view.contentEl.querySelector('.abyss-task-delete-btn')).toBeNull();
      } finally {
        release?.();
        await panel.close();
      }
    },
  );

  it.each(['set-status', 'toggle-completion'] as const)(
    'uses configured non-x Done for %s removal',
    async (type) => {
      const source = deletingFixture();
      const panel = await openRemovalPanel({ 'today.md': source }, (settings) => {
        const done = expectDefined(
          settings.taskStatuses.find((rule) => rule.type === 'done' && rule.core),
        );
        done.symbol = '!';
      });
      try {
        panel.select('First');
        const first = expectDefined(
          panel.application.index.list().find((t) => t.title === 'First'),
        );
        const result = await wrappedTasks(panel).execute(
          type === 'set-status'
            ? { type, target: { type: 'task', ref: first.ref }, symbol: '!' }
            : { type, target: { type: 'task', ref: first.ref } },
        );
        await settleRemoval();
        expect(result.type).toBe('ok');
        expect(await panel.read()).toBe(source.split('\n').slice(2).join('\n'));
        expect(panel.state.get('taskStack')).toEqual([]);
      } finally {
        await panel.close();
      }
    },
  );

  it('keeps the valid daily Delete recurrence active root and child selected', async () => {
    const source = deletingFixture(true);
    const panel = await openRemovalPanel({ 'today.md': source });
    try {
      panel.state.set('selectedList', 'inbox');
      panel.select('First');
      const first = expectDefined(panel.application.index.list().find((t) => t.title === 'First'));
      const result = await wrappedTasks(panel).execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: first.ref },
      });
      await settleRemoval();
      const created = window.moment().format('YYYY-MM-DD');
      expect(await panel.read()).toBe(
        `- [ ] First 🔁 every day 🏁 delete ➕ ${created} 📅 2031-02-11\n  - [ ] Child ➕ ${created}\n- [ ] Sentinel 📅 ${created}\n`,
      );
      expect(result.type).toBe('ok');
      const successor = expectDefined(
        panel.application.index.list().find((t) => t.title === 'First'),
      );
      expect(panel.state.get('taskStack')).toEqual([successor]);
      expect(successor.subtasks[0]?.ref.parent).toEqual({ type: 'task', ref: successor.ref });
      expect(sidebarInspector(panel).querySelector('.abyss-right-title-view')?.textContent).toBe(
        'First',
      );
    } finally {
      await panel.close();
    }
  });

  it.each(['child', 'non-Done', 'already-Done', 'unproven'] as const)(
    'does not hold %s status command as root removal',
    async (kind) => {
      const source = deletingFixture().replace(
        '- [ ] First',
        kind === 'already-Done' ? '- [x] First' : '- [ ] First',
      );
      const panel = await openRemovalPanel({ 'today.md': source });
      try {
        const first = expectDefined(
          panel.application.index.list().find((t) => t.title === 'First'),
        );
        const hold = vi.spyOn(panel.state, 'beginTaskRemoval');
        vi.spyOn(panel.application.tasks, 'execute').mockResolvedValueOnce({
          type: 'io-error',
          cause: 'repository-error',
          contentState: 'unchanged',
        });
        const command: TaskCommand = {
          type: 'set-status',
          target:
            kind === 'child'
              ? { type: 'subtask', ref: expectDefined(first.subtasks[0]).ref }
              : {
                  type: 'task',
                  ref: kind === 'unproven' ? { ...first.ref, revision: 'unproven' } : first.ref,
                },
          symbol: kind === 'non-Done' ? ' ' : 'x',
        };
        await wrappedTasks(panel).execute(command);
        expect(hold).not.toHaveBeenCalled();
        expect(await panel.read()).toBe(source);
      } finally {
        await panel.close();
      }
    },
  );

  it('does not clear another exact selected ref on a late deleted completion result', async () => {
    const panel = await openRemovalPanel({ 'today.md': deletingFixture() });
    try {
      panel.select('First');
      const first = expectDefined(panel.application.index.list().find((t) => t.title === 'First'));
      const gate = deferred<TaskCommandResult>();
      vi.spyOn(panel.application.tasks, 'execute').mockReturnValueOnce(gate.promise);
      const pending = wrappedTasks(panel).execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: first.ref },
      });
      panel.select('Sentinel');
      const selected = panel.state.get('taskStack');
      gate.resolve({ type: 'ok', changed: true, outcome: { type: 'deleted', ref: first.ref } });
      await pending;
      expect(panel.state.get('taskStack')).toEqual(selected);
      expect(sidebarInspector(panel).querySelector('.abyss-right-title-view')?.textContent).toBe(
        'Sentinel',
      );
    } finally {
      await panel.close();
    }
  });

  it.each(panelRemovals)(
    '%s empties the inspector when the index update lands first',
    async (_name, remove) => {
      const panel = await openRemovalPanel();
      try {
        panel.select('First');
        panel.selections.length = 0;

        remove(panel);
        await settleRemoval();

        expect(await panel.read()).not.toContain('First');
        expect(panel.state.get('taskStack').map((node) => node.title)).toEqual([]);
        expect(panel.selections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(panel.view.contentEl.querySelector('.abyss-task-delete-btn')).toBeNull();
        expect(panel.view.contentEl.querySelector('.abyss-right .abyss-right-title')).toBeNull();
      } finally {
        await panel.close();
      }
    },
  );

  it.each(panelRemovals)(
    '%s empties the inspector when the index update lands after the command',
    async (_name, remove) => {
      const panel = await openRemovalPanel();
      try {
        panel.select('First');
        panel.selections.length = 0;
        const release = panel.holdIndexEvents();

        remove(panel);
        await settleRemoval();
        expect(await panel.read()).not.toContain('First');
        release();
        await settleRemoval();

        expect(panel.state.get('taskStack').map((node) => node.title)).toEqual([]);
        expect(panel.selections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(panel.view.contentEl.querySelector('.abyss-task-delete-btn')).toBeNull();
      } finally {
        await panel.close();
      }
    },
  );

  it.each(['Delete task', 'Archive'] as const)(
    'the task modal %s closes the modal and empties the panel when the index update lands first',
    async (label) => {
      const panel = await openRemovalPanel();
      try {
        panel.select('First');
        const first = expectDefined(
          panel.application.index.list().find((candidate) => candidate.title === 'First'),
        );
        const modal = (panel.view as unknown as RemovalModalInternals).center_abyssPrivate
          .taskModal_abyssPrivate;
        modal.open(first);
        const modalSelections: string[][] = [];
        expectDefined(modal.innerState_abyssPrivate).on('taskStack', (stack) => {
          modalSelections.push(stack.map((node) => node.title));
        });
        panel.selections.length = 0;

        clickInspectorAction(
          expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal')),
          label,
        );
        await settleRemoval();

        expect(await panel.read()).not.toContain('First');
        expect(activeDocument.querySelector('.abyss-modal-backdrop')).toBeNull();
        expect(modalSelections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(panel.state.get('taskStack').map((node) => node.title)).toEqual([]);
        expect(panel.selections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(panel.view.contentEl.querySelector('.abyss-task-delete-btn')).toBeNull();
      } finally {
        await panel.close();
      }
    },
  );

  it.each(['Delete task', 'Archive'] as const)(
    'the task modal %s never shows the next task when the index update lands after the command',
    async (label) => {
      const panel = await openRemovalPanel();
      try {
        const first = expectDefined(
          panel.application.index.list().find((candidate) => candidate.title === 'First'),
        );
        const modal = (panel.view as unknown as RemovalModalInternals).center_abyssPrivate
          .taskModal_abyssPrivate;
        modal.open(first);
        const modalSelections: string[][] = [];
        expectDefined(modal.innerState_abyssPrivate).on('taskStack', (stack) => {
          modalSelections.push(stack.map((node) => node.title));
        });
        const release = panel.holdIndexEvents();

        clickInspectorAction(
          expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal')),
          label,
        );
        await settleRemoval();
        expect(await panel.read()).not.toContain('First');
        release();
        await settleRemoval();

        expect(modalSelections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(activeDocument.querySelector('.abyss-modal .abyss-right-title')).toBeNull();
      } finally {
        await panel.close();
      }
    },
  );

  it('keeps following the selected task through an edit on the panel wrapper', async () => {
    const panel = await openRemovalPanel();
    try {
      panel.select('First');
      const first = expectDefined(
        panel.application.index.list().find((candidate) => candidate.title === 'First'),
      );
      const tasks = (
        panel.view as unknown as { createSelectionTasks_abyssPrivate(): TaskApplicationApi }
      ).createSelectionTasks_abyssPrivate();
      const order: string[] = [];
      panel.application.index.subscribe(() => order.push('index update'));

      const result = await tasks.execute({
        type: 'patch',
        target: { type: 'task', ref: first.ref },
        patch: { markdownTitle: { type: 'set', value: 'First edited' } },
      });
      order.push('command returned');
      await settleRemoval();

      expect(result.type).toBe('ok');
      expect(order.slice(0, 2)).toEqual(['index update', 'command returned']);
      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['First edited']);
      expect(cardsWithTheX(panel)).toEqual(['First edited']);
    } finally {
      await panel.close();
    }
  });

  it('keeps the selection when the delete fails, and still follows a later edit of the line', async () => {
    const panel = await openRemovalPanel();
    try {
      panel.select('First');
      vi.spyOn(panel.application.tasks, 'execute').mockResolvedValueOnce({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unchanged',
      });

      expectDefined(
        panel.card('First').querySelector<HTMLElement>('.abyss-task-delete-btn'),
      ).click();
      await settleRemoval();

      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['First']);
      const file = panel.app.vault.getAbstractFileByPath('today.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      await panel.app.vault.modify(file, (await panel.read()).replace('First', 'Edited'));
      await settleRemoval();

      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['Edited']);
    } finally {
      await panel.close();
    }
  });

  it('follows an edit of the selected line when no removal is pending', async () => {
    const panel = await openRemovalPanel();
    try {
      panel.select('First');
      const file = panel.app.vault.getAbstractFileByPath('today.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');

      await panel.app.vault.modify(
        file,
        (await panel.read()).replace('- [ ] First', '- [ ] Other'),
      );
      await settleRemoval();

      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['Other']);
    } finally {
      await panel.close();
    }
  });

  it('keeps the inspected task when the list deletes another task', async () => {
    const panel = await openRemovalPanel();
    try {
      panel.select('Second');

      clickCardMenuItem(panel.card('First'), 'Delete');
      await settleRemoval();

      expect(await panel.read()).not.toContain('First');
      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['Second']);
      expect(panel.card('Second').querySelector('.abyss-task-delete-btn')).not.toBeNull();
    } finally {
      await panel.close();
    }
  });

  it('keeps a selection begun while the delete runs', async () => {
    const panel = await openRemovalPanel();
    try {
      panel.select('First');
      const gate = deferred<undefined>();
      const execute = panel.application.tasks.execute.bind(panel.application.tasks);
      vi.spyOn(panel.application.tasks, 'execute').mockImplementation(async (command) => {
        await gate.promise;
        return execute(command);
      });

      expectDefined(
        panel.card('First').querySelector<HTMLElement>('.abyss-task-delete-btn'),
      ).click();
      panel.select('Third');
      gate.resolve(undefined);
      await settleRemoval();

      expect(await panel.read()).not.toContain('First');
      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['Third']);
      expect(panel.card('Third').querySelector('.abyss-task-delete-btn')).not.toBeNull();
    } finally {
      await panel.close();
    }
  });
});

const PROJECT_NOTE = '---\nstatus: wip\n---\n# Tasks\n';

function projectFiles(
  titles: readonly string[] = ['First', 'Second', 'Third'],
): Record<string, string> {
  return { 'today.md': todayNote(titles), 'Projects/P.md': PROJECT_NOTE };
}

const projectDrops: ReadonlyArray<readonly [string, (panel: RemovalPanel, title: string) => void]> =
  [
    [
      'onto the left panel project row',
      (panel, title) => {
        dispatchDnD(panel.card(title), 'dragstart');
        dispatchDnD(panel.projectRow('P'), 'drop');
      },
    ],
    [
      'of the project row onto the card',
      (panel, title) => {
        dispatchDnD(panel.projectRow('P'), 'dragstart');
        dispatchDnD(panel.card(title), 'drop');
        dispatchDnD(panel.projectRow('P'), 'dragend');
      },
    ],
  ];

function selectedCardTitles(panel: RemovalPanel): string[] {
  return [
    ...panel.view.contentEl.querySelectorAll<HTMLElement>('.abyss-task-card.is-selected'),
  ].map((card) => card.querySelector('.abyss-task-title')?.textContent ?? '');
}

function cardsWithTheX(panel: RemovalPanel): string[] {
  return [...panel.view.contentEl.querySelectorAll<HTMLElement>('.abyss-task-delete-btn')].map(
    (button) =>
      button.closest('.abyss-task-card')?.querySelector('.abyss-task-title')?.textContent ?? '',
  );
}

function selectedRoot(panel: RemovalPanel): { readonly title: string; readonly filePath: string } {
  const root = expectDefined(panel.state.get('taskStack')[0]);
  if (!('source' in root)) throw new Error('The selection has no root task');
  return { title: root.title, filePath: root.source.filePath };
}

describe('PanelView project moves of the inspected task', () => {
  it.each(projectDrops)(
    'a drop %s keeps the moved task in the inspector when the index update lands first',
    async (_name, drop) => {
      const panel = await openRemovalPanel(projectFiles());
      try {
        panel.select('First');
        panel.selections.length = 0;

        drop(panel, 'First');
        await settleRemoval();

        expect(await panel.read('Projects/P.md')).toContain('First');
        expect(await panel.read()).not.toContain('First');
        expect(selectedRoot(panel)).toEqual({ title: 'First', filePath: 'Projects/P.md' });
        expect(panel.selections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(selectedCardTitles(panel)).toEqual(['First']);
        expect(cardsWithTheX(panel)).toEqual(['First']);
      } finally {
        await panel.close();
      }
    },
  );

  it.each(projectDrops)(
    'a drop %s keeps the moved task in the inspector when the index update lands after the command',
    async (_name, drop) => {
      const panel = await openRemovalPanel(projectFiles());
      try {
        panel.select('First');
        panel.selections.length = 0;
        const release = panel.holdIndexEvents();

        drop(panel, 'First');
        await settleRemoval();
        expect(await panel.read('Projects/P.md')).toContain('First');
        release();
        await settleRemoval();

        expect(selectedRoot(panel)).toEqual({ title: 'First', filePath: 'Projects/P.md' });
        expect(panel.selections.flat().filter((title) => title !== 'First')).toEqual([]);
        expect(selectedCardTitles(panel)).toEqual(['First']);
        expect(cardsWithTheX(panel)).toEqual(['First']);
      } finally {
        await panel.close();
      }
    },
  );

  it.each([
    ['first', false],
    ['after the command', true],
  ] as const)(
    'keeps the inspected sub-task and a working Back through the move and a later write when the index update lands %s',
    async (_order, holdIndex) => {
      const today = window.moment().format('YYYY-MM-DD');
      const panel = await openRemovalPanel({
        'today.md': `\n- [ ] First 📅 ${today}\n  - [ ] Child\n- [ ] Second 📅 ${today}\n- [ ] Third 📅 ${today}\n`,
        'Projects/P.md': PROJECT_NOTE,
      });
      try {
        const nodes = panel.application.index.listNodes();
        const third = expectDefined(nodes.find(({ node }) => node.title === 'Third'));
        const child = expectDefined(nodes.find(({ node }) => node.title === 'Child'));
        panel.state.set('taskStack', [third.root]);
        panel.state.openInspectorDependency(child);
        expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['First', 'Child']);
        const release = holdIndex ? panel.holdIndexEvents() : undefined;

        expectDefined(projectDrops[0])[1](panel, 'First');
        await settleRemoval();
        release?.();
        await settleRemoval();

        expect(selectedRoot(panel)).toEqual({ title: 'First', filePath: 'Projects/P.md' });
        expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['First', 'Child']);
        // Third moved up two lines. After one more write to its note, Back still finds it.
        const file = panel.app.vault.getAbstractFileByPath('today.md');
        if (!(file instanceof TFile)) throw new Error('Missing fixture');
        await panel.app.vault.modify(
          file,
          (await panel.read()).replace('- [ ] Second', '- [x] Second'),
        );
        await settleRemoval();
        expectDefined(
          panel.view.contentEl.querySelector<HTMLElement>('[aria-label="Back to previous task"]'),
        ).click();

        expect(selectedRoot(panel)).toEqual({ title: 'Third', filePath: 'today.md' });
        expect(panel.state.get('inspectorBackStack')).toEqual([]);
      } finally {
        await panel.close();
      }
    },
  );

  it('keeps the selection on the source task when the move fails', async () => {
    const panel = await openRemovalPanel(projectFiles());
    try {
      panel.select('First');
      const first = selectedRoot(panel);
      vi.spyOn(panel.application.tasks, 'execute').mockResolvedValueOnce({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unchanged',
      });

      expectDefined(projectDrops[0])[1](panel, 'First');
      await settleRemoval();

      expect(selectedRoot(panel)).toEqual(first);
      expect(selectedCardTitles(panel)).toEqual(['First']);
    } finally {
      await panel.close();
    }
  });

  it('keeps the inspected task when another task moves', async () => {
    const panel = await openRemovalPanel(projectFiles());
    try {
      panel.select('Second');

      expectDefined(projectDrops[0])[1](panel, 'First');
      await settleRemoval();

      expect(await panel.read('Projects/P.md')).toContain('First');
      expect(selectedRoot(panel)).toEqual({ title: 'Second', filePath: 'today.md' });
      expect(cardsWithTheX(panel)).toEqual(['Second']);
    } finally {
      await panel.close();
    }
  });

  it('keeps a selection begun while the move runs', async () => {
    const panel = await openRemovalPanel(projectFiles());
    try {
      panel.select('First');
      const gate = deferred<undefined>();
      const execute = panel.application.tasks.execute.bind(panel.application.tasks);
      vi.spyOn(panel.application.tasks, 'execute').mockImplementation(async (command) => {
        await gate.promise;
        return execute(command);
      });

      expectDefined(projectDrops[0])[1](panel, 'First');
      panel.select('Third');
      gate.resolve(undefined);
      await settleRemoval();

      expect(await panel.read('Projects/P.md')).toContain('First');
      expect(selectedRoot(panel)).toEqual({ title: 'Third', filePath: 'today.md' });
      expect(cardsWithTheX(panel)).toEqual(['Third']);
    } finally {
      await panel.close();
    }
  });
});

function compactLayout(
  panel: RemovalPanel,
  width = 390,
): { readonly right: HTMLElement; readonly details: HTMLButtonElement } {
  const layout = expectDefined(panel.view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
  setGeometry(layout, rect(0, 0, width, 480));
  window.dispatchEvent(new Event('resize'));
  return {
    right: expectDefined(layout.querySelector<HTMLElement>('.abyss-right')),
    details: expectDefined(
      layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
    ),
  };
}

function openTrackedTask(panel: RemovalPanel, title: string): void {
  const tracked = expectDefined(
    panel.application.index.list().find((candidate) => candidate.title === title),
  );
  (
    panel.view as unknown as { openTrackedTask_abyssPrivate(target: TaskNodeRef): void }
  ).openTrackedTask_abyssPrivate({ type: 'task', ref: tracked.ref });
}

async function editToday(panel: RemovalPanel, edit: (content: string) => string): Promise<void> {
  const file = panel.app.vault.getAbstractFileByPath('today.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  await panel.app.vault.modify(file, edit(await panel.read()));
  await settleRemoval();
}

describe('PanelView compact details on a begun selection', () => {
  it('closes automatic details outside the layout but preserves explicitly opened details', async () => {
    const panel = await openRemovalPanel();
    const outside = activeDocument.body.createEl('button');
    const pointer = (target: HTMLElement): void => {
      target.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    };
    try {
      const { right, details } = compactLayout(panel);
      panel.select('First');
      pointer(outside);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      details.click();
      pointer(outside);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      // A repeated selection goes through the real automatic-open caller.
      openTrackedTask(panel, 'First');
      pointer(outside);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      pointer(right);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      pointer(panel.card('Second'));
      expect(right.classList.contains('is-compact-open')).toBe(false);
      panel.select('Second');
      pointer(outside);
      expect(right.classList.contains('is-compact-open')).toBe(false);
    } finally {
      outside.remove();
      await panel.close();
    }
  });

  it.each(['escape', 'selection', 'mode', 'resize', 'button'] as const)(
    'clears explicit details intent after closing through %s',
    async (close) => {
      const panel = await openRemovalPanel();
      const outside = activeDocument.body.createEl('button');
      try {
        const { right, details } = compactLayout(panel);
        panel.select('First');
        details.click();
        details.click();
        const layout = expectDefined(
          panel.view.contentEl.querySelector<HTMLElement>('.abyss-layout'),
        );
        if (close === 'escape')
          right.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          );
        if (close === 'selection') panel.state.set('taskStack', []);
        if (close === 'mode') panel.state.set('mode', 'calendar');
        if (close === 'resize') {
          setGeometry(layout, rect(0, 0, 1200, 480));
          window.dispatchEvent(new Event('resize'));
        }
        if (close === 'button') details.click();
        expect(right.classList.contains('is-compact-open')).toBe(false);
        if (close === 'mode') panel.state.set('mode', 'tasks');
        if (close === 'resize') compactLayout(panel);
        panel.select('First');
        expect(right.classList.contains('is-compact-open')).toBe(true);
        outside.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
        expect(right.classList.contains('is-compact-open')).toBe(false);
      } finally {
        outside.remove();
        await panel.close();
      }
    },
  );

  it('keeps explicit left-pane outside dismissal unchanged', async () => {
    const panel = await openRemovalPanel();
    const outside = activeDocument.body.createEl('button');
    try {
      compactLayout(panel);
      const left = expectDefined(panel.view.contentEl.querySelector<HTMLElement>('.abyss-left'));
      expectDefined(
        panel.view.contentEl.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--left'),
      ).click();
      expect(left.classList.contains('is-compact-open')).toBe(true);
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(left.classList.contains('is-compact-open')).toBe(false);
    } finally {
      outside.remove();
      await panel.close();
    }
  });

  it('reopens the hidden details when the selected card is tapped again', async () => {
    const panel = await openRemovalPanel();
    try {
      const { right, details } = compactLayout(panel);
      panel.select('First');
      expect(right.classList.contains('is-compact-open')).toBe(true);
      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(false);

      panel.select('First');

      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(details.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await panel.close();
    }
  });

  it('reopens the hidden details for a tracked task that is already selected', async () => {
    const panel = await openRemovalPanel();
    try {
      const { right, details } = compactLayout(panel);
      panel.select('First');
      details.click();

      openTrackedTask(panel, 'First');

      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['First']);
      expect(right.classList.contains('is-compact-open')).toBe(true);
    } finally {
      await panel.close();
    }
  });

  it('keeps the details hidden when an edit above moves the selected line', async () => {
    const panel = await openRemovalPanel();
    try {
      const { right, details } = compactLayout(panel);
      panel.select('Second');
      details.click();

      await editToday(panel, (content) => `- [ ] Above\n${content}`);

      expect(selectedRoot(panel)).toEqual({ title: 'Second', filePath: 'today.md' });
      expect(right.classList.contains('is-compact-open')).toBe(false);
    } finally {
      await panel.close();
    }
  });

  it('keeps the details hidden when the selected line is refreshed in place', async () => {
    const panel = await openRemovalPanel();
    try {
      const { right, details } = compactLayout(panel);
      panel.select('First');
      details.click();

      await editToday(panel, (content) => content.replace('- [ ] First', '- [ ] Edited'));

      expect(selectedRoot(panel)).toEqual({ title: 'Edited', filePath: 'today.md' });
      expect(right.classList.contains('is-compact-open')).toBe(false);
    } finally {
      await panel.close();
    }
  });

  it('opens the details for a tracked task that is not selected yet', async () => {
    const panel = await openRemovalPanel();
    try {
      const { right } = compactLayout(panel);

      openTrackedTask(panel, 'Second');

      expect(panel.state.get('taskStack').map((node) => node.title)).toEqual(['Second']);
      expect(right.classList.contains('is-compact-open')).toBe(true);
    } finally {
      await panel.close();
    }
  });

  it('keeps the details hidden when the hidden selection moves to a project', async () => {
    const panel = await openRemovalPanel(projectFiles());
    try {
      const { right, details } = compactLayout(panel, 700);
      panel.select('First');
      details.click();

      expectDefined(projectDrops[0])[1](panel, 'First');
      await settleRemoval();

      expect(selectedRoot(panel)).toEqual({ title: 'First', filePath: 'Projects/P.md' });
      expect(right.classList.contains('is-compact-open')).toBe(false);
    } finally {
      await panel.close();
    }
  });
});

describe('PanelView', () => {
  // jsdom has no `scrollIntoView`, and creation feedback scrolls a created card into view.
  let scrollIntoView: Mock<HTMLElement['scrollIntoView']>;

  beforeEach(() => {
    scrollIntoView = vi.fn<HTMLElement['scrollIntoView']>();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  describe('empty vault suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;
    let tagManager: TagManager;
    let settings: CalendarSettings;
    let notifyWindowMigration: (owner: Window) => void;
    let unsubscribeWindowMigration: () => void;

    beforeEach(async () => {
      app = await createAppWithFiles({});
      settings = structuredClone(DEFAULT_SETTINGS);
      taskApplication = configuredTaskApplication(app, settings);
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      tagManager = makeTagManager(app, settings);
      view = new PanelView(
        leaf,
        settings,
        tagManager,
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      vi.spyOn(app.workspace, 'getActiveViewOfType').mockImplementation((type) =>
        type === PanelView && workspaceState(app).activeLeaf === leaf ? view : null,
      );
      // test-mocks leaves the documented host migration subscription as a no-op.
      notifyWindowMigration = () => undefined;
      unsubscribeWindowMigration = vi.fn();
      vi.spyOn(view.contentEl, 'onWindowMigrated').mockImplementation((listener) => {
        notifyWindowMigration = listener;
        return unsubscribeWindowMigration;
      });
      await view.onOpen();
      setGeometry(view.containerEl, rect(20, 20, 640, 480));
      setGeometry(view.contentEl, rect(20, 20, 640, 480));
    });

    afterEach(async () => {
      await view.onClose();
      view.containerEl.remove();
      workspaceState(app).activeLeaf = null;
      taskApplication.index.destroy();
    });

    it('adds abyss-panel-view class to contentEl', () => {
      expect(view.contentEl.classList.contains('abyss-panel-view')).toBe(true);
    });

    it('creates abyss-layout with 4 zones', () => {
      const layout = view.contentEl.querySelector('.abyss-layout');
      expect(layout).not.toBeNull();
      expect(layout?.querySelector('.abyss-rail')).not.toBeNull();
      expect(layout?.querySelector('.abyss-left')).not.toBeNull();
      expect(layout?.querySelector('.abyss-center')).not.toBeNull();
      expect(layout?.querySelector('.abyss-right')).not.toBeNull();
    });

    it('says so when a tracked task is no longer in its note', () => {
      const internals = view as unknown as {
        openTrackedTask_abyssPrivate(target: TaskNodeRef): void;
        panelNavigation_abyssPrivate: { openTasks(): void };
      };
      const openTasks = vi.spyOn(internals.panelNavigation_abyssPrivate, 'openTasks');
      let noticeMessage: unknown;
      const notice = vi.spyOn(
        Notice.prototype as unknown as {
          constructor__(message: string | DocumentFragment, duration?: number): void;
        },
        'constructor__',
      );
      notice.mockImplementation((message) => {
        noticeMessage = message;
      });
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      internals.openTrackedTask_abyssPrivate({
        type: 'task',
        ref: { filePath: 'gone.md', line: 4, revision: '1' },
      });

      expect(notice).toHaveBeenCalledOnce();
      expect(noticeMessage).toBe('That tracked task is no longer in its note');
      // A click that reaches nothing leaves the reader in the mode they were in.
      expect(openTasks).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '[abyss-tasks] The tracked task is no longer in its note',
        '["gone.md",4,[]]',
      );
    });

    it('owns one stable out-of-flow creation feedback host inside the layout', () => {
      const layout = view.contentEl.querySelector('.abyss-layout');
      const feedback = layout?.querySelector('.abyss-creation-feedback');

      expect(feedback).not.toBeNull();
      expect(feedback?.getAttribute('role')).toBe('status');
      expect(feedback?.getAttribute('aria-live')).toBe('polite');
      expect(feedback?.getAttribute('aria-atomic')).toBe('true');
      expect(layout?.querySelectorAll('.abyss-creation-feedback')).toHaveLength(1);
    });

    it('owns one stable Quick Capture host in the center shell across every mode rerender', () => {
      const layout = expectDefined(view.contentEl.querySelector('.abyss-layout'));
      const host = layout.querySelector('.abyss-quick-capture-host');
      const shell = layout.querySelector('.abyss-center-shell');
      const center = layout.querySelector('.abyss-center');

      expect(host).not.toBeNull();
      expect(shell).not.toBeNull();
      expect(center).not.toBeNull();
      expect(layout.querySelectorAll('.abyss-quick-capture-host')).toHaveLength(1);
      expect(host?.parentElement).toBe(shell);
      expect(center?.parentElement).toBe(shell);
      expect(host?.closest('.abyss-center-shell')).toBe(shell);
      expect(host?.closest('.abyss-rail, .abyss-left, .abyss-right')).toBeNull();

      const internals = view as unknown as { panelNavigation_abyssPrivate: PanelNavigator };
      internals.panelNavigation_abyssPrivate.openCalendar();
      internals.panelNavigation_abyssPrivate.openSearch();
      internals.panelNavigation_abyssPrivate.openProjects();
      internals.panelNavigation_abyssPrivate.openTasks();

      expect(layout.querySelector('.abyss-quick-capture-host')).toBe(host);
      expect(layout.querySelector('.abyss-center-shell')).toBe(shell);
      expect(layout.querySelector('.abyss-center')).toBe(center);
      expect(host?.parentElement).toBe(shell);
    });

    it('keeps collapsed Tasks panes reachable through keyboard-native compact controls', () => {
      activeDocument.body.appendChild(view.containerEl);
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const left = expectDefined(layout.querySelector<HTMLElement>('.abyss-left'));
      const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
      const lists = expectDefined(
        layout.querySelector<HTMLButtonElement>('[aria-label="Show task lists"]'),
      );
      const details = expectDefined(
        layout.querySelector<HTMLButtonElement>('[aria-label="Show task details"]'),
      );

      expect(lists.tagName).toBe('BUTTON');
      expect(details.tagName).toBe('BUTTON');
      expect(lists.getAttribute('aria-controls')).toBe(left.id);
      expect(details.getAttribute('aria-controls')).toBe(right.id);
      expect(lists.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-expanded')).toBe('false');
      const header = expectDefined(layout.querySelector<HTMLElement>('.abyss-center-header'));
      const title = expectDefined(header.querySelector<HTMLElement>('.abyss-center-title'));
      const controls = expectDefined(header.querySelector<HTMLElement>('.abyss-center-controls'));
      expect(lists.closest('.abyss-center-header')).toBe(header);
      expect(details.closest('.abyss-center-header')).toBe(header);
      expect(title.parentElement).toBe(header);
      expect(controls.firstElementChild).toBe(lists);
      expect(controls.lastElementChild).toBe(details);

      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });
      expect(layout.querySelector('[aria-label="Show task lists"]')).toBe(lists);
      expect(layout.querySelector('[aria-label="Show task details"]')).toBe(details);

      setGeometry(layout, rect(0, 0, 1200, 480));
      window.dispatchEvent(new Event('resize'));
      details.focus();
      internals.state_abyssPrivate.set('taskStack', [task()]);
      const desktopEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(desktopEscape);
      expect(desktopEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(activeDocument.activeElement).toBe(details);

      internals.state_abyssPrivate.set('taskStack', []);
      setGeometry(layout, rect(0, 0, 390, 480));
      window.dispatchEvent(new Event('resize'));

      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(true);
      expect(lists.getAttribute('aria-expanded')).toBe('true');
      expect(lists.getAttribute('aria-label')).toBe('Hide task lists');
      expect(activeDocument.activeElement).toBe(left);

      details.click();
      expect(left.classList.contains('is-compact-open')).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(lists.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-expanded')).toBe('true');
      expect(lists.getAttribute('aria-label')).toBe('Show task lists');
      expect(details.getAttribute('aria-label')).toBe('Hide task details');
      expect(activeDocument.activeElement).toBe(right);

      const composingEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      activeDocument.dispatchEvent(composingEscape);
      expect(composingEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);

      const legacyComposingEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(legacyComposingEscape, 'keyCode', { value: 229 });
      activeDocument.dispatchEvent(legacyComposingEscape);
      expect(legacyComposingEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);

      const nativeMenu = activeDocument.body.createDiv({ cls: 'menu' });
      setGeometry(nativeMenu, rect(20, 20, 180, 80));
      const nativeEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(nativeEscape);
      expect(nativeEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      nativeMenu.remove();

      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(details.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-label')).toBe('Show task details');
      expect(activeDocument.activeElement).toBe(details);

      internals.state_abyssPrivate.set('taskStack', [task()]);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(details.getAttribute('aria-expanded')).toBe('true');

      internals.panelNavigation_abyssPrivate.openCalendar();
      expect(left.classList.contains('is-compact-open')).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(lists.getAttribute('aria-expanded')).toBe('false');
      expect(details.getAttribute('aria-expanded')).toBe('false');
      expect(layout.contains(lists)).toBe(false);
      expect(layout.contains(details)).toBe(false);

      setTaskStack(internals.state_abyssPrivate, []);
      setTaskStack(internals.state_abyssPrivate, [task()]);
      const calendarEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(calendarEscape);
      expect(calendarEscape.defaultPrevented).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);

      internals.panelNavigation_abyssPrivate.openTasks();
      const refreshedHeader = expectDefined(
        layout.querySelector<HTMLElement>('.abyss-center-header'),
      );
      expect(lists.closest('.abyss-center-header')).toBe(refreshedHeader);
      expect(details.closest('.abyss-center-header')).toBe(refreshedHeader);
    });

    it('lets one Escape cancel the compact inline add and a second close the pane', async () => {
      activeDocument.body.appendChild(view.containerEl);
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const left = expectDefined(layout.querySelector<HTMLElement>('.abyss-left'));
      const lists = expectDefined(
        layout.querySelector<HTMLButtonElement>('[aria-label="Show task lists"]'),
      );
      setGeometry(layout, rect(0, 0, 390, 480));
      window.dispatchEvent(new Event('resize'));
      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(true);
      expectDefined(
        left.querySelector<HTMLElement>('.abyss-left-section--tags .abyss-left-add'),
      ).click();
      await flushMicrotasks();
      const input = expectDefined(left.querySelector<HTMLInputElement>('.abyss-left-add-input'));
      expect(activeDocument.activeElement).toBe(input);

      const first = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(first);

      expect(first.defaultPrevented).toBe(true);
      expect(left.classList.contains('is-compact-open')).toBe(true);
      expect(activeDocument.activeElement).toBe(left);

      const second = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      left.dispatchEvent(second);

      expect(second.defaultPrevented).toBe(true);
      expect(left.classList.contains('is-compact-open')).toBe(false);
    });

    it.each(['resolving', 'open'] as const)(
      'does not destroy a %s Quick Capture generation when a compact pane is requested',
      (phase) => {
        const internals = view as unknown as { quickCapture_abyssPrivate: QuickCaptureCoordinator };
        const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
        const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
        const details = expectDefined(
          layout.querySelector<HTMLButtonElement>('[aria-label="Show task details"]'),
        );
        setGeometry(layout, rect(0, 0, 390, 480));
        window.dispatchEvent(new Event('resize'));
        const close = vi.spyOn(internals.quickCapture_abyssPrivate, 'close');
        vi.spyOn(internals.quickCapture_abyssPrivate, 'phase', 'get').mockReturnValue(phase);

        details.click();

        expect(close).not.toHaveBeenCalled();
        expect(right.classList.contains('is-compact-open')).toBe(false);
        expect(details.getAttribute('aria-expanded')).toBe('false');
      },
    );

    it('retains width availability for empty selection across mode/header changes and clears reset refs', () => {
      activeDocument.body.appendChild(view.containerEl);
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        compactPaneAccess_abyssPrivate: CompactPaneAccess;
      };
      internals.state_abyssPrivate.set('taskStack', []);
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
      const lists = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--left'),
      );
      const details = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
      );
      const resizeTo = (width: number): void => {
        setGeometry(layout, rect(0, 0, width, 480));
        window.dispatchEvent(new Event('resize'));
      };
      const focused = activeDocument.activeElement;
      resizeTo(929);
      expect(details.classList.contains('is-compact-available')).toBe(false);
      resizeTo(928);
      expect(details.classList.contains('is-compact-available')).toBe(true);
      expect(lists.classList.contains('is-compact-available')).toBe(false);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(activeDocument.activeElement).toBe(focused);
      resizeTo(608);
      expect(lists.classList.contains('is-compact-available')).toBe(true);
      details.click();
      internals.state_abyssPrivate.set('mode', 'calendar');
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(details.classList.contains('is-compact-available')).toBe(true);
      expect(lists.classList.contains('is-compact-available')).toBe(true);
      internals.state_abyssPrivate.set('mode', 'tasks');
      expect(right.classList.contains('is-compact-open')).toBe(false);
      const header = activeDocument.body.createDiv();
      const controls = header.createDiv();
      layout.appendChild(header);
      internals.compactPaneAccess_abyssPrivate.attachHeader(header, controls);
      expect(controls.contains(details)).toBe(true);
      expect(details.classList.contains('is-compact-available')).toBe(true);
      expect(lists.classList.contains('is-compact-available')).toBe(true);
      resizeTo(609);
      expect(lists.classList.contains('is-compact-available')).toBe(false);
      resizeTo(929);
      expect(details.classList.contains('is-compact-available')).toBe(false);
      resizeTo(608);
      internals.compactPaneAccess_abyssPrivate.reset();
      expect(lists.classList.contains('is-compact-available')).toBe(false);
      expect(details.classList.contains('is-compact-available')).toBe(false);
      expect(internals.state_abyssPrivate.get('taskStack')).toEqual([]);
    });

    it('reconciles compact-pane ownership at the exact 58rem and 38rem boundaries', () => {
      activeDocument.body.appendChild(view.containerEl);
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const left = expectDefined(layout.querySelector<HTMLElement>('.abyss-left'));
      const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
      const lists = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--left'),
      );
      const details = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
      );
      const resizeTo = (width: number): void => {
        setGeometry(layout, rect(0, 0, width, 480));
        window.dispatchEvent(new Event('resize'));
      };

      resizeTo(929);
      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(false);

      resizeTo(928);
      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(true);
      details.click();
      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(false);

      resizeTo(608);
      lists.click();
      expect(left.classList.contains('is-compact-open')).toBe(true);
      resizeTo(609);
      expect(left.classList.contains('is-compact-open')).toBe(false);
      expect(lists.getAttribute('aria-expanded')).toBe('false');

      details.click();
      expect(right.classList.contains('is-compact-open')).toBe(true);
      resizeTo(929);
      expect(right.classList.contains('is-compact-open')).toBe(false);
      expect(details.getAttribute('aria-expanded')).toBe('false');
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      activeDocument.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    });

    it('reconciles rem-based pane ownership on css-change without a width change', () => {
      activeDocument.body.appendChild(view.containerEl);
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
      const details = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
      );
      const root = activeDocument.documentElement;
      const ownerWindow = expectDefined(activeDocument.defaultView);
      const getComputedStyle = ownerWindow.getComputedStyle.bind(ownerWindow);
      let fontSize = '16px';
      const styleSpy = vi
        .spyOn(ownerWindow, 'getComputedStyle')
        .mockImplementation((element, pseudoElement) => {
          const style = getComputedStyle(element, pseudoElement);
          return element === root ? computedStyleWithFontSize(style, fontSize) : style;
        });
      setGeometry(layout, rect(0, 0, 950, 480));

      try {
        window.dispatchEvent(new Event('resize'));
        details.click();
        expect(right.classList.contains('is-compact-open')).toBe(false);

        fontSize = '17px';
        app.workspace.trigger('css-change');
        details.click();
        expect(right.classList.contains('is-compact-open')).toBe(true);

        fontSize = '16px';
        app.workspace.trigger('css-change');
        expect(right.classList.contains('is-compact-open')).toBe(false);
        expect(details.getAttribute('aria-expanded')).toBe('false');
      } finally {
        styleSpy.mockRestore();
        app.workspace.trigger('css-change');
      }
    });

    it.each(['left control', 'right control', 'task selection'] as const)(
      'preserves an exact pending-blur failure through a compact %s conflict',
      async (trigger) => {
        activeDocument.body.appendChild(view.containerEl);
        const internals = view as unknown as {
          state_abyssPrivate: AppState;
          quickCapture_abyssPrivate: QuickCaptureCoordinator;
          creationPresentation_abyssPrivate: CreationPresentationController;
          interactionRegistry_abyssPrivate: InteractionRegistry<string>;
        };
        const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
        const left = expectDefined(layout.querySelector<HTMLElement>('.abyss-left'));
        const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
        const leftButton = expectDefined(
          layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--left'),
        );
        const rightButton = expectDefined(
          layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
        );
        setGeometry(layout, rect(0, 0, 390, 480));
        window.dispatchEvent(new Event('resize'));

        const pending = deferred<TaskCommandResult>();
        const execute = vi.fn(() => pending.promise);
        const options = (
          internals.quickCapture_abyssPrivate as unknown as {
            options: { resolveTarget: () => Promise<CaptureTarget> };
          }
        ).options;
        options.resolveTarget = async () => panelCaptureTarget(execute);
        const present = vi
          .spyOn(internals.creationPresentation_abyssPrivate, 'present')
          .mockImplementation(() => undefined);

        internals.quickCapture_abyssPrivate.openOrFocus();
        await flushMicrotasks(0);
        const input = expectDefined(
          layout.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
        );
        input.value = '  exact failed draft  ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        let conflictTarget: HTMLElement = layout;
        if (trigger === 'left control') conflictTarget = leftButton;
        if (trigger === 'right control') conflictTarget = rightButton;
        conflictTarget.dispatchEvent(
          new Event('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        );
        if (trigger === 'task selection') internals.state_abyssPrivate.set('taskStack', [task()]);
        else conflictTarget.click();

        expect(execute).toHaveBeenCalledOnce();
        expect(internals.quickCapture_abyssPrivate.phase).toBe('open');
        expect(input.readOnly).toBe(true);
        expect(left.classList.contains('is-compact-open')).toBe(false);
        expect(right.classList.contains('is-compact-open')).toBe(false);

        const failure: TaskCommandResult = {
          type: 'invalid',
          issues: [{ code: 'invalid-title', field: 'title' }],
        };
        pending.resolve(failure);
        await flushMicrotasks(0);

        expect(internals.quickCapture_abyssPrivate.phase).toBe('open');
        expect(input.value).toBe('  exact failed draft  ');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(layout.querySelector('.abyss-capture-error')?.textContent).toBe(
          'The new task is invalid and was not created.',
        );
        expect(present).toHaveBeenCalledOnce();
        expect(present).toHaveBeenCalledWith(failure, expect.objectContaining({ kind: 'error' }));
        expect(internals.interactionRegistry_abyssPrivate.allows('openCalendar')).toBe(false);

        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(internals.quickCapture_abyssPrivate.phase).toBe('closed');
        expect(internals.interactionRegistry_abyssPrivate.allows('openCalendar')).toBe(true);
      },
    );

    it('delivers a pending-blur success before allowing the requested compact pane', async () => {
      activeDocument.body.appendChild(view.containerEl);
      const internals = view as unknown as {
        quickCapture_abyssPrivate: QuickCaptureCoordinator;
        creationPresentation_abyssPrivate: CreationPresentationController;
        interactionRegistry_abyssPrivate: InteractionRegistry<string>;
      };
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
      const details = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
      );
      setGeometry(layout, rect(0, 0, 390, 480));
      window.dispatchEvent(new Event('resize'));

      const pending = deferred<TaskCommandResult>();
      const execute = vi.fn(() => pending.promise);
      const options = (
        internals.quickCapture_abyssPrivate as unknown as {
          options: { resolveTarget: () => Promise<CaptureTarget> };
        }
      ).options;
      options.resolveTarget = async () => panelCaptureTarget(execute);
      const present = vi
        .spyOn(internals.creationPresentation_abyssPrivate, 'present')
        .mockImplementation(() => undefined);

      internals.quickCapture_abyssPrivate.openOrFocus();
      await flushMicrotasks(0);
      const input = expectDefined(
        layout.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      input.value = 'captured once';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      details.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true, composed: true }),
      );
      details.click();
      expect(execute).toHaveBeenCalledOnce();
      expect(right.classList.contains('is-compact-open')).toBe(false);

      const result = successfulCaptureResult();
      pending.resolve(result);
      await flushMicrotasks(0);

      expect(internals.quickCapture_abyssPrivate.phase).toBe('closed');
      expect(layout.querySelector('.abyss-quick-capture-input')).toBeNull();
      expect(present).toHaveBeenCalledOnce();
      expect(present).toHaveBeenCalledWith(result, expect.objectContaining({ kind: 'success' }));
      expect(internals.interactionRegistry_abyssPrivate.allows('openCalendar')).toBe(true);
      expect(right.classList.contains('is-compact-open')).toBe(true);
      const outside = activeDocument.body.createEl('button');
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(right.classList.contains('is-compact-open')).toBe(true);
      outside.remove();
    });

    it('opens the requested compact pane after a capture whose presentation fails', async () => {
      activeDocument.body.appendChild(view.containerEl);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const internals = view as unknown as {
        quickCapture_abyssPrivate: QuickCaptureCoordinator;
        creationPresentation_abyssPrivate: CreationPresentationController;
        compactPaneAccess_abyssPrivate: CompactPaneAccess;
      };
      const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
      const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
      const details = expectDefined(
        layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--right'),
      );
      setGeometry(layout, rect(0, 0, 390, 480));
      window.dispatchEvent(new Event('resize'));
      const pending = deferred<TaskCommandResult>();
      const execute = vi.fn(() => pending.promise);
      const options = (
        internals.quickCapture_abyssPrivate as unknown as {
          options: { resolveTarget: () => Promise<CaptureTarget> };
        }
      ).options;
      options.resolveTarget = async () => panelCaptureTarget(execute);
      const takePending = vi.spyOn(internals.compactPaneAccess_abyssPrivate, 'takePending');
      const failure = new Error('presentation failed');
      vi.spyOn(internals.creationPresentation_abyssPrivate, 'present').mockImplementation(() => {
        throw failure;
      });

      internals.quickCapture_abyssPrivate.openOrFocus();
      await flushMicrotasks(0);
      const input = expectDefined(
        layout.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      input.value = 'captured once';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      details.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true, composed: true }),
      );
      details.click();
      expect(takePending).not.toHaveBeenCalled();
      expect(right.classList.contains('is-compact-open')).toBe(false);

      pending.resolve(successfulCaptureResult());
      await flushMicrotasks(0);

      expect(takePending).toHaveBeenCalledOnce();
      expect(takePending.mock.results[0]?.value).toEqual({
        pane: 'right',
        moveFocus: true,
        reason: 'button',
      });
      expect(internals.compactPaneAccess_abyssPrivate.takePending()).toBeUndefined();
      expect(internals.quickCapture_abyssPrivate.phase).toBe('closed');
      expect(right.classList.contains('is-compact-open')).toBe(true);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '[abyss-tasks] Could not show the capture result',
        failure,
      );
    });

    it('routes shortcuts only for its connected visible active leaf and detaches on close', async () => {
      const internals = view as unknown as { panelNavigation_abyssPrivate: PanelNavigator };
      const openQuickCapture = vi
        .spyOn(internals.panelNavigation_abyssPrivate, 'openQuickCapture')
        .mockImplementation(() => undefined);
      workspaceState(app).activeLeaf = leaf;

      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).not.toHaveBeenCalled();

      document.body.appendChild(view.containerEl);
      workspaceState(app).activeLeaf = null;
      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).not.toHaveBeenCalled();

      workspaceState(app).activeLeaf = leaf;
      view.containerEl.setCssProps({ display: 'none' });
      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).not.toHaveBeenCalled();

      view.containerEl.setCssProps({ display: '' });
      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'й',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).toHaveBeenCalledOnce();

      await view.onClose();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(openQuickCapture).toHaveBeenCalledOnce();
    });

    it('moves shortcut ownership with the same view and releases it on close', async () => {
      const internals = view as unknown as { panelNavigation_abyssPrivate: PanelNavigator };
      const openQuickCapture = vi
        .spyOn(internals.panelNavigation_abyssPrivate, 'openQuickCapture')
        .mockImplementation(() => undefined);
      document.body.append(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      const frame = document.body.createEl('iframe');
      const destination = expectDefined(frame.contentWindow) as EventWindow;
      const destroyRouter = vi.spyOn(PanelShortcutRouter.prototype, 'destroy');
      const destinationListeners = vi.spyOn(destination.document, 'addEventListener');
      const pressQ = (owner: EventWindow): KeyboardEvent => {
        const event = new owner.KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        });
        owner.document.body.dispatchEvent(event);
        return event;
      };
      try {
        expect(pressQ(window).defaultPrevented).toBe(true);
        expect(openQuickCapture).toHaveBeenCalledTimes(1);

        // Adopt the retained view's main-realm nodes, preserving Obsidian DOM helpers.
        destination.document.body.append(view.containerEl);
        notifyWindowMigration(destination);
        expect(view.contentEl.ownerDocument).toBe(destination.document);
        expect(pressQ(destination).defaultPrevented).toBe(true);
        expect(openQuickCapture).toHaveBeenCalledTimes(2);
        expect(pressQ(window).defaultPrevented).toBe(false);
        expect(openQuickCapture).toHaveBeenCalledTimes(2);

        notifyWindowMigration(destination);
        expect(pressQ(destination).defaultPrevented).toBe(true);
        expect(openQuickCapture).toHaveBeenCalledTimes(3);
        expect(destroyRouter).toHaveBeenCalledTimes(1);
        expect(destinationListeners.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(
          1,
        );
        const menu = document.body.createDiv({ cls: 'menu' });
        setGeometry(menu, rect(20, 20, 180, 80));
        destination.document.body.append(menu);
        expect(pressQ(destination).defaultPrevented).toBe(false);
        expect(openQuickCapture).toHaveBeenCalledTimes(3);
        menu.remove();

        document.body.append(view.containerEl);
        notifyWindowMigration(window);
        expect(pressQ(destination).defaultPrevented).toBe(false);
        expect(pressQ(window).defaultPrevented).toBe(true);
        expect(openQuickCapture).toHaveBeenCalledTimes(4);

        await view.onClose();
        await view.onClose();
        expect(unsubscribeWindowMigration).toHaveBeenCalledOnce();
        expect(destroyRouter).toHaveBeenCalledTimes(3);
        destination.document.body.append(view.containerEl);
        notifyWindowMigration(destination);
        expect(pressQ(destination).defaultPrevented).toBe(false);
        expect(pressQ(window).defaultPrevented).toBe(false);
        expect(openQuickCapture).toHaveBeenCalledTimes(4);
      } finally {
        document.body.append(view.containerEl);
        frame.remove();
      }
    });

    it('creates through Q after moving the same view and expires feedback in its new window', async () => {
      document.body.append(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        quickCapture_abyssPrivate: QuickCaptureCoordinator;
        creationPresentation_abyssPrivate: CreationPresentationController;
      };
      const retainedState = internals.state_abyssPrivate;
      const retainedCapture = internals.quickCapture_abyssPrivate;
      const retainedPresentation = internals.creationPresentation_abyssPrivate;
      const feedback = expectDefined(
        view.contentEl.querySelector<HTMLElement>('.abyss-creation-feedback'),
      );
      internals.state_abyssPrivate.set('selectedList', 'inbox');
      const execute = vi.fn(
        async () =>
          ({
            type: 'ok',
            changed: true,
            outcome: {
              type: 'task',
              task: expectDefined(
                taskApplication.index.installCommittedContent('capture.md', '- [ ] Captured\n')[0],
              ),
            },
          }) satisfies TaskCommandResult,
      );
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      vi.spyOn(application, 'planCreate').mockResolvedValue({
        type: 'ready',
        destination: { filePath: 'capture.md', insertion: { type: 'append' } },
        execute,
      });
      const frame = document.body.createEl('iframe');
      const destination = expectDefined(frame.contentWindow) as EventWindow;
      const timers = new Map<number, { delay: number; run: () => void }>();
      // Native Obsidian installs its DOM helpers in every window; test-mocks only
      // installs them in the main realm. Adopt new descendants from that realm too.
      vi.spyOn(destination.document, 'createElement').mockImplementation((tag, options) =>
        destination.document.adoptNode(document.createElement(tag, options)),
      );
      const scroll = expectDefined(view.contentEl.querySelector('.abyss-center-scroll'));
      vi.spyOn(scroll, 'cloneNode').mockImplementation((deep) =>
        destination.document.adoptNode(document.importNode(scroll, deep)),
      );
      // The main window has no `matchMedia`; only the window the view moved to answers.
      expect(typeof window.matchMedia).toBe('undefined');
      const ownerMotion = vi.fn(() => ({ matches: true }));
      Object.defineProperty(destination, 'matchMedia', { configurable: true, value: ownerMotion });
      let nextTimer = 1;
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      vi.spyOn(destination, 'setTimeout').mockImplementation((callback, delay) => {
        if (typeof callback !== 'function') throw new Error('Expected timer callback');
        const id = nextTimer++;
        timers.set(id, {
          delay: delay ?? 0,
          run: () => {
            (callback as () => void)();
          },
        });
        return id;
      });
      vi.spyOn(destination, 'clearTimeout').mockImplementation((id) => {
        if (id !== undefined) timers.delete(id);
      });
      try {
        destination.document.body.append(view.containerEl);
        notifyWindowMigration(destination);
        const q = new destination.KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        });
        destination.document.body.dispatchEvent(q);
        await flushMicrotasks(0);
        expect(q.defaultPrevented).toBe(true);
        const input = expectDefined(
          view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
        );
        input.value = 'Captured';
        input.dispatchEvent(new destination.Event('input', { bubbles: true }));
        input.dispatchEvent(
          new destination.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
        await flushMicrotasks();

        expect(execute).toHaveBeenCalledOnce();
        expect(view.contentEl.querySelector('.abyss-creation-feedback')).toBe(feedback);
        expect(feedback.textContent).toBe('Task added to capture.md');
        expect(internals.state_abyssPrivate).toBe(retainedState);
        expect(internals.quickCapture_abyssPrivate).toBe(retainedCapture);
        expect(internals.creationPresentation_abyssPrivate).toBe(retainedPresentation);
        const card = expectDefined(
          view.contentEl.querySelector('.abyss-task-card.is-just-created'),
        );
        expect(ownerMotion).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
        const highlight = expectDefined(
          [...timers.entries()].find(([, timer]) => timer.delay === 800),
        );
        const announcement = expectDefined(
          [...timers.entries()].find(([, timer]) => timer.delay === 4000),
        );
        now += 800;
        timers.delete(highlight[0]);
        highlight[1].run();
        expect(card.classList.contains('is-just-created')).toBe(false);
        now += 3200;
        timers.delete(announcement[0]);
        announcement[1].run();
        expect(feedback.textContent).toBe('');

        // A second post-move creation leaves owner-window timers for close to cancel.
        input.value = 'Captured';
        input.dispatchEvent(new destination.Event('input', { bubbles: true }));
        input.dispatchEvent(
          new destination.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
        await flushMicrotasks();
        expect(execute).toHaveBeenCalledTimes(2);
        expect([...timers.values()].some((timer) => timer.delay === 800)).toBe(true);
        expect([...timers.values()].some((timer) => timer.delay === 4000)).toBe(true);
        await view.onClose();
        expect(timers.size).toBe(0);
      } finally {
        await view.onClose();
        document.body.append(view.containerEl);
        frame.remove();
      }
    });

    it('gives the recurrence-delete alertdialog modal precedence in the live panel router', async () => {
      document.body.appendChild(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      document.body.tabIndex = -1;
      document.body.focus();
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        interactionRegistry_abyssPrivate: InteractionRegistry<string>;
      };
      const before = {
        mode: internals.state_abyssPrivate.get('mode'),
        selectedList: internals.state_abyssPrivate.get('selectedList'),
        taskStack: internals.state_abyssPrivate.get('taskStack'),
        searchQuery: internals.state_abyssPrivate.get('searchQuery'),
      };
      const completion = requestTaskCompletion(
        { status: 'open', recurrence: 'tomorrow', onCompletion: 'delete' },
        vi.fn(),
        internals.interactionRegistry_abyssPrivate,
      );
      const surface = expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-recurrence-delete-confirm'),
      );
      const cancel = expectDefined(
        Array.from(surface.querySelectorAll<HTMLButtonElement>('button')).find(
          (candidate) => candidate.textContent === 'Cancel',
        ),
      );
      cancel.blur();
      document.body.focus();

      const suppressed = [
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'l',
          code: 'KeyL',
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      ];
      suppressed.forEach((event) => document.body.dispatchEvent(event));
      await flushMicrotasks(0);

      suppressed.forEach((event) => {
        expect(event.defaultPrevented).toBe(false);
      });
      expect({
        mode: internals.state_abyssPrivate.get('mode'),
        selectedList: internals.state_abyssPrivate.get('selectedList'),
        taskStack: internals.state_abyssPrivate.get('taskStack'),
        searchQuery: internals.state_abyssPrivate.get('searchQuery'),
      }).toEqual(before);
      expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBe(surface);
      expect(view.contentEl.querySelector('.abyss-capture-surface')).toBeNull();

      cancel.click();
      await completion;
      const afterDismissal = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(afterDismissal);
      expect(afterDismissal.defaultPrevented).toBe(true);
      expect(internals.state_abyssPrivate.get('mode')).toBe('calendar');
    });

    it.each(['CenterPanel', 'RightPanel'] as const)(
      'releases the live recurrence dialog owner when PanelView tears down the %s path',
      async (path) => {
        const invalidDelete = task({ recurrence: 'tomorrow', onCompletion: 'delete' });
        const internals = view as unknown as {
          center_abyssPrivate: CenterPanel;
          right_abyssPrivate: {
            toggleTaskLike_abyssPrivate(task: typeof invalidDelete): Promise<void>;
          };
          interactionRegistry_abyssPrivate: InteractionRegistry<string>;
        };
        const completion =
          path === 'CenterPanel'
            ? taskCommandsOf(internals.center_abyssPrivate).toggleTask(invalidDelete)
            : internals.right_abyssPrivate.toggleTaskLike_abyssPrivate(invalidDelete);
        const registry = internals.interactionRegistry_abyssPrivate;
        const surface = expectDefined(
          activeDocument.querySelector<HTMLElement>('.abyss-recurrence-delete-confirm'),
        );

        expect(registry.allows('openCalendar')).toBe(false);
        await view.onClose();
        await completion;

        expect(surface.isConnected).toBe(false);
        expect(registry.allows('openCalendar')).toBe(true);
      },
    );

    it('keeps TaskModal ownership layered after its RightPanel recurrence dialog closes', async () => {
      const invalidDelete = task({ recurrence: 'tomorrow', onCompletion: 'delete' });
      const internals = view as unknown as {
        center_abyssPrivate: {
          taskModal_abyssPrivate: {
            open(task: typeof invalidDelete): void;
            close(): void;
            innerPanel_abyssPrivate: {
              toggleTaskLike_abyssPrivate(task: typeof invalidDelete): Promise<void>;
            };
          };
        };
        interactionRegistry_abyssPrivate: InteractionRegistry<string>;
      };
      const modal = internals.center_abyssPrivate.taskModal_abyssPrivate;
      modal.open(invalidDelete);
      const completion = modal.innerPanel_abyssPrivate.toggleTaskLike_abyssPrivate(invalidDelete);
      const surface = expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-recurrence-delete-confirm'),
      );

      expect(internals.interactionRegistry_abyssPrivate.allows('openCalendar')).toBe(false);
      surface.querySelector<HTMLButtonElement>('button')?.click();
      await completion;
      expect(internals.interactionRegistry_abyssPrivate.allows('openCalendar')).toBe(false);

      modal.close();
      expect(internals.interactionRegistry_abyssPrivate.allows('openCalendar')).toBe(true);
    });

    it('settles a live recurrence dialog and releases both owners when TaskModal closes', async () => {
      const invalidDelete = task({ recurrence: 'tomorrow', onCompletion: 'delete' });
      const internals = view as unknown as {
        center_abyssPrivate: {
          taskModal_abyssPrivate: {
            open(task: typeof invalidDelete): void;
            close(): void;
            innerPanel_abyssPrivate: {
              toggleTaskLike_abyssPrivate(task: typeof invalidDelete): Promise<void>;
            };
          };
        };
        interactionRegistry_abyssPrivate: InteractionRegistry<string>;
      };
      const modal = internals.center_abyssPrivate.taskModal_abyssPrivate;
      const releaseModal = vi.fn();
      const releaseDialog = vi.fn();
      const acquire = vi
        .spyOn(internals.interactionRegistry_abyssPrivate, 'acquire')
        .mockReturnValueOnce({ release: releaseModal })
        .mockReturnValueOnce({ release: releaseDialog });

      modal.open(invalidDelete);
      const completion = modal.innerPanel_abyssPrivate.toggleTaskLike_abyssPrivate(invalidDelete);
      const surface = expectDefined(
        activeDocument.querySelector<HTMLElement>('.abyss-recurrence-delete-confirm'),
      );
      expect(surface.isConnected).toBe(true);
      expect(acquire).toHaveBeenCalledTimes(2);

      modal.close();
      await completion;
      modal.close();

      expect(surface.isConnected).toBe(false);
      expect(releaseModal).toHaveBeenCalledOnce();
      expect(releaseDialog).toHaveBeenCalledOnce();
    });

    it.each([
      [
        'zero-area bounds',
        (element: HTMLElement) => {
          setGeometry(element, rect(20, 20, 0, 480));
        },
      ],
      [
        'no rendered client rectangles',
        (element: HTMLElement) => {
          setGeometry(element, rect(20, 20, 640, 480), []);
        },
      ],
      [
        'offscreen bounds',
        (element: HTMLElement) => {
          setGeometry(element, rect(window.innerWidth + 20, 20, 640, 480));
        },
      ],
    ] as const)(
      'does not route shortcuts from an active connected pane with %s',
      (_reason, hide) => {
        document.body.appendChild(view.containerEl);
        workspaceState(app).activeLeaf = leaf;
        hide(view.contentEl);
        const event = new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        });

        view.contentEl.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(view.contentEl.querySelector('.abyss-quick-capture-host')?.children).toHaveLength(0);
      },
    );

    it('applies shortcut settings edits immediately without recreating the PanelView', () => {
      document.body.appendChild(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      const internals = view as unknown as { panelNavigation_abyssPrivate: PanelNavigator };
      const openSearch = vi.spyOn(internals.panelNavigation_abyssPrivate, 'openSearch');

      view.contentEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          code: 'KeyS',
          bubbles: true,
          cancelable: true,
        }),
      );
      settings.shortcuts.openSearch = 'E';
      const stale = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        bubbles: true,
        cancelable: true,
      });
      view.contentEl.dispatchEvent(stale);
      const current = new KeyboardEvent('keydown', {
        key: 'e',
        code: 'KeyE',
        bubbles: true,
        cancelable: true,
      });
      view.contentEl.dispatchEvent(current);

      expect(openSearch).toHaveBeenCalledTimes(2);
      expect(stale.defaultPrevented).toBe(false);
      expect(current.defaultPrevented).toBe(true);
    });

    it('opens and owns Quick Capture without changing mode, then refocuses only from panel chrome', async () => {
      document.body.appendChild(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const execute = vi.fn().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: {
          type: 'task',
          task: task({ source: { filePath: 'capture.md', line: 0 } }),
        },
      } satisfies TaskCommandResult);
      vi.spyOn(application, 'planCreate').mockResolvedValue({
        type: 'ready',
        destination: { filePath: 'capture.md', insertion: { type: 'append' } },
        execute,
      });
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      internals.panelNavigation_abyssPrivate.openSearch();
      await flushMicrotasks(0);
      const chrome = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-rail'));
      chrome.tabIndex = 0;
      chrome.focus();

      const openEvent = new KeyboardEvent('keydown', {
        key: 'q',
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      });
      chrome.dispatchEvent(openEvent);
      await flushMicrotasks(0);
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>(
          '.abyss-quick-capture-host .abyss-quick-capture-input',
        ),
      );

      expect(openEvent.defaultPrevented).toBe(true);
      expect(internals.state_abyssPrivate.get('mode')).toBe('search');
      expect(document.activeElement).toBe(input);
      const navigation = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        bubbles: true,
        cancelable: true,
      });
      chrome.dispatchEvent(navigation);
      expect(navigation.defaultPrevented).toBe(false);
      expect(internals.state_abyssPrivate.get('mode')).toBe('search');

      chrome.focus();
      chrome.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(input);

      const typedQ = new KeyboardEvent('keydown', {
        key: 'q',
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(typedQ);
      input.value = 'q';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expect(typedQ.defaultPrevented).toBe(false);
      expect(input.value).toBe('q');
      expect(view.contentEl.querySelectorAll('.abyss-capture-surface')).toHaveLength(1);
    });

    it('reports complete list, project, search, calendar mount, and calendar patch boundaries', () => {
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        center_abyssPrivate: { refresh(): void };
        creationPresentation_abyssPrivate: CreationPresentationController;
      };
      const afterRender = vi.spyOn(internals.creationPresentation_abyssPrivate, 'afterRender');

      internals.center_abyssPrivate.refresh();
      expect(afterRender).toHaveBeenCalledWith(
        view.contentEl.querySelector<HTMLElement>('.abyss-center'),
      );

      afterRender.mockClear();
      internals.state_abyssPrivate.set('mode', 'projects');
      expect(afterRender).toHaveBeenCalled();

      afterRender.mockClear();
      internals.state_abyssPrivate.set('mode', 'search');
      expect(afterRender).toHaveBeenCalled();

      afterRender.mockClear();
      internals.state_abyssPrivate.set('mode', 'calendar');
      expect(afterRender).toHaveBeenCalledWith(
        view.contentEl.querySelector<HTMLElement>('.abyss-cal-body'),
      );

      afterRender.mockClear();
      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });
      expect(afterRender).toHaveBeenCalledWith(
        view.contentEl.querySelector<HTMLElement>('.abyss-cal-body'),
      );
    });

    it.each([
      { name: 'Inbox', selection: 'inbox' as const, suffix: '' },
      {
        name: 'Today',
        selection: 'today' as const,
        dated: true,
      },
    ])(
      'selects a $name task created from Center and routes feedback without a Notice',
      async (scenario) => {
        const consoleError = vi.spyOn(console, 'error');
        const { selection } = scenario;
        const suffix = 'dated' in scenario ? ` 📅 ${window.moment().format('YYYY-MM-DD')}` : '';
        const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
        state.set('selectedList', selection);
        let created: ReturnType<typeof task> | undefined;
        const sessionExecute = vi.fn(async () => {
          created = expectDefined(
            taskApplication.index.installCommittedContent(
              'capture.md',
              `- [ ] Captured${suffix}\n`,
            )[0],
          );
          return {
            type: 'ok',
            changed: true,
            outcome: { type: 'task', task: created },
          } satisfies TaskCommandResult;
        });
        const captureApplication = taskApplication.tasks as TaskApplicationApi &
          TaskCaptureApplicationApi;
        const planCreate = vi.spyOn(captureApplication, 'planCreate').mockResolvedValue({
          type: 'ready',
          destination: { filePath: 'capture.md', insertion: { type: 'append' } },
          execute: sessionExecute,
        });
        const notice = vi.spyOn(
          Notice.prototype as unknown as {
            constructor__(message: string | DocumentFragment, duration?: number): void;
          },
          'constructor__',
        );
        view.contentEl.querySelector<HTMLElement>('.abyss-add-task-trigger')?.click();
        await flushMicrotasks();
        const input = expectDefined(
          view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
        );
        input.value = 'captured task';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        await flushMicrotasks();

        expect(planCreate).toHaveBeenCalledOnce();
        expect(sessionExecute).toHaveBeenCalledOnce();
        expect(view.contentEl.querySelector('.abyss-creation-feedback')?.textContent).toBe(
          'Task added to capture.md',
        );
        expect(state.get('taskStack')).toEqual([created]);
        expect(
          view.contentEl.querySelector<HTMLElement>('.abyss-task-card.is-selected')?.dataset[
            'abyssTaskRefKey'
          ],
        ).toBe(created == null ? undefined : taskPresentationKey(created.ref));
        expect(notice).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
      },
    );

    it('reveals a created task without smooth scrolling and with the short highlight under reduced motion', async () => {
      const consoleError = vi.spyOn(console, 'error');
      const matchMedia = vi.fn(() => ({ matches: true }));
      vi.stubGlobal('matchMedia', matchMedia);
      const setTimeout = vi.spyOn(window, 'setTimeout');
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('selectedList', 'inbox');
      const captureApplication = taskApplication.tasks as TaskApplicationApi &
        TaskCaptureApplicationApi;
      vi.spyOn(captureApplication, 'planCreate').mockResolvedValue({
        type: 'ready',
        destination: { filePath: 'capture.md', insertion: { type: 'append' } },
        execute: async () => ({
          type: 'ok',
          changed: true,
          outcome: {
            type: 'task',
            task: expectDefined(
              taskApplication.index.installCommittedContent('capture.md', '- [ ] Captured\n')[0],
            ),
          },
        }),
      });
      view.contentEl.querySelector<HTMLElement>('.abyss-add-task-trigger')?.click();
      await flushMicrotasks();
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      input.value = 'Captured';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(view.contentEl.querySelector('.abyss-task-card.is-just-created')).not.toBeNull();
      expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest',
      });
      const delays = setTimeout.mock.calls.map(([, delay]) => delay);
      expect(delays).toContain(800);
      expect(delays).not.toContain(1100);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('keeps a captured calendar task selected after a later calendar patch', async () => {
      document.body.appendChild(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        quickCapture_abyssPrivate: QuickCaptureCoordinator;
      };
      const today = window.moment().format('YYYY-MM-DD');
      const previous = expectDefined(
        taskApplication.index.installCommittedContent(
          'capture.md',
          `- [ ] Previous 📅 ${today}\n`,
        )[0],
      );
      await flushMicrotasks();
      internals.state_abyssPrivate.set('taskStack', [previous]);
      internals.state_abyssPrivate.set('mode', 'calendar');
      let created: ReturnType<typeof task> | undefined;
      const execute = vi.fn(async () => {
        created = expectDefined(
          taskApplication.index
            .installCommittedContent(
              'capture.md',
              `- [ ] Previous 📅 ${today}\n- [ ] Captured 📅 ${today}\n`,
            )
            .find((candidate) => candidate.title === 'Captured'),
        );
        return {
          type: 'ok',
          changed: true,
          outcome: { type: 'task', task: created },
        } satisfies TaskCommandResult;
      });
      const options = (
        internals.quickCapture_abyssPrivate as unknown as {
          options: { resolveTarget: () => Promise<CaptureTarget> };
        }
      ).options;
      options.resolveTarget = async () => panelCaptureTarget(execute);

      internals.quickCapture_abyssPrivate.openOrFocus();
      await flushMicrotasks(0);
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      input.value = 'Captured';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(internals.state_abyssPrivate.get('taskStack')).toEqual([created]);
      const selectedBeforePatch = expectDefined(
        view.contentEl.querySelector<HTMLElement>('.abyss-calendar-item.is-selected'),
      );
      expect(view.contentEl.querySelectorAll('.abyss-calendar-item.is-selected')).toHaveLength(1);
      expect(
        created == null
          ? []
          : renderedTaskNodeElements(view.contentEl, { type: 'task', ref: created.ref }),
      ).toContain(selectedBeforePatch);

      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['capture.md'] });

      const selectedAfterPatch = expectDefined(
        view.contentEl.querySelector<HTMLElement>('.abyss-calendar-item.is-selected'),
      );
      expect(view.contentEl.querySelectorAll('.abyss-calendar-item.is-selected')).toHaveLength(1);
      expect(
        created == null
          ? []
          : renderedTaskNodeElements(view.contentEl, { type: 'task', ref: created.ref }),
      ).toContain(selectedAfterPatch);
      expect(document.activeElement).toBe(input);
    });

    it('destroys creation presentation ownership on close', async () => {
      const controller = (
        view as unknown as { creationPresentation_abyssPrivate: CreationPresentationController }
      ).creationPresentation_abyssPrivate;
      const destroy = vi.spyOn(controller, 'destroy');

      await view.onClose();

      expect(destroy).toHaveBeenCalledOnce();
    });

    it('supplies one live interaction registry to both panels and destroys it after panel teardown', async () => {
      const internals = view as unknown as {
        interactionRegistry_abyssPrivate: InteractionRegistry<string>;
        center_abyssPrivate: { interactionOwnership_abyssPrivate: unknown };
        right_abyssPrivate: { interactionOwnership_abyssPrivate: unknown };
      };
      const registry = internals.interactionRegistry_abyssPrivate;

      expect(registry).toBeDefined();
      expect(internals.center_abyssPrivate.interactionOwnership_abyssPrivate).toBe(registry);
      expect(internals.right_abyssPrivate.interactionOwnership_abyssPrivate).toBe(registry);
      registry.acquire({ blocksShortcuts: true });
      expect(registry.allows('navigate')).toBe(false);

      await view.onClose();

      expect(registry.allows('navigate')).toBe(true);
      registry.acquire({ blocksShortcuts: true });
      expect(registry.allows('navigate')).toBe(true);
    });

    it('keeps planCreate on the PanelView application wrapper', async () => {
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const planCreate = vi.spyOn(application, 'planCreate');
      const center = (
        view as unknown as {
          center_abyssPrivate: {
            captureApplication_abyssPrivate:
              (TaskApplicationApi & TaskCaptureApplicationApi) | null;
          };
        }
      ).center_abyssPrivate;

      expect(center.captureApplication_abyssPrivate).not.toBeNull();
      await center.captureApplication_abyssPrivate?.planCreate({
        type: 'explicit',
        destination: { filePath: 'planned.md', insertion: { type: 'append' } },
      });

      expect(planCreate).toHaveBeenCalledWith({
        type: 'explicit',
        destination: { filePath: 'planned.md', insertion: { type: 'append' } },
      });
    });

    it('abyss-rail has 4 rail buttons (tasks/projects/calendar/search) + 1 settings button', () => {
      const railBtns = view.contentEl.querySelectorAll('.abyss-rail .abyss-rail-btn');
      expect(railBtns).toHaveLength(5);
    });

    it('abyss-left shows Inbox / Today / Upcoming smart lists', () => {
      const labels = Array.from(
        view.contentEl.querySelectorAll('.abyss-left .abyss-left-label'),
      ).map((l) => l.textContent);
      expect(labels).toContain('Inbox');
      expect(labels).toContain('Today');
      expect(labels).toContain('Upcoming');
    });

    it('shares semantic navigation across Rail, Left, and tag identity bridges', async () => {
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      const openCalendar = vi.spyOn(internals.panelNavigation_abyssPrivate, 'openCalendar');
      const openList = vi.spyOn(internals.panelNavigation_abyssPrivate, 'openList');
      const followTagRename = vi.spyOn(internals.panelNavigation_abyssPrivate, 'followTagRename');

      expectDefined(
        view.contentEl.querySelector<HTMLButtonElement>('.abyss-rail [aria-label="Calendar"]'),
      ).click();
      expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-left-item')).click();

      expect(openCalendar).toHaveBeenCalledOnce();
      expect(openList).toHaveBeenCalledWith('inbox');

      internals.state_abyssPrivate.set('selectedList', { type: 'tag', tag: '#work' });
      await tagManager.renameTagExact('#work', '#focus');

      expect(followTagRename).toHaveBeenCalledExactlyOnceWith({
        oldTag: '#work',
        newTag: '#focus',
        scope: 'exact',
      });
      expect(internals.state_abyssPrivate.get('selectedList')).toEqual({
        type: 'tag',
        tag: '#focus',
      });
    });

    it('mode change to calendar updates layout class', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const layout = view.contentEl.querySelector('.abyss-layout') as HTMLElement;
      const before = layout.className;
      state.set('mode', 'calendar');
      expect(layout.className).not.toBe(before);
      expect(layout.className).toContain('abyss-layout--calendar');
    });

    it.each([
      {
        scope: 'exact',
        selected: '#work',
        expected: '#focus',
      },
      {
        scope: 'prefix',
        selected: '#work/deep/child',
        expected: '#focus/deep/child',
      },
    ] as const)(
      'rebases the active $scope tag list after a vault identity rename',
      async ({ scope, selected, expected }) => {
        const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
        state.set('selectedList', { type: 'tag', tag: selected });

        if (scope === 'exact') {
          await tagManager.renameTagExact('#work', '#focus');
        } else {
          await tagManager.renameTagPrefix('#work', '#focus');
        }

        expect(state.get('selectedList')).toEqual({ type: 'tag', tag: expected });
      },
    );

    it.each([
      ['calendar', 'tag rename'],
      ['search', 'tag rename'],
      ['projects', 'tag rename'],
      ['calendar', 'project rename'],
      ['search', 'project rename'],
      ['projects', 'project rename'],
      ['calendar', 'project delete'],
      ['search', 'project delete'],
      ['projects', 'project delete'],
    ] as const)(
      'keeps %s active during background %s identity maintenance',
      async (mode, event) => {
        const internals = view as unknown as {
          state_abyssPrivate: AppState;
          panelNavigation_abyssPrivate: PanelNavigator;
        };
        const rebase = vi.spyOn(internals.panelNavigation_abyssPrivate, 'rebaseListIdentity');
        const followTagRename = vi.spyOn(internals.panelNavigation_abyssPrivate, 'followTagRename');
        const followNoteDelete = vi.spyOn(
          internals.panelNavigation_abyssPrivate,
          'followNoteDelete',
        );
        let expected: ListSelection;

        if (event === 'tag rename') {
          internals.panelNavigation_abyssPrivate.openList({ type: 'tag', tag: '#work' });
          if (mode === 'calendar') internals.panelNavigation_abyssPrivate.openCalendar();
          else if (mode === 'search') internals.panelNavigation_abyssPrivate.openSearch();
          else internals.panelNavigation_abyssPrivate.openProjects();
          rebase.mockClear();
          await tagManager.renameTagExact('#work', '#focus');
          expected = { type: 'tag', tag: '#focus' };
        } else {
          const file = await app.vault.create('Project.md', '');
          internals.panelNavigation_abyssPrivate.openList({ type: 'project', path: file.path });
          if (mode === 'calendar') internals.panelNavigation_abyssPrivate.openCalendar();
          else if (mode === 'search') internals.panelNavigation_abyssPrivate.openSearch();
          else internals.panelNavigation_abyssPrivate.openProjects();
          rebase.mockClear();
          if (event === 'project rename') {
            await app.vault.rename(file, 'Renamed.md');
            expected = { type: 'project', path: 'Renamed.md' };
          } else {
            await app.fileManager.trashFile(file);
            expected = 'today';
          }
        }

        if (event === 'project delete') {
          expect(followNoteDelete).toHaveBeenCalledExactlyOnceWith('Project.md');
          expect(rebase).not.toHaveBeenCalled();
        } else if (event === 'tag rename') {
          expect(followTagRename).toHaveBeenCalledExactlyOnceWith({
            oldTag: '#work',
            newTag: '#focus',
            scope: 'exact',
          });
        } else {
          expect(rebase).toHaveBeenCalledWith(expected);
        }
        expect(internals.state_abyssPrivate.get('mode')).toBe(mode);
        expect(internals.state_abyssPrivate.get('selectedList')).toEqual(expected);
      },
    );

    it('treats a rename away from Markdown as a delete of the selected project', async () => {
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      const followNoteDelete = vi.spyOn(internals.panelNavigation_abyssPrivate, 'followNoteDelete');
      const file = await app.vault.create('Project.md', '');
      internals.panelNavigation_abyssPrivate.openList({ type: 'project', path: file.path });
      internals.panelNavigation_abyssPrivate.openProjects();
      internals.state_abyssPrivate.set('projectsPanel', { view: 'dashboard', path: file.path });

      await app.vault.rename(file, 'Project.txt');

      expect(followNoteDelete).toHaveBeenCalledExactlyOnceWith('Project.md');
      expect(internals.state_abyssPrivate.get('selectedList')).toBe('today');
      expect(internals.state_abyssPrivate.get('mode')).toBe('projects');
      expect(internals.state_abyssPrivate.get('projectsPanel')).toEqual({ view: 'table' });
    });

    it('places the filter chips right before the view-state button, in filter order, and again after one is removed', async () => {
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      activeDocument.body.appendChild(view.containerEl);
      await app.vault.create('Source.md', '- [ ] Alpha #work\n');
      await flushMicrotasks();
      internals.panelNavigation_abyssPrivate.openList({ type: 'tag', tag: '#work' });
      internals.state_abyssPrivate.set('centerListViewState', {
        ...internals.state_abyssPrivate.get('centerListViewState'),
        filters: [
          { type: 'file', filePath: 'Source.md' },
          { type: 'tag', value: '#work' },
        ],
      });
      await flushMicrotasks();
      const controls = (): HTMLElement =>
        expectDefined(
          view.contentEl.querySelector<HTMLElement>('.abyss-center .abyss-center-controls'),
        );
      const chips = (): HTMLElement[] =>
        Array.from(controls().querySelectorAll<HTMLElement>(':scope > .abyss-filter-chip'));
      // The chips run in filter order straight into the view-state button.
      const expectChipsBeforeViewButton = (labels: readonly string[]): void => {
        const found = chips();
        expect(
          found.map((chip) => chip.querySelector('.abyss-filter-chip-label')?.textContent),
        ).toEqual(labels);
        for (const [index, chip] of found.entries()) {
          expect(chip.nextElementSibling).toBe(
            found[index + 1] ?? controls().querySelector(':scope > .abyss-view-state-btn'),
          );
        }
      };

      expectChipsBeforeViewButton(['📄 Source', '#work']);
      expectDefined(
        expectDefined(chips()[0]).querySelector<HTMLButtonElement>('.abyss-filter-chip-x'),
      ).click();
      await flushMicrotasks();

      expectChipsBeforeViewButton(['#work']);
      expect(view.contentEl.querySelector('.abyss-task-filter-chips')).toBeNull();
    });

    it('keeps a file filter chip on the list on screen in step with a note rename', async () => {
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      await app.vault.create('Source.md', '- [ ] Alpha #work\n');
      await app.vault.create('Other.md', '- [ ] Beta #work\n');
      await flushMicrotasks();
      internals.panelNavigation_abyssPrivate.openList({ type: 'tag', tag: '#work' });
      internals.state_abyssPrivate.set('centerListViewState', {
        ...internals.state_abyssPrivate.get('centerListViewState'),
        filters: [{ type: 'file', filePath: 'Source.md' }],
      });
      const center = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
      const chips = (): string[] =>
        Array.from(center.querySelectorAll('.abyss-filter-chip-label'), (chip) => chip.textContent);
      const titles = (): string[] =>
        Array.from(center.querySelectorAll('.abyss-task-title'), (title) => title.textContent);
      await flushMicrotasks();
      expect(chips()).toEqual(['📄 Source']);
      expect(titles()).toEqual(['Alpha']);

      await app.vault.rename(expectDefined(app.vault.getFileByPath('Source.md')), 'Renamed.md');
      await flushMicrotasks();

      expect(chips()).toEqual(['📄 Renamed']);
      expect(titles()).toEqual(['Alpha']);
    });

    it('does not change an active group selection during a prefix rename', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const selection = { type: 'group', groupId: 'work-group' } as const;
      state.set('selectedList', selection);

      await tagManager.renameTagPrefix('#work', '#focus');

      expect(state.get('selectedList')).toBe(selection);
    });

    it('rebases a retired collision-suffixed discovered prefix to its surviving exact tag', async () => {
      settings.tagGroups.push({
        id: discoveredPrefixGroupId('work'),
        name: 'Configured focus',
        mode: 'prefix',
        prefix: 'focus',
      });
      view.refreshProjectSettings();
      taskApplication.index.installCommittedContent(
        'tasks.md',
        '- [ ] Root #work\n- [ ] Descendant #work/client\n',
      );
      await flushMicrotasks();
      const discovered = expectDefined(
        resolveEffectiveTagGroups(
          settings,
          collectTaskNodeTags(taskApplication.index.listNodes()),
        ).find(
          (group) =>
            group.origin === 'discovered' && group.mode === 'prefix' && group.prefix === 'work',
        ),
      );
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      expect(discovered.id).not.toBe(discoveredPrefixGroupId('work'));
      internals.panelNavigation_abyssPrivate.openList({
        type: 'group',
        groupId: discovered.id,
      });

      taskApplication.index.installCommittedContent('tasks.md', '- [ ] Root #work\n');
      await flushMicrotasks();

      expect(internals.state_abyssPrivate.get('selectedList')).toEqual({
        type: 'tag',
        tag: '#work',
      });
      expect(internals.state_abyssPrivate.get('mode')).toBe('tasks');
    });

    it('does not retire a configured prefix group when its last descendant disappears', async () => {
      settings.tagGroups.push({
        id: 'configured-work',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
      });
      view.refreshProjectSettings();
      taskApplication.index.installCommittedContent(
        'tasks.md',
        '- [ ] Root #work\n- [ ] Descendant #work/client\n',
      );
      await flushMicrotasks();
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        panelNavigation_abyssPrivate: PanelNavigator;
      };
      const selection = { type: 'group', groupId: 'configured-work' } as const;
      internals.panelNavigation_abyssPrivate.openList(selection);

      taskApplication.index.installCommittedContent('tasks.md', '- [ ] Root #work\n');
      await flushMicrotasks();

      expect(internals.state_abyssPrivate.get('selectedList')).toEqual(selection);
    });

    it('detaches the selected-list rename boundary when the panel closes', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      await view.onClose();
      state.set('selectedList', { type: 'tag', tag: '#work/deep' });

      await tagManager.renameTagPrefix('#work', '#focus');

      expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#work/deep' });
    });

    it('query update with empty taskStack → no error', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('taskStack', []);
      expect(() => {
        emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });
      }).not.toThrow();
    });

    it('recomputes rendered tag contrast when Obsidian emits css-change', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      settings.tagGroups.push({
        id: 'work',
        name: 'Work',
        mode: 'prefix',
        prefix: 'work',
        color: '#ffffff',
      });
      document.body.setCssProps({ '--background-primary': '#ffffff' });
      const content = `- [ ] Root #work 📅 ${window.moment().format('YYYY-MM-DD')}`;
      await app.vault.create('tasks.md', content);
      taskApplication.index.installCommittedContent('tasks.md', content);
      state.set('mode', 'calendar');
      const item = expectDefined(
        view.contentEl.querySelector<HTMLElement>('.abyss-mg-plain, .abyss-mg-deadline-marker'),
      );
      expect(item.style.getPropertyValue('--abyss-tag-text-color')).toBe(
        'var(--abyss-tag-text-dark)',
      );
      document.body.setCssProps({ '--background-primary': '#000000' });
      try {
        app.workspace.trigger('css-change');
        const updated = expectDefined(
          view.contentEl.querySelector<HTMLElement>('.abyss-mg-plain, .abyss-mg-deadline-marker'),
        );
        expect(updated.style.getPropertyValue('--abyss-tag-text-color')).toBe(
          'var(--abyss-tag-text-light)',
        );
      } finally {
        document.body.style.removeProperty('--background-primary');
      }
    });

    it('refreshes the selected group title after static tag settings change', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      settings.tagGroups.push({ id: 'work', name: 'Work', mode: 'prefix', prefix: 'work' });
      state.set('selectedList', { type: 'group', groupId: 'work' });
      expect(view.contentEl.querySelector('.abyss-center-title')?.textContent).toBe('Work');

      expectDefined(settings.tagGroups[0]).name = 'Focused work';
      view.refreshProjectSettings();

      expect(view.contentEl.querySelector('.abyss-center-title')?.textContent).toBe('Focused work');
    });

    it('lets CenterPanel own the sole calendar patch while PanelView refreshes only LeftPanel', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const panels = view as unknown as {
        left_abyssPrivate: { refresh(): void };
        center_abyssPrivate: { refresh(): void };
      };
      state.set('mode', 'calendar');
      const leftRefresh = vi.spyOn(panels.left_abyssPrivate, 'refresh');
      const centerRefresh = vi.spyOn(panels.center_abyssPrivate, 'refresh');
      const calendarPatch = vi.spyOn(MonthGridView.prototype, 'patch');

      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });

      expect(leftRefresh).toHaveBeenCalledOnce();
      expect(centerRefresh).not.toHaveBeenCalled();
      expect(calendarPatch).toHaveBeenCalledOnce();
    });

    it.each(['tasks', 'search', 'projects'] as const)(
      'keeps PanelView center.refresh ownership in %s mode',
      (mode) => {
        const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
        const panels = view as unknown as {
          left_abyssPrivate: { refresh(): void };
          center_abyssPrivate: { refresh(): void };
        };
        state.set('mode', mode);
        const leftRefresh = vi.spyOn(panels.left_abyssPrivate, 'refresh');
        const centerRefresh = vi.spyOn(panels.center_abyssPrivate, 'refresh');

        emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });

        expect(leftRefresh).toHaveBeenCalledOnce();
        expect(centerRefresh).toHaveBeenCalledOnce();
      },
    );

    it('onClose empties contentEl', async () => {
      await view.onClose();
      expect(view.contentEl.children).toHaveLength(0);
    });

    it('onClose unsubs mode listener (different mode value does not mutate layout)', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const layout = view.contentEl.querySelector('.abyss-layout') as HTMLElement;
      const before = layout.className;
      await view.onClose();
      state.set('mode', 'search'); // different value
      expect(layout.className).toBe(before); // listener removed → no change
    });

    it('getViewType returns task-calendar-panel', () => {
      expect(view.getViewType()).toBe(PANEL_VIEW_TYPE);
    });

    it('getDisplayText returns "Abyss Tasks"', () => {
      expect(view.getDisplayText()).toBe('Abyss Tasks');
    });

    it('keeps the static tab title on desktop whatever the list', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('selectedList', 'upcoming');
      expect(view.getDisplayText()).toBe('Abyss Tasks');
    });

    it('names the phone header after the current list and mode', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      Platform.isPhone = true;
      try {
        const titleEl = createDiv();
        const updateHeader = vi.fn();
        Object.assign(view, { titleEl });
        Object.assign(view.leaf, { updateHeader });
        state.set('selectedList', 'upcoming');
        expect(view.getDisplayText()).toBe('Upcoming');
        expect(titleEl.textContent).toBe('Upcoming');
        expect(updateHeader).toHaveBeenCalled();
        state.set('mode', 'projects');
        expect(view.getDisplayText()).toBe('Projects');
        expect(titleEl.textContent).toBe('Projects');
        state.set('mode', 'tasks');
        state.set('selectedList', { type: 'project', path: 'Projects/Launch.md' });
        expect(titleEl.textContent).toBe('Launch');
      } finally {
        Platform.isPhone = false;
      }
    });

    it('reads as Abyss Tasks on a phone until the panel opens', async () => {
      Platform.isPhone = true;
      const freshLeaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      Object.assign(freshLeaf, { updateHeader: vi.fn() });
      const fresh = new PanelView(
        freshLeaf,
        settings,
        tagManager,
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      const titleEl = createDiv();
      Object.assign(fresh, { titleEl });
      try {
        // Obsidian reads the title during View.load and layout serialization, before onOpen.
        expect(fresh.getDisplayText()).toBe('Abyss Tasks');
        await fresh.onOpen();
        expect(fresh.getDisplayText()).toBe('Today');
        expect(titleEl.textContent).toBe('Today');
      } finally {
        Platform.isPhone = false;
        await fresh.onClose();
      }
    });

    it('opens the calendar in the Day view on a phone and in Month on desktop', async () => {
      const calendarViewOf = (target: PanelView): string =>
        (
          target as unknown as { center_abyssPrivate: { calendarView(): string } }
        ).center_abyssPrivate.calendarView();
      expect(calendarViewOf(view)).toBe('month');
      Platform.isPhone = true;
      const freshLeaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      Object.assign(freshLeaf, { updateHeader: vi.fn() });
      const fresh = new PanelView(
        freshLeaf,
        settings,
        tagManager,
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      Object.assign(fresh, { titleEl: createDiv() });
      try {
        await fresh.onOpen();
        expect(calendarViewOf(fresh)).toBe('today');
      } finally {
        Platform.isPhone = false;
        await fresh.onClose();
      }
    });

    it('stops following the list after close', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      Platform.isPhone = true;
      try {
        const titleEl = createDiv();
        Object.assign(view, { titleEl });
        Object.assign(view.leaf, { updateHeader: vi.fn() });
        state.set('selectedList', 'inbox');
        expect(titleEl.textContent).toBe('Inbox');
        await view.onClose();
        state.set('selectedList', 'upcoming');
        expect(titleEl.textContent).toBe('Inbox');
      } finally {
        Platform.isPhone = false;
      }
    });

    it('drops the bottom inset while the phone keyboard is open', async () => {
      Platform.isPhone = true;
      const freshLeaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      Object.assign(freshLeaf, { updateHeader: vi.fn() });
      const fresh = new PanelView(
        freshLeaf,
        settings,
        tagManager,
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      Object.assign(fresh, { titleEl: createDiv() });
      const keyboardClass = 'abyss-panel-view--keyboard';
      try {
        await fresh.onOpen();
        window.dispatchEvent(new Event('keyboardWillShow'));
        expect(fresh.contentEl.hasClass(keyboardClass)).toBe(true);
        window.dispatchEvent(new Event('keyboardWillHide'));
        expect(fresh.contentEl.hasClass(keyboardClass)).toBe(false);
        window.dispatchEvent(new Event('keyboardWillShow'));
        expect(fresh.contentEl.hasClass(keyboardClass)).toBe(true);
        await fresh.onClose();
        expect(fresh.contentEl.hasClass(keyboardClass)).toBe(false);
        window.dispatchEvent(new Event('keyboardWillShow'));
        expect(fresh.contentEl.hasClass(keyboardClass)).toBe(false);
      } finally {
        Platform.isPhone = false;
      }
    });

    it('ignores the keyboard events on desktop', () => {
      window.dispatchEvent(new Event('keyboardWillShow'));
      expect(view.contentEl.hasClass('abyss-panel-view--keyboard')).toBe(false);
    });

    it('getIcon returns calendar-days', () => {
      expect(view.getIcon()).toBe('calendar-days');
    });
  });

  describe('project table Quick Capture suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;
    let settings: CalendarSettings;

    beforeEach(async () => {
      app = await createAppWithFiles({
        'Projects/A.md': '---\nstatus: active\nstart: 2026-09-01\n---\n',
        'Projects/B.md': '---\nstatus: planned\nstart: 2026-09-02\n---\n',
      });
      const nativeTypes = new Map([
        ['status', 'text'],
        ['start', 'date'],
        ['end', 'date'],
        ['description', 'text'],
      ]);
      Object.defineProperty(app, 'metadataTypeManager', {
        configurable: true,
        value: {
          getAllProperties: () =>
            Object.fromEntries([...nativeTypes.keys()].map((name) => [name, { name }])),
          getTypeInfo: (name: string) => ({ expected: { type: nativeTypes.get(name) } }),
          getAssignedWidget: () => null,
          on: () => ({ id: 'project-table-quick-capture' }),
          offref: () => {},
        },
      });
      settings = structuredClone(DEFAULT_SETTINGS);
      settings.projects.taskInsertionMode = 'section';
      settings.projects.taskInsertionSection = '## Project tasks';
      taskApplication = configuredTaskApplication(app, settings);
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      view = new PanelView(
        leaf,
        settings,
        makeTagManager(app, settings),
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      vi.spyOn(app.workspace, 'getActiveViewOfType').mockImplementation((type) =>
        type === PanelView && workspaceState(app).activeLeaf === leaf ? view : null,
      );
      await view.onOpen();
      document.body.appendChild(view.containerEl);
      workspaceState(app).activeLeaf = leaf;
      setGeometry(view.containerEl, rect(20, 20, 640, 480));
      setGeometry(view.contentEl, rect(20, 20, 640, 480));
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('mode', 'projects');
    });

    afterEach(async () => {
      await view.onClose();
      view.containerEl.remove();
      workspaceState(app).activeLeaf = null;
      taskApplication.index.destroy();
    });

    function cell(path: string, columnId: string): HTMLElement {
      return expectDefined(
        view.contentEl.querySelector<HTMLElement>(
          `[data-project-path="${path}"] [data-column-id="${columnId}"]`,
        ),
      );
    }

    function pressQ(target: HTMLElement): KeyboardEvent {
      const event = new KeyboardEvent('keydown', {
        key: 'q',
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    }

    it('opens Q for the focused range occurrence, freezes its project, and restores cell focus', async () => {
      const pending = deferred<TaskCreateSession>();
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const planCreate = vi.spyOn(application, 'planCreate').mockReturnValue(pending.promise);
      const alphaStatus = cell('Projects/A.md', 'status');
      const betaStatus = cell('Projects/B.md', 'status');
      alphaStatus.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      betaStatus.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

      const open = pressQ(betaStatus);
      alphaStatus.focus();
      pending.resolve({
        type: 'ready',
        destination: {
          filePath: 'Projects/B.md',
          insertion: { type: 'section', heading: '## Project tasks', position: 'top' },
        },
        execute: vi.fn(),
      });
      await flushMicrotasks(0);

      expect(open.defaultPrevented).toBe(true);
      expect(planCreate).toHaveBeenCalledExactlyOnceWith({
        type: 'explicit',
        destination: {
          filePath: 'Projects/B.md',
          insertion: { type: 'section', heading: '## Project tasks', position: 'top' },
        },
      });
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      expect(input.closest('.abyss-capture-surface')?.textContent).toContain('Projects/B.md');
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(betaStatus);

      betaStatus.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(cell('Projects/B.md', 'progress'));
    });

    it('uses the projects default destination when the table has no selection', async () => {
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const planCreate = vi.spyOn(application, 'planCreate');
      const center = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));

      const open = pressQ(center);
      await flushMicrotasks(0);

      expect(open.defaultPrevented).toBe(true);
      expect(planCreate).toHaveBeenCalledExactlyOnceWith({ type: 'configured-default' });
    });

    it('selects a project task created by Q and preserves capture input focus', async () => {
      const consoleError = vi.spyOn(console, 'error');
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        quickCapture_abyssPrivate: QuickCaptureCoordinator;
      };
      internals.state_abyssPrivate.set('projectsPanel', {
        view: 'dashboard',
        path: 'Projects/B.md',
      });
      let created: ReturnType<typeof task> | undefined;
      const execute = vi.fn(async () => {
        created = expectDefined(
          taskApplication.index
            .installCommittedContent(
              'Projects/B.md',
              [
                '---',
                'status: planned',
                'start: 2026-09-02',
                '---',
                '',
                '## Project tasks',
                '- [ ] Captured project task',
                '',
              ].join('\n'),
            )
            .find((candidate) => candidate.title === 'Captured project task'),
        );
        return {
          type: 'ok',
          changed: true,
          outcome: { type: 'task', task: created },
        } satisfies TaskCommandResult;
      });
      const options = (
        internals.quickCapture_abyssPrivate as unknown as {
          options: { resolveTarget: () => Promise<CaptureTarget> };
        }
      ).options;
      options.resolveTarget = async () => panelCaptureTarget(execute);

      internals.quickCapture_abyssPrivate.openOrFocus();
      await flushMicrotasks(0);
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>('.abyss-quick-capture-input'),
      );
      input.value = 'Captured project task';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();

      expect(internals.state_abyssPrivate.get('taskStack')).toEqual([created]);
      const selected = expectDefined(
        view.contentEl.querySelector<HTMLElement>('.abyss-task-card.is-selected'),
      );
      expect(view.contentEl.querySelectorAll('.abyss-task-card.is-selected')).toHaveLength(1);
      expect(selected.dataset['abyssTaskRefKey']).toBe(
        created == null ? undefined : taskPresentationKey(created.ref),
      );
      expect(document.activeElement).toBe(input);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('leaves Q in a project cell editor instead of opening Quick Capture', () => {
      const application = taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi;
      const planCreate = vi.spyOn(application, 'planCreate');
      const start = cell('Projects/B.md', 'start');
      start.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const editor = expectDefined(start.querySelector<HTMLInputElement>('input'));

      const typed = pressQ(editor);

      expect(typed.defaultPrevented).toBe(false);
      expect(planCreate).not.toHaveBeenCalled();
      expect(view.contentEl.querySelector('.abyss-quick-capture-input')).toBeNull();
    });
  });

  describe('populated vault suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;

    beforeEach(async () => {
      app = await createAppWithFiles({
        'today.md': `- [ ] task one 📅 ${window.moment().format('YYYY-MM-DD')}`,
      });
      seedTaskCache(app, 'today.md', [{ task: ' ', parent: -1, line: 0 }]);
      taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      view = new PanelView(
        leaf,
        DEFAULT_SETTINGS,
        makeTagManager(app),
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('query update matching root task path → taskStack replaced with fresh task', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const tasks = taskApplication.index.list();
      const root = expectDefined(tasks[0]);
      state.set('taskStack', [root]);
      emitQueryEvent(taskApplication.index, {
        type: 'changed',
        files: [root.source.filePath],
      });
      const stack = state.get('taskStack');
      expect(stack).toHaveLength(1);
      expect(stack[0] != null && 'source' in stack[0] ? stack[0].source.filePath : undefined).toBe(
        root.source.filePath,
      );
    });

    it('query update with non-matching changedFile → taskStack unchanged', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const root = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [root]);
      const before = state.get('taskStack');
      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['other.md'] });
      expect(state.get('taskStack')).toBe(before);
    });

    it('query update when root task deleted → taskStack reset to []', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const root = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [root]);
      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (file == null) throw new Error('root task file missing');
      await app.fileManager.trashFile(file);
      await flushMicrotasks();
      expect(state.get('taskStack')).toHaveLength(0);
    });

    it('keeps the selected task and dirty draft on the fresh ref across a vault rename', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const root = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [root]);
      const comment = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      comment.value = 'rename-safe panel draft';
      comment.focus();
      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (file == null) throw new Error('root task file missing');

      await app.vault.rename(file, 'renamed.md');
      await flushMicrotasks();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(state.get('taskStack')[0]).toMatchObject({
        ref: { filePath: 'renamed.md' },
        source: { filePath: 'renamed.md' },
      });
      const restored = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      expect(restored.value).toBe('rename-safe panel draft');
      expect(view.contentEl.querySelector('.abyss-detached-draft')).toBeNull();
    });

    it('consumes an actual submitted comment across the service/index early event', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const root = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [root]);
      const observedResolutions: unknown[] = [];
      const off = taskApplication.index.subscribe((event) => {
        if (event.type === 'changed') {
          observedResolutions.push(taskApplication.index.resolve(root.ref));
        }
      });
      const input = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      input.value = 'actual interleaving comment';

      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      await flushMicrotasks();

      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (!(file instanceof TFile)) throw new Error('root task file missing');
      const content = await app.vault.cachedRead(file);
      expect(content.match(/actual interleaving comment/gu)).toHaveLength(1);
      expect(taskApplication.index.list()[0]?.comments).toHaveLength(1);
      expect(observedResolutions).toHaveLength(1);
      expect(observedResolutions[0]).toMatchObject({
        type: 'rebased',
        evidence: 'authority-transition',
      });
      expect(view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
        '',
      );
      expect(view.contentEl.querySelector('.abyss-detached-draft')).toBeNull();
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
      off();
    });

    it('restores one escrow after an observed repository candidate rolls back on process failure', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const root = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [root]);
      const original = await app.vault.read(expectDefined(app.vault.getMarkdownFiles()[0]));
      vi.spyOn(app.vault, 'process').mockImplementation(async (file, transform) => {
        const candidate = transform(original);
        const cache = app.metadataCache.getFileCache(file);
        if (cache == null) throw new Error('task cache missing');
        app.metadataCache.trigger('changed', file, candidate, cache);
        await flushMicrotasks();
        throw new Error('simulated process rollback');
      });
      const input = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      input.value = 'rollback actual comment';

      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      await flushMicrotasks();

      const file = expectDefined(app.vault.getMarkdownFiles()[0]);
      expect(await app.vault.read(file)).toBe(original);
      expect(taskApplication.index.list()[0]?.comments).toHaveLength(0);
      const live =
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value ?? '';
      const detached = view.contentEl.querySelector('.abyss-detached-draft')?.textContent ?? '';
      expect(`${live}${detached}`.match(/rollback actual comment/gu)).toHaveLength(1);
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('clears owned-write acknowledgement when deletion/switch changes the selected root', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const root = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [root]);
      (
        view as unknown as { acknowledgeOwnWrite_abyssPrivate(task: typeof root): void }
      ).acknowledgeOwnWrite_abyssPrivate(root);
      state.set('taskStack', []);
      const otherRoot = {
        ...root,
        ref: { filePath: 'other.md', line: 0, revision: 'other-old' },
        source: { ...root.source, filePath: 'other.md', line: 0 },
      };
      state.set('taskStack', [otherRoot]);
      (
        view as unknown as {
          applyResolution_abyssPrivate(result: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution_abyssPrivate({ type: 'uncertain', ref: otherRoot.ref });
      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('rejects a late write acknowledgement after selection switched away from its root', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const first = expectDefined(taskApplication.index.list()[0]);
      const firstView = first;
      const secondView = {
        ...firstView,
        ref: { filePath: 'other.md', line: 0, revision: 'second' },
        source: { ...first.source, filePath: 'other.md', line: 0 },
      };
      setTaskStack(state, [firstView]);
      setTaskStack(state, [secondView]);
      (
        view as unknown as { acknowledgeOwnWrite_abyssPrivate(ref: typeof first.ref): void }
      ).acknowledgeOwnWrite_abyssPrivate(first.ref);
      state.set('taskStack', [firstView]);
      (
        view as unknown as {
          applyResolution_abyssPrivate(result: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution_abyssPrivate({ type: 'uncertain', ref: first.ref });
      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('converges a selected Center or Left command immediately and accepts the next index event', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const observed = expectDefined(taskApplication.index.list()[0]);
      const updated = {
        ...observed,
        ref: { ...observed.ref, revision: 'owned-update' },
        title: 'Owned update',
        markdownTitle: 'Owned update',
      };
      const result: TaskCommandResult = {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      };
      state.set('taskStack', [observed]);

      (
        view as unknown as {
          convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand_abyssPrivate(observed.ref, result);

      expect(state.get('taskStack')[0]).toMatchObject({ title: 'Owned update', ref: updated.ref });
      (
        view as unknown as {
          applyResolution_abyssPrivate(resolution: { type: 'exact'; task: typeof updated }): void;
        }
      ).applyResolution_abyssPrivate({ type: 'exact', task: updated });
      expect(view.contentEl.querySelector('.abyss-task-selection-stale')).toBeNull();
    });

    it('preserves the full RightPanel DOM draft bundle while a no-op Center command converges', async () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const observed = expectDefined(taskApplication.index.list()[0]);
      state.set('taskStack', [observed]);
      activeDocument.body.append(view.contentEl);
      expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-right-title-view')).click();
      await flushMicrotasks();
      const title = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      title.value = 'unsaved title';
      title.focus();
      title.setSelectionRange(1, 6);
      const comment = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      comment.value = 'unsaved comment';
      comment.setSelectionRange(2, 9);
      const execute = vi.spyOn(taskApplication.tasks, 'execute');

      (
        view as unknown as {
          convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand_abyssPrivate(observed.ref, {
        type: 'ok',
        outcome: { type: 'task', task: observed },
        changed: false,
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

      const restoredTitle = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      const restoredComment = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      expect(restoredTitle.value).toBe('unsaved title');
      expect(restoredTitle.selectionStart).toBe(1);
      expect(restoredTitle.selectionEnd).toBe(6);
      expect(restoredComment.value).toBe('unsaved comment');
      expect(restoredComment.selectionStart).toBe(2);
      expect(restoredComment.selectionEnd).toBe(9);
      expect(activeDocument.activeElement).toBe(restoredTitle);
      expect(execute).not.toHaveBeenCalled();
    });

    it('keeps uncertainty silent when the matching command result wins the race', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const observed = expectDefined(taskApplication.index.list()[0]);
      const updated = {
        ...observed,
        ref: { ...observed.ref, revision: 'owned-after-conflict' },
        title: 'Owned after conflict',
      };
      state.set('taskStack', [observed]);
      (
        view as unknown as {
          applyResolution_abyssPrivate(resolution: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution_abyssPrivate({ type: 'uncertain', ref: observed.ref });
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();

      (
        view as unknown as {
          convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand_abyssPrivate(observed.ref, {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      });

      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.abyss-task-selection-stale')).toBeNull();
    });

    it('renders a fresh visual candidate and detaches the stale draft without a message', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const observed = expectDefined(taskApplication.index.list()[0]);
      const current = {
        ...observed,
        ref: { ...observed.ref, revision: 'visual-current' },
        title: 'Visual current',
        markdownTitle: 'Visual current',
      };
      state.set('taskStack', [observed]);
      const comment = expectDefined(
        view.contentEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      comment.value = 'stale local draft';

      (
        view as unknown as {
          applyResolution_abyssPrivate(resolution: {
            type: 'visual';
            stale: TaskRef;
            current: typeof current;
            evidence: 'same-line';
          }): void;
        }
      ).applyResolution_abyssPrivate({
        type: 'visual',
        stale: observed.ref,
        current,
        evidence: 'same-line',
      });

      expect(state.get('taskStack')[0]).toMatchObject({
        title: 'Visual current',
        ref: current.ref,
      });
      expect(view.contentEl.querySelector('.abyss-detached-draft')?.textContent).toContain(
        'stale local draft',
      );
      expect(view.contentEl.querySelector('.abyss-task-selection-message')).toBeNull();
    });

    it('does not let a late Center or Left result replace a different selection', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const first = expectDefined(taskApplication.index.list()[0]);
      const second = {
        ...first,
        ref: { filePath: 'other.md', line: 0, revision: 'second' },
        source: { ...first.source, filePath: 'other.md', line: 0 },
      };
      const updated = {
        ...first,
        ref: { ...first.ref, revision: 'late-update' },
        title: 'Late update',
      };
      setTaskStack(state, [first]);
      setTaskStack(state, [second]);

      (
        view as unknown as {
          convergeOwnCommand_abyssPrivate(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand_abyssPrivate(first.ref, {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      });

      expect(state.get('taskStack')[0]).toBe(second);
    });

    it('refresh updates left panel count badges after index change (DOM assertion)', async () => {
      // Initial: one open task due today → Today count badge = "1"
      const left = view.contentEl.querySelector('.abyss-left') as HTMLElement;
      const todayItem = Array.from(left.querySelectorAll('.abyss-left-item')).find(
        (el) => el.querySelector('.abyss-left-label')?.textContent === 'Today',
      ) as HTMLElement | undefined;
      expect(todayItem?.querySelector('.abyss-left-count')?.textContent).toBe('1');
      // Toggle the task done via file mutation (simulates an external vault edit).
      const file = expectDefined(app.vault.getMarkdownFiles()[0]);
      await app.vault.process(file, (data) => data.replace('- [ ]', '- [x]'));
      await flushMicrotasks();
      // After refresh: no open tasks due today → Today count badge absent (count 0 → not rendered)
      const todayItemAfter = Array.from(left.querySelectorAll('.abyss-left-item')).find(
        (el) => el.querySelector('.abyss-left-label')?.textContent === 'Today',
      ) as HTMLElement | undefined;
      expect(todayItemAfter?.querySelector('.abyss-left-count')?.textContent ?? '0').toBe('0');
    });
  });

  describe('deep-stack rebuild suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;

    beforeEach(async () => {
      app = await createAppWithFiles({
        'tasks.md': `- [ ] parent task 📅 ${window.moment().format('YYYY-MM-DD')}\n  - [ ] subtask one`,
      });
      seedTaskCache(app, 'tasks.md', [
        { task: ' ', parent: -1, line: 0 },
        { task: ' ', parent: 0, line: 1 },
      ]);
      taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      view = new PanelView(
        leaf,
        DEFAULT_SETTINGS,
        makeTagManager(app),
        taskApplication.index,
        taskApplication.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('exact resolution rebuilds a deep stack with the fresh subtask', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const tasks = taskApplication.index.list();
      const root = expectDefined(tasks[0]);
      const sub = root.subtasks[0];
      expect(sub).toBeDefined();
      // Set a 2-level stack: [root, subtask]
      state.set('taskStack', [root, expectDefined(sub)]);
      const snapshot = expectDefined(
        taskApplication.index.list({ filePath: root.source.filePath })[0],
      );
      (
        view as unknown as {
          applyResolution_abyssPrivate(result: { type: 'exact'; task: typeof snapshot }): void;
        }
      ).applyResolution_abyssPrivate({ type: 'exact', task: snapshot });
      const stack = state.get('taskStack');
      // Stack should still have 2 elements (root + fresh subtask found by line match)
      expect(stack).toHaveLength(2);
      expect(stack[0] != null && 'source' in stack[0] ? stack[0].source.filePath : undefined).toBe(
        root.source.filePath,
      );
      expect(taskNodeLine(snapshot, expectDefined(stack[1]))).toBe(
        taskNodeLine(root, expectDefined(sub)),
      );
    });

    it('exact resolution truncates a deep stack when the subtask identity is stale', () => {
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      const tasks = taskApplication.index.list();
      const root = expectDefined(tasks[0]);
      // Create a fake subtask with a line number that doesn't exist in fresh data
      const original = expectDefined(root.subtasks[0]);
      const fakeSub = {
        ...original,
        ref: {
          ...original.ref,
          relativeLine: 999,
          originalBlock: '  - [ ] different child',
        },
      };
      state.set('taskStack', [root, fakeSub]);
      const snapshot = expectDefined(
        taskApplication.index.list({ filePath: root.source.filePath })[0],
      );
      (
        view as unknown as {
          applyResolution_abyssPrivate(result: { type: 'exact'; task: typeof snapshot }): void;
        }
      ).applyResolution_abyssPrivate({ type: 'exact', task: snapshot });
      const stack = state.get('taskStack');
      // Fresh subtask not found at line 999 → break → stack truncated to [freshRoot]
      expect(stack).toHaveLength(1);
    });
  });
});

it('injects the actual canonical service into a mounted PanelView Search owner', async () => {
  const app = await createAppWithFiles({ 'tasks.md': '- [ ] needle' });
  const settings = structuredClone(DEFAULT_SETTINGS);
  const application = configuredTaskApplication(app, settings);
  await application.index.initialize();
  const search = canonicalSearchForIndex(application.index);
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
  const view = new PanelView(
    leaf,
    settings,
    makeTagManager(app),
    application.index,
    application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
    application.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    search,
  );
  activeDocument.body.append(view.containerEl);
  try {
    await view.onOpen();
    const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
    state.set('mode', 'search');
    const input = expectDefined(
      view.contentEl.querySelector<HTMLInputElement>('.abyss-search-global'),
    );
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await searchUiCompleted(
      view.contentEl.querySelector<HTMLElement>('.abyss-center') ?? view.contentEl,
    );
    expect(view.contentEl.querySelectorAll('.abyss-task-card')).toHaveLength(1);
  } finally {
    await view.onClose();
    search.dispose();
    application.index.destroy();
    view.containerEl.remove();
  }
});

/** Control only the host presentation boundary; search/index/panel remain real. */
function panelFrames(owner: Window) {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(owner, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.spyOn(owner, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    frames,
    present() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(0);
      }
    },
  };
}

async function prewarmPanel(initialize = true, markdown = '- [ ] needle') {
  const h = await createCanonicalSearchHarness(
    { 'tasks.md': markdown },
    structuredClone(DEFAULT_SETTINGS),
    initialize,
  );
  const frames = panelFrames(window);
  const views: PanelView[] = [];
  async function mount(ready = true, hidden = false) {
    h.app.workspace.layoutReady = ready;
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(h.app);
    const view = new PanelView(
      leaf,
      structuredClone(DEFAULT_SETTINGS),
      makeTagManager(h.app),
      h.index,
      h.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
      h.statusRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      h.search,
    );
    views.push(view);
    document.body.append(view.containerEl);
    view.containerEl.hidden = hidden;
    setGeometry(view.containerEl, rect(20, 20, 640, 480));
    setGeometry(view.contentEl, rect(20, 20, 640, 480));
    let migrate: (owner: Window) => void = () => {};
    vi.spyOn(view.contentEl, 'onWindowMigrated').mockImplementation((callback) => {
      migrate = callback;
      return () => {};
    });
    await view.onOpen();
    return { view, migrate };
  }
  return {
    ...h,
    frames,
    mount,
    async dispose() {
      for (const view of views) {
        await view.onClose();
        view.containerEl.remove();
      }
      h.close();
      vi.restoreAllMocks();
    },
  };
}

describe('PanelView useful shared prewarm', () => {
  it.each([true, false])(
    'presents the mounted visible shell before preparation, layout ready first: %s',
    async (ready) => {
      const h = await prewarmPanel();
      try {
        const { view } = await h.mount(ready);
        expect(view.contentEl.querySelector('.abyss-center-header')).not.toBeNull();
        expect(h.backends).toHaveLength(0);
        if (!ready) {
          h.frames.present();
          expect(h.backends).toHaveLength(0);
          (h.app.workspace as unknown as { setLayoutReady__(): void }).setLayoutReady__();
        }
        expect(h.frames.frames.size).toBe(1);
        // A visible sidebar is useful even when the editor owns the active leaf.
        expect(h.app.workspace.getActiveViewOfType(PanelView)).not.toBe(view);
        h.frames.present();
        expect(h.backends).toHaveLength(0);
        await vi.waitFor(() => {
          expect(h.backends).toHaveLength(1);
        });
        const cursor = await h.search.open(
          { kind: 'roots', query: 'needle' },
          new AbortController().signal,
        );
        expect(cursor.total).toBe(1);
        h.search.release(cursor);
        h.app.workspace.trigger('layout-change');
        h.app.workspace.trigger('resize');
        expect(h.frames.frames.size).toBe(0);
      } finally {
        await h.dispose();
      }
    },
  );

  it('leaves hidden restored and zero-area panels cold until a visible opportunity', async () => {
    const h = await prewarmPanel();
    try {
      const { view } = await h.mount(true, true);
      h.frames.present();
      await flushMicrotasks();
      expect(h.backends).toHaveLength(0);
      view.containerEl.hidden = false;
      setGeometry(view.contentEl, rect(0, 0, 0, 0));
      h.app.workspace.trigger('layout-change');
      expect(h.frames.frames.size).toBe(0);
      setGeometry(view.contentEl, rect(20, 20, 640, 480));
      h.app.workspace.trigger('active-leaf-change', null);
      h.frames.present();
      await vi.waitFor(() => {
        expect(h.backends).toHaveLength(1);
      });
    } finally {
      await h.dispose();
    }
  });

  it('rechecks hidden frame and task callbacks without consuming the later opportunity', async () => {
    const h = await prewarmPanel();
    try {
      const { view } = await h.mount();
      view.containerEl.hidden = true;
      h.frames.present();
      expect(h.frames.frames.size).toBe(0);
      view.containerEl.hidden = false;
      h.app.workspace.trigger('resize');
      h.frames.present();
      view.containerEl.hidden = true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
      expect(h.backends).toHaveLength(0);
      view.containerEl.hidden = false;
      h.app.workspace.trigger('layout-change');
      h.frames.present();
      await vi.waitFor(() => {
        expect(h.backends).toHaveLength(1);
      });
    } finally {
      await h.dispose();
    }
  });

  it.each(['frame', 'task', 'layout'] as const)(
    'close cancels a pending %s and never starts late work',
    async (phase) => {
      const h = await prewarmPanel();
      try {
        const { view } = await h.mount(phase !== 'layout');
        if (phase === 'task') h.frames.present();
        await view.onClose();
        (h.app.workspace as unknown as { setLayoutReady__(): void }).setLayoutReady__();
        h.app.workspace.trigger('resize');
        h.frames.present();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
        expect(h.backends).toHaveLength(0);
        expect(h.frames.frames.size).toBe(0);
      } finally {
        await h.dispose();
      }
    },
  );

  it.each(['frame', 'task'] as const)(
    'cancels the old owner %s callback and schedules only through the migrated owner',
    async (phase) => {
      const h = await prewarmPanel();
      const iframe = document.body.createEl('iframe');
      try {
        const owner = expectDefined(iframe.contentWindow);
        const migrated = panelFrames(owner);
        const { view, migrate } = await h.mount();
        if (phase === 'task') h.frames.present(); // old owner's task is queued
        owner.document.body.append(view.containerEl);
        migrate(owner);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
        expect(h.backends).toHaveLength(0);
        expect(migrated.frames.size).toBe(1);
        migrated.present();
        await vi.waitFor(() => {
          expect(h.backends).toHaveLength(1);
        });
      } finally {
        await h.dispose();
        iframe.remove();
      }
    },
  );

  it('two panels and early input join one preparation, and close/reopen retains its backend', async () => {
    const h = await prewarmPanel();
    try {
      h.scheduler.hold();
      const first = await h.mount();
      await h.mount();
      const state = (first.view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('mode', 'search');
      const input = expectDefined(
        first.view.contentEl.querySelector<HTMLInputElement>('.abyss-search-global'),
      );
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => {
        expect(h.backends).toHaveLength(1);
      });
      expect(h.backends[0]?.searchCalls).toBe(0);
      h.frames.present();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
      expect(h.backends).toHaveLength(1);
      await h.scheduler.flush();
      await searchUiCompleted(
        expectDefined(first.view.contentEl.querySelector<HTMLElement>('.abyss-center')),
      );
      expect(first.view.contentEl.querySelectorAll('.abyss-task-card')).toHaveLength(1);
      expect(h.backends[0]?.searchCalls).toBe(1);
      await first.view.onClose();
      await h.mount();
      h.frames.present();
      const cursor = await h.search.open(
        { kind: 'roots', query: 'needle' },
        new AbortController().signal,
      );
      expect(cursor.total).toBe(1);
      expect(h.backends).toHaveLength(1);
      h.search.release(cursor);
    } finally {
      await h.dispose();
    }
  });

  it('one accepted task change replaces Search once while preserving inspector reconciliation', async () => {
    const h = await prewarmPanel();
    try {
      const { view } = await h.mount();
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('mode', 'search');
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>('.abyss-search-global'),
      );
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
      await searchUiCompleted(root);
      state.set('taskStack', [expectDefined(h.index.list()[0])]);
      const calls = expectDefined(h.backends[0]).searchCalls;
      const request = Number(root.dataset['searchRequest']);
      h.index.installCommittedContent('tasks.md', '- [ ] needle updated');
      await searchUiCompleted(root);
      expect(expectDefined(h.backends[0]).searchCalls - calls).toBe(1);
      expect(Number(root.dataset['searchRequest']) - request).toBe(2);
      expect(root.textContent).toContain('needle updated');
      expect(state.get('taskStack')[0]).toMatchObject({ title: 'needle updated' });
    } finally {
      await h.dispose();
    }
  });
});

it.each(['search', 'tasks'] as const)(
  'PanelView host CSS/project notifications retain a completed %s request and page',
  async (mode) => {
    const h = await prewarmPanel();
    try {
      h.index.installCommittedContent(
        'tasks.md',
        Array.from({ length: 101 }, (_, i) => `- [ ] needle ${i}`).join('\n'),
      );
      const { view } = await h.mount();
      const internals = view as unknown as {
        state_abyssPrivate: AppState;
        projectStore_abyssPrivate: ProjectStore;
      };
      const state = internals.state_abyssPrivate;
      state.set('selectedList', 'inbox');
      state.set('mode', mode);
      const input = expectDefined(
        view.contentEl.querySelector<HTMLInputElement>(
          mode === 'search' ? '.abyss-search-global' : '.abyss-center-search',
        ),
      );
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
      await searchUiCompleted(root);
      expectDefined(root.querySelector<HTMLButtonElement>('[aria-label="Next page"]')).click();
      await searchUiCompleted(root);
      const card = expectDefined(root.querySelector<HTMLElement>('.abyss-task-card'));
      if (mode === 'tasks') {
        card.click();
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
        expect(root.querySelectorAll('.abyss-multi-selected')).toHaveLength(1);
      }
      const request = root.dataset['searchRequest'];
      const calls = h.backends[0]?.searchCalls;
      internals.projectStore_abyssPrivate.refresh();
      h.app.workspace.trigger('css-change');
      h.app.workspace.trigger('resize');
      h.app.metadataCache.trigger('resolved');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      expect(root.dataset['searchRequest']).toBe(request);
      expect(h.backends[0]?.searchCalls).toBe(calls);
      expect(card.isConnected).toBe(true);
      if (mode === 'tasks') expect(root.querySelectorAll('.abyss-multi-selected')).toHaveLength(1);
      expect(root.textContent).toContain('needle 50');
    } finally {
      await h.dispose();
    }
  },
);

it('passive panel preparation failure is sanitized, quiet and never rearmed by layout events', async () => {
  const h = await prewarmPanel();
  const notice = vi
    .spyOn(Notice.prototype as unknown as { constructor__(s: string): void }, 'constructor__')
    .mockImplementation(() => {});
  const sentinel = 'PRIVATE source query task text';
  let failed = false;
  const off = h.search.subscribe((state) => {
    failed = state.phase === 'failed';
  });
  vi.spyOn(h.source, 'documents').mockImplementation(() => {
    throw new Error(sentinel);
  });
  try {
    await h.mount();
    h.frames.present();
    await vi.waitFor(() => {
      expect(failed).toBe(true);
    });
    expect(notice).not.toHaveBeenCalled();
    expect(h.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.diagnostics)).not.toContain(sentinel);
    const attempts = h.backends.length;
    h.app.workspace.trigger('layout-change');
    h.app.workspace.trigger('resize');
    h.frames.present();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
    expect(h.backends).toHaveLength(attempts);
  } finally {
    off();
    await h.dispose();
  }
});

it('closing a panel waiting on an already started build leaves shared preparation alive', async () => {
  const h = await prewarmPanel();
  try {
    h.scheduler.hold();
    const { view } = await h.mount();
    h.frames.present();
    await vi.waitFor(() => {
      expect(h.backends).toHaveLength(1);
    });
    await view.onClose();
    await h.scheduler.flush();
    const cursor = await h.search.open(
      { kind: 'roots', query: 'needle' },
      new AbortController().signal,
    );
    expect(cursor.total).toBe(1);
    expect(h.backends).toHaveLength(1);
    h.search.release(cursor);
  } finally {
    await h.dispose();
  }
});

it('visible prewarm waits on canonical bootstrap and early input joins that same source preparation', async () => {
  const h = await prewarmPanel(false);
  try {
    seedTaskCache(h.app, 'tasks.md', [{ task: ' ', parent: -1, line: 0 }]);
    const { view } = await h.mount();
    h.frames.present();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
    expect(h.backends).toHaveLength(0);
    const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
    state.set('mode', 'search');
    const input = expectDefined(
      view.contentEl.querySelector<HTMLInputElement>('.abyss-search-global'),
    );
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    expect(h.backends).toHaveLength(0);
    await h.index.initialize();
    await searchUiCompleted(
      expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center')),
    );
    expect(h.backends).toHaveLength(1);
    expect(h.backends[0]?.searchCalls).toBe(1);
    expect(view.contentEl.querySelectorAll('.abyss-task-card')).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

it.each(['edit', 'rename', 'delete'] as const)(
  'panel preparation publishes latest canonical %s while its shared build is held',
  async (action) => {
    const h = await prewarmPanel();
    try {
      h.scheduler.hold();
      await h.mount();
      h.frames.present();
      await vi.waitFor(() => {
        expect(h.backends).toHaveLength(1);
      });
      const file = expectDefined(h.app.vault.getFileByPath('tasks.md'));
      if (action === 'edit') {
        await h.app.vault.modify(file, '- [ ] needle updated\n- [ ] needle added');
        h.index.installCommittedContent(file.path, '- [ ] needle updated\n- [ ] needle added');
      } else if (action === 'rename') await h.app.vault.rename(file, 'renamed.md');
      else await h.app.fileManager.trashFile(file);
      await flushMicrotasks(20);
      await h.scheduler.flush();
      const cursor = await h.search.open(
        { kind: 'roots', query: 'needle' },
        new AbortController().signal,
      );
      expect(cursor.total).toBe({ delete: 0, edit: 2, rename: 1 }[action]);
      const page = await h.search.read(cursor, 0, 50, new AbortController().signal);
      const hydrated = await h.search.resolvePage(page.hits, new AbortController().signal);
      expect(hydrated.map((hit) => hit.task.root.source.filePath)).toEqual(
        { delete: [], edit: ['tasks.md', 'tasks.md'], rename: ['renamed.md'] }[action],
      );
      expect(h.backends).toHaveLength(1);
      h.search.release(cursor);
    } finally {
      await h.dispose();
    }
  },
);

it('a detached or off-viewport panel keeps its later visible prewarm opportunity', async () => {
  const h = await prewarmPanel();
  try {
    const { view } = await h.mount();
    view.containerEl.remove();
    h.frames.present();
    expect(h.frames.frames.size).toBe(0);
    expect(h.backends).toHaveLength(0);
    document.body.append(view.containerEl);
    setGeometry(view.contentEl, rect(10000, 10000, 640, 480));
    h.app.workspace.trigger('layout-change');
    expect(h.frames.frames.size).toBe(0);
    setGeometry(view.contentEl, rect(20, 20, 640, 480));
    h.app.workspace.trigger('resize');
    h.frames.present();
    await vi.waitFor(() => {
      expect(h.backends).toHaveLength(1);
    });
  } finally {
    await h.dispose();
  }
});

describe('mounted Search window migration', () => {
  it.each(['search', 'tasks', 'empty-tasks'] as const)(
    'resumes %s through the new owner and accepts real input with the same backend',
    async (mode) => {
      const h = await prewarmPanel();
      const iframe = document.body.createEl('iframe');
      try {
        h.index.installCommittedContent('tasks.md', '- [ ] needle\n- [ ] other');
        const { view, migrate } = await h.mount();
        const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
        state.set('mode', mode === 'search' ? 'search' : 'tasks');
        state.set('selectedList', 'inbox');
        const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
        const input = expectDefined(
          root.querySelector<HTMLInputElement>(
            mode === 'search' ? '.abyss-search-global' : '.abyss-center-search',
          ),
        );
        if (mode !== 'empty-tasks') {
          input.value = 'needle';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await searchUiCompleted(root);
          expect(root.querySelectorAll('.abyss-task-card')).toHaveLength(1);
        } else {
          expect(root.querySelectorAll('.abyss-task-card')).toHaveLength(2);
        }
        const backend = h.backends[0];
        const request = Number(root.dataset['searchRequest'] ?? 0);
        const owner = expectDefined(iframe.contentWindow) as EventWindow;
        // Match the host's per-window DOM extensions, as in the capture migration tests.
        vi.spyOn(owner.document, 'createElement').mockImplementation((tag, options) =>
          owner.document.adoptNode(document.createElement(tag, options)),
        );
        const scroll = expectDefined(root.querySelector('.abyss-center-scroll'));
        vi.spyOn(scroll, 'cloneNode').mockImplementation((deep) =>
          owner.document.adoptNode(document.importNode(scroll, deep)),
        );
        owner.document.body.append(view.containerEl);
        migrate(owner);
        expect(root.querySelector('input.abyss-center-search')).toBe(input);
        expect(input.value).toBe(mode === 'empty-tasks' ? '' : 'needle');
        input.value = 'other';
        input.dispatchEvent(new owner.Event('input', { bubbles: true }));
        await searchUiCompleted(root);
        expect(Number(root.dataset['searchRequest'])).toBeGreaterThan(request);
        expect(root.dataset['searchLogicalResults']).toBe('1');
        expect(root.querySelector('.abyss-task-title')?.textContent).toBe('other');
        expect(h.backends).toHaveLength(1);
        if (backend !== undefined) expect(h.backends[0]).toBe(backend);
        if (mode !== 'search') {
          input.value = '';
          input.dispatchEvent(new owner.Event('input', { bubbles: true }));
          expect(root.querySelectorAll('.abyss-task-card')).toHaveLength(2);
          expect(root.querySelector('input.abyss-center-search')).toBe(input);
        }
      } finally {
        await h.dispose();
        iframe.remove();
      }
    },
  );

  it('releases the debounce in its original window before resuming the retained query', async () => {
    const h = await prewarmPanel();
    const iframe = document.body.createEl('iframe');
    try {
      const { view, migrate } = await h.mount();
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('mode', 'search');
      const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
      const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-search-global'));
      await searchUiCompleted(root);
      const setTimer = vi.spyOn(window, 'setTimeout');
      const clearTimer = vi.spyOn(window, 'clearTimeout');
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const timerAt = setTimer.mock.calls.findIndex(([, delay]) => delay === 60);
      expect(timerAt).toBeGreaterThanOrEqual(0);
      const timer = setTimer.mock.results[timerAt]?.value as number;
      const owner = expectDefined(iframe.contentWindow) as EventWindow;
      owner.document.body.append(view.containerEl);
      migrate(owner);
      expect(clearTimer).toHaveBeenCalledWith(timer);
      await searchUiCompleted(root);
      expect(input.value).toBe('needle');
      expect(root.dataset['searchLogicalResults']).toBe('1');
      expect(h.backends).toHaveLength(1);
      expect(h.backends[0]?.searchCalls).toBe(1);
    } finally {
      await h.dispose();
      iframe.remove();
    }
  });

  it.each(['cursor', 'Markdown'] as const)(
    'cancels held %s work and settles the new owner without old completion',
    async (phase) => {
      const h = await prewarmPanel();
      const iframe = document.body.createEl('iframe');
      const entered = deferred<void>(),
        release = deferred<void>();
      let oldSignal: AbortSignal | undefined;
      try {
        h.index.installCommittedContent('tasks.md', '- [ ] **needle**\n- [ ] **other**');
        const { view, migrate } = await h.mount();
        const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
        state.set('mode', 'search');
        const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
        const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-search-global'));
        let held = false;
        if (phase === 'cursor') {
          const read = h.search.read.bind(h.search);
          vi.spyOn(h.search, 'read').mockImplementation(async (cursor, offset, limit, signal) => {
            if (!held) {
              held = true;
              oldSignal = signal;
              entered.resolve();
              await release.promise;
            }
            return read(cursor, offset, limit, signal);
          });
        }
        // Obsidian's host renderer is external; retain its real promise boundary and supplied text.
        vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, el) => {
          if (phase === 'Markdown' && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          el.createEl('strong', { text: markdown.replaceAll('**', '') });
        });
        const completions: string[] = [];
        const observer = new MutationObserver(() => {
          if (root.dataset['searchPhase'] === 'complete')
            completions.push(root.dataset['searchRequest'] ?? '');
        });
        observer.observe(root, { attributes: true });
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await entered.promise;
        const oldRequest = root.dataset['searchRequest'];
        expect(root.dataset['searchPhase']).toBe('pending');
        const backend = h.backends[0];
        const owner = expectDefined(iframe.contentWindow) as EventWindow;
        owner.document.body.append(view.containerEl);
        migrate(owner);
        if (phase === 'cursor') expect(oldSignal?.aborted).toBe(true);
        // Migration itself must resume the retained query while the old operation is still held.
        await searchUiCompleted(root);
        expect(input.value).toBe('needle');
        expect(root.querySelector('.abyss-task-title')?.textContent).toBe('needle');
        input.value = 'other';
        input.dispatchEvent(new owner.Event('input', { bubbles: true }));
        await searchUiCompleted(root);
        const currentRequest = root.dataset['searchRequest'];
        release.resolve();
        await flushMicrotasks();
        expect(root.dataset['searchRequest']).toBe(currentRequest);
        expect(root.dataset['searchPhase']).toBe('complete');
        expect(root.querySelector('.abyss-task-title')?.textContent).toBe('other');
        expect(completions).not.toContain(oldRequest);
        expect(h.backends).toEqual([backend]);
        observer.disconnect();
      } finally {
        release.resolve();
        await h.dispose();
        iframe.remove();
      }
    },
  );
});

it.each(['toggle', 'other-root', 'deleted'] as const)(
  'Search receipt expiry preserves the real PanelView inspector after %s',
  async (reason) => {
    const h = await prewarmPanel(true, '- [ ] needle\n  - [ ] child\n- [ ] other');
    try {
      const { view } = await h.mount();
      const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
      state.set('mode', 'search');
      state.set('searchQuery', 'needle');
      const center = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-center'));
      await searchUiCompleted(center);
      expectDefined(center.querySelector<HTMLElement>('.abyss-task-card')).click();
      await vi.waitFor(() => {
        expect(state.get('mode')).toBe('tasks');
      });
      await searchUiCompleted(center);
      if (reason === 'toggle')
        expectDefined(
          center.querySelector<HTMLElement>('.is-search-revealed .abyss-status-marker'),
        ).click();
      else if (reason === 'deleted')
        await h.app.fileManager.trashFile(expectDefined(h.app.vault.getFileByPath('tasks.md')));
      else
        h.index.installCommittedContent(
          'tasks.md',
          '- [ ] needle\n  - [ ] child\n- [ ] other changed',
        );
      await vi.waitFor(() => {
        expect(center.dataset['searchPhase']).toBe('idle');
      });
      expect(center.dataset['searchLogicalResults']).toBeUndefined();
      expect(center.textContent).not.toContain('Type to search');
      if (reason !== 'deleted') expect(center.querySelector('.abyss-task-card')).not.toBeNull();
      if (reason === 'deleted') expect(state.get('taskStack')).toEqual([]);
      else {
        const selected = expectDefined(state.get('taskStack')[0]);
        expect(selected.title).toBe('needle');
        expect(selected.status).toBe(reason === 'toggle' ? 'done' : 'open');
        expect(state.get('inspectorBackStack')).toEqual([]);
      }
      const input = expectDefined(center.querySelector<HTMLInputElement>('.abyss-center-search'));
      input.value = 'other';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await searchUiCompleted(center);
      expect(center.dataset['searchPhase']).toBe('complete');
    } finally {
      await h.dispose();
    }
  },
);
