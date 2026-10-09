import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  TaskApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskIndexEvent,
} from '../src/tasks';
import { TaskModal } from '../src/ui/TaskModal';
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
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
async function opened() {
  const h = await hierarchyHarness();
  const pending = deferred<TaskCommandResult>();
  const listeners = new Set<(event: TaskIndexEvent) => void>();
  let unavailable = false;
  const queries: TaskApplicationApi['queries'] = {
    list: h.index.list.bind(h.index),
    searchEligibility: h.index.searchEligibility.bind(h.index),
    listNodes: h.index.listNodes.bind(h.index),
    dependencySummary: h.index.dependencySummary.bind(h.index),
    prepareDependencies: h.index.prepareDependencies.bind(h.index),
    observedTags: h.index.observedTags.bind(h.index),
    organization: h.index.organization.bind(h.index),
    matchesSearchAddress: h.index.matchesSearchAddress.bind(h.index),
    resolveSearchHits: h.index.resolveSearchHits.bind(h.index),
    forCalendarProjection: h.index.forCalendarProjection.bind(h.index),
    dependencies: h.index.dependencies.bind(h.index),
    dependencyEligibility: h.index.dependencyEligibility.bind(h.index),
    subscribe: (listener) => {
      listeners.add(listener);
      const off = h.index.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    subscribeReconciled: h.index.subscribeReconciled.bind(h.index),
    resolve: (ref) => (unavailable ? { type: 'not-found', ref } : h.index.resolve(ref)),
    activeEntries: h.index.activeEntries.bind(h.index),
    entriesOverlapping: h.index.entriesOverlapping.bind(h.index),
    fileTotal: h.index.fileTotal.bind(h.index),
  };
  const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
  const modal = new TaskModal({
    app: h.app,
    statusRegistry: testStatusRegistry(),
    settings: DEFAULT_SETTINGS,
    queries,
    tasks: { queries, execute },
  });
  modal.open(h.source);
  const inner = () =>
    modal as unknown as { innerState_abyssPrivate: AppState; innerPanel_abyssPrivate: RightPanel };
  const state = inner().innerState_abyssPrivate;
  const panel = inner().innerPanel_abyssPrivate;
  const run = (command: Extract<TaskCommand, { type: 'reparent-task' | 'promote-subtask' }>) =>
    (
      panel as unknown as {
        executeHierarchyCommand_abyssPrivate: (command: TaskCommand) => Promise<void>;
      }
    ).executeHierarchyCommand_abyssPrivate(command);
  cleanups.push(() => {
    modal.close();
    h.index.destroy();
  });
  const publishUnavailable = () => {
    unavailable = true;
    for (const listener of [...listeners]) listener({ type: 'changed', files: ['source.md'] });
  };
  return {
    ...h,
    modal,
    state,
    panel,
    pending,
    execute,
    run,
    publishUnavailable,
    restore: () => {
      unavailable = false;
    },
  };
}
function shown(): boolean {
  return document.querySelector('.abyss-modal-backdrop') !== null;
}
describe('hierarchy modal continuation', () => {
  it('keeps the root removal lifetime open and carries its selected child after publication', async () => {
    const h = await opened();
    const child = expectDefined(h.source.subtasks[0]);
    h.state.navigateInspectorSelection([h.source, child]);
    const begun = vi.fn();
    h.state.onTaskSelectionBegun(begun);
    const action = h.run(h.command);
    const result = await h.service.execute(h.command);
    await flushMicrotasks();
    expect(shown()).toBe(true);
    expect(h.state.get('taskStack')).toEqual([]);
    h.pending.resolve(result);
    await action;
    expect(shown()).toBe(true);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Parent', 'Move', 'Child']);
  });
  it('promotes through the ordinary menu after early parent revision without closing', async () => {
    const h = await opened();
    const child = expectDefined(h.source.subtasks[0]);
    h.state.navigateInspectorSelection([h.source, child]);
    expectDefined(
      document.querySelector<HTMLElement>('.abyss-modal [aria-label="More actions"]'),
    ).click();
    expectDefined(
      [...document.querySelectorAll<HTMLElement>('.abyss-modal [role="menuitem"]')].find(
        (el) => el.textContent === 'Make independent task',
      ),
    ).click();
    const result = await h.service.execute({ type: 'promote-subtask', subtask: child.ref });
    await flushMicrotasks();
    expect(shown()).toBe(true);
    h.pending.resolve(result);
    await flushMicrotasks(30);
    expect(shown()).toBe(true);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Child']);
  });
  it('restores only an exact full source path after a failed deferred operation', async () => {
    const h = await opened();
    const child = expectDefined(h.source.subtasks[0]);
    h.state.navigateInspectorSelection([h.source, child]);
    const action = h.run(h.command);
    h.publishUnavailable();
    expect(shown()).toBe(true);
    h.restore();
    h.pending.resolve({ type: 'conflict', current: h.source });
    await action;
    expect(shown()).toBe(true);
    expect(h.state.get('taskStack')).toEqual([h.source, child]);
  });
  it.each([false, true])(
    'settles an unavailable source with dirty draft=%s truthfully',
    async (dirty) => {
      const h = await opened();
      if (dirty)
        expectDefined(
          document.querySelector<HTMLTextAreaElement>('.abyss-modal .abyss-comment-input'),
        ).value = 'Keep draft';
      const action = h.run(h.command);
      h.publishUnavailable();
      expect(shown()).toBe(true);
      h.pending.resolve({ type: 'not-found', target: { type: 'task', ref: h.source.ref } });
      await action;
      expect(shown()).toBe(dirty);
      if (dirty) expect(document.body.textContent).toContain('Keep draft');
    },
  );
  it('does not restore a same-line visual replacement after failure', async () => {
    const h = await opened();
    const action = h.run(h.command);
    h.publishUnavailable();
    h.restore();
    vi.spyOn(h.index, 'resolve').mockReturnValue({
      type: 'visual',
      current: h.parent,
      stale: h.source.ref,
      evidence: 'same-line',
    });
    h.pending.resolve({ type: 'not-found', target: { type: 'task', ref: h.source.ref } });
    await action;
    expect(shown()).toBe(false);
  });
  it('keeps later user selection and makes old close/reopen settlements inert', async () => {
    const h = await opened();
    const action = h.run(h.command);
    h.publishUnavailable();
    h.modal.close();
    h.modal.open(h.parent);
    h.pending.resolve({ type: 'conflict', current: h.source });
    await action;
    expect(shown()).toBe(true);
    expect(document.querySelector('.abyss-modal .abyss-right-title')?.textContent).toBe('Parent');
  });
});
