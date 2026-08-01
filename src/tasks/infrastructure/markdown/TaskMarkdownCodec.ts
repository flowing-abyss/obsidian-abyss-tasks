import { inlineCodeRanges, type SourceRange } from '../../../parser/inlineCode';
import { parseLinks } from '../../../parser/links';
import { StatusCatalog } from '../../domain/StatusCatalog';
import { parseRecurrenceRule } from '../../domain/recurrence';
import type { OnCompletion, TaskPriority, TaskStatus } from '../../domain/types';
import {
  formatDurationMinutes,
  isSingleLineText,
  localDate,
  localTime,
  type TaskIssue,
  type TaskValidationField,
  type TaskValidationState,
  durationMinutes as validatedDurationMinutes,
  validateTaskChange,
} from '../../domain/validation';

export type LineEdit =
  | { readonly type: 'set-title'; readonly markdownTitle: string }
  | { readonly type: 'append-title'; readonly markdown: string }
  | { readonly type: 'edit-link'; readonly occurrence: number; readonly replacement: string }
  | { readonly type: 'set-status'; readonly symbol: string; readonly today?: string }
  | { readonly type: 'set-priority'; readonly priority: TaskPriority }
  | {
      readonly type: 'set-date';
      readonly field: 'due' | 'scheduled' | 'start';
      readonly value: string | null;
    }
  | { readonly type: 'set-time'; readonly value: string | null }
  | { readonly type: 'set-duration'; readonly value: number | null }
  | { readonly type: 'set-recurrence'; readonly value: string | null }
  | { readonly type: 'set-on-completion'; readonly value: OnCompletion | null }
  | {
      readonly type: 'change-tags';
      readonly add: readonly string[];
      readonly remove: readonly string[];
    };

export type LineEditResult =
  | { readonly type: 'changed'; readonly content: string }
  | { readonly type: 'unchanged'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

type PreparedLineEdit =
  | {
      readonly type: 'prepared';
      readonly content: string;
      readonly fields: readonly TaskValidationField[];
    }
  | Extract<LineEditResult, { readonly type: 'unchanged' | 'invalid' }>;

export type TaskSpanKind =
  | 'prefix'
  | 'title'
  | 'tag'
  | 'priority'
  | 'recurrence'
  | 'on-completion'
  | 'created'
  | 'start'
  | 'scheduled'
  | 'due'
  | 'completion'
  | 'cancelled'
  | 'time'
  | 'duration'
  | 'task-id'
  | 'depends-on'
  | 'block-id'
  | 'malformed-known'
  | 'separator'
  | 'unknown';

export interface SourceSpan {
  readonly kind: TaskSpanKind;
  readonly from: number;
  readonly to: number;
  readonly malformedKind?: Exclude<
    TaskSpanKind,
    'prefix' | 'title' | 'tag' | 'malformed-known' | 'separator' | 'unknown'
  >;
}

export interface ParsedTaskLine {
  readonly original: string;
  readonly lineEnding: '' | '\n' | '\r\n';
  readonly statusSymbol: string;
  readonly markdownTitle: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly spans: readonly SourceSpan[];
  readonly occurrences: ReadonlyMap<TaskSpanKind, readonly SourceSpan[]>;
  readonly planning: {
    readonly due?: string;
    readonly created?: string;
    readonly scheduled?: string;
    readonly start?: string;
    readonly completion?: string;
    readonly cancelled?: string;
    readonly time?: string;
    readonly duration?: number;
  };
  readonly priority: TaskPriority;
  readonly recurrence?: string;
  readonly onCompletion: OnCompletion;
  readonly onCompletionExplicit: boolean;
  readonly source: {
    readonly filePath: string;
    readonly line: number;
    readonly originalMarkdown: string;
  };
}

interface ParseSource {
  readonly filePath: string;
  readonly line: number;
}

interface Candidate extends SourceSpan {
  readonly value?: string | number;
}

const TASK_LINE_RE = /^[\s>]*- \[(.)\]/u;
const TAG_RE = /#[\w/-]+/gu;
const PRIORITY_RE = /[🔺⏫🔼🔽⏬]/gu;
const DATE_PATTERNS: ReadonlyArray<{
  kind: 'created' | 'start' | 'scheduled' | 'due' | 'completion' | 'cancelled';
  regex: RegExp;
}> = [
  { kind: 'created', regex: /➕\s*(\d{4}-\d{2}-\d{2})/gu },
  { kind: 'start', regex: /🛫\s*(\d{4}-\d{2}-\d{2})/gu },
  { kind: 'scheduled', regex: /⏳\s*(\d{4}-\d{2}-\d{2})/gu },
  { kind: 'due', regex: /📅\s*(\d{4}-\d{2}-\d{2})/gu },
  { kind: 'completion', regex: /✅\s*(\d{4}-\d{2}-\d{2})/gu },
  { kind: 'cancelled', regex: /❌\s*(\d{4}-\d{2}-\d{2})/gu },
];
const TIME_RE = /⏰\s*(\d{1,2}:\d{2})/gu;
const DURATION_RE = /⏱️\s*(?:(\d{1,2}):([0-5]\d)(?=\s|$)|(?:(\d+)h)?(?:(\d+)m)?)/gu;
const RECURRENCE_MARKER_RE = /🔁/gu;
const ON_COMPLETION_RE = /🏁\s*(keep|delete)(?=\s|$)/giu;
const BLOCK_ID_RE = /\^[A-Za-z0-9-]+(?=\s*$)/gu;

const MARKER_BY_FIELD: Readonly<Record<TaskValidationField, string>> = {
  title: '',
  status: '',
  due: '📅',
  scheduled: '⏳',
  start: '🛫',
  completion: '✅',
  cancelled: '❌',
  time: '⏰',
  duration: '⏱️',
  recurrence: '🔁',
  'on-completion': '🏁',
};

const SPAN_KIND_BY_FIELD: Readonly<Partial<Record<TaskValidationField, TaskSpanKind>>> = {
  due: 'due',
  scheduled: 'scheduled',
  start: 'start',
  completion: 'completion',
  cancelled: 'cancelled',
  time: 'time',
  duration: 'duration',
  recurrence: 'recurrence',
  'on-completion': 'on-completion',
};

const TOKEN_BY_PRIORITY: Readonly<Record<TaskPriority, string>> = {
  A: '🔺',
  B: '⏫',
  C: '🔼',
  D: '',
  E: '🔽',
  F: '⏬',
};

const TOKEN_RANK: Readonly<Partial<Record<TaskSpanKind, number>>> = {
  time: 10,
  duration: 20,
  priority: 30,
  recurrence: 40,
  'on-completion': 45,
  created: 50,
  start: 60,
  scheduled: 70,
  due: 80,
  cancelled: 90,
  completion: 100,
};

const TASK_ID = '[A-Za-z0-9_-]+';
const TASK_ID_SEQUENCE = `${TASK_ID}( *, *${TASK_ID} *)*`;
const TASK_ID_RE = new RegExp(`🆔\\uFE0F? *(${TASK_ID})(?=$|\\s)`, 'uy');
const DEPENDS_ON_RE = new RegExp(`⛔\\uFE0F? *(${TASK_ID_SEQUENCE})(?=$|\\s)`, 'uy');

const KNOWN_CARRIER_MARKERS = [
  { marker: '➕', kind: 'created' },
  { marker: '🛫', kind: 'start' },
  { marker: '⏳', kind: 'scheduled' },
  { marker: '📅', kind: 'due' },
  { marker: '✅', kind: 'completion' },
  { marker: '❌', kind: 'cancelled' },
  { marker: '⏰', kind: 'time' },
  { marker: '⏱️', kind: 'duration' },
  { marker: '🏁', kind: 'on-completion' },
  { marker: '🆔', kind: 'task-id' },
  { marker: '⛔', kind: 'depends-on' },
] as const satisfies ReadonlyArray<{
  readonly marker: string;
  readonly kind: NonNullable<SourceSpan['malformedKind']>;
}>;

const METADATA_KINDS = new Set<TaskSpanKind>([
  'priority',
  'recurrence',
  'on-completion',
  'created',
  'start',
  'scheduled',
  'due',
  'completion',
  'cancelled',
  'time',
  'duration',
  'task-id',
  'depends-on',
  'block-id',
  'malformed-known',
]);

const TITLE_SEMANTIC_KINDS = new Set<TaskSpanKind>([...METADATA_KINDS, 'tag']);

const PRIORITY_BY_MARKER: Readonly<Record<string, TaskPriority>> = {
  '🔺': 'A',
  '⏫': 'B',
  '🔼': 'C',
  '🔽': 'E',
  '⏬': 'F',
};

const PRIORITY_PRECEDENCE: readonly TaskPriority[] = ['A', 'B', 'C', 'E', 'F'];
const UNKNOWN_PICTOGRAPH_RE = /\p{Extended_Pictographic}/u;
const WIKILINK_ALIAS_RE = /\[\[([^|[\]]+)\|([^[\]]+)\]\]/gu;
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/gu;
const MD_LINK_RE = /\[([^[\]]+)\]\(([^)]+)\)/gu;
const BRACKETS_RE = /\[([^[\]]*)\]/gu;

