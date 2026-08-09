import { shiftLocalDate } from './localDateMath';
import { parseRecurrenceRule, type RecurrenceIssueCode } from './recurrence';
import { parseTaskLineSourceModel, type TaskLineSourceCarrier } from './taskLineSourceModel';
import type { LocalDate, TaskPlanning } from './types';
import { formatDurationMinutes, localDate, localTime } from './validation';

export interface RecurrenceIterationInput {
  readonly rootBlock: string;
  readonly ownerRelativeLine: number;
  readonly nextPlanning: TaskPlanning;
  readonly dayDelta: number;
  readonly doneSymbol: string;
  readonly todoSymbol: string;
  readonly today: LocalDate;
  readonly addCreatedDate: boolean;
  readonly addCompletionDate: boolean;
}

export type RecurrenceIterationResult =
  | {
      readonly type: 'prepared';
      readonly cleanSubtree: string;
      readonly completedSubtree: string;
    }
  | { readonly type: 'invalid'; readonly code: RecurrenceIssueCode | 'invalid-task-syntax' };

type IterationIssueCode = RecurrenceIssueCode | 'invalid-task-syntax';
type DateCarrier = 'created' | 'start' | 'scheduled' | 'due' | 'completion' | 'cancelled';
type CarrierKind =
  | DateCarrier
  | 'time'
  | 'duration'
  | 'recurrence'
  | 'on-completion'
  | 'task-id'
  | 'depends-on'
  | 'block-id';

interface SourceRange {
  readonly from: number;
  readonly to: number;
}

interface Carrier extends SourceRange {
  readonly kind: CarrierKind;
  readonly value?: string | number;
}

interface SourceLine {
  readonly text: string;
  readonly ending: '' | '\n' | '\r\n';
}

interface ParsedIterationTaskLine {
  readonly original: string;
  readonly contentEnd: number;
  readonly statusSymbol: string;
  readonly statusAt: number;
  readonly carriers: readonly Carrier[];
}

export interface RecurrenceOwnedSubtree {
  readonly fromLine: number;
  readonly toLine: number;
  readonly taskLines: readonly number[];
}

export type RecurrenceTaskLineEdit =
  | {
      readonly type: 'clean-owner';
      readonly planning: TaskPlanning;
      readonly todoSymbol: string;
      readonly today: LocalDate;
      readonly addCreatedDate: boolean;
    }
  | {
      readonly type: 'clean-descendant';
      readonly dayDelta: number;
      readonly todoSymbol: string;
      readonly today: LocalDate;
      readonly addCreatedDate: boolean;
    }
  | {
      readonly type: 'complete-owner';
      readonly doneSymbol: string;
      readonly today: LocalDate;
      readonly addCompletionDate: boolean;
    };

export type RecurrenceTaskLineEditResult =
  | { readonly type: 'changed'; readonly content: string }
  | { readonly type: 'invalid'; readonly code: IterationIssueCode };

const TASK_RE = /^[\s>]*- \[(.)\]/u;
const PREFIX_RE = /^([\s>]*)/u;
const DATE_MARKERS: Readonly<Record<DateCarrier, string>> = {
  created: '➕',
  start: '🛫',
  scheduled: '⏳',
  due: '📅',
  completion: '✅',
  cancelled: '❌',
};
const INSERTION_RANK: Readonly<Record<CarrierKind, number>> = {
  time: 10,
  duration: 20,
  recurrence: 40,
  'on-completion': 45,
  created: 50,
  start: 60,
  scheduled: 70,
  due: 80,
  cancelled: 90,
  completion: 100,
  'task-id': 110,
  'depends-on': 120,
  'block-id': 130,
};

function sourceLines(content: string): SourceLine[] {
  if (content.length === 0) return [];
  const result: SourceLine[] = [];
  let from = 0;
  while (from < content.length) {
    const newline = content.indexOf('\n', from);
    if (newline < 0) {
      result.push({ text: content.slice(from), ending: '' });
      break;
    }
    const hasCrLf = newline > from && content[newline - 1] === '\r';
    result.push({
      text: content.slice(from, newline - (hasCrLf ? 1 : 0)),
      ending: hasCrLf ? '\r\n' : '\n',
    });
    from = newline + 1;
  }
  return result;
}

