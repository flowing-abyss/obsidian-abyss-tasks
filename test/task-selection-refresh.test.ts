import type { App } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type {
  SubtaskSnapshot,
  TaskIndexEvent,
  TaskNodeRef,
  TaskQueryApi,
  TaskResolution,
  TaskSnapshot,
} from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import {
  createRightPanelDraftRebaseContext,
  rebaseRightPanelDraft,
  type RightPanelDraftState,
} from '../src/ui/taskDraftContinuity';
import { rebuildTaskSelection, taskNodeLine } from '../src/ui/taskSelection';
import { expectDefined, taskQueryApi, testStatusRegistry } from './helpers';

const captured = vi.hoisted(() => ({
  state: null as AppState | null,
  acknowledgeOwnWrite: undefined as ((ref?: TaskRef) => void) | undefined,
  captureDraftState: vi.fn(),
  restoreDraftState: vi.fn(),
  detachDraftState: vi.fn(),
}));

vi.mock('../src/panels/RightPanel', () => ({
  RightPanel: class RightPanelMock {
    constructor(
      ...[state, _app, _statusRegistry, _settings, acknowledgeOwnWrite]: readonly [
        state: AppState,
        app: unknown,
        statusRegistry: unknown,
        settings: unknown,
        acknowledgeOwnWrite?: (ref?: TaskRef) => void,
      ]
    ) {
      captured.state = state;
      captured.acknowledgeOwnWrite = acknowledgeOwnWrite;
    }

    mount(el: HTMLElement): void {
      el.createDiv({ cls: 'abyss-right-header-actions' });
    }

    destroy(): void {}

    captureDraftState = captured.captureDraftState;
    restoreDraftState = captured.restoreDraftState;
    detachDraftState = captured.detachDraftState;
  },
}));

import { TaskModal } from '../src/ui/TaskModal';

function snapshot(revision: string, title = revision): TaskSnapshot {
  return {
    ref: { filePath: 'tasks.md', line: 4, revision },
    title,
    markdownTitle: title,
    status: 'open',
    statusSymbol: ' ',
    priority: 'F',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: 'tasks.md',
      line: 4,
      originalMarkdown: `- [ ] ${title}`,
      originalBlock: `- [ ] ${title}`,
    },
    presentation: { linkCount: 0 },
  };
}

