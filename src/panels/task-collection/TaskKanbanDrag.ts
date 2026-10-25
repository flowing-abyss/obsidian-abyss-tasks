import { Notice } from 'obsidian';
import type { AppState, TaskNodeDragPayload } from '../../app/AppState';
import type { TaskStatusDef } from '../../settings/types';
import type { TaskNodeSnapshot } from '../../tasks';
import { isRealmHTMLElement } from '../../ui/domRealm';
import { runAsyncAction } from '../../ui/runAsyncAction';

type CapturedDrop = (status: TaskStatusDef, accept: () => boolean) => Promise<void>;
interface Options {
  readonly host: HTMLElement;
  readonly state: AppState;
  statuses(): readonly TaskStatusDef[];
  capture?(task: TaskNodeSnapshot): CapturedDrop | undefined;
  drop(task: TaskNodeSnapshot, status: TaskStatusDef, accept: () => boolean): Promise<void>;
}
/** Whole-column status destination. AppState remains the only native task payload authority. */
export class TaskKanbanDrag {
  #payload: TaskNodeDragPayload | null = null;
  #statuses: readonly TaskStatusDef[] = [];
  #owner: Window | null = null;
  #column: HTMLElement | undefined;
  #point: { x: number; y: number } | undefined;
  #frame: number | undefined;
  #accepted = false;
  #captured: CapturedDrop | undefined;
  #commit: object | undefined;
  readonly #off: () => void;
  constructor(readonly options: Options) {
    this.#off = options.state.on('draggingTaskNode', (payload) => {
      this.#clearPreview();
      if (payload !== null) this.#commit = undefined;
      this.#payload = payload;
      this.#captured = payload === null ? undefined : options.capture?.(payload.task);
      this.#statuses = options.statuses().map((status) => ({ ...status }));
      this.#accepted = false;
    });
    options.host.addEventListener('dragover', this.#over, true);
    options.host.addEventListener('dragleave', this.#leave, true);
    options.host.addEventListener('drop', this.#drop, true);
    options.host.addEventListener('contextmenu', this.#contextMenu, true);
    this.refresh();
  }
  refresh(): void {
    const owner = this.options.host.ownerDocument.defaultView;
    if (owner === this.#owner) return;
    this.#cancel();
    this.#listen(false);
    this.#owner = owner;
    this.#listen(true);
  }
  #listen(add: boolean): void {
    const owner = this.#owner;
    if (owner === null) return;
    if (add) {
      owner.addEventListener('blur', this.#cancel);
      owner.document.addEventListener('keydown', this.#key, true);
    } else {
      owner.removeEventListener('blur', this.#cancel);
      owner.document.removeEventListener('keydown', this.#key, true);
    }
  }
  #target(event: DragEvent): { column: HTMLElement; status: TaskStatusDef } | undefined {
    if (
      this.#accepted ||
      this.#payload === null ||
      this.options.host.ownerDocument.defaultView !== this.#owner
    )
      return undefined;
    const target = event.composedPath().find(isRealmHTMLElement);
    const column = target?.closest<HTMLElement>('.abyss-task-kanban-column');
    if (column == null || !this.options.host.contains(column)) return undefined;
    const status = this.#columnStatus(column);
    return status === undefined ? undefined : { column, status };
  }
  #columnStatus(column: HTMLElement): TaskStatusDef | undefined {
    const status = this.#statuses.find(
      (value) => `status:${value.id}` === column.dataset['columnKey'],
    );
    const current = this.options.statuses().find((value) => value.id === status?.id);
    if (status === undefined || current?.symbol !== status.symbol || current.type !== status.type)
      return undefined;
    return status;
  }
  readonly #over = (event: DragEvent): void => {
    if (this.#payload === null) return;
    event.stopPropagation();
    const target = this.#target(event);
    if (target === undefined) {
      this.#clearPreview();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'move';
    if (this.#column !== target.column) {
      this.#column?.removeClass('is-drop-target');
      this.#column = target.column;
      this.#column.addClass('is-drop-target');
    }
    this.#point = { x: event.clientX, y: event.clientY };
    this.#schedule();
  };
  readonly #contextMenu = (event: MouseEvent): void => {
    if (this.#payload === null) return;
    // Android follows native dragstart with contextmenu on the long-pressed card.
    event.preventDefault();
    event.stopPropagation();
  };
  readonly #leave = (event: DragEvent): void => {
    const next = event.relatedTarget;
    if (next !== null && 'nodeType' in next && this.options.host.contains(next as Node)) return;
    this.#clearPreview();
  };
  readonly #drop = (event: DragEvent): void => {
    const payload = this.#payload;
    if (payload === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = this.#target(event);
    this.#clearPreview();
    if (target === undefined) return;
    this.#accepted = true;
    runAsyncAction(
      this.#submit(payload, target.status, this.#captured),
      'Could not move task to status column',
    );
  };
  async #submit(
    payload: TaskNodeDragPayload,
    status: TaskStatusDef,
    captured: CapturedDrop | undefined,
  ): Promise<void> {
    const token = {};
    this.#commit = token;
    const accept = (): boolean => {
      const current = this.options.statuses().find((value) => value.id === status.id);
      return (
        this.#commit === token &&
        this.options.host.isConnected &&
        this.options.host.ownerDocument.defaultView === this.#owner &&
        current?.symbol === status.symbol &&
        current.type === status.type
      );
    };
    try {
      if (captured !== undefined) await captured(status, accept);
      else if (payload.task.node.statusSymbol !== status.symbol)
        await this.options.drop(payload.task, status, accept);
    } catch (error) {
      new Notice('Could not change task status. Try again.');
      throw error;
    } finally {
      if (this.#commit === token) this.#commit = undefined;
      if (this.options.state.get('draggingTaskNode') === payload)
        this.options.state.set('draggingTaskNode', null);
    }
  }
  #schedule(): void {
    if (this.#frame !== undefined || this.#owner === null) return;
    this.#frame = this.#owner.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (
        !this.options.host.isConnected ||
        this.options.host.ownerDocument.defaultView !== this.#owner
      ) {
        this.#cancel();
        return;
      }
      const point = this.#point;
      if (point === undefined) return;
      this.#scroll(this.options.host, point.x, true);
      const vertical = this.#column?.querySelector<HTMLElement>('.abyss-task-kanban-column-body');
      if (vertical != null) this.#scroll(vertical, point.y, false);
      this.#schedule();
    });
  }
  #scroll(element: HTMLElement, coordinate: number, horizontal: boolean): void {
    const rect = element.getBoundingClientRect();
    const start = horizontal ? rect.left : rect.top;
    const end = horizontal ? rect.right : rect.bottom;
    let delta = 0;
    if (coordinate < start + 32) delta = -10;
    else if (coordinate > end - 32) delta = 10;
    if (horizontal) element.scrollLeft += delta;
    else element.scrollTop += delta;
  }
  #clearPreview(): void {
    if (this.#frame !== undefined) this.#owner?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#point = undefined;
    this.#column?.removeClass('is-drop-target');
    this.#column = undefined;
  }
  readonly #key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.#cancel();
  };
  readonly #cancel = (): void => {
    this.#commit = undefined;
    this.#clearPreview();
    if (this.#payload !== null && this.options.state.get('draggingTaskNode') === this.#payload)
      this.options.state.set('draggingTaskNode', null);
  };
  destroy(): void {
    this.#cancel();
    this.#off();
    this.#listen(false);
    this.options.host.removeEventListener('dragover', this.#over, true);
    this.options.host.removeEventListener('dragleave', this.#leave, true);
    this.options.host.removeEventListener('drop', this.#drop, true);
    this.options.host.removeEventListener('contextmenu', this.#contextMenu, true);
  }
}
