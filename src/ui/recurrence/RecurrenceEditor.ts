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
import type { TaskSelectionNode } from '../taskSelection';
import {
  buildRecurrenceRule,
  recurrencePresetRule,
  type MonthlyChoice,
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
}

export interface RecurrenceEditorHandle {
  destroy(): void;
  focus(): void;
}

export interface AnchoredRecurrenceEditorOptions extends Omit<
  RecurrenceEditorOptions,
  'container' | 'onClose'
> {
  readonly anchor: HTMLElement;
  readonly onClose?: () => void;
}

type Preset = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';
type Unit = 'days' | 'weeks' | 'months' | 'years';
type Month = Extract<YearlyChoice, { type: 'date' }>['month'];

interface EditorState {
  mode: 'controls' | 'advanced';
  preset: Preset | undefined;
  intervalText: string;
  unit: Unit;
  weekdays: Weekday[];
  monthly: MonthlyChoice;
  yearly: YearlyChoice;
  whenDone: boolean;
  advancedRaw: string;
  onCompletion: 'keep' | 'delete';
  submitting: boolean;
  submissionError: string | undefined;
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

function selectedTask(source: TaskOccurrenceResult): TaskSelectionNode | undefined {
  if (source.target.type === 'task') return source.root;
  const path = [];
  let current = source.target.ref;
  path.unshift(current);
  while (current.parent.type === 'subtask') {
    current = current.parent.ref;
    path.unshift(current);
  }
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
  let base = raw.trim().replace(/\s+/gu, ' ');
  const suffix = 'when done';
  while (base.toLowerCase().endsWith(suffix)) {
    const suffixStart = base.length - suffix.length;
    const preceding = base.charAt(suffixStart - 1);
    if (suffixStart > 0 && preceding?.trim().length !== 0) break;
    base = base.slice(0, suffixStart).trimEnd();
  }
  return base;
}

export function mountRecurrenceEditor(options: RecurrenceEditorOptions): RecurrenceEditorHandle {
  const task = selectedTask(options.source);
  const reference = referenceDate(options.source, options.policy);
  const previousFocus = options.container.ownerDocument.activeElement;
  const existing = task?.recurrence;
  const existingParsed = existing === undefined ? undefined : parseRecurrenceRule(existing);
  const state: EditorState = {
    mode: existing === undefined ? 'controls' : 'advanced',
    preset: existing === undefined ? 'daily' : undefined,
    intervalText: '1',
    unit: 'days',
    weekdays: reference ? [weekdayForReference(reference)] : ['Monday'],
    monthly: { type: 'same-date' },
    yearly: { type: 'same-date' },
    whenDone: existingParsed?.type === 'valid' ? existingParsed.whenDone : false,
    advancedRaw: existing ?? 'every day',
    onCompletion: task?.onCompletion ?? 'keep',
    submitting: false,
    submissionError: undefined,
  };

  const parseState = (): RecurrenceParseResult => {
    if (state.mode === 'advanced') return parseRecurrenceRule(state.advancedRaw);
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

  const validationMessage = (parsed: RecurrenceParseResult): string => {
    if (options.ownershipConflict) return 'Remove the nested repeat conflict first.';
    if (!reference) return 'Add a date before setting a repeat.';
    if (
      state.mode === 'controls' &&
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
    if (state.mode === 'advanced' && parsed.type === 'valid') {
      state.whenDone = parsed.whenDone;
    }
    const message = validationMessage(parsed);
    const preview = options.container.querySelector<HTMLElement>('.tc-recurrence-preview-rule');
    if (preview) {
      let previewText = '—';
      if (parsed.type === 'valid') {
        const completionSuffix = parsed.whenDone ? ' when done' : '';
        previewText = `${parsed.canonical}${completionSuffix}`;
      }
      preview.textContent = previewText;
    }
    const status = options.container.querySelector<HTMLElement>('.tc-recurrence-status');
    if (status) status.textContent = message;
    const warning = options.container.querySelector<HTMLElement>('.tc-recurrence-delete-warning');
    if (warning) {
      warning.textContent =
        state.onCompletion === 'delete'
          ? 'Completing this repeat deletes the finished task and its owned sub-tasks.'
          : '';
    }
    const whenDoneControl = options.container.querySelector<HTMLInputElement>(
      '.tc-recurrence-when-done',
    );
    if (whenDoneControl && state.mode === 'advanced' && parsed.type === 'valid') {
      whenDoneControl.checked = parsed.whenDone;
    }
    const save = options.container.querySelector<HTMLButtonElement>('.tc-recurrence-save');
    if (save) save.disabled = state.submitting || message.length > 0 || parsed.type === 'invalid';
  };

  const submit = async (): Promise<void> => {
    const parsed = parseState();
    if (state.submitting || validationMessage(parsed).length > 0 || parsed.type === 'invalid')
      return;
    state.submitting = true;
    state.submissionError = undefined;
    refresh();
    try {
      const result = await options.onSubmit({
        recurrence: { type: 'set', value: parsed.raw },
        onCompletion: { type: 'set', value: state.onCompletion },
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
    state.mode = 'controls';
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
    render();
  };

  const renderAdaptiveControls = (parent: HTMLElement): void => {
    if (state.preset === 'weekdays') return;
    const cadence = parent.createDiv({ cls: 'tc-recurrence-cadence' });
    cadence.createEl('span', { cls: 'tc-recurrence-inline-label', text: 'Every' });
    const interval = cadence.createEl('input', {
      cls: 'tc-recurrence-interval',
      attr: {
        type: 'number',
        min: '1',
        step: '1',
        value: state.intervalText,
        'aria-label': 'Repeat interval',
      },
    });
    interval.addEventListener('input', () => {
      state.intervalText = interval.value;
      state.preset = undefined;
      state.submissionError = undefined;
      refresh();
    });
    const unit = cadence.createEl('select', { attr: { 'aria-label': 'Repeat unit' } });
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
      render();
    });

    if (state.unit === 'weeks') {
      const days = parent.createDiv({
        cls: 'tc-recurrence-weekdays',
        attr: { role: 'group', 'aria-label': 'Repeat weekdays' },
      });
      for (const weekday of WEEKDAYS) {
        const label = days.createEl('label', { cls: 'tc-recurrence-weekday' });
        const checkbox = label.createEl('input', {
          attr: { type: 'checkbox', name: 'recurrence-weekday', value: weekday },
        });
        checkbox.checked = state.weekdays.includes(weekday);
        label.createSpan({ text: weekday.slice(0, 2) });
        checkbox.addEventListener('change', () => {
          state.weekdays = checkbox.checked
            ? [...state.weekdays, weekday]
            : state.weekdays.filter((candidate) => candidate !== weekday);
          state.submissionError = undefined;
          refresh();
        });
      }
    }

    if (state.unit === 'months') renderMonthlyControls(parent);
    if (state.unit === 'years') renderYearlyControls(parent);
  };

  const renderMonthlyControls = (parent: HTMLElement): void => {
    const row = parent.createDiv({ cls: 'tc-recurrence-detail-row' });
    const pattern = row.createEl('select', { attr: { 'aria-label': 'Monthly pattern' } });
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
      render();
    });
    if (state.monthly.type === 'day') {
      const day = row.createEl('input', {
        attr: {
          type: 'number',
          min: '1',
          max: '31',
          value: String(state.monthly.day),
          'aria-label': 'Month day',
        },
      });
      day.addEventListener('input', () => {
        state.monthly = { type: 'day', day: Number(day.value) };
        refresh();
      });
    }
    if (state.monthly.type === 'weekday') {
      const ordinal = row.createEl('select', { attr: { 'aria-label': 'Weekday ordinal' } });
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
      const weekday = row.createEl('select', { attr: { 'aria-label': 'Monthly weekday' } });
      for (const value of WEEKDAYS) {
        addOption(weekday, value, value, state.monthly.weekday === value);
      }
      ordinal.addEventListener('change', () => {
        if (state.monthly.type !== 'weekday') return;
        state.monthly = {
          ...state.monthly,
          ordinal: Number(ordinal.value) as 1 | 2 | 3 | 4 | -1 | -2,
        };
        refresh();
      });
      weekday.addEventListener('change', () => {
        if (state.monthly.type !== 'weekday') return;
        state.monthly = { ...state.monthly, weekday: weekday.value as Weekday };
        refresh();
      });
    }
  };

  const renderYearlyControls = (parent: HTMLElement): void => {
    const row = parent.createDiv({ cls: 'tc-recurrence-detail-row' });
    const pattern = row.createEl('select', { attr: { 'aria-label': 'Yearly pattern' } });
    addOption(pattern, 'same-date', 'Same date', state.yearly.type === 'same-date');
    addOption(pattern, 'date', 'Calendar date', state.yearly.type === 'date');
    pattern.addEventListener('change', () => {
      state.yearly =
        pattern.value === 'date' ? { type: 'date', month: 1, day: 1 } : { type: 'same-date' };
      state.submissionError = undefined;
      render();
    });
    if (state.yearly.type !== 'date') return;
    const month = row.createEl('select', { attr: { 'aria-label': 'Yearly month' } });
    MONTHS.forEach((label, index) => {
      addOption(
        month,
        String(index + 1),
        label,
        state.yearly.type === 'date' && state.yearly.month === index + 1,
      );
    });
    const day = row.createEl('input', {
      attr: {
        type: 'number',
        min: '1',
        max: '31',
        value: String(state.yearly.day),
        'aria-label': 'Yearly day',
      },
    });
    month.addEventListener('change', () => {
      if (state.yearly.type !== 'date') return;
      state.yearly = { ...state.yearly, month: Number(month.value) as Month };
      refresh();
    });
    day.addEventListener('input', () => {
      if (state.yearly.type !== 'date') return;
      state.yearly = { ...state.yearly, day: Number(day.value) };
      refresh();
    });
  };

  const render = (): void => {
    options.container.empty();
    const editor = options.container.createDiv({ cls: 'tc-recurrence-editor' });
    const heading = editor.createDiv({ cls: 'tc-recurrence-heading' });
    heading.createEl('span', { cls: 'tc-recurrence-title', text: 'Repeat' });
    const advanced = heading.createEl('button', {
      cls: `tc-recurrence-advanced${state.mode === 'advanced' ? ' is-selected' : ''}`,
      text: 'Advanced',
      attr: { type: 'button', 'aria-pressed': String(state.mode === 'advanced') },
    });
    advanced.addEventListener('click', () => {
      const parsed = parseState();
      if (parsed.type === 'valid') state.advancedRaw = parsed.raw;
      state.mode = 'advanced';
      state.preset = undefined;
      state.submissionError = undefined;
      render();
    });

    const presets = editor.createDiv({
      cls: 'tc-recurrence-presets',
      attr: { role: 'group', 'aria-label': 'Repeat presets' },
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
          'aria-pressed': String(state.mode === 'controls' && state.preset === preset),
        },
      });
      presetButton.addEventListener('click', () => setPreset(preset));
    }

    const controls = editor.createDiv({ cls: 'tc-recurrence-controls' });
    if (state.mode === 'advanced') {
      const raw = controls.createEl('input', {
        cls: 'tc-recurrence-raw',
        attr: {
          type: 'text',
          value: state.advancedRaw,
          'aria-label': 'Recurrence rule',
          spellcheck: 'false',
        },
      });
      raw.addEventListener('input', () => {
        state.advancedRaw = raw.value;
        state.submissionError = undefined;
        refresh();
      });
    } else {
      renderAdaptiveControls(controls);
    }

    const whenDone = editor.createEl('label', { cls: 'tc-recurrence-check-row' });
    const whenDoneInput = whenDone.createEl('input', {
      cls: 'tc-recurrence-when-done',
      attr: { type: 'checkbox' },
    });
    whenDoneInput.checked = state.whenDone;
    whenDone.createSpan({ text: 'Repeat from completion date' });
    whenDoneInput.addEventListener('change', () => {
      state.whenDone = whenDoneInput.checked;
      if (state.mode === 'advanced') {
        const parsed = parseRecurrenceRule(state.advancedRaw);
        const base =
          parsed.type === 'valid' ? parsed.canonical : withoutTerminalWhenDone(state.advancedRaw);
        state.advancedRaw = `${base}${state.whenDone ? ' when done' : ''}`;
        const raw = options.container.querySelector<HTMLInputElement>('.tc-recurrence-raw');
        if (raw) raw.value = state.advancedRaw;
      }
      state.submissionError = undefined;
      refresh();
    });

    const completedRow = editor.createEl('label', { cls: 'tc-recurrence-completed-row' });
    completedRow.createSpan({ text: 'Completed task' });
    const completed = completedRow.createEl('select', {
      attr: { 'aria-label': 'Completed task' },
    });
    addOption(completed, 'keep', 'Keep completed task', state.onCompletion === 'keep');
    addOption(completed, 'delete', 'Delete completed task', state.onCompletion === 'delete');
    completed.addEventListener('change', () => {
      state.onCompletion = completed.value as 'keep' | 'delete';
      refresh();
    });

    editor.createDiv({ cls: 'tc-recurrence-delete-warning', attr: { role: 'note' } });
    const preview = editor.createDiv({ cls: 'tc-recurrence-preview' });
    preview.createSpan({ cls: 'tc-recurrence-preview-label', text: 'Rule' });
    preview.createSpan({ cls: 'tc-recurrence-preview-rule' });
    editor.createDiv({
      cls: 'tc-recurrence-status',
      attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
    });

    const actions = editor.createDiv({ cls: 'tc-recurrence-actions' });
    if (existing !== undefined || task?.onCompletionExplicit) {
      const clearButton = actions.createEl('button', {
        cls: 'tc-recurrence-clear',
        text: 'Clear repeat',
        attr: { type: 'button' },
      });
      clearButton.addEventListener('click', () => void clear());
    }
    const spacer = actions.createSpan({ cls: 'tc-recurrence-actions-spacer' });
    spacer.setAttribute('aria-hidden', 'true');
    const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
    cancel.addEventListener('click', options.onClose);
    const save = actions.createEl('button', {
      cls: 'mod-cta tc-recurrence-save',
      text: 'Save repeat',
      attr: { type: 'button' },
    });
    save.addEventListener('click', () => void submit());
    refresh();
  };

