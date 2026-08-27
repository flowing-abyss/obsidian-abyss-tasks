import { Menu, setIcon } from 'obsidian';
import type {
  WorkNoteCommandResult,
  WorkNoteCreateRequest,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
import type { WorkNotesViewState } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { workNoteStatusMenuModel } from './boardProjection';
import { BoundedWindow } from './BoundedWindow';
import { renderWorkNotesBoard, type BoardViewHandle } from './ProjectsBoardView';
import type { LogicalViewportSession, WorkNotesSession } from './ProjectWorkspaceSession';
import { logicalViewportFirst } from './ProjectWorkspaceSession';
import { renderWorkNoteInspector } from './WorkNoteInspector';
import {
  createWorkNoteResultPresenter,
  type WorkNoteResultPresenter,
} from './WorkNoteResultPresenter';

export const WORK_NOTE_ROW_EXTENT = 52;
export const WORK_NOTE_FALLBACK_VISIBLE_ROWS = 12;
export const WORK_NOTE_OVERSCAN = 4;

export interface WorkNotesViewOptions {
  readonly notes: readonly WorkNoteSnapshot[];
  readonly statuses: readonly WorkNoteStatusDefinition[];
  readonly layout: 'list' | 'board';
  readonly viewState?: WorkNotesViewState;
  readonly commandsEnabled?: boolean;
  readonly createEnabled?: boolean;
  readonly projectPath?: string;
  readonly onCreate?: (
    request: WorkNoteCreateRequest,
  ) => Promise<WorkNoteCommandResult> | WorkNoteCommandResult;
  readonly onSetStatus: (
    note: WorkNoteSnapshot,
    statusId: string,
  ) => Promise<WorkNoteCommandResult> | WorkNoteCommandResult;
  readonly openNote: (path: string) => void;
  readonly session?: WorkNotesSession;
}

export interface WorkNotesViewHandle {
  destroy(): void;
}

function creationResultText(result: WorkNoteCommandResult): string {
  if (result.type === 'partial') return `Partial work note kept at ${basename(result.path)}.`;
  if (result.type === 'conflict') return `Work note not created: ${result.field} changed.`;
  if (result.type === 'compatibility-conflict') return 'Work note not created: audit changed.';
  if (result.type === 'invalid') return `Work note not created: invalid ${result.field}.`;
  return 'Work note could not be created.';
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/u, '');
}

function statusText(note: WorkNoteSnapshot, statuses: readonly WorkNoteStatusDefinition[]): string {
  return (
    (note.statusId ? statuses.find(({ id }) => id === note.statusId)?.label : undefined) ??
    note.rawStatus ??
    'No status'
  );
}

function selectedNotes(options: WorkNotesViewOptions): readonly WorkNoteSnapshot[] {
  if (!options.viewState) return [...options.notes];
  const allowed = options.viewState?.statusIds;
  const filtered =
    allowed && allowed.length > 0
      ? options.notes.filter(({ statusId }) => statusId === null || allowed.includes(statusId))
      : [...options.notes];
  const field = options.viewState?.sortBy.field ?? 'updated';
  const direction = options.viewState?.sortBy.dir === 'asc' ? 1 : -1;
  return [...filtered].sort((left, right) => {
    const value = (note: WorkNoteSnapshot): string => {
      if (field === 'title') return basename(note.path);
      if (field === 'status') return statusText(note, options.statuses);
      if (field === 'priority') return note.priority ?? '';
      if (field === 'start') return note.range.start?.raw ?? '';
      if (field === 'end') return note.range.end?.raw ?? '';
      if (field === 'updated') return note.updated ?? '';
      return basename(note.path);
    };
    return direction * value(left).localeCompare(value(right));
  });
}

function renderStatusMenu(
  event: MouseEvent,
  note: WorkNoteSnapshot,
  options: WorkNotesViewOptions,
  presenter: WorkNoteResultPresenter,
  initiator: HTMLElement,
): void {
  const menu = new Menu();
  for (const action of workNoteStatusMenuModel(options.statuses, note)) {
    menu.addItem((item) =>
      item
        .setTitle(action.label)
        .setIcon(action.icon)
        .setChecked(action.checked)
        .setDisabled(action.disabled)
        .onClick(() => {
          void presenter.run(() => options.onSetStatus(note, action.columnKey), initiator);
        }),
    );
  }
  showMenuAtMouseEventWithFocus(menu, event);
}

