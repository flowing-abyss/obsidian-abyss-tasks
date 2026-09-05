import {
  parseRecurrenceRule,
  type LocalDate,
  type RecurrenceParseResult,
  type RecurrencePolicy,
  type SubtaskSnapshot,
  type TaskCommandResult,
  type TaskOccurrenceResult,
  type TaskPatch,
} from '../../tasks';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../interactionOwnership';
import { runAsyncAction } from '../runAsyncAction';
import type { RecurrenceEditorDraft } from '../taskDraftContinuity';
import type { TaskSelectionNode } from '../taskSelection';
import {
  buildRecurrenceRule,
  recurrencePresetRule,
  type MonthlyChoice,
  type Preset,
  type Unit,
  type Weekday,
  type YearlyChoice,
} from './recurrenceEditorModel';
import { recurrenceIssueText } from './renderRecurrenceBadge';

export interface RecurrenceEditorOptions {
  readonly container: HTMLElement;
  readonly source: TaskOccurrenceResult;
  readonly policy: RecurrencePolicy;
  readonly ownershipConflict: boolean;
  readonly onSubmit: (patch: TaskPatch) => Promise<TaskCommandResult>;
  readonly onClose: () => void;
  readonly dismissalFocus?: HTMLElement;
}

export interface RecurrenceEditorHandle {
  destroy(): void;
  dismiss(): void;
  focus(): void;
  captureDraftState(): RecurrenceEditorDraft;
  restoreDraftState(draft: RecurrenceEditorDraft): void;
}

export interface AnchoredRecurrenceEditorOptions extends Omit<
  RecurrenceEditorOptions,
  'container' | 'dismissalFocus' | 'onClose'
> {
  readonly anchor: HTMLElement;
  readonly onClose?: () => void;
  readonly interactionOwnership?: InteractionOwnershipPort;
}

type Month = Extract<YearlyChoice, { type: 'date' }>['month'];

interface EditorState {
  mode: 'structured' | 'custom';
  preset: Preset | undefined;
  intervalText: string;
  unit: Unit;
  weekdays: Weekday[];
  monthly: MonthlyChoice;
  yearly: YearlyChoice;
  whenDone: boolean;
  customDraft: string;
  onCompletion: 'keep' | 'delete';
  submitting: boolean;
  submissionError: string | undefined;
  dirty: boolean;
}

