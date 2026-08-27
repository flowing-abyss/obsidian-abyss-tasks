import { Menu, setIcon } from 'obsidian';
import type {
  WorkNoteCommandResult,
  WorkNoteCreateRequest,
  WorkNoteSnapshot,
} from '../../projects/work-notes/types';
import type { ProjectStatus, WorkNotesViewState } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { workNoteStatusMenuModel } from './boardProjection';
import { BoundedWindow } from './BoundedWindow';
import { renderWorkNotesBoard, type BoardViewHandle } from './ProjectsBoardView';
import { renderWorkNoteInspector } from './WorkNoteInspector';

export const WORK_NOTE_ROW_EXTENT = 52;
export const WORK_NOTE_FALLBACK_VISIBLE_ROWS = 12;
export const WORK_NOTE_OVERSCAN = 4;

export interface WorkNotesViewOptions {
  readonly notes: readonly WorkNoteSnapshot[];
  readonly statuses: readonly ProjectStatus[];
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
}

export interface WorkNotesViewHandle {
  destroy(): void;
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/u, '');
}

function statusText(note: WorkNoteSnapshot, statuses: readonly ProjectStatus[]): string {
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
      return basename(note.path);
    };
    return direction * value(left).localeCompare(value(right));
  });
}

function renderStatusMenu(
  event: MouseEvent,
  note: WorkNoteSnapshot,
  options: WorkNotesViewOptions,
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
          Promise.resolve(options.onSetStatus(note, action.columnKey)).catch(() => undefined);
        }),
    );
  }
  showMenuAtMouseEventWithFocus(menu, event);
}

function renderRow(
  host: HTMLElement,
  note: WorkNoteSnapshot,
  options: WorkNotesViewOptions,
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
    if (!status.disabled) renderStatusMenu(event, note, options);
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
      onSetStatus: (selected, statusId) => {
        Promise.resolve(options.onSetStatus(selected, statusId)).catch(() => undefined);
      },
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
        const row = renderRow(host, note, options, () => select(note));
        row.addEventListener('focus', () => bounded.focus(note.path));
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
  const onScroll = (): void => renderWindow(false);
  scroll.addEventListener('scroll', onScroll);
  renderWindow();
  return {
    destroy: () => {
      destroyed = true;
      scroll.removeEventListener('scroll', onScroll);
      container.empty();
    },
  };
}

function renderWorkNoteBoard(
  container: HTMLElement,
  notes: readonly WorkNoteSnapshot[],
  options: WorkNotesViewOptions,
): BoardViewHandle {
  return renderWorkNotesBoard(container, {
    notes,
    statuses: options.statuses,
    onMoveStatus: (note, statusId) => Promise.resolve(options.onSetStatus(note, statusId)),
    renderItem: (host, note) => renderRow(host, note, options, () => undefined),
  });
}

export function renderWorkNotesView(
  container: HTMLElement,
  options: WorkNotesViewOptions,
): WorkNotesViewHandle {
  container.addClass('abyss-work-notes-view');
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
        void Promise.resolve(options.onCreate?.({ title, projectPath: options.projectPath! })).then(
          () => input.remove(),
          () => {
            input.disabled = false;
          },
        );
      });
      input.focus();
    });
  }
  const notes = selectedNotes(options);
  const view =
    options.layout === 'board'
      ? renderWorkNoteBoard(content, notes, options)
      : renderList(content, notes, options);
  return {
    destroy: () => {
      view.destroy();
      container.empty();
    },
  };
}
