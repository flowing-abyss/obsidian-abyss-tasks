import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, Setting } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { CalendarSettingsTab } from '../src/settings/SettingsTab';
import { SHORTCUT_ACTION_IDS } from '../src/settings/shortcuts';
import type { CalendarSettings } from '../src/settings/types';
import { deferred, useRealMoment } from './helpers';

useRealMoment();

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

interface StubPlugin {
  app: App;
  settings: CalendarSettings;
  saveSettings: ReturnType<typeof vi.fn>;
  previewWorkNoteCompatibility: ReturnType<typeof vi.fn>;
  acceptWorkNoteCompatibility: ReturnType<typeof vi.fn>;
  disableWorkNoteCompatibility: ReturnType<typeof vi.fn>;
}

interface CapturedComp {
  type: 'text' | 'dropdown' | 'toggle' | 'button' | 'color';
  name: string;
  comp: {
    getValue?: () => unknown;
    setValue: (v: unknown) => unknown;
    clickHandler?: () => void;
  };
}

function patchSetting(captured: CapturedComp[]): () => void {
  const proto = Setting.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const refs: Record<string, (...args: unknown[]) => unknown> = {
    addText: proto.addText!,
    addDropdown: proto.addDropdown!,
    addToggle: proto.addToggle!,
    addButton: proto.addButton!,
    addColorPicker: proto.addColorPicker!,
  };
  const wrap = (orig: (...args: unknown[]) => unknown, type: CapturedComp['type']) =>
    function (this: { components: unknown[]; nameEl?: { textContent?: string } }, cb: unknown) {
      const result = orig.call(this, cb);
      captured.push({
        type,
        name: this.nameEl?.textContent ?? '',
        comp: this.components[this.components.length - 1] as CapturedComp['comp'],
      });
      return result;
    };
  const set = (name: string, fn: unknown) => {
    (Setting.prototype as unknown as Record<string, unknown>)[name] = fn;
  };
  set('addText', wrap(refs.addText!, 'text'));
  set('addDropdown', wrap(refs.addDropdown!, 'dropdown'));
  set('addToggle', wrap(refs.addToggle!, 'toggle'));
  set('addButton', wrap(refs.addButton!, 'button'));
  set('addColorPicker', wrap(refs.addColorPicker!, 'color'));
  return () => {
    set('addText', refs.addText!);
    set('addDropdown', refs.addDropdown!);
    set('addToggle', refs.addToggle!);
    set('addButton', refs.addButton!);
    set('addColorPicker', refs.addColorPicker!);
  };
}

function makeTab(
  settingsOverrides: Partial<CalendarSettings> = {},
  opts: {
    expand?: boolean;
    saveSettings?: StubPlugin['saveSettings'];
    previewWorkNoteCompatibility?: StubPlugin['previewWorkNoteCompatibility'];
    acceptWorkNoteCompatibility?: StubPlugin['acceptWorkNoteCompatibility'];
    disableWorkNoteCompatibility?: StubPlugin['disableWorkNoteCompatibility'];
  } = {},
): {
  tab: CalendarSettingsTab;
  plugin: StubPlugin;
  app: App;
  captured: CapturedComp[];
} {
  const expandCards = opts.expand ?? true;
  const app = new App();
  // Mock plugins so DailyNoteResolver adapters don't throw on app.plugins access
  (app as unknown as Record<string, unknown>).plugins = { getPlugin: () => null };
  (app as unknown as Record<string, unknown>).internalPlugins = { getPluginById: () => null };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...settingsOverrides };
  const saveSettings = opts.saveSettings ?? vi.fn().mockResolvedValue(undefined);
  const previewWorkNoteCompatibility =
    opts.previewWorkNoteCompatibility ?? vi.fn().mockResolvedValue(undefined);
  const acceptWorkNoteCompatibility =
    opts.acceptWorkNoteCompatibility ?? vi.fn().mockResolvedValue(undefined);
  const disableWorkNoteCompatibility =
    opts.disableWorkNoteCompatibility ?? vi.fn().mockResolvedValue(undefined);
  const plugin: StubPlugin = {
    app,
    settings,
    saveSettings,
    previewWorkNoteCompatibility,
    acceptWorkNoteCompatibility,
    disableWorkNoteCompatibility,
  };
  const captured: CapturedComp[] = [];
  const restore = patchSetting(captured);
  const tab = new CalendarSettingsTab(
    app,
    plugin as unknown as ConstructorParameters<typeof CalendarSettingsTab>[1],
  );
  // Cards (tag groups / statuses) are collapsed by default; expand them all so
  // their body Settings render and are captured for inspection.
  if (expandCards) {
    const expanded = (tab as unknown as { expandedCards: Set<string> }).expandedCards;
    for (const g of settings.tagGroups) expanded.add(g.id);
    for (const s of settings.projects.statuses) expanded.add(s.id);
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  tab.display();
  restore();
  return { tab, plugin, app, captured };
}

