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
  readonly label: string | (() => string);
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
  readonly activeValue: string | (() => string);
  readonly options: readonly ViewOption[];
  readonly onSelect: (value: string) => void | Promise<void>;
}

export interface ViewOptionsMultiRow extends ViewOptionsRowBase {
  readonly kind: 'multi';
  readonly selected: readonly string[] | (() => readonly string[]);
  readonly options: readonly ViewOption[];
  readonly presets?: ReadonlyArray<{
    label: string;
    active?: boolean | (() => boolean);
    onSelect: () => void | Promise<void>;
  }>;
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
  readonly showReset?: boolean | (() => boolean);
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
  readonly label: HTMLElement;
  readonly moveButtons: ReadonlyArray<{
    readonly button: HTMLButtonElement;
    readonly direction: 'up' | 'down';
  }>;
  readonly actionButton?: HTMLButtonElement;
}

interface RenderedSingleOption {
  readonly option: ViewOption;
  readonly button: HTMLButtonElement;
  readonly check: HTMLElement;
  readonly label: HTMLElement;
}

type OwnChild = (element: HTMLElement, close: () => void) => () => void;

interface MultiOptionRuntime {
  readonly sync: () => void;
  readonly ownChild: OwnChild;
}

interface ViewOptionsRuntime {
  readonly ownChild: OwnChild;
  readonly syncRows: Array<() => void>;
  readonly syncAll: () => void;
}

interface ScrollPosition {
  readonly element: HTMLElement;
  readonly top: number;
}

function selectedValues(spec: ViewOptionsMultiRow): readonly string[] {
  return typeof spec.selected === 'function' ? spec.selected() : spec.selected;
}

function currentDisplayValue(spec: ViewOptionsRow): string {
  return typeof spec.displayValue === 'function' ? spec.displayValue() : spec.displayValue;
}

function currentOptionLabel(option: ViewOption): string {
  return typeof option.label === 'function' ? option.label() : option.label;
}

