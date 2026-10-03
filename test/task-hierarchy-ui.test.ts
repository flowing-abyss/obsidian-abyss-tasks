import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskApplicationApi, TaskCommandResult } from '../src/tasks';
import { executeTaskHierarchy, hierarchyDropCommand } from '../src/ui/taskHierarchyActions';
import { selectedRootResolution, taskNodeRef } from '../src/ui/taskSelection';
import { taskSnapshotForCalendarOccurrence } from '../src/views/calendarOccurrences';
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  task,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import { notices } from './support/inspectorHarness';
import { hierarchyHarness } from './support/taskHierarchyHarness';

useRealMoment();
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
});
const files = {
  'source.md':
    '- [ ] Move ⏰ 23:00 ⏱️ 99h ^move\n  description\n  - 2026-10-03: comment\n  - 2026-10-03T10:00:00+00:00 → 2026-10-03T11:00:00+00:00\n  - [ ] Child ^child\n    - [ ] Grandchild ^grand\n- [ ] Duplicate\n',
  'target.md': '- [ ] Parent ^parent\n- [ ] Duplicate\n',
};
async function mounted(contents = files) {
  const h = await hierarchyHarness(contents);
  const state = new AppState();
  state.set('mode', 'tasks');
  state.set('selectedList', 'inbox');
  state.set('taskStack', [h.source]);
  const execute = vi.fn<TaskApplicationApi['execute']>((command) => h.service.execute(command));
  const api = { queries: h.index, execute };
  const centerEl = document.body.createDiv();
  const rightEl = document.body.createDiv();
  const center = new CenterPanel({
    state,
    app: h.app,
    settings: DEFAULT_SETTINGS,
    queries: h.index,
    tasks: api,
    statusRegistry: testStatusRegistry(),
    projectStore: null,
    projectManager: null,
  });
  const right = new RightPanel({
    state,
    app: h.app,
    settings: DEFAULT_SETTINGS,
    tasks: api,
    statusRegistry: testStatusRegistry(),
  });
  center.mount(centerEl);
  right.mount(rightEl);
  cleanups.push(() => {
    center.destroy();
    right.destroy();
    h.index.destroy();
    centerEl.remove();
    rightEl.remove();
  });
  const card = (title: string) =>
    expectDefined(
      [...centerEl.querySelectorAll<HTMLElement>('.abyss-task-card')].find((el) =>
        el.textContent.includes(title),
      ),
    );
  const header = () => expectDefined(rightEl.querySelector<HTMLElement>('.abyss-right-header'));
  return { ...h, state, execute, center, right, centerEl, rightEl, card, header };
}
function drag(el: HTMLElement, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}
function nest(h: Awaited<ReturnType<typeof mounted>>, target: HTMLElement) {
  drag(h.card('Move'), 'dragstart');
  drag(target, 'dragover');
  drag(target, 'drop');
}

function navigateWhilePending(h: Awaited<ReturnType<typeof mounted>>, kind: string): void {
  if (kind === 'same array') h.state.set('taskStack', h.state.get('taskStack'));
  if (kind === 'same task') h.state.set('taskStack', [h.source]);
  if (kind === 'breadcrumb')
    expectDefined(h.rightEl.querySelector<HTMLElement>('.abyss-breadcrumb-item')).click();
  if (kind === 'subtask')
    expectDefined(h.rightEl.querySelector<HTMLElement>('.abyss-subtask-label')).click();
  if (kind === 'back')
    expectDefined(h.rightEl.querySelector<HTMLElement>('.abyss-inspector-back')).click();
  if (kind === 'mode roundtrip') {
    h.state.set('mode', 'calendar');
    expect(h.state.get('mode')).toBe('calendar');
    h.state.set('mode', 'tasks');
  }
  if (kind === 'user clear') {
    h.state.clearReconciledTaskSelection();
    h.state.set('taskStack', []);
  }
  if (kind === 'disposed') h.centerEl.remove();
  if (kind === 'destroyed') h.center.destroy();
}

