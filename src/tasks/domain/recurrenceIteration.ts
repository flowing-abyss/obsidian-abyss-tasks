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

function blankSourceLine(line: SourceLine): boolean {
  return /^[\s>]*$/u.test(line.text);
}

function rootBlockStructureIsValid(lines: readonly SourceLine[], root: SourceLine): boolean {
  const rootIndent = indentation(root.text);
  const rootQuote = quoteDepth(root.text);
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) return false;
    if (blankSourceLine(line)) continue;
    if (quoteDepth(line.text) !== rootQuote || indentation(line.text) <= rootIndent) return false;
  }
  return true;
}

function withinOwner(line: SourceLine, ownerIndent: number, ownerQuote: number): boolean {
  return (
    blankSourceLine(line) ||
    (quoteDepth(line.text) === ownerQuote && indentation(line.text) > ownerIndent)
  );
}

function trimTrailingBlankLines(
  lines: readonly SourceLine[],
  fromLine: number,
  toLine: number,
): number {
  let trimmed = toLine;
  while (trimmed > fromLine && blankSourceLine(lines[trimmed] ?? { text: '', ending: '' })) {
    trimmed--;
  }
  return trimmed;
}

function ownedSubtreeEnd(
  lines: readonly SourceLine[],
  ownerRelativeLine: number,
  owner: SourceLine,
): number | undefined {
  const ownerIndent = indentation(owner.text);
  const ownerQuote = quoteDepth(owner.text);
  let toLine = ownerRelativeLine;
  for (let index = ownerRelativeLine + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) return undefined;
    if (!withinOwner(line, ownerIndent, ownerQuote)) break;
    toLine = index;
  }
  return trimTrailingBlankLines(lines, ownerRelativeLine, toLine);
}

function ownedTaskLines(
  lines: readonly SourceLine[],
  fromLine: number,
  toLine: number,
): number[] | undefined {
  const taskLines: number[] = [];
  for (let index = fromLine; index <= toLine; index++) {
    const line = lines[index];
    if (line === undefined) return undefined;
    if (TASK_RE.test(line.text)) taskLines.push(index);
  }
  return taskLines;
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
    root == null ||
    owner == null ||
    !Number.isInteger(ownerRelativeLine) ||
    ownerRelativeLine < 0 ||
    !TASK_RE.test(root.text) ||
    !TASK_RE.test(owner.text)
  ) {
    return undefined;
  }
  if (!rootBlockStructureIsValid(lines, root)) return undefined;
  const toLine = ownedSubtreeEnd(lines, ownerRelativeLine, owner);
  if (toLine === undefined) return undefined;
  const taskLines = ownedTaskLines(lines, ownerRelativeLine, toLine);
  if (taskLines === undefined) return undefined;
  return { fromLine: ownerRelativeLine, toLine, taskLines };
}

/** Removes only a whitespace-delimited terminal Obsidian block ID. */
export function stripRecurrenceTerminalBlockId(line: string): string {
  // The brief requires this exact line-safe terminal-only expression.
  // eslint-disable-next-line sonarjs/super-linear-regex -- terminal-only bounded line grammar
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

function validCarrierTime(value: Carrier['value']): boolean {
  try {
    localTime(String(value));
    return true;
  } catch {
    return false;
  }
}

function dateCarrierIssue(value: Carrier['value']): IterationIssueCode | undefined {
  return typeof value === 'string' && calendarDate(value) ? undefined : 'invalid-task-syntax';
}

function durationCarrierIssue(value: Carrier['value']): IterationIssueCode | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? undefined
    : 'invalid-task-syntax';
}

function recurrenceCarrierIssue(value: Carrier['value']): IterationIssueCode | undefined {
  const recurrence = parseRecurrenceRule(String(value ?? ''));
  return recurrence.type === 'invalid' ? recurrence.code : undefined;
}

function carrierValueIssue(carrier: Carrier): IterationIssueCode | undefined {
  if (carrier.kind in DATE_MARKERS) return dateCarrierIssue(carrier.value);
  if (carrier.kind === 'time')
    return validCarrierTime(carrier.value) ? undefined : 'invalid-task-syntax';
  if (carrier.kind === 'duration') return durationCarrierIssue(carrier.value);
  return carrier.kind === 'recurrence' ? recurrenceCarrierIssue(carrier.value) : undefined;
}

