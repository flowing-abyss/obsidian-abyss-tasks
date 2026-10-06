import { MarkdownRenderer, requireApiVersion } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  CompletionTrackingWitness,
  SubtaskSnapshot,
  TaskApplicationApi,
  TaskCommandResult,
  TaskSnapshot,
} from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import { createTaskBlock } from '../src/tasks/infrastructure/markdown/createTaskBlock';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from '../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import * as attachmentDrop from '../src/ui/attachmentDrop';
import { taskNodeRef } from '../src/ui/taskSelection';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  deferred,
  dispatchImeKey,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import {
  inspectorCleanups,
  inspectorHarness,
  notices,
  subscribeInspectorReconciliation,
} from './support/inspectorHarness';

useRealMoment();

function snapshot(revision: string, description = 'old description'): TaskSnapshot {
  const ref: TaskRef = { filePath: 'tasks.md', line: 0, revision };
  const parent = { type: 'task' as const, ref };
  return {
    ref,
    title: 'root',
    markdownTitle: 'root',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [
      {
        ref: {
          parent,
          relativeLine: 2,
          originalMarkdown: '  - 2026-07-13: old comment',
        },
        timestamp: {
          precision: 'day',
          value: '2026-07-13' as never,
          raw: '2026-07-13',
        },
        text: 'old comment',
      },
    ],
    timeEntries: [],
    description,
    source: {
      filePath: 'tasks.md',
      line: 0,
      originalMarkdown: '- [ ] root',
      originalBlock: '- [ ] root',
    },
    presentation: { linkCount: 0 },
  };
}

function snapshotWithChildren(revision: string, titles: readonly string[]): TaskSnapshot {
  const root = { ...snapshot(revision), comments: [] };
  delete root.description;
  const parent = { type: 'task' as const, ref: root.ref };
  return {
    ...root,
    subtasks: titles.map((title, index) => ({
      ref: {
        parent,
        relativeLine: index + 1,
        originalBlock: `  - [ ] ${title}`,
      },
      title,
      markdownTitle: title,
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      dependsOn: [],
      subtasks: [],
      comments: [],
      timeEntries: [],
    })),
  };
}

function snapshotWithNestedChildren(revision: string): TaskSnapshot {
  const root = snapshotWithChildren(revision, ['branch', 'sibling']);
  const rootNode = { type: 'task' as const, ref: root.ref };
  const branchRef = {
    parent: rootNode,
    relativeLine: 1,
    originalBlock: '  - [ ] branch\n    - [ ] nested one\n    - [ ] nested two',
  };
  const branchNode = { type: 'subtask' as const, ref: branchRef };
  const nested = ['nested one', 'nested two'].map((title, index) => ({
    ref: {
      parent: branchNode,
      relativeLine: index + 1,
      originalBlock: `    - [ ] ${title}`,
    },
    title,
    markdownTitle: title,
    status: 'open' as const,
    statusSymbol: ' ',
    priority: 'D' as const,
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    dependsOn: [],
    subtasks: [],
    comments: [],
    timeEntries: [],
  }));
  return {
    ...root,
    subtasks: [
      { ...expectDefined(root.subtasks[0]), ref: branchRef, subtasks: nested },
      {
        ...expectDefined(root.subtasks[1]),
        ref: { ...expectDefined(root.subtasks[1]).ref, parent: rootNode, relativeLine: 4 },
      },
    ],
  };
}

function api(execute: TaskApplicationApi['execute']): TaskApplicationApi {
  return {
    queries: taskQueryApi(),
    execute,
  };
}

function call<T>(panel: RightPanel, method: string, ...args: unknown[]): T {
  const fn = expectDefined(
    (panel as unknown as Record<string, (...values: unknown[]) => T>)[`${method}_abyssPrivate`],
  );
  return fn.call(panel, ...args);
}

async function panelWith(
  initial: TaskSnapshot,
  execute: TaskApplicationApi['execute'],
  acknowledge?: (ref?: TaskRef) => void,
  settings = DEFAULT_SETTINGS,
) {
  const app = await createAppWithFiles({ 'tasks.md': '- [ ] root\n' });
  const state = new AppState();
  state.set('taskStack', [initial]);
  const panel = new RightPanel({
    state,
    app,
    statusRegistry: testStatusRegistry(),
    settings,
    onSuccessfulMutation: acknowledge,
    tasks: api(execute),
  });
  return { app, state, panel };
}

