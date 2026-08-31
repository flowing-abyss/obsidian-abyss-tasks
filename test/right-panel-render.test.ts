import { TFile, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DependencyIndex } from '../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../src/projects/dependencies/DependencyPolicy';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { StatusRegistry } from '../src/status/StatusRegistry';
import type { SubtaskSnapshot, TaskApplicationApi, TaskSnapshot } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { CommentTimeContextProvider } from '../src/tasks/domain/commentTimeLabel';
import { atomDateTime } from '../src/tasks/domain/commentTimestamp';
import type { TaskRef } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { InteractionRegistry, type InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { rootTaskRef, taskNodeLine } from '../src/ui/taskSelection';
import {
  createAppWithFiles,
  flushMicrotasks,
  freshContainer,
  queryApiForTasks,
  subtask,
  task,
  taskComment,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RightPanel recurrence editor integration', () => {
  it('keeps repeat editing in explicit RightPanel controls', async () => {
    const { state, el } = await makePanel();
    activeDocument.body.append(el);
    state.set('taskStack', [task({ title: 'Repeat me', planning: { due: '2026-08-09' } })]);

    const chip = el.querySelector<HTMLButtonElement>('.abyss-repeat-chip')!;
    expect(chip.textContent).toBe('+ repeat');
    const kebab = el.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
    click(kebab);
    expect(
      Array.from(
        el.querySelectorAll<HTMLElement>('.abyss-task-context-menu .abyss-context-item'),
      ).some((item) => item.textContent === 'Edit repeat…'),
    ).toBe(true);

    click(chip);

    expect(el.querySelectorAll('.abyss-recurrence-popover')).toHaveLength(1);
    expect(el.querySelectorAll('.abyss-recurrence-editor')).toHaveLength(1);
    expect(el.querySelector('.abyss-recurrence-popover')?.classList).toContain(
      'abyss-popover-anchored',
    );

    el.querySelector<HTMLElement>('.abyss-recurrence-editor')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(el.querySelector('.abyss-recurrence-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(chip);
    el.remove();
  });

  it('labels its anchored editor host and dismisses outside through the focus-restoring handle', async () => {
    const { state, el } = await makePanel();
    activeDocument.body.append(el);
    state.set('taskStack', [task({ title: 'Repeat me', planning: { due: '2026-08-09' } })]);
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });
    const chip = el.querySelector<HTMLButtonElement>('.abyss-repeat-chip')!;

    click(chip);
    await tick();
    const popover = el.querySelector<HTMLElement>('.abyss-recurrence-popover')!;
    const title = popover.querySelector<HTMLElement>('.abyss-recurrence-title')!;
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-modal')).toBe('false');
    expect(popover.getAttribute('aria-labelledby')).toBe(title.id);
    expect(popover.querySelector('[aria-modal="true"]')).toBeNull();

    click(outside);

    expect(el.querySelector('.abyss-recurrence-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(chip);
    el.remove();
    outside.remove();
  });

  it('renders the current repeat value and detects recurrence ownership conflicts', async () => {
    const { state, el } = await makePanel();
    const child = subtask({ title: 'Child', recurrence: 'every day' });
    const root = task({
      title: 'Root',
      planning: { due: '2026-08-09' },
      recurrence: 'every week',
      subtasks: [child],
    });
    state.set('taskStack', [root]);

    const chip = el.querySelector<HTMLButtonElement>('.abyss-repeat-chip')!;
    expect(chip.textContent).toBe('every week');
    expect(chip.querySelector('.abyss-recurrence-badge')?.getAttribute('aria-label')).toBe(
      'Repeats: every week',
    );
    expect(chip.querySelectorAll('.abyss-recurrence-badge-icon')).toHaveLength(1);
    click(chip);

    expect(el.querySelector('.abyss-recurrence-status')?.textContent).toBe(
      'Remove the nested repeat conflict first.',
    );
    expect(el.querySelector<HTMLButtonElement>('.abyss-recurrence-save')?.disabled).toBe(true);
  });

  it('opens the shared editor for the exact selected sub-task from its context menu', async () => {
    const child = subtask({
      title: 'Child',
      recurrence: 'every weekday',
      planning: { due: '2026-08-10' },
    });
    const root = task({ title: 'Root', subtasks: [child] });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'io-error',
      cause: 'test',
      contentState: 'unchanged',
    });
    const { state, el } = await makePanel({}, { queries: queryApiForTasks(() => [root]), execute });
    state.set('taskStack', [root, child]);

    const more = Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-right-action-btn')).find(
      (button) => button.textContent === '⋯',
    )!;
    click(more);
    const edit = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-task-context-menu .abyss-context-item'),
    ).find((item) => item.textContent === 'Edit repeat…');
    expect(edit).not.toBeUndefined();
    click(edit!);

    expect(el.querySelectorAll('.abyss-recurrence-popover .abyss-recurrence-editor')).toHaveLength(
      1,
    );
    expect(el.querySelector<HTMLInputElement>('.abyss-recurrence-raw')?.value).toBe(
      'every weekday',
    );
    const raw = el.querySelector<HTMLInputElement>('.abyss-recurrence-raw')!;
    raw.value = 'every month';
    raw.dispatchEvent(new Event('input', { bubbles: true }));
    click(el.querySelector<HTMLButtonElement>('.abyss-recurrence-save')!);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'subtask', ref: child.ref },
      patch: {
        recurrence: { type: 'set', value: 'every month' },
      },
    });
  });

  it('moves focus into the right-panel overflow menu when it opens', async () => {
    const root = task({ title: 'Focused menu task' });
    const { state, el, panel } = await makePanel(
      {},
      {
        queries: queryApiForTasks(() => [root]),
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    );
    activeDocument.body.append(el);
    state.set('taskStack', [root]);
    const more = Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-right-action-btn')).find(
      (button) => button.textContent === '⋯',
    )!;

    try {
      more.focus();
      click(more);
      const menu = el.querySelector<HTMLElement>('.abyss-task-context-menu')!;
      const firstItem = menu.querySelector<HTMLElement>('.abyss-context-item')!;

      expect(menu.getAttribute('role')).toBe('menu');
      expect(firstItem.getAttribute('role')).toBe('menuitem');
      expect(activeDocument.activeElement).toBe(firstItem);
      expect(menu.contains(activeDocument.activeElement)).toBe(true);
      expect(firstItem.tabIndex).toBe(0);

      firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(el.querySelector('.abyss-task-context-menu')).toBeNull();
      expect(activeDocument.activeElement).toBe(more);

      click(more);
      el.querySelector<HTMLElement>('.abyss-task-context-menu .abyss-context-item')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      expect(el.querySelector('.abyss-task-context-menu')).toBeNull();
      expect(el.querySelector('.abyss-recurrence-popover')).not.toBeNull();
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('owns overflow-menu listeners in its mounted document and removes them on rerender', async () => {
    const originalActiveDocument = activeDocument;
    const frame = originalActiveDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    const replacementDocument = originalActiveDocument.implementation.createHTMLDocument('next');
    const ownerAdd = vi.spyOn(ownerDocument, 'addEventListener');
    const ownerRemove = vi.spyOn(ownerDocument, 'removeEventListener');
    const replacementAdd = vi.spyOn(replacementDocument, 'addEventListener');
    const first = task({ title: 'First menu task' });
    const second = task({ title: 'Replacement task' });
    const { state, el, panel } = await makePanel(
      {},
      {
        queries: queryApiForTasks(() => [first, second]),
        execute: vi.fn<TaskApplicationApi['execute']>(),
      },
    );
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    state.set('taskStack', [first]);

    try {
      const more = Array.from(
        el.querySelectorAll<HTMLButtonElement>('.abyss-right-action-btn'),
      ).find((button) => button.textContent === '⋯')!;
      click(more);
      vi.stubGlobal('activeDocument', replacementDocument);
      await tick();

      const keyRegistration = ownerAdd.mock.calls.find(([type]) => type === 'keydown')!;
      const clickRegistration = ownerAdd.mock.calls.find(([type]) => type === 'click')!;
      expect(keyRegistration).toBeDefined();
      expect(clickRegistration).toBeDefined();
      expect(
        replacementAdd.mock.calls.some(([type]) => type === 'keydown' || type === 'click'),
      ).toBe(false);

      state.set('taskStack', [second]);

      expect(el.querySelector('.abyss-task-context-menu')).toBeNull();
      expect(ownerRemove).toHaveBeenCalledWith('keydown', keyRegistration[1], true);
      expect(ownerRemove).toHaveBeenCalledWith('click', clickRegistration[1], true);
    } finally {
      vi.unstubAllGlobals();
      panel.destroy();
      el.remove();
      frame.remove();
      ownerAdd.mockRestore();
      ownerRemove.mockRestore();
      replacementAdd.mockRestore();
    }
  });
});

describe('RightPanel dependency completion policy', () => {
  it('blocks Done from the status menu and keyboard marker before repository mutation', async () => {
    const prerequisite = task({
      title: 'Prepare',
      dependency: { id: 'prep', dependsOn: [] },
      source: { filePath: 'Tasks.md', line: 0, originalBlock: '- [ ] Prepare 🆔 prep' },
    });
    const dependent = task({
      title: 'Ship',
      dependency: { dependsOn: ['prep'] },
      source: { filePath: 'Tasks.md', line: 1, originalBlock: '- [ ] Ship ⛔ prep' },
    });
    const queries = taskQueryApi({
      list: () => [prerequisite, dependent],
      resolve: (ref) => {
        const current = [prerequisite, dependent].find(
          (candidate) => candidate.ref.revision === ref.revision,
        );
        return current
          ? { type: 'exact' as const, task: current, basis: { observed: current } }
          : { type: 'not-found' as const, ref };
      },
    });
    const edit = vi.fn();
    const graph = new DependencyIndex();
    graph.replace([prerequisite, dependent]);
    const policy = new DependencyPolicy(graph);
    const application = new TaskApplicationService(
      queries,
      { edit, completeRecurrence: vi.fn(), create: vi.fn(), move: vi.fn() },
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-08-28') },
      undefined,
      undefined,
      graph,
      policy,
    );
    const execute = vi.spyOn(application, 'execute');
    const { panel, state, el } = await makePanel({}, application);
    state.set('taskStack', [dependent]);

    el.querySelector<HTMLElement>('.abyss-right-header > .abyss-status-marker')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    const done = Array.from(
      activeDocument.querySelectorAll<HTMLElement>('.abyss-status-popover-row'),
    ).find((row) => row.textContent?.includes('Done'))!;
    expect(done).toBeDefined();
    click(done);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledOnce();
    await expect(execute.mock.results[0]?.value).resolves.toMatchObject({
      type: 'blocked',
      operation: 'completion',
    });
    const marker = el.querySelector<HTMLElement>('.abyss-right-header > .abyss-status-marker')!;
    marker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(2);
    await expect(execute.mock.results[1]?.value).resolves.toMatchObject({
      type: 'blocked',
      operation: 'completion',
    });
    expect(edit).not.toHaveBeenCalled();
    panel.destroy();
  });
});

/** Read a markdown file's current content via the vault. */
async function readMd(app: App, path: string): Promise<string> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) throw new Error(`${path} is not a TFile`);
  return app.vault.cachedRead(f);
}

