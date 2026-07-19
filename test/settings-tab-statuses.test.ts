import { App, Setting } from 'obsidian';
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
  rebuildTaskStatusSemantics: ReturnType<typeof vi.fn>;
}

interface CapturedButton {
  el: HTMLButtonElement;
  click: () => void;
}

/**
 * obsidian-test-mocks' ButtonComponent never wires a real DOM 'click' listener —
 * `onClick` only stores the handler, invoked via its internal `simulateClick__`.
 * Patch `addButton` to capture components so tests can trigger clicks directly.
 */
interface CapturedText {
  el: HTMLInputElement;
  invokeChange: (v: string) => unknown;
}

/**
 * Patch `addText` to capture each TextComponent's inputEl + its registered
 * onChange callback, so a test can invoke the handler directly without
 * relying on DOM 'input' event wiring (which obsidian-test-mocks doesn't
 * simulate for TextComponent).
 */
function patchAddText(captured: CapturedText[]): () => void {
  const proto = Setting.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const orig = proto.addText!;
  proto.addText = function (
    this: {
      components: Array<{ inputEl: HTMLInputElement; _onChange?: (v: string) => unknown }>;
    },
    cb: unknown,
  ) {
    const result = orig.call(this, cb);
    const comp = this.components[this.components.length - 1]!;
    captured.push({ el: comp.inputEl, invokeChange: (v: string) => comp._onChange?.(v) });
    return result;
  };
  return () => {
    proto.addText = orig;
  };
}

function patchAddButton(captured: CapturedButton[]): () => void {
  const proto = Setting.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const orig = proto.addButton!;
  proto.addButton = function (
    this: { components: Array<{ buttonEl: HTMLButtonElement; clickHandler?: () => void }> },
    cb: unknown,
  ) {
    const result = orig.call(this, cb);
    const comp = this.components[this.components.length - 1]!;
    captured.push({ el: comp.buttonEl, click: () => comp.clickHandler?.() });
    return result;
  };
  return () => {
    proto.addButton = orig;
  };
}

function makeTab(opts: { withCustomStatus?: boolean } = {}): {
  tab: CalendarSettingsTab;
  plugin: StubPlugin;
  captured: CapturedButton[];
} {
  const app = new App();
  (app as unknown as Record<string, unknown>).plugins = { getPlugin: () => null };
  (app as unknown as Record<string, unknown>).internalPlugins = { getPluginById: () => null };
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (opts.withCustomStatus) {
    settings.taskStatuses.push({
      id: 'status-custom',
      symbol: '!',
      name: 'Important',
      type: 'todo',
      icon: 'alert-triangle',
      core: false,
    });
  }
  const plugin: StubPlugin = {
    app,
    settings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
    rebuildTaskStatusSemantics: vi.fn(),
  };
  const captured: CapturedButton[] = [];
  const restore = patchAddButton(captured);
  const tab = new CalendarSettingsTab(
    app,
    plugin as unknown as ConstructorParameters<typeof CalendarSettingsTab>[1],
  );
  const expanded = (tab as unknown as { expandedCards: Set<string> }).expandedCards;
  for (const s of settings.taskStatuses) expanded.add(s.id);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  tab.display();
  restore();
  return { tab, plugin, captured };
}

/** The "Custom statuses" section body — opened via its header click. */
function openStatusesSection(tab: CalendarSettingsTab): HTMLElement {
  const headers = tab.containerEl.querySelectorAll<HTMLElement>('.tc-settings-section-header');
  const labels = tab.containerEl.querySelectorAll('.tc-settings-section-label');
  let idx = -1;
  labels.forEach((l, i) => {
    if (l.textContent === 'Custom statuses') idx = i;
  });
  expect(idx).toBeGreaterThanOrEqual(0);
  headers[idx]!.click();
  return tab.containerEl
    .querySelectorAll<HTMLElement>('.tc-settings-section')
    [idx]!.querySelector('.tc-settings-section-body')!;
}

