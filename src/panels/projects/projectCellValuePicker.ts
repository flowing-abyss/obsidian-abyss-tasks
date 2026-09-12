import { setIcon } from 'obsidian';
import type { ProjectPropertySuggestion } from '../../ui/ProjectPropertySuggest';
import { renderProjectPropertySuggestion } from '../../ui/ProjectPropertySuggest';
import {
  projectPropertyValuePresentation,
  projectTagLabel,
} from '../../ui/projectPropertyValuePresentation';

export interface ProjectCellValuePickerOptions {
  readonly root: HTMLElement;
  readonly label: string;
  readonly multiple: boolean;
  readonly value: unknown;
  readonly suggestions: readonly ProjectPropertySuggestion[];
  readonly appearance?: 'status' | 'tag';
  readonly equivalent: (left: unknown, right: unknown) => boolean;
  readonly literal: (query: string) => string | number;
  readonly onChange: () => void;
  readonly onCommit: () => void;
  readonly onInvalid: (message: string) => void;
}

export interface ProjectCellValuePickerControl {
  readonly focusTarget: HTMLInputElement;
  readonly preferredWidth: number;
  value(): unknown;
  discardUnsubmitted(): void;
  destroy(): void;
}

interface PickerChoice {
  readonly key: string;
  readonly value: unknown;
  readonly suggestion: ProjectPropertySuggestion;
}

interface PickerRow {
  readonly element: HTMLElement;
  readonly edit: HTMLButtonElement;
  readonly choice: PickerChoice;
}

let pickerSequence = 0;

function copyValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyValue) : value;
}

