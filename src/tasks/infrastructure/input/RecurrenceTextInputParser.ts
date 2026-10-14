import type { RecurrenceInputParser } from '../../application/RecurrenceInputParser';
import {
  parseRecurrenceRule,
  recurrenceLabel,
  type RecurrenceParseResult,
} from '../../domain/recurrence';
import type {
  RecurrenceInputExtraction,
  TaskInputRecurrenceCandidate,
} from '../../domain/recurrenceInputTypes';
import {
  inputRangesOverlap,
  inputTextBarriers,
  maskInputRanges,
  validInputRange,
} from '../../domain/taskInputGuards';
import type { TaskInputRange } from '../../domain/taskInputTypes';
import { englishRecurrenceInput } from './recurrence/englishRecurrenceInput';
import {
  normalizeRecurrencePhrase,
  type RecurrenceInputLocale,
} from './recurrence/RecurrenceInputLocale';
import { russianRecurrenceInput } from './recurrence/russianRecurrenceInput';

const MAX_UNITS = 512;
const MAX_TOKENS = 80;
const DEFAULT_LOCALES = [englishRecurrenceInput, russianRecurrenceInput] as const;

interface ExtractionContext {
  readonly text: string;
  readonly masked: string;
  readonly barriers: readonly TaskInputRange[];
  readonly locales: readonly RecurrenceInputLocale[];
}
interface PhraseMatch {
  readonly to: number;
  readonly rule: string;
}
const VOID_HTML = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
/** Only already-protected tag atoms can establish an opaque HTML element. */
function htmlElementBarriers(text: string, atoms: readonly TaskInputRange[]): TaskInputRange[] {
  const result: TaskInputRange[] = [];
  const stack: Array<{ name: string; from: number }> = [];
  for (const atom of atoms) {
    const source = text.slice(atom.from, atom.to);
    const tag = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])/iu.exec(source);
    if (tag === null || !source.endsWith('>')) continue;
    const name = (tag[2] ?? '').toLowerCase();
    if (VOID_HTML.has(name) || source.endsWith('/>')) continue;
    if (tag[1] !== '/') {
      stack.push({ name, from: atom.from });
      continue;
    }
    const matching = stack.map((opening) => opening.name).lastIndexOf(name);
    const opening = stack[matching];
    if (opening === undefined) continue;
    result.push({ from: opening.from, to: atom.to });
    stack.splice(matching);
  }
  for (const opening of stack) result.push({ from: opening.from, to: text.length });
  return result;
}
function withinBudget(text: string): boolean {
  return text.length <= MAX_UNITS && [...text.matchAll(/[\p{L}\p{N}_]+/gu)].length <= MAX_TOKENS;
}
function abbreviationPeriod(
  text: string,
  index: number,
  abbreviations: ReadonlySet<string>,
  lookback: number,
): boolean {
  const prefix = text.slice(Math.max(0, index - lookback), index);
  const word = /(?:^|[^\p{L}\p{N}_])(\p{L}+)$/u.exec(prefix)?.[1];
  return word !== undefined && abbreviations.has(word.toLowerCase());
}
function clauses(text: string, locales: readonly RecurrenceInputLocale[]): TaskInputRange[] {
  const abbreviations = new Set(
    locales
      .flatMap((locale) => locale.weekdayAbbreviations ?? [])
      .map((word) => word.toLowerCase()),
  );
  const lookback = Math.max(0, ...[...abbreviations].map((word) => word.length)) + 1;
  const ranges: TaskInputRange[] = [];
  let from = 0;
  for (const separator of text.matchAll(/[;!?\r\n]|\.(?=\s|$)/gu)) {
    if (separator[0] === '.' && abbreviationPeriod(text, separator.index, abbreviations, lookback))
      continue;
    if (separator.index > from) ranges.push({ from, to: separator.index });
    from = separator.index + separator[0].length;
  }
  if (from < text.length) ranges.push({ from, to: text.length });
  return ranges;
}
function translatedRule(phrase: string, locale: RecurrenceInputLocale): string | undefined {
  const english = locale.toEnglish(phrase);
  if (english === undefined) return undefined;
  const parsed = parseRecurrenceRule(english);
  return parsed.type === 'valid' ? recurrenceLabel(english) : undefined;
}
function longestPhrase(
  context: ExtractionContext,
  from: number,
  to: number,
  locale: RecurrenceInputLocale,
): PhraseMatch | undefined {
  let longest: PhraseMatch | undefined;
  const atom = context.barriers.find((range) => range.from >= from && range.from < to);
  const limit = atom?.from ?? to;
  const source = context.text.slice(from, limit);
  let tokens = 0;
  for (const word of source.matchAll(/[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu)) {
    tokens++;
    const end = from + word.index + word[0].length;
    const phrase = normalizeRecurrencePhrase(context.text.slice(from, end));
    if (tokens > MAX_TOKENS || phrase.length > MAX_UNITS) break;
    const rule = translatedRule(phrase, locale);
    if (rule !== undefined) longest = { to: end, rule };
  }
  return longest;
}
/** Inspect punctuation and atoms without adding them to recurrence removal ranges. */
function continuationStart(context: ExtractionContext, from: number, to: number): number {
  let cursor = from;
  while (cursor < to) {
    const atom = context.barriers.find((range) => range.from <= cursor && cursor < range.to);
    if (atom !== undefined) {
      cursor = atom.to;
      continue;
    }
    const spacedHyphen =
      context.text[cursor] === '-' &&
      /[^\S\r\n]/u.test(context.text[cursor - 1] ?? '') &&
      /[^\S\r\n]/u.test(context.text[cursor + 1] ?? '');
    if (!spacedHyphen && !/[\s,()[\]{}:—–]/u.test(context.text[cursor] ?? '')) break;
    cursor++;
  }
  return cursor;
}
function validClock(clock: RegExpExecArray): boolean {
  if (clock[2] === undefined && clock[3] === undefined) return false;
  const hour = Number(clock[1]),
    minute = Number(clock[2] ?? '0');
  if (minute > 59) return false;
  return clock[3] === undefined ? hour <= 23 : hour >= 1 && hour <= 12;
}
function clockLength(source: string, cue: string): number | undefined {
  const head = /^(\p{L}+)[^\S\r\n]+/u.exec(source);
  if (head === null || head[1]?.toLowerCase() !== cue) return undefined;
  const clock = /^(\d{1,2})(?::(\d{2}))?(?:[^\S\r\n]?([ap]m))?(?![\p{L}\p{N}_:./+-])/iu.exec(
    source.slice(head[0].length),
  );
  if (clock === null || !validClock(clock)) return undefined;
  return head[0].length + clock[0].length;
}
function unsupportedTail(context: ExtractionContext, from: number, to: number): boolean {
  const cursor = continuationStart(context, from, to);
  const source = context.text.slice(cursor, to);
  const tail = normalizeRecurrencePhrase(source);
  if (tail.length === 0) return false;
  for (const locale of context.locales) {
    for (const cue of locale.clockCues) {
      const length = clockLength(source, cue);
      if (length !== undefined) {
        const restFrom = continuationStart(context, cursor + length, to);
        const rest = normalizeRecurrencePhrase(context.text.slice(restFrom, to));
        return (
          /^[-–—\d:./+]/u.test(rest) || context.locales.some((entry) => entry.isContinuation(rest))
        );
      }
    }
  }
  return context.locales.some((locale) => locale.isContinuation(tail));
}
function sourceProtection(text: string, from: number, to: number): TaskInputRange {
  return { from, to: from + text.slice(from, to).trimEnd().length };
}

interface RecurrenceCue {
  readonly from: number;
  readonly locale: RecurrenceInputLocale;
}
interface ExtractionScan {
  index: number;
  expressions: number;
  readonly candidates: TaskInputRecurrenceCandidate[];
  readonly protectedRanges: TaskInputRange[];
}
function leadingRestricted(
  context: ExtractionContext,
  clause: TaskInputRange,
  cue: RecurrenceCue,
): boolean {
  const prefix = normalizeRecurrencePhrase(context.masked.slice(clause.from, cue.from));
  return context.locales.some((locale) => locale.hasLeadingRestriction(prefix));
}
function unsupportedProtection(
  context: ExtractionContext,
  clause: TaskInputRange,
  cue: RecurrenceCue,
): TaskInputRange {
  const start = leadingRestricted(context, clause, cue) ? clause.from : cue.from;
  const from = start + context.text.slice(start, clause.to).search(/\S/u);
  return sourceProtection(context.text, from, clause.to);
}
function candidateAt(
  context: ExtractionContext,
  clause: TaskInputRange,
  cue: RecurrenceCue,
): TaskInputRecurrenceCandidate | undefined {
  const match = longestPhrase(context, cue.from, clause.to, cue.locale);
  if (match === undefined) return undefined;
  if (leadingRestricted(context, clause, cue)) return undefined;
  if (unsupportedTail(context, match.to, clause.to)) return undefined;
  const range = { from: cue.from, to: match.to };
  if (context.barriers.some((barrier) => inputRangesOverlap(range, barrier))) return undefined;
  return { ranges: [range], rule: match.rule };
}
function scanCue(
  context: ExtractionContext,
  clause: TaskInputRange,
  cue: RecurrenceCue,
  scan: ExtractionScan,
): void {
  if (
    cue.from < clause.from ||
    scan.protectedRanges.some((range) => range.from <= cue.from && cue.from < range.to)
  )
    return;
  const candidate = candidateAt(context, clause, cue);
  const range = candidate?.ranges[0] ?? unsupportedProtection(context, clause, cue);
  if (!validInputRange(context.text, range)) return;
  scan.protectedRanges.push(range);
  scan.expressions++;
  if (candidate !== undefined) scan.candidates.push(candidate);
}
function scanClause(
  context: ExtractionContext,
  clause: TaskInputRange,
  cues: readonly RecurrenceCue[],
  scan: ExtractionScan,
): void {
  while (scan.index < cues.length && (cues[scan.index]?.from ?? Infinity) < clause.to) {
    const cue = cues[scan.index++];
    if (cue !== undefined) scanCue(context, clause, cue, scan);
  }
}

export class RecurrenceTextInputParser implements RecurrenceInputParser {
  constructor(private readonly locales: readonly RecurrenceInputLocale[] = DEFAULT_LOCALES) {}

  parse(text: string): RecurrenceParseResult {
    const existing = parseRecurrenceRule(text);
    if (existing.type === 'valid') return existing;
    const phrase = normalizeRecurrencePhrase(text);
    if (!withinBudget(phrase)) return existing;
    for (const locale of this.locales) {
      const rule = translatedRule(phrase, locale);
      if (rule !== undefined) return parseRecurrenceRule(rule);
    }
    return existing;
  }

  extract(request: {
    readonly text: string;
    readonly protectedRanges: readonly TaskInputRange[];
  }): RecurrenceInputExtraction {
    const atoms = inputTextBarriers(request.text, request.protectedRanges)
      .filter((range) => validInputRange(request.text, range))
      .sort((a, b) => a.from - b.from);
    const html = htmlElementBarriers(request.text, atoms);
    const barriers = [...atoms, ...html].sort((a, b) => a.from - b.from);
    const masked = maskInputRanges(request.text, barriers);
    const context: ExtractionContext = {
      text: request.text,
      masked,
      barriers,
      locales: this.locales,
    };
    const cues = this.locales
      .flatMap((locale) => locale.starts(masked).map((from) => ({ from, locale })))
      .sort((a, b) => a.from - b.from);
    const scan: ExtractionScan = {
      index: 0,
      expressions: 0,
      candidates: [],
      protectedRanges: [...html],
    };
    for (const clause of clauses(masked, this.locales)) scanClause(context, clause, cues, scan);
    return {
      candidates: scan.expressions === 1 ? scan.candidates : [],
      protectedRanges: scan.protectedRanges,
    };
  }
}
