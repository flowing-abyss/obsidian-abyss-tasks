import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { expectDefined, useRealMoment } from './helpers';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
useRealMoment();
afterEach(() => vi.restoreAllMocks());

it('switches Tasks to Timeline with shared search, exact descendant cards and independent date display', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.inbox = { mode: 'tag', tag: '#inbox', removeTagOnAssign: true };
  settings.listViewStates = { inbox: { ...getListViewDefaults('inbox'), groupBy: 'priority' } };
  const h = await mountCanonicalSearchUi(
    {
      'tasks.md':
        '- [ ] parent\n  - [ ] needle child #inbox 🛫 2026-10-24 📅 2026-10-26 ⏳ 2026-10-28\n- [x] needle done #inbox\n- [ ] unrelated #inbox',
    },
    settings,
    'tasks',
  );
  try {
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Timeline view"]')).click();
    await h.completed();
    expect(h.root.querySelector('.abyss-task-timeline')).not.toBeNull();
    h.query('needle');
    await h.completed();
    const titles = Array.from(h.root.querySelectorAll('.abyss-task-title'), (n) => n.textContent);
    expect(titles).toContain('needle child');
    expect(titles).toContain('needle done');
    expect(titles).not.toContain('unrelated');
    expect(
      h.root.querySelectorAll(
        '.abyss-task-timeline-scheduled-track:not([hidden]) .abyss-project-timeline-bar',
      ),
    ).toHaveLength(1);
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="List view"]')).click();
    await h.completed();
    expect(h.root.querySelector<HTMLInputElement>('.abyss-center-search')?.value).toBe('needle');
    expect(h.state.get('centerListViewState').groupBy).toBe('priority');
  } finally {
    h.dispose();
  }
});