function indentation(line: string): number {
  const prefix = PREFIX_RE.exec(line)?.[1] ?? '';
  return prefix.replace(/>/gu, ' ').replace(/\t/gu, '    ').length;
}

function quoteDepth(line: string): number {
  return [...(PREFIX_RE.exec(line)?.[1] ?? '')].filter((character) => character === '>').length;
}

/** Shared ownership primitive used by TaskBlockEditor and the pure recurrence transformer. */
export function recurrenceOwnedSubtree(
  rootBlock: string,
  ownerRelativeLine: number,
): RecurrenceOwnedSubtree | undefined {
  const lines = sourceLines(rootBlock);
  const root = lines[0];
  const owner = lines[ownerRelativeLine];
  if (
    !root ||
    !owner ||
    !Number.isInteger(ownerRelativeLine) ||
    ownerRelativeLine < 0 ||
    !TASK_RE.test(root.text) ||
    !TASK_RE.test(owner.text)
  ) {
    return undefined;
  }

  const rootIndent = indentation(root.text);
  const rootQuote = quoteDepth(root.text);
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^[\s>]*$/u.test(line.text)) continue;
    if (quoteDepth(line.text) !== rootQuote || indentation(line.text) <= rootIndent)
      return undefined;
  }

  const ownerIndent = indentation(owner.text);
  const ownerQuote = quoteDepth(owner.text);
  let toLine = ownerRelativeLine;
  for (let index = ownerRelativeLine + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!/^[\s>]*$/u.test(line.text)) {
      if (quoteDepth(line.text) !== ownerQuote || indentation(line.text) <= ownerIndent) break;
      toLine = index;
    } else if (toLine >= ownerRelativeLine) {
      toLine = index;
    }
  }
  while (toLine > ownerRelativeLine && /^[\s>]*$/u.test(lines[toLine]!.text)) toLine--;

  const taskLines: number[] = [];
  for (let index = ownerRelativeLine; index <= toLine; index++) {
    if (TASK_RE.test(lines[index]!.text)) taskLines.push(index);
  }
  return { fromLine: ownerRelativeLine, toLine, taskLines };
}

/** Removes only a whitespace-delimited terminal Obsidian block ID. */
export function stripRecurrenceTerminalBlockId(line: string): string {
  // The brief requires this exact line-safe terminal-only expression.
  // eslint-disable-next-line sonarjs/super-linear-regex
  return line.replace(/\s+\^[A-Za-z0-9-]+(?=\r?$)/u, '');
}

function calendarDate(value: string): boolean {
  try {
    localDate(value);
    return true;
  } catch {
    return false;
  }
}

function lineEndingOf(original: string): SourceLine['ending'] {
  if (original.endsWith('\r\n')) return '\r\n';
  if (original.endsWith('\n')) return '\n';
  return '';
}

const CARRIER_KINDS = new Set<string>([
  ...Object.keys(DATE_MARKERS),
  'time',
  'duration',
  'recurrence',
  'on-completion',
  'task-id',
  'depends-on',
  'block-id',
]);

function isCarrier(candidate: TaskLineSourceCarrier): candidate is Carrier {
  return CARRIER_KINDS.has(candidate.kind);
}

function carrierIssue(carriers: readonly Carrier[]): IterationIssueCode | undefined {
  const uniqueKinds = [
    'created',
    'start',
    'scheduled',
    'due',
    'completion',
    'cancelled',
    'time',
    'duration',
    'recurrence',
    'on-completion',
  ] as const;
  for (const kind of uniqueKinds) {
    if (carriers.filter((carrier) => carrier.kind === kind).length > 1) {
      return kind === 'recurrence' ? 'nested-recurrence-conflict' : 'invalid-task-syntax';
    }
  }
  const start = carriers.find((carrier) => carrier.kind === 'start')?.value;
  const due = carriers.find((carrier) => carrier.kind === 'due')?.value;
  return typeof start === 'string' && typeof due === 'string' && start > due
    ? 'invalid-task-syntax'
    : undefined;
}

