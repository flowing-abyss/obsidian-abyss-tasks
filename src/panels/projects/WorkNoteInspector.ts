import { Menu, setIcon } from 'obsidian';
import type { ProjectAction, TaskRollup } from '../../projects/types';
import type { MilestoneRollup } from '../../projects/work-notes/rollups';
import type {
  WorkNoteCommandResult,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
import type { TaskCommandResult } from '../../tasks';
import { markInspectorEntity, renderInspectorField } from '../../ui/inspector/InspectorFields';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import type { InspectorDraftRegistry, InspectorDraftResult } from '../../ui/projectDraftContinuity';
import { workNoteStatusMenuModel } from './boardProjection';
import {
  createWorkNoteResultPresenter,
  type WorkNoteResultPresenter,
} from './WorkNoteResultPresenter';

export interface WorkNoteInspectorOptions {
  readonly statuses: readonly WorkNoteStatusDefinition[];
  readonly commandsEnabled?: boolean;
  readonly resultPresenter?: WorkNoteResultPresenter;
  readonly onSetStatus: (
    note: WorkNoteSnapshot,
    statusId: string,
  ) => Promise<WorkNoteCommandResult> | WorkNoteCommandResult;
  readonly openNote: (path: string) => void;
  /** Compatibility-only: desktop closure belongs to the containing inspector shell. */
  readonly onClose?: () => void;
  readonly draftRegistry?: InspectorDraftRegistry;
  readonly onDraftSettled?: () => void;
  readonly taskRollup?: TaskRollup;
  readonly milestoneRollup?: MilestoneRollup;
  readonly onShowTasks?: (note: WorkNoteSnapshot) => void;
  readonly onDelete?: (note: WorkNoteSnapshot, event: MouseEvent) => Promise<void> | void;
  readonly onCreateTask?: (
    note: WorkNoteSnapshot,
    markdownBody: string,
  ) => Promise<TaskCommandResult | WorkNoteCommandResult>;
  readonly taskMoveCandidates?: readonly ProjectAction[];
  readonly onMoveTask?: (
    note: WorkNoteSnapshot,
    action: ProjectAction,
  ) => Promise<TaskCommandResult | WorkNoteCommandResult>;
  readonly onSetTitle?: (note: WorkNoteSnapshot, title: string) => Promise<WorkNoteCommandResult>;
  readonly onSetDate?: (
    note: WorkNoteSnapshot,
    field: 'start' | 'end',
    raw: string | null,
  ) => Promise<WorkNoteCommandResult>;
  readonly onSetPriority?: (
    note: WorkNoteSnapshot,
    value: string | null,
  ) => Promise<WorkNoteCommandResult>;
  readonly onSetDescription?: (
    note: WorkNoteSnapshot,
    value: string | null,
  ) => Promise<WorkNoteCommandResult>;
  readonly relationCandidates?: readonly WorkNoteSnapshot[];
  readonly onSetMilestone?: (
    note: WorkNoteSnapshot,
    milestone: WorkNoteSnapshot | null,
  ) => Promise<WorkNoteCommandResult>;
  readonly onToggleRelated?: (
    note: WorkNoteSnapshot,
    target: WorkNoteSnapshot,
    present: boolean,
  ) => Promise<WorkNoteCommandResult>;
  readonly onToggleBlockedBy?: (
    note: WorkNoteSnapshot,
    target: WorkNoteSnapshot,
    present: boolean,
  ) => Promise<WorkNoteCommandResult>;
}

function isWorkNoteResult(
  result: TaskCommandResult | WorkNoteCommandResult,
): result is WorkNoteCommandResult {
  if (result.type === 'ok') return !('changed' in result);
  if (result.type === 'partial') return !('operation' in result);
  if (result.type === 'io-error') return !('cause' in result);
  if (result.type === 'conflict' || result.type === 'invalid') return 'field' in result;
  return result.type === 'unchanged' || result.type === 'compatibility-conflict';
}

async function presentWorkNoteTaskResult(
  result: TaskCommandResult | WorkNoteCommandResult,
  presenter: WorkNoteResultPresenter,
  control: HTMLElement,
): Promise<void> {
  if (isWorkNoteResult(result)) await presenter.run(() => result, control);
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/u, '');
}

