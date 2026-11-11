import { setIcon, setTooltip } from 'obsidian';
import type { TaskTreeV1 } from '../../../api';
import type { CommandSessionOwner } from '../../ai/CommandSessionOwner';
import { commandMessage } from '../../ai/commandMessages';
import type { HistoricalCommandSession } from '../../ai/commandRecovery';
import type { CommandChange } from '../../ai/commandTypes';
import { openAnchoredPopover, type AnchoredPopover } from '../anchoredPopover';
import { runAsyncAction } from '../runAsyncAction';
import type { CaptureExtensionHost } from '../taskCapture/CaptureSurface';

interface HistoryOptions {
  readonly capture: CaptureExtensionHost;
  readonly anchor: HTMLElement;
  readonly owner: CommandSessionOwner;
  readonly selected: () => void;
  readonly closed: () => void;
}
interface HistoryRow {
  readonly element: HTMLElement;
  readonly select: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
}
function taskTitles(tree: TaskTreeV1): string[] {
  return [tree.markdownTitle, ...tree.children.flatMap(taskTitles)];
}
function changeSubjects(change: CommandChange): string[] {
  switch (change.kind) {
    case 'task':
      return [change.plan.before, change.plan.after].flatMap((tree) =>
        tree === null ? [] : taskTitles(tree),
      );
    case 'project-create':
      return [change.name];
    case 'project':
      return [change.before.name];
    case 'project-move':
      return [change.before.markdownTitle];
    case 'note':
      return [change.plan.path];
    case 'cleanup':
    case 'link':
    case 'status':
      return [];
  }
}
function matches(record: HistoricalCommandSession, query: string): boolean {
  if (query === '') return true;
  const state = record.snapshot;
  return [
    record.title,
    state.input,
    ...state.exchanges.map((entry) => entry.text),
    ...state.actual.flatMap(taskTitles),
    ...state.proposal.changes.flatMap(changeSubjects),
    ...state.trees.flatMap((tree) =>
      [tree.before, tree.after].flatMap((value) => (value === null ? [] : taskTitles(value))),
    ),
    ...state.entities.tasks.flatMap((page) => taskTitles(page.tree)),
    ...state.entities.projects.map((project) => project.name),
    ...state.entities.notes.map((page) => page.note.path),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}
function viewport(anchor: HTMLElement): DOMRect {
  const win = anchor.ownerDocument.defaultView;
  if (win === null) return anchor.getBoundingClientRect();
  const visual = win.visualViewport;
  return new win.DOMRect(
    visual?.offsetLeft ?? 0,
    visual?.offsetTop ?? 0,
    visual?.width ?? win.innerWidth,
    visual?.height ?? win.innerHeight,
  );
}
/** Compact history controls; all reads and mutations stay with the session owner. */
export class CommandHistoryPopover {
  private readonly popup: AnchoredPopover;
  private readonly input: HTMLInputElement;
  private readonly clear: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly rows = new Map<string, HistoryRow>();
  private records: readonly HistoricalCommandSession[] = [];
  private readonly unsubscribe: () => void;
  private readonly releaseSurface: () => void;
  private live = true;
  private pending = false;
  private failure = '';
  constructor(private readonly options: HistoryOptions) {
    const document = options.anchor.ownerDocument;
    options.anchor.setAttribute('aria-expanded', 'true');
    options.anchor.setAttribute('aria-haspopup', 'dialog');
    this.popup = openAnchoredPopover({
      owner: document.body,
      anchor: options.anchor,
      boundary: document.body,
      getBoundaryRect: () => viewport(options.anchor),
      viewportPositioned: true,
      preferred: 'below-start',
      cls: 'abyss-command-history-popover',
      attr: { role: 'dialog', 'aria-label': commandMessage('History') },
      ownership: options.capture.interactionOwnership,
      onClose: (restoreFocus) => {
        this.live = false;
        this.unsubscribe();
        this.releaseSurface();
        this.rows.clear();
        this.records = [];
        options.anchor.setAttribute('aria-expanded', 'false');
        options.closed();
        if (restoreFocus && options.anchor.isConnected)
          options.anchor.focus({ preventScroll: true });
      },
    });
    this.releaseSurface = options.capture.registerSurface(this.popup.element);
    const controls = this.popup.element.createDiv({ cls: 'abyss-popover-input-row' });
    this.input = controls.createEl('input', {
      cls: 'abyss-command-history-search',
      type: 'search',
      attr: {
        'aria-label': commandMessage('Search history'),
        placeholder: commandMessage('Search history'),
      },
    });
    this.clear = this.iconButton(controls, 'Clear history', 'brush-cleaning');
    this.list = this.popup.element.createDiv({ cls: 'abyss-command-history-list' });
    this.status = this.popup.element.createDiv({
      cls: 'abyss-command-history-status abyss-command-scope-label',
      attr: { role: 'status' },
    });
    this.input.addEventListener('input', () => {
      this.render();
    });
    this.clear.addEventListener('click', () => {
      runAsyncAction(
        this.run(() => options.owner.clearHistory(), commandMessage('Could not clear history')),
        commandMessage('Could not clear history'),
      );
    });
    this.unsubscribe = options.owner.subscribe(() => {
      this.records = options.owner.recent();
      this.render();
    });
    this.input.focus({ preventScroll: true });
    this.popup.reposition();
  }
  private iconButton(
    host: HTMLElement,
    label: 'Clear history' | 'Delete session',
    icon: string,
  ): HTMLButtonElement {
    const button = host.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { type: 'button', 'aria-label': commandMessage(label) },
    });
    setIcon(button, icon);
    setTooltip(button, commandMessage(label));
    return button;
  }
  private row(id: string): HistoryRow {
    const element = this.list.createDiv({
      cls: 'abyss-command-history-row abyss-popover-input-row',
    });
    const select = element.createEl('button', {
      cls: 'abyss-command-history-select',
      attr: { type: 'button' },
    });
    const remove = this.iconButton(element, 'Delete session', 'x');
    select.addEventListener('click', () => {
      runAsyncAction(
        this.run(
          () => this.options.owner.select(id),
          commandMessage('Could not open session'),
          () => {
            this.close();
            this.options.selected();
          },
        ),
        commandMessage('Could not open session'),
      );
    });
    remove.addEventListener('click', () => {
      runAsyncAction(
        this.run(() => this.options.owner.delete(id), commandMessage('Could not delete session')),
        commandMessage('Could not delete session'),
      );
    });
    return { element, select, remove };
  }
  private prune(ids: ReadonlySet<string>): void {
    const focused = this.popup.element.ownerDocument.activeElement;
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      if (row.element.contains(focused)) this.input.focus({ preventScroll: true });
      row.element.remove();
      this.rows.delete(id);
    }
  }
  private updateRow(record: HistoricalCommandSession, activeId: string): HistoryRow {
    const id = record.snapshot.id;
    let row = this.rows.get(id);
    if (row === undefined) {
      row = this.row(id);
      this.rows.set(id, row);
    }
    row.select.textContent = record.title;
    row.select.title = record.title;
    row.select.setAttribute('aria-current', String(id === activeId));
    row.select.disabled = this.pending;
    const reason = this.options.owner.deletionReason(record);
    row.remove.disabled = this.pending || reason !== null;
    row.remove.title = reason ?? commandMessage('Delete session');
    if (reason === null) row.remove.removeAttribute('aria-description');
    else row.remove.setAttribute('aria-description', reason);
    return row;
  }
  private renderStatus(total: number, shown: number): void {
    this.clear.disabled = this.pending || total === 0;
    this.popup.element.setAttribute('aria-busy', String(this.pending));
    let message = this.options.owner.persistenceFailure()?.message ?? this.failure;
    if (this.pending) message = commandMessage('Updating history…');
    if (message === '' && shown === 0)
      message = commandMessage(total === 0 ? 'No sessions yet' : 'No matching sessions');
    this.status.textContent = message;
    this.status.hidden = message === '';
  }
  private render(): void {
    if (!this.live) return;
    const records = this.records;
    const query = this.input.value.trim().toLocaleLowerCase();
    const visible = records.filter((record) => matches(record, query));
    this.prune(new Set(visible.map((record) => record.snapshot.id)));
    const focused = this.popup.element.ownerDocument.activeElement;
    const activeId = this.options.owner.snapshot().id;
    let cursor = this.list.firstElementChild;
    for (const record of visible) {
      const row = this.updateRow(record, activeId);
      if (row.element === cursor) cursor = cursor.nextElementSibling;
      else this.list.insertBefore(row.element, cursor);
    }
    this.restoreFocus(focused);
    this.renderStatus(records.length, visible.length);
    this.popup.reposition();
  }
  private restoreFocus(focused: Element | null): void {
    const win = this.options.anchor.ownerDocument.defaultView;
    if (
      win !== null &&
      focused instanceof win.HTMLElement &&
      this.list.contains(focused) &&
      focused !== this.popup.element.ownerDocument.activeElement
    )
      focused.focus({ preventScroll: true });
  }
  private isLive(): boolean {
    return this.live;
  }
  private async run(
    work: () => Promise<boolean>,
    failure: string,
    success?: () => void,
  ): Promise<void> {
    if (!this.live || this.pending) return;
    this.pending = true;
    this.failure = '';
    this.render();
    try {
      const result = await work();
      if (!this.isLive()) return;
      if (result) success?.();
      else this.failure = failure;
    } catch {
      if (this.isLive()) this.failure = failure;
    } finally {
      this.pending = false;
      this.render();
    }
  }
  close(restoreFocus?: boolean): void {
    this.popup.close(restoreFocus);
  }
}
