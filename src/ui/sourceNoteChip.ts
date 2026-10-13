import { compileNotePathPattern } from '../markdown/notePathPattern';
import type { TaskSnapshot } from '../tasks';
import { renderSourceNoteContent } from './taskMetadataContent';

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
  const chip = renderSourceNoteContent(container, task.source.filePath);
  chip.classList.toggle('abyss-task-source-note--clickable', onClick != null);
  if (onClick != null) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(task.source.filePath);
    });
  }
}
