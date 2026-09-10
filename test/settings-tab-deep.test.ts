import type * as ObsidianModule from 'obsidian';
import { App, Notice, Setting } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { CalendarSettingsTab } from '../src/settings/SettingsTab';
import { SHORTCUT_ACTION_IDS } from '../src/settings/shortcuts';
import type { CalendarSettings } from '../src/settings/types';
import {
  DataTransferStub,
  deferred,
  expectDefined,
  flushMicrotasks,
  loadPluginStyles,
  objectMatching,
  useRealMoment,
} from './helpers';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof ObsidianModule>('obsidian');
  return { ...actual, Notice: vi.fn() };
});

useRealMoment();

const css = await loadPluginStyles();

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

interface StubPlugin {
  app: App;
  settings: CalendarSettings;
  saveSettings: ReturnType<typeof vi.fn>;
  saveViewState: ReturnType<typeof vi.fn>;
  refreshProjectTableSettings: ReturnType<typeof vi.fn>;
  renameProjectStatus: ReturnType<typeof vi.fn>;
  rebuildTaskStatusSemantics: ReturnType<typeof vi.fn>;
}

function expandAllSettingsCards(settings: CalendarSettings, expanded: Set<string>): void {
  for (const group of settings.tagGroups) expanded.add(group.id);
  for (const status of settings.projects.statuses) expanded.add(status.id);
  for (const status of settings.taskStatuses) expanded.add(status.id);
  for (const column of settings.projects.table.columns) {
    expanded.add(`project-property:${column.id}`);
  }
}

interface CapturedComp {
  type: 'text' | 'dropdown' | 'toggle' | 'button' | 'color';
  name: string;
  comp: {
    getValue?: () => unknown;
    setValue: (v: unknown) => unknown;
    clickHandler?: () => void;
    selectEl?: HTMLSelectElement;
  };
}

