import { getIconIds, Notice, setIcon, Setting } from 'obsidian';
import { StatusRegistry } from '../../status/StatusRegistry';
import { TYPE_LABELS, TYPE_ORDER } from '../../status/statusConstants';
import type { TaskStatusType } from '../../tasks';
import { renderStatusMarker } from '../../ui/StatusMarker';
import { runAsyncAction } from '../../ui/runAsyncAction';
import type { CardListOptions } from '../settingsCard';
import type { TaskStatusDef } from '../types';

interface CardDragPayload {
  id: string;
  listKey: string;
  groupKey?: string;
}

function parseCardDragPayload(raw: string | undefined): CardDragPayload | null {
  if (raw === undefined || raw === '') return null;
  try {
    const payload = JSON.parse(raw) as Partial<CardDragPayload>;
    return typeof payload.id === 'string' && typeof payload.listKey === 'string'
      ? (payload as CardDragPayload)
      : null;
  } catch {
    return null;
  }
}

interface TaskStatusIconResults {
  host: HTMLElement;
  def: TaskStatusDef;
  iconIds: readonly string[];
  query: string;
  focusIcon?: string;
  selectIcon: (iconId: string) => void;
}

/** Returns an error message if `symbol` is invalid for a status, else null. */
export function validateStatusSymbol(
  symbol: string,
  all: Array<{ id: string; symbol: string }>,
  selfId: string,
): string | null {
  // Use UTF-16 code-unit length (not [...symbol] codepoint length): the bracket
  // symbol is matched by parser regexes without the `u` flag (`\[(.)\]`), so a
  // surrogate-pair emoji (2 code units) would pass validation here but then never
  // match as a task at all. Multi-codepoint icons are fine elsewhere (e.g. the
  // status icon), just not for this bracket symbol.
  if (symbol.length !== 1) return 'Symbol must be a single character';
  if (all.some((s) => s.id !== selfId && s.symbol === symbol))
    return 'Symbol already used by another status';
  return null;
}

export interface TaskStatusSettingsHost {
  readonly renderCards: (
    container: HTMLElement,
    items: TaskStatusDef[],
    options: CardListOptions<TaskStatusDef>,
  ) => void;
  readonly reorderStatuses: (
    items: TaskStatusDef[],
    draggedId: string,
    targetId: string,
  ) => boolean;
  readonly commitDraft: (action: string) => void;
  readonly persistStatuses: () => Promise<void>;
  readonly setExpanded: (id: string, expanded: boolean) => void;
}

export interface TaskStatusSettingsOptions {
  readonly statuses: () => TaskStatusDef[];
  readonly host: TaskStatusSettingsHost;
}

export class TaskStatusSettings {
  readonly #options: TaskStatusSettingsOptions;
  readonly #statusHeaderPreviewEls = new Map<string, HTMLElement>();
  readonly #deleteTimers = new Map<HTMLButtonElement, { ownerWindow: Window; timer: number }>();

  constructor(options: TaskStatusSettingsOptions) {
    this.#options = options;
  }

  resetRenderedControls(): void {
    this.#statusHeaderPreviewEls.clear();
    for (const { ownerWindow, timer } of this.#deleteTimers.values())
      ownerWindow.clearTimeout(timer);
    this.#deleteTimers.clear();
  }

  #moveStatusToGroup(id: string, targetType: TaskStatusType): void {
    const statuses = this.#options.statuses();
    const def = statuses.find((s) => s.id === id);
    if (def == null || def.type === targetType) return;
    if (def.core) return; // core cards cannot leave their own type group
    def.type = targetType;
    this.#options.host.commitDraft('move task status');
  }

