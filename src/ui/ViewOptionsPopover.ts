import { setIcon } from 'obsidian';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

export interface ViewOptionAction {
  readonly label: string | (() => string);
  readonly ariaLabel: string;
  readonly onSelect: (
    event: MouseEvent,
    run: (action: () => void | Promise<void>) => void,
    ownChild: (element: HTMLElement, close: () => void) => () => void,
  ) => void | Promise<void>;
}

export interface ViewOption {
  readonly label: string;
  readonly value: string;
  readonly isDefault?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly action?: ViewOptionAction;
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
  readonly onMove?: (
    value: string,
    direction: 'up' | 'down',
    targetValue: string,
  ) => void | Promise<void>;
}

interface ViewOptionsGroupRow extends ViewOptionsRowBase {
  readonly kind: 'group';
  readonly rows: readonly ViewOptionsRow[];
}

export type ViewOptionsRow = ViewOptionsSingleRow | ViewOptionsMultiRow | ViewOptionsGroupRow;

export interface OpenViewOptionsPopoverOptions {
  readonly host: HTMLElement;
  readonly anchor: HTMLElement;
  readonly rows: readonly ViewOptionsRow[];
  readonly showReset?: boolean;
  readonly onReset?: () => void;
  readonly interactionOwnership?: InteractionOwnershipPort;
  readonly onClose?: () => void;
}

function closeRow(row: HTMLElement): void {
  row.querySelectorAll<HTMLElement>('.abyss-view-state-sublist').forEach((element) => {
    element.addClass('abyss-hidden');
  });
  row.querySelectorAll<HTMLElement>('.abyss-view-state-row-main').forEach((element) => {
    element.removeClass('is-open');
    element.setAttribute('aria-expanded', 'false');
  });
}

function closeSiblingRows(host: HTMLElement, retained: HTMLElement): void {
  for (const child of host.children) {
    if (
      child !== retained &&
      child.instanceOf(HTMLElement) &&
      child.hasClass('abyss-view-state-row')
    ) {
      closeRow(child);
    }
  }
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
  readonly actionButton?: HTMLButtonElement;
}

type OwnChild = (element: HTMLElement, close: () => void) => () => void;

interface MultiOptionRuntime {
  readonly sync: () => void;
  readonly ownChild: OwnChild;
}

function selectedValues(spec: ViewOptionsMultiRow): readonly string[] {
  return typeof spec.selected === 'function' ? spec.selected() : spec.selected;
}

function currentDisplayValue(spec: ViewOptionsRow): string {
  return typeof spec.displayValue === 'function' ? spec.displayValue() : spec.displayValue;
}

function currentActionLabel(action: ViewOptionAction): string {
  return typeof action.label === 'function' ? action.label() : action.label;
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
  }
  if (rendered.actionButton !== undefined && rendered.option.action !== undefined) {
    rendered.actionButton.setText(currentActionLabel(rendered.option.action));
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
  if (focused?.instanceOf(HTMLElement) === true && focused.isConnected && host.contains(focused)) {
    focused.focus({ preventScroll: true });
  }
}

function renderMultiPresets(sublist: HTMLElement, spec: ViewOptionsMultiRow): void {
  for (const preset of spec.presets ?? []) {
    optionButton(sublist, preset.label, preset.active === true).addEventListener('click', () => {
      preset.onSelect();
    });
  }
  if ((spec.presets?.length ?? 0) > 0) {
    sublist.createDiv({ cls: 'abyss-view-state-sublist-divider' });
  }
}

function renderOptionAction(
  row: HTMLElement,
  option: ViewOption,
  sync: () => void,
  ownChild: OwnChild,
): HTMLButtonElement | undefined {
  if (option.action === undefined) return undefined;
  const action = option.action;
  const button = row.createEl('button', {
    cls: 'abyss-view-state-option-action',
    text: currentActionLabel(action),
    attr: { type: 'button', 'aria-label': action.ariaLabel },
  });
  button.addEventListener('click', (event) => {
    runOptionAction(() =>
      action.onSelect(
        event,
        (callback) => {
          runOptionAction(callback, sync);
        },
        ownChild,
      ),
    );
  });
  return button;
}

