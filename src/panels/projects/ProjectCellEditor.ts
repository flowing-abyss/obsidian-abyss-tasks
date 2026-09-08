import { Notice, type App } from 'obsidian';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectFieldCatalogItem, ProjectPropertyType } from '../../projects/projectFields';
import type { ProjectStatus } from '../../settings/types';
import { ProjectPropertySuggest } from '../../ui/ProjectPropertySuggest';

export type ProjectCellEditorResult = 'committed' | 'cancelled';
interface ProjectCellEditorCloseContext {
  readonly restoreFocus: boolean;
}

export interface ProjectCellEditorOptions {
  readonly app: App;
  readonly container: HTMLElement;
  readonly field: ProjectFieldCatalogItem;
  readonly value: unknown;
  readonly catalog: ProjectPropertyCatalog;
  readonly statuses?: readonly ProjectStatus[];
  readonly sourcePath?: string;
  readonly save: (value: unknown) => Promise<void>;
  readonly onClose: (
    result: ProjectCellEditorResult,
    context: ProjectCellEditorCloseContext,
  ) => void;
  readonly restoreFocus?: () => void;
}

export interface ProjectCellEditorHandle {
  readonly element: HTMLElement;
  focus(): void;
  destroy(): void;
}

interface EditorControl {
  readonly focusTarget?: HTMLElement;
  readonly suggest?: ProjectPropertySuggest;
  value(): unknown;
}

function isEditablePropertyType(
  type: ProjectFieldCatalogItem['type'],
): type is ProjectPropertyType {
  return (
    type === 'text' ||
    type === 'list' ||
    type === 'number' ||
    type === 'checkbox' ||
    type === 'date' ||
    type === 'datetime' ||
    type === 'tags'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameProperty(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function currentCustomType(
  field: ProjectFieldCatalogItem,
  catalog: ProjectPropertyCatalog,
): ProjectPropertyType | null | undefined {
  if (!field.id.startsWith('property:') || field.property === undefined) return undefined;
  return catalog.list().find(({ name }) => sameProperty(name, field.property ?? ''))?.type;
}

function suggestOptions(
  options: ProjectCellEditorOptions,
  input: HTMLInputElement,
  suggestion: {
    readonly values: readonly string[];
    readonly onPick: (value: string) => void;
    readonly includeNotes: boolean;
  },
): ConstructorParameters<typeof ProjectPropertySuggest>[0] {
  return {
    app: options.app,
    input,
    ...suggestion,
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
  };
}

function textControl(options: ProjectCellEditorOptions, root: HTMLElement): EditorControl {
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-input',
    attr: { type: 'text', 'aria-label': options.field.label, autocomplete: 'off' },
  });
  input.value = typeof options.value === 'string' ? options.value : '';
  const values =
    options.field.property === undefined ? [] : options.catalog.values(options.field.property);
  const suggest = new ProjectPropertySuggest(
    suggestOptions(options, input, {
      values,
      onPick: (value) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      includeNotes: true,
    }),
  );
  return { focusTarget: input, suggest, value: () => input.value };
}

function initialListValues(value: unknown): unknown[] {
  const values: unknown[] = [];
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) values.push(item);
  } else if (value !== undefined && value !== null && value !== '') {
    values.push(value);
  }
  return values;
}

