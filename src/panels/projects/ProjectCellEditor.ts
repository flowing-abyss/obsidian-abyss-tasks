import { Notice, type App } from 'obsidian';
import { exactLinkToken } from '../../markdown/links';
import type { ProjectPropertyCatalog } from '../../projects/ObsidianProjectProperties';
import { isProjectEditValidationError } from '../../projects/projectEditError';
import type { ProjectFieldCatalogItem, ProjectPropertyType } from '../../projects/projectFields';
import { projectPropertyPresetIdentity } from '../../projects/projectPropertyPresets';
import { projectTableLinkTargetParts } from '../../projects/projectTableLinkTarget';
import { projectStatusDisplayName } from '../../projects/status';
import type { ProjectStatus } from '../../settings/types';
import { normalizeTag } from '../../tags/markdownTagRename';
import type { ProjectPropertySuggestion } from '../../ui/ProjectPropertySuggest';
import {
  projectPropertyValuePresentation,
  projectTagLabel,
} from '../../ui/projectPropertyValuePresentation';
import { mountProjectCellValuePicker } from './projectCellValuePicker';

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
  readonly presets?: readonly ProjectPropertySuggestion[];
  readonly sourceField?: string;
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
  readonly preferredWidth: number | undefined;
  commit(): Promise<boolean>;
  cancel(): void;
  focus(): void;
  closeSuggestion(): void;
  destroy(): void;
}

interface EditorControl {
  readonly focusTarget?: HTMLElement;
  readonly preferredWidth?: number;
  value(): unknown;
  destroy?(): void;
}

interface EditorEvents {
  changed(): void;
  cancel(): void;
  commit(close: boolean): void;
  invalid(message: string): void;
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

function unchangedDraft(
  changed: boolean,
  value: unknown,
  initialValue: unknown,
  committedValue: unknown,
): boolean {
  return (!changed && equalValue(value, initialValue)) || equalValue(value, committedValue);
}

function initialControlValue(control: EditorControl | undefined, source: unknown): unknown {
  if (control === undefined) return copyValue(source);
  try {
    return copyValue(control.value());
  } catch {
    return copyValue(source);
  }
}

function appendSuggestion(
  options: ProjectCellEditorOptions,
  result: ProjectPropertySuggestion[],
  seen: Set<string>,
  suggestion: ProjectPropertySuggestion,
): void {
  const identity = editorValueIdentity(options, suggestion.value);
  if (seen.has(identity)) return;
  seen.add(identity);
  result.push(
    options.field.type === 'tags' && suggestion.appearance === undefined
      ? { ...suggestion, appearance: 'tag' }
      : suggestion,
  );
}

function editorValueIdentity(options: ProjectCellEditorOptions, value: unknown): string {
  if (options.field.type === 'tags' && typeof value === 'string') {
    const tag = normalizeTag(value);
    if (tag !== null) return `tag:${tag}`;
  }
  return projectPropertyPresetIdentity(value);
}

function catalogSuggestion(
  options: ProjectCellEditorOptions,
  value: string,
): ProjectPropertySuggestion | undefined {
  const presentation = projectPropertyValuePresentation(value);
  let rawValue: string | number = value;
  if (options.field.type === 'number') {
    if (value.trim() === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    rawValue = number;
  }
  return {
    kind: 'value',
    value: rawValue,
    label: options.field.type === 'tags' ? projectTagLabel(presentation.label) : presentation.label,
    ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
    ...(options.field.type === 'tags' ? { appearance: 'tag' as const } : {}),
  };
}

function withCollidingLinkDetails(
  suggestions: readonly ProjectPropertySuggestion[],
): ProjectPropertySuggestion[] {
  const counts = new Map<string, number>();
  for (const suggestion of suggestions) {
    if (projectPropertyValuePresentation(String(suggestion.value)).link === undefined) continue;
    const key = suggestion.label.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return suggestions.map((suggestion) => {
    const link = projectPropertyValuePresentation(String(suggestion.value)).link;
    return link !== undefined && (counts.get(suggestion.label.toLocaleLowerCase()) ?? 0) > 1
      ? { ...suggestion, detail: suggestion.detail ?? link.target }
      : suggestion;
  });
}

function mergedSuggestions(options: ProjectCellEditorOptions): ProjectPropertySuggestion[] {
  const result: ProjectPropertySuggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of options.presets ?? [])
    appendSuggestion(options, result, seen, suggestion);
  const source = options.sourceField ?? options.field.property;
  const catalogValues = source === undefined ? [] : options.catalog.values(source);
  for (const value of catalogValues) {
    const suggestion = catalogSuggestion(options, value);
    if (suggestion !== undefined) appendSuggestion(options, result, seen, suggestion);
  }
  return withCollidingLinkDetails(result);
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
  return { focusTarget: input, value: () => input.value };
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
    attr: { 'aria-labelledby': label.id, placeholder: 'Description' },
  });
  textarea.value = typeof options.value === 'string' ? options.value : '';
  textarea.addEventListener('input', () => {
    events.changed();
  });
  return { focusTarget: textarea, value: () => textarea.value };
}