function patchSetting(captured: CapturedComp[]): () => void {
  const proto = Setting.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const refs: Record<string, (...args: unknown[]) => unknown> = {
    addText: expectDefined(proto['addText']),
    addDropdown: expectDefined(proto['addDropdown']),
    addToggle: expectDefined(proto['addToggle']),
    addButton: expectDefined(proto['addButton']),
    addColorPicker: expectDefined(proto['addColorPicker']),
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
  set('addText', wrap(expectDefined(refs['addText']), 'text'));
  set('addDropdown', wrap(expectDefined(refs['addDropdown']), 'dropdown'));
  set('addToggle', wrap(expectDefined(refs['addToggle']), 'toggle'));
  set('addButton', wrap(expectDefined(refs['addButton']), 'button'));
  set('addColorPicker', wrap(expectDefined(refs['addColorPicker']), 'color'));
  return () => {
    set('addText', expectDefined(refs['addText']));
    set('addDropdown', expectDefined(refs['addDropdown']));
    set('addToggle', expectDefined(refs['addToggle']));
    set('addButton', expectDefined(refs['addButton']));
    set('addColorPicker', expectDefined(refs['addColorPicker']));
  };
}

function makeTab(
  settingsOverrides: Partial<CalendarSettings> = {},
  opts: {
    expand?: boolean;
    saveSettings?: StubPlugin['saveSettings'];
    saveViewState?: StubPlugin['saveViewState'];
    projectProperties?: ProjectPropertyCatalog;
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
  (app as unknown as Record<string, unknown>)['plugins'] = { getPlugin: () => null };
  (app as unknown as Record<string, unknown>)['internalPlugins'] = {
    getPluginById: () => null,
  };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...settingsOverrides };
  const saveSettings = opts.saveSettings ?? vi.fn().mockResolvedValue(undefined);
  const saveViewState = opts.saveViewState ?? vi.fn().mockResolvedValue(undefined);
  const refreshProjectTableSettings = vi.fn();
  const renameProjectStatus = vi.fn(
    async (id: string, name: string, expectedName: string): Promise<void> => {
      const status = settings.projects.statuses.find((candidate) => candidate.id === id);
      if (status?.name !== expectedName) throw new Error('status changed externally');
      status.name = name.trim();
      await (saveSettings as unknown as () => Promise<void>)();
    },
  );
  const plugin: StubPlugin = {
    app,
    settings,
    saveSettings,
    saveViewState,
    refreshProjectTableSettings,
    renameProjectStatus,
    rebuildTaskStatusSemantics: vi.fn(),
  };
  const captured: CapturedComp[] = [];
  const restore = patchSetting(captured);
  const tab = new CalendarSettingsTab(
    app,
    plugin as unknown as ConstructorParameters<typeof CalendarSettingsTab>[1],
    opts.projectProperties,
  );
  // Cards (tag groups / statuses) are collapsed by default; expand them all so
  // their body Settings render and are captured for inspection.
  if (expandCards) {
    const expanded = (tab as unknown as { expandedCards_abyssPrivate: Set<string> })
      .expandedCards_abyssPrivate;
    expandAllSettingsCards(settings, expanded);
  }
  (tab as unknown as { display(): void }).display();
  restore();
  return { tab, plugin, app, captured };
}

function openSection(tab: CalendarSettingsTab, index: number): HTMLElement {
  const headers = tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header');
  expectDefined(headers[index]).click();
  return expectDefined(
    expectDefined(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')[index],
    ).querySelector<HTMLElement>('.abyss-settings-section-body'),
  );
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
  if (el == null) return null;
  // TextComponent creates a plain <input> (no type attr); exclude color inputs.
  const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input'));
  return inputs.find((i) => i.type !== 'color') ?? null;
}

function findDropdown(body: HTMLElement, name: string): HTMLSelectElement | null {
  return findSettingEl(body, name)?.querySelector<HTMLSelectElement>('select') ?? null;
}

function findColorInput(body: HTMLElement, name: string): HTMLInputElement | null {
  const el = findSettingEl(body, name);
  if (el == null) return null;
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

function attachSettingsScroller(tab: CalendarSettingsTab, scrollTop: number): HTMLElement {
  const scroller = document.body.createDiv({ cls: 'vertical-tab-content' });
  scroller.append(tab.containerEl);
  scroller.scrollTop = scrollTop;
  return scroller;
}

function cardNamed(container: HTMLElement, title: string): HTMLElement {
  return expectDefined(
    Array.from(container.querySelectorAll<HTMLElement>('.abyss-settings-card')).find(
      (card) =>
        card.querySelector(':scope > .abyss-settings-card-header > .abyss-settings-card-title')
          ?.textContent === title,
    ),
  );
}

function capturedButton(
  captured: CapturedComp[],
  text: string,
  sectionTitle: string,
): CapturedComp['comp'] {
  return expectDefined(
    captured.find((candidate) => {
      if (candidate.type !== 'button') return false;
      const button = (candidate.comp as { buttonEl?: HTMLButtonElement }).buttonEl;
      return (
        button?.textContent === text &&
        button.closest<HTMLElement>('[data-section-title]')?.dataset['sectionTitle'] ===
          sectionTitle
      );
    }),
  ).comp;
}

function dragCard(source: HTMLElement, target: HTMLElement): void {
  const dataTransfer = new DataTransferStub();
  for (const [element, type] of [
    [expectDefined(source.querySelector<HTMLElement>('.abyss-settings-card-header')), 'dragstart'],
    [target, 'drop'],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    element.dispatchEvent(event);
  }
}

function dispatchCardDragStart(source: HTMLElement): Event {
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: new DataTransferStub() });
  expectDefined(source.querySelector<HTMLElement>('.abyss-settings-card-header')).dispatchEvent(
    event,
  );
  return event;
}

function projectStatusOrder(tab: CalendarSettingsTab): string[] {
  const projects = expectDefined(
    Array.from(tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')).find(
      (section) =>
        section.querySelector('.abyss-settings-section-label')?.textContent === 'Projects',
    ),
  );
  const statusProperty = expectDefined(
    projects.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
  );
  return Array.from(
    statusProperty.querySelectorAll(
      ':scope > .abyss-settings-card-body > .abyss-settings-card > .abyss-settings-card-header > .abyss-settings-card-title',
    ),
    (title) => title.textContent,
  );
}

describe('CalendarSettingsTab renderGeneralSettings', () => {
  it('task prefix input reflects setting and saves on change', () => {
    const { tab, plugin, captured } = makeTab({ taskPrefix: '#task' });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Task prefix');
    expect(input).not.toBeNull();
    expect(expectDefined(input).value).toBe('#task');
    expectDefined(findComp(captured, 'Task prefix', 'text')).comp.setValue('#todo');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.taskPrefix).toBe('#todo');
  });

  it('add to today toggle reflects setting and saves on change', () => {
    const { tab, plugin, captured } = makeTab({ addToToday: true });
    openSection(tab, 0);
    // Toggle has no checkbox input in the mock; verify via captured component value
    const toggleComp = expectDefined(findComp(captured, "Add to today's note", 'toggle'));
    if (toggleComp.comp.getValue === undefined) {
      throw new Error('Expected the toggle component to expose getValue');
    }
    expect(toggleComp.comp.getValue()).toBe(true);
    toggleComp.comp.setValue(false);
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.addToToday).toBe(false);
  });

  it('custom file path visible when addToToday is false', () => {
    const { tab } = makeTab({ addToToday: false, customFilePath: 'inbox.md' });
    const body = openSection(tab, 0);
    const input = findInput(body, 'Custom file path');
    expect(input).not.toBeNull();
    expect(expectDefined(input).value).toBe('inbox.md');
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
    expectDefined(findComp(captured, 'Custom file path', 'text')).comp.setValue('new.md');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.customFilePath).toBe('new.md');
  });
});

