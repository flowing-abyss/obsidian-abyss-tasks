import type * as ObsidianModule from 'obsidian';
import { Notice, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type {
  TaskApplicationApi,
  TaskCreateSession,
  TaskIndexEvent,
  TaskSnapshot,
} from '../src/tasks';
import type { InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import {
  expectDefined,
  freshContainer,
  queryApiForTasks,
  resolvedConfig,
  task,
  useRealMoment,
} from './helpers';

useRealMoment();
vi.useFakeTimers();

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  class MockModal {
    app: App;
    contentEl: HTMLElement;
    containerEl: HTMLElement;
    onSubmit?: (text: string) => Promise<void>;
    constructor(app: App) {
      this.app = app;
      this.containerEl = createFragment().createDiv();
      activeDocument.body.appendChild(this.containerEl);
      this.contentEl = this.containerEl.createDiv();
    }
    open(): void {
      this.onOpen();
    }
    close(): void {
      this.onClose();
      this.containerEl.remove();
    }
    onOpen(): void {}
    onClose(): void {}
  }
  return { ...actual, Modal: MockModal, Notice: vi.fn() };
});

// Import AFTER vi.mock
import { CalendarRenderer } from '../src/ui/CalendarRenderer';

class StubStore {
  private tasks: TaskSnapshot[] = [];
  private readonly listeners = new Set<(event: TaskIndexEvent) => void>();
  taskQueries = queryApiForTasks(
    () => this.tasks,
    (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  );
  emit(changedFile?: string): void {
    for (const listener of this.listeners) {
      listener({ type: 'changed', files: changedFile === undefined ? [] : [changedFile] });
    }
  }
  setTasks(t: TaskSnapshot[]): void {
    this.tasks = t;
  }
  toggleTask = vi.fn();
  execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
    type: 'invalid',
    issues: [{ code: 'invalid-target' }],
  });
  create = vi.fn<Extract<TaskCreateSession, { type: 'ready' }>['execute']>().mockResolvedValue({
    type: 'ok',
    changed: true,
    outcome: { type: 'task', task: task({ title: 'Created' }) },
  });
  planCreate = vi.fn(async () => ({
    type: 'ready' as const,
    destination: { filePath: 'tasks/active.md', insertion: { type: 'append' as const } },
    execute: this.create,
  }));
  addTask = vi.fn<(date: string, text: string) => Promise<void>>().mockResolvedValue(undefined);
}

function fakeApp(): App {
  return {} as App;
}

