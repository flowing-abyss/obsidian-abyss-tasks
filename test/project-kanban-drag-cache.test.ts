import { afterEach, expect, it, vi } from 'vitest';
import { ProjectKanbanDragController } from '../src/panels/projects/projectKanbanDrag';
import type {
  ProjectKanbanDropPlan,
  ProjectKanbanDropSource,
  ProjectKanbanDropTarget,
} from '../src/panels/projects/projectKanbanDrop';
import type { Project } from '../src/projects/types';
import { expectDefined } from './helpers';

const controllers: ProjectKanbanDragController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => {
    controller.destroy();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const project: Project = {
  path: 'a',
  name: 'A',
  frontmatter: { status: 'Active' },
  tags: [],
  statusId: 'active',
  rawStatus: null,
  stats: {
    total: 0,
    done: 0,
    cancelled: 0,
    inProgress: 0,
    tracked: { closedMs: 0, openStartsMs: [] },
  },
};
function frameDrag(clamped = false) {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
    frames.delete(key);
  });
  const root = document.body.createDiv();
  const column = root.createDiv({
    cls: 'abyss-project-kanban-column',
    attr: { 'data-status-key': 'id:active' },
  });
  const scroll = column.createDiv({ cls: 'abyss-project-kanban-column-body' });
  const card = scroll.createDiv({
    cls: 'abyss-project-kanban-card',
    attr: { 'data-project-path': 'a' },
  });
  const source: ProjectKanbanDropSource = {
    projectPath: 'a',
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
  };
  let target: ProjectKanbanDropTarget = {
    status: { key: 'id:active', value: 'active' },
    group: { key: 'all', value: ['A'] },
    beforePath: 'b',
  };
  let top = 40;
  let allowed = true;
  let calls = 0;
  const plan = (): ProjectKanbanDropPlan =>
    allowed
      ? {
          allowed: true,
          message: 'Move A',
          changes: [],
          proposedProject: project,
          model: { columns: [], availableStatusGroups: [], uniqueVisibleCount: 0 },
          insertion: { kind: 'before', groupKey: 'all', beforePath: 'b' },
        }
      : { allowed: false, message: 'Unavailable' };
  const controller = new ProjectKanbanDragController(root, root, {
    begin: () => () => {},
    pin: () => () => {},
    capture: () => source,
    hitTest: () => ({ target: structuredClone(target), lineHost: scroll }),
    insertionLocation: () => ({ lineHost: scroll, lineTop: top }),
    preview: () => {
      calls++;
      return plan();
    },
    commit: async () => {},
    reportFailure: (error) => {
      throw error;
    },
  });
  controllers.push(controller);
  const box = {
    left: 0,
    top: 0,
    right: 1000,
    bottom: 1000,
    width: 1000,
    height: 1000,
    x: 0,
    y: 0,
    toJSON() {},
  };
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(box);
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(box);
  if (clamped) {
    Object.defineProperty(root, 'scrollLeft', { get: () => 0, set() {} });
    Object.defineProperty(scroll, 'scrollTop', { get: () => 0, set() {} });
  }
  const data = new Map<string, string>();
  const transfer = {
    get types() {
      return [...data.keys()];
    },
    setData: (key: string, value: string) => {
      data.set(key, value);
    },
    getData: (key: string) => data.get(key) ?? '',
    dropEffect: 'none',
    effectAllowed: '',
    setDragImage() {},
  };
  const drag = (type: string) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: clamped ? 990 : 500,
      clientY: clamped ? 990 : 500,
    });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    card.dispatchEvent(event);
  };
  card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  drag('dragstart');
  drag('dragover');
  const frame = () => {
    const work = [...frames.values()];
    frames.clear();
    work.forEach((callback) => {
      callback(0);
    });
  };
  return {
    controller,
    root,
    scroll,
    drag,
    frame,
    calls: () => calls,
    markerTop: () =>
      scroll
        .querySelector<HTMLElement>('.abyss-project-kanban-insertion-line')
        ?.style.getPropertyValue('--abyss-project-kanban-insertion-top'),
    setTop: (value: number) => {
      top = value;
    },
    setTarget: (value: ProjectKanbanDropTarget) => {
      target = value;
    },
    reject: () => {
      allowed = false;
    },
  };
}
it.each([false, true])('does not replan 60 unchanged stationary frames (clamped=%s)', (clamped) => {
  const h = frameDrag(clamped);
  expect(h.calls()).toBe(1);
  for (let frame = 0; frame < 60; frame++) h.frame();
  expect(h.calls()).toBe(1);
  expect(h.markerTop()).toBe('40px');
});
it('refreshes live marker geometry while preserving the unchanged semantic plan', () => {
  const h = frameDrag();
  h.setTop(95);
  h.frame();
  expect(h.markerTop()).toBe('95px');
  expect(h.calls()).toBe(1);
  h.drag('dragover');
  expect(h.calls()).toBe(2);
});