/** Resolve after a real setTimeout so popover `setTimeout(0)` listeners attach. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Dispatch a click event on an element. */
function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

/** Read the textContent of the first element matching `sel` inside `el`, or '' if absent. */
function el2Text(el: HTMLElement, sel: string): string {
  return el.querySelector(sel)?.textContent ?? '';
}

/** Bracket-access helper to call private methods (preserves `this` binding). */
function call<T>(panel: RightPanel, method: string, ...args: unknown[]): T {
  const fn = (panel as unknown as Record<string, (...a: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

function absoluteFixtureLine(taskLike: TaskSnapshot | SubtaskSnapshot): number {
  if ('source' in taskLike) return taskLike.source.line;
  let line = rootTaskRef(taskLike).line;
  let ref = taskLike.ref;
  const offsets: number[] = [];
  while ('parent' in ref) {
    offsets.unshift(ref.relativeLine);
    if (ref.parent.type === 'task') break;
    ref = ref.parent.ref;
  }
  return offsets.reduce((sum, offset) => sum + offset, line);
}

function attachCurrentRef(panel: RightPanel, taskLike: TaskSnapshot | SubtaskSnapshot): void {
  const roots = (panel as unknown as { tasks: TaskApplicationApi }).tasks.queries.list();
  for (const root of roots) {
    const queue: Array<TaskSnapshot | SubtaskSnapshot> = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (
        root.source.filePath === rootTaskRef(taskLike).filePath &&
        taskNodeLine(root, current) === absoluteFixtureLine(taskLike)
      ) {
        Object.assign(taskLike, { ref: current.ref });
        return;
      }
      queue.push(...current.subtasks);
    }
  }
}

/**
 * Wire up a real RightPanel + AppState with a vault file. `fileContent` is
 * seeded at `f.md` so vault-write tests can assert on the resulting content.
 */
async function makePanel(
  files: Record<string, string> = {},
  tasks?: TaskApplicationApi,
  statusRegistry: StatusRegistry = testStatusRegistry(),
  onSuccessfulMutation?: (ref?: TaskRef) => void,
  commentTimeContext?: CommentTimeContextProvider,
  interactionOwnership?: InteractionOwnershipPort,
): Promise<{ panel: RightPanel; state: AppState; app: App; el: HTMLElement }> {
  const app = await createAppWithFiles(files);
  const state = new AppState();
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const defaultTasks = new TaskApplicationService(
    index,
    new ObsidianTaskRepository(app, {
      codec: new TaskMarkdownCodec(statusCatalog),
      editor: new TaskBlockEditor(),
      locator: new TaskLocator(),
      snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    }),
    statusCatalog,
    { today: () => '2026-07-14' as never },
  );
  await index.initialize();
  const panel = new RightPanel(
    state,
    app,
    statusRegistry,
    DEFAULT_SETTINGS,
    onSuccessfulMutation,
    tasks ?? defaultTasks,
    undefined,
    undefined,
    commentTimeContext,
    interactionOwnership,
  );
  const el = freshContainer();
  panel.mount(el);
  return { panel, state, app, el };
}

describe('RightPanel interaction ownership', () => {
  const cases = [
    {
      category: 'action',
      open: (el: HTMLElement) =>
        click(el.querySelector<HTMLElement>('[aria-label="More actions"]')!),
      focus: '.abyss-task-context-menu [role="menuitem"]',
    },
    {
      category: 'add-date',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-chip-add-date')!),
      focus: '.abyss-add-date-menu [role="menuitem"]',
    },
    {
      category: 'date',
      open: (el: HTMLElement) =>
        click(
          Array.from(el.querySelectorAll<HTMLElement>('.abyss-chips-row > button')).find(
            (candidate) => candidate.textContent?.startsWith('📅'),
          )!,
        ),
      focus: '.abyss-date-popover [aria-label="Clear date"]',
    },
    {
      category: 'priority',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-priority-chip')!),
      focus: '.abyss-priority-popover [role="option"]',
    },
    {
      category: 'time/duration',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-chip-time')!),
      focus: '.abyss-time-popover [aria-label="Clear time"]',
    },
    {
      category: 'status',
      open: (el: HTMLElement) =>
        el
          .querySelector<HTMLElement>('.abyss-status-marker')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      focus: '.abyss-status-popover [role="menuitemradio"]',
    },
  ] as const;

  it.each(cases)(
    'blocks semantic navigation in the $category surface and releases on rerender',
    async ({ open, focus }) => {
      const registry = new InteractionRegistry<'navigate'>();
      const { panel, state, el } = await makePanel(
        {},
        undefined,
        testStatusRegistry(),
        undefined,
        undefined,
        registry,
      );
      activeDocument.body.append(el);
      const navigate = vi.fn();
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'n' && registry.allows('navigate')) navigate();
      };
      activeDocument.addEventListener('keydown', onKeydown);
      state.set('taskStack', [
        task({
          title: 'Owned surface',
          priority: 'B',
          planning: { due: '2026-08-11', time: '09:15', duration: 45 },
        }),
      ]);

      try {
        open(el);
        const focused =
          el.querySelector<HTMLElement>(focus) ?? activeDocument.querySelector<HTMLElement>(focus);
        expect(focused).not.toBeNull();
        focused!.focus();
        focused!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
        expect(navigate).not.toHaveBeenCalled();

        state.set('taskStack', [task({ title: 'Replacement' })]);
        activeDocument.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'n', bubbles: true }),
        );
        expect(navigate).toHaveBeenCalledOnce();
      } finally {
        activeDocument.removeEventListener('keydown', onKeydown);
        panel.destroy();
        registry.destroy();
        el.remove();
      }
    },
  );

  const statusReplacementCases = [
    {
      category: 'action',
      open: (el: HTMLElement) =>
        click(el.querySelector<HTMLElement>('[aria-label="More actions"]')!),
      surface: '.abyss-task-context-menu',
    },
    {
      category: 'add-date',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-chip-add-date')!),
      surface: '.abyss-add-date-menu',
    },
    {
      category: 'date',
      open: (el: HTMLElement) =>
        click(
          Array.from(el.querySelectorAll<HTMLElement>('.abyss-chips-row > button')).find(
            (candidate) => candidate.textContent?.startsWith('📅'),
          )!,
        ),
      surface: '.abyss-date-popover',
    },
    {
      category: 'priority',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-priority-chip')!),
      surface: '.abyss-priority-popover',
    },
    {
      category: 'time/duration',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-chip-time')!),
      surface: '.abyss-time-popover',
    },
    {
      category: 'recurrence',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('.abyss-repeat-chip')!),
      surface: '.abyss-recurrence-popover',
    },
    {
      category: 'tag input',
      open: (el: HTMLElement) => click(el.querySelector<HTMLElement>('[aria-label="Add tag"]')!),
      surface: '.abyss-tag-dropdown-wrap',
    },
  ] as const;

  it.each(statusReplacementCases)(
    'releases and removes the $category surface before opening a status menu',
    async ({ open, surface }) => {
      const releases = [vi.fn(), vi.fn()];
      const acquire = vi
        .fn()
        .mockReturnValueOnce({ release: releases[0] })
        .mockReturnValueOnce({ release: releases[1] });
      const { panel, state, app, el } = await makePanel(
        {},
        undefined,
        testStatusRegistry(),
        undefined,
        undefined,
        { acquire },
      );
      (app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags = () => ({
        '#owned': 1,
      });
      activeDocument.body.append(el);
      state.set('taskStack', [
        task({
          title: 'Replace owned surface',
          priority: 'B',
          recurrence: 'every day',
          planning: { due: '2026-08-11', time: '09:15', duration: 45 },
        }),
      ]);

      try {
        open(el);
        expect(el.querySelector(surface)).not.toBeNull();

        const statusMarker = el.querySelector<HTMLElement>(
          '.abyss-right-header > .abyss-status-marker',
        )!;
        statusMarker.focus();
        statusMarker.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );

        expect(el.querySelector(surface)).toBeNull();
        expect(
          activeDocument
            .querySelector<HTMLElement>('.abyss-status-popover')
            ?.contains(activeDocument.activeElement),
        ).toBe(true);
        expect(releases[0]).toHaveBeenCalledOnce();
        expect(releases[1]).not.toHaveBeenCalled();
        expect(activeDocument.querySelector('.abyss-status-popover')).not.toBeNull();
        expect(releases[0]!.mock.invocationCallOrder[0]).toBeLessThan(
          acquire.mock.invocationCallOrder[1]!,
        );

        panel.destroy();
        expect(releases[0]).toHaveBeenCalledOnce();
        expect(releases[1]).toHaveBeenCalledOnce();
      } finally {
        panel.destroy();
        el.remove();
      }
    },
  );

  it('uses the same replacement path for a sub-task status marker', async () => {
    const releases = [vi.fn(), vi.fn()];
    const acquire = vi
      .fn()
      .mockReturnValueOnce({ release: releases[0] })
      .mockReturnValueOnce({ release: releases[1] });
    const child = subtask({ title: 'Owned child' });
    const root = task({ title: 'Owned root', priority: 'B', subtasks: [child] });
    const { panel, state, el } = await makePanel(
      {},
      undefined,
      testStatusRegistry(),
      undefined,
      undefined,
      { acquire },
    );
    activeDocument.body.append(el);
    state.set('taskStack', [root]);

    try {
      click(el.querySelector<HTMLElement>('.abyss-priority-chip')!);
      expect(el.querySelector('.abyss-priority-popover')).not.toBeNull();

      const statusMarker = el.querySelector<HTMLElement>(
        '.abyss-subtask-row .abyss-status-marker',
      )!;
      statusMarker.focus();
      statusMarker.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );

      expect(el.querySelector('.abyss-priority-popover')).toBeNull();
      expect(
        activeDocument
          .querySelector<HTMLElement>('.abyss-status-popover')
          ?.contains(activeDocument.activeElement),
      ).toBe(true);
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).not.toHaveBeenCalled();
      expect(releases[0]!.mock.invocationCallOrder[0]).toBeLessThan(
        acquire.mock.invocationCallOrder[1]!,
      );
    } finally {
      panel.destroy();
      el.remove();
    }
  });
});