function openSection(tab: CalendarSettingsTab, index: number): HTMLElement {
  const headers = tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header');
  headers[index]!.click();
  return tab.containerEl
    .querySelectorAll<HTMLElement>('.abyss-settings-section')
    [index]!.querySelector('.abyss-settings-section-body')!;
}

/** Find a Setting's root element within a section body by its nameEl text.
 * Searches recursively so Settings nested inside tag-group cards are found. */
function findSettingEl(body: HTMLElement, name: string): HTMLElement | null {
  const allDivs = body.querySelectorAll('div');
  for (const d of allDivs) {
    if (d.textContent === name && d.children.length === 0) {
      // nameEl is child of infoEl; infoEl is child of settingEl.
      // Walk up: nameEl -> infoEl -> settingEl
      return d.parentElement?.parentElement ?? null;
    }
  }
  return null;
}

function findInput(body: HTMLElement, name: string): HTMLInputElement | null {
  const el = findSettingEl(body, name);
  if (!el) return null;
  // TextComponent creates a plain <input> (no type attr); exclude color inputs.
  const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input'));
  return inputs.find((i) => i.type !== 'color') ?? null;
}

function findDropdown(body: HTMLElement, name: string): HTMLSelectElement | null {
  return findSettingEl(body, name)?.querySelector<HTMLSelectElement>('select') ?? null;
}

function findColorInput(body: HTMLElement, name: string): HTMLInputElement | null {
  const el = findSettingEl(body, name);
  if (!el) return null;
  return (
    Array.from(el.querySelectorAll<HTMLInputElement>('input')).find((i) => i.type === 'color') ??
    null
  );
}

function findComp(
  captured: CapturedComp[],
  name: string,
  type: CapturedComp['type'],
): CapturedComp | undefined {
  return captured.find((c) => c.name === name && c.type === type);
}

describe('CalendarSettingsTab renderGeneralSettings', () => {
  it('task prefix input reflects setting and saves on change', () => {
    const { tab, plugin, captured } = makeTab({ taskPrefix: '#task' });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Task prefix');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('#task');
    findComp(captured, 'Task prefix', 'text')!.comp.setValue('#todo');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.taskPrefix).toBe('#todo');
  });

  it('add to today toggle reflects setting and saves on change', () => {
    const { tab, plugin, captured } = makeTab({ addToToday: true });
    openSection(tab, 0);
    // Toggle has no checkbox input in the mock; verify via captured component value
    const toggleComp = findComp(captured, "Add to today's note", 'toggle')!;
    expect(toggleComp.comp.getValue!()).toBe(true);
    toggleComp.comp.setValue(false);
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.addToToday).toBe(false);
  });

  it('custom file path visible when addToToday is false', () => {
    const { tab } = makeTab({ addToToday: false, customFilePath: 'inbox.md' });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Custom file path');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('inbox.md');
  });

  it('custom file path hidden when addToToday is true', () => {
    const { tab } = makeTab({ addToToday: true });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Custom file path');
    expect(input).toBeNull();
  });

  it('custom file path change saves', () => {
    const { tab, plugin, captured } = makeTab({ addToToday: false, customFilePath: 'old.md' });
    openSection(tab, 0);
    findComp(captured, 'Custom file path', 'text')!.comp.setValue('new.md');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.customFilePath).toBe('new.md');
  });
});