function matches(regex: RegExp, text: string): RegExpExecArray[] {
  regex.lastIndex = 0;
  const result: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) result.push(match);
  return result;
}

function pushPatternCandidates(
  candidates: Candidate[],
  body: string,
  bodyFrom: number,
  kind: TaskSpanKind,
  regex: RegExp,
  valueGroup?: number,
): void {
  for (const match of matches(regex, body)) {
    if (match[0].length === 0) continue;
    candidates.push({
      kind,
      from: bodyFrom + match.index,
      to: bodyFrom + match.index + match[0].length,
      ...(valueGroup !== undefined && match[valueGroup] !== undefined
        ? { value: match[valueGroup] }
        : {}),
    });
  }
}

function pushTagCandidates(candidates: Candidate[], body: string, bodyFrom: number): void {
  for (const match of matches(TAG_RE, body)) {
    const from = match.index;
    const to = from + match[0].length;
    candidates.push({ kind: 'tag', from: bodyFrom + from, to: bodyFrom + to });
  }
}

function mergedRanges(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.from > previous.to) {
      merged.push(range);
      continue;
    }
    if (range.to > previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: range.to };
    }
  }
  return merged;
}

function excludeOverlappingRanges<T extends SourceRange>(
  sortedCandidates: readonly T[],
  sortedExclusions: readonly SourceRange[],
): T[] {
  const accepted: T[] = [];
  let exclusionIndex = 0;
  for (const candidate of sortedCandidates) {
    while (
      exclusionIndex < sortedExclusions.length &&
      sortedExclusions[exclusionIndex]!.to <= candidate.from
    ) {
      exclusionIndex++;
    }
    const exclusion = sortedExclusions[exclusionIndex];
    if (exclusion && candidate.from < exclusion.to && candidate.to > exclusion.from) continue;
    accepted.push(candidate);
  }
  return accepted;
}

function containsSortedPoint(at: number, sortedRanges: readonly SourceRange[]): boolean {
  for (const range of sortedRanges) {
    if (range.to <= at) continue;
    return range.from <= at && at < range.to;
  }
  return false;
}

function includesExactCandidate(
  sortedCandidates: readonly Candidate[],
  range: SourceRange,
  kind: TaskSpanKind,
): boolean {
  for (const candidate of sortedCandidates) {
    if (candidate.from > range.from) return false;
    if (candidate.kind === kind && candidate.from === range.from && candidate.to === range.to) {
      return true;
    }
  }
  return false;
}

function pushPinnedCarrierCandidates(
  candidates: Candidate[],
  body: string,
  bodyFrom: number,
  marker: '🆔' | '⛔',
  regex: RegExp,
  kind: 'task-id' | 'depends-on',
): void {
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const markerAt = body.indexOf(marker, searchFrom);
    if (markerAt < 0) break;
    regex.lastIndex = markerAt;
    const match = regex.exec(body);
    if (match?.index === markerAt) {
      candidates.push({
        kind,
        from: bodyFrom + markerAt,
        to: bodyFrom + markerAt + match[0].length,
        value: match[1],
      });
    }
    searchFrom = markerAt + marker.length;
  }
}

function markerPositions(body: string): ReadonlyArray<{
  readonly at: number;
  readonly marker: string;
  readonly kind: NonNullable<SourceSpan['malformedKind']>;
}> {
  return KNOWN_CARRIER_MARKERS.flatMap(({ marker, kind }) => {
    const positions: Array<{ at: number; marker: string; kind: typeof kind }> = [];
    let from = 0;
    while (from < body.length) {
      const at = body.indexOf(marker, from);
      if (at < 0) break;
      positions.push({ at, marker, kind });
      from = at + marker.length;
    }
    return positions;
  }).sort((left, right) => left.at - right.at);
}

