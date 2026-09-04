import { setIcon } from 'obsidian';
import { parseRecurrenceRule, type RecurrenceParseResult } from '../../tasks';

export interface RecurrenceBadgeInput {
  readonly rule: string;
  readonly validity: 'valid' | 'invalid';
  readonly reason?: string;
  readonly forecast?: boolean;
}

export function recurrenceIssueText(
  code: Extract<RecurrenceParseResult, { type: 'invalid' }>['code'],
): string {
  if (code === 'must-start-with-every') return 'Start the rule with “every”.';
  if (code === 'unsupported-recurrence-count')
    return 'Repeating a fixed number of times is not supported.';
  if (code === 'unsupported-recurrence-until') return 'Repeating until a date is not supported.';
  if (code === 'invalid-when-done') return 'Put “when done” once, at the end of the rule.';
  if (code === 'recurrence-date-required') return 'Add a date before setting a repeat.';
  if (code === 'nested-recurrence-conflict') return 'Remove the nested repeat conflict first.';
  if (code === 'invalid-descendant-date') return 'A repeated sub-task has an invalid date.';
  if (code === 'forecast-limit-reached') return 'The repeat forecast limit was reached.';
  return 'Enter a supported repeat rule.';
}

export function recurrenceBadgeInput(rule: string, forecast = false): RecurrenceBadgeInput {
  const parsed = parseRecurrenceRule(rule);
  if (parsed.type === 'valid') {
    return { rule, validity: 'valid', ...(forecast && { forecast: true }) };
  }
  return {
    rule,
    validity: 'invalid',
    reason: recurrenceIssueText(parsed.code),
    ...(forecast && { forecast: true }),
  };
}

export function renderRecurrenceBadge(
  container: HTMLElement,
  input: RecurrenceBadgeInput,
): HTMLElement {
  const tooltip =
    input.validity === 'invalid'
      ? `Invalid repeat rule: ${input.reason ?? 'Enter a supported repeat rule.'}`
      : `Repeats: ${input.rule}`;
  const badge = container.createSpan({
    cls: 'abyss-recurrence-badge',
    attr: {
      title: tooltip,
      'aria-label': tooltip,
      'data-recurrence-validity': input.validity,
      ...((input.forecast ?? false) && { 'data-recurrence-forecast': 'true' }),
    },
  });
  const icon = badge.createSpan({
    cls: 'abyss-recurrence-badge-icon',
    attr: { 'aria-hidden': 'true', 'data-icon': 'repeat-2' },
  });
  setIcon(icon, 'repeat-2');
  return badge;
}