it('invalidates accepted and rejected semantics without losing the active pointer', () => {
  const h = frameDrag();
  h.reject();
  h.controller.invalidatePreviewPlan();
  h.frame();
  expect(h.calls()).toBe(2);
  expect(h.markerTop()).toBeUndefined();
  for (let frame = 0; frame < 60; frame++) h.frame();
  expect(h.calls()).toBe(2);
});
it.each([
  { status: { key: 'id:other', value: 'active' } },
  { status: { key: 'id:active', value: 'other' } },
  { group: { key: 'other', value: ['A'] } },
  { group: { key: 'all', value: ['B'] } },
  { group: { key: 'all', value: ['A'], sourcePath: 'other.md' } },
  { group: { key: 'all', value: ['A'], projected: true } },
  { beforePath: 'c' },
])('replans a changed semantic target %j once', (change) => {
  const h = frameDrag();
  h.setTarget({
    status: { key: 'id:active', value: 'active' },
    group: { key: 'all', value: ['A'] },
    beforePath: 'b',
    ...change,
  });
  h.frame();
  h.frame();
  expect(h.calls()).toBe(2);
});
it('discards cached acceptance on leaving the board before a later dragover', () => {
  const h = frameDrag();
  document.body.dispatchEvent(new MouseEvent('dragover', { bubbles: true }));
  expect(h.markerTop()).toBeUndefined();
  h.drag('dragover');
  expect(h.calls()).toBe(2);
});

it.each([1000, 10000])('bounds tail hover title lookup work for %s projects', (count) => {
  vi.useFakeTimers();
  const h = frameDrag();
  h.controller.destroy();
  const root = document.body.createDiv();
  const sourceColumn = root.createDiv({
    cls: 'abyss-project-kanban-column',
    attr: { 'data-status-key': 'id:planned' },
  });
  const card = sourceColumn.createDiv({
    cls: 'abyss-project-kanban-card',
    attr: { 'data-project-path': 'a' },
  });
  const target = root.createDiv({
    cls: 'abyss-project-kanban-column is-collapsed',
    attr: { 'data-status-key': 'id:active' },
  });
  let reads = 0;
  const projects = Array.from({ length: count }, (_, index): Project => ({
    ...project,
    name: `Project ${index}`,
    get path() {
      reads++;
      return String(index);
    },
  }));
  const group = { key: 'all', label: '', value: null, projects };
  const status = { key: 'id:active', label: 'Active', statusId: 'active' };
  const plan: ProjectKanbanDropPlan = {
    allowed: true,
    message: 'Move',
    changes: [],
    proposedProject: project,
    model: {
      columns: [{ status, groups: [group], uniqueVisibleCount: count }],
      availableStatusGroups: [status],
      uniqueVisibleCount: count,
    },
    insertion: { kind: 'after', groupKey: 'all', afterPath: String(count - 1) },
  };
  const controller = new ProjectKanbanDragController(root, root, {
    hitTest: () => undefined,
    insertionLocation: () => undefined,
    pin: () => () => {},
    begin: () => () => {},
    capture: () => ({
      projectPath: 'a',
      statusKey: 'id:planned',
      group: { key: 'all', value: null },
      statusGuard: {
        fieldId: 'status',
        fieldType: 'status',
        sourceProperty: 'status',
        expectedValue: 'Planned',
        expectedExists: true,
      },
      settingsGuard: { groupBy: 'none', sortField: 'name', sortDirection: 'asc' },
    }),
    preview: () => plan,
    commit: async () => {},
    reportFailure: (error) => {
      throw error;
    },
  });
  controllers.push(controller);
  const values = new Map<string, string>();
  const data = {
    get types() {
      return [...values.keys()];
    },
    getData: (key: string) => values.get(key) ?? '',
    setData: (key: string, value: string) => {
      values.set(key, value);
    },
    setDragImage() {},
    effectAllowed: '',
    dropEffect: '',
  };
  card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  const start = new Event('dragstart', { bubbles: true });
  Object.defineProperty(start, 'dataTransfer', { value: data });
  card.dispatchEvent(start);
  target.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true }));
  vi.advanceTimersByTime(450);
  const body = expectDefined(root.querySelector<HTMLElement>('.abyss-project-kanban-hover-body'));
  Object.defineProperty(body, 'clientHeight', { value: 420 });
  reads = 0;
  body.scrollTop = 8 + (count - 10) * 42;
  body.dispatchEvent(new Event('scroll'));
  h.frame();
  expect(body.textContent).toContain(`Project ${count - 1}`);
  expect(body.querySelectorAll('.abyss-project-kanban-hover-card').length).toBeLessThan(30);
  expect(reads).toBe(0);
});