function internalLinkPath(options: ProjectCellEditorOptions, value: string): string | undefined {
  const link = exactLinkToken(value);
  if (link === undefined) return undefined;
  const parts = projectTableLinkTargetParts(link);
  if (parts.externalTarget !== undefined) return undefined;
  return options.app.metadataCache
    .getFirstLinkpathDest(parts.resolverTarget, options.sourcePath ?? '')
    ?.path.toLocaleLowerCase();
}

function equivalentListValue(
  options: ProjectCellEditorOptions,
  existing: unknown,
  candidate: unknown,
): boolean {
  if (options.field.type === 'tags') {
    return editorValueIdentity(options, existing) === editorValueIdentity(options, candidate);
  }
  if (Object.is(existing, candidate)) return true;
  if (typeof existing !== 'string' || typeof candidate !== 'string') return false;
  const existingPath = internalLinkPath(options, existing);
  return existingPath !== undefined && existingPath === internalLinkPath(options, candidate);
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
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const { label } = options.field;
  const value = options.value;
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

function numberPickerLiteral(options: ProjectCellEditorOptions, query: string): number {
  const value = Number(query);
  if (!Number.isFinite(value)) throw new Error(`${options.field.label} must be a finite number.`);
  return value;
}

function pickerAppearance(options: ProjectCellEditorOptions): 'status' | 'tag' | undefined {
  if (options.field.type === 'tags') return 'tag';
  if (options.field.type === 'status') return 'status';
  return undefined;
}

function valuePickerControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
  suggestions: readonly ProjectPropertySuggestion[],
): EditorControl {
  const appearance = pickerAppearance(options);
  const literal =
    options.field.type === 'number'
      ? (query: string): number => numberPickerLiteral(options, query)
      : (query: string): string => query;
  return mountProjectCellValuePicker({
    root,
    label: options.field.label,
    multiple: options.field.type === 'list' || options.field.type === 'tags',
    value: options.value,
    suggestions,
    ...(appearance === undefined ? {} : { appearance }),
    equivalent: (left, right) => equivalentListValue(options, left, right),
    literal,
    onChange: () => {
      events.changed();
    },
    onCommit: () => {
      events.commit(false);
    },
    onInvalid: (message) => {
      events.invalid(message);
    },
  });
}

function textPropertyControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  if (options.field.id === 'description') return descriptionControl(options, root, events);
  const suggestions = mergedSuggestions(options);
  return suggestions.length === 0
    ? textControl(options, root, events)
    : valuePickerControl(options, root, events, suggestions);
}

function numberPropertyControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  events: EditorEvents,
): EditorControl {
  const suggestions = mergedSuggestions(options);
  return suggestions.length === 0
    ? numberControl(options, root, events)
    : valuePickerControl(options, root, events, suggestions);
}

