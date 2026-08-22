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
    if (!child) return undefined;
    selected = child;
  }
  return selected;
}

function referenceDate(
  source: TaskOccurrenceResult,
  policy: RecurrencePolicy,
): LocalDate | undefined {
  const planning = selectedTask(source)?.planning;
  if (!planning) return undefined;
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

function withoutTerminalWhenDone(raw: string): string {
  let base = raw.trimEnd();
  while (true) {
    let cursor = base.length;
    if (base.slice(cursor - 'done'.length, cursor).toLowerCase() !== 'done') return base;
    cursor -= 'done'.length;
    if (cursor === 0 || !/\s/u.test(base[cursor - 1] ?? '')) return base;
    while (cursor > 0 && /\s/u.test(base[cursor - 1] ?? '')) cursor--;
    if (base.slice(cursor - 'when'.length, cursor).toLowerCase() !== 'when') return base;
    cursor -= 'when'.length;
    if (cursor > 0 && !/\s/u.test(base[cursor - 1] ?? '')) return base;
    base = base.slice(0, cursor).trimEnd();
  }
}

function withTerminalWhenDone(raw: string, whenDone: boolean): string {
  const base = withoutTerminalWhenDone(raw);
  return `${base}${whenDone ? ' when done' : ''}`;
}

export function mountRecurrenceEditor(options: RecurrenceEditorOptions): RecurrenceEditorHandle {
  const instanceId = ++nextEditorInstance;
  const titleId = `abyss-recurrence-title-${instanceId}`;
  const diagnosticId = `abyss-recurrence-diagnostic-${instanceId}`;
  const task = selectedTask(options.source);
  const reference = referenceDate(options.source, options.policy);
  const previousFocus = options.container.ownerDocument.activeElement;
  const restoreFocus = (): void => {
    if (options.dismissalFocus?.isConnected) {
      options.dismissalFocus.focus();
      return;
    }
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const dismiss = (): void => {
    options.onClose();
    restoreFocus();
  };
  const existing = task?.recurrence;
  const existingParsed = existing === undefined ? undefined : parseRecurrenceRule(existing);
  const state: EditorState = {
    mode: existing === undefined ? 'structured' : 'custom',
    preset: existing === undefined ? 'daily' : undefined,
    intervalText: '1',
    unit: 'days',
    weekdays: reference ? [weekdayForReference(reference)] : ['Monday'],
    monthly: { type: 'same-date' },
    yearly: { type: 'same-date' },
    whenDone: existingParsed?.type === 'valid' ? existingParsed.whenDone : false,
    customDraft: existing ?? 'every day',
    onCompletion: task?.onCompletion ?? 'keep',
    submitting: false,
    submissionError: undefined,
    dirty: false,
  };

  const controlKey = (element: Element | null): string | undefined => {
    if (!(element instanceof HTMLElement) || !options.container.contains(element)) return undefined;
    return element.dataset['recurrenceFocusKey'];
  };

  const controlForKey = (key: string | undefined): HTMLElement | undefined => {
    if (!key) return undefined;
    const controls = [
      ...options.container.querySelectorAll<HTMLElement>('[data-recurrence-focus-key]'),
    ];
    return controls.find((control) => controlKey(control) === key);
  };

  const parseState = (): RecurrenceParseResult => {
    if (state.mode === 'custom') return parseRecurrenceRule(state.customDraft);
    if (state.preset === 'weekdays') {
      return parseRecurrenceRule(`every weekday${state.whenDone ? ' when done' : ''}`);
    }
    return buildRecurrenceRule({
      interval: Number(state.intervalText),
      unit: state.unit,
      weekdays: state.weekdays,
      monthly: state.monthly,
      yearly: state.yearly,
      whenDone: state.whenDone,
    });
  };

  const canonicalPreset = (): Preset | undefined => {
    if (state.mode === 'custom') return undefined;
    const parsed = parseState();
    if (parsed.type === 'invalid') return undefined;
    const candidates: readonly (readonly [Preset, string])[] = [
      ['daily', 'every day'],
      ['weekdays', 'every weekday'],
      ...(reference === undefined
        ? []
        : ([['weekly', recurrencePresetRule('weekly', reference)]] as const)),
      ['monthly', 'every month'],
      ['yearly', 'every year'],
    ];
    return candidates.find(([, rule]) => parsed.canonical === rule)?.[0];
  };

  const validationMessage = (parsed: RecurrenceParseResult): string => {
    if (options.ownershipConflict) return 'Remove the nested repeat conflict first.';
    if (!reference) return 'Add a date before setting a repeat.';
    if (
      state.mode === 'structured' &&
      state.preset !== 'weekdays' &&
      (!Number.isSafeInteger(Number(state.intervalText)) || Number(state.intervalText) < 1)
    ) {
      return 'Use a whole number greater than zero.';
    }
    if (state.submissionError) return state.submissionError;
    return parsed.type === 'invalid' ? recurrenceIssueText(parsed.code) : '';
  };

  const refresh = (): void => {
    const parsed = parseState();
    if (state.mode === 'custom' && parsed.type === 'valid') {
      state.whenDone = parsed.whenDone;
    }
    const message = validationMessage(parsed);
    const preview = options.container.querySelector<HTMLElement>('.abyss-recurrence-preview-rule');
    if (preview) {
      let previewText = '—';
      if (parsed.type === 'valid') {
        const completionSuffix = parsed.whenDone ? ' when done' : '';
        previewText = `${parsed.canonical}${completionSuffix}`;
      }
      preview.textContent = previewText;
    }
    const status = options.container.querySelector<HTMLElement>('.abyss-recurrence-status');
    if (status) {
      status.textContent = message;
      status.hidden = message.length === 0;
    }
    const warning = options.container.querySelector<HTMLElement>(
      '.abyss-recurrence-delete-warning',
    );
    if (warning) {
      warning.textContent =
        state.onCompletion === 'delete'
          ? 'Completing this repeat deletes the finished task and its owned sub-tasks.'
          : '';
      warning.hidden = state.onCompletion !== 'delete';
    }
    const whenDoneControl = options.container.querySelector<HTMLInputElement>(
      '.abyss-recurrence-when-done',
    );
    if (whenDoneControl && state.mode === 'custom' && parsed.type === 'valid') {
      whenDoneControl.checked = parsed.whenDone;
    }
    const save = options.container.querySelector<HTMLButtonElement>('.abyss-recurrence-save');
    if (save) save.disabled = state.submitting || message.length > 0 || parsed.type === 'invalid';
    const pressedPreset = canonicalPreset();
    for (const button of options.container.querySelectorAll<HTMLButtonElement>(
      '.abyss-recurrence-presets button',
    )) {
      const preset = button.dataset['recurrencePreset'] as Preset | undefined;
      const custom = button.dataset['recurrenceMode'] === 'custom';
      button.setAttribute(
        'aria-pressed',
        String(custom ? state.mode === 'custom' : preset !== undefined && preset === pressedPreset),
      );
    }
    const invalidInterval =
      state.mode === 'structured' &&
      state.preset !== 'weekdays' &&
      (!Number.isSafeInteger(Number(state.intervalText)) || Number(state.intervalText) < 1);
    const invalidMonthDay =
      state.mode === 'structured' &&
      state.unit === 'months' &&
      state.monthly.type === 'day' &&
      (!Number.isSafeInteger(state.monthly.day) || state.monthly.day < 1 || state.monthly.day > 31);
    const invalidYearlyDay =
      state.mode === 'structured' &&
      state.unit === 'years' &&
      state.yearly.type === 'date' &&
      (!Number.isSafeInteger(state.yearly.day) || state.yearly.day < 1 || state.yearly.day > 31);
    options.container
      .querySelector<HTMLElement>('.abyss-recurrence-interval')
      ?.setAttribute('aria-invalid', String(invalidInterval));
    options.container
      .querySelector<HTMLElement>('.abyss-recurrence-month-day')
      ?.setAttribute('aria-invalid', String(invalidMonthDay));
    options.container
      .querySelector<HTMLElement>('.abyss-recurrence-yearly-day')
      ?.setAttribute('aria-invalid', String(invalidYearlyDay));
    options.container
      .querySelector<HTMLElement>('.abyss-recurrence-raw')
      ?.setAttribute('aria-invalid', String(state.mode === 'custom' && parsed.type === 'invalid'));
  };

  const submit = async (): Promise<void> => {
    const parsed = parseState();
    if (state.submitting || validationMessage(parsed).length > 0 || parsed.type === 'invalid')
      return;
    state.submitting = true;
    state.submissionError = undefined;
    refresh();
    try {
      const initialOnCompletion = task?.onCompletion ?? 'keep';
      let onCompletionPatch: Pick<TaskPatch, 'onCompletion'> = {};
      if (state.onCompletion !== initialOnCompletion) {
        onCompletionPatch =
          state.onCompletion === 'delete'
            ? { onCompletion: { type: 'set', value: 'delete' } }
            : { onCompletion: { type: 'clear' } };
      }
      const result = await options.onSubmit({
        recurrence: { type: 'set', value: parsed.raw },
        ...onCompletionPatch,
      });
      if (result.type === 'ok') {
        options.onClose();
        return;
      }
      state.submissionError = 'Could not save the repeat.';
    } catch {
      state.submissionError = 'Could not save the repeat.';
    }
    state.submitting = false;
    refresh();
  };

  const clear = async (): Promise<void> => {
    if (state.submitting) return;
    state.submitting = true;
    refresh();
    try {
      const result = await options.onSubmit({
        recurrence: { type: 'clear' },
        onCompletion: { type: 'clear' },
      });
      if (result.type === 'ok') {
        options.onClose();
        return;
      }
      state.submissionError = 'Could not clear the repeat.';
    } catch {
      state.submissionError = 'Could not clear the repeat.';
    }
    state.submitting = false;
    refresh();
  };

  const setPreset = (preset: Preset): void => {
    state.mode = 'structured';
    state.preset = preset;
    state.intervalText = '1';
    state.monthly = { type: 'same-date' };
    state.yearly = { type: 'same-date' };
    if (preset === 'daily' || preset === 'weekdays') state.unit = 'days';
    if (preset === 'weekly') {
      state.unit = 'weeks';
      state.weekdays = reference ? [weekdayForReference(reference)] : ['Monday'];
    }
    if (preset === 'monthly') state.unit = 'months';
    if (preset === 'yearly') state.unit = 'years';
    state.submissionError = undefined;
    state.dirty = true;
    render();
  };

  const renderAdaptiveControls = (parent: HTMLElement): void => {
    if (state.preset === 'weekdays') return;
    const cadence = parent.createDiv({ cls: 'abyss-recurrence-cadence' });
    cadence.createEl('span', { cls: 'abyss-recurrence-inline-label', text: 'Every' });
    const interval = cadence.createEl('input', {
      cls: 'abyss-recurrence-interval',
      attr: {
        type: 'text',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        value: state.intervalText,
        'aria-label': 'Repeat interval',
        'aria-describedby': diagnosticId,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'interval',
      },
    });
    interval.addEventListener('input', () => {
      state.intervalText = interval.value;
      state.preset = undefined;
      state.submissionError = undefined;
      state.dirty = true;
      refresh();
    });
    const unit = cadence.createEl('select', {
      attr: { 'aria-label': 'Repeat unit', 'data-recurrence-focus-key': 'unit' },
    });
    addOption(unit, 'days', 'Days', state.unit === 'days');
    addOption(unit, 'weeks', 'Weeks', state.unit === 'weeks');
    addOption(unit, 'months', 'Months', state.unit === 'months');
    addOption(unit, 'years', 'Years', state.unit === 'years');
    unit.addEventListener('change', () => {
      state.unit = unit.value as Unit;
      state.preset = undefined;
      state.monthly = { type: 'same-date' };
      state.yearly = { type: 'same-date' };
      state.weekdays = reference ? [weekdayForReference(reference)] : ['Monday'];
      state.submissionError = undefined;
      state.dirty = true;
      render();
    });

    if (state.unit === 'weeks') {
      const days = parent.createDiv({
        cls: 'abyss-recurrence-weekdays',
        attr: { role: 'group', 'aria-label': 'Repeat weekdays' },
      });
      for (const weekday of WEEKDAYS) {
        const label = days.createEl('label', { cls: 'abyss-recurrence-weekday' });
        const checkbox = label.createEl('input', {
          attr: {
            type: 'checkbox',
            name: 'recurrence-weekday',
            value: weekday,
            'data-recurrence-focus-key': `weekday:${weekday}`,
          },
        });
        checkbox.checked = state.weekdays.includes(weekday);
        label.createSpan({ text: weekday.slice(0, 2) });
        checkbox.addEventListener('change', () => {
          state.weekdays = checkbox.checked
            ? [...state.weekdays, weekday]
            : state.weekdays.filter((candidate) => candidate !== weekday);
          state.submissionError = undefined;
          state.dirty = true;
          refresh();
        });
      }
    }

    if (state.unit === 'months') renderMonthlyControls(parent);
    if (state.unit === 'years') renderYearlyControls(parent);
  };

  const renderMonthlyControls = (parent: HTMLElement): void => {
    const row = parent.createDiv({ cls: 'abyss-recurrence-detail-row' });
    const pattern = row.createEl('select', {
      attr: {
        'aria-label': 'Monthly pattern',
        'data-recurrence-focus-key': 'monthly-pattern',
      },
    });
    const value = state.monthly.type === 'edge' ? state.monthly.edge : state.monthly.type;
    addOption(pattern, 'same-date', 'Same date', value === 'same-date');
    addOption(pattern, 'day', 'Day of month', value === 'day');
    addOption(pattern, 'first', 'First day', value === 'first');
    addOption(pattern, 'last', 'Last day', value === 'last');
    addOption(pattern, 'weekday', 'Weekday pattern', value === 'weekday');
    pattern.addEventListener('change', () => {
      if (pattern.value === 'same-date') state.monthly = { type: 'same-date' };
      if (pattern.value === 'day') state.monthly = { type: 'day', day: 1 };
      if (pattern.value === 'first' || pattern.value === 'last') {
        state.monthly = { type: 'edge', edge: pattern.value };
      }
      if (pattern.value === 'weekday') {
        state.monthly = { type: 'weekday', ordinal: 1, weekday: 'Monday' };
      }
      state.submissionError = undefined;
      state.dirty = true;
      render();
    });
    if (state.monthly.type === 'day') {
      const day = row.createEl('input', {
        cls: 'abyss-recurrence-month-day',
        attr: {
          type: 'number',
          min: '1',
          max: '31',
          value: String(state.monthly.day),
          'aria-label': 'Month day',
          'aria-describedby': diagnosticId,
          'aria-invalid': 'false',
          'data-recurrence-focus-key': 'monthly-day',
        },
      });
      day.addEventListener('input', () => {
        state.monthly = { type: 'day', day: Number(day.value) };
        state.dirty = true;
        refresh();
      });
    }
    if (state.monthly.type === 'weekday') {
      const ordinal = row.createEl('select', {
        attr: {
          'aria-label': 'Weekday ordinal',
          'data-recurrence-focus-key': 'monthly-ordinal',
        },
      });
      for (const [number, label] of [
        [1, 'First'],
        [2, 'Second'],
        [3, 'Third'],
        [4, 'Fourth'],
        [-1, 'Last'],
        [-2, 'Second last'],
      ] as const) {
        addOption(ordinal, String(number), label, state.monthly.ordinal === number);
      }
      const weekday = row.createEl('select', {
        attr: {
          'aria-label': 'Monthly weekday',
          'data-recurrence-focus-key': 'monthly-weekday',
        },
      });
      for (const value of WEEKDAYS) {
        addOption(weekday, value, value, state.monthly.weekday === value);
      }
      ordinal.addEventListener('change', () => {
        if (state.monthly.type !== 'weekday') return;
        state.monthly = {
          ...state.monthly,
          ordinal: Number(ordinal.value) as 1 | 2 | 3 | 4 | -1 | -2,
        };
        state.dirty = true;
        refresh();
      });
      weekday.addEventListener('change', () => {
        if (state.monthly.type !== 'weekday') return;
        state.monthly = { ...state.monthly, weekday: weekday.value as Weekday };
        state.dirty = true;
        refresh();
      });
    }
  };

  const renderYearlyControls = (parent: HTMLElement): void => {
    const row = parent.createDiv({ cls: 'abyss-recurrence-detail-row' });
    const pattern = row.createEl('select', {
      attr: {
        'aria-label': 'Yearly pattern',
        'data-recurrence-focus-key': 'yearly-pattern',
      },
    });
    addOption(pattern, 'same-date', 'Same date', state.yearly.type === 'same-date');
    addOption(pattern, 'date', 'Calendar date', state.yearly.type === 'date');
    pattern.addEventListener('change', () => {
      state.yearly =
        pattern.value === 'date' ? { type: 'date', month: 1, day: 1 } : { type: 'same-date' };
      state.submissionError = undefined;
      state.dirty = true;
      render();
    });
    if (state.yearly.type !== 'date') return;
    const month = row.createEl('select', {
      attr: {
        'aria-label': 'Yearly month',
        'data-recurrence-focus-key': 'yearly-month',
      },
    });
    MONTHS.forEach((label, index) => {
      addOption(
        month,
        String(index + 1),
        label,
        state.yearly.type === 'date' && state.yearly.month === index + 1,
      );
    });
    const day = row.createEl('input', {
      cls: 'abyss-recurrence-yearly-day',
      attr: {
        type: 'number',
        min: '1',
        max: '31',
        value: String(state.yearly.day),
        'aria-label': 'Yearly day',
        'aria-describedby': diagnosticId,
        'aria-invalid': 'false',
        'data-recurrence-focus-key': 'yearly-day',
      },
    });
    month.addEventListener('change', () => {
      if (state.yearly.type !== 'date') return;
      state.yearly = { ...state.yearly, month: Number(month.value) as Month };
      state.dirty = true;
      refresh();
    });
    day.addEventListener('input', () => {
      if (state.yearly.type !== 'date') return;
      state.yearly = { ...state.yearly, day: Number(day.value) };
      state.dirty = true;
      refresh();
    });
  };

  const render = (): void => {
    const focusedControl = controlKey(options.container.ownerDocument.activeElement);
    options.container.empty();
    const editor = options.container.createDiv({
      cls: 'abyss-recurrence-editor',
      attr: { role: 'region', 'aria-labelledby': titleId },
    });
    const heading = editor.createDiv({ cls: 'abyss-recurrence-heading' });
    heading.createEl('span', {
      cls: 'abyss-recurrence-title',
      text: 'Repeat',
      attr: { id: titleId },
    });
    const presets = editor.createDiv({
      cls: 'abyss-recurrence-presets',
      attr: { role: 'group', 'aria-label': 'Repeat pattern' },
    });
    for (const [preset, label] of [
      ['daily', 'Daily'],
      ['weekdays', 'Weekdays'],
      ['weekly', 'Weekly'],
      ['monthly', 'Monthly'],
      ['yearly', 'Yearly'],
    ] as const) {
      const presetButton = presets.createEl('button', {
        text: label,
        attr: {
          type: 'button',
          'data-recurrence-preset': preset,
          'data-recurrence-focus-key': `preset:${preset}`,
          'aria-pressed': String(state.mode === 'structured' && canonicalPreset() === preset),
        },
      });
      presetButton.addEventListener('click', () => setPreset(preset));
    }
    const customButton = presets.createEl('button', {
      text: 'Custom',
      attr: {
        type: 'button',
        'data-recurrence-mode': 'custom',
        'data-recurrence-focus-key': 'custom-mode',
        'aria-pressed': String(state.mode === 'custom'),
      },
    });
    customButton.addEventListener('click', () => {
      state.customDraft = withTerminalWhenDone(state.customDraft, state.whenDone);
      state.mode = 'custom';
      state.preset = undefined;
      state.submissionError = undefined;
      state.dirty = true;
      render();
    });

    const controls = editor.createDiv({ cls: 'abyss-recurrence-controls' });
    if (state.mode === 'custom') {
      const raw = controls.createEl('input', {
        cls: 'abyss-recurrence-raw',
        attr: {
          type: 'text',
          value: state.customDraft,
          'aria-label': 'Recurrence rule',
          'aria-describedby': diagnosticId,
          'aria-invalid': 'false',
          spellcheck: 'false',
          'data-recurrence-focus-key': 'custom',
        },
      });
      raw.addEventListener('input', () => {
        state.customDraft = raw.value;
        state.submissionError = undefined;
        state.dirty = true;
        refresh();
      });
    } else {
      renderAdaptiveControls(controls);
    }

    const whenDone = editor.createEl('label', { cls: 'abyss-recurrence-check-row' });
    const whenDoneInput = whenDone.createEl('input', {
      cls: 'abyss-recurrence-when-done',
      attr: { type: 'checkbox', 'data-recurrence-focus-key': 'when-done' },
    });
    whenDoneInput.checked = state.whenDone;
    whenDone.createSpan({ text: 'Repeat from completion date' });
    whenDoneInput.addEventListener('change', () => {
      state.whenDone = whenDoneInput.checked;
      if (state.mode === 'custom') {
        state.customDraft = withTerminalWhenDone(state.customDraft, state.whenDone);
        const raw = options.container.querySelector<HTMLInputElement>('.abyss-recurrence-raw');
        if (raw) raw.value = state.customDraft;
      }
      state.submissionError = undefined;
      state.dirty = true;
      refresh();
    });

    const completedRow = editor.createEl('label', { cls: 'abyss-recurrence-completed-row' });
    completedRow.createSpan({ text: 'Completed task' });
    const completed = completedRow.createEl('select', {
      attr: {
        'aria-label': 'Completed task',
        'data-recurrence-focus-key': 'completed-task',
      },
    });
    addOption(completed, 'keep', 'Keep completed task', state.onCompletion === 'keep');
    addOption(completed, 'delete', 'Delete completed task', state.onCompletion === 'delete');
    completed.addEventListener('change', () => {
      state.onCompletion = completed.value as 'keep' | 'delete';
      state.dirty = true;
      refresh();
    });

    editor.createDiv({ cls: 'abyss-recurrence-delete-warning', attr: { role: 'note' } });
    const preview = editor.createDiv({ cls: 'abyss-recurrence-preview' });
    preview.createSpan({ cls: 'abyss-recurrence-preview-label', text: 'Rule' });
    preview.createSpan({ cls: 'abyss-recurrence-preview-rule' });
    editor.createDiv({
      cls: 'abyss-recurrence-status',
      attr: { id: diagnosticId, 'aria-live': 'polite', 'aria-atomic': 'true' },
    });

    const actions = editor.createDiv({ cls: 'abyss-recurrence-actions' });
    if (existing !== undefined || task?.onCompletionExplicit) {
      const clearButton = actions.createEl('button', {
        cls: 'abyss-recurrence-clear',
        text: 'Clear repeat',
        attr: { type: 'button', 'data-recurrence-focus-key': 'clear' },
      });
      clearButton.addEventListener('click', () => void clear());
    }
    const spacer = actions.createSpan({ cls: 'abyss-recurrence-actions-spacer' });
    spacer.setAttribute('aria-hidden', 'true');
    const cancel = actions.createEl('button', {
      text: 'Cancel',
      attr: { type: 'button', 'data-recurrence-focus-key': 'cancel' },
    });
    cancel.addEventListener('click', dismiss);
    const save = actions.createEl('button', {
      cls: 'mod-cta abyss-recurrence-save',
      text: 'Save repeat',
      attr: { type: 'button', 'data-recurrence-focus-key': 'save' },
    });
    save.addEventListener('click', () => void submit());
    refresh();
    controlForKey(focusedControl)?.focus();
  };

  const keyHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
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
      void submit();
    }
  };

  const ownerWindow = options.container.ownerDocument.defaultView;
  const submitShortcutHandler = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Enter' ||
      (!event.metaKey && !event.ctrlKey) ||
      !event.target ||
      !options.container.contains(event.target as Node)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void submit();
  };

  ownerWindow?.addEventListener('keydown', submitShortcutHandler, true);
  options.container.addEventListener('keydown', keyHandler);
  render();

  const captureDraftState = (): RecurrenceEditorDraft => {
    const active = options.container.ownerDocument.activeElement;
    const input =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active
        : undefined;
    return {
      mode: state.mode,
      ...(state.preset !== undefined && { preset: state.preset }),
      intervalText: state.intervalText,
      unit: state.unit,
      weekdays: [...state.weekdays],
      monthly: state.monthly,
      yearly: state.yearly,
      whenDone: state.whenDone,
      onCompletion: state.onCompletion,
      customDraft: state.customDraft,
      ...(controlKey(active) !== undefined && { focusedControl: controlKey(active) }),
      ...(input?.selectionStart !== null &&
        input?.selectionStart !== undefined && {
          selectionStart: input.selectionStart,
        }),
      ...(input?.selectionEnd !== null &&
        input?.selectionEnd !== undefined && {
          selectionEnd: input.selectionEnd,
        }),
      dirty: state.dirty,
    };
  };

  const restoreDraftState = (draft: RecurrenceEditorDraft): void => {
    state.mode = draft.mode;
    state.preset = draft.preset;
    state.intervalText = draft.intervalText;
    state.unit = draft.unit;
    state.weekdays = [...draft.weekdays];
    state.monthly = draft.monthly;
    state.yearly = draft.yearly;
    state.whenDone = draft.whenDone;
    state.onCompletion = draft.onCompletion;
    state.customDraft = draft.customDraft;
    state.dirty = draft.dirty;
    state.submissionError = undefined;
    render();
    const control = controlForKey(draft.focusedControl);
    control?.focus();
    if (
      control instanceof HTMLInputElement &&
      draft.selectionStart !== undefined &&
      draft.selectionEnd !== undefined
    ) {
      control.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    }
  };

  return {
    destroy: () => {
      ownerWindow?.removeEventListener('keydown', submitShortcutHandler, true);
      options.container.removeEventListener('keydown', keyHandler);
      options.container.empty();
    },
    dismiss,
    focus: () => {
      const focusTarget = options.container.querySelector<HTMLElement>(
        state.mode === 'custom'
          ? '[aria-label="Recurrence rule"]'
          : '[aria-pressed="true"], [aria-label="Repeat interval"]',
      );
      focusTarget?.focus();
    },
    captureDraftState,
    restoreDraftState,
  };
}