describe('CalendarSettingsTab Hotkeys', () => {
  function hotkeysBody(tab: CalendarSettingsTab): HTMLElement {
    return openSection(tab, 7);
  }

  function shortcutInput(body: HTMLElement, action: string): HTMLInputElement {
    return expectDefined(
      body.querySelector<HTMLInputElement>(`[data-shortcut-action="${action}"]`),
    );
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
    const section = expectDefined(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')[7],
    );
    const header = expectDefined(
      section.querySelector<HTMLButtonElement>('.abyss-settings-section-header'),
    );
    const body = expectDefined(section.querySelector<HTMLElement>('.abyss-settings-section-body'));

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
    const status = expectDefined(
      body.querySelector<HTMLElement>('.abyss-shortcut-validation-status'),
    );

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
    (tab as unknown as { display(): void }).display();
    const body = hotkeysBody(tab);
    const quickCapture = shortcutInput(body, 'openQuickCapture');
    const issueId = quickCapture.getAttribute('aria-describedby');
    const issue = expectDefined(body.querySelector<HTMLElement>(`#${issueId}`));

    expect(quickCapture.getAttribute('aria-invalid')).toBe('true');
    expect(issue.textContent).toContain(
      'Q conflicts with Search and is disabled. shift 7 remains active.',
    );
    const warning = expectDefined(issue.querySelector<HTMLElement>('.abyss-shortcut-warning-icon'));
    const status = expectDefined(
      body.querySelector<HTMLElement>('.abyss-shortcut-validation-status'),
    );
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
    expect(screenReaderOnly).toContain('clip-path: inset(50%)');
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
    (tab as unknown as { display(): void }).display();
    const body = hotkeysBody(tab);
    const input = shortcutInput(body, 'openQuickCapture');
    const issue = expectDefined(
      body.querySelector<HTMLElement>(`#${input.getAttribute('aria-describedby')}`),
    );

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(issue.textContent).toContain(message);
  });

  it('coalesces rapid hotkey saves so out-of-order persistence cannot regress the final value', async () => {
    const settings = { current: undefined as CalendarSettings | undefined };
    const persisted: string[] = [];
    const saves: Array<{ value: string; completion: ReturnType<typeof deferred<void>> }> = [];
    const saveSettings = vi.fn(() => {
      const completion = deferred<void>();
      const value = expectDefined(settings.current).shortcuts.openQuickCapture;
      saves.push({ value, completion });
      void completion.promise
        .then(() => persisted.push(value))
        .catch((error: unknown) => {
          throw error;
        });
      return completion.promise;
    });
    const { tab, plugin } = makeTab({}, { saveSettings });
    settings.current = plugin.settings;
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

    expectDefined(saves[0]).completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(saves.map((save) => save.value)).toEqual(['Q', 'E']);
    expectDefined(saves[1]).completion.resolve();
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

      const status = expectDefined(body.querySelector<HTMLElement>('.abyss-shortcut-save-status'));
      const retry = expectDefined(
        body.querySelector<HTMLButtonElement>('.abyss-shortcut-save-retry'),
      );
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
    const options = Array.from(expectDefined(dd).options).map((o) => o.value);
    expect(options).toContain('tag');
    expect(options).toContain('untagged');
  });

  it('inbox source switch to tag saves and re-renders', () => {
    const { tab, plugin, captured } = makeTab({
      inbox: { mode: 'untagged', tag: '', removeTagOnAssign: true },
    });
    openSection(tab, 3);
    expectDefined(findComp(captured, 'Inbox source', 'dropdown')).comp.setValue('tag');
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
    expect(expectDefined(input).value).toBe('#inbox');
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
    expectDefined(findComp(captured, 'Inbox tag', 'text')).comp.setValue('  #new  ');
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
    const addButton = expectDefined(addBtn).comp;
    if (addButton.clickHandler === undefined) {
      throw new Error('Expected the add button to expose a click handler');
    }
    addButton.clickHandler();
    vi.useRealTimers();
    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(expectDefined(plugin.settings.tagGroups[0]).id).toMatch(/^group-\d+$/);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

describe('CalendarSettingsTab renderTagGroupCard', () => {
  const baseGroup = { id: 'g1', name: 'Work', mode: 'prefix' as const, prefix: 'work' };

  it('group name input saves on change', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup }] });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Group name', 'text')).comp.setValue('Personal');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).name).toBe('Personal');
  });

  it('mode dropdown has prefix/manual options', () => {
    const { tab } = makeTab({ tagGroups: [{ ...baseGroup }] });
    const body = openSection(tab, 4);
    const dd = findDropdown(body, 'Mode');
    expect(dd).not.toBeNull();
    const options = Array.from(expectDefined(dd).options).map((o) => o.value);
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
    expectDefined(findComp(captured, 'Prefix', 'text')).comp.setValue('  work  ');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).prefix).toBe('work');
  });

  it('tags CSV input parses to array (split, trim, filter empty)', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup, mode: 'manual', tags: [] }],
    });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Tags', 'text')).comp.setValue('a, b, c');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).tags).toEqual(['a', 'b', 'c']);
  });

  it('tags CSV input filters out empty values', () => {
    const { tab, plugin, captured } = makeTab({
      tagGroups: [{ ...baseGroup, mode: 'manual', tags: [] }],
    });
    openSection(tab, 4);
    expectDefined(findComp(captured, 'Tags', 'text')).comp.setValue('a,, ,b');
    expect(expectDefined(plugin.settings.tagGroups[0]).tags).toEqual(['a', 'b']);
  });

  it('color picker saves on change', () => {
    const { tab, plugin, captured } = makeTab({ tagGroups: [{ ...baseGroup, color: '#ff0000' }] });
    const body = openSection(tab, 4);
    const colorInput = findColorInput(body, 'Color');
    expect(colorInput).not.toBeNull();
    expectDefined(findComp(captured, 'Color', 'color')).comp.setValue('#00ff00');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(expectDefined(plugin.settings.tagGroups[0]).color).toBe('#00ff00');
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
    const deleteButton = expectDefined(delBtns[0]).comp;
    if (deleteButton.clickHandler === undefined) {
      throw new Error('Expected the delete button to expose a click handler');
    }
    deleteButton.clickHandler();
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(expectDefined(plugin.settings.tagGroups[0]).id).toBe('g2');
  });
});

