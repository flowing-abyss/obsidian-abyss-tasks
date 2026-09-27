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

/**
 * A link, embed, or image that no task field may start inside. The `raw` of an embed or image
 * starts with `!`.
 */
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

/** A Markdown link ends at an unescaped `)`, so none can start after the last one. */
function markdownLinkScope(source: string): string {
  let close = source.lastIndexOf(')');
  while (close >= 0 && isEscaped(source, close)) close = source.lastIndexOf(')', close - 1);
  return source.slice(0, close + 1);
}

/**
 * Pushes each link, embed, and image that does not start in inline code. Group 3 passes over an
 * escaped `\`, `[`, or `!`. The pattern is global and never matches empty text, so each search
 * starts where the previous match ended.
 */
function pushLinkRanges(
  candidates: LinkRange[],
  input: string,
  link: RegExp,
  inlineCode: readonly SourceRange[],
): void {
  const cursor = { index: 0 };
  let match: RegExpExecArray | null;
  while ((match = link.exec(input)) !== null) {
    if (match[3] !== undefined || insideOrderedRange(match.index, inlineCode, cursor)) {
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

/**
 * Reads the links, embeds, and images that no task field may start inside, in source order: each
 * match that does not start inside an earlier kept match.
 */
export function parseLinkRanges(input: string): readonly LinkRange[] {
  if (!input.includes('[')) return [];
  const candidates: LinkRange[] = [];
  const inlineCode = inlineCodeRanges(input);
  // A wiki link or embed runs to the first `]]` after non-empty content and holds no `[[` or
  // line break.
  pushLinkRanges(candidates, input, /(!?)\[\[((?:(?!\[\[)[^\r\n])+?)\]\]|(\\[\\[!])/gu, inlineCode);
  // A backslash always takes the next character, and a Markdown link or image ends at a `)`.
  pushLinkRanges(
    candidates,
    markdownLinkScope(input),
    /!?\[((?:[^\\[\]]|\\[^])+)\]\(((?:[^\\)]|\\[^])+)\)|(\\[\\[!])/gu,
    inlineCode,
  );
  // No two ranges start at one index, because a wiki range starts with `[[` or `![[` and a
  // Markdown link's text cannot start with `[`.
  candidates.sort((left, right) => left.index - right.index);
  const accepted: LinkRange[] = [];
  let acceptedTo = 0;
  for (const candidate of candidates) {
    if (candidate.index < acceptedTo) continue;
    accepted.push(candidate);
    acceptedTo = candidate.to;
  }
  return accepted;
}