function sourceSnapshot(markdown: string, revision: string): TaskSnapshot {
  const statuses = canonicalStatusCatalog();
  return expectDefined(
    projectTaskSnapshot({
      codec: new TaskMarkdownCodec(statuses),
      statusCatalog: statuses,
      filePath: 'tasks.md',
      lines: markdown.split('\n'),
      line: 0,
      exactBlock: markdown,
      ref: { filePath: 'tasks.md', line: 0, revision },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
}

function entrySelector(kind: 'subtask' | 'comment'): string {
  return kind === 'subtask' ? '.abyss-subtask-new-input' : '.abyss-comment-input';
}
function entryParent(root: TaskSnapshot, path: readonly number[]) {
  return path.reduce<TaskSnapshot | TaskSnapshot['subtasks'][number]>(
    (node, index) => expectDefined(node.subtasks[index]),
    root,
  );
}

describe('RightPanel block editing', () => {
  it('removes temporary entry document listeners when Escape ends the editor', async () => {
    const { panel } = await panelWith(snapshot('before'), vi.fn<TaskApplicationApi['execute']>());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const add = vi.spyOn(activeDocument, 'addEventListener');
    const remove = vi.spyOn(activeDocument, 'removeEventListener');
    try {
      expectDefined(
        container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const input = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
      );
      const listeners = add.mock.calls.filter(
        ([type]) => type === 'focusin' || type === 'pointerdown',
      );
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (const [type, listener] of listeners)
        expect(
          remove.mock.calls.filter(
            ([removedType, removedListener]) =>
              removedType === type && removedListener === listener,
          ),
        ).toHaveLength(1);
    } finally {
      panel.destroy();
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('keeps the creation policy captured before a pending submission', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.taskPrefix = '#original';
    const initial = sourceSnapshot('- [ ] Root\n  - [ ] Owner', 'before');
    const pending = deferred<TaskCommandResult>();
    const { panel, state } = await panelWith(initial, () => pending.promise, undefined, settings);
    state.set('taskStack', [initial, expectDefined(initial.subtasks[0])]);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(
        container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const input = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
      );
      input.value = 'Added';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      settings.taskPrefix = '#changed';
      pending.resolve({
        type: 'ok',
        changed: true,
        outcome: {
          type: 'task',
          task: sourceSnapshot('- [ ] Root\n  - [ ] Owner\n    - [ ] #original Added', 'after'),
        },
      });
      await flushMicrotasks(20);
      const replacement = container.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
      expect(replacement?.isConnected).toBe(true);
      expect(replacement?.value).toBe('');
      expect(activeDocument.activeElement).toBe(replacement);
    } finally {
      panel.destroy();
    }
  });

  it('restores the exact parent when adding a child makes it byte-identical to its sibling', async () => {
    const initial = sourceSnapshot(
      '- [ ] Root\n  - [ ] Same\n  - [ ] Same\n    - [ ] Child',
      'before',
    );
    const current = sourceSnapshot(
      '- [ ] Root\n  - [ ] Same\n    - [ ] Child\n  - [ ] Same\n    - [ ] Child',
      'after',
    );
    const { panel, state } = await panelWith(initial, async () => ({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: current },
    }));
    state.set('taskStack', [initial, expectDefined(initial.subtasks[0])]);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(
        container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const input = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
      );
      input.value = 'Child';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(20);
      const replacement = container.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
      expect(replacement?.isConnected).toBe(true);
      expect(replacement?.value).toBe('');
      expect(activeDocument.activeElement).toBe(replacement);
      expect(state.get('taskStack')[1]?.ref).toEqual(current.subtasks[0]?.ref);
    } finally {
      panel.destroy();
    }
  });

  it.each(['subtask', 'comment'] as const)(
    'does not recover a dismissed %s continuation after an index-first failure',
    async (kind) => {
      const initial = sourceSnapshot('- [ ] Root\n  - [ ] Owner', 'before');
      const current = sourceSnapshot(
        `${initial.source.originalBlock}\n    ${kind === 'subtask' ? '- [ ]' : '- 2026-09-20T12:00:00+07:00:'} Submitted`,
        'after',
      );
      const pending = deferred<TaskCommandResult>();
      const { panel, state } = await panelWith(initial, () => pending.promise);
      state.set('taskStack', [initial, expectDefined(initial.subtasks[0])]);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      const outside = activeDocument.body.createEl('button');
      try {
        if (kind === 'subtask')
          expectDefined(
            container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
          ).click();
        const input = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entrySelector(kind)),
        );
        input.focus();
        input.value = 'Submitted';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushMicrotasks();
        const selection = panel.selectionForOwnedTransition(
          initial.ref,
          current,
          state.get('taskStack'),
        );
        const bundle = panel.captureDraftStateForOwnedTransition(initial.ref, current.ref);
        state.updateInspectorSelection(expectDefined(selection));
        panel.restoreDraftState(bundle, current);
        const replacement = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entrySelector(kind)),
        );
        replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        outside.focus();
        pending.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
        await flushMicrotasks(20);
        expect(container.querySelector('.abyss-detached-draft')).toBeNull();
        expect(activeDocument.activeElement).toBe(outside);
        expect(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entrySelector(kind))
            ?.value ?? '',
        ).toBe('');
      } finally {
        panel.destroy();
        outside.remove();
      }
    },
  );

  it.each(['subtask', 'comment'] as const)(
    'keeps failed %s text retryable and respects navigation during a pending retry',
    async (kind) => {
      const initial = sourceSnapshot('- [ ] Root', 'before');
      const first = deferred<TaskCommandResult>();
      const second = deferred<TaskCommandResult>();
      const execute = vi
        .fn<TaskApplicationApi['execute']>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const { panel, state } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      try {
        if (kind === 'subtask')
          expectDefined(
            container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
          ).click();
        const input = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entrySelector(kind)),
        );
        input.focus();
        input.value = '  exact text  ';
        input.setSelectionRange(2, 7);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        first.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unchanged' });
        await flushMicrotasks(20);
        expect(input.value).toBe('  exact text  ');
        expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
        expect(activeDocument.activeElement).toBe(input);
        expect(execute).toHaveBeenCalledOnce();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushMicrotasks();
        state.set('taskStack', [sourceSnapshot('- [ ] Other', 'other')]);
        const other = expectDefined(
          container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
        );
        other.value = 'Other draft';
        other.focus();
        second.resolve({
          type: 'ok',
          changed: true,
          outcome: {
            type: 'task',
            task: sourceSnapshot(
              `- [ ] Root\n  ${kind === 'subtask' ? '- [ ]' : '- 2026-09-20T12:00:00+07:00:'} exact text`,
              'after',
            ),
          },
        });
        await flushMicrotasks(20);
        expect(container.querySelector('.abyss-right-title-view')?.textContent).toBe('Other');
        expect(other.value).toBe('Other draft');
        expect(activeDocument.activeElement).toBe(other);
        expect(execute).toHaveBeenCalledTimes(2);
      } finally {
        panel.destroy();
      }
    },
  );

  it('never follows a same-root sibling after an unproven ordinary insertion receipt', async () => {
    const initial = sourceSnapshot('- [ ] Root\n  - [ ] Owner\n  - [ ] Owner', 'before');
    const current = sourceSnapshot(
      '- [ ] Root\n  - [ ] Foreign\n  - [ ] Owner\n    - [ ] Added',
      'after',
    );
    const { panel, state } = await panelWith(initial, async () => ({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: current },
    }));
    state.set('taskStack', [initial, expectDefined(initial.subtasks[0])]);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(
        container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const input = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
      );
      input.value = 'Added';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(20);
      expect(state.get('taskStack').map((node) => node.title)).toEqual(['Root']);
      expect(container.querySelector('.abyss-subtask-new-input')).toBeNull();
      expect(container.querySelector('.abyss-detached-draft')).toBeNull();
    } finally {
      panel.destroy();
    }
  });

  it.each(['subtask', 'comment'] as const)(
    'preserves newer %s text and caret across a changed result',
    async (kind) => {
      const initial = sourceSnapshot(
        '- [ ] Root\n\t- [ ] Nested owner\n\t\t- [ ] Grandchild',
        'before',
      );
      const pending = deferred<TaskCommandResult>();
      const { panel, state } = await panelWith(initial, () => pending.promise);
      state.set('taskStack', [initial, expectDefined(initial.subtasks[0])]);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      try {
        if (kind === 'subtask')
          expectDefined(
            container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
          ).click();
        const selector = kind === 'subtask' ? '.abyss-subtask-new-input' : '.abyss-comment-input';
        const input = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector),
        );
        input.focus();
        input.value = 'Submitted';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushMicrotasks();
        input.value = 'Newer unfinished';
        input.setSelectionRange(3, 7);
        pending.resolve({
          type: 'ok',
          changed: true,
          outcome: {
            type: 'task',
            task: sourceSnapshot(
              `${initial.source.originalBlock}\n\t\t${kind === 'subtask' ? '- [ ]' : '- 2026-09-20T12:00:00+07:00:'} Submitted`,
              'after',
            ),
          },
        });
        await flushMicrotasks(20);
        const restored = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector),
        );
        expect(restored.value).toBe('Newer unfinished');
        expect([restored.selectionStart, restored.selectionEnd]).toEqual([3, 7]);
        expect(activeDocument.activeElement).toBe(restored);
        expect(container.querySelector('.abyss-detached-draft')).toBeNull();
      } finally {
        panel.destroy();
      }
    },
  );

  it.each(['subtask', 'comment'] as const)(
    'ignores IME and whitespace %s Enter and never writes on outside dismissal',
    async (kind) => {
      const initial = sourceSnapshot('- [ ] Root', 'before');
      const execute = vi.fn<TaskApplicationApi['execute']>();
      const { panel } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      const outside = activeDocument.body.createEl('button');
      try {
        if (kind === 'subtask')
          expectDefined(
            container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
          ).click();
        const input = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            kind === 'subtask' ? '.abyss-subtask-new-input' : '.abyss-comment-input',
          ),
        );
        input.focus();
        input.value = 'Composing';
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
        );
        // Checking only `isComposing` lets a legacy keyCode 229 Enter add the entry.
        dispatchImeKey(input, 'Enter', 'legacy');
        input.value = '   ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.value = 'Unfinished';
        if (kind === 'comment') {
          const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          });
          input.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
        }
        outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        outside.focus();
        await flushMicrotasks(20);
        expect(execute).not.toHaveBeenCalled();
        expect(activeDocument.activeElement).toBe(outside);
        if (kind === 'subtask')
          expect(container.querySelector('.abyss-subtask-new-input')).toBeNull();
      } finally {
        panel.destroy();
        outside.remove();
      }
    },
  );

  it.each(['result-first', 'index-first'] as const)(
    'continues root and nested entry through %s owned reconciliation',
    async (order) => {
      for (const nested of [false, true])
        for (const kind of ['subtask', 'comment'] as const)
          await verifyContinuousEntry(order, nested, kind, '');
    },
  );

  it.each(['result-first', 'index-first'] as const)(
    'continues normalized ordinary child creation through %s reconciliation',
    async (order) => {
      for (const nested of [false, true]) {
        const parent = await verifyContinuousEntry(order, nested, 'subtask', ' ⏱️ 25h');
        expect(parent.subtasks.slice(-2).map((child) => child.ref.originalBlock.trim())).toEqual([
          '- [ ] First ⏱️ 24h',
          '- [ ] Second ⏱️ 24h',
        ]);
      }
    },
  );

  function createdEntry(kind: 'subtask' | 'comment', text: string): string {
    if (kind === 'comment') return `- 2026-09-20T12:00:00+07:00: ${text}`;
    const created = createTaskBlock(new TaskMarkdownCodec(canonicalStatusCatalog()), {
      markdownBody: text,
      today: '2026-09-20' as never,
      addCreatedDate: false,
    });
    if (created.type !== 'created') throw new Error('Invalid child fixture');
    return created.content;
  }

  async function verifyContinuousEntry(
    order: 'result-first' | 'index-first',
    nested: boolean,
    kind: 'subtask' | 'comment',
    suffix: string,
  ): Promise<ReturnType<typeof entryParent>> {
    const selectedPath = nested ? [0] : [];
    const isSubtask = kind === 'subtask';
    let markdown = nested ? '- [ ] Root\n\t- [ ] Nested owner\n\t\t- [ ] Grandchild' : '- [ ] Root';
    let current = sourceSnapshot(markdown, 'initial');
    const execute = vi.fn<TaskApplicationApi['execute']>(async (command) => {
      expect(command.type).toBe(`add-${kind}`);
      if (command.type !== 'add-subtask' && command.type !== 'add-comment')
        throw new Error('Unexpected command');
      const parent = entryParent(current, selectedPath);
      expect(command.parent).toEqual(taskNodeRef(parent));
      markdown += `${nested ? '\n\t\t' : '\n\t'}${createdEntry(kind, command.text)}`;
      const next = sourceSnapshot(markdown, command.text);
      if (order === 'index-first') {
        const selection = panel.selectionForOwnedTransition(
          current.ref,
          next,
          state.get('taskStack'),
        );
        const draft = panel.captureDraftStateForOwnedTransition(current.ref, next.ref);
        state.updateInspectorSelection(selection ?? [next]);
        panel.restoreDraftState(draft, next);
      }
      current = next;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: next } };
    });
    const { panel, state } = await panelWith(current, execute);
    if (nested) state.set('taskStack', [current, expectDefined(current.subtasks[0])]);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      if (isSubtask)
        expectDefined(
          container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
        ).click();
      for (const text of ['First', 'Second']) {
        const input = expectDefined(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entrySelector(kind)),
        );
        input.focus();
        input.value = `${text}${suffix}`;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushMicrotasks(20);
        const replacement = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          entrySelector(kind),
        );
        expect(expectDefined(replacement).isConnected).toBe(true);
        expect(expectDefined(replacement).value).toBe('');
        expect(activeDocument.activeElement).toBe(replacement);
        expect(expectDefined(state.get('taskStack')[state.get('taskStack').length - 1]).title).toBe(
          nested ? 'Nested owner' : 'Root',
        );
      }
      const parent = entryParent(current, selectedPath);
      const entries =
        kind === 'subtask'
          ? parent.subtasks.map((child) => child.title)
          : parent.comments.map((comment) => comment.text);
      expect(entries.slice(-2)).toEqual(['First', 'Second']);
      expect(entries).toHaveLength(selectedPath.length > 0 && isSubtask ? 3 : 2);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(container.querySelector('.abyss-detached-draft')).toBeNull();
      return parent;
    } finally {
      panel.destroy();
    }
  }

  it.each(['Escape', 'outside'] as const)(
    'dismisses pending new subtask on %s without late focus or another write',
    async (dismissal) => {
      const initial = sourceSnapshot('- [ ] Root', 'before');
      const pending = deferred<TaskCommandResult>();
      const execute = vi.fn<TaskApplicationApi['execute']>(() => pending.promise);
      const { panel } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      const outside = activeDocument.body.createEl('button');
      try {
        expectDefined(
          container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
        ).click();
        const input = expectDefined(
          container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
        );
        input.value = 'First';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        if (dismissal === 'Escape')
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        outside.focus();
        expect(container.querySelector('.abyss-subtask-new-input')).toBeNull();
        pending.resolve({
          type: 'ok',
          changed: true,
          outcome: { type: 'task', task: sourceSnapshot('- [ ] Root\n  - [ ] First', 'after') },
        });
        await flushMicrotasks(20);
        expect(container.querySelector('.abyss-subtask-new-input')).toBeNull();
        expect(activeDocument.activeElement).toBe(outside);
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        panel.destroy();
        outside.remove();
      }
    },
  );

  it('offers Undo after subtask deletion and restores the inspector through its committed parent', async () => {
    const initial = snapshotWithChildren('old', ['selected', 'sibling']);
    const afterDelete = snapshotWithChildren('deleted', ['sibling']);
    const restored = snapshotWithChildren('restored', ['selected', 'sibling']);
    const parent = { type: 'task' as const, ref: afterDelete.ref };
    const recovery = {
      parent,
      markdown: '  - [ ] selected\n',
      placement: { relativeLine: 1, before: expectDefined(afterDelete.subtasks[0]).ref },
    };
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterDelete, subtaskRemovalRecovery: recovery },
      })
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: restored },
      });
    const shown = notices();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      await call<Promise<void>>(panel, 'deleteTask', expectDefined(initial.subtasks[0]));
      expect(state.get('taskStack')[0]?.subtasks.map((child) => child.title)).toEqual(['sibling']);
      expect(shown).toHaveLength(0);
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-undo-row button')).click();
      await flushMicrotasks(20);
      expect(execute).toHaveBeenLastCalledWith({ type: 'restore-subtask', ...recovery });
      expect(state.get('taskStack')[0]).toEqual(restored);
      expect(shown).toHaveLength(0);
    } finally {
      panel.destroy();
      container.remove();
      shown.forEach((notice) => {
        if (requireApiVersion('1.8.7')) notice.containerEl.remove();
      });
    }
  });

  it('presents a removal Undo refused by a pending write as a pending edit', async () => {
    const initial = snapshotWithChildren('old', ['selected', 'sibling']);
    const afterDelete = snapshotWithChildren('deleted', ['sibling']);
    const recovery = {
      parent: { type: 'task' as const, ref: afterDelete.ref },
      markdown: '  - [ ] selected\n',
      placement: { relativeLine: 1, before: expectDefined(afterDelete.subtasks[0]).ref },
    };
    const held = deferred<TaskCommandResult>();
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterDelete, subtaskRemovalRecovery: recovery },
      })
      .mockReturnValueOnce(held.promise);
    const messages: string[] = [];
    const captured = notices(messages);
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      await call<Promise<void>>(panel, 'deleteTask', expectDefined(initial.subtasks[0]));
      const pending = call<Promise<TaskCommandResult>>(panel, 'updatePriority', afterDelete, 'A');
      expectDefined(container.querySelector<HTMLButtonElement>('.abyss-undo-row button')).click();
      await flushMicrotasks(20);

      expect(messages).toEqual([
        'Another change to this task is still being saved. Try again in a moment.',
      ]);
      // The refused Undo runs no restore, which would race the priority write still in flight.
      expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
        'delete-subtask',
        'patch',
      ]);
      held.resolve({ type: 'ok', changed: true, outcome: { type: 'task', task: afterDelete } });
      await pending;
    } finally {
      panel.destroy();
      container.remove();
      captured.forEach((notice) => {
        if (requireApiVersion('1.8.7')) notice.containerEl.remove();
      });
    }
  });

  it.each(['Enter', 'Escape'] as const)(
    'preserves a full long title through %s',
    async (finish) => {
      const plain =
        'Complete title source remains available beyond the visible two-line preview '.repeat(6);
      const markdownTitle = `**${plain}**`;
      const updatedPlain = `${plain}updated`;
      const updatedMarkdown = `${markdownTitle} updated`;
      const initial = { ...snapshot('old'), title: plain, markdownTitle };
      const updated = { ...snapshot('new'), title: updatedPlain, markdownTitle: updatedMarkdown };
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: updated },
      });
      const { panel } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      try {
        const view = expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view'));
        expect(view.hasAttribute('title')).toBe(false);
        expect(view.getAttribute('aria-label')).toBe(plain);
        view.click();
        await flushMicrotasks();
        const editor = expectDefined(
          container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
        );
        expect(editor.value).toBe(markdownTitle);
        editor.value = updatedMarkdown;
        editor.dispatchEvent(
          new KeyboardEvent('keydown', { key: finish, bubbles: true, cancelable: true }),
        );
        await flushMicrotasks(20);
        expect(container.querySelector('.abyss-right-title-edit')).toBeNull();
        if (finish === 'Enter') {
          expect(execute).toHaveBeenCalledExactlyOnceWith({
            type: 'patch',
            target: { type: 'task', ref: initial.ref },
            patch: { markdownTitle: { type: 'set', value: updatedMarkdown } },
          });
        } else expect(execute).not.toHaveBeenCalled();
        const returned = expectDefined(
          container.querySelector<HTMLElement>('.abyss-right-title-view'),
        );
        expect(returned.hasAttribute('title')).toBe(false);
        expect(returned.getAttribute('aria-label')).toBe(finish === 'Enter' ? updatedPlain : plain);
        returned.click();
        expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
          finish === 'Enter' ? updatedMarkdown : markdownTitle,
        );
      } finally {
        panel.destroy();
        container.remove();
      }
    },
  );

  it('preserves the full DOM draft bundle when an add-comment command is a no-op', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: initial },
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
      await flushMicrotasks();
      const title = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      title.value = 'unsaved title';
      title.focus();
      title.setSelectionRange(2, 7);
      const comment = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      comment.value = 'already present';
      comment.setSelectionRange(3, 10);

      comment.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks(20);

      const restoredTitle = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      const restoredComment = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      expect(restoredTitle.value).toBe('unsaved title');
      expect(restoredTitle.selectionStart).toBe(2);
      expect(restoredTitle.selectionEnd).toBe(7);
      expect(restoredComment.value).toBe('already present');
      expect(restoredComment.selectionStart).toBe(3);
      expect(restoredComment.selectionEnd).toBe(10);
      expect(activeDocument.activeElement).toBe(restoredTitle);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      panel.destroy();
    }
  });

  it('preserves simultaneous dirty title and new-comment drafts across refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
    await flushMicrotasks();
    const title = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    const comment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    comment.focus();
    title.value = 'local title draft';
    comment.value = 'local comment draft';

    const drafts = panel.captureDraftState();
    title.remove();
    const current = {
      ...snapshot('current'),
      title: 'external title',
      markdownTitle: 'external title',
    };
    state.set('taskStack', [current]);
    panel.restoreDraftState(drafts, current);

    expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'local title draft',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
      'local comment draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('captures every dirty editor plus the focused clean editor in one bundle', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
    await flushMicrotasks();
    const title = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    const comment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    title.value = 'dirty title';
    comment.focus();

    const bundle = panel.captureDraftState();
    title.remove();

    expect(bundle?.entries).toHaveLength(2);
    expect(
      bundle?.entries.map((entry) => [
        entry.kind,
        'dirty' in entry ? entry.dirty : entry.editor.dirty,
      ]),
    ).toEqual([
      ['title', true],
      ['new-comment', false],
    ]);
    const current = { ...snapshot('current'), title: 'external', markdownTitle: 'external' };
    state.set('taskStack', [current]);
    panel.restoreDraftState(bundle, current);
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'dirty title',
    );
    expect(activeDocument.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    panel.destroy();
  });

  it('preserves simultaneous dirty recurrence and new-comment drafts across refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const comment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    comment.value = 'local comment draft';
    expectDefined(container.querySelector<HTMLElement>('.abyss-repeat-chip')).click();
    const interval = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
    );
    interval.value = '7';
    interval.dispatchEvent(new Event('input', { bubbles: true }));
    interval.focus();

    const drafts = panel.captureDraftState();
    const current = snapshot('current');
    state.set('taskStack', [current]);
    panel.restoreDraftState(drafts, current);

    expect(container.querySelector<HTMLInputElement>('.abyss-recurrence-interval')?.value).toBe(
      '7',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
      'local comment draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it.each([
    {
      kind: 'title',
      open: '.abyss-right-title-view',
      edit: '.abyss-right-title-edit',
    },
    {
      kind: 'description',
      open: '.abyss-right-desc-view',
      edit: '.abyss-right-desc-edit',
    },
    {
      kind: 'existing-comment',
      open: '.abyss-comment-text',
      edit: '.abyss-comment-edit-input',
    },
    {
      kind: 'new-subtask',
      open: '.abyss-subtask-add-row',
      edit: '.abyss-subtask-new-input',
    },
  ] as const)(
    'retains dirty $kind text, focus, and selection across a proven refresh',
    async (entry) => {
      const initial = snapshot('old');
      const execute = vi.fn<TaskApplicationApi['execute']>();
      const { panel, state } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      expectDefined(container.querySelector<HTMLElement>(entry.open)).click();
      await flushMicrotasks();
      const edit = expectDefined(
        container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entry.edit),
      );
      edit.value = 'local unsaved';
      edit.focus();
      edit.setSelectionRange(3, 8);

      const draft = panel.captureDraftState();
      const current = {
        ...snapshot('current'),
        title: 'external title',
        markdownTitle: 'external title',
      };
      state.set('taskStack', [current]);
      panel.restoreDraftState(draft, current);

      const restored = expectDefined(
        container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entry.edit),
      );
      expect(restored).not.toBeNull();
      expect(restored.value).toBe('local unsaved');
      expect(restored.selectionStart).toBe(3);
      expect(restored.selectionEnd).toBe(8);
      expect(activeDocument.activeElement).toBe(restored);
      expect(execute).not.toHaveBeenCalled();
      panel.destroy();
    },
  );

  it('retains a dirty new-comment draft across a proven refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    edit.value = 'local unsaved';
    edit.focus();
    edit.setSelectionRange(3, 8);

    const draft = panel.captureDraftState();
    const current = snapshot('current');
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    const restored = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    expect(restored.value).toBe('local unsaved');
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(8);
    expect(activeDocument.activeElement).toBe(restored);
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('detaches a dirty draft when its target disappears', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    edit.value = 'local unsaved';
    edit.focus();

    const draft = panel.captureDraftState();
    const current = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    const detached = expectDefined(container.querySelector<HTMLElement>('.abyss-detached-draft'));
    const copy = expectDefined(
      container.querySelector<HTMLButtonElement>('.abyss-detached-draft-copy'),
    );
    expect(detached.textContent).toContain('local unsaved');
    expect(detached.getAttribute('aria-label')).toContain('root');
    expect(detached.getAttribute('aria-label')).toContain('existing comment');
    expect(detached.getAttribute('role')).toBe('group');
    expect(copy).not.toBeNull();
    expect(copy.getAttribute('aria-label')).toContain('root');
    expect(copy.getAttribute('aria-label')).toContain('existing comment');
    expect(
      container
        .querySelector<HTMLButtonElement>('.abyss-detached-draft-discard')
        ?.getAttribute('aria-label'),
    ).toContain('root');
    expect(container.querySelector('.abyss-detached-draft-discard')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
      'Draft preserved',
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(activeDocument.activeElement).toBe(copy);
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('upserts the newest value when the same draft detaches again', async () => {
    const initial = snapshot('old');
    const { panel, state } = await panelWith(initial, vi.fn<TaskApplicationApi['execute']>());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const input = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    input.value = 'first value';
    const first = expectDefined(panel.captureDraftState());
    panel.detachDraftState(first);
    input.value = 'newest value';
    const newest = expectDefined(panel.captureDraftState());
    panel.detachDraftState(newest);

    const detached = container.querySelectorAll<HTMLElement>('.abyss-detached-draft');
    expect(detached).toHaveLength(1);
    expect(detached[0]?.textContent).toContain('newest value');
    expect(detached[0]?.textContent).not.toContain('first value');
    state.set('taskStack', []);
    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain('newest value');
    panel.destroy();
  });

  it('keeps a detached draft visible across subsequent panel renders', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    edit.value = 'persistent detached draft';

    const draft = panel.captureDraftState();
    const current = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);
    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'persistent detached draft',
    );

    state.set('taskStack', [{ ...current, presentation: { linkCount: 1 } }]);

    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'persistent detached draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('keeps an append-once tray whose copy is non-destructive and discard removes one entry', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const existing = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    existing.value = 'existing comment draft';
    const existingBundle = panel.captureDraftState();
    const withoutComment = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [withoutComment]);
    panel.restoreDraftState(existingBundle, withoutComment);
    panel.detachDraftState(existingBundle);

    const newComment = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    newComment.value = 'new comment draft';
    const newBundle = panel.captureDraftState();
    panel.detachDraftState(newBundle);

    expect(container.querySelectorAll('.abyss-detached-drafts-title')).toHaveLength(1);
    expect(container.querySelectorAll('.abyss-detached-draft')).toHaveLength(2);
    const entries = [...container.querySelectorAll<HTMLElement>('.abyss-detached-draft')];
    expect(entries[0]?.textContent).toContain('existing comment draft');
    expect(entries[1]?.textContent).toContain('new comment draft');

    Object.defineProperty(
      expectDefined(container.ownerDocument.defaultView).navigator,
      'clipboard',
      {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      },
    );
    const copy = expectDefined(
      expectDefined(entries[1]).querySelector<HTMLButtonElement>('.abyss-detached-draft-copy'),
    );
    copy.click();
    await flushMicrotasks();
    expect(container.querySelectorAll('.abyss-detached-draft')).toHaveLength(2);
    expect(entries[1]?.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Could not copy',
    );
    expect(activeDocument.activeElement).toBe(copy);

    expectDefined(
      expectDefined(entries[0]).querySelector<HTMLButtonElement>('.abyss-detached-draft-discard'),
    ).click();
    const remaining = [...container.querySelectorAll<HTMLElement>('.abyss-detached-draft')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('new comment draft');
    panel.destroy();
  });

  it('detaches instead of attaching a comment draft to a duplicate at the stale line', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
    const edit = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
    );
    edit.value = 'local duplicate-sensitive draft';

    const draft = panel.captureDraftState();
    const original = expectDefined(initial.comments[0]);
    const current = {
      ...snapshot('current'),
      comments: [original, { ...original, ref: { ...original.ref, relativeLine: 4 } }],
    };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'local duplicate-sensitive draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('retains a structured recurrence draft focus after deferred popover autofocus', async () => {
    const initial = { ...snapshot('old'), recurrence: 'every day' };
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-repeat-chip')).click();
      expectDefined(
        container.querySelector<HTMLButtonElement>('[data-recurrence-preset="daily"]'),
      ).click();
      const interval = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
      );
      interval.value = '12345';
      interval.dispatchEvent(new Event('input', { bubbles: true }));
      interval.focus();
      interval.setSelectionRange(2, 5);

      const draft = panel.captureDraftState();
      const current = { ...snapshot('current'), recurrence: 'every day' };
      state.set('taskStack', [current]);
      panel.restoreDraftState(draft, current);
      await new Promise<void>((resolve) => {
        activeDocument.defaultView?.setTimeout(resolve, 0);
      });

      const restored = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
      );
      expect(restored.value).toBe('12345');
      expect(restored.selectionStart).toBe(2);
      expect(restored.selectionEnd).toBe(5);
      expect(activeDocument.activeElement).toBe(restored);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      panel.destroy();
    }
  });

  it('deletes a root through the API and preserves newer navigation on a late result', async () => {
    const initial = snapshot('old');
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockImplementation(() => new Promise<TaskCommandResult>((done) => (resolve = done)));
    const { panel, state, app } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const process = vi.spyOn(app.vault, 'process');

    const pending = call<Promise<void>>(panel, 'deleteTask', root);
    expect(execute).toHaveBeenCalledWith({ type: 'delete', ref: initial.ref });
    const newer = snapshot('newer');
    state.set('taskStack', [newer]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'deleted', ref: initial.ref },
    });
    await pending;

    expect(state.get('taskStack')).toEqual([newer]);
    expect(process).not.toHaveBeenCalled();
  });

  it('delegates all description/comment intents with their exact revisioned targets', async () => {
    const initial = snapshot('old');
    const fresh = snapshot('fresh', 'new description');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: fresh },
    });
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const comment = expectDefined(root.comments[0]);

    await call<Promise<boolean>>(panel, 'updateDescription', root, 'new description');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'set-description',
      target: { type: 'task', ref: initial.ref },
      text: 'new description',
    });
    expect(state.get('taskStack')[0]).toMatchObject({
      ref: fresh.ref,
      description: 'new description',
    });

    execute.mockClear();
    const current = expectDefined(state.get('taskStack')[0]);
    const currentComment = expectDefined(current.comments[0]);
    const input = freshContainer().createEl('textarea');
    input.value = 'draft';
    await call<Promise<boolean>>(panel, 'addComment', current, 'added', freshContainer(), input);
    expect(execute).toHaveBeenLastCalledWith({
      type: 'add-comment',
      parent: { type: 'task', ref: fresh.ref },
      text: 'added',
    });

    await call<Promise<boolean>>(panel, 'updateComment', current, currentComment, 'updated');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'update-comment',
      comment: expectDefined(fresh.comments[0]).ref,
      text: 'updated',
    });

    await call<Promise<boolean>>(panel, 'deleteComment', root, comment);
    expect(execute).toHaveBeenLastCalledWith({
      type: 'delete-comment',
      comment: expectDefined(initial.comments[0]).ref,
    });
  });

  it('keeps add-comment input and DOM unchanged on a structured conflict', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel, state } = await panelWith(initial, execute);
    const input = freshContainer().createEl('textarea');
    const list = freshContainer();
    input.value = 'draft';

    await call<Promise<boolean>>(
      panel,
      'addComment',
      expectDefined(state.get('taskStack')[0]),
      'draft',
      list,
      input,
    );

    expect(input.value).toBe('draft');
    expect(list.querySelectorAll('.abyss-comment-row')).toHaveLength(0);
    expect(state.get('taskStack')[0]).toMatchObject({ ref: initial.ref });
  });

  it.each([
    {
      label: 'conflict',
      result: { type: 'conflict', current: snapshot('external') },
    },
    {
      label: 'not-found',
      result: {
        type: 'not-found',
        target: { type: 'task', ref: snapshot('old').ref },
      },
    },
    {
      label: 'ambiguous',
      result: {
        type: 'ambiguous',
        candidates: [
          {
            root: snapshot('candidate'),
            target: { type: 'task', ref: snapshot('candidate').ref },
          },
        ],
      },
    },
    {
      label: 'invalid',
      result: {
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask' }],
      },
    },
    {
      label: 'io-error',
      result: {
        type: 'io-error',
        cause: 'process-error',
        contentState: 'unknown',
      },
    },
  ])('keeps the add-subtask editor and exact draft open on $label', async ({ result }) => {
    const initial = snapshot('old');
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValue(result as TaskCommandResult);
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-subtask-add-row')).click();
    const input = expectDefined(
      container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
    );
    input.value = 'keep this draft';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'add-subtask',
      parent: { type: 'task', ref: initial.ref },
      text: 'keep this draft',
    });
    expect(container.querySelector('.abyss-subtask-new-input')).toBe(input);
    expect(input.value).toBe('keep this draft');
    expect(
      container.querySelector('.abyss-subtask-add-row')?.hasClass('abyss-subtask-add-row--hidden'),
    ).toBe(true);
    panel.destroy();
  });

  it('keeps the description textarea open when its save conflicts', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expectDefined(container.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
    const textarea = expectDefined(
      container.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
    );
    textarea.value = 'attempted change';
    textarea.dispatchEvent(new FocusEvent('blur'));
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'set-description',
      target: { type: 'task', ref: initial.ref },
      text: 'attempted change',
    });
    expect(container.querySelector('.abyss-right-desc-edit')).toBe(textarea);
    panel.destroy();
  });

  it('closes the description editor after a save that changes nothing', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: initial },
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const outside = activeDocument.body.createEl('button');
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
      await flushMicrotasks();
      const textarea = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
      );
      // The editor focuses its textarea on the next task; the blur below is real only then.
      expect(activeDocument.activeElement).toBe(textarea);
      textarea.value = 'old description ';
      outside.focus();
      await flushMicrotasks(20);

      expect(execute).toHaveBeenCalledWith({
        type: 'set-description',
        target: { type: 'task', ref: initial.ref },
        text: 'old description ',
      });
      // Restoring the submitted editor draft after an unchanged result would reopen the editor.
      expect(container.querySelector('.abyss-right-desc-edit')).toBeNull();
    } finally {
      panel.destroy();
      outside.remove();
      container.remove();
    }
  });

  it('closes the title editor after a save that changes nothing', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: initial },
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const outside = activeDocument.body.createEl('button');
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
      await flushMicrotasks();
      const textarea = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      // The editor focuses its textarea on the next task; the blur below is real only then.
      expect(activeDocument.activeElement).toBe(textarea);
      textarea.value = 'root ';
      outside.focus();
      await flushMicrotasks(20);

      expect(execute).toHaveBeenCalledWith({
        type: 'patch',
        target: { type: 'task', ref: initial.ref },
        patch: { markdownTitle: { type: 'set', value: 'root' } },
      });
      // Restoring the submitted editor draft after an unchanged result would reopen the editor.
      expect(container.querySelector('.abyss-right-title-edit')).toBeNull();
    } finally {
      panel.destroy();
      outside.remove();
      container.remove();
    }
  });

  it('keeps a comment typed while a description save that changes nothing is pending', async () => {
    const initial = snapshot('old');
    const pending = deferred<TaskCommandResult>();
    const execute = vi.fn<TaskApplicationApi['execute']>().mockReturnValue(pending.promise);
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
      await flushMicrotasks();
      const textarea = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
      );
      // The editor focuses its textarea on the next task; the blur below is real only then.
      expect(activeDocument.activeElement).toBe(textarea);
      textarea.value = 'old description ';
      const typed = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      typed.focus();
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledWith({
        type: 'set-description',
        target: { type: 'task', ref: initial.ref },
        text: 'old description ',
      });
      typed.value = 'typed during the save';
      pending.resolve({ type: 'ok', changed: false, outcome: { type: 'task', task: initial } });
      await flushMicrotasks(20);

      expect(container.querySelector('.abyss-right-desc-edit')).toBeNull();
      const comment = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      // Dropping every draft on an unchanged result would lose the typed comment.
      expect(comment.value).toBe('typed during the save');
      expect(activeDocument.activeElement).toBe(comment);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('keeps a comment textarea open when its exact comment ref conflicts', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    vi.useFakeTimers();
    try {
      expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const textarea = expectDefined(
        container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
      );
      textarea.value = 'attempted comment';
      textarea.dispatchEvent(new FocusEvent('blur'));
      await vi.advanceTimersByTimeAsync(151);

      expect(execute).toHaveBeenCalledWith({
        type: 'update-comment',
        comment: expectDefined(initial.comments[0]).ref,
        text: 'attempted comment',
      });
      expect(container.querySelector('.abyss-comment-edit-input')).toBe(textarea);
    } finally {
      vi.useRealTimers();
      panel.destroy();
    }
  });

  it('does not restore a selection replaced while a structural result was in flight', async () => {
    const initial = snapshot('old');
    const other = { ...snapshot('other'), ref: { ...snapshot('other').ref, filePath: 'other.md' } };
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const acknowledge = vi.fn<(ref?: TaskRef) => void>();
    const { panel, state } = await panelWith(initial, execute, acknowledge);
    const pending = call<Promise<boolean>>(
      panel,
      'updateDescription',
      expectDefined(state.get('taskStack')[0]),
      'new description',
    );
    state.set('taskStack', [other]);
    const fresh = snapshot('fresh', 'new description');
    resolve({ type: 'ok', changed: true, outcome: { type: 'task', task: fresh } });
    await pending;

    expect(state.get('taskStack')[0]).toMatchObject({ ref: other.ref });
    expect(acknowledge).toHaveBeenCalledWith(fresh.ref);
  });

  it('delegates add and sibling reorder through revisioned structural commands', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    const afterAdd = snapshotWithChildren('after-add', ['first', 'second', 'new child']);
    const afterReorder = snapshotWithChildren('after-reorder', ['second', 'first', 'new child']);
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterAdd },
      })
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterReorder },
      });
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);

    await call<Promise<void>>(panel, 'addSubTask', root, 'new child');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'add-subtask',
      parent: { type: 'task', ref: initial.ref },
      text: 'new child',
    });

    const current = expectDefined(state.get('taskStack')[0]);
    await call<Promise<void>>(
      panel,
      'reorderSubTask',
      current,
      expectDefined(current.subtasks[0]),
      expectDefined(current.subtasks[1]),
      'after',
    );
    expect(execute).toHaveBeenLastCalledWith({
      type: 'reorder-subtask',
      subtask: expectDefined(afterAdd.subtasks[0]).ref,
      target: expectDefined(afterAdd.subtasks[1]).ref,
      placement: 'after',
    });
    expect(expectDefined(state.get('taskStack')[0]).subtasks.map((child) => child.title)).toEqual([
      'second',
      'first',
      'new child',
    ]);
  });

  it('deletes the selected nested task through the menu and converges selection to its parent', async () => {
    const initial = snapshotWithChildren('old', ['selected', 'sibling']);
    const afterDelete = snapshotWithChildren('fresh', ['sibling']);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: afterDelete },
    });
    const { panel, state } = await panelWith(initial, execute);
    const root = initial;
    state.set('taskStack', [root, expectDefined(root.subtasks[0])]);
    const container = freshContainer();
    panel.mount(container);

    expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="More actions"]'),
    ).click();
    const deleteItem = expectDefined(container.querySelector<HTMLElement>('.abyss-context-danger'));
    expect(deleteItem.textContent).toBe('Delete sub-task');
    deleteItem.click();
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'delete-subtask',
      subtask: expectDefined(initial.subtasks[0]).ref,
    });
    expect(state.get('taskStack')).toHaveLength(1);
    expect(state.get('taskStack')[0]).toMatchObject({ ref: afterDelete.ref, title: 'root' });
    panel.destroy();
  });

  it('does not overwrite a newer selection when a late reorder result arrives', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    const other = { ...snapshot('other'), ref: { ...snapshot('other').ref, filePath: 'other.md' } };
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const pending = call<Promise<void>>(
      panel,
      'reorderSubTask',
      root,
      expectDefined(root.subtasks[0]),
      expectDefined(root.subtasks[1]),
      'after',
    );
    state.set('taskStack', [other]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: snapshotWithChildren('fresh', ['second', 'first']) },
    });
    await pending;

    expect(state.get('taskStack')[0]).toMatchObject({ ref: other.ref });
  });

  it('does not overwrite newer navigation within the same root when a reorder resolves late', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const { panel, state } = await panelWith(initial, execute);
    const root = expectDefined(state.get('taskStack')[0]);
    const pending = call<Promise<void>>(
      panel,
      'reorderSubTask',
      root,
      expectDefined(root.subtasks[0]),
      expectDefined(root.subtasks[1]),
      'after',
    );
    const selectedChild = expectDefined(root.subtasks[1]);
    state.set('taskStack', [root, selectedChild]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: snapshotWithChildren('fresh', ['second', 'first']) },
    });
    await pending;

    expect(state.get('taskStack')).toEqual([root, selectedChild]);
  });

  it.each(['add', 'delete', 'reorder'] as const)(
    'keeps a newer sibling selection when a deferred nested %s completes',
    async (operation) => {
      const initial = snapshotWithNestedChildren('old');
      let resolve!: (result: TaskCommandResult) => void;
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
        () =>
          new Promise<TaskCommandResult>((done) => {
            resolve = done;
          }),
      );
      const { panel, state } = await panelWith(initial, execute);
      const root = initial;
      const branch = expectDefined(root.subtasks[0]);
      const sibling = expectDefined(root.subtasks[1]);
      state.set('taskStack', [root, branch]);

      let pending: Promise<unknown>;
      if (operation === 'add') {
        pending = call<Promise<boolean>>(panel, 'addSubTask', branch, 'new nested child');
      } else if (operation === 'delete') {
        pending = call<Promise<void>>(panel, 'deleteTask', branch);
      } else {
        pending = call<Promise<void>>(
          panel,
          'reorderSubTask',
          branch,
          expectDefined(branch.subtasks[0]),
          expectDefined(branch.subtasks[1]),
          'after',
        );
      }

      state.set('taskStack', [root, sibling]);
      resolve({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: snapshotWithNestedChildren('fresh') },
      });
      await pending;

      expect(state.get('taskStack')).toEqual([root, sibling]);
    },
  );
});