describe('RightPanel render lifecycle', () => {
  it('calls the header-actions hook with each newly rendered actions container', async () => {
    const app = await createAppWithFiles({});
    const state = new AppState();
    const renderHeaderActions = vi.fn<(actions: HTMLElement) => void>();
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      undefined,
      renderHeaderActions,
    );
    const el = freshContainer();
    panel.mount(el);
    expect(renderHeaderActions).not.toHaveBeenCalled();

    state.set('taskStack', [task({ title: 'First' })]);
    const firstActions = renderHeaderActions.mock.calls[0]?.[0];
    expect(firstActions?.classList.contains('abyss-right-header-actions')).toBe(true);
    expect(firstActions?.parentElement?.classList.contains('abyss-right-header')).toBe(true);

    state.set('taskStack', [task({ title: 'Second' })]);
    const secondActions = renderHeaderActions.mock.calls[1]?.[0];
    expect(renderHeaderActions).toHaveBeenCalledTimes(2);
    expect(secondActions).not.toBe(firstActions);
    expect(secondActions?.parentElement).toBe(el.querySelector('.abyss-right-header'));
  });

  it('mount subscribes to taskStack → re-renders when stack changes', async () => {
    const { state, el } = await makePanel();
    expect(el.querySelector('.abyss-right-title-view')).toBeNull();
    state.set('taskStack', [task({ title: 'Hello' })]);
    const view = el.querySelector('.abyss-right-title-view');
    expect(view).not.toBeNull();
  });

  it('destroy removes the taskStack listener (no re-render after destroy)', async () => {
    const { panel, state, el } = await makePanel();
    panel.destroy();
    state.set('taskStack', [task({ title: 'After destroy' })]);
    expect(el.querySelector('.abyss-right-title-view')).toBeNull();
    expect(el.children).toHaveLength(0);
  });

  it('empty taskStack renders the empty-state message', async () => {
    const { el } = await makePanel();
    expect(el.querySelector('.abyss-right-empty')).not.toBeNull();
    expect(el.querySelector('.abyss-right-empty-title')?.textContent).toBe('No task selected');
  });
});

