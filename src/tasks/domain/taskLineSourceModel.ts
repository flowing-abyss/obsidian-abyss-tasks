import type { OnCompletion, TaskPriority } from './types';

export type TaskLineSourceSpanKind =
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

export interface TaskLineSourceSpan {
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
    const delimiter = '`'.repeat(runLength);
    let close = source.indexOf(delimiter, open + runLength);
    while (close >= 0 && (source[close - 1] === '`' || source[close + runLength] === '`')) {
      close = source.indexOf(delimiter, close + 1);
    }
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
  while (cursor.index < ranges.length && ranges[cursor.index]!.to <= at) cursor.index++;
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
  candidates.sort((left, right) => left.index - right.index || right.raw.length - left.raw.length);
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
  candidates: Candidate[],
  body: string,
  bodyFrom: number,
  kind: TaskLineSourceSpanKind,
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

function mergedRanges(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.from > previous.to) {
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

function malformedValueEnd(
  body: string,
  valueFrom: number,
  boundary: number,
  kind: NonNullable<TaskLineSourceSpan['malformedKind']>,
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
  for (const { at, marker, kind } of markers) {
    const absoluteFrom = bodyFrom + at;
    while (
      protectedIndex < protectedRanges.length &&
      protectedRanges[protectedIndex]!.to <= absoluteFrom
    ) {
      protectedIndex++;
    }
    const protectedRange = protectedRanges[protectedIndex];
    if (
      protectedRange &&
      absoluteFrom < protectedRange.to &&
      absoluteFrom + marker.length > protectedRange.from
    ) {
      continue;
    }
    let markerEnd = at + marker.length;
    if ((kind === 'task-id' || kind === 'depends-on') && body[markerEnd] === '\ufe0f') markerEnd++;
    let valueFrom = markerEnd;
    while (/\s/u.test(body[valueFrom] ?? '')) valueFrom++;
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! < valueFrom) {
      boundaryIndex++;
    }
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

function semanticTitleFragments(
  spans: readonly TaskLineSourceSpan[],
  contentEnd: number,
): readonly TaskLineSourceSpan[] {
  const fragments: TaskLineSourceSpan[] = [];
  let fragmentFrom: number | undefined;
  let fragmentTo: number | undefined;
  for (const span of spans) {
    if (span.kind === 'prefix' || (span.kind === 'separator' && span.from === contentEnd)) continue;
    if (span.kind === 'title' || span.kind === 'unknown') {
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

export function parseTaskLineSourceModel(original: string): TaskLineSourceModel | null {
  const lineEnding = lineEndingOf(original);
  const contentEnd = original.length - lineEnding.length;
  const content = original.slice(0, contentEnd);
  const taskMatch = TASK_LINE_RE.exec(content);
  if (!taskMatch) return null;
  const statusSymbol = taskMatch[1] ?? '';
  const prefixEnd = taskMatch[0].length;
  const body = content.slice(prefixEnd);
  const inlineCodeInBody = inlineCodeRanges(body);
  const links = parseLinkRanges(body);
  const atomicBodyRanges = mergedRanges([...inlineCodeInBody, ...links]);
  const atomicTitleRanges = atomicBodyRanges.map((range) => ({
    from: prefixEnd + range.from,
    to: prefixEnd + range.to,
  }));
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
    if ([match[1], match[2], match[3], match[4]].every((value) => value === undefined)) continue;
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

  candidates.sort((left, right) => left.from - right.from || left.to - right.to);
  candidates = excludeOverlappingRanges(candidates, atomicTitleRanges);
  const terminalCaret = terminalCaretRange(body, atomicBodyRanges);
  let malformedTerminal: Candidate | undefined;
  if (terminalCaret) {
    const terminalRange = {
      from: prefixEnd + terminalCaret.from,
      to: prefixEnd + terminalCaret.to,
    };
    const validBlock = includesExactCandidate(candidates, terminalRange, 'block-id');
    if (!containsSortedPoint(terminalRange.from, atomicTitleRanges) && !validBlock) {
      malformedTerminal = {
        kind: 'malformed-known',
        malformedKind: 'block-id',
        ...terminalRange,
      };
      candidates = excludeOverlappingRanges(candidates, [terminalRange]);
      candidates.push(malformedTerminal);
    }
  }
  candidates.push(...atomicTitleRanges.map((range) => ({ kind: 'title' as const, ...range })));
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
  const boundaries = candidateBoundaries(candidates, knownMarkers, recurrenceMarkers, prefixEnd);
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

  const spans: TaskLineSourceSpan[] = [{ kind: 'prefix', from: 0, to: prefixEnd }];
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

  const occurrences = new Map<TaskLineSourceSpanKind, TaskLineSourceSpan[]>();
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
  const durationCarrier = accepted.find((candidate) => candidate.kind === 'duration');
  const duration =
    durationCarrier && typeof durationCarrier.value === 'number'
      ? durationCarrier.value
      : undefined;
  const planning: TaskLineSourceModel['planning'] = {
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
    ...(duration !== undefined && { duration }),
  };
  const onCompletionValue = firstString(accepted, 'on-completion')?.toLowerCase();
  const onCompletion: OnCompletion = onCompletionValue === 'delete' ? 'delete' : 'keep';
  return {
    original,
    lineEnding,
    contentEnd,
    statusSymbol,
    statusAt: prefixEnd - 2,
    markdownTitle,
    tags: accepted
      .filter((candidate) => candidate.kind === 'tag')
      .map((candidate) => original.slice(candidate.from, candidate.to)),
    spans,
    carriers: accepted,
    occurrences,
    planning,
    priority,
    recurrence: firstString(accepted, 'recurrence'),
    onCompletion,
    onCompletionExplicit: onCompletionValue !== undefined,
  };
}