describe('RightPanel IME-owned keys', () => {
  async function mounted() {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    return { panel, container, execute };
  }

  it.each(['composing', 'legacy'] as const)(
    'keeps the title editor open on IME keys (%s)',
    async (ime) => {
      const { panel, container, execute } = await mounted();
      try {
        expectDefined(container.querySelector<HTMLElement>('.abyss-right-title-view')).click();
        await flushMicrotasks();
        const title = expectDefined(
          container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
        );
        title.value = 'かな';
        const keys = ['Enter', 'Escape'].map((key) => dispatchImeKey(title, key, ime));
        await flushMicrotasks();

        // Guarding only Enter still lets a composing Escape cancel the editor.
        expect(keys.map((event) => event.defaultPrevented)).toEqual([false, false]);
        expect(title.isConnected).toBe(true);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        panel.destroy();
      }
    },
  );

  it.each(['composing', 'legacy'] as const)(
    'keeps the description editor open on IME Enter and Escape (%s)',
    async (ime) => {
      const { panel, container, execute } = await mounted();
      try {
        expectDefined(container.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
        await flushMicrotasks();
        const description = expectDefined(
          container.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
        );
        description.value = 'かな';
        const enter = dispatchImeKey(description, 'Enter', ime);
        const escape = dispatchImeKey(description, 'Escape', ime);
        await flushMicrotasks();

        expect(enter.defaultPrevented).toBe(false);
        expect(escape.defaultPrevented).toBe(false);
        expect(description.isConnected).toBe(true);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        panel.destroy();
      }
    },
  );

  it.each(['composing', 'legacy'] as const)(
    'keeps an existing comment editor open on IME keys (%s)',
    async (ime) => {
      const { panel, container, execute } = await mounted();
      try {
        expectDefined(container.querySelector<HTMLElement>('.abyss-comment-text')).click();
        const editor = expectDefined(
          container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
        );
        editor.value = 'かな';
        const keys = ['Enter', 'Escape'].map((key) => dispatchImeKey(editor, key, ime));

        // Guarding only Escape still lets an IME Enter blur the editor, which saves the draft.
        expect(keys.map((event) => event.defaultPrevented)).toEqual([false, false]);
        expect(editor.isConnected).toBe(true);
        expect(activeDocument.activeElement).toBe(editor);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        panel.destroy();
      }
    },
  );

  it('keeps a new sub-task entry open on a legacy IME Escape', async () => {
    const { panel, container } = await mounted();
    try {
      expectDefined(
        container.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const input = expectDefined(
        container.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
      );
      input.value = 'かな';
      // The entry Escape checked only `isComposing`.
      const escape = dispatchImeKey(input, 'Escape', 'legacy');

      expect(escape.defaultPrevented).toBe(false);
      expect(input.isConnected).toBe(true);
      expect(activeDocument.activeElement).toBe(input);
    } finally {
      panel.destroy();
    }
  });

  it.each(['composing', 'legacy'] as const)(
    'keeps an anchored surface open on an IME Escape (%s)',
    async (ime) => {
      const { panel, container } = await mounted();
      try {
        expectDefined(
          container.querySelector<HTMLElement>(
            '.abyss-right-action-btn[aria-label="More actions"]',
          ),
        ).click();
        const menu = expectDefined(container.querySelector('.abyss-task-context-menu'));
        const escape = dispatchImeKey(expectDefined(activeDocument.activeElement), 'Escape', ime);

        // Guarding only field keydown handlers leaves the surface's Escape listener to dismiss it.
        expect(escape.defaultPrevented).toBe(false);
        expect(menu.isConnected).toBe(true);
      } finally {
        panel.destroy();
      }
    },
  );
});

describe('consumed draft recovery over the real index', () => {
  afterEach(() => {
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });

  it.each(
    [
      { label: 'plain', entries: [] },
      {
        label: 'one stopped entry',
        entries: ['  - 2026-10-06T09:00:00+07:00 → 2026-10-06T09:20:00+07:00'],
      },
      {
        label: 'two stopped entries',
        entries: [
          '  - 2026-10-06T09:00:00+07:00 → 2026-10-06T09:20:00+07:00',
          '  - 2026-10-06T10:00:00+07:00 → 2026-10-06T10:20:00+07:00',
        ],
      },
      { label: 'running entry', entries: ['  - 2026-10-06T09:00:00+07:00 → ...'] },
    ].flatMap((fixture) => ['result-first', 'index-first'].map((order) => ({ ...fixture, order }))),
  )('retains connected nested entry with $label and $order', async ({ entries, order }) => {
    const h = await inspectorHarness(
      ['- [ ] Root', '  - [ ] Branch', '    - [ ] Owner', '      - [ ] Existing', ...entries].join(
        '\n',
      ),
      'Owner',
    );
    const unsubscribe = order === 'index-first' ? subscribeInspectorReconciliation(h) : () => {};
    try {
      expectDefined(
        h.el.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const input = expectDefined(h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'));
      const header = h.el.querySelector('.abyss-right-header');
      const description = h.el.querySelector('.abyss-right-desc-view');
      const existing = expectDefined(h.el.querySelector('.abyss-subtask-row'));
      const execute = vi.spyOn(h.api, 'execute');
      h.el.scrollTop = 73;
      for (const text of ['First', 'Second', 'Third']) {
        const parent = taskNodeRef(h.node('Owner').node);
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => {
          expect(h.node('Owner').node.subtasks.some((child) => child.title === text)).toBe(true);
          expect(h.state.get('taskStack')[h.state.get('taskStack').length - 1]?.ref).toEqual(
            h.node('Owner').node.ref,
          );
        });
        await flushMicrotasks(20);
        expect(execute).toHaveBeenLastCalledWith({ type: 'add-subtask', parent, text });
        expect(input.isConnected).toBe(true);
        expect(h.el.querySelector('.abyss-subtask-new-input')).toBe(input);
        expect(input.ownerDocument.activeElement).toBe(input);
        expect(h.el.querySelector('.abyss-right-header')).toBe(header);
        expect(h.el.querySelector('.abyss-right-desc-view')).toBe(description);
        expect(existing.isConnected).toBe(true);
        expect(h.el.scrollTop).toBe(73);
      }
      const commentInput = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
      );
      commentInput.focus();
      for (const text of ['Comment one\nsecond line', 'Comment two\nsecond line']) {
        const input = commentInput;
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => {
          expect(h.node('Owner').node.comments.some((comment) => comment.text === text)).toBe(true);
          expect(h.state.get('taskStack')[h.state.get('taskStack').length - 1]?.ref).toEqual(
            h.node('Owner').node.ref,
          );
        });
        await flushMicrotasks(20);
        expect(input.isConnected).toBe(true);
        expect(h.el.querySelector('.abyss-comment-input')).toBe(input);
        expect(input.ownerDocument.activeElement).toBe(input);
      }
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
        'Root',
        'Branch',
        'Owner',
      ]);
      expect(h.node('Root').node.timeEntries).toHaveLength(entries.length);
      expect(h.node('Root').node.comments).toHaveLength(0);
      expect(h.node('Branch').node.comments).toHaveLength(0);
      expect(h.node('Owner').node.timeEntries).toHaveLength(0);
      expect((await h.read()).split('\n').filter((line) => line.includes(' → '))).toEqual(entries);
    } finally {
      unsubscribe();
    }
  });

  it.each(['navigate', 'toggle', 'delete'] as const)(
    'uses the proven existing child for its retained %s action',
    async (action) => {
      const h = await inspectorHarness('- [ ] Owner\n  - [ ] Existing', 'Owner');
      const off = subscribeInspectorReconciliation(h);
      try {
        const row = expectDefined(h.el.querySelector('.abyss-subtask-row'));
        const label = expectDefined(row.querySelector<HTMLElement>('.abyss-subtask-label'));
        const marker = expectDefined(row.querySelector<HTMLElement>('.abyss-status-marker'));
        const remove = expectDefined(row.querySelector<HTMLElement>('.abyss-subtask-remove'));
        await call<Promise<boolean>>(h.panel, 'addSubTask', h.node('Owner').node, 'Added');
        const target = taskNodeRef(h.node('Existing').node);
        const execute = vi.spyOn(h.api, 'execute');
        expect(row.isConnected).toBe(true);
        if (action === 'navigate') {
          label.click();
          expect(taskNodeRef(expectDefined(h.state.get('taskStack')[1]))).toEqual(target);
        } else if (action === 'toggle') {
          marker.click();
          await vi.waitFor(() => {
            expect(h.node('Existing').node.status).toBe('done');
          });
          expect(execute).toHaveBeenLastCalledWith({ type: 'toggle-completion', target });
          expect(marker.isConnected).toBe(true);
          expect(marker.getAttribute('aria-checked')).toBe('true');
        } else {
          remove.click();
          await vi.waitFor(() => {
            expect(h.node('Owner').node.subtasks.map((child) => child.title)).toEqual(['Added']);
          });
          expect(target.type).toBe('subtask');
          expect(execute).toHaveBeenLastCalledWith({ type: 'delete-subtask', subtask: target.ref });
          expect(row.isConnected).toBe(false);
          execute.mockClear();
          remove.click();
          expect(execute).not.toHaveBeenCalled();
        }
      } finally {
        off();
      }
    },
  );

  it('keeps the original open editor target while new actions acquire the proven successor', async () => {
    const h = await inspectorHarness('- [ ] Owner\n  Original description', 'Owner');
    const off = subscribeInspectorReconciliation(h);
    try {
      const original = taskNodeRef(h.node('Owner').node);
      expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
      const editor = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
      );
      await call<Promise<boolean>>(h.panel, 'addSubTask', h.node('Owner').node, 'Added');
      expect(editor.isConnected).toBe(true);
      const execute = vi.spyOn(h.api, 'execute');
      editor.value = 'Captured edit';
      editor.dispatchEvent(new Event('blur'));
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledWith({
          type: 'set-description',
          target: original,
          text: 'Captured edit',
        });
      });
    } finally {
      off();
    }
  });

  it('retires document listeners on window migration and restores the owned entry draft', async () => {
    const h = await inspectorHarness('- [ ] Owner', 'Owner');
    expectDefined(h.el.querySelector<HTMLElement>('.abyss-subtask-add-row')).click();
    const original = expectDefined(
      h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
    );
    original.value = 'Migration draft';
    original.setSelectionRange(2, 6);
    h.panel.onWindowMigrated();
    const restored = expectDefined(
      h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
    );
    expect(original.isConnected).toBe(false);
    expect(restored.value).toBe('Migration draft');
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([2, 6]);
    const execute = vi.spyOn(h.api, 'execute');
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(execute).not.toHaveBeenCalled();
    restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(restored.isConnected).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('updates only the edited selected field while retaining unrelated inspector regions', async () => {
    const h = await inspectorHarness('- [ ] Owner\n  Old description\n  - [ ] Existing', 'Owner');
    const off = subscribeInspectorReconciliation(h);
    try {
      const header = expectDefined(h.el.querySelector('.abyss-right-header'));
      const row = expectDefined(h.el.querySelector('.abyss-subtask-row'));
      const input = expectDefined(h.el.querySelector('.abyss-comment-input'));
      expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
      const edit = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'));
      edit.value = 'New description';
      edit.dispatchEvent(new Event('blur'));
      await vi.waitFor(() => {
        expect(h.node('Owner').node.description).toBe('New description');
      });
      await flushMicrotasks(20);
      expect(header.isConnected).toBe(true);
      expect(row.isConnected).toBe(true);
      expect(input.isConnected).toBe(true);
      expect(h.el.querySelector('.abyss-right-desc-view')?.textContent).toContain(
        'New description',
      );
    } finally {
      off();
    }
  });

  it('preserves the exact newer live continuation and trays the original submitted text', async () => {
    const h = await inspectorHarness('- [ ] A\n- [ ] B\nSentinel.\n', 'A');
    const unsubscribe = subscribeInspectorReconciliation(h);
    const late = deferred<TaskCommandResult>();
    const published = deferred<void>();
    const execute = h.api.execute.bind(h.api);
    const spy = vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
      const result = await execute(command);
      expect(result.type).toBe('ok');
      published.resolve(undefined);
      return late.promise;
    });
    try {
      expectDefined(
        h.el.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
      ).click();
      const submitted = expectDefined(
        h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
      );
      submitted.value = 'QA-SP1j submitted';
      submitted.dispatchEvent(new Event('input', { bubbles: true }));
      submitted.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await published.promise;
      await flushMicrotasks(20);
      const expected = '- [ ] A\n\t- [ ] QA-SP1j submitted ➕ 2026-09-05\n- [ ] B\nSentinel.\n';
      expect(await h.read()).toBe(expected);
      const stack = h.state.get('taskStack').map(taskNodeRef);
      expect(stack).toEqual([h.node('A').target]);
      const newer = expectDefined(h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'));
      expect(newer).toBe(submitted);
      expect(newer.value).toBe('');
      expect(activeDocument.activeElement).toBe(newer);
      newer.value = 'QA-SP1j newer';
      newer.dispatchEvent(new Event('input', { bubbles: true }));
      newer.setSelectionRange(13, 13);
      late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
      await flushMicrotasks(20);
      expect(h.el.querySelector('.abyss-subtask-new-input')).toBe(newer);
      expect(newer.isConnected).toBe(true);
      expect(newer.value).toBe('QA-SP1j newer');
      expect([newer.selectionStart, newer.selectionEnd]).toEqual([13, 13]);
      expect(activeDocument.activeElement).toBe(newer);
      expect(h.state.get('taskStack').map(taskNodeRef)).toEqual(stack);
      expect(await h.read()).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.el.querySelector('.abyss-detached-draft-label')?.textContent).toBe('A, new subtask');
      expect(h.el.querySelector('.abyss-detached-draft pre')?.textContent).toBe(
        'QA-SP1j submitted',
      );
    } finally {
      late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
      await flushMicrotasks(20);
      unsubscribe();
      spy.mockRestore();
    }
  });
  it.each(['different root', 'same-root sibling'] as const)(
    'keeps a live description at a %s while recovering A to its original tray',
    async (kind) => {
      const initial =
        kind === 'different root'
          ? '- [ ] A\n\t- > Old\n- [ ] B\nSentinel.\n'
          : '- [ ] Root\n\t- [ ] A\n\t\t- > Old\n\t- [ ] B\nSentinel.\n';
      const expected = initial.replace('- > Old', '- > Submitted description');
      const h = await inspectorHarness(initial, 'A');
      const unsubscribe = subscribeInspectorReconciliation(h);
      const late = deferred<TaskCommandResult>(),
        published = deferred<void>();
      const execute = h.api.execute.bind(h.api);
      const spy = vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
        const result = await execute(command);
        expect(result.type).toBe('ok');
        published.resolve(undefined);
        return late.promise;
      });
      try {
        expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
        const submitted = expectDefined(
          h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
        );
        submitted.focus();
        submitted.value = 'Submitted description';
        submitted.dispatchEvent(new Event('input', { bubbles: true }));
        submitted.blur();
        await published.promise;
        await flushMicrotasks(20);
        expect(await h.read()).toBe(expected);
        const other = h.node('B');
        h.state.set('taskStack', [other.root, ...other.path]);
        expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
        const live = expectDefined(
          h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
        );
        live.focus();
        live.value = 'New B';
        live.dispatchEvent(new Event('input', { bubbles: true }));
        live.setSelectionRange(2, 4);
        const stack = h.state.get('taskStack').map(taskNodeRef);
        late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
        await flushMicrotasks(20);
        expect(h.el.querySelector('.abyss-right-desc-edit')).toBe(live);
        expect(live.isConnected).toBe(true);
        expect(live.value).toBe('New B');
        expect([live.selectionStart, live.selectionEnd]).toEqual([2, 4]);
        expect(activeDocument.activeElement).toBe(live);
        expect(h.state.get('taskStack').map(taskNodeRef)).toEqual(stack);
        expect(await h.read()).toBe(expected);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(h.el.querySelector('.abyss-detached-draft-label')?.textContent).toBe(
          'A, description',
        );
        expect(h.el.querySelector('.abyss-detached-draft pre')?.textContent).toBe(
          'Submitted description',
        );
      } finally {
        late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
        await flushMicrotasks(20);
        unsubscribe();
        spy.mockRestore();
      }
    },
  );

  it.each(['QA-SP1j submitted', ''])(
    'does not recreate or assign a present same-owner entry with value %j',
    async (value) => {
      const h = await inspectorHarness('- [ ] A\n- [ ] B\nSentinel.\n', 'A');
      const unsubscribe = subscribeInspectorReconciliation(h);
      const late = deferred<TaskCommandResult>(),
        published = deferred<void>();
      const execute = h.api.execute.bind(h.api);
      const spy = vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
        const result = await execute(command);
        expect(result.type).toBe('ok');
        published.resolve(undefined);
        return late.promise;
      });
      try {
        expectDefined(
          h.el.querySelector<HTMLElement>('.abyss-subtask-section .abyss-subtask-add-row'),
        ).click();
        const submitted = expectDefined(
          h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
        );
        submitted.value = 'QA-SP1j submitted';
        submitted.dispatchEvent(new Event('input', { bubbles: true }));
        submitted.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await published.promise;
        await flushMicrotasks(20);
        const expected = '- [ ] A\n\t- [ ] QA-SP1j submitted ➕ 2026-09-05\n- [ ] B\nSentinel.\n';
        expect(await h.read()).toBe(expected);
        const live = expectDefined(
          h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'),
        );
        expect(live).toBe(submitted);
        live.value = value;
        live.dispatchEvent(new Event('input', { bubbles: true }));
        live.setSelectionRange(0, 0);
        late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
        await flushMicrotasks(20);
        expect(h.el.querySelector('.abyss-subtask-new-input')).toBe(live);
        expect(live.isConnected).toBe(true);
        expect(live.value).toBe(value);
        expect([live.selectionStart, live.selectionEnd]).toEqual([0, 0]);
        expect(activeDocument.activeElement).toBe(live);
        expect(await h.read()).toBe(expected);
        expect(h.state.get('taskStack').map(taskNodeRef)).toEqual([h.node('A').target]);
        expect(spy).toHaveBeenCalledTimes(1);
        if (value === '') {
          expect(h.el.querySelector('.abyss-detached-draft-label')?.textContent).toBe(
            'A, new subtask',
          );
          expect(h.el.querySelector('.abyss-detached-draft pre')?.textContent).toBe(
            'QA-SP1j submitted',
          );
        } else expect(h.el.querySelector('.abyss-detached-draft')).toBeNull();
      } finally {
        late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
        await flushMicrotasks(20);
        unsubscribe();
        spy.mockRestore();
      }
    },
  );
  it('trays an existing-comment draft whose original anchor changed at publication', async () => {
    const h = await inspectorHarness(
      '- [ ] A\n\t- 2026-07-13: Original\n- [ ] B\nSentinel.\n',
      'A',
    );
    const unsubscribe = subscribeInspectorReconciliation(h);
    const late = deferred<TaskCommandResult>(),
      published = deferred<void>();
    const execute = h.api.execute.bind(h.api);
    const spy = vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
      const result = await execute(command);
      expect(result.type).toBe('ok');
      published.resolve(undefined);
      return late.promise;
    });
    try {
      expectDefined(h.el.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const submitted = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
      );
      submitted.focus();
      submitted.value = 'Edited';
      submitted.dispatchEvent(new Event('input', { bubbles: true }));
      submitted.blur();
      await published.promise;
      await flushMicrotasks(20);
      const expected = '- [ ] A\n\t- 2026-07-13: Edited\n- [ ] B\nSentinel.\n';
      expect(await h.read()).toBe(expected);
      expect(h.el.querySelector('.abyss-comment-edit-input')).toBeNull();
      late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
      await flushMicrotasks(20);
      expect(h.el.querySelector('.abyss-comment-edit-input')).toBeNull();
      expect(h.el.querySelector('.abyss-comment-text')?.textContent).toBe('Edited');
      expect(h.el.querySelector('.abyss-detached-draft-label')?.textContent).toBe(
        'A, existing comment',
      );
      expect(h.el.querySelector('.abyss-detached-draft pre')?.textContent).toBe('Edited');
      expect(await h.read()).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      late.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unknown' });
      await flushMicrotasks(20);
      unsubscribe();
      spy.mockRestore();
    }
  });
});

