import { Notice, type App } from 'obsidian';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectFieldCatalogItem, ProjectPropertyType } from '../../projects/projectFields';
import type { ProjectStatus } from '../../settings/types';
import { ProjectPropertySuggest } from '../../ui/ProjectPropertySuggest';

export type ProjectCellEditorResult = 'committed' | 'cancelled';
export type ProjectCellEditorNavigation =
  'restore-current' | 'tab-forward' | 'tab-backward' | 'preserve-focus';
interface ProjectCellEditorCloseContext {
  readonly navigation: ProjectCellEditorNavigation;
  readonly focusTarget?: HTMLElement;
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
  commit(): Promise<boolean>;
  cancel(): void;
  focus(): void;
  destroy(): void;
}

interface EditorControl {
  readonly focusTarget?: HTMLElement;
  readonly suggest?: ProjectPropertySuggest;
  value(): unknown;
}

interface EditorEvents {
  changed(): void;
  commit(close: boolean): void;
  suggestionOpen(open: boolean): void;
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

function copyValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(copyValue) : value;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalValue(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function initialDraftValue(control: EditorControl | undefined, sourceValue: unknown): unknown {
  if (control === undefined) return copyValue(sourceValue);
  try {
    return copyValue(control.value());
  } catch {
    return copyValue(sourceValue);
  }
}

function currentCustomType(
  field: ProjectFieldCatalogItem,
  catalog: ProjectPropertyCatalog,
): ProjectPropertyType | null | undefined {
  if (!field.id.startsWith('property:') || field.property === undefined) return undefined;
  const snapshot = catalog.inspect(field.property);
  if (snapshot.kind === 'unavailable') return null;
  if (snapshot.assignment.kind === 'assigned') return snapshot.assignment.type;
  return snapshot.property?.type;
}

function suggestOptions(
  options: ProjectCellEditorOptions,
  input: HTMLInputElement,
  suggestion: {
    readonly values: readonly string[];
    readonly onPick: (value: string) => void;
  },
  events: EditorEvents,
): ConstructorParameters<typeof ProjectPropertySuggest>[0] {
  return {
    app: options.app,
    input,
    ...suggestion,
    onOpen: () => {
      events.suggestionOpen(true);
    },
    onClose: () => {
      events.suggestionOpen(false);
    },
  };
}

function textControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-input',
    attr: { type: 'text', 'aria-label': options.field.label, autocomplete: 'off' },
  });
  input.value = typeof options.value === 'string' ? options.value : '';
  input.addEventListener('input', () => {
    events.changed();
  });
  const values =
    options.field.property === undefined ? [] : options.catalog.values(options.field.property);
  const suggest = new ProjectPropertySuggest(
    suggestOptions(
      options,
      input,
      {
        values,
        onPick: (value) => {
          input.value = value;
          events.changed();
          events.commit(true);
        },
      },
      events,
    ),
  );
  return { focusTarget: input, suggest, value: () => input.value };
}

function initialListValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.map(copyValue);
  return value === undefined || value === null || value === '' ? [] : [value];
}

function listControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const values = initialListValues(options.value);
  const list = root.createDiv({ cls: 'abyss-project-list-values' });
  const inputRow = root.createDiv({ cls: 'abyss-project-list-entry' });
  const input = inputRow.createEl('input', {
    cls: 'abyss-project-editor-input abyss-project-list-input',
    attr: { type: 'text', 'aria-label': `Add ${options.field.label}`, autocomplete: 'off' },
  });
  input.addEventListener('input', () => {
    events.changed();
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
        cls: 'abyss-project-list-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': `Remove ${String(value)}` },
      });
      remove.addEventListener('click', () => {
        values.splice(index, 1);
        renderValues();
        events.changed();
        events.commit(false);
        input.focus();
      });
    });
  };
  const addPending = (value = input.value): boolean => {
    const normalized = value.trim();
    if (normalized.length === 0) return false;
    values.push(normalized);
    input.value = '';
    renderValues();
    events.changed();
    input.focus();
    return true;
  };
  addButton.addEventListener('click', () => {
    if (addPending()) events.commit(false);
  });
  renderValues();

  const suggestions =
    options.field.property === undefined ? [] : options.catalog.values(options.field.property);
  const suggest = new ProjectPropertySuggest(
    suggestOptions(
      options,
      input,
      {
        values: suggestions,
        onPick: (value) => {
          if (addPending(value)) events.commit(false);
        },
      },
      events,
    ),
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

function validNativeInput(input: HTMLInputElement, label: string, kind: string): void {
  if (input.validity.badInput) throw new Error(`${label} must be a valid ${kind}.`);
}

interface TemporalControlOptions {
  readonly root: HTMLElement;
  readonly type: 'date' | 'datetime-local';
  readonly label: string;
  readonly value: unknown;
  readonly events: EditorEvents;
}

function temporalControl(options: TemporalControlOptions): EditorControl {
  const { root, type, label, value, events } = options;
  let keyboardEditing = false;
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-input',
    attr: { type, 'aria-label': label },
  });
  input.value = typeof value === 'string' ? value : '';
  input.addEventListener('input', () => {
    events.changed();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Tab' && event.key !== 'Escape') {
      keyboardEditing = true;
    }
  });
  input.addEventListener('pointerdown', () => {
    keyboardEditing = false;
  });
  input.addEventListener('change', () => {
    events.changed();
    if (!keyboardEditing) events.commit(true);
  });
  return {
    focusTarget: input,
    value: () => {
      validNativeInput(input, label, type === 'date' ? 'date' : 'date and time');
      return input.value;
    },
  };
}