function renderRow(
  host: HTMLElement,
  note: WorkNoteSnapshot,
  options: WorkNotesViewOptions,
  presenter: WorkNoteResultPresenter,
  select: () => void,
): HTMLElement {
  const row = host.createDiv({
    cls: 'abyss-work-note-row',
    attr: {
      role: 'button',
      tabindex: '0',
      'data-work-note-path': note.path,
      'aria-label': `${basename(note.path)}, ${statusText(note, options.statuses)}`,
    },
  });
  const identity = row.createDiv({ cls: 'abyss-work-note-identity' });
  identity.createSpan({ cls: 'abyss-work-note-title', text: basename(note.path) });
  const meta = identity.createDiv({ cls: 'abyss-work-note-meta' });
  meta.createSpan({
    cls: 'abyss-work-note-kind',
    text: note.kind === 'ordinary' ? 'Ordinary' : 'Milestone',
  });
  meta.createSpan({ cls: 'abyss-work-note-project', text: basename(note.projectPath) });
  if (note.priority) meta.createSpan({ cls: 'abyss-work-note-priority', text: note.priority });
  const status = row.createEl('button', {
    cls: 'abyss-work-note-status',
    text: statusText(note, options.statuses),
    attr: {
      type: 'button',
      'aria-label': 'Change work note status',
      title:
        options.commandsEnabled === false
          ? 'Requires an accepted compatibility audit with update capability'
          : 'Change work note status',
    },
  });
  status.disabled = options.commandsEnabled === false;
  status.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!status.disabled) renderStatusMenu(event, note, options, presenter, status);
  });
  const open = row.createEl('button', {
    cls: 'abyss-work-note-open',
    attr: { type: 'button', 'aria-label': 'Open work note', title: 'Open work note' },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    options.openNote(note.path);
  });
  row.addEventListener('click', select);
  return row;
}