describe('multiline inspector comment and description editing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });

  it('collapses multiline comments, retains disclosure through proven refresh and edits full text', async () => {
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
      holder.setText(source);
    });
    const h = await inspectorHarness('- [ ] Owner\n  - 2026-07-13: first\n    second', 'Owner');
    const row = expectDefined(h.el.querySelector('.abyss-comment-row'));
    expect(row.querySelector('.abyss-comment-text')?.textContent).toBe('first');
    const disclosure = expectDefined(row.querySelector<HTMLButtonElement>('button[aria-expanded]'));
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    disclosure.focus();
    disclosure.click();
    expect(disclosure.ownerDocument.activeElement).toBe(disclosure);
    expect(disclosure.isConnected).toBe(true);
    expect(row.querySelector('button[aria-expanded]')).toBe(disclosure);
    expect(row.querySelector('.abyss-comment-edit-input')).toBeNull();
    expect(row.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => {
      expect(row.querySelector('.abyss-comment-text')?.textContent).toContain('second');
    });
    await call<Promise<boolean>>(
      h.panel,
      'addComment',
      h.node('Owner').node,
      'single',
      row,
      expectDefined(h.el.querySelector('.abyss-comment-input')),
    );
    expect(h.el.querySelector('.abyss-comment-row')).toBe(row);
    expect(row.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    expect(h.el.querySelectorAll('.abyss-comment-row button[aria-expanded]')).toHaveLength(1);
    expectDefined(row.querySelector<HTMLElement>('.abyss-comment-text')).click();
    expect(row.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input')?.value).toBe(
      'first\nsecond',
    );
    expect(row.querySelector('button[aria-expanded]')).toBeNull();
  });

  it.each([false, true])(
    'submits a multiline description once on Enter (shift=%s) and retains its text',
    async (shiftKey) => {
      const h = await inspectorHarness('- [ ] Owner\n  - > old', 'Owner');
      expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
      const editor = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
      );
      const execute = vi.spyOn(h.api, 'execute');
      editor.value = 'one\ntwo';
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
      editor.dispatchEvent(new Event('blur'));
      await vi.waitFor(() => {
        expect(h.node('Owner').node.description).toBe('one\ntwo');
      });
      expect(event.defaultPrevented).toBe(true);
      expect(
        execute.mock.calls.filter(([command]) => command.type === 'set-description'),
      ).toHaveLength(1);
      expect(h.el.querySelector('.abyss-right-desc-edit')).toBeNull();
    },
  );

  it('deletes a cleared comment without producing a phantom detached draft', async () => {
    const h = await inspectorHarness('- [ ] Owner\n  - 2026-07-13: old comment', 'Owner');
    const off = subscribeInspectorReconciliation(h);
    try {
      expectDefined(h.el.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const editor = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
      );
      editor.value = '';
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => {
        expect(h.node('Owner').node.comments).toHaveLength(0);
      });
      await flushMicrotasks(20);
      expect(h.panel.captureDraftState()?.entries ?? []).toEqual([]);
      expect(h.el.textContent).not.toContain('Unsaved drafts');
    } finally {
      off();
    }
  });

  it('keeps Shift+Enter and both IME Enter forms from submitting a new comment', async () => {
    const h = await inspectorHarness('- [ ] Owner', 'Owner');
    const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
    const execute = vi.spyOn(h.api, 'execute');
    input.value = 'one\ntwo';
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    for (const ime of ['composing', 'legacy'] as const)
      expect(dispatchImeKey(input, 'Enter', ime).defaultPrevented).toBe(false);
    await flushMicrotasks();
    expect(event.defaultPrevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(input.value).toBe('one\ntwo');
  });

  it('normalizes comment submission without consuming a newer cleared entry draft', async () => {
    const h = await inspectorHarness('- [ ] Owner', 'Owner');
    const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
    const result = deferred<TaskCommandResult>();
    const realExecute = h.api.execute.bind(h.api);
    vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
      const committed = await realExecute(command);
      await result.promise;
      return committed;
    });
    input.focus();
    input.value = '  one  \n \n  two  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(h.node('Owner').node.comments[0]?.text).toBe('  one  \n  two  ');
    });
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    result.resolve({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: h.node('Owner').root },
    });
    await flushMicrotasks(30);
    expect(h.el.querySelector('.abyss-comment-input')).toBe(input);
    expect(input.value).toBe('');
    expect(input.isConnected).toBe(true);
  });
});