function diagnosticLabel(type: WorkNoteSnapshot['diagnostics'][number]['type']): string {
  return type
    .split('-')
    .map((part, index) =>
      index === 0 ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part,
    )
    .join(' ');
}

function metadataRow(host: HTMLElement, label: string, value: string): HTMLElement {
  const row = host.createDiv({ cls: 'abyss-work-note-inspector-row' });
  row.createSpan({ cls: 'abyss-work-note-inspector-label', text: label });
  return row.createSpan({ cls: 'abyss-work-note-inspector-value', text: value });
}

function relationRow(
  host: HTMLElement,
  label: string,
  paths: readonly string[],
  openNote: (path: string) => void,
): void {
  const row = host.createDiv({ cls: 'abyss-work-note-inspector-row' });
  row.createSpan({ cls: 'abyss-work-note-inspector-label', text: label });
  const values = row.createSpan({ cls: 'abyss-work-note-inspector-value' });
  paths.forEach((path, index) => {
    const target = values.createEl('button', {
      cls: 'abyss-work-note-relation-link',
      text: basename(path),
      attr: { type: 'button', 'aria-label': `Open ${basename(path)}` },
    });
    target.addEventListener('click', () => openNote(path));
    if (index < paths.length - 1) values.createSpan({ text: ', ' });
  });
}

function relationEditButton(
  host: HTMLElement,
  label: 'Milestone' | 'Related' | 'Blocked by',
  note: WorkNoteSnapshot,
  options: WorkNoteInspectorOptions,
  presenter: WorkNoteResultPresenter,
): void {
  const presentResult = async (command: () => Promise<WorkNoteCommandResult>) => {
    const result = await presenter.run(command, edit);
    if (result.type === 'ok' || result.type === 'unchanged') options.onDraftSettled?.();
    return result;
  };
  let enabled = options.onToggleBlockedBy !== undefined;
  if (label === 'Milestone') enabled = options.onSetMilestone !== undefined;
  else if (label === 'Related') enabled = options.onToggleRelated !== undefined;
  if (!enabled) return;
  const edit = host.createEl('button', {
    cls: 'abyss-work-note-relation-edit',
    text: 'Edit',
    attr: {
      type: 'button',
      'aria-label': `Edit ${label} relation${label === 'Milestone' ? '' : 's'}`,
    },
  });
  edit.addEventListener('click', (event) => {
    const menu = new Menu();
    const candidates = (options.relationCandidates ?? []).filter(
      (candidate) => candidate.path !== note.path && candidate.projectPath === note.projectPath,
    );
    if (label === 'Milestone') {
      const clearMilestone = options.onSetMilestone!.bind(undefined, note, null);
      menu.addItem((item) =>
        item
          .setTitle('Clear milestone')
          .setChecked(note.milestonePath === undefined)
          .onClick(() => presentResult(clearMilestone)),
      );
      for (const candidate of candidates.filter(({ kind }) => kind === 'milestone')) {
        const setMilestone = options.onSetMilestone!.bind(undefined, note, candidate);
        menu.addItem((item) =>
          item
            .setTitle(basename(candidate.path))
            .setChecked(note.milestonePath === candidate.path)
            .onClick(() => presentResult(setMilestone)),
        );
      }
    } else {
      const presentPaths = label === 'Related' ? note.relatedPaths : note.blockedByPaths;
      for (const candidate of candidates) {
        const present = presentPaths.includes(candidate.path);
        const command =
          label === 'Related'
            ? options.onToggleRelated!.bind(undefined, note, candidate, present)
            : options.onToggleBlockedBy!.bind(undefined, note, candidate, present);
        menu.addItem((item) =>
          item
            .setTitle(basename(candidate.path))
            .setChecked(present)
            .onClick(() => presentResult(command)),
        );
      }
    }
    showMenuAtMouseEventWithFocus(menu, event);
  });
}