describe('CalendarSettingsTab Hotkeys', () => {
  function hotkeysBody(tab: CalendarSettingsTab): HTMLElement {
    return openSection(tab, 7);
  }

  function shortcutInput(body: HTMLElement, action: string): HTMLInputElement {
    return body.querySelector<HTMLInputElement>(`[data-shortcut-action="${action}"]`)!;
  }

  it('persists raw invalid values and announces the row-level issue', () => {
    const { tab, plugin } = makeTab();
    const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');

    input.value = 'Ctrl+Q';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.shortcuts.openQuickCapture).toBe('Ctrl+Q');
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(tab.containerEl.querySelector(`#${describedBy}`)?.textContent).toContain('valid');
    expect(tab.containerEl.querySelector(`#${describedBy}`)?.getAttribute('role')).toBeNull();
    expect(tab.containerEl.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('keeps collapsed Hotkeys inputs out of sequential focus and exposes disclosure state', () => {
    const { tab } = makeTab();
    const section = tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')[7]!;
    const header = section.querySelector<HTMLButtonElement>('.abyss-settings-section-header')!;
    const body = section.querySelector<HTMLElement>('.abyss-settings-section-body')!;

    expect(header.tagName).toBe('BUTTON');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.getAttribute('aria-controls')).toBe(body.id);
    expect(body.hidden).toBe(true);
    expect(body.querySelectorAll('input')).toHaveLength(SHORTCUT_ACTION_IDS.length);

    header.click();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
  });

  it('uses one atomic polite status for settled validation instead of duplicate alerts', () => {
    const { tab } = makeTab();
    const body = hotkeysBody(tab);
    const tasks = shortcutInput(body, 'openTasks');
    const status = body.querySelector<HTMLElement>('.abyss-shortcut-validation-status')!;

    for (const value of ['C', 'Ct', 'Ctr', 'Ctrl', 'Q']) {
      tasks.value = value;
      tasks.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(status.textContent).toBe('');
    tasks.dispatchEvent(new FocusEvent('blur'));

    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.classList).toContain('abyss-sr-only');
    expect(status.textContent).toBe(
      'Q conflicts with Quick capture and is disabled. No alternatives remain active.',
    );
    expect(body.querySelectorAll('[role="alert"]')).toHaveLength(0);

    tasks.value = '';
    tasks.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tasks.getAttribute('aria-invalid')).toBeNull();
    expect(status.textContent).toBe('');
  });

  it('keeps the active input and its caret while conflict feedback updates every affected row', () => {
    const { tab, plugin } = makeTab();
    const body = hotkeysBody(tab);
    const quickCapture = shortcutInput(body, 'openQuickCapture');
    const tasks = shortcutInput(body, 'openTasks');
    document.body.appendChild(tab.containerEl);
    tasks.focus();
    tasks.setSelectionRange(1, 1);

    tasks.value = 'Q';
    tasks.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.shortcuts.openTasks).toBe('Q');
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(tasks);
    expect(tasks.selectionStart).toBe(1);
    expect(tasks.getAttribute('aria-invalid')).toBe('true');
    expect(quickCapture.getAttribute('aria-invalid')).toBe('true');
    expect(tasks.isConnected).toBe(true);
    tab.containerEl.remove();
  });

  it('keeps blank shortcut values as disabled without an issue', () => {
    const { tab, plugin } = makeTab();
    const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.shortcuts.openQuickCapture).toBe('');
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('explains partial conflicts with an accessible row warning', () => {
    const { tab, plugin } = makeTab();
    plugin.settings.shortcuts.openQuickCapture = 'Q | shift 7';
    plugin.settings.shortcuts.openSearch = 'Q | S';
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    tab.display();
    const body = hotkeysBody(tab);
    const quickCapture = shortcutInput(body, 'openQuickCapture');
    const issueId = quickCapture.getAttribute('aria-describedby');
    const issue = body.querySelector<HTMLElement>(`#${issueId}`)!;

    expect(quickCapture.getAttribute('aria-invalid')).toBe('true');
    expect(issue.textContent).toContain(
      'Q conflicts with Search and is disabled. shift 7 remains active.',
    );
    const warning = issue.querySelector<HTMLElement>('.abyss-shortcut-warning-icon')!;
    const status = body.querySelector<HTMLElement>('.abyss-shortcut-validation-status')!;
    expect(warning.getAttribute('aria-hidden')).toBe('true');
    expect(issue.classList).not.toContain('abyss-sr-only');
    expect(declarationsFor('.abyss-shortcut-issue')).toContain('display: flex');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.classList).toContain('abyss-sr-only');
    const screenReaderOnly = declarationsFor('.abyss-sr-only');
    expect(screenReaderOnly).toContain('position: absolute');
    expect(screenReaderOnly).toContain('width: 1px');
    expect(screenReaderOnly).toContain('height: 1px');
    expect(screenReaderOnly).toContain('margin: -1px');
    expect(screenReaderOnly).toContain('clip: rect(0, 0, 0, 0)');
    expect(screenReaderOnly).not.toContain('display: none');
    expect(screenReaderOnly).not.toContain('visibility: hidden');
  });

  it.each([
    ['empty', 'Q | ', 'Alternative 2 is empty and is disabled. Q remains active.'],
    ['invalid', 'Q | nope', 'nope is invalid and is disabled. Q remains active.'],
    ['duplicate', 'Q | q', 'q duplicates Q and is disabled. Q remains active.'],
    [
      'duplicate plus conflict',
      'Q | q | shift 7',
      'q duplicates Q and is disabled. Q conflicts with Search and is disabled. shift 7 remains active.',
    ],
    [
      'no remaining alternatives',
      'nope',
      'nope is invalid and is disabled. No alternatives remain active.',
    ],
  ])('formats %s shortcut issues with surviving alternatives', (_name, value, message) => {
    const { tab, plugin } = makeTab();
    plugin.settings.shortcuts.openQuickCapture = value;
    if (_name === 'duplicate plus conflict') plugin.settings.shortcuts.openSearch = 'Q';
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    tab.display();
    const body = hotkeysBody(tab);
    const input = shortcutInput(body, 'openQuickCapture');
    const issue = body.querySelector<HTMLElement>(`#${input.getAttribute('aria-describedby')}`)!;

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(issue.textContent).toContain(message);
  });

  it('coalesces rapid hotkey saves so out-of-order persistence cannot regress the final value', async () => {
    let settings: CalendarSettings | undefined;
    const persisted: string[] = [];
    const saves: Array<{ value: string; completion: ReturnType<typeof deferred<void>> }> = [];
    const saveSettings = vi.fn(() => {
      const completion = deferred<void>();
      const value = settings!.shortcuts.openQuickCapture;
      saves.push({ value, completion });
      void completion.promise.then(() => persisted.push(value));
      return completion.promise;
    });
    const { tab, plugin } = makeTab({}, { saveSettings });
    settings = plugin.settings;
    const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');
    document.body.appendChild(tab.containerEl);
    input.focus();

    for (const value of ['Q', 'W', 'E']) {
      input.value = value;
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    expect(saveSettings).toHaveBeenCalledOnce();
    expect(saves.map((save) => save.value)).toEqual(['Q']);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);

    saves[0]!.completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(saves.map((save) => save.value)).toEqual(['Q', 'E']);
    saves[1]!.completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(persisted).toEqual(['Q', 'E']);
    expect(plugin.settings.shortcuts.openQuickCapture).toBe('E');
    tab.containerEl.remove();
  });

  it('contains a failed hotkey save after the tab is hidden', async () => {
    let rejectSave!: (reason: Error) => void;
    const saveSettings = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { tab } = makeTab({}, { saveSettings });
      const input = shortcutInput(hotkeysBody(tab), 'openQuickCapture');

      input.value = 'W';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      tab.hide();
      rejectSave(new Error('storage failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('retains a failed save and exposes a retry that clears the unsaved state on success', async () => {
    let rejectFirst!: (reason: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const saveSettings = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { tab } = makeTab({}, { saveSettings });
      const body = hotkeysBody(tab);
      const input = shortcutInput(body, 'openQuickCapture');
      input.value = 'Q | shift 7';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      rejectFirst(new Error('storage failed'));
      await Promise.resolve();
      await Promise.resolve();

      const status = body.querySelector<HTMLElement>('.abyss-shortcut-save-status')!;
      const retry = body.querySelector<HTMLButtonElement>('.abyss-shortcut-save-retry')!;
      expect(status.textContent).toContain('not saved');
      expect(retry.hidden).toBe(false);
      expect(input.value).toBe('Q | shift 7');

      retry.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(saveSettings).toHaveBeenCalledTimes(2);
      expect(status.textContent).toBe('');
      expect(retry.hidden).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe('CalendarSettingsTab renderTagGroupSettings', () => {
  it('inbox source dropdown has tag/untagged options', () => {
    const { tab } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    const body = openSection(tab, 3);
    const dd = findDropdown(body, 'Inbox source');
    expect(dd).not.toBeNull();
    const options = Array.from(dd!.options).map((o) => o.value);
    expect(options).toContain('tag');
    expect(options).toContain('untagged');
  });

  it('inbox source switch to tag saves and re-renders', () => {
    const { tab, plugin, captured } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    openSection(tab, 3);
    findComp(captured, 'Inbox source', 'dropdown')!.comp.setValue('tag');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.inbox.mode).toBe('tag');
  });

  it('inbox tag field visible when inboxMode is tag', () => {
    const { tab } = makeTab({
      inbox: { mode: 'tag', tag: '#inbox', removeTagOnAssign: true },
    });
    const body = openSection(tab, 3);
    const input = findInput(body, 'Inbox tag');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('#inbox');
  });

  it('inbox tag field hidden when inboxMode is untagged', () => {
    const { tab } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    const body = openSection(tab, 3);
    const input = findInput(body, 'Inbox tag');
    expect(input).toBeNull();
  });

  it('inbox tag change saves (trimmed)', () => {
    const { tab, plugin, captured } = makeTab({
      inbox: { mode: 'tag', tag: '#old', removeTagOnAssign: true },
    });
    openSection(tab, 3);
    findComp(captured, 'Inbox tag', 'text')!.comp.setValue('  #new  ');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.inbox.tag).toBe('#new');
  });

  it('add group button appends new group with timestamp id', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [] });
    openSection(tab, 4);
    // Add group button is the only button with empty name (no setName called)
    const addBtn = captured.find((c) => c.type === 'button' && c.name === '');
    expect(addBtn).toBeDefined();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T10:00:00Z'));
    addBtn!.comp.clickHandler!();
    vi.useRealTimers();
    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(plugin.settings.tagGroups[0]!.id).toMatch(/^group-\d+$/);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

describe('CalendarSettingsTab renderTagGroupCard', () => {
  const baseGroup = { id: 'g1', name: 'Work', mode: 'prefix' as const, prefix: 'work' };

  it('group name input saves on change', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup }] });
    openSection(tab, 4);
    findComp(captured, 'Group name', 'text')!.comp.setValue('Personal');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups[0]!.name).toBe('Personal');
  });

  it('mode dropdown has prefix/manual options', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup }] });
    const body = openSection(tab, 4);
    const dd = findDropdown(body, 'Mode');
    expect(dd).not.toBeNull();
    const options = Array.from(dd!.options).map((o) => o.value);
    expect(options).toEqual(['prefix', 'manual']);
  });

  it('prefix mode shows Prefix input', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup, mode: 'prefix', prefix: 'work' }] });
    const body = openSection(tab, 4);
    expect(findInput(body, 'Prefix')).not.toBeNull();
    expect(findInput(body, 'Tags')).toBeNull();
  });

  it('manual mode shows Tags input', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup, mode: 'manual', tags: ['#a', '#b'] }] });
    const body = openSection(tab, 4);
    expect(findInput(body, 'Tags')).not.toBeNull();
    expect(findInput(body, 'Prefix')).toBeNull();
  });

  it('prefix input change saves (trimmed)', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup, prefix: '' }] });
    openSection(tab, 4);
    findComp(captured, 'Prefix', 'text')!.comp.setValue('  work  ');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups[0]!.prefix).toBe('work');
  });

  it('tags CSV input parses to array (split, trim, filter empty)', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup, mode: 'manual', tags: [] }],
    });
    openSection(tab, 4);
    findComp(captured, 'Tags', 'text')!.comp.setValue('a, b, c');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups[0]!.tags).toEqual(['a', 'b', 'c']);
  });

  it('tags CSV input filters out empty values', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup, mode: 'manual', tags: [] }],
    });
    openSection(tab, 4);
    findComp(captured, 'Tags', 'text')!.comp.setValue('a,, ,b');
    expect(plugin.settings.tagGroups[0]!.tags).toEqual(['a', 'b']);
  });

  it('color picker saves on change', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup, color: '#ff0000' }] });
    const body = openSection(tab, 4);
    const colorInput = findColorInput(body, 'Color');
    expect(colorInput).not.toBeNull();
    findComp(captured, 'Color', 'color')!.comp.setValue('#00ff00');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups[0]!.color).toBe('#00ff00');
  });

  it('delete button splices group and saves', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup }, { ...baseGroup, id: 'g2', name: 'Other' }],
    });
    const body = openSection(tab, 4);
    const cards = body.querySelectorAll('.abyss-settings-card');
    expect(cards).toHaveLength(2);
    // Each card has its own "Delete group" warning button.
    const delBtns = captured.filter((c) => {
      if (c.type !== 'button') return false;
      const el = (c.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return el?.textContent === 'Delete group';
    });
    expect(delBtns).toHaveLength(2);
    delBtns[0]!.comp.clickHandler!();
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(plugin.settings.tagGroups[0]!.id).toBe('g2');
  });
});