function submissionSelector(kind: 'create' | 'edit' | 'description'): string {
  const selectors = {
    create: '.abyss-comment-input',
    edit: '.abyss-comment-edit-input',
    description: '.abyss-right-desc-edit',
  };
  return selectors[kind];
}

describe('inspector submission waits for the original paste session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });

  it.each(['create', 'edit', 'description'] as const)(
    'awaits paste and submits once for %s',
    async (kind) => {
      const h = await inspectorHarness(
        '- [ ] Owner\n  - > old description\n  - 2026-07-13: old comment',
        'Owner',
      );
      const paste = deferred<void>();
      vi.spyOn(attachmentDrop, 'whenPasteSettled').mockReturnValue(paste.promise);
      const execute = vi.spyOn(h.api, 'execute');
      if (kind !== 'create')
        expectDefined(
          h.el.querySelector<HTMLElement>(
            kind === 'edit' ? '.abyss-comment-text' : '.abyss-right-desc-view',
          ),
        ).click();
      const input = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>(submissionSelector(kind)),
      );
      input.focus();
      input.value = 'one';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(execute).not.toHaveBeenCalled();
      input.value = 'one\ntwo';
      paste.resolve();
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledTimes(1);
      });
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ text: 'one\ntwo' });
    },
  );

  it.each(['create', 'edit', 'description'] as const)(
    'cancelling %s while paste is pending does not write later',
    async (kind) => {
      const h = await inspectorHarness(
        '- [ ] Owner\n  - > old description\n  - 2026-07-13: old comment',
        'Owner',
      );
      const paste = deferred<void>();
      vi.spyOn(attachmentDrop, 'whenPasteSettled').mockReturnValue(paste.promise);
      const execute = vi.spyOn(h.api, 'execute');
      if (kind !== 'create')
        expectDefined(
          h.el.querySelector<HTMLElement>(
            kind === 'edit' ? '.abyss-comment-text' : '.abyss-right-desc-view',
          ),
        ).click();
      const input = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>(submissionSelector(kind)),
      );
      input.focus();
      input.value = 'cancelled';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      paste.resolve();
      await flushMicrotasks(30);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'edit'] as const)(
    'navigation invalidates pending %s submission',
    async (kind) => {
      const h = await inspectorHarness(
        '- [ ] Owner\n  - 2026-07-13: old comment\n- [ ] Other',
        'Owner',
      );
      const paste = deferred<void>();
      vi.spyOn(attachmentDrop, 'whenPasteSettled').mockReturnValue(paste.promise);
      const execute = vi.spyOn(h.api, 'execute');
      if (kind === 'edit')
        expectDefined(h.el.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const input = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>(
          kind === 'create' ? '.abyss-comment-input' : '.abyss-comment-edit-input',
        ),
      );
      input.focus();
      input.value = 'old selection draft';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      h.state.set('taskStack', [h.node('Other').root]);
      paste.resolve();
      await flushMicrotasks(30);
      expect(execute).not.toHaveBeenCalled();
      expect(h.node('Other').node.comments).toHaveLength(0);
    },
  );
});

