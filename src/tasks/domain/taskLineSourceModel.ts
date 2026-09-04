import type { OnCompletion, TaskPriority } from './types';

type TaskLineSourceSpanKind =
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

interface TaskLineSourceSpan {
  readonly kind: TaskLineSourceSpanKind;
  readonly from: number;
  readonly to: number;
  readonly malformedKind?: Exclude<
    TaskLineSourceSpanKind,
    'prefix' | 'title' | 'tag' | 'malformed-known' | 'separator' | 'unknown'
  >;
}

export interface TaskLineSourceCarrier extends TaskLineSourceSpan {
  readonly value?: string | number;
}

export interface TaskLineSourceModel {
  readonly original: string;
  readonly lineEnding: '' | '\n' | '\r\n';
  readonly contentEnd: number;
  readonly statusSymbol: string;
  readonly statusAt: number;
  readonly markdownTitle: string;
  readonly tags: readonly string[];
  readonly dependencyId?: string;
  readonly dependsOn: readonly string[];
  readonly spans: readonly TaskLineSourceSpan[];
  readonly carriers: readonly TaskLineSourceCarrier[];
  readonly occurrences: ReadonlyMap<TaskLineSourceSpanKind, readonly TaskLineSourceSpan[]>;
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
}

interface SourceRange {
  readonly from: number;
  readonly to: number;
}

type Candidate = TaskLineSourceCarrier;

interface LinkRange extends SourceRange {
  readonly index: number;
  readonly raw: string;
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
  readonly kind: NonNullable<TaskLineSourceSpan['malformedKind']>;
}>;
const PRIORITY_BY_MARKER: Readonly<Record<string, TaskPriority>> = {
  '🔺': 'A',
  '⏫': 'B',
  '🔼': 'C',
  '🔽': 'E',
  '⏬': 'F',
};
const PRIORITY_PRECEDENCE: readonly TaskPriority[] = ['A', 'B', 'C', 'E', 'F'];
const UNKNOWN_PICTOGRAPH_RE = /\p{Extended_Pictographic}/u;

function isEscaped(source: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

function closingBacktick(source: string, open: number, runLength: number): number {
  const delimiter = '`'.repeat(runLength);
  let close = source.indexOf(delimiter, open + runLength);
  while (close >= 0 && (source[close - 1] === '`' || source[close + runLength] === '`')) {
    close = source.indexOf(delimiter, close + 1);
  }
  return close;
}

function inlineCodeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('`', cursor);
    if (open < 0) break;
    if (isEscaped(source, open)) {
      cursor = open + 1;
      continue;
    }
    let runLength = 1;
    while (source[open + runLength] === '`') runLength++;
    const close = closingBacktick(source, open, runLength);
    if (close < 0) {
      cursor = open + runLength;
      continue;
    }
    ranges.push({ from: open, to: close + runLength });
    cursor = close + runLength;
  }
  return ranges;
}

function insideOrderedRange(
  at: number,
  ranges: readonly SourceRange[],
  cursor: { index: number },
): boolean {
  while ((ranges[cursor.index]?.to ?? Number.POSITIVE_INFINITY) <= at) cursor.index++;
  const range = ranges[cursor.index];
  return range !== undefined && at >= range.from && at < range.to;
}

function parseLinkRanges(input: string): readonly LinkRange[] {
  const candidates: LinkRange[] = [];
  const inlineCode = inlineCodeRanges(input);
  const wiki = /(?<!!)\[\[((?:\\.|[^|[\]])+)(?:\|((?:\\.|[^[\]])+))?\]\]/gu;
  const markdown = /(?<!!)\[((?:\\.|[^[\]])+)\]\(((?:\\.|[^)])+)\)/gu;
  let match: RegExpExecArray | null;
  const wikiCursor = { index: 0 };
  while ((match = wiki.exec(input)) !== null) {
    if (isEscaped(input, match.index) || insideOrderedRange(match.index, inlineCode, wikiCursor)) {
      continue;
    }
    candidates.push({
      from: match.index,
      to: match.index + match[0].length,
      index: match.index,
      raw: match[0],
    });
  }
  const markdownCursor = { index: 0 };
  while ((match = markdown.exec(input)) !== null) {
    if (
      isEscaped(input, match.index) ||
      insideOrderedRange(match.index, inlineCode, markdownCursor)
    ) {
      continue;
    }
    candidates.push({
      from: match.index,
      to: match.index + match[0].length,
      index: match.index,
      raw: match[0],
    });
  }
  candidates.sort((left, right) => {
    const indexOrder = left.index - right.index;
    return indexOrder !== 0 ? indexOrder : right.raw.length - left.raw.length;
  });
  const ordered = candidates;
  const accepted: LinkRange[] = [];
  let acceptedTo = 0;
  for (const candidate of ordered) {
    if (candidate.index < acceptedTo) continue;
    accepted.push(candidate);
    acceptedTo = candidate.to;
  }
  return accepted;
}