function renderEditableValue(
  host: HTMLElement,
  field: string,
  label: string,
  current: string,
  save: (value: string | null) => Promise<WorkNoteCommandResult>,
  presenter: WorkNoteResultPresenter,
): void {
  const control = renderInspectorField(host, field as never, label).content;
  const input = control.createEl('input', {
    cls: 'abyss-work-note-edit-input',
    value: current,
    attr: { type: 'text', 'aria-label': `Edit ${label.toLocaleLowerCase()}` },
  });
  const commit = control.createEl('button', {
    cls: 'abyss-work-note-edit-save',
    text: 'Save',
    attr: { type: 'button', 'aria-label': `Save ${label.toLocaleLowerCase()}` },
  });
  commit.addEventListener('click', () => {
    const value = input.value.trim();
    void presenter.run(() => save(value.length > 0 ? value : null), commit);
  });
}

function draftResultText(result: InspectorDraftResult | undefined): string {
  if (result === 'ok') return 'Status updated.';
  if (result === 'unchanged') return 'Status is unchanged.';
  if (result === 'conflict') return 'Status changed outside calendar. Draft kept.';
  if (result === 'invalid') return 'Status is invalid. Draft kept.';
  if (result === 'io-error') return 'Could not update status. Draft kept.';
  return '';
}

function renderStatusMenu(
  event: MouseEvent,
  note: WorkNoteSnapshot,
  status: HTMLElement,
  options: WorkNoteInspectorOptions,
  presenter: WorkNoteResultPresenter,
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
          const identity = {
            type: 'work-note' as const,
            path: note.path,
            projectPath: note.projectPath,
          };
          const pendingEntry = options.draftRegistry?.markPending(
            identity,
            'status',
            action.columnKey,
            note.statusId ?? '',
            status.ownerDocument.activeElement === status,
          );
          return presenter
            .run(() => options.onSetStatus(note, action.columnKey), status)
            .then((result) => {
              let draftResult: InspectorDraftResult;
              if (result.type === 'ok' || result.type === 'unchanged') draftResult = result.type;
              else if (result.type === 'conflict' || result.type === 'compatibility-conflict') {
                draftResult = 'conflict';
              } else if (result.type === 'invalid') draftResult = 'invalid';
              else draftResult = 'io-error';
              if (pendingEntry) {
                options.draftRegistry?.settlePending(pendingEntry, draftResult, action.columnKey);
              }
              options.onDraftSettled?.();
              return result;
            });
        }),
    );
  }
  showMenuAtMouseEventWithFocus(menu, event);
}