async function settleSubmission(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function expectCreateCommand(store: StubStore, markdownBody: string): void {
  const request = expectDefined(store.create.mock.calls[0]?.[0]);
  expect(request.markdownBody).toBe(markdownBody);
  expect(request.initial?.due?.type).toBe('set');
  if (request.initial?.due?.type !== 'set') throw new Error('Expected a due date');
  expect(typeof request.initial.due.value).toBe('string');
}

function makeRenderer(
  ...[root, store, config, app, interactionOwnership]: readonly [
    root: HTMLElement,
    store: StubStore,
    config: ReturnType<typeof resolvedConfig>,
    app: App,
    interactionOwnership?: InteractionOwnershipPort,
  ]
): CalendarRenderer {
  return new CalendarRenderer(
    root,
    config,
    app,
    store.taskQueries,
    { queries: store.taskQueries, execute: store.execute, planCreate: store.planCreate },
    new StatusRegistry(buildDefaultTaskStatuses()),
    undefined,
    undefined,
    interactionOwnership,
  );
}

describe('CalendarRenderer TaskInputModal submit', () => {
  let store: StubStore;
  let root: HTMLElement;
  let renderer: CalendarRenderer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(Notice).mockClear();
    store = new StubStore();
    root = freshContainer();
    renderer = makeRenderer(root, store, resolvedConfig({ defaultView: 'month' }), fakeApp());
    renderer.mount();
  });

  afterEach(() => {
    renderer.destroy();
    // Clear any modal containers leaked into activeDocument.body between tests
    activeDocument.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('onCellClick opens modal with input + Add button in activeDocument', () => {
    // trigger onCellClick by clicking a current-month cell (not task/cellName)
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // modal contentEl should be in activeDocument.body
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const addBtn = Array.from(activeDocument.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add',
    );
    expect(addBtn).not.toBeNull();
  });

  it('uses an optional ownership port for the legacy add-task modal and releases on submit', async () => {
    renderer.destroy();
    const release = vi.fn();
    const interactionOwnership = { acquire: vi.fn(() => ({ release })) };
    renderer = makeRenderer(
      root,
      store,
      resolvedConfig({ defaultView: 'month' }),
      fakeApp(),
      interactionOwnership,
    );
    renderer.mount();

    expectDefined(root.querySelector<HTMLElement>('.cell.currentMonth')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(interactionOwnership.acquire).toHaveBeenCalledOnce();
    expect(interactionOwnership.acquire).toHaveBeenCalledWith({ blocksShortcuts: true });
    const input = expectDefined(
      activeDocument.body.querySelector<HTMLInputElement>('input[type="text"]'),
    );
    input.value = 'Owned capture';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleSubmission();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases owned add-task modals on replacement and renderer destruction', () => {
    renderer.destroy();
    const releases = [vi.fn(), vi.fn()];
    const interactionOwnership = {
      acquire: vi
        .fn()
        .mockReturnValueOnce({ release: releases[0] })
        .mockReturnValueOnce({ release: releases[1] }),
    };
    renderer = makeRenderer(
      root,
      store,
      resolvedConfig({ defaultView: 'month' }),
      fakeApp(),
      interactionOwnership,
    );
    renderer.mount();
    const cell = expectDefined(root.querySelector<HTMLElement>('.cell.currentMonth'));

    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(interactionOwnership.acquire).toHaveBeenCalledTimes(2);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(activeDocument.body.querySelectorAll('input[type="text"]')).toHaveLength(1);

    renderer.destroy();
    renderer.destroy();
    expect(releases[1]).toHaveBeenCalledOnce();
    expect(activeDocument.body.querySelector('input[type="text"]')).toBeNull();
  });

  it('plans once on open and submits through the retained session with a due date', async () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(store.planCreate).toHaveBeenCalledExactlyOnceWith({ type: 'configured-default' });
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '  Buy milk  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleSubmission();
    expectCreateCommand(store, 'Buy milk');
    expect(store.addTask).not.toHaveBeenCalled();
  });

  it('Add button click submits through the retained create session', async () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'Task via button';
    const addBtn = expectDefined(
      Array.from(activeDocument.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Add',
      ),
    );
    addBtn.click();
    await settleSubmission();
    expectCreateCommand(store, 'Task via button');
  });

  it('empty/whitespace input sends no create command', () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.create).not.toHaveBeenCalled();
  });

  it('cancels an opened planned modal without executing the session', () => {
    expectDefined(root.querySelector<HTMLElement>('.cell.currentMonth')).click();
    expect(store.planCreate).toHaveBeenCalledOnce();

    renderer.destroy();

    expect(store.create).not.toHaveBeenCalled();
    expect(activeDocument.body.querySelector('input[type="text"]')).toBeNull();
  });

  it('owns one pending submission and prevents duplicate execution', async () => {
    let resolveCreate!: (result: Awaited<ReturnType<typeof store.create>>) => void;
    store.create.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    expectDefined(root.querySelector<HTMLElement>('.cell.currentMonth')).click();
    const input = expectDefined(
      activeDocument.body.querySelector<HTMLInputElement>('input[type="text"]'),
    );
    input.value = 'Pending task';

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleSubmission();

    expect(store.create).toHaveBeenCalledOnce();
    expect(input.disabled).toBe(true);
    resolveCreate({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: task({ title: 'Pending task' }) },
    });
    await settleSubmission();
    expect(activeDocument.body.querySelector('input[type="text"]')).toBeNull();
  });

  it('create receives the clicked cell date as its initial due date', async () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    const expectedDate =
      cell.querySelector('.cellName')?.getAttribute('href')?.split('/').pop() ??
      cell.querySelector('.cellName')?.getAttribute('href');
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'test';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleSubmission();
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: { due: { type: 'set', value: expectedDate } },
      }),
    );
  });

  it('reports a failed modal create through the shared creation result Notice adapter', async () => {
    store.create.mockResolvedValueOnce({
      type: 'invalid',
      issues: [{ code: 'invalid-title', field: 'title' }],
    });
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'Task from modal';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await settleSubmission();
    expect(Notice).toHaveBeenCalledWith('The new task is invalid and was not created.');
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('Task from modal');
  });

  it('keeps a failed draft focused and retries it without replanning', async () => {
    store.create
      .mockResolvedValueOnce({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unknown',
      })
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: task({ title: 'Retried' }) },
      });
    expectDefined(root.querySelector<HTMLElement>('.cell.currentMonth')).click();
    const input = expectDefined(
      activeDocument.body.querySelector<HTMLInputElement>('input[type="text"]'),
    );
    input.value = 'Retained draft';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleSubmission();

    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('Retained draft');
    expect(activeDocument.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleSubmission();
    expect(store.planCreate).toHaveBeenCalledOnce();
    expect(store.create).toHaveBeenCalledTimes(2);
    expect(activeDocument.body.querySelector('input[type="text"]')).toBeNull();
  });
});