function matches(regex: RegExp, text: string): RegExpExecArray[] {
  regex.lastIndex = 0;
  const result: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) result.push(match);
  return result;
}

function pushPatternCandidates(
  ...args: [
    candidates: Candidate[],
    body: string,
    bodyFrom: number,
    kind: TaskLineSourceSpanKind,
    regex: RegExp,
    valueGroup?: number,
  ]
): void {
  const [candidates, body, bodyFrom, kind, regex, valueGroup] = args;
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

function mergedRanges(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const sorted = [...ranges].sort((left, right) => {
    const startOrder = left.from - right.from;
    return startOrder !== 0 ? startOrder : left.to - right.to;
  });
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous == null || range.from > previous.to) {
      merged.push(range);
    } else if (range.to > previous.to) {
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
    while ((sortedExclusions[exclusionIndex]?.to ?? Number.POSITIVE_INFINITY) <= candidate.from) {
      exclusionIndex++;
    }
    const exclusion = sortedExclusions[exclusionIndex];
    if (exclusion != null && candidate.from < exclusion.to && candidate.to > exclusion.from)
      continue;
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
  kind: TaskLineSourceSpanKind,
): boolean {
  for (const candidate of sortedCandidates) {
    if (candidate.from > range.from) return false;
    if (candidate.kind === kind && candidate.from === range.from && candidate.to === range.to) {
      return true;
    }
  }
  return false;
}

function pushTagCandidates(candidates: Candidate[], body: string, bodyFrom: number): void {
  for (const match of matches(TAG_RE, body)) {
    candidates.push({
      kind: 'tag',
      from: bodyFrom + match.index,
      to: bodyFrom + match.index + match[0].length,
    });
  }
}

function pushPinnedCarrierCandidates(
  ...args: [
    candidates: Candidate[],
    body: string,
    bodyFrom: number,
    marker: '🆔' | '⛔',
    regex: RegExp,
    kind: 'task-id' | 'depends-on',
  ]
): void {
  const [candidates, body, bodyFrom, marker, regex, kind] = args;
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const markerAt = body.indexOf(marker, searchFrom);
    if (markerAt < 0) break;
    regex.lastIndex = markerAt;
    const match = regex.exec(body);
    if (match?.index === markerAt) {
      const value = match[1];
      candidates.push({
        kind,
        from: bodyFrom + markerAt,
        to: bodyFrom + markerAt + match[0].length,
        ...(value !== undefined && { value }),
      });
    }
    searchFrom = markerAt + marker.length;
  }
}

function markerPositions(body: string): ReadonlyArray<{
  readonly at: number;
  readonly marker: string;
  readonly kind: NonNullable<TaskLineSourceSpan['malformedKind']>;
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
  while (to > 0 && /\s/u.test(body[to - 1] ?? '')) to--;
  const from = terminalTokenStart(body, to, sortedAtomicRanges);
  return body[from] === '^' ? { from, to } : undefined;
}

function terminalTokenStart(
  body: string,
  end: number,
  sortedAtomicRanges: readonly SourceRange[],
): number {
  let from = end;
  let atomicIndex = sortedAtomicRanges.length - 1;
  while (from > 0) {
    while (atomicIndex >= 0) {
      const atomic = sortedAtomicRanges[atomicIndex];
      if (atomic === undefined || atomic.to <= from) break;
      atomicIndex--;
    }
    const atomic = sortedAtomicRanges[atomicIndex];
    if (atomic?.to === from) {
      from = atomic.from;
      atomicIndex--;
      continue;
    }
    if (/\s/u.test(body[from - 1] ?? '')) break;
    from--;
  }
  return from;
}

function malformedValueEnd(
  body: string,
  valueFrom: number,
  boundary: number,
  kind: NonNullable<TaskLineSourceSpan['malformedKind']>,
): number {
  let to = valueFrom;
  while (to < boundary && !/\s/u.test(body[to] ?? '')) to++;
  return kind === 'depends-on' ? dependsOnValueEnd(body, to, boundary) : to;
}