describe('CalendarSettingsTab renderViewConfigSettings', () => {
  it('default view dropdown has month/week/list', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 1); // Desktop
    const dd = findDropdown(body, 'Default view');
    expect(dd).not.toBeNull();
    const options = Array.from(expectDefined(dd).options).map((o) => o.value);
    expect(options).toEqual(['month', 'week', 'list']);
  });

  it('default view change saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Default view', 'dropdown')).comp.setValue('week');
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
    expectDefined(findComp(captured, 'First day of week', 'dropdown')).comp.setValue('1');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.firstDayOfWeek).toBe(1);
  });

  it('daily note folder input saves (manual provider)', () => {
    const { tab, plugin, captured } = makeTab({ dailyNoteProvider: 'manual' });
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Daily note folder', 'text')).comp.setValue('notes/daily');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.dailyNoteFolder).toBe('notes/daily');
  });

  it('daily note format input saves (manual provider)', () => {
    const { tab, plugin, captured } = makeTab({ dailyNoteProvider: 'manual' });
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Daily note format', 'text')).comp.setValue('DD-MM-YYYY');
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
    expectDefined(findComp(captured, 'Global task filter', 'text')).comp.setValue('#task');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.globalTaskFilter).toBe('#task');
  });

  it('upcoming days valid number saves', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Upcoming days', 'text')).comp.setValue('14');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.settings.desktop.upcomingDays).toBe(14);
  });

  it.each(['abc', '-5', '0'])('upcoming days invalid input %s does not save', (invalidValue) => {
    const { tab, plugin, captured } = makeTab({
      desktop: { ...DEFAULT_SETTINGS.desktop, upcomingDays: 7 },
    });
    openSection(tab, 1);
    expectDefined(findComp(captured, 'Upcoming days', 'text')).comp.setValue(invalidValue);
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
    expectDefined(headers[0]).click();
    const selects = tab.containerEl.querySelectorAll<HTMLSelectElement>('select');
    const values = Array.from(selects).map((s) => s.value);
    expect(values).toContain('non-default');
  });

  it('dropdown has three options: never, always, non-default', () => {
    const { tab } = makeTab();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    expectDefined(headers[0]).click();
    const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    const sourceSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'non-default'),
    );
    expect(sourceSelect).not.toBeUndefined();
    const optionValues = Array.from(expectDefined(sourceSelect).options).map((o) => o.value);
    expect(optionValues).toContain('never');
    expect(optionValues).toContain('always');
    expect(optionValues).toContain('non-default');
  });

  it('dropdown reflects current settings value', () => {
    const { tab, plugin } = makeTab();
    plugin.settings.sourceNoteDisplay = 'always';
    (tab as unknown as { display(): void }).display();
    const headers = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    );
    expectDefined(headers[0]).click();
    const selects = Array.from(tab.containerEl.querySelectorAll<HTMLSelectElement>('select'));
    const sourceSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === 'non-default'),
    );
    expect(sourceSelect?.value).toBe('always');
  });
});

