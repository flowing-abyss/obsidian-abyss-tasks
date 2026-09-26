export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

function isEscaped(source: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

function closingDelimiterAt(source: string, delimiter: string, from: number): number {
  let close = source.indexOf(delimiter, from);
  while (close >= 0 && (source[close - 1] === '`' || source[close + delimiter.length] === '`')) {
    close = source.indexOf(delimiter, close + 1);
  }
  return close;
}

/** Finds closed CommonMark-style code spans using exact-length backtick delimiters. */
export function inlineCodeRanges(source: string): readonly SourceRange[] {
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
    const close = closingDelimiterAt(source, delimiter, open + runLength);
    if (close < 0) {
      cursor = open + runLength;
      continue;
    }
    ranges.push({ from: open, to: close + runLength });
    cursor = close + runLength;
  }
  return ranges;
}

/** A link the task line reads; no task field may start inside it. */
export interface LinkRange extends SourceRange {
  readonly index: number;
  readonly raw: string;
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

/** Pushes the unescaped links outside inline code; group 3 of `link` passes over an image opener. */
function pushLinkRanges(
  candidates: LinkRange[],
  input: string,
  link: RegExp,
  inlineCode: readonly SourceRange[],
): void {
  const cursor = { index: 0 };
  let match: RegExpExecArray | null;
  while ((match = link.exec(input)) !== null) {
    if (
      match[3] !== undefined ||
      isEscaped(input, match.index) ||
      insideOrderedRange(match.index, inlineCode, cursor)
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
}

/** Reads the links that no task field may start inside, in source order. */
export function parseLinkRanges(input: string): readonly LinkRange[] {
  if (!input.includes('[')) return [];
  const candidates: LinkRange[] = [];
  const inlineCode = inlineCodeRanges(input);
  // `![` opens an image or embed, never a link; group 3 passes over it.
  pushLinkRanges(
    candidates,
    input,
    /\[\[((?:\\.|[^|[\]])+)(?:\|((?:\\.|[^[\]])+))?\]\]|(!\[)/gu,
    inlineCode,
  );
  pushLinkRanges(candidates, input, /\[((?:\\.|[^[\]])+)\]\(((?:\\.|[^)])+)\)|(!\[)/gu, inlineCode);
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