function terminalCaretRange(
  body: string,
  sortedAtomicRanges: readonly SourceRange[],
): SourceRange | undefined {
  let to = body.length;
  while (to > 0 && /\s/u.test(body[to - 1]!)) to--;
  let from = to;
  let atomicIndex = sortedAtomicRanges.length - 1;
  while (from > 0) {
    while (atomicIndex >= 0 && sortedAtomicRanges[atomicIndex]!.to > from) atomicIndex--;
    const atomic = sortedAtomicRanges[atomicIndex];
    if (atomic?.to === from) {
      from = atomic.from;
      atomicIndex--;
      continue;
    }
    if (/\s/u.test(body[from - 1]!)) break;
    from--;
  }
  return body[from] === '^' ? { from, to } : undefined;
}

function sortedUnique(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function malformedValueEnd(
  body: string,
  valueFrom: number,
  boundary: number,
  kind: NonNullable<SourceSpan['malformedKind']>,
): number {
  let to = valueFrom;
  while (to < boundary && !/\s/u.test(body[to]!)) to++;
  if (kind !== 'depends-on') return to;

  while (to < boundary) {
    let next = to;
    while (next < boundary && /\s/u.test(body[next]!)) next++;
    if (next >= boundary || (body[to - 1] !== ',' && body[next] !== ',')) break;
    to = next;
    while (to < boundary && !/\s/u.test(body[to]!)) to++;
  }
  return to;
}

function pushRecurrenceCandidates(
  candidates: Candidate[],
  body: string,
  bodyFrom: number,
  recurrenceMarkers: readonly number[],
  boundaries: readonly number[],
): void {
  let boundaryIndex = 0;
  for (const recurrenceAt of recurrenceMarkers) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= recurrenceAt) {
      boundaryIndex++;
    }
    const recurrenceBoundary = boundaries[boundaryIndex] ?? body.length;
    let recurrenceTo = recurrenceBoundary;
    while (recurrenceTo > recurrenceAt && /\s/u.test(body[recurrenceTo - 1] ?? '')) {
      recurrenceTo--;
    }
    const rawValue = body.slice(recurrenceAt + '🔁'.length, recurrenceTo).trim();
    candidates.push({
      kind: 'recurrence',
      from: bodyFrom + recurrenceAt,
      to: bodyFrom + recurrenceTo,
      ...(rawValue ? { value: rawValue } : {}),
    });
  }
}

function pushMalformedKnownCandidates(
  candidates: Candidate[],
  body: string,
  bodyFrom: number,
  markers: ReturnType<typeof markerPositions>,
  boundaries: readonly number[],
): void {
  const protectedRanges = mergedRanges(candidates);
  let protectedIndex = 0;
  let boundaryIndex = 0;
  const overlapsProtected = (from: number, to: number): boolean => {
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex]!.to <= from) {
      protectedIndex++;
    }
    const protectedRange = protectedRanges[protectedIndex];
    return protectedRange !== undefined && from < protectedRange.to && to > protectedRange.from;
  };

  for (const { at, marker, kind } of markers) {
    const absoluteFrom = bodyFrom + at;
    if (overlapsProtected(absoluteFrom, absoluteFrom + marker.length)) continue;

    let markerEnd = at + marker.length;
    if ((kind === 'task-id' || kind === 'depends-on') && body[markerEnd] === '\ufe0f') markerEnd++;
    let valueFrom = markerEnd;
    while (/\s/u.test(body[valueFrom] ?? '')) valueFrom++;
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! < valueFrom) {
      boundaryIndex++;
    }
    const boundary = boundaries[boundaryIndex] ?? body.length;
    const valueTo = malformedValueEnd(body, valueFrom, boundary, kind);
    const to = valueTo > valueFrom ? valueTo : markerEnd;
    candidates.push({
      kind: 'malformed-known',
      malformedKind: kind,
      from: bodyFrom + at,
      to: bodyFrom + to,
    });
  }
}

function durationMinutes(
  hours: string | undefined,
  minutes: string | undefined,
): number | undefined {
  const total = Number(hours ?? 0) * 60 + Number(minutes ?? 0);
  return total > 0 ? total : undefined;
}

function addGapSpans(spans: SourceSpan[], original: string, from: number, to: number): void {
  let cursor = from;
  while (cursor < to) {
    const whitespace = /\s/u.test(original[cursor] ?? '');
    let end = cursor + 1;
    while (end < to && /\s/u.test(original[end] ?? '') === whitespace) end++;
    if (whitespace) {
      spans.push({ kind: 'separator', from: cursor, to: end });
      cursor = end;
      continue;
    }

    const raw = original.slice(cursor, end);
    spans.push({
      kind: UNKNOWN_PICTOGRAPH_RE.test(raw) ? 'unknown' : 'title',
      from: cursor,
      to: end,
    });
    cursor = end;
  }
}

function collapseLinks(input: string): string {
  return input
    .replace(WIKILINK_ALIAS_RE, '🔗$1')
    .replace(WIKILINK_RE, (_match, link: string) => '🔗 ' + link.replace(/\.[^.]*$/u, ''))
    .replace(MD_LINK_RE, '🌐 $1')
    .replace(BRACKETS_RE, '$1');
}

function firstString(candidates: readonly Candidate[], kind: TaskSpanKind): string | undefined {
  const value = candidates.find((candidate) => candidate.kind === kind)?.value;
  return typeof value === 'string' ? value : undefined;
}

function completionPolicyFrom(candidates: readonly Candidate[]): {
  readonly onCompletion: OnCompletion;
  readonly onCompletionExplicit: boolean;
} {
  const value = firstString(candidates, 'on-completion')?.toLowerCase();
  return value === 'delete'
    ? { onCompletion: 'delete', onCompletionExplicit: true }
    : { onCompletion: 'keep', onCompletionExplicit: value !== undefined };
}

function lineEndingOf(original: string): ParsedTaskLine['lineEnding'] {
  if (original.endsWith('\r\n')) return '\r\n';
  if (original.endsWith('\n')) return '\n';
  return '';
}

function pushBlockIdCandidates(candidates: Candidate[], body: string, bodyFrom: number): void {
  for (const match of matches(BLOCK_ID_RE, body)) {
    const before = body[match.index - 1];
    if (match.index === 0 || before === undefined || !/\s/u.test(before)) continue;
    candidates.push({
      kind: 'block-id',
      from: bodyFrom + match.index,
      to: bodyFrom + match.index + match[0].length,
    });
  }
}

function spliceSource(source: string, from: number, to: number, replacement: string): string {
  return source.slice(0, from) + replacement + source.slice(to);
}