describe('RightPanel.renderTask', () => {
  it('uses the shared field lifecycle for a deferred Task priority conflict', async () => {
    const selected = task({ title: 'Lifecycle', priority: 'B' });
    let settle!: (result: Awaited<ReturnType<TaskApplicationApi['execute']>>) => void;
    const pending = new Promise<Awaited<ReturnType<TaskApplicationApi['execute']>>>((resolve) => {
      settle = resolve;
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending);
    const { panel, state, el } = await makePanel({}, { execute } as unknown as TaskApplicationApi);
    el.ownerDocument.body.append(el);
    state.set('taskStack', [selected]);
    const priority = el.querySelector<HTMLButtonElement>('.abyss-priority-chip')!;
    priority.focus();

    const update = (
      panel as unknown as { updatePriority(task: TaskSnapshot, value: string): Promise<void> }
    ).updatePriority(selected, 'A');
    const feedback = el.querySelector<HTMLElement>('[data-task-field-feedback="priority"]')!;
    expect(feedback.dataset['resultType']).toBe('pending');
    expect(priority.disabled).toBe(true);

    settle({ type: 'conflict', current: selected });
    await update;
    expect(feedback.dataset['resultType']).toBe('conflict');
    expect(feedback.textContent).toContain('Draft kept');
    expect(priority.disabled).toBe(false);
    expect(el.ownerDocument.activeElement).toBe(priority);
    panel.destroy();
    el.remove();
  });

  it('joins the common inspector entity and field contract without removing Task-only sections', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'Contract task', recurrence: 'every week' })]);

    expect(el.dataset['inspectorEntity']).toBe('task');
    expect(el.classList.contains('abyss-inspector-shell')).toBe(true);
    expect(
      Array.from(
        el.querySelectorAll<HTMLElement>('[data-inspector-field]'),
        (field) => field.dataset['inspectorField'],
      ),
    ).toEqual(expect.arrayContaining(['description', 'subtasks', 'comments']));
    expect(el.querySelector('.abyss-right-section-label')?.textContent).toBe('Progress');
    expect(
      Array.from(
        el.querySelectorAll('.abyss-right-section-label'),
        ({ textContent }) => textContent,
      ),
    ).toContain('Sub-tasks');
  });

  it('keeps semantic section headings without a decorative divider element', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'Task' })]);
    const headings = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-right-section-label'),
      (element) => element.textContent,
    );

    expect(headings).toEqual(['Progress', 'Description', 'Sub-tasks', 'Comments']);
    expect(el.querySelector('.abyss-right-divider')).toBeNull();
  });

  it.each(['root', 'subtask'] as const)(
    'renders one shared %s header status control and rebases its successful commands',
    async (selection) => {
      const registry = testStatusRegistry();
      registry.replace([
        ...registry.all(),
        {
          id: 'status-waiting',
          symbol: 'w',
          name: 'Waiting',
          type: 'in-progress',
          icon: 'pause',
          core: false,
        },
      ]);
      const rootRef: TaskRef = { filePath: 'f.md', line: 0, revision: 'old' };
      const childRef = {
        parent: { type: 'task' as const, ref: rootRef },
        relativeLine: 1,
        originalBlock: '  - [w] Child',
      };
      const child = subtask({
        title: 'Child',
        status: 'in-progress',
        statusSymbol: 'w',
        priority: 'F',
        ref: childRef,
      });
      const root = task({
        title: 'Root',
        status: 'in-progress',
        statusSymbol: 'w',
        priority: 'F',
        ref: rootRef,
        subtasks: [child],
      });
      const freshRootRef: TaskRef = { ...rootRef, revision: 'fresh' };
      const freshChild = subtask({
        ...child,
        ref: { ...childRef, parent: { type: 'task', ref: freshRootRef } },
      });
      const freshRoot = task({
        ...root,
        ref: freshRootRef,
        subtasks: [freshChild],
      });
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: freshRoot },
      });
      const tasks: TaskApplicationApi = {
        queries: queryApiForTasks(() => []),
        execute,
      };
      const acknowledge = vi.fn<(ref?: TaskRef) => void>();
      const { state, el } = await makePanel({}, tasks, registry, acknowledge);
      state.set('taskStack', selection === 'root' ? [root] : [root, child]);

      const header = el.querySelector<HTMLElement>('.abyss-right-header')!;
      const marker = header.querySelector<HTMLElement>(':scope > .abyss-status-marker')!;
      const title = header.querySelector<HTMLElement>(':scope > .abyss-right-title')!;
      expect(header.querySelectorAll(':scope > .abyss-status-marker')).toHaveLength(1);
      expect(marker).not.toBeNull();
      expect(marker.nextElementSibling).toBe(title);
      expect(marker.getAttribute('data-status')).toBe('status-waiting');
      expect(marker.getAttribute('data-priority')).toBe('F');

      click(marker);
      await flushMicrotasks();

      const expectedInitialTarget =
        selection === 'root'
          ? { type: 'task' as const, ref: rootRef }
          : { type: 'subtask' as const, ref: childRef };
      expect(execute).toHaveBeenNthCalledWith(1, {
        type: 'toggle-completion',
        target: expectedInitialTarget,
      });
      expect(state.get('taskStack')).toEqual(
        selection === 'root' ? [freshRoot] : [freshRoot, freshChild],
      );

      const currentMarker = el.querySelector<HTMLElement>(
        '.abyss-right-header > .abyss-status-marker',
      )!;
      currentMarker.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      const popover = activeDocument.body.querySelector<HTMLElement>('.abyss-status-popover')!;
      expect(
        popover.querySelectorAll('.abyss-status-popover-list .abyss-status-popover-row'),
      ).toHaveLength(registry.all().length);
      expect(popover.querySelectorAll('.abyss-status-popover-flag')).toHaveLength(6);
      const waiting = Array.from(
        popover.querySelectorAll<HTMLElement>('.abyss-status-popover-row'),
      ).find((row) => row.textContent?.includes('Waiting'))!;
      click(waiting);
      await flushMicrotasks();

      const expectedFreshTarget =
        selection === 'root'
          ? { type: 'task' as const, ref: freshRootRef }
          : { type: 'subtask' as const, ref: freshChild.ref };
      expect(execute).toHaveBeenNthCalledWith(2, {
        type: 'set-status',
        target: expectedFreshTarget,
        symbol: 'w',
      });

      el.querySelector<HTMLElement>('.abyss-right-header > .abyss-status-marker')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      click(
        activeDocument.body.querySelector<HTMLElement>(
          ".abyss-status-popover-flag[data-abyss-priority='A']",
        )!,
      );
      await flushMicrotasks();

      expect(execute).toHaveBeenNthCalledWith(3, {
        type: 'patch',
        target: expectedFreshTarget,
        patch: { priority: { type: 'set', value: 'A' } },
      });
      expect(acknowledge).toHaveBeenCalledTimes(3);
      expect(acknowledge).toHaveBeenLastCalledWith(freshRootRef);
    },
  );

  it('renders the root header first and the nested breadcrumb immediately before its header', async () => {
    const { state, el } = await makePanel();
    const child = subtask({ title: 'Child' });
    const parent = task({ title: 'Parent', subtasks: [child] });

    state.set('taskStack', [parent]);
    expect(el.firstElementChild?.classList.contains('abyss-right-header')).toBe(true);
    expect(el.querySelector('.abyss-breadcrumb')).toBeNull();

    state.set('taskStack', [parent, child]);
    const breadcrumb = el.firstElementChild;
    expect(breadcrumb?.classList.contains('abyss-breadcrumb')).toBe(true);
    expect(breadcrumb?.nextElementSibling?.classList.contains('abyss-right-header')).toBe(true);
    // Crumb text renders via MarkdownRenderer (mocked as a noop in tests), so we
    // assert on the crumb item element's presence rather than its textContent.
    expect(breadcrumb?.querySelector('.abyss-breadcrumb-item')).not.toBeNull();
  });

  it('title view renders idle; clicking it enters edit mode with markdownText', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'My task' })]);
    const view = el.querySelector<HTMLElement>('.abyss-right-title-view')!;
    expect(view).not.toBeNull();
    expect(el.querySelector('.abyss-right-title-edit')).toBeNull();

    click(view);
    const ta = el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('My task');
  });

  it('editing the title and blurring writes back via updateTaskTitle', async () => {
    const fileContent = '- [ ] My task\n';
    const { panel, state, el, app } = await makePanel({ 'f.md': fileContent });
    const current = task({
      title: 'My task',
      source: { originalMarkdown: '- [ ] My task', originalBlock: '- [ ] My task' },
    });
    attachCurrentRef(panel, current);
    state.set('taskStack', [current]);
    const view = el.querySelector<HTMLElement>('.abyss-right-title-view')!;
    click(view);
    const ta = el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    ta.value = 'Updated task';
    ta.dispatchEvent(new Event('blur', { bubbles: true }));
    await flushMicrotasks();

    const written = await readMd(app, 'f.md');
    expect(written).toContain('Updated task');
    expect(el.querySelector('.abyss-right-title-edit')).toBeNull();
    expect(el.querySelector('.abyss-right-title-view')).not.toBeNull();
  });

  it('date chip renders (non-empty) when task.due is present', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'Dated',
        planning: { due: '2026-06-25' },
        source: {
          originalMarkdown: '- [ ] Dated 📅 2026-06-25',
          originalBlock: '- [ ] Dated 📅 2026-06-25',
        },
      }),
    ]);
    const chips = el.querySelectorAll('.abyss-chips-row .abyss-chip');
    const dateChip = Array.from(chips).find((c) => c.textContent?.startsWith('📅'));
    expect(dateChip).toBeDefined();
    expect(dateChip?.classList.contains('abyss-chip-empty')).toBe(false);
  });

  it('priority chip renders (non-empty) when task.priority !== "D"', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'A' })]);
    const chip = el.querySelector('.abyss-priority-chip');
    expect(chip).not.toBeNull();
    expect(chip?.classList.contains('abyss-chip-empty')).toBe(false);
    expect(chip?.getAttribute('data-priority')).toBe('A');
  });

  it.each(['A', 'B', 'C', 'E', 'F'] as const)(
    'priority chip carries data-priority="%s" so it can be color-keyed anywhere it mounts',
    async (priority) => {
      const { state, el } = await makePanel();
      state.set('taskStack', [task({ title: 'P', priority })]);
      const chip = el.querySelector('.abyss-priority-chip');
      expect(chip?.getAttribute('data-priority')).toBe(priority);
    },
  );

  // Round 4 Task 41: the priority chip's color rule (styles.css) reads
  // `--abyss-priority-*`, which is only defined under `.abyss-panel-view` (see
  // PanelView.ts). TaskModal mounts RightPanel at document.body OUTSIDE that
  // class, so without a hardcoded fallback the chip rendered colorless in the
  // task detail modal even though the correct data-priority attribute was
  // always present. Guard the fallback so this can't silently regress.
  it('priority chip color rule in styles.css falls back to a global color var (works outside .abyss-panel-view)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const rule = /\.abyss-priority-chip\[data-priority='A'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/var\(--abyss-priority-a,\s*var\(--color-red\)\)/);
  });

  it('tag chips render for each #tag in rawText', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'Tagged',
        tags: ['#work', '#home/kitchen'],
        source: {
          originalMarkdown: '- [ ] Tagged #work #home/kitchen',
          originalBlock: '- [ ] Tagged #work #home/kitchen',
        },
      }),
    ]);
    const tagChips = el.querySelectorAll('.abyss-chip-tag');
    expect(tagChips).toHaveLength(2);
    expect(tagChips[0]?.textContent).toContain('#work');
    expect(tagChips[1]?.textContent).toContain('#home/kitchen');
  });

  it('does not render a removable chip for a tag lookalike inside inline code', async () => {
    const { state, el } = await makePanel();
    const inlineOnly = Object.assign(
      task({
        title: 'Tagged',
        source: { originalMarkdown: '- [ ] Tagged `#work`', originalBlock: '- [ ] Tagged `#work`' },
      }),
      {
        tags: [],
      },
    );

    state.set('taskStack', [inlineOnly]);

    expect(el.querySelectorAll('.abyss-chip-tag')).toHaveLength(0);
  });

  it('renders one canonical chip for mixed inline and real occurrences', async () => {
    const { state, el } = await makePanel();
    const mixed = Object.assign(
      task({
        title: 'Tagged',
        source: {
          originalMarkdown: '- [ ] Tagged `#work` #work',
          originalBlock: '- [ ] Tagged `#work` #work',
        },
      }),
      {
        tags: ['#work'],
      },
    );

    state.set('taskStack', [mixed]);

    expect(el.querySelectorAll('.abyss-chip-tag')).toHaveLength(1);
    expect(el.querySelector('.abyss-chip-tag')?.textContent).toContain('#work');
  });
});

describe('RightPanel.renderSubTask', () => {
  it('reads status choices from the injected live registry without replacing the selection', async () => {
    const registry = testStatusRegistry();
    const { state, el } = await makePanel({}, undefined, registry);
    const root = task({
      title: 'Parent',
      subtasks: [subtask({ title: 'Child', ref: { originalBlock: '  - [ ] Child' } })],
    });
    state.set('taskStack', [root]);
    const observedStack = state.get('taskStack');

    registry.replace([
      ...registry.all(),
      {
        id: 'status-waiting',
        symbol: 'w',
        name: 'Waiting',
        type: 'in-progress',
        icon: 'pause',
        core: false,
      },
    ]);
    el.querySelector<HTMLElement>('.abyss-subtask-row .abyss-status-marker')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );

    expect(activeDocument.body.querySelector('.abyss-status-popover')?.textContent).toContain(
      'Waiting',
    );
    expect(state.get('taskStack')).toBe(observedStack);
  });

  it('subtask row renders status marker + label text', async () => {
    const { state, el } = await makePanel();
    const sub = subtask({ title: 'sub one', ref: { originalBlock: '  - [ ] sub one' } });
    state.set('taskStack', [task({ title: 'Parent', subtasks: [sub] })]);
    const row = el.querySelector('.abyss-subtask-row');
    expect(row).not.toBeNull();
    const marker = row?.querySelector<HTMLElement>('.abyss-status-marker');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute('data-status-type')).toBe('todo');
    // Label text renders via MarkdownRenderer (mocked as a noop in tests), so we
    // assert on the label element's presence rather than its textContent.
    expect(row?.querySelector('.abyss-subtask-label')).not.toBeNull();
  });

  it('clicking the status marker → toggleSubTask writes [x] to file', async () => {
    const { panel, state, el, app } = await makePanel({
      'f.md': '- [ ] parent\n  - [ ] sub one',
    });
    const sub = subtask({ title: 'sub one', ref: { originalBlock: '  - [ ] sub one' } });
    attachCurrentRef(panel, sub);
    state.set('taskStack', [
      task({ title: 'parent', subtasks: [sub], source: { filePath: 'f.md', line: 0 } }),
    ]);
    const marker = el.querySelector<HTMLElement>('.abyss-subtask-row .abyss-status-marker')!;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks(20);
    const content = await readMd(app, 'f.md');
    expect(content).toContain('  - [x] sub one');
  });

  // Same bug class as the priority chip fix (Round 4 Task 41): the subtask row's
  // status marker (styles.css `.abyss-status-marker[data-priority='X']`) also reads
  // bare `--abyss-priority-*`, which is only defined under `.abyss-panel-view`. Subtask
  // rows render here in RightPanel, which TaskModal mounts at document.body
  // OUTSIDE that class — so without a hardcoded fallback the marker's
  // priority-colored border/color was lost in the task detail modal. Guard the
  // fallback so this can't silently regress.
  it.each([
    ['A', 'red'],
    ['B', 'orange'],
    ['C', 'yellow'],
    ['E', 'blue'],
    ['F', 'purple'],
  ] as const)(
    "status marker priority='%s' rule in styles.css falls back to var(--color-%s) (works outside .abyss-panel-view)",
    async (priority, colorName) => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
      const rule =
        new RegExp(
          `\\.abyss-status-marker\\[data-priority='${priority}'\\]\\s*\\{([^}]*)\\}`,
          'u',
        ).exec(css)?.[1] ?? '';
      const priorityVar = priority.toLowerCase();
      expect(rule).toMatch(
        new RegExp(
          `border-color:\\s*var\\(--abyss-priority-${priorityVar},\\s*var\\(--color-${colorName}\\)\\)`,
        ),
      );
      expect(rule).toMatch(
        new RegExp(
          `color:\\s*var\\(--abyss-priority-${priorityVar},\\s*var\\(--color-${colorName}\\)\\)`,
        ),
      );
    },
  );
});

