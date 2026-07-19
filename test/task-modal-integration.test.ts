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
import { createAppWithFiles, flushMicrotasks, task, testStatusRegistry } from './helpers';

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
    const queries: TaskQueryApi = {
      list: () => [current],
      forCalendarDates: () => [current],
      resolve: () => resolution,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
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
});
