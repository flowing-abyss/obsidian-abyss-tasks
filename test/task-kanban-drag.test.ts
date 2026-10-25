import { afterEach, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { TaskKanbanDrag } from '../src/panels/task-collection/TaskKanbanDrag';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { rootTaskNodeSnapshot } from '../src/tasks';
import { deferred, expectDefined, flushMicrotasks, task } from './helpers';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
  vi.restoreAllMocks();
});
function harness() {
  const state = new AppState();
  let statuses = structuredClone(DEFAULT_SETTINGS.taskStatuses);
  const host = document.body.createDiv();
  const doing = expectDefined(statuses.find((s) => s.symbol === '/'));
  const column = host.createDiv({ cls: 'abyss-task-kanban-column is-collapsed' });
  column.dataset['columnKey'] = `status:${doing.id}`;
  column.createDiv({ cls: 'abyss-task-kanban-column-body' });
  const drop = vi.fn(async () => {});
  const drag = new TaskKanbanDrag({ host, state, statuses: () => statuses, drop });
  const start = () => {
    state.set('draggingTaskNode', {
      source: 'center-card',
      task: rootTaskNodeSnapshot(task({ title: 'Source', statusSymbol: ' ' })),
    });
  };
  cleanup.push(() => {
    drag.destroy();
    host.remove();
  });
  return {
    state,
    host,
    column,
    doing,
    drop,
    start,
    replace: () => {
      statuses = statuses.map((s) => (s.id === doing.id ? { ...s, type: 'done' } : s));
    },
  };
}
function event(type: string) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
}
it('accepts one whole-column drop and clears its preview while awaiting the command', async () => {
  const h = harness();
  const pending = deferred<void>();
  h.drop.mockImplementation(() => pending.promise);
  h.start();
  h.column.dispatchEvent(event('dragover'));
  expect(h.column.hasClass('is-drop-target')).toBe(true);
  h.column.dispatchEvent(event('drop'));
  h.column.dispatchEvent(event('drop'));
  expect(h.drop).toHaveBeenCalledTimes(1);
  expect(h.column.hasClass('is-drop-target')).toBe(false);
  pending.resolve();
  await flushMicrotasks();
  expect(h.state.get('draggingTaskNode')).toBeNull();
});
it('cancels a changed column definition and Escape without submitting', () => {
  const h = harness();
  h.start();
  h.replace();
  h.column.dispatchEvent(event('drop'));
  expect(h.drop).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(h.state.get('draggingTaskNode')).toBeNull();
});
it('leaves tag and project drags to their existing handlers', () => {
  const h = harness();
  h.state.set('draggingTag', '#work');
  const over = event('dragover');
  h.column.dispatchEvent(over);
  expect(over.defaultPrevented).toBe(false);
  expect(h.drop).not.toHaveBeenCalled();
});