describe('RightPanel.renderComment', () => {
  it('renders a legacy day-only comment as Today without inventing hour precision', async () => {
    const context = vi.fn(() => ({
      nowEpochMs: Date.parse('2026-06-20T20:00:00Z'),
      today: localDate('2026-06-20'),
      locale: 'en-US',
      timeZone: 'UTC',
    }));
    const { state, el } = await makePanel({}, undefined, testStatusRegistry(), undefined, context);
    const comment = taskComment({ text: 'hello world', date: '2026-06-20' });
    state.set('taskStack', [task({ title: 'T', comments: [comment] })]);
    const row = el.querySelector('.abyss-comment-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.abyss-comment-date')?.textContent).toBe('Today');
    expect(context).toHaveBeenCalledOnce();
    // Comment text renders through MarkdownRenderer (a no-op mock in tests), so assert the
    // element exists rather than its async-populated textContent.
    expect(row?.querySelector('.abyss-comment-text')).not.toBeNull();
  });

  it('renders an Atom comment using elapsed hour-and-minute precision', async () => {
    const nowEpochMs = Date.parse('2026-06-20T20:00:00Z');
    const context = () => ({
      nowEpochMs,
      today: localDate('2026-06-21'),
      locale: 'en-US',
      timeZone: 'Asia/Novosibirsk',
    });
    const { state, el } = await makePanel({}, undefined, testStatusRegistry(), undefined, context);
    const raw = '2026-06-21T01:40:00+07:00';
    const comment = taskComment({
      text: 'precise',
      timestamp: {
        precision: 'instant',
        atom: atomDateTime(raw),
        raw,
        epochMs: nowEpochMs - 80 * 60_000,
      },
    });

    state.set('taskStack', [task({ title: 'T', comments: [comment] })]);

    expect(el.querySelector('.abyss-comment-date')?.textContent).toBe('1 hour 20 minutes ago');
  });

  it('click on comment text → edit-mode textarea appears', async () => {
    const { state, el } = await makePanel();
    const comment = taskComment({ text: 'editable', date: '2026-06-20' });
    state.set('taskStack', [task({ title: 'T', comments: [comment] })]);
    const textEl = el.querySelector<HTMLElement>('.abyss-comment-text')!;
    click(textEl);
    expect(el.querySelector('.abyss-comment-edit-input')).not.toBeNull();
    expect(el.querySelector('.abyss-comment-text')).toBeNull();
  });
});

