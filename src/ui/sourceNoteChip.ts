import { setIcon } from 'obsidian';
import type { TaskSnapshot } from '../tasks';

export function shouldShowSourceNote(
  task: TaskSnapshot,
  sourceNoteDisplay: 'never' | 'always' | 'non-default',
  customFilePath: string,
): boolean {
  if (sourceNoteDisplay === 'never') return false;
  if (sourceNoteDisplay === 'always') return true;
  const isDefault =
    task.presentation.dailyNoteDate !== undefined ||
    (customFilePath !== '' && task.source.filePath === customFilePath);
  return !isDefault;
}

export function renderSourceNoteChip(
  container: HTMLElement,
  task: TaskSnapshot,
  onClick?: (filePath: string) => void,
): void {
  const noteName = task.source.filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const chip = container.createSpan({
    cls: `abyss-task-source-note${onClick != null ? ' abyss-task-source-note--clickable' : ''}`,
  });
  const iconEl = chip.createSpan({ cls: 'abyss-task-source-note-icon' });
  setIcon(iconEl, 'file-text');
  chip.createSpan({ cls: 'abyss-task-source-note-name', text: noteName });
  if (onClick != null) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(task.source.filePath);
    });
  }
}
