import { setIcon } from 'obsidian';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

interface ViewOption {
  readonly label: string;
  readonly value: string;
  readonly isDefault?: boolean;
}

interface ViewOptionsRowBase {
  readonly icon: string;
  readonly label: string;
  readonly displayValue: string | (() => string);
  readonly initiallyOpen?: boolean;
}

export interface ViewOptionsSingleRow extends ViewOptionsRowBase {
  readonly kind: 'single';
  readonly activeValue: string;
  readonly options: readonly ViewOption[];
  readonly onSelect: (value: string) => void | Promise<void>;
}

export interface ViewOptionsMultiRow extends ViewOptionsRowBase {
  readonly kind: 'multi';
  readonly selected: readonly string[] | (() => readonly string[]);
  readonly options: readonly ViewOption[];
  readonly presets?: ReadonlyArray<{ label: string; active?: boolean; onSelect: () => void }>;
  readonly onToggle: (value: string) => void | Promise<void>;
  readonly onMove?: (value: string, direction: 'up' | 'down') => void | Promise<void>;
}

export type ViewOptionsRow = ViewOptionsSingleRow | ViewOptionsMultiRow;

export interface OpenViewOptionsPopoverOptions {
  readonly host: HTMLElement;
  readonly anchor: HTMLElement;
  readonly rows: readonly ViewOptionsRow[];
  readonly showReset?: boolean;
  readonly onReset?: () => void;
  readonly interactionOwnership?: InteractionOwnershipPort;
  readonly onClose?: () => void;
}

function closeSublists(popover: HTMLElement): void {
  popover.querySelectorAll<HTMLElement>('.abyss-view-state-sublist').forEach((element) => {
    element.addClass('abyss-hidden');
  });
  popover.querySelectorAll<HTMLElement>('.abyss-view-state-row-main').forEach((element) => {
    element.removeClass('is-open');
    element.setAttribute('aria-expanded', 'false');
  });
}

function optionButton(host: HTMLElement, label: string, active: boolean): HTMLButtonElement {
  const button = host.createEl('button', {
    cls: 'abyss-view-state-option',
    attr: { type: 'button', 'aria-pressed': String(active) },
  });
  const check = button.createSpan({ cls: 'abyss-view-state-option-check' });
  if (active) setIcon(check, 'check');
  button.createSpan({ cls: 'abyss-view-state-option-label', text: label });
  return button;
}

interface RenderedMultiOption {
  readonly option: ViewOption;
  readonly row: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly check: HTMLElement;
  readonly moveButtons: readonly HTMLButtonElement[];
}

function selectedValues(spec: ViewOptionsMultiRow): readonly string[] {
  return typeof spec.selected === 'function' ? spec.selected() : spec.selected;
}

function currentDisplayValue(spec: ViewOptionsRow): string {
  return typeof spec.displayValue === 'function' ? spec.displayValue() : spec.displayValue;
}

function compareMultiOptions(
  left: RenderedMultiOption,
  right: RenderedMultiOption,
  rank: ReadonlyMap<string, number>,
  rows: readonly RenderedMultiOption[],
): number {
  const leftRank = rank.get(left.option.value);
  const rightRank = rank.get(right.option.value);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  if (leftRank !== undefined) return -1;
  if (rightRank !== undefined) return 1;
  return rows.indexOf(left) - rows.indexOf(right);
}

function syncMultiOption(rendered: RenderedMultiOption, active: boolean): void {
  rendered.button.setAttribute('aria-pressed', String(active));
  rendered.check.empty();
  if (active) setIcon(rendered.check, 'check');
  for (const move of rendered.moveButtons) {
    move.hidden = !active;
    move.disabled = false;
  }
}

function reportOptionError(error: unknown): void {
  console.error('[abyss-tasks] Could not update view options', error);
}

function runOptionAction(action: () => void | Promise<void>, onSettled?: () => void): void {
  let result: void | Promise<void>;
  try {
    result = action();
  } catch (error) {
    reportOptionError(error);
    return;
  }
  Promise.resolve(result).then(onSettled).catch(reportOptionError);
}

function syncMultiOptions(
  host: HTMLElement,
  spec: ViewOptionsMultiRow,
  rows: RenderedMultiOption[],
  summary: HTMLElement,
): void {
  const selected = selectedValues(spec);
  const rank = new Map(selected.map((value, index) => [value, index]));
  const focused = host.ownerDocument.activeElement;
  const ordered = [...rows].sort((left, right) => compareMultiOptions(left, right, rank, rows));
  for (const rendered of ordered) host.append(rendered.row);
  for (const rendered of rows) {
    syncMultiOption(rendered, rank.has(rendered.option.value));
  }
  summary.setText(currentDisplayValue(spec));
  if (focused instanceof HTMLElement && focused.isConnected && host.contains(focused)) {
    focused.focus({ preventScroll: true });
  }
}