describe('RightPanel popovers', () => {
  it('opens a selected nested task at its absolute source line', async () => {
    const { state, el, app } = await makePanel({
      'f.md': ['zero', 'one', 'two', 'three', '- [ ] Parent', 'five', 'six', '  - [ ] Child'].join(
        '\n',
      ),
    });
    const root = task({
      title: 'Parent',
      subtasks: [
        subtask({
          title: 'Child',
          root: { filePath: 'f.md', line: 4 },
          ref: { relativeLine: 3, originalBlock: '  - [ ] Child' },
        }),
      ],
      source: {
        filePath: 'f.md',
        line: 4,
        originalMarkdown: '- [ ] Parent',
        originalBlock: '- [ ] Parent',
      },
    });
    const child = root.subtasks[0]!;
    state.set('taskStack', [root, child]);
    const leaf = app.workspace.getLeaf('tab');
    const setCursor = vi.fn();
    (leaf as unknown as { view: unknown }).view = { editor: { setCursor } };
    vi.spyOn(app.workspace, 'getLeaf').mockReturnValue(leaf);

    click(el.querySelector<HTMLElement>('[aria-label="More actions"]')!);
    const openItem = Array.from(el.querySelectorAll<HTMLElement>('.abyss-context-item')).find(
      (item) => item.textContent === 'Open in file',
    );
    click(openItem!);
    await flushMicrotasks();

    expect(setCursor).toHaveBeenCalledWith({ line: 7, ch: 0 });
  });

  it('date chip click → date popover appears', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'D',
        planning: { due: '2026-06-25' },
        source: {
          originalMarkdown: '- [ ] D 📅 2026-06-25',
          originalBlock: '- [ ] D 📅 2026-06-25',
        },
      }),
    ]);
    const chips = el.querySelectorAll('.abyss-chips-row .abyss-chip');
    const dateChip = Array.from(chips).find((c) => c.textContent?.startsWith('📅')) as HTMLElement;
    expect(dateChip).toBeDefined();
    click(dateChip);
    expect(el.querySelector('.abyss-date-popover')).not.toBeNull();
    expect(el.querySelector('.abyss-date-input')).not.toBeNull();
    panel.destroy();
  });

  it('owns Escape in the mounted document and restores focus from the date popover', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    state.set('taskStack', [
      task({
        title: 'Keyboard date',
        planning: { due: '2026-08-11' },
        source: {
          originalMarkdown: '- [ ] Keyboard date 📅 2026-08-11',
          originalBlock: '- [ ] Keyboard date 📅 2026-08-11',
        },
      }),
    ]);
    const chip = Array.from(
      el.querySelectorAll<HTMLButtonElement>('.abyss-chips-row > button'),
    ).find((candidate) => candidate.textContent?.startsWith('📅'))!;
    const escapedToDocument = vi.fn();
    ownerDocument.addEventListener('keydown', escapedToDocument);

    try {
      chip.focus();
      click(chip);
      await tick();
      const popover = el.querySelector<HTMLElement>('.abyss-date-popover')!;
      const input = popover.querySelector<HTMLInputElement>('.abyss-date-input')!;
      expect(ownerDocument.activeElement).toBe(input);

      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(escapedToDocument).not.toHaveBeenCalled();
      expect(el.querySelector('.abyss-date-popover')).toBeNull();
      expect(ownerDocument.activeElement).toBe(chip);
    } finally {
      ownerDocument.removeEventListener('keydown', escapedToDocument);
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('keeps the date popover open while focus traverses to Clear beyond the blur delay', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    const outside = ownerDocument.createElement('button');
    outside.textContent = 'Outside';
    ownerDocument.body.append(outside);
    state.set('taskStack', [task({ title: 'Date traversal', planning: { due: '2026-08-11' } })]);
    const chip = Array.from(
      el.querySelectorAll<HTMLButtonElement>('.abyss-chips-row > button'),
    ).find((candidate) => candidate.textContent?.startsWith('📅'))!;
    vi.useFakeTimers();

    try {
      click(chip);
      vi.runOnlyPendingTimers();
      const popover = el.querySelector<HTMLElement>('.abyss-date-popover')!;
      const input = popover.querySelector<HTMLInputElement>('.abyss-date-input')!;
      const clear = popover.querySelector<HTMLButtonElement>('[aria-label="Clear date"]')!;
      expect(ownerDocument.activeElement).toBe(input);

      clear.focus();
      vi.advanceTimersByTime(250);
      expect(el.querySelector('.abyss-date-popover')).toBe(popover);
      expect(ownerDocument.activeElement).toBe(clear);

      outside.focus();
      vi.advanceTimersByTime(250);
      expect(el.querySelector('.abyss-date-popover')).toBeNull();
    } finally {
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('cancels pending date focus-leave cleanup when the panel is destroyed', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    const outside = ownerDocument.createElement('button');
    ownerDocument.body.append(outside);
    state.set('taskStack', [task({ title: 'Date cleanup', planning: { due: '2026-08-11' } })]);
    const chip = Array.from(
      el.querySelectorAll<HTMLButtonElement>('.abyss-chips-row > button'),
    ).find((candidate) => candidate.textContent?.startsWith('📅'))!;
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(ownerDocument.defaultView!, 'clearTimeout');

    try {
      click(chip);
      vi.runOnlyPendingTimers();
      outside.focus();
      clearTimeout.mockClear();

      panel.destroy();

      expect(clearTimeout).toHaveBeenCalledWith(expect.any(Number));
      vi.advanceTimersByTime(250);
      expect(el.querySelector('.abyss-date-popover')).toBeNull();
    } finally {
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('clears a scheduled-only task through the visible Date chip and refreshes the UI', async () => {
    const ref: TaskRef = { filePath: 'f.md', line: 0, revision: 'old' };
    const freshRef: TaskRef = { ...ref, revision: 'fresh' };
    const fresh: TaskSnapshot = {
      ref: freshRef,
      title: 'Scheduled',
      markdownTitle: 'Scheduled',
      status: 'open',
      statusSymbol: ' ',
      priority: 'D',
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      subtasks: [],
      comments: [],
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Scheduled',
        originalBlock: '- [ ] Scheduled',
      },
      presentation: { linkCount: 0 },
    };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: fresh },
    });
    const tasks: TaskApplicationApi = {
      queries: taskQueryApi(),
      execute,
    };
    const { state, el } = await makePanel({ 'f.md': '- [ ] Scheduled ⏳ 2026-07-05\n' }, tasks);
    state.set('taskStack', [
      Object.assign(
        task({
          title: 'Scheduled',
          planning: { due: undefined, scheduled: '2026-07-05' },
          source: {
            filePath: 'f.md',
            originalMarkdown: '- [ ] Scheduled ⏳ 2026-07-05',
            originalBlock: '- [ ] Scheduled ⏳ 2026-07-05',
          },
        }),
        { ref },
      ),
    ]);

    const dateChip = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-chips-row .abyss-chip'),
    ).find((chip) => chip.textContent?.startsWith('📅'));
    expect(dateChip).toBeDefined();
    click(dateChip!);
    click(el.querySelector<HTMLElement>('.abyss-popover-clear-icon-btn')!);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { scheduled: { type: 'clear' } },
    });
    expect(el2Text(el, '.abyss-chips-row .abyss-chip')).toContain('Date');
    expect(el.querySelector('.abyss-chip-scheduled')).toBeNull();
  });

  it('time chip click → popover has both a time input and a duration input', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'T',
        planning: { time: '15:00', duration: 90 },
        source: {
          originalMarkdown: '- [ ] T ⏰ 15:00 ⏱️ 1h30m',
          originalBlock: '- [ ] T ⏰ 15:00 ⏱️ 1h30m',
        },
      }),
    ]);
    const chip = el.querySelector<HTMLElement>('.abyss-chip-time')!;
    click(chip);
    expect(el.querySelector('.abyss-time-popover')).not.toBeNull();
    const timeInput = el.querySelector<HTMLInputElement>('.abyss-time-input')!;
    expect(timeInput.value).toBe('15:00');
    const durationInput = el.querySelector<HTMLInputElement>('.abyss-duration-input')!;
    expect(durationInput).not.toBeNull();
    expect(durationInput.value).toBe('1h30m');
    panel.destroy();
  });

  it('owns Escape in the mounted document and restores focus from the time popover', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    state.set('taskStack', [task({ title: 'Keyboard time', planning: { time: '09:15' } })]);
    const chip = el.querySelector<HTMLButtonElement>('.abyss-chip-time')!;
    const escapedToDocument = vi.fn();
    ownerDocument.addEventListener('keydown', escapedToDocument);

    try {
      chip.focus();
      click(chip);
      await tick();
      const popover = el.querySelector<HTMLElement>('.abyss-time-popover')!;
      const input = popover.querySelector<HTMLInputElement>('.abyss-time-input')!;
      expect(ownerDocument.activeElement).toBe(input);

      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(escapedToDocument).not.toHaveBeenCalled();
      expect(el.querySelector('.abyss-time-popover')).toBeNull();
      expect(ownerDocument.activeElement).toBe(chip);
    } finally {
      ownerDocument.removeEventListener('keydown', escapedToDocument);
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('keeps the time popover open while focus traverses its controls beyond the blur delay', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    const outside = ownerDocument.createElement('button');
    outside.textContent = 'Outside';
    ownerDocument.body.append(outside);
    state.set('taskStack', [
      task({ title: 'Keyboard traversal', planning: { time: '09:15', duration: 45 } }),
    ]);
    const chip = el.querySelector<HTMLButtonElement>('.abyss-chip-time')!;
    vi.useFakeTimers();

    try {
      click(chip);
      vi.runOnlyPendingTimers();
      const popover = el.querySelector<HTMLElement>('.abyss-time-popover')!;
      const timeInput = popover.querySelector<HTMLInputElement>('.abyss-time-input')!;
      const clearTime = popover.querySelector<HTMLButtonElement>('[aria-label="Clear time"]')!;
      const durationInput = popover.querySelector<HTMLInputElement>('.abyss-duration-input')!;
      const clearDuration = popover.querySelector<HTMLButtonElement>(
        '[aria-label="Clear duration"]',
      )!;

      expect(ownerDocument.activeElement).toBe(timeInput);
      for (const control of [clearTime, durationInput, clearDuration]) {
        control.focus();
        vi.advanceTimersByTime(250);
        expect(el.querySelector('.abyss-time-popover')).toBe(popover);
        expect(ownerDocument.activeElement).toBe(control);
      }

      outside.focus();
      vi.advanceTimersByTime(250);
      expect(el.querySelector('.abyss-time-popover')).toBeNull();
    } finally {
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('exposes truthful popup roles and expanded state on every RightPanel overlay trigger', async () => {
    const { panel, state, el, app } = await makePanel();
    activeDocument.body.append(el);
    Object.defineProperty(app.metadataCache, 'getTags', {
      configurable: true,
      value: () => ({ '#alpha': 1 }),
    });
    state.set('taskStack', [task({ title: 'Overlay roles' })]);

    const inlineTagTrigger = Array.from(
      el.querySelectorAll<HTMLButtonElement>('.abyss-chip-add'),
    ).find((candidate) => candidate.textContent === '+ tag')!;
    const cases = [
      [
        el.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!,
        '.abyss-task-context-menu',
        'menu',
      ],
      [el.querySelector<HTMLButtonElement>('.abyss-chip-time')!, '.abyss-time-popover', 'dialog'],
      [inlineTagTrigger, '.abyss-tag-dropdown', 'listbox'],
      [
        el.querySelector<HTMLButtonElement>('.abyss-chip-add-date')!,
        '.abyss-add-date-menu',
        'menu',
      ],
      [
        el.querySelector<HTMLButtonElement>('.abyss-priority-chip')!,
        '.abyss-priority-popover',
        'listbox',
      ],
    ] as const;

    try {
      for (const [trigger, popupSelector, popupRole] of cases) {
        expect(trigger.getAttribute('aria-haspopup')).toBe(popupRole);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        click(trigger);
        const popup = el.querySelector<HTMLElement>(popupSelector)!;
        expect(popup.getAttribute('role')).toBe(popupRole);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');

        click(trigger);
        expect(el.querySelector(popupSelector)).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
      }
    } finally {
      panel.destroy();
      el.remove();
    }
  });

  it('updates the +date trigger while its menu hands ownership to the date dialog', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    state.set('taskStack', [task({ title: 'Add a date' })]);
    const trigger = el.querySelector<HTMLButtonElement>('.abyss-chip-add-date')!;

    try {
      click(trigger);
      click(el.querySelector<HTMLElement>('.abyss-add-date-menu-item')!);
      const dialog = el.querySelector<HTMLElement>('.abyss-date-popover')!;

      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      dialog.querySelector<HTMLInputElement>('.abyss-date-input')!.dispatchEvent(
        new ownerDocument.defaultView!.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(el.querySelector('.abyss-date-popover')).toBeNull();
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('owns inline-tag Escape/outside/toggle/rerender/destroy cleanup in its mounted document', async () => {
    const { panel, state, el, app } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    const outside = ownerDocument.createElement('button');
    outside.textContent = 'Outside';
    ownerDocument.body.append(outside);
    Object.defineProperty(app.metadataCache, 'getTags', {
      configurable: true,
      value: () => ({ '#alpha': 1, '#beta': 1 }),
    });
    const escapedToDocument = vi.fn();
    ownerDocument.addEventListener('keydown', escapedToDocument);
    state.set('taskStack', [task({ title: 'Tag lifecycle' })]);

    const trigger = (): HTMLButtonElement =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('.abyss-chip-add')).find(
        (candidate) => candidate.textContent === '+ tag',
      )!;

    try {
      const escapeTrigger = trigger();
      escapeTrigger.focus();
      click(escapeTrigger);
      const input = el.querySelector<HTMLInputElement>('.abyss-tag-input')!;
      expect(ownerDocument.activeElement).toBe(input);
      const escape = new ownerDocument.defaultView!.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(escapedToDocument).not.toHaveBeenCalled();
      expect(el.querySelector('.abyss-tag-dropdown-wrap')).toBeNull();
      expect(escapeTrigger.getAttribute('aria-expanded')).toBe('false');
      expect(ownerDocument.activeElement).toBe(escapeTrigger);

      click(escapeTrigger);
      await tick();
      click(outside);
      expect(el.querySelector('.abyss-tag-dropdown-wrap')).toBeNull();
      expect(escapeTrigger.getAttribute('aria-expanded')).toBe('false');

      click(escapeTrigger);
      click(escapeTrigger);
      expect(el.querySelector('.abyss-tag-dropdown-wrap')).toBeNull();
      expect(escapeTrigger.getAttribute('aria-expanded')).toBe('false');
      expect(escapeTrigger.classList.contains('abyss-chip-add--hidden')).toBe(false);

      click(escapeTrigger);
      const rerenderedSurface = el.querySelector<HTMLElement>('.abyss-tag-dropdown-wrap')!;
      state.set('taskStack', [task({ title: 'Rerendered tag lifecycle' })]);
      expect(rerenderedSurface.isConnected).toBe(false);
      expect(escapeTrigger.getAttribute('aria-expanded')).toBe('false');

      const destroyTrigger = trigger();
      click(destroyTrigger);
      const destroyedSurface = el.querySelector<HTMLElement>('.abyss-tag-dropdown-wrap')!;
      panel.destroy();
      expect(destroyedSurface.isConnected).toBe(false);
      expect(destroyTrigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      ownerDocument.removeEventListener('keydown', escapedToDocument);
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('editing the duration input sends one validated duration patch', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] T ⏰ 15:00' });
    const state = new AppState();
    const ref: TaskRef = { filePath: 'f.md', line: 0, revision: 'r' };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref },
    });
    const tasks: TaskApplicationApi = {
      queries: taskQueryApi(),
      execute,
    };
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
    );
    const el = freshContainer();
    panel.mount(el);
    state.set('taskStack', [
      Object.assign(
        task({
          title: 'T',
          planning: { time: '15:00', duration: undefined },
          source: {
            filePath: 'f.md',
            line: 0,
            originalMarkdown: '- [ ] T ⏰ 15:00',
            originalBlock: '- [ ] T ⏰ 15:00',
          },
        }),
        { ref },
      ),
    ]);
    const chip = el.querySelector<HTMLElement>('.abyss-chip-time')!;
    click(chip);
    const durationInput = el.querySelector<HTMLInputElement>('.abyss-duration-input')!;
    durationInput.value = '2h';
    durationInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { duration: { type: 'set', value: 120 } },
    });
  });

  it('the duration input does not render for a SubTask (no duration field)', async () => {
    const { state, el } = await makePanel();
    const sub = subtask({
      title: 'sub',
      planning: { time: '09:00' },
      ref: { originalBlock: '  - [ ] sub ⏰ 09:00' },
    });
    const parent = task({ title: 'Parent', subtasks: [sub] });
    state.set('taskStack', [parent, parent.subtasks[0]!]);
    const chip = el.querySelector<HTMLElement>('.abyss-chip-time')!;
    click(chip);
    expect(el.querySelector('.abyss-time-popover')).not.toBeNull();
    expect(el.querySelector('.abyss-duration-input')).toBeNull();
  });

  it('priority chip click → priority popover appears with options', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    const chip = el.querySelector<HTMLElement>('.abyss-priority-chip')!;
    click(chip);
    const pop = el.querySelector('.abyss-priority-popover');
    expect(pop).not.toBeNull();
    expect(pop?.querySelectorAll('.abyss-priority-option').length).toBe(6);
    panel.destroy();
  });

  it('priority popover options use the shared menu option structure', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'F' })]);
    const chip = el.querySelector<HTMLElement>('.abyss-priority-chip')!;
    click(chip);

    const active = el.querySelector<HTMLElement>('.abyss-priority-option.is-active');

    const children = Array.from(active?.children ?? []).map((el) => el.className);

    expect(children).toEqual([
      'abyss-priority-option-check',
      'abyss-priority-option-flag',
      'abyss-priority-option-label',
    ]);
    expect(active?.querySelector('.abyss-priority-option-flag')).not.toBeNull();
    expect(active?.querySelector('.abyss-priority-option-label')?.textContent).toBe('Lowest');
    expect(active?.querySelector('.abyss-priority-option-check')).not.toBeNull();
    panel.destroy();
  });

  it('moves focus into the selected priority option and owns Escape dismissal', async () => {
    const { panel, state, el } = await makePanel();
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    state.set('taskStack', [task({ title: 'Keyboard priority', priority: 'F' })]);
    const chip = el.querySelector<HTMLButtonElement>('.abyss-priority-chip')!;
    const escapedToDocument = vi.fn();
    ownerDocument.addEventListener('keydown', escapedToDocument);

    try {
      chip.focus();
      click(chip);
      const popover = el.querySelector<HTMLElement>('.abyss-priority-popover')!;
      const selected = popover.querySelector<HTMLButtonElement>(
        '.abyss-priority-option.is-active',
      )!;

      expect(popover.contains(ownerDocument.activeElement)).toBe(true);
      expect(ownerDocument.activeElement).toBe(selected);

      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      selected.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(escapedToDocument).not.toHaveBeenCalled();
      expect(el.querySelector('.abyss-priority-popover')).toBeNull();
      expect(ownerDocument.activeElement).toBe(chip);

      click(chip);
      const highest = el.querySelector<HTMLButtonElement>(
        '.abyss-priority-option[data-priority="A"]',
      )!;
      click(highest);
      expect(el.querySelector('.abyss-priority-popover')).toBeNull();
      expect(ownerDocument.activeElement).toBe(chip);
    } finally {
      ownerDocument.removeEventListener('keydown', escapedToDocument);
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('converts viewport placement to a bordered and scrolled panel padding box', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    const chip = el.querySelector<HTMLElement>('.abyss-priority-chip')!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 50, 300, 240),
    });
    Object.defineProperties(el, {
      clientLeft: { configurable: true, value: 3 },
      clientTop: { configurable: true, value: 5 },
      scrollLeft: { configurable: true, value: 11 },
      scrollTop: { configurable: true, value: 13 },
    });
    Object.defineProperty(chip, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(370, 80, 20, 20),
    });
    const real = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('abyss-priority-popover')) return rect(0, 0, 120, 80);
        return real.call(this);
      });

    click(chip);

    const popover = el.querySelector<HTMLElement>('.abyss-priority-popover')!;
    expect(popover.parentElement).toBe(el);
    expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe('180px');
    expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('62px');
    panel.destroy();
    measure.mockRestore();
  });

  it.each([
    ['date', '.abyss-chips-row .abyss-chip', '.abyss-date-popover', 180],
    ['time and duration', '.abyss-chip-time', '.abyss-time-popover', 180],
    ['priority', '.abyss-priority-chip', '.abyss-priority-popover', 180],
    ['add date', '.abyss-chip-add-date', '.abyss-add-date-menu', 180],
    ['task actions', '[aria-label="More actions"]', '.abyss-task-context-menu', 88],
  ] as const)(
    'anchors every floating task surface to its actual containing block: %s',
    async (_surface, triggerSelector, popoverSelector, expectedLeft) => {
      const { panel, state, el } = await makePanel();
      const containingBlock = el.ownerDocument.createElement('div');
      el.ownerDocument.body.append(containingBlock);
      containingBlock.append(el);
      state.set('taskStack', [
        task({
          title: 'Anchored',
          priority: 'B',
          planning: { due: '2026-07-14', time: '09:15', duration: 45 },
        }),
      ]);
      Object.defineProperties(el, {
        clientLeft: { configurable: true, value: 3 },
        clientTop: { configurable: true, value: 5 },
        scrollLeft: { configurable: true, value: 11 },
        scrollTop: { configurable: true, value: 13 },
      });
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect(100, 50, 300, 240),
      });
      Object.defineProperties(containingBlock, {
        clientLeft: { configurable: true, value: 7 },
        clientTop: { configurable: true, value: 4 },
        scrollLeft: { configurable: true, value: 17 },
        scrollTop: { configurable: true, value: 19 },
      });
      Object.defineProperty(containingBlock, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect(30, 20, 500, 400),
      });
      const trigger = el.querySelector<HTMLElement>(triggerSelector)!;
      Object.defineProperty(trigger, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect(200, 100, 20, 20),
      });
      const realRect = HTMLElement.prototype.getBoundingClientRect;
      const measure = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (this.matches(popoverSelector)) return rect(0, 0, 120, 80);
          return realRect.call(this);
        });
      const offsetParent = vi
        .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
        .mockImplementation(function (this: HTMLElement) {
          if (this.matches('.abyss-popover-anchored')) return containingBlock;
          return null;
        });

      try {
        click(trigger);

        const popover = el.querySelector<HTMLElement>(popoverSelector)!;
        expect(popover.offsetParent).toBe(containingBlock);
        expect(popover.offsetParent).not.toBe(el);
        expect(popover.style.getPropertyValue('--abyss-pop-left')).toBe(`${expectedLeft}px`);
        expect(popover.style.getPropertyValue('--abyss-pop-top')).toBe('119px');

        // `--abyss-popover-anchor-gap: 0.25rem` resolves to the configured 4px gap.
        const viewportTop =
          Number.parseFloat(popover.style.getPropertyValue('--abyss-pop-top')) + 20 + 4 - 19;
        expect(viewportTop - 120).toBe(4);
      } finally {
        offsetParent.mockRestore();
        measure.mockRestore();
        panel.destroy();
        containingBlock.remove();
      }
    },
  );

  it('removes anchored-surface resize and scroll listeners when the panel is destroyed', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    const ownerDocument = el.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    const removeWindowListener = vi.spyOn(ownerWindow, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(ownerDocument, 'removeEventListener');

    click(el.querySelector<HTMLElement>('.abyss-priority-chip')!);
    panel.destroy();

    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });

  it('cancels deferred priority dismissal when another owned surface replaces it', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    vi.useFakeTimers();
    const addListener = vi.spyOn(el.ownerDocument, 'addEventListener');

    click(el.querySelector<HTMLElement>('.abyss-priority-chip')!);
    click(el.querySelector<HTMLElement>('.abyss-chip-time')!);
    vi.runOnlyPendingTimers();

    const installedDismissals = addListener.mock.calls.filter(
      ([type, , options]) => type === 'click' && options === true,
    );
    expect(installedDismissals).toHaveLength(1);
    expect(el.querySelector('.abyss-priority-popover')).toBeNull();
    expect(el.querySelector('.abyss-time-popover')).not.toBeNull();
  });

  it('does not install priority dismissal after destroy before the timer', async () => {
    const { panel, state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    vi.useFakeTimers();
    const addListener = vi.spyOn(el.ownerDocument, 'addEventListener');

    click(el.querySelector<HTMLElement>('.abyss-priority-chip')!);
    panel.destroy();
    vi.runOnlyPendingTimers();

    expect(
      addListener.mock.calls.some(([type, , options]) => type === 'click' && options === true),
    ).toBe(false);
  });

  it('removes an installed priority dismissal listener when render replaces the surface', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    vi.useFakeTimers();
    const addListener = vi.spyOn(el.ownerDocument, 'addEventListener');
    const removeListener = vi.spyOn(el.ownerDocument, 'removeEventListener');

    click(el.querySelector<HTMLElement>('.abyss-priority-chip')!);
    vi.runOnlyPendingTimers();
    const dismissalListener = addListener.mock.calls.find(
      ([type, , options]) => type === 'click' && options === true,
    )?.[1];
    state.set('taskStack', [task({ title: 'Replacement', priority: 'C' })]);

    expect(dismissalListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith('click', dismissalListener, true);
  });

  it('outside click dismisses the priority popover', async () => {
    const { panel, state, el } = await makePanel();
    activeDocument.body.append(el);
    state.set('taskStack', [task({ title: 'P', priority: 'B' })]);
    const chip = el.querySelector<HTMLElement>('.abyss-priority-chip')!;
    click(chip);
    expect(el.querySelector('.abyss-priority-popover')).not.toBeNull();
    // The outside-click listener is registered via setTimeout(0); wait for it.
    await tick(5);
    // Click on an unrelated element (the title view) — bubbles to el → once:click removes pop.
    const title = el.querySelector<HTMLElement>('.abyss-right-title-view')!;
    click(title);
    expect(el.querySelector('.abyss-priority-popover')).toBeNull();
    panel.destroy();
    el.remove();
  });
});