function removeSpan(source: string, span: SourceSpan): string {
  let from = span.from;
  let to = span.to;
  if (source[from - 1] === ' ') from--;
  else if (source[to] === ' ') to++;
  return spliceSource(source, from, to, '');
}

function isSemanticTitleSpan(span: SourceSpan): boolean {
  return span.kind === 'title' || span.kind === 'unknown';
}

function semanticTitleFragments(
  spans: readonly SourceSpan[],
  contentEnd: number,
): readonly SourceSpan[] {
  const fragments: SourceSpan[] = [];
  let fragmentFrom: number | undefined;
  let fragmentTo: number | undefined;
  for (const span of spans) {
    if (span.kind === 'prefix' || (span.kind === 'separator' && span.from === contentEnd)) continue;
    if (isSemanticTitleSpan(span)) {
      fragmentFrom ??= span.from;
      fragmentTo = span.to;
      continue;
    }
    if (span.kind === 'separator' && fragmentFrom !== undefined) continue;
    if (fragmentFrom !== undefined && fragmentTo !== undefined) {
      fragments.push({ kind: 'title', from: fragmentFrom, to: fragmentTo });
      fragmentFrom = undefined;
      fragmentTo = undefined;
    }
  }
  if (fragmentFrom !== undefined && fragmentTo !== undefined) {
    fragments.push({ kind: 'title', from: fragmentFrom, to: fragmentTo });
  }
  return fragments;
}

function insertionPoint(parsed: ParsedTaskLine, kind: TaskSpanKind): number {
  const rank = TOKEN_RANK[kind];
  if (rank !== undefined) {
    const later = parsed.spans.find((span) => {
      const candidateRank = TOKEN_RANK[span.kind];
      if (candidateRank === undefined || candidateRank <= rank) return false;
      const raw = parsed.original.slice(span.from, span.to);
      try {
        if (
          span.kind === 'created' ||
          span.kind === 'start' ||
          span.kind === 'scheduled' ||
          span.kind === 'due' ||
          span.kind === 'cancelled' ||
          span.kind === 'completion'
        ) {
          localDate(raw.slice(-10));
        } else if (span.kind === 'time') {
          localTime(raw.slice(-5));
        }
      } catch {
        return false;
      }
      return true;
    });
    const carrierAt =
      kind === 'recurrence' || kind === 'on-completion'
        ? Math.min(
            parsed.occurrences.get('task-id')?.[0]?.from ?? Infinity,
            parsed.occurrences.get('depends-on')?.[0]?.from ?? Infinity,
            parsed.occurrences.get('block-id')?.[0]?.from ?? Infinity,
          )
        : Infinity;
    if (later) return Math.min(later.from, carrierAt);
    if (carrierAt !== Infinity) return carrierAt;
  }
  const blockId = parsed.occurrences.get('block-id')?.[0];
  if (blockId) return blockId.from;
  return parsed.original.length - parsed.lineEnding.length;
}

function insertToken(parsed: ParsedTaskLine, kind: TaskSpanKind, token: string): string {
  const at = insertionPoint(parsed, kind);
  const before = parsed.original[at - 1];
  const after = parsed.original[at];
  const left = before === undefined || /\s/u.test(before) ? '' : ' ';
  const right = after === undefined || /\s/u.test(after) ? '' : ' ';
  return spliceSource(parsed.original, at, at, `${left}${token}${right}`);
}

function invalid(
  code: TaskIssue['code'],
  field?: string,
): Extract<LineEditResult, { readonly type: 'invalid' }> {
  return { type: 'invalid', issues: [{ code, ...(field !== undefined && { field }) }] };
}

export class TaskMarkdownCodec {
  constructor(private readonly statusCatalog: StatusCatalog) {}

  statusForSymbol(symbol: string): TaskStatus {
    return this.statusCatalog.statusForSymbol(symbol);
  }

  editTextLink(source: string, occurrence: number, replacement: string): LineEditResult {
    if (!isSingleLineText(replacement)) return invalid('invalid-target', 'link');
    if (!Number.isInteger(occurrence) || occurrence < 0) return invalid('invalid-target', 'link');
    const link = parseLinks(source)[occurrence];
    if (!link) return invalid('invalid-target', 'link');
    const content = spliceSource(source, link.index, link.index + link.raw.length, replacement);
    return content === source
      ? { type: 'unchanged', content: source }
      : { type: 'changed', content };
  }

  private malformedFields(parsed: ParsedTaskLine): ReadonlySet<TaskValidationField> {
    const malformed = new Set<TaskValidationField>();
    for (const [field, kind] of Object.entries(SPAN_KIND_BY_FIELD) as Array<
      [TaskValidationField, TaskSpanKind]
    >) {
      if (
        parsed.spans.some((span) => span.kind === 'malformed-known' && span.malformedKind === kind)
      ) {
        malformed.add(field);
      }
    }
    if (
      (parsed.occurrences.get('duration')?.length ?? 0) > 0 &&
      parsed.planning.duration === undefined
    ) {
      malformed.add('duration');
    }
    if (
      (parsed.occurrences.get('recurrence')?.length ?? 0) > 0 &&
      parsed.recurrence === undefined
    ) {
      malformed.add('recurrence');
    }
    return malformed;
  }

  private validationState(parsed: ParsedTaskLine): TaskValidationState {
    return {
      markdownTitle: parsed.markdownTitle,
      statusSymbol: parsed.statusSymbol,
      statusConfigured: this.statusCatalog.ruleForSymbol(parsed.statusSymbol) !== undefined,
      planning: parsed.planning,
      recurrence: parsed.recurrence,
      onCompletion: parsed.onCompletion,
      malformedFields: [...this.malformedFields(parsed)],
    };
  }

  /** Validates a complete candidate line before task creation writes it to the vault. */
  validateLine(original: string): readonly TaskIssue[] {
    const parsed = this.parseLine(original, { filePath: '', line: 0 });
    if (!parsed) return [{ code: 'invalid-task-syntax' }];
    return validateTaskChange(
      this.validationState(parsed),
      new Set<TaskValidationField>([
        'due',
        'scheduled',
        'start',
        'completion',
        'cancelled',
        'time',
        'duration',
        'recurrence',
        'on-completion',
      ]),
    );
  }

  private duplicateIssue(parsed: ParsedTaskLine, kind: TaskSpanKind, field: string): TaskIssue[] {
    return (parsed.occurrences.get(kind)?.length ?? 0) > 1
      ? [{ code: 'duplicate-field', field }]
      : [];
  }