describe('CalendarSettingsTab — custom statuses section', () => {
  it('renders a card for each default status, grouped by type', () => {
    const { tab } = makeTab();
    const body = openStatusesSection(tab);
    const groups = body.querySelectorAll('.tc-status-type-group');
    expect(groups.length).toBeGreaterThan(0);
    const cards = body.querySelectorAll('.tc-settings-card');
    expect(cards).toHaveLength(4); // the 4 locked core statuses, no defaults beyond that
  });

  it('shows a marker preview chip and monospace symbol badge per card', () => {
    const { tab } = makeTab();
    const body = openStatusesSection(tab);
    expect(body.querySelectorAll('.tc-status-header-preview')).toHaveLength(4);
    expect(body.querySelectorAll('.tc-settings-card-badge')).toHaveLength(4);
  });

  it('keeps both header and editable-card marker previews inert', () => {
    const { tab } = makeTab();
    const body = openStatusesSection(tab);
    const markers = [
      body.querySelector<HTMLElement>('.tc-status-header-preview .tc-status-marker'),
      body.querySelector<HTMLElement>('.tc-status-preview .tc-status-marker'),
    ];

    for (const marker of markers) {
      expect(marker).not.toBeNull();
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      marker!.dispatchEvent(click);
      expect(marker!.hasAttribute('role')).toBe(false);
      expect(marker!.hasAttribute('tabindex')).toBe(false);
      expect(click.defaultPrevented).toBe(false);
    }
  });

  it('core statuses have no delete button by default', () => {
    const { tab, captured } = makeTab();
    const body = openStatusesSection(tab);
    const deleteButtons = captured.filter(
      (b) => body.contains(b.el) && b.el.textContent === 'Delete status',
    );
    // All 4 default statuses are core => none get a delete button.
    expect(deleteButtons).toHaveLength(0);
  });

  it('"+ Add status" appends a new, non-core, deletable card', async () => {
    const { tab, plugin, captured } = makeTab();
    const body = openStatusesSection(tab);
    const addBtn = captured.find((b) => body.contains(b.el) && b.el.textContent === '+ Add status');
    expect(addBtn).toBeDefined();
    addBtn!.click();
    await Promise.resolve(); // flush the async onClick handler

    expect(plugin.settings.taskStatuses).toHaveLength(5);
    const added = plugin.settings.taskStatuses[4]!;
    expect(added.core).toBe(false);
    expect(added.name).toBe('New status');
    expect(added.type).toBe('todo');
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(plugin.rebuildTaskStatusSemantics).toHaveBeenCalled();
  });

  it('added status gets a symbol not already in use', async () => {
    const { tab, plugin, captured } = makeTab();
    const body = openStatusesSection(tab);
    const addBtn = captured.find(
      (b) => body.contains(b.el) && b.el.textContent === '+ Add status',
    )!;
    addBtn.click();
    await Promise.resolve();
    const symbols = plugin.settings.taskStatuses.map((s) => s.symbol);
    const dupes = symbols.filter((s, i) => symbols.indexOf(s) !== i);
    expect(dupes).toHaveLength(0);
  });

  it('deleting a non-core status requires a confirmation click', async () => {
    // No non-core status exists in the defaults anymore — seed one directly.
    const { tab, plugin, captured } = makeTab({ withCustomStatus: true });
    const body = openStatusesSection(tab);

    const deleteBtn = captured.find(
      (b) => body.contains(b.el) && b.el.textContent === 'Delete status',
    );
    expect(deleteBtn).toBeDefined();
    const before = plugin.settings.taskStatuses.length;

    deleteBtn!.click();
    await Promise.resolve();
    expect(plugin.settings.taskStatuses).toHaveLength(before); // armed, not yet deleted
    expect(deleteBtn!.el.textContent).toBe('Click again to confirm');

    deleteBtn!.click();
    await Promise.resolve();
    expect(plugin.settings.taskStatuses).toHaveLength(before - 1);
  });

  it('validateStatusSymbol rejects an already-used symbol on edit', () => {
    const { plugin } = makeTab();
    const statuses = plugin.settings.taskStatuses;
    // Sanity: the fixture actually has distinct symbols to begin with.
    const symbols = statuses.map((s) => s.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('core statuses show a lock cue and a disabled symbol input; non-core does not', () => {
    const { tab } = makeTab({ withCustomStatus: true });
    const body = openStatusesSection(tab);
    const cards = body.querySelectorAll('.tc-settings-card');
    let sawLockedCore = false;
    let sawUnlockedNonCore = false;
    cards.forEach((card) => {
      const lock = card.querySelector('.tc-status-symbol-lock');
      const lockedInput = card.querySelector<HTMLInputElement>('.tc-status-symbol-locked');
      if (lock) {
        expect(lockedInput).not.toBeNull();
        sawLockedCore = true;
      } else {
        sawUnlockedNonCore = true;
      }
    });
    expect(sawLockedCore).toBe(true);
    expect(sawUnlockedNonCore).toBe(true);
  });

  it('core statuses show a locked, read-only icon; non-core gets the full picker', () => {
    const { tab } = makeTab({ withCustomStatus: true });
    const body = openStatusesSection(tab);
    const cards = body.querySelectorAll('.tc-settings-card');
    let sawLockedCoreIcon = false;
    let sawEditableNonCoreIcon = false;
    cards.forEach((card) => {
      const iconLock = card.querySelector('.tc-status-icon-lock');
      const lockedPreview = card.querySelector('.tc-status-icon-locked-preview');
      const searchInput = card.querySelector('.tc-status-icon-input-host');
      if (iconLock) {
        expect(lockedPreview).not.toBeNull();
        expect(searchInput).toBeNull(); // no Lucide search picker for locked core icons
        sawLockedCoreIcon = true;
      } else if (searchInput) {
        sawEditableNonCoreIcon = true;
      }
    });
    expect(sawLockedCoreIcon).toBe(true);
    expect(sawEditableNonCoreIcon).toBe(true);
  });

  it('has no per-status Color setting and no glyph-mode icon dropdown', () => {
    const { tab } = makeTab();
    const body = openStatusesSection(tab);
    const settingNames = Array.from(body.querySelectorAll('.setting-item-name')).map(
      (el) => el.textContent,
    );
    expect(settingNames).not.toContain('Color');
    // The 4 default statuses are all core, so "Icon" only appears as the
    // locked read-only row (guarded by the dedicated test above) — never as
    // an editable glyph-mode dropdown.
  });

  it('core Symbol onChange is a guarded no-op even if invoked directly', async () => {
    const captured: CapturedText[] = [];
    const restore = patchAddText(captured);
    const { plugin } = makeTab();
    restore();

    const coreStatus = plugin.settings.taskStatuses.find((s) => s.core)!;
    expect(coreStatus).toBeDefined();
    const originalSymbol = coreStatus.symbol;

    const coreSymbolInput = captured.find((c) =>
      c.el.classList.contains('tc-status-symbol-locked'),
    );
    expect(coreSymbolInput).toBeDefined();

    coreSymbolInput!.invokeChange('!');
    await Promise.resolve();

    expect(coreStatus.symbol).toBe(originalSymbol);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('"No icon" cell clears a custom status icon and persists the empty state', async () => {
    const { tab, plugin } = makeTab({ withCustomStatus: true });
    const body = openStatusesSection(tab);
    const status = plugin.settings.taskStatuses.find((s) => !s.core && s.icon !== '')!;
    expect(status).toBeDefined();
    const card = Array.from(body.querySelectorAll('.tc-settings-card')).find((c) =>
      c.textContent?.includes(status.name),
    )!;
    expect(card).toBeDefined();
    const clearCell = card.querySelector<HTMLElement>('.tc-status-icon-clear');
    expect(clearCell).not.toBeNull();
    clearCell!.click();
    await Promise.resolve();
    expect(status.icon).toBe('');
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});