describe('task hierarchy surfaces', () => {
  it.each(['center', 'inspector'] as const)(
    'routes one native %s drop and moves the complete subtree',
    async (surface) => {
      const h = await mounted();
      if (surface === 'inspector') h.state.set('taskStack', [h.parent]);
      const target = surface === 'center' ? h.card('Parent') : h.header();
      nest(h, target);
      await flushMicrotasks(30);
      expect(h.execute).toHaveBeenCalledExactlyOnceWith(h.command);
      expect(await h.read('source.md')).toBe('- [ ] Duplicate\n');
      expect(await h.read('target.md')).toContain(
        '    - [ ] Move ⏰ 23:00 ⏱️ 99h ^move\n      description\n      - 2026-10-03: comment\n      - 2026-10-03T10:00:00+00:00 → 2026-10-03T11:00:00+00:00\n      - [ ] Child ^child\n        - [ ] Grandchild ^grand',
      );
    },
  );
  it('carries the exact selected descendant and prevents inherited-line selection during publication', async () => {
    const h = await mounted();
    const child = expectDefined(h.source.subtasks[0]);
    const grand = expectDefined(child.subtasks[0]);
    h.state.set('taskStack', [h.source, child, grand]);
    const off = h.index.subscribe(() => {
      expect(h.state.isTaskRemovalPending(h.source.ref)).toBe(true);
      const resolved = selectedRootResolution(
        h.index,
        h.source.ref,
        h.state.isTaskRemovalPending(h.source.ref),
      );
      if (resolved.type === 'not-found') h.state.updateInspectorSelection([]);
    });
    cleanups.push(off);
    nest(h, h.card('Parent'));
    await flushMicrotasks(30);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
      'Parent',
      'Move',
      'Child',
      'Grandchild',
    ]);
    expect(h.state.isTaskRemovalPending(h.source.ref)).toBe(false);
  });
  it.each([
    'self',
    'cycle',
    'ended',
    'escape',
    'relation',
    'missing',
    'target changed',
    'mode',
    'detached',
  ] as const)('rejects %s preview or stale drop', async (kind) => {
    const h = await mounted();
    let target = h.card('Parent');
    if (kind === 'self') target = h.card('Move');
    if (kind === 'cycle') {
      h.state.set('taskStack', [h.source, expectDefined(h.source.subtasks[0])]);
      target = h.header();
    }
    drag(h.card('Move'), 'dragstart');
    drag(target, 'dragover');
    if (kind === 'ended') drag(h.card('Move'), 'dragend');
    if (kind === 'escape')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (kind === 'relation') {
      const payload = expectDefined(h.state.get('draggingTaskNode'));
      h.state.set('draggingTaskNode', {
        ...payload,
        source: 'inspector-relation',
        relation: {
          dependent: h.command.parent,
          blocker: h.command.source,
          direction: 'blocked-by',
          dependencyId: 'move',
        },
      });
    }
    if (kind === 'missing')
      vi.spyOn(h.index, 'resolve').mockReturnValue({ type: 'not-found', ref: h.source.ref });
    if (kind === 'target changed') {
      const resolve = h.index.resolve.bind(h.index);
      vi.spyOn(h.index, 'resolve').mockImplementation((ref) =>
        ref.filePath === 'target.md' ? { type: 'not-found', ref } : resolve(ref),
      );
    }
    if (kind === 'mode') h.state.set('mode', 'calendar');
    if (kind === 'detached') target.remove();
    drag(target, 'drop');
    await flushMicrotasks();
    expect(h.execute).not.toHaveBeenCalled();
    expect(target.classList.contains('abyss-drop-target')).toBe(false);
  });
  it('promotes the selected deep child through the ordinary keyboard-accessible menu', async () => {
    const h = await mounted();
    const child = expectDefined(h.source.subtasks[0]);
    const grand = expectDefined(child.subtasks[0]);
    h.state.set('taskStack', [h.source, child, grand]);
    expectDefined(h.rightEl.querySelector<HTMLElement>('[aria-label="More actions"]')).click();
    const item = expectDefined(
      [...h.rightEl.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (el) => el.textContent === 'Make independent task',
      ),
    );
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks(30);
    expect(h.execute).toHaveBeenCalledExactlyOnceWith({
      type: 'promote-subtask',
      subtask: grand.ref,
    });
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Grandchild']);
  });
  it.each(['rejected', 'noop', 'navigate', 'dependency navigation'] as const)(
    'preserves selection and focus after %s outcome',
    async (kind) => {
      const h = await mounted();
      const pending = deferred<TaskCommandResult>();
      h.execute.mockReturnValueOnce(pending.promise);
      const before = h.state.get('taskStack');
      nest(h, h.card('Parent'));
      expect(h.execute).toHaveBeenCalledExactlyOnceWith(h.command);
      const input = document.body.createEl('input');
      cleanups.push(() => {
        input.remove();
      });
      input.focus();
      if (kind === 'navigate') h.state.set('taskStack', [h.parent]);
      if (kind === 'dependency navigation') {
        const node = expectDefined(
          h.index.listNodes().find((node) => node.node.title === 'Parent'),
        );
        h.state.openInspectorDependency(node);
      }
      let result: TaskCommandResult;
      if (kind === 'rejected') result = { type: 'conflict', current: h.source };
      else if (kind === 'noop')
        result = {
          type: 'ok',
          changed: false,
          outcome: {
            type: 'hierarchy',
            source: h.command.source,
            moved: { root: h.source, target: h.command.source },
            affectedRoots: [],
          },
        };
      else result = await h.service.execute(h.command);
      pending.resolve(result);
      await flushMicrotasks(30);
      expect(h.state.get('taskStack')).toEqual(
        kind === 'navigate' || kind === 'dependency navigation' ? [h.parent] : before,
      );
      expect(document.activeElement).toBe(input);
    },
  );
  it.each([
    'same array',
    'same task',
    'breadcrumb',
    'subtask',
    'back',
    'mode roundtrip',
    'user clear',
    'disposed',
    'destroyed',
  ] as const)('revokes delayed handoff on %s intent', async (kind) => {
    const h = await mounted();
    const child = expectDefined(h.source.subtasks[0]);
    const grand = expectDefined(child.subtasks[0]);
    if (kind === 'back') {
      h.state.set('taskStack', [h.parent]);
      h.state.openInspectorDependency(
        expectDefined(h.index.listNodes().find((node) => node.node.title === 'Move')),
      );
    }
    if (kind === 'breadcrumb') h.state.set('taskStack', [h.source, child, grand]);
    const pending = deferred<TaskCommandResult>();
    h.execute.mockReturnValueOnce(pending.promise);
    nest(h, h.card('Parent'));
    navigateWhilePending(h, kind);
    const expected = h.state.get('taskStack');
    pending.resolve(await h.service.execute(h.command));
    await flushMicrotasks(30);
    expect(h.state.get('taskStack')).toEqual(expected);
  });
  it.each(['exact', 'rebased', 'truncated', 'cleared'] as const)(
    'continues after neutral %s reconciliation without emitting selectionBegun',
    async (kind) => {
      const h = await mounted();
      const child = expectDefined(h.source.subtasks[0]);
      const grand = expectDefined(child.subtasks[0]);
      h.state.set('taskStack', [h.source, child, grand]);
      const pending = deferred<TaskCommandResult>();
      h.execute.mockReturnValueOnce(pending.promise);
      nest(h, h.card('Parent'));
      const begun = vi.fn();
      h.state.onTaskSelectionBegun(begun);
      if (kind === 'exact') h.state.updateInspectorSelection([...h.state.get('taskStack')]);
      if (kind === 'rebased')
        h.state.updateInspectorSelection([
          task({ ...h.source, ref: { ...h.source.ref, revision: 'automatic-revision' } }),
        ]);
      if (kind === 'truncated') h.state.updateInspectorSelection([h.source]);
      if (kind === 'cleared') h.state.clearReconciledTaskSelection();
      begun.mockClear();
      pending.resolve(await h.service.execute(h.command));
      await flushMicrotasks(30);
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
        'Parent',
        'Move',
        'Child',
        'Grandchild',
      ]);
      expect(begun).not.toHaveBeenCalled();
    },
  );
  it('drags an inspector subtask to a center parent using the exact subtask ref', async () => {
    const h = await mounted();
    const child = expectDefined(h.source.subtasks[0]);
    const row = expectDefined(h.rightEl.querySelector<HTMLElement>('.abyss-subtask-row'));
    drag(row, 'dragstart');
    drag(h.card('Parent'), 'dragover');
    drag(h.card('Parent'), 'drop');
    await flushMicrotasks(30);
    expect(h.execute).toHaveBeenCalledExactlyOnceWith({
      type: 'reparent-task',
      source: { type: 'subtask', ref: child.ref },
      parent: h.command.parent,
    });
    expect(await h.read('target.md')).toContain(
      '    - [ ] Child ^child\n      - [ ] Grandchild ^grand',
    );
  });
  it('keeps tag drops more specific than hierarchy', async () => {
    const h = await mounted();
    drag(h.card('Move'), 'dragstart');
    h.state.set('draggingTag', '#winner');
    drag(h.card('Parent'), 'dragover');
    drag(h.card('Parent'), 'drop');
    await flushMicrotasks(30);
    expect(h.execute.mock.calls.map(([command]) => command.type)).toEqual(['patch']);
    expect(await h.read('source.md')).toContain('- [ ] Move');
    expect(await h.read('target.md')).toContain('#winner');
  });
  it('does not preview a calendar forecast source', async () => {
    const h = await mounted();
    const forecast = taskSnapshotForCalendarOccurrence({
      kind: 'forecast',
      key: 'forecast',
      source: { root: h.source, node: h.source, target: h.command.source },
      planning: {},
      referenceDate: '2026-10-03' as never,
      ordinal: 1,
    });
    expect(
      hierarchyDropCommand(
        {
          source: 'center-card',
          task: { root: forecast, node: forecast, path: [], target: taskNodeRef(forecast) },
        },
        h.command.parent,
      ),
    ).toBeUndefined();
  });
  it('claims a duplicated outgoing-link source once and preserves Bob occurrence focus on no-op', async () => {
    const h = await mounted({
      ...files,
      'source.md': files['source.md'].replace('Move ', 'Move [[Alice]] [[Bob]] '),
    });
    h.state.set('centerListViewState', {
      ...h.state.get('centerListViewState'),
      groupBy: 'outgoing-link',
    });
    await flushMicrotasks();
    const occurrences = [...h.centerEl.querySelectorAll<HTMLElement>('.abyss-task-card')].filter(
      (el) => el.dataset['filePath'] === 'source.md' && el.dataset['line'] === '0',
    );
    expect(occurrences, h.centerEl.textContent).toHaveLength(2);
    const bob = expectDefined(occurrences[1]);
    bob.click();
    bob.focus();
    h.execute.mockResolvedValueOnce({
      type: 'ok',
      changed: false,
      outcome: {
        type: 'hierarchy',
        source: h.command.source,
        moved: { root: h.source, target: h.command.source },
        affectedRoots: [],
      },
    });
    drag(bob, 'dragstart');
    drag(h.card('Parent'), 'dragover');
    drag(h.card('Parent'), 'drop');
    drag(h.card('Parent'), 'drop');
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(h.command);
    expect(document.activeElement).toBe(bob);
  });
  it('leaves attachment drop specificity on the inspector title intact', async () => {
    const h = await mounted();
    h.state.set('taskStack', [h.parent]);
    drag(h.card('Move'), 'dragstart');
    const title = expectDefined(h.rightEl.querySelector<HTMLElement>('.abyss-right-title-view'));
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [], dropEffect: 'none' },
    });
    title.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(title.classList.contains('abyss-drop-active')).toBe(true);
    expect(h.header().classList.contains('abyss-drop-target')).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('requires exact outcome source and moved target proof', async () => {
    const h = await mounted();
    const before = h.state.get('taskStack');
    const result = await h.service.execute(h.command);
    if (result.type !== 'ok' || result.outcome.type !== 'hierarchy')
      throw new Error('Missing hierarchy fixture');
    for (const outcome of [
      { ...result.outcome, source: h.command.parent },
      { ...result.outcome, moved: { ...result.outcome.moved, target: h.command.source } },
    ]) {
      h.execute.mockResolvedValueOnce({ type: 'ok', changed: true, outcome });
      await executeTaskHierarchy(
        h.state,
        { queries: h.index, execute: h.execute },
        h.command,
        () => true,
      );
      expect(h.state.get('taskStack')).toEqual(before);
    }
  });
  it('logs and presents an unexpected rejection once with both physical paths', async () => {
    const h = await mounted();
    const messages: string[] = [];
    notices(messages);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.execute.mockRejectedValueOnce(new Error('unexpected'));
    nest(h, h.card('Parent'));
    await flushMicrotasks();
    expect(error).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source.md');
    expect(messages[0]).toContain('target.md');
    expect(messages[0]).toMatch(/Inspect/);
  });
  it('keeps the inspector draft on a rejected command and presents one failure', async () => {
    const h = await mounted();
    const messages: string[] = [];
    notices(messages);
    h.execute.mockResolvedValueOnce({ type: 'conflict', current: h.source });
    expectDefined(h.rightEl.querySelector<HTMLElement>('.abyss-right-title')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    const draft = expectDefined(
      h.rightEl.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    draft.value = 'Unsaved title';
    nest(h, h.card('Parent'));
    await flushMicrotasks();
    expect(draft.value).toBe('Unsaved title');
    expect(messages).toHaveLength(1);
  });
});

it.each(['promote-subtask', 'reparent-task'] as const)(
  'omits task source and arbitrary thrown data from %s diagnostics',
  async (type) => {
    const sentinel = 'PRIVATE_TASK_SOURCE_SENTINEL';
    const h = await mounted({
      'source.md': `- [ ] Move\n  - [ ] ${sentinel}\n`,
      'target.md': '- [ ] Parent\n',
    });
    const child = expectDefined(h.source.subtasks[0]);
    const messages: string[] = [];
    notices(messages);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.execute.mockRejectedValueOnce(new Error(sentinel.repeat(100)));
    await executeTaskHierarchy(
      h.state,
      { queries: h.index, execute: h.execute },
      type === 'promote-subtask'
        ? { type, subtask: child.ref }
        : { type, source: taskNodeRef(child), parent: taskNodeRef(h.parent) },
      () => true,
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toEqual({
      operation: type,
      phase: 'unexpected',
      sourcePath: 'source.md',
      destinationPath: type === 'promote-subtask' ? 'source.md' : 'target.md',
      cause: 'command-rejected',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(sentinel);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Inspect/);
  },
);
