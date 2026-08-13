import { TFile, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import type { TaskCommandResult, TaskIndexEvent, TaskQueryApi, TaskRef } from '../src/tasks';
import { taskNodeLine } from '../src/ui/taskSelection';
import { MonthGridView } from '../src/views/MonthGridView';
import { PANEL_VIEW_TYPE, PanelView } from '../src/views/PanelView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  flushMicrotasks,
  seedTaskCache,
  useRealMoment,
} from './helpers';

function makeTagManager(app: App): TagManager {
  const save = vi.fn().mockResolvedValue(undefined);
  return new TagManager(app, DEFAULT_SETTINGS, save);
}

useRealMoment();

function emitQueryEvent(queries: TaskQueryApi, event: TaskIndexEvent): void {
  const source = queries as unknown as {
    listeners: Array<(published: TaskIndexEvent) => void>;
  };
  for (const listener of [...source.listeners]) listener(event);
}

type TaskApplication = ReturnType<typeof configuredTaskApplication>;

describe('PanelView', () => {
  describe('empty vault suite', () => {
    let app: Awaited<ReturnType<typeof createAppWithFiles>>;
    let taskApplication: TaskApplication;
    let leaf: WorkspaceLeaf;
    let view: PanelView;
    let tagManager: TagManager;

    beforeEach(async () => {
      app = await createAppWithFiles({});
      taskApplication = configuredTaskApplication(app, DEFAULT_SETTINGS);
      await taskApplication.index.initialize();
      await flushMicrotasks();
      leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
      tagManager = makeTagManager(app);
      view = new PanelView(
        leaf,
        DEFAULT_SETTINGS,
        tagManager,
        taskApplication.index,
        taskApplication.tasks,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('adds tc-panel-view class to contentEl', () => {
      expect(view.contentEl.classList.contains('tc-panel-view')).toBe(true);
    });

    it('creates tc-layout with 4 zones', () => {
      const layout = view.contentEl.querySelector('.tc-layout');
      expect(layout).not.toBeNull();
      expect(layout?.querySelector('.tc-rail')).not.toBeNull();
      expect(layout?.querySelector('.tc-left')).not.toBeNull();
      expect(layout?.querySelector('.tc-center')).not.toBeNull();
      expect(layout?.querySelector('.tc-right')).not.toBeNull();
    });

    it('tc-rail has 4 rail buttons (tasks/projects/calendar/search) + 1 settings button', () => {
      const railBtns = view.contentEl.querySelectorAll('.tc-rail .tc-rail-btn');
      expect(railBtns).toHaveLength(5);
    });

    it('tc-left shows Inbox / Today / Upcoming smart lists', () => {
      const labels = Array.from(view.contentEl.querySelectorAll('.tc-left .tc-left-label')).map(
        (l) => l.textContent,
      );
      expect(labels).toContain('Inbox');
      expect(labels).toContain('Today');
      expect(labels).toContain('Upcoming');
    });

    it('mode change to calendar updates layout class', () => {
      const state = (view as unknown as { state: AppState }).state;
      const layout = view.contentEl.querySelector('.tc-layout') as HTMLElement;
      const before = layout.className;
      state.set('mode', 'calendar');
      expect(layout.className).not.toBe(before);
      expect(layout.className).toContain('tc-layout--calendar');
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
        const state = (view as unknown as { state: AppState }).state;
        state.set('selectedList', { type: 'tag', tag: selected });

        if (scope === 'exact') {
          await tagManager.renameTagExact('#work', '#focus');
        } else {
          await tagManager.renameTagPrefix('#work', '#focus');
        }

        expect(state.get('selectedList')).toEqual({ type: 'tag', tag: expected });
      },
    );

    it('does not change an active group selection during a prefix rename', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const selection = { type: 'group', groupId: 'work-group' } as const;
      state.set('selectedList', selection);

      await tagManager.renameTagPrefix('#work', '#focus');

      expect(state.get('selectedList')).toBe(selection);
    });

    it('detaches the selected-list rename boundary when the panel closes', async () => {
      const state = (view as unknown as { state: AppState }).state;
      await view.onClose();
      state.set('selectedList', { type: 'tag', tag: '#work/deep' });

      await tagManager.renameTagPrefix('#work', '#focus');

      expect(state.get('selectedList')).toEqual({ type: 'tag', tag: '#work/deep' });
    });

    it('query update with empty taskStack → no error', () => {
      const state = (view as unknown as { state: AppState }).state;
      state.set('taskStack', []);
      expect(() =>
        emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] }),
      ).not.toThrow();
    });

    it('recomputes rendered tag contrast when Obsidian emits css-change', () => {
      const panels = view as unknown as { center: { refresh(): void } };
      const refresh = vi.spyOn(panels.center, 'refresh');
      app.workspace.trigger('css-change');
      expect(refresh).toHaveBeenCalledOnce();
    });

    it('lets CenterPanel own the sole calendar patch while PanelView refreshes only LeftPanel', () => {
      const state = (view as unknown as { state: AppState }).state;
      const panels = view as unknown as {
        left: { refresh(): void };
        center: { refresh(): void };
      };
      state.set('mode', 'calendar');
      const leftRefresh = vi.spyOn(panels.left, 'refresh');
      const centerRefresh = vi.spyOn(panels.center, 'refresh');
      const calendarPatch = vi.spyOn(MonthGridView.prototype, 'patch');

      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['x.md'] });

      expect(leftRefresh).toHaveBeenCalledOnce();
      expect(centerRefresh).not.toHaveBeenCalled();
      expect(calendarPatch).toHaveBeenCalledOnce();
    });

    it.each(['tasks', 'search', 'projects'] as const)(
      'keeps PanelView center.refresh ownership in %s mode',
      (mode) => {
        const state = (view as unknown as { state: AppState }).state;
        const panels = view as unknown as {
          left: { refresh(): void };
          center: { refresh(): void };
        };
        state.set('mode', mode);
        const leftRefresh = vi.spyOn(panels.left, 'refresh');
        const centerRefresh = vi.spyOn(panels.center, 'refresh');

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
      const state = (view as unknown as { state: AppState }).state;
      const layout = view.contentEl.querySelector('.tc-layout') as HTMLElement;
      const before = layout.className;
      await view.onClose();
      state.set('mode', 'search'); // different value
      expect(layout.className).toBe(before); // listener removed → no change
    });

    it('getViewType returns task-calendar-panel', () => {
      expect(view.getViewType()).toBe(PANEL_VIEW_TYPE);
    });

    it('getDisplayText returns "Task calendar"', () => {
      expect(view.getDisplayText()).toBe('Task calendar');
    });

    it('getIcon returns calendar-days', () => {
      expect(view.getIcon()).toBe('calendar-days');
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
        taskApplication.tasks,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('query update matching root task path → taskStack replaced with fresh task', () => {
      const state = (view as unknown as { state: AppState }).state;
      const tasks = taskApplication.index.list();
      const root = tasks[0]!;
      state.set('taskStack', [root]);
      emitQueryEvent(taskApplication.index, {
        type: 'changed',
        files: [root.source.filePath],
      });
      const stack = state.get('taskStack');
      expect(stack).toHaveLength(1);
      expect(stack[0] && 'source' in stack[0] ? stack[0].source.filePath : undefined).toBe(
        root.source.filePath,
      );
    });

    it('query update with non-matching changedFile → taskStack unchanged', () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const before = state.get('taskStack');
      emitQueryEvent(taskApplication.index, { type: 'changed', files: ['other.md'] });
      expect(state.get('taskStack')).toBe(before);
    });

    it('query update when root task deleted → taskStack reset to []', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (!file) throw new Error('root task file missing');
      await app.vault.delete(file);
      await flushMicrotasks();
      expect(state.get('taskStack')).toHaveLength(0);
    });

    it('keeps the selected task and dirty draft on the fresh ref across a vault rename', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const comment = view.contentEl.querySelector<HTMLTextAreaElement>('.tc-comment-input')!;
      comment.value = 'rename-safe panel draft';
      comment.focus();
      const file = app.vault.getAbstractFileByPath(root.source.filePath);
      if (!file) throw new Error('root task file missing');

      await app.vault.rename(file, 'renamed.md');
      await flushMicrotasks();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(state.get('taskStack')[0]).toMatchObject({
        ref: { filePath: 'renamed.md' },
        source: { filePath: 'renamed.md' },
      });
      const restored = view.contentEl.querySelector<HTMLTextAreaElement>('.tc-comment-input')!;
      expect(restored.value).toBe('rename-safe panel draft');
      expect(view.contentEl.querySelector('.tc-detached-draft')).toBeNull();
    });

    it('consumes an actual submitted comment across the service/index early event', async () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      const observedResolutions: unknown[] = [];
      const off = taskApplication.index.subscribe((event) => {
        if (event.type === 'changed') {
          observedResolutions.push(taskApplication.index.resolve(root.ref));
        }
      });
      const input = view.contentEl.querySelector<HTMLTextAreaElement>('.tc-comment-input')!;
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
      expect(view.contentEl.querySelector<HTMLTextAreaElement>('.tc-comment-input')?.value).toBe(
        '',
      );
      expect(view.contentEl.querySelector('.tc-detached-draft')).toBeNull();
      expect(view.contentEl.querySelector('.tc-task-selection-message')).toBeNull();
      off();
    });

    it('clears owned-write acknowledgement when deletion/switch changes the selected root', () => {
      const state = (view as unknown as { state: AppState }).state;
      const root = taskApplication.index.list()[0]!;
      state.set('taskStack', [root]);
      (view as unknown as { acknowledgeOwnWrite(task: typeof root): void }).acknowledgeOwnWrite(
        root,
      );
      state.set('taskStack', []);
      const otherRoot = {
        ...root,
        ref: { filePath: 'other.md', line: 0, revision: 'other-old' },
        source: { ...root.source, filePath: 'other.md', line: 0 },
      };
      state.set('taskStack', [otherRoot]);
      (
        view as unknown as {
          applyResolution(result: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution({ type: 'uncertain', ref: otherRoot.ref });
      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.tc-task-selection-message')).toBeNull();
    });

    it('rejects a late write acknowledgement after selection switched away from its root', () => {
      const state = (view as unknown as { state: AppState }).state;
      const first = taskApplication.index.list()[0]!;
      const firstView = first;
      const secondView = {
        ...firstView,
        ref: { filePath: 'other.md', line: 0, revision: 'second' },
        source: { ...first.source, filePath: 'other.md', line: 0 },
      };
      state.set('taskStack', [firstView]);
      state.set('taskStack', [secondView]);
      (view as unknown as { acknowledgeOwnWrite(ref: typeof first.ref): void }).acknowledgeOwnWrite(
        first.ref,
      );
      state.set('taskStack', [firstView]);
      (
        view as unknown as {
          applyResolution(result: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution({ type: 'uncertain', ref: first.ref });
      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.tc-task-selection-message')).toBeNull();
    });

    it('converges a selected Center or Left command immediately and accepts the next index event', () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
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
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(observed.ref, result);

      expect(state.get('taskStack')[0]).toMatchObject({ title: 'Owned update', ref: updated.ref });
      (
        view as unknown as {
          applyResolution(resolution: { type: 'exact'; task: typeof updated }): void;
        }
      ).applyResolution({ type: 'exact', task: updated });
      expect(view.contentEl.querySelector('.tc-task-selection-stale')).toBeNull();
    });

    it('keeps uncertainty silent when the matching command result wins the race', () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
      const updated = {
        ...observed,
        ref: { ...observed.ref, revision: 'owned-after-conflict' },
        title: 'Owned after conflict',
      };
      state.set('taskStack', [observed]);
      (
        view as unknown as {
          applyResolution(resolution: { type: 'uncertain'; ref: TaskRef }): void;
        }
      ).applyResolution({ type: 'uncertain', ref: observed.ref });
      expect(view.contentEl.querySelector('.tc-task-selection-message')).toBeNull();

      (
        view as unknown as {
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(observed.ref, {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      });

      expect(state.get('taskStack')).toEqual([]);
      expect(view.contentEl.querySelector('.tc-task-selection-stale')).toBeNull();
    });

    it('renders a fresh visual candidate and detaches the stale draft without a message', () => {
      const state = (view as unknown as { state: AppState }).state;
      const observed = taskApplication.index.list()[0]!;
      const current = {
        ...observed,
        ref: { ...observed.ref, revision: 'visual-current' },
        title: 'Visual current',
        markdownTitle: 'Visual current',
      };
      state.set('taskStack', [observed]);
      const comment = view.contentEl.querySelector<HTMLTextAreaElement>('.tc-comment-input')!;
      comment.value = 'stale local draft';

      (
        view as unknown as {
          applyResolution(resolution: {
            type: 'visual';
            stale: TaskRef;
            current: typeof current;
            evidence: 'same-line';
          }): void;
        }
      ).applyResolution({
        type: 'visual',
        stale: observed.ref,
        current,
        evidence: 'same-line',
      });

      expect(state.get('taskStack')[0]).toMatchObject({
        title: 'Visual current',
        ref: current.ref,
      });
      expect(view.contentEl.querySelector('.tc-detached-draft')?.textContent).toContain(
        'stale local draft',
      );
      expect(view.contentEl.querySelector('.tc-task-selection-message')).toBeNull();
    });

    it('does not let a late Center or Left result replace a different selection', () => {
      const state = (view as unknown as { state: AppState }).state;
      const first = taskApplication.index.list()[0]!;
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
      state.set('taskStack', [first]);
      state.set('taskStack', [second]);

      (
        view as unknown as {
          convergeOwnCommand(initiatingRef: TaskRef, result: TaskCommandResult): void;
        }
      ).convergeOwnCommand(first.ref, {
        type: 'ok',
        outcome: { type: 'task', task: updated },
        changed: true,
      });

      expect(state.get('taskStack')[0]).toBe(second);
    });

    it('refresh updates left panel count badges after index change (DOM assertion)', async () => {
      // Initial: one open task due today → Today count badge = "1"
      const left = view.contentEl.querySelector('.tc-left') as HTMLElement;
      const todayItem = Array.from(left.querySelectorAll('.tc-left-item')).find(
        (el) => el.querySelector('.tc-left-label')?.textContent === 'Today',
      ) as HTMLElement | undefined;
      expect(todayItem?.querySelector('.tc-left-count')?.textContent).toBe('1');
      // Toggle the task done via file mutation (simulates an external vault edit).
      const file = app.vault.getMarkdownFiles()[0]!;
      await app.vault.process(file, (data) => data.replace('- [ ]', '- [x]'));
      await flushMicrotasks();
      // After refresh: no open tasks due today → Today count badge absent (count 0 → not rendered)
      const todayItemAfter = Array.from(left.querySelectorAll('.tc-left-item')).find(
        (el) => el.querySelector('.tc-left-label')?.textContent === 'Today',
      ) as HTMLElement | undefined;
      expect(todayItemAfter?.querySelector('.tc-left-count')?.textContent ?? '0').toBe('0');
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
        taskApplication.tasks,
        taskApplication.statusRegistry,
      );
      await view.onOpen();
    });

    afterEach(async () => {
      await view.onClose();
      taskApplication.index.destroy();
    });

    it('exact resolution rebuilds a deep stack with the fresh subtask', () => {
      const state = (view as unknown as { state: AppState }).state;
      const tasks = taskApplication.index.list();
      const root = tasks[0]!;
      const sub = root.subtasks[0];
      expect(sub).toBeDefined();
      // Set a 2-level stack: [root, subtask]
      state.set('taskStack', [root, sub!]);
      const snapshot = taskApplication.index.list({ filePath: root.source.filePath })[0]!;
      (
        view as unknown as {
          applyResolution(result: { type: 'exact'; task: typeof snapshot }): void;
        }
      ).applyResolution({ type: 'exact', task: snapshot });
      const stack = state.get('taskStack');
      // Stack should still have 2 elements (root + fresh subtask found by line match)
      expect(stack).toHaveLength(2);
      expect(stack[0] && 'source' in stack[0] ? stack[0].source.filePath : undefined).toBe(
        root.source.filePath,
      );
      expect(taskNodeLine(snapshot, stack[1]!)).toBe(taskNodeLine(root, sub!));
    });

    it('exact resolution truncates a deep stack when the subtask identity is stale', () => {
      const state = (view as unknown as { state: AppState }).state;
      const tasks = taskApplication.index.list();
      const root = tasks[0]!;
      // Create a fake subtask with a line number that doesn't exist in fresh data
      const original = root.subtasks[0]!;
      const fakeSub = {
        ...original,
        ref: {
          ...original.ref,
          relativeLine: 999,
          originalBlock: '  - [ ] different child',
        },
      };
      state.set('taskStack', [root, fakeSub]);
      const snapshot = taskApplication.index.list({ filePath: root.source.filePath })[0]!;
      (
        view as unknown as {
          applyResolution(result: { type: 'exact'; task: typeof snapshot }): void;
        }
      ).applyResolution({ type: 'exact', task: snapshot });
      const stack = state.get('taskStack');
      // Fresh subtask not found at line 999 → break → stack truncated to [freshRoot]
      expect(stack).toHaveLength(1);
    });
  });
});