function dependsOnValueEnd(body: string, initialTo: number, boundary: number): number {
  let to = initialTo;
  while (to < boundary) {
    let next = to;
    while (next < boundary && /\s/u.test(body[next] ?? '')) next++;
    if (!continuesDependsOnValue(body, to, next, boundary)) break;
    to = next;
    while (to < boundary && !/\s/u.test(body[to] ?? '')) to++;
  }
  return to;
}

function continuesDependsOnValue(
  body: string,
  currentEnd: number,
  next: number,
  boundary: number,
): boolean {
  return next < boundary && (body[currentEnd - 1] === ',' || body[next] === ',');
}

function pushRecurrenceCandidates(
  ...args: [
    candidates: Candidate[],
    body: string,
    bodyFrom: number,
    recurrenceMarkers: readonly number[],
    boundaries: readonly number[],
  ]
): void {
  const [candidates, body, bodyFrom, recurrenceMarkers, boundaries] = args;
  let boundaryIndex = 0;
  for (const recurrenceAt of recurrenceMarkers) {
    while ((boundaries[boundaryIndex] ?? Number.POSITIVE_INFINITY) <= recurrenceAt) {
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
      ...(rawValue.length > 0 ? { value: rawValue } : {}),
    });
  }
}

function pushMalformedKnownCandidates(
  ...args: [
    candidates: Candidate[],
    body: string,
    bodyFrom: number,
    markers: ReturnType<typeof markerPositions>,
    boundaries: readonly number[],
  ]
): void {
  const [candidates, body, bodyFrom, markers, boundaries] = args;
  const protectedRanges = mergedRanges(candidates);
  let protectedIndex = 0;
  let boundaryIndex = 0;
  for (const { at, marker, kind } of markers) {
    const absoluteFrom = bodyFrom + at;
    protectedIndex = rangeIndexAfter(protectedRanges, protectedIndex, absoluteFrom);
    const protectedRange = protectedRanges[protectedIndex];
    if (overlapsMarker(protectedRange, absoluteFrom, marker.length)) continue;
    const markerEnd = carrierMarkerEnd(body, at, marker, kind);
    const valueFrom = nonWhitespaceIndex(body, markerEnd);
    boundaryIndex = boundaryIndexAtOrAfter(boundaries, boundaryIndex, valueFrom);
    const boundary = boundaries[boundaryIndex] ?? body.length;
    const valueTo = malformedValueEnd(body, valueFrom, boundary, kind);
    candidates.push({
      kind: 'malformed-known',
      malformedKind: kind,
      from: bodyFrom + at,
      to: bodyFrom + (valueTo > valueFrom ? valueTo : markerEnd),
    });
  }
}

function rangeIndexAfter(ranges: readonly SourceRange[], initialIndex: number, at: number): number {
  let index = initialIndex;
  while (index < ranges.length && (ranges[index]?.to ?? Number.POSITIVE_INFINITY) <= at) index++;
  return index;
}

function overlapsMarker(range: SourceRange | undefined, from: number, length: number): boolean {
  return range != null && from < range.to && from + length > range.from;
}

function carrierMarkerEnd(
  body: string,
  at: number,
  marker: string,
  kind: NonNullable<TaskLineSourceSpan['malformedKind']>,
): number {
  const end = at + marker.length;
  const supportsVariation = kind === 'task-id' || kind === 'depends-on';
  return supportsVariation && body[end] === '\ufe0f' ? end + 1 : end;
}

function nonWhitespaceIndex(body: string, initialIndex: number): number {
  let index = initialIndex;
  while (/\s/u.test(body[index] ?? '')) index++;
  return index;
}

function boundaryIndexAtOrAfter(
  boundaries: readonly number[],
  initialIndex: number,
  at: number,
): number {
  let index = initialIndex;
  while ((boundaries[index] ?? Number.POSITIVE_INFINITY) < at) index++;
  return index;
}

function durationMinutes(
  hours: string | undefined,
  minutes: string | undefined,
): number | undefined {
  const total = Number(hours ?? 0) * 60 + Number(minutes ?? 0);
  return total > 0 ? total : undefined;
}

