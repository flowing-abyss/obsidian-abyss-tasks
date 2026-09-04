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
  private readonly titleId = `abyss-recurrence-title-${++nextEditorInstance}`;
  private readonly diagnosticId = `abyss-recurrence-diagnostic-${nextEditorInstance}`;
  private readonly task: TaskSelectionNode | undefined;
  private readonly reference: LocalDate | undefined;
  private readonly previousFocus: Element | null;
  private readonly state: EditorState;
  private readonly ownerWindow: Window | null;

  constructor(private readonly options: RecurrenceEditorOptions) {
    this.task = selectedTask(options.source);
    this.reference = referenceDate(options.source, options.policy);
    this.previousFocus = options.container.ownerDocument.activeElement;
    this.ownerWindow = options.container.ownerDocument.defaultView;
    this.state = initialEditorState(this.task, this.reference);
  }

  mount(): void {
    this.ownerWindow?.addEventListener('keydown', this.submitShortcutHandler, true);
    this.options.container.addEventListener('keydown', this.keyHandler);
    this.render();
  }

  destroy(): void {
    this.ownerWindow?.removeEventListener('keydown', this.submitShortcutHandler, true);
    this.options.container.removeEventListener('keydown', this.keyHandler);
    this.options.container.empty();
  }

  dismiss(): void {
    this.options.onClose();
    this.restoreFocus();
  }

  focus(): void {
    const selector =
      this.state.mode === 'custom'
        ? '[aria-label="Recurrence rule"]'
        : '[aria-pressed="true"], [aria-label="Repeat interval"]';
    this.options.container.querySelector<HTMLElement>(selector)?.focus();
  }

  captureDraftState(): RecurrenceEditorDraft {
    const active = this.options.container.ownerDocument.activeElement;
    const input = this.textInput(active);
    const focusedControl = this.controlKey(active);
    return {
      mode: this.state.mode,
      ...(this.state.preset !== undefined && { preset: this.state.preset }),
      intervalText: this.state.intervalText,
      unit: this.state.unit,
      weekdays: [...this.state.weekdays],
      monthly: this.state.monthly,
      yearly: this.state.yearly,
      whenDone: this.state.whenDone,
      onCompletion: this.state.onCompletion,
      customDraft: this.state.customDraft,
      ...(focusedControl !== undefined && { focusedControl }),
      ...selectionState(input),
      dirty: this.state.dirty,
    };
  }

  restoreDraftState(draft: RecurrenceEditorDraft): void {
    Object.assign(this.state, {
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
    this.render();
    this.restoreDraftFocus(draft);
  }

  private restoreFocus(): void {
    if (this.options.dismissalFocus?.isConnected === true) {
      this.options.dismissalFocus.focus();
      return;
    }
    if (this.previousFocus instanceof HTMLElement && this.previousFocus.isConnected) {
      this.previousFocus.focus();
    }
  }

  private textInput(element: Element | null): HTMLInputElement | HTMLTextAreaElement | undefined {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element
      : undefined;
  }

  private controlKey(element: Element | null): string | undefined {
    if (!(element instanceof HTMLElement) || !this.options.container.contains(element)) {
      return undefined;
    }
    return element.dataset['recurrenceFocusKey'];
  }

  private controlForKey(key: string | undefined): HTMLElement | undefined {
    if (key === undefined || key.length === 0) return undefined;
    const controls = this.options.container.querySelectorAll<HTMLElement>(
      '[data-recurrence-focus-key]',
    );
    return [...controls].find((control) => this.controlKey(control) === key);
  }

  private restoreDraftFocus(draft: RecurrenceEditorDraft): void {
    const control = this.controlForKey(draft.focusedControl);
    control?.focus();
    if (
      control instanceof HTMLInputElement &&
      draft.selectionStart !== undefined &&
      draft.selectionEnd !== undefined
    ) {
      control.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    }
  }

  private parseState(): RecurrenceParseResult {
    if (this.state.mode === 'custom') return parseRecurrenceRule(this.state.customDraft);
    if (this.state.preset === 'weekdays') {
      return parseRecurrenceRule(`every weekday${this.state.whenDone ? ' when done' : ''}`);
    }
    return buildRecurrenceRule({
      interval: Number(this.state.intervalText),
      unit: this.state.unit,
      weekdays: this.state.weekdays,
      monthly: this.state.monthly,
      yearly: this.state.yearly,
      whenDone: this.state.whenDone,
    });
  }

  private canonicalPreset(): Preset | undefined {
    if (this.state.mode === 'custom') return undefined;
    const parsed = this.parseState();
    if (parsed.type === 'invalid') return undefined;
    const candidates: ReadonlyArray<readonly [Preset, string]> = [
      ['daily', 'every day'],
      ['weekdays', 'every weekday'],
      ...(this.reference === undefined
        ? []
        : ([['weekly', recurrencePresetRule('weekly', this.reference)]] as const)),
      ['monthly', 'every month'],
      ['yearly', 'every year'],
    ];
    return candidates.find(([, rule]) => parsed.canonical === rule)?.[0];
  }

  private validationMessage(parsed: RecurrenceParseResult): string {
    if (this.options.ownershipConflict) return 'Remove the nested repeat conflict first.';
    if (this.reference == null) return 'Add a date before setting a repeat.';
    if (this.hasInvalidInterval()) return 'Use a whole number greater than zero.';
    if (this.state.submissionError !== undefined && this.state.submissionError.length > 0) {
      return this.state.submissionError;
    }
    return parsed.type === 'invalid' ? recurrenceIssueText(parsed.code) : '';
  }

  private hasInvalidInterval(): boolean {
    const interval = Number(this.state.intervalText);
    return (
      this.state.mode === 'structured' &&
      this.state.preset !== 'weekdays' &&
      (!Number.isSafeInteger(interval) || interval < 1)
    );
  }

  private refresh(): void {
    const parsed = this.parseState();
    if (this.state.mode === 'custom' && parsed.type === 'valid') {
      this.state.whenDone = parsed.whenDone;
    }
    const message = this.validationMessage(parsed);
    this.refreshPreview(parsed);
    this.refreshStatus(message);
    this.refreshDeleteWarning();
    this.refreshWhenDone(parsed);
    this.refreshSaveButton(parsed, message);
    this.refreshPresetButtons();
    this.refreshValidity(parsed);
  }

  private refreshPreview(parsed: RecurrenceParseResult): void {
    const preview = this.options.container.querySelector<HTMLElement>(
      '.abyss-recurrence-preview-rule',
    );
    if (preview === null) return;
    const suffix = parsed.type === 'valid' && parsed.whenDone ? ' when done' : '';
    preview.textContent = parsed.type === 'valid' ? `${parsed.canonical}${suffix}` : '—';
  }

  private refreshStatus(message: string): void {
    const status = this.options.container.querySelector<HTMLElement>('.abyss-recurrence-status');
    if (status === null) return;
    status.textContent = message;
    status.hidden = message.length === 0;
  }

  private refreshDeleteWarning(): void {
    const warning = this.options.container.querySelector<HTMLElement>(
      '.abyss-recurrence-delete-warning',
    );
    if (warning === null) return;
    const deletes = this.state.onCompletion === 'delete';
    warning.textContent = deletes
      ? 'Completing this repeat deletes the finished task and its owned sub-tasks.'
      : '';
    warning.hidden = !deletes;
  }

  private refreshWhenDone(parsed: RecurrenceParseResult): void {
    if (this.state.mode !== 'custom' || parsed.type !== 'valid') return;
    const input = this.options.container.querySelector<HTMLInputElement>(
      '.abyss-recurrence-when-done',
    );
    if (input !== null) input.checked = parsed.whenDone;
  }

  private refreshSaveButton(parsed: RecurrenceParseResult, message: string): void {
    const save = this.options.container.querySelector<HTMLButtonElement>('.abyss-recurrence-save');
    if (save !== null) {
      save.disabled = this.state.submitting || message.length > 0 || parsed.type === 'invalid';
    }
  }

  private refreshPresetButtons(): void {
    const pressedPreset = this.canonicalPreset();
    const buttons = this.options.container.querySelectorAll<HTMLButtonElement>(
      '.abyss-recurrence-presets button',
    );
    for (const button of buttons) {
      const preset = button.dataset['recurrencePreset'] as Preset | undefined;
      const pressed =
        button.dataset['recurrenceMode'] === 'custom'
          ? this.state.mode === 'custom'
          : preset !== undefined && preset === pressedPreset;
      button.setAttribute('aria-pressed', String(pressed));
    }
  }

  private refreshValidity(parsed: RecurrenceParseResult): void {
    this.setInvalid('.abyss-recurrence-interval', this.hasInvalidInterval());
    this.setInvalid('.abyss-recurrence-month-day', this.hasInvalidMonthlyDay());
    this.setInvalid('.abyss-recurrence-yearly-day', this.hasInvalidYearlyDay());
    this.setInvalid(
      '.abyss-recurrence-raw',
      this.state.mode === 'custom' && parsed.type === 'invalid',
    );
  }

  private hasInvalidMonthlyDay(): boolean {
    const choice = this.state.monthly;
    if (this.state.mode !== 'structured' || this.state.unit !== 'months') return false;
    return (
      choice.type === 'day' &&
      (!Number.isSafeInteger(choice.day) || choice.day < 1 || choice.day > 31)
    );
  }

  private hasInvalidYearlyDay(): boolean {
    const choice = this.state.yearly;
    if (this.state.mode !== 'structured' || this.state.unit !== 'years') return false;
    return (
      choice.type === 'date' &&
      (!Number.isSafeInteger(choice.day) || choice.day < 1 || choice.day > 31)
    );
  }

  private setInvalid(selector: string, invalid: boolean): void {
    this.options.container
      .querySelector<HTMLElement>(selector)
      ?.setAttribute('aria-invalid', String(invalid));
  }

  private async submit(): Promise<void> {
    const parsed = this.parseState();
    if (
      this.state.submitting ||
      this.validationMessage(parsed).length > 0 ||
      parsed.type === 'invalid'
    ) {
      return;
    }
    this.beginSubmission();
    const succeeded = await this.performPatch({
      recurrence: { type: 'set', value: parsed.raw },
      ...this.onCompletionPatch(),
    });
    this.finishSubmission(succeeded, 'Could not save the repeat.');
  }

  private async clear(): Promise<void> {
    if (this.state.submitting) return;
    this.beginSubmission();
    const succeeded = await this.performPatch({
      recurrence: { type: 'clear' },
      onCompletion: { type: 'clear' },
    });
    this.finishSubmission(succeeded, 'Could not clear the repeat.');
  }

  private beginSubmission(): void {
    this.state.submitting = true;
    this.state.submissionError = undefined;
    this.refresh();
  }

  private async performPatch(patch: TaskPatch): Promise<boolean> {
    try {
      return (await this.options.onSubmit(patch)).type === 'ok';
    } catch {
      return false;
    }
  }

  private finishSubmission(succeeded: boolean, failure: string): void {
    if (succeeded) {
      this.options.onClose();
      return;
    }
    this.state.submissionError = failure;
    this.state.submitting = false;
    this.refresh();
  }

  private onCompletionPatch(): Pick<TaskPatch, 'onCompletion'> {
    const initial = this.task?.onCompletion ?? 'keep';
    if (this.state.onCompletion === initial) return {};
    return this.state.onCompletion === 'delete'
      ? { onCompletion: { type: 'set', value: 'delete' } }
      : { onCompletion: { type: 'clear' } };
  }

  private setPreset(preset: Preset): void {
    Object.assign(this.state, {
      mode: 'structured',
      preset,
      intervalText: '1',
      monthly: { type: 'same-date' },
      yearly: { type: 'same-date' },
      submissionError: undefined,
      dirty: true,
    });
    this.applyPresetCadence(preset);
    this.render();
  }

  private applyPresetCadence(preset: Preset): void {
    if (preset === 'daily' || preset === 'weekdays') this.state.unit = 'days';
    if (preset === 'monthly') this.state.unit = 'months';
    if (preset === 'yearly') this.state.unit = 'years';
    if (preset !== 'weekly') return;
    this.state.unit = 'weeks';
    this.state.weekdays =
      this.reference != null ? [weekdayForReference(this.reference)] : ['Monday'];
  }

  private renderAdaptiveControls(parent: HTMLElement): void {
    if (this.state.preset === 'weekdays') return;
    this.renderCadenceControls(parent);
    if (this.state.unit === 'weeks') this.renderWeekdayControls(parent);
    if (this.state.unit === 'months') this.renderMonthlyControls(parent);
    if (this.state.unit === 'years') this.renderYearlyControls(parent);
  }

  private renderCadenceControls(parent: HTMLElement): void {
    const cadence = parent.createDiv({ cls: 'abyss-recurrence-cadence' });
    cadence.createSpan({ cls: 'abyss-recurrence-inline-label', text: 'Every' });
    const interval = this.createIntervalInput(cadence);
    const unit = this.createUnitSelect(cadence);
    interval.addEventListener('input', () => {
      this.state.intervalText = interval.value;
      this.state.preset = undefined;
      this.markDirty();
      this.refresh();
    });
    unit.addEventListener('change', () => {
      this.state.unit = unit.value as Unit;
      this.state.preset = undefined;
      this.state.monthly = { type: 'same-date' };
      this.state.yearly = { type: 'same-date' };
      this.state.weekdays =
        this.reference != null ? [weekdayForReference(this.reference)] : ['Monday'];
      this.markDirty();
      this.render();
    });
  }

  private createIntervalInput(parent: HTMLElement): HTMLInputElement {
    return parent.createEl('input', {
      cls: 'abyss-recurrence-interval',
      attr: {
        type: 'text',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        value: this.state.intervalText,
        'aria-label': 'Repeat interval',
        'aria-describedby': this.diagnosticId,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'interval',
      },
    });
  }

  private createUnitSelect(parent: HTMLElement): HTMLSelectElement {
    const unit = parent.createEl('select', {
      attr: { 'aria-label': 'Repeat unit', 'data-recurrence-focus-key': 'unit' },
    });
    addOption(unit, 'days', 'Days', this.state.unit === 'days');
    addOption(unit, 'weeks', 'Weeks', this.state.unit === 'weeks');
    addOption(unit, 'months', 'Months', this.state.unit === 'months');
    addOption(unit, 'years', 'Years', this.state.unit === 'years');
    return unit;
  }

  private renderWeekdayControls(parent: HTMLElement): void {
    const days = parent.createDiv({
      cls: 'abyss-recurrence-weekdays',
      attr: { role: 'group', 'aria-label': 'Repeat weekdays' },
    });
    for (const weekday of WEEKDAYS) this.renderWeekdayOption(days, weekday);
  }

  private renderWeekdayOption(parent: HTMLElement, weekday: Weekday): void {
    const label = parent.createEl('label', { cls: 'abyss-recurrence-weekday' });
    const checkbox = label.createEl('input', {
      attr: {
        type: 'checkbox',
        name: 'recurrence-weekday',
        value: weekday,
        'data-recurrence-focus-key': `weekday:${weekday}`,
      },
    });
    checkbox.checked = this.state.weekdays.includes(weekday);
    label.createSpan({ text: weekday.slice(0, 2) });
    checkbox.addEventListener('change', () => {
      this.state.weekdays = checkbox.checked
        ? [...this.state.weekdays, weekday]
        : this.state.weekdays.filter((candidate) => candidate !== weekday);
      this.markDirty();
      this.refresh();
    });
  }

  private renderMonthlyControls(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'abyss-recurrence-detail-row' });
    this.renderMonthlyPattern(row);
    if (this.state.monthly.type === 'day') this.renderMonthlyDay(row);
    if (this.state.monthly.type === 'weekday') this.renderMonthlyWeekday(row);
  }

  private renderMonthlyPattern(row: HTMLElement): void {
    const pattern = row.createEl('select', {
      attr: {
        'aria-label': 'Monthly pattern',
        'data-recurrence-focus-key': 'monthly-pattern',
      },
    });
    const value =
      this.state.monthly.type === 'edge' ? this.state.monthly.edge : this.state.monthly.type;
    addOption(pattern, 'same-date', 'Same date', value === 'same-date');
    addOption(pattern, 'day', 'Day of month', value === 'day');
    addOption(pattern, 'first', 'First day', value === 'first');
    addOption(pattern, 'last', 'Last day', value === 'last');
    addOption(pattern, 'weekday', 'Weekday pattern', value === 'weekday');
    pattern.addEventListener('change', () => {
      this.state.monthly = monthlyChoiceFromValue(pattern.value);
      this.markDirty();
      this.render();
    });
  }

  private renderMonthlyDay(row: HTMLElement): void {
    if (this.state.monthly.type !== 'day') return;
    const day = row.createEl('input', {
      cls: 'abyss-recurrence-month-day',
      attr: {
        type: 'number',
        min: '1',
        max: '31',
        value: String(this.state.monthly.day),
        'aria-label': 'Month day',
        'aria-describedby': this.diagnosticId,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'monthly-day',
      },
    });
    day.addEventListener('input', () => {
      this.state.monthly = { type: 'day', day: Number(day.value) };
      this.markDirty(false);
      this.refresh();
    });
  }

  private renderMonthlyWeekday(row: HTMLElement): void {
    if (this.state.monthly.type !== 'weekday') return;
    const ordinal = this.createOrdinalSelect(row);
    const weekday = this.createMonthlyWeekdaySelect(row);
    ordinal.addEventListener('change', () => {
      if (this.state.monthly.type !== 'weekday') return;
      this.state.monthly = {
        ...this.state.monthly,
        ordinal: Number(ordinal.value) as 1 | 2 | 3 | 4 | -1 | -2,
      };
      this.markDirty(false);
      this.refresh();
    });
    weekday.addEventListener('change', () => {
      if (this.state.monthly.type !== 'weekday') return;
      this.state.monthly = { ...this.state.monthly, weekday: weekday.value as Weekday };
      this.markDirty(false);
      this.refresh();
    });
  }

  private createOrdinalSelect(row: HTMLElement): HTMLSelectElement {
    const ordinal = row.createEl('select', {
      attr: {
        'aria-label': 'Weekday ordinal',
        'data-recurrence-focus-key': 'monthly-ordinal',
      },
    });
    for (const [number, label] of MONTHLY_ORDINALS) {
      const selected =
        this.state.monthly.type === 'weekday' && this.state.monthly.ordinal === number;
      addOption(ordinal, String(number), label, selected);
    }
    return ordinal;
  }

  private createMonthlyWeekdaySelect(row: HTMLElement): HTMLSelectElement {
    const select = row.createEl('select', {
      attr: {
        'aria-label': 'Monthly weekday',
        'data-recurrence-focus-key': 'monthly-weekday',
      },
    });
    for (const value of WEEKDAYS) {
      const selected =
        this.state.monthly.type === 'weekday' && this.state.monthly.weekday === value;
      addOption(select, value, value, selected);
    }
    return select;
  }

  private renderYearlyControls(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'abyss-recurrence-detail-row' });
    const pattern = this.createYearlyPatternSelect(row);
    pattern.addEventListener('change', () => {
      this.state.yearly =
        pattern.value === 'date' ? { type: 'date', month: 1, day: 1 } : { type: 'same-date' };
      this.markDirty();
      this.render();
    });
    if (this.state.yearly.type !== 'date') return;
    this.renderYearlyDate(row);
  }

  private createYearlyPatternSelect(row: HTMLElement): HTMLSelectElement {
    const pattern = row.createEl('select', {
      attr: {
        'aria-label': 'Yearly pattern',
        'data-recurrence-focus-key': 'yearly-pattern',
      },
    });
    addOption(pattern, 'same-date', 'Same date', this.state.yearly.type === 'same-date');
    addOption(pattern, 'date', 'Calendar date', this.state.yearly.type === 'date');
    return pattern;
  }

  private renderYearlyDate(row: HTMLElement): void {
    if (this.state.yearly.type !== 'date') return;
    const month = row.createEl('select', {
      attr: {
        'aria-label': 'Yearly month',
        'data-recurrence-focus-key': 'yearly-month',
      },
    });
    MONTHS.forEach((label, index) => {
      const selected = this.state.yearly.type === 'date' && this.state.yearly.month === index + 1;
      addOption(month, String(index + 1), label, selected);
    });
    const day = this.createYearlyDayInput(row);
    month.addEventListener('change', () => {
      if (this.state.yearly.type !== 'date') return;
      this.state.yearly = { ...this.state.yearly, month: Number(month.value) as Month };
      this.markDirty(false);
      this.refresh();
    });
    day.addEventListener('input', () => {
      if (this.state.yearly.type !== 'date') return;
      this.state.yearly = { ...this.state.yearly, day: Number(day.value) };
      this.markDirty(false);
      this.refresh();
    });
  }

  private createYearlyDayInput(row: HTMLElement): HTMLInputElement {
    const day = this.state.yearly.type === 'date' ? this.state.yearly.day : 1;
    return row.createEl('input', {
      cls: 'abyss-recurrence-yearly-day',
      attr: {
        type: 'number',
        min: '1',
        max: '31',
        value: String(day),
        'aria-label': 'Yearly day',
        'aria-describedby': this.diagnosticId,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'yearly-day',
      },
    });
  }

  private markDirty(clearError = true): void {
    if (clearError) this.state.submissionError = undefined;
    this.state.dirty = true;
  }

  private render(): void {
    const focused = this.controlKey(this.options.container.ownerDocument.activeElement);
    this.options.container.empty();
    const editor = this.createEditorRoot();
    this.renderPresets(editor);
    this.renderRuleControls(editor);
    this.renderCompletionControls(editor);
    this.renderDiagnostics(editor);
    this.renderActions(editor);
    this.refresh();
    this.controlForKey(focused)?.focus();
  }

  private createEditorRoot(): HTMLElement {
    const editor = this.options.container.createDiv({
      cls: 'abyss-recurrence-editor',
      attr: { role: 'region', 'aria-labelledby': this.titleId },
    });
    const heading = editor.createDiv({ cls: 'abyss-recurrence-heading' });
    heading.createSpan({
      cls: 'abyss-recurrence-title',
      text: 'Repeat',
      attr: { id: this.titleId },
    });
    return editor;
  }

  private renderPresets(editor: HTMLElement): void {
    const presets = editor.createDiv({
      cls: 'abyss-recurrence-presets',
      attr: { role: 'group', 'aria-label': 'Repeat pattern' },
    });
    for (const [preset, label] of PRESET_LABELS) this.renderPresetButton(presets, preset, label);
    const custom = presets.createEl('button', {
      text: 'Custom',
      attr: {
        type: 'button',
        'data-recurrence-mode': 'custom',
        'data-recurrence-focus-key': 'custom-mode',
        'aria-pressed': String(this.state.mode === 'custom'),
      },
    });
    custom.addEventListener('click', () => {
      this.state.customDraft = withTerminalWhenDone(this.state.customDraft, this.state.whenDone);
      this.state.mode = 'custom';
      this.state.preset = undefined;
      this.markDirty();
      this.render();
    });
  }

  private renderPresetButton(parent: HTMLElement, preset: Preset, label: string): void {
    const button = parent.createEl('button', {
      text: label,
      attr: {
        type: 'button',
        'data-recurrence-preset': preset,
        'data-recurrence-focus-key': `preset:${preset}`,
        'aria-pressed': String(
          this.state.mode === 'structured' && this.canonicalPreset() === preset,
        ),
      },
    });
    button.addEventListener('click', () => {
      this.setPreset(preset);
    });
  }

  private renderRuleControls(editor: HTMLElement): void {
    const controls = editor.createDiv({ cls: 'abyss-recurrence-controls' });
    if (this.state.mode !== 'custom') {
      this.renderAdaptiveControls(controls);
      return;
    }
    const raw = controls.createEl('input', {
      cls: 'abyss-recurrence-raw',
      attr: {
        type: 'text',
        value: this.state.customDraft,
        'aria-label': 'Recurrence rule',
        'aria-describedby': this.diagnosticId,
        'aria-invalid': 'false',
        spellcheck: 'false',
        'data-recurrence-focus-key': 'custom',
      },
    });
    raw.addEventListener('input', () => {
      this.state.customDraft = raw.value;
      this.markDirty();
      this.refresh();
    });
  }

  private renderCompletionControls(editor: HTMLElement): void {
    this.renderWhenDoneControl(editor);
    const row = editor.createEl('label', { cls: 'abyss-recurrence-completed-row' });
    row.createSpan({ text: 'Completed task' });
    const completed = row.createEl('select', {
      attr: {
        'aria-label': 'Completed task',
        'data-recurrence-focus-key': 'completed-task',
      },
    });
    addOption(completed, 'keep', 'Keep completed task', this.state.onCompletion === 'keep');
    addOption(completed, 'delete', 'Delete completed task', this.state.onCompletion === 'delete');
    completed.addEventListener('change', () => {
      this.state.onCompletion = completed.value as 'keep' | 'delete';
      this.markDirty(false);
      this.refresh();
    });
  }

  private renderWhenDoneControl(editor: HTMLElement): void {
    const row = editor.createEl('label', { cls: 'abyss-recurrence-check-row' });
    const input = row.createEl('input', {
      cls: 'abyss-recurrence-when-done',
      attr: { type: 'checkbox', 'data-recurrence-focus-key': 'when-done' },
    });
    input.checked = this.state.whenDone;
    row.createSpan({ text: 'Repeat from completion date' });
    input.addEventListener('change', () => {
      this.state.whenDone = input.checked;
      this.syncCustomWhenDoneInput();
      this.markDirty();
      this.refresh();
    });
  }

  private syncCustomWhenDoneInput(): void {
    if (this.state.mode !== 'custom') return;
    this.state.customDraft = withTerminalWhenDone(this.state.customDraft, this.state.whenDone);
    const raw = this.options.container.querySelector<HTMLInputElement>('.abyss-recurrence-raw');
    if (raw !== null) raw.value = this.state.customDraft;
  }

  private renderDiagnostics(editor: HTMLElement): void {
    editor.createDiv({ cls: 'abyss-recurrence-delete-warning', attr: { role: 'note' } });
    const preview = editor.createDiv({ cls: 'abyss-recurrence-preview' });
    preview.createSpan({ cls: 'abyss-recurrence-preview-label', text: 'Rule' });
    preview.createSpan({ cls: 'abyss-recurrence-preview-rule' });
    editor.createDiv({
      cls: 'abyss-recurrence-status',
      attr: { id: this.diagnosticId, 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
  }

  private renderActions(editor: HTMLElement): void {
    const actions = editor.createDiv({ cls: 'abyss-recurrence-actions' });
    if (this.task?.recurrence !== undefined || (this.task?.onCompletionExplicit ?? false)) {
      this.renderClearAction(actions);
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
      runAsyncAction(this.submit(), 'Could not save recurrence');
    });
  }

  private renderClearAction(actions: HTMLElement): void {
    const clear = actions.createEl('button', {
      cls: 'abyss-recurrence-clear',
      text: 'Clear repeat',
      attr: { type: 'button', 'data-recurrence-focus-key': 'clear' },
    });
    clear.addEventListener('click', () => {
      runAsyncAction(this.clear(), 'Could not clear recurrence');
    });
  }

  private readonly keyHandler = (event: KeyboardEvent): void => {
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
      runAsyncAction(this.submit(), 'Could not save recurrence');
    }
  };

  private readonly submitShortcutHandler = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Enter' ||
      (!event.metaKey && !event.ctrlKey) ||
      event.target == null ||
      !this.options.container.contains(event.target as Node)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    runAsyncAction(this.submit(), 'Could not save recurrence');
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
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window | null;
  private readonly popover: HTMLElement;
  private readonly ownershipToken: ReturnType<InteractionOwnershipPort['acquire']>;
  private editor: RecurrenceEditorHandle | undefined;
  private destroyed = false;
  private outsideTimer: number | undefined;
  private autofocusTimer: number | undefined;

  constructor(private readonly options: AnchoredRecurrenceEditorOptions) {
    this.ownerDocument = options.anchor.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView;
    this.ownershipToken = (options.interactionOwnership ?? noInteractionOwnership).acquire({
      blocksShortcuts: true,
    });
    this.popover = this.ownerDocument.body.createDiv({
      cls: 'abyss-popover abyss-recurrence-popover abyss-popover-anchored abyss-recurrence-popover-floating',
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
  }

  mount(): void {
    this.editor = mountRecurrenceEditor({
      ...this.options,
      container: this.popover,
      dismissalFocus: this.options.anchor,
      onClose: () => {
        this.destroy();
      },
    });
    this.labelPopover();
    this.position();
    this.ownerDocument.addEventListener('scroll', this.position, true);
    this.ownerWindow?.addEventListener('resize', this.position);
    this.scheduleOutsideListener();
    this.scheduleAutofocus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    this.ownerDocument.removeEventListener('mousedown', this.onOutside, true);
    this.ownerDocument.removeEventListener('scroll', this.position, true);
    this.ownerWindow?.removeEventListener('resize', this.position);
    this.editor?.destroy();
    this.popover.remove();
    this.ownershipToken.release();
    this.options.onClose?.();
  }

  dismiss(): void {
    this.requireEditor().dismiss();
  }

  focus(): void {
    this.requireEditor().focus();
  }

  captureDraftState(): RecurrenceEditorDraft {
    return this.requireEditor().captureDraftState();
  }

  restoreDraftState(draft: RecurrenceEditorDraft): void {
    if (this.autofocusTimer !== undefined) {
      this.ownerWindow?.clearTimeout(this.autofocusTimer);
      this.autofocusTimer = undefined;
    }
    this.requireEditor().restoreDraftState(draft);
  }

  private requireEditor(): RecurrenceEditorHandle {
    if (this.editor === undefined) throw new Error('recurrence-editor-unavailable');
    return this.editor;
  }

  private labelPopover(): void {
    const title = this.popover.querySelector<HTMLElement>('.abyss-recurrence-title');
    if (title !== null && title.id.length > 0) {
      this.popover.setAttribute('aria-labelledby', title.id);
    }
  }

  private clearTimers(): void {
    if (this.outsideTimer !== undefined) this.ownerWindow?.clearTimeout(this.outsideTimer);
    if (this.autofocusTimer !== undefined) this.ownerWindow?.clearTimeout(this.autofocusTimer);
  }

  private scheduleOutsideListener(): void {
    this.outsideTimer = this.ownerWindow?.setTimeout(() => {
      this.outsideTimer = undefined;
      if (!this.destroyed) {
        this.ownerDocument.addEventListener('mousedown', this.onOutside, true);
      }
    }, 0);
  }

  private scheduleAutofocus(): void {
    this.autofocusTimer = this.ownerWindow?.setTimeout(() => {
      this.autofocusTimer = undefined;
      this.editor?.focus();
    }, 0);
  }

  private readonly position = (): void => {
    const anchor = this.options.anchor.getBoundingClientRect();
    const floating = this.popover.getBoundingClientRect();
    const measuredWidth = floating.width !== 0 ? floating.width : this.popover.offsetWidth;
    const width = measuredWidth !== 0 ? measuredWidth : 352;
    const height = floating.height !== 0 ? floating.height : this.popover.offsetHeight;
    const edge = 8;
    const viewportWidth = this.ownerWindow?.innerWidth ?? width + edge * 2;
    const viewportHeight = this.ownerWindow?.innerHeight ?? anchor.bottom + height + edge;
    const left = Math.min(
      Math.max(anchor.left, edge),
      Math.max(edge, viewportWidth - width - edge),
    );
    const below = anchor.bottom + 4;
    const top = below + height > viewportHeight - edge ? anchor.top - height - 4 : below;
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${Math.max(edge, top)}px`;
  };

  private readonly onOutside = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (!this.popover.contains(target) && !this.options.anchor.contains(target)) {
      this.editor?.dismiss();
    }
  };
}