describe('CalendarSettingsTab renderViewConfigSettings', () => {
  it('default view dropdown has month/week/list', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 1); // Desktop
    const dd = findDropdown(body, 'Default view');
    expect(dd).not.toBeNull();
    const options = Array.from(dd!.options).map((o) => o.value);
    expect(options).toEqual(['month', 'week', 'list']);
  });

  it('default view change saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    findComp(captured, 'Default view', 'dropdown')!.comp.setValue('week');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.defaultView).toBe('week');
  });

  it('does not render a legacy "Default style" dropdown (desktop)', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 1);
    expect(findDropdown(body, 'Default style')).toBeNull();
  });

  it('first day of week dropdown parses int on change', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    findComp(captured, 'First day of week', 'dropdown')!.comp.setValue('1');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.firstDayOfWeek).toBe(1);
  });

  it('daily note folder input saves (manual provider)', () => {
    const { tab, plugin, captured } = makeTab({ dailyNoteProvider: 'manual' });
    openSection(tab, 1);
    findComp(captured, 'Daily note folder', 'text')!.comp.setValue('notes/daily');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.dailyNoteFolder).toBe('notes/daily');
  });

  it('daily note format input saves (manual provider)', () => {
    const { tab, plugin, captured } = makeTab({ dailyNoteProvider: 'manual' });
    openSection(tab, 1);
    findComp(captured, 'Daily note format', 'text')!.comp.setValue('DD-MM-YYYY');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.dailyNoteFormat).toBe('DD-MM-YYYY');
  });

  it('daily note folder and format hidden when addToToday is true and provider is auto', () => {
    const { tab } = makeTab({ addToToday: true, dailyNoteProvider: 'auto' });
    const body = openSection(tab, 1);
    expect(findInput(body, 'Daily note folder')).toBeNull();
    expect(findInput(body, 'Daily note format')).toBeNull();
  });

  it('global task filter input saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    findComp(captured, 'Global task filter', 'text')!.comp.setValue('#task');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.globalTaskFilter).toBe('#task');
  });

  it('upcoming days valid number saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    findComp(captured, 'Upcoming days', 'text')!.comp.setValue('14');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(14);
  });

  it('upcoming days NaN input does not save (CURRENT BEHAVIOR)', () => {
    const { tab, plugin, captured } = makeTab({
      desktop: { ...DEFAULT_SETTINGS.desktop, upcomingDays: 7 },
    });
    openSection(tab, 1);
    findComp(captured, 'Upcoming days', 'text')!.comp.setValue('abc');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(7); // unchanged
  });

  it('upcoming days negative input does not save (CURRENT BEHAVIOR)', () => {
    const { tab, plugin, captured } = makeTab({
      desktop: { ...DEFAULT_SETTINGS.desktop, upcomingDays: 7 },
    });
    openSection(tab, 1);
    findComp(captured, 'Upcoming days', 'text')!.comp.setValue('-5');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(7); // unchanged
  });

  it('upcoming days zero does not save (CURRENT BEHAVIOR, n > 0 required)', () => {
    const { tab, plugin, captured } = makeTab({
      desktop: { ...DEFAULT_SETTINGS.desktop, upcomingDays: 7 },
    });
    openSection(tab, 1);
    findComp(captured, 'Upcoming days', 'text')!.comp.setValue('0');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(7);
  });

  it('mobile section has same view config settings, and no "Default style" dropdown', () => {
    const { tab } = makeTab({ dailyNoteProvider: 'manual' });
    const body = openSection(tab, 2); // Mobile
    expect(findDropdown(body, 'Default view')).not.toBeNull();
    expect(findDropdown(body, 'Default style')).toBeNull();
    expect(findInput(body, 'Daily note folder')).not.toBeNull();
  });
});

