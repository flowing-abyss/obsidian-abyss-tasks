import { App, Platform } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { CalendarSettingsTab } from '../src/settings/SettingsTab';
import { SHORTCUT_ACTIONS } from '../src/settings/shortcuts';
import type { CalendarSettings } from '../src/settings/types';
import { expectDefined, useRealMoment } from './helpers';

useRealMoment();

async function loadStylesFixture(): Promise<string> {
  if (!Platform.isDesktop) throw new Error('CSS fixture requires the desktop test runtime');
  const fileSystem = await import('node:fs');
  const nodePath = await import('node:path');
  return fileSystem.readFileSync(nodePath.resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
}

const css = await loadStylesFixture();

function expectDeclaration(source: string, property: string, value: string): void {
  expect(source).toMatch(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*${value}\\s*(?:;|$)`, 'u'));
}

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
}

interface StubPlugin {
  app: App;
  settings: CalendarSettings;
  saveSettings(): Promise<void>;
  saveViewState(): Promise<void>;
  refreshProjectTableSettings(): void;
}

function makeTab(): CalendarSettingsTab {
  const app = new App();
  // Mock plugins so DailyNoteResolver adapters don't throw on app.plugins access
  (app as unknown as Record<string, unknown>)['plugins'] = { getPlugin: () => null };
  (app as unknown as Record<string, unknown>)['internalPlugins'] = {
    getPluginById: () => null,
  };
  const plugin: StubPlugin = {
    app,
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    saveViewState: vi.fn().mockResolvedValue(undefined),
    refreshProjectTableSettings: vi.fn(),
  };
  const tab = new CalendarSettingsTab(
    app,
    plugin as unknown as ConstructorParameters<typeof CalendarSettingsTab>[1],
  );
  (tab as unknown as { display(): void }).display();
  return tab;
}

describe('CalendarSettingsTab sections', () => {
  it('nests each top-level section body in a padded inner wrapper', () => {
    const tab = makeTab();
    const sections = [...tab.containerEl.querySelectorAll(':scope > .abyss-settings-section')];
    for (const section of sections) {
      const body = expectDefined(section.querySelector(':scope > .abyss-settings-section-body'));
      expect(body.children).toHaveLength(1);
      expect(body.firstElementChild?.classList.contains('abyss-settings-section-body-inner')).toBe(
        true,
      );
    }
    expect(
      expectDefined(expectDefined(sections[0]).querySelector('.abyss-settings-section-body-inner'))
        .textContent,
    ).toContain('Task prefix');
  });

  it('uses compact theme-native settings card geometry', () => {
    const header = declarationsFor(
      '.modal.mod-settings .abyss-settings-section > button.abyss-settings-section-header',
    );
    expectDeclaration(header, 'appearance', 'none');
    expectDeclaration(header, 'min-height', '0');
    expectDeclaration(header, 'height', 'auto');
    expectDeclaration(header, 'border', '0');
    expectDeclaration(header, 'border-radius', '0');
    expectDeclaration(header, 'box-shadow', 'none');
    expectDeclaration(header, 'font', 'inherit');
    expectDeclaration(header, 'line-height', 'normal');
    expectDeclaration(header, 'width', '100%');
    expectDeclaration(header, 'padding', '12px 16px');

    const body = declarationsFor('.abyss-settings-section-body');
    const openBody = declarationsFor(
      '.abyss-settings-section.is-open .abyss-settings-section-body',
    );
    expect(body).not.toMatch(/(?:^|;)\\s*(?:max-height|transition)\\s*:/u);
    expect(openBody).not.toMatch(/(?:^|;)\\s*max-height\\s*:/u);
    expectDeclaration(
      declarationsFor('.abyss-settings-section-body-inner'),
      'padding',
      '12px 16px 8px',
    );
  });

  it('renders lifecycle and recurrence setting rows in General', () => {
    const tab = makeTab();
    expectDefined(
      tab.containerEl.querySelector<HTMLElement>('.abyss-settings-section-header'),
    ).click();
    expect(tab.containerEl.textContent).toContain('Add created date');
    expect(tab.containerEl.textContent).toContain('Add completion date');
    expect(tab.containerEl.textContent).toContain('New occurrence placement');
    expect(tab.containerEl.textContent).toContain('Remove scheduled date');
  });

  it('renders a Hotkeys section with one row per supported action', () => {
    const tab = makeTab();
    const sections = tab.containerEl.querySelectorAll('.abyss-settings-section');
    expect(sections).toHaveLength(8);

    const hotkeys = expectDefined(sections[7]);
    expectDefined(hotkeys.querySelector<HTMLElement>('.abyss-settings-section-header')).click();
    expect(hotkeys.textContent).toContain('Hotkeys');
    expect(hotkeys.querySelectorAll('.abyss-shortcut-row')).toHaveLength(SHORTCUT_ACTIONS.length);
    expect(hotkeys.textContent).toContain('Quick capture');
    expect(hotkeys.textContent).toContain('Calendar: month');
    expect(hotkeys.textContent).toContain('Separate alternatives with |');
    expect(hotkeys.textContent).toContain('Q | shift 7');
  });

  it('styles shortcut warnings without reserving space for clean rows', () => {
    expect(css).toMatch(
      /\.abyss-shortcut-input\[aria-invalid='true'\]\s*\{[^}]*var\(--text-warning\)/u,
    );
    expect(css).toMatch(/\.abyss-shortcut-issue:empty\s*\{\s*display:\s*none/u);
  });

  it('all sections start collapsed (no is-open)', () => {
    const tab = makeTab();
    const open = tab.containerEl.querySelectorAll('.abyss-settings-section.is-open');
    expect(open).toHaveLength(0);
  });

  it('uses native disclosure buttons and removes collapsed bodies from interaction', () => {
    const tab = makeTab();
    const header = expectDefined(
      tab.containerEl.querySelector<HTMLButtonElement>('.abyss-settings-section-header'),
    );
    const controlled = header.getAttribute('aria-controls');
    const body = expectDefined(tab.containerEl.querySelector<HTMLElement>(`#${controlled}`));

    expect(header.tagName).toBe('BUTTON');
    expect(header.type).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);

    header.click();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);

    header.click();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
  });

  it('clicking a header adds is-open to that section', () => {
    const tab = makeTab();
    const header = tab.containerEl.querySelector<HTMLElement>('.abyss-settings-section-header');
    expect(header).not.toBeNull();
    expectDefined(header).click();
    const section = expectDefined(header).closest('.abyss-settings-section');
    expect(section?.classList.contains('is-open')).toBe(true);
  });

  it('clicking header again removes is-open', () => {
    const tab = makeTab();
    const header = tab.containerEl.querySelector<HTMLElement>('.abyss-settings-section-header');
    expectDefined(header).click();
    expectDefined(header).click();
    const section = expectDefined(header).closest('.abyss-settings-section');
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
      'Hotkeys',
    ]);
  });

  it('each section header has an icon element', () => {
    const tab = makeTab();
    const icons = tab.containerEl.querySelectorAll('.abyss-settings-section-icon');
    expect(icons).toHaveLength(8);
  });

  it('each section header has a chevron element', () => {
    const tab = makeTab();
    const chevrons = tab.containerEl.querySelectorAll('.abyss-settings-section-chevron');
    expect(chevrons).toHaveLength(8);
  });

  it('open sections stay open after display() re-render', () => {
    const tab = makeTab();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    expectDefined(headers[1]).click(); // open Desktop (index 1)
    expectDefined(headers[2]).click(); // open Mobile (index 2)
    (tab as unknown as { display(): void }).display();
    const sections = Array.from(tab.containerEl.querySelectorAll('.abyss-settings-section'));
    expect(expectDefined(sections[0]).classList.contains('is-open')).toBe(false);
    expect(expectDefined(sections[1]).classList.contains('is-open')).toBe(true);
    expect(expectDefined(sections[2]).classList.contains('is-open')).toBe(true);
    expect(expectDefined(sections[3]).classList.contains('is-open')).toBe(false);
    expect(
      expectDefined(sections[1])
        .querySelector('.abyss-settings-section-header')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      expectDefined(sections[1]).querySelector<HTMLElement>('.abyss-settings-section-body')?.hidden,
    ).toBe(false);
  });
});