function numberControl(
  root: HTMLElement,
  label: string,
  value: unknown,
  events: EditorEvents,
): EditorControl {
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-input',
    attr: { type: 'number', 'aria-label': label },
  });
  input.value = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  input.addEventListener('input', () => {
    events.changed();
  });
  input.addEventListener('change', () => {
    events.changed();
    events.commit(true);
  });
  return {
    focusTarget: input,
    value: (): unknown => {
      validNativeInput(input, label, 'number');
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
  events: EditorEvents,
): EditorControl {
  switch (type) {
    case 'text':
      return textControl(options, root, events);
    case 'list':
    case 'tags':
      return listControl(options, root, events);
    case 'number':
      return numberControl(root, options.field.label, options.value, events);
    case 'checkbox': {
      const input = root.createEl('input', {
        cls: 'abyss-project-editor-checkbox',
        attr: { type: 'checkbox', 'aria-label': options.field.label },
      });
      input.checked = options.value === true;
      input.addEventListener('change', () => {
        events.changed();
        events.commit(true);
      });
      return { focusTarget: input, value: () => input.checked };
    }
    case 'date':
      return temporalControl({
        root,
        type: 'date',
        label: options.field.label,
        value: options.value,
        events,
      });
    case 'datetime':
      return temporalControl({
        root,
        type: 'datetime-local',
        label: options.field.label,
        value: options.value,
        events,
      });
  }
}

function statusControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const select = root.createEl('select', {
    cls: 'abyss-project-editor-status',
    attr: { 'aria-label': options.field.label },
  });
  select.createEl('option', { value: '', text: 'No status' });
  const current = typeof options.value === 'string' ? options.value : '';
  if (current.length > 0 && !(options.statuses ?? []).some(({ name }) => name === current)) {
    select.createEl('option', { value: current, text: current });
  }
  for (const status of options.statuses ?? []) {
    const option = select.createEl('option', { value: status.name, text: status.name });
    if (status.color !== undefined) option.style.color = status.color;
  }
  select.value = current;
  select.addEventListener('change', () => {
    events.changed();
    events.commit(true);
  });
  return { focusTarget: select, value: () => select.value };
}

function buildControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl | undefined {
  if (isEditablePropertyType(options.field.type)) {
    return propertyControl(options, root, options.field.type, events);
  }
  if (options.field.type === 'status') return statusControl(options, root, events);
  return undefined;
}

class ProjectCellEditorLifecycle implements ProjectCellEditorHandle {
  readonly element: HTMLElement;
  private readonly control_abyssPrivate: EditorControl | undefined;
  private readonly error_abyssPrivate: HTMLElement;
  private committedValue_abyssPrivate: unknown;
  private saveInFlight_abyssPrivate: Promise<boolean> | undefined;
  private closeRequested_abyssPrivate = false;
  private closeNavigation_abyssPrivate: ProjectCellEditorNavigation = 'restore-current';
  private closeFocusTarget_abyssPrivate: HTMLElement | undefined;
  private suggestOpen_abyssPrivate = false;
  private ownedPointerActive_abyssPrivate = false;
  private ownedPointerCleanup_abyssPrivate: (() => void) | undefined;
  private blurPending_abyssPrivate = false;
  private closed_abyssPrivate = false;