function renderMoveButtons(
  row: HTMLElement,
  option: ViewOption,
  spec: ViewOptionsMultiRow,
  sync: () => void,
): HTMLButtonElement[] {
  const onMove = spec.onMove;
  if (onMove === undefined || option.disabled === true || option.required === true) return [];
  return (['up', 'down'] as const).map((direction) => {
    const move = row.createEl('button', {
      cls: 'abyss-view-state-option-move',
      attr: { type: 'button', 'aria-label': `Move ${option.label} ${direction}` },
    });
    setIcon(move, direction === 'up' ? 'chevron-up' : 'chevron-down');
    move.addEventListener('click', () => {
      const selected = selectedValues(spec);
      const index = selected.indexOf(option.value);
      const targetValue = selected[index + (direction === 'up' ? -1 : 1)];
      if (targetValue !== undefined) {
        runOptionAction(() => onMove(option.value, direction, targetValue), sync);
      }
    });
    return move;
  });
}

function renderMultiOption(
  host: HTMLElement,
  option: ViewOption,
  spec: ViewOptionsMultiRow,
  runtime: MultiOptionRuntime,
): RenderedMultiOption {
  const row = host.createDiv({ cls: 'abyss-view-state-option-row' });
  const button = optionButton(row, option.label, false);
  button.disabled = option.disabled === true;
  if (option.required === true) {
    button.createSpan({ cls: 'abyss-view-state-option-required', text: 'Required' });
  }
  const check = button.querySelector<HTMLElement>('.abyss-view-state-option-check');
  if (check === null) throw new Error('View option check marker was not rendered.');
  button.addEventListener('click', () => {
    runOptionAction(() => spec.onToggle(option.value), runtime.sync);
  });
  const actionButton = renderOptionAction(row, option, runtime.sync, runtime.ownChild);
  return {
    option,
    row,
    button,
    check,
    moveButtons: renderMoveButtons(row, option, spec, runtime.sync),
    ...(actionButton === undefined ? {} : { actionButton }),
  };
}

function renderMultiOptions(
  sublist: HTMLElement,
  spec: ViewOptionsMultiRow,
  summary: HTMLElement,
  ownChild: OwnChild,
): void {
  renderMultiPresets(sublist, spec);
  const optionsHost = sublist.createDiv({ cls: 'abyss-view-state-options' });
  const renderedRows: RenderedMultiOption[] = [];
  const sync = (): void => {
    syncMultiOptions(optionsHost, spec, renderedRows, summary);
  };
  for (const option of spec.options) {
    renderedRows.push(renderMultiOption(optionsHost, option, spec, { sync, ownChild }));
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
    button.disabled = option.disabled === true;
    if (option.isDefault === true) {
      button.createSpan({ cls: 'abyss-view-state-option-default', text: 'Default' });
    }
    button.addEventListener('click', () => {
      close();
      runOptionAction(() => spec.onSelect(option.value));
    });
  }
}

function renderRow(
  host: HTMLElement,
  spec: ViewOptionsRow,
  close: () => void,
  ownChild: OwnChild,
): void {
  const row = host.createDiv({ cls: 'abyss-view-state-row' });
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
    closeSiblingRows(host, row);
    if (open) {
      sublist.removeClass('abyss-hidden');
      main.addClass('is-open');
      main.setAttribute('aria-expanded', 'true');
    } else {
      closeRow(row);
    }
  };
  main.addEventListener('click', toggle);

  if (spec.kind === 'multi') renderMultiOptions(sublist, spec, summary, ownChild);
  else if (spec.kind === 'single') renderSingleOptions(sublist, spec, close);
  else for (const child of spec.rows) renderRow(sublist, child, close, ownChild);
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
  const ownedChildren = new Map<HTMLElement, () => void>();
  const close = (restoreFocus = false): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    if (listening) ownerDocument.removeEventListener('click', dismiss, true);
    popover.remove();
    const childCleanups = [...ownedChildren.values()];
    ownedChildren.clear();
    for (const cleanup of childCleanups) cleanup();
    ownership.release();
    options.onClose?.();
    if (restoreFocus && options.anchor.isConnected) options.anchor.focus();
  };
  const dismiss = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (popover.contains(target) || event.target === options.anchor) return;
    for (const child of ownedChildren.keys()) {
      if (child.contains(target)) return;
    }
    close();
  };
  const ownChild = (element: HTMLElement, closeChild: () => void): (() => void) => {
    ownedChildren.set(element, closeChild);
    return (): void => {
      if (ownedChildren.get(element) === closeChild) ownedChildren.delete(element);
    };
  };
  popover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  for (const row of options.rows) renderRow(popover, row, close, ownChild);
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