function parseIterationTaskLine(original: string):
  | { readonly type: 'valid'; readonly parsed: ParsedIterationTaskLine }
  | {
      readonly type: 'invalid';
      readonly code: IterationIssueCode;
    } {
  const model = parseTaskLineSourceModel(original);
  if (!model || model.carriers.some((carrier) => carrier.kind === 'malformed-known')) {
    return { type: 'invalid', code: 'invalid-task-syntax' };
  }
  const carriers = model.carriers.filter(isCarrier);

  for (const carrier of carriers) {
    if (carrier.kind in DATE_MARKERS) {
      if (typeof carrier.value !== 'string' || !calendarDate(carrier.value)) {
        return { type: 'invalid', code: 'invalid-task-syntax' };
      }
    }
    if (carrier.kind === 'time') {
      try {
        localTime(String(carrier.value));
      } catch {
        return { type: 'invalid', code: 'invalid-task-syntax' };
      }
    }
    if (
      carrier.kind === 'duration' &&
      (typeof carrier.value !== 'number' ||
        !Number.isSafeInteger(carrier.value) ||
        carrier.value <= 0)
    ) {
      return { type: 'invalid', code: 'invalid-task-syntax' };
    }
    if (carrier.kind === 'recurrence') {
      const recurrence = parseRecurrenceRule(String(carrier.value ?? ''));
      if (recurrence.type === 'invalid') return recurrence;
    }
  }

  const issue = carrierIssue(carriers);
  if (issue) return { type: 'invalid', code: issue };

  return {
    type: 'valid',
    parsed: {
      original,
      contentEnd: model.contentEnd,
      statusSymbol: model.statusSymbol,
      statusAt: model.statusAt,
      carriers,
    },
  };
}

function semanticRecurrenceMarkerCount(original: string): number {
  return (
    parseTaskLineSourceModel(original)?.carriers.filter(({ kind }) => kind === 'recurrence')
      .length ?? 0
  );
}

function removeSpan(source: string, span: SourceRange): string {
  let from = span.from;
  let to = span.to;
  if (source[from - 1] === ' ') from--;
  else if (source[to] === ' ') to++;
  return source.slice(0, from) + source.slice(to);
}

function applyCarrierChanges(
  parsed: ParsedIterationTaskLine,
  changes: Readonly<Partial<Record<CarrierKind, string | null>>>,
): string {
  let content = parsed.original;
  const replacements: Array<SourceRange & { readonly replacement: string | null }> = [];
  for (const [kind, replacement] of Object.entries(changes) as Array<
    [CarrierKind, string | null]
  >) {
    const carriers = parsed.carriers.filter((candidate) => candidate.kind === kind);
    carriers.forEach((carrier, index) => {
      replacements.push({ ...carrier, replacement: index === 0 ? replacement : null });
    });
  }
  const descendingReplacements = [...replacements];
  descendingReplacements.sort((left, right) => right.from - left.from);
  for (const change of descendingReplacements) {
    content =
      change.replacement === null
        ? removeSpan(content, change)
        : content.slice(0, change.from) + change.replacement + content.slice(change.to);
  }

  const missing = (Object.entries(changes) as Array<[CarrierKind, string | null]>)
    .filter(
      ([kind, replacement]) =>
        replacement !== null && !parsed.carriers.some((carrier) => carrier.kind === kind),
    )
    .sort(([left], [right]) => INSERTION_RANK[left] - INSERTION_RANK[right]);
  for (const [kind, token] of missing) {
    if (token === null) continue;
    const current = parseIterationTaskLine(content);
    if (current.type === 'invalid') return content;
    const later = current.parsed.carriers.find(
      (carrier) => INSERTION_RANK[carrier.kind] > INSERTION_RANK[kind],
    );
    const at = later?.from ?? current.parsed.contentEnd;
    const left = /\s/u.test(content[at - 1] ?? '') ? '' : ' ';
    const right = /\s/u.test(content[at] ?? '') || at === current.parsed.contentEnd ? '' : ' ';
    content = content.slice(0, at) + `${left}${token}${right}` + content.slice(at);
  }
  return content;
}

function shiftedDate(value: string | undefined, dayDelta: number): LocalDate | undefined | null {
  if (value === undefined) return undefined;
  const shifted = shiftLocalDate(localDate(value), dayDelta);
  return shifted ?? null;
}

function validPlanningDate(value: LocalDate | undefined): boolean {
  return value === undefined || calendarDate(value);
}

