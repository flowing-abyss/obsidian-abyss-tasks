import { setIcon } from 'obsidian';
import type { TaskStatusDef } from '../../settings/types';
import type { TaskKanbanColumn, TaskKanbanModel } from '../../task-lists/taskKanbanModel';
import {
  defaultTaskKanbanSettings,
  type TaskKanbanSettings,
} from '../../task-lists/taskKanbanSettings';
import { indexedRows, type TaskListRows } from '../task-list/taskListRows';
import {
  TaskListSurface,
  type TaskListNativeWriteObserver,
  type TaskListPresentation,
  type TaskListScrollPosition,
  type TaskListSurfaceOptions,
} from '../task-list/TaskListSurface';
import type { TaskCollectionSurface } from './TaskCollectionSurface';

interface Column<T> {
  model: TaskKanbanColumn<T>;
  readonly element: HTMLElement;
  readonly marker: HTMLElement;
  readonly label: HTMLElement;
  readonly count: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly create: HTMLButtonElement;
  readonly body: HTMLElement;
  readonly capture: HTMLElement;
  readonly viewport: TaskListSurface<T>;
  pins: number;
  active: boolean;
}
interface KanbanActions {
  toggleColumn(key: string): void;
  createTask?(status: TaskStatusDef, host: HTMLElement, trigger: HTMLElement): void;
}
interface NativeObserver {
  readonly observer: TaskListNativeWriteObserver;
  readonly invalidated: () => void;
  readonly releases: Map<string, () => void>;
}
export interface TaskKanbanScrollPosition {
  readonly left: number;
  readonly columns: ReadonlyMap<string, TaskListScrollPosition>;
}
/** Each visible status column delegates geometry and mounts to the existing task list viewport. */
export class TaskKanbanSurface<T> implements TaskCollectionSurface<T> {
  readonly #columns = new Map<string, Column<T>>();
  readonly #owners = new Map<string, Column<T>>();
  readonly #expanded = new Set<string>();
  readonly #nativeObservers = new Set<NativeObserver>();
  #model: TaskKanbanModel<T> = { rows: indexedRows([]), columns: [] };
  #settings = defaultTaskKanbanSettings();
  #owner: Window | null = null;
  #resize: ResizeObserver | undefined;
  #frame: number | undefined;
  #suspended = false;
  #destroyed = false;
  #pendingScroll: TaskKanbanScrollPosition | undefined;
  constructor(
    readonly options: TaskListSurfaceOptions<T>,
    readonly actions: KanbanActions,
  ) {
    options.host.addClass('abyss-task-kanban', 'abyss-task-kanban-scroll');
    this.#bind();
  }
  get rows(): TaskListRows<T> {
    return this.#model.rows;
  }
  captureScroll(): TaskKanbanScrollPosition {
    return {
      left: this.options.host.scrollLeft,
      columns: new Map(
        [...this.#columns].map(([key, column]) => [key, column.viewport.captureScroll()]),
      ),
    };
  }
  restoreScroll(position: TaskKanbanScrollPosition): void {
    this.#pendingScroll = position;
  }
  setModel(model: TaskKanbanModel<T>, settings: TaskKanbanSettings): void {
    this.#model = model;
    this.#settings = settings;
  }
  update(
    _rows: TaskListRows<T>,
    presentation: TaskListPresentation<T>,
    failure: 'report' | 'throw' = 'report',
  ): void {
    if (this.#destroyed) return;
    this.#bind();
    this.#removeMissingColumns();
    this.#owners.clear();
    this.options.host.dataset['descriptionLines'] = String(this.#settings.descriptionLines);
    this.options.host.toggleClass('abyss-task-kanban--hide-metadata', !this.#settings.showMetadata);
    let previous: HTMLElement | undefined;
    for (const model of this.#model.columns) {
      const column = this.#columns.get(model.key) ?? this.#createColumn(model);
      column.model = model;
      this.#columns.set(model.key, column);
      this.#updateHeader(column);
      const before =
        previous === undefined ? this.options.host.firstElementChild : previous.nextElementSibling;
      if (column.element !== before) this.options.host.insertBefore(column.element, before);
      previous = column.element;
      this.#updateColumn(column, presentation, failure);
    }
    if (this.#pendingScroll !== undefined) {
      this.options.host.scrollLeft = this.#pendingScroll.left;
      this.#pendingScroll = undefined;
      this.#visibility();
    }
    this.options.mountedChanged();
  }
  #updateColumn(
    column: Column<T>,
    presentation: TaskListPresentation<T>,
    failure: 'report' | 'throw',
  ): void {
    const model = column.model;
    const scroll = this.#pendingScroll?.columns.get(model.key);
    if (scroll !== undefined) column.viewport.restoreScroll(scroll);
    for (const row of model.rows.slice(0, model.rows.rowCount)) this.#owners.set(row.key, column);
    const visible = this.#visible(column);
    if (!visible) column.viewport.suspend(true);
    column.viewport.update(model.rows, presentation, failure);
    this.#activate(column, visible);
  }
  #removeMissingColumns(): void {
    const keys = new Set(this.#model.columns.map((column) => column.key));
    for (const [key, column] of this.#columns) {
      if (keys.has(key)) continue;
      this.#removeColumn(column);
      this.#columns.delete(key);
      this.#expanded.delete(key);
    }
  }
  #createColumn(model: TaskKanbanColumn<T>): Column<T> {
    const element = this.options.host.createDiv({ cls: 'abyss-task-kanban-column' });
    element.dataset['columnKey'] = model.key;
    const header = element.createDiv({ cls: 'abyss-task-kanban-column-header' });
    const marker = header.createSpan({
      cls: 'abyss-status-marker',
      attr: { 'aria-hidden': 'true' },
    });
    const label = header.createSpan({ cls: 'abyss-task-kanban-column-label' });
    const count = header.createSpan({ cls: 'abyss-task-kanban-column-count' });
    const create = header.createEl('button', {
      cls: 'clickable-icon abyss-task-kanban-column-create',
      attr: { type: 'button' },
    });
    setIcon(create, 'plus');
    const toggle = header.createEl('button', {
      cls: 'clickable-icon abyss-task-kanban-column-toggle',
      attr: { type: 'button' },
    });
    const body = element.createDiv({ cls: 'abyss-task-kanban-column-body' });
    const capture = body.createDiv({ cls: 'abyss-task-kanban-capture' });
    const content = body.createDiv({ cls: 'abyss-task-kanban-window' });
    const viewport = new TaskListSurface({ ...this.options, host: content, scroll: body });
    viewport.suspend();
    const column: Column<T> = {
      model,
      element,
      marker,
      label,
      count,
      create,
      toggle,
      body,
      capture,
      viewport,
      pins: 0,
      active: false,
    };
    toggle.addEventListener('click', () => {
      this.#toggle(column);
    });
    create.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    create.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    create.addEventListener('click', (event) => {
      event.stopPropagation();
      if (column.model.status === undefined) return;
      this.#expanded.add(column.model.key);
      this.#updateHeader(column);
      this.#visibility();
      this.actions.createTask?.(column.model.status, column.capture, column.create);
    });
    for (const token of this.#nativeObservers) this.#observeColumn(token, column);
    return column;
  }
  #collapsed(column: Column<T>): boolean {
    return (
      !this.#expanded.has(column.model.key) &&
      (this.#settings.collapsedColumns.includes(column.model.key) ||
        (column.model.rows.taskCount === 0 && this.#settings.emptyColumns === 'compact'))
    );
  }
  #updateHeader(column: Column<T>): void {
    const { model } = column;
    column.label.setText(model.label);
    column.count.setText(String(model.rows.taskCount));
    column.marker.dataset['statusType'] = model.status?.type ?? 'todo';
    column.marker.dataset['status'] = model.status?.type === 'done' ? 'done' : 'other';
    column.marker.empty();
    if (model.status !== undefined && model.status.icon.length > 0)
      setIcon(column.marker, model.status.icon);
    const collapsed = this.#collapsed(column);
    column.element.toggleClass('is-collapsed', collapsed);
    column.element.setAttribute('aria-label', model.label);
    column.toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${model.label}`);
    column.toggle.setAttribute('aria-expanded', String(!collapsed));
    setIcon(column.toggle, collapsed ? 'chevron-right' : 'chevron-left');
    column.create.hidden = model.status === undefined || this.actions.createTask === undefined;
    column.create.setAttribute('aria-label', `Add task in ${model.label}`);
  }
  #toggle(column: Column<T>): void {
    const key = column.model.key;
    if (this.#expanded.delete(key) && this.#collapsed(column)) {
      this.#updateHeader(column);
      this.#visibility();
      return;
    }
    if (this.#collapsed(column) && !this.#settings.collapsedColumns.includes(key)) {
      this.#expanded.add(key);
      this.#updateHeader(column);
      this.#visibility();
      return;
    }
    this.#expanded.delete(key);
    this.actions.toggleColumn(key);
  }
  #visible(column: Column<T>): boolean {
    if (this.#suspended || this.#collapsed(column)) return false;
    if (column.pins > 0 || column.element.contains(this.options.host.ownerDocument.activeElement))
      return true;
    const host = this.options.host.getBoundingClientRect();
    const rect = column.element.getBoundingClientRect();
    return (
      rect.width === 0 || host.width === 0 || (rect.right > host.left && rect.left < host.right)
    );
  }
  #activate(column: Column<T>, active: boolean): void {
    if (column.active === active) return;
    column.active = active;
    if (active) column.viewport.resume();
    else column.viewport.suspend(true);
  }
  #visibility(): void {
    if (this.#destroyed) return;
    for (const column of this.#columns.values()) this.#activate(column, this.#visible(column));
    this.options.mountedChanged();
  }
  readonly #schedule = (): void => {
    if (this.#destroyed || this.#suspended) return;
    this.#bind();
    const owner = this.#owner;
    if (owner === null || this.#frame !== undefined) return;
    this.#frame = owner.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.#owner !== owner || this.options.host.ownerDocument !== owner.document) return;
      this.#visibility();
    });
  };
  #bind(): void {
    const owner = this.options.host.ownerDocument.defaultView;
    if (owner === this.#owner) return;
    this.#unbind();
    this.#owner = owner;
    if (owner === null) return;
    this.options.host.addEventListener('scroll', this.#schedule, { passive: true });
    owner.addEventListener('resize', this.#schedule);
    this.#resize = new owner.ResizeObserver(this.#schedule);
    this.#resize.observe(this.options.host);
  }
  #unbind(): void {
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#resize?.disconnect();
    this.#resize = undefined;
    this.options.host.removeEventListener('scroll', this.#schedule);
    this.#owner?.removeEventListener('resize', this.#schedule);
    this.#owner = null;
  }
  element(key: string): HTMLElement | undefined {
    return this.#owners.get(key)?.viewport.element(key);
  }
  *cards(): Iterable<readonly [string, HTMLElement]> {
    for (const model of this.#model.columns) {
      const viewport = this.#columns.get(model.key)?.viewport;
      if (viewport !== undefined) yield* viewport.cards();
    }
  }
  mountedKeys(): readonly string[] {
    return [...this.cards()].map(([key]) => key);
  }
  refreshMeasurements(): void {
    this.#bind();
    for (const column of this.#columns.values())
      if (column.active) column.viewport.refreshMeasurements();
    this.#schedule();
  }
  reveal(key: string): HTMLElement | undefined;
  reveal(
    key: string,
    options: { readonly waitForReady: true },
  ): HTMLElement | 'pending' | undefined;
  reveal(
    key: string,
    options?: { readonly waitForReady: true },
  ): HTMLElement | 'pending' | undefined {
    const column = this.#owners.get(key);
    if (column === undefined || this.#destroyed) return undefined;
    this.#expanded.add(column.model.key);
    this.#updateHeader(column);
    const viewport = this.options.host.getBoundingClientRect();
    const target = column.element.getBoundingClientRect();
    if (target.left < viewport.left) this.options.host.scrollLeft += target.left - viewport.left;
    else if (target.right > viewport.right)
      this.options.host.scrollLeft += target.right - viewport.right;
    this.#activate(column, true);
    return options === undefined
      ? column.viewport.reveal(key)
      : column.viewport.reveal(key, options);
  }
  pin(key: string, invalidated?: () => void, observer?: TaskListNativeWriteObserver): () => void {
    const column = this.#owners.get(key);
    if (column === undefined) return () => {};
    column.pins++;
    const release = column.viewport.pin(key, invalidated, observer);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      column.pins--;
      release();
      this.#schedule();
    };
  }
  #observeColumn(token: NativeObserver, column: Column<T>): void {
    token.releases.set(
      column.model.key,
      column.viewport.observeNativeWrites(token.observer, token.invalidated),
    );
  }
  observeNativeWrites(observer: TaskListNativeWriteObserver, invalidated: () => void): () => void {
    const token: NativeObserver = { observer, invalidated, releases: new Map() };
    this.#nativeObservers.add(token);
    for (const column of this.#columns.values()) this.#observeColumn(token, column);
    return () => {
      this.#nativeObservers.delete(token);
      for (const release of token.releases.values()) release();
      token.releases.clear();
    };
  }
  suspend(): void {
    this.#suspended = true;
    this.#unbind();
    this.#visibility();
  }
  resume(): void {
    this.#suspended = false;
    this.#bind();
    this.#visibility();
  }
  #removeColumn(column: Column<T>): void {
    for (const token of this.#nativeObservers) {
      token.releases.get(column.model.key)?.();
      token.releases.delete(column.model.key);
    }
    column.viewport.destroy();
    column.element.remove();
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unbind();
    for (const column of this.#columns.values()) this.#removeColumn(column);
    for (const token of this.#nativeObservers) token.invalidated();
    this.#nativeObservers.clear();
    this.#columns.clear();
    this.#owners.clear();
    this.options.host.removeClass(
      'abyss-task-kanban',
      'abyss-task-kanban-scroll',
      'abyss-task-kanban--hide-metadata',
    );
    delete this.options.host.dataset['descriptionLines'];
  }
}