describe('CalendarSettingsTab collapsible cards + default status', () => {
  it('rejects a tag-group card payload dropped on the project-status list', () => {
    const tagGroups = [{ id: 'group-work', name: 'Work', mode: 'prefix' as const, prefix: 'work' }];
    const { tab, plugin } = makeTab({ tagGroups });
    const tagBody = openSection(tab, 4);
    const projectBody = openSection(tab, 5);
    const beforeStatuses = plugin.settings.projects.statuses.map(({ id }) => id);

    dragCard(
      cardNamed(tagBody, 'Work'),
      cardNamed(projectBody, expectDefined(plugin.settings.projects.statuses[1]).name),
    );

    expect(plugin.settings.projects.statuses.map(({ id }) => id)).toEqual(beforeStatuses);
    expect(plugin.settings.tagGroups.map(({ id }) => id)).toEqual(['group-work']);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps the focused draft and current identities through repeated project-status drops', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const [first, second, third] = plugin.settings.projects.statuses;
    const firstStatus = expectDefined(first);
    const secondStatus = expectDefined(second);
    const thirdStatus = expectDefined(third);
    const firstCard = cardNamed(body, firstStatus.name);
    const secondCard = cardNamed(body, secondStatus.name);
    const thirdCard = cardNamed(body, thirdStatus.name);
    const draft = expectDefined(firstCard.querySelector<HTMLInputElement>('input'));
    draft.value = 'unfinished status draft';
    draft.focus();
    draft.setSelectionRange(10, 10);

    dragCard(secondCard, firstCard);
    dragCard(secondCard, thirdCard);
    dragCard(thirdCard, secondCard);

    expect(plugin.settings.projects.statuses.slice(0, 3).map(({ id }) => id)).toEqual([
      firstStatus.id,
      secondStatus.id,
      thirdStatus.id,
    ]);
    expect(projectStatusOrder(tab)).toEqual([
      firstStatus.name,
      secondStatus.name,
      thirdStatus.name,
    ]);
    expect(scroller.scrollTop).toBe(513);
    expect(activeDocument.activeElement).toBe(draft);
    expect(draft.isConnected).toBe(true);
    expect(draft.value).toBe('unfinished status draft');
    expect(draft.selectionStart).toBe(10);
  });

  it('owns a nested project-status drag without bubbling it into the property card', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const statusProperty = expectDefined(
      body.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
    );
    const nestedStatus = cardNamed(body, expectDefined(plugin.settings.projects.statuses[0]).name);
    const outerDragStart = vi.fn();
    statusProperty.addEventListener('dragstart', outerDragStart);

    dispatchCardDragStart(nestedStatus);

    expect(outerDragStart).not.toHaveBeenCalled();
    expect(nestedStatus.hasClass('abyss-dragging')).toBe(true);
    expect(statusProperty.hasClass('abyss-dragging')).toBe(false);
  });

  it('preserves focused draft context when display rebuilds an open settings tab', () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const status = expectDefined(plugin.settings.projects.statuses[0]);
    const before = expectDefined(
      cardNamed(body, status.name).querySelector<HTMLInputElement>('input'),
    );
    before.value = 'display draft';
    before.focus();
    before.setSelectionRange(4, 9, 'backward');

    (tab as unknown as { display(): void }).display();

    const after = expectDefined(
      cardNamed(tab.containerEl, status.name).querySelector<HTMLInputElement>('input'),
    );
    expect(after).not.toBe(before);
    expect(scroller.scrollTop).toBe(513);
    expect(activeDocument.activeElement).toBe(after);
    expect(after.value).toBe('display draft');
    expect(after.selectionStart).toBe(4);
    expect(after.selectionEnd).toBe(9);
    expect(after.selectionDirection).toBe('backward');
  });

  it('preserves a focused project-column width draft through display', () => {
    const { tab } = makeTab();
    openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const before = expectDefined(
      tab.containerEl.querySelector<HTMLInputElement>(
        '[data-column-id="progress"] .abyss-project-column-width',
      ),
    );
    before.value = '260';
    before.focus();

    (tab as unknown as { display(): void }).display();

    const after = expectDefined(
      tab.containerEl.querySelector<HTMLInputElement>(
        '[data-column-id="progress"] .abyss-project-column-width',
      ),
    );
    expect(after.value).toBe('260');
    expect(activeDocument.activeElement).toBe(after);
    expect(scroller.scrollTop).toBe(513);
  });

  it('expands one card without replacing an unrelated focused settings control', () => {
    const { tab } = makeTab({}, { expand: false });
    const general = openSection(tab, 0);
    const projects = openSection(tab, 5);
    attachSettingsScroller(tab, 513);
    const taskPrefix = expectDefined(findInput(general, 'Task prefix'));
    taskPrefix.value = '#unfinished';
    taskPrefix.focus();
    taskPrefix.setSelectionRange(5, 5);
    expect(activeDocument.activeElement).toBe(taskPrefix);

    expectDefined(projects.querySelector<HTMLElement>('.abyss-settings-card-header')).click();

    expect(activeDocument.activeElement).toBe(taskPrefix);
    expect(taskPrefix.isConnected).toBe(true);
    expect(taskPrefix.value).toBe('#unfinished');
    expect(taskPrefix.selectionStart).toBe(5);
    expect(projects.querySelector('.abyss-settings-card.is-open')).not.toBeNull();
  });

  it('ignores unchanged catalog events and preserves draft context for a changed catalog', () => {
    let properties = [{ name: 'status', type: 'text' as const }];
    let publish: () => void = () => {};
    const projectProperties: ProjectPropertyCatalog = {
      list: () => properties,
      inspect: () => ({ kind: 'available', property: undefined, assignment: { kind: 'none' } }),
      values: () => [],
      onChange: (callback) => {
        publish = callback;
        return () => {};
      },
    };
    const { tab, plugin } = makeTab({}, { projectProperties });
    const body = openSection(tab, 5);
    const scroller = attachSettingsScroller(tab, 513);
    const status = expectDefined(plugin.settings.projects.statuses[0]);
    const input = expectDefined(
      cardNamed(body, status.name).querySelector<HTMLInputElement>('input'),
    );
    input.value = 'catalog draft';
    input.focus();
    input.setSelectionRange(7, 7);

    publish();
    expect(activeDocument.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);

    properties = [...properties, { name: 'Phase', type: 'text' }];
    publish();

    const replacement = expectDefined(
      cardNamed(tab.containerEl, status.name).querySelector<HTMLInputElement>('input'),
    );
    const statusSource = findDropdown(tab.containerEl, 'Status property');
    expect(Array.from(expectDefined(statusSource).options).map(({ value }) => value)).toContain(
      'Phase',
    );
    expect(scroller.scrollTop).toBe(513);
    expect(activeDocument.activeElement).toBe(replacement);
    expect(replacement.value).toBe('catalog draft');
    expect(replacement.selectionStart).toBe(7);
  });

  it('keeps the reordered draft and offers a current-state retry after save failure', async () => {
    vi.mocked(Notice).mockClear();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saveSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined);
    const { tab, plugin } = makeTab({}, { saveSettings });
    const body = openSection(tab, 5);
    const before = plugin.settings.projects.statuses.map(({ id }) => id);
    const first = cardNamed(body, expectDefined(plugin.settings.projects.statuses[0]).name);
    const second = cardNamed(body, expectDefined(plugin.settings.projects.statuses[1]).name);

    dragCard(second, first);
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.settings.projects.statuses.map(({ id }) => id)).toEqual([
      expectDefined(before[1]),
      expectDefined(before[0]),
      ...before.slice(2),
    ]);
    expect(projectStatusOrder(tab)).toEqual(
      plugin.settings.projects.statuses.slice(0, 3).map(({ name }) => name),
    );
    expect(Notice).toHaveBeenCalledOnce();
    const noticeContent = vi.mocked(Notice).mock.calls[0]?.[0];
    expect(noticeContent).toBeInstanceOf(DocumentFragment);
    expect((noticeContent as DocumentFragment).textContent).toContain(
      'Could not reorder project statuses: disk unavailable. Changes are kept in this session.',
    );
    expectDefined((noticeContent as DocumentFragment).querySelector('button')).click();
    await Promise.resolve();
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      '[abyss-tasks] Could not reorder project statuses',
      objectMatching<{ cause: unknown }>({ cause: expect.any(Error) as unknown }),
    );
    errorLog.mockRestore();
  });

  it('does not let an older failed reorder overwrite a newer project-status order', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const saveSettings = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined);
    const { tab, plugin } = makeTab({}, { saveSettings });
    const body = openSection(tab, 5);
    const [first, second, third] = plugin.settings.projects.statuses;
    const firstStatus = expectDefined(first);
    const secondStatus = expectDefined(second);
    const thirdStatus = expectDefined(third);
    const secondCard = cardNamed(body, secondStatus.name);

    dragCard(secondCard, cardNamed(body, firstStatus.name));
    dragCard(secondCard, cardNamed(body, thirdStatus.name));
    rejectFirst(new Error('older write failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.settings.projects.statuses.slice(0, 3).map(({ id }) => id)).toEqual([
      firstStatus.id,
      thirdStatus.id,
      secondStatus.id,
    ]);
    expect(projectStatusOrder(tab)).toEqual([
      firstStatus.name,
      thirdStatus.name,
      secondStatus.name,
    ]);
  });

  it('renders a tag-group addition immediately and keeps it after save failure', async () => {
    vi.mocked(Notice).mockClear();
    const { tab, plugin, captured } = makeTab(
      { tagGroups: [] },
      { saveSettings: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
    );
    openSection(tab, 4);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, '+ add group', 'Tag groups').clickHandler)();

    expect(plugin.settings.tagGroups).toHaveLength(1);
    expect(cardNamed(tab.containerEl, 'New group').isConnected).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect((vi.mocked(Notice).mock.calls[0]?.[0] as DocumentFragment).textContent).toContain(
      'Changes are kept in this session',
    );
  });

  it('renders a tag-group deletion immediately and keeps it after save failure', async () => {
    const { tab, plugin, captured } = makeTab(
      { tagGroups: [{ id: 'g1', name: 'Work', mode: 'prefix', prefix: 'work' }] },
      { saveSettings: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
    );
    openSection(tab, 4);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, 'Delete group', 'Tag groups').clickHandler)();

    expect(plugin.settings.tagGroups).toHaveLength(0);
    expect(tab.containerEl.textContent).not.toContain('Work');
    await Promise.resolve();
    await Promise.resolve();
    expect(Notice).toHaveBeenCalled();
  });

  it('renders project-status add and delete drafts before persistence settles', async () => {
    const pending = deferred<void>();
    const { tab, plugin, captured } = makeTab({}, { saveSettings: vi.fn(() => pending.promise) });
    openSection(tab, 5);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, '+ add status', 'Projects').clickHandler)();
    expect(cardNamed(tab.containerEl, 'status 4').isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(
      cardNamed(tab.containerEl, 'status 4').querySelector('.abyss-settings-card-body input'),
    );

    const deleteStatus = expectDefined(plugin.settings.projects.statuses[0]);
    const deleteButton = capturedButton(captured, 'Delete status', 'Projects');
    expectDefined(deleteButton.clickHandler)();
    expect(plugin.settings.projects.statuses.some(({ id }) => id === deleteStatus.id)).toBe(false);
    expect(
      tab.containerEl.querySelector(
        `[data-section-title="Projects"] [data-card-id="${deleteStatus.id}"]`,
      ),
    ).toBeNull();
    pending.resolve();
    await pending.promise;
  });

  it('keeps task-status add and delete drafts coherent when saves fail', async () => {
    vi.mocked(Notice).mockClear();
    const custom = {
      id: 'status-custom',
      symbol: '!',
      name: 'Important',
      type: 'todo' as const,
      icon: 'alert-triangle',
      core: false,
    };
    const { tab, plugin, captured } = makeTab(
      { taskStatuses: [...structuredClone(DEFAULT_SETTINGS.taskStatuses), custom] },
      { saveSettings: vi.fn().mockRejectedValue(new Error('disk unavailable')) },
    );
    openSection(tab, 6);
    attachSettingsScroller(tab, 513);

    expectDefined(capturedButton(captured, '+ add status', 'Custom statuses').clickHandler)();
    expect(cardNamed(tab.containerEl, 'New status').isConnected).toBe(true);
    expect(plugin.rebuildTaskStatusSemantics).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();

    const deleteButton = capturedButton(captured, 'Delete status', 'Custom statuses');
    expectDefined(deleteButton.clickHandler)();
    expectDefined(deleteButton.clickHandler)();
    expect(plugin.settings.taskStatuses.some(({ id }) => id === custom.id)).toBe(false);
    expect(tab.containerEl.querySelector(`[data-card-id="${custom.id}"]`)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(Notice).toHaveBeenCalled();
  });

  it('refreshes a mounted project table after description and column view saves', async () => {
    const { tab, plugin } = makeTab();
    const projectsHeader = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section-header'),
    ).find((header) => header.textContent.includes('Projects'));
    expectDefined(projectsHeader).click();
    const description = expectDefined(
      tab.containerEl.querySelector<HTMLInputElement>('.abyss-project-show-description'),
    );

    description.checked = false;
    description.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(plugin.saveViewState).toHaveBeenCalledOnce();
    expect(plugin.refreshProjectTableSettings).toHaveBeenCalledOnce();

    const column = expectDefined(
      Array.from(
        tab.containerEl.querySelectorAll<HTMLInputElement>('.abyss-project-column-visible'),
      ).find((input) => !input.disabled),
    );
    column.checked = !column.checked;
    column.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(plugin.saveViewState).toHaveBeenCalledTimes(2);
    expect(plugin.refreshProjectTableSettings).toHaveBeenCalledTimes(2);
  });

  it('keeps the project toolbar in the shared compact row at constrained widths', () => {
    expect(css).toContain('--abyss-center-toolbar-height: 60px');
    expect(css).toMatch(
      /\.abyss-center-header,\s*\.abyss-cal-nav\s*\{[^}]*min-height: var\(--abyss-center-toolbar-height\)/u,
    );
    expect(css).toMatch(
      /@media \(width <= 720px\)[\s\S]*?\.abyss-projects-toolbar\s*\{[^}]*flex-wrap: nowrap/u,
    );
    expect(css).toMatch(
      /@container abyss-task-list \(max-width: 30rem\)[\s\S]*?\.abyss-cal-nav\s*\{(?=[^}]*flex-wrap: nowrap)(?=[^}]*overflow-x: auto)/u,
    );
    expect(css).toContain('min(var(--abyss-shell-top-inset), 5px)');
  });

  it('isolates compact table descriptions from dashboard spacing', () => {
    const declarations = declarationsFor('.abyss-projects-table .abyss-project-description');
    expect(declarations).toContain('margin: 0');
    expect(declarations).toContain('white-space: nowrap');
    expect(declarationsFor('.abyss-projects-table .abyss-project-description.is-empty')).toBe('');
  });

  it('lets the sorted drop marker override the group perimeter', () => {
    expect(
      declarationsFor('.abyss-project-table-row.is-drop-target.is-drop-before > td'),
    ).toContain('inset 0 2px');
    expect(declarationsFor('.abyss-project-table-row.is-drop-target.is-drop-after > td')).toContain(
      'inset 0 -2px',
    );
  });

  it('preserves the real settings scroller and focuses a newly added project status', async () => {
    const { tab, captured } = makeTab();
    const scroller = document.body.createDiv({ cls: 'vertical-tab-content' });
    scroller.append(tab.containerEl);
    scroller.scrollTop = 720.5;
    const add = expectDefined(
      captured.find((candidate) => {
        if (candidate.type !== 'button') return false;
        const button = (candidate.comp as { buttonEl?: HTMLButtonElement }).buttonEl;
        return button?.textContent === '+ add status';
      }),
    );

    add.comp.clickHandler?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(720.5);
    const newCard = Array.from(
      tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-card'),
    ).find((card) => card.querySelector('.abyss-settings-card-title')?.textContent === 'status 4');
    expect(activeDocument.activeElement).toBe(
      expectDefined(newCard).querySelector('.abyss-settings-card-body input'),
    );
  });

  it('preserves the real settings scroller and focuses the newly added property card', async () => {
    const projectProperties: ProjectPropertyCatalog = {
      list: () => [{ name: 'Budget', type: 'number' }],
      inspect: () => ({ kind: 'available', property: undefined, assignment: { kind: 'none' } }),
      values: () => [],
      onChange: () => () => {},
    };
    const { tab } = makeTab({}, { projectProperties });
    const scroller = document.body.createDiv({ cls: 'vertical-tab-content' });
    scroller.append(tab.containerEl);
    scroller.scrollTop = 1855;
    const input = expectDefined(
      tab.containerEl.querySelector<HTMLInputElement>('.abyss-project-column-add-input'),
    );
    input.value = 'Budget';
    expectDefined(
      tab.containerEl.querySelector<HTMLButtonElement>('.abyss-project-column-add'),
    ).click();
    await flushMicrotasks();

    expect(scroller.scrollTop).toBe(1855);
    expect(activeDocument.activeElement).toBe(
      tab.containerEl.querySelector(
        '[data-card-id="project-property:property:Budget"] .abyss-project-property-toggle',
      ),
    );
  });

  it('statuses render as collapsed cards (title only) by default', () => {
    const { tab } = makeTab({}, { expand: false });
    const body = openSection(tab, 5); // Projects
    const statusProperty = expectDefined(
      body.querySelector<HTMLElement>('[data-card-id="project-property:status"]'),
    );
    expectDefined(statusProperty.querySelector<HTMLElement>('.abyss-settings-card-header')).click();
    const cards = statusProperty.querySelectorAll<HTMLElement>(
      '.abyss-settings-card-body > .abyss-settings-card',
    );
    expect(cards).toHaveLength(DEFAULT_SETTINGS.projects.statuses.length);
    // Collapsed: title shown, no expanded body.
    expect(expectDefined(cards[0]).querySelector('.abyss-settings-card-title')?.textContent).toBe(
      'active',
    );
    expect(expectDefined(cards[0]).querySelector('.abyss-settings-card-body')).toBeNull();
  });

  it('clicking a card header expands it to reveal the body', () => {
    const { tab } = makeTab({}, { expand: false });
    const body = openSection(tab, 5);
    (body.querySelector('.abyss-settings-card .abyss-settings-card-header') as HTMLElement).click();
    const bodyAgain = expectDefined(
      expectDefined(
        tab.containerEl.querySelectorAll<HTMLElement>('.abyss-settings-section')[5],
      ).querySelector('.abyss-settings-section-body'),
    );
    expect(
      bodyAgain.querySelector('.abyss-settings-card.is-open .abyss-settings-card-body'),
    ).toBeTruthy();
  });

  it('a single Default status dropdown lists all statuses and sets defaultStatusId', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const dd = captured.find((c) => c.name === 'Default status' && c.type === 'dropdown');
    expect(dd).toBeTruthy();
    const plannedId = expectDefined(plugin.settings.projects.statuses[1]).id;
    expectDefined(dd).comp.setValue(plannedId);
    expect(plugin.settings.projects.defaultStatusId).toBe(plannedId);
    // No per-status "Default for new projects" toggle remains.
    expect(captured.some((c) => c.name === 'Default for new projects')).toBe(false);
  });

  it('renders project status appearance with native dropdown presentation', () => {
    const { tab, plugin, captured } = makeTab();
    openSection(tab, 5);
    const appearanceComponent = expectDefined(
      captured.find((entry) => entry.name === 'Appearance' && entry.type === 'dropdown'),
    ).comp;
    const appearance = appearanceComponent.selectEl;

    expect(expectDefined(appearance).classList.contains('dropdown')).toBe(true);
    expect(appearance?.getAttribute('aria-label')).toBe('Appearance for active');
    expect(appearanceComponent.getValue?.()).toBe('badge');
    appearanceComponent.setValue('text');
    expect(plugin.settings.projects.statuses[0]?.display).toBe('text');
  });

  it('deleting the default status repoints defaultStatusId to the first remaining', () => {
    const { tab, plugin, captured } = makeTab();
    // Make the first status the default, then delete it.
    plugin.settings.projects.defaultStatusId = expectDefined(
      plugin.settings.projects.statuses[0],
    ).id;
    openSection(tab, 5);
    const delBtns = captured.filter((c) => {
      if (c.type !== 'button') return false;
      const el = (c.comp as unknown as { buttonEl?: HTMLElement }).buttonEl;
      return el?.textContent === 'Delete status';
    });
    const survivorId = expectDefined(plugin.settings.projects.statuses[1]).id;
    const deleteButton = expectDefined(delBtns[0]).comp;
    if (deleteButton.clickHandler === undefined) {
      throw new Error('Expected the delete button to expose a click handler');
    }
    deleteButton.clickHandler();
    expect(plugin.settings.projects.defaultStatusId).toBe(survivorId);
  });
});

