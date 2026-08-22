import { Notice, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskApplicationApi, TaskIndexEvent, TaskSnapshot } from '../src/tasks';
import { freshContainer, queryApiForTasks, resolvedConfig, useRealMoment } from './helpers';

useRealMoment();
vi.useFakeTimers();

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
  class MockModal {
    app: App;
    contentEl: HTMLElement;
    containerEl: HTMLElement;
    onSubmit?: (text: string) => Promise<void>;
    constructor(app: App) {
      this.app = app;
      this.containerEl = activeDocument.createElement('div');
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
  private listeners = new Set<(event: TaskIndexEvent) => void>();
  taskQueries = queryApiForTasks(
    () => this.tasks,
    (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  );
  emit(changedFile?: string): void {
    for (const listener of this.listeners) {
      listener({ type: 'changed', files: changedFile ? [changedFile] : [] });
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
  addTask = vi.fn<(date: string, text: string) => Promise<void>>().mockResolvedValue(undefined);
}

function fakeApp(): App {
  return {} as App;
}

function makeRenderer(
  root: HTMLElement,
  store: StubStore,
  config: ReturnType<typeof resolvedConfig>,
  app: App,
): CalendarRenderer {
  return new CalendarRenderer(
    root,
    config,
    app,
    store.taskQueries,
    { queries: store.taskQueries, execute: store.execute },
    new StatusRegistry(buildDefaultTaskStatuses()),
    '- [ ] ',
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

  it('Enter with text sends one configured create command with a due date', () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '  Buy milk  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.execute).toHaveBeenCalledWith({
      type: 'create',
      destination: { type: 'configured-default' },
      markdownBody: '- [ ] Buy milk',
      initial: { due: { type: 'set', value: expect.any(String) } },
    });
    expect(store.addTask).not.toHaveBeenCalled();
  });

  it('Add button click sends a configured create command', () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'Task via button';
    const addBtn = Array.from(activeDocument.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add',
    )!;
    addBtn.click();
    expect(store.execute).toHaveBeenCalledWith({
      type: 'create',
      destination: { type: 'configured-default' },
      markdownBody: '- [ ] Task via button',
      initial: { due: { type: 'set', value: expect.any(String) } },
    });
  });

  it('empty/whitespace input sends no create command', () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.execute).not.toHaveBeenCalled();
  });

  it('create receives the clicked cell date as its initial due date', () => {
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    const expectedDate =
      cell.querySelector('.cellName')?.getAttribute('href')?.split('/').pop() ??
      cell.querySelector('.cellName')?.getAttribute('href');
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'test';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: { due: { type: 'set', value: expectedDate } },
      }),
    );
  });

  it('reports a failed modal create through the shared creation result Notice adapter', async () => {
    store.execute.mockResolvedValueOnce({
      type: 'invalid',
      issues: [{ code: 'invalid-title', field: 'title' }],
    });
    const cell = root.querySelector('.cell.currentMonth') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = activeDocument.body.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'Task from modal';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await Promise.resolve();
    expect(Notice).toHaveBeenCalledWith('The new task is invalid and was not created.');
  });
});
