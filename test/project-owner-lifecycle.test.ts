import { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountProjectCellEditor } from '../src/panels/projects/ProjectCellEditor';
import { ProjectCreationPresentation } from '../src/panels/projects/ProjectCreationPresentation';
import { ProjectKanbanDragController } from '../src/panels/projects/projectKanbanDrag';
import { renderProjectTableColumns } from '../src/panels/projects/projectTableColumns';
import { expectDefined } from './helpers';

function surface(detached = false) {
  const frame = document.body.createEl('iframe');
  const owner = expectDefined(frame.contentWindow);
  const doc = detached
    ? document.implementation.createHTMLDocument()
    : expectDefined(frame.contentDocument);
  // Adopt main-realm nodes: the mocks install Obsidian helpers on that prototype.
  const host = document.body.createDiv();
  doc.body.append(host);
  const pending = new Map<number, () => void>();
  let next = 1;
  vi.spyOn(owner, 'setTimeout').mockImplementation((callback) => {
    if (typeof callback !== 'function') throw new Error('Expected callback');
    const id = next++;
    pending.set(id, () => {
      (callback as () => void)();
    });
    return id;
  });
  vi.spyOn(owner, 'clearTimeout').mockImplementation((id) => {
    if (id !== undefined) pending.delete(id);
  });
  return {
    owner,
    doc,
    host,
    pending,
    flush: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => {
        callback();
      });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.empty();
});

function columns(host: HTMLElement, onResize: () => void = vi.fn()) {
  const table = host.createEl('table');
  const sort = vi.fn();
  const preview = vi.fn();
  const destroy = renderProjectTableColumns(table, {
    columns: [
      {
        column: { id: 'start', visible: true },
        field: { id: 'start', label: 'Start', type: 'date' },
      },
    ],
    sort: { field: 'start', dir: 'asc' },
    onSort: sort,
    onSortExact: vi.fn(),
    onRename: vi.fn(),
    beforeAction: (action) => {
      action();
    },
    onAlignment: vi.fn(),
    dateDisplay: () => 'raw',
    onDateDisplay: vi.fn(),
    typeChoices: () => [],
    onType: vi.fn(),
    restoreTableFocus: () => true,
    onMove: vi.fn(),
    onResize,
    onResizePreview: preview,
  });
  return { table, sort, preview, destroy };
}