function addGapSpans(
  spans: TaskLineSourceSpan[],
  original: string,
  from: number,
  to: number,
): void {
  let cursor = from;
  while (cursor < to) {
    const whitespace = /\s/u.test(original[cursor] ?? '');
    let end = cursor + 1;
    while (end < to && /\s/u.test(original[end] ?? '') === whitespace) end++;
    let kind: TaskLineSourceSpanKind = 'separator';
    if (!whitespace) {
      kind = UNKNOWN_PICTOGRAPH_RE.test(original.slice(cursor, end)) ? 'unknown' : 'title';
    }
    spans.push({ kind, from: cursor, to: end });
    cursor = end;
  }
}

function ignoresSemanticTitleSpan(span: TaskLineSourceSpan, contentEnd: number): boolean {
  return span.kind === 'prefix' || (span.kind === 'separator' && span.from === contentEnd);
}

function extendsSemanticTitle(span: TaskLineSourceSpan): boolean {
  return span.kind === 'title' || span.kind === 'unknown';
}

function continuesSemanticTitle(
  span: TaskLineSourceSpan,
  fragmentFrom: number | undefined,
): boolean {
  return span.kind === 'separator' && fragmentFrom !== undefined;
}

function titleFragment(
  from: number | undefined,
  to: number | undefined,
): TaskLineSourceSpan | undefined {
  return from === undefined || to === undefined ? undefined : { kind: 'title', from, to };
}

function semanticTitleFragments(
  spans: readonly TaskLineSourceSpan[],
  contentEnd: number,
): readonly TaskLineSourceSpan[] {
  const fragments: TaskLineSourceSpan[] = [];
  let fragmentFrom: number | undefined;
  let fragmentTo: number | undefined;
  for (const span of spans) {
    if (ignoresSemanticTitleSpan(span, contentEnd)) continue;
    if (extendsSemanticTitle(span)) {
      fragmentFrom ??= span.from;
      fragmentTo = span.to;
      continue;
    }
    if (continuesSemanticTitle(span, fragmentFrom)) continue;
    const fragment = titleFragment(fragmentFrom, fragmentTo);
    if (fragment !== undefined) {
      fragments.push(fragment);
      fragmentFrom = undefined;
      fragmentTo = undefined;
    }
  }
  const terminal = titleFragment(fragmentFrom, fragmentTo);
  if (terminal !== undefined) fragments.push(terminal);
  return fragments;
}

function firstString(
  candidates: readonly Candidate[],
  kind: TaskLineSourceSpanKind,
): string | undefined {
  const value = candidates.find((candidate) => candidate.kind === kind)?.value;
  return typeof value === 'string' ? value : undefined;
}

function lineEndingOf(original: string): TaskLineSourceModel['lineEnding'] {
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

function candidateBoundaries(
  candidates: readonly Candidate[],
  knownMarkers: ReturnType<typeof markerPositions>,
  recurrenceMarkers: readonly number[],
  prefixEnd: number,
): readonly number[] {
  return [
    ...new Set([
      ...candidates.map((candidate) => candidate.from - prefixEnd),
      ...knownMarkers.map(({ at }) => at),
      ...recurrenceMarkers,
    ]),
  ].sort((left, right) => left - right);
}

interface TaskLineParseContext {
  readonly original: string;
  readonly lineEnding: TaskLineSourceModel['lineEnding'];
  readonly contentEnd: number;
  readonly statusSymbol: string;
  readonly prefixEnd: number;
  readonly body: string;
  readonly atomicBodyRanges: readonly SourceRange[];
  readonly atomicTitleRanges: readonly SourceRange[];
}

function taskLineParseContext(original: string): TaskLineParseContext | null {
  const lineEnding = lineEndingOf(original);
  const contentEnd = original.length - lineEnding.length;
  const content = original.slice(0, contentEnd);
  const taskMatch = TASK_LINE_RE.exec(content);
  if (taskMatch == null) return null;
  const prefixEnd = taskMatch[0].length;
  const body = content.slice(prefixEnd);
  const atomicBodyRanges = mergedRanges([...inlineCodeRanges(body), ...parseLinkRanges(body)]);
  return {
    original,
    lineEnding,
    contentEnd,
    statusSymbol: taskMatch[1] ?? '',
    prefixEnd,
    body,
    atomicBodyRanges,
    atomicTitleRanges: atomicBodyRanges.map((range) => ({
      from: prefixEnd + range.from,
      to: prefixEnd + range.to,
    })),
  };
}

function pushDurationCandidates(candidates: Candidate[], body: string, prefixEnd: number): void {
  for (const match of matches(DURATION_RE, body)) {
    if ([match[1], match[2], match[3], match[4]].every((value) => value === undefined)) continue;
    const value = durationMinutes(match[1] ?? match[3], match[2] ?? match[4]);
    candidates.push({
      kind: 'duration',
      from: prefixEnd + match.index,
      to: prefixEnd + match.index + match[0].length,
      ...(value !== undefined && { value }),
    });
  }
}

function initialCandidates(body: string, prefixEnd: number): Candidate[] {
  const candidates: Candidate[] = [];
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
  pushDurationCandidates(candidates, body, prefixEnd);
  return candidates;
}

function sortedCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    const startOrder = left.from - right.from;
    return startOrder !== 0 ? startOrder : left.to - right.to;
  });
}