  constructor(private readonly options_abyssPrivate: ProjectCellEditorOptions) {
    this.committedValue_abyssPrivate = copyValue(options_abyssPrivate.value);
    this.element = options_abyssPrivate.container.createDiv({ cls: 'abyss-project-cell-editor' });
    this.error_abyssPrivate = this.element.createDiv({
      cls: 'abyss-project-editor-error',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });
    const events: EditorEvents = {
      changed: () => {
        this.error_abyssPrivate.empty();
      },
      commit: (close) => {
        this.requestCommit_abyssPrivate(close, 'restore-current');
      },
      suggestionOpen: (open) => {
        this.suggestOpen_abyssPrivate = open;
        if (!open) this.finishAfterSuggestion_abyssPrivate();
      },
    };
    this.control_abyssPrivate = buildControl(options_abyssPrivate, this.element, events);
    this.committedValue_abyssPrivate = initialDraftValue(
      this.control_abyssPrivate,
      options_abyssPrivate.value,
    );
    this.element.appendChild(this.error_abyssPrivate);
    if (this.control_abyssPrivate === undefined) this.renderUnavailable_abyssPrivate();
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    this.element.addEventListener('keydown', this.onKeyDown_abyssPrivate);
    this.element.addEventListener('focusout', this.onFocusOut_abyssPrivate);
    this.element.addEventListener('focusin', () => {
      this.blurPending_abyssPrivate = false;
    });
    this.element.addEventListener('pointerdown', this.onOwnedPointerDown_abyssPrivate, true);
    this.element.addEventListener('click', () => {
      this.clearOwnedPointer_abyssPrivate();
    });
    this.focus();
  }

  commit(): Promise<boolean> {
    return this.commitWithOptions_abyssPrivate(true, 'restore-current');
  }

  cancel(): void {
    this.finish_abyssPrivate('cancelled');
  }

  focus(): void {
    this.control_abyssPrivate?.focusTarget?.focus({ preventScroll: true });
  }

  destroy(): void {
    if (this.closed_abyssPrivate) return;
    this.closed_abyssPrivate = true;
    this.clearOwnedPointer_abyssPrivate();
    this.control_abyssPrivate?.suggest?.close();
    this.element.remove();
  }

  private renderUnavailable_abyssPrivate(): void {
    const { field } = this.options_abyssPrivate;
    this.error_abyssPrivate.setText(
      field.type === null
        ? 'Obsidian property type is unavailable. Editing is disabled.'
        : `${field.label} is not editable here.`,
    );
  }