function cleanOwnerChanges(
  edit: Extract<RecurrenceTaskLineEdit, { readonly type: 'clean-owner' }>,
): Partial<Record<CarrierKind, string | null>> | undefined {
  if (
    !validPlanningDate(edit.planning.start) ||
    !validPlanningDate(edit.planning.scheduled) ||
    !validPlanningDate(edit.planning.due) ||
    (edit.planning.start !== undefined &&
      edit.planning.due !== undefined &&
      edit.planning.start > edit.planning.due)
  ) {
    return undefined;
  }
  if (edit.planning.time !== undefined) {
    try {
      localTime(edit.planning.time);
    } catch {
      return undefined;
    }
  }
  if (
    edit.planning.duration !== undefined &&
    (!Number.isSafeInteger(edit.planning.duration) || edit.planning.duration <= 0)
  ) {
    return undefined;
  }
  return {
    created: edit.addCreatedDate ? `➕ ${edit.today}` : null,
    start: edit.planning.start ? `🛫 ${edit.planning.start}` : null,
    scheduled: edit.planning.scheduled ? `⏳ ${edit.planning.scheduled}` : null,
    due: edit.planning.due ? `📅 ${edit.planning.due}` : null,
    completion: null,
    cancelled: null,
    time: edit.planning.time ? `⏰ ${edit.planning.time}` : null,
    duration:
      edit.planning.duration === undefined
        ? null
        : `⏱️ ${formatDurationMinutes(edit.planning.duration)}`,
    'task-id': null,
    'depends-on': null,
  };
}

type CarrierChangesResult =
  | {
      readonly type: 'valid';
      readonly changes: Partial<Record<CarrierKind, string | null>>;
    }
  | { readonly type: 'invalid'; readonly code: IterationIssueCode };

function descendantChanges(
  parsed: ParsedIterationTaskLine,
  edit: Extract<RecurrenceTaskLineEdit, { readonly type: 'clean-descendant' }>,
): CarrierChangesResult {
  if (!Number.isSafeInteger(edit.dayDelta)) {
    return { type: 'invalid', code: 'invalid-descendant-date' };
  }
  const changes: Partial<Record<CarrierKind, string | null>> = {
    created: edit.addCreatedDate ? `➕ ${edit.today}` : null,
    completion: null,
    cancelled: null,
    'task-id': null,
    'depends-on': null,
  };
  for (const kind of ['start', 'scheduled', 'due'] as const) {
    const carrier = parsed.carriers.find((candidate) => candidate.kind === kind);
    const shifted = shiftedDate(
      typeof carrier?.value === 'string' ? carrier.value : undefined,
      edit.dayDelta,
    );
    if (shifted === null) return { type: 'invalid', code: 'invalid-descendant-date' };
    if (shifted !== undefined) changes[kind] = `${DATE_MARKERS[kind]} ${shifted}`;
  }
  return { type: 'valid', changes };
}

function changesForEdit(
  parsed: ParsedIterationTaskLine,
  edit: RecurrenceTaskLineEdit,
): CarrierChangesResult {
  if (edit.type === 'clean-owner') {
    const changes = cleanOwnerChanges(edit);
    return changes
      ? { type: 'valid', changes }
      : { type: 'invalid', code: 'invalid-descendant-date' };
  }
  if (edit.type === 'complete-owner') {
    const sameDoneStatus =
      parsed.statusSymbol === edit.doneSymbol ||
      (parsed.statusSymbol.toLowerCase() === 'x' && edit.doneSymbol.toLowerCase() === 'x');
    return {
      type: 'valid',
      changes: {
        ...(!sameDoneStatus && {
          completion: edit.addCompletionDate ? `✅ ${edit.today}` : null,
        }),
        cancelled: null,
      },
    };
  }
  return descendantChanges(parsed, edit);
}