export function mountAnchoredRecurrenceEditor(
  options: AnchoredRecurrenceEditorOptions,
): RecurrenceEditorHandle {
  const ownerDocument = options.anchor.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const popover = ownerDocument.body.createDiv({
    cls: 'abyss-popover abyss-recurrence-popover abyss-popover-anchored abyss-recurrence-popover-floating',
    attr: { role: 'dialog', 'aria-modal': 'false' },
  });
  let destroyed = false;
  let outsideTimer: number | undefined;
  let autofocusTimer: number | undefined;
  let editor: RecurrenceEditorHandle | undefined;

  const position = (): void => {
    const anchorRect = options.anchor.getBoundingClientRect();
    const floatingRect = popover.getBoundingClientRect();
    const width = floatingRect.width || popover.offsetWidth || 352;
    const height = floatingRect.height || popover.offsetHeight;
    const edge = 8;
    const viewportWidth = ownerWindow?.innerWidth ?? width + edge * 2;
    const viewportHeight = ownerWindow?.innerHeight ?? anchorRect.bottom + height + edge;
    const left = Math.min(
      Math.max(anchorRect.left, edge),
      Math.max(edge, viewportWidth - width - edge),
    );
    const below = anchorRect.bottom + 4;
    const preferredTop =
      below + height > viewportHeight - edge ? anchorRect.top - height - 4 : below;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(edge, preferredTop)}px`;
  };
  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (!popover.contains(target) && !options.anchor.contains(target)) editor?.dismiss();
  };
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (outsideTimer !== undefined) ownerWindow?.clearTimeout(outsideTimer);
    if (autofocusTimer !== undefined) ownerWindow?.clearTimeout(autofocusTimer);
    ownerDocument.removeEventListener('mousedown', onOutside, true);
    ownerDocument.removeEventListener('scroll', position, true);
    ownerWindow?.removeEventListener('resize', position);
    editor?.destroy();
    popover.remove();
    options.onClose?.();
  };

  editor = mountRecurrenceEditor({
    ...options,
    container: popover,
    dismissalFocus: options.anchor,
    onClose: destroy,
  });
  const title = popover.querySelector<HTMLElement>('.abyss-recurrence-title');
  if (title?.id) popover.setAttribute('aria-labelledby', title.id);
  position();
  ownerDocument.addEventListener('scroll', position, true);
  ownerWindow?.addEventListener('resize', position);
  outsideTimer = ownerWindow?.setTimeout(() => {
    outsideTimer = undefined;
    if (!destroyed) ownerDocument.addEventListener('mousedown', onOutside, true);
  }, 0);
  autofocusTimer = ownerWindow?.setTimeout(() => {
    autofocusTimer = undefined;
    editor?.focus();
  }, 0);

  return {
    destroy,
    dismiss: () => editor?.dismiss(),
    focus: () => editor?.focus(),
    captureDraftState: () => {
      if (!editor) throw new Error('recurrence-editor-unavailable');
      return editor.captureDraftState();
    },
    restoreDraftState: (draft) => {
      if (autofocusTimer !== undefined) {
        ownerWindow?.clearTimeout(autofocusTimer);
        autofocusTimer = undefined;
      }
      editor?.restoreDraftState(draft);
    },
  };
}