  private readonly onKeyDown_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      return;
    }
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    event.preventDefault();
    event.stopPropagation();
    let navigation: ProjectCellEditorNavigation = 'restore-current';
    if (event.key === 'Tab') navigation = event.shiftKey ? 'tab-backward' : 'tab-forward';
    this.requestCommit_abyssPrivate(true, navigation);
  };

  private readonly onFocusOut_abyssPrivate = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.element.contains(next)) {
      this.blurPending_abyssPrivate = false;
      return;
    }
    if (this.ownedPointerActive_abyssPrivate) {
      this.blurPending_abyssPrivate = false;
      return;
    }
    if (this.suggestOpen_abyssPrivate) {
      this.blurPending_abyssPrivate = true;
      return;
    }
    this.blurPending_abyssPrivate = false;
    this.requestCommit_abyssPrivate(
      true,
      'preserve-focus',
      next instanceof HTMLElement ? next : undefined,
    );
  };

  private readonly onOwnedPointerDown_abyssPrivate = (): void => {
    this.ownedPointerCleanup_abyssPrivate?.();
    this.ownedPointerActive_abyssPrivate = true;
    const ownerDocument = this.element.ownerDocument;
    const release = (): void => {
      window.setTimeout(() => {
        this.clearOwnedPointer_abyssPrivate();
      }, 0);
    };
    const cancel = (): void => {
      this.clearOwnedPointer_abyssPrivate();
    };
    this.ownedPointerCleanup_abyssPrivate = () => {
      ownerDocument.removeEventListener('pointerup', release);
      ownerDocument.removeEventListener('pointercancel', cancel);
      this.ownedPointerCleanup_abyssPrivate = undefined;
    };
    ownerDocument.addEventListener('pointerup', release);
    ownerDocument.addEventListener('pointercancel', cancel);
  };

  private clearOwnedPointer_abyssPrivate(): void {
    this.ownedPointerActive_abyssPrivate = false;
    this.ownedPointerCleanup_abyssPrivate?.();
  }

  private finishAfterSuggestion_abyssPrivate(): void {
    if (!this.blurPending_abyssPrivate) return;
    this.blurPending_abyssPrivate = false;
    queueMicrotask(() => {
      if (
        this.closed_abyssPrivate ||
        this.suggestOpen_abyssPrivate ||
        this.ownedPointerActive_abyssPrivate
      ) {
        return;
      }
      const active = this.element.ownerDocument.activeElement;
      if (active instanceof Node && this.element.contains(active)) return;
      this.requestCommit_abyssPrivate(true, 'preserve-focus');
    });
  }

  private validateCurrentType_abyssPrivate(): boolean {
    const { catalog, field } = this.options_abyssPrivate;
    if (!field.id.startsWith('property:')) return true;
    const current = currentCustomType(field, catalog);
    if (current === undefined || current === field.type) return true;
    this.error_abyssPrivate.setText(
      current === null
        ? 'This property type is unavailable in Obsidian. Close and reopen the editor.'
        : 'This property type changed in Obsidian. Close and reopen the editor.',
    );
    this.focus();
    return false;
  }

  private commitWithOptions_abyssPrivate(
    close: boolean,
    navigation: ProjectCellEditorNavigation,
    focusTarget?: HTMLElement,
  ): Promise<boolean> {
    if (this.closed_abyssPrivate) return Promise.resolve(true);
    this.closeRequested_abyssPrivate ||= close;
    if (
      close &&
      !(
        navigation === 'preserve-focus' &&
        this.saveInFlight_abyssPrivate !== undefined &&
        (this.closeNavigation_abyssPrivate === 'tab-forward' ||
          this.closeNavigation_abyssPrivate === 'tab-backward')
      )
    ) {
      this.closeNavigation_abyssPrivate = navigation;
      this.closeFocusTarget_abyssPrivate =
        navigation === 'preserve-focus' ? focusTarget : undefined;
    }
    if (this.saveInFlight_abyssPrivate !== undefined) {
      const inFlight = this.saveInFlight_abyssPrivate;
      return inFlight.then(async (saved): Promise<boolean> => {
        if (!saved || this.closed_abyssPrivate || !this.closeRequested_abyssPrivate) return saved;
        return await this.commitWithOptions_abyssPrivate(
          true,
          this.closeNavigation_abyssPrivate,
          this.closeFocusTarget_abyssPrivate,
        );
      });
    }
    const saving = this.saveUntilCurrent_abyssPrivate().catch((error: unknown) => {
      this.handleSaveFailure_abyssPrivate(error);
      return false;
    });
    this.saveInFlight_abyssPrivate = saving;
    const clearInFlight = (): void => {
      if (this.saveInFlight_abyssPrivate === saving) this.saveInFlight_abyssPrivate = undefined;
    };
    saving.then(clearInFlight, clearInFlight);
    return saving;
  }

  private requestCommit_abyssPrivate(
    close: boolean,
    navigation: ProjectCellEditorNavigation,
    focusTarget?: HTMLElement,
  ): void {
    this.commitWithOptions_abyssPrivate(close, navigation, focusTarget).then(
      () => undefined,
      (error: unknown) => {
        this.handleSaveFailure_abyssPrivate(error);
      },
    );
  }

  private readDraft_abyssPrivate(
    control: EditorControl,
  ): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
    try {
      return { ok: true, value: control.value() };
    } catch (error) {
      this.error_abyssPrivate.setText(errorMessage(error));
      this.focus();
      return { ok: false };
    }
  }

  private finishUnchanged_abyssPrivate(): void {
    if (this.closeRequested_abyssPrivate) {
      this.finish_abyssPrivate('committed', this.closeNavigation_abyssPrivate);
    } else {
      this.focus();
    }
  }

  private async persistDraft_abyssPrivate(value: unknown): Promise<boolean> {
    try {
      await this.options_abyssPrivate.save(value);
      return true;
    } catch (error) {
      this.handleSaveFailure_abyssPrivate(error);
      return false;
    }
  }

  private async saveUntilCurrent_abyssPrivate(): Promise<boolean> {
    const control = this.control_abyssPrivate;
    if (control === undefined || !this.validateCurrentType_abyssPrivate()) return false;
    this.error_abyssPrivate.empty();
    while (!this.closed_abyssPrivate) {
      const draft = this.readDraft_abyssPrivate(control);
      if (!draft.ok) return false;
      if (equalValue(draft.value, this.committedValue_abyssPrivate)) {
        this.finishUnchanged_abyssPrivate();
        return true;
      }
      const submitted = copyValue(draft.value);
      if (!(await this.persistDraft_abyssPrivate(submitted))) return false;
      this.committedValue_abyssPrivate = submitted;
    }
    return true;
  }

  private handleSaveFailure_abyssPrivate(error: unknown): void {
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

  private finish_abyssPrivate(
    result: ProjectCellEditorResult,
    navigation: ProjectCellEditorNavigation = 'restore-current',
  ): void {
    if (this.closed_abyssPrivate) return;
    this.destroy();
    this.options_abyssPrivate.onClose(result, {
      navigation,
      ...(this.closeFocusTarget_abyssPrivate === undefined
        ? {}
        : { focusTarget: this.closeFocusTarget_abyssPrivate }),
    });
    if (navigation === 'restore-current') this.options_abyssPrivate.restoreFocus?.();
  }
}

/** Mounts one transient inline editor. The returned handle owns all editor-local cleanup. */
export function mountProjectCellEditor(options: ProjectCellEditorOptions): ProjectCellEditorHandle {
  return new ProjectCellEditorLifecycle(options);
}