function propertyControl(
  options: ProjectCellEditorOptions,
  root: HTMLElement,
  type: ProjectPropertyType,
  events: EditorEvents,
): EditorControl {
  switch (type) {
    case 'text':
      return textPropertyControl(options, root, events);
    case 'list':
    case 'tags':
      return valuePickerControl(options, root, events, mergedSuggestions(options));
    case 'number':
      return numberPropertyControl(options, root, events);
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
  const current = typeof options.value === 'string' ? options.value : '';
  const configured = options.statuses ?? [];
  const catalogValues = options.catalog.values(options.sourceField ?? options.field.property ?? '');
  const unknown = catalogValues.filter(
    (value) => !configured.some(({ name }) => name === value) && value !== current,
  );
  const suggestions = [
    ...(current.length > 0 && !configured.some(({ name }) => name === current)
      ? [{ kind: 'value' as const, value: current, label: current, appearance: 'status' as const }]
      : []),
    ...configured.map((status) => ({
      kind: 'value' as const,
      value: status.name,
      label: projectStatusDisplayName(status),
      appearance: 'status' as const,
      display: status.display ?? 'badge',
      ...(status.color === undefined ? {} : { color: status.color }),
    })),
    ...unknown.map((value) => ({
      kind: 'value' as const,
      value,
      label: value,
      appearance: 'status' as const,
    })),
  ];
  return valuePickerControl(options, root, events, suggestions);
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
  private initialDraftValue_abyssPrivate: unknown;
  private changed_abyssPrivate = false;
  private saveInFlight_abyssPrivate: Promise<boolean> | undefined;
  private savePending_abyssPrivate = false;
  private closeRequested_abyssPrivate = false;
  private closeNavigation_abyssPrivate: ProjectCellEditorNavigation = 'restore-current';
  private closeFocusTarget_abyssPrivate: HTMLElement | undefined;
  private ownedPointerActive_abyssPrivate = false;
  private ownedPointerCleanup_abyssPrivate: (() => void) | undefined;
  private closed_abyssPrivate = false;

  constructor(private readonly options_abyssPrivate: ProjectCellEditorOptions) {
    this.committedValue_abyssPrivate = copyValue(options_abyssPrivate.value);
    this.initialDraftValue_abyssPrivate = copyValue(options_abyssPrivate.value);
    this.element = options_abyssPrivate.container.createDiv({ cls: 'abyss-project-cell-editor' });
    this.error_abyssPrivate = this.element.createDiv({
      cls: 'abyss-project-editor-error',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });
    const events: EditorEvents = {
      changed: () => {
        this.changed_abyssPrivate = true;
        this.error_abyssPrivate.empty();
      },
      cancel: () => {
        this.cancel();
      },
      commit: (close) => {
        this.requestCommit_abyssPrivate(close, 'restore-current');
      },
      invalid: (message) => {
        this.error_abyssPrivate.setText(message);
        this.focus();
      },
    };
    this.control_abyssPrivate = buildControl(options_abyssPrivate, this.element, events);
    this.initialDraftValue_abyssPrivate = initialControlValue(
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
    this.element.addEventListener('pointerdown', this.onOwnedPointerDown_abyssPrivate, true);
    this.element.addEventListener('click', () => {
      this.clearOwnedPointer_abyssPrivate();
    });
    this.element.ownerDocument.addEventListener(
      'pointerdown',
      this.onDocumentPointerDown_abyssPrivate,
      true,
    );
  }

  get preferredWidth(): number | undefined {
    return this.control_abyssPrivate?.preferredWidth;
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

  closeSuggestion(): void {}

  destroy(): void {
    if (this.closed_abyssPrivate) return;
    this.closed_abyssPrivate = true;
    this.clearOwnedPointer_abyssPrivate();
    this.control_abyssPrivate?.destroy?.();
    this.element.ownerDocument.removeEventListener(
      'pointerdown',
      this.onDocumentPointerDown_abyssPrivate,
      true,
    );
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
      return;
    }
    if (this.ownedPointerActive_abyssPrivate) {
      return;
    }
    queueMicrotask(() => {
      if (this.closed_abyssPrivate) return;
      const active = this.element.ownerDocument.activeElement;
      if (active instanceof Node && this.element.contains(active)) return;
      this.requestCommit_abyssPrivate(
        true,
        'preserve-focus',
        next instanceof HTMLElement ? next : undefined,
      );
    });
  };

  private readonly onDocumentPointerDown_abyssPrivate = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && this.element.contains(target)) return;
    this.requestCommit_abyssPrivate(
      true,
      'preserve-focus',
      target instanceof HTMLElement ? target : undefined,
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
      this.savePending_abyssPrivate = true;
      return inFlight.then(async (saved): Promise<boolean> => {
        if (!saved) {
          this.savePending_abyssPrivate = false;
          return false;
        }
        if (this.closed_abyssPrivate || !this.savePending_abyssPrivate) return saved;
        this.savePending_abyssPrivate = false;
        return await this.commitWithOptions_abyssPrivate(
          this.closeRequested_abyssPrivate,
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
      if (
        unchangedDraft(
          this.changed_abyssPrivate,
          draft.value,
          this.initialDraftValue_abyssPrivate,
          this.committedValue_abyssPrivate,
        )
      ) {
        this.finishUnchanged_abyssPrivate();
        return true;
      }
      const submitted = copyValue(draft.value);
      if (!(await this.persistDraft_abyssPrivate(submitted))) return false;
      this.committedValue_abyssPrivate = submitted;
      this.initialDraftValue_abyssPrivate = copyValue(submitted);
      this.changed_abyssPrivate = false;
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