/** Shared lossless task-line mutation primitive used by TaskMarkdownCodec and this transformer. */
export function editRecurrenceIterationTaskLine(
  original: string,
  edit: RecurrenceTaskLineEdit,
): RecurrenceTaskLineEditResult {
  const parsedResult = parseIterationTaskLine(original);
  if (parsedResult.type === 'invalid') return parsedResult;
  const parsed = parsedResult.parsed;
  const status = edit.type === 'complete-owner' ? edit.doneSymbol : edit.todoSymbol;
  if (status.length !== 1 || /[\r\n\]]/u.test(status)) {
    return { type: 'invalid', code: 'invalid-task-syntax' };
  }

  const changes = changesForEdit(parsed, edit);
  if (changes.type === 'invalid') return changes;

  let content = applyCarrierChanges(parsed, changes.changes);
  content = content.slice(0, parsed.statusAt) + status + content.slice(parsed.statusAt + 1);
  if (edit.type !== 'complete-owner') {
    const ending = lineEndingOf(content);
    content =
      stripRecurrenceTerminalBlockId(content.slice(0, content.length - ending.length)) + ending;
  }
  const validated = parseIterationTaskLine(content);
  return validated.type === 'invalid' ? validated : { type: 'changed', content };
}

function serializeSubtree(lines: readonly SourceLine[], from: number, to: number): string {
  return lines
    .slice(from, to + 1)
    .map((line, index, selected) => line.text + (index === selected.length - 1 ? '' : line.ending))
    .join('');
}

function invalid(code: IterationIssueCode): RecurrenceIterationResult {
  return { type: 'invalid', code };
}

export function prepareRecurrenceIteration(
  input: RecurrenceIterationInput,
): RecurrenceIterationResult {
  const lines = sourceLines(input.rootBlock);
  const ownership = recurrenceOwnedSubtree(input.rootBlock, input.ownerRelativeLine);
  if (!ownership || !calendarDate(input.today)) return invalid('invalid-task-syntax');
  if (!Number.isSafeInteger(input.dayDelta)) return invalid('invalid-descendant-date');
  const recurrenceMarkersByLine = lines.map((line) =>
    semanticRecurrenceMarkerCount(line.text + line.ending),
  );
  const recurrenceMarkerCount = recurrenceMarkersByLine.reduce((sum, count) => sum + count, 0);
  if (recurrenceMarkerCount !== 1 || recurrenceMarkersByLine[ownership.fromLine] !== 1) {
    return invalid('nested-recurrence-conflict');
  }

  for (let index = 0; index < lines.length; index++) {
    const original = lines[index]!.text + lines[index]!.ending;
    if (!TASK_RE.test(lines[index]!.text)) continue;
    const parsed = parseIterationTaskLine(original);
    if (parsed.type === 'invalid') return invalid(parsed.code);
  }

  const completedLines = lines.map((line) => ({ ...line }));
  const completedOwner = editRecurrenceIterationTaskLine(
    completedLines[ownership.fromLine]!.text + completedLines[ownership.fromLine]!.ending,
    {
      type: 'complete-owner',
      doneSymbol: input.doneSymbol,
      today: input.today,
      addCompletionDate: input.addCompletionDate,
    },
  );
  if (completedOwner.type === 'invalid') return invalid(completedOwner.code);
  const completedSource = sourceLines(completedOwner.content)[0];
  if (!completedSource) return invalid('invalid-task-syntax');
  completedLines[ownership.fromLine] = completedSource;

  const cleanLines = lines.map((line) => ({ ...line }));
  for (const taskLine of ownership.taskLines) {
    const source = cleanLines[taskLine]!;
    const edited = editRecurrenceIterationTaskLine(source.text + source.ending, {
      ...(taskLine === ownership.fromLine
        ? {
            type: 'clean-owner' as const,
            planning: input.nextPlanning,
          }
        : {
            type: 'clean-descendant' as const,
            dayDelta: input.dayDelta,
          }),
      todoSymbol: input.todoSymbol,
      today: input.today,
      addCreatedDate: input.addCreatedDate,
    });
    if (edited.type === 'invalid') return invalid(edited.code);
    const editedSource = sourceLines(edited.content)[0];
    if (!editedSource) return invalid('invalid-task-syntax');
    cleanLines[taskLine] = editedSource;
  }
  for (let index = ownership.fromLine; index <= ownership.toLine; index++) {
    const source = cleanLines[index]!;
    cleanLines[index] = { ...source, text: stripRecurrenceTerminalBlockId(source.text) };
  }

  return {
    type: 'prepared',
    cleanSubtree: serializeSubtree(cleanLines, ownership.fromLine, ownership.toLine),
    completedSubtree: serializeSubtree(completedLines, ownership.fromLine, ownership.toLine),
  };
}