function pasteFile(input: HTMLTextAreaElement, bytes: Promise<ArrayBuffer>): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [{ name: 'saved.png', arrayBuffer: () => bytes }] },
  });
  input.dispatchEvent(event);
}

describe('real inspector attachment paste lifetime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });

  async function pastedInspector() {
    const h = await inspectorHarness(
      '- [ ] Owner\n  - 2026-07-13: old comment\n- [ ] Other',
      'Owner',
      { 'saved.png': '' },
    );
    vi.spyOn(h.app.fileManager, 'getAvailablePathForAttachment').mockResolvedValue('saved.png');
    vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockReturnValue('[[saved.png]]');
    const file = expectDefined(h.app.vault.getFileByPath('saved.png'));
    vi.spyOn(h.app.vault, 'createBinary').mockResolvedValue(file);
    return h;
  }

  it('ignores a cancelled paste after reusing the same entry and accepts its live subsequent paste', async () => {
    const h = await pastedInspector();
    const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
    input.focus();
    const stale = deferred<ArrayBuffer>();
    pasteFile(input, stale.promise);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.focus();
    input.value = 'new draft';
    input.setSelectionRange(9, 9);
    const live = deferred<ArrayBuffer>();
    pasteFile(input, live.promise);
    stale.resolve(new ArrayBuffer(1));
    await flushMicrotasks(30);
    expect(input.value).toBe('new draft');
    live.resolve(new ArrayBuffer(1));
    await attachmentDrop.whenPasteSettled(input);
    expect(input.value).toBe('new draft [[saved.png]]');
  });

  it.each(['create', 'edit'] as const)(
    'persists the settled attachment through %s Enter once',
    async (kind) => {
      const h = await pastedInspector();
      if (kind === 'edit')
        expectDefined(h.el.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const input = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>(submissionSelector(kind)),
      );
      const bytes = deferred<ArrayBuffer>();
      const execute = vi.spyOn(h.api, 'execute');
      input.focus();
      input.value = 'one\ntwo';
      input.setSelectionRange(7, 7);
      pasteFile(input, bytes.promise);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(execute).not.toHaveBeenCalled();
      bytes.resolve(new ArrayBuffer(1));
      await vi.waitFor(() => {
        expect(
          h
            .node('Owner')
            .node.comments.some((comment) => comment.text === 'one\ntwo [[saved.png]]'),
        ).toBe(true);
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['navigate', 'dispose'] as const)(
    'suppresses a deferred paste after %s',
    async (action) => {
      const h = await pastedInspector();
      const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
      input.value = 'original';
      const bytes = deferred<ArrayBuffer>();
      pasteFile(input, bytes.promise);
      if (action === 'navigate') h.state.set('taskStack', [h.node('Other').root]);
      else h.panel.destroy();
      bytes.resolve(new ArrayBuffer(1));
      await attachmentDrop.whenPasteSettled(input);
      expect(input.value).toBe('original');
    },
  );
});

it('starts a fresh comment submission while the cancelled paste submission remains pending', async () => {
  const h = await inspectorHarness('- [ ] Owner', 'Owner', { 'saved.png': '' });
  try {
    vi.spyOn(h.app.fileManager, 'getAvailablePathForAttachment').mockResolvedValue('saved.png');
    vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockReturnValue('[[saved.png]]');
    vi.spyOn(h.app.vault, 'createBinary').mockResolvedValue(
      expectDefined(h.app.vault.getFileByPath('saved.png')),
    );
    const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
    const stale = deferred<ArrayBuffer>();
    input.focus();
    input.value = 'cancelled';
    pasteFile(input, stale.promise);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.focus();
    input.value = 'live';
    input.setSelectionRange(4, 4);
    const live = deferred<ArrayBuffer>();
    pasteFile(input, live.promise);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    live.resolve(new ArrayBuffer(1));
    await vi.waitFor(() => {
      expect(h.node('Owner').node.comments[0]?.text).toBe('live [[saved.png]]');
    });
    stale.resolve(new ArrayBuffer(1));
    await flushMicrotasks(30);
    expect(h.node('Owner').node.comments).toHaveLength(1);
  } finally {
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
  }
});

it.each([
  { submitted: '', newer: 'newer typed' },
  { submitted: '  edited  \n \nsecond', newer: 'newer typed' },
  { submitted: '  edited  \n \nsecond', newer: '' },
])(
  'preserves the newer existing-comment draft after submitting $submitted',
  async ({ submitted, newer }) => {
    const h = await inspectorHarness('- [ ] Owner\n  - old comment', 'Owner');
    const late = deferred<void>();
    const published = deferred<void>();
    const execute = h.api.execute.bind(h.api);
    vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
      const result = await execute(command);
      published.resolve();
      await late.promise;
      return result;
    });
    try {
      expectDefined(h.el.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const input = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
      );
      input.value = submitted;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await published.promise;
      input.value = newer;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      late.resolve();
      await flushMicrotasks(30);
      const live = h.panel
        .captureDraftState()
        ?.entries.find((entry) => entry.kind === 'existing-comment');
      if (live !== undefined) expect(live.value).toBe(newer);
      else {
        const preserved = expectDefined(h.el.querySelector('.abyss-detached-draft pre'));
        expect(preserved.textContent).toBe(newer);
      }
      expect(h.node('Owner').node.comments.map((comment) => comment.text)).toEqual(
        submitted === '' ? [] : ['  edited  \nsecond'],
      );
    } finally {
      late.resolve();
      for (const cleanup of inspectorCleanups.splice(0)) cleanup();
      vi.restoreAllMocks();
    }
  },
);