function parseIterationTaskLine(original: string):
  | { readonly type: 'valid'; readonly parsed: ParsedIterationTaskLine }
  | {
      readonly type: 'invalid';
      readonly code: IterationIssueCode;
    } {
  const model = parseTaskLineSourceModel(original);
  if (model == null || model.carriers.some((carrier) => carrier.kind === 'malformed-known')) {
    return { type: 'invalid', code: 'invalid-task-syntax' };
  }
  const carriers = model.carriers.filter(isCarrier);
  for (const carrier of carriers) {
    const issue = carrierValueIssue(carrier);
    if (issue !== undefined) return { type: 'invalid', code: issue };
  }
  const issue = carrierIssue(carriers);
  if (issue !== undefined) return { type: 'invalid', code: issue };

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

export function recurrenceMarkerCountInOwnedSubtree(
  rootBlock: string,
  ownerRelativeLine: number,
): number | undefined {
  const ownership = recurrenceOwnedSubtree(rootBlock, ownerRelativeLine);
  if (ownership == null) return undefined;
  const lines = sourceLines(rootBlock);
  let count = 0;
  for (const lineIndex of ownership.taskLines) {
    const line = lines[lineIndex];
    if (line === undefined) return undefined;
    count += semanticRecurrenceMarkerCount(line.text + line.ending);
  }
  return count;
}

function removeSpan(source: string, span: SourceRange): string {
  let from = span.from;
  let to = span.to;
  if (source[from - 1] === ' ') from--;
  else if (source[to] === ' ') to++;
  return source.slice(0, from) + source.slice(to);
}

type CarrierChanges = Readonly<Partial<Record<CarrierKind, string | null>>>;
type CarrierReplacement = SourceRange & { readonly replacement: string | null };

function carrierReplacements(
  parsed: ParsedIterationTaskLine,
  changes: CarrierChanges,
): CarrierReplacement[] {
  const replacements: CarrierReplacement[] = [];
  for (const [kind, replacement] of Object.entries(changes) as Array<
    [CarrierKind, string | null]
  >) {
    const carriers = parsed.carriers.filter((candidate) => candidate.kind === kind);
    carriers.forEach((carrier, index) => {
      replacements.push({ ...carrier, replacement: index === 0 ? replacement : null });
    });
  }
  return replacements.sort((left, right) => right.from - left.from);
}

function applyCarrierReplacements(
  content: string,
  replacements: readonly CarrierReplacement[],
): string {
  let updated = content;
  for (const change of replacements) {
    updated =
      change.replacement === null
        ? removeSpan(updated, change)
        : updated.slice(0, change.from) + change.replacement + updated.slice(change.to);
  }
  return updated;
}

function missingCarriers(
  parsed: ParsedIterationTaskLine,
  changes: CarrierChanges,
): Array<[CarrierKind, string | null]> {
  return (Object.entries(changes) as Array<[CarrierKind, string | null]>)
    .filter(
      ([kind, replacement]) =>
        replacement !== null && !parsed.carriers.some((carrier) => carrier.kind === kind),
    )
    .sort(([left], [right]) => INSERTION_RANK[left] - INSERTION_RANK[right]);
}

function insertMissingCarrier(
  content: string,
  kind: CarrierKind,
  token: string,
): string | undefined {
  const current = parseIterationTaskLine(content);
  if (current.type === 'invalid') return undefined;
  const later = current.parsed.carriers.find(
    (carrier) => INSERTION_RANK[carrier.kind] > INSERTION_RANK[kind],
  );
  const at = later?.from ?? current.parsed.contentEnd;
  const left = /\s/u.test(content[at - 1] ?? '') ? '' : ' ';
  const right = /\s/u.test(content[at] ?? '') || at === current.parsed.contentEnd ? '' : ' ';
  return `${content.slice(0, at)}${left}${token}${right}${content.slice(at)}`;
}

function insertMissingCarriers(
  content: string,
  missing: ReadonlyArray<readonly [CarrierKind, string | null]>,
): string {
  let updated = content;
  for (const [kind, token] of missing) {
    if (token === null) continue;
    const inserted = insertMissingCarrier(updated, kind, token);
    if (inserted === undefined) return updated;
    updated = inserted;
  }
  return updated;
}

function applyCarrierChanges(parsed: ParsedIterationTaskLine, changes: CarrierChanges): string {
  const content = applyCarrierReplacements(parsed.original, carrierReplacements(parsed, changes));
  return insertMissingCarriers(content, missingCarriers(parsed, changes));
}

function shiftedDate(value: string | undefined, dayDelta: number): LocalDate | undefined | null {
  if (value === undefined) return undefined;
  const shifted = shiftLocalDate(localDate(value), dayDelta);
  return shifted ?? null;
}

function validPlanningDate(value: LocalDate | undefined): boolean {
  return value === undefined || calendarDate(value);
}

function validPlanningTime(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    localTime(value);
    return true;
  } catch {
    return false;
  }
}

