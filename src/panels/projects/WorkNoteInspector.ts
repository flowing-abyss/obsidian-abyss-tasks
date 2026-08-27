import { Menu, setIcon } from 'obsidian';
import type { WorkNoteSnapshot } from '../../projects/work-notes/types';
import type { ProjectStatus } from '../../settings/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { workNoteStatusMenuModel } from './boardProjection';

export interface WorkNoteInspectorOptions {
  readonly statuses: readonly ProjectStatus[];
  readonly commandsEnabled?: boolean;
  readonly onSetStatus: (note: WorkNoteSnapshot, statusId: string) => void;
  readonly openNote: (path: string) => void;
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

export function renderWorkNoteInspector(
  container: HTMLElement,
  note: WorkNoteSnapshot,
  options: WorkNoteInspectorOptions,
): void {
  container.empty();
  container.addClass('abyss-work-note-inspector');
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
  status.disabled = options.commandsEnabled === false;
  if (statusDefinition?.color)
    status.style.setProperty('--abyss-status-accent', statusDefinition.color);
  status.addEventListener('click', (event) => {
    if (status.disabled) return;
    const menu = new Menu();
    for (const action of workNoteStatusMenuModel(options.statuses, note)) {
      menu.addItem((item) =>
        item
          .setTitle(action.label)
          .setIcon(action.icon)
          .setChecked(action.checked)
          .setDisabled(action.disabled)
          .onClick(() => options.onSetStatus(note, action.columnKey)),
      );
    }
    showMenuAtMouseEventWithFocus(menu, event);
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