describe('nested existing comment continuity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });
  it.each(
    ['plain', 'stopped', 'active'].flatMap((mode) =>
      ['result-first', 'index-first'].flatMap((order) =>
        ['update', 'delete'].map((operation) => ({ mode, order, operation })),
      ),
    ),
  )(
    'retains the exact owner and controls for $mode $order $operation',
    async ({ mode, order, operation }) => {
      const trackingEnd = mode === 'active' ? '...' : '2026-10-06T09:20:00+07:00';
      const tracking =
        mode === 'plain' ? '' : `\n      - 2026-10-06T09:00:00+07:00 → ${trackingEnd}`;
      const source = `- [ ] Root\n  - [ ] Branch\n    - [ ] Owner\n      - 2026-10-06: old\n        second\n      - neighbor\n      - [ ] Child${tracking}\n  - [ ] Sibling`;
      const h = await inspectorHarness(source, 'Owner');
      const off = order === 'index-first' ? subscribeInspectorReconciliation(h) : () => {};
      try {
        const header = expectDefined(h.el.querySelector('.abyss-right-header'));
        const create = expectDefined(h.el.querySelector('.abyss-comment-input'));
        const rows = [...h.el.querySelectorAll('.abyss-comment-row')];
        const neighbor = expectDefined(rows[1]);
        expectDefined(
          expectDefined(rows[0]).querySelector<HTMLElement>('.abyss-comment-text'),
        ).click();
        const input = expectDefined(
          h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input'),
        );
        input.value = operation === 'delete' ? '' : 'updated\n- [ ] literal\nthird';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => {
          expect(h.node('Owner').node.comments[0]?.text).toBe(
            operation === 'delete' ? 'neighbor' : 'updated\n\\- [ ] literal\nthird',
          );
          expect(h.el.querySelector('.abyss-comment-edit-input')).toBeNull();
        });
        expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
          'Root',
          'Branch',
          'Owner',
        ]);
        expect(
          taskNodeRef(expectDefined(h.state.get('taskStack')[h.state.get('taskStack').length - 1])),
        ).toEqual(taskNodeRef(h.node('Owner').node));
        expect(h.el.querySelector('.abyss-right-header')).toBe(header);
        expect(h.el.querySelector('.abyss-comment-input')).toBe(create);
        expect(header.isConnected && create.isConnected && neighbor.isConnected).toBe(true);
        expect(h.el.querySelectorAll('.abyss-comment-row')).toHaveLength(
          operation === 'delete' ? 1 : 2,
        );
        expect(neighbor.querySelector('.abyss-comment-text')?.textContent).toBe('neighbor');
        expect(h.el.querySelector('.abyss-detached-drafts')).toBeNull();
        expect(await h.read()).toBe(
          source.replace(
            '      - 2026-10-06: old\n        second\n',
            operation === 'delete'
              ? ''
              : '      - 2026-10-06: updated\n        \\- [ ] literal\n        third\n',
          ),
        );
      } finally {
        off();
      }
    },
  );
});

