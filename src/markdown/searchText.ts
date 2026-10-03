import { inlineCodeRanges, type SourceRange } from './inlineCode';
import { searchLinkSpans } from './links';
import type {
  SearchLinkSpan,
  SearchTextMapRun,
  SearchTextProjection,
  SearchTextValue,
} from './searchTextTypes';
export type { SearchTextMapRun, SearchTextProjection, SearchTextValue } from './searchTextTypes';

interface Piece {
  readonly text: string;
  readonly source: readonly SourceRange[];
  readonly delimiter?: boolean;
}
interface Replacement {
  readonly range: SourceRange;
  readonly pieces: readonly Piece[];
  readonly destination?: SearchTextValue;
}
const punctuation = /^[!-/:-@[-`{-~]$/u;

function appendRange(ranges: SourceRange[], range: SourceRange): void {
  const last = ranges[ranges.length - 1];
  if (last?.to === range.from) ranges[ranges.length - 1] = { from: last.from, to: range.to };
  else if (last?.from !== range.from || last.to !== range.to) ranges.push(range);
}
export function searchTextSourceRanges(
  value: SearchTextValue,
  visible: SourceRange,
): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const run of value.map) {
    const from = Math.max(visible.from, run.visible.from),
      to = Math.min(visible.to, run.visible.to);
    if (from >= to) continue;
    const source = run.source[0];
    if (
      run.source.length === 1 &&
      source !== undefined &&
      source.to - source.from === run.visible.to - run.visible.from
    ) {
      appendRange(ranges, {
        from: source.from + from - run.visible.from,
        to: source.from + to - run.visible.from,
      });
    } else for (const range of run.source) appendRange(ranges, range);
  }
  return ranges;
}
function valueOf(pieces: readonly Piece[]): SearchTextValue {
  const chunks: string[] = [];
  let length = 0;
  const map: SearchTextMapRun[] = [];
  for (const piece of pieces) {
    if (piece.text === '') continue;
    const from = length;
    chunks.push(piece.text);
    length += piece.text.length;
    const next = { visible: { from, to: length }, source: piece.source };
    const merged = mergeIdentityRuns(map[map.length - 1], next);
    if (merged === undefined) map.push(next);
    else map[map.length - 1] = merged;
  }
  return { text: chunks.join(''), map };
}
function identitySource(run: SearchTextMapRun): SourceRange | undefined {
  const source = run.source[0];
  return run.source.length === 1 &&
    source !== undefined &&
    source.to - source.from === run.visible.to - run.visible.from
    ? source
    : undefined;
}
function mergeIdentityRuns(
  previous: SearchTextMapRun | undefined,
  next: SearchTextMapRun,
): SearchTextMapRun | undefined {
  if (previous === undefined) return undefined;
  const a = identitySource(previous),
    b = identitySource(next);
  if (a === undefined || a.to !== b?.from) return undefined;
  return {
    visible: { from: previous.visible.from, to: next.visible.to },
    source: [{ from: a.from, to: b.to }],
  };
}
function piecesOf(value: SearchTextValue): Piece[] {
  return value.map.map((run) => ({
    text: value.text.slice(run.visible.from, run.visible.to),
    source: run.source,
  }));
}
function codePieces(source: string, range: SourceRange, offset: number): Piece[] {
  let delimiter = 1;
  while (source[range.from + delimiter] === '`') delimiter++;
  let from = range.from + delimiter,
    to = range.to - delimiter;
  const raw = source.slice(from, to);
  // Trim one normalized space at either edge, accounting for a CRLF's two source units.
  if (/^[ \r\n]/u.test(raw) && /[ \r\n]$/u.test(raw) && /[^ \r\n]/u.test(raw)) {
    from += raw.startsWith('\r\n') ? 2 : 1;
    to -= raw.endsWith('\r\n') ? 2 : 1;
  }
  return normalizedCodePieces(source.slice(from, to), offset + from);
}
function identityPiece(source: string, from: number, to: number, offset: number): Piece {
  return { text: source.slice(from, to), source: [{ from: offset + from, to: offset + to }] };
}
function normalizedCodePieces(source: string, offset: number): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const newline of source.matchAll(/\r\n|[\r\n]/gu)) {
    if (at < newline.index) pieces.push(identityPiece(source, at, newline.index, offset));
    at = newline.index + newline[0].length;
    pieces.push({ text: ' ', source: [{ from: offset + newline.index, to: offset + at }] });
  }
  if (at < source.length) pieces.push(identityPiece(source, at, source.length, offset));
  return pieces;
}

