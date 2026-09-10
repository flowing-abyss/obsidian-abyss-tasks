import { Notice, type App } from 'obsidian';
import { exactLinkToken } from '../../markdown/links';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectFieldCatalogItem, ProjectPropertyType } from '../../projects/projectFields';
import { projectTableLinkTargetParts } from '../../projects/projectTableLinkTarget';
import type { ProjectStatus } from '../../settings/types';
import { ProjectPropertySuggest } from '../../ui/ProjectPropertySuggest';
import {
  projectPropertyValuePresentation,
  projectTagLabel,
} from './projectPropertyValuePresentation';

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
  readonly resolveField?: (fieldId: string) => ProjectFieldCatalogItem | undefined;
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
  closeSuggestion(): void;
  destroy(): void;
}

interface EditorControl {
  readonly focusTarget?: HTMLElement;
  readonly suggest?: ProjectPropertySuggest;
  readonly openSuggestionOnFocus?: boolean;
  value(): unknown;
}

interface EditorEvents {
  changed(): void;
  cancel(): void;
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

function suggestOptions(
  options: ProjectCellEditorOptions,
  input: HTMLInputElement,
  suggestion: {
    readonly values: readonly string[];
    readonly suggestions?: ConstructorParameters<typeof ProjectPropertySuggest>[0]['suggestions'];
    readonly exclude?: (value: string) => boolean;
    readonly appearance?: 'tag';
    readonly onPick: (value: string) => void;
    readonly browseOnOpen?: boolean;
  },
  events: EditorEvents,
): ConstructorParameters<typeof ProjectPropertySuggest>[0] {
  return {
    app: options.app,
    input,
    values: suggestion.values,
    onPick: suggestion.onPick,
    ...(suggestion.suggestions === undefined ? {} : { suggestions: suggestion.suggestions }),
    ...(suggestion.exclude === undefined ? {} : { exclude: suggestion.exclude }),
    ...(suggestion.appearance === undefined ? {} : { appearance: suggestion.appearance }),
    ...(suggestion.browseOnOpen === undefined ? {} : { browseOnOpen: suggestion.browseOnOpen }),
    onEscape: () => {
      events.cancel();
    },
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
        browseOnOpen: true,
      },
      events,
    ),
  );
  return { focusTarget: input, suggest, value: () => input.value };
}

function descriptionControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const label = root.createSpan({ cls: 'abyss-sr-only', text: options.field.label });
  label.id = 'abyss-project-description-editor-label';
  const textarea = root.createEl('textarea', {
    cls: 'abyss-project-editor-input abyss-project-description-editor',
    attr: { 'aria-labelledby': label.id },
  });
  textarea.value = typeof options.value === 'string' ? options.value : '';
  textarea.addEventListener('input', () => {
    events.changed();
  });
  return { focusTarget: textarea, value: () => textarea.value };
}

function initialListValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.map(copyValue);
  return value === undefined || value === null || value === '' ? [] : [value];
}

function notifyChanged(events: EditorEvents): void {
  events.changed();
}

function listDraftValue(values: readonly unknown[], input: HTMLInputElement): unknown[] {
  const pending = input.value.trim();
  return pending.length === 0 ? [...values] : [...values, pending];
}

function equivalentListValue(
  options: ProjectCellEditorOptions,
  existing: unknown,
  candidate: string,
): boolean {
  const raw = String(existing);
  if (raw.toLocaleLowerCase() === candidate.toLocaleLowerCase()) return true;
  const existingLink = exactLinkToken(raw);
  const candidateLink = exactLinkToken(candidate);
  if (existingLink === undefined || candidateLink === undefined) return false;
  const existingParts = projectTableLinkTargetParts(existingLink);
  const candidateParts = projectTableLinkTargetParts(candidateLink);
  if (existingParts.externalTarget !== undefined || candidateParts.externalTarget !== undefined)
    return false;
  const sourcePath = options.sourcePath ?? '';
  const existingFile = options.app.metadataCache.getFirstLinkpathDest(
    existingParts.resolverTarget,
    sourcePath,
  );
  const candidateFile = options.app.metadataCache.getFirstLinkpathDest(
    candidateParts.resolverTarget,
    sourcePath,
  );
  return (
    existingFile !== null &&
    candidateFile !== null &&
    existingFile.path.toLocaleLowerCase() === candidateFile.path.toLocaleLowerCase()
  );
}

function listControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const values = initialListValues(options.value);
  const control = root.createDiv({ cls: 'abyss-project-list-control' });
  const list = control.createDiv({ cls: 'abyss-project-list-values' });
  const inputRow = control.createDiv({ cls: 'abyss-project-list-entry' });
  const input = inputRow.createEl('input', {
    cls: 'abyss-project-editor-input abyss-project-list-input',
    attr: { type: 'text', 'aria-label': `Add ${options.field.label}`, autocomplete: 'off' },
  });
  input.addEventListener('input', () => {
    notifyChanged(events);
  });
  const renderValues = (): void => {
    list.empty();
    values.forEach((value, index) => {
      const item = list.createDiv({
        cls: `abyss-project-list-value${options.field.type === 'tags' ? ' is-tag' : ''}`,
      });
      const presentation = projectPropertyValuePresentation(String(value));
      const displayed =
        options.field.type === 'tags' ? projectTagLabel(presentation.label) : presentation.label;
      item.createSpan({
        cls: `abyss-project-list-value-text${presentation.link === undefined ? '' : ' is-link'}${options.field.type === 'tags' ? ' tag' : ''}`,
        text: displayed,
      });
      const remove = item.createEl('button', {
        cls: 'abyss-project-list-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': `Remove ${displayed}` },
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
  renderValues();
  const suggestions =
    options.field.property === undefined ? [] : options.catalog.values(options.field.property);
  const suggest = new ProjectPropertySuggest(
    suggestOptions(
      options,
      input,
      {
        values: suggestions,
        ...(options.field.type === 'tags' ? { appearance: 'tag' as const } : {}),
        exclude: (candidate) =>
          values.some((value) => equivalentListValue(options, value, candidate)),
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
    value: () => listDraftValue(values, input),
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
      return options.field.id === 'description'
        ? descriptionControl(options, root, events)
        : textControl(options, root, events);
    case 'list':
    case 'tags':
      return listControl(options, root, events);
    case 'number':
      return numberControl(root, options.field.label, options.value, events);
    case 'checkbox': {
      const input = root.createEl('input', {
        cls: 'abyss-project-editor-checkbox metadata-input-checkbox',
        attr: {
          type: 'checkbox',
          'aria-label': options.field.label,
          'data-indeterminate': String(options.value !== true && options.value !== false),
        },
      });
      input.checked = options.value === true;
      input.indeterminate = false;
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
  const input = root.createEl('input', {
    cls: 'abyss-project-editor-status',
    attr: { type: 'text', readonly: '', 'aria-label': options.field.label, autocomplete: 'off' },
  });
  let current = typeof options.value === 'string' ? options.value : '';
  input.value = current.length === 0 ? 'No status' : current;
  const configured = options.statuses ?? [];
  const suggestions = [
    { kind: 'value' as const, value: '', label: 'No status', appearance: 'status' as const },
    ...(current.length > 0 && !configured.some(({ name }) => name === current)
      ? [{ kind: 'value' as const, value: current, label: current, appearance: 'status' as const }]
      : []),
    ...configured.map(({ name, color }) => ({
      kind: 'value' as const,
      value: name,
      label: name,
      appearance: 'status' as const,
      ...(color === undefined ? {} : { color }),
    })),
  ];
  const suggest = new ProjectPropertySuggest(
    suggestOptions(
      options,
      input,
      {
        values: [],
        suggestions,
        browseOnOpen: true,
        onPick: (value) => {
          current = value;
          input.value = value.length === 0 ? 'No status' : value;
          events.changed();
          events.commit(true);
        },
      },
      events,
    ),
  );
  return { focusTarget: input, suggest, openSuggestionOnFocus: true, value: () => current };
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
      cancel: () => {
        this.cancel();
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
  }

  commit(): Promise<boolean> {
    return this.commitWithOptions_abyssPrivate(true, 'restore-current');
  }

  cancel(): void {
    this.finish_abyssPrivate('cancelled');
  }

  focus(): void {
    this.control_abyssPrivate?.focusTarget?.focus({ preventScroll: true });
    if (this.control_abyssPrivate?.openSuggestionOnFocus === true) {
      this.control_abyssPrivate.suggest?.open();
    }
  }

  closeSuggestion(): void {
    this.control_abyssPrivate?.suggest?.close();
  }

  destroy(): void {
    if (this.closed_abyssPrivate) return;
    this.closed_abyssPrivate = true;
    this.clearOwnedPointer_abyssPrivate();
    this.closeSuggestion();
    this.element.remove();
  }

  private renderUnavailable_abyssPrivate(): void {
    const { field } = this.options_abyssPrivate;
    this.error_abyssPrivate.setText(
      field.type === null
        ? 'Project property type is not configured. Choose a Type in project settings.'
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
    if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement) return;
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
    const { field, resolveField } = this.options_abyssPrivate;
    if (!field.id.startsWith('property:')) return true;
    if (resolveField === undefined) return true;
    const configured = resolveField(field.id);
    const matches =
      configured !== undefined &&
      configured.type !== null &&
      configured.id === field.id &&
      configured.property === field.property &&
      configured.type === field.type;
    if (matches) return true;
    this.error_abyssPrivate.setText(
      'This project property configuration changed. Close and reopen the editor.',
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