  #reorderStatusWithinType(type: TaskStatusType, draggedId: string, targetId: string): boolean {
    const statuses = this.#options.statuses();
    if (
      statuses.find((status) => status.id === draggedId)?.type !== type ||
      statuses.find((status) => status.id === targetId)?.type !== type
    ) {
      return false;
    }
    return this.#options.host.reorderStatuses(statuses, draggedId, targetId);
  }

  render(containerEl: HTMLElement): void {
    const statuses = this.#options.statuses();
    const groupDefs: Array<{ type: TaskStatusType; label: string }> = TYPE_ORDER.map((type) => ({
      type,
      label: TYPE_LABELS[type],
    }));

    for (const { type, label } of groupDefs) {
      const groupEl = containerEl.createDiv({ cls: 'abyss-status-type-group' });
      groupEl.createDiv({ cls: 'abyss-status-type-group-label', text: label });
      const items = statuses.filter((s) => s.type === type);

      // Group-level drop zone catches drops on empty space (not over any card),
      // including into an otherwise-empty group.
      groupEl.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      groupEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const payload = parseCardDragPayload(e.dataTransfer?.getData('text/plain'));
        if (payload?.listKey !== 'task-statuses') return;
        if (payload.groupKey === type) return; // handled by a card's own drop listener
        this.#moveStatusToGroup(payload.id, type);
      });

      this.#options.host.renderCards(groupEl, items, {
        listKey: 'task-statuses',
        id: (s) => s.id,
        title: (s) => s.name,
        badge: (s) => s.symbol,
        preview: (headerEl, s) => {
          const previewEl = headerEl.createSpan({ cls: 'abyss-status-header-preview' });
          this.#statusHeaderPreviewEls.set(s.id, previewEl);
          this.#renderStatusHeaderPreview(s.id);
        },
        groupKey: type,
        onCrossGroupDrop: (id, targetType) => {
          this.#moveStatusToGroup(id, targetType as TaskStatusType);
        },
        body: (bodyEl, item) => {
          this.#renderTaskStatusCardBody(bodyEl, item);
        },
        onReorder: (draggedId, targetId) =>
          this.#reorderStatusWithinType(type, draggedId, targetId),
      });
    }

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('+ add status')
        .setCta()
        .onClick(() => {
          let n = statuses.length + 1;
          while (statuses.some((s) => s.id === `status-${n}`)) n++;
          const id = `status-${n}`;
          const used = new Set(statuses.map((s) => s.symbol));
          const printable =
            '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
          const symbol = [...printable].find((c) => !used.has(c)) ?? '?';
          statuses.push({
            id,
            symbol,
            name: 'New status',
            type: 'todo',
            icon: '',
            core: false,
          });
          this.#options.host.setExpanded(id, true);
          this.#options.host.commitDraft('add task status');
        }),
    );
  }

  /** Re-renders a status's collapsed-card header preview chip (e.g. after an icon edit). */
  #renderStatusHeaderPreview(statusId: string): void {
    const previewEl = this.#statusHeaderPreviewEls.get(statusId);
    if (previewEl == null) return;
    const statuses = this.#options.statuses();
    const def = statuses.find((s) => s.id === statusId);
    if (def == null) return;
    previewEl.empty();
    const registry = new StatusRegistry(statuses);
    renderStatusMarker(previewEl, {
      task: { statusSymbol: def.symbol, priority: 'D' },
      registry,
      interactive: false,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
  }

  #renderTaskStatusCardBody(bodyEl: HTMLElement, def: TaskStatusDef): void {
    const statuses = this.#options.statuses();
    let updatePreview: () => void = () => {};
    const refreshPreview = (): void => {
      updatePreview();
    };

    this.#renderTaskStatusNameSetting(bodyEl, def, refreshPreview);
    this.#renderTaskStatusSymbolSetting(bodyEl, def, statuses, refreshPreview);
    this.#renderTaskStatusIconSetting(bodyEl, def, refreshPreview);
    updatePreview = this.#renderTaskStatusPreview(bodyEl, def, statuses);
    updatePreview();
    if (!def.core) this.#renderDeleteTaskStatusSetting(bodyEl, def, statuses);
  }

  #renderTaskStatusNameSetting(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    updatePreview: () => void,
  ): void {
    new Setting(bodyEl).setName('Name').addText((t) =>
      t.setValue(def.name).onChange(async (v) => {
        def.name = v;
        await this.#options.host.persistStatuses();
        updatePreview();
      }),
    );
  }

  #renderTaskStatusSymbolSetting(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    statuses: TaskStatusDef[],
    updatePreview: () => void,
  ): void {
    const symbolSetting = new Setting(bodyEl).setName('Symbol');
    let symbolErrorEl: HTMLElement | null = null;
    if (def.core) {
      const lockEl = symbolSetting.nameEl.createSpan({ cls: 'abyss-status-symbol-lock' });
      setIcon(lockEl, 'lock');
      symbolSetting.setTooltip('Core status — symbol is fixed');
    }
    symbolSetting.addText((t) => {
      t.setValue(def.symbol).setDisabled(def.core);
      if (def.core) t.inputEl.addClass('abyss-status-symbol-locked');
      t.onChange(async (v) => {
        if (def.core) return;
        const err = validateStatusSymbol(v, statuses, def.id);
        if (err !== null && err !== '') {
          symbolErrorEl ??= symbolSetting.descEl.createDiv({ cls: 'abyss-status-symbol-error' });
          symbolErrorEl.setText(err);
          return;
        }
        if (symbolErrorEl != null) {
          symbolErrorEl.remove();
          symbolErrorEl = null;
        }
        def.symbol = v;
        await this.#options.host.persistStatuses();
        updatePreview();
      });
      return t;
    });
  }

  #renderTaskStatusIconSetting(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    updatePreview: () => void,
  ): void {
    if (def.core) this.#renderLockedTaskStatusIcon(bodyEl, def);
    else this.#renderEditableTaskStatusIcon(bodyEl, def, updatePreview);
  }

  #renderLockedTaskStatusIcon(bodyEl: HTMLElement, def: TaskStatusDef): void {
    const iconSetting = new Setting(bodyEl).setName('Icon');
    const lockEl = iconSetting.nameEl.createSpan({ cls: 'abyss-status-icon-lock' });
    setIcon(lockEl, 'lock');
    iconSetting.setTooltip('Core status — icon is fixed');
    const lockedPreview = iconSetting.controlEl.createDiv({
      cls: 'abyss-status-icon-locked-preview',
    });
    if (def.icon !== '') setIcon(lockedPreview, def.icon);
    else lockedPreview.createSpan({ cls: 'abyss-status-icon-result-icon', text: '—' });
  }

  #availableStatusIconIds(): string[] {
    const seen = new Set<string>();
    const iconIds: string[] = [];
    for (const raw of getIconIds()) {
      const iconId = raw.startsWith('lucide-') ? raw.slice('lucide-'.length) : raw;
      if (seen.has(iconId)) continue;
      seen.add(iconId);
      iconIds.push(iconId);
    }
    return iconIds;
  }

  #renderEditableTaskStatusIcon(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    updatePreview: () => void,
  ): void {
    const iconWrap = bodyEl.createDiv({ cls: 'abyss-status-icon-field' });
    const inputHost = iconWrap.createDiv({ cls: 'abyss-status-icon-input-host' });
    const iconIds = this.#availableStatusIconIds();
    let renderResults: (query: string, focusIcon?: string) => void = () => {};
    new Setting(inputHost).setName('Search icons').addText((text) =>
      text
        .setPlaceholder('Search lucide icons…')
        .setValue('')
        .onChange((query) => {
          renderResults(query);
        }),
    );
    const resultsHost = inputHost.createDiv({ cls: 'abyss-status-icon-results' });
    renderResults = (query, focusIcon) => {
      const selectIcon = (iconId: string): void => {
        def.icon = iconId;
        runAsyncAction(this.#options.host.persistStatuses());
        renderResults(query, iconId);
        updatePreview();
        this.#renderStatusHeaderPreview(def.id);
      };
      this.#renderTaskStatusIconResults({
        host: resultsHost,
        def,
        iconIds,
        query,
        ...(focusIcon === undefined ? {} : { focusIcon }),
        selectIcon,
      });
    };
    renderResults('');
  }

  #renderTaskStatusIconResults(results: TaskStatusIconResults): void {
    results.host.empty();
    this.#renderClearTaskStatusIcon(results);
    const query = results.query.trim().toLowerCase();
    const matchingIds = results.iconIds
      .filter((iconId) => query === '' || iconId.toLowerCase().includes(query))
      .slice(0, 48);
    if (matchingIds.length === 0) {
      results.host.createDiv({ cls: 'abyss-status-icon-empty', text: 'No icons found' });
    } else {
      for (const iconId of matchingIds) this.#renderTaskStatusIconResult(results, iconId);
    }
    this.#focusTaskStatusIconResult(results);
  }

  #renderClearTaskStatusIcon(results: TaskStatusIconResults): void {
    const clearCell = results.host.createEl('button', {
      cls: `abyss-status-icon-result abyss-status-icon-clear${results.def.icon === '' ? ' is-selected' : ''}`,
      attr: {
        type: 'button',
        title: 'No icon',
        'data-icon': '',
        'aria-label': 'Clear icon',
        'aria-pressed': String(results.def.icon === ''),
      },
    });
    clearCell.createSpan({ cls: 'abyss-status-icon-result-icon', text: '—' });
    clearCell.addEventListener('click', () => {
      results.selectIcon('');
    });
  }

  #renderTaskStatusIconResult(results: TaskStatusIconResults, iconId: string): void {
    const cell = results.host.createEl('button', {
      cls: `abyss-status-icon-result${iconId === results.def.icon ? ' is-selected' : ''}`,
      attr: {
        type: 'button',
        title: iconId,
        'data-icon': iconId,
        'aria-label': `Select icon ${iconId}`,
        'aria-pressed': String(iconId === results.def.icon),
      },
    });
    const iconPreview = cell.createSpan({ cls: 'abyss-status-icon-result-icon' });
    setIcon(iconPreview, iconId);
    cell.addEventListener('click', () => {
      results.selectIcon(iconId);
    });
  }

  #focusTaskStatusIconResult(results: TaskStatusIconResults): void {
    if (results.focusIcon === undefined) return;
    const cell = Array.from(
      results.host.querySelectorAll<HTMLButtonElement>('.abyss-status-icon-result'),
    ).find((button) => button.dataset['icon'] === results.focusIcon);
    cell?.focus({ preventScroll: true });
  }

  #renderTaskStatusPreview(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    statuses: TaskStatusDef[],
  ): () => void {
    const previewSetting = new Setting(bodyEl).setName('Preview');
    const previewHost = previewSetting.controlEl.createDiv({ cls: 'abyss-status-preview' });
    return () => {
      previewHost.empty();
      const registry = new StatusRegistry(statuses);
      renderStatusMarker(previewHost, {
        task: { statusSymbol: def.symbol, priority: 'D' },
        registry,
        interactive: false,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
      previewHost.createSpan({
        cls: 'abyss-status-preview-title',
        text: def.name !== '' ? def.name : 'Sample task',
      });
    };
  }

  #renderDeleteTaskStatusSetting(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    statuses: TaskStatusDef[],
  ): void {
    let armed = false;
    new Setting(bodyEl).addButton((button) =>
      button
        .setButtonText('Delete status')
        .setClass('mod-warning')
        .onClick(() => {
          if (!armed) {
            armed = true;
            button.setButtonText('Click again to confirm');
            new Notice('Deleting this status: tasks using it will fall back to plain to-do.');
            const ownerWindow = button.buttonEl.ownerDocument.defaultView;
            if (ownerWindow !== null) {
              const timer = ownerWindow.setTimeout(() => {
                this.#deleteTimers.delete(button.buttonEl);
                armed = false;
                button.setButtonText('Delete status');
              }, 4000);
              this.#deleteTimers.set(button.buttonEl, { ownerWindow, timer });
            }
            return;
          }
          const index = statuses.findIndex((status) => status.id === def.id);
          if (index >= 0) statuses.splice(index, 1);
          this.#options.host.setExpanded(def.id, false);
          this.#options.host.commitDraft('delete task status');
        }),
    );
  }
}
