import { Menu, setIcon } from 'obsidian';
import type {
  WorkNoteCommandResult,
  WorkNoteSnapshot,
  WorkNoteStatusDefinition,
} from '../../projects/work-notes/types';
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
  readonly onClose?: () => void;
  readonly draftRegistry?: InspectorDraftRegistry;
  readonly onDraftSettled?: () => void;
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

function metadataRow(host: HTMLElement, label: string, value: string): void {
  const row = host.createDiv({ cls: 'abyss-work-note-inspector-row' });
  row.createSpan({ cls: 'abyss-work-note-inspector-label', text: label });
  row.createSpan({ cls: 'abyss-work-note-inspector-value', text: value });
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

export function renderWorkNoteInspector(
  container: HTMLElement,
  note: WorkNoteSnapshot,
  options: WorkNoteInspectorOptions,
): void {
  container.empty();
  container.addClass('abyss-work-note-inspector');
  const presenter = options.resultPresenter ?? createWorkNoteResultPresenter(container);
  const header = container.createDiv({ cls: 'abyss-work-note-inspector-header' });
  header.createEl('h3', { text: basename(note.path) });
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
  if (options.onClose) {
    /* eslint-disable obsidianmd/ui/sentence-case -- Work Note is a named product concept. */
    const close = header.createEl('button', {
      cls: 'abyss-work-note-inspector-close',
      attr: {
        type: 'button',
        'aria-label': 'Close Work Note details',
        title: 'Close Work Note details',
      },
    });
    /* eslint-enable obsidianmd/ui/sentence-case */
    setIcon(close, 'x');
    close.addEventListener('click', options.onClose);
  }

  const statusDefinition = note.statusId
    ? options.statuses.find(({ id }) => id === note.statusId)
    : undefined;
  const status = container.createEl('button', {
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
  const draftFeedback = container.createDiv({
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
  if (note.priority) metadataRow(metadata, 'Priority', note.priority);
  if (note.milestonePath) metadataRow(metadata, 'Milestone', basename(note.milestonePath));
  if (note.blockedByPaths.length > 0) {
    metadataRow(metadata, 'Blocked by', note.blockedByPaths.map(basename).join(', '));
  }
  if (note.relatedPaths.length > 0) {
    metadataRow(metadata, 'Related', note.relatedPaths.map(basename).join(', '));
  }
  if (note.diagnostics.length > 0) {
    const diagnostics = container.createDiv({ cls: 'abyss-work-note-inspector-diagnostics' });
    for (const diagnostic of note.diagnostics) {
      diagnostics.createDiv({ text: diagnosticLabel(diagnostic.type) });
    }
  }
}