  private malformedTargetIssue(parsed: ParsedTaskLine, field: TaskValidationField): TaskIssue[] {
    if (!this.malformedFields(parsed).has(field)) return [];
    if (field === 'time') return [{ code: 'invalid-time', field }];
    if (field === 'duration') return [{ code: 'invalid-duration', field }];
    if (field === 'on-completion') return [{ code: 'invalid-on-completion', field }];
    if (field === 'recurrence') return [{ code: 'unparseable-rule', field }];
    return [{ code: 'invalid-date', field }];
  }

  private replaceOrInsertToken(
    parsed: ParsedTaskLine,
    kind: TaskSpanKind,
    token: string | null,
  ): string {
    const occurrence = parsed.occurrences.get(kind)?.[0];
    if (occurrence) {
      return token === null
        ? removeSpan(parsed.original, occurrence)
        : spliceSource(parsed.original, occurrence.from, occurrence.to, token);
    }
    return token === null ? parsed.original : insertToken(parsed, kind, token);
  }

  private editableTitleFragments(parsed: ParsedTaskLine): readonly SourceSpan[] {
    const contentEnd = parsed.original.length - parsed.lineEnding.length;
    return semanticTitleFragments(parsed.spans, contentEnd);
  }

  private linkTitleFragments(parsed: ParsedTaskLine): readonly SourceSpan[] {
    const contentEnd = parsed.original.length - parsed.lineEnding.length;
    return semanticTitleFragments(parsed.spans, contentEnd);
  }

  private replaceTitle(parsed: ParsedTaskLine, markdownTitle: string): string {
    const fragments = this.editableTitleFragments(parsed);
    const first = fragments[0];
    if (first) {
      let content = parsed.original;
      const removals = markdownTitle ? fragments.slice(1) : fragments;
      for (const fragment of [...removals].reverse()) {
        content = removeSpan(content, fragment);
      }
      return markdownTitle ? spliceSource(content, first.from, first.to, markdownTitle) : content;
    }

    const contentEnd = parsed.original.length - parsed.lineEnding.length;
    const firstProtected = parsed.spans.find(
      (span) => span.kind !== 'prefix' && span.kind !== 'separator',
    );
    const at = firstProtected?.from ?? contentEnd;
    const left = /\s/u.test(parsed.original[at - 1] ?? '') ? '' : ' ';
    const right = /\s/u.test(parsed.original[at] ?? '') || at === contentEnd ? '' : ' ';
    return spliceSource(parsed.original, at, at, `${left}${markdownTitle}${right}`);
  }

  private appendTitle(parsed: ParsedTaskLine, markdown: string): string {
    const fragments = this.editableTitleFragments(parsed);
    const last = fragments[fragments.length - 1];
    if (!last) return this.replaceTitle(parsed, markdown);
    return spliceSource(parsed.original, last.to, last.to, ` ${markdown}`);
  }

  private editTitleLink(
    parsed: ParsedTaskLine,
    occurrence: number,
    replacement: string,
  ): PreparedLineEdit {
    if (!Number.isInteger(occurrence) || occurrence < 0) return invalid('invalid-target', 'link');
    let remaining = occurrence;
    for (const fragment of this.linkTitleFragments(parsed)) {
      const source = parsed.original.slice(fragment.from, fragment.to);
      const links = parseLinks(source);
      if (remaining >= links.length) {
        remaining -= links.length;
        continue;
      }
      const link = links[remaining];
      if (!link) return invalid('invalid-target', 'link');
      return {
        type: 'prepared',
        content: spliceSource(
          parsed.original,
          fragment.from + link.index,
          fragment.from + link.index + link.raw.length,
          replacement,
        ),
        fields: ['title'],
      };
    }
    return invalid('invalid-target', 'link');
  }

  private introducedTitleIssues(
    before: ParsedTaskLine,
    after: ParsedTaskLine,
  ): readonly TaskIssue[] {
    const introducedFields = new Set<TaskValidationField>();
    const duplicateIssues: TaskIssue[] = [];
    for (const [field, kind] of Object.entries(SPAN_KIND_BY_FIELD) as Array<
      [TaskValidationField, TaskSpanKind]
    >) {
      const carrierCount = (parsed: ParsedTaskLine): number =>
        (parsed.occurrences.get(kind)?.length ?? 0) +
        parsed.spans.filter(
          (span) => span.kind === 'malformed-known' && span.malformedKind === kind,
        ).length;
      const beforeOccurrences = carrierCount(before);
      const afterOccurrences = carrierCount(after);
      if (afterOccurrences > beforeOccurrences) introducedFields.add(field);
      if (afterOccurrences > beforeOccurrences && afterOccurrences > 1) {
        duplicateIssues.push({ code: 'duplicate-field', field });
      }
    }
    if (duplicateIssues.length > 0) return duplicateIssues;

    const introducedSemanticSpan = [...TITLE_SEMANTIC_KINDS].some(
      (kind) =>
        (after.occurrences.get(kind)?.length ?? 0) > (before.occurrences.get(kind)?.length ?? 0),
    );
    if (introducedFields.size === 0 && !introducedSemanticSpan) {
      return [];
    }

    const valueIssues = validateTaskChange(this.validationState(after), introducedFields);
    return valueIssues.length > 0 ? valueIssues : [{ code: 'invalid-target', field: 'title' }];
  }