describe('RightPanel Start/Plan badges (round-pill, unified with due/time/priority)', () => {
  it('unset Start and Plan render NO placeholder badges in the top chip row; a "+" control is offered instead', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({ title: 'Dated', planning: { due: '2026-06-25', duration: undefined } }),
    ]);
    // No placeholder pills for unset Start/Plan clutter the main row any more.
    expect(el.querySelector('.abyss-chip-start')).toBeNull();
    expect(el.querySelector('.abyss-chip-scheduled')).toBeNull();
    // No separate "Planning" disclosure exists any more — fully unified into the top row.
    expect(el.querySelector('.abyss-planning-section')).toBeNull();
    // Compact "+"-style control, mirroring the "+ tag" button's pattern.
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date');
    expect(addBtn).not.toBeNull();
  });

  it('a task with scheduled set shows a value-bearing (non-empty) scheduled badge in the top row', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'Sched',
        planning: { due: undefined, scheduled: '2026-07-05', duration: undefined },
      }),
    ]);
    const chip = el.querySelector('.abyss-chip-scheduled');
    expect(chip?.textContent).toContain('5 Jul');
    expect(chip?.classList.contains('abyss-chip-empty')).toBe(false);
  });

  it('a task with start set shows a value-bearing (non-empty) start badge in the top row', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'Started',
        planning: { due: undefined, start: '2026-07-05', duration: undefined },
      }),
    ]);
    const chip = el.querySelector('.abyss-chip-start');
    expect(chip?.textContent).toContain('5 Jul');
    expect(chip?.classList.contains('abyss-chip-empty')).toBe(false);
  });

  it('the "+" control\'s menu offers both Start and Plan when neither is set', async () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    const { state, el, panel } = await makePanel();
    ownerDocument.body.append(ownerDocument.adoptNode(el));
    state.set('taskStack', [
      task({ title: 'Dated', planning: { due: '2026-06-25', duration: undefined } }),
    ]);
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date')!;
    try {
      addBtn.focus();
      click(addBtn);
      const menu = el.querySelector<HTMLElement>('.abyss-add-date-menu')!;
      const firstItem = menu.querySelector<HTMLElement>('.abyss-add-date-menu-item')!;
      expect(menu.getAttribute('role')).toBe('menu');
      expect(firstItem.getAttribute('role')).toBe('menuitem');
      expect(firstItem.tabIndex).toBe(0);
      expect(ownerDocument.activeElement).toBe(firstItem);
      expect(menu.textContent).toContain('Start');
      expect(menu.textContent).toContain('Plan');

      firstItem.dispatchEvent(
        new ownerDocument.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      expect(el.querySelector('.abyss-add-date-menu')).toBeNull();
      expect(ownerDocument.activeElement).toBe(addBtn);
    } finally {
      panel.destroy();
      el.remove();
      frame.remove();
    }
  });

  it('keeps a wrapped left-edge "+ date" chooser inside a narrow panel as a compact child surface', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({ title: 'Dated', planning: { due: '2026-06-25', duration: undefined } }),
    ]);
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date')!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(100, 40, 180, 280),
    });
    Object.defineProperty(addBtn, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(96, 120, 50, 24),
    });
    const real = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('abyss-add-date-menu')) return rect(0, 0, 90, 72);
        return real.call(this);
      });

    click(addBtn);

    const menu = el.querySelector<HTMLElement>('.abyss-add-date-menu')!;
    expect(menu.parentElement).toBe(el);
    expect(addBtn.contains(menu)).toBe(false);
    expect(menu.classList.contains('abyss-add-date-menu--compact')).toBe(true);
    expect(menu.style.getPropertyValue('--abyss-pop-left')).toBe('8px');
    expect(
      Array.from(menu.querySelectorAll('.abyss-add-date-menu-item')).map(
        (item) => item.textContent,
      ),
    ).toEqual(['🛫 Start', '⏳ Plan']);
    measure.mockRestore();
  });

  it('the "+" control\'s menu offers only the currently-unset field when the other is already set', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'Sched',
        planning: { due: undefined, scheduled: '2026-07-05', duration: undefined },
      }),
    ]);
    // Plan is set, so it renders as a normal pill and is no longer offered in the menu.
    expect(el.querySelector('.abyss-chip-scheduled')).not.toBeNull();
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date')!;
    click(addBtn);
    const menu = el.querySelector('.abyss-add-date-menu');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Start');
    expect(menu?.textContent).not.toContain('Plan');
  });

  it('the "+" control does not render once both Start and Plan are set', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({
        title: 'Both',
        planning: { start: '2026-07-01', scheduled: '2026-07-05', duration: undefined },
      }),
    ]);
    expect(el.querySelector('.abyss-chip-add-date')).toBeNull();
  });

  it('Space on "Start" in the "+" menu opens the shared date popover', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({ title: 'Dated', planning: { due: '2026-06-25', duration: undefined } }),
    ]);
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date')!;
    click(addBtn);
    const startOption = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-add-date-menu-item'),
    ).find((o) => o.textContent?.includes('Start'))!;
    startOption.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    const popover = el.querySelector('.abyss-date-popover');
    expect(popover).not.toBeNull();
    expect(popover?.querySelector('input[type="date"]')).not.toBeNull();
  });

  it('clicking "Plan" in the "+" menu opens the same date popover style used for the due-date chip', async () => {
    const { state, el } = await makePanel();
    state.set('taskStack', [
      task({ title: 'Dated', planning: { due: '2026-06-25', duration: undefined } }),
    ]);
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date')!;
    click(addBtn);
    const planOption = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-add-date-menu-item'),
    ).find((o) => o.textContent?.includes('Plan'))!;
    click(planOption);
    const popover = el.querySelector('.abyss-date-popover');
    expect(popover).not.toBeNull();
    expect(popover?.querySelector('input[type="date"]')).not.toBeNull();
  });

  it('setting a Start date via the "+" menu delegates a typed planning command', async () => {
    const ref: TaskRef = { filePath: 'f.md', line: 0, revision: 'revision' };
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'not-found',
      target: { type: 'task', ref },
    });
    const tasks: TaskApplicationApi = {
      queries: taskQueryApi(),
      execute,
    };
    const { state, app, el } = await makePanel({ 'f.md': '- [ ] Dated 📅 2026-06-25\n' }, tasks);
    state.set('taskStack', [
      Object.assign(
        task({
          title: 'Dated',
          planning: { due: '2026-06-25', duration: undefined },
          source: {
            filePath: 'f.md',
            line: 0,
            originalMarkdown: '- [ ] Dated 📅 2026-06-25',
            originalBlock: '- [ ] Dated 📅 2026-06-25',
          },
        }),
        { ref },
      ),
    ]);
    const addBtn = el.querySelector<HTMLElement>('.abyss-chip-add-date')!;
    click(addBtn);
    const startOption = Array.from(
      el.querySelectorAll<HTMLElement>('.abyss-add-date-menu-item'),
    ).find((o) => o.textContent?.includes('Start'))!;
    click(startOption);
    const input = el.querySelector<HTMLInputElement>('.abyss-date-popover .abyss-date-input')!;
    input.value = '2026-07-01';
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledWith({
      type: 'patch',
      target: { type: 'task', ref },
      patch: { start: { type: 'set', value: '2026-07-01' } },
    });
    expect(await readMd(app, 'f.md')).toBe('- [ ] Dated 📅 2026-06-25\n');
  });

  it('a SubTask (no duration field) offers the "+" control for its own unset Start/Plan — not gated on the removed Planning disclosure', async () => {
    const { state, el } = await makePanel();
    const sub = subtask({
      title: 'sub-thing',
      planning: { due: '2026-07-10' }, // a real sub-item can carry its own 📅 date
      ref: { originalBlock: '  - [ ] sub-thing 📅 2026-07-10' },
    });
    // Drill into the sub-task directly, the same way clicking its label would.
    const parent = task({ title: 'Parent', subtasks: [sub] });
    state.set('taskStack', [parent, parent.subtasks[0]!]);
    expect(el.querySelector('.abyss-planning-section')).toBeNull();
    expect(el.querySelector('.abyss-chip-start')).toBeNull();
    expect(el.querySelector('.abyss-chip-scheduled')).toBeNull();
    expect(el.querySelector('.abyss-chip-add-date')).not.toBeNull();
  });

  it('time chip keeps the alarm marker and exposes exact empty, time, and duration states', async () => {
    const emptyPanel = await makePanel();
    emptyPanel.state.set('taskStack', [task({ title: 'Empty time' })]);
    const empty = emptyPanel.el.querySelector<HTMLButtonElement>('.abyss-chip-time')!;
    expect(empty.textContent).toBe('⏰ Time');
    expect(empty.getAttribute('aria-label')).toBe('Set time and duration');

    const withBothPanel = await makePanel();
    withBothPanel.state.set('taskStack', [
      task({ title: 'TD', planning: { time: '15:00', duration: 90 } }),
    ]);
    const withBoth = withBothPanel.el.querySelector<HTMLButtonElement>('.abyss-chip-time')!;
    expect(withBoth.textContent).toBe('⏰ 15:00 · 1h30m');
    expect(withBoth.getAttribute('aria-label')).toBe(
      'Change time, currently 15:00, duration 90 minutes',
    );

    const timeOnlyPanel = await makePanel();
    timeOnlyPanel.state.set('taskStack', [task({ title: 'T', planning: { time: '15:00' } })]);
    const timeOnly = timeOnlyPanel.el.querySelector<HTMLButtonElement>('.abyss-chip-time')!;
    expect(timeOnly.textContent).toBe('⏰ 15:00');
    expect(timeOnly.getAttribute('aria-label')).toBe('Change time, currently 15:00, no duration');
  });
});