describe('all live paste settlement in the inspector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });
  async function setup() {
    const h = await inspectorHarness('- [ ] Owner\n  - old', 'Owner', { 'saved.png': '' });
    vi.spyOn(h.app.fileManager, 'getAvailablePathForAttachment').mockResolvedValue('saved.png');
    vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockReturnValue('[[saved.png]]');
    vi.spyOn(h.app.vault, 'createBinary').mockResolvedValue(
      expectDefined(h.app.vault.getFileByPath('saved.png')),
    );
    return h;
  }
  it.each(['create', 'edit'] as const)(
    'waits for A after faster B before %s submission',
    async (kind) => {
      const h = await setup();
      if (kind === 'edit')
        expectDefined(h.el.querySelector<HTMLElement>('.abyss-comment-text')).click();
      const input = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>(submissionSelector(kind)),
      );
      input.value = 'one\ntwo';
      input.setSelectionRange(7, 7);
      const a = deferred<ArrayBuffer>(),
        b = deferred<ArrayBuffer>();
      pasteFile(input, a.promise);
      pasteFile(input, b.promise);
      const execute = vi.spyOn(h.api, 'execute');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      b.resolve(new ArrayBuffer(1));
      await flushMicrotasks(40);
      expect(execute).not.toHaveBeenCalled();
      expect(input.value).toBe('one\ntwo [[saved.png]]');
      a.resolve(new ArrayBuffer(1));
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledTimes(1);
      });
      expect(
        h
          .node('Owner')
          .node.comments.some((comment) => comment.text === 'one\ntwo [[saved.png]] [[saved.png]]'),
      ).toBe(true);
    },
  );
  it('submits fresh plaintext before a cancelled session file finishes without replacement paste', async () => {
    const h = await setup();
    const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
    const a = deferred<ArrayBuffer>();
    input.value = 'cancelled';
    pasteFile(input, a.promise);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.focus();
    input.value = 'live plaintext';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks(50);
    expect(h.node('Owner').node.comments.map((comment) => comment.text)).toEqual([
      'old',
      'live plaintext',
    ]);
    a.resolve(new ArrayBuffer(1));
    await flushMicrotasks(40);
    expect(input.value).toBe('');
    expect(h.node('Owner').node.comments.map((comment) => comment.text)).toEqual([
      'old',
      'live plaintext',
    ]);
  });
});

describe('owned tracked completion publications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  });
  it.each(
    ['Owner', 'Leaf'].flatMap((selected) => [false, true].map((short) => ({ selected, short }))),
  )(
    'keeps selected $selected controls through status and timer close publications (short=$short)',
    async ({ selected, short }) => {
      const h = await inspectorHarness(
        `- [ ] Root\n  - [ ] Owner\n    - [ ] Leaf\n      - 2026-09-05T11:00:00Z → 2026-09-05T11:01:00Z\n      - 2026-09-05T${short ? '11:59:30' : '11:58:00'}Z →\n  - [ ] Neighbor\n    - 2026-09-05T11:55:00Z →`,
        selected,
      );
      const off = subscribeInspectorReconciliation(h);
      const header = expectDefined(h.el.querySelector('.abyss-right-header'));
      const input = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
      input.value = 'pending local draft';
      const observations: boolean[] = [];
      const stop = h.state.on('taskStack', () => {
        observations.push(header.isConnected && input.isConnected);
      });
      try {
        const leaf = h.node('Leaf').node;
        await call<Promise<void>>(h.panel, 'toggleTaskLike', leaf);
        await flushMicrotasks(30);
        expect(h.node('Leaf').node.status).toBe('done');
        expect(h.node('Leaf').node.timeEntries.map((entry) => entry.state)).toEqual(
          short ? ['closed'] : ['closed', 'closed'],
        );
        expect(h.node('Neighbor').node.timeEntries[0]?.state).toBe('running');
        expect(h.state.get('taskStack').map((node) => node.title)).toEqual(
          selected === 'Owner' ? ['Root', 'Owner'] : ['Root', 'Owner', 'Leaf'],
        );
        expect(observations.length).toBeGreaterThanOrEqual(2);
        expect(observations.every(Boolean)).toBe(true);
        expect(h.el.querySelector('.abyss-right-header')).toBe(header);
        expect(h.el.querySelector('.abyss-comment-input')).toBe(input);
        expect(input.value).toBe('pending local draft');
        expect(h.el.querySelector('.abyss-detached-drafts')).toBeNull();
      } finally {
        stop();
        off();
      }
    },
  );
});

it('retires completion follow-up ownership with newer selection and settled commands', async () => {
  const h = await inspectorHarness(
    '- [ ] Root\n  - [ ] Owner\n    - [ ] Leaf\n      - 2026-09-05T11:58:00Z →\n  - [ ] Neighbor',
    'Owner',
  );
  const held = deferred<void>();
  const execute = h.api.execute.bind(h.api);
  vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
    const result = await execute(command);
    await held.promise;
    return result;
  });
  let follow:
    | {
        witness: CompletionTrackingWitness;
        current: TaskSnapshot;
        stack: Array<TaskSnapshot | SubtaskSnapshot>;
      }
    | undefined;
  const off = h.index.subscribe(() => {
    const stack = h.state.get('taskStack');
    const root = expectDefined(stack[0]);
    const resolution = h.index.resolve((root as TaskSnapshot).ref);
    if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition') return;
    const witness = resolution.basis.authorityTransition?.completionTracking;
    if (witness !== undefined) {
      follow = { witness, current: resolution.current, stack };
      expect(
        h.panel.ownedRefForCompletionFollowUp(resolution.current, stack, undefined),
      ).toBeUndefined();
      expect(
        h.panel.ownedRefForCompletionFollowUp(resolution.current, stack, {
          ...witness,
          before: { ...witness.before, line: 99 },
        }),
      ).toBeUndefined();
      expect(
        h.panel.ownedRefForCompletionFollowUp(resolution.current, stack, {
          ...witness,
          entry: { ...witness.entry, originalMarkdown: 'forged' },
        }),
      ).toBeUndefined();
      expect(h.panel.ownedRefForCompletionFollowUp(resolution.current, stack, witness)).toEqual(
        witness.before,
      );
      return;
    }
    const owned = h.panel.selectionForOwnedTransition(
      resolution.previous.ref,
      resolution.current,
      stack,
    );
    const draft = h.panel.captureDraftStateForOwnedTransition(
      resolution.previous.ref,
      resolution.current.ref,
    );
    h.state.updateInspectorSelection(expectDefined(owned));
    h.panel.restoreDraftState(draft, resolution.current);
  });
  try {
    const completion = call<Promise<void>>(h.panel, 'toggleTaskLike', h.node('Leaf').node);
    await flushMicrotasks(30);
    const captured = expectDefined(follow);
    h.state.set('taskStack', [h.node('Root').root]);
    expect(
      h.panel.ownedRefForCompletionFollowUp(captured.current, captured.stack, captured.witness),
    ).toBeUndefined();
    held.resolve();
    await completion;
    expect(
      h.panel.ownedRefForCompletionFollowUp(captured.current, captured.stack, captured.witness),
    ).toBeUndefined();
  } finally {
    off();
    held.resolve();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
  }
});

it('ordinary stop does not acquire completion follow-up evidence', async () => {
  const h = await inspectorHarness('- [ ] Current\n  - 2026-09-05T11:58:00Z →');
  const previous = expectDefined(h.index.list()[0]);
  const evidence: unknown[] = [];
  const off = h.index.subscribe(() => {
    const resolution = h.index.resolve(previous.ref);
    if (resolution.type === 'rebased')
      evidence.push(resolution.basis.authorityTransition?.completionTracking);
  });
  try {
    expect((await h.api.execute({ type: 'stop-tracking' })).type).toBe('ok');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((item) => item === undefined)).toBe(true);
  } finally {
    off();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  }
});

it('aborts completion witness staging when its source callback rejects', async () => {
  const h = await inspectorHarness('- [ ] Current\n  - 2026-09-05T11:58:00Z →');
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementation((file, transform, options) =>
    process(
      file,
      (content) => {
        const candidate = transform(content);
        if (candidate.includes('→ 2026-09-05T12:00:00')) throw new Error('rejected close callback');
        return candidate;
      },
      options,
    ),
  );
  try {
    const original = expectDefined(h.index.list()[0]);
    await h.api.execute({ type: 'toggle-completion', target: { type: 'task', ref: original.ref } });
    const content = await h.app.vault.read(h.file);
    const current = expectDefined(h.index.installCommittedContent('tasks.md', content)[0]);
    expect(current.status).toBe('done');
    expect(current.timeEntries[0]?.state).toBe('running');
    const resolution = h.index.resolve(current.ref);
    expect(resolution.type).toBe('exact');
    if (resolution.type === 'exact')
      expect(resolution.basis.authorityTransition?.completionTracking).toBeUndefined();
    expect(content).not.toContain('→ 2026-09-05T12:00:00');
  } finally {
    vi.restoreAllMocks();
    for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  }
});