function listControl(options: ProjectCellEditorOptions, root: HTMLElement): EditorControl {
  const values = initialListValues(options.value);
  const list = root.createDiv({ cls: 'abyss-project-list-values' });
  const inputRow = root.createDiv({ cls: 'abyss-project-list-entry' });
  const input = inputRow.createEl('input', {
    cls: 'abyss-project-editor-input abyss-project-list-input',
    attr: { type: 'text', 'aria-label': `Add ${options.field.label}`, autocomplete: 'off' },
  });
  const addButton = inputRow.createEl('button', {
    cls: 'abyss-project-list-add',
    text: 'Add',
    attr: { type: 'button' },
  });

  const renderValues = (): void => {
    list.empty();
    values.forEach((value, index) => {
      const item = list.createDiv({ cls: 'abyss-project-list-value' });
      item.createSpan({ text: String(value) });
      const remove = item.createEl('button', {
        text: 'Remove',
        attr: { type: 'button', 'aria-label': `Remove ${String(value)}` },
      });
      remove.addEventListener('click', () => {
        values.splice(index, 1);
        renderValues();
        input.focus();
      });
    });
  };
  const addPending = (value = input.value): void => {
    const normalized = value.trim();
    if (normalized.length === 0) return;
    values.push(normalized);
    input.value = '';
    renderValues();
    input.focus();
  };
  addButton.addEventListener('click', () => {
    addPending();
  });
  renderValues();

  const suggestions =
    options.field.property === undefined ? [] : options.catalog.values(options.field.property);
  const suggest = new ProjectPropertySuggest(
    suggestOptions(options, input, {
      values: suggestions,
      onPick: (value) => {
        addPending(value);
      },
      includeNotes: options.field.type === 'list',
    }),
  );
  return {
    focusTarget: input,
    suggest,
    value: () => {
      const pending = input.value.trim();
      return pending.length === 0 ? [...values] : [...values, pending];
    },
  };
}

function temporalControl(
  root: HTMLElement,
  type: 'date' | 'datetime-local',
  label: string,
  value: unknown,
): EditorControl {
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-input',
    attr: { type, 'aria-label': label },
  });
  input.value = typeof value === 'string' ? value : '';
  return { focusTarget: input, value: () => input.value };
}

function numberControl(root: HTMLElement, label: string, value: unknown): EditorControl {
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-input',
    attr: { type: 'number', 'aria-label': label },
  });
  input.value = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return {
    focusTarget: input,
    value: (): unknown => {
      if (input.value === '') return '';
      const number = input.valueAsNumber;
      if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
      return number;
    },
  };
}

function propertyControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  type: ProjectPropertyType,
): EditorControl {
  switch (type) {
    case 'text':
      return textControl(options, root);
    case 'list':
    case 'tags':
      return listControl(options, root);
    case 'number':
      return numberControl(root, options.field.label, options.value);
    case 'checkbox': {
      const input = root.createEl('input', {
        cls: 'abyss-project-editor-checkbox',
        attr: { type: 'checkbox', 'aria-label': options.field.label },
      });
      input.checked = options.value === true;
      return { focusTarget: input, value: () => input.checked };
    }
    case 'date':
      return temporalControl(root, 'date', options.field.label, options.value);
    case 'datetime':
      return temporalControl(root, 'datetime-local', options.field.label, options.value);
  }
}

function statusControl(options: ProjectCellEditorOptions, root: HTMLElement): EditorControl {
  const select = root.createEl('select', {
    cls: 'abyss-project-editor-status',
    attr: { 'aria-label': options.field.label },
  });
  for (const status of options.statuses ?? []) {
    const option = select.createEl('option', { value: status.id, text: status.label });
    if (status.color !== undefined) option.style.color = status.color;
  }
  select.value = typeof options.value === 'string' ? options.value : '';
  return { focusTarget: select, value: () => select.value };
}

function buildControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
): EditorControl | undefined {
  if (isEditablePropertyType(options.field.type)) {
    return propertyControl(options, root, options.field.type);
  }
  if (options.field.type === 'status') return statusControl(options, root);
  return undefined;
}

class ProjectCellEditorLifecycle implements ProjectCellEditorHandle {
  readonly element: HTMLElement;
  private readonly control_abyssPrivate: EditorControl | undefined;
  private readonly error_abyssPrivate: HTMLElement;
  private saveButton_abyssPrivate: HTMLButtonElement | undefined;
  private saveInFlight_abyssPrivate: Promise<void> | undefined;
  private closed_abyssPrivate = false;

  constructor(private readonly options_abyssPrivate: ProjectCellEditorOptions) {
    this.element = options_abyssPrivate.container.createDiv({ cls: 'abyss-project-cell-editor' });
    this.control_abyssPrivate = buildControl(options_abyssPrivate, this.element);
    this.error_abyssPrivate = this.element.createDiv({
      cls: 'abyss-project-editor-error',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });
    this.renderActions_abyssPrivate();
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    this.element.addEventListener('keydown', this.onKeyDown_abyssPrivate);
    this.focus();
  }

  focus(): void {
    this.control_abyssPrivate?.focusTarget?.focus();
  }