function currentActiveValue(spec: ViewOptionsSingleRow): string {
  return typeof spec.activeValue === 'function' ? spec.activeValue() : spec.activeValue;
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
  const label = currentOptionLabel(rendered.option);
  rendered.button.setAttribute('aria-pressed', String(active));
  rendered.check.empty();
  rendered.label.setText(label);
  if (active) setIcon(rendered.check, 'check');
  for (const move of rendered.moveButtons) {
    move.button.hidden = !active;
    move.button.setAttribute('aria-label', `Move ${label} ${move.direction}`);
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

function captureScrollPositions(host: HTMLElement): ScrollPosition[] {
  const positions: ScrollPosition[] = [];
  for (let element: HTMLElement | null = host; element !== null; element = element.parentElement) {
    positions.push({ element, top: element.scrollTop });
  }
  return positions;
}

function reconcileMultiOptionOrder(
  host: HTMLElement,
  ordered: readonly RenderedMultiOption[],
): void {
  let cursor = host.firstElementChild;
  for (const rendered of ordered) {
    if (rendered.row === cursor) cursor = cursor.nextElementSibling;
    else host.insertBefore(rendered.row, cursor);
  }
}

function restoreContainedFocus(host: HTMLElement, focused: Element | null): void {
  if (focused?.instanceOf(HTMLElement) !== true || !focused.isConnected) return;
  if (!host.contains(focused) || host.ownerDocument.activeElement === focused) return;
  focused.focus({ preventScroll: true });
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
  const scrollPositions = captureScrollPositions(host);
  const ordered = [...rows].sort((left, right) => compareMultiOptions(left, right, rank, rows));
  reconcileMultiOptionOrder(host, ordered);
  for (const rendered of rows) {
    syncMultiOption(rendered, rank.has(rendered.option.value));
  }
  summary.setText(currentDisplayValue(spec));
  restoreContainedFocus(host, focused);
  for (const position of scrollPositions) position.element.scrollTop = position.top;
}

function renderMultiPresets(
  sublist: HTMLElement,
  spec: ViewOptionsMultiRow,
  syncAll: () => void,
  syncRows: Array<() => void>,
): void {
  for (const preset of spec.presets ?? []) {
    const button = optionButton(
      sublist,
      preset.label,
      typeof preset.active === 'function' ? preset.active() : preset.active === true,
    );
    const check = button.querySelector<HTMLElement>('.abyss-view-state-option-check');
    if (check === null) throw new Error('View option check marker was not rendered.');
    const sync = (): void => {
      const active = typeof preset.active === 'function' ? preset.active() : preset.active === true;
      button.setAttribute('aria-pressed', String(active));
      check.empty();
      if (active) setIcon(check, 'check');
    };
    syncRows.push(sync);
    button.addEventListener('click', () => {
      runOptionAction(preset.onSelect, syncAll);
    });
    sync();
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
): Array<{ readonly button: HTMLButtonElement; readonly direction: 'up' | 'down' }> {
  const onMove = spec.onMove;
  if (onMove === undefined || option.disabled === true || option.required === true) return [];
  return (['up', 'down'] as const).map((direction) => {
    const label = currentOptionLabel(option);
    const button = row.createEl('button', {
      cls: 'abyss-view-state-option-move',
      attr: { type: 'button', 'aria-label': `Move ${label} ${direction}` },
    });
    setIcon(button, direction === 'up' ? 'chevron-up' : 'chevron-down');
    button.addEventListener('click', () => {
      const selected = selectedValues(spec);
      const index = selected.indexOf(option.value);
      const targetValue = selected[index + (direction === 'up' ? -1 : 1)];
      if (targetValue !== undefined) {
        runOptionAction(() => onMove(option.value, direction, targetValue), sync);
      }
    });
    return { button, direction };
  });
}

function renderMultiOption(
  host: HTMLElement,
  option: ViewOption,
  spec: ViewOptionsMultiRow,
  runtime: MultiOptionRuntime,
): RenderedMultiOption {
  const row = host.createDiv({ cls: 'abyss-view-state-option-row' });
  const button = optionButton(row, currentOptionLabel(option), false);
  button.disabled = option.disabled === true;
  if (option.required === true) {
    button.createSpan({ cls: 'abyss-view-state-option-required', text: 'Required' });
  }
  const check = button.querySelector<HTMLElement>('.abyss-view-state-option-check');
  const label = button.querySelector<HTMLElement>('.abyss-view-state-option-label');
  if (check === null) throw new Error('View option check marker was not rendered.');
  if (label === null) throw new Error('View option label was not rendered.');
  button.addEventListener('click', () => {
    runOptionAction(() => spec.onToggle(option.value), runtime.sync);
  });
  const actionButton = renderOptionAction(row, option, runtime.sync, runtime.ownChild);
  return {
    option,
    row,
    button,
    check,
    label,
    moveButtons: renderMoveButtons(row, option, spec, runtime.sync),
    ...(actionButton === undefined ? {} : { actionButton }),
  };
}

function renderMultiOptions(
  sublist: HTMLElement,
  spec: ViewOptionsMultiRow,
  summary: HTMLElement,
  runtime: ViewOptionsRuntime,
): void {
  renderMultiPresets(sublist, spec, runtime.syncAll, runtime.syncRows);
  const optionsHost = sublist.createDiv({ cls: 'abyss-view-state-options' });
  const renderedRows: RenderedMultiOption[] = [];
  const sync = (): void => {
    syncMultiOptions(optionsHost, spec, renderedRows, summary);
  };
  runtime.syncRows.push(sync);
  for (const option of spec.options) {
    renderedRows.push(
      renderMultiOption(optionsHost, option, spec, {
        sync: runtime.syncAll,
        ownChild: runtime.ownChild,
      }),
    );
  }
  sync();
}

function renderSingleOptions(
  sublist: HTMLElement,
  spec: ViewOptionsSingleRow,
  summary: HTMLElement,
  runtime: ViewOptionsRuntime,
): void {
  const rendered: RenderedSingleOption[] = [];
  const sync = (): void => {
    const activeValue = currentActiveValue(spec);
    summary.setText(currentDisplayValue(spec));
    for (const item of rendered) {
      const active = item.option.value === activeValue;
      item.button.setAttribute('aria-pressed', String(active));
      item.check.empty();
      item.label.setText(currentOptionLabel(item.option));
      if (active) setIcon(item.check, 'check');
    }
  };
  runtime.syncRows.push(sync);
  for (const option of spec.options) {
    const button = optionButton(
      sublist,
      currentOptionLabel(option),
      option.value === currentActiveValue(spec),
    );
    button.disabled = option.disabled === true;
    if (option.isDefault === true) {
      button.createSpan({ cls: 'abyss-view-state-option-default', text: 'Default' });
    }
    const check = button.querySelector<HTMLElement>('.abyss-view-state-option-check');
    const label = button.querySelector<HTMLElement>('.abyss-view-state-option-label');
    if (check === null || label === null) throw new Error('View option content was not rendered.');
    rendered.push({ option, button, check, label });
    button.addEventListener('click', () => {
      runOptionAction(() => spec.onSelect(option.value), runtime.syncAll);
    });
  }
  sync();
}

function renderRow(host: HTMLElement, spec: ViewOptionsRow, runtime: ViewOptionsRuntime): void {
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

  if (spec.kind === 'multi') {
    renderMultiOptions(sublist, spec, summary, runtime);
  } else if (spec.kind === 'single') {
    renderSingleOptions(sublist, spec, summary, runtime);
  } else {
    runtime.syncRows.push(() => {
      summary.setText(currentDisplayValue(spec));
    });
    for (const child of spec.rows) renderRow(sublist, child, runtime);
  }
}

function resetControlSync(
  popover: HTMLElement,
  options: Pick<OpenViewOptionsPopoverOptions, 'showReset' | 'onReset'>,
  close: () => void,
): () => void {
  let reset: HTMLElement | undefined;
  return (): void => {
    const visible =
      typeof options.showReset === 'function' ? options.showReset() : options.showReset === true;
    if (!visible || options.onReset === undefined) {
      reset?.remove();
      reset = undefined;
      return;
    }
    if (reset !== undefined) return;
    reset = popover.createDiv({ cls: 'abyss-view-state-reset' });
    const button = reset.createEl('button', {
      cls: 'abyss-view-state-reset-btn',
      text: 'Reset to defaults',
      attr: { type: 'button' },
    });
    button.addEventListener('click', () => {
      close();
      options.onReset?.();
    });
  };
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
  const syncRows: Array<() => void> = [];
  const syncAll = (): void => {
    for (const sync of syncRows) sync();
  };
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
  const runtime: ViewOptionsRuntime = { ownChild, syncRows, syncAll };
  popover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  for (const row of options.rows) renderRow(popover, row, runtime);
  if (options.showReset !== undefined) {
    const syncReset = resetControlSync(popover, options, close);
    syncRows.push(syncReset);
    syncReset();
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