function validPlanningDuration(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function validOwnerPlanning(planning: TaskPlanning): boolean {
  if (!validPlanningDate(planning.start)) return false;
  if (!validPlanningDate(planning.scheduled)) return false;
  if (!validPlanningDate(planning.due)) return false;
  if (planning.start !== undefined && planning.due !== undefined && planning.start > planning.due) {
    return false;
  }
  return validPlanningTime(planning.time) && validPlanningDuration(planning.duration);
}

function cleanOwnerChanges(
  edit: Extract<RecurrenceTaskLineEdit, { readonly type: 'clean-owner' }>,
): Partial<Record<CarrierKind, string | null>> | undefined {
  if (!validOwnerPlanning(edit.planning)) return undefined;
  return {
    created: edit.addCreatedDate ? `➕ ${edit.today}` : null,
    start: edit.planning.start != null ? `🛫 ${edit.planning.start}` : null,
    scheduled: edit.planning.scheduled != null ? `⏳ ${edit.planning.scheduled}` : null,
    due: edit.planning.due != null ? `📅 ${edit.planning.due}` : null,
    completion: null,
    cancelled: null,
    time: edit.planning.time != null ? `⏰ ${edit.planning.time}` : null,
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
    return changes != null
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

type IterationLinesResult =
  | { readonly type: 'valid'; readonly lines: SourceLine[] }
  | { readonly type: 'invalid'; readonly code: IterationIssueCode };

function recurrenceStructureIssue(
  lines: readonly SourceLine[],
  ownership: RecurrenceOwnedSubtree,
): IterationIssueCode | undefined {
  const counts = lines.map((line) => semanticRecurrenceMarkerCount(line.text + line.ending));
  const total = counts.reduce((sum, count) => sum + count, 0);
  return total === 1 && counts[ownership.fromLine] === 1 ? undefined : 'nested-recurrence-conflict';
}

function iterationLinesIssue(lines: readonly SourceLine[]): IterationIssueCode | undefined {
  for (const line of lines) {
    if (!TASK_RE.test(line.text)) continue;
    const parsed = parseIterationTaskLine(line.text + line.ending);
    if (parsed.type === 'invalid') return parsed.code;
  }
  return undefined;
}

function completedIterationLines(
  lines: readonly SourceLine[],
  ownership: RecurrenceOwnedSubtree,
  input: RecurrenceIterationInput,
): IterationLinesResult {
  const completedLines = lines.map((line) => ({ ...line }));
  const source = completedLines[ownership.fromLine];
  if (source === undefined) return { type: 'invalid', code: 'invalid-task-syntax' };
  const completed = editRecurrenceIterationTaskLine(source.text + source.ending, {
    type: 'complete-owner',
    doneSymbol: input.doneSymbol,
    today: input.today,
    addCompletionDate: input.addCompletionDate,
  });
  if (completed.type === 'invalid') return completed;
  const updated = sourceLines(completed.content)[0];
  if (updated == null) return { type: 'invalid', code: 'invalid-task-syntax' };
  completedLines[ownership.fromLine] = updated;
  return { type: 'valid', lines: completedLines };
}

function cleanLineEdit(
  taskLine: number,
  ownership: RecurrenceOwnedSubtree,
  input: RecurrenceIterationInput,
): RecurrenceTaskLineEdit {
  const common = {
    todoSymbol: input.todoSymbol,
    today: input.today,
    addCreatedDate: input.addCreatedDate,
  };
  return taskLine === ownership.fromLine
    ? { type: 'clean-owner', planning: input.nextPlanning, ...common }
    : { type: 'clean-descendant', dayDelta: input.dayDelta, ...common };
}

function cleanIterationLines(
  lines: readonly SourceLine[],
  ownership: RecurrenceOwnedSubtree,
  input: RecurrenceIterationInput,
): IterationLinesResult {
  const cleanLines = lines.map((line) => ({ ...line }));
  for (const taskLine of ownership.taskLines) {
    const source = cleanLines[taskLine];
    if (source === undefined) return { type: 'invalid', code: 'invalid-task-syntax' };
    const edited = editRecurrenceIterationTaskLine(
      source.text + source.ending,
      cleanLineEdit(taskLine, ownership, input),
    );
    if (edited.type === 'invalid') return edited;
    const updated = sourceLines(edited.content)[0];
    if (updated == null) return { type: 'invalid', code: 'invalid-task-syntax' };
    cleanLines[taskLine] = updated;
  }
  if (!stripOwnedBlockIds(cleanLines, ownership)) {
    return { type: 'invalid', code: 'invalid-task-syntax' };
  }
  return { type: 'valid', lines: cleanLines };
}

function stripOwnedBlockIds(lines: SourceLine[], ownership: RecurrenceOwnedSubtree): boolean {
  for (let index = ownership.fromLine; index <= ownership.toLine; index++) {
    const source = lines[index];
    if (source === undefined) return false;
    lines[index] = { ...source, text: stripRecurrenceTerminalBlockId(source.text) };
  }
  return true;
}

export function prepareRecurrenceIteration(
  input: RecurrenceIterationInput,
): RecurrenceIterationResult {
  const lines = sourceLines(input.rootBlock);
  const ownership = recurrenceOwnedSubtree(input.rootBlock, input.ownerRelativeLine);
  if (ownership == null || !calendarDate(input.today)) return invalid('invalid-task-syntax');
  if (!Number.isSafeInteger(input.dayDelta)) return invalid('invalid-descendant-date');
  const issue = recurrenceStructureIssue(lines, ownership) ?? iterationLinesIssue(lines);
  if (issue !== undefined) return invalid(issue);
  const completed = completedIterationLines(lines, ownership, input);
  if (completed.type === 'invalid') return invalid(completed.code);
  const clean = cleanIterationLines(lines, ownership, input);
  if (clean.type === 'invalid') return invalid(clean.code);
  return {
    type: 'prepared',
    cleanSubtree: serializeSubtree(clean.lines, ownership.fromLine, ownership.toLine),
    completedSubtree: serializeSubtree(completed.lines, ownership.fromLine, ownership.toLine),
  };
}