// The inspector is deliberately one render transaction so shared field order and focus continuity
// remain explicit across plain and editable states.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function renderWorkNoteInspector(
  container: HTMLElement,
  note: WorkNoteSnapshot,
  options: WorkNoteInspectorOptions,
): void {
  container.empty();
  container.addClass('abyss-work-note-inspector');
  markInspectorEntity(container, 'work-note');
  const presenter = options.resultPresenter ?? createWorkNoteResultPresenter(container);
  const header = container.createDiv({ cls: 'abyss-work-note-inspector-header' });
  header.createEl('h3', { text: basename(note.path) });
  if (note.kind === 'milestone' && options.onSetTitle) {
    const title = header.createEl('input', {
      cls: 'abyss-milestone-title-input',
      value: basename(note.path),
      attr: { type: 'text', 'aria-label': 'Edit milestone title' },
    });
    const saveTitle = header.createEl('button', {
      text: 'Save title',
      attr: { type: 'button', 'aria-label': 'Save milestone title' },
    });
    saveTitle.addEventListener('click', () => {
      void presenter.run(() => options.onSetTitle!(note, title.value), saveTitle);
    });
  }
  const open = header.createEl('button', {
    cls: 'abyss-work-note-open',
    attr: {
      type: 'button',
      'aria-label': 'Open work note',
      title: 'Open work note',
    },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', () => options.openNote(note.path));
  if (options.onShowTasks) {
    const tasks = header.createEl('button', {
      cls: 'abyss-work-note-show-tasks',
      attr: {
        type: 'button',
        'aria-label': `Show tasks in ${basename(note.path)}`,
        title: `Show tasks in ${basename(note.path)}`,
      },
    });
    setIcon(tasks, 'list-checks');
    tasks.addEventListener('click', () => options.onShowTasks?.(note));
  }
  if (options.onDelete) {
    const remove = header.createEl('button', {
      cls: 'abyss-work-note-delete',
      attr: {
        type: 'button',
        'aria-label': 'Delete work note',
        title: 'Delete work note',
      },
    });
    setIcon(remove, 'trash-2');
    remove.addEventListener('click', (event) => {
      void options.onDelete?.(note, event);
    });
  }
  if (options.onCreateTask || (options.onMoveTask && options.taskMoveCandidates?.length)) {
    const ownership = renderInspectorField(container, 'tasks' as never, 'Tasks').content;
    if (options.onCreateTask) {
      const input = ownership.createEl('input', {
        cls: 'abyss-work-note-task-input',
        attr: { type: 'text', placeholder: 'Task title', 'aria-label': 'New task title' },
      });
      const create = ownership.createEl('button', {
        text: 'Add task',
        attr: { type: 'button', 'aria-label': 'Create task in work note' },
      });
      create.addEventListener('click', () => {
        const markdownBody = input.value.trim();
        if (!markdownBody) return;
        create.disabled = true;
        void options.onCreateTask!(note, markdownBody)
          .then(async (result) =>
            isWorkNoteResult(result) ? presenter.run(() => result, create) : result,
          )
          .then((result) => {
            if (result.type === 'ok') input.value = '';
          })
          .finally(() => {
            create.disabled = false;
          });
      });
    }
    if (options.onMoveTask && options.taskMoveCandidates?.length) {
      const move = ownership.createEl('button', {
        text: 'Move existing task',
        attr: { type: 'button', 'aria-label': 'Move existing task to work note' },
      });
      move.addEventListener('click', (event) => {
        const menu = new Menu();
        for (const action of options.taskMoveCandidates ?? []) {
          menu.addItem((item) =>
            item.setTitle(action.task.title).onClick(async () => {
              const result = await options.onMoveTask!(note, action);
              await presentWorkNoteTaskResult(result, presenter, move);
            }),
          );
        }
        showMenuAtMouseEventWithFocus(menu, event);
      });
    }
  }
  const statusDefinition = note.statusId
    ? options.statuses.find(({ id }) => id === note.statusId)
    : undefined;
  const statusField = renderInspectorField(container, 'status', 'Status');
  const status = statusField.content.createEl('button', {
    cls: 'abyss-work-note-status',
    text: statusDefinition?.label ?? note.rawStatus ?? 'No status',
    attr: {
      type: 'button',
      'aria-label': 'Change work note status',
      title:
        options.commandsEnabled === false
          ? 'Requires an accepted compatibility audit with update capability'
          : 'Change work note status',
    },
  });
  const identity = {
    type: 'work-note' as const,
    path: note.path,
    projectPath: note.projectPath,
  };
  const statusDraft = options.draftRegistry?.reconcile(identity, 'status', note.statusId ?? '');
  status.disabled = options.commandsEnabled === false || statusDraft?.pending === true;
  if (statusDraft?.pending) status.dataset['resultType'] = 'pending';
  else if (statusDraft?.result) status.dataset['resultType'] = statusDraft.result;
  const draftFeedback = statusField.row.createDiv({
    cls: 'abyss-work-note-draft-result',
    attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  if (statusDraft?.pending) draftFeedback.setText('Saving status…');
  else draftFeedback.setText(draftResultText(statusDraft?.result));
  if (statusDraft?.hadFocus) {
    queueMicrotask(() => {
      if (status.isConnected) status.focus({ preventScroll: true });
    });
  }
  status.addEventListener('focus', () => {
    const current = options.draftRegistry?.get(identity, 'status');
    options.draftRegistry?.capture(identity, 'status', {
      ...current,
      value: current?.value ?? note.statusId ?? '',
      baseline: current?.baseline ?? note.statusId ?? '',
      selectionStart: 0,
      selectionEnd: 0,
      hadFocus: true,
    });
  });
  status.addEventListener('blur', () => {
    const current = options.draftRegistry?.get(identity, 'status');
    if (!current) return;
    options.draftRegistry?.capture(identity, 'status', { ...current, hadFocus: false });
  });
  status.addEventListener('click', (event) => {
    if (status.disabled) return;
    renderStatusMenu(event, note, status, options, presenter);
  });

  const metadata = container.createDiv({ cls: 'abyss-work-note-inspector-metadata' });
  metadataRow(metadata, 'Kind', note.kind === 'ordinary' ? 'Ordinary' : 'Milestone');
  metadataRow(metadata, 'Project', basename(note.projectPath));
  if (note.kind === 'milestone' && options.onSetDate) {
    renderEditableValue(
      metadata,
      'range-start',
      'Start',
      note.range.start?.raw ?? '',
      (value) => options.onSetDate!(note, 'start', value),
      presenter,
    );
    renderEditableValue(
      metadata,
      'range-end',
      'End',
      note.range.end?.raw ?? '',
      (value) => options.onSetDate!(note, 'end', value),
      presenter,
    );
  } else {
    renderInspectorField(metadata, 'range-start', 'Start').content.setText(
      note.range.start?.raw ?? 'Not set',
    );
    renderInspectorField(metadata, 'range-end', 'End').content.setText(
      note.range.end?.raw ?? 'Not set',
    );
  }
  if (note.kind === 'milestone' && options.onSetPriority) {
    renderEditableValue(
      metadata,
      'priority',
      'Priority',
      note.priority ?? '',
      (value) => options.onSetPriority!(note, value),
      presenter,
    );
  } else if (note.priority) {
    renderInspectorField(metadata, 'priority', 'Priority').content.setText(note.priority);
  } else {
    renderInspectorField(metadata, 'priority', 'Priority').content.setText('Not set');
  }
  if (note.kind === 'milestone' && options.onSetDescription) {
    renderEditableValue(
      metadata,
      'description',
      'Description',
      note.description ?? '',
      (value) => options.onSetDescription!(note, value),
      presenter,
    );
  } else if (note.description) {
    const description = renderInspectorField(metadata, 'description', 'Description').content;
    description.setText(note.description);
    description.dataset['workNoteDescription'] = '';
  } else {
    renderInspectorField(metadata, 'description', 'Description').content.setText('Not set');
  }
  if (note.milestonePath || note.blockedByPaths.length > 0 || note.relatedPaths.length > 0) {
    const relations = renderInspectorField(metadata, 'relations', 'Relations').content;
    if (note.milestonePath) {
      relationRow(relations, 'Milestone', [note.milestonePath], options.openNote);
    }
    if (note.blockedByPaths.length > 0) {
      relationRow(relations, 'Blocked by', note.blockedByPaths, options.openNote);
    }
    if (note.relatedPaths.length > 0) {
      relationRow(relations, 'Related', note.relatedPaths, options.openNote);
    }
  } else {
    renderInspectorField(metadata, 'relations', 'Relations').content.setText('None');
  }
  const relationEditors = metadata.createDiv({ cls: 'abyss-work-note-relation-editors' });
  relationEditButton(relationEditors, 'Milestone', note, options, presenter);
  relationEditButton(relationEditors, 'Related', note, options, presenter);
  relationEditButton(relationEditors, 'Blocked by', note, options, presenter);
  if (note.diagnostics.length > 0) {
    const diagnostics = renderInspectorField(container, 'diagnostics', 'Diagnostics').content;
    diagnostics.addClass('abyss-work-note-inspector-diagnostics');
    for (const diagnostic of note.diagnostics) {
      diagnostics.createDiv({ text: diagnosticLabel(diagnostic.type) });
    }
  } else {
    renderInspectorField(container, 'diagnostics', 'Diagnostics').content.setText('None');
  }
  renderInspectorField(container, 'comments', 'Comments').content.setText('Unavailable');
  const progress = renderInspectorField(container, 'progress', 'Progress').content;
  if (note.kind === 'milestone' && options.milestoneRollup) {
    const denominator = options.milestoneRollup.active + options.milestoneRollup.completed;
    progress.setText(
      denominator === 0
        ? 'No active members'
        : `${String(options.milestoneRollup.completed)} of ${String(denominator)} complete`,
    );
  } else if (options.taskRollup?.progress === null || options.taskRollup === undefined) {
    progress.setText(options.taskRollup ? 'No active tasks' : 'Unavailable');
  } else {
    progress.setText(
      `${String(options.taskRollup.done)} of ${String(options.taskRollup.total)} complete`,
    );
  }
}
