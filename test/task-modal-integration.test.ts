import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  TaskApplicationApi,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
  TaskSnapshot,
} from '../src/tasks';
import { TaskModal } from '../src/ui/TaskModal';
import {
  createAppWithFiles,
  flushMicrotasks,
  task,
  taskQueryApi,
  testStatusRegistry,
} from './helpers';

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('TaskModal with real RightPanel', () => {
  let modal: TaskModal | undefined;

  afterEach(() => {
    modal?.close();
    activeDocument.querySelectorAll('.tc-status-popover').forEach((element) => element.remove());
  });

  it('shares the header status control, rebuilds command results, and owns its refresh', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [w] Modal task\n' });
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
    const initialRef: TaskRef = { filePath: 'f.md', line: 0, revision: 'revision-0' };
    let current = task({
      title: 'Modal task',
      status: 'in-progress',
      statusSymbol: 'w',
      priority: 'F',
      ref: initialRef,
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [w] Modal task',
        originalBlock: '- [w] Modal task',
      },
    });
    let listener: ((event: TaskIndexEvent) => void) | undefined;
    let resolution: TaskResolution = { type: 'exact', task: current };
    const queries: TaskQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    let revision = 0;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(async (command) => {
      revision += 1;
      const nextRef: TaskRef = { ...current.ref, revision: `revision-${revision}` };
      const next: TaskSnapshot = task({
        ...current,
        ref: nextRef,
        status:
          command.type === 'toggle-completion'
            ? 'done'
            : command.type === 'set-status'
              ? 'in-progress'
              : current.status,
        statusSymbol:
          command.type === 'toggle-completion'
            ? 'x'
            : command.type === 'set-status'
              ? command.symbol
              : current.statusSymbol,
        priority:
          command.type === 'patch' && command.patch.priority?.type === 'set'
            ? command.patch.priority.value
            : current.priority,
      });
      current = next;
      return { type: 'ok', changed: true, outcome: { type: 'task', task: next } };
    });
    const tasks: TaskApplicationApi = { queries, execute };
    modal = new TaskModal(app, registry, DEFAULT_SETTINGS, queries, tasks);

    modal.open(current);

    const header = activeDocument.querySelector<HTMLElement>('.tc-modal .tc-right-header')!;
    const initialMarker = header.querySelector<HTMLElement>(':scope > .tc-status-marker')!;
    expect(initialMarker).not.toBeNull();
    expect(initialMarker.nextElementSibling).toBe(header.querySelector(':scope > .tc-right-title'));
    expect(initialMarker.getAttribute('data-status')).toBe('status-waiting');
    expect(initialMarker.getAttribute('data-priority')).toBe('F');

    click(initialMarker);
    await flushMicrotasks();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ type: 'toggle-completion' });
    expect(activeDocument.querySelector('.tc-modal-backdrop')).not.toBeNull();
    expect(activeDocument.querySelector('.tc-modal-close-btn')).not.toBeNull();
    expect(
      activeDocument
        .querySelector('.tc-modal .tc-right-header > .tc-status-marker')
        ?.getAttribute('data-status'),
    ).toBe('status-3');

    activeDocument
      .querySelector<HTMLElement>('.tc-modal .tc-right-header > .tc-status-marker')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const waiting = Array.from(
      activeDocument.querySelectorAll<HTMLElement>('.tc-status-popover-row'),
    ).find((row) => row.textContent?.includes('Waiting'))!;
    click(waiting);
    await flushMicrotasks();
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: 'set-status', symbol: 'w' });
    expect(activeDocument.querySelector('.tc-modal-close-btn')).not.toBeNull();
    expect(
      activeDocument
        .querySelector('.tc-modal .tc-right-header > .tc-status-marker')
        ?.getAttribute('data-status'),
    ).toBe('status-waiting');

    activeDocument
      .querySelector<HTMLElement>('.tc-modal .tc-right-header > .tc-status-marker')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    click(
      activeDocument.querySelector<HTMLElement>(".tc-status-popover-flag[data-tc-priority='A']")!,
    );
    await flushMicrotasks();
    expect(execute.mock.calls[2]?.[0]).toMatchObject({
      type: 'patch',
      patch: { priority: { type: 'set', value: 'A' } },
    });
    expect(activeDocument.querySelector('.tc-modal-close-btn')).not.toBeNull();
    expect(
      activeDocument
        .querySelector('.tc-modal .tc-right-header > .tc-status-marker')
        ?.getAttribute('data-priority'),
    ).toBe('A');

    const refreshed = task({
      ...current,
      status: 'cancelled',
      statusSymbol: '-',
      priority: 'B',
    });
    resolution = { type: 'conflict', current: refreshed };
    listener?.({ type: 'changed', files: ['f.md'] });

    const refreshedMarker = activeDocument.querySelector<HTMLElement>(
      '.tc-modal .tc-right-header > .tc-status-marker',
    );
    expect(activeDocument.querySelector('.tc-modal-backdrop')).not.toBeNull();
    expect(activeDocument.querySelector('.tc-task-selection-stale')).toBeNull();
    expect(refreshedMarker?.getAttribute('data-status')).toBe('status-4');
    expect(refreshedMarker?.getAttribute('data-priority')).toBe('B');
    const closeButton = activeDocument.querySelector<HTMLElement>('.tc-modal-close-btn');
    expect(closeButton).not.toBeNull();
    click(closeButton!);
    expect(activeDocument.querySelector('.tc-modal-backdrop')).toBeNull();
  });

  it('inherits the one shared recurrence editor through RightPanel reuse', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal repeat 📅 2026-08-09\n' });
    const current = task({
      title: 'Modal repeat',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal repeat 📅 2026-08-09',
        originalBlock: '- [ ] Modal repeat 📅 2026-08-09',
      },
    });
    const queries: TaskQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current }),
    });
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: current },
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute,
    });
    modal.open(current);

    const repeatChip = activeDocument.querySelector<HTMLElement>('.tc-modal .tc-repeat-chip')!;
    click(repeatChip);

    expect(activeDocument.querySelectorAll('.tc-recurrence-editor')).toHaveLength(1);
    expect(activeDocument.querySelectorAll('.tc-modal .tc-recurrence-editor')).toHaveLength(1);
    expect(activeDocument.querySelector('.tc-modal .tc-recurrence-popover')).not.toBeNull();

    activeDocument
      .querySelector<HTMLElement>('.tc-modal .tc-recurrence-editor')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(activeDocument.querySelector('.tc-modal-backdrop')).not.toBeNull();
    expect(activeDocument.querySelector('.tc-modal .tc-recurrence-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(repeatChip);
  });

  it('keeps the modal open when Escape dismisses its status menu', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal status\n' });
    const current = task({
      title: 'Modal status',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal status',
        originalBlock: '- [ ] Modal status',
      },
    });
    const queries: TaskQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current }),
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
    });
    modal.open(current);
    const marker = activeDocument.querySelector<HTMLElement>(
      '.tc-modal .tc-right-header > .tc-status-marker',
    )!;

    marker.focus();
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    activeDocument
      .querySelector<HTMLButtonElement>('.tc-status-popover-flag')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

    expect(activeDocument.querySelector('.tc-status-popover')).toBeNull();
    expect(activeDocument.querySelector('.tc-modal-backdrop')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(marker);
  });

  it('keeps the modal open when Escape dismisses its focused priority popover', async () => {
    const app = await createAppWithFiles({ 'f.md': '- [ ] Modal priority ⏬\n' });
    const current = task({
      title: 'Modal priority',
      priority: 'F',
      source: {
        filePath: 'f.md',
        line: 0,
        originalMarkdown: '- [ ] Modal priority ⏬',
        originalBlock: '- [ ] Modal priority ⏬',
      },
    });
    const queries: TaskQueryApi = taskQueryApi({
      list: () => [current],
      resolve: () => ({ type: 'exact', task: current }),
    });
    modal = new TaskModal(app, testStatusRegistry(), DEFAULT_SETTINGS, queries, {
      queries,
      execute: vi.fn<TaskApplicationApi['execute']>(),
    });
    modal.open(current);
    const chip = activeDocument.querySelector<HTMLButtonElement>('.tc-modal .tc-priority-chip')!;

    chip.focus();
    click(chip);
    const selected = activeDocument.querySelector<HTMLButtonElement>(
      '.tc-modal .tc-priority-option.is-active',
    )!;
    expect(activeDocument.activeElement).toBe(selected);

    selected.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(activeDocument.querySelector('.tc-modal .tc-priority-popover')).toBeNull();
    expect(activeDocument.querySelector('.tc-modal-backdrop')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(chip);
  });
});