describe('sourceNoteDisplay setting', () => {
  it('renders a source-note-display dropdown in the General section', () => {
    const { tab } = makeTab();
    // Open the General section (index 0) to make its body visible
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    headers[0]!.click();
    const selects = tab.containerEl.querySelectorAll<HTMLSelectElement>('select');
    const values = Array.from(selects).map((s) => s.value);
    expect(values).toContain('non-default');
  });

  it('dropdown has three options: never, always, non-default', () => {
    const { tab } = makeTab();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    headers[0]!.click();
    const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    const sourceSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'non-default'),
    );
    expect(sourceSelect).not.toBeUndefined();
    const optionValues = Array.from(sourceSelect!.options).map((o) => o.value);
    expect(optionValues).toContain('never');
    expect(optionValues).toContain('always');
    expect(optionValues).toContain('non-default');
  });

  it('dropdown reflects current settings value', () => {
    const { tab, plugin } = makeTab();
    plugin.settings.sourceNoteDisplay = 'always';
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    tab.display();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    headers[0]!.click();
    const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    const sourceSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'non-default'),
    );
    expect(sourceSelect?.value).toBe('always');
  });
});

describe('CalendarSettingsTab collapsible cards + default status', () => {
  it('renders an aggregate-only disabled Work Note preview without saving or mutation controls', async () => {
    const previewWorkNoteCompatibility = vi.fn().mockResolvedValue({
      preset: { enabled: false, accepted: false },
      notes: { scanned: 37, eligible: 12, excluded: 3 },
      kinds: { ordinary: 10, milestone: 2, ambiguous: 1, missing: 2 },
      statuses: { mapped: 9, unknown: 2, missing: 1, nonScalar: 0 },
      links: {
        brokenProject: 1,
        ambiguousProject: 1,
        brokenRelation: 2,
        ambiguousRelation: 0,
        invalidProjectEntry: 0,
        invalidRelationEntry: 1,
      },
      cardinality: { missingProject: 1, multipleProjects: 1, multipleMilestones: 0 },
      duplicateBasenames: { project: 1, relation: 0 },
      diagnostics: { 'broken-project': 1, 'unknown-status': 2 },
      capabilities: { update: false, create: false },
    });
    const { tab, plugin, captured } = makeTab({}, { previewWorkNoteCompatibility });
    const before = structuredClone(plugin.settings.projects.workNoteCompatibility);
    const body = openSection(tab, 5);
    const previewButton = Array.from(body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Preview work notes',
    );

    expect(previewButton).toBeDefined();
    const previewComponent = captured.find((entry) => {
      if (entry.type !== 'button') return false;
      const element = (entry.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return element?.textContent === 'Preview work notes';
    });
    previewComponent!.comp.clickHandler!();
    await vi.waitFor(() => expect(previewWorkNoteCompatibility).toHaveBeenCalledOnce());

    const result = body.querySelector<HTMLElement>('.abyss-work-note-preview');
    expect(result?.textContent).toContain('12 eligible');
    expect(result?.textContent).toContain('3 excluded');
    expect(result?.textContent).toContain('10 ordinary');
    expect(result?.textContent).toContain('2 milestones');
    expect(result?.textContent).toContain('2 unknown statuses');
    expect(result?.textContent).toContain('1 duplicate project basename');
    expect(result?.dataset['presetEnabled']).toBe('false');
    expect(result?.dataset['accepted']).toBe('false');
    expect(result?.dataset['capabilityUpdate']).toBe('false');
    expect(result?.dataset['capabilityCreate']).toBe('false');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.projects.workNoteCompatibility).toEqual(before);
    for (const mutationLabel of [
      'Accept',
      'Enable',
      'Create Work Note',
      'Set status',
      'Set date',
      'Set relation',
    ]) {
      expect(
        Array.from(body.querySelectorAll('button')).some(
          (button) => button.textContent === mutationLabel,
        ),
      ).toBe(false);
    }
  });

  it('offers one explicit audited enable action and reports accepted capabilities', async () => {
    const preview = {
      acceptanceToken: 'work-note-preview-test',
      preset: { enabled: false, accepted: false },
      notes: { scanned: 12, eligible: 10, excluded: 2 },
      kinds: { ordinary: 9, milestone: 1, ambiguous: 0, missing: 0 },
      statuses: { mapped: 10, unknown: 0, missing: 0, nonScalar: 0 },
      links: {
        brokenProject: 0,
        ambiguousProject: 0,
        brokenRelation: 0,
        ambiguousRelation: 0,
        invalidProjectEntry: 0,
        invalidRelationEntry: 0,
      },
      cardinality: { missingProject: 0, multipleProjects: 0, multipleMilestones: 0 },
      duplicateBasenames: { project: 0, relation: 0 },
      diagnostics: {},
      capabilities: { update: false, create: false },
    } as const;
    const accepted = {
      ...preview,
      preset: { enabled: true, accepted: true },
      capabilities: { update: true, create: true },
    } as const;
    const previewWorkNoteCompatibility = vi.fn().mockResolvedValue(preview);
    const acceptWorkNoteCompatibility = vi
      .fn()
      .mockResolvedValue({ type: 'ok', preset: {}, preview: accepted });
    const { tab, captured } = makeTab(
      {},
      { previewWorkNoteCompatibility, acceptWorkNoteCompatibility },
    );
    const body = openSection(tab, 5);
    const previewComponent = captured.find((entry) => {
      if (entry.type !== 'button') return false;
      const element = (entry.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return element?.textContent === 'Preview work notes';
    });
    previewComponent!.comp.clickHandler!();
    await vi.waitFor(() => expect(previewWorkNoteCompatibility).toHaveBeenCalledOnce());

    const enable = body.querySelector<HTMLButtonElement>('[data-work-note-accept]')!;
    expect(enable.textContent).toBe('Enable audited work notes');
    enable.click();
    await vi.waitFor(() =>
      expect(acceptWorkNoteCompatibility).toHaveBeenCalledWith('work-note-preview-test'),
    );
    expect(body.querySelector('.abyss-work-note-preview')?.textContent).toContain(
      'Updates and creation enabled',
    );
    expect(body.querySelectorAll('[data-work-note-capability]')).toHaveLength(2);
  });

  it('statuses render as collapsed cards (title only) by default', () => {
    const { tab } = makeTab({}, { expand: false });
    const body = openSection(tab, 5); // Projects
    const cards = body.querySelectorAll('.abyss-settings-card');
    expect(cards.length).toBe(DEFAULT_SETTINGS.projects.statuses.length);
    // Collapsed: title shown, no expanded body.
    expect(cards[0]!.querySelector('.abyss-settings-card-title')?.textContent).toBe('Active');
    expect(cards[0]!.querySelector('.abyss-settings-card-body')).toBeNull();
  });

  it('clicking a card header expands it to reveal the body', () => {
    const { tab } = makeTab({}, { expand: false });
    const body = openSection(tab, 5);
    (body.querySelector('.abyss-settings-card .abyss-settings-card-header') as HTMLElement).click();
    const bodyAgain = tab.containerEl
      .querySelectorAll<HTMLElement>('.abyss-settings-section')[5]!
      .querySelector('.abyss-settings-section-body')!;
    expect(
      bodyAgain.querySelector('.abyss-settings-card.is-open .abyss-settings-card-body'),
    ).toBeTruthy();
  });

  it('a single Default status dropdown lists all statuses and sets defaultStatusId', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const dd = captured.find((c) => c.name === 'Default status' && c.type === 'dropdown');
    expect(dd).toBeTruthy();
    const plannedId = plugin.settings.projects.statuses[1]!.id;
    dd!.comp.setValue(plannedId);
    expect(plugin.settings.projects.defaultStatusId).toBe(plannedId);
    // No per-status "Default for new projects" toggle remains.
    expect(captured.some((c) => c.name === 'Default for new projects')).toBe(false);
  });

  it('deleting the default status repoints defaultStatusId to the first remaining', () => {
    const { tab, plugin, captured } = makeTab();
    // Make the first status the default, then delete it.
    plugin.settings.projects.defaultStatusId = plugin.settings.projects.statuses[0]!.id;
    openSection(tab, 5);
    const delBtns = captured.filter((c) => {
      if (c.type !== 'button') return false;
      const el = (c.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return el?.textContent === 'Delete status';
    });
    const survivorId = plugin.settings.projects.statuses[1]!.id;
    delBtns[0]!.comp.clickHandler!();
    expect(plugin.settings.projects.defaultStatusId).toBe(survivorId);
  });

  it('gives a newly added project status stable regular lifecycle behavior', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const addStatus = captured.find((entry) => {
      if (entry.type !== 'button') return false;
      const element = (entry.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return element?.textContent === '+ Add status';
    });

    addStatus!.comp.clickHandler!();

    expect(
      plugin.settings.projects.statuses[plugin.settings.projects.statuses.length - 1]?.behavior,
    ).toBe('regular');
  });
});

describe('CalendarSettingsTab card badges (manual/prefix, property/tag)', () => {
  it('tag-group card headers show a mode badge distinguishing manual vs prefix', () => {
    const { tab } = makeTab({
      tagGroups: [
        { id: 'p', name: 'Pre', mode: 'prefix', prefix: 'work' },
        { id: 'm', name: 'Man', mode: 'manual', tags: ['#x'] },
      ],
    });
    const body = openSection(tab, 4);
    const badges = Array.from(body.querySelectorAll('.abyss-settings-card-badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toContain('prefix');
    expect(badges).toContain('manual');
  });

  it('status card headers show a property/tag badge', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 5);
    const badges = Array.from(body.querySelectorAll('.abyss-settings-card-badge')).map(
      (b) => b.textContent,
    );
    // Default statuses are all property-defined.
    expect(badges.every((b) => b === 'property')).toBe(true);
    expect(badges.length).toBeGreaterThan(0);
  });
});