  private prepareTagChange(
    parsed: ParsedTaskLine,
    add: readonly string[],
    remove: readonly string[],
  ): PreparedLineEdit {
    const normalize = (tag: string): string => (tag.startsWith('#') ? tag : `#${tag}`);
    const additions = [...new Set(add.map(normalize))];
    const removals = new Set(remove.map(normalize));
    if ([...additions, ...removals].some((tag) => !/^#[\w/-]+$/u.test(tag))) {
      return invalid('invalid-target', 'tags');
    }

    let content = parsed.original;
    for (const span of [...(parsed.occurrences.get('tag') ?? [])].reverse()) {
      const tag = parsed.original.slice(span.from, span.to);
      if (removals.has(tag)) content = removeSpan(content, span);
    }
    const candidate = this.parseLine(content, { filePath: '', line: 0 })!;
    const present = new Set(candidate.tags);
    const pending = additions.filter((tag) => !present.has(tag));
    if (pending.length === 0) return { type: 'prepared', content, fields: [] };

    const tags = candidate.occurrences.get('tag') ?? [];
    const lastTag = tags[tags.length - 1];
    if (lastTag) {
      return {
        type: 'prepared',
        content: spliceSource(content, lastTag.to, lastTag.to, ` ${pending.join(' ')}`),
        fields: [],
      };
    }
    const protectedSpan = candidate.spans.find(
      (span) => METADATA_KINDS.has(span.kind) || span.kind === 'block-id',
    );
    const at = protectedSpan?.from ?? content.length - candidate.lineEnding.length;
    const left = /\s/u.test(content[at - 1] ?? '') ? '' : ' ';
    const right = /\s/u.test(content[at] ?? '') || at === content.length ? '' : ' ';
    return {
      type: 'prepared',
      content: spliceSource(content, at, at, `${left}${pending.join(' ')}${right}`),
      fields: [],
    };
  }

  private prepareStatusEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-status' }>,
  ): PreparedLineEdit {
    if (parsed.statusSymbol === edit.symbol) {
      return { type: 'unchanged', content: parsed.original };
    }
    const rule = this.statusCatalog.ruleForSymbol(edit.symbol);
    if (edit.symbol.length !== 1 || !rule) return invalid('invalid-status', 'status');
    const currentRule = this.statusCatalog.ruleForSymbol(parsed.statusSymbol);

    const issues: TaskIssue[] = [];
    for (const field of ['completion', 'cancelled'] as const) {
      issues.push(...this.duplicateIssue(parsed, field, field));
      issues.push(...this.malformedTargetIssue(parsed, field));
    }
    if (issues.length > 0) return { type: 'invalid', issues };

    const statusAt = (parsed.occurrences.get('prefix')?.[0]?.to ?? 0) - 2;
    let content = spliceSource(parsed.original, statusAt, statusAt + 1, edit.symbol);
    let stampedKind: 'completion' | 'cancelled' | undefined;
    if (rule.type === 'done') stampedKind = 'completion';
    if (rule.type === 'cancelled') stampedKind = 'cancelled';
    const preservesStamp = stampedKind !== undefined && currentRule?.type === rule.type;
    if (stampedKind !== undefined && !preservesStamp && edit.today === undefined) {
      return invalid('invalid-status', 'status');
    }
    for (const kind of ['completion', 'cancelled'] as const) {
      if (preservesStamp && kind === stampedKind) continue;
      const current = this.parseLine(content, { filePath: '', line: 0 })!;
      content = this.replaceOrInsertToken(current, kind, null);
    }
    if (stampedKind !== undefined && edit.today !== undefined) {
      const marker = stampedKind === 'completion' ? '✅' : '❌';
      const current = this.parseLine(content, { filePath: '', line: 0 })!;
      content = this.replaceOrInsertToken(current, stampedKind, `${marker} ${edit.today}`);
    }
    return { type: 'prepared', content, fields: ['status', 'completion', 'cancelled'] };
  }

