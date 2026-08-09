import type { App } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { TaskIndexEvent, TaskQueryApi, TaskResolution, TaskSnapshot } from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import { rebuildTaskSelection, taskNodeLine } from '../src/ui/taskSelection';
import { taskQueryApi, testStatusRegistry } from './helpers';

const captured = vi.hoisted(() => ({
  state: null as AppState | null,
  acknowledgeOwnWrite: undefined as ((ref?: TaskRef) => void) | undefined,
}));

vi.mock('../src/panels/RightPanel', () => ({
  RightPanel: vi.fn().mockImplementation(function (
    this: unknown,
    state: AppState,
    _app: unknown,
    _statusRegistry: unknown,
    _settings: unknown,
    acknowledgeOwnWrite?: (ref?: TaskRef) => void,
  ) {
    captured.state = state;
    captured.acknowledgeOwnWrite = acknowledgeOwnWrite;
    return {
      mount: (el: HTMLElement) => el.createDiv({ cls: 'tc-right-header-actions' }),
      destroy: vi.fn(),
    };
  }),
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
    activeDocument.body.empty();
  });

  it('retains the ref and replaces the selection only on exact resolution', () => {
    const observed = snapshot('old');
    const fresh = { ...observed, presentation: { linkCount: 0, noteColor: '#fff' } };
    const h = queryHarness({ type: 'exact', task: fresh });
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

  it('reanchors an acknowledged plugin-owned write while external conflicts remain stale', () => {
    const observed = snapshot('old', 'Observed');
    const current = snapshot('new', 'Current');
    const h = queryHarness({ type: 'conflict', current });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    captured.acknowledgeOwnWrite?.();
    h.changed();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({
      title: 'Current',
      ref: current.ref,
    });
    expect(activeDocument.body.querySelector('.tc-task-selection-stale')).toBeNull();
    modal.close();
  });

  it('rejects a late write acknowledgement after selection switched away from its root', () => {
    const first = snapshot('first', 'First');
    const second = snapshot('second', 'Second');
    const external = snapshot('external', 'External');
    const h = queryHarness({ type: 'conflict', current: external });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(first);
    captured.state?.set('taskStack', [second]);
    captured.acknowledgeOwnWrite?.(first.ref);
    captured.state?.set('taskStack', [first]);
    h.changed();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({ title: 'First' });
    expect(activeDocument.body.querySelector('.tc-task-selection-stale')).not.toBeNull();
    modal.close();
  });

  it('keeps the observed task and shows explicit reload/close actions on conflict', () => {
    const observed = snapshot('old', 'Observed');
    const current = snapshot('new', 'Current');
    const h = queryHarness({ type: 'conflict', current });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({ title: 'Observed' });
    const banner = activeDocument.body.querySelector('.tc-task-selection-stale');
    expect(banner?.textContent).toContain('changed');
    expect(banner?.querySelectorAll('button')).toHaveLength(2);
    (banner?.querySelector('.tc-task-selection-reload') as HTMLButtonElement).click();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({ title: 'Current' });
    modal.close();
  });

  it('closes a missing modal selection', () => {
    const observed = snapshot('old');
    const h = queryHarness({ type: 'not-found', ref: observed.ref });
    const modal = new TaskModal({} as App, testStatusRegistry(), undefined, h.queries);
    modal.open(observed);
    h.changed();
    expect(activeDocument.body.querySelector('.tc-modal-backdrop')).toBeNull();
  });

  it('requires an explicit candidate choice for an ambiguous resolution', () => {
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
    expect(captured.state?.get('taskStack')[0]).toMatchObject({ title: 'Observed' });
    const choices = activeDocument.body.querySelectorAll('.tc-task-selection-candidate');
    expect(choices).toHaveLength(2);
    (choices[1] as HTMLButtonElement).click();
    expect(captured.state?.get('taskStack')[0]).toMatchObject({ title: 'Second' });
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
    const child = root.subtasks[0]!;
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
    const rebuilt = rebuildTaskSelection(movedRoot, [staleRoot, staleRoot.subtasks[0]!]);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1]).toMatchObject({ title: 'Child' });
    expect(taskNodeLine(movedRoot, rebuilt[1]!)).toBe(10);
  });

  it('does not adopt a different child at the same relative line after reload', () => {
    const staleRoot = withChild(snapshot('old', 'Root'), '  - [ ] Original');
    const changedRoot = withChild(snapshot('new', 'Root changed'), '  - [ ] Replacement');
    const rebuilt = rebuildTaskSelection(changedRoot, [staleRoot, staleRoot.subtasks[0]!]);
    expect(rebuilt).toHaveLength(1);
  });

  it('follows a uniquely matching child block after a sibling changes its relative line', () => {
    const staleRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const originalRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const child = originalRoot.subtasks[0]!;
    const movedChildRoot = {
      ...originalRoot,
      subtasks: [{ ...child, ref: { ...child.ref, relativeLine: 2 } }],
    };
    const rebuilt = rebuildTaskSelection(movedChildRoot, [staleRoot, staleRoot.subtasks[0]!]);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1]).toMatchObject({ title: 'Child' });
    expect(taskNodeLine(movedChildRoot, rebuilt[1]!)).toBe(6);
  });

  it('does not guess between duplicate child blocks after relative-line drift', () => {
    const staleRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const originalRoot = withChild(snapshot('same', 'Root'), '  - [ ] Child');
    const child = originalRoot.subtasks[0]!;
    const candidateRoot = {
      ...originalRoot,
      subtasks: [
        { ...child, ref: { ...child.ref, relativeLine: 2 } },
        { ...child, ref: { ...child.ref, relativeLine: 3 } },
      ],
    };
    expect(rebuildTaskSelection(candidateRoot, [staleRoot, staleRoot.subtasks[0]!])).toHaveLength(
      1,
    );
  });
});
