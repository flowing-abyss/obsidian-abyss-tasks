import { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { CalendarSettingsTab } from '../src/settings/SettingsTab';
import type { CalendarSettings } from '../src/settings/types';
import { useRealMoment } from './helpers';

useRealMoment();

interface StubPlugin {
  app: App;
  settings: CalendarSettings;
  saveSettings(): Promise<void>;
}

function makeTab(): CalendarSettingsTab {
  const app = new App();
  // Mock plugins so DailyNoteResolver adapters don't throw on app.plugins access
  (app as unknown as Record<string, unknown>).plugins = { getPlugin: () => null };
  (app as unknown as Record<string, unknown>).internalPlugins = { getPluginById: () => null };
  const plugin: StubPlugin = {
    app,
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  const tab = new CalendarSettingsTab(
    app,
    plugin as unknown as ConstructorParameters<typeof CalendarSettingsTab>[1],
  );
  tab.display();
  return tab;
}

describe('CalendarSettingsTab sections', () => {
  it('renders lifecycle and recurrence setting rows in General', () => {
    const tab = makeTab();
    tab.containerEl.querySelector<HTMLElement>('.abyss-settings-section-header')!.click();
    expect(tab.containerEl.textContent).toContain('Add created date');
    expect(tab.containerEl.textContent).toContain('Add completion date');
    expect(tab.containerEl.textContent).toContain('New occurrence placement');
    expect(tab.containerEl.textContent).toContain('Remove scheduled date');
  });

  it('renders exactly 6 sections', () => {
    const tab = makeTab();
    const sections = tab.containerEl.querySelectorAll('.abyss-settings-section');
    expect(sections).toHaveLength(7);
  });

  it('all sections start collapsed (no is-open)', () => {
    const tab = makeTab();
    const open = tab.containerEl.querySelectorAll('.abyss-settings-section.is-open');
    expect(open).toHaveLength(0);
  });

  it('clicking a header adds is-open to that section', () => {
    const tab = makeTab();
    const header = tab.containerEl.querySelector<HTMLElement>('.abyss-settings-section-header');
    expect(header).not.toBeNull();
    header!.click();
    const section = header!.closest('.abyss-settings-section');
    expect(section?.classList.contains('is-open')).toBe(true);
  });

  it('clicking header again removes is-open', () => {
    const tab = makeTab();
    const header = tab.containerEl.querySelector<HTMLElement>('.abyss-settings-section-header');
    header!.click();
    header!.click();
    const section = header!.closest('.abyss-settings-section');
    expect(section?.classList.contains('is-open')).toBe(false);
  });

  it('section labels match expected names', () => {
    const tab = makeTab();
    const labels = Array.from(
      tab.containerEl.querySelectorAll('.abyss-settings-section-label'),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      'General',
      'Desktop',
      'Mobile',
      'Inbox',
      'Tag groups',
      'Projects',
      'Custom statuses',
    ]);
  });

  it('each section header has an icon element', () => {
    const tab = makeTab();
    const icons = tab.containerEl.querySelectorAll('.abyss-settings-section-icon');
    expect(icons).toHaveLength(7);
  });

  it('each section header has a chevron element', () => {
    const tab = makeTab();
    const chevrons = tab.containerEl.querySelectorAll('.abyss-settings-section-chevron');
    expect(chevrons).toHaveLength(7);
  });

  it('open sections stay open after display() re-render', () => {
    const tab = makeTab();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    headers[1]!.click(); // open Desktop (index 1)
    headers[2]!.click(); // open Mobile (index 2)
    tab.display();
    const sections = Array.from(tab.containerEl.querySelectorAll('.abyss-settings-section'));
    expect(sections[0]!.classList.contains('is-open')).toBe(false);
    expect(sections[1]!.classList.contains('is-open')).toBe(true);
    expect(sections[2]!.classList.contains('is-open')).toBe(true);
    expect(sections[3]!.classList.contains('is-open')).toBe(false);
  });
});