const WEEKDAYS: readonly Weekday[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const PRESET_LABELS: ReadonlyArray<readonly [Preset, string]> = [
  ['daily', 'Daily'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
];

const MONTHLY_ORDINALS = [
  [1, 'First'],
  [2, 'Second'],
  [3, 'Third'],
  [4, 'Fourth'],
  [-1, 'Last'],
  [-2, 'Second last'],
] as const;

let nextEditorInstance = 0;

function selectedTask(source: TaskOccurrenceResult): TaskSelectionNode | undefined {
  if (source.target.type === 'task') return source.root;
  const path = [];
  let current = source.target.ref;
  path.push(current);
  while (current.parent.type === 'subtask') {
    current = current.parent.ref;
    path.push(current);
  }
  path.reverse();
  let selected: TaskSelectionNode = source.root;
  for (const ref of path) {
    const child: SubtaskSnapshot | undefined = selected.subtasks.find(
      (candidate) =>
        candidate.ref.relativeLine === ref.relativeLine &&
        candidate.ref.originalBlock === ref.originalBlock,
    );
    if (child == null) return undefined;
    selected = child;
  }
  return selected;
}

function referenceDate(
  source: TaskOccurrenceResult,
  policy: RecurrencePolicy,
): LocalDate | undefined {
  const planning = selectedTask(source)?.planning;
  if (planning == null) return undefined;
  return policy.removeScheduledDate
    ? (planning.due ?? planning.start ?? planning.scheduled)
    : (planning.due ?? planning.scheduled ?? planning.start);
}

function weekdayForReference(reference: LocalDate): Weekday {
  return recurrencePresetRule('weekly', reference).slice('every week on '.length) as Weekday;
}

function addOption(
  select: HTMLSelectElement,
  value: string,
  label: string,
  selected: boolean,
): void {
  select.createEl('option', { text: label, attr: { value } }).selected = selected;
}

function precedingNonWhitespace(value: string, end: number): number {
  let cursor = end;
  while (cursor > 0 && /\s/u.test(value[cursor - 1] ?? '')) cursor--;
  return cursor;
}

function terminalWordStart(value: string, end: number, word: string): number | undefined {
  const start = end - word.length;
  if (start < 0 || value.slice(start, end).toLowerCase() !== word) return undefined;
  if (start > 0 && !/\s/u.test(value[start - 1] ?? '')) return undefined;
  return start;
}

function stripOneTerminalWhenDone(value: string): string | undefined {
  const doneStart = terminalWordStart(value, value.length, 'done');
  if (doneStart === undefined || doneStart === 0) return undefined;
  const whenEnd = precedingNonWhitespace(value, doneStart);
  const whenStart = terminalWordStart(value, whenEnd, 'when');
  if (whenStart === undefined) return undefined;
  return value.slice(0, whenStart).trimEnd();
}

function withoutTerminalWhenDone(raw: string): string {
  let base = raw.trimEnd();
  for (;;) {
    const stripped = stripOneTerminalWhenDone(base);
    if (stripped === undefined) return base;
    base = stripped;
  }
}

function withTerminalWhenDone(raw: string, whenDone: boolean): string {
  const base = withoutTerminalWhenDone(raw);
  return `${base}${whenDone ? ' when done' : ''}`;
}

function initialWeekdays(reference: LocalDate | undefined): Weekday[] {
  return reference === undefined ? ['Monday'] : [weekdayForReference(reference)];
}

function initialWhenDone(existing: string | undefined): boolean {
  if (existing === undefined) return false;
  const parsed = parseRecurrenceRule(existing);
  return parsed.type === 'valid' && parsed.whenDone;
}

function initialEditorState(
  task: TaskSelectionNode | undefined,
  reference: LocalDate | undefined,
): EditorState {
  const existing = task?.recurrence;
  return {
    mode: existing === undefined ? 'structured' : 'custom',
    preset: existing === undefined ? 'daily' : undefined,
    intervalText: '1',
    unit: 'days',
    weekdays: initialWeekdays(reference),
    monthly: { type: 'same-date' },
    yearly: { type: 'same-date' },
    whenDone: initialWhenDone(existing),
    customDraft: existing ?? 'every day',
    onCompletion: task?.onCompletion ?? 'keep',
    submitting: false,
    submissionError: undefined,
    dirty: false,
  };
}

function selectionState(
  input: HTMLInputElement | HTMLTextAreaElement | undefined,
): Partial<Pick<RecurrenceEditorDraft, 'selectionStart' | 'selectionEnd'>> {
  if (input === undefined) return {};
  const start = input.selectionStart;
  const end = input.selectionEnd;
  return {
    ...(start !== null && { selectionStart: start }),
    ...(end !== null && { selectionEnd: end }),
  };
}

function monthlyChoiceFromValue(value: string): MonthlyChoice {
  if (value === 'day') return { type: 'day', day: 1 };
  if (value === 'first' || value === 'last') return { type: 'edge', edge: value };
  if (value === 'weekday') return { type: 'weekday', ordinal: 1, weekday: 'Monday' };
  return { type: 'same-date' };
}

export function mountRecurrenceEditor(options: RecurrenceEditorOptions): RecurrenceEditorHandle {
  const controller = new RecurrenceEditorController(options);
  controller.mount();
  return controller;
}

class RecurrenceEditorController implements RecurrenceEditorHandle {
  private readonly titleId_abyssPrivate = `abyss-recurrence-title-${++nextEditorInstance}`;
  private readonly diagnosticId_abyssPrivate = `abyss-recurrence-diagnostic-${nextEditorInstance}`;
  private readonly task_abyssPrivate: TaskSelectionNode | undefined;
  private readonly reference_abyssPrivate: LocalDate | undefined;
  private readonly previousFocus_abyssPrivate: Element | null;
  private readonly state_abyssPrivate: EditorState;
  private readonly ownerWindow_abyssPrivate: Window | null;

  constructor(private readonly options_abyssPrivate: RecurrenceEditorOptions) {
    this.task_abyssPrivate = selectedTask(options_abyssPrivate.source);
    this.reference_abyssPrivate = referenceDate(
      options_abyssPrivate.source,
      options_abyssPrivate.policy,
    );
    this.previousFocus_abyssPrivate = options_abyssPrivate.container.ownerDocument.activeElement;
    this.ownerWindow_abyssPrivate = options_abyssPrivate.container.ownerDocument.defaultView;
    this.state_abyssPrivate = initialEditorState(
      this.task_abyssPrivate,
      this.reference_abyssPrivate,
    );
  }

  mount(): void {
    this.ownerWindow_abyssPrivate?.addEventListener(
      'keydown',
      this.submitShortcutHandler_abyssPrivate,
      true,
    );
    this.options_abyssPrivate.container.addEventListener('keydown', this.keyHandler_abyssPrivate);
    this.render_abyssPrivate();
  }

  destroy(): void {
    this.ownerWindow_abyssPrivate?.removeEventListener(
      'keydown',
      this.submitShortcutHandler_abyssPrivate,
      true,
    );
    this.options_abyssPrivate.container.removeEventListener(
      'keydown',
      this.keyHandler_abyssPrivate,
    );
    this.options_abyssPrivate.container.empty();
  }

  dismiss(): void {
    this.options_abyssPrivate.onClose();
    this.restoreFocus_abyssPrivate();
  }

  focus(): void {
    const selector =
      this.state_abyssPrivate.mode === 'custom'
        ? '[aria-label="Recurrence rule"]'
        : '[aria-pressed="true"], [aria-label="Repeat interval"]';
    this.options_abyssPrivate.container.querySelector<HTMLElement>(selector)?.focus();
  }

  captureDraftState(): RecurrenceEditorDraft {
    const active = this.options_abyssPrivate.container.ownerDocument.activeElement;
    const input = this.textInput_abyssPrivate(active);
    const focusedControl = this.controlKey_abyssPrivate(active);
    return {
      mode: this.state_abyssPrivate.mode,
      ...(this.state_abyssPrivate.preset !== undefined && {
        preset: this.state_abyssPrivate.preset,
      }),
      intervalText: this.state_abyssPrivate.intervalText,
      unit: this.state_abyssPrivate.unit,
      weekdays: [...this.state_abyssPrivate.weekdays],
      monthly: this.state_abyssPrivate.monthly,
      yearly: this.state_abyssPrivate.yearly,
      whenDone: this.state_abyssPrivate.whenDone,
      onCompletion: this.state_abyssPrivate.onCompletion,
      customDraft: this.state_abyssPrivate.customDraft,
      ...(focusedControl !== undefined && { focusedControl }),
      ...selectionState(input),
      dirty: this.state_abyssPrivate.dirty,
    };
  }

  restoreDraftState(draft: RecurrenceEditorDraft): void {
    Object.assign(this.state_abyssPrivate, {
      mode: draft.mode,
      preset: draft.preset,
      intervalText: draft.intervalText,
      unit: draft.unit,
      weekdays: [...draft.weekdays],
      monthly: draft.monthly,
      yearly: draft.yearly,
      whenDone: draft.whenDone,
      onCompletion: draft.onCompletion,
      customDraft: draft.customDraft,
      dirty: draft.dirty,
      submissionError: undefined,
    });
    this.render_abyssPrivate();
    this.restoreDraftFocus_abyssPrivate(draft);
  }

  private restoreFocus_abyssPrivate(): void {
    if (this.options_abyssPrivate.dismissalFocus?.isConnected === true) {
      this.options_abyssPrivate.dismissalFocus.focus();
      return;
    }
    if (
      this.previousFocus_abyssPrivate instanceof HTMLElement &&
      this.previousFocus_abyssPrivate.isConnected
    ) {
      this.previousFocus_abyssPrivate.focus();
    }
  }

  private textInput_abyssPrivate(
    element: Element | null,
  ): HTMLInputElement | HTMLTextAreaElement | undefined {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element
      : undefined;
  }

  private controlKey_abyssPrivate(element: Element | null): string | undefined {
    if (
      !(element instanceof HTMLElement) ||
      !this.options_abyssPrivate.container.contains(element)
    ) {
      return undefined;
    }
    return element.dataset['recurrenceFocusKey'];
  }

  private controlForKey_abyssPrivate(key: string | undefined): HTMLElement | undefined {
    if (key === undefined || key.length === 0) return undefined;
    const controls = this.options_abyssPrivate.container.querySelectorAll<HTMLElement>(
      '[data-recurrence-focus-key]',
    );
    return [...controls].find((control) => this.controlKey_abyssPrivate(control) === key);
  }

  private restoreDraftFocus_abyssPrivate(draft: RecurrenceEditorDraft): void {
    const control = this.controlForKey_abyssPrivate(draft.focusedControl);
    control?.focus();
    if (
      control instanceof HTMLInputElement &&
      draft.selectionStart !== undefined &&
      draft.selectionEnd !== undefined
    ) {
      control.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    }
  }

  private parseState_abyssPrivate(): RecurrenceParseResult {
    if (this.state_abyssPrivate.mode === 'custom')
      return parseRecurrenceRule(this.state_abyssPrivate.customDraft);
    if (this.state_abyssPrivate.preset === 'weekdays') {
      return parseRecurrenceRule(
        `every weekday${this.state_abyssPrivate.whenDone ? ' when done' : ''}`,
      );
    }
    return buildRecurrenceRule({
      interval: Number(this.state_abyssPrivate.intervalText),
      unit: this.state_abyssPrivate.unit,
      weekdays: this.state_abyssPrivate.weekdays,
      monthly: this.state_abyssPrivate.monthly,
      yearly: this.state_abyssPrivate.yearly,
      whenDone: this.state_abyssPrivate.whenDone,
    });
  }

  private canonicalPreset_abyssPrivate(): Preset | undefined {
    if (this.state_abyssPrivate.mode === 'custom') return undefined;
    const parsed = this.parseState_abyssPrivate();
    if (parsed.type === 'invalid') return undefined;
    const candidates: ReadonlyArray<readonly [Preset, string]> = [
      ['daily', 'every day'],
      ['weekdays', 'every weekday'],
      ...(this.reference_abyssPrivate === undefined
        ? []
        : ([['weekly', recurrencePresetRule('weekly', this.reference_abyssPrivate)]] as const)),
      ['monthly', 'every month'],
      ['yearly', 'every year'],
    ];
    return candidates.find(([, rule]) => parsed.canonical === rule)?.[0];
  }

  private validationMessage_abyssPrivate(parsed: RecurrenceParseResult): string {
    if (this.options_abyssPrivate.ownershipConflict)
      return 'Remove the nested repeat conflict first.';
    if (this.reference_abyssPrivate == null) return 'Add a date before setting a repeat.';
    if (this.hasInvalidInterval_abyssPrivate()) return 'Use a whole number greater than zero.';
    if (
      this.state_abyssPrivate.submissionError !== undefined &&
      this.state_abyssPrivate.submissionError.length > 0
    ) {
      return this.state_abyssPrivate.submissionError;
    }
    return parsed.type === 'invalid' ? recurrenceIssueText(parsed.code) : '';
  }

  private hasInvalidInterval_abyssPrivate(): boolean {
    const interval = Number(this.state_abyssPrivate.intervalText);
    return (
      this.state_abyssPrivate.mode === 'structured' &&
      this.state_abyssPrivate.preset !== 'weekdays' &&
      (!Number.isSafeInteger(interval) || interval < 1)
    );
  }

  private refresh_abyssPrivate(): void {
    const parsed = this.parseState_abyssPrivate();
    if (this.state_abyssPrivate.mode === 'custom' && parsed.type === 'valid') {
      this.state_abyssPrivate.whenDone = parsed.whenDone;
    }
    const message = this.validationMessage_abyssPrivate(parsed);
    this.refreshPreview_abyssPrivate(parsed);
    this.refreshStatus_abyssPrivate(message);
    this.refreshDeleteWarning_abyssPrivate();
    this.refreshWhenDone_abyssPrivate(parsed);
    this.refreshSaveButton_abyssPrivate(parsed, message);
    this.refreshPresetButtons_abyssPrivate();
    this.refreshValidity_abyssPrivate(parsed);
  }

  private refreshPreview_abyssPrivate(parsed: RecurrenceParseResult): void {
    const preview = this.options_abyssPrivate.container.querySelector<HTMLElement>(
      '.abyss-recurrence-preview-rule',
    );
    if (preview === null) return;
    const suffix = parsed.type === 'valid' && parsed.whenDone ? ' when done' : '';
    preview.textContent = parsed.type === 'valid' ? `${parsed.canonical}${suffix}` : '—';
  }

  private refreshStatus_abyssPrivate(message: string): void {
    const status = this.options_abyssPrivate.container.querySelector<HTMLElement>(
      '.abyss-recurrence-status',
    );
    if (status === null) return;
    status.textContent = message;
    status.hidden = message.length === 0;
  }

  private refreshDeleteWarning_abyssPrivate(): void {
    const warning = this.options_abyssPrivate.container.querySelector<HTMLElement>(
      '.abyss-recurrence-delete-warning',
    );
    if (warning === null) return;
    const deletes = this.state_abyssPrivate.onCompletion === 'delete';
    warning.textContent = deletes
      ? 'Completing this repeat deletes the finished task and its owned sub-tasks.'
      : '';
    warning.hidden = !deletes;
  }

  private refreshWhenDone_abyssPrivate(parsed: RecurrenceParseResult): void {
    if (this.state_abyssPrivate.mode !== 'custom' || parsed.type !== 'valid') return;
    const input = this.options_abyssPrivate.container.querySelector<HTMLInputElement>(
      '.abyss-recurrence-when-done',
    );
    if (input !== null) input.checked = parsed.whenDone;
  }

  private refreshSaveButton_abyssPrivate(parsed: RecurrenceParseResult, message: string): void {
    const save =
      this.options_abyssPrivate.container.querySelector<HTMLButtonElement>(
        '.abyss-recurrence-save',
      );
    if (save !== null) {
      save.disabled =
        this.state_abyssPrivate.submitting || message.length > 0 || parsed.type === 'invalid';
    }
  }

  private refreshPresetButtons_abyssPrivate(): void {
    const pressedPreset = this.canonicalPreset_abyssPrivate();
    const buttons = this.options_abyssPrivate.container.querySelectorAll<HTMLButtonElement>(
      '.abyss-recurrence-presets button',
    );
    for (const button of buttons) {
      const preset = button.dataset['recurrencePreset'] as Preset | undefined;
      const pressed =
        button.dataset['recurrenceMode'] === 'custom'
          ? this.state_abyssPrivate.mode === 'custom'
          : preset !== undefined && preset === pressedPreset;
      button.setAttribute('aria-pressed', String(pressed));
    }
  }

  private refreshValidity_abyssPrivate(parsed: RecurrenceParseResult): void {
    this.setInvalid_abyssPrivate(
      '.abyss-recurrence-interval',
      this.hasInvalidInterval_abyssPrivate(),
    );
    this.setInvalid_abyssPrivate(
      '.abyss-recurrence-month-day',
      this.hasInvalidMonthlyDay_abyssPrivate(),
    );
    this.setInvalid_abyssPrivate(
      '.abyss-recurrence-yearly-day',
      this.hasInvalidYearlyDay_abyssPrivate(),
    );
    this.setInvalid_abyssPrivate(
      '.abyss-recurrence-raw',
      this.state_abyssPrivate.mode === 'custom' && parsed.type === 'invalid',
    );
  }

  private hasInvalidMonthlyDay_abyssPrivate(): boolean {
    const choice = this.state_abyssPrivate.monthly;
    if (this.state_abyssPrivate.mode !== 'structured' || this.state_abyssPrivate.unit !== 'months')
      return false;
    return (
      choice.type === 'day' &&
      (!Number.isSafeInteger(choice.day) || choice.day < 1 || choice.day > 31)
    );
  }

  private hasInvalidYearlyDay_abyssPrivate(): boolean {
    const choice = this.state_abyssPrivate.yearly;
    if (this.state_abyssPrivate.mode !== 'structured' || this.state_abyssPrivate.unit !== 'years')
      return false;
    return (
      choice.type === 'date' &&
      (!Number.isSafeInteger(choice.day) || choice.day < 1 || choice.day > 31)
    );
  }

  private setInvalid_abyssPrivate(selector: string, invalid: boolean): void {
    this.options_abyssPrivate.container
      .querySelector<HTMLElement>(selector)
      ?.setAttribute('aria-invalid', String(invalid));
  }

  private async submit_abyssPrivate(): Promise<void> {
    const parsed = this.parseState_abyssPrivate();
    if (
      this.state_abyssPrivate.submitting ||
      this.validationMessage_abyssPrivate(parsed).length > 0 ||
      parsed.type === 'invalid'
    ) {
      return;
    }
    this.beginSubmission_abyssPrivate();
    const succeeded = await this.performPatch_abyssPrivate({
      recurrence: { type: 'set', value: parsed.raw },
      ...this.onCompletionPatch_abyssPrivate(),
    });
    this.finishSubmission_abyssPrivate(succeeded, 'Could not save the repeat.');
  }

  private async clear_abyssPrivate(): Promise<void> {
    if (this.state_abyssPrivate.submitting) return;
    this.beginSubmission_abyssPrivate();
    const succeeded = await this.performPatch_abyssPrivate({
      recurrence: { type: 'clear' },
      onCompletion: { type: 'clear' },
    });
    this.finishSubmission_abyssPrivate(succeeded, 'Could not clear the repeat.');
  }

  private beginSubmission_abyssPrivate(): void {
    this.state_abyssPrivate.submitting = true;
    this.state_abyssPrivate.submissionError = undefined;
    this.refresh_abyssPrivate();
  }

  private async performPatch_abyssPrivate(patch: TaskPatch): Promise<boolean> {
    try {
      return (await this.options_abyssPrivate.onSubmit(patch)).type === 'ok';
    } catch {
      return false;
    }
  }

  private finishSubmission_abyssPrivate(succeeded: boolean, failure: string): void {
    if (succeeded) {
      this.options_abyssPrivate.onClose();
      return;
    }
    this.state_abyssPrivate.submissionError = failure;
    this.state_abyssPrivate.submitting = false;
    this.refresh_abyssPrivate();
  }

  private onCompletionPatch_abyssPrivate(): Pick<TaskPatch, 'onCompletion'> {
    const initial = this.task_abyssPrivate?.onCompletion ?? 'keep';
    if (this.state_abyssPrivate.onCompletion === initial) return {};
    return this.state_abyssPrivate.onCompletion === 'delete'
      ? { onCompletion: { type: 'set', value: 'delete' } }
      : { onCompletion: { type: 'clear' } };
  }

  private setPreset_abyssPrivate(preset: Preset): void {
    Object.assign(this.state_abyssPrivate, {
      mode: 'structured',
      preset,
      intervalText: '1',
      monthly: { type: 'same-date' },
      yearly: { type: 'same-date' },
      submissionError: undefined,
      dirty: true,
    });
    this.applyPresetCadence_abyssPrivate(preset);
    this.render_abyssPrivate();
  }

  private applyPresetCadence_abyssPrivate(preset: Preset): void {
    if (preset === 'daily' || preset === 'weekdays') this.state_abyssPrivate.unit = 'days';
    if (preset === 'monthly') this.state_abyssPrivate.unit = 'months';
    if (preset === 'yearly') this.state_abyssPrivate.unit = 'years';
    if (preset !== 'weekly') return;
    this.state_abyssPrivate.unit = 'weeks';
    this.state_abyssPrivate.weekdays =
      this.reference_abyssPrivate != null
        ? [weekdayForReference(this.reference_abyssPrivate)]
        : ['Monday'];
  }

  private renderAdaptiveControls_abyssPrivate(parent: HTMLElement): void {
    if (this.state_abyssPrivate.preset === 'weekdays') return;
    this.renderCadenceControls_abyssPrivate(parent);
    if (this.state_abyssPrivate.unit === 'weeks') this.renderWeekdayControls_abyssPrivate(parent);
    if (this.state_abyssPrivate.unit === 'months') this.renderMonthlyControls_abyssPrivate(parent);
    if (this.state_abyssPrivate.unit === 'years') this.renderYearlyControls_abyssPrivate(parent);
  }

  private renderCadenceControls_abyssPrivate(parent: HTMLElement): void {
    const cadence = parent.createDiv({ cls: 'abyss-recurrence-cadence' });
    cadence.createSpan({ cls: 'abyss-recurrence-inline-label', text: 'Every' });
    const interval = this.createIntervalInput_abyssPrivate(cadence);
    const unit = this.createUnitSelect_abyssPrivate(cadence);
    interval.addEventListener('input', () => {
      this.state_abyssPrivate.intervalText = interval.value;
      this.state_abyssPrivate.preset = undefined;
      this.markDirty_abyssPrivate();
      this.refresh_abyssPrivate();
    });
    unit.addEventListener('change', () => {
      this.state_abyssPrivate.unit = unit.value as Unit;
      this.state_abyssPrivate.preset = undefined;
      this.state_abyssPrivate.monthly = { type: 'same-date' };
      this.state_abyssPrivate.yearly = { type: 'same-date' };
      this.state_abyssPrivate.weekdays =
        this.reference_abyssPrivate != null
          ? [weekdayForReference(this.reference_abyssPrivate)]
          : ['Monday'];
      this.markDirty_abyssPrivate();
      this.render_abyssPrivate();
    });
  }

  private createIntervalInput_abyssPrivate(parent: HTMLElement): HTMLInputElement {
    return parent.createEl('input', {
      cls: 'abyss-recurrence-interval',
      attr: {
        type: 'text',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        value: this.state_abyssPrivate.intervalText,
        'aria-label': 'Repeat interval',
        'aria-describedby': this.diagnosticId_abyssPrivate,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'interval',
      },
    });
  }

  private createUnitSelect_abyssPrivate(parent: HTMLElement): HTMLSelectElement {
    const unit = parent.createEl('select', {
      attr: { 'aria-label': 'Repeat unit', 'data-recurrence-focus-key': 'unit' },
    });
    addOption(unit, 'days', 'Days', this.state_abyssPrivate.unit === 'days');
    addOption(unit, 'weeks', 'Weeks', this.state_abyssPrivate.unit === 'weeks');
    addOption(unit, 'months', 'Months', this.state_abyssPrivate.unit === 'months');
    addOption(unit, 'years', 'Years', this.state_abyssPrivate.unit === 'years');
    return unit;
  }

  private renderWeekdayControls_abyssPrivate(parent: HTMLElement): void {
    const days = parent.createDiv({
      cls: 'abyss-recurrence-weekdays',
      attr: { role: 'group', 'aria-label': 'Repeat weekdays' },
    });
    for (const weekday of WEEKDAYS) this.renderWeekdayOption_abyssPrivate(days, weekday);
  }

  private renderWeekdayOption_abyssPrivate(parent: HTMLElement, weekday: Weekday): void {
    const label = parent.createEl('label', { cls: 'abyss-recurrence-weekday' });
    const checkbox = label.createEl('input', {
      attr: {
        type: 'checkbox',
        name: 'recurrence-weekday',
        value: weekday,
        'data-recurrence-focus-key': `weekday:${weekday}`,
      },
    });
    checkbox.checked = this.state_abyssPrivate.weekdays.includes(weekday);
    label.createSpan({ text: weekday.slice(0, 2) });
    checkbox.addEventListener('change', () => {
      this.state_abyssPrivate.weekdays = checkbox.checked
        ? [...this.state_abyssPrivate.weekdays, weekday]
        : this.state_abyssPrivate.weekdays.filter((candidate) => candidate !== weekday);
      this.markDirty_abyssPrivate();
      this.refresh_abyssPrivate();
    });
  }

  private renderMonthlyControls_abyssPrivate(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'abyss-recurrence-detail-row' });
    this.renderMonthlyPattern_abyssPrivate(row);
    if (this.state_abyssPrivate.monthly.type === 'day') this.renderMonthlyDay_abyssPrivate(row);
    if (this.state_abyssPrivate.monthly.type === 'weekday')
      this.renderMonthlyWeekday_abyssPrivate(row);
  }

  private renderMonthlyPattern_abyssPrivate(row: HTMLElement): void {
    const pattern = row.createEl('select', {
      attr: {
        'aria-label': 'Monthly pattern',
        'data-recurrence-focus-key': 'monthly-pattern',
      },
    });
    const value =
      this.state_abyssPrivate.monthly.type === 'edge'
        ? this.state_abyssPrivate.monthly.edge
        : this.state_abyssPrivate.monthly.type;
    addOption(pattern, 'same-date', 'Same date', value === 'same-date');
    addOption(pattern, 'day', 'Day of month', value === 'day');
    addOption(pattern, 'first', 'First day', value === 'first');
    addOption(pattern, 'last', 'Last day', value === 'last');
    addOption(pattern, 'weekday', 'Weekday pattern', value === 'weekday');
    pattern.addEventListener('change', () => {
      this.state_abyssPrivate.monthly = monthlyChoiceFromValue(pattern.value);
      this.markDirty_abyssPrivate();
      this.render_abyssPrivate();
    });
  }

  private renderMonthlyDay_abyssPrivate(row: HTMLElement): void {
    if (this.state_abyssPrivate.monthly.type !== 'day') return;
    const day = row.createEl('input', {
      cls: 'abyss-recurrence-month-day',
      attr: {
        type: 'number',
        min: '1',
        max: '31',
        value: String(this.state_abyssPrivate.monthly.day),
        'aria-label': 'Month day',
        'aria-describedby': this.diagnosticId_abyssPrivate,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'monthly-day',
      },
    });
    day.addEventListener('input', () => {
      this.state_abyssPrivate.monthly = { type: 'day', day: Number(day.value) };
      this.markDirty_abyssPrivate(false);
      this.refresh_abyssPrivate();
    });
  }

  private renderMonthlyWeekday_abyssPrivate(row: HTMLElement): void {
    if (this.state_abyssPrivate.monthly.type !== 'weekday') return;
    const ordinal = this.createOrdinalSelect_abyssPrivate(row);
    const weekday = this.createMonthlyWeekdaySelect_abyssPrivate(row);
    ordinal.addEventListener('change', () => {
      if (this.state_abyssPrivate.monthly.type !== 'weekday') return;
      this.state_abyssPrivate.monthly = {
        ...this.state_abyssPrivate.monthly,
        ordinal: Number(ordinal.value) as 1 | 2 | 3 | 4 | -1 | -2,
      };
      this.markDirty_abyssPrivate(false);
      this.refresh_abyssPrivate();
    });
    weekday.addEventListener('change', () => {
      if (this.state_abyssPrivate.monthly.type !== 'weekday') return;
      this.state_abyssPrivate.monthly = {
        ...this.state_abyssPrivate.monthly,
        weekday: weekday.value as Weekday,
      };
      this.markDirty_abyssPrivate(false);
      this.refresh_abyssPrivate();
    });
  }

  private createOrdinalSelect_abyssPrivate(row: HTMLElement): HTMLSelectElement {
    const ordinal = row.createEl('select', {
      attr: {
        'aria-label': 'Weekday ordinal',
        'data-recurrence-focus-key': 'monthly-ordinal',
      },
    });
    for (const [number, label] of MONTHLY_ORDINALS) {
      const selected =
        this.state_abyssPrivate.monthly.type === 'weekday' &&
        this.state_abyssPrivate.monthly.ordinal === number;
      addOption(ordinal, String(number), label, selected);
    }
    return ordinal;
  }

  private createMonthlyWeekdaySelect_abyssPrivate(row: HTMLElement): HTMLSelectElement {
    const select = row.createEl('select', {
      attr: {
        'aria-label': 'Monthly weekday',
        'data-recurrence-focus-key': 'monthly-weekday',
      },
    });
    for (const value of WEEKDAYS) {
      const selected =
        this.state_abyssPrivate.monthly.type === 'weekday' &&
        this.state_abyssPrivate.monthly.weekday === value;
      addOption(select, value, value, selected);
    }
    return select;
  }

  private renderYearlyControls_abyssPrivate(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'abyss-recurrence-detail-row' });
    const pattern = this.createYearlyPatternSelect_abyssPrivate(row);
    pattern.addEventListener('change', () => {
      this.state_abyssPrivate.yearly =
        pattern.value === 'date' ? { type: 'date', month: 1, day: 1 } : { type: 'same-date' };
      this.markDirty_abyssPrivate();
      this.render_abyssPrivate();
    });
    if (this.state_abyssPrivate.yearly.type !== 'date') return;
    this.renderYearlyDate_abyssPrivate(row);
  }

  private createYearlyPatternSelect_abyssPrivate(row: HTMLElement): HTMLSelectElement {
    const pattern = row.createEl('select', {
      attr: {
        'aria-label': 'Yearly pattern',
        'data-recurrence-focus-key': 'yearly-pattern',
      },
    });
    addOption(
      pattern,
      'same-date',
      'Same date',
      this.state_abyssPrivate.yearly.type === 'same-date',
    );
    addOption(pattern, 'date', 'Calendar date', this.state_abyssPrivate.yearly.type === 'date');
    return pattern;
  }

  private renderYearlyDate_abyssPrivate(row: HTMLElement): void {
    if (this.state_abyssPrivate.yearly.type !== 'date') return;
    const month = row.createEl('select', {
      attr: {
        'aria-label': 'Yearly month',
        'data-recurrence-focus-key': 'yearly-month',
      },
    });
    MONTHS.forEach((label, index) => {
      const selected =
        this.state_abyssPrivate.yearly.type === 'date' &&
        this.state_abyssPrivate.yearly.month === index + 1;
      addOption(month, String(index + 1), label, selected);
    });
    const day = this.createYearlyDayInput_abyssPrivate(row);
    month.addEventListener('change', () => {
      if (this.state_abyssPrivate.yearly.type !== 'date') return;
      this.state_abyssPrivate.yearly = {
        ...this.state_abyssPrivate.yearly,
        month: Number(month.value) as Month,
      };
      this.markDirty_abyssPrivate(false);
      this.refresh_abyssPrivate();
    });
    day.addEventListener('input', () => {
      if (this.state_abyssPrivate.yearly.type !== 'date') return;
      this.state_abyssPrivate.yearly = {
        ...this.state_abyssPrivate.yearly,
        day: Number(day.value),
      };
      this.markDirty_abyssPrivate(false);
      this.refresh_abyssPrivate();
    });
  }

  private createYearlyDayInput_abyssPrivate(row: HTMLElement): HTMLInputElement {
    const day =
      this.state_abyssPrivate.yearly.type === 'date' ? this.state_abyssPrivate.yearly.day : 1;
    return row.createEl('input', {
      cls: 'abyss-recurrence-yearly-day',
      attr: {
        type: 'number',
        min: '1',
        max: '31',
        value: String(day),
        'aria-label': 'Yearly day',
        'aria-describedby': this.diagnosticId_abyssPrivate,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'yearly-day',
      },
    });
  }

  private markDirty_abyssPrivate(clearError = true): void {
    if (clearError) this.state_abyssPrivate.submissionError = undefined;
    this.state_abyssPrivate.dirty = true;
  }

  private render_abyssPrivate(): void {
    const focused = this.controlKey_abyssPrivate(
      this.options_abyssPrivate.container.ownerDocument.activeElement,
    );
    this.options_abyssPrivate.container.empty();
    const editor = this.createEditorRoot_abyssPrivate();
    this.renderPresets_abyssPrivate(editor);
    this.renderRuleControls_abyssPrivate(editor);
    this.renderCompletionControls_abyssPrivate(editor);
    this.renderDiagnostics_abyssPrivate(editor);
    this.renderActions_abyssPrivate(editor);
    this.refresh_abyssPrivate();
    this.controlForKey_abyssPrivate(focused)?.focus();
  }

  private createEditorRoot_abyssPrivate(): HTMLElement {
    const editor = this.options_abyssPrivate.container.createDiv({
      cls: 'abyss-recurrence-editor',
      attr: { role: 'region', 'aria-labelledby': this.titleId_abyssPrivate },
    });
    const heading = editor.createDiv({ cls: 'abyss-recurrence-heading' });
    heading.createSpan({
      cls: 'abyss-recurrence-title',
      text: 'Repeat',
      attr: { id: this.titleId_abyssPrivate },
    });
    return editor;
  }

  private renderPresets_abyssPrivate(editor: HTMLElement): void {
    const presets = editor.createDiv({
      cls: 'abyss-recurrence-presets',
      attr: { role: 'group', 'aria-label': 'Repeat pattern' },
    });
    for (const [preset, label] of PRESET_LABELS)
      this.renderPresetButton_abyssPrivate(presets, preset, label);
    const custom = presets.createEl('button', {
      text: 'Custom',
      attr: {
        type: 'button',
        'data-recurrence-mode': 'custom',
        'data-recurrence-focus-key': 'custom-mode',
        'aria-pressed': String(this.state_abyssPrivate.mode === 'custom'),
      },
    });
    custom.addEventListener('click', () => {
      this.state_abyssPrivate.customDraft = withTerminalWhenDone(
        this.state_abyssPrivate.customDraft,
        this.state_abyssPrivate.whenDone,
      );
      this.state_abyssPrivate.mode = 'custom';
      this.state_abyssPrivate.preset = undefined;
      this.markDirty_abyssPrivate();
      this.render_abyssPrivate();
    });
  }

  private renderPresetButton_abyssPrivate(
    parent: HTMLElement,
    preset: Preset,
    label: string,
  ): void {
    const button = parent.createEl('button', {
      text: label,
      attr: {
        type: 'button',
        'data-recurrence-preset': preset,
        'data-recurrence-focus-key': `preset:${preset}`,
        'aria-pressed': String(
          this.state_abyssPrivate.mode === 'structured' &&
            this.canonicalPreset_abyssPrivate() === preset,
        ),
      },
    });
    button.addEventListener('click', () => {
      this.setPreset_abyssPrivate(preset);
    });
  }

  private renderRuleControls_abyssPrivate(editor: HTMLElement): void {
    const controls = editor.createDiv({ cls: 'abyss-recurrence-controls' });
    if (this.state_abyssPrivate.mode !== 'custom') {
      this.renderAdaptiveControls_abyssPrivate(controls);
      return;
    }
    const raw = controls.createEl('input', {
      cls: 'abyss-recurrence-raw',
      attr: {
        type: 'text',
        value: this.state_abyssPrivate.customDraft,
        'aria-label': 'Recurrence rule',
        'aria-describedby': this.diagnosticId_abyssPrivate,
        'aria-invalid': 'false',
        spellcheck: 'false',
        'data-recurrence-focus-key': 'custom',
      },
    });
    raw.addEventListener('input', () => {
      this.state_abyssPrivate.customDraft = raw.value;
      this.markDirty_abyssPrivate();
      this.refresh_abyssPrivate();
    });
  }

  private renderCompletionControls_abyssPrivate(editor: HTMLElement): void {
    this.renderWhenDoneControl_abyssPrivate(editor);
    const row = editor.createEl('label', { cls: 'abyss-recurrence-completed-row' });
    row.createSpan({ text: 'Completed task' });
    const completed = row.createEl('select', {
      attr: {
        'aria-label': 'Completed task',
        'data-recurrence-focus-key': 'completed-task',
      },
    });
    addOption(
      completed,
      'keep',
      'Keep completed task',
      this.state_abyssPrivate.onCompletion === 'keep',
    );
    addOption(
      completed,
      'delete',
      'Delete completed task',
      this.state_abyssPrivate.onCompletion === 'delete',
    );
    completed.addEventListener('change', () => {
      this.state_abyssPrivate.onCompletion = completed.value as 'keep' | 'delete';
      this.markDirty_abyssPrivate(false);
      this.refresh_abyssPrivate();
    });
  }

  private renderWhenDoneControl_abyssPrivate(editor: HTMLElement): void {
    const row = editor.createEl('label', { cls: 'abyss-recurrence-check-row' });
    const input = row.createEl('input', {
      cls: 'abyss-recurrence-when-done',
      attr: { type: 'checkbox', 'data-recurrence-focus-key': 'when-done' },
    });
    input.checked = this.state_abyssPrivate.whenDone;
    row.createSpan({ text: 'Repeat from completion date' });
    input.addEventListener('change', () => {
      this.state_abyssPrivate.whenDone = input.checked;
      this.syncCustomWhenDoneInput_abyssPrivate();
      this.markDirty_abyssPrivate();
      this.refresh_abyssPrivate();
    });
  }

  private syncCustomWhenDoneInput_abyssPrivate(): void {
    if (this.state_abyssPrivate.mode !== 'custom') return;
    this.state_abyssPrivate.customDraft = withTerminalWhenDone(
      this.state_abyssPrivate.customDraft,
      this.state_abyssPrivate.whenDone,
    );
    const raw =
      this.options_abyssPrivate.container.querySelector<HTMLInputElement>('.abyss-recurrence-raw');
    if (raw !== null) raw.value = this.state_abyssPrivate.customDraft;
  }

  private renderDiagnostics_abyssPrivate(editor: HTMLElement): void {
    editor.createDiv({ cls: 'abyss-recurrence-delete-warning', attr: { role: 'note' } });
    const preview = editor.createDiv({ cls: 'abyss-recurrence-preview' });
    preview.createSpan({ cls: 'abyss-recurrence-preview-label', text: 'Rule' });
    preview.createSpan({ cls: 'abyss-recurrence-preview-rule' });
    editor.createDiv({
      cls: 'abyss-recurrence-status',
      attr: { id: this.diagnosticId_abyssPrivate, 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
  }

  private renderActions_abyssPrivate(editor: HTMLElement): void {
    const actions = editor.createDiv({ cls: 'abyss-recurrence-actions' });
    if (
      this.task_abyssPrivate?.recurrence !== undefined ||
      (this.task_abyssPrivate?.onCompletionExplicit ?? false)
    ) {
      this.renderClearAction_abyssPrivate(actions);
    }
    const spacer = actions.createSpan({ cls: 'abyss-recurrence-actions-spacer' });
    spacer.setAttribute('aria-hidden', 'true');
    const cancel = actions.createEl('button', {
      text: 'Cancel',
      attr: { type: 'button', 'data-recurrence-focus-key': 'cancel' },
    });
    cancel.addEventListener('click', () => {
      this.dismiss();
    });
    const save = actions.createEl('button', {
      cls: 'mod-cta abyss-recurrence-save',
      text: 'Save repeat',
      attr: { type: 'button', 'data-recurrence-focus-key': 'save' },
    });
    save.addEventListener('click', () => {
      runAsyncAction(this.submit_abyssPrivate(), 'Could not save recurrence');
    });
  }

  private renderClearAction_abyssPrivate(actions: HTMLElement): void {
    const clear = actions.createEl('button', {
      cls: 'abyss-recurrence-clear',
      text: 'Clear repeat',
      attr: { type: 'button', 'data-recurrence-focus-key': 'clear' },
    });
    clear.addEventListener('click', () => {
      runAsyncAction(this.clear_abyssPrivate(), 'Could not clear recurrence');
    });
  }

  private readonly keyHandler_abyssPrivate = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
      return;
    }
    const target = event.target;
    const plainInputEnter =
      event.key === 'Enter' &&
      target instanceof HTMLInputElement &&
      target.type !== 'checkbox' &&
      !event.shiftKey &&
      !event.altKey;
    if ((event.key === 'Enter' && (event.metaKey || event.ctrlKey)) || plainInputEnter) {
      event.preventDefault();
      runAsyncAction(this.submit_abyssPrivate(), 'Could not save recurrence');
    }
  };

  private readonly submitShortcutHandler_abyssPrivate = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Enter' ||
      (!event.metaKey && !event.ctrlKey) ||
      event.target == null ||
      !this.options_abyssPrivate.container.contains(event.target as Node)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    runAsyncAction(this.submit_abyssPrivate(), 'Could not save recurrence');
  };
}