interface TerminalCandidateResult {
  readonly candidates: Candidate[];
  readonly malformed?: Candidate;
}

function withMalformedTerminal(
  context: TaskLineParseContext,
  sourceCandidates: readonly Candidate[],
): TerminalCandidateResult {
  const { body, prefixEnd, atomicBodyRanges, atomicTitleRanges } = context;
  const terminalCaret = terminalCaretRange(body, atomicBodyRanges);
  if (terminalCaret == null) return { candidates: [...sourceCandidates] };
  const terminalRange = {
    from: prefixEnd + terminalCaret.from,
    to: prefixEnd + terminalCaret.to,
  };
  const validBlock = includesExactCandidate(sourceCandidates, terminalRange, 'block-id');
  if (containsSortedPoint(terminalRange.from, atomicTitleRanges) || validBlock) {
    return { candidates: [...sourceCandidates] };
  }
  const malformed: Candidate = {
    kind: 'malformed-known',
    malformedKind: 'block-id',
    ...terminalRange,
  };
  return {
    candidates: [...excludeOverlappingRanges(sourceCandidates, [terminalRange]), malformed],
    malformed,
  };
}

function recurrenceMarkerPositions(
  context: TaskLineParseContext,
  malformed: Candidate | undefined,
): readonly number[] {
  const exclusions = mergedRanges([
    ...context.atomicTitleRanges,
    ...(malformed == null ? [] : [malformed]),
  ]);
  const markerRanges = matches(RECURRENCE_MARKER_RE, context.body).map((match) => ({
    at: match.index,
    from: context.prefixEnd + match.index,
    to: context.prefixEnd + match.index + '🔁'.length,
  }));
  return excludeOverlappingRanges(markerRanges, exclusions).map(({ at }) => at);
}

function collectCandidates(context: TaskLineParseContext): Candidate[] {
  let candidates = excludeOverlappingRanges(
    sortedCandidates(initialCandidates(context.body, context.prefixEnd)),
    context.atomicTitleRanges,
  );
  const terminal = withMalformedTerminal(context, candidates);
  candidates = terminal.candidates;
  candidates.push(
    ...context.atomicTitleRanges.map((range) => ({ kind: 'title' as const, ...range })),
  );
  const recurrenceMarkers = recurrenceMarkerPositions(context, terminal.malformed);
  const knownMarkers = markerPositions(context.body);
  const boundaries = candidateBoundaries(
    candidates,
    knownMarkers,
    recurrenceMarkers,
    context.prefixEnd,
  );
  pushRecurrenceCandidates(
    candidates,
    context.body,
    context.prefixEnd,
    recurrenceMarkers,
    boundaries,
  );
  pushMalformedKnownCandidates(
    candidates,
    context.body,
    context.prefixEnd,
    knownMarkers,
    boundaries,
  );
  return sortedCandidates(candidates);
}

function acceptedCandidates(context: TaskLineParseContext): Candidate[] {
  const accepted: Candidate[] = [];
  let acceptedTo = context.prefixEnd;
  for (const candidate of collectCandidates(context)) {
    if (candidate.from < acceptedTo || candidate.to > context.contentEnd) continue;
    accepted.push(candidate);
    acceptedTo = candidate.to;
  }
  return accepted;
}

