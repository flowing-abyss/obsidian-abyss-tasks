import { setIcon } from 'obsidian';
import { compileNotePathPattern } from '../markdown/notePathPattern';
import type { TaskSnapshot } from '../tasks';

export function shouldShowSourceNote(
  task: TaskSnapshot,
  sourceNoteDisplay: 'never' | 'always' | 'non-default',
  taskFilePath: string,
): boolean {
  if (sourceNoteDisplay === 'never') return false;
  if (sourceNoteDisplay === 'always') return true;
  let isConfiguredTaskFile = false;
  try {
    isConfiguredTaskFile = compileNotePathPattern(taskFilePath).matches(task.source.filePath);
  } catch {
    isConfiguredTaskFile = false;
  }
  return !isConfiguredTaskFile;
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