export function mountAnchoredRecurrenceEditor(
  options: AnchoredRecurrenceEditorOptions,
): RecurrenceEditorHandle {
  const controller = new AnchoredRecurrenceEditorController(options);
  controller.mount();
  return controller;
}

class AnchoredRecurrenceEditorController implements RecurrenceEditorHandle {
  private readonly ownerDocument_abyssPrivate: Document;
  private readonly ownerWindow_abyssPrivate: Window | null;
  private readonly popover_abyssPrivate: HTMLElement;
  private readonly ownershipToken_abyssPrivate: ReturnType<InteractionOwnershipPort['acquire']>;
  private editor_abyssPrivate: RecurrenceEditorHandle | undefined;
  private destroyed_abyssPrivate = false;
  private outsideTimer_abyssPrivate: number | undefined;
  private autofocusTimer_abyssPrivate: number | undefined;

  constructor(private readonly options_abyssPrivate: AnchoredRecurrenceEditorOptions) {
    this.ownerDocument_abyssPrivate = options_abyssPrivate.anchor.ownerDocument;
    this.ownerWindow_abyssPrivate = this.ownerDocument_abyssPrivate.defaultView;
    this.ownershipToken_abyssPrivate = (
      options_abyssPrivate.interactionOwnership ?? noInteractionOwnership
    ).acquire({
      blocksShortcuts: true,
    });
    this.popover_abyssPrivate = this.ownerDocument_abyssPrivate.body.createDiv({
      cls: 'abyss-popover abyss-recurrence-popover abyss-popover-anchored abyss-recurrence-popover-floating',
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
  }

  mount(): void {
    this.editor_abyssPrivate = mountRecurrenceEditor({
      ...this.options_abyssPrivate,
      container: this.popover_abyssPrivate,
      dismissalFocus: this.options_abyssPrivate.anchor,
      onClose: () => {
        this.destroy();
      },
    });
    this.labelPopover_abyssPrivate();
    this.position_abyssPrivate();
    this.ownerDocument_abyssPrivate.addEventListener('scroll', this.position_abyssPrivate, true);
    this.ownerWindow_abyssPrivate?.addEventListener('resize', this.position_abyssPrivate);
    this.scheduleOutsideListener_abyssPrivate();
    this.scheduleAutofocus_abyssPrivate();
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.clearTimers_abyssPrivate();
    this.ownerDocument_abyssPrivate.removeEventListener(
      'mousedown',
      this.onOutside_abyssPrivate,
      true,
    );
    this.ownerDocument_abyssPrivate.removeEventListener('scroll', this.position_abyssPrivate, true);
    this.ownerWindow_abyssPrivate?.removeEventListener('resize', this.position_abyssPrivate);
    this.editor_abyssPrivate?.destroy();
    this.popover_abyssPrivate.remove();
    this.ownershipToken_abyssPrivate.release();
    this.options_abyssPrivate.onClose?.();
  }

  dismiss(): void {
    this.requireEditor_abyssPrivate().dismiss();
  }

  focus(): void {
    this.requireEditor_abyssPrivate().focus();
  }

  captureDraftState(): RecurrenceEditorDraft {
    return this.requireEditor_abyssPrivate().captureDraftState();
  }

  restoreDraftState(draft: RecurrenceEditorDraft): void {
    if (this.autofocusTimer_abyssPrivate !== undefined) {
      this.ownerWindow_abyssPrivate?.clearTimeout(this.autofocusTimer_abyssPrivate);
      this.autofocusTimer_abyssPrivate = undefined;
    }
    this.requireEditor_abyssPrivate().restoreDraftState(draft);
  }

  private requireEditor_abyssPrivate(): RecurrenceEditorHandle {
    if (this.editor_abyssPrivate === undefined) throw new Error('recurrence-editor-unavailable');
    return this.editor_abyssPrivate;
  }

  private labelPopover_abyssPrivate(): void {
    const title = this.popover_abyssPrivate.querySelector<HTMLElement>('.abyss-recurrence-title');
    if (title !== null && title.id.length > 0) {
      this.popover_abyssPrivate.setAttribute('aria-labelledby', title.id);
    }
  }

  private clearTimers_abyssPrivate(): void {
    if (this.outsideTimer_abyssPrivate !== undefined)
      this.ownerWindow_abyssPrivate?.clearTimeout(this.outsideTimer_abyssPrivate);
    if (this.autofocusTimer_abyssPrivate !== undefined)
      this.ownerWindow_abyssPrivate?.clearTimeout(this.autofocusTimer_abyssPrivate);
  }

  private scheduleOutsideListener_abyssPrivate(): void {
    this.outsideTimer_abyssPrivate = this.ownerWindow_abyssPrivate?.setTimeout(() => {
      this.outsideTimer_abyssPrivate = undefined;
      if (!this.destroyed_abyssPrivate) {
        this.ownerDocument_abyssPrivate.addEventListener(
          'mousedown',
          this.onOutside_abyssPrivate,
          true,
        );
      }
    }, 0);
  }

  private scheduleAutofocus_abyssPrivate(): void {
    this.autofocusTimer_abyssPrivate = this.ownerWindow_abyssPrivate?.setTimeout(() => {
      this.autofocusTimer_abyssPrivate = undefined;
      this.editor_abyssPrivate?.focus();
    }, 0);
  }

  private readonly position_abyssPrivate = (): void => {
    const anchor = this.options_abyssPrivate.anchor.getBoundingClientRect();
    const floating = this.popover_abyssPrivate.getBoundingClientRect();
    const measuredWidth =
      floating.width !== 0 ? floating.width : this.popover_abyssPrivate.offsetWidth;
    const width = measuredWidth !== 0 ? measuredWidth : 352;
    const height = floating.height !== 0 ? floating.height : this.popover_abyssPrivate.offsetHeight;
    const edge = 8;
    const viewportWidth = this.ownerWindow_abyssPrivate?.innerWidth ?? width + edge * 2;
    const viewportHeight =
      this.ownerWindow_abyssPrivate?.innerHeight ?? anchor.bottom + height + edge;
    const left = Math.min(
      Math.max(anchor.left, edge),
      Math.max(edge, viewportWidth - width - edge),
    );
    const below = anchor.bottom + 4;
    const top = below + height > viewportHeight - edge ? anchor.top - height - 4 : below;
    this.popover_abyssPrivate.style.left = `${left}px`;
    this.popover_abyssPrivate.style.top = `${Math.max(edge, top)}px`;
  };

  private readonly onOutside_abyssPrivate = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (
      !this.popover_abyssPrivate.contains(target) &&
      !this.options_abyssPrivate.anchor.contains(target)
    ) {
      this.editor_abyssPrivate?.dismiss();
    }
  };
}
