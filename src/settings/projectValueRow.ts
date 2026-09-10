import { DropdownComponent, setIcon } from 'obsidian';
import { registerSettingsDragHandlers } from './settingsCard';

export interface ProjectValueRowOptions {
  readonly container: HTMLElement;
  readonly id: string;
  readonly listKey: string;
  readonly label: string;
  readonly value: string;
  readonly valueType: 'text' | 'number';
  readonly displayName?: string;
  readonly color?: string;
  readonly display?: 'badge' | 'text' | 'dot';
  readonly onLeftPanel?: boolean;
  readonly removeDisabled?: boolean;
  readonly onReorder: (draggedId: string, targetId: string) => boolean;
}

export interface ProjectValueRowControls {
  readonly row: HTMLElement;
  readonly value: HTMLInputElement;
  readonly displayName: HTMLInputElement;
  readonly color: HTMLInputElement;
  readonly appearance: HTMLSelectElement;
  readonly onLeftPanel?: HTMLInputElement;
  readonly remove: HTMLButtonElement;
  readonly updateLabel: (label: string) => void;
}

function renderGrip(row: HTMLElement, options: ProjectValueRowOptions): HTMLElement {
  const grip = row.createSpan({
    cls: 'abyss-settings-card-grip abyss-project-value-grip',
    attr: {
      draggable: 'true',
      'aria-label': `Reorder ${options.label}`,
      'data-settings-focus-key': 'reorder',
      title: `Reorder ${options.label}`,
    },
  });
  setIcon(grip, 'grip-vertical');
  registerSettingsDragHandlers(row, grip, options.id, {
    listKey: options.listKey,
    onReorder: options.onReorder,
  });
  return grip;
}

function renderTextControl(
  row: HTMLElement,
  options: {
    readonly className: string;
    readonly type: 'text' | 'number';
    readonly label: string;
    readonly focusKey: string;
    readonly placeholder: string;
    readonly value: string;
  },
): HTMLInputElement {
  const input = row.createEl('input', {
    cls: options.className,
    attr: {
      type: options.type,
      'aria-label': options.label,
      'data-settings-focus-key': options.focusKey,
      placeholder: options.placeholder,
    },
  });
  input.value = options.value;
  return input;
}

function renderColor(row: HTMLElement, options: ProjectValueRowOptions): HTMLInputElement {
  const color = row.createEl('input', {
    cls: 'abyss-project-value-color',
    attr: {
      type: 'color',
      'aria-label': `Color for ${options.label}`,
      'data-settings-focus-key': 'color',
    },
  });
  color.value =
    options.color !== undefined && /^#[\da-f]{6}$/iu.test(options.color)
      ? options.color
      : '#888888';
  return color;
}

function renderAppearance(row: HTMLElement, options: ProjectValueRowOptions): HTMLSelectElement {
  const appearance = new DropdownComponent(row)
    .addOptions({ badge: 'Badge', text: 'Text', dot: 'Dot' })
    .setValue(options.display ?? 'badge').selectEl;
  appearance.addClasses(['dropdown', 'abyss-project-value-appearance']);
  appearance.setAttribute('aria-label', `Appearance for ${options.label}`);
  appearance.dataset['settingsFocusKey'] = 'appearance';
  return appearance;
}

function renderLeftPanel(
  row: HTMLElement,
  options: ProjectValueRowOptions,
): { input: HTMLInputElement; label: HTMLLabelElement } | undefined {
  if (options.onLeftPanel === undefined) return undefined;
  const label = row.createEl('label', {
    cls: 'abyss-project-value-left-panel-label',
    attr: { title: `Show ${options.label} on left panel` },
  });
  const input = label.createEl('input', {
    cls: 'abyss-project-value-left-panel',
    attr: {
      type: 'checkbox',
      'aria-label': `Show ${options.label} on left panel`,
      'data-settings-focus-key': 'left-panel',
    },
  });
  input.checked = options.onLeftPanel;
  label.createSpan({ text: 'Left panel' });
  return { input, label };
}

function renderRemove(row: HTMLElement, options: ProjectValueRowOptions): HTMLButtonElement {
  const remove = row.createEl('button', {
    cls: 'clickable-icon abyss-project-value-remove',
    attr: {
      type: 'button',
      'aria-label': `Remove ${options.label}`,
      'data-settings-focus-key': 'remove',
      title: `Remove ${options.label}`,
    },
  });
  remove.disabled = options.removeDisabled ?? false;
  setIcon(remove, 'x');
  return remove;
}

/** Shared compact controls for ordered project statuses and property presets. */
export function renderProjectValueRow(options: ProjectValueRowOptions): ProjectValueRowControls {
  const row = options.container.createDiv({
    cls: `abyss-project-value-row${options.onLeftPanel === undefined ? '' : ' has-left-panel'}`,
    attr: {
      'data-card-id': options.id,
      'data-settings-item-id': options.id,
    },
  });
  const grip = renderGrip(row, options);
  const value = renderTextControl(row, {
    className: 'abyss-project-value-raw',
    type: options.valueType,
    label: `Value for ${options.label}`,
    focusKey: 'value',
    placeholder: 'Value',
    value: options.value,
  });
  const displayName = renderTextControl(row, {
    className: 'abyss-project-value-alias',
    type: 'text',
    label: `Display name for ${options.label}`,
    focusKey: 'display-name',
    placeholder: 'Display name',
    value: options.displayName ?? '',
  });
  const color = renderColor(row, options);
  const appearance = renderAppearance(row, options);
  const leftPanel = renderLeftPanel(row, options);
  const remove = renderRemove(row, options);
  const updateLabel = (label: string): void => {
    grip.setAttrs({ 'aria-label': `Reorder ${label}`, title: `Reorder ${label}` });
    value.setAttribute('aria-label', `Value for ${label}`);
    displayName.setAttribute('aria-label', `Display name for ${label}`);
    color.setAttribute('aria-label', `Color for ${label}`);
    appearance.setAttribute('aria-label', `Appearance for ${label}`);
    if (leftPanel !== undefined) {
      leftPanel.label.title = `Show ${label} on left panel`;
      leftPanel.input.setAttribute('aria-label', `Show ${label} on left panel`);
    }
    remove.setAttrs({ 'aria-label': `Remove ${label}`, title: `Remove ${label}` });
  };
  return {
    row,
    value,
    displayName,
    color,
    appearance,
    ...(leftPanel === undefined ? {} : { onLeftPanel: leftPanel.input }),
    remove,
    updateLabel,
  };
}
