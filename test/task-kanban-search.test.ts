import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { expectDefined, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());

it('keeps compact search membership and exact descendant cards across layout changes', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), view: 'kanban' } };
  const h = await mountCanonicalSearchUi(
    { 'tasks.md': '- [ ] parent\n  - [/] needle child\n- [x] needle done\n- [ ] unrelated' },
    settings,
    'tasks',
  );
  try {
    await h.completed();
    expect(h.root.querySelectorAll('.abyss-task-kanban-column')).toHaveLength(
      settings.taskStatuses.length,
    );
    h.query('needle');
    await h.completed();
    const titles = [...h.root.querySelectorAll('.abyss-task-card .abyss-task-title')].map(
      (el) => el.textContent,
    );
    expect(titles.join(' ')).toContain('needle');
    expect(titles.join(' ')).not.toContain('unrelated');
    expectDefined(
      h.root.querySelector<HTMLButtonElement>('button[aria-label="List view"]'),
    ).click();
    await h.completed();
    expect(h.root.querySelector<HTMLInputElement>('.abyss-center-search')?.value).toBe('needle');
    expect(h.root.querySelector('.abyss-task-kanban')).toBeNull();
  } finally {
    h.dispose();
  }
});
