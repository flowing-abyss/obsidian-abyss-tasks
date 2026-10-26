import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskKanbanSurface } from '../src/panels/task-collection/TaskKanbanSurface';
import { indexedRows, type TaskListRow } from '../src/panels/task-list/taskListRows';
import type { TaskStatusDef } from '../src/settings/types';
import { buildTaskKanbanModel } from '../src/task-lists/taskKanbanModel';
import { defaultTaskKanbanSettings } from '../src/task-lists/taskKanbanSettings';
import { expectDefined } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';

interface Value {
  readonly statusSymbol: string;
  readonly priority: 'D';
}
const statuses: TaskStatusDef[] = [
  { id: 'todo', symbol: ' ', name: 'To do', type: 'todo', icon: '', core: true },
  { id: 'doing', symbol: '/', name: 'Doing', type: 'in-progress', icon: '', core: false },
  { id: 'done', symbol: 'x', name: 'Done', type: 'done', icon: 'check', core: true },
];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});
function harness(count = 2000) {
  const host = document.body.createDiv({ cls: 'abyss-center-scroll' });
  prepareTaskPanelViewport(host);
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frame, callback);
    return frame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const settings = defaultTaskKanbanSettings();
  const source = indexedRows<Value>(
    Array.from({ length: count }, (_, i) => ({
      kind: 'task',
      key: `n:${i}`,
      taskKey: `n:${i}`,
      task: { statusSymbol: i % 2 === 0 ? ' ' : '/', priority: 'D' },
    })),
  );
  const model = buildTaskKanbanModel(source, statuses, settings, (v) => v);
  const mounted = new Set<string>(),
    destroyed: string[] = [];
  const surface = new TaskKanbanSurface<Value>(
    {
      host,
      scroll: host,
      mountedChanged: () => {},
      reportFailure: (error) => {
        throw error;
      },
      mount: (parent, row) => {
        mounted.add(row.key);
        const element = parent.createDiv({
          cls: row.kind === 'group' ? 'abyss-group-header' : 'abyss-task-card',
        });
        element.dataset['rowKey'] = row.key;
        return {
          element,
          update: (_next: TaskListRow<Value>) => {},
          destroy: () => {
            mounted.delete(row.key);
            destroyed.push(row.key);
            element.remove();
          },
        };
      },
    },
    { toggleColumn: () => {} },
  );
  cleanups.push(() => {
    surface.destroy();
    host.remove();
  });
  const update = () => {
    surface.setModel(model, settings);
    surface.update(model.rows, {
      revision: 'one',
      preserveAnchor: true,
      estimate: () => 64,
      measurementRevision: () => 'one',
    });
  };
  update();
  return {
    host,
    surface,
    settings,
    model,
    mounted,
    destroyed,
    update,
    flush: () => {
      for (const callback of [...frames.values()]) callback(0);
      frames.clear();
    },
  };
}
describe('virtual task Kanban', () => {
  it('returns complete board-relative column bounds even for unmounted tasks', () => {
    const h = harness(200);
    expect(h.mounted.size).toBeLessThan(100);
    expect(h.surface.selectionSpan(h.host, 'n:199')).toEqual({ from: 100, to: 199 });
    const todo = expectDefined(
      h.host.querySelector<HTMLElement>('[data-column-key="status:todo"]'),
    );
    expect(h.surface.selectionSpan(todo, 'n:199')).toEqual({ from: 0, to: 99 });
    const done = expectDefined(
      h.host.querySelector<HTMLElement>('[data-column-key="status:done"]'),
    );
    expect(h.surface.selectionSpan(done, 'n:199')).toEqual({ from: 0, to: -1 });
  });
  it('labels columns without Obsidian hover tooltips', () => {
    const h = harness(2);
    const column = expectDefined(h.host.querySelector<HTMLElement>('.abyss-task-kanban-column'));
    expect(column.hasAttribute('aria-label')).toBe(false);
    const id = expectDefined(column.getAttribute('aria-labelledby') ?? undefined);
    expect(document.getElementById(id)?.textContent).toBe('To do');
  });

  it('keeps an active column editor attached during publication', () => {
    const h = harness();
    const capture = expectDefined(h.host.querySelector<HTMLElement>('.abyss-task-kanban-capture'));
    const input = capture.createEl('input');
    input.focus();
    h.update();
    expect(document.activeElement).toBe(input);
  });

  it('mounts bounded columns and reveals exact far rows without hydrating the complete board', () => {
    const h = harness();
    expect(h.surface.rows.taskCount).toBe(2000);
    expect(h.mounted.size).toBeLessThan(100);
    const card = h.surface.reveal('n:1998');
    expect(card?.dataset['rowKey']).toBe('n:1998');
    expect(h.mounted.size).toBeLessThan(100);
  });
  it('keeps independent column scroll receipts in the outer surface coordinate system', () => {
    const h = harness();
    let expected = h.host.scrollTop;
    let accepted = true;
    const invalidated = vi.fn();
    const release = h.surface.observeNativeWrites(
      {
        beforeWrite: (top) => {
          accepted &&= top === expected;
          return accepted;
        },
        afterWrite: (top) => {
          expected = top;
        },
      },
      invalidated,
    );
    expect(h.surface.reveal('n:1998')?.dataset['rowKey']).toBe('n:1998');
    expect(h.surface.reveal('n:1999')?.dataset['rowKey']).toBe('n:1999');
    expect(accepted).toBe(true);
    expect(expected).toBe(h.host.scrollTop);
    const body = expectDefined(h.host.querySelector<HTMLElement>('.abyss-task-kanban-column-body'));
    body.dispatchEvent(new Event('scroll'));
    expect(invalidated).not.toHaveBeenCalled();
    body.scrollTop -= 100;
    body.dispatchEvent(new Event('scroll'));
    expect(invalidated).toHaveBeenCalledTimes(1);
    release();
  });

  it('distinguishes owned horizontal reveal from a later manual board scroll', () => {
    const h = harness();
    const column = expectDefined(
      h.host.querySelectorAll<HTMLElement>('.abyss-task-kanban-column')[1],
    );
    vi.spyOn(h.host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 900));
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(800, 0, 272, 900));
    const invalidated = vi.fn();
    const release = h.surface.observeNativeWrites(
      { beforeWrite: () => true, afterWrite: () => {} },
      invalidated,
    );
    h.surface.reveal('n:1999');
    expect(h.host.scrollLeft).toBeGreaterThan(0);
    h.host.dispatchEvent(new Event('scroll'));
    expect(invalidated).not.toHaveBeenCalled();
    h.host.scrollLeft += 50;
    h.host.dispatchEvent(new Event('scroll'));
    expect(invalidated).toHaveBeenCalledTimes(1);
    release();
  });

  it('keeps the source pinned while the column scrolls, then releases all mounts on disposal', () => {
    const h = harness();
    const release = h.surface.pin('n:0');
    h.surface.reveal('n:1998');
    expect(h.surface.element('n:0')).toBeDefined();
    release();
    h.flush();
    h.surface.destroy();
    expect(h.mounted.size).toBe(0);
    expect([...h.surface.cards()]).toEqual([]);
  });
  it('retains logical rows when collapsed and expands the destination for reveal', () => {
    const h = harness();
    h.settings.collapsedColumns = ['status:doing'];
    h.update();
    const column = expectDefined(
      h.host.querySelector<HTMLElement>('[data-column-key="status:doing"]'),
    );
    expect(column.classList.contains('is-collapsed')).toBe(true);
    expect(h.surface.rows.taskCount).toBe(2000);
    expect(h.surface.reveal('n:1999')?.dataset['rowKey']).toBe('n:1999');
    expect(column.classList.contains('is-collapsed')).toBe(false);
    expectDefined(
      column.querySelector<HTMLButtonElement>('.abyss-task-kanban-column-toggle'),
    ).click();
    expect(column.classList.contains('is-collapsed')).toBe(true);
  });
  it('restores each column scroll when rebuilding a board', () => {
    const first = harness();
    first.surface.reveal('n:1998');
    const position = first.surface.captureScroll();
    const second = harness();
    second.surface.restoreScroll(position);
    second.update();
    expect(second.surface.element('n:1998')).toBeDefined();
    expect(second.mounted.size).toBeLessThan(100);
  });
  it('releases offscreen-column DOM while preserving a pinned source', () => {
    const h = harness();
    h.host.getBoundingClientRect = () => new DOMRect(0, 0, 300, 900);
    const columns = [...h.host.querySelectorAll<HTMLElement>('.abyss-task-kanban-column')];
    columns.forEach((column, index) => {
      column.getBoundingClientRect = () =>
        new DOMRect(index * 300 - h.host.scrollLeft, 0, 272, 900);
    });
    const release = h.surface.pin('n:0');
    h.host.scrollLeft = 300;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(h.surface.element('n:0')).toBeDefined();
    release();
    h.flush();
    expect(h.surface.element('n:0')).toBeUndefined();
    expect(h.surface.rows.taskCount).toBe(2000);
    h.host.scrollLeft = 0;
    h.host.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(h.surface.element('n:0')).toBeDefined();
  });
});
it.each([false, true])(
  'recompacts a revealed emptied column unless creation is active (%s)',
  (creating) => {
    const h = harness(2);
    h.settings.emptyColumns = 'compact';
    h.surface.reveal('n:0');
    const column = expectDefined(
      h.host.querySelector<HTMLElement>('[data-column-key="status:todo"]'),
    );
    if (creating)
      expectDefined(column.querySelector<HTMLElement>('.abyss-task-kanban-capture')).createEl(
        'input',
      );
    const model = buildTaskKanbanModel(indexedRows<Value>([]), statuses, h.settings, (v) => v);
    h.surface.setModel(model, h.settings);
    h.surface.update(model.rows, {
      revision: 'empty',
      preserveAnchor: true,
      estimate: () => 64,
      measurementRevision: () => 'one',
    });
    expect(column.hasClass('is-collapsed')).toBe(!creating);
  },
);
