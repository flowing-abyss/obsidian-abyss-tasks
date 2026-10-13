import { setIcon } from 'obsidian';
import { noteNameOfPath } from '../markdown/noteName';

export function renderTaskTagContent(host: HTMLElement, tag: string, color?: string): HTMLElement {
  const element = host.createSpan({ cls: 'abyss-task-tag', text: tag });
  if (color !== undefined && color !== '') {
    element.setCssProps({ '--abyss-tag-color': color });
    element.addClass('abyss-task-tag--colored');
  }
  return element;
}

export function renderSourceNoteContent(
  host: HTMLElement,
  filePath: string,
  icon: 'file-text' | 'inbox' = 'file-text',
  label?: string,
): HTMLElement {
  const chip = host.createSpan({ cls: 'abyss-task-source-note', attr: { title: filePath } });
  setIcon(chip.createSpan({ cls: 'abyss-task-source-note-icon' }), icon);
  chip.createSpan({ cls: 'abyss-task-source-note-name', text: label ?? noteNameOfPath(filePath) });
  return chip;
}
