import { addIcon, removeIcon } from 'obsidian';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { resolveEffectiveTagGroups } from '../src/tags/effectiveTagGroups';
import { tagColorForGroups } from '../src/tags/tagColor';
import { renderSourceNoteContent, renderTaskTagContent } from '../src/ui/taskMetadataContent';
it('shares full tag spelling and the existing color family', () => {
  const host = createDiv();
  const tag = renderTaskTagContent(host, '#Work/nested', '#ff0000');
  expect(tag.textContent).toBe('#Work/nested');
  expect(tag.classList).toContain('abyss-task-tag--colored');
  expect(tag.style.getPropertyValue('--abyss-tag-color')).toBe('#ff0000');
});
it('renders actual note basename/path and the requested Inbox icon', () => {
  addIcon('file-text', '<path/>');
  addIcon('inbox', '<path/>');
  const host = createDiv();
  const note = renderSourceNoteContent(host, 'Folder/Tasks.md');
  expect(note.textContent).toBe('Tasks');
  expect(note.getAttribute('title')).toBe('Folder/Tasks.md');
  expect(note.querySelector('.abyss-task-source-note-icon svg.file-text')).not.toBeNull();
  const inbox = renderSourceNoteContent(host, 'Inbox.md', 'inbox', 'Inbox');
  expect(inbox.textContent).toBe('Inbox');
  expect(inbox.querySelector('.abyss-task-source-note-icon svg.inbox')).not.toBeNull();
  removeIcon('file-text');
  removeIcon('inbox');
});
it('uses the first effective matching group including observed nested tags', () => {
  const groups = resolveEffectiveTagGroups(
    {
      ...DEFAULT_SETTINGS,
      tagGroups: [
        { id: 'work', name: 'Work', color: '#ff0000', mode: 'prefix', prefix: 'work', tags: [] },
      ],
    },
    ['#work/nested'],
  );
  expect(tagColorForGroups('#work/nested', groups)).toBe('#ff0000');
});