describe('project owner scheduler lifetimes', () => {
  it.each(['resize', 'drag'] as const)(
    'releases %s sort suppression on the owner and cancels on disposal',
    (gesture) => {
      const h = surface();
      const c = columns(h.host);
      const header = expectDefined(c.table.querySelector('th'));
      const button = expectDefined(header.querySelector('button'));
      const start = () => {
        if (gesture === 'resize') {
          expectDefined(header.querySelector('.abyss-project-column-resize')).dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true }),
          );
          h.doc.dispatchEvent(new Event('pointerup'));
        } else {
          header.dispatchEvent(new Event('dragstart'));
          header.dispatchEvent(new Event('dragend'));
        }
      };
      start();
      expect(h.pending.size).toBe(1);
      h.flush();
      button.click();
      expect(c.sort).toHaveBeenCalledWith('start');
      start();
      expect(h.pending.size).toBe(1);
      c.destroy();
      expect(h.pending.size).toBe(0);
      if (gesture === 'resize') expect(c.preview).toHaveBeenLastCalledWith(false);
    },
  );

  it('does not reschedule a sort guard when the resize callback disposes the headers', () => {
    const h = surface();
    let destroy = (): void => {};
    const c = columns(h.host, () => {
      destroy();
    });
    destroy = c.destroy;
    expectDefined(c.table.querySelector('.abyss-project-column-resize')).dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }),
    );
    h.doc.dispatchEvent(new MouseEvent('pointermove', { clientX: 40 }));
    h.doc.dispatchEvent(new Event('pointerup'));
    expect(h.pending.size).toBe(0);
  });

  it('releases detached column gestures without scheduling on the main window', () => {
    const h = surface(true);
    const c = columns(h.host);
    const header = expectDefined(c.table.querySelector('th'));
    header.dispatchEvent(new Event('dragstart'));
    header.dispatchEvent(new Event('dragend'));
    expectDefined(header.querySelector('button')).click();
    expect(c.sort).toHaveBeenCalledWith('start');
    c.destroy();
  });

  it.each([false, true])(
    'releases editor pointer ownership and destroys pending callbacks (detached=%s)',
    async (detached) => {
      const h = surface(detached);
      const save = vi.fn().mockResolvedValue(undefined);
      const editor = mountProjectCellEditor({
        app: new App(),
        container: h.host,
        field: { id: 'description', property: 'description', label: 'Description', type: 'text' },
        value: 'before',
        catalog: {
          list: () => [],
          inspect: () => ({ kind: 'unavailable' }),
          values: () => [],
          onChange: () => () => {},
        },
        save,
        onClose: vi.fn(),
      });
      const input = expectDefined(h.host.querySelector('textarea'));
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      h.doc.dispatchEvent(new Event('pointerup'));
      if (!detached) {
        expect(h.pending.size).toBe(1);
        h.flush();
      }
      input.value = 'after';
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(save).toHaveBeenCalledWith('after');
      editor.destroy();
      expect(h.pending.size).toBe(0);
    },
  );

  it('cancels editor pointer release when destroyed before the owner callback', () => {
    const h = surface();
    const editor = mountProjectCellEditor({
      app: new App(),
      container: h.host,
      field: { id: 'description', label: 'Description', type: 'text' },
      value: '',
      catalog: {
        list: () => [],
        inspect: () => ({ kind: 'unavailable' }),
        values: () => [],
        onChange: () => () => {},
      },
      save: vi.fn().mockResolvedValue(undefined),
      onClose: vi.fn(),
    });
    expectDefined(h.host.querySelector('textarea')).dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    h.doc.dispatchEvent(new Event('pointerup'));
    expect(h.pending.size).toBe(1);
    editor.destroy();
    expect(h.pending.size).toBe(0);
  });

  it('cancels creation expiry on its original owner after host adoption', () => {
    const h = surface();
    const controller = new ProjectCreationPresentation({
      host: h.host,
      projects: () => [],
      present: () => null,
      inaccessible: vi.fn(),
      reducedMotion: () => false,
      now: () => 0,
    });
    controller.enqueue({ path: 'New.md' });
    expect(h.pending.size).toBe(1);
    document.body.append(h.host);
    controller.destroy();
    expect(h.pending.size).toBe(0);
  });

  it('does not retain creation requests without an owning window', () => {
    const h = surface(true);
    const projects = vi.fn(() => []);
    const controller = new ProjectCreationPresentation({
      host: h.host,
      projects,
      present: () => null,
      inaccessible: vi.fn(),
      reducedMotion: () => false,
      now: () => 0,
    });
    controller.enqueue({ path: 'New.md' });
    projects.mockClear();
    controller.update();
    expect(projects).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('releases owner Kanban animation, hover, image and interaction state on destroy', () => {
    const h = surface();
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(h.owner, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(1, callback);
      return 1;
    });
    vi.spyOn(h.owner, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const column = h.host.createDiv({ cls: 'abyss-project-kanban-column is-collapsed' });
    column.dataset['statusKey'] = 'id:active';
    const card = column.createDiv({ cls: 'abyss-project-kanban-card' });
    card.dataset['projectPath'] = 'Project.md';
    const release = vi.fn();
    const controller = new ProjectKanbanDragController(h.host, h.host, {
      begin: () => release,
      capture: () => ({
        projectPath: 'Project.md',
        statusKey: 'id:active',
        group: { key: 'all', value: null },
        statusGuard: {
          fieldId: 'status',
          fieldType: 'status',
          sourceProperty: 'status',
          expectedValue: 'Active',
          expectedExists: true,
        },
        settingsGuard: { groupBy: 'none', sortField: 'none', sortDirection: 'asc' },
      }),
      preview: () => ({ allowed: false, message: 'blocked' }),
      commit: async () => {},
      reportFailure: vi.fn(),
    });
    card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    const start = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', {
      value: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' },
    });
    card.dispatchEvent(start);
    column.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true }));
    expect(h.pending.size).toBe(1);
    expect(frames.size).toBe(1);
    expect(h.doc.querySelector('.abyss-project-kanban-drag-image')).not.toBeNull();
    expect(card.classList.contains('is-dragging')).toBe(true);
    controller.destroy();
    expect(h.pending.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(h.doc.querySelector('.abyss-project-kanban-drag-image')).toBeNull();
    expect(card.classList.contains('is-dragging')).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    h.owner.dispatchEvent(new Event('blur'));
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not borrow the main window for detached Kanban drag', () => {
    const h = surface(true);
    const add = vi.spyOn(window, 'addEventListener');
    const controller = new ProjectKanbanDragController(h.host, h.host, {
      begin: () => () => {},
      capture: () => {
        throw new Error('unused');
      },
      preview: () => {
        throw new Error('unused');
      },
      commit: async () => {},
      reportFailure: vi.fn(),
    });
    expect(add.mock.calls.filter(([name]) => name === 'blur')).toEqual([]);
    controller.destroy();
  });
});
