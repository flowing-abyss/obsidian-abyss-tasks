import { inputRangesOverlap, inputTextBarriers, validInputRange } from './taskInputGuards';
import type { TaskInputRange } from './taskInputTypes';

export interface InputBody {
  readonly markdownBody: string;
  readonly separators: readonly TaskInputRange[];
  readonly retained: ReadonlyArray<{
    readonly sourceRange: TaskInputRange;
    readonly bodyOffset: number;
  }>;
}
const horizontal = (value: string | undefined): boolean =>
  value !== undefined && /^[^\S\r\n]$/u.test(value);
function onlyHorizontal(raw: string, from: number, to: number): boolean {
  return /^[^\S\r\n]*$/u.test(raw.slice(from, to));
}
function dashEdge(value: string | undefined): boolean {
  return value === undefined || value === '\r' || value === '\n' || horizontal(value);
}
function eligibleColon(raw: string, range: TaskInputRange): boolean {
  const before = raw[range.from - 1],
    after = raw[range.to];
  if (before === ':' || after === ':') return false;
  // A spaced colon glued to authored text is a shortcode/label, not a delimiter.
  return !horizontal(before) || dashEdge(after);
}
function separatorTokens(raw: string, barriers: readonly TaskInputRange[]): TaskInputRange[] {
  const tokens: TaskInputRange[] = [];
  for (const match of raw.matchAll(/[-‐‑‒–—―]+|:/gu)) {
    const range = { from: match.index, to: match.index + match[0].length };
    if (barriers.some((barrier) => inputRangesOverlap(barrier, range))) continue;
    const eligible =
      match[0] === ':'
        ? eligibleColon(raw, range)
        : dashEdge(raw[range.from - 1]) && dashEdge(raw[range.to]);
    if (eligible) tokens.push(range);
  }
  return tokens;
}
function separatorBridge(
  raw: string,
  from: number,
  to: number,
  tokens: readonly TaskInputRange[],
): boolean {
  let cursor = from;
  for (const token of tokens.filter((token) => from <= token.from && token.to <= to)) {
    if (!onlyHorizontal(raw, cursor, token.from)) return false;
    cursor = token.to;
  }
  return onlyHorizontal(raw, cursor, to);
}
function metadataGroups(
  raw: string,
  hidden: readonly TaskInputRange[],
  tokens: readonly TaskInputRange[],
  barriers: readonly TaskInputRange[],
): TaskInputRange[] {
  const groups: Array<{ from: number; to: number }> = [];
  for (const range of hidden
    .filter(
      (range) =>
        validInputRange(raw, range) &&
        !/[\r\n]/u.test(raw.slice(range.from, range.to)) &&
        !barriers.some(
          (barrier) =>
            inputRangesOverlap(barrier, range) &&
            (barrier.from < range.from || range.to < barrier.to),
        ),
    )
    .sort((a, b) => a.from - b.from)) {
    const last = groups[groups.length - 1];
    if (
      last !== undefined &&
      (range.from <= last.to || separatorBridge(raw, last.to, range.from, tokens))
    )
      last.to = Math.max(last.to, range.to);
    else groups.push({ ...range });
  }
  return groups;
}
function lineBounds(raw: string, range: TaskInputRange): TaskInputRange {
  let from = range.from,
    to = range.to;
  while (from > 0 && !/[\r\n]/u.test(raw[from - 1] ?? '')) from--;
  while (to < raw.length && !/[\r\n]/u.test(raw[to] ?? '')) to++;
  return { from, to };
}
function rightSeparatorSpan(
  raw: string,
  metadataTo: number,
  token: TaskInputRange,
): TaskInputRange {
  let to = token.to;
  while (horizontal(raw[to])) to++;
  // Keep one source whitespace unit so active canonical metadata stays tokenized.
  return { from: metadataTo + (horizontal(raw[metadataTo]) ? 1 : 0), to };
}
function leftSeparatorSpan(
  raw: string,
  metadataFrom: number,
  token: TaskInputRange,
): TaskInputRange {
  let from = token.from;
  while (horizontal(raw[from - 1])) from--;
  return { from, to: metadataFrom - (horizontal(raw[metadataFrom - 1]) ? 1 : 0) };
}
function groupSeparators(
  raw: string,
  group: TaskInputRange,
  tokens: readonly TaskInputRange[],
): TaskInputRange[] {
  const left = [...tokens]
    .reverse()
    .find((token) => token.to <= group.from && onlyHorizontal(raw, token.to, group.from));
  const right = tokens.find(
    (token) => group.to <= token.from && onlyHorizontal(raw, group.to, token.from),
  );
  const line = lineBounds(raw, group),
    owned: TaskInputRange[] = [];
  const atStart = onlyHorizontal(raw, line.from, group.from),
    atEnd = onlyHorizontal(raw, group.to, line.to);
  if (right !== undefined && (atStart || left !== undefined))
    owned.push(rightSeparatorSpan(raw, group.to, right));
  if (left !== undefined && atEnd) owned.push(leftSeparatorSpan(raw, group.from, left));
  return owned;
}
function internalSeparators(
  raw: string,
  group: TaskInputRange,
  hidden: readonly TaskInputRange[],
  tokens: readonly TaskInputRange[],
): TaskInputRange[] {
  return tokens
    .filter((token) => group.from <= token.from && token.to <= group.to)
    .map((token) => {
      const previous = [...hidden]
        .sort((a, b) => b.to - a.to)
        .find((range) => range.to <= token.from);
      return previous === undefined ? token : rightSeparatorSpan(raw, previous.to, token);
    });
}
function ownedSeparators(
  raw: string,
  hidden: readonly TaskInputRange[],
  protectedRanges: readonly TaskInputRange[],
): TaskInputRange[] {
  const barriers = inputTextBarriers(raw, protectedRanges),
    tokens = separatorTokens(raw, [...barriers, ...hidden]);
  return metadataGroups(raw, hidden, tokens, barriers).flatMap((group) => [
    ...internalSeparators(raw, group, hidden, tokens),
    ...groupSeparators(raw, group, tokens),
  ]);
}
/** Source deletions and title-hidden metadata are distinct: active canonical tokens survive. */
export function buildInputBody(
  raw: string,
  ranges: readonly TaskInputRange[],
  hidden: readonly TaskInputRange[],
  protectedRanges: readonly TaskInputRange[],
): InputBody {
  const separators = ownedSeparators(raw, hidden, protectedRanges);
  const space = (value: string | undefined): boolean => value === ' ' || value === '\t';
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of [...ranges, ...separators]
    .filter((item) => validInputRange(raw, item))
    .sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      (range.from <= last.to ||
        (range.from === last.to + 1 &&
          (space(raw[last.to]) ||
            (horizontal(raw[last.to]) &&
              separators.some(
                (separator) => separator.from === range.from || separator.to === last.to,
              )))))
    )
      last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  const owned = merged
    .map((range) => {
      let { from, to } = range;
      if (from === 0 && space(raw[to])) to++;
      else if (to === raw.length && space(raw[from - 1])) from--;
      else if (space(raw[from - 1]) && space(raw[to])) to++;
      return { from, to };
    })
    .sort((a, b) => a.from - b.from);
  let cursor = 0,
    body = '';
  const retained: Array<{ sourceRange: TaskInputRange; bodyOffset: number }> = [];
  const retain = (from: number, to: number): void => {
    if (to <= from) return;
    retained.push({ sourceRange: { from, to }, bodyOffset: body.length });
    body += raw.slice(from, to);
  };
  for (const range of owned) {
    retain(cursor, range.from);
    cursor = Math.max(cursor, range.to);
  }
  retain(cursor, raw.length);
  return { markdownBody: body, retained, separators };
}