  private preparePriorityEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-priority' }>,
  ): PreparedLineEdit {
    const issues = this.duplicateIssue(parsed, 'priority', 'priority');
    if (issues.length > 0) return { type: 'invalid', issues };
    const occurrences = parsed.occurrences.get('priority')?.length ?? 0;
    if (parsed.priority === edit.priority && (edit.priority !== 'D' || occurrences === 0)) {
      return { type: 'unchanged', content: parsed.original };
    }
    const content = this.replaceOrInsertToken(
      parsed,
      'priority',
      TOKEN_BY_PRIORITY[edit.priority] || null,
    );
    return { type: 'prepared', content, fields: [] };
  }

  private prepareDateEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-date' }>,
  ): PreparedLineEdit {
    const issues = [
      ...this.duplicateIssue(parsed, edit.field, edit.field),
      ...this.malformedTargetIssue(parsed, edit.field),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const current = parsed.planning[edit.field];
    if (
      (edit.value === null && current === undefined) ||
      (edit.value !== null && current === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    const marker = MARKER_BY_FIELD[edit.field];
    const token = edit.value === null ? null : `${marker} ${edit.value}`;
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(parsed, edit.field, token),
      fields: [edit.field],
    };
  }

  private prepareTimeEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-time' }>,
  ): PreparedLineEdit {
    const issues = [
      ...this.duplicateIssue(parsed, 'time', 'time'),
      ...this.malformedTargetIssue(parsed, 'time'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const current = parsed.planning.time;
    if (
      (edit.value === null && current === undefined) ||
      (edit.value !== null && current === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(
        parsed,
        'time',
        edit.value === null ? null : `⏰ ${edit.value}`,
      ),
      fields: ['time'],
    };
  }

  private prepareDurationEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-duration' }>,
  ): PreparedLineEdit {
    const issues = [
      ...this.duplicateIssue(parsed, 'duration', 'duration'),
      ...this.malformedTargetIssue(parsed, 'duration'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const current = parsed.planning.duration;
    if (
      (edit.value === null && current === undefined) ||
      (edit.value !== null && current === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    let token: string | null = null;
    if (edit.value !== null) {
      try {
        token = `⏱️ ${formatDurationMinutes(validatedDurationMinutes(edit.value))}`;
      } catch {
        return invalid('invalid-duration', 'duration');
      }
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(parsed, 'duration', token),
      fields: ['duration'],
    };
  }

  private prepareRecurrenceEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-recurrence' }>,
  ): PreparedLineEdit {
    if (edit.value !== null && !isSingleLineText(edit.value)) {
      return invalid('invalid-target', 'recurrence');
    }
    const issues = [
      ...this.duplicateIssue(parsed, 'recurrence', 'recurrence'),
      ...this.malformedTargetIssue(parsed, 'recurrence'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    const recurrence = edit.value === null ? undefined : parseRecurrenceRule(edit.value);
    if (recurrence?.type === 'invalid') {
      return invalid(recurrence.code, 'recurrence');
    }
    if (
      (edit.value === null && parsed.recurrence === undefined) ||
      (edit.value !== null && parsed.recurrence === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(
        parsed,
        'recurrence',
        edit.value === null ? null : `🔁 ${edit.value}`,
      ),
      fields: ['recurrence'],
    };
  }

  private prepareOnCompletionEdit(
    parsed: ParsedTaskLine,
    edit: Extract<LineEdit, { readonly type: 'set-on-completion' }>,
  ): PreparedLineEdit {
    if (
      edit.value !== null &&
      (!isSingleLineText(edit.value) || (edit.value !== 'keep' && edit.value !== 'delete'))
    ) {
      return invalid('invalid-target', 'on-completion');
    }
    const issues = [
      ...this.duplicateIssue(parsed, 'on-completion', 'on-completion'),
      ...this.malformedTargetIssue(parsed, 'on-completion'),
    ];
    if (issues.length > 0) return { type: 'invalid', issues };
    if (
      (edit.value === null && !parsed.onCompletionExplicit) ||
      (edit.value !== null && parsed.onCompletionExplicit && parsed.onCompletion === edit.value)
    ) {
      return { type: 'unchanged', content: parsed.original };
    }
    return {
      type: 'prepared',
      content: this.replaceOrInsertToken(
        parsed,
        'on-completion',
        edit.value === null ? null : `🏁 ${edit.value}`,
      ),
      fields: ['on-completion'],
    };
  }

  private prepareLineEdit(parsed: ParsedTaskLine, edit: LineEdit): PreparedLineEdit {
    switch (edit.type) {
      case 'set-title':
        if (!isSingleLineText(edit.markdownTitle)) return invalid('invalid-target', 'title');
        return parsed.markdownTitle === edit.markdownTitle
          ? { type: 'unchanged', content: parsed.original }
          : {
              type: 'prepared',
              content: this.replaceTitle(parsed, edit.markdownTitle),
              fields: ['title'],
            };
      case 'append-title':
        if (!isSingleLineText(edit.markdown)) return invalid('invalid-target', 'title');
        return edit.markdown.length === 0
          ? { type: 'unchanged', content: parsed.original }
          : {
              type: 'prepared',
              content: this.appendTitle(parsed, edit.markdown),
              fields: ['title'],
            };
      case 'edit-link':
        if (!isSingleLineText(edit.replacement)) return invalid('invalid-target', 'link');
        return this.editTitleLink(parsed, edit.occurrence, edit.replacement);
      case 'set-status':
        return this.prepareStatusEdit(parsed, edit);
      case 'set-priority':
        return this.preparePriorityEdit(parsed, edit);
      case 'set-date':
        return this.prepareDateEdit(parsed, edit);
      case 'set-time':
        return this.prepareTimeEdit(parsed, edit);
      case 'set-duration':
        return this.prepareDurationEdit(parsed, edit);
      case 'set-recurrence':
        return this.prepareRecurrenceEdit(parsed, edit);
      case 'set-on-completion':
        return this.prepareOnCompletionEdit(parsed, edit);
      case 'change-tags':
        return this.prepareTagChange(parsed, edit.add, edit.remove);
    }
  }

  applyLineEdit(original: string, edit: LineEdit): LineEditResult {
    const parsed = this.parseLine(original, { filePath: '', line: 0 });
    if (!parsed) return invalid('invalid-task-syntax');
    const prepared = this.prepareLineEdit(parsed, edit);
    if (prepared.type !== 'prepared') return prepared;
    if (prepared.content === original) return { type: 'unchanged', content: original };
    const reparsed = this.parseLine(prepared.content, { filePath: '', line: 0 });
    if (!reparsed) return invalid('invalid-task-syntax');
    if (edit.type === 'set-title' || edit.type === 'append-title' || edit.type === 'edit-link') {
      const titleIssues = this.introducedTitleIssues(parsed, reparsed);
      if (titleIssues.length > 0) return { type: 'invalid', issues: titleIssues };
    }
    const issues = validateTaskChange(this.validationState(reparsed), new Set(prepared.fields));
    if (issues.length > 0) return { type: 'invalid', issues };
    return { type: 'changed', content: prepared.content };
  }

  /** Applies correlated field edits as one candidate and validates only the final state. */
  applyLineEdits(
    original: string,
    edits: readonly LineEdit[],
    requestedFields: readonly TaskValidationField[] = [],
  ): LineEditResult {
    const before = this.parseLine(original, { filePath: '', line: 0 });
    if (!before) return invalid('invalid-task-syntax');

    let current = before;
    let content = original;
    const changedFields = new Set<TaskValidationField>(requestedFields);
    for (const edit of edits) {
      const prepared = this.prepareLineEdit(current, edit);
      if (prepared.type === 'invalid') return prepared;
      if (prepared.type === 'unchanged') continue;
      content = prepared.content;
      for (const field of prepared.fields) changedFields.add(field);
      const reparsed = this.parseLine(content, { filePath: '', line: 0 });
      if (!reparsed) return invalid('invalid-task-syntax');
      if (edit.type === 'set-title' || edit.type === 'append-title' || edit.type === 'edit-link') {
        const titleIssues = this.introducedTitleIssues(current, reparsed);
        if (titleIssues.length > 0) return { type: 'invalid', issues: titleIssues };
      }
      current = reparsed;
    }
    const issues = validateTaskChange(this.validationState(current), changedFields);
    if (issues.length > 0) return { type: 'invalid', issues };
    return content === original
      ? { type: 'unchanged', content: original }
      : { type: 'changed', content };
  }

  parseLine(original: string, source: ParseSource): ParsedTaskLine | null {
    const lineEnding = lineEndingOf(original);
    const contentEnd = original.length - lineEnding.length;
    const content = original.slice(0, contentEnd);
    const taskMatch = TASK_LINE_RE.exec(content);
    if (!taskMatch) return null;

    const statusSymbol = taskMatch[1] ?? '';
    const prefixEnd = taskMatch[0].length;
    const body = content.slice(prefixEnd);
    const inlineCodeInBody = inlineCodeRanges(body);
    const links = parseLinks(body);
    const inlineCode = inlineCodeInBody.map((range) => ({
      from: prefixEnd + range.from,
      to: prefixEnd + range.to,
    }));
    const linkRanges = links.map((link) => ({
      from: prefixEnd + link.index,
      to: prefixEnd + link.index + link.raw.length,
    }));
    const atomicBodyRanges = mergedRanges([
      ...inlineCodeInBody,
      ...links.map((link) => ({ from: link.index, to: link.index + link.raw.length })),
    ]);
    let candidates: Candidate[] = [];

    for (const pattern of DATE_PATTERNS) {
      pushPatternCandidates(candidates, body, prefixEnd, pattern.kind, pattern.regex, 1);
    }
    pushPatternCandidates(candidates, body, prefixEnd, 'on-completion', ON_COMPLETION_RE, 1);
    pushTagCandidates(candidates, body, prefixEnd);
    pushPatternCandidates(candidates, body, prefixEnd, 'priority', PRIORITY_RE);
    pushPatternCandidates(candidates, body, prefixEnd, 'time', TIME_RE, 1);
    pushBlockIdCandidates(candidates, body, prefixEnd);
    pushPinnedCarrierCandidates(candidates, body, prefixEnd, '🆔', TASK_ID_RE, 'task-id');
    pushPinnedCarrierCandidates(candidates, body, prefixEnd, '⛔', DEPENDS_ON_RE, 'depends-on');

    for (const match of matches(DURATION_RE, body)) {
      if (
        match[1] === undefined &&
        match[2] === undefined &&
        match[3] === undefined &&
        match[4] === undefined
      )
        continue;
      const hours = match[1] ?? match[3];
      const minutes = match[2] ?? match[4];
      candidates.push({
        kind: 'duration',
        from: prefixEnd + match.index,
        to: prefixEnd + match.index + match[0].length,
        ...(durationMinutes(hours, minutes) !== undefined
          ? { value: durationMinutes(hours, minutes) }
          : {}),
      });
    }

    const atomicTitleCandidates: Candidate[] = [
      ...inlineCode.map((range) => ({ kind: 'title' as const, ...range })),
      ...linkRanges.map((range) => ({ kind: 'title' as const, ...range })),
    ].sort((left, right) => left.from - right.from || left.to - right.to);
    const atomicTitleRanges = atomicBodyRanges.map((range) => ({
      from: prefixEnd + range.from,
      to: prefixEnd + range.to,
    }));
    candidates.sort((left, right) => left.from - right.from || left.to - right.to);
    candidates = excludeOverlappingRanges(candidates, atomicTitleRanges);
    const terminalCaret = terminalCaretRange(body, atomicBodyRanges);
    let malformedTerminal: Candidate | undefined;
    if (terminalCaret) {
      const terminalRange = {
        from: prefixEnd + terminalCaret.from,
        to: prefixEnd + terminalCaret.to,
      };
      const isAtomicTitle = containsSortedPoint(terminalRange.from, atomicTitleRanges);
      const isValidBlock = includesExactCandidate(candidates, terminalRange, 'block-id');
      if (!isAtomicTitle && !isValidBlock) {
        malformedTerminal = {
          kind: 'malformed-known',
          malformedKind: 'block-id',
          ...terminalRange,
        };
        candidates = excludeOverlappingRanges(candidates, [terminalRange]);
        candidates.push(malformedTerminal);
      }
    }
    candidates.push(...atomicTitleCandidates);
    const recurrenceExcluded = mergedRanges([
      ...atomicTitleRanges,
      ...(malformedTerminal ? [malformedTerminal] : []),
    ]);
    const recurrenceMarkerRanges = matches(RECURRENCE_MARKER_RE, body).map((match) => ({
      at: match.index,
      from: prefixEnd + match.index,
      to: prefixEnd + match.index + '🔁'.length,
    }));
    const recurrenceMarkers = excludeOverlappingRanges(
      recurrenceMarkerRanges,
      recurrenceExcluded,
    ).map(({ at }) => at);
    const knownMarkers = markerPositions(body);
    const boundaries = sortedUnique([
      ...candidates.map((candidate) => candidate.from - prefixEnd),
      ...knownMarkers.map(({ at }) => at),
      ...recurrenceMarkers,
    ]);
    pushRecurrenceCandidates(candidates, body, prefixEnd, recurrenceMarkers, boundaries);
    pushMalformedKnownCandidates(candidates, body, prefixEnd, knownMarkers, boundaries);

    candidates.sort((left, right) => left.from - right.from || left.to - right.to);
    const accepted: Candidate[] = [];
    let acceptedTo = prefixEnd;
    for (const candidate of candidates) {
      if (candidate.from < acceptedTo || candidate.to > contentEnd) continue;
      accepted.push(candidate);
      acceptedTo = candidate.to;
    }

    const spans: SourceSpan[] = [{ kind: 'prefix', from: 0, to: prefixEnd }];
    let cursor = prefixEnd;
    for (const candidate of accepted) {
      addGapSpans(spans, original, cursor, candidate.from);
      spans.push({
        kind: candidate.kind,
        from: candidate.from,
        to: candidate.to,
        ...(candidate.malformedKind !== undefined && {
          malformedKind: candidate.malformedKind,
        }),
      });
      cursor = candidate.to;
    }
    addGapSpans(spans, original, cursor, contentEnd);
    if (lineEnding) spans.push({ kind: 'separator', from: contentEnd, to: original.length });

    const occurrences = new Map<TaskSpanKind, SourceSpan[]>();
    for (const span of spans) {
      const group = occurrences.get(span.kind) ?? [];
      group.push(span);
      occurrences.set(span.kind, group);
    }

    const markdownTitle = semanticTitleFragments(spans, contentEnd)
      .map((fragment) => original.slice(fragment.from, fragment.to))
      .join(' ')
      .replace(/\s{2,}/gu, ' ')
      .trim();

    const priorityCandidates = accepted
      .filter((candidate) => candidate.kind === 'priority')
      .map((candidate) => PRIORITY_BY_MARKER[original.slice(candidate.from, candidate.to)])
      .filter((priority): priority is TaskPriority => priority !== undefined);
    const priority =
      PRIORITY_PRECEDENCE.find((candidate) => priorityCandidates.includes(candidate)) ?? 'D';

    const firstDuration = accepted.find((candidate) => candidate.kind === 'duration');
    const duration =
      firstDuration && typeof firstDuration.value === 'number' ? firstDuration.value : undefined;
    const planning: ParsedTaskLine['planning'] = {
      ...(firstString(accepted, 'due') !== undefined && { due: firstString(accepted, 'due') }),
      ...(firstString(accepted, 'created') !== undefined && {
        created: firstString(accepted, 'created'),
      }),
      ...(firstString(accepted, 'scheduled') !== undefined && {
        scheduled: firstString(accepted, 'scheduled'),
      }),
      ...(firstString(accepted, 'start') !== undefined && {
        start: firstString(accepted, 'start'),
      }),
      ...(firstString(accepted, 'completion') !== undefined && {
        completion: firstString(accepted, 'completion'),
      }),
      ...(firstString(accepted, 'cancelled') !== undefined && {
        cancelled: firstString(accepted, 'cancelled'),
      }),
      ...(firstString(accepted, 'time') !== undefined && { time: firstString(accepted, 'time') }),
      ...(typeof duration === 'number' && { duration }),
    };

    const completionPolicy = completionPolicyFrom(accepted);
    return {
      original,
      lineEnding,
      statusSymbol,
      markdownTitle,
      title: collapseLinks(markdownTitle),
      tags: accepted
        .filter((candidate) => candidate.kind === 'tag')
        .map((candidate) => original.slice(candidate.from, candidate.to)),
      spans,
      occurrences,
      planning,
      priority,
      recurrence: firstString(accepted, 'recurrence'),
      ...completionPolicy,
      source: { ...source, originalMarkdown: original },
    };
  }
}