function queryHarness(initial: TaskResolution) {
  let result = initial;
  let listener: ((event: TaskIndexEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const queries: TaskQueryApi = taskQueryApi({
    resolve: vi.fn(() => result),
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
  });
  return {
    queries,
    set: (next: TaskResolution) => {
      result = next;
    },
    changed: () => listener?.({ type: 'changed', files: ['tasks.md'] }),
    unsubscribe,
  };
}

describe('revision-aware TaskModal refresh', () => {
  beforeEach(() => {
    captured.state = null;
    captured.acknowledgeOwnWrite = undefined;
    captured.captureDraftState.mockReset();
    captured.restoreDraftState.mockReset();
    captured.detachDraftState.mockReset();
    activeDocument.body.empty();
  });

  it('retains the ref and replaces the selection only on exact resolution', () => {
    const observed = snapshot('old');
    const fresh = { ...observed, presentation: { linkCount: 0, noteColor: '#fff' } };
    const h = queryHarness({ type: 'exact', task: fresh, basis: { observed } });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({
      title: 'old',
      ref: fresh.ref,
      presentation: { noteColor: '#fff' },
    });
    modal.close();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it('silently follows a proven external edit without rendering stale actions', () => {
    const observed = snapshot('old', 'Observed');
    const current = snapshot('new', 'Current');
    const h = queryHarness({
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'authority-transition',
      basis: { observed },
    });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({
      title: 'Current',
      ref: current.ref,
    });
    expect(activeDocument.body.querySelector('.abyss-task-selection-message')).toBeNull();
    modal.close();
  });

  it('shows a visual candidate with its fresh ref and detaches stale drafts without a message', () => {
    const observed = snapshot('old', 'Observed');
    const current = snapshot('new', 'Current visual');
    const bundle = { entries: [{ kind: 'new-comment', dirty: true }] };
    captured.captureDraftState.mockReturnValue(bundle);
    const h = queryHarness({
      type: 'visual',
      stale: observed.ref,
      current,
      evidence: 'same-line',
    });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();

    expect(captured.state?.get('taskStack')[0]).toMatchObject({
      title: 'Current visual',
      ref: current.ref,
    });
    expect(captured.detachDraftState).toHaveBeenCalledWith(bundle);
    expect(captured.restoreDraftState).not.toHaveBeenCalled();
    expect(activeDocument.body.querySelector('.abyss-task-selection-message')).toBeNull();
    modal.close();
  });

  it('rejects a late write acknowledgement after selection switched away from its root', () => {
    const first = snapshot('first', 'First');
    const second = snapshot('second', 'Second');
    const external = snapshot('external', 'External');
    const h = queryHarness({ type: 'uncertain', ref: external.ref });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(first);
    captured.state?.set('taskStack', [second]);
    captured.acknowledgeOwnWrite?.(first.ref);
    captured.state?.set('taskStack', [first]);
    h.changed();
    expect(captured.state?.get('taskStack')).toEqual([]);
    expect(activeDocument.body.querySelector('.abyss-task-selection-message')).toBeNull();
    modal.close();
  });

  it('silently clears an uncertain selection without exposing actions', () => {
    const observed = snapshot('old', 'Observed');
    const h = queryHarness({ type: 'uncertain', ref: observed.ref });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(captured.state?.get('taskStack')).toEqual([]);
    expect(activeDocument.body.querySelector('.abyss-task-selection-message')).toBeNull();
    modal.close();
  });

  it('closes a missing modal selection', () => {
    const observed = snapshot('old');
    const h = queryHarness({ type: 'not-found', ref: observed.ref });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).toBeNull();
  });

  it('silently clears an ambiguous resolution instead of rendering a chooser', () => {
    const observed = snapshot('old', 'Observed');
    const first = snapshot('a', 'First');
    const second = snapshot('b', 'Second');
    const h = queryHarness({
      type: 'ambiguous',
      candidates: [
        { root: first, target: { type: 'task', ref: first.ref } },
        { root: second, target: { type: 'task', ref: second.ref } },
      ],
    });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(captured.state?.get('taskStack')).toEqual([]);
    expect(activeDocument.body.querySelector('.abyss-task-selection-message')).toBeNull();
    modal.close();
  });
});

describe('revision-aware nested selection rebuild', () => {
  function withChild(root: TaskSnapshot, originalBlock: string): TaskSnapshot {
    return {
      ...root,
      subtasks: [
        {
          ref: {
            parent: { type: 'task', ref: root.ref },
            relativeLine: 1,
            originalBlock,
          },
          title: originalBlock.replace(/^\s*- \[ \] /u, ''),
          markdownTitle: originalBlock.replace(/^\s*- \[ \] /u, ''),
          status: 'open',
          statusSymbol: ' ',
          priority: 'F',
          onCompletion: 'keep' as const,
          onCompletionExplicit: false,
          planning: {},
          tags: [],
          dependsOn: [],
          subtasks: [],
          comments: [],
        },
      ],
    };
  }

  it('keeps canonical root and nested tags in detached snapshots', () => {
    const root = withChild(
      { ...snapshot('same', 'Root'), tags: ['#root'] },
      '  - [ ] Child `#inline` #child',
    );
    const child = expectDefined(root.subtasks[0]);
    const tagged = { ...root, subtasks: [{ ...child, tags: ['#child'] }] };

    expect(tagged).toMatchObject({
      tags: ['#root'],
      subtasks: [{ tags: ['#child'] }],
    });
  });

  it('keeps a selected child by retained relative ref when an exact root moves', () => {
    const staleRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const movedRoot = withChild(
      {
        ...staleRoot,
        ref: { ...staleRoot.ref, line: 9 },
        source: { ...staleRoot.source, line: 9 },
        subtasks: [],
      },
      '  - [ ] Child',
    );
    const rebuilt = rebuildTaskSelection(movedRoot, [
      staleRoot,
      expectDefined(staleRoot.subtasks[0]),
    ]);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1]).toMatchObject({ title: 'Child' });
    expect(taskNodeLine(movedRoot, expectDefined(rebuilt[1]))).toBe(10);
  });

  it('does not adopt a different child at the same relative line after reload', () => {
    const staleRoot = withChild(snapshot('old', 'Root'), '  - [ ] Original');
    const changedRoot = withChild(snapshot('new', 'Root changed'), '  - [ ] Replacement');
    const rebuilt = rebuildTaskSelection(changedRoot, [
      staleRoot,
      expectDefined(staleRoot.subtasks[0]),
    ]);
    expect(rebuilt).toHaveLength(1);
  });

  it.each(['title', 'priority', 'status', 'description', 'child-structure', 'ambiguous-position'])(
    'does not retain a %s change as a dependency-only authority transition',
    (change) => {
      const staleRoot = withChild(snapshot('old', 'Root'), '  - [ ] Child');
      const stale = expectDefined(staleRoot.subtasks[0]);
      const candidate = {
        ...stale,
        dependsOn: ['new-id'],
        ref: { ...stale.ref, originalBlock: '  - [ ] Child ⛔ new-id' },
        ...(change === 'title' ? { title: 'Other', markdownTitle: 'Other' } : {}),
        ...(change === 'priority' ? { priority: 'A' as const } : {}),
        ...(change === 'status' ? { status: 'done' as const, statusSymbol: 'x' } : {}),
        ...(change === 'description' ? { description: 'Changed description' } : {}),
        ...(change === 'child-structure' ? { subtasks: [stale] } : {}),
      };
      const root = {
        ...staleRoot,
        subtasks: change === 'ambiguous-position' ? [candidate, candidate] : [candidate],
      };
      expect(
        rebuildTaskSelection(root, [staleRoot, stale], { preserveDependencyChanges: true }),
      ).toEqual([root]);
    },
  );

  it('keeps dependency metadata fallback disabled for ordinary reloads', () => {
    const staleRoot = withChild(snapshot('old', 'Root'), '  - [ ] Child');
    const stale = expectDefined(staleRoot.subtasks[0]);
    const changed = {
      ...stale,
      dependsOn: ['id'],
      ref: { ...stale.ref, originalBlock: '  - [ ] Child ⛔ id' },
    };
    const root = { ...staleRoot, subtasks: [changed] };
    expect(rebuildTaskSelection(root, [staleRoot, stale])).toEqual([root]);
  });

  it('follows a uniquely matching child block after a sibling changes its relative line', () => {
    const staleRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const originalRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const child = expectDefined(originalRoot.subtasks[0]);
    const movedChildRoot = {
      ...originalRoot,
      subtasks: [{ ...child, ref: { ...child.ref, relativeLine: 2 } }],
    };
    const rebuilt = rebuildTaskSelection(movedChildRoot, [
      staleRoot,
      expectDefined(staleRoot.subtasks[0]),
    ]);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1]).toMatchObject({ title: 'Child' });
    expect(taskNodeLine(movedChildRoot, expectDefined(rebuilt[1]))).toBe(6);
  });

  it('does not guess between duplicate child blocks after relative-line drift', () => {
    const staleRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const originalRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const child = expectDefined(originalRoot.subtasks[0]);
    const candidateRoot = {
      ...originalRoot,
      subtasks: [
        { ...child, ref: { ...child.ref, relativeLine: 2 } },
        { ...child, ref: { ...child.ref, relativeLine: 3 } },
      ],
    };
    expect(
      rebuildTaskSelection(candidateRoot, [staleRoot, expectDefined(staleRoot.subtasks[0])]),
    ).toHaveLength(1);
  });

  it('does not let a duplicate child at the stale line capture the selection', () => {
    const staleRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const child = expectDefined(staleRoot.subtasks[0]);
    const candidateRoot = {
      ...staleRoot,
      subtasks: [child, { ...child, ref: { ...child.ref, relativeLine: 3 } }],
    };

    expect(rebuildTaskSelection(candidateRoot, [staleRoot, child])).toHaveLength(1);
  });

  it('indexes 1000 direct siblings once while rebasing a draft bundle', () => {
    const root = snapshot('fresh', 'Root');
    let sourceReads = 0;
    const subtasks = Array.from({ length: 1000 }, (_, index) => {
      const originalBlock = `  - [ ] sibling ${index}`;
      return {
        ref: {
          parent: { type: 'task' as const, ref: root.ref },
          relativeLine: index + 1,
          get originalBlock() {
            sourceReads += 1;
            return originalBlock;
          },
        },
        title: `sibling ${index}`,
        markdownTitle: `sibling ${index}`,
        status: 'open' as const,
        statusSymbol: ' ',
        priority: 'F' as const,
        onCompletion: 'keep' as const,
        onCompletionExplicit: false,
        planning: {},
        tags: [],
        dependsOn: [],
        subtasks: [],
        comments: [],
      };
    });
    const current = { ...root, subtasks };
    const context = createRightPanelDraftRebaseContext();
    const drafts: RightPanelDraftState[] = subtasks.map((subtask) => ({
      kind: 'new-comment',
      parent: { type: 'subtask', ref: subtask.ref },
      value: `draft ${subtask.title}`,
      selectionStart: 0,
      selectionEnd: 0,
      hadFocus: false,
      dirty: true,
    }));

    for (const draft of drafts)
      expect(rebaseRightPanelDraft(draft, current, context)).toBeDefined();

    expect(sourceReads).toBeLessThan(5000);
  });

  it('memoizes one deep stale child path across a large draft bundle', () => {
    const depth = 40;
    const current = snapshot('fresh', 'Root');
    let currentNode = current as unknown as { subtasks: SubtaskSnapshot[] };
    let currentParent: TaskNodeRef = { type: 'task', ref: current.ref };
    for (let index = 0; index < depth; index += 1) {
      const originalBlock = `${'  '.repeat(index + 1)}- [ ] child ${index}`;
      const child: SubtaskSnapshot = {
        ref: { parent: currentParent, relativeLine: index + 1, originalBlock },
        title: `child ${index}`,
        markdownTitle: `child ${index}`,
        status: 'open',
        statusSymbol: ' ',
        priority: 'F',
        onCompletion: 'keep',
        onCompletionExplicit: false,
        planning: {},
        tags: [],
        dependsOn: [],
        subtasks: [],
        comments: [],
      };
      currentNode.subtasks = [child];
      currentNode = child as unknown as { subtasks: SubtaskSnapshot[] };
      currentParent = { type: 'subtask', ref: child.ref };
    }

    let pathReads = 0;
    let staleParent: TaskNodeRef = { type: 'task', ref: snapshot('stale', 'Root').ref };
    for (let index = 0; index < depth; index += 1) {
      const parent: TaskNodeRef = staleParent;
      const originalBlock = `${'  '.repeat(index + 1)}- [ ] child ${index}`;
      staleParent = {
        type: 'subtask',
        ref: {
          get parent(): TaskNodeRef {
            pathReads += 1;
            return parent;
          },
          relativeLine: index + 1,
          originalBlock,
        },
      };
    }
    const draft: RightPanelDraftState = {
      kind: 'new-comment',
      parent: staleParent,
      value: 'shared deep draft',
      selectionStart: 0,
      selectionEnd: 0,
      hadFocus: false,
      dirty: true,
    };
    const context = createRightPanelDraftRebaseContext();

    for (let index = 0; index < 1000; index += 1) {
      expect(rebaseRightPanelDraft(draft, current, context)).toBeDefined();
    }

    expect(pathReads).toBeLessThan(depth * 2);
  });
});