interface Delimiter {
  readonly char: string;
  readonly start: number;
  readonly length: number;
  remaining: number;
  readonly open: boolean;
  readonly close: boolean;
}
function whitespace(char: string): boolean {
  return char === '' || /\s/u.test(char);
}
function punct(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char);
}
function leftFlanking(outer: string, inner: string): boolean {
  return !whitespace(inner) && (!punct(inner) || whitespace(outer) || punct(outer));
}
function flanking(char: string, previous: string, next: string): { open: boolean; close: boolean } {
  const before = [...previous].pop() ?? '',
    after = [...next][0] ?? '';
  const left = leftFlanking(before, after),
    right = leftFlanking(after, before);
  return {
    open: left && (char !== '_' || !right || punct(before)),
    close: right && (char !== '_' || !left || punct(after)),
  };
}
function canPair(opener: Delimiter, closer: Delimiter): boolean {
  if (opener.char !== closer.char || opener.remaining === 0) return false;
  return (
    closer.char === '~' ||
    !(opener.close || closer.open) ||
    (opener.length + closer.length) % 3 !== 0 ||
    (opener.length % 3 === 0 && closer.length % 3 === 0)
  );
}
function consumeDelimiterPair(opener: Delimiter, closer: Delimiter, removed: Set<number>): void {
  const used = Math.min(opener.remaining, closer.remaining) >= 2 ? 2 : 1;
  for (let i = 0; i < used; i++) {
    removed.add(opener.start + opener.remaining - 1 - i);
    removed.add(closer.start + closer.length - closer.remaining + i);
  }
  opener.remaining -= used;
  closer.remaining -= used;
}
function sameDelimiter(piece: Piece | undefined, char: string): boolean {
  return piece?.delimiter === true && piece.text === char;
}
function closeDelimiter(closer: Delimiter, stack: Delimiter[], removed: Set<number>): void {
  while (closer.close && closer.remaining > 0) {
    let index = stack.length - 1;
    while (index >= 0 && !canPair(stack[index] as Delimiter, closer)) index--;
    const opener = stack[index];
    if (opener === undefined) break;
    consumeDelimiterPair(opener, closer, removed);
    stack.splice(index + Number(opener.remaining > 0));
  }
}
function authoredFlanking(
  source: string,
  offset: number,
  run: readonly Piece[],
): { open: boolean; close: boolean } {
  const first = run[0],
    last = run[run.length - 1];
  const from = (first?.source[0]?.from ?? offset) - offset;
  const to = (last?.source[0]?.to ?? offset) - offset;
  return flanking(
    first?.text ?? '',
    source.slice(Math.max(0, from - 2), from),
    source.slice(to, to + 2),
  );
}
function delimiterRuns(pieces: readonly Piece[], source: string, offset: number): Delimiter[] {
  const runs: Delimiter[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece?.delimiter !== true) continue;
    const start = i,
      char = piece.text;
    while (sameDelimiter(pieces[i + 1], char)) i++;
    const length = i - start + 1;
    if (char === '~' && length !== 2) continue;
    runs.push({
      char,
      start,
      length,
      remaining: length,
      ...authoredFlanking(source, offset, pieces.slice(start, i + 1)),
    });
  }
  return runs;
}
function balancedPieces(
  pieces: readonly Piece[],
  source: string,
  offset: number,
): readonly Piece[] {
  const stack: Delimiter[] = [],
    removed = new Set<number>();
  for (const closer of delimiterRuns(pieces, source, offset)) {
    closeDelimiter(closer, stack, removed);
    if (closer.open && closer.remaining > 0) stack.push(closer);
  }
  return removed.size === 0 ? pieces : pieces.filter((_, index) => !removed.has(index));
}
function literalPiece(source: string, start: number, offset: number): Piece {
  let at = start;
  const from = at;
  let text = source[at] ?? '';
  const escaped = text === '\\' && punctuation.test(source[at + 1] ?? '');
  if (escaped) text = source[++at] ?? '';
  return {
    text,
    source: [{ from: offset + from, to: offset + at + 1 }],
    delimiter: !escaped && '*_~'.includes(text),
  };
}
function appendLiteralPieces(pieces: Piece[], source: string, offset: number): void {
  // Only syntax can split an identity run. The same pass handles prose and Markdown labels.
  const boundaries = /[\\*_~]/gu;
  let at = 0;
  for (const boundary of source.matchAll(boundaries)) {
    if (boundary.index < at) continue; // A punctuation escape already consumed this delimiter.
    if (at < boundary.index) pieces.push(identityPiece(source, at, boundary.index, offset));
    const piece = literalPiece(source, boundary.index, offset);
    pieces.push(piece);
    at = (piece.source[0]?.to ?? offset + boundary.index + 1) - offset;
  }
  if (at < source.length) pieces.push(identityPiece(source, at, source.length, offset));
}
function inlineProjection(
  source: string,
  offset: number,
  replacements: readonly Replacement[],
): SearchTextValue {
  const pieces: Piece[] = [];
  let at = 0;
  for (const replacement of replacements) {
    appendLiteralPieces(pieces, source.slice(at, replacement.range.from), offset + at);
    for (const piece of replacement.pieces) pieces.push(piece);
    at = replacement.range.to;
  }
  appendLiteralPieces(pieces, source.slice(at), offset + at);
  return valueOf(balancedPieces(pieces, source, offset));
}
function escapedAt(source: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}
function htmlTagEnd(source: string, start: number): number {
  let at = start;
  const attribute = /\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*)?/uy;
  const value = /"[^"]*"|'[^']*'|[^\s"'=<>`]+/uy;
  const close = /\s*\/?>/uy;
  while (at < source.length) {
    close.lastIndex = at;
    if (close.test(source)) return close.lastIndex;
    attribute.lastIndex = at;
    const match = attribute.exec(source);
    if (match === null) return -1;
    at = attribute.lastIndex;
    if (/=\s*$/u.test(match[0])) {
      value.lastIndex = at;
      if (!value.test(source)) return -1;
      at = value.lastIndex;
    }
  }
  return -1;
}
function proseHtml(source: string): Replacement[] {
  // Recognize tag/comment scaffolding only; malformed syntax remains literal.
  const output: Replacement[] = [];
  const open = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*/gu;
  for (const match of source.matchAll(open)) {
    if (escapedAt(source, match.index)) continue;
    const to = match[0].startsWith('<!--')
      ? match.index + match[0].length
      : htmlTagEnd(source, match.index + match[0].length);
    if (to > match.index) output.push({ range: { from: match.index, to }, pieces: [] });
  }
  return output;
}
function codeReplacements(source: string, offset: number): Replacement[] {
  return inlineCodeRanges(source).map((range) => ({
    range,
    pieces: codePieces(source, range, offset),
  }));
}
function linkReplacement(link: SearchLinkSpan): Replacement {
  let label = link.label;
  if (link.kind === 'markdown') {
    const from = link.label.map[0]?.source[0]?.from ?? link.source.from;
    label = inlineProjection(link.label.text, from, codeReplacements(link.label.text, from));
  }
  return { range: link.source, pieces: piecesOf(label), destination: link.destination };
}
function nonOverlapping(replacements: Replacement[]): Replacement[] {
  replacements.sort((a, b) => {
    const start = a.range.from - b.range.from;
    return start === 0 ? b.range.to - a.range.to : start;
  });
  const accepted: Replacement[] = [];
  let end = 0;
  for (const replacement of replacements) {
    if (replacement.range.from < end) continue;
    accepted.push(replacement);
    end = replacement.range.to;
  }
  return accepted;
}
export function projectSearchText(
  source: string,
  presentation: 'title' | 'prose',
): SearchTextProjection {
  const replacements = [
    ...codeReplacements(source, 0),
    ...searchLinkSpans(source).map(linkReplacement),
  ];
  if (presentation === 'prose') replacements.push(...proseHtml(source));
  const accepted = nonOverlapping(replacements);
  return {
    visible: inlineProjection(source, 0, accepted),
    destinations: accepted.flatMap((item) =>
      item.destination === undefined ? [] : [item.destination],
    ),
  };
}
