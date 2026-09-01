import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, Setting } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProjectsList } from '../src/panels/projects/ProjectsListView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import type {
  WorkNoteCompatibilityDisableResult,
  WorkNoteCompatibilityPreset,
  WorkNoteCompatibilityValidationResult,
  WorkNoteValidatedApplyResult,
} from '../src/projects/work-notes/types';
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
  validateWorkNoteCompatibility: ReturnType<typeof vi.fn>;
  applyValidatedWorkNoteCompatibility: ReturnType<typeof vi.fn>;
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
    validateWorkNoteCompatibility?: StubPlugin['validateWorkNoteCompatibility'];
    applyValidatedWorkNoteCompatibility?: StubPlugin['applyValidatedWorkNoteCompatibility'];
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
  const validateWorkNoteCompatibility =
    opts.validateWorkNoteCompatibility ?? vi.fn().mockResolvedValue(undefined);
  const applyValidatedWorkNoteCompatibility =
    opts.applyValidatedWorkNoteCompatibility ?? vi.fn().mockResolvedValue(undefined);
  const disableWorkNoteCompatibility =
    opts.disableWorkNoteCompatibility ?? vi.fn().mockResolvedValue(undefined);
  const plugin: StubPlugin = {
    app,
    settings,
    saveSettings,
    validateWorkNoteCompatibility,
    applyValidatedWorkNoteCompatibility,
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
  const workNotePreset = (
    overrides: Partial<WorkNoteCompatibilityPreset> = {},
  ): WorkNoteCompatibilityPreset => ({
    ...structuredClone(DEFAULT_SETTINGS.projects.workNoteCompatibility),
    revision: 7,
    enabled: false,
    membershipQuery: 'Work Notes/',
    ordinaryKindQuery: '#work-note/task',
    milestoneKindQuery: '#work-note/milestone',
    folder: 'Work Notes',
    fields: {
      ...DEFAULT_SETTINGS.projects.workNoteCompatibility.fields,
      project: 'project',
    },
    rawStatusByStatusId: { 'status-1': 'active' },
    ...overrides,
  });

  const preview = (capabilities = { update: true, create: false }) => ({
    preset: { enabled: true, accepted: false },
    notes: { scanned: 37, eligible: 12, excluded: 25 },
    kinds: { ordinary: 10, milestone: 2, ambiguous: 1, missing: 0 },
    statuses: { mapped: 9, unknown: 2, missing: 1, nonScalar: 0 },
    links: {
      brokenProject: 1,
      ambiguousProject: 0,
      brokenRelation: 0,
      ambiguousRelation: 0,
      invalidProjectEntry: 0,
      invalidRelationEntry: 0,
    },
    cardinality: { missingProject: 0, multipleProjects: 0, multipleMilestones: 0 },
    duplicateBasenames: { project: 0, relation: 0 },
    diagnostics: { 'ambiguous-kind': 1, 'unknown-status': 2 },
    capabilities,
  });

  const audited = (
    token: object = {},
    capabilities = { update: true, create: true },
  ): WorkNoteCompatibilityValidationResult => ({
    type: 'audited',
    token: token as Extract<WorkNoteCompatibilityValidationResult, { type: 'audited' }>['token'],
    presetFingerprint: 'work-note-preset:test',
    preview: preview(capabilities),
  });

  const projectBody = (tab: CalendarSettingsTab): HTMLElement =>
    tab.containerEl
      .querySelectorAll<HTMLElement>('.abyss-settings-section')[5]!
      .querySelector<HTMLElement>('.abyss-settings-section-body')!;

  const workNoteSetup = (body: HTMLElement): HTMLElement =>
    body.matches('.abyss-work-note-setup')
      ? body
      : body.querySelector<HTMLElement>('.abyss-work-note-setup')!;

  const button = (body: HTMLElement, label: string): HTMLButtonElement | undefined =>
    Array.from(body.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  it('keeps ordinary Project settings compact and moves technical audit data into one collapsed Diagnostics disclosure', () => {
    const { tab } = makeTab({
      projects: {
        ...structuredClone(DEFAULT_SETTINGS.projects),
        workNoteCompatibility: workNotePreset({ enabled: true }),
      },
    });
    const body = openSection(tab, 5);
    const setup = workNoteSetup(body);

    expect(button(setup, 'Validate')).toBeUndefined();
    expect(button(setup, 'Apply configuration')).toBeUndefined();
    expect(setup.textContent).not.toContain('matched');
    expect(setup.textContent).not.toContain('excluded');
    expect(setup.textContent).not.toContain('Workspace default');
    expect(setup.querySelectorAll('.abyss-work-note-diagnostics')).toHaveLength(1);
    const diagnostics = setup.querySelector<HTMLDetailsElement>('.abyss-work-note-diagnostics')!;
    expect(diagnostics.tagName).toBe('DETAILS');
    expect(diagnostics.open).toBe(false);
    expect(diagnostics.querySelector('summary')?.textContent).toBe('Diagnostics');
    expect(button(diagnostics, 'Copy diagnostics')).toBeDefined();
    expect(setup.querySelector('[data-work-note-creation]')).not.toBeNull();
  });

  it('keeps the ordinary Projects allow-list and puts Table defaults in one collapsed disclosure', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 5);

    expect(findSettingEl(body, 'Membership query')).not.toBeNull();
    expect(findSettingEl(body, 'Create folder')).not.toBeNull();
    expect(findSettingEl(body, 'Template path')).not.toBeNull();
    expect(findSettingEl(body, 'Project view')).not.toBeNull();
    expect(findSettingEl(body, 'Task insert position')).toBeNull();
    expect(findSettingEl(body, 'Task section heading')).toBeNull();
    const table = body.querySelector<HTMLDetailsElement>('[data-project-table-settings]')!;
    expect(table.tagName).toBe('DETAILS');
    expect(table.open).toBe(false);
    expect(table.querySelector('summary')?.textContent).toBe('Table fields');
    expect(table.textContent).toContain('Project table');
    expect(table.textContent).toContain('Task table');
  });

  it('persists sequential Project table field toggles cumulatively', async () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const projectFieldIndex = captured.findIndex(
      ({ type, name }) => type === 'toggle' && name === 'Project',
    );
    const projectField = captured[projectFieldIndex]!;
    const statusField = captured
      .slice(projectFieldIndex + 1)
      .find(({ type, name }) => type === 'toggle' && name === 'Status')!;

    projectField.comp.setValue(false);
    statusField.comp.setValue(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      plugin.settings.projects.view.table.columns.find(({ propertyId }) => propertyId === 'project')
        ?.visible,
    ).toBe(false);
    expect(
      plugin.settings.projects.view.table.columns.find(({ propertyId }) => propertyId === 'status')
        ?.visible,
    ).toBe(false);
  });

  it('debounces validation and automatically applies the exact audited Work Note draft', async () => {
    vi.useFakeTimers();
    try {
      const token = {};
      const candidate = workNotePreset({ enabled: true, membershipQuery: '#work-note' });
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited(token));
      const applyValidatedWorkNoteCompatibility = vi.fn().mockResolvedValue({
        type: 'applied',
        preset: candidate,
        preview: preview(),
      } satisfies WorkNoteValidatedApplyResult);
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      const setup = workNoteSetup(openSection(tab, 5));
      const membership = findInput(setup, 'Membership query')!;
      membership.value = '#work-note';
      membership.dispatchEvent(new Event('input', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(249);
      expect(validateWorkNoteCompatibility).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledOnce());

      expect(validateWorkNoteCompatibility).toHaveBeenCalledOnce();
      expect(validateWorkNoteCompatibility).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, membershipQuery: '#work-note' }),
      );
      expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledWith(token);
      expect(projectBody(tab).textContent).not.toContain('Validate');
      expect(projectBody(tab).textContent).not.toContain('Apply configuration');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a cancelled Work Note debounce when an open Projects section is rendered again', async () => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue({
        type: 'invalid-draft',
        reason: 'syntax-invalid',
        diagnostics: [],
      } satisfies WorkNoteCompatibilityValidationResult);
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility },
      );
      let setup = workNoteSetup(openSection(tab, 5));
      const membership = findInput(setup, 'Membership query')!;
      membership.value = '#work-note/reopened';
      membership.dispatchEvent(new Event('input', { bubbles: true }));
      tab.hide();

      // eslint-disable-next-line @typescript-eslint/no-deprecated
      tab.display();
      setup = workNoteSetup(projectBody(tab));
      expect(findInput(setup, 'Membership query')?.value).toBe('#work-note/reopened');
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows debounced query and property errors beside the responsible field without stealing focus', async () => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue({
        type: 'invalid-draft',
        reason: 'syntax-invalid',
        diagnostics: [{ source: 'membershipQuery', code: 'expected-term', offset: 9 }],
      } satisfies WorkNoteCompatibilityValidationResult);
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility },
      );
      document.body.appendChild(tab.containerEl);
      let setup = workNoteSetup(openSection(tab, 5));
      const membership = findInput(setup, 'Membership query')!;
      membership.focus();
      membership.value = '#tag AND )';
      membership.setSelectionRange(10, 10);
      membership.dispatchEvent(new Event('input', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() =>
        expect(projectBody(tab).querySelector('[data-work-note-query-error]')).not.toBeNull(),
      );
      setup = workNoteSetup(projectBody(tab));
      const currentMembership = findInput(setup, 'Membership query')!;
      expect(currentMembership.getAttribute('aria-invalid')).toBe('true');
      expect(findSettingEl(setup, 'Membership query')?.textContent).toContain(
        'Expected a query term',
      );
      expect(document.activeElement).toBe(currentMembership);

      const relation = findInput(setup, 'Project relation property')!;
      relation.focus();
      relation.value = '   ';
      relation.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      setup = workNoteSetup(projectBody(tab));
      const currentRelation = findInput(setup, 'Project relation property')!;
      expect(currentRelation.getAttribute('aria-invalid')).toBe('true');
      expect(findSettingEl(setup, 'Project relation property')?.textContent).toContain(
        'Enter a property name',
      );
      expect(document.activeElement).toBe(currentRelation);
      tab.containerEl.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves creation input and select focus across background validation and save rerenders', async () => {
    vi.useFakeTimers();
    try {
      const initial = workNotePreset({
        enabled: true,
        creation: {
          folder: 'Work Notes',
          templatePath: '',
          defaultKind: 'ordinary',
          defaultStatusId: 'status-1',
          kindMarkers: {
            ordinary: { kind: 'frontmatter-tag', value: '#work-note/task' },
            milestone: { kind: 'frontmatter-tag', value: '#work-note/milestone' },
          },
        },
      });
      const folderPreset = {
        ...initial,
        creation: { ...initial.creation!, folder: 'Tasks/Research' },
      };
      const kindPreset = {
        ...folderPreset,
        creation: { ...folderPreset.creation!, defaultKind: 'milestone' as const },
      };
      const validateWorkNoteCompatibility = vi
        .fn()
        .mockResolvedValueOnce(audited({ id: 1 }, { update: true, create: true }))
        .mockResolvedValueOnce(audited({ id: 2 }, { update: true, create: true }));
      const applyValidatedWorkNoteCompatibility = vi
        .fn()
        .mockResolvedValueOnce({ type: 'applied', preset: folderPreset, preview: preview() })
        .mockResolvedValueOnce({ type: 'applied', preset: kindPreset, preview: preview() });
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: initial,
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      document.body.appendChild(tab.containerEl);
      let setup = workNoteSetup(openSection(tab, 5));
      const folder = findInput(setup, 'Creation folder')!;
      folder.focus();
      folder.value = 'Tasks/Research';
      folder.setSelectionRange(14, 14);
      folder.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(projectBody(tab).textContent).toContain('Saved automatically.'),
      );

      setup = workNoteSetup(projectBody(tab));
      const currentFolder = findInput(setup, 'Creation folder')!;
      expect(document.activeElement).toBe(currentFolder);
      expect(currentFolder.selectionStart).toBe(14);

      const kind = findDropdown(setup, 'Default kind')!;
      kind.focus();
      kind.value = 'milestone';
      const pendingState = (
        tab as unknown as {
          workNoteSetupState: {
            draft: WorkNoteCompatibilityPreset;
          };
        }
      ).workNoteSetupState;
      (
        tab as unknown as {
          replaceWorkNoteDraft: (
            container: HTMLElement,
            draft: WorkNoteCompatibilityPreset,
            rerender: boolean,
          ) => void;
        }
      ).replaceWorkNoteDraft(
        setup,
        {
          ...pendingState.draft,
          creation: { ...pendingState.draft.creation!, defaultKind: 'milestone' },
        },
        false,
      );
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      expect(document.activeElement).toBe(
        findDropdown(workNoteSetup(projectBody(tab)), 'Default kind'),
      );
      tab.containerEl.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps unsafe creation configuration unsaved and reports the responsible field inline', async () => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi
        .fn()
        .mockResolvedValue(audited({}, { update: true, create: false }));
      const applyValidatedWorkNoteCompatibility = vi.fn();
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({
              enabled: true,
              creation: {
                folder: 'Work Notes',
                templatePath: '',
                defaultKind: 'ordinary',
                defaultStatusId: 'status-1',
                kindMarkers: {
                  ordinary: { kind: 'frontmatter-tag', value: '#work-note/task' },
                  milestone: { kind: 'frontmatter-tag', value: '#work-note/milestone' },
                },
              },
            }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      let setup = workNoteSetup(openSection(tab, 5));
      const template = findInput(setup, 'Template path')!;
      template.value = 'Templates/Missing.md';
      template.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() =>
        expect(projectBody(tab).querySelector('[data-work-note-property-error]')).not.toBeNull(),
      );

      setup = workNoteSetup(projectBody(tab));
      expect(findInput(setup, 'Template path')?.getAttribute('aria-invalid')).toBe('true');
      expect(findSettingEl(setup, 'Template path')?.textContent).toContain(
        'Template is unavailable or conflicts with owned fields',
      );
      expect(applyValidatedWorkNoteCompatibility).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Work Note edits in a section-local draft across collapse and rerender', () => {
    const applied = workNotePreset();
    const { tab, plugin } = makeTab({
      projects: {
        ...structuredClone(DEFAULT_SETTINGS.projects),
        workNoteCompatibility: applied,
      },
    });
    let body = openSection(tab, 5);
    button(workNoteSetup(body), 'Re-enable')!.click();
    body = workNoteSetup(projectBody(tab));
    const membership = findInput(body, 'Membership query')!;
    membership.value = '#work-note AND "Research Notes/"';
    membership.dispatchEvent(new Event('input', { bubbles: true }));

    expect(plugin.settings.projects.workNoteCompatibility).toEqual(applied);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    tab.containerEl
      .querySelectorAll<HTMLButtonElement>('.abyss-settings-section-header')[5]!
      .click();
    tab.containerEl
      .querySelectorAll<HTMLButtonElement>('.abyss-settings-section-header')[5]!
      .click();
    expect(findInput(workNoteSetup(projectBody(tab)), 'Membership query')?.value).toBe(
      '#work-note AND "Research Notes/"',
    );

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    tab.display();
    expect(findInput(workNoteSetup(projectBody(tab)), 'Membership query')?.value).toBe(
      '#work-note AND "Research Notes/"',
    );
    expect(plugin.settings.projects.workNoteCompatibility).toEqual(applied);
    expect(button(workNoteSetup(projectBody(tab)), 'Validate')).toBeUndefined();
  });

  it('documents the complete membership language without a compatibility prose wall', () => {
    const { tab } = makeTab({
      projects: {
        ...structuredClone(DEFAULT_SETTINGS.projects),
        workNoteCompatibility: workNotePreset({ enabled: true }),
      },
    });
    const body = openSection(tab, 5);
    const setup = body.querySelector<HTMLElement>('.abyss-work-note-setup')!;

    expect(setup.textContent).toContain('folder');
    expect(setup.textContent).toContain('#tag');
    expect(setup.textContent).toContain('key=value');
    expect(setup.textContent).toContain('AND | OR | NOT');
    expect(setup.textContent).toContain('parentheses');
    expect(setup.textContent).toContain('quotes');
    expect(setup.textContent).toContain('escaping');
    expect(setup.textContent).not.toContain('compatibility');
    expect(setup.textContent).not.toContain('Preview work notes');
    expect(body.querySelector('.abyss-work-note-preview')).toBeNull();
  });

  it('preserves the active field and ignores stale background validation responses', async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<WorkNoteCompatibilityValidationResult>();
      const second = deferred<WorkNoteCompatibilityValidationResult>();
      const validateWorkNoteCompatibility = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const applyValidatedWorkNoteCompatibility = vi.fn();
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      document.body.appendChild(tab.containerEl);
      openSection(tab, 5);
      await vi.advanceTimersByTimeAsync(250);

      const membership = findInput(workNoteSetup(projectBody(tab)), 'Membership query')!;
      membership.focus();
      membership.value = '#tag AND )';
      membership.setSelectionRange(10, 10);
      membership.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      second.resolve({
        type: 'invalid-draft',
        reason: 'syntax-invalid',
        diagnostics: [{ source: 'membershipQuery', code: 'expected-term', offset: 9 }],
      });
      await Promise.resolve();
      await Promise.resolve();

      const body = projectBody(tab);
      expect(body.querySelectorAll('[data-work-note-query-error]')).toHaveLength(1);
      const focusedMembership = findInput(workNoteSetup(body), 'Membership query')!;
      await Promise.resolve();
      expect(document.activeElement).toBe(focusedMembership);
      expect(focusedMembership.selectionStart).toBe(10);

      first.resolve(audited({ stale: true }));
      await Promise.resolve();
      expect(applyValidatedWorkNoteCompatibility).not.toHaveBeenCalled();
      expect(projectBody(tab).textContent).toContain('Expected a query term');
      tab.containerEl.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps audit counts inside Diagnostics while automatically applying the exact token', async () => {
    vi.useFakeTimers();
    try {
      const token = {};
      const validateWorkNoteCompatibility = vi
        .fn()
        .mockResolvedValue(audited(token, { update: true, create: true }));
      const applied = workNotePreset({
        revision: 8,
        enabled: true,
        acceptedAudit: {
          presetFingerprint: 'work-note-preset:accepted',
          acceptedRevision: 8,
          acceptedAt: '2026-08-28T00:00:00.000Z',
          capabilities: { update: true, create: false },
        },
      });
      const applyResult = deferred<WorkNoteValidatedApplyResult>();
      const applyValidatedWorkNoteCompatibility = vi.fn().mockReturnValue(applyResult.promise);
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      openSection(tab, 5);
      expect(projectBody(tab).querySelector('[data-work-note-creation]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledOnce());
      expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledWith(token);

      const diagnostics = projectBody(tab).querySelector<HTMLElement>(
        '.abyss-work-note-diagnostics',
      )!;
      expect(diagnostics.textContent).toContain('"eligible": 12');
      const ordinary = workNoteSetup(projectBody(tab)).cloneNode(true) as HTMLElement;
      ordinary.querySelector('.abyss-work-note-diagnostics')?.remove();
      expect(ordinary.textContent).not.toContain('matched');
      expect(ordinary.textContent).not.toContain('excluded');

      applyResult.resolve({ type: 'applied', preset: applied, preview: preview() });
      await vi.waitFor(() => expect(projectBody(tab).textContent).toContain('Saved automatically'));
      expect(workNoteSetup(projectBody(tab)).dataset['dirty']).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a draft when automatic save fails and retries without an artificial edit', async () => {
    vi.useFakeTimers();
    try {
      const token = {};
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited(token));
      const applied = workNotePreset({ enabled: true, membershipQuery: '#work-note' });
      const applyValidatedWorkNoteCompatibility = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'revalidation-required',
          reason: 'save-failed',
        } satisfies WorkNoteValidatedApplyResult)
        .mockResolvedValueOnce({ type: 'applied', preset: applied, preview: preview() });
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      let body = openSection(tab, 5);
      const membership = findInput(workNoteSetup(body), 'Membership query')!;
      membership.value = '#work-note';
      membership.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(projectBody(tab).textContent).toContain('were not saved'));

      body = projectBody(tab);
      expect(findInput(workNoteSetup(body), 'Membership query')?.value).toBe('#work-note');
      expect(button(body, 'Apply configuration')).toBeUndefined();
      expect(button(body, 'Validate')).toBeUndefined();
      button(body, 'Retry')!.click();
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(projectBody(tab).textContent).toContain('Saved automatically'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically revalidates a bounded race result without requiring an edit', async () => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited());
      const applied = workNotePreset({ enabled: true, membershipQuery: '#work-note' });
      const applyValidatedWorkNoteCompatibility = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'revalidation-required',
          reason: 'audit-inputs-changed',
        } satisfies WorkNoteValidatedApplyResult)
        .mockResolvedValueOnce({ type: 'applied', preset: applied, preview: preview() });
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      const setup = workNoteSetup(openSection(tab, 5));
      const membership = findInput(setup, 'Membership query')!;
      membership.value = '#work-note';
      membership.dispatchEvent(new Event('input', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(applyValidatedWorkNoteCompatibility).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates automatically when the Project relation property changes', async () => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited());
      const applyValidatedWorkNoteCompatibility = vi.fn().mockResolvedValue({
        type: 'revalidation-required',
        reason: 'save-failed',
      } satisfies WorkNoteValidatedApplyResult);
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({
              enabled: true,
              acceptedAudit: {
                presetFingerprint: 'accepted',
                acceptedRevision: 7,
                acceptedAt: '2026-08-28T00:00:00.000Z',
                capabilities: { update: true, create: false },
              },
            }),
          },
        },
        { validateWorkNoteCompatibility, applyValidatedWorkNoteCompatibility },
      );
      const setup = workNoteSetup(openSection(tab, 5));

      const relation = findInput(setup, 'Project relation property')!;
      relation.value = 'belongs_to';
      relation.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledOnce());
      expect(validateWorkNoteCompatibility.mock.calls[0]![0]).toMatchObject({
        fields: { project: 'belongs_to' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables immediately, rolls back failure UI, and re-enables through background validation', async () => {
    const firstDisable = deferred<WorkNoteCompatibilityDisableResult>();
    const disableWorkNoteCompatibility = vi
      .fn()
      .mockReturnValueOnce(firstDisable.promise)
      .mockResolvedValueOnce({ type: 'disabled', preset: workNotePreset() });
    const { tab } = makeTab(
      {
        projects: {
          ...structuredClone(DEFAULT_SETTINGS.projects),
          workNoteCompatibility: workNotePreset({ enabled: true }),
        },
      },
      { disableWorkNoteCompatibility },
    );
    let body = openSection(tab, 5);
    button(body, 'Disable')!.click();
    button(projectBody(tab), 'Disable')?.click();
    expect(disableWorkNoteCompatibility).toHaveBeenCalledOnce();
    firstDisable.resolve({ type: 'save-failed' });
    await vi.waitFor(() => expect(projectBody(tab).textContent).toContain('Could not disable'));
    expect(button(projectBody(tab), 'Disable')).toBeDefined();

    button(projectBody(tab), 'Disable')!.click();
    await vi.waitFor(() => expect(projectBody(tab).textContent).toContain('Work Notes are off'));
    body = projectBody(tab);
    expect(body.textContent?.match(/Work Notes are off/g)).toHaveLength(1);
    expect(button(body, 'Apply configuration')).toBeUndefined();
    button(workNoteSetup(body), 'Re-enable')!.click();
    expect(button(projectBody(tab), 'Re-enable')).toBeUndefined();
    expect(projectBody(tab).textContent).toContain('Checking the preserved setup');
    expect(button(projectBody(tab), 'Validate')).toBeUndefined();
    expect(button(projectBody(tab), 'Apply configuration')).toBeUndefined();
  });

  it.each([
    ['folder-only', 'Work Notes/'],
    ['tag-only', '#work-note'],
    ['folder and tag', 'Work Notes/ AND #work-note'],
  ])('sends the %s Membership draft through the exact validation API', async (_name, query) => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited());
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: workNotePreset({ enabled: true }),
          },
        },
        { validateWorkNoteCompatibility },
      );
      const body = openSection(tab, 5);
      const membership = findInput(workNoteSetup(body), 'Membership query')!;
      membership.value = query;
      membership.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledOnce());
      expect(validateWorkNoteCompatibility.mock.calls[0]![0]).toMatchObject({
        enabled: true,
        membershipQuery: query,
        fields: { project: 'project' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sequential Creation edits in one exact candidate', async () => {
    vi.useFakeTimers();
    try {
      const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited());
      const configured = workNotePreset({
        enabled: true,
        creation: {
          folder: 'Work Notes',
          templatePath: 'Templates/Old.md',
          defaultKind: 'ordinary',
          defaultStatusId: 'status-1',
          kindMarkers: {
            ordinary: { kind: 'frontmatter-tag', value: '#work-note/task' },
            milestone: { kind: 'frontmatter-tag', value: '#work-note/milestone' },
          },
        },
        acceptedAudit: {
          presetFingerprint: 'accepted',
          acceptedRevision: 7,
          acceptedAt: '2026-08-28T00:00:00.000Z',
          capabilities: { update: true, create: true },
        },
      });
      const { tab } = makeTab(
        {
          projects: {
            ...structuredClone(DEFAULT_SETTINGS.projects),
            workNoteCompatibility: configured,
          },
        },
        { validateWorkNoteCompatibility },
      );
      const setup = workNoteSetup(openSection(tab, 5));
      const folder = findInput(setup, 'Creation folder')!;
      folder.value = 'Research/Work Notes';
      folder.dispatchEvent(new Event('input', { bubbles: true }));
      const template = findInput(setup, 'Template path')!;
      template.value = 'Templates/New.md';
      template.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(validateWorkNoteCompatibility).toHaveBeenCalledOnce());

      expect(validateWorkNoteCompatibility.mock.calls[0]![0]).toMatchObject({
        creation: {
          folder: 'Research/Work Notes',
          templatePath: 'Templates/New.md',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Creation available and separates editable fields from collapsed diagnostics', () => {
    const validateWorkNoteCompatibility = vi.fn().mockResolvedValue(audited());
    const { tab } = makeTab(
      {
        projects: {
          ...structuredClone(DEFAULT_SETTINGS.projects),
          workNoteCompatibility: workNotePreset({ enabled: true }),
        },
      },
      { validateWorkNoteCompatibility },
    );
    const body = openSection(tab, 5);
    const advanced = body.querySelector<HTMLDetailsElement>('.abyss-work-note-advanced')!;
    expect(advanced.tagName).toBe('DETAILS');
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')?.textContent).toBe('Work note fields');
    expect(advanced.querySelector('.abyss-work-note-fields-body')).not.toBeNull();
    expect(body.querySelector('[data-work-note-creation]')).not.toBeNull();
    advanced.open = true;
    advanced.dispatchEvent(new Event('toggle'));
    expect(advanced.textContent).toContain('Source boundary');
    expect(advanced.textContent).toContain('Ordinary kind query');
    expect(advanced.textContent).toContain('Milestone kind query');
    expect(advanced.textContent).toContain('Status mapping');
    expect(advanced.textContent).toContain('Blocked by property');

    const diagnostics = body.querySelector<HTMLDetailsElement>('.abyss-work-note-diagnostics')!;
    expect(diagnostics.open).toBe(false);
    expect(diagnostics.querySelector('summary')?.textContent).toBe('Diagnostics');
    const setup = workNoteSetup(body);
    expect(findInput(setup, 'Creation folder')).not.toBeNull();
    expect(findInput(setup, 'Template path')).not.toBeNull();
    expect(findDropdown(setup, 'Default kind')).not.toBeNull();
    expect(findDropdown(setup, 'Default status')).not.toBeNull();
    expect(findDropdown(setup, 'Kind marker')).not.toBeNull();
    expect(body.querySelectorAll('button button, button a, a button')).toHaveLength(0);
    for (const input of setup.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')) {
      expect(input.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('uses the native settings geometry and reserves a stable compact validation slot', () => {
    expect(declarationsFor('.abyss-settings-section-body-inner')).toContain('padding');
    expect(declarationsFor('.abyss-work-note-validation-slot')).toContain('min-block-size');
    expect(declarationsFor('.abyss-work-note-validation-slot')).toContain('20px');
    expect(css).toMatch(
      /\.abyss-work-note-query-error,\s*\.abyss-work-note-property-error\s*\{[^}]*display:\s*block/u,
    );
    expect(css).toMatch(/\.abyss-work-note-diagnostics-body\s*\{[^}]*max-block-size/u);
    expect(declarationsFor('.abyss-work-note-setup')).not.toContain('#');
    expect(declarationsFor('.abyss-work-note-setup')).toContain('var(');
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

  it('keeps a newly added Project status visible after Projects are mapped to it', async () => {
    const { tab, plugin, captured } = makeTab();
    const previouslyVisible = [...plugin.settings.projects.view.visibleStatusIds];
    openSection(tab, 5);
    const addStatus = captured.find((entry) => {
      if (entry.type !== 'button') return false;
      const element = (entry.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return element?.textContent === '+ Add status';
    });

    addStatus!.comp.clickHandler!();
    await Promise.resolve();

    const added = plugin.settings.projects.statuses[plugin.settings.projects.statuses.length - 1]!;
    expect(plugin.settings.projects.view.visibleStatusIds).toEqual([
      ...previouslyVisible,
      added.id,
    ]);
    expect(plugin.settings.projects.view.visibleStatusIds.filter((id) => id === added.id)).toEqual([
      added.id,
    ]);
  });

  it('keeps a Project rendered when it is newly mapped to the added status', async () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const addStatus = captured.find((entry) => {
      if (entry.type !== 'button') return false;
      const element = (entry.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return element?.textContent === '+ Add status';
    });
    addStatus!.comp.clickHandler!();
    await Promise.resolve();
    const added = plugin.settings.projects.statuses[plugin.settings.projects.statuses.length - 1]!;
    const taskRollup = {
      total: 0,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      open: 0,
      progress: null,
    };
    const snapshot: ProjectWorkspaceSnapshot = {
      project: {
        path: 'Projects/Newly mapped.md',
        name: 'Newly mapped',
        frontmatter: { status: 'new' },
        tags: [],
        statusId: added.id,
        rawStatus: null,
        range: {},
        stats: taskRollup,
      },
      tasks: [],
      workNotes: [],
      milestones: [],
      taskRollup,
      workNoteRollup: { active: 0, completed: 0, dropped: 0 },
      milestoneRollups: new Map(),
      workNoteRelations: [],
      overdue: { tasks: 0, workNotes: 0 },
      dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
      diagnostics: [],
    };
    const container = activeDocument.body.createDiv();

    const cleanup = renderProjectsList(container, [snapshot], {
      state: new AppState(),
      settings: plugin.settings,
      onSaveSettings: async () => undefined,
      onCreate: vi.fn().mockResolvedValue({
        type: 'failed-before-create',
        reason: 'unused',
      }),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(
      container.querySelector('[data-project-path="Projects/Newly mapped.md"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('No projects match the status filters');
    cleanup();
    container.remove();
  });

  it('does not duplicate a newly configured Project status already present in the filter order', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    const nextId = `status-${projects.statuses.length + 1}`;
    projects.view.visibleStatusIds = [projects.statuses[1]!.id, projects.statuses[0]!.id, nextId];
    const { tab, plugin, captured } = makeTab({ projects });
    openSection(tab, 5);
    const addStatus = captured.find((entry) => {
      if (entry.type !== 'button') return false;
      const element = (entry.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return element?.textContent === '+ Add status';
    });

    addStatus!.comp.clickHandler!();
    await Promise.resolve();

    expect(
      plugin.settings.projects.statuses[plugin.settings.projects.statuses.length - 1]?.id,
    ).toBe(nextId);
    expect(plugin.settings.projects.view.visibleStatusIds).toEqual([
      projects.statuses[1]!.id,
      projects.statuses[0]!.id,
      nextId,
    ]);
  });

  it('lets each Project status persist one of the four lifecycle roles', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const lifecycle = captured.filter(
      (entry) => entry.name === 'Lifecycle role' && entry.type === 'dropdown',
    );

    expect(lifecycle).toHaveLength(plugin.settings.projects.statuses.length);
    const select = (lifecycle[0]!.comp as unknown as { selectEl: HTMLSelectElement }).selectEl;
    expect(Array.from(select.options).map(({ value }) => value)).toEqual([
      'regular',
      'completed',
      'dropped',
      'published',
    ]);

    lifecycle[0]!.comp.setValue('completed');
    expect(plugin.settings.projects.statuses[0]!.behavior).toBe('completed');
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it.each(['dropped', 'published'] as const)(
    'keeps the %s lifecycle role unique when it is reassigned',
    (role) => {
      const { tab, plugin, captured } = makeTab();
      openSection(tab, 5);
      const lifecycle = captured.filter(
        (entry) => entry.name === 'Lifecycle role' && entry.type === 'dropdown',
      );

      expect(lifecycle).toHaveLength(plugin.settings.projects.statuses.length);
      if (lifecycle.length < 2) return;
      lifecycle[0]!.comp.setValue(role);
      lifecycle[1]!.comp.setValue(role);

      expect(plugin.settings.projects.statuses[0]!.behavior).toBe('regular');
      expect(plugin.settings.projects.statuses[1]!.behavior).toBe(role);
    },
  );
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
