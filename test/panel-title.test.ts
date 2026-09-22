import { describe, expect, it, vi } from 'vitest';
import { listSelectionTitle, panelTitle } from '../src/views/panelTitle';

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
    expect(listSelectionTitle({ type: 'project', path: 'a/b/Plan.md' }, groups)).toBe('Plan');
    expect(listSelectionTitle({ type: 'project', path: 'Plan' }, groups)).toBe('Plan');
  });

  it('names every mode and asks for the list name only in tasks mode', () => {
    const listTitle = vi.fn(() => 'Work');
    expect(panelTitle('tasks', listTitle)).toBe('Work');
    expect(panelTitle('calendar', listTitle)).toBe('Calendar');
    expect(panelTitle('projects', listTitle)).toBe('Projects');
    expect(panelTitle('search', listTitle)).toBe('Search');
    expect(listTitle).toHaveBeenCalledTimes(1);
  });
});