  destroy(): void {
    if (this.closed_abyssPrivate) return;
    this.closed_abyssPrivate = true;
    this.control_abyssPrivate?.suggest?.close();
    this.element.remove();
  }

  private renderActions_abyssPrivate(): void {
    if (this.control_abyssPrivate === undefined) {
      this.renderUnavailable_abyssPrivate();
      return;
    }
    const actions = this.element.createDiv({ cls: 'abyss-project-editor-actions' });
    this.saveButton_abyssPrivate = actions.createEl('button', {
      cls: 'abyss-project-editor-save mod-cta',
      text: 'Save',
      attr: { type: 'button' },
    });
    const cancel = actions.createEl('button', {
      cls: 'abyss-project-editor-cancel',
      text: 'Cancel',
      attr: { type: 'button' },
    });
    this.saveButton_abyssPrivate.addEventListener('click', () => {
      this.commit_abyssPrivate();
    });
    cancel.addEventListener('click', () => {
      this.finish_abyssPrivate('cancelled');
    });
  }

  private renderUnavailable_abyssPrivate(): void {
    const { field } = this.options_abyssPrivate;
    this.error_abyssPrivate.setText(
      field.type === null
        ? 'Obsidian property type is unavailable. Editing is disabled.'
        : `${field.label} is not editable here.`,
    );
    const close = this.element.createEl('button', { text: 'Close', attr: { type: 'button' } });
    close.addEventListener('click', () => {
      this.finish_abyssPrivate('cancelled');
    });
  }

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.finish_abyssPrivate('cancelled');
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit_abyssPrivate();
    } else if (event.key === 'Tab') {
      this.commit_abyssPrivate(false);
    }
  };

  private validateCurrentType_abyssPrivate(): boolean {
    const { catalog, field } = this.options_abyssPrivate;
    if (!field.id.startsWith('property:')) return true;
    if (currentCustomType(field, catalog) === field.type) return true;
    this.error_abyssPrivate.setText(
      'This property type changed in Obsidian. Close and reopen the editor.',
    );
    this.focus();
    return false;
  }

  private commit_abyssPrivate(restoreFocus = true): void {
    const control = this.control_abyssPrivate;
    if (control === undefined || this.saveInFlight_abyssPrivate !== undefined) return;
    this.error_abyssPrivate.empty();
    if (!this.validateCurrentType_abyssPrivate()) return;
    let value: unknown;
    try {
      value = control.value();
    } catch (error) {
      this.error_abyssPrivate.setText(errorMessage(error));
      this.focus();
      return;
    }
    this.saveButton_abyssPrivate?.setAttribute('disabled', '');
    const save = this.options_abyssPrivate.save(value);
    this.saveInFlight_abyssPrivate = save;
    void save.then(
      () => {
        this.finish_abyssPrivate('committed', restoreFocus);
      },
      (error: unknown) => {
        this.handleSaveFailure_abyssPrivate(error);
      },
    );
  }

  private handleSaveFailure_abyssPrivate(error: unknown): void {
    this.saveInFlight_abyssPrivate = undefined;
    this.saveButton_abyssPrivate?.removeAttribute('disabled');
    const message = errorMessage(error);
    if (isProjectEditValidationError(error)) {
      this.error_abyssPrivate.setText(message);
      this.focus();
      return;
    }
    this.error_abyssPrivate.setText(
      `Could not save ${this.options_abyssPrivate.field.label}: ${message}`,
    );
    console.error('[abyss-tasks] Could not save project property', {
      property: this.options_abyssPrivate.field.property,
      cause: error,
    });
    new Notice(`Could not save ${this.options_abyssPrivate.field.label}: ${message}`);
    this.focus();
  }

  private finish_abyssPrivate(result: ProjectCellEditorResult, restoreFocus = true): void {
    if (this.closed_abyssPrivate) return;
    this.destroy();
    this.options_abyssPrivate.onClose(result, { restoreFocus });
    if (restoreFocus) this.options_abyssPrivate.restoreFocus?.();
  }
}

/** Mounts one transient inline editor. The returned handle owns all editor-local cleanup. */
export function mountProjectCellEditor(options: ProjectCellEditorOptions): ProjectCellEditorHandle {
  return new ProjectCellEditorLifecycle(options);
}