function initialValues(value: unknown, multiple: boolean): unknown[] {
  if (multiple) {
    if (Array.isArray(value)) return value.map(copyValue);
    return value === undefined || value === null || value === '' ? [] : [copyValue(value)];
  }
  return value === undefined || value === null || value === '' ? [] : [copyValue(value)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matches(choice: PickerChoice, query: string): boolean {
  const normalized = query.toLocaleLowerCase();
  if (normalized.length === 0) return true;
  const { label, detail } = choice.suggestion;
  return [String(choice.value), label, detail ?? ''].some((candidate) =>
    candidate.toLocaleLowerCase().includes(normalized),
  );
}

function genericSuggestion(
  value: unknown,
  appearance: ProjectCellValuePickerOptions['appearance'],
): ProjectPropertySuggestion {
  const presentation = projectPropertyValuePresentation(String(value));
  return {
    value: typeof value === 'number' ? value : String(value),
    label: appearance === 'tag' ? projectTagLabel(presentation.label) : presentation.label,
    ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
    ...(appearance === undefined ? {} : { appearance }),
  };
}

function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || Reflect.get(event, 'keyCode') === 229;
}

class ProjectCellValuePicker implements ProjectCellValuePickerControl {
  readonly focusTarget: HTMLInputElement;
  readonly preferredWidth = 320;
  private readonly selected_abyssPrivate: unknown[];
  private readonly choices_abyssPrivate: PickerChoice[] = [];
  private readonly rows_abyssPrivate = new Map<string, PickerRow>();
  private readonly picker_abyssPrivate: HTMLElement;
  private readonly results_abyssPrivate: HTMLElement;
  private readonly selectedGroup_abyssPrivate: HTMLElement;
  private readonly selectedRows_abyssPrivate: HTMLElement;
  private readonly availableGroup_abyssPrivate: HTMLElement;
  private readonly availableRows_abyssPrivate: HTMLElement;
  private readonly actionHost_abyssPrivate: HTMLElement;
  private readonly sequence_abyssPrivate = ++pickerSequence;
  private activeKey_abyssPrivate: string | undefined;
  private editIndex_abyssPrivate: number | undefined;
  private choiceSequence_abyssPrivate = 0;

  constructor(private readonly options_abyssPrivate: ProjectCellValuePickerOptions) {
    this.selected_abyssPrivate = initialValues(
      options_abyssPrivate.value,
      options_abyssPrivate.multiple,
    );
    for (const value of this.selected_abyssPrivate) this.addChoice_abyssPrivate(value);
    for (const suggestion of options_abyssPrivate.suggestions) {
      this.addChoice_abyssPrivate(suggestion.value, suggestion);
    }
    this.picker_abyssPrivate = options_abyssPrivate.root.createDiv({
      cls: 'abyss-project-value-picker abyss-popover',
    });
    this.focusTarget = this.createSearch_abyssPrivate();
    this.results_abyssPrivate = this.picker_abyssPrivate.createDiv({
      cls: 'abyss-project-value-picker-results',
      attr: { role: 'listbox', 'aria-label': `${options_abyssPrivate.label} values` },
    });
    this.results_abyssPrivate.id = `abyss-project-value-picker-${String(this.sequence_abyssPrivate)}-results`;
    this.focusTarget.setAttribute('aria-controls', this.results_abyssPrivate.id);
    const selectedGroup = this.createGroup_abyssPrivate('Selected');
    this.selectedGroup_abyssPrivate = selectedGroup[0];
    this.selectedRows_abyssPrivate = selectedGroup[1];
    const availableGroup = this.createGroup_abyssPrivate('Available');
    this.availableGroup_abyssPrivate = availableGroup[0];
    this.availableRows_abyssPrivate = availableGroup[1];
    this.actionHost_abyssPrivate = this.picker_abyssPrivate.createDiv({
      cls: 'abyss-project-value-picker-action-host',
    });
    this.render_abyssPrivate();
  }

  value(): unknown {
    return this.options_abyssPrivate.multiple
      ? this.selected_abyssPrivate.map(copyValue)
      : copyValue(this.selected_abyssPrivate[0] ?? '');
  }

  discardUnsubmitted(): void {
    this.clearQuery_abyssPrivate();
    this.activeKey_abyssPrivate = undefined;
    this.render_abyssPrivate();
  }

  destroy(): void {
    this.picker_abyssPrivate.remove();
  }

  private createSearch_abyssPrivate(): HTMLInputElement {
    const input = this.picker_abyssPrivate.createEl('input', {
      cls: 'abyss-project-editor-input abyss-project-value-picker-search',
      attr: {
        type: 'text',
        role: 'combobox',
        'aria-label': `Search ${this.options_abyssPrivate.label}`,
        'aria-autocomplete': 'list',
        'aria-expanded': 'true',
        'aria-keyshortcuts': 'Shift+Enter',
        autocomplete: 'off',
        placeholder: 'Search or add value',
      },
    });
    input.addEventListener('input', () => {
      this.render_abyssPrivate();
    });
    input.addEventListener('keydown', this.onKeyDown_abyssPrivate);
    return input;
  }

  private createGroup_abyssPrivate(label: string): [HTMLElement, HTMLElement] {
    const group = this.results_abyssPrivate.createDiv({
      cls: 'abyss-project-value-picker-group',
    });
    group.createDiv({ cls: 'abyss-project-value-picker-heading', text: label });
    return [group, group.createDiv({ cls: 'abyss-project-value-picker-rows' })];
  }

  private findSelected_abyssPrivate(value: unknown, ignoredIndex?: number): number {
    return this.selected_abyssPrivate.findIndex(
      (candidate, index) =>
        index !== ignoredIndex && this.options_abyssPrivate.equivalent(candidate, value),
    );
  }

  private choiceFor_abyssPrivate(value: unknown): PickerChoice | undefined {
    return this.choices_abyssPrivate.find((choice) =>
      this.options_abyssPrivate.equivalent(choice.value, value),
    );
  }

  private suggestionFor_abyssPrivate(value: unknown): ProjectPropertySuggestion {
    const configured = this.options_abyssPrivate.suggestions.find((suggestion) =>
      this.options_abyssPrivate.equivalent(suggestion.value, value),
    );
    if (configured === undefined) {
      return genericSuggestion(value, this.options_abyssPrivate.appearance);
    }
    return {
      ...configured,
      value: typeof value === 'string' || typeof value === 'number' ? value : String(value),
    };
  }

  private addChoice_abyssPrivate(
    value: unknown,
    preferred?: ProjectPropertySuggestion,
  ): PickerChoice {
    const existing = this.choiceFor_abyssPrivate(value);
    if (existing !== undefined) return existing;
    const choice = {
      key: `choice-${String(++this.choiceSequence_abyssPrivate)}`,
      value,
      suggestion: preferred ?? this.suggestionFor_abyssPrivate(value),
    };
    this.choices_abyssPrivate.push(choice);
    return choice;
  }

  private selectedIndex_abyssPrivate(choice: PickerChoice): number {
    return this.findSelected_abyssPrivate(choice.value);
  }

  private visibleChoices_abyssPrivate(): PickerChoice[] {
    const matching = this.choices_abyssPrivate.filter((choice) =>
      matches(choice, this.focusTarget.value),
    );
    return [
      ...matching.filter((choice) => this.selectedIndex_abyssPrivate(choice) >= 0),
      ...matching.filter((choice) => this.selectedIndex_abyssPrivate(choice) < 0),
    ];
  }

  private clearQuery_abyssPrivate(): void {
    this.focusTarget.value = '';
    this.editIndex_abyssPrivate = undefined;
  }

  private publish_abyssPrivate(): void {
    this.options_abyssPrivate.onChange();
    this.options_abyssPrivate.onCommit();
    this.focusTarget.focus({ preventScroll: true });
  }

  private replaceEdited_abyssPrivate(value: unknown): void {
    const editIndex = this.editIndex_abyssPrivate;
    if (editIndex === undefined || editIndex >= this.selected_abyssPrivate.length) return;
    const duplicate = this.findSelected_abyssPrivate(value, editIndex);
    if (duplicate >= 0) this.selected_abyssPrivate.splice(editIndex, 1);
    else this.selected_abyssPrivate.splice(editIndex, 1, value);
  }

  private toggle_abyssPrivate(value: unknown): void {
    const index = this.findSelected_abyssPrivate(value);
    if (index >= 0) this.selected_abyssPrivate.splice(index, 1);
    else this.selected_abyssPrivate.push(value);
  }

  private mutate_abyssPrivate(value: unknown, clearAfter: boolean): void {
    this.addChoice_abyssPrivate(value);
    if (this.editIndex_abyssPrivate !== undefined) {
      this.replaceEdited_abyssPrivate(value);
    } else if (this.options_abyssPrivate.multiple) {
      this.toggle_abyssPrivate(value);
    } else if (this.findSelected_abyssPrivate(value) >= 0) {
      this.selected_abyssPrivate.splice(0);
    } else {
      this.selected_abyssPrivate.splice(0, this.selected_abyssPrivate.length, value);
    }
    if (clearAfter) this.clearQuery_abyssPrivate();
    this.render_abyssPrivate();
    this.publish_abyssPrivate();
  }

  private literalValue_abyssPrivate(reportInvalid: boolean): string | number | undefined {
    const query = this.focusTarget.value.trim();
    if (query.length === 0) return undefined;
    try {
      return this.options_abyssPrivate.literal(query);
    } catch (error) {
      if (reportInvalid) this.options_abyssPrivate.onInvalid(errorMessage(error));
      return undefined;
    }
  }

  private actionableLiteral_abyssPrivate(reportInvalid = false): string | number | undefined {
    const literal = this.literalValue_abyssPrivate(reportInvalid);
    if (literal === undefined) return undefined;
    const editIndex = this.editIndex_abyssPrivate;
    if (editIndex !== undefined) {
      return this.options_abyssPrivate.equivalent(this.selected_abyssPrivate[editIndex], literal)
        ? undefined
        : literal;
    }
    return this.findSelected_abyssPrivate(literal) >= 0 ? undefined : literal;
  }

  private readonly submitLiteral_abyssPrivate = (): void => {
    const literal = this.actionableLiteral_abyssPrivate(true);
    if (literal !== undefined) this.mutate_abyssPrivate(literal, true);
  };

  private editChoice_abyssPrivate(choice: PickerChoice): void {
    const index = this.selectedIndex_abyssPrivate(choice);
    if (index < 0) return;
    this.editIndex_abyssPrivate = index;
    this.focusTarget.value = String(this.selected_abyssPrivate[index]);
    this.activeKey_abyssPrivate = undefined;
    this.render_abyssPrivate();
    this.focusTarget.focus({ preventScroll: true });
    this.focusTarget.select();
  }

  private createRow_abyssPrivate(choice: PickerChoice): PickerRow {
    const element = this.options_abyssPrivate.root.createDiv({
      cls: 'abyss-project-value-picker-option',
      attr: { role: 'option', 'data-value': String(choice.value), title: String(choice.value) },
    });
    element.remove();
    element.id = `abyss-project-value-picker-${String(this.sequence_abyssPrivate)}-${choice.key}`;
    element.createSpan({
      cls: 'abyss-project-value-picker-indicator',
      text: '✓',
      attr: { 'aria-hidden': 'true' },
    });
    const presentation = element.createDiv({ cls: 'abyss-project-value-picker-presentation' });
    renderProjectPropertySuggestion(choice.suggestion, presentation);
    const edit = element.createEl('button', {
      cls: 'abyss-project-value-picker-edit',
      attr: {
        type: 'button',
        title: `Edit ${choice.suggestion.label} (Shift+Enter)`,
        'aria-label': `Edit ${choice.suggestion.label}`,
        'aria-keyshortcuts': 'Shift+Enter',
      },
    });
    setIcon(edit, 'pencil');
    element.addEventListener('click', () => {
      this.mutate_abyssPrivate(choice.value, this.editIndex_abyssPrivate !== undefined);
    });
    edit.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.editChoice_abyssPrivate(choice);
    });
    return { element, edit, choice };
  }

  private rowFor_abyssPrivate(choice: PickerChoice): PickerRow {
    const existing = this.rows_abyssPrivate.get(choice.key);
    if (existing !== undefined) return existing;
    const row = this.createRow_abyssPrivate(choice);
    this.rows_abyssPrivate.set(choice.key, row);
    return row;
  }

  private renderAction_abyssPrivate(): void {
    this.actionHost_abyssPrivate.empty();
    const literal = this.actionableLiteral_abyssPrivate();
    if (literal === undefined) return;
    const verb = this.editIndex_abyssPrivate === undefined ? 'Add' : 'Apply';
    const action = this.actionHost_abyssPrivate.createEl('button', {
      cls: 'abyss-project-value-picker-action',
      text: `${verb} ${String(literal)}`,
      attr: { type: 'button' },
    });
    action.addEventListener('click', this.submitLiteral_abyssPrivate);
  }

  private updateRow_abyssPrivate(choice: PickerChoice, visible: ReadonlySet<string>): boolean {
    const row = this.rowFor_abyssPrivate(choice);
    if (!visible.has(choice.key)) {
      row.element.remove();
      return false;
    }
    const selected = this.selectedIndex_abyssPrivate(choice) >= 0;
    row.element.setAttribute('aria-selected', String(selected));
    row.element.toggleClass('is-selected', selected);
    row.element.toggleClass('is-active', choice.key === this.activeKey_abyssPrivate);
    row.edit.hidden = !selected;
    (selected ? this.selectedRows_abyssPrivate : this.availableRows_abyssPrivate).appendChild(
      row.element,
    );
    return selected;
  }

  private renderActive_abyssPrivate(): void {
    const activeKey = this.activeKey_abyssPrivate;
    if (activeKey === undefined) {
      this.focusTarget.removeAttribute('aria-activedescendant');
      return;
    }
    const active = this.rows_abyssPrivate.get(activeKey);
    if (active !== undefined) {
      this.focusTarget.setAttribute('aria-activedescendant', active.element.id);
    }
  }

  private render_abyssPrivate(): void {
    const previousScrollTop = this.results_abyssPrivate.scrollTop;
    const visible = new Set(this.visibleChoices_abyssPrivate().map(({ key }) => key));
    if (this.activeKey_abyssPrivate !== undefined && !visible.has(this.activeKey_abyssPrivate)) {
      this.activeKey_abyssPrivate = undefined;
    }
    let selectedCount = 0;
    let availableCount = 0;
    for (const choice of this.choices_abyssPrivate) {
      if (this.updateRow_abyssPrivate(choice, visible)) selectedCount++;
      else if (visible.has(choice.key)) availableCount++;
    }
    this.selectedGroup_abyssPrivate.hidden = selectedCount === 0;
    this.availableGroup_abyssPrivate.hidden = availableCount === 0;
    this.renderActive_abyssPrivate();
    this.renderAction_abyssPrivate();
    this.results_abyssPrivate.scrollTop = previousScrollTop;
  }

  private revealActive_abyssPrivate(): void {
    const activeKey = this.activeKey_abyssPrivate;
    const row = activeKey === undefined ? undefined : this.rows_abyssPrivate.get(activeKey);
    if (row === undefined) return;
    const resultsRect = this.results_abyssPrivate.getBoundingClientRect();
    const rowRect = row.element.getBoundingClientRect();
    if (rowRect.top < resultsRect.top) {
      this.results_abyssPrivate.scrollTop -= resultsRect.top - rowRect.top;
    } else if (rowRect.bottom > resultsRect.bottom) {
      this.results_abyssPrivate.scrollTop += rowRect.bottom - resultsRect.bottom;
    }
  }

  private moveActive_abyssPrivate(step: -1 | 1): void {
    const visible = this.visibleChoices_abyssPrivate();
    if (visible.length === 0) return;
    const current = visible.findIndex(({ key }) => key === this.activeKey_abyssPrivate);
    let next = current + step;
    if (current < 0) next = step > 0 ? 0 : visible.length - 1;
    const bounded = Math.max(0, Math.min(next, visible.length - 1));
    this.activeKey_abyssPrivate = visible[bounded]?.key;
    this.render_abyssPrivate();
    this.revealActive_abyssPrivate();
  }

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) {
      if (event.key === 'Enter') event.stopPropagation();
      return;
    }
    if (this.handleEditShortcut_abyssPrivate(event)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.moveActive_abyssPrivate(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    const active = this.activeChoice_abyssPrivate();
    if (active === undefined) this.submitLiteral_abyssPrivate();
    else this.mutate_abyssPrivate(active.value, this.editIndex_abyssPrivate !== undefined);
  };

  private handleEditShortcut_abyssPrivate(event: KeyboardEvent): boolean {
    if (event.key !== 'Enter' || !event.shiftKey) return false;
    event.preventDefault();
    event.stopPropagation();
    const active = this.activeChoice_abyssPrivate();
    if (active !== undefined && this.selectedIndex_abyssPrivate(active) >= 0) {
      this.editChoice_abyssPrivate(active);
    }
    return true;
  }

  private activeChoice_abyssPrivate(): PickerChoice | undefined {
    const activeKey = this.activeKey_abyssPrivate;
    return activeKey === undefined ? undefined : this.rows_abyssPrivate.get(activeKey)?.choice;
  }
}

/** Mounts the retained, editor-local option list used by one project cell. */
export function mountProjectCellValuePicker(
  options: ProjectCellValuePickerOptions,
): ProjectCellValuePickerControl {
  return new ProjectCellValuePicker(options);
}