describe('CalendarSettingsTab card badges and project status metadata', () => {
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

  it('status cards have one shared property source and no per-status source badge', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 5);
    const badges = Array.from(body.querySelectorAll('.abyss-settings-card-badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual([]);
    expect(findDropdown(body, 'Status property')?.value).toBe('status');
    expect(body.textContent).not.toContain('Defined by');
    expect(findInput(body, 'Value')?.value).toBe('active');
  });

  it('commits a status rename on blur rather than on each input event', async () => {
    const { tab, plugin } = makeTab();
    const body = openSection(tab, 5);
    const input = expectDefined(findInput(body, 'Value'));
    input.value = 'running';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(plugin.renameProjectStatus).not.toHaveBeenCalled();

    input.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.renameProjectStatus).toHaveBeenCalledWith('status-1', 'running', 'active');
  });

  it('nests status and curated date controls inside their property cards', () => {
    const { tab } = makeTab();
    const body = openSection(tab, 5);
    const text = body.textContent;
    expect(text).not.toContain('Statuses');
    expect(text.indexOf('Status property')).toBeGreaterThan(text.indexOf('Table columns'));
    expect(text.indexOf('Start property')).toBeGreaterThan(text.indexOf('Table columns'));
    expect(text.indexOf('End property')).toBeGreaterThan(text.indexOf('Table columns'));
  });

  it('offers nonreserved sources independent of native type and omits curated collisions', () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.statusProperty = 'Статус';
    projects.startProperty = 'Начало';
    projects.endProperty = 'Конец';
    const projectProperties: ProjectPropertyCatalog = {
      list: () => [
        { name: 'Статус', type: 'text' },
        { name: 'Фаза', type: 'text' },
        { name: 'description', type: 'text' },
        { name: 'Начало', type: 'date' },
        { name: 'Конец', type: 'date' },
        { name: 'Wrong type', type: 'number' },
      ],
      inspect: () => ({
        kind: 'available',
        property: undefined,
        assignment: { kind: 'none' },
      }),
      values: () => [],
      onChange: () => () => {},
    };
    const { tab, plugin } = makeTab({ projects }, { projectProperties });
    const body = openSection(tab, 5);
    const status = expectDefined(findDropdown(body, 'Status property'));
    const start = expectDefined(findDropdown(body, 'Start property'));
    expect(Array.from(status.options).map(({ value }) => value)).toEqual([
      'Статус',
      'Фаза',
      'Wrong type',
    ]);
    expect(Array.from(start.options).map(({ value }) => value)).toEqual([
      'Фаза',
      'Начало',
      'Wrong type',
    ]);

    expect(plugin.settings.projects.startProperty).toBe('Начало');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('selects the native Status spelling for a case-insensitive saved source', () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.statusProperty = 'status';
    const projectProperties: ProjectPropertyCatalog = {
      list: () => [{ name: 'Status', type: 'text' }],
      inspect: () => ({
        kind: 'available',
        property: { name: 'Status', type: 'text' },
        assignment: { kind: 'none' },
      }),
      values: () => [],
      onChange: () => () => {},
    };

    const { tab } = makeTab({ projects }, { projectProperties });
    const body = openSection(tab, 5);

    expect(findDropdown(body, 'Status property')?.value).toBe('Status');
  });

  it('shows recoverable legacy binding evidence until a source is selected', async () => {
    const projects = structuredClone(DEFAULT_SETTINGS.projects);
    projects.statusProperty = '';
    projects.statusMigration = {
      issue: 'conflicting-properties',
      legacyStatuses: [
        { id: 'a', match: { kind: 'property', property: 'status', value: 'active' } },
      ],
      propertyCandidates: ['status', 'phase'],
    };
    const { tab, plugin, captured } = makeTab({ projects });
    const body = openSection(tab, 5);
    expect(findDropdown(body, 'Status migration needs attention')).not.toBeNull();
    const resolution = expectDefined(
      captured.find(
        (entry) => entry.type === 'dropdown' && entry.name === 'Status migration needs attention',
      ),
    );

    resolution.comp.setValue('phase');
    await Promise.resolve();
    await Promise.resolve();

    expect(plugin.settings.projects.statusProperty).toBe('phase');
    expect(plugin.settings.projects.statusMigration).toBeUndefined();
    expect(plugin.saveSettings).toHaveBeenCalledOnce();
  });
});