function renderList(
  container: HTMLElement,
  notes: readonly WorkNoteSnapshot[],
  options: WorkNotesViewOptions,
  presenter: WorkNoteResultPresenter,
): WorkNotesViewHandle {
  container.addClass('abyss-work-notes-view');
  if (notes.length === 0) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'No Work Notes' });
    return { destroy: () => container.empty() };
  }
  const split = container.createDiv({ cls: 'abyss-work-notes-split' });
  const scroll = split.createDiv({ cls: 'abyss-work-notes-scroll' });
  const rows = scroll.createDiv({
    cls: 'abyss-work-note-rows',
    attr: { tabindex: '-1', 'aria-label': 'Work Notes' },
  });
  const inspector = split.createDiv({ cls: 'abyss-work-note-inspector-host' });
  const bounded = new BoundedWindow(
    notes.map(({ path }) => path),
    WORK_NOTE_OVERSCAN,
  );
  const session: LogicalViewportSession | undefined = options.session?.list;
  if (session?.focusedKey) bounded.focus(session.focusedKey);
  const initialFirst = logicalViewportFirst(
    session,
    notes.map(({ path }) => path),
  );
  scroll.scrollTop = initialFirst * WORK_NOTE_ROW_EXTENT;
  let destroyed = false;
  const viewport = (): { first: number; visible: number } => ({
    first: Math.floor(Math.max(0, scroll.scrollTop) / WORK_NOTE_ROW_EXTENT),
    visible:
      scroll.clientHeight > 0
        ? Math.ceil(scroll.clientHeight / WORK_NOTE_ROW_EXTENT)
        : WORK_NOTE_FALLBACK_VISIBLE_ROWS,
  });
  const select = (note: WorkNoteSnapshot): void => {
    renderWorkNoteInspector(inspector, note, {
      statuses: options.statuses,
      commandsEnabled: options.commandsEnabled,
      resultPresenter: presenter,
      onSetStatus: options.onSetStatus,
      openNote: options.openNote,
    });
  };
  const renderWindow = (restoreFocus = false): void => {
    if (destroyed) return;
    const result = bounded.render(rows, {
      ...viewport(),
      itemExtent: WORK_NOTE_ROW_EXTENT,
      restoreFocus,
      render: (host, _key, logicalIndex) => {
        const note = notes[logicalIndex]!;
        const row = renderRow(host, note, options, presenter, () => select(note));
        row.addEventListener('focus', () => {
          bounded.focus(note.path);
          if (session) {
            session.focusedKey = note.path;
            session.restoreFocus = true;
          }
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(note);
            return;
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          bounded.focus(note.path);
          if (bounded.move(event.key === 'ArrowDown' ? 1 : -1) === null) return;
          const first = bounded.viewportForFocus(viewport());
          scroll.scrollTop = first * WORK_NOTE_ROW_EXTENT;
          renderWindow(true);
        });
        return row;
      },
    });
    if (restoreFocus) scroll.scrollTop = result.first * WORK_NOTE_ROW_EXTENT;
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (!session || !(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>('[data-work-note-path]');
    const path = row?.dataset['workNotePath'];
    if (!path || !bounded.focus(path)) return;
    session.focusedKey = path;
    session.restoreFocus = true;
  };
  const onFocusOut = (): void => {
    queueMicrotask(() => {
      if (!session || !rows.isConnected || rows.contains(rows.ownerDocument.activeElement)) return;
      session.restoreFocus = false;
    });
  };
  const rememberViewport = (): void => {
    if (!session) return;
    session.firstIndex = viewport().first;
    session.firstKey = notes[session.firstIndex]?.path ?? null;
  };
  const onScroll = (): void => {
    rememberViewport();
    renderWindow(false);
  };
  scroll.addEventListener('scroll', onScroll);
  rows.addEventListener('focusin', onFocusIn);
  rows.addEventListener('focusout', onFocusOut);
  renderWindow(session?.restoreFocus === true);
  rememberViewport();
  return {
    destroy: () => {
      destroyed = true;
      scroll.removeEventListener('scroll', onScroll);
      rows.removeEventListener('focusin', onFocusIn);
      rows.removeEventListener('focusout', onFocusOut);
      container.empty();
    },
  };
}

function renderWorkNoteBoard(
  container: HTMLElement,
  notes: readonly WorkNoteSnapshot[],
  options: WorkNotesViewOptions,
  presenter: WorkNoteResultPresenter,
): BoardViewHandle {
  return renderWorkNotesBoard(container, {
    notes,
    statuses: options.statuses,
    onMoveStatus: (note, statusId) => Promise.resolve(options.onSetStatus(note, statusId)),
    renderItem: (host, note) => renderRow(host, note, options, presenter, () => undefined),
    executeMutation: (command, initiator) => presenter.run(command, initiator),
    session: options.session?.board,
  });
}

export function renderWorkNotesView(
  container: HTMLElement,
  options: WorkNotesViewOptions,
): WorkNotesViewHandle {
  container.addClass('abyss-work-notes-view');
  const presenter = createWorkNoteResultPresenter(container);
  const toolbar = container.createDiv({ cls: 'abyss-work-notes-toolbar' });
  const content = container.createDiv({ cls: 'abyss-work-notes-content' });
  if (options.onCreate && options.projectPath) {
    const create = toolbar.createEl('button', {
      cls: 'abyss-work-note-create',
      attr: {
        type: 'button',
        'aria-label': 'New work note',
        title:
          options.createEnabled === false
            ? 'Requires an accepted compatibility audit with create capability'
            : 'New work note',
      },
    });
    setIcon(create, 'plus');
    create.disabled = options.createEnabled === false;
    create.addEventListener('click', () => {
      if (toolbar.querySelector('.abyss-work-note-create-input')) return;
      toolbar.querySelector('.abyss-work-note-create-result')?.remove();
      const input = toolbar.createEl('input', {
        cls: 'abyss-work-note-create-input',
        attr: { type: 'text', placeholder: 'Work note title', 'aria-label': 'Work note title' },
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          input.remove();
          create.focus();
          return;
        }
        if (event.key !== 'Enter') return;
        const title = input.value.trim();
        if (!title) return;
        input.disabled = true;
        void Promise.resolve(options.onCreate!({ title, projectPath: options.projectPath! })).then(
          (result) => {
            if (result.type === 'ok' || result.type === 'unchanged') {
              input.remove();
              return;
            }
            input.disabled = false;
            input.focus();
            const status =
              toolbar.querySelector<HTMLElement>('.abyss-work-note-create-result') ??
              toolbar.createDiv({
                cls: 'abyss-work-note-create-result',
                attr: { role: 'status' },
              });
            status.setText(creationResultText(result));
          },
          () => {
            input.disabled = false;
            input.focus();
            const status = toolbar.createDiv({
              cls: 'abyss-work-note-create-result',
              attr: { role: 'status' },
            });
            status.setText('Work note could not be created.');
          },
        );
      });
      input.focus();
    });
  }
  const notes = selectedNotes(options);
  const view =
    options.layout === 'board'
      ? renderWorkNoteBoard(content, notes, options, presenter)
      : renderList(content, notes, options, presenter);
  return {
    destroy: () => {
      view.destroy();
      container.empty();
    },
  };
}