function renderMultiOptions(
  sublist: HTMLElement,
  spec: ViewOptionsMultiRow,
  summary: HTMLElement,
): void {
  for (const preset of spec.presets ?? []) {
    optionButton(sublist, preset.label, preset.active === true).addEventListener('click', () => {
      preset.onSelect();
    });
  }
  if ((spec.presets?.length ?? 0) > 0) {
    sublist.createDiv({ cls: 'abyss-view-state-sublist-divider' });
  }
  const optionsHost = sublist.createDiv({ cls: 'abyss-view-state-options' });
  const renderedRows: RenderedMultiOption[] = [];
  const sync = (): void => {
    syncMultiOptions(optionsHost, spec, renderedRows, summary);
  };
  for (const option of spec.options) {
    const row = optionsHost.createDiv({ cls: 'abyss-view-state-option-row' });
    const button = optionButton(row, option.label, false);
    const check = button.querySelector<HTMLElement>('.abyss-view-state-option-check');
    if (check === null) continue;
    button.addEventListener('click', () => {
      runOptionAction(() => spec.onToggle(option.value), sync);
    });
    const moveButtons = (['up', 'down'] as const).flatMap((direction) => {
      const onMove = spec.onMove;
      if (onMove === undefined) return [];
      const move = row.createEl('button', {
        cls: 'abyss-view-state-option-move',
        attr: { type: 'button', 'aria-label': `Move ${option.label} ${direction}` },
      });
      setIcon(move, direction === 'up' ? 'chevron-up' : 'chevron-down');
      move.addEventListener('click', () => {
        runOptionAction(() => onMove(option.value, direction), sync);
      });
      return [move];
    });
    renderedRows.push({ option, row, button, check, moveButtons });
  }
  sync();
}

function renderSingleOptions(
  sublist: HTMLElement,
  spec: ViewOptionsSingleRow,
  close: () => void,
): void {
  for (const option of spec.options) {
    const button = optionButton(sublist, option.label, option.value === spec.activeValue);
    if (option.isDefault === true) {
      button.createSpan({ cls: 'abyss-view-state-option-default', text: 'Default' });
    }
    button.addEventListener('click', () => {
      close();
      runOptionAction(() => spec.onSelect(option.value));
    });
  }
}

function renderRow(popover: HTMLElement, spec: ViewOptionsRow, close: () => void): void {
  const row = popover.createDiv({ cls: 'abyss-view-state-row' });
  const initiallyOpen = spec.initiallyOpen === true;
  const main = row.createEl('button', {
    cls: `abyss-view-state-row-main${initiallyOpen ? ' is-open' : ''}`,
    attr: { type: 'button', 'aria-expanded': String(initiallyOpen) },
  });
  const icon = main.createSpan({ cls: 'abyss-view-state-row-icon' });
  setIcon(icon, spec.icon);
  main.createSpan({ cls: 'abyss-view-state-row-label', text: spec.label });
  const summary = main.createSpan({
    cls: 'abyss-view-state-row-value',
    text: currentDisplayValue(spec),
  });
  const chevron = main.createSpan({ cls: 'abyss-view-state-row-chevron' });
  setIcon(chevron, 'chevron-right');
  const sublist = row.createDiv({
    cls: `abyss-view-state-sublist${initiallyOpen ? '' : ' abyss-hidden'}`,
  });
  const toggle = (): void => {
    const open = sublist.hasClass('abyss-hidden');
    closeSublists(popover);
    if (open) {
      sublist.removeClass('abyss-hidden');
      main.addClass('is-open');
      main.setAttribute('aria-expanded', 'true');
    }
  };
  main.addEventListener('click', toggle);

  if (spec.kind === 'multi') renderMultiOptions(sublist, spec, summary);
  else renderSingleOptions(sublist, spec, close);
}

/** Opens the shared task/project sort and grouping surface and returns idempotent cleanup. */
export function openViewOptionsPopover(options: OpenViewOptionsPopoverOptions): () => void {
  const popover = options.host.createDiv({
    cls: 'abyss-view-state-popover abyss-popover',
    attr: { role: 'dialog', 'aria-label': 'Sort and group options' },
  });
  const ownerDocument = popover.ownerDocument;
  const ownership = (options.interactionOwnership ?? noInteractionOwnership).acquire({
    blocksShortcuts: true,
  });
  let timer: number | undefined;
  let listening = false;
  let closed = false;
  const close = (restoreFocus = false): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    if (listening) ownerDocument.removeEventListener('click', dismiss, true);
    popover.remove();
    ownership.release();
    options.onClose?.();
    if (restoreFocus && options.anchor.isConnected) options.anchor.focus();
  };
  const dismiss = (event: MouseEvent): void => {
    if (!popover.contains(event.target as Node) && event.target !== options.anchor) close();
  };
  popover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  for (const row of options.rows) renderRow(popover, row, close);
  if (options.showReset === true && options.onReset !== undefined) {
    const reset = popover.createDiv({ cls: 'abyss-view-state-reset' }).createEl('button', {
      cls: 'abyss-view-state-reset-btn',
      text: 'Reset to defaults',
      attr: { type: 'button' },
    });
    reset.addEventListener('click', () => {
      close();
      options.onReset?.();
    });
  }
  options.anchor.after(popover);
  popover.querySelector<HTMLElement>('.abyss-view-state-row-main')?.focus();
  timer = window.setTimeout(() => {
    timer = undefined;
    if (!popover.isConnected) return;
    ownerDocument.addEventListener('click', dismiss, true);
    listening = true;
  }, 0);
  return close;
}