function spansFor(
  context: TaskLineParseContext,
  accepted: readonly Candidate[],
): TaskLineSourceSpan[] {
  const spans: TaskLineSourceSpan[] = [{ kind: 'prefix', from: 0, to: context.prefixEnd }];
  let cursor = context.prefixEnd;
  for (const candidate of accepted) {
    addGapSpans(spans, context.original, cursor, candidate.from);
    spans.push({
      kind: candidate.kind,
      from: candidate.from,
      to: candidate.to,
      ...(candidate.malformedKind !== undefined && { malformedKind: candidate.malformedKind }),
    });
    cursor = candidate.to;
  }
  addGapSpans(spans, context.original, cursor, context.contentEnd);
  if (context.lineEnding.length > 0) {
    spans.push({ kind: 'separator', from: context.contentEnd, to: context.original.length });
  }
  return spans;
}

function occurrencesFor(
  spans: readonly TaskLineSourceSpan[],
): ReadonlyMap<TaskLineSourceSpanKind, readonly TaskLineSourceSpan[]> {
  const occurrences = new Map<TaskLineSourceSpanKind, TaskLineSourceSpan[]>();
  for (const span of spans) {
    const group = occurrences.get(span.kind) ?? [];
    group.push(span);
    occurrences.set(span.kind, group);
  }
  return occurrences;
}

function priorityFor(original: string, accepted: readonly Candidate[]): TaskPriority {
  const priorities = accepted
    .filter((candidate) => candidate.kind === 'priority')
    .map((candidate) => PRIORITY_BY_MARKER[original.slice(candidate.from, candidate.to)])
    .filter((priority): priority is TaskPriority => priority !== undefined);
  return PRIORITY_PRECEDENCE.find((candidate) => priorities.includes(candidate)) ?? 'D';
}

type MutablePlanning = {
  -readonly [Key in keyof TaskLineSourceModel['planning']]: TaskLineSourceModel['planning'][Key];
};

function assignPlanningString(
  planning: MutablePlanning,
  field: Exclude<keyof MutablePlanning, 'duration'>,
  value: string | undefined,
): void {
  if (value !== undefined) planning[field] = value;
}

function planningFor(accepted: readonly Candidate[]): TaskLineSourceModel['planning'] {
  const durationCarrier = accepted.find((candidate) => candidate.kind === 'duration');
  const duration = typeof durationCarrier?.value === 'number' ? durationCarrier.value : undefined;
  const planning: MutablePlanning = {};
  assignPlanningString(planning, 'due', firstString(accepted, 'due'));
  assignPlanningString(planning, 'created', firstString(accepted, 'created'));
  assignPlanningString(planning, 'scheduled', firstString(accepted, 'scheduled'));
  assignPlanningString(planning, 'start', firstString(accepted, 'start'));
  assignPlanningString(planning, 'completion', firstString(accepted, 'completion'));
  assignPlanningString(planning, 'cancelled', firstString(accepted, 'cancelled'));
  assignPlanningString(planning, 'time', firstString(accepted, 'time'));
  if (duration !== undefined) planning.duration = duration;
  return planning;
}

function dependsOnFor(accepted: readonly Candidate[]): readonly string[] {
  return (firstString(accepted, 'depends-on') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseTaskLineSourceModel(original: string): TaskLineSourceModel | null {
  const context = taskLineParseContext(original);
  if (context == null) return null;
  const accepted = acceptedCandidates(context);
  const spans = spansFor(context, accepted);
  const occurrences = occurrencesFor(spans);
  const markdownTitle = semanticTitleFragments(spans, context.contentEnd)
    .map((fragment) => original.slice(fragment.from, fragment.to))
    .join(' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  const recurrence = firstString(accepted, 'recurrence');
  const dependencyId = firstString(accepted, 'task-id');
  const onCompletionValue = firstString(accepted, 'on-completion')?.toLowerCase();
  const onCompletion: OnCompletion = onCompletionValue === 'delete' ? 'delete' : 'keep';
  return {
    original,
    lineEnding: context.lineEnding,
    contentEnd: context.contentEnd,
    statusSymbol: context.statusSymbol,
    statusAt: context.prefixEnd - 2,
    markdownTitle,
    tags: accepted
      .filter((candidate) => candidate.kind === 'tag')
      .map((candidate) => original.slice(candidate.from, candidate.to)),
    ...(dependencyId !== undefined && { dependencyId }),
    dependsOn: dependsOnFor(accepted),
    spans,
    carriers: accepted,
    occurrences,
    planning: planningFor(accepted),
    priority: priorityFor(original, accepted),
    ...(recurrence !== undefined && { recurrence }),
    onCompletion,
    onCompletionExplicit: onCompletionValue !== undefined,
  };
}
