import { MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getListViewDefaults } from '../src/settings/defaults';
import { expectDefined, useRealMoment } from './helpers';
import { projectTimelineLogicalCenter } from './support/projectTimelineGeometry';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';
useRealMoment();
afterEach(() => vi.restoreAllMocks());

it('opens the fully formatted task at a distant scroll position using its normal card', async () => {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
    const match = /^\*\*(needle \d{3})\*\*$/.exec(source);
    if (match?.[1] !== undefined) holder.createEl('strong', { text: match[1] });
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.inbox = { mode: 'tag', tag: '#category', removeTagOnAssign: false };
  const h = await mountCanonicalSearchUi(
    {
      'tasks.md': Array.from(
        { length: 120 },
        (_, i) => `- [x] **needle ${String(i).padStart(3, '0')}** #category 📅 2026-10-26`,
      ).join('\n'),
    },
    settings,
    'tasks',
  );
  try {
    expectDefined(h.root.querySelector<HTMLButtonElement>('[aria-label="Timeline view"]')).click();
    h.query('needle');
    await h.completed();
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-timeline'));
    expect(scroll.querySelector('[data-timeline-preview-key]')).toBeNull();
    scroll.scrollTop = 7300;
    scroll.dispatchEvent(new Event('scroll'));
    const row = await vi.waitFor(() => {
      const target = expectDefined(
        scroll.querySelector<HTMLElement>(
          '[data-occurrence-id="tasks.md:105"].abyss-task-timeline-row',
        ),
      );
      expect(target.querySelector('.abyss-task-card .abyss-task-title')?.textContent).toBe(
        'needle 105',
      );
      return target;
    });
    expect(row.querySelector('.abyss-task-title strong')?.textContent).toBe('needle 105');
    expect(row.classList.contains('is-done')).toBe(true);
    expect(row.querySelector('.abyss-status-marker')).not.toBeNull();
    expect(row.querySelector('.abyss-task-date-part')).not.toBeNull();
    expect(row.textContent).toContain('category');
    expect(row.querySelector('.abyss-project-timeline-track')).not.toBeNull();
    expectDefined(row.querySelector<HTMLElement>('.abyss-task-card')).click();
    await vi.waitFor(() => {
      expect(h.state.get('taskStack')[0]?.ref).toMatchObject({ filePath: 'tasks.md', line: 105 });
    });
  } finally {
    h.dispose();
  }
});

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
    const done = expectDefined(
      [...h.root.querySelectorAll<HTMLElement>('.abyss-task-timeline-row')].find((row) =>
        row.textContent.includes('needle done'),
      ),
    );
    expect(done.classList.contains('is-done')).toBe(true);
    expect(h.root.querySelectorAll('.abyss-task-timeline-row.is-done')).toHaveLength(1);
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

it('resets horizontal focus on intentional Timeline entry while ordinary search refresh preserves it', async () => {
  const h = await mountCanonicalSearchUi(
    { 'tasks.md': '- [ ] needle #inbox 🛫 2026-10-24 📅 2026-10-26' },
    structuredClone(DEFAULT_SETTINGS),
    'tasks',
  );
  try {
    const measure = expectDefined(
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').getMockImplementation(),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = measure.call(this);
      return this.classList.contains('abyss-project-timeline-axis-summary')
        ? { ...rect, width: 180, right: 180 }
        : rect;
    });
    const choose = async (view: string) => {
      expectDefined(h.root.querySelector<HTMLButtonElement>(`[aria-label="${view} view"]`)).click();
      await h.completed();
    };
    await choose('Timeline');
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-timeline'));
    const initial = scroll.scrollLeft;
    scroll.scrollLeft += 401.375;
    h.query('needle');
    await h.completed();
    expect(scroll.scrollLeft).toBeCloseTo(initial + 401.375, 6);
    await choose('List');
    await choose('Timeline');
    expect(
      expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-timeline')).scrollLeft,
    ).toBeCloseTo(initial, 6);
  } finally {
    h.dispose();
  }
});

it('preserves the scrolled date after selecting the active Timeline view and migrating windows', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const h = await mountCanonicalSearchUi(
    { 'tasks.md': '- [ ] needle #inbox 🛫 2026-10-24 📅 2026-10-26' },
    settings,
    'tasks',
  );
  let migrated: ReturnType<typeof taskViewportOwner> | undefined;
  try {
    const measure = expectDefined(
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').getMockImplementation(),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = measure.call(this);
      return this.classList.contains('abyss-project-timeline-axis-summary')
        ? { ...rect, width: 180, right: 180 }
        : rect;
    });
    const chooseTimeline = () => {
      expectDefined(
        h.root.querySelector<HTMLButtonElement>('[aria-label="Timeline view"]'),
      ).click();
    };
    chooseTimeline();
    await h.completed();
    const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-timeline'));
    scroll.scrollLeft += 401.375;
    const savedSettings = structuredClone(settings);
    chooseTimeline();
    expect(settings).toEqual(savedSettings);
    expect(h.root.querySelector('.abyss-task-timeline')).toBe(scroll);
    scroll.scrollLeft += 200;
    const expectedCenter = projectTimelineLogicalCenter(scroll);
    migrated = taskViewportOwner();
    migrated.doc.body.append(h.root);
    h.panel.onWindowMigrated();
    await h.completed();
    migrated.flush();
    expect(
      projectTimelineLogicalCenter(
        expectDefined(h.root.querySelector<HTMLElement>('.abyss-task-timeline')),
      ),
    ).toBeCloseTo(expectedCenter, 6);
  } finally {
    h.dispose();
    migrated?.destroy();
  }
});