  const keyHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onClose();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
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

  options.container.addEventListener('keydown', keyHandler);
  render();

  return {
    destroy: () => {
      options.container.removeEventListener('keydown', keyHandler);
      options.container.empty();
    },
    focus: () => {
      const focusTarget = options.container.querySelector<HTMLElement>(
        state.mode === 'advanced'
          ? '[aria-label="Recurrence rule"]'
          : '[aria-pressed="true"], [aria-label="Repeat interval"]',
      );
      focusTarget?.focus();
    },
  };
}

export function mountAnchoredRecurrenceEditor(
  options: AnchoredRecurrenceEditorOptions,
): RecurrenceEditorHandle {
  const ownerDocument = options.anchor.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const popover = ownerDocument.body.createDiv({
    cls: 'tc-popover tc-recurrence-popover tc-popover-anchored tc-recurrence-popover-floating',
  });
  let destroyed = false;
  let outsideTimer: number | undefined;
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
    if (!popover.contains(target) && !options.anchor.contains(target)) destroy();
  };
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (outsideTimer !== undefined) ownerWindow?.clearTimeout(outsideTimer);
    ownerDocument.removeEventListener('mousedown', onOutside, true);
    ownerDocument.removeEventListener('scroll', position, true);
    ownerWindow?.removeEventListener('resize', position);
    editor?.destroy();
    popover.remove();
    options.onClose?.();
  };

  editor = mountRecurrenceEditor({ ...options, container: popover, onClose: destroy });
  position();
  ownerDocument.addEventListener('scroll', position, true);
  ownerWindow?.addEventListener('resize', position);
  outsideTimer = ownerWindow?.setTimeout(() => {
    outsideTimer = undefined;
    if (!destroyed) ownerDocument.addEventListener('mousedown', onOutside, true);
  }, 0);
  ownerWindow?.setTimeout(() => editor?.focus(), 0);

  return { destroy, focus: () => editor?.focus() };
}
