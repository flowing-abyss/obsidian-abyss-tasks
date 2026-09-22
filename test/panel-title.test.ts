import { describe, expect, it } from 'vitest';
import { listSelectionTitle, panelTitle, projectNameFromPath } from '../src/views/panelTitle';

const groups = [{ id: 'g-work', name: 'Work' }];

describe('panelTitle', () => {
  it('names the built-in lists', () => {
    expect(listSelectionTitle('inbox', groups)).toBe('Inbox');
    expect(listSelectionTitle('today', groups)).toBe('Today');
    expect(listSelectionTitle('upcoming', groups)).toBe('Upcoming');
  });

  it('names tag, group and project selections', () => {
    expect(listSelectionTitle({ type: 'tag', tag: '#work/legal' }, groups)).toBe('#work/legal');
    expect(listSelectionTitle({ type: 'group', groupId: 'g-work' }, groups)).toBe('Work');
    expect(listSelectionTitle({ type: 'group', groupId: 'missing' }, groups)).toBe('Group');
    expect(listSelectionTitle({ type: 'project', path: 'Projects/Launch.md' }, groups)).toBe(
      'Launch',
    );
  });

  it('reads selections this build does not know as Tasks', () => {
    expect(listSelectionTitle('archive' as unknown as 'inbox', groups)).toBe('Tasks');
    expect(
      listSelectionTitle(
        { type: 'saved', id: 'x' } as unknown as { type: 'tag'; tag: string },
        groups,
      ),
    ).toBe('Tasks');
  });

  it('strips folders and the markdown extension from project paths', () => {
    expect(projectNameFromPath('a/b/Plan.md')).toBe('Plan');
    expect(projectNameFromPath('Plan')).toBe('Plan');
  });

  it('names every mode', () => {
    expect(panelTitle('tasks', 'today', groups)).toBe('Today');
    expect(panelTitle('tasks', { type: 'group', groupId: 'g-work' }, groups)).toBe('Work');
    expect(panelTitle('calendar', 'today', groups)).toBe('Calendar');
    expect(panelTitle('projects', 'today', groups)).toBe('Projects');
    expect(panelTitle('search', 'today', groups)).toBe('Search');
  });
});
